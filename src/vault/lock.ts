/**
 * The one interprocess lock primitive this fork owns.
 *
 * A lock is a SQLite database held open inside a `BEGIN EXCLUSIVE` transaction
 * for the whole critical section. That transaction takes a POSIX advisory lock
 * on the file, and the *kernel* releases it when the holding process ends,
 * however it ends.
 *
 * That is the entire reason for the choice. Any lock built from `mkdir` plus a
 * liveness check has the same shape of race at its core: the state you validate
 * and the state you then act on are two different observations, and anything
 * can happen in between. Moving that decision into the operating system removes
 * the question rather than narrowing the window — no owner file, no pid check,
 * no heartbeat, no staleness window, no reclamation, no guard, and nothing left
 * behind to clean up after a crash.
 *
 * The database stays in SQLite's default rollback-journal mode. WAL is
 * deliberately not enabled: its readers do not block an exclusive writer the
 * way this relies on.
 *
 * Two callers use it and both go through this module rather than reimplementing
 * it: {@link PublicationJournal.withLock} for its per-source publication lock,
 * and {@link VaultIndex} for the single state-level index lock.
 *
 * The lock is **not reentrant**. A holder that calls back into another locked
 * entry point deadlocks against itself until its own timeout, so helpers that
 * run inside a critical section take the section as given and never re-acquire.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import type { VaultLogger } from "./PublicationJournal";

/** How long an acquirer waits before giving up on a live lock. */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** How often an acquirer retries while another holder is live. */
export const DEFAULT_LOCK_POLL_MS = 25;

/** Another holder kept the lock for longer than we were prepared to wait. */
export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockTimeoutError";
  }
}

/** Waiting behaviour a caller can tune. */
export interface LockOptions {
  /** How long to wait for a lock another process holds. */
  timeoutMs?: number;
  /** Base retry interval; the real pause is jittered around it. */
  pollMs?: number;
  /**
   * Called each time the lock is found already held, with the attempt number.
   *
   * Contention is otherwise invisible from outside: a caller that eventually
   * acquires looks exactly like one that never waited. This makes "somebody
   * else had it" an observable event.
   */
  onBusy?: (attempt: number) => void;
}

/** Who the lock database last recorded as its holder. */
export interface LockHolder {
  ownerToken: string;
  acquiredAt: string;
}

/** One acquisition request. */
export interface ExclusiveLockRequest extends LockOptions {
  /** Absolute path of the lock database; its parent is created if absent. */
  file: string;
  /** Structured sink for `lock.busy` and `lock.acquired`. */
  logger?: VaultLogger;
  /** Value used as the `loc` field of those events. */
  loc?: string;
  /** Typed context merged into every lock event and nothing else. */
  ctx?: Record<string, unknown>;
  /** Message carried by {@link LockTimeoutError}; names the contended resource. */
  timeoutMessage?: string;
  /** Clock used for the recorded acquisition time; injected by tests. */
  now?: () => Date;
}

/** Recognizes SQLite's "somebody else holds the lock" failure. */
export function isBusyError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT";
}

/**
 * Records who holds the lock, inside the transaction that holds it.
 *
 * This is diagnostics and nothing else: correctness comes from the file lock
 * the kernel is managing, never from this row.
 */
function recordHolder(db: DatabaseType, token: string, acquiredAt: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS lock_holder (id INTEGER PRIMARY KEY CHECK (id = 1), owner_token TEXT NOT NULL, acquired_at TEXT NOT NULL)",
  );
  db.prepare(
    "INSERT INTO lock_holder (id, owner_token, acquired_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_token = excluded.owner_token, acquired_at = excluded.acquired_at",
  ).run(token, acquiredAt);
}

/**
 * Runs `critical` while holding the exclusive interprocess lock on `file`.
 *
 * @param request Lock file, waiting behaviour and diagnostics context.
 * @param critical Section to run under the lock; its result is returned.
 * @returns Whatever `critical` resolves to.
 * @throws LockTimeoutError when the holder outlives the wait.
 */
export async function withExclusiveLock<T>(
  request: ExclusiveLockRequest,
  critical: () => Promise<T>,
): Promise<T> {
  const file = request.file;
  const timeoutMs = request.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = request.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const onBusy = request.onBusy ?? ((): void => undefined);
  const logger = request.logger;
  const loc = request.loc ?? "lock.withExclusiveLock";
  const ctx = request.ctx ?? {};
  const now = request.now ?? ((): Date => new Date());

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  let db: DatabaseType | null = null;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const handle = new Database(file);
    try {
      // Bounded per attempt, so the loop stays in charge of the deadline.
      const remaining = Math.max(1, deadline - Date.now());
      handle.pragma(`busy_timeout = ${Math.min(pollMs * 5, remaining)}`);
      handle.exec("BEGIN EXCLUSIVE");
      db = handle;
      break;
    } catch (error) {
      handle.close();
      if (!isBusyError(error)) throw error;

      onBusy(attempt);
      logger?.({ level: "debug", event: "lock.busy", loc, ctx: { ...ctx, attempt } });

      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          request.timeoutMessage ?? `another process holds the lock (${file})`,
        );
      }
      // Jittered, so two contenders do not retry in lockstep.
      const pause = pollMs * (1 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }

  try {
    // Everything after the transaction opens belongs inside this block. A
    // logger is injected, so it can throw, and anything that throws between
    // acquiring and the cleanup below would leave the connection — and the
    // lock — open until the process exits.
    logger?.({ level: "debug", event: "lock.acquired", loc, ctx });
    recordHolder(db, token, now().toISOString());
    return await critical();
  } finally {
    // Either ending releases the file lock; the distinction only matters to
    // the diagnostics row, which nothing depends on.
    try {
      db.exec("COMMIT");
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the transaction is already gone */
      }
    }
    db.close();
  }
}

/**
 * Reads a lock database's recorded holder without ever waiting for it.
 *
 * The busy timeout is zero on purpose. better-sqlite3 defaults to five seconds,
 * which would make a diagnostic command sit and stare at a capture that is
 * doing its job; "held right now" is the answer, and it is available
 * immediately.
 *
 * @param file Lock database to inspect.
 * @returns The recorded holder, and whether somebody is inside the lock now.
 */
export function readLockHolder(file: string): {
  holder: LockHolder | null;
  busy: boolean;
} {
  if (!fs.existsSync(file)) return { holder: null, busy: false };

  let db: DatabaseType | null = null;
  try {
    db = new Database(file, { readonly: true, timeout: 0 });
    const row = db
      .prepare(
        "SELECT owner_token AS ownerToken, acquired_at AS acquiredAt FROM lock_holder WHERE id = 1",
      )
      .get() as LockHolder | undefined;
    return { holder: row ?? null, busy: false };
  } catch (error) {
    return { holder: null, busy: isBusyError(error) };
  } finally {
    db?.close();
  }
}
