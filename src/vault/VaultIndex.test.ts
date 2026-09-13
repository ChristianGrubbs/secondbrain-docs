/**
 * Unit and integration contract for the derived vault index.
 *
 * These run against a real SQLite store in a temporary state directory and a
 * fake `obsidian-cli` holding note bytes in memory. Nothing here reaches the
 * network, and the fake vault records every write attempt so "the index never
 * writes to the vault" is asserted rather than assumed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppConfig, loadConfig } from "../utils/config";
import { sha256 } from "./identity";
import { LockTimeoutError } from "./lock";
import { ObsidianCli } from "./ObsidianCli";
import { renderSourceNote } from "./render";
import type { CliResult, SourceDocument } from "./types";
import {
  IndexContentError,
  type IndexEntry,
  IndexVerificationError,
  VaultIndex,
  type VaultIndexOptions,
} from "./VaultIndex";
import { SOURCE_UPDATES_PATH } from "./VaultPublisher";

const COLLECTION = "inbox";
const FOLDER = "00 Inbox/Source Captures";

/** Minimal in-memory stand-in for `obsidian-cli`, with recorded mutations. */
class FakeVault {
  readonly notes = new Map<string, string>();
  readonly reads: string[] = [];
  readonly lists: string[] = [];
  /** Every mutating invocation; the index must never add to this. */
  readonly writes: string[] = [];
  /**
   * Called before every invocation is served, so a test can act at an exact
   * point in a scan — a barrier, an edit, or a failure injected into the run
   * that is happening right now rather than into a sleep.
   */
  readonly hooks: ((args: string[]) => Promise<void> | void)[] = [];
  /** Paths whose read fails hard, for rebuild-failure coverage. */
  readonly unreadable = new Set<string>();

  run = async (args: string[], _stdin: string | null): Promise<CliResult> => {
    for (const hook of this.hooks) await hook(args);
    const [command, target] = args;

    if (command === "list") {
      this.lists.push(target);
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

    if (command === "read") {
      this.reads.push(target);
      if (this.unreadable.has(target)) {
        return { code: 2, stdout: "", stderr: "obsidian-cli: vault backend unavailable" };
      }
      const existing = this.notes.get(target);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${target}` };
      }
      return { code: 0, stdout: existing, stderr: "" };
    }

    this.writes.push(args.join(" "));
    return { code: 2, stdout: "", stderr: `unexpected subcommand: ${command}` };
  };

  cli(): ObsidianCli {
    return new ObsidianCli(this.run);
  }
}

/** Builds a managed source note exactly as the publisher would render one. */
function sourceNote(input: {
  url: string;
  title: string;
  body: string;
  version?: string;
  collection?: string;
}): { path: string; markdown: string; document: SourceDocument } {
  const document: SourceDocument = {
    sourceUrl: input.url,
    requestedUrl: input.url,
    collection: input.collection ?? COLLECTION,
    version: input.version ?? "",
    title: input.title,
    markdown: input.body,
    sourceContentType: "text/html",
    capturedAt: "2026-09-12T10:00:00.000Z",
  };
  const rendered = renderSourceNote(document, { publisherVersion: "9.9.9" });
  return { path: rendered.path, markdown: rendered.markdown, document };
}

/** A body long enough to split, carrying one deliberately rare phrase. */
function body(phrase: string): string {
  return [
    `# ${phrase}`,
    "",
    `The ${phrase} procedure is documented here for operators.`,
    "",
    "| Command | Purpose |",
    "| --- | --- |",
    "| `run` | Executes the documented step |",
    "",
    "```bash",
    `run --mode ${phrase}`,
    "```",
    "",
    "Further prose so the splitter has a paragraph of ordinary text to work",
    "with, rather than a single heading and nothing else.",
  ].join("\n");
}

/** Turns an entry the capture path would offer into an {@link IndexEntry}. */
function entryFor(note: {
  path: string;
  markdown: string;
  document: SourceDocument;
}): IndexEntry {
  return {
    path: note.path,
    markdown: note.markdown,
    sourceUrl: note.document.sourceUrl,
    collection: note.document.collection,
    version: note.document.version,
    digest: sha256(note.markdown),
  };
}

/** Reads the generation one collection's pointer currently names. */
function activeGeneration(index: VaultIndex, collection = COLLECTION): string {
  return JSON.parse(
    fs.readFileSync(path.join(index.collectionRoot(collection), "current.json"), "utf8"),
  ).generation as string;
}

/** Absolute path of one collection's active generation directory. */
function activeGenerationDir(index: VaultIndex, collection = COLLECTION): string {
  return path.join(
    index.collectionRoot(collection),
    "generations",
    activeGeneration(index, collection),
  );
}

/**
 * Absolute path of the generation a rebuild is filling right now: the one
 * directory that exists and is not the one the pointer names.
 */
function pendingGenerationDir(index: VaultIndex, collection = COLLECTION): string {
  const root = path.join(index.collectionRoot(collection), "generations");
  const active = activeGeneration(index, collection);
  const pending = fs.readdirSync(root).filter((name) => name !== active);
  expect(pending).toHaveLength(1);
  return path.join(root, pending[0]);
}

/** Reads every stored chunk of the active generation, straight from SQLite. */
function storedChunks(index: VaultIndex): { content: string; metadata: string }[] {
  const file = path.join(activeGenerationDir(index), "documents.db");
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare("SELECT content, metadata FROM documents").all() as {
      content: string;
      metadata: string;
    }[];
  } finally {
    db.close();
  }
}

describe("VaultIndex", () => {
  let stateDir: string;
  let vaultDir: string;
  let appConfig: AppConfig;
  const opened: VaultIndex[] = [];

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-index-"));
    stateDir = path.join(root, "state");
    vaultDir = path.join(root, "vault");
    fs.mkdirSync(vaultDir, { recursive: true });
    appConfig = loadConfig();
  });

  afterEach(async () => {
    for (const index of opened.splice(0)) await index.shutdown();
  });

  /** Builds an index over `vault`, registered for teardown. */
  function makeIndex(vault: FakeVault, overrides: VaultIndexOptions = {}): VaultIndex {
    const index = new VaultIndex(vault.cli(), {
      stateDir,
      vaultPath: vaultDir,
      appConfig,
      lock: { timeoutMs: 2_000, pollMs: 10 },
      ...overrides,
    });
    opened.push(index);
    return index;
  }

  it("makes a saved note's body searchable without fetching its source", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/kryptonite",
      title: "Kryptonite",
      body: body("kryptonite"),
    });
    vault.notes.set(note.path, note.markdown);

    const index = makeIndex(vault);
    const report = await index.rebuild({ collection: COLLECTION });
    expect(report.notesIndexed).toBe(1);

    const response = await index.search({ query: "kryptonite", collection: COLLECTION });
    expect(response.status).toBe("ok");
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      source_url: "https://example.com/kryptonite",
      vault_path: note.path,
      version: "",
      digest: sha256(note.markdown),
    });
    expect(response.results[0].excerpt).toContain("kryptonite");
    expect(vault.writes).toEqual([]);
  });

  it("reports the scan cost it paid on the collection", async () => {
    const vault = new FakeVault();
    for (const phrase of ["alpharadon", "betaradon", "gammaradon"]) {
      const note = sourceNote({
        url: `https://example.com/${phrase}`,
        title: phrase,
        body: body(phrase),
      });
      vault.notes.set(note.path, note.markdown);
    }

    const report = await makeIndex(vault).rebuild({ collection: COLLECTION });
    expect(report.notesDiscovered).toBe(3);
    expect(report.noteReads).toBe(3);
    expect(report.directoryScans).toBeGreaterThanOrEqual(1);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("reproduces searchable content after the whole index is deleted", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/quintessence",
      title: "Quintessence",
      body: body("quintessence"),
    });
    vault.notes.set(note.path, note.markdown);

    const first = makeIndex(vault);
    await first.rebuild({ collection: COLLECTION });
    const before = await first.search({ query: "quintessence", collection: COLLECTION });
    await first.shutdown();

    fs.rmSync(path.join(stateDir, "index"), { recursive: true, force: true });

    const second = makeIndex(vault);
    await second.rebuild({ collection: COLLECTION });
    const after = await second.search({ query: "quintessence", collection: COLLECTION });

    expect(after.results.map((r) => r.vault_path)).toEqual(
      before.results.map((r) => r.vault_path),
    );
    expect(after.results[0].digest).toBe(before.results[0].digest);
    expect(vault.writes).toEqual([]);
  });

  it("indexes the body only, leaving frontmatter out of chunks and section paths", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/frontmatter",
      title: "Frontmatter",
      body: body("wolframite"),
    });
    vault.notes.set(note.path, note.markdown);

    const index = makeIndex(vault);
    await index.rebuild({ collection: COLLECTION });

    const contentHash = sha256(body("wolframite"));
    const chunks = storedChunks(index);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.content).not.toContain(contentHash);
      expect(chunk.content).not.toContain("source_id");
      expect(chunk.content).not.toContain("publisher: secondbrain-docs");
      expect(chunk.metadata).not.toContain(contentHash);
    }

    const byHash = await index.search({ query: contentHash, collection: COLLECTION });
    expect(byHash.results).toEqual([]);
    const byBody = await index.search({ query: "wolframite", collection: COLLECTION });
    expect(byBody.results).toHaveLength(1);
  });

  it("indexes a manually edited note as it now stands", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/edited",
      title: "Edited",
      body: body("originalium"),
    });
    vault.notes.set(note.path, note.markdown);

    const index = makeIndex(vault);
    await index.rebuild({ collection: COLLECTION });

    // A human rewrites the body in place, frontmatter untouched.
    vault.notes.set(note.path, note.markdown.replace(/originalium/g, "revisium"));
    await index.rebuild({ collection: COLLECTION });

    const revised = await index.search({ query: "revisium", collection: COLLECTION });
    expect(revised.results).toHaveLength(1);
    expect(revised.results[0].digest).toBe(sha256(vault.notes.get(note.path) ?? ""));

    const original = await index.search({ query: "originalium", collection: COLLECTION });
    expect(original.results).toEqual([]);
  });

  it("follows a manually renamed note to its new path", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/renamed",
      title: "Renamed",
      body: body("peregrination"),
    });
    vault.notes.set(note.path, note.markdown);

    const index = makeIndex(vault);
    await index.rebuild({ collection: COLLECTION });

    const moved = `${FOLDER}/A Human Renamed This 0123456789ab.md`;
    vault.notes.delete(note.path);
    vault.notes.set(moved, note.markdown);
    await index.rebuild({ collection: COLLECTION });

    const response = await index.search({
      query: "peregrination",
      collection: COLLECTION,
    });
    expect(response.results).toHaveLength(1);
    expect(response.results[0].vault_path).toBe(moved);
    expect(index.manifestEntries(COLLECTION).map((e) => e.vaultPath)).toEqual([moved]);
  });

  it("reconciles a vault note that has gone out of the index, never out of the vault", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/vanishing",
      title: "Vanishing",
      body: body("evanescent"),
    });
    vault.notes.set(note.path, note.markdown);

    const index = makeIndex(vault);
    await index.rebuild({ collection: COLLECTION });
    expect(index.manifestEntries(COLLECTION)).toHaveLength(1);

    vault.notes.delete(note.path);
    const response = await index.search({ query: "evanescent", collection: COLLECTION });

    expect(response.status).toBe("partial");
    expect(response.omitted).toEqual([
      {
        source_url: "https://example.com/vanishing",
        vault_path: note.path,
        reason: "missing",
      },
    ]);
    expect(response.results).toEqual([]);
    expect(index.manifestEntries(COLLECTION)).toEqual([]);
    expect(vault.writes).toEqual([]);
  });

  it("reports a note that has gone when a capture retries its indexing", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/gone",
      title: "Gone",
      body: body("absentia"),
    });
    const index = makeIndex(vault);

    const result = await index.upsert(entryFor(note));
    expect(result.status).toBe("missing");
    expect(result.chunks).toBe(0);
    expect(vault.writes).toEqual([]);
  });

  it("indexes the canonical saved bytes rather than the bytes the caller offered", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/canonical",
      title: "Canonical",
      body: body("crawlerium"),
    });
    // Publication saved this; the caller still holds what the crawler produced.
    const saved = note.markdown.replace(/crawlerium/g, "canonicalium");
    vault.notes.set(note.path, saved);

    const index = makeIndex(vault);
    const result = await index.upsert(entryFor(note));

    expect(result.status).toBe("indexed");
    expect(result.refreshed).toBe(true);
    expect(result.digest).toBe(sha256(saved));

    const crawler = await index.search({ query: "crawlerium", collection: COLLECTION });
    expect(crawler.results).toEqual([]);
    const canonical = await index.search({
      query: "canonicalium",
      collection: COLLECTION,
    });
    expect(canonical.results).toHaveLength(1);
  });

  it("excludes conflict candidates from what it indexes", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/preserved",
      title: "Preserved",
      body: body("preservatium"),
    });
    vault.notes.set(note.path, note.markdown);

    const candidate = `${SOURCE_UPDATES_PATH}/abcdef012345-0123456789ab.md`;
    vault.notes.set(candidate, note.markdown.replace(/preservatium/g, "incomingium"));

    const index = makeIndex(vault);
    // The candidate is offered explicitly, which is the only way legacy or
    // unmanaged notes ever enter — and it is still refused.
    await index.rebuild({ collection: COLLECTION, inventory: [candidate] });

    expect(index.manifestEntries(COLLECTION).map((e) => e.vaultPath)).toEqual([
      note.path,
    ]);
    const incoming = await index.search({ query: "incomingium", collection: COLLECTION });
    expect(incoming.results).toEqual([]);
    const preserved = await index.search({
      query: "preservatium",
      collection: COLLECTION,
    });
    expect(preserved.results).toHaveLength(1);
  });

  it("imports an unmanaged note only from an explicit read-only inventory", async () => {
    const vault = new FakeVault();
    const legacy = `${FOLDER}/Legacy Handwritten Note.md`;
    vault.notes.set(legacy, `# Legacy\n\n${body("antiquarian")}\n`);

    const index = makeIndex(vault);
    const without = await index.rebuild({ collection: COLLECTION });
    expect(without.notesIndexed).toBe(0);

    const withInventory = await index.rebuild({
      collection: COLLECTION,
      inventory: [legacy],
    });
    expect(withInventory.notesIndexed).toBe(1);
    expect(index.manifestEntries(COLLECTION)[0]).toMatchObject({
      vaultPath: legacy,
      legacy: true,
    });
    expect(vault.writes).toEqual([]);
  });

  it("keeps one URL at two versions as two entries", async () => {
    const vault = new FakeVault();
    const url = "https://example.com/versioned";
    const one = sourceNote({
      url,
      title: "Versioned",
      body: body("versionalia"),
      version: "1.0",
    });
    const two = sourceNote({
      url,
      title: "Versioned",
      body: body("versionalia"),
      version: "2.0",
    });
    vault.notes.set(one.path, one.markdown);
    vault.notes.set(two.path, two.markdown);
    expect(one.path).not.toBe(two.path);

    const index = makeIndex(vault);
    await index.rebuild({ collection: COLLECTION });
    expect(index.manifestEntries(COLLECTION)).toHaveLength(2);

    const first = await index.search({
      query: "versionalia",
      collection: COLLECTION,
      version: "1.0",
    });
    expect(first.results.map((r) => r.vault_path)).toEqual([one.path]);
    expect(first.results[0].version).toBe("1.0");

    const second = await index.search({
      query: "versionalia",
      collection: COLLECTION,
      version: "2.0",
    });
    expect(second.results.map((r) => r.vault_path)).toEqual([two.path]);
  });

  it("replaces a note's chunks on re-upsert rather than appending duplicates", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/duplicate",
      title: "Duplicate",
      body: body("duplicatum"),
    });
    vault.notes.set(note.path, note.markdown);

    const index = makeIndex(vault);
    const first = await index.upsert(entryFor(note));
    const afterFirst = storedChunks(index).length;

    const second = await index.upsert(entryFor(note));
    const afterSecond = storedChunks(index).length;

    expect(first.chunks).toBeGreaterThan(0);
    expect(first.chunks).toBe(second.chunks);
    expect(afterFirst).toBe(first.chunks);
    expect(afterSecond).toBe(afterFirst);

    const response = await index.search({ query: "duplicatum", collection: COLLECTION });
    expect(response.results).toHaveLength(1);
  });

  it("reports a note that produces no chunks as an indexing failure", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/empty",
      title: "Empty",
      body: "   \n\n   \n",
    });
    vault.notes.set(note.path, note.markdown);

    const index = makeIndex(vault);
    await expect(index.upsert(entryFor(note))).rejects.toBeInstanceOf(IndexContentError);
  });

  it("builds with embeddings disabled even when a provider key is present", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "probe";
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      const vault = new FakeVault();
      const note = sourceNote({
        url: "https://example.com/embeddings",
        title: "Embeddings",
        body: body("embeddologist"),
      });
      vault.notes.set(note.path, note.markdown);

      // Loaded fresh, with the ambient key visible to upstream's resolution.
      const index = makeIndex(vault, { appConfig: loadConfig() });
      const report = await index.rebuild({ collection: COLLECTION });

      expect(report.embeddingsActive).toBe(false);
      const response = await index.search({
        query: "embeddologist",
        collection: COLLECTION,
      });
      expect(response.results).toHaveLength(1);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("rebuilds from discovery when the manifest has been lost", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/manifestless",
      title: "Manifestless",
      body: body("palimpsest"),
    });
    vault.notes.set(note.path, note.markdown);

    const index = makeIndex(vault);
    await index.rebuild({ collection: COLLECTION });

    fs.rmSync(path.join(activeGenerationDir(index), "manifest.json"));

    const response = await index.search({ query: "palimpsest", collection: COLLECTION });
    expect(response.results).toHaveLength(1);
    expect(response.results[0].vault_path).toBe(note.path);
  });

  it("keeps the previous generation active when a rebuild fails", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/durable",
      title: "Durable",
      body: body("obstinate"),
    });
    vault.notes.set(note.path, note.markdown);

    const index = makeIndex(vault);
    await index.rebuild({ collection: COLLECTION });
    const generation = activeGeneration(index);

    vault.unreadable.add(note.path);
    await expect(index.rebuild({ collection: COLLECTION })).rejects.toThrow();

    expect(activeGeneration(index)).toBe(generation);
    vault.unreadable.delete(note.path);
    const response = await index.search({ query: "obstinate", collection: COLLECTION });
    expect(response.results).toHaveLength(1);
  });

  it("refuses to take its own non-reentrant lock twice", async () => {
    const index = makeIndex(new FakeVault());
    await expect(
      index.withIndexLock(async () => index.withIndexLock(async () => "nested")),
    ).rejects.toThrow(/already held/);
  });

  it("times out rather than waiting forever for a lock another holder owns", async () => {
    const vault = new FakeVault();
    const holder = makeIndex(vault);
    const contender = makeIndex(vault, { lock: { timeoutMs: 120, pollMs: 10 } });

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holding = holder.withIndexLock(() => held);
    await expect(
      contender.search({ query: "anything", collection: COLLECTION }),
    ).rejects.toBeInstanceOf(LockTimeoutError);

    release();
    await holding;
  });

  it("indexes a capture that publishes and is then edited during a rebuild", async () => {
    const vault = new FakeVault();
    const existing = sourceNote({
      url: "https://example.com/existing",
      title: "Existing",
      body: body("antecedent"),
    });
    vault.notes.set(existing.path, existing.markdown);

    const rebuilder = makeIndex(vault);
    const capturer = makeIndex(vault, { lock: { timeoutMs: 10_000, pollMs: 10 } });

    // An explicit barrier, not a sleep: the rebuild announces that discovery
    // has begun and then waits, so everything below is guaranteed to happen
    // while the rebuild owns the lock.
    let discoveryStarted = (): void => undefined;
    const discovering = new Promise<void>((resolve) => {
      discoveryStarted = resolve;
    });
    let releaseDiscovery = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    let announced = false;
    vault.hooks.push(async (args) => {
      if (args[0] !== "read" || announced) return;
      announced = true;
      discoveryStarted();
      await held;
    });

    const rebuilding = rebuilder.rebuild({ collection: COLLECTION });
    await discovering;

    // The capture publishes while the rebuild holds the lock, so its index
    // update is queued behind the rebuild.
    const published = sourceNote({
      url: "https://example.com/concurrent",
      title: "Concurrent",
      body: body("interleaved"),
    });
    vault.notes.set(published.path, published.markdown);
    const offered = entryFor(published);
    const indexing = capturer.upsert(offered);

    // ...and while it is still queued, a human edits the very note it is
    // waiting to index. The bytes it was handed are now history.
    const edited = published.markdown.replace(/interleaved/g, "interpolated");
    vault.notes.set(published.path, edited);

    releaseDiscovery();
    const report = await rebuilding;
    const upserted = await indexing;

    expect(upserted.status).toBe("indexed");
    expect(upserted.refreshed).toBe(true);
    expect(upserted.digest).toBe(sha256(edited));
    expect(activeGeneration(capturer)).toBe(report.generation);

    // The queued update landed in the generation the rebuild promoted, and it
    // carries the edited bytes rather than the ones the capture was holding.
    const current = await capturer.search({
      query: "interpolated",
      collection: COLLECTION,
    });
    expect(current.results.map((r) => r.vault_path)).toEqual([published.path]);
    expect(current.results[0].digest).toBe(sha256(edited));

    const stale = await capturer.search({
      query: "interleaved",
      collection: COLLECTION,
    });
    expect(stale.results).toEqual([]);

    expect(
      capturer
        .manifestEntries(COLLECTION)
        .map((e) => e.vaultPath)
        .sort(),
    ).toEqual([existing.path, published.path].sort());
  });

  it("refreshes a stale hit and reruns the search once", async () => {
    const vault = new FakeVault();
    const note = sourceNote({
      url: "https://example.com/stale",
      title: "Stale",
      body: body("staleness"),
    });
    vault.notes.set(note.path, note.markdown);

    const index = makeIndex(vault);
    await index.rebuild({ collection: COLLECTION });

    // Edited behind the index's back: the stored digest no longer matches.
    const edited = note.markdown.replace("Further prose", "Freshened prose");
    vault.notes.set(note.path, edited);

    const response = await index.search({ query: "staleness", collection: COLLECTION });
    expect(response.refreshed).toBe(1);
    expect(response.status).toBe("ok");
    expect(response.results[0].digest).toBe(sha256(edited));
  });

  describe("two collections", () => {
    const OTHER = "toolbox";

    /** One managed note in each of two collections. */
    function twoCollections(vault: FakeVault): {
      inboxNote: ReturnType<typeof sourceNote>;
      otherNote: ReturnType<typeof sourceNote>;
    } {
      const inboxNote = sourceNote({
        url: "https://example.com/inboxed",
        title: "Inboxed",
        body: body("inboxical"),
      });
      const otherNote = sourceNote({
        url: "https://example.com/toolboxed",
        title: "Toolboxed",
        body: body("toolboxical"),
        collection: OTHER,
      });
      vault.notes.set(inboxNote.path, inboxNote.markdown);
      vault.notes.set(otherNote.path, otherNote.markdown);
      return { inboxNote, otherNote };
    }

    it("leaves the other collection searchable when one is rebuilt", async () => {
      const vault = new FakeVault();
      const { inboxNote, otherNote } = twoCollections(vault);
      const index = makeIndex(vault);

      await index.rebuild({ collection: COLLECTION });
      await index.rebuild({ collection: OTHER });

      // Rebuilding either one again must not cost the other its index. The
      // manifest is read first and directly: a search would rebuild a lost
      // manifest on the spot and hide the loss it is meant to detect.
      await index.rebuild({ collection: COLLECTION });
      expect(index.manifestEntries(OTHER).map((e) => e.vaultPath)).toEqual([
        otherNote.path,
      ]);
      expect(
        (await index.search({ query: "toolboxical", collection: OTHER })).results.map(
          (r) => r.vault_path,
        ),
      ).toEqual([otherNote.path]);

      await index.rebuild({ collection: OTHER });
      expect(index.manifestEntries(COLLECTION).map((e) => e.vaultPath)).toEqual([
        inboxNote.path,
      ]);
      expect(
        (await index.search({ query: "inboxical", collection: COLLECTION })).results.map(
          (r) => r.vault_path,
        ),
      ).toEqual([inboxNote.path]);
    });

    it("keeps one collection's pointer untouched while another is rebuilt", async () => {
      const vault = new FakeVault();
      twoCollections(vault);
      const index = makeIndex(vault);

      await index.rebuild({ collection: COLLECTION });
      await index.rebuild({ collection: OTHER });
      const otherGeneration = activeGeneration(index, OTHER);

      await index.rebuild({ collection: COLLECTION });

      expect(activeGeneration(index, OTHER)).toBe(otherGeneration);
      expect(index.collectionRoot(COLLECTION)).not.toBe(index.collectionRoot(OTHER));
    });

    it("reconstructs every collection after the whole index is deleted", async () => {
      const vault = new FakeVault();
      const { inboxNote, otherNote } = twoCollections(vault);

      const first = makeIndex(vault);
      await first.rebuild({ collection: COLLECTION });
      await first.rebuild({ collection: OTHER });
      await first.shutdown();

      fs.rmSync(path.join(stateDir, "index"), { recursive: true, force: true });

      const second = makeIndex(vault);
      await second.rebuild({ collection: COLLECTION });
      await second.rebuild({ collection: OTHER });

      // Both indexes exist after the two rebuilds, before anything searches:
      // reconstruction is what the rebuilds did, not what a later search had
      // to repair.
      expect(second.manifestEntries(COLLECTION).map((e) => e.vaultPath)).toEqual([
        inboxNote.path,
      ]);
      expect(second.manifestEntries(OTHER).map((e) => e.vaultPath)).toEqual([
        otherNote.path,
      ]);

      const inbox = await second.search({ query: "inboxical", collection: COLLECTION });
      const other = await second.search({ query: "toolboxical", collection: OTHER });

      expect(inbox.results.map((r) => r.vault_path)).toEqual([inboxNote.path]);
      expect(inbox.results[0].digest).toBe(sha256(inboxNote.markdown));
      expect(other.results.map((r) => r.vault_path)).toEqual([otherNote.path]);
      expect(other.results[0].digest).toBe(sha256(otherNote.markdown));
      expect(vault.writes).toEqual([]);
    });

    it("keeps a capture into one collection out of the other's index", async () => {
      const vault = new FakeVault();
      const { inboxNote, otherNote } = twoCollections(vault);
      const index = makeIndex(vault);

      await index.rebuild({ collection: COLLECTION });
      await index.rebuild({ collection: OTHER });

      const extra = sourceNote({
        url: "https://example.com/extra",
        title: "Extra",
        body: body("extraneous"),
      });
      vault.notes.set(extra.path, extra.markdown);
      await index.upsert(entryFor(extra));

      expect(index.manifestEntries(OTHER).map((e) => e.vaultPath)).toEqual([
        otherNote.path,
      ]);
      expect(
        index
          .manifestEntries(COLLECTION)
          .map((e) => e.vaultPath)
          .sort(),
      ).toEqual([inboxNote.path, extra.path].sort());
      expect(
        (await index.search({ query: "extraneous", collection: OTHER })).results,
      ).toEqual([]);
    });
  });

  describe("version identity", () => {
    /** One URL captured at two versions whose labels differ only in case. */
    function caseDistinctVersions(vault: FakeVault): {
      upper: ReturnType<typeof sourceNote>;
      lower: ReturnType<typeof sourceNote>;
    } {
      const url = "https://example.com/cased";
      const upper = sourceNote({
        url,
        title: "Cased",
        body: body("uppercasium"),
        version: "Release",
      });
      const lower = sourceNote({
        url,
        title: "Cased",
        body: body("lowercasium"),
        version: "release",
      });
      vault.notes.set(upper.path, upper.markdown);
      vault.notes.set(lower.path, lower.markdown);
      return { upper, lower };
    }

    it("keeps two case-distinct versions of one URL as two separate documents", async () => {
      const vault = new FakeVault();
      const { upper, lower } = caseDistinctVersions(vault);
      expect(upper.path).not.toBe(lower.path);

      const index = makeIndex(vault);
      await index.rebuild({ collection: COLLECTION });
      expect(index.manifestEntries(COLLECTION)).toHaveLength(2);

      const capital = await index.search({
        query: "uppercasium",
        collection: COLLECTION,
        version: "Release",
      });
      expect(capital.status).toBe("ok");
      expect(capital.results).toHaveLength(1);
      expect(capital.results[0]).toMatchObject({
        vault_path: upper.path,
        version: "Release",
        digest: sha256(upper.markdown),
      });
      expect(capital.results[0].excerpt).toContain("uppercasium");
      expect(capital.results[0].excerpt).not.toContain("lowercasium");

      const small = await index.search({
        query: "lowercasium",
        collection: COLLECTION,
        version: "release",
      });
      expect(small.status).toBe("ok");
      expect(small.results).toHaveLength(1);
      expect(small.results[0]).toMatchObject({
        vault_path: lower.path,
        version: "release",
        digest: sha256(lower.markdown),
      });
      expect(small.results[0].excerpt).toContain("lowercasium");
      expect(small.results[0].excerpt).not.toContain("uppercasium");
    });

    it("never answers one version's query with another version's text", async () => {
      const vault = new FakeVault();
      const { upper } = caseDistinctVersions(vault);

      const index = makeIndex(vault);
      await index.rebuild({ collection: COLLECTION });

      // The other version's distinctive word, asked for under this version.
      const crossed = await index.search({
        query: "lowercasium",
        collection: COLLECTION,
        version: "Release",
      });
      expect(crossed.results).toEqual([]);
      expect(crossed.omitted).toEqual([]);

      // And the one that does belong here still resolves to its own note.
      const own = await index.search({
        query: "uppercasium",
        collection: COLLECTION,
        version: "Release",
      });
      expect(own.results[0].vault_path).toBe(upper.path);
    });

    it("answers a version lookup that differs only in case as a clean miss", async () => {
      const vault = new FakeVault();
      const note = sourceNote({
        url: "https://example.com/onlyupper",
        title: "Only Upper",
        body: body("solitarium"),
        version: "Release",
      });
      vault.notes.set(note.path, note.markdown);

      const index = makeIndex(vault);
      await index.rebuild({ collection: COLLECTION });

      // `Release` and `release` are different source identities by the
      // publication contract, so the miss is the correct answer — what must
      // never happen is an unmappable hit or another version's content.
      const wrongCase = await index.search({
        query: "solitarium",
        collection: COLLECTION,
        version: "release",
      });
      expect(wrongCase.status).toBe("ok");
      expect(wrongCase.results).toEqual([]);
      expect(wrongCase.omitted).toEqual([]);

      const rightCase = await index.search({
        query: "solitarium",
        collection: COLLECTION,
        version: "Release",
      });
      expect(rightCase.results.map((r) => r.vault_path)).toEqual([note.path]);
    });

    it("upserts a case-distinct version without replacing its sibling", async () => {
      const vault = new FakeVault();
      const { upper, lower } = caseDistinctVersions(vault);

      const index = makeIndex(vault);
      await index.upsert(entryFor(upper));
      await index.upsert(entryFor(lower));

      expect(index.manifestEntries(COLLECTION)).toHaveLength(2);
      const capital = await index.search({
        query: "uppercasium",
        collection: COLLECTION,
        version: "Release",
      });
      expect(capital.results.map((r) => r.vault_path)).toEqual([upper.path]);
    });
  });

  describe("rebuild verification", () => {
    /** A body of `sections` headed sections, each mentioning `phrase`. */
    function longBody(phrase: string, sections: number): string {
      const parts: string[] = [`# ${phrase} handbook`, ""];
      for (let n = 0; n < sections; n += 1) {
        parts.push(
          `## ${phrase} chapter ${n}`,
          "",
          `The ${phrase} procedure is documented here for operators. `.repeat(30),
          "",
        );
      }
      return parts.join("\n");
    }

    it("promotes a generation whose ranked search would have hidden a sampled note", async () => {
      const vault = new FakeVault();

      // One long document contributing many chunks that all match the shared
      // token, beside several near-identical short ones.
      const crowder = sourceNote({
        url: "https://example.com/crowder",
        title: "Crowder",
        body: longBody("polyphonic", 14),
      });
      vault.notes.set(crowder.path, crowder.markdown);

      const neighbours = ["alpha", "beta", "gamma"].map((name) => {
        const note = sourceNote({
          url: `https://example.com/${name}`,
          title: name,
          body: `# ${name}\n\n${`The polyphonic procedure is documented here. `.repeat(12)}\n`,
        });
        vault.notes.set(note.path, note.markdown);
        return note;
      });

      const index = makeIndex(vault);
      const report = await index.rebuild({ collection: COLLECTION });

      expect(report.notesIndexed).toBe(4);
      expect(report.chunks).toBeGreaterThan(report.notesIndexed + PROBE_LIMIT_MARGIN);

      // The fixture reproduces the ranking artefact a ranked probe would have
      // tripped over: with the limit the old verification used, the crowder's
      // chunks fill the answer and a sound neighbour is nowhere in it.
      const ranked = await index.search({
        query: "polyphonic",
        collection: COLLECTION,
        limit: report.notesIndexed + PROBE_LIMIT_MARGIN,
      });
      const rankedPaths = ranked.results.map((r) => r.vault_path);
      expect(rankedPaths).toContain(crowder.path);
      expect(neighbours.some((note) => !rankedPaths.includes(note.path))).toBe(true);

      // Verification nonetheless promoted the generation, and every note is
      // retrievable by its own content.
      for (const note of [crowder, ...neighbours]) {
        const hit = await index.search({
          query: note.document.title,
          collection: COLLECTION,
          limit: 50,
        });
        expect(hit.results.map((r) => r.vault_path)).toContain(note.path);
      }
    });

    it("records the chunk count it persisted for every note", async () => {
      const vault = new FakeVault();
      const note = sourceNote({
        url: "https://example.com/counted",
        title: "Counted",
        body: longBody("countable", 6),
      });
      vault.notes.set(note.path, note.markdown);

      const index = makeIndex(vault);
      const report = await index.rebuild({ collection: COLLECTION });
      const entries = index.manifestEntries(COLLECTION);

      expect(entries).toHaveLength(1);
      expect(entries[0].chunkCount).toBeGreaterThan(1);
      expect(entries[0].chunkCount).toBe(report.chunks);
      expect(storedChunks(index)).toHaveLength(report.chunks);
    });

    it("refuses to index either note of an ambiguous source identity", async () => {
      const vault = new FakeVault();
      const original = sourceNote({
        url: "https://example.com/ambiguous",
        title: "Ambiguous",
        body: body("ambiguum"),
      });
      vault.notes.set(original.path, original.markdown);
      // A human copied the note, so two paths now claim one identity.
      vault.notes.set(
        `${FOLDER}/A Hand Copied Duplicate.md`,
        original.markdown.replace(/ambiguum/g, "ambiguum duplicatum"),
      );

      const index = makeIndex(vault);
      const report = await index.rebuild({ collection: COLLECTION });

      expect(report.notesIndexed).toBe(0);
      expect(report.notesSkipped).toBeGreaterThanOrEqual(2);
      expect(index.manifestEntries(COLLECTION)).toEqual([]);
      expect(
        (await index.search({ query: "ambiguum", collection: COLLECTION })).results,
      ).toEqual([]);
      // Neither note left the vault.
      expect(vault.notes.has(original.path)).toBe(true);
      expect(vault.writes).toEqual([]);
    });
  });

  describe("failures after a generation has begun", () => {
    const LEGACY = `${FOLDER}/Legacy Inventory Note.md`;

    /** Builds a vault holding one managed note plus one inventory target. */
    function seeded(): {
      vault: FakeVault;
      note: ReturnType<typeof sourceNote>;
    } {
      const vault = new FakeVault();
      const note = sourceNote({
        url: "https://example.com/durable",
        title: "Durable",
        body: body("obstinate"),
      });
      vault.notes.set(note.path, note.markdown);
      return { vault, note };
    }

    it("keeps the prior generation when indexing fails part way through", async () => {
      const { vault, note } = seeded();
      const index = makeIndex(vault);
      await index.rebuild({ collection: COLLECTION });
      const generation = activeGeneration(index);

      // The inventory note is read inside the indexing pass, after the new
      // generation already holds the managed note, and its read fails hard.
      vault.unreadable.add(LEGACY);
      await expect(
        index.rebuild({ collection: COLLECTION, inventory: [LEGACY] }),
      ).rejects.toThrow(/vault backend unavailable/);

      expect(activeGeneration(index)).toBe(generation);
      const response = await index.search({ query: "obstinate", collection: COLLECTION });
      expect(response.results.map((r) => r.vault_path)).toEqual([note.path]);
    });

    it("keeps the prior generation when verification rejects what was persisted", async () => {
      const { vault, note } = seeded();
      const index = makeIndex(vault);
      await index.rebuild({ collection: COLLECTION });
      const generation = activeGeneration(index);

      // While the rebuild sits between indexing and verifying, the generation
      // it just filled stops matching what it recorded: the stored page moves
      // to a URL the manifest does not name. `pages` carries no vector trigger,
      // so this needs nothing the store itself would have to load.
      vault.hooks.push((args) => {
        if (args[0] !== "read" || args[1] !== LEGACY) return;
        const db = new Database(path.join(pendingGenerationDir(index), "documents.db"));
        try {
          db.prepare("UPDATE pages SET url = ?").run("https://example.com/ghosted");
        } finally {
          db.close();
        }
      });

      await expect(
        index.rebuild({ collection: COLLECTION, inventory: [LEGACY] }),
      ).rejects.toBeInstanceOf(IndexVerificationError);

      expect(activeGeneration(index)).toBe(generation);
      const response = await index.search({ query: "obstinate", collection: COLLECTION });
      expect(response.results.map((r) => r.vault_path)).toEqual([note.path]);
    });

    it("keeps the prior generation when the manifest cannot be written", async () => {
      const { vault, note } = seeded();
      const index = makeIndex(vault);
      await index.rebuild({ collection: COLLECTION });
      const generation = activeGeneration(index);

      let poisoned: string | null = null;
      vault.hooks.push((args) => {
        if (args[0] !== "read" || args[1] !== LEGACY || poisoned !== null) return;
        poisoned = pendingGenerationDir(index);
        fs.chmodSync(poisoned, 0o555);
      });

      try {
        await expect(
          index.rebuild({ collection: COLLECTION, inventory: [LEGACY] }),
        ).rejects.toThrow(/EACCES|permission denied/i);

        expect(activeGeneration(index)).toBe(generation);
        const response = await index.search({
          query: "obstinate",
          collection: COLLECTION,
        });
        expect(response.results.map((r) => r.vault_path)).toEqual([note.path]);
      } finally {
        if (poisoned !== null) fs.chmodSync(poisoned, 0o755);
      }
    });

    it("reports a note listed in the inventory that is not in the vault", async () => {
      const { vault, note } = seeded();
      const index = makeIndex(vault);

      const report = await index.rebuild({
        collection: COLLECTION,
        inventory: [LEGACY],
      });

      expect(report.notesIndexed).toBe(1);
      expect(report.noteReads).toBe(scanReadsPlus(vault, 1));
      expect(index.manifestEntries(COLLECTION).map((e) => e.vaultPath)).toEqual([
        note.path,
      ]);
      expect(vault.writes).toEqual([]);
    });
  });
});

/**
 * Margin the superseded ranked probe added to the note count when it chose a
 * result limit. Kept here so the fixture that reproduces its unsoundness says
 * what it is reproducing.
 */
const PROBE_LIMIT_MARGIN = 5;

/** Reads the fake vault made during a scan, plus `extra` inventory reads. */
function scanReadsPlus(vault: FakeVault, extra: number): number {
  return vault.notes.size + extra;
}
