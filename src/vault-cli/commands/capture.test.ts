/**
 * Tests for `sb-docs capture`: a URL, local Markdown file, local document, and
 * a bounded multi-page crawl all publish full sources through the same
 * `VaultCaptureService` adapter, with honest partial-success exit codes.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScraperService } from "../../scraper/ScraperService";
import { ScrapeMode, type ScraperOptions } from "../../scraper/types";
import { type AppConfig, AppConfigSchema, DEFAULT_CONFIG } from "../../utils/config";
import { sha256 } from "../../vault/identity";
import { ObsidianCli } from "../../vault/ObsidianCli";
import type { CliResult, Publication, Publisher } from "../../vault/types";
import { createVaultCli } from "../index";
import { type CaptureDeps, normalizeCaptureInput } from "./capture";

/** In-memory stand-in for the `obsidian-cli` process, create/read/write only. */
class FakeVault {
  readonly notes = new Map<string, string>();

  anchorOf(notePath: string): string {
    const existing = this.notes.get(notePath);
    return existing === undefined ? "sha256:<absent>" : `sha256:${sha256(existing)}`;
  }

  run = async (args: string[], stdin: string | null): Promise<CliResult> => {
    const [command, target] = args;

    if (command === "create") {
      if (this.notes.has(target)) {
        return { code: 3, stdout: "", stderr: "obsidian-cli: note changed" };
      }
      this.notes.set(target, stdin ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "write") {
      const ifMatchIndex = args.indexOf("--if-match");
      const expected = ifMatchIndex === -1 ? null : args[ifMatchIndex + 1];
      if (expected !== null && expected !== this.anchorOf(target)) {
        return { code: 3, stdout: "", stderr: "obsidian-cli: note changed" };
      }
      this.notes.set(target, stdin ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "read") {
      const existing = this.notes.get(target);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${target}` };
      }
      return {
        code: 0,
        stdout: existing,
        stderr: args.includes("--with-anchor")
          ? `anchor: ${this.anchorOf(target)}\n`
          : "",
      };
    }

    if (command === "section-insert") {
      const existing = this.notes.get(target);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${target}` };
      }
      const lines = existing.split("\n");
      const at = lines.indexOf(args[2]);
      if (at === -1) {
        return { code: 1, stdout: "", stderr: "obsidian-cli: heading not found" };
      }
      lines.splice(at + 1, 0, stdin ?? "");
      this.notes.set(target, lines.join("\n"));
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "list") {
      const dir = target.replace(/\/$/, "");
      const entries = new Set<string>();
      for (const candidate of this.notes.keys()) {
        if (!candidate.startsWith(`${dir}/`)) continue;
        const head = candidate.slice(dir.length + 1).split("/")[0];
        if (head) entries.add(`${dir}/${head}`);
      }
      if (entries.size === 0) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a directory: ${dir}` };
      }
      return { code: 0, stdout: `${[...entries].sort().join("\n")}\n`, stderr: "" };
    }

    return { code: 2, stdout: "", stderr: `unknown subcommand: ${command}` };
  };
}

const temporaries: string[] = [];
let stateDir: string;
let vaultDir: string;
let vault: FakeVault;
let out: string[];
let err: string[];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

function unrestrictedConfig(): AppConfig {
  return AppConfigSchema.parse({
    ...DEFAULT_CONFIG,
    app: { ...DEFAULT_CONFIG.app, embeddingModel: "text-embedding-3-small" },
    scraper: {
      ...DEFAULT_CONFIG.scraper,
      security: {
        ...DEFAULT_CONFIG.scraper.security,
        fileAccess: {
          ...DEFAULT_CONFIG.scraper.security.fileAccess,
          mode: "unrestricted",
          followSymlinks: true,
          includeHidden: true,
        },
        network: {
          ...DEFAULT_CONFIG.scraper.security.network,
          allowPrivateNetworks: true,
        },
      },
    },
  });
}

beforeEach(() => {
  stateDir = makeTempDir("sb-docs-capture-state-");
  vaultDir = makeTempDir("sb-docs-capture-vault-");
  vault = new FakeVault();
  out = [];
  err = [];
  nock.cleanAll();
});

afterEach(() => {
  nock.cleanAll();
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `sb-docs capture` with injected state, vault and output sinks. */
async function runCapture(args: string[], overrides: CaptureDeps = {}): Promise<void> {
  await createVaultCli(["capture", ...args], {
    capture: {
      stateDir,
      vaultPath: vaultDir,
      cli: new ObsidianCli(vault.run),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      appConfig: unrestrictedConfig(),
      ...overrides,
    },
  })
    .exitProcess(false)
    .fail(false)
    .parseAsync();
}

function envelope(): {
  outcomes: Array<{
    sourceUrl: string;
    depth: number;
    index: string;
    publication?: Publication;
    error?: string;
    skipped?: string;
  }>;
  counts: {
    total: number;
    published: number;
    unchanged: number;
    replaced: number;
    conflict: number;
    notModified: number;
    notFound: number;
    fetchFailed: number;
    error: number;
  };
  cancelled: boolean;
  run_error?: string;
  exitCode: number;
} {
  return JSON.parse(out.join("\n"));
}

/** Starts a real HTTP server on an ephemeral loopback port for one test. */
function startFixtureServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to bind fixture server to an ephemeral port"));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("normalizeCaptureInput", () => {
  it("keeps an http(s) URL as-is", () => {
    expect(normalizeCaptureInput("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
  });

  it("keeps an existing file:// URL as-is", () => {
    expect(normalizeCaptureInput("file:///tmp/foo.md")).toBe("file:///tmp/foo.md");
  });

  it("converts a relative local path to an absolute file:// URL", () => {
    const result = normalizeCaptureInput("./README.md");
    expect(result).toBe(pathToFileURL(path.resolve("./README.md")).href);
  });
});

describe("sb-docs capture: input validation", () => {
  it("rejects a non-positive --max-pages", async () => {
    await expect(
      runCapture(["https://example.com/", "--max-pages", "0"]),
    ).rejects.toThrow(/--max-pages must be positive/);
  });

  it("rejects a negative --max-depth", async () => {
    await expect(
      runCapture(["https://example.com/", "--max-depth", "-1"]),
    ).rejects.toThrow(/--max-depth must be nonnegative/);
  });
});

describe("sb-docs capture: configuration", () => {
  it("forces embeddingModel and telemetryEnabled off after loading config", async () => {
    const appConfig = unrestrictedConfig();
    expect(appConfig.app.embeddingModel).not.toBe("");

    const publisher: Publisher = { publish: async () => published() };
    await runCapture(["https://example.com/"], {
      appConfig,
      scraperService: fakeScraperService([]),
      publisher,
    });

    expect(appConfig.app.embeddingModel).toBe("");
    expect(appConfig.app.telemetryEnabled).toBe(false);
  });

  it("normalizes the default collection to inbox", async () => {
    let capturedLibrary: string | undefined;
    const scraperService = fakeScraperServiceCapturingOptions((options) => {
      capturedLibrary = options.library;
    });
    const publisher: Publisher = { publish: async () => published() };

    await runCapture(["https://example.com/"], { scraperService, publisher });

    expect(capturedLibrary).toBe("inbox");
  });

  it("always passes scrapeMode Auto and single-page defaults", async () => {
    let seen: { maxPages?: number; maxDepth?: number; scrapeMode?: ScrapeMode } = {};
    const scraperService = fakeScraperServiceCapturingOptions((options) => {
      seen = {
        maxPages: options.maxPages,
        maxDepth: options.maxDepth,
        scrapeMode: options.scrapeMode,
      };
    });
    const publisher: Publisher = { publish: async () => published() };

    await runCapture(["https://example.com/"], { scraperService, publisher });

    expect(seen).toEqual({ maxPages: 1, maxDepth: 0, scrapeMode: ScrapeMode.Auto });
  });
});

function published(overrides: Partial<Publication> = {}): Publication {
  return {
    status: "published",
    path: "00 Inbox/Source Captures/note abc123456789.md",
    markdown: "# note",
    digest: "digest",
    moc: "linked",
    ...overrides,
  };
}

/** A minimal, content-bearing progress event for the fakes below. */
function fakeContentEvent(overrides: { currentUrl: string; depth: number }) {
  return {
    pagesScraped: 1,
    totalPages: 1,
    totalDiscovered: 1,
    maxDepth: 0,
    result: {
      url: overrides.currentUrl,
      title: "Title",
      sourceContentType: "text/html",
      contentType: "text/markdown",
      textContent: "# Title\n\nBody.",
      links: [],
      errors: [],
      chunks: [],
    },
    ...overrides,
  };
}

/** Fake scraper service that emits zero or more preset progress events. */
function fakeScraperService(
  events: Array<{ currentUrl: string; depth: number }>,
): ScraperService {
  const fake = {
    scrape: async (
      _options: ScraperOptions,
      progressCallback: (event: ReturnType<typeof fakeContentEvent>) => Promise<void>,
    ) => {
      for (const event of events) {
        await progressCallback(fakeContentEvent(event));
      }
    },
  };
  return fake as unknown as ScraperService;
}

/** Fake scraper service that records the options it was called with. */
function fakeScraperServiceCapturingOptions(
  onOptions: (options: ScraperOptions) => void,
): ScraperService {
  const fake = {
    scrape: async (
      options: ScraperOptions,
      progressCallback: (event: ReturnType<typeof fakeContentEvent>) => Promise<void>,
    ) => {
      onOptions(options);
      await progressCallback(
        fakeContentEvent({ currentUrl: "https://example.com/", depth: 0 }),
      );
    },
  };
  return fake as unknown as ScraperService;
}

describe("sb-docs capture: exit codes", () => {
  it("exits 0 and publishes a full note for a single successful page", async () => {
    const scraperService = fakeScraperService([
      { currentUrl: "https://example.com/", depth: 0 },
    ]);
    const publisher: Publisher = { publish: async () => published() };

    await runCapture(["https://example.com/", "--json"], { scraperService, publisher });

    expect(process.exitCode).toBe(0);
    const report = envelope();
    expect(report.exitCode).toBe(0);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].publication?.status).toBe("published");
    expect(report.outcomes[0].index).toBe("indexed");
    process.exitCode = 0;
  });

  it("exits 2 when one of two pages fails to publish", async () => {
    const scraperService = fakeScraperService([
      { currentUrl: "https://example.com/", depth: 0 },
      { currentUrl: "https://example.com/child", depth: 1 },
    ]);
    let calls = 0;
    const publisher: Publisher = {
      publish: async () => {
        calls += 1;
        if (calls === 2) throw new Error("vault write failed");
        return published();
      },
    };

    await runCapture(["https://example.com/", "--json"], { scraperService, publisher });

    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it("exits 1 when nothing useful was published", async () => {
    const scraperService = fakeScraperService([
      { currentUrl: "https://example.com/", depth: 0 },
    ]);
    const publisher: Publisher = {
      publish: async () => {
        throw new Error("vault unreachable");
      },
    };

    await runCapture(["https://example.com/", "--json"], { scraperService, publisher });

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe("sb-docs capture: plain (non-JSON) output", () => {
  it("surfaces the sanitized cause of an ignored child acquisition failure", async () => {
    // Root succeeds; a child is tagged fetch-failed (ignoreErrors swallowed
    // the thrown exception upstream) and carries a sanitized error message.
    const fake = {
      scrape: async (
        _options: ScraperOptions,
        progressCallback: (event: unknown) => Promise<void>,
      ) => {
        await progressCallback(
          fakeContentEvent({ currentUrl: "https://example.com/", depth: 0 }),
        );
        await progressCallback({
          pagesScraped: 1,
          totalPages: 2,
          totalDiscovered: 2,
          currentUrl: "https://example.com/child",
          depth: 1,
          maxDepth: 1,
          result: null,
          outcome: "fetch-failed",
          errorMessage: "connection reset while fetching child",
        });
      },
    };
    const scraperService = fake as unknown as ScraperService;
    const publisher: Publisher = { publish: async () => published() };

    // No --json: exercise the plain-text report path.
    await runCapture(["https://example.com/"], { scraperService, publisher });

    expect(process.exitCode).toBe(2);
    const errText = err.join("\n");
    expect(errText).toContain("https://example.com/child");
    expect(errText).toContain("connection reset while fetching child");
    process.exitCode = 0;
  });
});

describe("sb-docs capture: local Markdown and document fixtures", () => {
  it("publishes full Markdown from a local file:// Markdown source with no embedding key", async () => {
    const sourceDir = makeTempDir("sb-docs-capture-source-");
    const filePath = path.join(sourceDir, "notes.md");
    fs.writeFileSync(
      filePath,
      "# Local Notes\n\nSome **bold** content and a [link](https://example.com).\n",
    );

    await runCapture([filePath, "--json"]);

    expect(process.exitCode).toBe(0);
    const report = envelope();
    expect(report.outcomes).toHaveLength(1);
    const outcome = report.outcomes[0];
    expect(outcome.publication?.status).toBe("published");
    expect(outcome.index).toBe("indexed");
    expect(outcome.publication?.markdown).toContain("Local Notes");
    expect(outcome.publication?.markdown).toContain("bold");
    process.exitCode = 0;
  });

  it("publishes a local document (PDF) converted to recognizable Markdown", async () => {
    const pdfFixture = path.resolve(__dirname, "../../../test/fixtures/sample.pdf");
    expect(fs.existsSync(pdfFixture)).toBe(true);

    await runCapture([pdfFixture, "--json"]);

    expect(process.exitCode).toBe(0);
    const report = envelope();
    expect(report.exitCode).toBe(0);
    expect(report.outcomes).toHaveLength(1);
    const outcome = report.outcomes[0];
    expect(outcome.publication?.status).toBe("published");
    expect(outcome.index).toBe("indexed");
    // sample.pdf is RFC 2549, "IP over Avian Carriers with Quality of
    // Service" — a stable, known string proving real text was extracted
    // rather than an empty/placeholder conversion.
    expect(outcome.publication?.markdown).toContain("Avian Carriers");
    process.exitCode = 0;
  });
});

describe("sb-docs capture: bounded multi-page HTTP crawl", () => {
  it("publishes a root page and one linked child through a real crawl", async () => {
    const base = "https://sb-docs-fixture.test";
    nock(base)
      .get("/")
      .reply(
        200,
        `<html><body><h1>Root</h1><a href="${base}/child">Child</a></body></html>`,
        { "Content-Type": "text/html" },
      )
      .get("/child")
      .reply(200, "<html><body><h1>Child page</h1><p>Child content.</p></body></html>", {
        "Content-Type": "text/html",
      });

    await runCapture([`${base}/`, "--max-pages", "5", "--max-depth", "1", "--json"]);

    const report = envelope();
    expect(report.exitCode).toBe(0);
    expect(report.outcomes).toHaveLength(2);
    for (const outcome of report.outcomes) {
      expect(outcome.publication?.status).toBe("published");
      expect(outcome.index).toBe("indexed");
    }
    process.exitCode = 0;
  });

  it("publishes the root and records a linked child 404 as a skipped outcome, exit 2", async () => {
    const base = "https://sb-docs-fixture-404.test";
    nock(base)
      .get("/")
      .reply(
        200,
        `<html><body><h1>Root</h1><a href="${base}/missing">Missing</a></body></html>`,
        { "Content-Type": "text/html" },
      )
      .get("/missing")
      .reply(404, "not found");

    await runCapture([`${base}/`, "--max-pages", "5", "--max-depth", "1", "--json"]);

    const report = envelope();
    expect(report.exitCode).toBe(2);
    expect(report.outcomes).toHaveLength(2);
    const root = report.outcomes.find((o) => o.sourceUrl === `${base}/`);
    const missing = report.outcomes.find((o) => o.sourceUrl === `${base}/missing`);
    expect(root?.publication?.status).toBe("published");
    expect(missing?.skipped).toBe("not-found");
    process.exitCode = 0;
  });

  it("reports a fatal root 404 as one skipped outcome and one run_error, exit 1", async () => {
    const base = "https://sb-docs-fixture-root-404.test";
    nock(base).get("/").reply(404, "not found");

    await runCapture([`${base}/`, "--json"]);

    const report = envelope();
    expect(report.exitCode).toBe(1);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].skipped).toBe("not-found");
    expect(report.run_error).toBeDefined();
    expect(report.run_error).toContain("Root page not found");
    process.exitCode = 0;
  });
});

describe("sb-docs capture: real localhost fixture-server integration", () => {
  // Nock intercepts at the module level rather than a real socket. These
  // cases exercise an actual listening server and a real request over the
  // loopback interface, so the full network path (DNS/connect/HTTP parsing)
  // is real, matching how upstream e2e suites like
  // test/refresh-pipeline-e2e.test.ts exercise the scraper.
  it("publishes the root and records an untracked child 404 as not-found over a real socket, exit 2", async () => {
    const { server, baseUrl } = await startFixtureServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h1>Root</h1><a href="${baseUrl}/gone">Gone</a></body></html>`,
        );
        return;
      }
      if (req.url === "/gone") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      await runCapture([`${baseUrl}/`, "--max-pages", "5", "--max-depth", "1", "--json"]);

      const report = envelope();
      expect(report.exitCode).toBe(2);
      expect(report.run_error).toBeUndefined();
      expect(report.outcomes).toHaveLength(2);
      const root = report.outcomes.find((o) => o.sourceUrl === `${baseUrl}/`);
      const gone = report.outcomes.find((o) => o.sourceUrl === `${baseUrl}/gone`);
      expect(root?.publication?.status).toBe("published");
      expect(gone?.skipped).toBe("not-found");
      expect(report.counts).toEqual({
        total: 2,
        published: 1,
        unchanged: 0,
        replaced: 0,
        conflict: 0,
        notModified: 0,
        notFound: 1,
        fetchFailed: 0,
        error: 0,
      });
      process.exitCode = 0;
    } finally {
      await closeServer(server);
    }
  });

  it("reports a fatal root 404 over a real socket as one skipped outcome and one run_error, exit 1", async () => {
    const { server, baseUrl } = await startFixtureServer((_req, res) => {
      res.writeHead(404);
      res.end("not found");
    });

    try {
      await runCapture([`${baseUrl}/`, "--json"]);

      const report = envelope();
      expect(report.exitCode).toBe(1);
      expect(report.outcomes).toHaveLength(1);
      expect(report.outcomes[0].skipped).toBe("not-found");
      expect(report.run_error).toBeDefined();
      expect(report.run_error).toContain("Root page not found");
      expect(report.counts).toEqual({
        total: 1,
        published: 0,
        unchanged: 0,
        replaced: 0,
        conflict: 0,
        notModified: 0,
        notFound: 1,
        fetchFailed: 0,
        error: 0,
      });
      process.exitCode = 0;
    } finally {
      await closeServer(server);
    }
  });
});

describe("sb-docs capture: command-scoped cancellation", () => {
  it("exits 130 on SIGINT, preserving outcomes published before the abort", async () => {
    const fake = {
      scrape: async (
        _options: ScraperOptions,
        progressCallback: (event: ReturnType<typeof fakeContentEvent>) => Promise<void>,
        signal?: AbortSignal,
      ) => {
        await progressCallback(
          fakeContentEvent({ currentUrl: "https://example.com/", depth: 0 }),
        );
        // Simulate a real Ctrl-C: the process-level SIGINT handler the
        // command registers should call the controller's abort(), which
        // this fake scraper then observes and reacts to exactly as a real
        // ScraperService would.
        process.emit("SIGINT");
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("Scraping cancelled during batch processing"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new Error("Scraping cancelled during batch processing"));
          });
          setTimeout(resolve, 50);
        });
      },
    };
    const scraperService = fake as unknown as ScraperService;
    const publisher: Publisher = { publish: async () => published() };

    await runCapture(["https://example.com/", "--json"], { scraperService, publisher });

    expect(process.exitCode).toBe(130);
    const report = envelope();
    expect(report.exitCode).toBe(130);
    expect(report.cancelled).toBe(true);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].publication?.status).toBe("published");
    process.exitCode = 0;
  });
});
