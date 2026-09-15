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

/**
 * Longest basename most filesystems accept, in bytes. The character cap above
 * does not bound this on its own: 80 CJK characters are 240 bytes.
 */
const MAX_BASENAME_BYTES = 255;

/**
 * Hash characters kept in a filename. The full identity stays in frontmatter;
 * a colliding prefix is resolved by falling back to the full hash.
 */
export const SHORT_HASH_LENGTH = 12;

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
 * Truncates at code-point boundaries so a UTF-8 budget is respected without
 * splitting a multibyte character or an astral pair into a lone surrogate.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let result = "";
  let bytes = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) break;
    result += codePoint;
    bytes += size;
  }
  return result;
}

/**
 * Builds the filename for a source document.
 *
 * @param input The source document.
 * @param hashLength Identity characters to embed; the caller widens this to a
 *   full hash when a different source already holds the shorter name.
 * @returns A basename within the filesystem's byte limit.
 */
export function noteFilename(
  input: SourceDocument,
  hashLength: number = SHORT_HASH_LENGTH,
): string {
  const suffix = ` ${sourceId(input).slice(0, hashLength)}.md`;
  const budget = MAX_BASENAME_BYTES - Buffer.byteLength(suffix, "utf8");
  const title = truncateToBytes(sanitizeSegment(input.title), budget).trimEnd();

  return `${title.length > 0 ? title : "untitled"}${suffix}`;
}

/**
 * Builds the filename for a preserved conflict candidate.
 *
 * The name stays content addressed — source identity plus semantic content
 * digest — so an unchanged conflict reuses one candidate; the sanitized title
 * in front only makes it readable to a human browsing the inbox.
 *
 * @param options.title Source title, sanitized and truncated to fit.
 * @param options.sourceId Full source identity hash.
 * @param options.semanticDigest Full semantic content digest.
 * @returns A basename within the filesystem's byte limit.
 */
export function candidateFilename(options: {
  title: string;
  sourceId: string;
  semanticDigest: string;
}): string {
  const suffix = ` ${options.sourceId.slice(0, SHORT_HASH_LENGTH)}-${options.semanticDigest.slice(0, SHORT_HASH_LENGTH)}.md`;
  const budget = MAX_BASENAME_BYTES - Buffer.byteLength(suffix, "utf8");
  const title = truncateToBytes(sanitizeSegment(options.title), budget).trimEnd();

  return `${title.length > 0 ? title : "untitled"}${suffix}`;
}

/**
 * Computes the vault path for a source document.
 *
 * @param input The source document.
 * @param options.folder Resolved collection folder; defaults to the derived one.
 * @param options.hashLength Identity characters to embed in the filename.
 */
export function notePath(
  input: SourceDocument,
  options: { folder?: string; hashLength?: number } = {},
): string {
  const folder = options.folder ?? collectionPath(input.collection);
  return `${folder}/${noteFilename(input, options.hashLength ?? SHORT_HASH_LENGTH)}`;
}

/**
 * Reduces a title to a single-line wikilink display label.
 *
 * A filename-safe segment is not enough here: `]]`, `|` and newlines are
 * meaningful in the link context and would let a title inject extra entries
 * into a collection index.
 */
export function sanitizeLinkAlias(title: string): string {
  const cleaned = title
    .replace(/[\r\n]+/g, " ")
    .replace(/[[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "untitled";
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
