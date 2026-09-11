/**
 * Durable capture state that lives outside the vault.
 *
 * Three things are kept here, and none of them are vault bytes:
 *
 * - a **journal** entry per in-flight capture, recording the note's prior and
 *   proposed whole-note digests plus the proposed bytes, so an interrupted run
 *   can be classified and finished rather than guessed at;
 * - an **ownership** record per source — the exact whole-note digest this
 *   publisher last committed — which is what distinguishes our own note from a
 *   note a human has edited;
 * - a per-source **interprocess lock**, so two captures of one source never
 *   interleave their read-decide-write cycle.
 *
 * The vault never learns about any of it: a note's bytes carry no `last_seen_at`
 * and no ownership marker, because publisher frontmatter is forgeable and a
 * human edit must always win by default.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./identity";

/** Default durable state location on macOS. */
export const DEFAULT_STATE_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "SecondBrainDocs",
);

/** Default JSONL event log location on macOS. */
export const DEFAULT_LOG_FILE = path.join(
  os.homedir(),
  "Library",
  "Logs",
  "SecondBrainDocs",
  "events.jsonl",
);

/** How long a lock may sit untouched before another process may break it. */
const DEFAULT_STALE_AFTER_MS = 60_000;

/** How long an acquirer waits before giving up on a live lock. */
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** How often an acquirer retries while another holder is live. */
const DEFAULT_LOCK_POLL_MS = 25;

/** Phases of one note publication, in the order they are reached. */
export type JournalPhase = "prepared" | "note-written" | "moc-linked" | "complete";

/** One in-flight (or interrupted) publication. */
export interface JournalEntry {
  sourceId: string;
  /** Vault-relative path the publication targets. */
  path: string;
  /** Whole-note digest observed before the write; null when creating. */
  priorWholeNoteDigest: string | null;
  /** Whole-note digest of the bytes this capture intends to leave behind. */
  proposedWholeNoteDigest: string;
  phase: JournalPhase;
  updatedAt: string;
}

/** The last bytes this publisher committed for one source. */
export interface OwnershipRecord {
  sourceId: string;
  path: string;
  /** SHA-256 of the whole note, frontmatter included. */
  digest: string;
  lastSeenAt: string;
}

/** One structured event, emitted as a single JSONL line. */
export interface VaultLogEvent {
  level: "debug" | "info" | "warn" | "error";
  /** Dotted event name, e.g. `capture.decision`. */
  event: string;
  /** Where in the code the event was emitted. */
  loc: string;
  /** Typed context; never note bodies. */
  ctx: Record<string, unknown>;
}

/** Sink for structured events. */
export type VaultLogger = (event: VaultLogEvent) => void;

/** Logger that discards everything, used when logging is off. */
export const nullLogger: VaultLogger = () => undefined;

/**
 * Builds a JSONL logger.
 *
 * @param options.filePath Sink path; defaults to {@link DEFAULT_LOG_FILE}.
 * @param options.enabled Overrides the `SB_DOCS_LOG` environment gate.
 * @param options.runId Correlation id shared by every line of one run.
 * @returns A logger that appends one JSON object per line, or {@link nullLogger}
 *   when logging is disabled.
 */
export function createJsonlLogger(
  options: { filePath?: string; enabled?: boolean; runId?: string } = {},
): VaultLogger {
  const enabled =
    options.enabled ?? ["1", "true", "yes"].includes(process.env.SB_DOCS_LOG ?? "");
  if (!enabled) return nullLogger;

  const filePath = options.filePath ?? DEFAULT_LOG_FILE;
  const runId = options.runId ?? randomUUID();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  return (event) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      run_id: runId,
      level: event.level,
      event: event.event,
      loc: event.loc,
      ctx: event.ctx,
    });
    // Appends are best effort: losing a diagnostic must never fail a capture.
    try {
      fs.appendFileSync(filePath, `${line}\n`, "utf8");
    } catch {
      /* ignore */
    }
  };
}

/** The requested state directory is not a safe place to keep runtime state. */
export class StatePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatePathError";
  }
}

/** Another holder kept the per-source lock for longer than we were prepared to wait. */
export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockTimeoutError";
  }
}

/**
 * Canonicalizes a path that may not exist yet.
 *
 * Only existing ancestors can be resolved through symlinks, so the deepest
 * existing ancestor is resolved and the remaining components are appended. A
 * path under a symlinked alias of the vault therefore still compares equal to
 * the vault.
 */
function canonicalize(target: string): string {
  const resolved = path.resolve(target);
  let existing = resolved;
  const trailing: string[] = [];

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    trailing.unshift(path.basename(existing));
    existing = parent;
  }

  return path.join(fs.realpathSync(existing), ...trailing);
}

/** Reports whether `child` is `parent` or lives underneath it. */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

/**
 * Resolves and validates the runtime state directory.
 *
 * @param options.stateDir Requested directory; defaults to
 *   {@link DEFAULT_STATE_DIR}.
 * @param options.vaultPath Vault to stay out of; defaults to `OBSIDIAN_VAULT`.
 * @returns The canonical state directory path.
 * @throws StatePathError when the state directory is inside the vault, however
 *   it is spelled.
 */
export function resolveStateDir(
  options: { stateDir?: string; vaultPath?: string } = {},
): string {
  const requested = canonicalize(options.stateDir ?? DEFAULT_STATE_DIR);
  const vaultPath = options.vaultPath ?? process.env.OBSIDIAN_VAULT;

  if (vaultPath !== undefined && vaultPath.length > 0) {
    const vault = canonicalize(vaultPath);
    if (isWithin(vault, requested)) {
      throw new StatePathError(
        `runtime state must live outside the vault: ${requested} is inside ${vault}`,
      );
    }
  }

  return requested;
}

/** Writes a file through a temporary file, an fsync and an atomic rename. */
function writeFileAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(handle, data, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
}

/** Reads and parses a JSON file, returning null when it is absent or corrupt. */
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Reports whether a process id is still running on this host. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to somebody else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Options accepted by the per-source lock. */
export interface LockOptions {
  staleAfterMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}

/** Owner metadata written inside a held lock directory. */
interface LockOwner {
  pid: number;
  host: string;
  acquiredAt: string;
}

export class PublicationJournal {
  /** Canonical, validated state directory. */
  readonly stateDir: string;

  private readonly logger: VaultLogger;
  private readonly lockOptions: Required<LockOptions>;
  private readonly now: () => Date;

  constructor(
    options: {
      stateDir?: string;
      vaultPath?: string;
      logger?: VaultLogger;
      lock?: LockOptions;
      now?: () => Date;
    } = {},
  ) {
    this.stateDir = resolveStateDir(options);
    this.logger = options.logger ?? nullLogger;
    this.now = options.now ?? (() => new Date());
    this.lockOptions = {
      staleAfterMs: options.lock?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      timeoutMs: options.lock?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      pollMs: options.lock?.pollMs ?? DEFAULT_LOCK_POLL_MS,
    };
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  /**
   * Reduces a source identity to a filename-safe key.
   *
   * Identities are normally hex digests, but `doctor --adopt` can carry one
   * straight out of a hand-written note, so anything unexpected is hashed
   * rather than trusted as a path component.
   */
  private key(sourceId: string): string {
    return /^[A-Za-z0-9_-]{1,64}$/.test(sourceId) ? sourceId : sha256(sourceId);
  }

  private entryFile(sourceId: string): string {
    return path.join(this.stateDir, "journal", `${this.key(sourceId)}.json`);
  }

  private bytesFile(sourceId: string): string {
    return path.join(this.stateDir, "journal", `${this.key(sourceId)}.bytes.md`);
  }

  private ownershipFile(sourceId: string): string {
    return path.join(this.stateDir, "ownership", `${this.key(sourceId)}.json`);
  }

  /**
   * Records a publication about to be attempted, together with the exact bytes
   * it intends to write.
   *
   * @param input.priorWholeNoteDigest Digest of the note as it stands now, or
   *   null when the note does not exist yet.
   */
  prepare(input: {
    sourceId: string;
    path: string;
    priorWholeNoteDigest: string | null;
    proposedWholeNoteDigest: string;
    bytes: string;
  }): JournalEntry {
    const entry: JournalEntry = {
      sourceId: input.sourceId,
      path: input.path,
      priorWholeNoteDigest: input.priorWholeNoteDigest,
      proposedWholeNoteDigest: input.proposedWholeNoteDigest,
      phase: "prepared",
      updatedAt: this.now().toISOString(),
    };

    // Bytes first: an entry that names a proposal we cannot produce is worse
    // than bytes nobody references.
    writeFileAtomic(this.bytesFile(input.sourceId), input.bytes);
    writeFileAtomic(this.entryFile(input.sourceId), JSON.stringify(entry, null, 2));
    this.logger({
      level: "debug",
      event: "journal.prepared",
      loc: "PublicationJournal.prepare",
      ctx: { sourceId: input.sourceId, path: input.path },
    });
    return entry;
  }

  /**
   * Moves an existing entry to a later phase.
   *
   * @throws Error when no entry exists for the source.
   */
  advance(sourceId: string, phase: JournalPhase): JournalEntry {
    const entry = this.entry(sourceId);
    if (entry === null) throw new Error(`no journal entry for ${sourceId}`);

    const advanced: JournalEntry = {
      ...entry,
      phase,
      updatedAt: this.now().toISOString(),
    };
    writeFileAtomic(this.entryFile(sourceId), JSON.stringify(advanced, null, 2));
    this.logger({
      level: "debug",
      event: "journal.advanced",
      loc: "PublicationJournal.advance",
      ctx: { sourceId, phase },
    });
    return advanced;
  }

  /**
   * Marks a publication complete and prunes its entry.
   *
   * The completed phase is written before the prune, so a crash in between
   * leaves a `complete` entry that recovery simply discards.
   */
  complete(sourceId: string): void {
    if (this.entry(sourceId) !== null) this.advance(sourceId, "complete");
    this.discard(sourceId);
  }

  /** Removes an entry and its proposed bytes without touching ownership. */
  discard(sourceId: string): void {
    fs.rmSync(this.entryFile(sourceId), { force: true });
    fs.rmSync(this.bytesFile(sourceId), { force: true });
  }

  /** Reads one journal entry, or null when there is none. */
  entry(sourceId: string): JournalEntry | null {
    return readJson<JournalEntry>(this.entryFile(sourceId));
  }

  /** Reads the proposed bytes recorded with an entry, or null when absent. */
  proposedBytes(sourceId: string): string | null {
    try {
      return fs.readFileSync(this.bytesFile(sourceId), "utf8");
    } catch {
      return null;
    }
  }

  /** Every entry that has not been completed and pruned. */
  pending(): JournalEntry[] {
    const directory = path.join(this.stateDir, "journal");
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      return [];
    }

    const entries: JournalEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
      const entry = readJson<JournalEntry>(path.join(directory, name));
      if (entry !== null) entries.push(entry);
    }
    return entries.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  /** Reads the ownership record for a source, or null when we own nothing. */
  readOwnership(sourceId: string): OwnershipRecord | null {
    return readJson<OwnershipRecord>(this.ownershipFile(sourceId));
  }

  /**
   * Records the exact bytes this publisher is accountable for.
   *
   * @param input.lastSeenAt Capture time of this observation; stored here
   *   rather than in the note so an unchanged note keeps its bytes.
   */
  writeOwnership(input: {
    sourceId: string;
    path: string;
    digest: string;
    lastSeenAt?: string;
  }): OwnershipRecord {
    const record: OwnershipRecord = {
      sourceId: input.sourceId,
      path: input.path,
      digest: input.digest,
      lastSeenAt: input.lastSeenAt ?? this.now().toISOString(),
    };
    writeFileAtomic(this.ownershipFile(input.sourceId), JSON.stringify(record, null, 2));
    return record;
  }

  /** Number of ownership records, for diagnostics. */
  ownershipCount(): number {
    return this.ownershipRecords().length;
  }

  /** Every ownership record currently stored. */
  ownershipRecords(): OwnershipRecord[] {
    const directory = path.join(this.stateDir, "ownership");
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      return [];
    }

    const records: OwnershipRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
      const record = readJson<OwnershipRecord>(path.join(directory, name));
      if (record !== null) records.push(record);
    }
    return records;
  }

  /**
   * Runs `critical` while holding the per-source interprocess lock.
   *
   * The lock is a directory, because `mkdir` is atomic on every filesystem the
   * vault can live on. A lock whose owning process is gone, or which has sat
   * untouched past the staleness window, is broken explicitly; a lock held by a
   * live process is waited for and then reported as a timeout rather than
   * stolen.
   *
   * @throws LockTimeoutError when the holder outlives the wait.
   */
  async withLock<T>(sourceId: string, critical: () => Promise<T>): Promise<T> {
    const lockDir = path.join(this.stateDir, "locks", `${this.key(sourceId)}.lock`);
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });

    const deadline = Date.now() + this.lockOptions.timeoutMs;
    for (;;) {
      if (this.tryAcquire(lockDir)) break;
      if (this.breakIfStale(lockDir, sourceId)) continue;
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `another capture holds the lock for ${sourceId} (${lockDir})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.lockOptions.pollMs));
    }

    try {
      return await critical();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  /** Attempts one atomic acquisition; false means somebody else holds it. */
  private tryAcquire(lockDir: string): boolean {
    try {
      fs.mkdirSync(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }

    const owner: LockOwner = {
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: this.now().toISOString(),
    };
    writeFileAtomic(path.join(lockDir, "owner.json"), JSON.stringify(owner));
    return true;
  }

  /**
   * Breaks a lock whose owner is provably gone or whose age exceeds the
   * staleness window.
   *
   * @returns true when the lock was broken and acquisition should be retried.
   */
  private breakIfStale(lockDir: string, sourceId: string): boolean {
    const owner = readJson<LockOwner>(path.join(lockDir, "owner.json"));

    let age = Number.POSITIVE_INFINITY;
    try {
      age = Date.now() - fs.statSync(lockDir).mtimeMs;
    } catch {
      // The directory vanished; retrying is exactly right.
      return true;
    }

    const ownerGone =
      owner !== null && owner.host === os.hostname() && !processAlive(owner.pid);
    const expired = age > this.lockOptions.staleAfterMs;
    if (!ownerGone && !expired) return false;

    this.logger({
      level: "warn",
      event: "lock.broken",
      loc: "PublicationJournal.breakIfStale",
      ctx: { sourceId, reason: ownerGone ? "owner-gone" : "expired", ageMs: age },
    });
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  }
}
