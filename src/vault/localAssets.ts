/**
 * Local-asset preservation for `file://` captures.
 *
 * A Markdown file captured from disk may embed images relative to itself.
 * Those bytes are not part of the note, so publishing the note alone loses
 * them (Task 6 row F06). This module finds such embeds, chooses one
 * deterministic vault destination per asset under the vault's attachment
 * folder, and rewrites the embed to point there. It never touches the vault
 * itself: the publisher copies the listed assets through `obsidian-cli
 * attach` before it writes the note, so a link never dangles.
 *
 * Embeds are located as mdast `image` nodes (and the `definition` nodes that
 * reference-style `imageReference`s resolve through) by the same
 * `remark-parse` toolchain `markdownLinks.mjs` uses — never by regex — so
 * image-looking text inside fenced or inline code is left alone, and
 * angle-bracket destinations, titles, spaces and parentheses are handled by
 * the parser rather than guessed at (2026-09-14 Codex review of this row).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Definition, Image, ImageReference, Node, Parent, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { sha256, sourceId } from "./identity";
import type { SourceDocument } from "./types";

/** Obsidian's configured attachment folder (`attachmentFolderPath`). */
export const ATTACHMENTS_ROOT = "_attachments";

/** One asset to copy: where it is on disk and where it lands in the vault. */
export interface LocalAsset {
  localPath: string;
  vaultPath: string;
}

const HASH_LENGTH = 12;

const ESCAPE_HASH_LENGTH = 8;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const processor = unified().use(remarkParse);

/**
 * Depth-first walk over every node, the same shape `markdownLinks.mjs` uses
 * rather than pulling `unist-util-visit` (a transitive dependency only) into
 * the declared tree.
 */
function walk(node: Node, visitor: (node: Node) => void): void {
  visitor(node);
  const children = (node as Partial<Parent>).children;
  if (Array.isArray(children)) {
    for (const child of children) walk(child, visitor);
  }
}

const isImage = (node: Node): node is Image => node.type === "image";
const isImageReference = (node: Node): node is ImageReference =>
  node.type === "imageReference";
const isDefinition = (node: Node): node is Definition => node.type === "definition";

/**
 * Percent-encodes one vault path for a bare Markdown destination. Beyond
 * `encodeURIComponent`, parentheses are encoded too: a bare destination ends
 * at the first unbalanced `)`, so a filename or collection segment with an
 * unmatched parenthesis would otherwise truncate the link (2026-09-14 Codex
 * scoped re-review).
 */
const encodeLinkPath = (vaultPath: string): string =>
  vaultPath
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29"),
    )
    .join("/");

/**
 * Returns the original `[label]` bytes of a definition, so the rewrite never
 * has to re-escape a decoded label (an escaped `]` or backslash in the label
 * would otherwise be emitted raw and break the reference).
 */
function originalLabel(source: string): string {
  for (let index = 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "]") {
      return source.slice(0, index + 1);
    }
  }
  return source;
}

/** Resolves an embed target to a regular file beside the source, or null. */
function resolveLocalFile(target: string, sourceDir: string): string | null {
  if (
    target.length === 0 ||
    HAS_SCHEME.test(target) ||
    target.startsWith("/") ||
    target.startsWith("#")
  ) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (/\.(md|markdown)$/i.test(decoded)) return null;
  const resolved = path.resolve(sourceDir, decoded);
  try {
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Chooses the destination key for an asset: its path relative to the source
 * when it lives beside or below it, otherwise a short hash of that relative
 * path plus the basename. Two assets that share a basename in different
 * directories therefore never collide.
 */
function destinationKey(localPath: string, sourceDir: string): string {
  const relative = path.relative(sourceDir, localPath).split(path.sep).join("/");
  if (!relative.startsWith("../") && relative !== "..") return relative;
  return `${sha256(relative).slice(0, ESCAPE_HASH_LENGTH)}/${path.basename(localPath)}`;
}

const escapeAlt = (alt: string): string => alt.replace(/([\\\]])/g, "\\$1");

const renderTitle = (title: string | null | undefined): string =>
  title === null || title === undefined ? "" : ` "${title.replace(/"/g, '\\"')}"`;

/** One source-text replacement, applied from the end so offsets hold. */
interface Rewrite {
  start: number;
  end: number;
  text: string;
}

/**
 * Rewrites relative image embeds of a `file://` source to vault attachment
 * paths and lists the assets the publisher must copy first.
 *
 * @param input The converted source document.
 * @param folder Vault folder of the note's collection.
 * @returns The (possibly rewritten) document and its assets, in embed order.
 */
export function localizeLocalAssets(
  input: SourceDocument,
  folder: string,
): { input: SourceDocument; assets: LocalAsset[] } {
  if (!input.sourceUrl.startsWith("file:")) return { input, assets: [] };

  let sourceDir: string;
  try {
    sourceDir = path.dirname(fileURLToPath(input.sourceUrl));
  } catch {
    return { input, assets: [] };
  }

  const prefix = `${ATTACHMENTS_ROOT}/${folder}/${sourceId(input).slice(0, HASH_LENGTH)}`;
  const assets = new Map<string, LocalAsset>();
  const rewrites: Rewrite[] = [];

  const localize = (target: string): string | null => {
    const localPath = resolveLocalFile(target, sourceDir);
    if (localPath === null) return null;
    const vaultPath = `${prefix}/${destinationKey(localPath, sourceDir)}`;
    assets.set(vaultPath, { localPath, vaultPath });
    return encodeLinkPath(vaultPath);
  };

  const tree = processor.parse(input.markdown) as Root;

  // Reference-style images resolve through a definition; only definitions an
  // image actually uses are rewritten, so a plain `[text][ref]` link to a
  // local file is never turned into an attachment. CommonMark resolves a
  // duplicated label to its FIRST definition, so later duplicates are left
  // alone rather than rewritten and attached for nothing.
  const imageDefinitions = new Set<string>();
  walk(tree, (node) => {
    if (isImageReference(node)) imageDefinitions.add(node.identifier);
  });
  const rewrittenDefinitions = new Set<string>();

  walk(tree, (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (isImage(node)) {
      const link = localize(node.url);
      if (link === null) return;
      rewrites.push({
        start,
        end,
        text: `![${escapeAlt(node.alt ?? "")}](${link}${renderTitle(node.title)})`,
      });
    } else if (isDefinition(node) && imageDefinitions.has(node.identifier)) {
      if (rewrittenDefinitions.has(node.identifier)) return;
      rewrittenDefinitions.add(node.identifier);
      const link = localize(node.url);
      if (link === null) return;
      const label = originalLabel(input.markdown.slice(start, end));
      rewrites.push({ start, end, text: `${label}: ${link}${renderTitle(node.title)}` });
    }
  });

  if (rewrites.length === 0) return { input, assets: [] };

  let markdown = input.markdown;
  for (const rewrite of rewrites.sort((a, b) => b.start - a.start)) {
    markdown =
      markdown.slice(0, rewrite.start) + rewrite.text + markdown.slice(rewrite.end);
  }
  return { input: { ...input, markdown }, assets: [...assets.values()] };
}
