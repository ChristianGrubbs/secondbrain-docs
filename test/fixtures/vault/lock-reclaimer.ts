/**
 * Child process that takes a per-source lock, optionally pausing or dying at a
 * chosen point in the reclaim protocol.
 *
 * These are the interleavings a single-process test cannot reach: another
 * process is mid-reclaim, holding the reclaim guard, with the canonical lock
 * directory already renamed aside — and it either stops responding forever or
 * resumes after somebody else has taken the lock.
 *
 * Entry into the critical section is recorded through a witness file created
 * with `wx`, which is an atomic create-if-absent. Two overlapping holders
 * cannot both create it, so an overlap is observable as a fact rather than
 * inferred from timestamps.
 *
 * Environment:
 * - `STATE_DIR`    runtime state directory, shared with the parent
 * - `VAULT_PATH`   vault the state directory must stay out of
 * - `SOURCE_ID`    identity to lock
 * - `MODE`         `acquire`, `pause-after-rename` or `die-after-rename`
 * - `PAUSED_FILE`  written when the child reaches its barrier
 * - `GO_FILE`      polled until it exists; the child then continues
 * - `WITNESS_FILE` exclusive-create witness proving sections never overlap
 * - `ENTRIES_FILE` one line appended per critical section entered
 * - `TIMEOUT_MS`   how long to wait for the lock
 * - `HOLD_MS`      how long to hold the lock once acquired
 */

import fs from "node:fs";
import { PublicationJournal } from "../../../src/vault/PublicationJournal";

const say = (event: string, extra: Record<string, unknown> = {}): void => {
  process.stdout.write(
    `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...extra })}\n`,
  );
};

const mode = process.env.MODE ?? "acquire";
const pausedFile = process.env.PAUSED_FILE ?? "";
const goFile = process.env.GO_FILE ?? "";
const witnessFile = process.env.WITNESS_FILE ?? "";
const entriesFile = process.env.ENTRIES_FILE ?? "";

/** Dies instantly and unrecoverably, the way a killed process does. */
const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
};

/** Signals the parent and waits for its go-ahead. */
async function pause(sourceId: string): Promise<void> {
  say("paused", { sourceId });
  fs.writeFileSync(pausedFile, "paused");
  while (!fs.existsSync(goFile)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  say("resumed");
}

/** A journal that stops at one point inside the reclaim protocol. */
class BarrierJournal extends PublicationJournal {
  private tripped = false;
  private trippedBefore = false;

  protected override async beforeReclaim(sourceId: string): Promise<void> {
    if (mode !== "pause-before-reclaim" || this.trippedBefore) return;
    this.trippedBefore = true;
    await pause(sourceId);
  }

  protected override async afterReclaimRename(sourceId: string): Promise<void> {
    if (this.tripped) return;
    this.tripped = true;

    if (mode === "die-after-rename") {
      say("dying", { sourceId });
      die();
    }

    if (mode !== "pause-after-rename") return;
    await pause(sourceId);
  }
}

const journal = new BarrierJournal({
  stateDir: process.env.STATE_DIR,
  vaultPath: process.env.VAULT_PATH,
  lock: {
    timeoutMs: Number(process.env.TIMEOUT_MS ?? 3000),
    pollMs: 10,
    staleAfterMs: Number(process.env.STALE_AFTER_MS ?? 60_000),
  },
});

try {
  await journal.withLock(process.env.SOURCE_ID ?? "contended", async () => {
    // `wx` fails if the file exists, so a second holder inside at the same time
    // is recorded rather than silently tolerated.
    try {
      fs.writeFileSync(witnessFile, String(process.pid), { flag: "wx" });
    } catch {
      say("overlap", { witness: fs.readFileSync(witnessFile, "utf8") });
      throw new Error("critical sections overlapped");
    }

    say("acquired");
    if (entriesFile) fs.appendFileSync(entriesFile, `${process.pid}\n`);
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD_MS ?? 30)));
    say("releasing");
    fs.rmSync(witnessFile, { force: true });
  });
  say("released");
} catch (error) {
  say("failed", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
