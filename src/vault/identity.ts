/**
 * Source identity and vault path derivation.
 *
 * Identity is the final canonical URL plus collection and version. It is
 * deliberately independent of the title, so retitling a source never creates a
 * second note.
 */

import { createHash } from "node:crypto";
import type { SourceDocument } from "./types";

/** Reserved collection for generic captures. */
export const INBOX_COLLECTION = "inbox";

/** Vault folder that the reserved `inbox` collection maps to. */
export const INBOX_COLLECTION_PATH = "00 Inbox/Source Captures";

/** Parent folder for explicitly named documentation collections. */
export const DOC_SETS_ROOT = "30 Tools-Models/Doc Sets";

/** Heading that collection indexes list their captured sources under. */
export const SOURCES_HEADING = "## Sources";

/** Longest title fragment kept in a filename, in characters. */
const MAX_TITLE_SEGMENT = 80;

/** Control characters, which must never reach a filename. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/** Path separators and characters Obsidian reserves in links. */
const RESERVED_CHARACTERS = /[\\/:*?"<>|#^[\]]/g;

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Normalizes a collection identifier for hashing and for use as an upstream
 * library name. Folder names keep their original casing; only identity is
 * normalized, so `SpotOn Restaurant API` and `spoton restaurant api` are one
 * collection rather than two.
 */
export const normalizeCollection = (collection: string): string =>
  collection.trim().replace(/\s+/g, " ").toLowerCase();

export const sourceId = (input: SourceDocument): string =>
  sha256(
    JSON.stringify([
      input.sourceUrl,
      normalizeCollection(input.collection),
      input.version,
    ]),
  );

/**
 * Reduces one path component to characters that are safe in a vault filename.
 *
 * Strips separators, the characters Obsidian reserves in links, control
 * characters and leading dots, so a hostile title can never escape its
 * collection or produce a hidden file.
 */
export function sanitizeSegment(segment: string): string {
  const cleaned = segment
    .normalize("NFC")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(RESERVED_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, MAX_TITLE_SEGMENT)
    .trim();

  return cleaned.length > 0 ? cleaned : "untitled";
}

/**
 * Resolves the vault folder that a collection's notes and index live in.
 *
 * @param collection Collection identifier as supplied by the caller.
 * @returns Vault-relative folder path.
 */
export function collectionPath(collection: string): string {
  if (normalizeCollection(collection) === INBOX_COLLECTION) {
    return INBOX_COLLECTION_PATH;
  }
  return `${DOC_SETS_ROOT}/${sanitizeSegment(collection)}`;
}

/** Vault-relative path of a collection's index note. */
export const collectionIndexPath = (collection: string): string =>
  `${collectionPath(collection)}/index.md`;

/**
 * Computes the vault path for a source document.
 *
 * The filename pairs a safe title fragment with the full source identity hash,
 * so two sources that share a title and version cannot collide.
 */
export function notePath(input: SourceDocument): string {
  return `${collectionPath(input.collection)}/${sanitizeSegment(input.title)} ${sourceId(input)}.md`;
}

/**
 * Asserts that a vault-relative path stays inside its collection folder.
 *
 * @throws Error when the path escapes the collection.
 */
export function assertWithinCollection(collection: string, path: string): void {
  const root = `${collectionPath(collection)}/`;
  const normalized = path.replace(/\/+/g, "/");
  if (
    !normalized.startsWith(root) ||
    normalized.includes("../") ||
    normalized.includes("/..")
  ) {
    throw new Error(`vault path escapes its collection: ${path}`);
  }
}
