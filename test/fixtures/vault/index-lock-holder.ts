/**
 * Child process that holds the one state-level index lock, for the
 * process-level index fixtures. Run through `vite-node` so it takes the same
 * lock the built CLI takes, from a genuinely separate process.
 *
 * Barriers are explicit files rather than sleeps, so the parent asserts on a
 * state rather than on a timing guess: the child announces that it holds the
 * lock, and waits to be told to let go.
 *
 * Environment:
 * - `STATE_DIR`     runtime state directory (shared with the parent)
 * - `VAULT_PATH`    vault the state directory must stay out of
 * - `ACQUIRED_FILE` written once the lock is held
 * - `RELEASE_FILE`  polled until it exists; the child then leaves the section
 */

import fs from "node:fs";
import { ObsidianCli } from "../../../src/vault/ObsidianCli";
import { VaultIndex } from "../../../src/vault/VaultIndex";

const acquiredFile = process.env.ACQUIRED_FILE ?? "";
const releaseFile = process.env.RELEASE_FILE ?? "";

// The lock is taken before anything reads a note, so this never needs a real
// vault CLI: every call would be a programming error, and says so.
const cli = new ObsidianCli(async (args) => ({
  code: 2,
  stdout: "",
  stderr: `index lock holder does not run obsidian-cli: ${args.join(" ")}`,
}));

const index = new VaultIndex(cli, {
  stateDir: process.env.STATE_DIR,
  vaultPath: process.env.VAULT_PATH,
});

try {
  await index.withIndexLock(async () => {
    process.stdout.write(`${JSON.stringify({ event: "acquired", pid: process.pid })}\n`);
    if (acquiredFile) fs.writeFileSync(acquiredFile, String(process.pid));

    while (releaseFile && !fs.existsSync(releaseFile)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  process.stdout.write(`${JSON.stringify({ event: "released", pid: process.pid })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      event: "failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  await index.shutdown();
}
