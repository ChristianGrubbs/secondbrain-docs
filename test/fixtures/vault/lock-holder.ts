/**
 * Child process that takes a real per-source lock, for the multiprocess lock
 * fixtures. Run through `vite-node` so it exercises the same source the
 * publisher does, in a genuinely separate process.
 *
 * Barriers are explicit files rather than sleeps, so the parent can assert on
 * a state rather than on a timing guess: the child announces that it holds the
 * lock, and waits to be told to let go.
 *
 * Entry into the critical section is recorded through a witness file created
 * with `wx`, an atomic create-if-absent. Two overlapping holders cannot both
 * create it, so an overlap is observable as a fact rather than inferred.
 *
 * Environment:
 * - `STATE_DIR`     runtime state directory (shared with the parent)
 * - `VAULT_PATH`    vault the state directory must stay out of
 * - `SOURCE_ID`     identity to lock
 * - `WITNESS_FILE`  exclusive-create witness proving sections never overlap
 * - `ATTEMPTED_FILE` written the first time the lock is found already held, so
 *                    the parent can prove contention happened rather than
 *                    assume it from a sleep
 * - `ACQUIRED_FILE` written once the lock is held
 * - `RELEASE_FILE`  polled until it exists; the child then leaves the section
 * - `ENTRIES_FILE`  one line appended per critical section entered
 * - `MODE`          `hold` (release normally), `hang` (never leave; the parent
 *                   kills it) or `throw` (fail inside the section)
 * - `HOLD_MS`       fallback hold time when no release barrier is given
 * - `TIMEOUT_MS`    how long to wait for a contended lock
 */

import fs from "node:fs";
import { PublicationJournal } from "../../../src/vault/PublicationJournal";

const say = (event: string, extra: Record<string, unknown> = {}): void => {
  process.stdout.write(
    `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...extra })}\n`,
  );
};

const mode = process.env.MODE ?? "hold";
const witnessFile = process.env.WITNESS_FILE ?? "";
const acquiredFile = process.env.ACQUIRED_FILE ?? "";
const releaseFile = process.env.RELEASE_FILE ?? "";
const entriesFile = process.env.ENTRIES_FILE ?? "";

const attemptedFile = process.env.ATTEMPTED_FILE ?? "";
let reportedContention = false;

const journal = new PublicationJournal({
  stateDir: process.env.STATE_DIR,
  vaultPath: process.env.VAULT_PATH,
  lock: {
    timeoutMs: Number(process.env.TIMEOUT_MS ?? 10_000),
    pollMs: 10,
    onBusy: (attempt) => {
      say("busy", { attempt });
      if (attemptedFile && !reportedContention) {
        reportedContention = true;
        fs.writeFileSync(attemptedFile, String(attempt));
      }
    },
  },
});

try {
  await journal.withLock(process.env.SOURCE_ID ?? "child", async () => {
    if (witnessFile) {
      try {
        fs.writeFileSync(witnessFile, String(process.pid), { flag: "wx" });
      } catch {
        say("overlap", { witness: fs.readFileSync(witnessFile, "utf8") });
        throw new Error("critical sections overlapped");
      }
    }

    say("acquired");
    if (entriesFile) fs.appendFileSync(entriesFile, `${process.pid}\n`);
    if (acquiredFile) fs.writeFileSync(acquiredFile, String(process.pid));

    if (mode === "throw") {
      if (witnessFile) fs.rmSync(witnessFile, { force: true });
      throw new Error("the critical section failed");
    }

    if (mode === "hang") {
      // Held until the parent SIGKILLs us. A referenced timer, so the event
      // loop cannot drain and let the process exit on its own.
      await new Promise((resolve) => setTimeout(resolve, 600_000));
    }

    if (releaseFile) {
      while (!fs.existsSync(releaseFile)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } else {
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.HOLD_MS ?? 50)),
      );
    }

    say("releasing");
    if (witnessFile) fs.rmSync(witnessFile, { force: true });
  });
  say("released");
} catch (error) {
  say("failed", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
