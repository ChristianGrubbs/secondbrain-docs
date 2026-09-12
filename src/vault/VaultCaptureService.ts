/**
 * Connects upstream crawling to vault publication.
 *
 * This bypasses `PipelineWorker`'s clear-before-capture and swallow-storage-
 * error behavior without forking its implementation: it drives
 * `ScraperService` directly with its own progress callback, awaiting
 * `Publisher.publish` for every page that carries content, and turns the
 * scraper's per-page outcomes into a truthful, partial-success-aware report.
 *
 * Indexing is not this task's job — every outcome carries
 * `index: "not-attempted"`, and Task 5 adds indexing without changing these
 * exit semantics.
 */

import { CancellationError } from "../pipeline/errors";
import type { ScraperService } from "../scraper/ScraperService";
import type { ScraperOptions, ScraperProgressEvent } from "../scraper/types";
import type { Publication, Publisher, SourceDocument } from "./types";

/** Tag distinguishing which terminal event produced one page outcome. */
type TerminalCategory = "not-modified" | "not-found" | "fetch-failed" | "result";

/** One page's outcome, keyed by final URL, crawl depth, and terminal status. */
export type CapturePageOutcome = {
  /** Final canonical URL of the page, as reported by the scraper. */
  sourceUrl: string;
  /** Crawl depth the page was discovered at. */
  depth: number;
  /** Always `"not-attempted"` in this task; Task 5 adds real indexing. */
  index: "not-attempted";
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
 * Derives the process exit code from accumulated page outcomes.
 *
 * Exit 0 requires every page to be fully clean and no separate run error.
 * Exit 2 covers useful-but-incomplete output: a conflict candidate (counted
 * as useful preserved output per the product contract), a pending MOC link,
 * or any failure alongside at least one useful page. Exit 1 means nothing
 * useful came out of the run at all. Cancellation always wins as 130,
 * including when earlier pages published successfully.
 */
function deriveExitCode(
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
  const { scraperService, publisher } = deps;

  const pages = new Map<string, CapturePageOutcome>();

  // Run-scoped publication cache, keyed by final URL only (not depth), and
  // never evicted: the same canonical URL discovered concurrently,
  // sequentially, or at a different depth later in the same crawl shares one
  // publish call and its settled result, rather than publishing again.
  const publicationsByUrl = new Map<string, Promise<Publication>>();

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
        publishPromise = (async () => {
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
          return publisher.publish(document);
        })();
        publicationsByUrl.set(url, publishPromise);
      }

      const publication = await publishPromise;
      pages.set(key, {
        sourceUrl: url,
        depth: progress.depth,
        index: "not-attempted",
        publication,
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
    cancelled,
    ...(runError === undefined ? {} : { run_error: runError }),
    exitCode: deriveExitCode(outcomes, cancelled, runError),
  };
}
