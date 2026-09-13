/**
 * The one shared end-to-end publication-qualification contract, used by both
 * `test/vault-capture-e2e.test.ts` and `scripts/live-check-vault.mjs` (Task 6
 * qualification, MAJOR 3 / MAJOR C, 2026-09-13 Codex frontier review round 2:
 * a single implementation, not two independently-drifting copies).
 *
 * For one already-published outcome, this proves: every required fact is
 * present in the saved bytes, frontmatter identity metadata is correct
 * (`source_id`, `version`, `source_url`/`requested_url`), the whole-note
 * digest matches what is actually on disk, exactly one MOC link exists for
 * it, `sb-docs search` resolves the note's identity (path + digest) under
 * the right collection/version scope, and `sb-docs read` returns the
 * complete saved bytes — not merely that capture printed an envelope
 * containing the right substring.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** SHA-256 of a UTF-8 string, hex-encoded — matches `src/vault/identity.ts`'s `sha256`. */
export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** One frontmatter field extracted from saved note bytes, by exact YAML key. */
export function frontmatterField(markdown, key) {
  const frontmatterBlock = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterBlock) return undefined;
  const line = frontmatterBlock[1].split("\n").find((l) => l.startsWith(`${key}:`));
  if (!line) return undefined;
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^"(.*)"$/, "$1");
}

/** Counts occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** The MOC's wiki-link target for a saved note path (extensionless). */
export function mocLinkTarget(notePath) {
  return notePath.replace(/\.md$/, "");
}

/**
 * Removes fenced code blocks so a link shown as an example is not mistaken
 * for a live link. Mirrors `stripCodeFences` in `src/vault/VaultPublisher.ts`
 * exactly (MAJOR 1, 2026-09-13 Codex frontier review, round 4).
 */
function stripCodeFences(markdown) {
  return markdown
    .split(/^```.*$/m)
    .filter((_, index) => index % 2 === 0)
    .join("\n");
}

/**
 * Counts real wikilink references to `target` in a MOC, using the exact
 * link syntax the fork's own publisher emits and detects
 * (`- [[target|alias]]` or `[[target]]`, from `VaultPublisher.ts`'s
 * `linkFromIndex`/`hasLinkTo`) -- not a substring match, which a MOC
 * containing only plain text mentioning the note's path (or a longer
 * sibling target sharing the same prefix, e.g. `collection/Fixture 2`)
 * would satisfy without a single navigable link (MAJOR 1, 2026-09-13 Codex
 * frontier review, round 4).
 *
 * @param moc The MOC note's Markdown.
 * @param target Vault path of the note, without its `.md` extension.
 * @returns The number of distinct `[[target]]`/`[[target|alias]]` matches.
 */
export function countMocLinksTo(moc, target) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, "g");
  return (stripCodeFences(moc).match(pattern) ?? []).length;
}

/**
 * Runs the full qualification contract for one published outcome.
 *
 * @param options.vaultPath Absolute path of the vault the note was saved into.
 * @param options.notePath Vault-relative path of the saved note.
 * @param options.expectedDigest REQUIRED: the outcome's own reported
 *   publication digest. A missing or empty digest fails the contract --
 *   callers must read it from the capture envelope
 *   (`outcome.publication.digest`) and must not omit it.
 * @param options.facts Substrings that must appear in the saved bytes.
 * @param options.collection Collection the note was captured into.
 * @param options.query Search query expected to resolve this note's identity.
 * @param options.version Expected frontmatter version (default `""`).
 * @param options.sourceUrlContains Optional substring expected in
 *   `source_url`/`requested_url`.
 * @param options.runCli `(args: string[]) => Promise<{code, stdout, stderr}>`
 *   — invokes the built CLI with whatever env/isolation the caller needs.
 * @returns `{ ok: true, notePath, digest }` on success, or
 *   `{ ok: false, reason, notePath }` describing exactly which check failed.
 */
export async function qualifyNote(options) {
  const {
    vaultPath,
    notePath,
    expectedDigest,
    facts,
    collection,
    query,
    version = "",
    sourceUrlContains,
    runCli,
  } = options;

  if (!notePath) {
    return { ok: false, reason: "outcome carries no saved note path", notePath };
  }

  let savedBytes;
  try {
    savedBytes = fs.readFileSync(path.join(vaultPath, notePath), "utf8");
  } catch (err) {
    return { ok: false, reason: `could not read saved note: ${err}`, notePath };
  }

  // MAJOR 2 (2026-09-13 Codex frontier review, round 3): the publication
  // digest is REQUIRED, not optional -- skipping validation when it is
  // absent let a capture regression that omits the digest from its own
  // envelope still qualify. A missing digest is itself a contract failure.
  if (typeof expectedDigest !== "string" || expectedDigest.length === 0) {
    return {
      ok: false,
      reason: `missing publication digest (outcome.publication.digest was ${JSON.stringify(expectedDigest)}); the envelope must carry a non-empty digest for this note to qualify`,
      notePath,
    };
  }
  const actualDigest = sha256(savedBytes);
  if (actualDigest !== expectedDigest) {
    return {
      ok: false,
      reason: `digest mismatch: outcome said ${expectedDigest}, saved bytes hash to ${actualDigest}`,
      notePath,
    };
  }

  const missingFacts = (facts ?? []).filter((fact) => !savedBytes.includes(fact));
  if (missingFacts.length > 0) {
    return { ok: false, reason: `missing facts: ${missingFacts.join(", ")}`, notePath };
  }

  const sourceId = frontmatterField(savedBytes, "source_id");
  if (!sourceId) {
    return { ok: false, reason: "frontmatter missing source_id", notePath };
  }
  const frontmatterVersion = frontmatterField(savedBytes, "version");
  if (frontmatterVersion !== version) {
    return {
      ok: false,
      reason: `frontmatter version "${frontmatterVersion}" !== expected "${version}"`,
      notePath,
    };
  }
  if (sourceUrlContains !== undefined) {
    const sourceUrl =
      frontmatterField(savedBytes, "source_url") ?? frontmatterField(savedBytes, "requested_url");
    if (!sourceUrl?.includes(sourceUrlContains)) {
      return {
        ok: false,
        reason: `frontmatter source_url/requested_url "${sourceUrl}" missing "${sourceUrlContains}"`,
        notePath,
      };
    }
  }

  let mocLinkCount = -1;
  try {
    const moc = fs.readFileSync(path.join(vaultPath, path.dirname(notePath), "index.md"), "utf8");
    mocLinkCount = countMocLinksTo(moc, mocLinkTarget(notePath));
  } catch (err) {
    return { ok: false, reason: `could not read MOC: ${err}`, notePath };
  }
  if (mocLinkCount !== 1) {
    return { ok: false, reason: `MOC link count ${mocLinkCount}, expected 1`, notePath };
  }

  if (query !== undefined && collection !== undefined) {
    const searchArgs = ["search", query, "--collection", collection, "--json"];
    if (version !== undefined) searchArgs.push("--version", version);
    const found = await runCli(searchArgs);
    if (found.code !== 0) {
      return { ok: false, reason: `search "${query}" exited ${found.code}`, notePath };
    }
    const line = found.stdout.split("\n").find((l) => l.startsWith("{"));
    let envelope = null;
    try {
      envelope = line ? JSON.parse(line) : null;
    } catch {
      envelope = null;
    }
    const results = envelope?.results ?? [];
    const match = results.find((r) => r.vault_path === notePath);
    if (!match) {
      return {
        ok: false,
        reason: `search "${query}" did not resolve ${notePath}; got ${JSON.stringify(results)}`,
        notePath,
      };
    }
    if (match.digest !== actualDigest) {
      return {
        ok: false,
        reason: `search result digest ${match.digest} !== saved-bytes digest ${actualDigest}`,
        notePath,
      };
    }
  }

  const readBack = await runCli(["read", notePath]);
  if (readBack.code !== 0) {
    return { ok: false, reason: `read exited ${readBack.code}`, notePath };
  }
  if (readBack.stdout !== `${savedBytes}\n`) {
    return { ok: false, reason: "read did not return the complete saved bytes", notePath };
  }

  return { ok: true, notePath, digest: actualDigest };
}
