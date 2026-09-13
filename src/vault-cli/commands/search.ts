/**
 * `sb-docs search <query>` — retrieves saved vault documents from the derived
 * index.
 *
 * Retrieval is FTS over the notes as the vault holds them; no original source
 * is ever fetched and no embedding credential is used. Every hit is verified
 * against a fresh vault read before it is printed, so a note edited since it
 * was indexed is refreshed and re-searched rather than shown as current.
 *
 * Exit codes follow the product contract: 0 when the retrieval ran — including
 * when it found nothing or had to omit a stale hit — and 1 when the operation
 * itself could not run, which is what a held index lock produces.
 */

import type { CommandModule } from "yargs";
import type { AppConfig } from "../../utils/config";
import { loadConfig } from "../../utils/config";
import { INBOX_COLLECTION, normalizeCollection } from "../../vault/identity";
import { type LockOptions, LockTimeoutError } from "../../vault/lock";
import { createObsidianCliRunner, ObsidianCli } from "../../vault/ObsidianCli";
import { type IndexSearchResponse, VaultIndex } from "../../vault/VaultIndex";

/** Everything the command needs from the outside world. */
export interface SearchDeps {
  /** Runtime state directory; defaults to the platform location. */
  stateDir?: string;
  /** Vault the CLI operates on; defaults to `OBSIDIAN_VAULT`. */
  vaultPath?: string;
  /** Vault CLI wrapper; defaults to a real `obsidian-cli` subprocess. */
  cli?: ObsidianCli;
  /** Result sink; defaults to stdout. */
  stdout?: (line: string) => void;
  /** Diagnostics sink; defaults to stderr. */
  stderr?: (line: string) => void;
  /** Loaded upstream configuration; defaults to a real `loadConfig()`. */
  appConfig?: AppConfig;
  /** How long to wait for the index lock; defaults to the shared bound. */
  lock?: LockOptions;
  /** Index to query; defaults to one built from the arguments. */
  index?: VaultIndex;
}

/** The envelope a `--json` run prints, including the unavailable case. */
export interface SearchEnvelope {
  status: IndexSearchResponse["status"] | "unavailable";
  results: IndexSearchResponse["results"];
  omitted: IndexSearchResponse["omitted"];
  refreshed: number;
  /** Present only when the retrieval could not run at all. */
  error?: string;
}

/** Renders one envelope as the lines a human reads. */
function formatEnvelope(envelope: SearchEnvelope): string[] {
  const lines: string[] = [];
  for (const result of envelope.results) {
    lines.push(
      `${result.vault_path}${result.version === "" ? "" : ` @${result.version}`} — ${result.source_url}`,
    );
    lines.push(`  sha256:${result.digest}`);
    lines.push(`  ${result.excerpt.replace(/\s+/g, " ").trim()}`);
  }
  if (envelope.results.length === 0) lines.push("no results");
  return lines;
}

/** Builds the `search` command. */
export function createSearchCommand(deps: SearchDeps = {}): CommandModule {
  return {
    command: "search <query>",
    describe: "Search the saved vault documents this tool has captured",
    builder: (argv) =>
      argv
        .positional("query", {
          type: "string",
          demandOption: true,
          describe: "Text to search the saved notes for",
        })
        .option("collection", {
          type: "string",
          requiresArg: true,
          describe: 'Collection identifier; defaults to "inbox"',
        })
        .option("version", {
          type: "string",
          requiresArg: true,
          describe: "Version label; empty when the source is unversioned",
        })
        .option("limit", {
          type: "number",
          requiresArg: true,
          describe: "Maximum results to return (default: 10)",
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

      const limit = typeof args.limit === "number" ? args.limit : 10;
      if (!(limit > 0)) throw new Error(`--limit must be positive, got ${limit}`);

      const collection = normalizeCollection(
        typeof args.collection === "string" && args.collection.trim().length > 0
          ? args.collection
          : INBOX_COLLECTION,
      );
      const version = typeof args.version === "string" ? args.version : "";

      // Same forcing as capture: FTS only, no telemetry, whatever the ambient
      // environment offers.
      const appConfig = deps.appConfig ?? loadConfig();
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

      let envelope: SearchEnvelope;
      try {
        const response = await index.search({
          query: String(args.query),
          collection,
          version,
          limit,
        });
        envelope = { ...response };
      } catch (error) {
        if (!(error instanceof LockTimeoutError)) throw error;
        // The index is busy, not broken: the prior generation is untouched and
        // the operator can simply try again.
        envelope = {
          status: "unavailable",
          results: [],
          omitted: [],
          refreshed: 0,
          error: error.message,
        };
      } finally {
        if (deps.index === undefined) await index.shutdown();
      }

      if (args.json === true) stdout(JSON.stringify(envelope));
      else for (const line of formatEnvelope(envelope)) stdout(line);

      if (envelope.status === "unavailable") {
        stderr(`❌ search unavailable: ${envelope.error ?? "index busy"}`);
        process.exitCode = 1;
        return;
      }

      for (const omission of envelope.omitted) {
        stderr(
          `⚠️  omitted ${omission.reason}: ${omission.vault_path || omission.source_url}`,
        );
      }
    },
  };
}
