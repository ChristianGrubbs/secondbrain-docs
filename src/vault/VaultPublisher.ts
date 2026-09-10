/**
 * Publishes converted source documents into the Obsidian vault.
 *
 * The vault is authoritative: this class only ever creates notes, never
 * overwrites them. A note whose content no longer matches what we would
 * publish is preserved and reported as a conflict; Task 3 adds the ownership
 * journal that turns a subset of those conflicts into authorized replacements.
 */

import {
  collectionIndexPath,
  DOC_SETS_ROOT,
  INBOX_COLLECTION,
  INBOX_COLLECTION_PATH,
  normalizeCollection,
  notePath,
  SOURCES_HEADING,
  sanitizeLinkAlias,
  sanitizeSegment,
  sha256,
} from "./identity";
import {
  CasConflictError,
  HeadingFormatError,
  HeadingNotFoundError,
  type ObsidianCli,
} from "./ObsidianCli";
import {
  parseNoteFrontmatter,
  renderCollectionIndex,
  renderSourceNote,
  semanticDigest,
  semanticDigestOfNote,
} from "./render";
import type { Publication, Publisher, SourceDocument } from "./types";

/** Full identity length, used when a short filename is already taken. */
const FULL_HASH_LENGTH = 64;

/**
 * Removes fenced code blocks so a link shown as an example is not mistaken for
 * a live link.
 */
function stripCodeFences(markdown: string): string {
  return markdown
    .split(/^```.*$/m)
    .filter((_, index) => index % 2 === 0)
    .join("\n");
}

/**
 * Reports whether an index already links to a note, with or without an alias.
 *
 * @param index The index note's Markdown.
 * @param target Vault path of the note, without its `.md` extension.
 */
function hasLinkTo(index: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`).test(stripCodeFences(index));
}

export class VaultPublisher implements Publisher {
  /** Serializes writes so concurrent crawl callbacks cannot duplicate a link. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Normalized collection identity to its one canonical vault folder. */
  private readonly folders = new Map<string, string>();

  constructor(
    private readonly cli: ObsidianCli,
    private readonly options: { publisherVersion?: string } = {},
  ) {}

  /**
   * Publishes one source document as a vault note and links it from its
   * collection index.
   *
   * @param input The converted source document.
   * @returns The publication outcome, including the note's current bytes.
   */
  publish(input: SourceDocument): Promise<Publication> {
    const result = this.queue.then(
      () => this.publishSerially(input),
      () => this.publishSerially(input),
    );
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async publishSerially(input: SourceDocument): Promise<Publication> {
    if (input.markdown.trim().length === 0) {
      throw new Error(`refusing to publish empty markdown for ${input.sourceUrl}`);
    }

    const folder = await this.resolveCollectionFolder(input.collection);
    const rendered = renderSourceNote(input, this.options);
    const incomingDigest = semanticDigest(input);

    let path = notePath(input, { folder });
    let status: Publication["status"] = "published";
    let markdown = rendered.markdown;
    let digest = rendered.digest;

    try {
      await this.cli.createNote(path, rendered.markdown);
    } catch (error) {
      if (!(error instanceof CasConflictError)) throw error;

      const existing = await this.cli.readNote(path);
      if (existing === null) throw error;

      // A hand-edited `source_id` can decode as a number rather than a string
      // (YAML reads an all-digit scalar as one), so coerce instead of
      // requiring a string: an id we cannot match is treated as somebody
      // else's note, which is the safe direction.
      const rawId = parseNoteFrontmatter(existing)?.data.source_id;
      const existingId = rawId === undefined || rawId === null ? null : String(rawId);
      if (existingId !== null && existingId !== rendered.sourceId) {
        // A different source already holds the short filename. Widen to the
        // full identity rather than touching a note that is not ours.
        path = notePath(input, { folder, hashLength: FULL_HASH_LENGTH });
        return this.publishAt(input, path, rendered, incomingDigest);
      }

      markdown = existing;
      digest = sha256(existing);
      // Capture time and publisher release deliberately do not count as change.
      // An unparseable note yields null, which can never equal a real digest.
      status =
        semanticDigestOfNote(existing) === incomingDigest ? "unchanged" : "conflict";
    }

    const moc = await this.linkFromCollectionIndex(input, folder, path);
    return { status, path, markdown, digest, moc };
  }

  /** Publishes at an already-chosen path, used for the widened-hash retry. */
  private async publishAt(
    input: SourceDocument,
    path: string,
    rendered: ReturnType<typeof renderSourceNote>,
    incomingDigest: string,
  ): Promise<Publication> {
    const folder = await this.resolveCollectionFolder(input.collection);
    let status: Publication["status"] = "published";
    let markdown = rendered.markdown;
    let digest = rendered.digest;

    try {
      await this.cli.createNote(path, rendered.markdown);
    } catch (error) {
      if (!(error instanceof CasConflictError)) throw error;
      const existing = await this.cli.readNote(path);
      if (existing === null) throw error;
      markdown = existing;
      digest = sha256(existing);
      status =
        semanticDigestOfNote(existing) === incomingDigest ? "unchanged" : "conflict";
    }

    const moc = await this.linkFromCollectionIndex(input, folder, path);
    return { status, path, markdown, digest, moc };
  }

  /**
   * Resolves a collection to exactly one vault folder.
   *
   * Identity is case-insensitive, so two spellings of one collection must not
   * resolve to two folders. An existing folder's established spelling wins;
   * two folders claiming one identity is an error rather than a coin toss.
   *
   * @throws Error when the mapping is ambiguous.
   */
  private async resolveCollectionFolder(collection: string): Promise<string> {
    const normalized = normalizeCollection(collection);
    if (normalized === INBOX_COLLECTION) return INBOX_COLLECTION_PATH;

    const cached = this.folders.get(normalized);
    if (cached !== undefined) return cached;

    const entries = (await this.cli.listDirectory(DOC_SETS_ROOT)) ?? [];
    const matches = entries.filter(
      (entry) => normalizeCollection(entry.split("/").pop() ?? "") === normalized,
    );

    if (matches.length > 1) {
      throw new Error(
        `ambiguous collection folder for "${collection}": ${matches.join(", ")}`,
      );
    }

    const folder = matches[0] ?? `${DOC_SETS_ROOT}/${sanitizeSegment(collection)}`;
    this.folders.set(normalized, folder);
    return folder;
  }

  /**
   * Ensures the collection index carries exactly one link to the note.
   *
   * @returns `linked` once the link is present, `pending` when the index exists
   *   but cannot be safely amended.
   */
  private async linkFromCollectionIndex(
    input: SourceDocument,
    folder: string,
    path: string,
  ): Promise<"linked" | "pending"> {
    const indexPath = `${folder}/index.md`;
    const target = path.replace(/\.md$/, "");
    const link = `- [[${target}|${sanitizeLinkAlias(input.title)}]]`;

    let index = await this.cli.readNote(indexPath);

    if (index === null) {
      try {
        await this.cli.createNote(
          indexPath,
          renderCollectionIndex(folder.split("/").pop() ?? input.collection),
        );
        index = null;
      } catch (error) {
        if (!(error instanceof CasConflictError)) throw error;
        // Another writer created the index between our read and our create.
        index = await this.cli.readNote(indexPath);
        if (index === null) throw error;
      }
    }

    if (index !== null) {
      if (!index.split("\n").includes(SOURCES_HEADING)) return "pending";
      if (hasLinkTo(index, target)) return "linked";
    }

    try {
      await this.cli.insertUnderHeading(indexPath, SOURCES_HEADING, link);
      return "linked";
    } catch (error) {
      if (error instanceof HeadingFormatError || error instanceof HeadingNotFoundError) {
        return "pending";
      }
      throw error;
    }
  }
}

/** Re-exported so callers can build an index path without the publisher. */
export { collectionIndexPath };
