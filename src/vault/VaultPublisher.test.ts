import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { collectionPath, notePath, sha256, sourceId } from "./identity";
import { countLinksTo } from "./markdownLinks.mjs";
import { ObsidianCli } from "./ObsidianCli";
import { PublicationJournal } from "./PublicationJournal";
import { renderSourceNote } from "./render";
import type { CliResult, SourceDocument } from "./types";
import {
  SOURCE_UPDATES_INDEX,
  SOURCE_UPDATES_PATH,
  updateDecision,
  VaultPublisher,
} from "./VaultPublisher";

/**
 * Markdown that exercises everything publication must not mangle: a GFM table,
 * a fenced code block, non-ASCII text, and a literal shell substitution string
 * that must survive verbatim rather than being expanded by a shell.
 */
const SOURCE_MARKDOWN = `# uv Projects

Résumé of the — “quoted” — workflow… 日本語 ✅

| Flag | Meaning |
| --- | --- |
| \`--frozen\` | Do not update the lockfile |

\`\`\`bash
uv run --frozen -- python -c 'print("$(whoami)")'
\`\`\`

Literal, never expanded: \`$(rm -rf /)\` and \${HOME} and \`backtick\`.
`;

function makeDocument(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    sourceUrl: "https://docs.astral.sh/uv/guides/projects/",
    requestedUrl: "https://docs.astral.sh/uv/guides/projects/",
    collection: "inbox",
    version: "",
    title: "Working on Projects with uv",
    markdown: SOURCE_MARKDOWN,
    sourceContentType: "text/html",
    capturedAt: "2026-09-10T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * In-memory stand-in for the `obsidian-cli` process.
 *
 * It records every argument array and stdin payload so tests can assert the
 * exact process contract, and it also holds note bytes so tests can assert the
 * resulting vault state. Its exit codes mirror the documented CLI: 3 for a
 * create-only collision or a failed compare-and-swap, 1 for a missing note, and
 * a setext-heading refusal that arrives as exit 1 with its own diagnostic.
 */
class FakeObsidianCliProcess {
  readonly invocations: { args: string[]; stdin: string | null }[] = [];
  readonly notes = new Map<string, string>();
  /** Notes whose headings should be treated as setext. */
  readonly setextNotes = new Set<string>();
  /** Folders that exist without holding a note directly. */
  readonly folders = new Set<string>();

  /** Bumped per note to invalidate an anchor without changing any bytes. */
  private readonly anchorSalt = new Map<string, number>();

  /** Anchor the CLI reports for a note's current bytes. */
  anchorOf(notePath: string): string {
    const existing = this.notes.get(notePath);
    if (existing === undefined) return "sha256:<absent>";
    return `sha256:${sha256(`${existing}${this.anchorSalt.get(notePath) ?? 0}`)}`;
  }

  /**
   * Invalidates a note's anchor while leaving its bytes alone, which is what a
   * touch — or any write that lands identical content — looks like to CAS.
   */
  bumpAnchor(notePath: string): void {
    this.anchorSalt.set(notePath, (this.anchorSalt.get(notePath) ?? 0) + 1);
  }

  run = async (args: string[], stdin: string | null): Promise<CliResult> => {
    this.invocations.push({ args, stdin });
    const [command, notePath] = args;

    if (command === "create") {
      if (this.notes.has(notePath)) {
        return {
          code: 3,
          stdout: "",
          stderr: "obsidian-cli: note changed since sha256:<absent> — re-read and retry",
        };
      }
      this.notes.set(notePath, stdin ?? "");
      return {
        code: 0,
        stdout: `wrote ${(stdin ?? "").length} bytes -> ${notePath}`,
        stderr: "",
      };
    }

    if (command === "write") {
      const ifMatchIndex = args.indexOf("--if-match");
      const expected = ifMatchIndex === -1 ? null : args[ifMatchIndex + 1];
      if (expected !== null && expected !== this.anchorOf(notePath)) {
        return {
          code: 3,
          stdout: "",
          stderr: `obsidian-cli: note changed since ${expected} — re-read and retry`,
        };
      }
      if (!args.includes("--force") && this.notes.has(notePath)) {
        return { code: 1, stdout: "", stderr: "obsidian-cli: refusing to overwrite" };
      }
      this.notes.set(notePath, stdin ?? "");
      return {
        code: 0,
        stdout: `wrote ${(stdin ?? "").length} bytes -> ${notePath}`,
        stderr: "",
      };
    }

    if (command === "read") {
      const existing = this.notes.get(notePath);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${notePath}` };
      }
      const stderr = args.includes("--with-anchor")
        ? `anchor: ${this.anchorOf(notePath)}\n`
        : "";
      return { code: 0, stdout: existing, stderr };
    }

    if (command === "section-insert") {
      const heading = args[2];
      const existing = this.notes.get(notePath);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${notePath}` };
      }
      if (this.setextNotes.has(notePath)) {
        // The installed CLI reports this as exit 1, not exit 4.
        return {
          code: 1,
          stdout: "",
          stderr: `obsidian-cli: setext heading layout in ${notePath} (a line underlined by === or ---): section-insert only supports ATX (#) headings`,
        };
      }
      const lines = existing.split("\n");
      const headingIndex = lines.indexOf(heading);
      if (headingIndex === -1) {
        return {
          code: 1,
          stdout: "",
          stderr: `obsidian-cli: heading not found (must match a whole line, outside code fences) in ${notePath}: ${heading}`,
        };
      }
      lines.splice(headingIndex + 1, 0, stdin ?? "");
      this.notes.set(notePath, lines.join("\n"));
      return {
        code: 0,
        stdout: `inserted under "${heading}" -> ${notePath}`,
        stderr: "",
      };
    }

    if (command === "list") {
      const dir = notePath.replace(/\/$/, "");
      const entries = new Set<string>();
      for (const candidate of [...this.notes.keys(), ...this.folders]) {
        if (!candidate.startsWith(`${dir}/`)) continue;
        const rest = candidate.slice(dir.length + 1);
        const head = rest.split("/")[0];
        if (head) entries.add(`${dir}/${head}`);
      }
      if (entries.size === 0 && !this.folders.has(dir)) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a directory: ${dir}` };
      }
      return { code: 0, stdout: `${[...entries].sort().join("\n")}\n`, stderr: "" };
    }

    return { code: 2, stdout: "", stderr: `unknown subcommand: ${command}` };
  };
}

/** Splits a rendered note into its YAML frontmatter and its body. */
function splitNote(note: string): { frontmatter: string; body: string } {
  const match = note.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`note has no frontmatter:\n${note}`);
  return { frontmatter: match[1], body: match[2] };
}

const temporaries: string[] = [];
let stateDir: string;
let vaultDir: string;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

/**
 * Reports one placeholder entry per real link, using the exact same shared,
 * CommonMark-correct implementation the publisher itself uses (MAJOR 2,
 * 2026-09-13 Codex frontier review round 5; MAJOR 1+2, round 6 scoped
 * re-review: the shared implementation itself is now a real `remark` parse,
 * not a hand-rolled line-based stripper) -- not a test-local
 * re-implementation that could itself drift from what the publisher
 * actually does. Kept as an array-returning helper (rather than switching
 * every call site to `expect(countLinksTo(...)).toBe(n)`) so every existing
 * `.toHaveLength(n)` assertion keeps working unchanged.
 */
function linksTo(index: string, target: string): unknown[] {
  return Array.from({ length: countLinksTo({ markdown: index, target }) });
}

beforeEach(() => {
  stateDir = makeTempDir("sb-docs-pub-state-");
  vaultDir = makeTempDir("sb-docs-pub-vault-");
});

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makePublisher(cli: FakeObsidianCliProcess | ObsidianCli): VaultPublisher {
  const wrapped = cli instanceof ObsidianCli ? cli : new ObsidianCli(cli.run);
  return new VaultPublisher(wrapped, {
    stateDir,
    vaultPath: vaultDir,
    lock: { timeoutMs: 2000, pollMs: 5 },
  });
}

describe("updateDecision", () => {
  it.each([
    {
      name: "an absent note is created",
      input: { currentDigest: null, ownedDigest: null, semanticChanged: true },
      expected: "create",
    },
    {
      name: "an unowned existing note is a conflict",
      input: { currentDigest: "a", ownedDigest: null, semanticChanged: true },
      expected: "conflict",
    },
    {
      name: "a note edited since we wrote it is a conflict",
      input: { currentDigest: "b", ownedDigest: "a", semanticChanged: false },
      expected: "conflict",
    },
    {
      name: "our own note with changed content is replaced",
      input: { currentDigest: "a", ownedDigest: "a", semanticChanged: true },
      expected: "replace",
    },
    {
      name: "our own note with unchanged content is left alone",
      input: { currentDigest: "a", ownedDigest: "a", semanticChanged: false },
      expected: "unchanged",
    },
    {
      name: "an absent note wins over a stale ownership record",
      input: { currentDigest: null, ownedDigest: "a", semanticChanged: false },
      expected: "create",
    },
  ])("$name", ({ input, expected }) => {
    expect(updateDecision(input)).toBe(expected);
  });
});

describe("VaultPublisher", () => {
  let cli: FakeObsidianCliProcess;
  let publisher: VaultPublisher;

  beforeEach(() => {
    cli = new FakeObsidianCliProcess();
    publisher = makePublisher(cli);
  });

  it("refuses to keep its runtime state inside the vault", () => {
    expect(
      () =>
        new VaultPublisher(new ObsidianCli(cli.run), {
          stateDir: path.join(vaultDir, "state"),
          vaultPath: vaultDir,
        }),
    ).toThrow(/vault/i);
  });

  it("publishes one source note under the reserved inbox collection", async () => {
    const publication = await publisher.publish(makeDocument());

    expect(publication.status).toBe("published");
    expect(publication.moc).toBe("linked");
    expect(publication.path.startsWith("00 Inbox/Source Captures/")).toBe(true);
    expect(cli.notes.has(publication.path)).toBe(true);
  });

  it("preserves the source markdown body byte for byte", async () => {
    const publication = await publisher.publish(makeDocument());
    const { body } = splitNote(cli.notes.get(publication.path) ?? "");

    expect(body).toBe(SOURCE_MARKDOWN);
  });

  it("never lets a shell substitution string reach the process as an argument", async () => {
    await publisher.publish(makeDocument());

    for (const { args } of cli.invocations) {
      for (const arg of args) {
        expect(arg).not.toContain("$(");
        expect(arg).not.toContain("rm -rf");
      }
    }
    // The dangerous text is carried on stdin instead, unexpanded.
    const created = cli.invocations.find((invocation) => invocation.args[0] === "create");
    expect(created?.stdin).toContain("$(rm -rf /)");
  });

  it("round-trips the documented metadata through YAML", async () => {
    const document = makeDocument();
    const publication = await publisher.publish(document);
    const { frontmatter } = splitNote(cli.notes.get(publication.path) ?? "");
    const metadata = parseYaml(frontmatter);

    expect(metadata).toMatchObject({
      type: "source",
      source_url: document.sourceUrl,
      requested_url: document.requestedUrl,
      source_id: sourceId(document),
      collection: "inbox",
      version: "",
      captured_at: document.capturedAt,
      source_content_type: "text/html",
      content_sha256: sha256(SOURCE_MARKDOWN),
      publisher: "secondbrain-docs",
    });
    expect(typeof metadata.publisher_version).toBe("string");
    expect(metadata.publisher_version.length).toBeGreaterThan(0);
    // `last_seen_at` is external state, never a note byte.
    expect(frontmatter).not.toContain("last_seen_at");
  });

  it("keeps the source identity stable when only the title changes", async () => {
    const original = makeDocument();
    const retitled = makeDocument({ title: "uv — Working on Projects (2026 edition)" });

    expect(sourceId(retitled)).toBe(sourceId(original));
  });

  it("gives the same source a different identity under a different collection", async () => {
    expect(sourceId(makeDocument({ collection: "uv" }))).not.toBe(
      sourceId(makeDocument()),
    );
  });

  it("routes an explicitly named collection to its doc set folder, preserving its case", () => {
    expect(collectionPath("inbox")).toBe("00 Inbox/Source Captures");
    // The live vault already holds `30 Tools-Models/Doc Sets/SpotOn Restaurant API`,
    // so the folder keeps the given casing; only the identity is normalized.
    expect(collectionPath("SpotOn Restaurant API")).toBe(
      "30 Tools-Models/Doc Sets/SpotOn Restaurant API",
    );
  });

  it("normalizes collection case for identity but not for the folder", () => {
    expect(sourceId(makeDocument({ collection: "SpotOn Restaurant API" }))).toBe(
      sourceId(makeDocument({ collection: "spoton restaurant api" })),
    );
  });

  it("sanitizes a hostile title into a safe path inside the collection", async () => {
    const publication = await publisher.publish(
      makeDocument({ title: "../../etc/passwd: a *very* bad/title" }),
    );

    expect(publication.path.startsWith("00 Inbox/Source Captures/")).toBe(true);
    expect(publication.path).not.toContain("..");
    expect(publication.path).not.toContain(":");
    expect(publication.path.endsWith(".md")).toBe(true);
  });

  it("writes exactly one MOC link after capturing the same source twice", async () => {
    const first = await publisher.publish(makeDocument());
    const second = await publisher.publish(makeDocument());

    expect(first.status).toBe("published");
    expect(second.status).toBe("unchanged");

    const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";
    expect(linksTo(index, first.path.replace(/\.md$/, ""))).toHaveLength(1);
  });

  it("treats a later capture of unchanged content as unchanged, not a conflict", async () => {
    const first = await publisher.publish(makeDocument());
    const later = await publisher.publish(
      makeDocument({ capturedAt: "2026-11-01T09:30:00.000Z" }),
    );

    expect(later.status).toBe("unchanged");
    // The original note keeps its first captured_at byte for byte.
    expect(cli.notes.get(first.path)).toBe(first.markdown);
    expect(cli.notes.get(first.path)).toContain("captured_at: 2026-09-10T12:00:00.000Z");
  });

  it("keeps prior bytes when only the publisher release changed", async () => {
    const first = await publisher.publish(makeDocument());

    const upgraded = new VaultPublisher(new ObsidianCli(cli.run), {
      stateDir,
      vaultPath: vaultDir,
      publisherVersion: "99.0.0",
      lock: { timeoutMs: 2000, pollMs: 5 },
    });
    const second = await upgraded.publish(
      makeDocument({ capturedAt: "2027-01-01T00:00:00.000Z" }),
    );

    expect(second.status).toBe("unchanged");
    expect(cli.notes.get(first.path)).toBe(first.markdown);
    expect(cli.notes.get(first.path)).not.toContain("publisher_version: 99.0.0");
  });

  it("replaces its own note when the source body actually changed", async () => {
    const first = await publisher.publish(makeDocument());
    const changed = await publisher.publish(
      makeDocument({ markdown: `${SOURCE_MARKDOWN}\nA new paragraph.\n` }),
    );

    expect(changed.status).toBe("replaced");
    expect(changed.path).toBe(first.path);
    expect(cli.notes.get(first.path)).toBe(changed.markdown);
    expect(cli.notes.get(first.path)).toContain("A new paragraph.");
    expect(cli.notes.size).toBe(2); // the note and its index, nothing else
  });

  it("freezes the path across a title change and keeps exactly one MOC link", async () => {
    const first = await publisher.publish(makeDocument());
    const retitled = await publisher.publish(
      makeDocument({
        title: "uv — Working on Projects (2026 edition)",
        markdown: `${SOURCE_MARKDOWN}\nRewritten.\n`,
      }),
    );

    expect(retitled.status).toBe("replaced");
    expect(retitled.path).toBe(first.path);

    const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";
    expect(linksTo(index, first.path.replace(/\.md$/, ""))).toHaveLength(1);
    const notePaths = [...cli.notes.keys()].filter((key) => !key.endsWith("index.md"));
    expect(notePaths).toHaveLength(1);
  });

  it("gives two same-title sources distinct paths and two MOC links", async () => {
    const first = await publisher.publish(makeDocument({ title: "Shared Title" }));
    const second = await publisher.publish(
      makeDocument({
        title: "Shared Title",
        sourceUrl: "https://docs.astral.sh/uv/guides/scripts/",
        requestedUrl: "https://docs.astral.sh/uv/guides/scripts/",
      }),
    );

    expect(second.path).not.toBe(first.path);
    const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";
    expect(linksTo(index, first.path.replace(/\.md$/, ""))).toHaveLength(1);
    expect(linksTo(index, second.path.replace(/\.md$/, ""))).toHaveLength(1);
  });

  it("preserves an existing note whose bytes differ and reports a conflict", async () => {
    const first = await publisher.publish(makeDocument());
    cli.notes.set(first.path, "# Hand edited by a human\n");

    const second = await publisher.publish(makeDocument());

    expect(second.status).toBe("conflict");
    expect(second.conflictReason).toBe("manual-edit");
    expect(cli.notes.get(first.path)).toBe("# Hand edited by a human\n");
  });

  it("writes an incoming candidate when a human edited the body", async () => {
    const first = await publisher.publish(makeDocument());
    const handEdited = `${first.markdown}\n\nA human added this paragraph.\n`;
    cli.notes.set(first.path, handEdited);

    const second = await publisher.publish(
      makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed too.\n` }),
    );

    expect(second.status).toBe("conflict");
    expect(cli.notes.get(first.path)).toBe(handEdited);
    expect(second.candidatePath?.startsWith(`${SOURCE_UPDATES_PATH}/`)).toBe(true);
    const candidate = cli.notes.get(second.candidatePath ?? "") ?? "";
    expect(candidate).toContain("Upstream changed too.");

    const updatesIndex = cli.notes.get(SOURCE_UPDATES_INDEX) ?? "";
    expect(updatesIndex).toContain("## Sources");
    expect(
      linksTo(updatesIndex, (second.candidatePath ?? "").replace(/\.md$/, "")),
    ).toHaveLength(1);
  });

  it("catches a human frontmatter edit through the whole-note digest", async () => {
    const first = await publisher.publish(makeDocument());
    // Semantically identical: only the capture timestamp line moved.
    const touched = first.markdown.replace(
      "captured_at: 2026-09-10T12:00:00.000Z",
      "captured_at: 2026-09-10T12:00:01.000Z",
    );
    expect(touched).not.toBe(first.markdown);
    cli.notes.set(first.path, touched);

    const second = await publisher.publish(
      makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` }),
    );

    expect(second.status).toBe("conflict");
    expect(second.conflictReason).toBe("manual-edit");
    expect(cli.notes.get(first.path)).toBe(touched);
  });

  it("reuses an identical conflict candidate instead of writing a second one", async () => {
    const first = await publisher.publish(makeDocument());
    cli.notes.set(first.path, "# Hand edited by a human\n");
    const changed = makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` });

    const second = await publisher.publish(changed);
    const third = await publisher.publish({
      ...changed,
      capturedAt: "2027-02-02T02:02:02.000Z",
    });

    expect(third.status).toBe("conflict");
    expect(third.candidatePath).toBe(second.candidatePath);
    // Reused byte for byte, including the first capture timestamp.
    expect(cli.notes.get(third.candidatePath ?? "")).toBe(
      cli.notes.get(second.candidatePath ?? ""),
    );
    expect(cli.notes.get(third.candidatePath ?? "")).toContain(
      "captured_at: 2026-09-10T12:00:00.000Z",
    );

    const candidates = [...cli.notes.keys()].filter(
      (key) => key.startsWith(`${SOURCE_UPDATES_PATH}/`) && !key.endsWith("index.md"),
    );
    expect(candidates).toHaveLength(1);
    const updatesIndex = cli.notes.get(SOURCE_UPDATES_INDEX) ?? "";
    expect(
      linksTo(updatesIndex, (second.candidatePath ?? "").replace(/\.md$/, "")),
    ).toHaveLength(1);
  });

  it("never overwrites a candidate a human edited", async () => {
    const first = await publisher.publish(makeDocument());
    cli.notes.set(first.path, "# Hand edited by a human\n");
    const changed = makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` });

    const second = await publisher.publish(changed);
    const candidatePath = second.candidatePath ?? "";
    const editedCandidate = `${cli.notes.get(candidatePath) ?? ""}\nHuman note on the candidate.\n`;
    cli.notes.set(candidatePath, editedCandidate);

    const third = await publisher.publish(changed);

    expect(third.status).toBe("conflict");
    expect(third.conflictReason).toBe("candidate-modified");
    expect(cli.notes.get(candidatePath)).toBe(editedCandidate);
    const candidates = [...cli.notes.keys()].filter(
      (key) => key.startsWith(`${SOURCE_UPDATES_PATH}/`) && !key.endsWith("index.md"),
    );
    expect(candidates).toHaveLength(1);
  });

  it("refuses to publish a third note when two notes claim one source id", async () => {
    const first = await publisher.publish(makeDocument());
    const duplicatePath = "00 Inbox/Source Captures/a human copy.md";
    cli.notes.set(duplicatePath, first.markdown);
    // Runtime state is disposable, so the scan — not the ownership record — is
    // what has to notice that two notes now claim one identity.
    fs.rmSync(path.join(stateDir, "ownership"), { recursive: true, force: true });

    const fresh = makePublisher(cli);
    const second = await fresh.publish(
      makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` }),
    );

    expect(second.status).toBe("conflict");
    expect(second.conflictReason).toBe("identity-conflict");
    expect(cli.notes.get(first.path)).toBe(first.markdown);
    expect(cli.notes.get(duplicatePath)).toBe(first.markdown);
    const notes = [...cli.notes.keys()].filter(
      (key) => key.startsWith("00 Inbox/Source Captures/") && !key.endsWith("index.md"),
    );
    expect(notes).toHaveLength(2);
  });

  it("resolves a lost ownership record through discovery rather than a third note", async () => {
    const first = await publisher.publish(makeDocument({ title: "Original Title" }));

    // Runtime state is disposable; a human deleting it must not duplicate notes.
    fs.rmSync(path.join(stateDir, "ownership"), { recursive: true, force: true });

    const fresh = makePublisher(cli);
    const second = await fresh.publish(
      makeDocument({
        title: "A Completely New Title",
        markdown: `${SOURCE_MARKDOWN}\nx\n`,
      }),
    );

    expect(second.status).toBe("conflict");
    expect(second.conflictReason).toBe("user-owned");
    expect(second.path).toBe(first.path);
    expect(cli.notes.get(first.path)).toBe(first.markdown);
    const notes = [...cli.notes.keys()].filter(
      (key) => key.startsWith("00 Inbox/Source Captures/") && !key.endsWith("index.md"),
    );
    expect(notes).toHaveLength(1);
  });

  it("creates the collection index with a Sources heading when it is absent", async () => {
    await publisher.publish(makeDocument());
    const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";

    expect(index).toContain("## Sources");
  });

  it("reports a pending MOC instead of rewriting an index that lacks the heading", async () => {
    cli.notes.set(
      "00 Inbox/Source Captures/index.md",
      "# Source Captures\n\n## Something Else\n",
    );

    const publication = await publisher.publish(makeDocument());

    expect(publication.status).toBe("published");
    expect(publication.moc).toBe("pending");
    expect(cli.notes.get("00 Inbox/Source Captures/index.md")).toBe(
      "# Source Captures\n\n## Something Else\n",
    );
  });

  it("reports a pending MOC when the index uses setext headings", async () => {
    cli.notes.set(
      "00 Inbox/Source Captures/index.md",
      "Source Captures\n===\n\n## Sources\n",
    );
    cli.setextNotes.add("00 Inbox/Source Captures/index.md");

    const publication = await publisher.publish(makeDocument());

    expect(publication.status).toBe("published");
    expect(publication.moc).toBe("pending");
  });

  it("rejects empty source markdown rather than writing a blank note", async () => {
    await expect(publisher.publish(makeDocument({ markdown: "   \n" }))).rejects.toThrow(
      /empty/i,
    );
    expect(cli.notes.size).toBe(0);
  });

  it("does not duplicate the MOC link when two captures race", async () => {
    const [first, second] = await Promise.all([
      publisher.publish(makeDocument()),
      publisher.publish(makeDocument()),
    ]);

    const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";

    expect(linksTo(index, first.path.replace(/\.md$/, ""))).toHaveLength(1);
    expect([first.status, second.status].sort()).toEqual(["published", "unchanged"]);
  });

  it("keeps one note and one link when two publishers race over one source", async () => {
    // Two independent publisher instances, as two processes would be: they
    // share only the vault and the state directory, which is where the
    // interprocess lock lives.
    const one = makePublisher(cli);
    const two = makePublisher(cli);

    const [first, second] = await Promise.all([
      one.publish(makeDocument()),
      two.publish(makeDocument()),
    ]);

    expect(first.path).toBe(second.path);
    expect([first.status, second.status].sort()).toEqual(["published", "unchanged"]);

    const notes = [...cli.notes.keys()].filter(
      (key) => key.startsWith("00 Inbox/Source Captures/") && !key.endsWith("index.md"),
    );
    expect(notes).toHaveLength(1);
    const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";
    expect(linksTo(index, first.path.replace(/\.md$/, ""))).toHaveLength(1);
  });

  it("does not create a second note when another writer wins the race after discovery", async () => {
    // Warm the discovery scan with an unrelated note, then let a foreign writer
    // create our note between that scan and our create.
    await publisher.publish(
      makeDocument({
        sourceUrl: "https://docs.astral.sh/uv/guides/scripts/",
        requestedUrl: "https://docs.astral.sh/uv/guides/scripts/",
        title: "Other Source",
      }),
    );

    const target = notePath(makeDocument());
    let intercepted = false;
    const racing = new ObsidianCli(async (args, stdin) => {
      if (!intercepted && args[0] === "create" && args[1] === target) {
        intercepted = true;
        cli.notes.set(target, "---\ntype: source\n---\nwritten by somebody else\n");
      }
      return cli.run(args, stdin);
    });

    const publication = await new VaultPublisher(racing, {
      stateDir,
      vaultPath: vaultDir,
      lock: { timeoutMs: 2000, pollMs: 5 },
    }).publish(makeDocument());

    expect(intercepted).toBe(true);
    expect(publication.status).toBe("conflict");
    expect(cli.notes.get(target)).toBe(
      "---\ntype: source\n---\nwritten by somebody else\n",
    );
    const notes = [...cli.notes.keys()].filter(
      (key) => key.startsWith("00 Inbox/Source Captures/") && !key.endsWith("index.md"),
    );
    expect(notes).toHaveLength(2);
  });

  it("links two sources from one MOC without duplicating either", async () => {
    const first = await publisher.publish(makeDocument({ collection: "uv" }));
    const second = await publisher.publish(
      makeDocument({
        collection: "uv",
        sourceUrl: "https://docs.astral.sh/uv/guides/scripts/",
        requestedUrl: "https://docs.astral.sh/uv/guides/scripts/",
        title: "Running Scripts",
      }),
    );
    await publisher.publish(makeDocument({ collection: "uv" }));

    const index = cli.notes.get("30 Tools-Models/Doc Sets/uv/index.md") ?? "";
    expect(linksTo(index, first.path.replace(/\.md$/, ""))).toHaveLength(1);
    expect(linksTo(index, second.path.replace(/\.md$/, ""))).toHaveLength(1);
    expect((index.match(/\[\[/g) ?? []).length).toBe(2);
  });
});

describe("VaultPublisher recovery", () => {
  let cli: FakeObsidianCliProcess;

  beforeEach(() => {
    cli = new FakeObsidianCliProcess();
  });

  /** Builds a publisher whose CLI throws once a predicate matches. */
  function crashingPublisher(shouldCrash: (args: string[]) => boolean): VaultPublisher {
    const runner = new ObsidianCli(async (args, stdin) => {
      if (shouldCrash(args)) throw new Error("process died");
      return cli.run(args, stdin);
    });
    return new VaultPublisher(runner, {
      stateDir,
      vaultPath: vaultDir,
      lock: { timeoutMs: 2000, pollMs: 5 },
    });
  }

  it("classifies a crash before the note write as retryable and preserves bytes", async () => {
    const publisher = makePublisher(cli);
    const first = await publisher.publish(makeDocument());

    const changed = makeDocument({ markdown: `${SOURCE_MARKDOWN}\nChanged.\n` });
    const crashing = crashingPublisher((args) => args[0] === "write");
    await expect(crashing.publish(changed)).rejects.toThrow("process died");

    const journal = new PublicationJournal({ stateDir, vaultPath: vaultDir });
    expect(journal.pending()[0]?.phase).toBe("prepared");
    expect(cli.notes.get(first.path)).toBe(first.markdown);

    const report = await makePublisher(cli).recoverPending();
    expect(report).toHaveLength(1);
    expect(report[0].classification).toBe("retryable");
    expect(cli.notes.get(first.path)).toBe(first.markdown);

    // The retry is an ordinary capture, and it succeeds.
    const retried = await makePublisher(cli).publish(changed);
    expect(retried.status).toBe("replaced");
    expect(cli.notes.get(first.path)).toContain("Changed.");
  });

  it("resumes a crash after the note write and completes the MOC work", async () => {
    const publisher = makePublisher(cli);
    const first = await publisher.publish(makeDocument());
    // Drop the link so recovery has real MOC work to finish.
    const indexPath = "00 Inbox/Source Captures/index.md";
    cli.notes.set(indexPath, "# Source Captures\n\n## Sources\n");

    const changed = makeDocument({ markdown: `${SOURCE_MARKDOWN}\nChanged.\n` });
    let writes = 0;
    const crashing = crashingPublisher((args) => {
      if (args[0] === "write") writes += 1;
      // Crash on the readback that follows a successful write.
      return writes === 1 && args[0] === "read" && args[1] === first.path;
    });
    await expect(crashing.publish(changed)).rejects.toThrow("process died");

    const journal = new PublicationJournal({ stateDir, vaultPath: vaultDir });
    const pending = journal.pending()[0];
    expect(pending?.phase).toBe("note-written");
    expect(cli.notes.get(first.path)).toContain("Changed.");

    const report = await makePublisher(cli).recoverPending();
    expect(report[0].classification).toBe("resumable");
    expect(report[0].completed).toBe(true);
    expect(
      linksTo(cli.notes.get(indexPath) ?? "", first.path.replace(/\.md$/, "")),
    ).toHaveLength(1);
    expect(new PublicationJournal({ stateDir, vaultPath: vaultDir }).pending()).toEqual(
      [],
    );
    expect(
      new PublicationJournal({ stateDir, vaultPath: vaultDir }).readOwnership(
        sourceId(changed),
      )?.digest,
    ).toBe(sha256(cli.notes.get(first.path) ?? ""));
  });

  it("completes a crash after the MOC link without duplicating the link", async () => {
    const publisher = makePublisher(cli);
    const first = await publisher.publish(makeDocument());
    const indexPath = "00 Inbox/Source Captures/index.md";

    // A crash between `moc-linked` and the ownership write, reconstructed as
    // durable state: the note and its link are already in place.
    const journal = new PublicationJournal({ stateDir, vaultPath: vaultDir });
    journal.prepare({
      sourceId: sourceId(makeDocument()),
      path: first.path,
      priorWholeNoteDigest: first.digest,
      proposedWholeNoteDigest: first.digest,
      bytes: first.markdown,
    });
    journal.advance(sourceId(makeDocument()), "note-written");
    journal.advance(sourceId(makeDocument()), "moc-linked");

    const report = await makePublisher(cli).recoverPending();

    expect(report[0].classification).toBe("resumable");
    expect(report[0].completed).toBe(true);
    expect(
      linksTo(cli.notes.get(indexPath) ?? "", first.path.replace(/\.md$/, "")),
    ).toHaveLength(1);
    expect(cli.notes.get(first.path)).toBe(first.markdown);
  });

  it("reports a conflict rather than rolling back over a manual edit", async () => {
    const publisher = makePublisher(cli);
    const first = await publisher.publish(makeDocument());

    const changed = makeDocument({ markdown: `${SOURCE_MARKDOWN}\nChanged.\n` });
    const crashing = crashingPublisher((args) => args[0] === "write");
    await expect(crashing.publish(changed)).rejects.toThrow("process died");

    // A human edits the note while the entry is still pending.
    cli.notes.set(first.path, "# Hand edited during the outage\n");

    const report = await makePublisher(cli).recoverPending();

    expect(report[0].classification).toBe("conflict");
    expect(report[0].completed).toBe(false);
    expect(cli.notes.get(first.path)).toBe("# Hand edited during the outage\n");
    expect(
      new PublicationJournal({ stateDir, vaultPath: vaultDir }).pending(),
    ).toHaveLength(1);
  });

  it("restores ownership from the journal when the ownership file is lost", async () => {
    const publisher = makePublisher(cli);
    const first = await publisher.publish(makeDocument());
    const indexPath = "00 Inbox/Source Captures/index.md";
    cli.notes.set(indexPath, "# Source Captures\n\n## Sources\n");

    const changed = makeDocument({ markdown: `${SOURCE_MARKDOWN}\nChanged.\n` });
    let writes = 0;
    const crashing = crashingPublisher((args) => {
      if (args[0] === "write") writes += 1;
      return writes === 1 && args[0] === "read" && args[1] === first.path;
    });
    await expect(crashing.publish(changed)).rejects.toThrow("process died");

    // The ownership record never landed, but the journal proves those bytes.
    fs.rmSync(path.join(stateDir, "ownership"), { recursive: true, force: true });

    const republished = await makePublisher(cli).publish(
      makeDocument({ markdown: `${SOURCE_MARKDOWN}\nChanged again.\n` }),
    );

    expect(republished.status).toBe("replaced");
    expect(cli.notes.get(first.path)).toContain("Changed again.");
  });
});

// Regressions for the 2026-09-10 Codex review of commit 72a6407.
describe("VaultPublisher review regressions", () => {
  let cli: FakeObsidianCliProcess;
  let publisher: VaultPublisher;

  beforeEach(() => {
    cli = new FakeObsidianCliProcess();
    publisher = makePublisher(cli);
  });

  describe("filename budget", () => {
    it("uses a short hash prefix rather than the full source id", async () => {
      const publication = await publisher.publish(makeDocument());
      const basename = publication.path.split("/").pop() ?? "";

      expect(basename).toContain(sourceId(makeDocument()).slice(0, 12));
      expect(basename).not.toContain(sourceId(makeDocument()));
    });

    it("keeps the basename inside the 255-byte filesystem limit for CJK titles", async () => {
      const publication = await publisher.publish(
        makeDocument({ title: "日本語".repeat(200) }),
      );
      const basename = publication.path.split("/").pop() ?? "";

      expect(Buffer.byteLength(basename, "utf8")).toBeLessThanOrEqual(255);
    });

    it("never truncates an astral character into a lone surrogate", async () => {
      const publication = await publisher.publish(
        makeDocument({ title: "𝔘".repeat(300) }),
      );
      const basename = publication.path.split("/").pop() ?? "";

      // Valid astral characters are surrogate PAIRS; only an unpaired half is a defect.
      expect(basename).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
      expect(Buffer.byteLength(basename, "utf8")).toBeLessThanOrEqual(255);
    });

    it("falls back to the full identity when a different source holds the short path", async () => {
      const shortPath = notePath(makeDocument());
      // A different source already occupies the short filename.
      cli.notes.set(
        shortPath,
        '---\ntype: source\nsource_url: https://example.invalid/other\nsource_id: 0000000000000000000000000000000000000000000000000000000000000000\nversion: ""\nsource_content_type: text/html\n---\nsomething else\n',
      );

      const publication = await publisher.publish(makeDocument());

      expect(publication.status).toBe("published");
      expect(publication.path).not.toBe(shortPath);
      expect(publication.path).toContain(sourceId(makeDocument()));
      // The other source's note is untouched.
      expect(cli.notes.get(shortPath)).toContain("something else");
    });
  });

  describe("MOC link detection", () => {
    it("recognizes an existing link a human stripped the alias from", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(indexPath, `# Source Captures\n\n## Sources\n- [[${target}]]\n`);

      await publisher.publish(makeDocument());

      const links = (cli.notes.get(indexPath) ?? "")
        .split("\n")
        .filter((line) => line.includes(target));
      expect(links).toHaveLength(1);
    });

    it("does not count a link inside a fenced code block as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n\`\`\`\n- [[${target}]]\n\`\`\`\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// MAJOR 2 (2026-09-13 Codex frontier review, round 5): the fence
    // stripper round 4 added only recognized backtick fences. A target
    // mentioned only inside a tilde-fenced code block was still counted
    // as a live link, so `linkFromIndex` believed the note was already
    // linked and never added the real one.
    "does not count a link inside a tilde-fenced code block as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n~~~\n- [[${target}]]\n~~~\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// Same bug, inline-code-span shape: a target mentioned only inside
    // `` `[[...]]` `` inline code (not a fenced block) must not be
    // treated as a live link either.
    "does not count a link inside an inline code span as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\nSee the example \`[[${target}]]\` above.\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// MAJOR 1+2 (2026-09-13 Codex frontier review round 6, scoped): a
    // fence indented 1-3 spaces was invisible to the round-5 hand-rolled
    // stripper, so a mention inside one was wrongly counted as a live
    // link. The publisher must still add the real one.
    "does not count a link inside a fence indented 1-3 spaces as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n  \`\`\`\n  - [[${target}]]\n  \`\`\`\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    // A 4+-space-indented block is CommonMark's *indented* code block, a
    // different construct from a fence entirely -- checked at the module
    // level (`markdownLinks.test.ts`) and the contract level
    // (`scripts/lib/qualification-contract.test.ts`). Deliberately not
    // repeated as a full publish/insert round-trip here:
    // `insertUnderHeading` inserts the new real link as a flat list item
    // immediately under the heading, and CommonMark then reparses the
    // *pre-existing* 4-space-indented line as a nested list item
    // continuing that same list (not an indented code block) once it
    // directly follows a list item -- a genuine, correct reparse of the
    // resulting document, not a defect in link counting, so it would not
    // be a meaningful end-to-end fixture for "was this mention hidden".

    it(// CommonMark requires a closing fence line to contain nothing but the
    // fence characters (optionally trailing whitespace); a bogus closer
    // with trailing text does not close the fence, so the already-real
    // link placed after the true close is recognized as already linked
    // and must not be duplicated.
    "recognizes a real link after a fence whose bogus closing line (with trailing text) did not actually close it", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n\`\`\`\n- [[${target}]]\n\`\`\` trailing\n\`\`\`\n- [[${target}]]\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// CommonMark: a backtick-fenced code block's info string must not
    // itself contain a backtick -- such a line is not a valid fence
    // opener, so the real link right after it is ordinary prose and is
    // already linked; the publisher must not duplicate it.
    "recognizes a real link after a backtick opener whose info string itself contains backticks (not a valid fence)", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n\`\`\` \`info\` \n- [[${target}]]\n\`\`\`\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// The round-5 hand-rolled stripper's inline-span regex only matched a
    // single-backtick pair on one line; a multi-backtick-delimited span
    // was not recognized as one unit.
    "does not count a link inside a multi-backtick inline code span as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\nSee \`\` [[${target}]] \`\` above.\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// The round-5 hand-rolled stripper operated one line at a time, so an
    // inline code span spanning a line break was invisible to it.
    "does not count a link inside a multiline inline code span as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\nSee \`\n[[${target}]]\n\` above.\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// A double-backtick-delimited span containing a literal single
    // backtick inside it -- a "mismatched delimiter run" the hand-rolled
    // single-backtick-pair regex could misjudge the boundary of.
    "does not count a link inside a mismatched-delimiter-run inline code span as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\nSee \`\` code \` still code, [[${target}]] \`\` here.\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// Text that looks like a fence marker, but appears inline with no
    // matching closing backtick run anywhere in the same paragraph, is an
    // unmatched backtick run -- CommonMark treats it as literal text, so
    // the real link on the same line is already linked and must not be
    // duplicated.
    "recognizes a real link on the same line as fence-looking text with no matching close", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\nNote: \`\`\`\`\` marks a fence, e.g. [[${target}]].\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// MAJOR 1 (2026-09-13 Codex frontier review round 6, second scoped
    // re-review): `collectVisibleText` used to return "" for a skipped
    // node and simply concatenate its neighbours, so a wikilink
    // fragmented by an inline code span was reassembled into a false
    // "already linked" match, and the publisher never added the real
    // link.
    "does not count a pseudo-link fragmented by an inline code span as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n[[${target.slice(0, 5)}\`x\`${target.slice(5)}]]\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// A hard line break inside what looks like a wikilink must not be
    // reassembled into a false "already linked" match either.
    "does not count a pseudo-link fragmented by a hard line break as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n[[${target.slice(0, 5)}  \n${target.slice(5)}]]\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// An image inside what looks like a wikilink must not be reassembled
    // into a false "already linked" match either.
    "does not count a pseudo-link fragmented by an image as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n[[${target.slice(0, 5)}![alt](url)${target.slice(5)}]]\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// MAJOR 1 (2026-09-13 Codex frontier review round 6, third pass): the
    // raw-substring fast path this module briefly had ignored Markdown
    // escapes -- `\-` is resolved by remark to a literal `-`, so a MOC
    // link written with an escaped hyphen around a title containing one
    // would have been fast-pathed to "not linked" and duplicated.
    "recognizes an existing link written with a backslash-escaped hyphen as already linked", async () => {
      const first = await publisher.publish(makeDocument({ title: "Foo-Bar" }));
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      expect(target).toContain("Foo-Bar");
      const escapedTarget = target.replace(/-/g, "\\-");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n- [[${escapedTarget}]]\n`,
      );

      const republished = await publisher.publish(makeDocument({ title: "Foo-Bar" }));

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// Same bug shape, character references: `&amp;` is resolved by
    // remark to a literal `&`.
    "recognizes an existing link written with an HTML character reference as already linked", async () => {
      const first = await publisher.publish(makeDocument({ title: "Foo&Bar" }));
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      expect(target).toContain("Foo&Bar");
      const referencedTarget = target.replace(/&/g, "&amp;");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n- [[${referencedTarget}]]\n`,
      );

      const republished = await publisher.publish(makeDocument({ title: "Foo&Bar" }));

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// MAJOR 2 (2026-09-13 Codex frontier review round 6, third pass): the
    // former sentinel character (U+E000) is ordinary text; nothing stops
    // a real note title from containing it. A real, unfragmented link to
    // such a target must still be recognized as already linked (no
    // duplicate inserted).
    "recognizes an existing link to a target containing the former sentinel character (U+E000) as already linked", async () => {
      const puaTitle = "Foo\uE000Bar";
      const first = await publisher.publish(makeDocument({ title: puaTitle }));
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      expect(target).toContain(puaTitle);
      cli.notes.set(indexPath, `# Source Captures\n\n## Sources\n\n- [[${target}]]\n`);

      const republished = await publisher.publish(makeDocument({ title: puaTitle }));

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// MAJOR (2026-09-13 Codex frontier review round 9, scoped): the
    // alias group used to stop at the FIRST `]`, so an alias containing
    // a literal `]` (written as a backslash escape, which remark
    // resolves to a literal `]`) made the whole `[[target|alias]]` match
    // fail entirely, and the publisher would insert a duplicate note.
    "recognizes an existing link whose alias contains a backslash-escaped closing bracket as already linked", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n- [[${target}|Foo\\]Bar]]\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// Same bug shape, character reference: `&#93;` is resolved by remark
    // to a literal `]`.
    "recognizes an existing link whose alias contains a numeric HTML character reference for ] as already linked", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n- [[${target}|Foo&#93;Bar]]\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// MINOR 1 (2026-09-13 Codex frontier review round 9, scoped): an
    // image REFERENCE (`![alt][ref]`) is a distinct mdast node type from
    // a direct image, and lacked dedicated end-to-end coverage: a
    // pseudo-link fragmented by one must not be recognized as a live
    // link, and the publisher must still add the real one.
    "does not count a pseudo-link fragmented by an image reference as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n[[${target.slice(0, 5)}![alt][ref]${target.slice(5)}]]\n\n[ref]: https://example.com\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", target)).toHaveLength(1);
    });

    it(// MAJOR (2026-09-13 Codex frontier review round 10, scoped): an
    // unterminated link's alias scan used to cross a NESTED `[[` and
    // "borrow" a later link's closing `]]` -- a MOC with a malformed
    // `[[a|unterminated ] text [[b]]` line wrongly counted `a` as
    // already linked (suppressing the real link `a` still needs) while
    // correctly counting `b` (which is a genuinely well-formed link, and
    // must not be duplicated).
    "adds the real link for a target preceded by a malformed unterminated link, without duplicating the genuinely well-formed link that follows it", async () => {
      const first = await publisher.publish(
        makeDocument({
          title: "Malformed Target A",
          sourceUrl: "https://docs.astral.sh/uv/a/",
        }),
      );
      const second = await publisher.publish(
        makeDocument({
          title: "Malformed Target B",
          sourceUrl: "https://docs.astral.sh/uv/b/",
        }),
      );
      const indexPath = "00 Inbox/Source Captures/index.md";
      const targetA = first.path.replace(/\.md$/, "");
      const targetB = second.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n[[${targetA}|unterminated ] text [[${targetB}]]\n`,
      );

      const republishedA = await publisher.publish(
        makeDocument({
          title: "Malformed Target A",
          sourceUrl: "https://docs.astral.sh/uv/a/",
        }),
      );
      const republishedB = await publisher.publish(
        makeDocument({
          title: "Malformed Target B",
          sourceUrl: "https://docs.astral.sh/uv/b/",
        }),
      );

      expect(republishedA.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", targetA)).toHaveLength(1);
      expect(republishedB.moc).toBe("linked");
      expect(linksTo(cli.notes.get(indexPath) ?? "", targetB)).toHaveLength(1);
    });

    it("cannot be made to inject a second link through a hostile title", async () => {
      const publication = await publisher.publish(
        makeDocument({ title: "Innocent]]\n- [[Evil Injected Note|pwned" }),
      );

      const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";
      const wikilinks = index.match(/\[\[/g) ?? [];

      expect(publication.moc).toBe("linked");
      // The hostile text survives as inert display text, never as a second link.
      expect(wikilinks).toHaveLength(1);
      expect(index).not.toContain("[[Evil Injected Note");
      const sourcesSection = index.split("## Sources")[1] ?? "";
      expect(sourcesSection.trim().split("\n")).toHaveLength(1);
    });
  });

  describe("collection folder resolution", () => {
    it("reuses an existing folder's established spelling for a case variant", async () => {
      cli.folders.add("30 Tools-Models/Doc Sets/SpotOn Restaurant API");

      const publication = await publisher.publish(
        makeDocument({ collection: "spoton restaurant api" }),
      );

      expect(
        publication.path.startsWith("30 Tools-Models/Doc Sets/SpotOn Restaurant API/"),
      ).toBe(true);
    });

    it("refuses to publish when two folders claim one collection identity", async () => {
      cli.folders.add("30 Tools-Models/Doc Sets/SpotOn Restaurant API");
      cli.folders.add("30 Tools-Models/Doc Sets/spoton restaurant api");

      await expect(
        publisher.publish(makeDocument({ collection: "SpotOn Restaurant API" })),
      ).rejects.toThrow(/ambiguous/i);
    });
  });

  describe("semantic comparison", () => {
    it("treats a quoted scalar containing an escape sequence as changed, not unchanged", async () => {
      const document = makeDocument({ requestedUrl: "https://example.invalid/a\\nb" });
      const first = await publisher.publish(document);

      // A human re-quotes the scalar so YAML now decodes it as a real newline.
      const rewritten = (cli.notes.get(first.path) ?? "").replace(
        /^requested_url:.*$/m,
        'requested_url: "https://example.invalid/a\\nb"',
      );
      cli.notes.set(first.path, rewritten);

      const second = await publisher.publish(document);

      expect(second.status).toBe("conflict");
      expect(cli.notes.get(first.path)).toBe(rewritten);
    });

    it("republishes an unchanged multiline version without reporting a conflict", async () => {
      const document = makeDocument({ version: "release\nnotes" });
      await publisher.publish(document);

      const second = await publisher.publish(document);

      expect(second.status).toBe("unchanged");
    });

    it("treats an unparseable frontmatter block as a conflict", async () => {
      const first = await publisher.publish(makeDocument());
      cli.notes.set(first.path, "---\n:\n  - [unclosed\n---\nbody\n");

      const second = await publisher.publish(makeDocument());

      expect(second.status).toBe("conflict");
      expect(cli.notes.get(first.path)).toContain("unclosed");
    });
  });

  it("links exactly once when another writer creates the index first", async () => {
    const indexPath = "00 Inbox/Source Captures/index.md";
    const realRun = cli.run;
    let intercepted = false;

    // Another process creates the index between our read and our create.
    const racingCli = new ObsidianCli(async (args, stdin) => {
      if (!intercepted && args[0] === "create" && args[1] === indexPath) {
        intercepted = true;
        cli.notes.set(indexPath, "# Source Captures\n\n## Sources\n");
      }
      return realRun(args, stdin);
    });

    const racingPublisher = makePublisher(racingCli);
    const publication = await racingPublisher.publish(makeDocument());

    expect(publication.moc).toBe("linked");
    expect(
      linksTo(cli.notes.get(indexPath) ?? "", publication.path.replace(/\.md$/, "")),
    ).toHaveLength(1);
  });
});

// Regressions for the 2026-09-11 Codex review of commit ca3c3ad.
describe("VaultPublisher identity refresh", () => {
  let cli: FakeObsidianCliProcess;
  let publisher: VaultPublisher;

  beforeEach(() => {
    cli = new FakeObsidianCliProcess();
    publisher = makePublisher(cli);
  });

  it("sees a note created at another filename after the first scan", async () => {
    const first = await publisher.publish(makeDocument());

    // Another writer copies our note to a second filename afterwards. A valid
    // ownership record must not hide that duplicate identity.
    const alternate = "00 Inbox/Source Captures/another filename aaaa.md";
    cli.notes.set(alternate, first.markdown);

    const second = await publisher.publish(
      makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` }),
    );

    expect(second.status).toBe("conflict");
    expect(second.conflictReason).toBe("identity-conflict");
    expect(cli.notes.get(first.path)).toBe(first.markdown);
    expect(cli.notes.get(alternate)).toBe(first.markdown);
  });

  it("follows a note somebody moved rather than recreating it", async () => {
    const first = await publisher.publish(makeDocument());

    const moved = "00 Inbox/Source Captures/moved by a human aaaa.md";
    cli.notes.set(moved, first.markdown);
    cli.notes.delete(first.path);

    const second = await publisher.publish(makeDocument());

    expect(second.path).toBe(moved);
    const notes = [...cli.notes.keys()].filter(
      (key) => key.startsWith("00 Inbox/Source Captures/") && !key.endsWith("index.md"),
    );
    expect(notes).toEqual([moved]);
  });

  it("re-scans before allocating a path when a note appears mid-run", async () => {
    // Warm the scan with an unrelated capture, then let a note for our own
    // identity appear before the next capture allocates a filename.
    await publisher.publish(
      makeDocument({
        sourceUrl: "https://docs.astral.sh/uv/guides/scripts/",
        requestedUrl: "https://docs.astral.sh/uv/guides/scripts/",
        title: "Other Source",
      }),
    );

    const planted = "00 Inbox/Source Captures/planted by another process.md";
    cli.notes.set(
      planted,
      `---\ntype: source\ntitle: Planted\nsource_id: ${sourceId(makeDocument())}\n---\nplanted\n`,
    );

    const publication = await publisher.publish(makeDocument());

    expect(publication.path).toBe(planted);
    expect(publication.status).toBe("conflict");
    expect(cli.notes.get(planted)).toContain("planted");
    const notes = [...cli.notes.keys()].filter(
      (key) => key.startsWith("00 Inbox/Source Captures/") && !key.endsWith("index.md"),
    );
    expect(notes).toHaveLength(2);
  });

  it("notices a neighbour that starts claiming the target identity", async () => {
    const neighbour = "00 Inbox/Source Captures/neighbour.md";
    cli.notes.set(neighbour, "---\ntype: source\nsource_id: neighbour-1\n---\nbody\n");

    const first = await publisher.publish(makeDocument());

    // The pathname never changes, only its contents: a listing cannot see this,
    // so a cached identity for an already-scanned path would miss it entirely.
    cli.notes.set(
      neighbour,
      `---\ntype: source\nsource_id: ${sourceId(makeDocument())}\n---\nbody\n`,
    );

    const second = await publisher.publish(
      makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` }),
    );

    expect(second.status).toBe("conflict");
    expect(second.conflictReason).toBe("identity-conflict");
    expect(cli.notes.get(first.path)).toBe(first.markdown);
  });

  it("notices an identity added to a note that had none", async () => {
    const plain = "00 Inbox/Source Captures/plain.md";
    cli.notes.set(plain, "# Just a note\n");

    await publisher.publish(
      makeDocument({
        sourceUrl: "https://docs.astral.sh/uv/guides/scripts/",
        requestedUrl: "https://docs.astral.sh/uv/guides/scripts/",
        title: "Other Source",
      }),
    );

    cli.notes.set(
      plain,
      `---\ntype: source\nsource_id: ${sourceId(makeDocument())}\n---\nadopted\n`,
    );

    const publication = await publisher.publish(makeDocument());

    // The identity now lives at a path the scan had already dismissed, so no
    // second note may be allocated for it.
    expect(publication.path).toBe(plain);
    expect(publication.status).toBe("conflict");
    const notes = [...cli.notes.keys()].filter(
      (key) => key.startsWith("00 Inbox/Source Captures/") && !key.endsWith("index.md"),
    );
    expect(notes).toHaveLength(2);
  });

  it("falls back to the ownership record when our own note loses its identity", async () => {
    const first = await publisher.publish(makeDocument());

    // A human strips the frontmatter; the scan can no longer see the identity.
    cli.notes.set(first.path, "# Stripped by a human\n");

    const second = await publisher.publish(makeDocument());

    expect(second.path).toBe(first.path);
    expect(second.status).toBe("conflict");
    expect(cli.notes.get(first.path)).toBe("# Stripped by a human\n");
    const notes = [...cli.notes.keys()].filter(
      (key) => key.startsWith("00 Inbox/Source Captures/") && !key.endsWith("index.md"),
    );
    expect(notes).toHaveLength(1);
  });
});

describe("VaultPublisher pending links", () => {
  let cli: FakeObsidianCliProcess;

  /** An index that exists but carries no `## Sources` heading. */
  const unamendableIndex = () =>
    cli.notes.set(
      "00 Inbox/Source Captures/index.md",
      "# Source Captures\n\n## Something Else\n",
    );

  beforeEach(() => {
    cli = new FakeObsidianCliProcess();
  });

  it("keeps the journal entry when the MOC link could not be made", async () => {
    unamendableIndex();

    const publication = await makePublisher(cli).publish(makeDocument());

    expect(publication.status).toBe("published");
    expect(publication.moc).toBe("pending");

    // An unlinked note is unfinished work, and doctor has to be able to see it.
    const pending = new PublicationJournal({ stateDir, vaultPath: vaultDir }).pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].phase).toBe("note-written");
  });

  it("reports recovery as incomplete while the link is still impossible", async () => {
    unamendableIndex();
    await makePublisher(cli).publish(makeDocument());

    const report = await makePublisher(cli).recoverPending();

    expect(report[0].classification).toBe("resumable");
    expect(report[0].completed).toBe(false);
    expect(
      new PublicationJournal({ stateDir, vaultPath: vaultDir }).pending(),
    ).toHaveLength(1);
  });

  it("finishes recovery once the heading is repaired", async () => {
    unamendableIndex();
    const publication = await makePublisher(cli).publish(makeDocument());

    cli.notes.set(
      "00 Inbox/Source Captures/index.md",
      "# Source Captures\n\n## Something Else\n\n## Sources\n",
    );

    const report = await makePublisher(cli).recoverPending();

    expect(report[0].completed).toBe(true);
    expect(
      linksTo(
        cli.notes.get("00 Inbox/Source Captures/index.md") ?? "",
        publication.path.replace(/\.md$/, ""),
      ),
    ).toHaveLength(1);
    expect(new PublicationJournal({ stateDir, vaultPath: vaultDir }).pending()).toEqual(
      [],
    );
  });

  it("still records ownership for a note it wrote but could not link", async () => {
    unamendableIndex();
    const publication = await makePublisher(cli).publish(makeDocument());

    const second = await makePublisher(cli).publish(makeDocument());

    expect(second.status).toBe("unchanged");
    expect(cli.notes.get(publication.path)).toBe(publication.markdown);
  });
});

describe("VaultPublisher concurrent recovery", () => {
  let cli: FakeObsidianCliProcess;

  beforeEach(() => {
    cli = new FakeObsidianCliProcess();
  });

  it("rereads the entry inside the lock instead of acting on a stale snapshot", async () => {
    const first = await makePublisher(cli).publish(makeDocument());
    cli.notes.set(
      "00 Inbox/Source Captures/index.md",
      "# Source Captures\n\n## Sources\n",
    );

    const journal = new PublicationJournal({ stateDir, vaultPath: vaultDir });
    journal.prepare({
      sourceId: sourceId(makeDocument()),
      path: first.path,
      priorWholeNoteDigest: first.digest,
      proposedWholeNoteDigest: first.digest,
      bytes: first.markdown,
    });
    journal.advance(sourceId(makeDocument()), "note-written");

    // Two recoverers race over one entry; the loser must notice it is gone
    // rather than advancing an entry that no longer exists.
    const [one, two] = await Promise.all([
      makePublisher(cli).recoverPending(),
      makePublisher(cli).recoverPending(),
    ]);

    expect([...one, ...two].filter((outcome) => outcome.completed)).toHaveLength(1);
    expect(new PublicationJournal({ stateDir, vaultPath: vaultDir }).pending()).toEqual(
      [],
    );
    expect(
      linksTo(
        cli.notes.get("00 Inbox/Source Captures/index.md") ?? "",
        first.path.replace(/\.md$/, ""),
      ),
    ).toHaveLength(1);
  });

  it("does not discard a newer publication because a snapshot said complete", async () => {
    const first = await makePublisher(cli).publish(makeDocument());
    const id = sourceId(makeDocument());

    const journal = new PublicationJournal({ stateDir, vaultPath: vaultDir });
    journal.prepare({
      sourceId: id,
      path: first.path,
      priorWholeNoteDigest: first.digest,
      proposedWholeNoteDigest: first.digest,
      bytes: first.markdown,
    });
    journal.advance(id, "complete");

    // While recovery waits for the lock, a fresh capture replaces that entry
    // with a genuinely pending one.
    const slow = journal.withLock(id, async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      journal.prepare({
        sourceId: id,
        path: first.path,
        priorWholeNoteDigest: first.digest,
        proposedWholeNoteDigest: sha256("a newer proposal"),
        bytes: "---\ntype: source\n---\na newer proposal\n",
      });
    });

    await Promise.all([slow, makePublisher(cli).recoverPending()]);

    // The newer entry survives: recovery classified what it locked, not what
    // it had read before waiting.
    const remaining = new PublicationJournal({ stateDir, vaultPath: vaultDir }).pending();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].proposedWholeNoteDigest).toBe(sha256("a newer proposal"));
  });
});

describe("VaultPublisher compare-and-swap failures", () => {
  let cli: FakeObsidianCliProcess;

  beforeEach(() => {
    cli = new FakeObsidianCliProcess();
  });

  /** Builds a publisher that runs `mutate` once, just before its first write. */
  function racedOnWrite(mutate: () => void): VaultPublisher {
    let raced = false;
    return makePublisher(
      new ObsidianCli(async (args, stdin) => {
        if (!raced && args[0] === "write") {
          raced = true;
          mutate();
        }
        return cli.run(args, stdin);
      }),
    );
  }

  it("preserves an edit that lands between the read and the write", async () => {
    const first = await makePublisher(cli).publish(makeDocument());
    const handEdited = `${first.markdown}\nA human, mid-write.\n`;

    const publication = await racedOnWrite(() => {
      cli.notes.set(first.path, handEdited);
    }).publish(makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` }));

    expect(publication.status).toBe("conflict");
    expect(cli.notes.get(first.path)).toBe(handEdited);
    expect(publication.candidatePath).toBeDefined();
  });

  it("retries once from a fresh anchor when the bytes did not change", async () => {
    const first = await makePublisher(cli).publish(makeDocument());

    // The anchor is invalidated without the bytes changing — a touch, not an
    // edit — so exactly one retry must carry the write through.
    const publication = await racedOnWrite(() => {
      cli.bumpAnchor(first.path);
    }).publish(makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` }));

    expect(publication.status).toBe("replaced");
    expect(cli.notes.get(first.path)).toContain("Upstream changed.");
  });

  it("accepts a proposal another writer already applied", async () => {
    const first = await makePublisher(cli).publish(makeDocument());
    const changed = makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` });
    const proposed = renderSourceNote(changed).markdown;

    const publication = await racedOnWrite(() => {
      cli.notes.set(first.path, proposed);
      cli.bumpAnchor(first.path);
    }).publish(changed);

    expect(publication.status).toBe("replaced");
    expect(cli.notes.get(first.path)).toBe(proposed);
    expect(new PublicationJournal({ stateDir, vaultPath: vaultDir }).pending()).toEqual(
      [],
    );
  });

  it("treats a note deleted mid-write as a conflict rather than recreating it", async () => {
    const first = await makePublisher(cli).publish(makeDocument());

    const publication = await racedOnWrite(() => {
      cli.notes.delete(first.path);
    }).publish(makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` }));

    expect(publication.status).toBe("conflict");
    expect(cli.notes.has(first.path)).toBe(false);
  });
});

describe("VaultPublisher candidate integrity", () => {
  let cli: FakeObsidianCliProcess;
  let publisher: VaultPublisher;

  beforeEach(() => {
    cli = new FakeObsidianCliProcess();
    publisher = makePublisher(cli);
  });

  it("detects a frontmatter-only edit to a candidate", async () => {
    const first = await publisher.publish(makeDocument());
    cli.notes.set(first.path, "# Hand edited by a human\n");
    const changed = makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` });

    const second = await publisher.publish(changed);
    const candidatePath = second.candidatePath ?? "";

    // Semantically identical, byte-wise not: the whole-note digest is what has
    // to notice this one.
    const touched = (cli.notes.get(candidatePath) ?? "").replace(
      "captured_at: 2026-09-10T12:00:00.000Z",
      "captured_at: 2026-09-10T12:00:09.000Z",
    );
    expect(touched).not.toBe(cli.notes.get(candidatePath));
    cli.notes.set(candidatePath, touched);

    const third = await publisher.publish(changed);

    expect(third.conflictReason).toBe("candidate-modified");
    expect(cli.notes.get(candidatePath)).toBe(touched);
  });

  it("records what it is about to write before it writes the candidate", async () => {
    const first = await publisher.publish(makeDocument());
    cli.notes.set(first.path, "# Hand edited by a human\n");

    const second = await publisher.publish(
      makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` }),
    );

    // The baseline is durable state written around the creation, so an
    // interruption cannot leave a candidate with no recorded baseline.
    const name = (second.candidatePath ?? "").split("/").pop() ?? "";
    const record = new PublicationJournal({
      stateDir,
      vaultPath: vaultDir,
    }).readCandidate(name);
    expect(record?.digest).toBe(sha256(cli.notes.get(second.candidatePath ?? "") ?? ""));
    expect(record?.verified).toBe(true);
  });

  it("treats a candidate with no trustworthy baseline as modified", async () => {
    const first = await publisher.publish(makeDocument());
    cli.notes.set(first.path, "# Hand edited by a human\n");
    const changed = makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` });
    const second = await publisher.publish(changed);

    // Losing the record leaves bytes we cannot vouch for. Semantic equality is
    // not enough: a metadata-only edit is semantically identical.
    fs.rmSync(path.join(stateDir, "candidates"), { recursive: true, force: true });

    const third = await publisher.publish(changed);

    expect(third.candidatePath).toBe(second.candidatePath);
    expect(third.conflictReason).toBe("candidate-modified");
    expect(cli.notes.get(second.candidatePath ?? "")).toBe(
      cli.notes.get(third.candidatePath ?? ""),
    );
  });

  it("reconciles a candidate whose record never got its confirmation", async () => {
    const first = await publisher.publish(makeDocument());
    cli.notes.set(first.path, "# Hand edited by a human\n");
    const changed = makeDocument({ markdown: `${SOURCE_MARKDOWN}\nUpstream changed.\n` });
    const second = await publisher.publish(changed);
    const candidatePath = second.candidatePath ?? "";
    const name = candidatePath.split("/").pop() ?? "";

    // Exactly the state a process death between creation and confirmation
    // leaves behind: intent recorded, never confirmed.
    const journal = new PublicationJournal({ stateDir, vaultPath: vaultDir });
    const record = journal.readCandidate(name);
    journal.writeCandidate({
      name,
      path: candidatePath,
      digest: record?.digest ?? "",
      verified: false,
    });

    // Untouched bytes still match the recorded intent, so the candidate is ours.
    expect((await publisher.publish(changed)).conflictReason).toBe("manual-edit");

    // A metadata-only edit no longer matches it, and must be reported.
    cli.notes.set(
      candidatePath,
      (cli.notes.get(candidatePath) ?? "").replace(
        "captured_at: 2026-09-10T12:00:00.000Z",
        "captured_at: 2026-09-10T12:00:09.000Z",
      ),
    );
    journal.writeCandidate({
      name,
      path: candidatePath,
      digest: record?.digest ?? "",
      verified: false,
    });

    expect((await publisher.publish(changed)).conflictReason).toBe("candidate-modified");
  });
});
