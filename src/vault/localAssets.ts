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
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceId } from "./identity";
import type { SourceDocument } from "./types";

/** Obsidian's configured attachment folder (`attachmentFolderPath`). */
export const ATTACHMENTS_ROOT = "_attachments";

/** One asset to copy: where it is on disk and where it lands in the vault. */
export interface LocalAsset {
  localPath: string;
  vaultPath: string;
}

const HASH_LENGTH = 12;

/** Markdown image embed: `![alt](target)`, target without spaces or parens. */
const IMAGE_EMBED = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const encodeLinkPath = (vaultPath: string): string =>
  vaultPath.split("/").map(encodeURIComponent).join("/");

/** Resolves an embed target to a regular file beside the source, or null. */
function resolveLocalFile(target: string, sourceDir: string): string | null {
  if (HAS_SCHEME.test(target) || target.startsWith("/") || target.startsWith("#")) {
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

  const markdown = input.markdown.replace(
    IMAGE_EMBED,
    (whole: string, alt: string, target: string) => {
      const localPath = resolveLocalFile(target, sourceDir);
      if (localPath === null) return whole;
      const vaultPath = `${prefix}/${path.basename(localPath)}`;
      assets.set(vaultPath, { localPath, vaultPath });
      return `![${alt}](${encodeLinkPath(vaultPath)})`;
    },
  );

  if (assets.size === 0) return { input, assets: [] };
  return { input: { ...input, markdown }, assets: [...assets.values()] };
}
