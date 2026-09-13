import { describe, expect, it, vi } from "vitest";
import { CancellationError } from "../pipeline/errors";
import { FetchStatus } from "../scraper/fetcher/types";
import { ScraperRegistry } from "../scraper/ScraperRegistry";
import { ScraperService } from "../scraper/ScraperService";
import type { ProcessItemResult } from "../scraper/strategies/BaseScraperStrategy";
import { BaseScraperStrategy } from "../scraper/strategies/BaseScraperStrategy";
import type { QueueItem, ScraperOptions, ScraperProgressEvent } from "../scraper/types";
import type { ProgressCallback } from "../types";
import { loadConfig } from "../utils/config";
import { LockTimeoutError } from "./lock";
import type { Publication, Publisher, SourceDocument } from "./types";
import {
  type CaptureDependencies,
  type CaptureIndexer,
  type CapturePageOutcome,
  capture,
  deriveExitCode,
} from "./VaultCaptureService";
import { IndexContentError } from "./VaultIndex";

/** Minimal fake `ScraperService` that emits caller-supplied progress events. */
class FakeScraperService {
  constructor(
    private readonly run: (
      progressCallback: ProgressCallback<ScraperProgressEvent>,
      signal?: AbortSignal,
    ) => Promise<void>,
  ) {}

  scrape(
    _options: ScraperOptions,
    progressCallback: ProgressCallback<ScraperProgressEvent>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.run(progressCallback, signal);
  }
}

/** Fake publisher that resolves/rejects per URL according to a script. */
class ScriptedPublisher implements Publisher {
  readonly calls: SourceDocument[] = [];

  constructor(private readonly script: (input: SourceDocument) => Promise<Publication>) {}

  async publish(input: SourceDocument): Promise<Publication> {
    this.calls.push(input);
    return this.script(input);
  }
}

function published(path = "00 Inbox/Source Captures/note abc123456789.md"): Publication {
  return {
    status: "published",
    path,
    markdown: "# note",
    digest: "digest",
    moc: "linked",
  };
}

function baseOptions(overrides: Partial<ScraperOptions> = {}): ScraperOptions {
  return {
    url: "https://example.com/",
    library: "inbox",
    version: "",
    maxPages: 5,
    maxDepth: 2,
    ...overrides,
  };
}

function contentEvent(
  overrides: Partial<ScraperProgressEvent> & { currentUrl: string },
): ScraperProgressEvent {
  return {
    pagesScraped: 1,
    totalPages: 1,
    totalDiscovered: 1,
    depth: 0,
    maxDepth: 2,
    result: {
      url: overrides.currentUrl,
      title: "Title",
      sourceContentType: "text/html",
      contentType: "text/markdown",
      textContent: "# Title\n\nBody content.",
      links: [],
      errors: [],
      chunks: [],
    },
    ...overrides,
  };
}

function skipEvent(
  overrides: Partial<ScraperProgressEvent> & {
    currentUrl: string;
    outcome: "not-modified" | "not-found" | "fetch-failed";
  },
): ScraperProgressEvent {
  return {
    pagesScraped: 0,
    totalPages: 1,
    totalDiscovered: 1,
    depth: 1,
    maxDepth: 2,
    result: null,
    ...overrides,
  };
}

describe("capture", () => {
  it("publishes both pages of a two-page fixture when the second publication fails, exit 2", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/", depth: 0 }),
      );
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/child", depth: 1 }),
      );
    });

    const publisher = new ScriptedPublisher(async (input) => {
      if (input.sourceUrl.endsWith("/child")) {
        throw new Error("vault write failed");
      }
      return published();
    });

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.cancelled).toBe(false);
    expect(result.outcomes).toHaveLength(2);
    const root = result.outcomes.find((o) => o.sourceUrl === "https://example.com/");
    const child = result.outcomes.find(
      (o) => o.sourceUrl === "https://example.com/child",
    );
    expect(root?.publication?.status).toBe("published");
    expect(root?.index).toBe("not-attempted");
    expect(child?.error).toBe("vault write failed");
    expect(child?.index).toBe("not-attempted");

    // Partial success: one published page, one plain publish error.
    expect(result.counts).toEqual({
      total: 2,
      published: 1,
      unchanged: 0,
      replaced: 0,
      conflict: 0,
      notModified: 0,
      notFound: 0,
      fetchFailed: 0,
      error: 1,
    });
  });

  it("returns exit 1 when every page fails to publish", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/", depth: 0 }),
      );
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/child", depth: 1 }),
      );
    });

    const publisher = new ScriptedPublisher(async () => {
      throw new Error("vault unreachable");
    });

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.outcomes.every((o) => o.error === "vault unreachable")).toBe(true);

    // All-failed: two plain publish errors, nothing useful.
    expect(result.counts).toEqual({
      total: 2,
      published: 0,
      unchanged: 0,
      replaced: 0,
      conflict: 0,
      notModified: 0,
      notFound: 0,
      fetchFailed: 0,
      error: 2,
    });
  });

  it("returns exit 1 when the crawl produces no page content at all", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      // Directory discovery: progress with no result and no outcome tag.
      await progressCallback({
        pagesScraped: 0,
        totalPages: 0,
        totalDiscovered: 0,
        currentUrl: "file:///tmp/docs",
        depth: 0,
        maxDepth: 2,
        result: null,
      });
    });
    const publisher = new ScriptedPublisher(async () => published());

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.outcomes).toHaveLength(0);
    expect(publisher.calls).toHaveLength(0);
  });

  it("records a publisher rejection for empty content without crashing", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        contentEvent({
          currentUrl: "https://example.com/empty",
          depth: 0,
          result: {
            url: "https://example.com/empty",
            title: "",
            sourceContentType: "text/html",
            contentType: "text/markdown",
            textContent: "",
            links: [],
            errors: [],
            chunks: [],
          },
        }),
      );
    });
    const publisher = new ScriptedPublisher(async (input) => {
      if (input.markdown.trim().length === 0) {
        throw new Error(`refusing to publish empty markdown for ${input.sourceUrl}`);
      }
      return published();
    });

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/empty" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.outcomes[0]?.error).toMatch(/refusing to publish empty markdown/);
  });

  it("deduplicates concurrent publish attempts for a duplicate final URL", async () => {
    let resolvePublish: ((value: Publication) => void) | undefined;
    let publishCount = 0;
    const publisher: Publisher = {
      publish: (_input: SourceDocument) => {
        publishCount += 1;
        return new Promise<Publication>((resolve) => {
          resolvePublish = resolve;
        });
      },
    };

    const scraperService = new FakeScraperService(async (progressCallback) => {
      // Two concurrent queue items resolve to the same canonical URL at the
      // same depth (e.g. a trailing-slash redirect duplicate).
      const first = progressCallback(
        contentEvent({ currentUrl: "https://example.com/dup", depth: 1 }),
      );
      const second = progressCallback(
        contentEvent({ currentUrl: "https://example.com/dup", depth: 1 }),
      );
      // Let both callbacks reach the publish call before resolving it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      resolvePublish?.(published());
      await Promise.all([first, second]);
    });

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/dup" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(publishCount).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.publication?.status).toBe("published");
  });

  it("deduplicates a sequential (non-concurrent) duplicate final URL", async () => {
    let publishCount = 0;
    const publisher: Publisher = {
      publish: async () => {
        publishCount += 1;
        return published();
      },
    };

    const scraperService = new FakeScraperService(async (progressCallback) => {
      // Fully sequential: the second occurrence starts only after the first
      // has completely resolved, so no in-flight promise is ever shared —
      // only a persistent cache keyed by URL catches this.
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/seq", depth: 1 }),
      );
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/seq", depth: 1 }),
      );
    });

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/seq" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(publishCount).toBe(1);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.publication?.status).toBe("published");
  });

  it("deduplicates the same final URL discovered again at a later depth", async () => {
    let publishCount = 0;
    const publisher: Publisher = {
      publish: async () => {
        publishCount += 1;
        return published();
      },
    };

    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/shared", depth: 1 }),
      );
      // Same canonical URL, discovered again one level deeper.
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/shared", depth: 2 }),
      );
    });

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/shared" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    // Only one real publish call, even though two page outcomes are recorded
    // (dedup keys on URL alone; page outcomes still key on URL+depth).
    expect(publishCount).toBe(1);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.publication?.status === "published")).toBe(
      true,
    );
  });

  it("catches a publisher that throws synchronously instead of rejecting a promise", async () => {
    const publisher: Publisher = {
      publish: (): Promise<Publication> => {
        // A synchronous throw, not `Promise.reject(...)` — this must never
        // escape into the caller's progress callback undetected.
        throw new Error("publisher blew up synchronously");
      },
    };

    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/sync-throw", depth: 0 }),
      );
    });

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/sync-throw" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.cancelled).toBe(false);
    expect(result.run_error).toBeUndefined();
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.error).toBe("publisher blew up synchronously");
    expect(result.exitCode).toBe(1);
  });

  it("keeps distinct terminal statuses for the same page as separate outcomes rather than overwriting", async () => {
    // Two different terminal events for the exact same (url, depth) — this
    // should not normally happen, but the dedup key must not silently merge
    // a "not-found" tag with an unrelated "fetch-failed" tag into one lossy
    // entry.
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        skipEvent({
          currentUrl: "https://example.com/mixed",
          depth: 1,
          outcome: "not-found",
        }),
      );
      await progressCallback(
        skipEvent({
          currentUrl: "https://example.com/mixed",
          depth: 1,
          outcome: "fetch-failed",
          errorMessage: "second distinct failure",
        }),
      );
    });
    const publisher = new ScriptedPublisher(async () => published());

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/mixed" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.outcomes).toHaveLength(2);
    const notFound = result.outcomes.find((o) => o.skipped === "not-found");
    const fetchFailed = result.outcomes.find((o) => o.skipped === "fetch-failed");
    expect(notFound).toBeDefined();
    expect(fetchFailed).toBeDefined();
    expect(fetchFailed?.error).toBe("second distinct failure");

    // Deduplicated-event case: two distinct terminal statuses for one page,
    // each counted once rather than merged or dropped.
    expect(result.counts).toEqual({
      total: 2,
      published: 0,
      unchanged: 0,
      replaced: 0,
      conflict: 0,
      notModified: 0,
      notFound: 1,
      fetchFailed: 1,
      error: 0,
    });
  });

  it("carries the sanitized error message from a tagged fetch-failed event into the outcome", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        skipEvent({
          currentUrl: "https://example.com/child-failed",
          depth: 1,
          outcome: "fetch-failed",
          errorMessage: "connection reset while fetching child",
        }),
      );
    });
    const publisher = new ScriptedPublisher(async () => published());

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.skipped).toBe("fetch-failed");
    expect(result.outcomes[0]?.error).toBe("connection reset while fetching child");
  });

  it("records a 404 as a skipped outcome, retaining the published note from the crawl", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/", depth: 0 }),
      );
      await progressCallback(
        skipEvent({
          currentUrl: "https://example.com/gone",
          depth: 1,
          outcome: "not-found",
        }),
      );
    });
    const publisher = new ScriptedPublisher(async () => published());

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.outcomes).toHaveLength(2);
    const gone = result.outcomes.find((o) => o.sourceUrl === "https://example.com/gone");
    expect(gone?.skipped).toBe("not-found");
    expect(gone?.index).toBe("not-attempted");
    expect(gone?.publication).toBeUndefined();
    expect(publisher.calls).toHaveLength(1);
  });

  it("records an unverified 304 as a skipped outcome rather than assuming success", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        skipEvent({
          currentUrl: "https://example.com/cached",
          depth: 1,
          outcome: "not-modified",
        }),
      );
    });
    const publisher = new ScriptedPublisher(async () => published());

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/cached" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.skipped).toBe("not-modified");
    expect(result.outcomes[0]?.publication).toBeUndefined();
    expect(result.exitCode).toBe(1);
  });

  it("publishes a bounded two-level recursive crawl fixture", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/", depth: 0 }),
      );
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/a", depth: 1 }),
      );
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/a/b", depth: 2 }),
      );
    });
    const publisher = new ScriptedPublisher(async () => published());

    const result = await capture(
      { options: baseOptions({ maxDepth: 2 }), requestedUrl: "https://example.com/" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outcomes).toHaveLength(3);
    expect(publisher.calls).toHaveLength(3);
    expect(result.outcomes.every((o) => o.publication?.status === "published")).toBe(
      true,
    );

    // Full success: every page published, nothing else.
    expect(result.counts).toEqual({
      total: 3,
      published: 3,
      unchanged: 0,
      replaced: 0,
      conflict: 0,
      notModified: 0,
      notFound: 0,
      fetchFailed: 0,
      error: 0,
    });
  });

  it("exits 130 on cancellation and preserves outcomes published before the abort", async () => {
    const controller = new AbortController();
    const scraperService = new FakeScraperService(async (progressCallback, signal) => {
      void signal; // accepted for parity with the real ScraperService contract
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/", depth: 0 }),
      );
      controller.abort();
      throw new CancellationError("Scraping cancelled during batch processing");
    });
    const publisher = new ScriptedPublisher(async () => published());

    const result = await capture(
      {
        options: baseOptions(),
        requestedUrl: "https://example.com/",
        signal: controller.signal,
      },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.publication?.status).toBe("published");
    expect(result.run_error).toBeUndefined();
  });

  it("treats an in-flight publish failure as cancellation once the signal aborts, not a plain error outcome", async () => {
    const controller = new AbortController();
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/", depth: 0 }),
      );
    });
    const publisher: Publisher = {
      publish: async () => {
        controller.abort();
        throw new Error("write interrupted");
      },
    };

    const result = await capture(
      {
        options: baseOptions(),
        requestedUrl: "https://example.com/",
        signal: controller.signal,
      },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(result.outcomes).toHaveLength(0);
    expect(result.run_error).toBeUndefined();
  });

  it("dedupes a tagged root failure against the same error re-thrown from scrape", async () => {
    const failure = new Error("root fetch exploded");
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        skipEvent({
          currentUrl: "https://example.com/",
          depth: 0,
          outcome: "fetch-failed",
        }),
      );
      throw failure;
    });
    const publisher = new ScriptedPublisher(async () => published());

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      {
        scraperService:
          scraperService as unknown as CaptureDependencies["scraperService"],
        publisher,
      },
    );

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.skipped).toBe("fetch-failed");
    expect(result.run_error).toBe("root fetch exploded");
    expect(result.exitCode).toBe(1);
  });
});

/** Exposes protected failure-accounting fields for the real-strategy fixture. */
class InspectableStrategy extends BaseScraperStrategy {
  canHandle(): boolean {
    return true;
  }
  processItem =
    vi.fn<
      (
        item: QueueItem,
        options: ScraperOptions,
        signal?: AbortSignal,
      ) => Promise<ProcessItemResult>
    >();

  get failedChildPagesCount(): number {
    return this.failedChildPages;
  }
  get completedChildPageAttemptsCount(): number {
    return this.completedChildPageAttempts;
  }
}

describe("capture with a real BaseScraperStrategy", () => {
  it("does not count a publication failure toward upstream acquisition failure counters, and discovery continues", async () => {
    const strategy = new InspectableStrategy(loadConfig());
    strategy.processItem
      .mockResolvedValueOnce({
        url: "https://example.com/",
        links: ["https://example.com/child"],
        status: FetchStatus.SUCCESS,
        content: {
          title: "Root",
          textContent: "Root content",
          links: [],
          errors: [],
          chunks: [],
        },
      })
      .mockResolvedValueOnce({
        url: "https://example.com/child",
        links: [],
        status: FetchStatus.SUCCESS,
        content: {
          title: "Child",
          textContent: "Child content",
          links: [],
          errors: [],
          chunks: [],
        },
      });

    class FakeRegistry extends ScraperRegistry {
      getStrategy() {
        return strategy;
      }
    }
    const scraperService = new ScraperService(new FakeRegistry(loadConfig()));

    const publisher = new ScriptedPublisher(async (input) => {
      if (input.sourceUrl === "https://example.com/") {
        throw new Error("root publish failed");
      }
      if (input.sourceUrl === "https://example.com/child") {
        throw new Error("child publish failed");
      }
      return published();
    });

    const result = await capture(
      {
        options: baseOptions({ maxDepth: 1, maxPages: 5 }),
        requestedUrl: "https://example.com/",
      },
      { scraperService, publisher },
    );

    expect(strategy.processItem).toHaveBeenCalledTimes(2);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.error !== undefined)).toBe(true);
    expect(result.exitCode).toBe(1);

    // Publication exceptions never reach BaseScraperStrategy's own
    // acquisition-failure accounting: the callback swallows them, so from the
    // strategy's perspective both pages "completed" successfully.
    expect(strategy.failedChildPagesCount).toBe(0);
  });

  it("integrated: a fatal root 404 produces exactly one not-found page outcome plus one separate run error", async () => {
    // Exercises the real BaseScraperStrategy code path end to end: the
    // NOT_FOUND branch tags the event "not-found" and throws a fatal
    // ScraperError for the root, and the generic exception handler must not
    // re-tag that same error as "fetch-failed" before it reaches capture()'s
    // outer catch as a separate run_error.
    const strategy = new InspectableStrategy(loadConfig());
    strategy.processItem.mockResolvedValueOnce({
      url: "https://example.com/",
      links: [],
      status: FetchStatus.NOT_FOUND,
    });

    class FakeRegistry extends ScraperRegistry {
      getStrategy() {
        return strategy;
      }
    }
    const scraperService = new ScraperService(new FakeRegistry(loadConfig()));
    const publisher = new ScriptedPublisher(async () => published());

    const result = await capture(
      {
        options: baseOptions({ maxDepth: 1, maxPages: 5 }),
        requestedUrl: "https://example.com/",
      },
      { scraperService, publisher },
    );

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.skipped).toBe("not-found");
    expect(result.outcomes[0]?.sourceUrl).toBe("https://example.com/");
    expect(result.run_error).toBeDefined();
    expect(result.run_error).toContain("Root page not found");
    expect(result.exitCode).toBe(1);
    expect(publisher.calls).toHaveLength(0);
  });

  it("integrated: a root-success/child-404 crawl publishes the root and records the child as not-found", async () => {
    const strategy = new InspectableStrategy(loadConfig());
    strategy.processItem
      .mockResolvedValueOnce({
        url: "https://example.com/",
        links: ["https://example.com/gone"],
        status: FetchStatus.SUCCESS,
        content: {
          title: "Root",
          textContent: "Root content",
          links: [],
          errors: [],
          chunks: [],
        },
      })
      .mockResolvedValueOnce({
        url: "https://example.com/gone",
        links: [],
        status: FetchStatus.NOT_FOUND,
      });

    class FakeRegistry extends ScraperRegistry {
      getStrategy() {
        return strategy;
      }
    }
    const scraperService = new ScraperService(new FakeRegistry(loadConfig()));
    const publisher = new ScriptedPublisher(async () => published());

    const result = await capture(
      {
        options: baseOptions({ maxDepth: 1, maxPages: 5 }),
        requestedUrl: "https://example.com/",
      },
      { scraperService, publisher },
    );

    expect(result.run_error).toBeUndefined();
    expect(result.outcomes).toHaveLength(2);
    const root = result.outcomes.find((o) => o.sourceUrl === "https://example.com/");
    const child = result.outcomes.find((o) => o.sourceUrl === "https://example.com/gone");
    expect(root?.publication?.status).toBe("published");
    expect(child?.skipped).toBe("not-found");
    expect(result.exitCode).toBe(2);
  });
});

describe("deriveExitCode", () => {
  function outcomeWith(publication: Publication): CapturePageOutcome {
    return {
      sourceUrl: "https://example.com/",
      depth: 0,
      index: "not-attempted",
      publication,
    };
  }

  function publicationOf(
    status: Publication["status"],
    moc: Publication["moc"],
  ): Publication {
    return { status, path: "x.md", markdown: "# x", digest: "d", moc };
  }

  it.each([
    ["published", "linked", 0],
    ["unchanged", "linked", 0],
    ["replaced", "linked", 0],
    ["conflict", "linked", 2],
    ["published", "pending", 2],
    ["unchanged", "pending", 2],
    ["replaced", "pending", 2],
    ["conflict", "pending", 2],
  ] as const)(
    "a single %s publication with moc %s yields exit code %d",
    (status, moc, expectedExitCode) => {
      const outcome = outcomeWith(publicationOf(status, moc));
      expect(deriveExitCode([outcome], false, undefined)).toBe(expectedExitCode);
    },
  );

  it("returns exit 1 for an empty outcome list", () => {
    expect(deriveExitCode([], false, undefined)).toBe(1);
  });

  it("returns exit 130 when cancelled, even with an otherwise fully clean outcome", () => {
    const outcome = outcomeWith(publicationOf("published", "linked"));
    expect(deriveExitCode([outcome], true, undefined)).toBe(130);
  });

  it("returns exit 2 when a run error accompanies an otherwise fully clean outcome", () => {
    const outcome = outcomeWith(publicationOf("published", "linked"));
    expect(deriveExitCode([outcome], false, "unexpected failure")).toBe(2);
  });
});

describe("capture indexing", () => {
  /** The fake scraper, as the dependency type this module actually takes. */
  const asService = (fake: FakeScraperService): CaptureDependencies["scraperService"] =>
    fake as unknown as CaptureDependencies["scraperService"];

  /** Records the order publication and indexing happened in. */
  class OrderRecorder {
    readonly events: string[] = [];
  }

  function indexedPublication(url: string): Publication {
    return {
      status: "published",
      path: `00 Inbox/Source Captures/${url.replace(/\W+/g, "-")}.md`,
      markdown: `---\ntitle: x\n---\nbody for ${url}`,
      digest: `digest-${url}`,
      moc: "linked",
    };
  }

  it("publishes before it makes any index call", async () => {
    const recorder = new OrderRecorder();
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(contentEvent({ currentUrl: "https://example.com/" }));
    });
    const publisher = new ScriptedPublisher(async (input) => {
      recorder.events.push(`publish:${input.sourceUrl}`);
      return indexedPublication(input.sourceUrl);
    });
    const indexer: CaptureIndexer = {
      index: async (entry) => {
        recorder.events.push(`index:${entry.sourceUrl}`);
      },
    };

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      { scraperService: asService(scraperService), publisher, indexer },
    );

    expect(recorder.events).toEqual([
      "publish:https://example.com/",
      "index:https://example.com/",
    ]);
    expect(result.outcomes[0].index).toBe("indexed");
    expect(result.exitCode).toBe(0);
  });

  it("passes the saved note's own bytes, path and digest to the indexer", async () => {
    const seen: Parameters<CaptureIndexer["index"]>[0][] = [];
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(contentEvent({ currentUrl: "https://example.com/doc" }));
    });
    const publication = indexedPublication("https://example.com/doc");
    const publisher = new ScriptedPublisher(async () => publication);

    await capture(
      {
        options: baseOptions({ library: "Doc Set", version: "2.1" }),
        requestedUrl: "https://example.com/doc",
      },
      {
        scraperService: asService(scraperService),
        publisher,
        indexer: {
          index: async (entry) => {
            seen.push(entry);
          },
        },
      },
    );

    expect(seen).toEqual([
      {
        path: publication.path,
        markdown: publication.markdown,
        digest: publication.digest,
        sourceUrl: "https://example.com/doc",
        collection: "Doc Set",
        version: "2.1",
      },
    ]);
  });

  it("leaves the publication intact and reports pending when indexing fails", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(contentEvent({ currentUrl: "https://example.com/" }));
    });
    const publication = indexedPublication("https://example.com/");
    const publisher = new ScriptedPublisher(async () => publication);

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      {
        scraperService: asService(scraperService),
        publisher,
        indexer: {
          index: async () => {
            throw new Error("index store unavailable");
          },
        },
      },
    );

    expect(result.outcomes[0].index).toBe("pending");
    expect(result.outcomes[0].publication).toEqual(publication);
    expect(result.outcomes[0].error).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it("reports pending when the index lock is held by another process", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(contentEvent({ currentUrl: "https://example.com/" }));
    });
    const publisher = new ScriptedPublisher(async () =>
      indexedPublication("https://example.com/"),
    );

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      {
        scraperService: asService(scraperService),
        publisher,
        indexer: {
          index: async () => {
            throw new LockTimeoutError("another process holds the index lock");
          },
        },
      },
    );

    expect(result.outcomes[0].index).toBe("pending");
    expect(result.exitCode).toBe(0);
  });

  it("reports failed when the saved note produces no chunks", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(contentEvent({ currentUrl: "https://example.com/" }));
    });
    const publisher = new ScriptedPublisher(async () =>
      indexedPublication("https://example.com/"),
    );

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      {
        scraperService: asService(scraperService),
        publisher,
        indexer: {
          index: async () => {
            throw new IndexContentError("no chunks", "note.md");
          },
        },
      },
    );

    expect(result.outcomes[0].index).toBe("failed");
    // Indexing status never moves the exit code.
    expect(result.exitCode).toBe(0);
  });

  it("indexes one URL once however often the crawl reports it", async () => {
    const calls: string[] = [];
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/", depth: 0 }),
      );
      await progressCallback(
        contentEvent({ currentUrl: "https://example.com/", depth: 2 }),
      );
    });
    const publisher = new ScriptedPublisher(async () =>
      indexedPublication("https://example.com/"),
    );

    await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      {
        scraperService: asService(scraperService),
        publisher,
        indexer: {
          index: async (entry) => {
            calls.push(entry.sourceUrl);
          },
        },
      },
    );

    expect(calls).toEqual(["https://example.com/"]);
  });

  it("leaves every outcome not-attempted when no indexer is supplied", async () => {
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(contentEvent({ currentUrl: "https://example.com/" }));
    });
    const publisher = new ScriptedPublisher(async () =>
      indexedPublication("https://example.com/"),
    );

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/" },
      { scraperService: asService(scraperService), publisher },
    );

    expect(result.outcomes[0].index).toBe("not-attempted");
  });

  it("never indexes a page that was skipped rather than published", async () => {
    const calls: string[] = [];
    const scraperService = new FakeScraperService(async (progressCallback) => {
      await progressCallback(
        skipEvent({ currentUrl: "https://example.com/missing", outcome: "not-found" }),
      );
    });
    const publisher = new ScriptedPublisher(async () =>
      indexedPublication("https://example.com/missing"),
    );

    const result = await capture(
      { options: baseOptions(), requestedUrl: "https://example.com/missing" },
      {
        scraperService: asService(scraperService),
        publisher,
        indexer: {
          index: async (entry) => {
            calls.push(entry.sourceUrl);
          },
        },
      },
    );

    expect(calls).toEqual([]);
    expect(result.outcomes[0].index).toBe("not-attempted");
  });
});
