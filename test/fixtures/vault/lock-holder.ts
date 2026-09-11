/**
 * Child process that takes a real per-source lock, for the multiprocess lock
 * fixtures. Run through `vite-node` so it exercises the same source the
 * publisher does, in a genuinely separate process.
 *
 * Environment:
 * - `STATE_DIR`   runtime state directory (shared with the parent)
 * - `VAULT_PATH`  vault the state directory must stay out of
 * - `SOURCE_ID`   identity to lock
 * - `MODE`        `hold` (acquire, report, release) or `hang` (acquire, report,
 *                 never release — the parent kills it)
 * - `HOLD_MS`     how long `hold` keeps the lock
 * - `TIMEOUT_MS`  how long to wait for a contended lock
 *
 * Every observable step is one JSON line on stdout, so the parent can assert
 * ordering and overlap rather than timing.
 */

import { PublicationJournal } from "../../../src/vault/PublicationJournal";

const say = (event: string, extra: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...extra })}\n`);
};

const journal = new PublicationJournal({
  stateDir: process.env.STATE_DIR,
  vaultPath: process.env.VAULT_PATH,
  lock: {
    timeoutMs: Number(process.env.TIMEOUT_MS ?? 10_000),
    pollMs: 10,
    staleAfterMs: Number(process.env.STALE_AFTER_MS ?? 60_000),
  },
});

const sourceId = process.env.SOURCE_ID ?? "child";
const mode = process.env.MODE ?? "hold";

try {
  await journal.withLock(sourceId, async () => {
    say("acquired");
    if (mode === "hang") {
      // Hold until the parent SIGKILLs us. This has to be a real, referenced
      // timer: a promise that simply never resolves lets the event loop drain,
      // and the process would exit on its own — a dead holder, not a live one.
      await new Promise((resolve) => setTimeout(resolve, 600_000));
    }
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD_MS ?? 50)));
    say("releasing");
  });
  say("released");
} catch (error) {
  say("failed", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
