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
  /** Awaited inside `read`, so a test can hold a scan open. */
  gate: Promise<void> | null = null;
  /** Paths whose read fails hard, for rebuild-failure coverage. */
  readonly unreadable = new Set<string>();

  run = async (args: string[], _stdin: string | null): Promise<CliResult> => {
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
      if (this.gate !== null) await this.gate;
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
}): { path: string; markdown: string; document: SourceDocument } {
  const document: SourceDocument = {
    sourceUrl: input.url,
    requestedUrl: input.url,
    collection: COLLECTION,
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

/** Reads the generation the pointer currently names. */
function activeGeneration(stateDir: string): string {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "index", "current.json"), "utf8"))
    .generation as string;
}

/** Reads every stored chunk of the active generation, straight from SQLite. */
function storedChunks(stateDir: string): { content: string; metadata: string }[] {
  const file = path.join(
    stateDir,
    "index",
    "generations",
    activeGeneration(stateDir),
    "documents.db",
  );
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
    const chunks = storedChunks(stateDir);
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
    expect(index.manifestEntries().map((e) => e.vaultPath)).toEqual([moved]);
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
    expect(index.manifestEntries()).toHaveLength(1);

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
    expect(index.manifestEntries()).toEqual([]);
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

    expect(index.manifestEntries().map((e) => e.vaultPath)).toEqual([note.path]);
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
    expect(index.manifestEntries()[0]).toMatchObject({
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
    expect(index.manifestEntries()).toHaveLength(2);

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
    const afterFirst = storedChunks(stateDir).length;

    const second = await index.upsert(entryFor(note));
    const afterSecond = storedChunks(stateDir).length;

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

    fs.rmSync(
      path.join(
        stateDir,
        "index",
        "generations",
        activeGeneration(stateDir),
        "manifest.json",
      ),
    );

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
    const generation = activeGeneration(stateDir);

    vault.unreadable.add(note.path);
    await expect(index.rebuild({ collection: COLLECTION })).rejects.toThrow();

    expect(activeGeneration(stateDir)).toBe(generation);
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

  it("indexes a capture that publishes during a rebuild into the new generation", async () => {
    const vault = new FakeVault();
    const existing = sourceNote({
      url: "https://example.com/existing",
      title: "Existing",
      body: body("antecedent"),
    });
    vault.notes.set(existing.path, existing.markdown);

    const rebuilder = makeIndex(vault);
    const capturer = makeIndex(vault, { lock: { timeoutMs: 10_000, pollMs: 10 } });

    // The rebuild's discovery is held open, so the capture below is guaranteed
    // to publish and request indexing while the rebuild owns the lock.
    let openGate = (): void => undefined;
    vault.gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const rebuilding = rebuilder.rebuild({ collection: COLLECTION });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const published = sourceNote({
      url: "https://example.com/concurrent",
      title: "Concurrent",
      body: body("interleaved"),
    });
    vault.notes.set(published.path, published.markdown);
    const indexing = capturer.upsert(entryFor(published));

    openGate();
    vault.gate = null;
    const report = await rebuilding;
    const upserted = await indexing;

    expect(upserted.status).toBe("indexed");
    expect(activeGeneration(stateDir)).toBe(report.generation);

    const response = await capturer.search({
      query: "interleaved",
      collection: COLLECTION,
    });
    expect(response.results.map((r) => r.vault_path)).toEqual([published.path]);
    expect(
      capturer
        .manifestEntries()
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
});
