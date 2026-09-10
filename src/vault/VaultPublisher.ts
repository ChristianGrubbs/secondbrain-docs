/**
 * Publishes converted source documents into the Obsidian vault.
 *
 * The vault is authoritative: this class only ever creates notes, never
 * overwrites them. A note whose bytes no longer match what we would publish is
 * preserved and reported as a conflict; Task 3 adds the ownership journal that
 * turns a subset of those conflicts into authorized replacements.
 */

import {
  assertWithinCollection,
  collectionIndexPath,
  collectionPath,
  SOURCES_HEADING,
  sha256,
} from "./identity";
import {
  CasConflictError,
  HeadingFormatError,
  HeadingNotFoundError,
  type ObsidianCli,
} from "./ObsidianCli";
import { renderCollectionIndex, renderSourceNote, semanticDigest } from "./render";
import type { Publication, Publisher, SourceDocument } from "./types";

/** Reads the `source_id` recorded in a note's frontmatter, if any. */
function readSemanticMarker(note: string): string | null {
  const match = note.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const sourceUrl = match[1].match(/^source_url:\s*(.*)$/m)?.[1]?.trim();
  const requestedUrl = match[1].match(/^requested_url:\s*(.*)$/m)?.[1]?.trim();
  const sourceId = match[1].match(/^source_id:\s*(.*)$/m)?.[1]?.trim();
  const version = match[1].match(/^version:\s*(.*)$/m)?.[1]?.trim() ?? "";
  const contentType = match[1].match(/^source_content_type:\s*(.*)$/m)?.[1]?.trim();
  if (!sourceUrl || !sourceId || !contentType) return null;

  return sha256(
    JSON.stringify([
      match[2],
      stripQuotes(sourceUrl),
      stripQuotes(requestedUrl ?? sourceUrl),
      stripQuotes(sourceId),
      stripQuotes(version),
      stripQuotes(contentType),
    ]),
  );
}

/** Removes the quoting YAML may have added around a scalar. */
const stripQuotes = (value: string): string => value.replace(/^["'](.*)["']$/, "$1");

export class VaultPublisher implements Publisher {
  /** Serializes writes so concurrent crawl callbacks cannot duplicate a link. */
  private queue: Promise<unknown> = Promise.resolve();

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

    const rendered = renderSourceNote(input, this.options);
    assertWithinCollection(input.collection, rendered.path);

    let status: Publication["status"] = "published";
    let markdown = rendered.markdown;
    let digest = rendered.digest;

    try {
      await this.cli.createNote(rendered.path, rendered.markdown);
    } catch (error) {
      if (!(error instanceof CasConflictError)) throw error;

      const existing = await this.cli.readNote(rendered.path);
      if (existing === null) throw error;

      markdown = existing;
      digest = sha256(existing);
      // Capture time and publisher release deliberately do not count as change.
      status =
        readSemanticMarker(existing) === semanticDigest(input) ? "unchanged" : "conflict";
    }

    const moc = await this.linkFromCollectionIndex(input, rendered.path);
    return { status, path: rendered.path, markdown, digest, moc };
  }

  /**
   * Ensures the collection index carries exactly one link to the note.
   *
   * @returns `linked` once the link is present, `pending` when the index exists
   *   but cannot be safely amended.
   */
  private async linkFromCollectionIndex(
    input: SourceDocument,
    path: string,
  ): Promise<"linked" | "pending"> {
    const indexPath = collectionIndexPath(input.collection);
    const link = `- [[${path.replace(/\.md$/, "")}|${input.title}]]`;
    const target = `[[${path.replace(/\.md$/, "")}|`;

    const existing = await this.cli.readNote(indexPath);
    if (existing === null) {
      await this.cli.createNote(indexPath, renderCollectionIndex(collectionLabel(input)));
    } else {
      if (!existing.split("\n").includes(SOURCES_HEADING)) return "pending";
      if (existing.includes(target)) return "linked";
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

/** Human-facing label for a collection's index note. */
const collectionLabel = (input: SourceDocument): string =>
  collectionPath(input.collection).split("/").pop() ?? input.collection;
