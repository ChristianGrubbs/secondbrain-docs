/**
 * Child process that publishes one source into a throwaway vault and is killed
 * — by itself, with SIGKILL, so no handler can tidy up — at a chosen journal
 * boundary. This is how the recovery suite exercises real process death rather
 * than a thrown exception.
 *
 * Environment:
 * - `VAULT_PATH`     throwaway vault (never the operator's vault)
 * - `STATE_DIR`      runtime state directory, shared with the parent
 * - `CLI_PATH`       `obsidian-cli` executable
 * - `SOURCE_URL`     identity of the source to publish
 * - `TITLE`          note title
 * - `BODY_FILE`      file holding the converted Markdown body
 * - `CRASH_AT`       `prepared`, `note-written`, `moc-linked`,
 *                    `before-prune`, or `none`
 */

import fs from "node:fs";
import { createObsidianCliRunner, ObsidianCli } from "../../../src/vault/ObsidianCli";
import {
  type JournalPhase,
  PublicationJournal,
} from "../../../src/vault/PublicationJournal";
import { VaultPublisher } from "../../../src/vault/VaultPublisher";

const crashAt = process.env.CRASH_AT ?? "none";

/** Dies instantly and unrecoverably, the way a killed process does. */
const die = (): never => {
  process.kill(process.pid, "SIGKILL");
  // Unreachable; SIGKILL cannot be handled.
  throw new Error("unreachable");
};

/** A journal that stops the world at one boundary. */
class CrashingJournal extends PublicationJournal {
  override advance(sourceId: string, phase: JournalPhase) {
    const entry = super.advance(sourceId, phase);
    if (crashAt === phase) die();
    return entry;
  }

  override complete(sourceId: string): void {
    if (crashAt === "before-prune") {
      // Reach the `complete` phase on disk, then die before the prune.
      super.advance(sourceId, "complete");
      die();
    }
    super.complete(sourceId);
  }
}

const journal = new CrashingJournal({
  stateDir: process.env.STATE_DIR,
  vaultPath: process.env.VAULT_PATH,
  lock: { timeoutMs: 20_000, pollMs: 10 },
});

const cli = new ObsidianCli(
  createObsidianCliRunner({
    vaultPath: process.env.VAULT_PATH,
    cliPath: process.env.CLI_PATH,
  }),
);

const publisher = new VaultPublisher(cli, { journal, publisherVersion: "0.0.0-test" });

if (crashAt === "prepared") {
  // `prepared` is written by prepare(), not advance(), so it is armed here.
  const armed = journal.prepare.bind(journal);
  journal.prepare = ((input: Parameters<PublicationJournal["prepare"]>[0]) => {
    const entry = armed(input);
    die();
    return entry;
  }) as PublicationJournal["prepare"];
}

const publication = await publisher.publish({
  sourceUrl: process.env.SOURCE_URL ?? "https://example.invalid/doc",
  requestedUrl: process.env.SOURCE_URL ?? "https://example.invalid/doc",
  collection: "inbox",
  version: "",
  title: process.env.TITLE ?? "Child Published Note",
  markdown: fs.readFileSync(process.env.BODY_FILE ?? "", "utf8"),
  sourceContentType: "text/html",
  capturedAt: "2026-09-11T00:00:00.000Z",
});

process.stdout.write(`${JSON.stringify(publication)}\n`);
