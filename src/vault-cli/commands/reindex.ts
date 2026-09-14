/**
 * `sb-docs reindex` — rebuilds the derived index from the notes the vault
 * currently holds.
 *
 * It reads saved Markdown and never fetches an original URL, so a rebuild is
 * always safe to run: the worst it can do is cost a scan. The new generation is
 * built beside the old one and promoted only after it verifies, so a failed
 * rebuild leaves the previous index serving searches.
 *
 * Exit codes follow the product contract: 0 when the rebuild ran, 1 when the
 * index operation itself could not — a held lock, or a generation that refused
 * verification.
 */

import type { CommandModule } from "yargs";
import type { AppConfig } from "../../utils/config";
import { loadConfig } from "../../utils/config";
import { INBOX_COLLECTION, normalizeCollection } from "../../vault/identity";
import { type LockOptions, LockTimeoutError } from "../../vault/lock";
import { createObsidianCliRunner, ObsidianCli } from "../../vault/ObsidianCli";
import { type IndexRebuildReport, VaultIndex } from "../../vault/VaultIndex";

/** Everything the command needs from the outside world. */
export interface ReindexDeps {
  /** Runtime state directory; defaults to the platform location. */
  stateDir?: string;
  /** Vault the CLI operates on; defaults to `OBSIDIAN_VAULT`. */
  vaultPath?: string;
  /** Vault CLI wrapper; defaults to a real `obsidian-cli` subprocess. */
  cli?: ObsidianCli;
  /** Report sink; defaults to stdout. */
  stdout?: (line: string) => void;
  /** Diagnostics sink; defaults to stderr. */
  stderr?: (line: string) => void;
  /** Loaded upstream configuration; defaults to a real `loadConfig()`. */
  appConfig?: AppConfig;
  /** How long to wait for the index lock; defaults to the shared bound. */
  lock?: LockOptions;
  /** Index to rebuild; defaults to one built from the arguments. */
  index?: VaultIndex;
}

/** The envelope a `--json` run prints. */
export interface ReindexEnvelope {
  status: "rebuilt" | "unavailable" | "failed";
  /** Present when the rebuild completed. */
  report?: IndexRebuildReport;
  /** Present when it did not. */
  error?: string;
}

/** Renders one rebuild report as the lines a human reads. */
function formatReport(report: IndexRebuildReport): string[] {
  return [
    `rebuilt ${report.collection} into ${report.generation}`,
    `  notes: ${report.notesIndexed} indexed, ${report.notesSkipped} skipped, ${report.notesDiscovered} discovered`,
    `  chunks: ${report.chunks}`,
    `  vault cost: ${report.directoryScans} list, ${report.noteReads} read, ${report.elapsedMs} ms`,
    `  embeddings: ${report.embeddingsActive ? "active" : "disabled"}`,
  ];
}

/** Builds the `reindex` command. */
export function createReindexCommand(deps: ReindexDeps = {}): CommandModule {
  return {
    command: "reindex",
    describe: "Rebuild the search index from the notes saved in the vault",
    builder: (argv) =>
      argv
        .option("collection", {
          type: "string",
          requiresArg: true,
          describe: 'Collection identifier; defaults to "inbox"',
        })
        .option("inventory", {
          type: "array",
          string: true,
          describe: "Vault-relative notes this tool did not publish, imported read-only",
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "Print one JSON result envelope on stdout",
        })
        .option("state-dir", {
          type: "string",
          requiresArg: true,
          describe: "Runtime state directory; defaults to the platform location",
        })
        .strict(),

    handler: async (args) => {
      const stdout = deps.stdout ?? ((line: string) => console.log(line));
      const stderr = deps.stderr ?? ((line: string) => console.error(line));

      const collection = normalizeCollection(
        typeof args.collection === "string" && args.collection.trim().length > 0
          ? args.collection
          : INBOX_COLLECTION,
      );
      const inventory = Array.isArray(args.inventory)
        ? args.inventory.map((entry) => String(entry))
        : [];

      // Task 6 row D03: vault commands never write the default system config.
      const appConfig = deps.appConfig ?? loadConfig({}, { readOnly: true });
      appConfig.app.embeddingModel = "";
      appConfig.app.telemetryEnabled = false;

      const vaultPath = deps.vaultPath ?? process.env.OBSIDIAN_VAULT ?? null;
      const cli =
        deps.cli ??
        new ObsidianCli(createObsidianCliRunner(vaultPath === null ? {} : { vaultPath }));
      const stateDir =
        deps.stateDir ??
        (typeof args["state-dir"] === "string" ? args["state-dir"] : undefined);

      const index =
        deps.index ??
        new VaultIndex(cli, {
          stateDir,
          vaultPath: vaultPath ?? undefined,
          appConfig,
          ...(deps.lock === undefined ? {} : { lock: deps.lock }),
        });

      let envelope: ReindexEnvelope;
      try {
        const report = await index.rebuild({
          collection,
          ...(inventory.length === 0 ? {} : { inventory }),
        });
        envelope = { status: "rebuilt", report };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        envelope = {
          // A busy lock and a refused generation are different diagnoses with
          // the same consequence: the previous generation is still the active
          // one, and nothing was promoted.
          status: error instanceof LockTimeoutError ? "unavailable" : "failed",
          error: message,
        };
      } finally {
        if (deps.index === undefined) await index.shutdown();
      }

      if (args.json === true) stdout(JSON.stringify(envelope));
      else if (envelope.report !== undefined) {
        for (const line of formatReport(envelope.report)) stdout(line);
      }

      if (envelope.status !== "rebuilt") {
        stderr(`❌ reindex ${envelope.status}: ${envelope.error ?? "unknown failure"}`);
        process.exitCode = 1;
      }
    },
  };
}
