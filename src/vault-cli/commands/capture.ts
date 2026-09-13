/**
 * `sb-docs capture <input>` — captures a URL, local Markdown file, local
 * document, or a bounded multi-page crawl into the vault through the same
 * {@link VaultCaptureService} adapter, regardless of source class.
 *
 * A plain local path becomes a `file://` URL via `pathToFileURL`; anything
 * that already parses as a URL keeps its upstream-supported identity as-is.
 * Crawl bounds default to one page at depth zero — a bounded or unbounded
 * crawl requires explicit `--max-pages`/`--max-depth`.
 *
 * Exit codes follow the product contract: 0 every requested document is
 * published/unchanged and linked, 2 useful-but-incomplete output, 1 nothing
 * useful, 130 cancelled. Indexing runs after publication and never moves that
 * code: a note that is safely in the vault but not yet retrievable reports
 * `index: "pending"` and the next `reindex` picks it up.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandModule } from "yargs";
import { ScraperRegistry } from "../../scraper/ScraperRegistry";
import { ScraperService } from "../../scraper/ScraperService";
import { ScrapeMode, type ScraperOptions } from "../../scraper/types";
import type { AppConfig } from "../../utils/config";
import { loadConfig } from "../../utils/config";
import { INBOX_COLLECTION, normalizeCollection } from "../../vault/identity";
import { createObsidianCliRunner, ObsidianCli } from "../../vault/ObsidianCli";
import type { Publisher } from "../../vault/types";
import {
  type CaptureIndexer,
  type CaptureResult,
  capture,
} from "../../vault/VaultCaptureService";
import { VaultIndex } from "../../vault/VaultIndex";
import { VaultPublisher } from "../../vault/VaultPublisher";

/** Everything the command needs from the outside world. */
export interface CaptureDeps {
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
  /** Scraper service to drive; defaults to a real one built from `appConfig`. */
  scraperService?: ScraperService;
  /** Publisher to drive; defaults to a real `VaultPublisher`. */
  publisher?: Publisher;
  /**
   * Index to feed; defaults to a real {@link VaultIndex} sharing the
   * publisher's state directory. Pass `null` to publish without indexing.
   */
  indexer?: CaptureIndexer | null;
}

/**
 * Normalizes a capture input to the URL identity the scraper crawls.
 *
 * A string that already parses as a URL (any scheme, including `file:`)
 * keeps its upstream-supported identity untouched. Anything else is treated
 * as a local filesystem path and converted with `pathToFileURL(resolve(...))`
 * so relative paths, spaces and Unicode round-trip correctly.
 */
export function normalizeCaptureInput(input: string): string {
  try {
    return new URL(input).href;
  } catch {
    return pathToFileURL(resolve(input)).href;
  }
}

/** Builds the `capture` command. */
export function createCaptureCommand(deps: CaptureDeps = {}): CommandModule {
  return {
    command: "capture <input>",
    describe: "Capture a URL, local file, or bounded crawl into the vault",
    builder: (argv) =>
      argv
        .positional("input", {
          type: "string",
          demandOption: true,
          describe: "URL or local path to capture",
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
        .option("max-pages", {
          type: "number",
          requiresArg: true,
          describe: "Maximum pages to crawl; must be positive (default: 1)",
        })
        .option("max-depth", {
          type: "number",
          requiresArg: true,
          describe: "Maximum crawl depth; must be nonnegative (default: 0)",
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
        .option("no-index", {
          type: "boolean",
          default: false,
          describe: "Publish into the vault without touching the search index",
        })
        .strict(),

    handler: async (args) => {
      const stdout = deps.stdout ?? ((line: string) => console.log(line));
      const stderr = deps.stderr ?? ((line: string) => console.error(line));

      const maxPages = typeof args["max-pages"] === "number" ? args["max-pages"] : 1;
      const maxDepth = typeof args["max-depth"] === "number" ? args["max-depth"] : 0;
      if (!(maxPages > 0)) {
        throw new Error(`--max-pages must be positive, got ${maxPages}`);
      }
      if (!(maxDepth >= 0)) {
        throw new Error(`--max-depth must be nonnegative, got ${maxDepth}`);
      }

      const requestedUrl = normalizeCaptureInput(String(args.input));
      const library = normalizeCollection(
        typeof args.collection === "string" && args.collection.trim().length > 0
          ? args.collection
          : INBOX_COLLECTION,
      );
      const version = typeof args.version === "string" ? args.version : "";

      // After upstream config load, force these two fields off: this fork
      // starts with FTS and no embedding credential, and never phones home,
      // regardless of ambient credentials or telemetry env defaults.
      const appConfig = deps.appConfig ?? loadConfig();
      appConfig.app.embeddingModel = "";
      appConfig.app.telemetryEnabled = false;

      const scraperService =
        deps.scraperService ?? new ScraperService(new ScraperRegistry(appConfig));

      const vaultPath = deps.vaultPath ?? process.env.OBSIDIAN_VAULT ?? null;
      const cli =
        deps.cli ??
        new ObsidianCli(createObsidianCliRunner(vaultPath === null ? {} : { vaultPath }));
      const stateDir =
        deps.stateDir ??
        (typeof args["state-dir"] === "string" ? args["state-dir"] : undefined);
      const publisher =
        deps.publisher ??
        new VaultPublisher(cli, { stateDir, vaultPath: vaultPath ?? undefined });

      // Built once per run and shared by every page, so one crawl takes the
      // index lock per note rather than reopening the store from scratch.
      const ownedIndex =
        deps.indexer === undefined && args["no-index"] !== true
          ? new VaultIndex(cli, {
              stateDir,
              vaultPath: vaultPath ?? undefined,
              appConfig,
            })
          : null;
      const indexer: CaptureIndexer | null =
        deps.indexer === undefined
          ? ownedIndex === null
            ? null
            : { index: async (entry) => void (await ownedIndex.upsert(entry)) }
          : deps.indexer;

      const options: ScraperOptions = {
        url: requestedUrl,
        library,
        version,
        maxPages,
        maxDepth,
        scrapeMode: ScrapeMode.Auto,
      };

      // Command-scoped cancellation: a SIGINT during this capture aborts it
      // (exit 130, preserving prior outcomes) without touching `main.ts` —
      // Node lets any number of listeners share one signal, so this handler
      // coexists with the process's default SIGINT behavior and is removed
      // as soon as this command finishes, successfully or not.
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.on("SIGINT", onSigint);

      let result: CaptureResult;
      try {
        result = await capture(
          { options, requestedUrl, signal: controller.signal },
          {
            scraperService,
            publisher,
            ...(indexer === null ? {} : { indexer }),
          },
        );
      } finally {
        process.off("SIGINT", onSigint);
        await ownedIndex?.shutdown();
      }

      report(result, { stdout, stderr, json: args.json === true });

      // Set the exit code directly rather than throwing, so the process can
      // report the full 0/1/2/130 exit matrix — a thrown error would always
      // collapse to exit 1 via the executable's top-level catch.
      process.exitCode = result.exitCode;
    },
  };
}

/** Renders the capture result as the documented JSON envelope or plain text. */
function report(
  result: CaptureResult,
  sinks: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    json: boolean;
  },
): void {
  if (sinks.json) {
    sinks.stdout(JSON.stringify(result));
    return;
  }

  for (const outcome of result.outcomes) {
    if (outcome.publication !== undefined) {
      sinks.stdout(
        `${outcome.publication.status} ${outcome.sourceUrl} -> ${outcome.publication.path} (moc: ${outcome.publication.moc}, index: ${outcome.index})`,
      );
    } else if (outcome.skipped !== undefined) {
      sinks.stdout(`${outcome.skipped} ${outcome.sourceUrl}`);
      // A "fetch-failed" skip can carry a sanitized acquisition/conversion
      // error message (see ScraperProgressEvent.errorMessage) — surface it
      // too, since it is otherwise unreachable: this branch, not the
      // `outcome.error` branch below, is the one that fires for a skipped
      // outcome.
      if (outcome.error !== undefined) {
        sinks.stderr(`❌ ${outcome.sourceUrl}: ${outcome.error}`);
      }
    } else if (outcome.error !== undefined) {
      sinks.stderr(`❌ ${outcome.sourceUrl}: ${outcome.error}`);
    }
  }

  if (result.run_error !== undefined) {
    sinks.stderr(`❌ run error: ${result.run_error}`);
  }
  if (result.cancelled) {
    sinks.stderr("cancelled");
  }
}
