/**
 * Connects upstream crawling to vault publication.
 *
 * This bypasses `PipelineWorker`'s clear-before-capture and swallow-storage-
 * error behavior without forking its implementation: it drives
 * `ScraperService` directly with its own progress callback, awaiting
 * `Publisher.publish` for every page that carries content, and turns the
 * scraper's per-page outcomes into a truthful, partial-success-aware report.
 *
 * Indexing is derived from what was published, never from what was crawled:
 * the indexer is handed the note's saved path, bytes and digest *after* the
 * publisher returns, and it re-reads the vault itself. Its outcome is recorded
 * per page and never moves the exit code — a note that is safely in the vault
 * but not yet retrievable is a diagnostic, not a failed capture.
 */

import { CancellationError } from "../pipeline/errors";
import type { ScraperService } from "../scraper/ScraperService";
import type { ScraperOptions, ScraperProgressEvent } from "../scraper/types";
import type { Publication, Publisher, SourceDocument } from "./types";
import { IndexContentError, type IndexEntry } from "./VaultIndex";

/** Tag distinguishing which terminal event produced one page outcome. */
type TerminalCategory = "not-modified" | "not-found" | "fetch-failed" | "result";

/**
 * How far one published page got into the derived index.
 *
 * `pending` is the recoverable state: the note and its MOC link are intact and
 * the next `reindex` picks it up. `failed` is reserved for a note the index
 * refused on its own content — retrying it unchanged cannot help.
 */
export type CaptureIndexStatus = "not-attempted" | "indexed" | "pending" | "failed";

/** The index, as a capture is allowed to see it. */
export interface CaptureIndexer {
  /**
   * Indexes one saved note.
   *
   * @param entry The note as publication left it; the implementation re-reads
   *   the canonical bytes from the vault before it indexes anything.
   * @throws IndexContentError when the saved note yields nothing retrievable.
   */
  index(entry: IndexEntry): Promise<void>;
}

/** One page's outcome, keyed by final URL, crawl depth, and terminal status. */
export type CapturePageOutcome = {
  /** Final canonical URL of the page, as reported by the scraper. */
  sourceUrl: string;
  /** Crawl depth the page was discovered at. */
  depth: number;
  /** How far this page got into the derived index. */
  index: CaptureIndexStatus;
  /** Present when the page was published, unchanged, replaced, or conflicted. */
  publication?: Publication;
  /**
   * Present when publishing this page threw, or when a tagged `fetch-failed`
   * scraper event carried a sanitized error message.
   */
  error?: string;
  /**
   * Present when the scraper reported a tagged terminal event — 304, 404, or
   * a per-page acquisition/conversion exception — for which no publish was
   * attempted because there was no content to publish.
   */
  skipped?: "not-modified" | "not-found" | "fetch-failed";
};

/** Exit codes matching the product contract in the migration plan. */
export type CaptureExitCode = 0 | 1 | 2 | 130;

/**
 * Final counts derived from the keyed outcomes, one bucket per terminal
 * status plus the total page count. Every outcome falls into exactly one
 * bucket besides `total`: a publication's `status` (published / unchanged /
 * replaced / conflict), a skip tag (not-modified / not-found / fetch-failed),
 * or a plain publish error that carried no skip tag.
 */
export interface CaptureCounts {
  total: number;
  published: number;
  unchanged: number;
  replaced: number;
  conflict: number;
  notModified: number;
  notFound: number;
  fetchFailed: number;
  error: number;
}

/** The full result of one capture run. */
export interface CaptureResult {
  /**
   * One outcome per distinct (URL, depth, terminal status) page. Repeated
   * events for the same page and terminal status update that same entry;
   * distinct terminal statuses for the same page (which should not normally
   * both occur for one queue item) are kept as separate entries rather than
   * silently overwriting one another.
   */
  outcomes: CapturePageOutcome[];
  /** Final counts by terminal status, derived from `outcomes`. */
  counts: CaptureCounts;
  /** True when the run ended via cancellation (signal abort). */
  cancelled: boolean;
  /**
   * Set when the scraper itself failed outside any single page's tagged
   * event — a separate summary field, never a synthesized page outcome, so a
   * terminal exception that was already tagged per-page is never double
   * counted. Named `run_error` (not `runError`) to match the documented wire
   * contract for the CLI's JSON envelope.
   */
  run_error?: string;
  exitCode: CaptureExitCode;
}

/** Input to {@link capture}. */
export interface CaptureInput {
  options: ScraperOptions;
  /** URL or path the operator originally asked for, kept as provenance. */
  requestedUrl: string;
  signal?: AbortSignal;
}

/** Dependencies {@link capture} needs from the outside world. */
export interface CaptureDependencies {
  scraperService: ScraperService;
  publisher: Publisher;
  /** Omitted when indexing is not wanted; every outcome stays `not-attempted`. */
  indexer?: CaptureIndexer;
}

/** One published page and what the index then made of it. */
interface PublishedPage {
  publication: Publication;
  index: CaptureIndexStatus;
}

/**
 * Indexes one published note, converting every failure into a recorded status.
 *
 * Indexing runs after publication and can never undo it, so nothing here is
 * allowed to propagate: the note is already in the vault and the exit code is
 * already decided by what happened to it there.
 *
 * @returns `indexed`, `failed` for content the index refused, `pending` for
 *   everything else — a busy index lock, an unavailable store, an I/O error.
 */
async function indexPublication(
  indexer: CaptureIndexer,
  entry: IndexEntry,
): Promise<CaptureIndexStatus> {
  try {
    await indexer.index(entry);
    return "indexed";
  } catch (error) {
    return error instanceof IndexContentError ? "failed" : "pending";
  }
}

/** A page outcome carries useful vault output when it holds a publication. */
function isUseful(outcome: CapturePageOutcome): boolean {
  return outcome.publication !== undefined;
}

/**
 * A page outcome is fully clean when it published/replaced/left the note
 * unchanged and is linked from its collection index. A `conflict`
 * publication or a pending MOC link is useful but incomplete (see
 * {@link deriveExitCode}).
 */
function isFullyClean(outcome: CapturePageOutcome): boolean {
  return (
    outcome.publication !== undefined &&
    outcome.publication.status !== "conflict" &&
    outcome.publication.moc === "linked"
  );
}

/**
 * Tallies final counts by terminal status from the keyed outcomes. Each
 * outcome is classified by exactly one of: its publication's status, its
 * skip tag, or (if neither is present) a plain publish error.
 *
 * @param outcomes The capture run's keyed page outcomes.
 * @returns Per-status counts plus the total number of outcomes.
 */
function deriveCounts(outcomes: CapturePageOutcome[]): CaptureCounts {
  const counts: CaptureCounts = {
    total: outcomes.length,
    published: 0,
    unchanged: 0,
    replaced: 0,
    conflict: 0,
    notModified: 0,
    notFound: 0,
    fetchFailed: 0,
    error: 0,
  };

  for (const outcome of outcomes) {
    if (outcome.publication !== undefined) {
      switch (outcome.publication.status) {
        case "published":
          counts.published++;
          break;
        case "unchanged":
          counts.unchanged++;
          break;
        case "replaced":
          counts.replaced++;
          break;
        case "conflict":
          counts.conflict++;
          break;
      }
    } else if (outcome.skipped !== undefined) {
      switch (outcome.skipped) {
        case "not-modified":
          counts.notModified++;
          break;
        case "not-found":
          counts.notFound++;
          break;
        case "fetch-failed":
          counts.fetchFailed++;
          break;
      }
    } else if (outcome.error !== undefined) {
      counts.error++;
    }
  }

  return counts;
}

/**
 * Derives the process exit code from accumulated page outcomes.
 *
 * Exit 0 requires every page to be fully clean and no separate run error.
 * Exit 2 covers useful-but-incomplete output: a conflict candidate (counted
 * as useful preserved output per the product contract), a pending MOC link,
 * or any failure alongside at least one useful page. Exit 1 means nothing
 * useful came out of the run at all. Cancellation always wins as 130,
 * including when earlier pages published successfully.
 *
 * Exported for direct table-driven testing of the publication-state matrix
 * (published/unchanged/replaced/conflict × linked/pending MOC).
 */
export function deriveExitCode(
  outcomes: CapturePageOutcome[],
  cancelled: boolean,
  runError: string | undefined,
): CaptureExitCode {
  if (cancelled) return 130;

  const useful = outcomes.filter(isUseful);
  if (useful.length === 0) return 1;

  const allClean = outcomes.length > 0 && outcomes.every(isFullyClean);
  if (allClean && runError === undefined) return 0;

  return 2;
}

/**
 * Builds the dedup key for one page outcome: final URL, depth, and terminal
 * status. Including status means distinct terminal events for the same page
 * (e.g. a tagged 404 and, separately, a publication result) never overwrite
 * each other; repeated events sharing all three still update one entry.
 */
function pageKey(url: string, depth: number, category: TerminalCategory): string {
  return `${depth}::${category}::${url}`;
}

/**
 * Runs one capture: crawls from `options.url` using `scraperService`, and
 * awaits `publisher.publish` for every page that carries content, directly
 * inside the scraper's progress callback.
 *
 * @param input Scraper options, the operator-facing requested URL kept as
 *   provenance, and an optional cancellation signal.
 * @param deps The scraper service and publisher to drive.
 * @returns Per-page outcomes, cancellation/run-error status, and the derived
 *   exit code.
 */
export async function capture(
  input: CaptureInput,
  deps: CaptureDependencies,
): Promise<CaptureResult> {
  const { options, requestedUrl, signal } = input;
  const { scraperService, publisher, indexer } = deps;

  const pages = new Map<string, CapturePageOutcome>();

  // Run-scoped publication cache, keyed by final URL only (not depth), and
  // never evicted: the same canonical URL discovered concurrently,
  // sequentially, or at a different depth later in the same crawl shares one
  // publish call and its settled result, rather than publishing again. The
  // index call is inside that same cached promise, so one URL is indexed once
  // however often the crawl reports it.
  const publicationsByUrl = new Map<string, Promise<PublishedPage>>();

  const recordSkip = (
    progress: ScraperProgressEvent,
    outcomeTag: "not-modified" | "not-found" | "fetch-failed",
  ): void => {
    const key = pageKey(progress.currentUrl, progress.depth, outcomeTag);

    // A 304 only counts as "unchanged" when this same run already verified
    // the source by publishing it; an unverified 304 is recorded as a
    // skipped outcome rather than assumed successful, since this task's
    // capture is always a fresh, non-refresh crawl with nothing else to
    // compare it against.
    if (outcomeTag === "not-modified") {
      const publishedKey = pageKey(progress.currentUrl, progress.depth, "result");
      if (pages.get(publishedKey)?.publication !== undefined) {
        return;
      }
    }

    pages.set(key, {
      sourceUrl: progress.currentUrl,
      depth: progress.depth,
      index: "not-attempted",
      skipped: outcomeTag,
      // Carries the acquisition/conversion failure detail forward: an
      // ignored child failure (`ignoreErrors: true`) never throws, so this
      // tagged event is the only place that detail is ever recorded.
      ...(progress.errorMessage === undefined ? {} : { error: progress.errorMessage }),
    });
  };

  const progressCallback = async (progress: ScraperProgressEvent): Promise<void> => {
    if (progress.outcome !== undefined) {
      recordSkip(progress, progress.outcome);
      return;
    }

    // Untagged progress without content is only progress (e.g. directory
    // discovery) — never inferred as a page outcome on its own.
    if (!progress.result) {
      return;
    }

    const result = progress.result;
    const url = result.url;
    const key = pageKey(url, progress.depth, "result");

    try {
      let publishPromise = publicationsByUrl.get(url);
      if (!publishPromise) {
        // Wrapped in an async IIFE so a *synchronous* throw from
        // `publisher.publish` — before it ever returns a promise — becomes a
        // rejected promise instead of escaping this function outright. The
        // assignment into the cache below always happens, even for a
        // synchronous throw, so a later occurrence of the same URL reuses
        // the settled (rejected) result rather than retrying.
        publishPromise = (async (): Promise<PublishedPage> => {
          const document: SourceDocument = {
            sourceUrl: url,
            requestedUrl,
            collection: options.library,
            version: options.version ?? "",
            title: result.title,
            markdown: result.textContent,
            sourceContentType: result.sourceContentType,
            capturedAt: new Date().toISOString(),
          };
          const publication = await publisher.publish(document);

          // Publication first, always. The index is derived from the note that
          // now exists, and is handed its path, its saved bytes and the digest
          // those bytes hash to — never the crawler's own output.
          if (indexer === undefined) {
            return { publication, index: "not-attempted" };
          }
          const index = await indexPublication(indexer, {
            path: publication.path,
            markdown: publication.markdown,
            digest: publication.digest,
            sourceUrl: url,
            collection: options.library,
            version: options.version ?? "",
          });
          return { publication, index };
        })();
        publicationsByUrl.set(url, publishPromise);
      }

      const page = await publishPromise;
      pages.set(key, {
        sourceUrl: url,
        depth: progress.depth,
        index: page.index,
        publication: page.publication,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new CancellationError("Capture cancelled");
      }
      pages.set(key, {
        sourceUrl: url,
        depth: progress.depth,
        index: "not-attempted",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  let cancelled = false;
  let runError: string | undefined;

  try {
    await scraperService.scrape(options, progressCallback, signal);
  } catch (error) {
    if (error instanceof CancellationError || signal?.aborted) {
      cancelled = true;
    } else {
      // A separate summary field, never a synthesized page outcome: this
      // terminal exception may be the exact same error already tagged and
      // recorded per-page above (e.g. a fatal root failure), and we must
      // never manufacture a second page entry or extract a URL from error
      // prose to do so.
      runError = error instanceof Error ? error.message : String(error);
    }
  }

  const outcomes = [...pages.values()];
  return {
    outcomes,
    counts: deriveCounts(outcomes),
    cancelled,
    ...(runError === undefined ? {} : { run_error: runError }),
    exitCode: deriveExitCode(outcomes, cancelled, runError),
  };
}
