/**
 * Derives retrieval from the documents already saved in the vault.
 *
 * The vault is authoritative; this index is disposable. Nothing here ever
 * fetches an original source, and nothing here ever writes to the vault: an
 * index entry is built from the exact bytes `obsidian-cli` reports for a note,
 * read *after* publication, so a manual edit is indexed as it stands and a
 * crawler chunk that disagrees with the saved note is never persisted.
 *
 * Five properties are load bearing:
 *
 * - **One index per collection.** Each collection owns its own generations and
 *   its own pointer under `<stateDir>/index/collections/<key>`. Rebuilding one
 *   collection is therefore incapable of disturbing another, and restoring a
 *   deleted index is a rebuild per collection rather than a single rebuild that
 *   silently discards every collection it was not asked about.
 * - **Generations.** An index lives in a generation directory reached through
 *   an atomically renamed pointer. A rebuild fills a fresh sibling generation
 *   and only then switches the pointer, so a rebuild that fails at any point —
 *   while reading, while indexing, while verifying, while writing its manifest —
 *   leaves the previous generation serving searches.
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
import Database, { type Database as DatabaseType } from "better-sqlite3";
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

/**
 * Format version of the manifest file; an unknown one is treated as lost.
 *
 * Version 1 keyed entries by a collection that is now implied by the manifest's
 * own location, and carried no per-note chunk count for verification to check.
 * Neither shipped, so there is nothing to migrate: an older manifest simply
 * reads as lost, which is already the recoverable case.
 */
export const INDEX_MANIFEST_VERSION = 2;

/** MIME type every vault note body is indexed as. */
const NOTE_MIME_TYPE = "text/markdown";

/** Characters of stored chunk content carried into a search envelope. */
const EXCERPT_LENGTH = 400;

/** Notes a rebuild probes for retrievability before it switches the pointer. */
const PROBE_SAMPLE_SIZE = 5;

/**
 * Chunks read per page while verifying a freshly built generation.
 *
 * Exported so a fixture can say which boundary it is crossing rather than
 * hard-coding a number that would silently stop meaning anything if this
 * changed. `DocumentStore.listVersionChunks` recomputes its count and its
 * window per call, so paging is several queries, not one scan.
 */
export const VERIFY_PAGE_SIZE = 1_000;

/** Generations kept after a successful switch: the current one and its parent. */
const GENERATIONS_KEPT = 2;

/** Separator inside composite keys; never occurs in a URL or a version label. */
const KEY_SEPARATOR = "\u0000";

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

/**
 * The note an index request named is no longer in the vault.
 *
 * A capture that waited for the index lock can find its note deleted or renamed
 * by the time it gets in. The publication still stands; only the indexing of it
 * does not, and the next rebuild resolves it from whatever the vault now holds.
 */
export class IndexNoteMissingError extends Error {
  constructor(
    message: string,
    readonly vaultPath: string,
  ) {
    super(message);
    this.name = "IndexNoteMissingError";
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
  /** Name of the generation now serving searches for that collection. */
  generation: string;
  /** `obsidian-cli list` invocations the discovery scan made. */
  directoryScans: number;
  /** `obsidian-cli read --all` invocations the scan and the inventory made. */
  noteReads: number;
  notesDiscovered: number;
  notesIndexed: number;
  /**
   * Notes seen but not held by the index: unmanaged notes, conflict
   * candidates, notes with no retrievable content, and every note of an
   * ambiguous source identity.
   */
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
  /** Normalized collection identifier this manifest belongs to. */
  collection: string;
  /** Version exactly as the note declares it, case included. */
  version: string;
  /** Whole-note SHA-256 of the bytes this entry was built from. */
  digest: string;
  /** Chunks persisted for this note, which verification checks against. */
  chunkCount: number;
  indexedAt: string;
  /**
   * True for a note imported through an explicit read-only inventory rather
   * than published by this tool. Such a note is never rewritten or recaptured.
   */
  legacy: boolean;
}

/** The manifest file's on-disk shape. */
interface IndexManifest {
  /** Shape of this document. Orthogonal to {@link IndexManifest.storeEncoding}. */
  version: number;
  generation: string;
  /** Normalized collection this generation indexes, and only that one. */
  collection: string;
  /**
   * {@link STORE_ENCODING_ID} as it stood when this generation was written.
   *
   * The manifest version describes what this file looks like; this describes
   * what the database beside it is keyed by. They change for different reasons
   * and are checked separately.
   */
  storeEncoding: string;
  createdAt: string;
  entries: IndexManifestEntry[];
}

/** Why a generation cannot be used to answer a question. */
export type IndexStateProblem =
  /** No pointer: nothing has ever indexed this collection. */
  | "never-built"
  /** The pointer names a generation directory that is not there. */
  | "generation-missing"
  /** Absent, corrupt, foreign, or written in a manifest shape this build does not read. */
  | "manifest-unreadable"
  /** Written by a different version-key encoding, so its rows are unfindable. */
  | "encoding-changed"
  /** The manifest is intact and the database file is gone. */
  | "database-missing"
  /** The database file is there and cannot be read as this store. */
  | "database-unreadable"
  /** The database holds a different number of chunks than the manifest records. */
  | "database-inconsistent";

/** A generation that can be trusted to answer, together with its manifest. */
interface UsableGeneration {
  usable: true;
  generation: string;
  manifest: IndexManifest;
}

/** A generation that cannot, and the reason a caller must act on. */
interface BrokenGeneration {
  usable: false;
  /** The generation the pointer named, or null when there was no pointer. */
  generation: string | null;
  problem: IndexStateProblem;
  /** Human-readable specifics, for the log only. */
  detail?: string;
}

/** The full answer to "can this collection's index be used as it stands?". */
type GenerationInspection = UsableGeneration | BrokenGeneration;

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

/**
 * Reduces a collection identifier to one directory name.
 *
 * The readable part is for a human reading the state directory; the digest is
 * what makes it injective, so two collections whose names differ only in
 * characters a filename cannot carry never share an index.
 */
function collectionKey(collection: string): string {
  const normalized = normalizeCollection(collection);
  const readable = normalized
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${readable.length > 0 ? readable : "collection"}-${sha256(normalized).slice(0, 12)}`;
}

/**
 * Maps a version label onto the token the upstream store is keyed by.
 *
 * Upstream normalizes every version it is handed, and it does so in two
 * different places with two different rules: `DocumentManagementService`
 * lowercases on write and on search, while `normalizeVersionRef` — which
 * `listVersionChunks` goes through — both lowercases *and trims*. Source
 * identity, and therefore the note in the vault, is case sensitive and keeps
 * its whitespace. A label passed through unchanged is unsafe twice over:
 * `Release` and `release` would collapse onto one stored page while keeping two
 * manifest entries, so a search for one version could return the other's text
 * beside the first note's path and digest; and a label like `" Release"` would
 * be written under a key with a leading space and read back under one without,
 * so verification would look at a version nothing had been written to.
 *
 * The token is therefore a fixed prefix plus a digest of the exact label:
 * lowercase hexadecimal with no whitespace anywhere in it, so lowercasing and
 * trimming are both the identity function on it, and injective, so two labels
 * can never share a page. The readable label lives in the manifest, which is
 * what every envelope reports; nothing but this module reads the stored version
 * column.
 *
 * @param version Version label as the note declares it.
 * @returns A token no upstream normalization can alter, or `""` for the
 *   unversioned case, which upstream already treats as its own bucket.
 */
function storeVersion(version: string): string {
  if (version === "") return "";
  return `sv${sha256(version).slice(0, 20)}`;
}

/**
 * Labels the store encoding is fingerprinted over.
 *
 * They are chosen to exercise every branch the mapping has ever had: the
 * unversioned case, an ordinary label, a case pair, and the whitespace shapes
 * upstream's two normalizations disagree about.
 */
const ENCODING_PROBES = ["", "1.0", "Release", "release", " Release", "Release ", "   "];

/**
 * Identity of the mapping from version labels to stored version keys.
 *
 * This is computed from {@link storeVersion} rather than declared, and that is
 * the whole point. A generation's rows are only findable by the encoding that
 * wrote them, so changing the mapping silently orphans every existing index:
 * the manifest still parses, the pointer still resolves, and the store is asked
 * for a key it has never held — which is a successful empty answer, the one
 * outcome this module is not allowed to produce. A declared constant would have
 * to be remembered; a fingerprint of the function's own output cannot be
 * forgotten, because any change to the mapping changes it in the same commit.
 *
 * It is recorded in every manifest and checked before a generation is trusted.
 *
 * One limit, stated because it is easy to over-read: the fingerprint covers
 * these labels and no others. It detects any change to how they map — which is
 * every change the mapping has actually undergone — but a hypothetical revision
 * that altered only labels outside this set would leave it unchanged. Widening
 * the list costs nothing and is the right response to inventing such a case.
 */
export const STORE_ENCODING_ID = sha256(
  ENCODING_PROBES.map((label) => `${label}=>${storeVersion(label)}`).join("\u0000"),
).slice(0, 16);

/** Builds the manifest key for one source identity within its collection. */
function manifestKey(input: { version: string; sourceUrl: string }): string {
  return `${input.version}${KEY_SEPARATOR}${input.sourceUrl}`;
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

/**
 * Counts the chunks a generation's database actually holds.
 *
 * Opened read-only and with `fileMustExist`, so probing a generation can never
 * be the thing that creates the file it is checking for. Only the `documents`
 * table is touched, which needs no loadable extension.
 *
 * @param file Absolute path of the generation's `documents.db`.
 * @returns The row count, or null when the file cannot be read as this store.
 */
function countStoredChunks(file: string): number | null {
  let db: DatabaseType | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT COUNT(*) AS total FROM documents").get() as
      | { total: number }
      | undefined;
    return typeof row?.total === "number" ? row.total : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Reads and parses a JSON file, returning null when absent or corrupt. */
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Reports whether a pointer's generation name is one this build wrote.
 *
 * The pointer is a file, and a file can say anything. Every path this module
 * builds from a generation name is joined onto the state directory, and one
 * carrying `..` would resolve outside it — so the name is checked against the
 * shape {@link VaultIndex.nextGenerationName} produces before it is ever joined
 * to anything, and anything else classifies as missing state rather than
 * becoming a path.
 */
function isGenerationName(value: unknown): value is string {
  return typeof value === "string" && /^gen-[A-Za-z0-9._-]{1,120}$/.test(value);
}

/**
 * Reports whether one decoded manifest row is a row this build can use.
 *
 * Called on every entry of every manifest read from disk, because the
 * alternative is a detector that trusts its own input: reducing `chunkCount`
 * over a row that is `null` throws out of the classification that exists to
 * turn damaged state into a rebuild, and the caller then fails every time
 * instead of recovering once.
 */
function isManifestEntry(value: unknown): value is IndexManifestEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;

  for (const key of [
    "sourceId",
    "sourceUrl",
    "vaultPath",
    "collection",
    "version",
    "digest",
    "indexedAt",
  ]) {
    if (typeof entry[key] !== "string") return false;
  }

  if (typeof entry.legacy !== "boolean") return false;
  const chunkCount = entry.chunkCount;
  return (
    typeof chunkCount === "number" &&
    Number.isInteger(chunkCount) &&
    Number.isFinite(chunkCount) &&
    chunkCount >= 0
  );
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
 * Splits text into the runs a probe may be chosen from.
 *
 * Letters and digits only — no underscores, no hyphens. Those are word
 * characters to a regular expression and separators to the full-text
 * tokenizer (`porter unicode61`), and a candidate that straddles that
 * disagreement is the problem: a long underscore run inside a fenced code block
 * is the longest "token" in a note by any regex measure and is not an indexed
 * term at all, so searching for it correctly returns nothing. A check that
 * reads that correct answer as corruption blocks a healthy rebuild.
 *
 * Restricting candidates to alphanumeric runs keeps both uses honest: each is a
 * literal substring of the stored chunk, so exhaustive matching finds it, and
 * each is exactly one tokenizer term, so a search for it finds it too.
 */
function probeCandidates(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u);
}

/**
 * Picks the substring a rebuild probes one note's stored chunks for.
 *
 * The token is taken from the **splitter's own output**, never from the raw
 * note. A Markdown body is converted before it is chunked, and conversion drops
 * things: an HTML comment, an unused link reference definition, anything the
 * renderer has no output for. A token chosen from the raw body can therefore be
 * absent from every chunk of a note that indexed perfectly — and a probe that
 * cannot find it would reject the whole rebuild for a note that is fine.
 * Choosing from what was actually persisted means the probe can only fail when
 * persistence itself failed, which is the one thing it exists to detect.
 *
 * A single long token, not a phrase: chunk boundaries fall between words, so a
 * phrase can straddle two chunks where a token cannot. It does not need to be
 * unique, only present, because it is matched against every persisted chunk of
 * the version rather than against a ranked slice.
 *
 * @param chunks The chunks about to be persisted for one note.
 * @returns A token, or null when nothing long enough was stored to probe for.
 */
function probeToken(chunks: Chunk[]): string | null {
  let longest: string | null = null;
  for (const chunk of chunks) {
    for (const token of probeCandidates(chunk.content)) {
      if (token.length < 5) continue;
      if (longest === null || token.length > longest.length) longest = token;
    }
  }
  return longest;
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

  /** Open store handle, plus the collection and generation it belongs to. */
  private open: {
    collection: string;
    generation: string;
    service: DocumentManagementService;
  } | null = null;

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

  /** Directory holding every collection's index. */
  get indexRoot(): string {
    return path.join(this.stateDir, "index");
  }

  /** The single state-level index lock database, shared by every collection. */
  get lockFile(): string {
    return path.join(this.stateDir, "locks", "index.db");
  }

  /** Directory holding one collection's pointer and generations. */
  collectionRoot(collection: string): string {
    return path.join(this.indexRoot, "collections", collectionKey(collection));
  }

  private pointerFile(collection: string): string {
    return path.join(this.collectionRoot(collection), "current.json");
  }

  private generationDir(collection: string, generation: string): string {
    return path.join(this.collectionRoot(collection), "generations", generation);
  }

  private manifestFile(collection: string, generation: string): string {
    return path.join(this.generationDir(collection, generation), "manifest.json");
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
   * rebuilt, and the note may have been edited, moved or deleted.
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

    // A writing caller may start a collection nothing has indexed yet, but it
    // must never write one note into derived state that is broken or foreign:
    // that repairs the note in the caller's hand and leaves every one of its
    // siblings unreachable. Anything short of usable is rebuilt first.
    const generation = await this.usableGeneration(collection, {
      loc: "VaultIndex.upsertLocked",
      initializeWhenNew: true,
    });

    return this.indexIntoLocked({
      collection,
      generation,
      entry,
      markdown: current,
      digest,
      refreshed,
    });
  }

  /**
   * Writes one note into a generation the caller has already established is
   * usable.
   *
   * Split out so a search's stale-hit refresh can reuse the generation it is
   * already reading, rather than reclassifying — and so it can never trigger a
   * rebuild underneath the pass that is iterating that generation's hits.
   *
   * @param input.generation Generation to write into; already inspected.
   * @param input.markdown The note's current bytes, as read from the vault.
   * @returns The upsert outcome for those bytes.
   */
  private async indexIntoLocked(input: {
    collection: string;
    generation: string;
    entry: IndexEntry;
    markdown: string;
    digest: string;
    refreshed: boolean;
  }): Promise<IndexUpsertResult> {
    this.assertHeld("VaultIndex.indexIntoLocked");

    const { collection, generation, entry } = input;
    const service = await this.openStore(collection, generation);

    const indexed = await this.indexNote(service, {
      collection,
      version: entry.version,
      sourceUrl: entry.sourceUrl,
      vaultPath: entry.path,
      markdown: input.markdown,
    });
    const chunks = indexed.chunks;

    const manifest =
      this.loadManifest(collection, generation) ??
      this.emptyManifest(collection, generation);
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
      digest: input.digest,
      chunkCount: chunks,
      indexedAt: this.now().toISOString(),
      legacy: false,
    });
    this.saveManifest(collection, generation, manifest);

    this.logger({
      level: "info",
      event: "index.upserted",
      loc: "VaultIndex.indexIntoLocked",
      ctx: {
        generation,
        collection,
        version: entry.version,
        vaultPath: entry.path,
        chunks,
        refreshed: input.refreshed,
      },
    });

    return {
      status: "indexed",
      path: entry.path,
      digest: input.digest,
      chunks,
      refreshed: input.refreshed,
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

    // A reader never initializes. Everything this needs to tell apart — no
    // pointer, a vanished generation, an unreadable or foreign manifest, an old
    // store encoding, a missing or unreadable or inconsistent database — is
    // decided in one place, and every one of them rebuilds rather than
    // answering.
    const active = await this.usableGeneration(collection, {
      loc: "VaultIndex.searchLocked",
      initializeWhenNew: false,
    });

    // Keyed, and filled as the reasons are discovered rather than at the end:
    // a hit reconciled away on the first pass simply does not come back on the
    // second, and an omission that is only recorded on the last pass would
    // disappear with it — a silent drop, which is the one outcome forbidden.
    const omitted = new Map<string, IndexOmission>();
    let refreshed = 0;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const service = await this.openStore(collection, active);
      const manifest =
        this.loadManifest(collection, active) ?? this.emptyManifest(collection, active);
      const byKey = new Map(manifest.entries.map((e) => [manifestKey(e), e]));

      const hits = await service.searchStore(
        collection,
        storeVersion(version),
        query.query,
        limit,
      );
      const results: IndexSearchResult[] = [];
      let repaired = 0;

      for (const hit of hits) {
        const entry = byKey.get(manifestKey({ version, sourceUrl: hit.url }));
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
            // Refreshed under the caller's lock, into the generation this pass
            // is already reading: the non-reentrant lock must not be reacquired
            // here, and a reclassification must not move the generation out
            // from under the loop.
            await this.indexIntoLocked({
              collection,
              generation: active,
              entry: {
                path: entry.vaultPath,
                markdown: saved,
                sourceUrl: entry.sourceUrl,
                collection,
                version: entry.version,
                digest,
              },
              markdown: saved,
              digest,
              refreshed: true,
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
   * Rebuilds one collection's index from the notes currently saved in the vault.
   *
   * No original source is fetched, and no other collection is touched: each
   * collection owns its own generations and its own pointer, so restoring a
   * deleted index is one rebuild per collection and rebuilding one of them can
   * never discard another.
   *
   * A fresh sibling generation is filled, verified against what was actually
   * persisted, closed, and only then promoted by an atomic pointer rename — so
   * a rebuild that fails anywhere leaves the previous generation serving
   * searches.
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
    const inventory = (options.inventory ?? []).filter(
      (candidate) =>
        !isExcludedPath(candidate) && !managed.some((note) => note.path === candidate),
    );

    // Two notes claiming one source identity cannot both be indexed under it,
    // and picking a winner would make retrieval depend on scan order. Neither
    // is indexed, both are reported, and the collection's other notes are
    // unaffected — the same shape of answer publication gives an identity
    // conflict.
    const ambiguous = new Set<string>();
    const claimed = new Map<string, string>();
    for (const note of managed) {
      const key = manifestKey({
        version: noteVersion(note),
        sourceUrl: noteSourceUrl(note),
      });
      const first = claimed.get(key);
      if (first === undefined) claimed.set(key, note.path);
      else if (first !== note.path) {
        ambiguous.add(key);
        this.logger({
          level: "warn",
          event: "index.identity_conflict",
          loc: "VaultIndex.rebuildLocked",
          ctx: { collection, paths: [first, note.path] },
        });
      }
    }

    const generation = this.nextGenerationName(collection);
    const directory = this.generationDir(collection, generation);
    fs.mkdirSync(directory, { recursive: true });

    const manifest = this.emptyManifest(collection, generation);
    /** One token per indexed note, taken from its body, for verification. */
    const probes = new Map<string, string>();
    let chunks = 0;
    let indexed = 0;
    let discovered = 0;
    let skipped = scan.notes.length - managed.length;
    let inventoryReads = 0;
    let embeddingsActive = false;

    try {
      const service = await this.openStoreAt(collection, generation);

      /** Indexes one discovered note into the generation being built. */
      const take = async (note: ScannedNote, legacy: boolean): Promise<void> => {
        const url = noteSourceUrl(note);
        const version = noteVersion(note);
        if (!legacy && ambiguous.has(manifestKey({ version, sourceUrl: url }))) {
          skipped += 1;
          return;
        }

        discovered += 1;
        try {
          const outcome = await this.indexNote(service, {
            collection,
            version,
            sourceUrl: url,
            vaultPath: note.path,
            markdown: note.markdown,
          });
          const count = outcome.chunks;
          chunks += count;
          indexed += 1;
          if (outcome.probe !== null) {
            const key = manifestKey({ version, sourceUrl: url });
            probes.set(key, outcome.probe.toLowerCase());
          }
          this.putManifestEntry(manifest, {
            sourceId:
              frontmatterText(note.data, "source_id") ??
              identityOf({ sourceUrl: url, collection, version }),
            sourceUrl: url,
            vaultPath: note.path,
            collection,
            version,
            digest: sha256(note.markdown),
            chunkCount: count,
            indexedAt: this.now().toISOString(),
            legacy,
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
      };

      for (const note of managed) await take(note, false);

      // Inventory notes are read here rather than up front: one at a time, in
      // the same pass that indexes them, so a large inventory is never all in
      // memory at once and a read that fails stops the rebuild rather than
      // being discovered after the work.
      for (const vaultPath of inventory) {
        inventoryReads += 1;
        const markdown = await this.cli.readNote(vaultPath);
        if (markdown === null) {
          // Read-only by contract: a listed note that is not there is reported,
          // never created.
          skipped += 1;
          this.logger({
            level: "warn",
            event: "index.inventory_missing",
            loc: "VaultIndex.rebuildLocked",
            ctx: { vaultPath },
          });
          continue;
        }
        const parsed = parseNoteFrontmatter(markdown);
        await take(
          {
            path: vaultPath,
            markdown,
            data: parsed?.data ?? null,
            body: parsed?.body ?? markdown,
          },
          true,
        );
      }

      this.saveManifest(collection, generation, manifest);
      await this.verifyGeneration(service, { collection, manifest, probes });
      embeddingsActive = service.getActiveEmbeddingConfig() !== null;
    } catch (error) {
      // The pointer was never touched, so the previous generation is still the
      // active one. Cleanup is best effort and must never replace the real
      // failure with its own: a half-built generation left behind is noise, a
      // masked cause is a lost afternoon.
      await this.closeStore().catch(() => undefined);
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        this.logger({
          level: "warn",
          event: "index.generation_orphaned",
          loc: "VaultIndex.rebuildLocked",
          ctx: { collection, generation },
        });
      }
      throw error;
    }

    // Handles are closed before the pointer moves, so nothing is still writing
    // into a generation that has become the active one.
    await this.closeStore();
    this.switchPointer(collection, generation);
    this.pruneGenerations(collection, generation);

    const report: IndexRebuildReport = {
      collection,
      generation,
      embeddingsActive,
      directoryScans: scan.directoryScans,
      noteReads: scan.noteReads + inventoryReads,
      notesDiscovered: discovered,
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
   * Reports one collection's active manifest entries.
   *
   * @param collection Collection to report on.
   * @returns Every entry, or an empty list when that collection has no index.
   */
  manifestEntries(collection: string): IndexManifestEntry[] {
    const normalized = normalizeCollection(collection);
    const pointer = readJson<IndexPointer>(this.pointerFile(normalized));
    if (pointer === null || !isGenerationName(pointer.generation)) return [];
    return this.loadManifest(normalized, pointer.generation)?.entries ?? [];
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
  ): Promise<{ chunks: number; probe: string | null }> {
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

    await service.addScrapeResult(
      input.collection,
      storeVersion(input.version),
      0,
      result,
    );
    return { chunks: chunks.length, probe: probeToken(chunks) };
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
      version: storeVersion(input.version),
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
   * Verification never asks a ranked search whether a note is there. A ranked
   * result set is capped, and the cap applies to matching *chunks* before they
   * are grouped by page, so one long document contributing many matching chunks
   * can crowd a perfectly well indexed note out of the answer — a ranking
   * artefact would then fail a sound rebuild. Instead every persisted chunk of
   * the generation is read exhaustively, once, and checked directly:
   *
   * - every manifest entry has a stored page, and no page exists that the
   *   manifest does not name;
   * - each page holds exactly the number of chunks indexing recorded for it;
   * - a sample of notes is retrievable by a token from its own body, matched
   *   against the full chunk set rather than against a ranked slice.
   *
   * @throws IndexVerificationError on any of those.
   */
  private async verifyGeneration(
    service: DocumentManagementService,
    input: {
      collection: string;
      manifest: IndexManifest;
      /** Lowercased body token per manifest key, collected while indexing. */
      probes: Map<string, string>;
    },
  ): Promise<void> {
    const versions = new Set(input.manifest.entries.map((entry) => entry.version));
    const expected = new Map(
      input.manifest.entries.map((entry) => [manifestKey(entry), entry]),
    );

    /** Persisted chunk counts per manifest key. */
    const persisted = new Map<string, number>();
    /** The sampled notes whose own token was found in their own chunks. */
    const found = new Set<string>();

    const probes = new Map<string, string>();
    for (const entry of input.manifest.entries.slice(0, PROBE_SAMPLE_SIZE)) {
      const token = input.probes.get(manifestKey(entry));
      if (token !== undefined) probes.set(manifestKey(entry), token);
    }

    for (const version of versions) {
      const token = storeVersion(version);
      let offset = 0;
      for (;;) {
        const page = await service.listVersionChunks(
          { library: input.collection, version: token },
          { limit: VERIFY_PAGE_SIZE, offset },
        );
        for (const chunk of page.chunks) {
          const key = manifestKey({ version, sourceUrl: chunk.url });
          persisted.set(key, (persisted.get(key) ?? 0) + 1);
          const probe = probes.get(key);
          if (probe !== undefined && chunk.content.toLowerCase().includes(probe)) {
            found.add(key);
          }
        }
        offset += page.chunks.length;
        if (page.chunks.length === 0 || offset >= page.total) break;
      }
    }

    for (const [key, entry] of expected) {
      const count = persisted.get(key);
      if (count === undefined) {
        throw new IndexVerificationError(
          `rebuilt index stored no chunks for ${entry.vaultPath}`,
        );
      }
      if (count !== entry.chunkCount) {
        throw new IndexVerificationError(
          `rebuilt index stored ${count} chunks for ${entry.vaultPath}, not the ${entry.chunkCount} it indexed`,
        );
      }
    }

    for (const key of persisted.keys()) {
      if (!expected.has(key)) {
        throw new IndexVerificationError(
          `rebuilt index holds a page its manifest does not name: ${key.replace(KEY_SEPARATOR, "@")}`,
        );
      }
    }

    for (const [key, probe] of probes) {
      if (!found.has(key)) {
        throw new IndexVerificationError(
          `rebuilt index does not retrieve ${expected.get(key)?.vaultPath ?? key} by "${probe}"`,
        );
      }
    }

    // Everything above reads the chunk rows directly, which proves they are
    // there and proves nothing about the full-text index built beside them —
    // and searching is the one thing this generation exists to do. A generation
    // promoted with an unpopulated FTS index would answer every question with a
    // successful empty result forever.
    //
    // The assertion is deliberately weak in the one way that matters: *some*
    // hit, not a particular one. Which note a ranked search returns first is a
    // ranking question and no business of verification — that conflation is
    // what made an earlier probe reject sound rebuilds — but a token known to
    // be in the index returning nothing at all is not a ranking question.
    let asked = 0;
    for (const [key, probe] of probes) {
      const entry = expected.get(key);
      if (entry === undefined) continue;
      asked += 1;
      const hits = await service.searchStore(
        input.collection,
        storeVersion(entry.version),
        probe,
        1,
      );
      if (hits.length > 0) return;
    }

    if (asked > 0) {
      // Every sampled probe came back empty. One could be a quirk of the term
      // it happened to choose; all of them cannot be, and this is the only
      // conclusion the check is entitled to draw — that the index answers
      // nothing at all, not that any particular note ranks anywhere.
      throw new IndexVerificationError(
        `rebuilt index answers no search at all: ${asked} stored term${asked === 1 ? " finds" : "s find"} nothing`,
      );
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
    const pointer = readJson<IndexPointer>(this.pointerFile(input.collection));
    if (pointer === null || !isGenerationName(pointer.generation)) return false;

    const manifest = this.loadManifest(input.collection, pointer.generation);
    if (manifest === null) return false;

    const key = manifestKey(input);
    const before = manifest.entries.length;
    manifest.entries = manifest.entries.filter((entry) => manifestKey(entry) !== key);
    if (manifest.entries.length === before) return false;

    const service = await this.openStore(input.collection, pointer.generation);
    // The manifest named this entry, so its library and version already exist;
    // `ensureLibraryAndVersion` is upstream's only public way to resolve that
    // id, and its create-if-absent behaviour is unreachable from here.
    const versionId = await service.ensureLibraryAndVersion(
      input.collection,
      storeVersion(input.version),
    );
    const pages = await service.getPagesByVersionId(versionId);
    for (const page of pages) {
      if (page.url === input.sourceUrl) await service.deletePage(page.id);
    }

    this.saveManifest(input.collection, pointer.generation, manifest);
    return true;
  }

  /**
   * Decides whether a collection's derived state can answer as it stands.
   *
   * A generation is five things — a pointer, a directory, a manifest, a
   * database file, and rows inside it keyed by a particular encoding — and any
   * of them can be present while another is not. Every one of those states used
   * to end the same way: a query the store could not satisfy, reported as a
   * successful empty result. An index that cannot answer must never be
   * indistinguishable from an index with nothing to say, so all five are
   * checked here, in one place, and every caller goes through it.
   *
   * The checks run cheapest first and stop at the first problem, so the common
   * case costs a JSON read and one `COUNT(*)`.
   *
   * @param collection Normalized collection identifier.
   * @returns The usable generation and its manifest, or the reason it is not.
   */
  private inspectGeneration(collection: string): GenerationInspection {
    const pointer = readJson<IndexPointer>(this.pointerFile(collection));
    if (pointer === null || !isGenerationName(pointer.generation)) {
      return { usable: false, generation: null, problem: "never-built" };
    }

    const generation = pointer.generation;
    const directory = this.generationDir(collection, generation);
    if (!fs.existsSync(directory)) {
      return { usable: false, generation, problem: "generation-missing" };
    }

    const manifest = this.loadManifest(collection, generation);
    if (manifest === null) {
      return { usable: false, generation, problem: "manifest-unreadable" };
    }

    if (manifest.storeEncoding !== STORE_ENCODING_ID) {
      // The rows are all there and every one of them is keyed by a mapping this
      // build no longer produces, so every query would miss.
      return {
        usable: false,
        generation,
        problem: "encoding-changed",
        detail: `written by ${manifest.storeEncoding ?? "an unrecorded encoding"}, this build uses ${STORE_ENCODING_ID}`,
      };
    }

    const database = path.join(directory, "documents.db");
    if (!fs.existsSync(database)) {
      return { usable: false, generation, problem: "database-missing" };
    }

    const stored = countStoredChunks(database);
    if (stored === null) {
      return { usable: false, generation, problem: "database-unreadable" };
    }

    const recorded = manifest.entries.reduce((sum, entry) => sum + entry.chunkCount, 0);
    if (stored !== recorded) {
      return {
        usable: false,
        generation,
        problem: "database-inconsistent",
        detail: `${stored} chunks stored, ${recorded} recorded`,
      };
    }

    return { usable: true, generation, manifest };
  }

  /**
   * Resolves a generation this caller may use, repairing the state if it must.
   *
   * @param collection Normalized collection identifier.
   * @param options.loc Emitting location, for the log.
   * @param options.initializeWhenNew Whether a collection nothing has ever
   *   indexed may be initialized empty rather than rebuilt. A writing caller
   *   sets this — it is holding the first note and there is nothing to lose. A
   *   reader never does: an empty answer about an unbuilt collection is a
   *   statement about the state directory dressed up as one about the vault.
   * @returns A generation that {@link VaultIndex.inspectGeneration} accepts.
   */
  private async usableGeneration(
    collection: string,
    options: { loc: string; initializeWhenNew: boolean },
  ): Promise<string> {
    const inspection = this.inspectGeneration(collection);
    if (inspection.usable) return inspection.generation;

    if (inspection.problem === "never-built" && options.initializeWhenNew) {
      return this.ensureGeneration(collection);
    }

    this.logger({
      level: "warn",
      event: "index.state_missing",
      loc: options.loc,
      ctx: {
        collection,
        generation: inspection.generation,
        reason: inspection.problem,
        ...(inspection.detail === undefined ? {} : { detail: inspection.detail }),
      },
    });

    // Rebuilding is the only repair that restores every note rather than the
    // one a caller happens to be holding.
    return (await this.rebuildLocked({ collection })).generation;
  }

  /**
   * Creates a collection's first generation, empty.
   *
   * Reached only from {@link VaultIndex.usableGeneration}, and only for a
   * collection nothing has ever indexed *and* a caller that is writing: an
   * upsert holding the first note is being asked to create exactly this. Every
   * other state — including a generation that exists and is broken — rebuilds
   * instead, because initializing over one of those would strand every note it
   * already held.
   *
   * @returns The generation name that collection's pointer now names.
   */
  private ensureGeneration(collection: string): string {
    const generation = this.nextGenerationName(collection);
    fs.mkdirSync(this.generationDir(collection, generation), { recursive: true });
    this.saveManifest(collection, generation, this.emptyManifest(collection, generation));
    this.switchPointer(collection, generation);
    this.logger({
      level: "info",
      event: "index.initialized",
      loc: "VaultIndex.ensureGeneration",
      ctx: { collection, generation },
    });
    return generation;
  }

  /**
   * Names a generation directory that does not exist yet.
   *
   * The timestamp is for a human reading the directory; the counter is what
   * makes the name free. Rebuilds are serialized by the index lock, so the
   * first free name cannot be taken between choosing it and creating it.
   */
  private nextGenerationName(collection: string): string {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    for (let counter = 0; ; counter += 1) {
      const candidate = `gen-${stamp}-${counter}`;
      if (!fs.existsSync(this.generationDir(collection, candidate))) return candidate;
    }
  }

  /** Opens (or reuses) the store for one collection's generation. */
  private async openStore(
    collection: string,
    generation: string,
  ): Promise<DocumentManagementService> {
    if (
      this.open !== null &&
      (this.open.collection !== collection || this.open.generation !== generation)
    ) {
      await this.closeStore();
    }
    if (this.open !== null) return this.open.service;
    return this.openStoreAt(collection, generation);
  }

  /** Opens a store for one generation directory, whether or not it is active. */
  private async openStoreAt(
    collection: string,
    generation: string,
  ): Promise<DocumentManagementService> {
    await this.closeStore();

    const directory = this.generationDir(collection, generation);
    fs.mkdirSync(directory, { recursive: true });

    const service = new DocumentManagementService(new EventBusService(), {
      ...this.appConfig,
      app: { ...this.appConfig.app, storePath: directory },
    });
    await service.initialize();
    this.open = { collection, generation, service };
    return service;
  }

  /** Closes the open store, if there is one. */
  private async closeStore(): Promise<void> {
    if (this.open === null) return;
    const service = this.open.service;
    this.open = null;
    await service.shutdown();
  }

  private emptyManifest(collection: string, generation: string): IndexManifest {
    return {
      version: INDEX_MANIFEST_VERSION,
      generation,
      collection,
      storeEncoding: STORE_ENCODING_ID,
      createdAt: this.now().toISOString(),
      entries: [],
    };
  }

  /** Inserts or replaces one manifest row, keyed by source identity. */
  private putManifestEntry(manifest: IndexManifest, entry: IndexManifestEntry): void {
    const key = manifestKey(entry);
    const index = manifest.entries.findIndex((e) => manifestKey(e) === key);
    if (index >= 0) manifest.entries[index] = entry;
    else manifest.entries.push(entry);
  }

  /**
   * Reads a generation's manifest.
   *
   * @returns Null when it is absent, corrupt, written in a format this build
   *   does not read, or written for a different collection — all of which are
   *   "derived state was lost", which is a rebuild, never a guess.
   */
  private loadManifest(collection: string, generation: string): IndexManifest | null {
    const manifest = readJson<IndexManifest>(this.manifestFile(collection, generation));
    if (manifest === null || manifest.version !== INDEX_MANIFEST_VERSION) return null;
    if (manifest.collection !== collection) return null;
    if (!Array.isArray(manifest.entries)) return null;
    // Every entry, not just the array around them. A file whose header reads
    // correctly and whose rows do not is still derived state this build cannot
    // use, and saying so here is what routes it to the rebuild rather than to a
    // property access on a row that is not an object.
    if (!manifest.entries.every(isManifestEntry)) return null;
    return manifest;
  }

  private saveManifest(
    collection: string,
    generation: string,
    manifest: IndexManifest,
  ): void {
    writeFileAtomic(
      this.manifestFile(collection, generation),
      JSON.stringify(manifest, null, 2),
    );
  }

  /** Promotes one generation by an atomic rename of its collection's pointer. */
  private switchPointer(collection: string, generation: string): void {
    const pointer: IndexPointer = {
      generation,
      switchedAt: this.now().toISOString(),
    };
    writeFileAtomic(this.pointerFile(collection), JSON.stringify(pointer, null, 2));
  }

  /**
   * Removes generations older than the current one and its parent.
   *
   * The parent is kept because another process may have opened it moments
   * before the pointer moved.
   */
  private pruneGenerations(collection: string, current: string): void {
    const root = path.join(this.collectionRoot(collection), "generations");
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }

    const ordered = names
      .filter((name) => name !== current)
      .map((name) => {
        try {
          return { name, at: fs.statSync(path.join(root, name)).mtimeMs };
        } catch {
          // Listed a moment ago and not there now. Housekeeping is not the
          // place to turn somebody else's tidy-up into a failed rebuild.
          return null;
        }
      })
      .filter((entry): entry is { name: string; at: number } => entry !== null)
      .sort((a, b) => b.at - a.at)
      .slice(GENERATIONS_KEPT - 1);

    for (const stale of ordered) {
      try {
        fs.rmSync(path.join(root, stale.name), { recursive: true, force: true });
      } catch {
        this.logger({
          level: "warn",
          event: "index.prune_failed",
          loc: "VaultIndex.pruneGenerations",
          ctx: { collection, generation: stale.name },
        });
      }
    }
  }
}
