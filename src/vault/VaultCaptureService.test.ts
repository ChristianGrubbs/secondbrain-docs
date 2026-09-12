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
import type { Publication, Publisher, SourceDocument } from "./types";
import { type CaptureDependencies, capture } from "./VaultCaptureService";

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
    expect(result.runError).toBeUndefined();
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
    expect(result.runError).toBeUndefined();
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
    expect(result.runError).toBe("root fetch exploded");
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
});
