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
 *   interleave their read-decide-write cycle. It is a SQLite `BEGIN EXCLUSIVE`
 *   transaction, which means the operating system owns mutual exclusion and
 *   releases it when a process dies — see {@link PublicationJournal.withLock}.
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
import {
  DEFAULT_LOCK_POLL_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  type LockHolder,
  type LockOptions,
  readLockHolder,
  withExclusiveLock,
} from "./lock";

export { type LockOptions, LockTimeoutError } from "./lock";

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

/**
 * Layout version of the runtime state directory.
 *
 * Version 1 — proposals stored flat as `journal/proposals/<digest>.md` — never
 * shipped: it existed only on an unmerged branch, so no operator state
 * directory was ever written in that shape and there is nothing to migrate.
 * The marker exists so that if the layout ever does change under a released
 * build, the mismatch is refused loudly instead of read as if it were current.
 */
export const STATE_LAYOUT_VERSION = 2;

/** The state directory was written by a different layout than this build reads. */
export class StateLayoutError extends Error {
  constructor(
    message: string,
    readonly stateDir: string,
    readonly found: number | null,
    readonly expected: number,
  ) {
    super(message);
    this.name = "StateLayoutError";
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

/**
 * Flushes a directory entry so a rename or unlink survives a power loss.
 *
 * Renaming durably is two steps, not one: the file's own fsync only promises
 * its contents, while the directory's fsync is what promises the name now
 * points at them.
 */
function fsyncDir(directory: string): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(directory, "r");
    fs.fsyncSync(handle);
  } catch {
    // Some filesystems refuse to fsync a directory handle. The rename is still
    // atomic there; only the durability barrier is unavailable.
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

/** Writes a file through a temporary file, an fsync and an atomic rename. */
function writeFileAtomic(file: string, data: string): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(handle, data, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
  fsyncDir(directory);
}

/** Removes a file and flushes the removal. */
function removeFile(file: string): void {
  if (!fs.existsSync(file)) return;
  fs.rmSync(file, { force: true });
  fsyncDir(path.dirname(file));
}

/** Reads and parses a JSON file, returning null when it is absent or corrupt. */
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** One per-source lock, as `doctor` reports it. */
export interface LockRecord {
  /** Sanitized source key the lock database is named for. */
  source: string;
  /** Token of the last recorded holder, or null when it cannot be read. */
  ownerToken: string | null;
  acquiredAt: string | null;
  /** True when a capture holds this lock right now. */
  busy: boolean;
}

/** What this publisher recorded for one preserved incoming candidate. */
export interface CandidateRecord {
  /** Vault-relative path of the candidate note. */
  path: string;
  /** SHA-256 of the whole candidate note this publisher wrote, or intended to. */
  digest: string;
  /**
   * Whether the note was observed in the vault carrying exactly those bytes.
   *
   * The record is written before the note is created, so an interruption
   * between the two leaves `false`: the digest is then an intent, good enough
   * to recognise our own untouched bytes, and never good enough to declare an
   * edited candidate unmodified.
   */
  verified: boolean;
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
      timeoutMs: options.lock?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      pollMs: options.lock?.pollMs ?? DEFAULT_LOCK_POLL_MS,
      onBusy: options.lock?.onBusy ?? (() => undefined),
    };
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.ensureLayout();
  }

  /**
   * Stamps a new state directory with its layout version, and refuses one whose
   * layout this build cannot read.
   *
   * An empty directory is initialized. A directory that already holds entries
   * or ownership records but carries no marker predates the marker, so its
   * layout is unknown — and reading unknown state as if it were current is how
   * a journal ends up pointing at bytes that are not there.
   *
   * @throws StateLayoutError when the marker is missing beside existing state,
   *   or names a version this build does not implement.
   */
  private ensureLayout(): void {
    const markerFile = path.join(this.stateDir, "layout.json");
    const marker = readJson<{ version?: unknown }>(markerFile);
    const found = typeof marker?.version === "number" ? marker.version : null;

    if (found === STATE_LAYOUT_VERSION) return;

    if (found !== null) {
      throw new StateLayoutError(
        `state directory ${this.stateDir} has layout version ${found}, but this build reads version ${STATE_LAYOUT_VERSION}`,
        this.stateDir,
        found,
        STATE_LAYOUT_VERSION,
      );
    }

    if (this.hasExistingState()) {
      throw new StateLayoutError(
        `state directory ${this.stateDir} holds state with no layout marker; this build reads version ${STATE_LAYOUT_VERSION} and will not guess which version wrote it`,
        this.stateDir,
        null,
        STATE_LAYOUT_VERSION,
      );
    }

    writeFileAtomic(
      markerFile,
      JSON.stringify({ version: STATE_LAYOUT_VERSION }, null, 2),
    );
  }

  /** Reports whether anything durable has already been written here. */
  private hasExistingState(): boolean {
    for (const directory of ["journal", "ownership", "candidates"]) {
      try {
        if (fs.readdirSync(path.join(this.stateDir, directory)).length > 0) return true;
      } catch {
        // Absent directory: nothing written yet.
      }
    }
    return false;
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

  /**
   * Path of a proposal's bytes.
   *
   * Proposals are content addressed and immutable, so an entry's
   * `proposedWholeNoteDigest` names exactly one generation of bytes.
   * Re-preparing a source writes a new file rather than replacing the one an
   * older entry still refers to, which is what makes the two writes safe to
   * interrupt.
   *
   * They are also namespaced per source, so their whole lifecycle sits under
   * that source's lock. A digest-only namespace would be shared state: two
   * sources proposing identical bytes would share one file, and one of them
   * collecting it could delete bytes the other had just decided not to rewrite.
   */
  private proposalFile(sourceId: string, digest: string): string {
    return path.join(
      this.stateDir,
      "journal",
      "proposals",
      this.key(sourceId),
      `${digest}.md`,
    );
  }

  private ownershipFile(sourceId: string): string {
    return path.join(this.stateDir, "ownership", `${this.key(sourceId)}.json`);
  }

  private candidateFile(name: string): string {
    return path.join(this.stateDir, "candidates", `${this.key(name)}.json`);
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

    // The proposal lands first, under its own digest. A death before the entry
    // write leaves an orphan file nobody reads; a death after it leaves an
    // entry whose bytes are provably the ones it names.
    const proposal = this.proposalFile(input.sourceId, input.proposedWholeNoteDigest);
    if (!fs.existsSync(proposal)) writeFileAtomic(proposal, input.bytes);

    const previous = this.entry(input.sourceId);
    writeFileAtomic(this.entryFile(input.sourceId), JSON.stringify(entry, null, 2));
    if (
      previous !== null &&
      previous.proposedWholeNoteDigest !== input.proposedWholeNoteDigest
    ) {
      this.collectProposal(input.sourceId, previous.proposedWholeNoteDigest);
    }
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
    const entry = this.entry(sourceId);
    removeFile(this.entryFile(sourceId));
    if (entry !== null) this.collectProposal(sourceId, entry.proposedWholeNoteDigest);
  }

  /**
   * Removes a proposal's bytes once this source's entry no longer refers to
   * them.
   *
   * Only this source's own namespace is ever touched, so collection is covered
   * by the same lock that covers the entry it belongs to.
   */
  private collectProposal(sourceId: string, digest: string): void {
    const current = this.entry(sourceId);
    if (current?.proposedWholeNoteDigest === digest) return;
    removeFile(this.proposalFile(sourceId, digest));
  }

  /** Reads one journal entry, or null when there is none. */
  entry(sourceId: string): JournalEntry | null {
    return readJson<JournalEntry>(this.entryFile(sourceId));
  }

  /**
   * Reads the proposed bytes an entry refers to.
   *
   * The bytes are verified against the digest the entry names, so corrupted or
   * truncated state is reported as missing rather than published.
   *
   * @returns The proposal, or null when it is absent or does not match.
   */
  proposedBytes(sourceId: string): string | null {
    const entry = this.entry(sourceId);
    if (entry === null) return null;

    try {
      const bytes = fs.readFileSync(
        this.proposalFile(sourceId, entry.proposedWholeNoteDigest),
        "utf8",
      );
      if (sha256(bytes) !== entry.proposedWholeNoteDigest) {
        this.logger({
          level: "error",
          event: "journal.proposal_corrupt",
          loc: "PublicationJournal.proposedBytes",
          ctx: { sourceId, expected: entry.proposedWholeNoteDigest },
        });
        return null;
      }
      return bytes;
    } catch {
      return null;
    }
  }

  /** Reads what this publisher recorded for a preserved candidate. */
  readCandidate(name: string): CandidateRecord | null {
    return readJson<CandidateRecord>(this.candidateFile(name));
  }

  /**
   * Records the exact bytes a preserved candidate was, or is about to be,
   * written with.
   *
   * Semantic addressing decides which candidate a conflict reuses; this
   * whole-note digest is what proves the candidate has not been edited since.
   *
   * @param input.verified False while the note has not yet been observed
   *   carrying these bytes, which is how the intent survives a process death
   *   between recording and creation.
   */
  writeCandidate(input: {
    name: string;
    path: string;
    digest: string;
    verified: boolean;
  }): CandidateRecord {
    const record: CandidateRecord = {
      path: input.path,
      digest: input.digest,
      verified: input.verified,
    };
    writeFileAtomic(this.candidateFile(input.name), JSON.stringify(record, null, 2));
    return record;
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
   * The mechanics live in {@link withExclusiveLock}: one SQLite database per
   * source, held inside a `BEGIN EXCLUSIVE` transaction, released by the kernel
   * when the holding process ends. This method only chooses *which* file that
   * is and what to say when the wait runs out — there is exactly one
   * implementation of the primitive in this fork, shared with the index lock.
   *
   * @param sourceId Identity whose lock file is taken.
   * @param critical Section to run under the lock; its result is returned.
   * @throws LockTimeoutError when the holder outlives the wait.
   */
  async withLock<T>(sourceId: string, critical: () => Promise<T>): Promise<T> {
    const file = this.lockFile(sourceId);
    return withExclusiveLock(
      {
        file,
        timeoutMs: this.lockOptions.timeoutMs,
        pollMs: this.lockOptions.pollMs,
        onBusy: this.lockOptions.onBusy,
        logger: this.logger,
        loc: "PublicationJournal.withLock",
        ctx: { sourceId },
        timeoutMessage: `another capture holds the lock for ${sourceId} (${file})`,
        now: this.now,
      },
      critical,
    );
  }

  /** Vault-free location of one source's lock database. */
  private lockFile(sourceId: string): string {
    return path.join(this.stateDir, "locks", `${this.key(sourceId)}.db`);
  }

  /**
   * Reports who last held a source's lock, for `doctor`.
   *
   * @param sourceId Identity whose lock file is inspected.
   * @returns The recorded holder, or null when there is none or the lock is
   *   busy — a reader cannot see into an exclusive transaction, and waiting for
   *   one would make a diagnostic command block.
   */
  lockDiagnostics(sourceId: string): LockHolder | null {
    const read = readLockHolder(this.lockFile(sourceId));
    return read.busy ? null : read.holder;
  }

  /**
   * Lists every per-source lock this state directory holds a database for.
   *
   * @returns One record per lock, with its recorded holder, or `busy` when a
   *   capture is inside that lock right now.
   */
  lockRecords(): LockRecord[] {
    const directory = path.join(this.stateDir, "locks");
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      return [];
    }

    const records: LockRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".db")) continue;
      const read = readLockHolder(path.join(directory, name));
      records.push({
        source: name.replace(/\.db$/, ""),
        ownerToken: read.holder?.ownerToken ?? null,
        acquiredAt: read.holder?.acquiredAt ?? null,
        busy: read.busy,
      });
    }
    return records.sort((a, b) => a.source.localeCompare(b.source));
  }
}
