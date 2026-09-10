/**
 * Renders a source document into the exact bytes of its vault note.
 *
 * The converted Markdown body is emitted unchanged: fenced code, tables, link
 * destinations and Unicode all survive byte for byte. Only YAML frontmatter is
 * added in front of it.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { notePath, sha256, sourceId } from "./identity";
import type { SourceDocument } from "./types";

/** Value written to every managed note's `publisher` field. */
export const PUBLISHER = "secondbrain-docs";

/** A rendered note plus the identities derived from it. */
export interface RenderedNote {
  /** Vault-relative path the note belongs at. */
  path: string;
  /** Whole-note bytes, frontmatter included. */
  markdown: string;
  /** SHA-256 of the whole-note bytes; governs ownership and staleness. */
  digest: string;
  /**
   * SHA-256 of the body plus stable provenance only. Capture time and
   * publisher release are excluded, so a recapture of unchanged content
   * compares equal.
   */
  semanticDigest: string;
  sourceId: string;
}

/**
 * Computes the digest used to decide whether a source actually changed.
 *
 * @param input The source document.
 * @returns Hex SHA-256 over the body and the provenance that identifies it.
 */
export function semanticDigest(input: SourceDocument): string {
  return sha256(
    JSON.stringify([
      input.markdown,
      input.sourceUrl,
      input.requestedUrl,
      sourceId(input),
      input.version,
      input.sourceContentType,
    ]),
  );
}

/**
 * Renders one source document as a complete vault note.
 *
 * @param input The source document to render.
 * @param options.publisherVersion Release string recorded in frontmatter;
 *   defaults to the build-injected application version.
 * @returns The note path, its exact bytes, and the derived digests.
 */
export function renderSourceNote(
  input: SourceDocument,
  options: { publisherVersion?: string } = {},
): RenderedNote {
  const id = sourceId(input);
  const frontmatter = stringifyYaml({
    type: "source",
    title: input.title,
    source_url: input.sourceUrl,
    requested_url: input.requestedUrl,
    source_id: id,
    collection: input.collection,
    version: input.version,
    captured_at: input.capturedAt,
    source_content_type: input.sourceContentType,
    content_sha256: sha256(input.markdown),
    publisher: PUBLISHER,
    publisher_version: options.publisherVersion ?? __APP_VERSION__,
  });

  const markdown = `---\n${frontmatter}---\n${input.markdown}`;

  return {
    path: notePath(input),
    markdown,
    digest: sha256(markdown),
    semanticDigest: semanticDigest(input),
    sourceId: id,
  };
}

/** A note split into decoded frontmatter and its body. */
export interface ParsedNote {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Parses a note's frontmatter with the YAML parser.
 *
 * Regex extraction is not YAML decoding: quoting, escapes, folded and block
 * scalars all change a scalar's value, so comparing raw matched text would
 * both miss real changes and invent false ones.
 *
 * @returns The decoded frontmatter and body, or null when the note has no
 *   frontmatter or its YAML is invalid or not a mapping.
 */
export function parseNoteFrontmatter(note: string): ParsedNote | null {
  const match = note.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  try {
    const data = parseYaml(match[1]);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    return { data: data as Record<string, unknown>, body: match[2] };
  } catch {
    return null;
  }
}

/**
 * Recomputes the semantic digest of a note already stored in the vault, so it
 * can be compared with {@link semanticDigest} of an incoming document.
 *
 * @returns The digest, or null when the note is not a parseable managed note —
 *   which callers must treat as a conflict rather than as unchanged.
 */
export function semanticDigestOfNote(note: string): string | null {
  const parsed = parseNoteFrontmatter(note);
  if (!parsed) return null;

  const text = (key: string): string | null =>
    typeof parsed.data[key] === "string" ? (parsed.data[key] as string) : null;

  const sourceUrl = text("source_url");
  const id = text("source_id");
  const contentType = text("source_content_type");
  if (sourceUrl === null || id === null || contentType === null) return null;

  const requestedUrl = text("requested_url") ?? sourceUrl;
  const rawVersion = parsed.data.version;
  const version =
    rawVersion === undefined || rawVersion === null ? "" : String(rawVersion);

  return sha256(
    JSON.stringify([parsed.body, sourceUrl, requestedUrl, id, version, contentType]),
  );
}

/**
 * Renders the default index note for a collection that has none yet.
 *
 * @param collection Collection identifier, used as the index title.
 * @returns Markdown for a minimal index carrying the `## Sources` heading.
 */
export function renderCollectionIndex(collection: string): string {
  return `---\ntype: moc\ntitle: ${JSON.stringify(collection)}\n---\n\n# ${collection}\n\n## Sources\n`;
}
