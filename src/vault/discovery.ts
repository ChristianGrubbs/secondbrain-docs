/**
 * Finds which notes in a collection already carry which source identity.
 *
 * This is what freezes a note's path: a capture resolves its target by
 * `source_id` before it ever derives a filename, so retitling a source — or
 * losing the disposable ownership record — moves nothing and duplicates
 * nothing. `obsidian-cli list` walks exactly one directory level, so the
 * recursion lives here.
 */

import type { ObsidianCli } from "./ObsidianCli";
import { nullLogger, type VaultLogger } from "./PublicationJournal";
import { parseNoteFrontmatter } from "./render";

/** Notes read concurrently when nothing else is requested. */
const DEFAULT_CONCURRENCY = 4;

/** Deepest folder nesting the scan will follow. */
const MAX_DEPTH = 16;

/** Runs `worker` over `items` with at most `limit` in flight. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () =>
    (async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    })(),
  );

  await Promise.all(runners);
  return results;
}

/**
 * Collects every Markdown note under a collection folder, recursively.
 *
 * @returns Vault-relative note paths, sorted.
 */
async function collectNotePaths(
  cli: ObsidianCli,
  root: string,
  logger: VaultLogger,
): Promise<string[]> {
  const notes: string[] = [];
  const seen = new Set<string>();
  let level = [root];

  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
    const nextLevel: string[] = [];
    for (const directory of level) {
      if (seen.has(directory)) continue;
      seen.add(directory);

      const entries = await cli.listDirectory(directory);
      if (entries === null) continue;

      for (const entry of entries) {
        if (entry.toLowerCase().endsWith(".md")) notes.push(entry);
        else nextLevel.push(entry);
      }
    }
    level = nextLevel;
  }

  logger({
    level: "debug",
    event: "discovery.scanned",
    loc: "discovery.collectNotePaths",
    ctx: { root, noteCount: notes.length },
  });
  return notes.sort();
}

/** One scan of a collection folder. */
export interface SourceScan {
  /** Source id to sorted note paths; more than one path is a conflict. */
  map: Map<string, string[]>;
  /**
   * Every note path the scan saw, with the identity it carries (null when it
   * carries none). Passing this back as `known` makes the next scan cost one
   * listing plus a read of whatever is new.
   */
  seen: Map<string, string | null>;
}

/**
 * Scans a collection folder for source identities, reusing what is already
 * known.
 *
 * Re-listing is cheap and re-reading is not, so a repeat scan lists the folder
 * tree again — that is what catches a note another process created or moved
 * since the last scan — and only reads note paths it has not seen before.
 *
 * @param options.known Result of a previous scan's `seen`, if any.
 * @param options.stale Paths to re-read even when they are already known.
 */
export async function scanSources(options: {
  cli: ObsidianCli;
  collectionPath: string;
  concurrency?: number;
  logger?: VaultLogger;
  known?: Map<string, string | null>;
  stale?: Iterable<string>;
}): Promise<SourceScan> {
  const logger = options.logger ?? nullLogger;
  const known = new Map(options.known ?? []);
  for (const path of options.stale ?? []) known.delete(path);

  const notePaths = await collectNotePaths(options.cli, options.collectionPath, logger);
  const unknown = notePaths.filter((notePath) => !known.has(notePath));

  const found = await mapWithLimit(
    unknown,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (notePath) => {
      const markdown = await options.cli.readNote(notePath);
      if (markdown === null) return { path: notePath, sourceId: null };

      const raw = parseNoteFrontmatter(markdown)?.data.source_id;
      // A hand-edited id can decode as a number rather than a string, so the
      // value is coerced instead of required to be one.
      return {
        path: notePath,
        sourceId: raw === undefined || raw === null ? null : String(raw),
      };
    },
  );
  for (const hit of found) known.set(hit.path, hit.sourceId);

  // Only paths that still exist count; a note that was moved away stops
  // claiming its old identity.
  const seen = new Map<string, string | null>();
  const map = new Map<string, string[]>();
  for (const notePath of notePaths) {
    const sourceId = known.get(notePath) ?? null;
    seen.set(notePath, sourceId);
    if (sourceId === null) continue;
    const paths = map.get(sourceId);
    if (paths === undefined) map.set(sourceId, [notePath]);
    else paths.push(notePath);
  }

  for (const [sourceId, paths] of map) {
    if (paths.length > 1) {
      logger({
        level: "warn",
        event: "discovery.duplicate_identity",
        loc: "discovery.scanSources",
        ctx: { sourceId, paths },
      });
    }
  }

  return { map, seen };
}

/**
 * Maps every source identity in a collection folder to the notes carrying it.
 *
 * A key with more than one path is an identity conflict: two notes claim one
 * source, and a capture must resolve that rather than adding a third note.
 *
 * @param options.cli Vault CLI wrapper to read through.
 * @param options.collectionPath Vault-relative folder to scan.
 * @param options.concurrency Notes read at once; defaults to 4.
 * @returns Source id to sorted note paths.
 */
export async function discoverSources(options: {
  cli: ObsidianCli;
  collectionPath: string;
  concurrency?: number;
  logger?: VaultLogger;
}): Promise<Map<string, string[]>> {
  return (await scanSources(options)).map;
}
