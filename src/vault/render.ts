/**
 * Renders a source document into the exact bytes of its vault note.
 *
 * The converted Markdown body is emitted unchanged: fenced code, tables, link
 * destinations and Unicode all survive byte for byte. Only YAML frontmatter is
 * added in front of it.
 */

import { stringify as stringifyYaml } from "yaml";
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

/**
 * Renders the default index note for a collection that has none yet.
 *
 * @param collection Collection identifier, used as the index title.
 * @returns Markdown for a minimal index carrying the `## Sources` heading.
 */
export function renderCollectionIndex(collection: string): string {
  return `---\ntype: moc\ntitle: ${JSON.stringify(collection)}\n---\n\n# ${collection}\n\n## Sources\n`;
}
