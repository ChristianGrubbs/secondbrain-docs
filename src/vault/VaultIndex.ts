/**
 * Derives retrieval from the documents already saved in the vault.
 *
 * The vault is authoritative; this index is disposable. Nothing here ever
 * fetches an original source, and nothing here ever writes to the vault: an
 * index entry is built from the exact bytes `obsidian-cli` reports for a note,
 * read *after* publication, so a manual edit is indexed as it stands and a
 * crawler chunk that disagrees with the saved note is never persisted.
 *
 * Four properties are load bearing:
 *
 * - **Generations.** An index lives in `<stateDir>/index/generations/<name>`
 *   and is reached through an atomically renamed pointer. A rebuild fills a
 *   fresh sibling generation and only then switches the pointer, so a rebuild
 *   that fails at any point leaves the previous generation serving searches.
 * - **One state-level lock.** Every upsert, search and rebuild runs inside the
 *   single interprocess lock at `<stateDir>/locks/index.db`
 *   ({@link withExclusiveLock}). The lock is not reentrant, so the private
 *   `*Locked` methods take the critical section as given — a stale-hit refresh
 *   during a search calls {@link VaultIndex.upsertLocked}, never
 *   {@link VaultIndex.upsert}.
 * - **The manifest is derived.** It maps source identity and vault path to the
 *   current whole-note digest, and losing it is recoverable: a search that
 *   finds no manifest rebuilds one from discovery rather than failing or
 *   guessing.
 * - **No embeddings, no network.** The store is constructed with
 *   `embeddingModel: ""` and `telemetryEnabled: false` forced on a private copy
 *   of the loaded configuration, so FTS is the whole retrieval path and an
 *   ambient provider key cannot switch it on.
 *
 * Deviation from the migration plan, recorded deliberately: the plan says to
 * strip YAML metadata with `gray-matter`. This uses the fork's existing
 * {@link parseNoteFrontmatter} (the `yaml` dependency) instead, so the fork has
 * exactly one frontmatter parser and the body bytes an index chunk is built
 * from cannot diverge from the body bytes publication compares. `gray-matter`
 * is not a dependency of this repository and adding a second parser to gain a
 * second answer would be the bug, not the feature.
 */

import fs from "node:fs";
import path from "node:path";
import { EventBusService } from "../events";
import { FetchStatus } from "../scraper/fetcher/types";
import { PipelineFactory } from "../scraper/pipelines/PipelineFactory";
import type { ContentPipeline } from "../scraper/pipelines/types";
import { ScrapeMode, type ScrapeResult, type ScraperOptions } from "../scraper/types";
import type { Chunk } from "../splitter/types";
import { DocumentManagementService } from "../store/DocumentManagementService";
import type { AppConfig } from "../utils/config";
import { loadConfig } from "../utils/config";
import { type ScannedNote, scanNotes } from "./discovery";
import { collectionPath, normalizeCollection, sha256, sourceId } from "./identity";
import { type LockOptions, withExclusiveLock } from "./lock";
import type { ObsidianCli } from "./ObsidianCli";
import {
  createJsonlLogger,
  PublicationJournal,
  type VaultLogger,
} from "./PublicationJournal";
import { PUBLISHER, parseNoteFrontmatter } from "./render";
import { SOURCE_UPDATES_PATH } from "./VaultPublisher";

/** Format version of the manifest file; an unknown one is treated as lost. */
export const INDEX_MANIFEST_VERSION = 1;

/** MIME type every vault note body is indexed as. */
const NOTE_MIME_TYPE = "text/markdown";

/** Characters of stored chunk content carried into a search envelope. */
const EXCERPT_LENGTH = 400;

/** Notes a rebuild probes by search before it switches the pointer. */
const PROBE_SAMPLE_SIZE = 5;

/** Generations kept after a successful switch: the current one and its parent. */
const GENERATIONS_KEPT = 2;

/** The note produced no chunks, so there is nothing to retrieve it by. */
export class IndexContentError extends Error {
  constructor(
    message: string,
    readonly vaultPath: string,
  ) {
    super(message);
    this.name = "IndexContentError";
  }
}

/** A rebuild refused to promote the generation it had just built. */
export class IndexVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexVerificationError";
  }
}

/** One note offered to the index. */
export interface IndexEntry {
  /** Vault-relative path of the saved note. */
  path: string;
  /**
   * Bytes the caller believes are saved there.
   *
   * They are never indexed directly: the note is re-read under the lock and the
   * vault's bytes win, because publication and indexing are separated by a lock
   * wait during which the note can be edited.
   */
  markdown: string;
  /** Final canonical URL of the source. */
  sourceUrl: string;
  /** Collection identifier; normalized before it is used as a library name. */
  collection: string;
  /** Version label, empty when the source is unversioned. */
  version: string;
  /** Whole-note SHA-256 of {@link IndexEntry.markdown}. */
  digest: string;
}

/** What one upsert did. */
export interface IndexUpsertResult {
  /**
   * `indexed` when the note's current bytes are now retrievable; `missing`
   * when the note has gone from the vault and was reconciled out of the index
   * (never out of the vault).
   */
  status: "indexed" | "missing";
  path: string;
  /** Whole-note digest actually indexed, which may differ from the request. */
  digest: string;
  /** Chunks persisted for this note. */
  chunks: number;
  /** True when the saved bytes differed from the bytes the caller offered. */
  refreshed: boolean;
}

/** One retrieval request. */
export interface IndexQuery {
  query: string;
  collection: string;
  version?: string;
  limit?: number;
}

/** One search hit, as the product contract defines the envelope. */
export interface IndexSearchResult {
  source_url: string;
  vault_path: string;
  version: string;
  excerpt: string;
  digest: string;
}

/** A hit that was deliberately not returned. */
export interface IndexOmission {
  source_url: string;
  vault_path: string;
  /** `missing`: the note is gone. `stale`: it changed and stayed changed. */
  reason: "missing" | "stale";
}

/** The whole answer to one search. */
export interface IndexSearchResponse {
  /** `partial` whenever something was omitted; never a silent drop. */
  status: "ok" | "partial";
  results: IndexSearchResult[];
  omitted: IndexOmission[];
  /** Stale hits re-indexed from current vault bytes before the rerun. */
  refreshed: number;
}

/** What a rebuild did, and what it cost. */
export interface IndexRebuildReport {
  collection: string;
  /** Name of the generation now serving searches. */
  generation: string;
  /** `obsidian-cli list` invocations the discovery scan made. */
  directoryScans: number;
  /** `obsidian-cli read --all` invocations the discovery scan made. */
  noteReads: number;
  notesDiscovered: number;
  notesIndexed: number;
  /** Notes skipped: unmanaged, conflict candidates, or empty of chunks. */
  notesSkipped: number;
  chunks: number;
  elapsedMs: number;
  /**
   * Whether the store this generation was built with had a live embedding
   * configuration. This fork starts with FTS and no embedding credential, so a
   * `true` here means an ambient provider key reached the store despite the
   * forced configuration.
   */
  embeddingsActive: boolean;
}

/** Everything {@link VaultIndex} needs from the outside world. */
export interface VaultIndexOptions {
  /** Runtime state directory; must be outside the vault. */
  stateDir?: string;
  /** Vault the CLI operates on, used to validate `stateDir`. */
  vaultPath?: string;
  /** Shares the state directory (and its layout marker) with the publisher. */
  journal?: PublicationJournal;
  /** Upstream configuration; embeddings and telemetry are forced off on a copy. */
  appConfig?: AppConfig;
  logger?: VaultLogger;
  lock?: LockOptions;
  now?: () => Date;
}

/** One manifest row: source identity and vault path to current digest. */
export interface IndexManifestEntry {
  sourceId: string;
  sourceUrl: string;
  vaultPath: string;
  /** Normalized collection identifier, as used for the upstream library name. */
  collection: string;
  version: string;
  /** Whole-note SHA-256 of the bytes this entry was built from. */
  digest: string;
  indexedAt: string;
  /**
   * True for a note imported through an explicit read-only inventory rather
   * than published by this tool. Such a note is never rewritten or recaptured.
   */
  legacy: boolean;
}

/** The manifest file's on-disk shape. */
interface IndexManifest {
  version: number;
  generation: string;
  createdAt: string;
  entries: IndexManifestEntry[];
}

/** The pointer file's on-disk shape. */
interface IndexPointer {
  generation: string;
  switchedAt: string;
}

/**
 * Computes the source identity of one indexed note.
 *
 * Identity is the final canonical URL plus collection and version, exactly as
 * {@link sourceId} defines it for publication; the remaining
 * {@link SourceDocument} fields play no part in it and are supplied empty.
 */
function identityOf(input: {
  sourceUrl: string;
  collection: string;
  version: string;
}): string {
  return sourceId({
    sourceUrl: input.sourceUrl,
    requestedUrl: input.sourceUrl,
    collection: input.collection,
    version: input.version,
    title: "",
    markdown: "",
    sourceContentType: NOTE_MIME_TYPE,
    capturedAt: "",
  });
}

/** Builds the manifest key for one store identity. */
function manifestKey(input: {
  collection: string;
  version: string;
  sourceUrl: string;
}): string {
  return `${normalizeCollection(input.collection)} ${input.version} ${input.sourceUrl}`;
}

/** Writes a file through a temporary file, an fsync and an atomic rename. */
function writeFileAtomic(file: string, data: string): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const handle = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(handle, data, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
}

/** Reads and parses a JSON file, returning null when absent or corrupt. */
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Reads a string field out of decoded frontmatter. */
function frontmatterText(
  data: Record<string, unknown> | null,
  key: string,
): string | null {
  if (data === null) return null;
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Derives the title one saved note is stored under.
 *
 * @param vaultPath Vault-relative path of the note.
 * @param data Decoded frontmatter, or null when the note carries none.
 * @param body The note body, frontmatter already removed.
 * @returns The frontmatter title, else its first ATX heading, else its stem.
 */
function deriveTitle(
  vaultPath: string,
  data: Record<string, unknown> | null,
  body: string,
): string {
  const declared = frontmatterText(data, "title");
  if (declared !== null) return declared;

  const heading = body.match(/^#{1,6}\s+(.+)$/m);
  if (heading) return heading[1].trim();

  return path.basename(vaultPath, ".md");
}

/**
 * Builds a search probe from a note body: its rarest-looking long tokens.
 *
 * Long tokens are preferred because a rebuild probe must distinguish one note
 * from its neighbours, and short words do not.
 *
 * @returns A query string, or null when the body carries nothing to probe with.
 */
function probeQuery(body: string): string | null {
  const tokens = body
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((token) => token.length >= 5)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  return tokens.length > 0 ? tokens.join(" ") : null;
}

export class VaultIndex {
  /** Canonical, validated state directory, shared with the publication journal. */
  readonly stateDir: string;

  private readonly cli: ObsidianCli;
  private readonly logger: VaultLogger;
  private readonly lockOptions: LockOptions;
  private readonly appConfig: AppConfig;
  private readonly now: () => Date;

  /** True only while this instance is inside its own critical section. */
  private held = false;

  /** Open store handle plus the generation it belongs to. */
  private open: { generation: string; service: DocumentManagementService } | null = null;

  /** Lazily built upstream pipelines, closed by {@link VaultIndex.shutdown}. */
  private pipelines: ContentPipeline[] | null = null;

  constructor(cli: ObsidianCli, options: VaultIndexOptions = {}) {
    this.cli = cli;
    this.logger = options.logger ?? createJsonlLogger();
    this.lockOptions = options.lock ?? {};
    this.now = options.now ?? ((): Date => new Date());

    const journal =
      options.journal ??
      new PublicationJournal({
        stateDir: options.stateDir,
        vaultPath: options.vaultPath,
        logger: this.logger,
      });
    this.stateDir = journal.stateDir;

    // A private copy, so forcing these two fields off can never leak back into
    // a configuration object the caller still uses for something else.
    const loaded = options.appConfig ?? loadConfig();
    this.appConfig = {
      ...loaded,
      app: { ...loaded.app, embeddingModel: "", telemetryEnabled: false },
    };
  }

  /** Directory holding the pointer and every generation. */
  get indexRoot(): string {
    return path.join(this.stateDir, "index");
  }

  /** The single state-level index lock database. */
  get lockFile(): string {
    return path.join(this.stateDir, "locks", "index.db");
  }

  private get pointerFile(): string {
    return path.join(this.indexRoot, "current.json");
  }

  private generationDir(generation: string): string {
    return path.join(this.indexRoot, "generations", generation);
  }

  private manifestFile(generation: string): string {
    return path.join(this.generationDir(generation), "manifest.json");
  }

  /**
   * Runs `critical` while holding the one state-level index lock.
   *
   * Exposed so a caller that performs several index operations can hold the
   * lock across all of them rather than reacquiring per item.
   *
   * @throws LockTimeoutError when another process holds the index.
   */
  async withIndexLock<T>(critical: () => Promise<T>): Promise<T> {
    if (this.held) {
      // The lock is not reentrant, and waiting for ourselves would burn the
      // whole timeout before failing. Say so immediately instead.
      throw new Error("the index lock is already held by this VaultIndex instance");
    }

    return withExclusiveLock(
      {
        file: this.lockFile,
        ...this.lockOptions,
        logger: this.logger,
        loc: "VaultIndex.withIndexLock",
        ctx: { lock: "index" },
        timeoutMessage: `another process holds the index lock (${this.lockFile})`,
        now: this.now,
      },
      async () => {
        this.held = true;
        try {
          return await critical();
        } finally {
          this.held = false;
        }
      },
    );
  }

  /** Refuses to run a helper outside the caller's critical section. */
  private assertHeld(loc: string): void {
    if (!this.held) throw new Error(`${loc} must run under the index lock`);
  }

  /**
   * Indexes one saved note, replacing whatever was stored for it before.
   *
   * @param entry The note as the caller last saw it.
   * @returns What was indexed, including the digest actually used.
   * @throws LockTimeoutError when the index is busy; the caller reports the
   *   indexing as pending rather than failing the publication.
   * @throws IndexContentError when the saved note produces no chunks.
   */
  async upsert(entry: IndexEntry): Promise<IndexUpsertResult> {
    return this.withIndexLock(() => this.upsertLocked(entry));
  }

  /**
   * Upsert body, run under a lock the caller already holds.
   *
   * The note is re-read here, inside the lock, and those bytes are what get
   * indexed: between publication and this point the index may have been
   * rebuilt, and the note may have been edited.
   */
  private async upsertLocked(entry: IndexEntry): Promise<IndexUpsertResult> {
    this.assertHeld("VaultIndex.upsertLocked");

    const collection = normalizeCollection(entry.collection);
    const current = await this.cli.readNote(entry.path);

    if (current === null) {
      const removed = await this.reconcileMissing({
        collection,
        version: entry.version,
        sourceUrl: entry.sourceUrl,
        vaultPath: entry.path,
      });
      this.logger({
        level: "warn",
        event: "index.note_missing",
        loc: "VaultIndex.upsertLocked",
        ctx: { vaultPath: entry.path, removedFromIndex: removed },
      });
      return {
        status: "missing",
        path: entry.path,
        digest: entry.digest,
        chunks: 0,
        refreshed: false,
      };
    }

    const digest = sha256(current);
    // The bytes the caller offered are never indexed; they are only compared,
    // so "the note changed between publication and indexing" is observable.
    const refreshed = current !== entry.markdown;
    if (sha256(entry.markdown) !== entry.digest) {
      this.logger({
        level: "warn",
        event: "index.digest_mismatch",
        loc: "VaultIndex.upsertLocked",
        ctx: { vaultPath: entry.path },
      });
    }

    const generation = await this.ensureGeneration();
    const service = await this.openStore(generation);

    const chunks = await this.indexNote(service, {
      collection,
      version: entry.version,
      sourceUrl: entry.sourceUrl,
      vaultPath: entry.path,
      markdown: current,
    });

    const manifest = this.loadManifest(generation) ?? this.emptyManifest(generation);
    this.putManifestEntry(manifest, {
      sourceId: identityOf({
        sourceUrl: entry.sourceUrl,
        collection,
        version: entry.version,
      }),
      sourceUrl: entry.sourceUrl,
      vaultPath: entry.path,
      collection,
      version: entry.version,
      digest,
      indexedAt: this.now().toISOString(),
      legacy: false,
    });
    this.saveManifest(generation, manifest);

    this.logger({
      level: "info",
      event: "index.upserted",
      loc: "VaultIndex.upsertLocked",
      ctx: {
        generation,
        collection,
        version: entry.version,
        vaultPath: entry.path,
        chunks,
        refreshed,
      },
    });

    return {
      status: "indexed",
      path: entry.path,
      digest,
      chunks,
      refreshed,
    };
  }

  /**
   * Searches the active generation and verifies every hit against the vault.
   *
   * A hit whose note changed since it was indexed is refreshed from the saved
   * bytes and the search is rerun exactly once; a hit whose note has gone is
   * reconciled out of the index. Anything still unverified is omitted and
   * reported, never returned as if it were current.
   *
   * @throws LockTimeoutError when another process holds the index.
   */
  async search(query: IndexQuery): Promise<IndexSearchResponse> {
    return this.withIndexLock(() => this.searchLocked(query));
  }

  /** Search body, run under a lock the caller already holds. */
  private async searchLocked(query: IndexQuery): Promise<IndexSearchResponse> {
    this.assertHeld("VaultIndex.searchLocked");

    const collection = normalizeCollection(query.collection);
    const version = query.version ?? "";
    const limit = query.limit ?? 10;

    let generation = await this.ensureGeneration();
    if (this.loadManifest(generation) === null) {
      // Derived state, lost. Rebuilding from discovery is the recovery path;
      // answering from a generation nothing can be mapped back to is not.
      this.logger({
        level: "warn",
        event: "index.manifest_lost",
        loc: "VaultIndex.searchLocked",
        ctx: { generation, collection },
      });
      generation = (await this.rebuildLocked({ collection })).generation;
    }

    // Keyed, and filled as the reasons are discovered rather than at the end:
    // a hit reconciled away on the first pass simply does not come back on the
    // second, and an omission that is only recorded on the last pass would
    // disappear with it — a silent drop, which is the one outcome forbidden.
    const omitted = new Map<string, IndexOmission>();
    let refreshed = 0;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const service = await this.openStore(generation);
      const manifest = this.loadManifest(generation) ?? this.emptyManifest(generation);
      const byKey = new Map(manifest.entries.map((e) => [manifestKey(e), e]));

      const hits = await service.searchStore(collection, version, query.query, limit);
      const results: IndexSearchResult[] = [];
      let repaired = 0;

      for (const hit of hits) {
        const entry = byKey.get(manifestKey({ collection, version, sourceUrl: hit.url }));
        if (entry === undefined) {
          // In the index but not in the manifest: nothing can prove which note
          // this came from, so it is reported rather than shown.
          omitted.set(hit.url, {
            source_url: hit.url,
            vault_path: "",
            reason: "missing",
          });
          continue;
        }

        const saved = await this.cli.readNote(entry.vaultPath);
        if (saved === null) {
          await this.reconcileMissing({
            collection,
            version: entry.version,
            sourceUrl: entry.sourceUrl,
            vaultPath: entry.vaultPath,
          });
          omitted.set(entry.vaultPath, {
            source_url: entry.sourceUrl,
            vault_path: entry.vaultPath,
            reason: "missing",
          });
          repaired += 1;
          continue;
        }

        const digest = sha256(saved);
        if (digest !== entry.digest) {
          if (attempt === 0) {
            // Refreshed under the caller's lock: the non-reentrant lock must
            // not be reacquired here.
            await this.upsertLocked({
              path: entry.vaultPath,
              markdown: saved,
              sourceUrl: entry.sourceUrl,
              collection,
              version: entry.version,
              digest,
            });
            refreshed += 1;
            repaired += 1;
            continue;
          }
          omitted.set(entry.vaultPath, {
            source_url: entry.sourceUrl,
            vault_path: entry.vaultPath,
            reason: "stale",
          });
          continue;
        }

        results.push({
          source_url: entry.sourceUrl,
          vault_path: entry.vaultPath,
          version: entry.version,
          excerpt: hit.content.slice(0, EXCERPT_LENGTH),
          digest,
        });
      }

      if (repaired > 0 && attempt === 0) continue;

      this.logger({
        level: "info",
        event: "index.searched",
        loc: "VaultIndex.searchLocked",
        ctx: {
          collection,
          version,
          hits: hits.length,
          returned: results.length,
          omitted: omitted.size,
          refreshed,
        },
      });
      return {
        status: omitted.size > 0 ? "partial" : "ok",
        results,
        omitted: [...omitted.values()],
        refreshed,
      };
    }

    // Unreachable: the second pass always returns. Present because a `for`
    // loop is not a proof to the type checker.
    return {
      status: "partial",
      results: [],
      omitted: [...omitted.values()],
      refreshed,
    };
  }

  /**
   * Rebuilds a collection's index from the notes currently saved in the vault.
   *
   * No original source is fetched. A fresh sibling generation is filled,
   * verified by count and by search probes, closed, and only then promoted by
   * an atomic pointer rename — so a rebuild that fails anywhere leaves the
   * previous generation serving searches.
   *
   * @param options.collection Collection to rebuild.
   * @param options.inventory Explicit read-only list of vault-relative notes to
   *   import that this tool did not publish. Legacy notes are imported only
   *   this way, and are never rewritten or recaptured.
   * @throws LockTimeoutError when another process holds the index.
   * @throws IndexVerificationError when the new generation fails verification.
   */
  async rebuild(options: {
    collection: string;
    inventory?: string[];
  }): Promise<IndexRebuildReport> {
    return this.withIndexLock(() => this.rebuildLocked(options));
  }

  /** Rebuild body, run under a lock the caller already holds. */
  private async rebuildLocked(options: {
    collection: string;
    inventory?: string[];
  }): Promise<IndexRebuildReport> {
    this.assertHeld("VaultIndex.rebuildLocked");

    const started = Date.now();
    const collection = normalizeCollection(options.collection);
    const folder = collectionPath(options.collection);

    const scan = await scanNotes({
      cli: this.cli,
      collectionPath: folder,
      logger: this.logger,
    });

    const managed = scan.notes.filter((note) => isManaged(note));
    const legacy = await this.readInventory(options.inventory ?? []);
    const candidates = [...managed, ...legacy.notes];

    // Everything the previous generation holds is discarded here: the new
    // generation is filled from the vault alone, so a note deleted from the
    // vault is reconciled out simply by not being rediscovered.
    const generation = `gen-${this.now().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
    const directory = this.generationDir(generation);
    fs.mkdirSync(directory, { recursive: true });

    const manifest = this.emptyManifest(generation);
    let chunks = 0;
    let indexed = 0;
    let embeddingsActive = false;
    let skipped = scan.notes.length - managed.length;

    const service = await this.openStoreAt(generation);
    try {
      for (const note of candidates) {
        const url = noteSourceUrl(note);
        const version = noteVersion(note);
        try {
          const count = await this.indexNote(service, {
            collection,
            version,
            sourceUrl: url,
            vaultPath: note.path,
            markdown: note.markdown,
          });
          chunks += count;
          indexed += 1;
          this.putManifestEntry(manifest, {
            sourceId:
              frontmatterText(note.data, "source_id") ?? sha256(`${collection}:${url}`),
            sourceUrl: url,
            vaultPath: note.path,
            collection,
            version,
            digest: sha256(note.markdown),
            indexedAt: this.now().toISOString(),
            legacy: legacy.paths.has(note.path),
          });
        } catch (error) {
          if (!(error instanceof IndexContentError)) throw error;
          // A note with no retrievable content is reported and skipped; it
          // must never abort the rebuild of every other note beside it.
          skipped += 1;
          this.logger({
            level: "warn",
            event: "index.note_empty",
            loc: "VaultIndex.rebuildLocked",
            ctx: { vaultPath: note.path },
          });
        }
      }

      await this.verifyGeneration(service, { collection, manifest, notes: candidates });
      embeddingsActive = service.getActiveEmbeddingConfig() !== null;
    } catch (error) {
      // The pointer was never touched, so the previous generation is still the
      // active one; all this has to do is not leave the failed one behind.
      await this.closeStore();
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }

    this.saveManifest(generation, manifest);
    // Handles are closed before the pointer moves, so nothing is still writing
    // into a generation that has become the active one.
    await this.closeStore();
    this.switchPointer(generation);
    this.pruneGenerations(generation);

    const report: IndexRebuildReport = {
      collection,
      generation,
      embeddingsActive,
      directoryScans: scan.directoryScans,
      noteReads: scan.noteReads + legacy.reads,
      notesDiscovered: candidates.length,
      notesIndexed: indexed,
      notesSkipped: skipped,
      chunks,
      elapsedMs: Date.now() - started,
    };

    this.logger({
      level: "info",
      event: "index.rebuilt",
      loc: "VaultIndex.rebuildLocked",
      ctx: { ...report },
    });
    return report;
  }

  /**
   * Reports the active generation's manifest entries.
   *
   * @returns Every entry, or an empty list when no index exists yet.
   */
  manifestEntries(): IndexManifestEntry[] {
    const pointer = readJson<IndexPointer>(this.pointerFile);
    if (pointer === null) return [];
    return this.loadManifest(pointer.generation)?.entries ?? [];
  }

  /** Closes every handle this instance opened. */
  async shutdown(): Promise<void> {
    await this.closeStore();
    if (this.pipelines !== null) {
      await Promise.allSettled(this.pipelines.map((pipeline) => pipeline.close()));
      this.pipelines = null;
    }
  }

  /**
   * Reads an explicit inventory of unmanaged notes.
   *
   * This is the only way legacy content enters the index, and it is read-only:
   * a listed note that cannot be read is skipped rather than created.
   */
  private async readInventory(
    paths: string[],
  ): Promise<{ notes: ScannedNote[]; paths: Set<string>; reads: number }> {
    const notes: ScannedNote[] = [];
    const seen = new Set<string>();
    let reads = 0;

    for (const vaultPath of paths) {
      if (seen.has(vaultPath) || isExcludedPath(vaultPath)) continue;
      reads += 1;
      const markdown = await this.cli.readNote(vaultPath);
      if (markdown === null) continue;
      const parsed = parseNoteFrontmatter(markdown);
      seen.add(vaultPath);
      notes.push({
        path: vaultPath,
        markdown,
        data: parsed?.data ?? null,
        body: parsed?.body ?? markdown,
      });
    }

    return { notes, paths: seen, reads };
  }

  /**
   * Splits one saved note and persists its chunks, replacing any it had before.
   *
   * This is the single place our named-object boundary is translated into
   * upstream's positional `addScrapeResult(library, version, depth, result)`.
   * `DocumentStore.addDocuments` deletes the existing documents of an existing
   * `(version_id, url)` page before inserting, which is what makes this a
   * replacement rather than an append.
   *
   * @returns The number of chunks persisted.
   * @throws IndexContentError when the body produced none.
   */
  private async indexNote(
    service: DocumentManagementService,
    input: {
      collection: string;
      version: string;
      sourceUrl: string;
      vaultPath: string;
      markdown: string;
    },
  ): Promise<number> {
    const parsed = parseNoteFrontmatter(input.markdown);
    const body = parsed?.body ?? input.markdown;
    const title = deriveTitle(input.vaultPath, parsed?.data ?? null, body);

    const chunks = await this.splitBody({
      body,
      sourceUrl: input.sourceUrl,
      collection: input.collection,
      version: input.version,
    });

    if (chunks.length === 0) {
      // `addScrapeResult` skips an empty chunk list silently, so an unreported
      // skip here would look exactly like a successful index.
      throw new IndexContentError(
        `saved note produced no indexable chunks: ${input.vaultPath}`,
        input.vaultPath,
      );
    }

    const result: ScrapeResult = {
      url: input.sourceUrl,
      title,
      sourceContentType: NOTE_MIME_TYPE,
      contentType: NOTE_MIME_TYPE,
      textContent: body,
      links: [],
      errors: [],
      chunks,
    };

    await service.addScrapeResult(input.collection, input.version, 0, result);
    return chunks.length;
  }

  /** Splits a note body with the upstream pipeline that claims Markdown. */
  private async splitBody(input: {
    body: string;
    sourceUrl: string;
    collection: string;
    version: string;
  }): Promise<Chunk[]> {
    if (this.pipelines === null) {
      this.pipelines = PipelineFactory.createStandardPipelines(this.appConfig);
    }

    const pipeline = this.pipelines.find((candidate) =>
      candidate.canProcess(NOTE_MIME_TYPE, input.body),
    );
    if (pipeline === undefined) {
      throw new Error(`no upstream pipeline accepts ${NOTE_MIME_TYPE}`);
    }

    const options: ScraperOptions = {
      url: input.sourceUrl,
      library: input.collection,
      version: input.version,
      maxPages: 1,
      maxDepth: 0,
      scrapeMode: ScrapeMode.Auto,
    };

    const processed = await pipeline.process(
      {
        content: input.body,
        mimeType: NOTE_MIME_TYPE,
        charset: "utf-8",
        source: input.sourceUrl,
        status: FetchStatus.SUCCESS,
      },
      options,
    );

    return processed.chunks ?? [];
  }

  /**
   * Verifies a freshly built generation before it is allowed to be promoted.
   *
   * Counts alone would pass an index whose rows are unreachable by query, so a
   * sample of notes is searched for and required to come back.
   *
   * @throws IndexVerificationError on either failure.
   */
  private async verifyGeneration(
    service: DocumentManagementService,
    input: { collection: string; manifest: IndexManifest; notes: ScannedNote[] },
  ): Promise<void> {
    const byPath = new Map(input.notes.map((note) => [note.path, note]));

    for (const entry of input.manifest.entries) {
      if (!byPath.has(entry.vaultPath)) {
        throw new IndexVerificationError(
          `manifest names a note the rebuild did not discover: ${entry.vaultPath}`,
        );
      }
    }

    const sample = input.manifest.entries.slice(0, PROBE_SAMPLE_SIZE);
    for (const entry of sample) {
      const note = byPath.get(entry.vaultPath);
      if (note === undefined) continue;
      const probe = probeQuery(note.body ?? note.markdown);
      if (probe === null) continue;

      const hits = await service.searchStore(
        input.collection,
        entry.version,
        probe,
        input.manifest.entries.length + PROBE_SAMPLE_SIZE,
      );
      if (!hits.some((hit) => hit.url === entry.sourceUrl)) {
        throw new IndexVerificationError(
          `rebuilt index does not retrieve ${entry.vaultPath} by its own content`,
        );
      }
    }
  }

  /**
   * Removes one page from the index and the manifest.
   *
   * Reconciliation is one directional by design: a note missing from the vault
   * leaves the index, and nothing ever leaves the vault.
   *
   * @returns True when something was actually removed.
   */
  private async reconcileMissing(input: {
    collection: string;
    version: string;
    sourceUrl: string;
    vaultPath: string;
  }): Promise<boolean> {
    const pointer = readJson<IndexPointer>(this.pointerFile);
    if (pointer === null) return false;

    const manifest = this.loadManifest(pointer.generation);
    if (manifest === null) return false;

    const key = manifestKey(input);
    const before = manifest.entries.length;
    manifest.entries = manifest.entries.filter((entry) => manifestKey(entry) !== key);
    if (manifest.entries.length === before) return false;

    const service = await this.openStore(pointer.generation);
    // The manifest named this entry, so its library and version already exist;
    // `ensureLibraryAndVersion` is upstream's only public way to resolve that
    // id, and its create-if-absent behaviour is unreachable from here.
    const versionId = await service.ensureLibraryAndVersion(
      input.collection,
      input.version,
    );
    const pages = await service.getPagesByVersionId(versionId);
    for (const page of pages) {
      if (page.url === input.sourceUrl) await service.deletePage(page.id);
    }

    this.saveManifest(pointer.generation, manifest);
    return true;
  }

  /**
   * Resolves the active generation, creating an empty one on first use.
   *
   * @returns The generation name the pointer now names.
   */
  private async ensureGeneration(): Promise<string> {
    const pointer = readJson<IndexPointer>(this.pointerFile);
    if (pointer !== null && fs.existsSync(this.generationDir(pointer.generation))) {
      return pointer.generation;
    }

    const generation = `gen-${this.now().toISOString().replace(/[:.]/g, "-")}-initial`;
    fs.mkdirSync(this.generationDir(generation), { recursive: true });
    this.saveManifest(generation, this.emptyManifest(generation));
    this.switchPointer(generation);
    return generation;
  }

  /** Opens (or reuses) the store for the generation the pointer names. */
  private async openStore(generation: string): Promise<DocumentManagementService> {
    if (this.open !== null && this.open.generation !== generation) {
      await this.closeStore();
    }
    if (this.open !== null) return this.open.service;
    return this.openStoreAt(generation);
  }

  /** Opens a store for one generation directory, whether or not it is active. */
  private async openStoreAt(generation: string): Promise<DocumentManagementService> {
    await this.closeStore();

    const directory = this.generationDir(generation);
    fs.mkdirSync(directory, { recursive: true });

    const service = new DocumentManagementService(new EventBusService(), {
      ...this.appConfig,
      app: { ...this.appConfig.app, storePath: directory },
    });
    await service.initialize();
    this.open = { generation, service };
    return service;
  }

  /** Closes the open store, if there is one. */
  private async closeStore(): Promise<void> {
    if (this.open === null) return;
    const service = this.open.service;
    this.open = null;
    await service.shutdown();
  }

  private emptyManifest(generation: string): IndexManifest {
    return {
      version: INDEX_MANIFEST_VERSION,
      generation,
      createdAt: this.now().toISOString(),
      entries: [],
    };
  }

  /** Inserts or replaces one manifest row, keyed by store identity. */
  private putManifestEntry(manifest: IndexManifest, entry: IndexManifestEntry): void {
    const key = manifestKey(entry);
    const index = manifest.entries.findIndex((e) => manifestKey(e) === key);
    if (index >= 0) manifest.entries[index] = entry;
    else manifest.entries.push(entry);
  }

  /**
   * Reads a generation's manifest.
   *
   * @returns Null when it is absent, corrupt, or written in a format this build
   *   does not read — all three are "derived state was lost", which is a
   *   rebuild, never a guess.
   */
  private loadManifest(generation: string): IndexManifest | null {
    const manifest = readJson<IndexManifest>(this.manifestFile(generation));
    if (manifest === null || manifest.version !== INDEX_MANIFEST_VERSION) return null;
    if (!Array.isArray(manifest.entries)) return null;
    return manifest;
  }

  private saveManifest(generation: string, manifest: IndexManifest): void {
    writeFileAtomic(this.manifestFile(generation), JSON.stringify(manifest, null, 2));
  }

  /** Promotes one generation by an atomic rename of the pointer file. */
  private switchPointer(generation: string): void {
    const pointer: IndexPointer = {
      generation,
      switchedAt: this.now().toISOString(),
    };
    writeFileAtomic(this.pointerFile, JSON.stringify(pointer, null, 2));
  }

  /**
   * Removes generations older than the current one and its parent.
   *
   * The parent is kept because another process may have opened it moments
   * before the pointer moved.
   */
  private pruneGenerations(current: string): void {
    const root = path.join(this.indexRoot, "generations");
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }

    const ordered = names
      .filter((name) => name !== current)
      .map((name) => ({
        name,
        at: fs.statSync(path.join(root, name)).mtimeMs,
      }))
      .sort((a, b) => b.at - a.at)
      .slice(GENERATIONS_KEPT - 1);

    for (const stale of ordered) {
      fs.rmSync(path.join(root, stale.name), { recursive: true, force: true });
    }
  }
}

/** Reports whether a vault path is one the index must never hold. */
function isExcludedPath(vaultPath: string): boolean {
  return vaultPath.startsWith(`${SOURCE_UPDATES_PATH}/`);
}

/**
 * Reports whether a scanned note is one this publisher manages.
 *
 * Conflict candidates are excluded by path: they are complete, valid source
 * notes carrying the same identity as the note they were preserved beside, and
 * returning one from a search would present a rejected incoming version as the
 * saved document.
 */
function isManaged(note: ScannedNote): boolean {
  if (isExcludedPath(note.path)) return false;
  if (frontmatterText(note.data, "publisher") !== PUBLISHER) return false;
  return frontmatterText(note.data, "source_url") !== null;
}

/** The URL a note is retrieved by; a legacy note is addressed by its path. */
function noteSourceUrl(note: ScannedNote): string {
  return frontmatterText(note.data, "source_url") ?? `vault://${note.path}`;
}

/** The version a note declares, coerced from a hand-edited scalar. */
function noteVersion(note: ScannedNote): string {
  const raw = note.data?.version;
  return raw === undefined || raw === null ? "" : String(raw);
}
