/**
 * Child process that reclaims an abandoned lock, pausing at a barrier so the
 * parent can reclaim and re-acquire the same lock first.
 *
 * This is the interleaving a single-process test cannot reach: the child has
 * already decided the lock it can see is abandoned, and is about to act on that
 * decision, when the directory underneath it is replaced by a live holder.
 *
 * Environment:
 * - `STATE_DIR`   runtime state directory, shared with the parent
 * - `VAULT_PATH`  vault the state directory must stay out of
 * - `SOURCE_ID`   identity to lock
 * - `PAUSED_FILE` written once the child is paused at the barrier
 * - `GO_FILE`     polled until it exists; the child then continues
 * - `TIMEOUT_MS`  how long to wait for the lock
 * - `HOLD_MS`     how long to hold the lock once acquired
 */

import fs from "node:fs";
import { PublicationJournal } from "../../../src/vault/PublicationJournal";

const say = (event: string, extra: Record<string, unknown> = {}): void => {
  process.stdout.write(
    `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...extra })}\n`,
  );
};

const pausedFile = process.env.PAUSED_FILE ?? "";
const goFile = process.env.GO_FILE ?? "";

/** A journal that stops at the reclaim barrier exactly once. */
class BarrierJournal extends PublicationJournal {
  private paused = false;

  protected override async beforeReclaim(sourceId: string): Promise<void> {
    if (this.paused) return;
    this.paused = true;

    say("paused", { sourceId });
    fs.writeFileSync(pausedFile, "paused");
    while (!fs.existsSync(goFile)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    say("resumed");
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
    say("acquired");
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD_MS ?? 30)));
    say("releasing");
  });
  say("released");
} catch (error) {
  say("failed", { message: error instanceof Error ? error.message : String(error) });
}
