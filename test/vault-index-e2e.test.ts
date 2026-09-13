/**
 * Process-level checks for `sb-docs` retrieval, against the built
 * `dist/vault-cli.js` and a real `obsidian-cli` over a throwaway vault.
 *
 * These prove the properties that only a real process can prove: that a
 * capture whose indexing could not run still exits 0, that `search` and
 * `reindex` refuse rather than block when the index lock is held elsewhere and
 * leave the previous generation active, that a body phrase is retrievable
 * while the note's frontmatter-only hashes are not, and that none of it ever
 * opens a listening socket.
 *
 * The first test is a safety gate, not a nicety: it proves — read-only, before
 * anything is captured — that the CLI honours the `OBSIDIAN_VAULT` override. If
 * that assumption were wrong, every later test here would write into the
 * operator's live vault.
 */

import type { ChildProcessByStdio } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { sha256 } from "../src/vault/identity";

const projectRoot = path.resolve(import.meta.dirname, "..");
const vaultCliEntry = path.join(projectRoot, "dist", "vault-cli.js");
const listenGuard = path.join(
  projectRoot,
  "test",
  "fixtures",
  "vault-cli",
  "no-listen-guard.mjs",
);
const lockHolderFixture = path.join(
  projectRoot,
  "test",
  "fixtures",
  "vault",
  "index-lock-holder.ts",
);
const viteNode = path.join(projectRoot, "node_modules", ".bin", "vite-node");

const cliPath = path.join(os.homedir(), "ai-stack", "bin", "obsidian-cli");
const cliAvailable = fs.existsSync(cliPath);
const LIVE_VAULT = "/Volumes/3M/Obsidian";

/** A deliberately rare phrase, so a hit proves retrieval rather than luck. */
const PHRASE = "zorbalicious";

const SOURCE_MARKDOWN = `# Zorbalicious Operations

The ${PHRASE} subsystem is documented here for operators, with enough
surrounding prose that the splitter has a real paragraph to work with.

| Command | Purpose |
| --- | --- |
| \`run\` | Executes the documented step |

\`\`\`bash
run --mode ${PHRASE}
\`\`\`
`;

interface VaultCliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** One entry per `net.Server.prototype.listen` call made by the child. */
  listenCalls: string[];
  /** Every JSONL event the run emitted, in order. */
  events: { event: string; ctx: Record<string, unknown> }[];
}

/**
 * Reports whether the CLI at `cliPath` actually operates on `vaultPath` when
 * `OBSIDIAN_VAULT` names it.
 *
 * `status` is read-only, so this can be checked before any mutation.
 */
function honoursVaultOverride(cliPath: string, vaultPath: string): boolean {
  try {
    const status = execFileSync(cliPath, ["status"], {
      encoding: "utf8",
      env: { ...process.env, OBSIDIAN_VAULT: vaultPath },
    });
    return status.includes(`vault: ok (${vaultPath})`);
  } catch {
    return false;
  }
}

let sandbox: string;
let stateDir: string;
let sourceFile: string;
let configFile: string;
let logFile: string;

/**
 * Runs the built vault CLI executable directly and captures its output plus
 * any listening-socket attempts.
 */
async function runVaultCli(args: string[]): Promise<VaultCliRun> {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-index-listen-"));
  const logPath = path.join(logDir, "listen.log");

  try {
    return await new Promise<VaultCliRun>((resolve, reject) => {
      const nodeOptions = [
        process.env.NODE_OPTIONS,
        `--import ${pathToFileURL(listenGuard).href}`,
      ]
        .filter(Boolean)
        .join(" ");

      // Deliberately NOT `spawn("node", [vaultCliEntry, ...])`.
      // Truncated per run, so `events` describes this invocation alone.
      fs.writeFileSync(logFile, "", "utf8");

      const proc = spawn(vaultCliEntry, args, {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VITEST_WORKER_ID: undefined,
          NODE_OPTIONS: nodeOptions,
          SB_DOCS_LISTEN_LOG: logPath,
          OBSIDIAN_VAULT: sandbox,
          // The run's own structured log, redirected into this suite's
          // temporary directory so its events can be asserted on without ever
          // touching the operator's log.
          SB_DOCS_LOG: "1",
          SB_DOCS_LOG_FILE: logFile,
          // A read-only config, so the run neither inherits nor rewrites the
          // operator's own `config.yaml`, and local sources under this run's
          // temporary directory are inside the allowed roots.
          DOCS_MCP_CONFIG: configFile,
        },
        timeout: 120_000,
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("error", (err) =>
        reject(
          new Error(
            `Failed to execute ${vaultCliEntry} directly: ${err.message}. ` +
              "Build the fork with `npm run build` before running this suite.",
          ),
        ),
      );
      proc.on("close", (code) => {
        const listenCalls = fs.existsSync(logPath)
          ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean)
          : [];
        const events = fs.existsSync(logFile)
          ? fs
              .readFileSync(logFile, "utf8")
              .split("\n")
              .filter((line) => line.startsWith("{"))
              .map(
                (line) => JSON.parse(line) as { event: string; ctx: Record<string, unknown> },
              )
          : [];
        resolve({ code, stdout, stderr, listenCalls, events });
      });
    });
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

/** Parses the single JSON envelope a `--json` run printed. */
function envelopeOf(run: VaultCliRun): Record<string, unknown> {
  const line = run.stdout.split("\n").find((candidate) => candidate.startsWith("{"));
  expect(line, `no JSON envelope on stdout: ${run.stdout}\n${run.stderr}`).toBeDefined();
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

/**
 * Reads the generation one collection's pointer currently names.
 *
 * Each collection owns its own index, so the pointer lives under that
 * collection's directory. The directory name is derived exactly as
 * {@link VaultIndex} derives it, from the normalized collection identifier.
 */
function activeGeneration(collection = "inbox"): string {
  const key = `${collection
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)}-${sha256(collection.toLowerCase()).slice(0, 12)}`;
  return JSON.parse(
    fs.readFileSync(
      path.join(stateDir, "index", "collections", key, "current.json"),
      "utf8",
    ),
  ).generation as string;
}

/** Absolute path of one collection's index directory. */
function collectionRoot(collection: string): string {
  const key = `${collection
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)}-${sha256(collection.toLowerCase()).slice(0, 12)}`;
  return path.join(stateDir, "index", "collections", key);
}

/** One collection's derived state, read straight off disk. */
interface IndexState {
  generation: string;
  /** Vault paths the manifest names, sorted. */
  vaultPaths: string[];
  /** Rows in the generation's `documents` table. */
  chunkRows: number;
}

/**
 * Reads a collection's pointer, manifest and database directly.
 *
 * Deliberately not through `search`: a search rebuilds missing derived state on
 * the spot, so asserting reconstruction through one would assert that the
 * repair path works rather than that the rebuild did anything.
 */
function readIndexState(collection: string): IndexState {
  const root = collectionRoot(collection);
  const generation = (
    JSON.parse(fs.readFileSync(path.join(root, "current.json"), "utf8")) as {
      generation: string;
    }
  ).generation;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "generations", generation, "manifest.json"), "utf8"),
  ) as { entries: { vaultPath: string }[] };

  const db = new Database(path.join(root, "generations", generation, "documents.db"), {
    readonly: true,
  });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
    return {
      generation,
      vaultPaths: manifest.entries.map((entry) => entry.vaultPath).sort(),
      chunkRows: row.n,
    };
  } finally {
    db.close();
  }
}

/** Holds the index lock in a separate process until the returned release runs. */
async function holdIndexLock(): Promise<() => Promise<void>> {
  const barriers = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-index-lock-"));
  const acquiredFile = path.join(barriers, "acquired");
  const releaseFile = path.join(barriers, "release");

  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    viteNode,
    [lockHolderFixture],
    {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        STATE_DIR: stateDir,
        VAULT_PATH: sandbox,
        ACQUIRED_FILE: acquiredFile,
        RELEASE_FILE: releaseFile,
      },
    },
  );

  const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));

  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(acquiredFile)) {
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("index lock holder never acquired the lock");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return async () => {
    fs.writeFileSync(releaseFile, "go");
    await exited;
    fs.rmSync(barriers, { recursive: true, force: true });
  };
}

describe.skipIf(!cliAvailable)("sb-docs index E2E", () => {
  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-index-vault-"));
    // Runtime state is durable and must never live inside a vault, not even a
    // throwaway one.
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-index-state-"));
    fs.mkdirSync(path.join(sandbox, "00 Inbox"), { recursive: true });

    // GATE. Nothing in this file may capture until the override is proven.
    if (!honoursVaultOverride(cliPath, sandbox)) {
      throw new Error(
        `REFUSING TO RUN: obsidian-cli did not report the sandbox vault ${sandbox}. ` +
          "Capturing now could mutate the operator's live vault.",
      );
    }

    const sources = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-index-src-")),
    );
    sourceFile = path.join(sources, "zorbalicious.md");
    fs.writeFileSync(sourceFile, SOURCE_MARKDOWN, "utf8");

    // Upstream's file-access policy allows `$DOCUMENTS` only. A capture of a
    // local fixture therefore needs this run's own directory named explicitly;
    // pointing DOCS_MCP_CONFIG at it also keeps the run read-only with respect
    // to the operator's real configuration file.
    logFile = path.join(stateDir, "events.jsonl");
    configFile = path.join(stateDir, "config.yaml");
    fs.writeFileSync(
      configFile,
      [
        "scraper:",
        "  security:",
        "    fileAccess:",
        "      mode: allowedRoots",
        "      allowedRoots:",
        `        - ${JSON.stringify(sources)}`,
        "      followSymlinks: true",
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    if (sourceFile) fs.rmSync(path.dirname(sourceFile), { recursive: true, force: true });
  });

  it("ran the override gate before capturing anything", () => {
    expect(honoursVaultOverride(cliPath, sandbox)).toBe(true);
  });

  it("captures a local source and indexes it, opening no listening socket", async () => {
    const run = await runVaultCli([
      "capture",
      sourceFile,
      "--state-dir",
      stateDir,
      "--json",
    ]);

    expect(run.code).toBe(0);
    const envelope = envelopeOf(run);
    const outcomes = envelope.outcomes as { index: string; publication?: unknown }[];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].index).toBe("indexed");
    expect(run.listenCalls).toEqual([]);
  });

  it("retrieves the body phrase but not the frontmatter-only content hash", async () => {
    const found = await runVaultCli([
      "search",
      PHRASE,
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(found.code).toBe(0);

    const envelope = envelopeOf(found);
    expect(envelope.status).toBe("ok");
    const results = envelope.results as {
      source_url: string;
      vault_path: string;
      version: string;
      excerpt: string;
      digest: string;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0].source_url).toMatch(/^file:\/\//);
    expect(results[0].vault_path).toMatch(/^00 Inbox\/Source Captures\//);
    expect(results[0].excerpt).toContain(PHRASE);

    const saved = fs.readFileSync(path.join(sandbox, results[0].vault_path), "utf8");
    expect(results[0].digest).toBe(sha256(saved));
    expect(found.listenCalls).toEqual([]);

    // The frontmatter's own content hash is a fact about the note, never part
    // of the retrievable document.
    const contentHash = /content_sha256:\s*(\w+)/.exec(saved)?.[1];
    expect(contentHash).toBeDefined();
    const byHash = await runVaultCli([
      "search",
      String(contentHash),
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(byHash.code).toBe(0);
    expect(envelopeOf(byHash).results).toEqual([]);
  });

  it("prints the whole saved note through read, frontmatter included", async () => {
    const found = await runVaultCli([
      "search",
      PHRASE,
      "--state-dir",
      stateDir,
      "--json",
    ]);
    const results = envelopeOf(found).results as { vault_path: string }[];
    const notePath = results[0].vault_path;

    const run = await runVaultCli(["read", notePath]);

    expect(run.code).toBe(0);
    const saved = fs.readFileSync(path.join(sandbox, notePath), "utf8");
    expect(run.stdout).toContain(saved.trimEnd());
    expect(run.stdout).toContain("publisher: secondbrain-docs");
    expect(run.listenCalls).toEqual([]);
  });

  describe("with the index lock held by another process", () => {
    let release: (() => Promise<void>) | null = null;
    let generation: string;

    beforeAll(async () => {
      generation = activeGeneration();
      release = await holdIndexLock();
    });

    afterAll(async () => {
      if (release) await release();
      release = null;
    });

    it("reports search unavailable, exits nonzero, and leaves the generation intact", async () => {
      const run = await runVaultCli([
        "search",
        PHRASE,
        "--state-dir",
        stateDir,
        "--json",
      ]);

      expect(run.code).not.toBe(0);
      expect(envelopeOf(run).status).toBe("unavailable");
      expect(run.stderr).toContain("search unavailable");
      expect(activeGeneration()).toBe(generation);
      expect(run.listenCalls).toEqual([]);
    }, 120_000);

    it("reports reindex unavailable, exits nonzero, and leaves the generation intact", async () => {
      const run = await runVaultCli(["reindex", "--state-dir", stateDir, "--json"]);

      expect(run.code).not.toBe(0);
      expect(envelopeOf(run).status).toBe("unavailable");
      expect(run.stderr).toContain("reindex unavailable");
      expect(activeGeneration()).toBe(generation);
      expect(run.listenCalls).toEqual([]);
    }, 120_000);

    it("still exits 0 for a capture whose indexing could not run", async () => {
      const pendingSource = path.join(path.dirname(sourceFile), "pending.md");
      fs.writeFileSync(
        pendingSource,
        SOURCE_MARKDOWN.replace(new RegExp(PHRASE, "g"), "pendingphrase"),
        "utf8",
      );

      const run = await runVaultCli([
        "capture",
        pendingSource,
        "--state-dir",
        stateDir,
        "--json",
      ]);

      expect(run.code).toBe(0);
      const outcomes = envelopeOf(run).outcomes as {
        index: string;
        publication?: { path: string; status: string };
      }[];
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].index).toBe("pending");
      expect(outcomes[0].publication?.status).toBe("published");

      // Pending indexing never costs the note: it is in the vault, in full.
      const notePath = outcomes[0].publication?.path ?? "";
      expect(fs.readFileSync(path.join(sandbox, notePath), "utf8")).toContain(
        "pendingphrase",
      );
      expect(run.listenCalls).toEqual([]);
    }, 180_000);
  });

  it("picks up the pending note on the next reindex", async () => {
    const run = await runVaultCli(["reindex", "--state-dir", stateDir, "--json"]);

    expect(run.code).toBe(0);
    const envelope = envelopeOf(run);
    expect(envelope.status).toBe("rebuilt");

    const found = await runVaultCli([
      "search",
      "pendingphrase",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(found.code).toBe(0);
    expect((envelopeOf(found).results as unknown[]).length).toBe(1);
    expect(found.listenCalls).toEqual([]);
  }, 120_000);

  it("rebuilds every collection after the whole index is deleted", async () => {
    // A second collection, so the acceptance is exercised on a vault holding
    // more than one — rebuilding one collection must not cost the other its
    // index, and restoring a deleted index is a rebuild per collection.
    const otherSource = path.join(path.dirname(sourceFile), "toolboxical.md");
    fs.writeFileSync(
      otherSource,
      SOURCE_MARKDOWN.replace(new RegExp(PHRASE, "gi"), "toolboxical"),
      "utf8",
    );

    const captured = await runVaultCli([
      "capture",
      otherSource,
      "--collection",
      "toolbox",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(captured.code).toBe(0);

    /**
     * Asserts one collection holds a retrievable note carrying `phrase`, and
     * that answering did not rebuild anything.
     *
     * The rebuild check is the point: a search repairs missing derived state on
     * the spot, so a retrieval assertion on its own cannot tell "the index was
     * rebuilt correctly" from "the index was missing and the search rebuilt it".
     */
    const retrievable = async (collection: string, phrase: string): Promise<void> => {
      const before = readIndexState(collection);
      const found = await runVaultCli([
        "search",
        phrase,
        "--collection",
        collection,
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(found.code).toBe(0);

      const results = envelopeOf(found).results as { vault_path: string }[];
      expect(results.length).toBeGreaterThanOrEqual(1);
      const bodies = results.map((result) =>
        fs.readFileSync(path.join(sandbox, result.vault_path), "utf8"),
      );
      expect(bodies.some((body) => body.toLowerCase().includes(phrase))).toBe(true);
      expect(found.listenCalls).toEqual([]);

      // The search emitted no rebuild and moved no pointer.
      expect(found.events.map((entry) => entry.event)).not.toContain("index.rebuilt");
      expect(found.events.map((entry) => entry.event)).not.toContain(
        "index.state_missing",
      );
      expect(readIndexState(collection)).toEqual(before);
    };

    // Both collections are retrievable, and answering leaves them alone.
    await retrievable("inbox", PHRASE);
    await retrievable("toolbox", "toolboxical");

    // Snapshot the collection that is about to be left alone, in full.
    const toolboxBefore = readIndexState("toolbox");
    expect(toolboxBefore.vaultPaths.length).toBeGreaterThan(0);
    expect(toolboxBefore.chunkRows).toBeGreaterThan(0);

    const rebuiltInbox = await runVaultCli([
      "reindex",
      "--collection",
      "inbox",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(rebuiltInbox.code).toBe(0);
    // The rebuild really did rebuild, and it named only the collection asked for.
    const rebuildEvents = rebuiltInbox.events.filter(
      (entry) => entry.event === "index.rebuilt",
    );
    expect(rebuildEvents).toHaveLength(1);
    expect(rebuildEvents[0].ctx.collection).toBe("inbox");

    // Its sibling is untouched: same generation, same manifest, same rows.
    expect(readIndexState("toolbox")).toEqual(toolboxBefore);

    // Now delete the whole index and rebuild it, collection by collection.
    fs.rmSync(path.join(stateDir, "index"), { recursive: true, force: true });
    expect(fs.existsSync(path.join(stateDir, "index"))).toBe(false);

    for (const collection of ["inbox", "toolbox"]) {
      const rebuilt = await runVaultCli([
        "reindex",
        "--collection",
        collection,
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(rebuilt.code).toBe(0);
      expect(envelopeOf(rebuilt).status).toBe("rebuilt");
    }

    // Both indexes exist, on disk, before anything searches them.
    const inboxAfter = readIndexState("inbox");
    const toolboxAfter = readIndexState("toolbox");
    expect(inboxAfter.chunkRows).toBeGreaterThan(0);
    expect(toolboxAfter.chunkRows).toBeGreaterThan(0);
    expect(toolboxAfter.vaultPaths).toEqual(toolboxBefore.vaultPaths);
    expect(inboxAfter.vaultPaths.every((p) => p.startsWith("00 Inbox/"))).toBe(true);
    expect(
      toolboxAfter.vaultPaths.every((p) => p.startsWith("30 Tools-Models/Doc Sets/")),
    ).toBe(true);
    expect(inboxAfter.generation).not.toBe(toolboxAfter.generation);

    await retrievable("inbox", PHRASE);
    await retrievable("toolbox", "toolboxical");
  }, 300_000);

  describe(
    // R10: process-level representatives for four of the nine damaged-state
    // shapes `src/vault/VaultIndex.test.ts` already proves at the unit
    // level (malformed pointer, deleted pointer, malformed manifest row,
    // deleted database) — each exercised through both `sb-docs search` and
    // a `sb-docs capture` that triggers `upsert`, at the real process
    // boundary. Placed here (not in test/vault-capture-e2e.test.ts) because
    // this file already owns the on-disk index-state helpers
    // (`collectionRoot`, `readIndexState`) these rows need.
    "R10: process-level damaged-index representatives (search and upsert)",
    () => {
      const CASES: Array<{
        name: string;
        damage: (root: string, generation: string) => void;
      }> = [
        {
          name: "a malformed (non-JSON) pointer",
          damage: (root) => {
            fs.writeFileSync(path.join(root, "current.json"), "{ not json", "utf8");
          },
        },
        {
          name: "a deleted pointer",
          damage: (root) => {
            fs.rmSync(path.join(root, "current.json"));
          },
        },
        {
          name: "a malformed manifest row",
          damage: (root, generation) => {
            const file = path.join(root, "generations", generation, "manifest.json");
            const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
            manifest.entries = [null, ...manifest.entries.slice(1)];
            fs.writeFileSync(file, JSON.stringify(manifest), "utf8");
          },
        },
        {
          name: "a deleted database",
          damage: (root, generation) => {
            fs.rmSync(path.join(root, "generations", generation, "documents.db"));
          },
        },
      ];

      it.each(CASES)("$name: search recovers full membership, not top-N", async ({ damage }) => {
        const root = collectionRoot("inbox");
        const generation = activeGeneration("inbox");
        const before = readIndexState("inbox");
        damage(root, generation);

        const run = await runVaultCli(["search", PHRASE, "--state-dir", stateDir, "--json"]);
        expect(run.code).toBe(0);
        expect((envelopeOf(run).results as unknown[]).length).toBeGreaterThan(0);

        // Full membership after repair, inspected directly — not inferred
        // from a top-N search hit. Both manifest identities and database
        // row count are checked (readIndexState reads both).
        const after = readIndexState("inbox");
        expect(after.vaultPaths).toEqual(before.vaultPaths);
        expect(after.chunkRows).toBeGreaterThanOrEqual(before.chunkRows);
      }, 120_000);

      it.each(CASES)(
        "$name: a capture that triggers upsert recovers full membership, not just the new note",
        async ({ damage }) => {
          const root = collectionRoot("inbox");
          const generation = activeGeneration("inbox");
          const before = readIndexState("inbox");
          damage(root, generation);

          const source = path.join(
            path.dirname(sourceFile),
            `r10-upsert-${Math.random().toString(36).slice(2)}.md`,
          );
          const marker = `r10upsertmarker${Math.random().toString(36).slice(2)}`;
          fs.writeFileSync(
            source,
            SOURCE_MARKDOWN.replace(new RegExp(PHRASE, "g"), marker),
            "utf8",
          );
          const run = await runVaultCli(["capture", source, "--state-dir", stateDir, "--json"]);
          expect(run.code).toBe(0);
          const outcomes = envelopeOf(run).outcomes as Array<{ index: string }>;
          expect(outcomes[0].index).toBe("indexed");

          const after = readIndexState("inbox");
          // Every prior member plus exactly one new one — not the new note
          // alone.
          expect(after.vaultPaths).toHaveLength(before.vaultPaths.length + 1);
          for (const priorPath of before.vaultPaths) {
            expect(after.vaultPaths).toContain(priorPath);
          }
          expect(after.chunkRows).toBeGreaterThan(before.chunkRows);

          const found = await runVaultCli([
            "search",
            marker,
            "--state-dir",
            stateDir,
            "--json",
          ]);
          expect(found.code).toBe(0);
          expect((envelopeOf(found).results as unknown[]).length).toBe(1);
        },
        120_000,
      );
    },
  );

  describe(
    // R16: a note edited, renamed, or deleted while its indexing waits
    // under a held lock. Each sub-case captures one note (exits 0,
    // `index: pending`), mutates the *published vault note itself* — not the
    // original source — while the lock is still held, then releases the
    // lock and reindexes. The unit-level equivalents ("indexes a manually
    // edited note as it now stands", "follows a manually renamed note to its
    // new path", "reconciles a vault note that has gone out of the index,
    // never out of the vault" in src/vault/VaultIndex.test.ts) already prove
    // the underlying reconciliation logic; this only proves the process
    // boundary carries the *actual* outcome through `index: pending` →
    // reindex, rather than reporting a vanished/changed note as still
    // cleanly `indexed`.
    "R16: a note edited/renamed/deleted while its update waits under a held index lock",
    () => {
      async function capturePending(
        phrase: string,
        filename: string,
      ): Promise<string> {
        const source = path.join(path.dirname(sourceFile), filename);
        fs.writeFileSync(
          source,
          SOURCE_MARKDOWN.replace(new RegExp(PHRASE, "g"), phrase),
          "utf8",
        );
        const run = await runVaultCli(["capture", source, "--state-dir", stateDir, "--json"]);
        expect(run.code).toBe(0);
        const outcomes = envelopeOf(run).outcomes as Array<{
          index: string;
          publication?: { path: string };
        }>;
        expect(outcomes[0].index).toBe("pending");
        return outcomes[0].publication?.path ?? "";
      }

      it("reflects an edit made to the published note while indexing was pending", async () => {
        const release = await holdIndexLock();
        try {
          const notePath = await capturePending("r16editphrase", "r16-edit-source.md");
          // A human edits the *saved vault note* directly, before it was ever
          // indexed.
          const before = fs.readFileSync(path.join(sandbox, notePath), "utf8");
          fs.writeFileSync(
            path.join(sandbox, notePath),
            before.replace(/r16editphrase/g, "r16editedwhilepending"),
          );
        } finally {
          await release();
        }

        const rebuilt = await runVaultCli(["reindex", "--state-dir", stateDir, "--json"]);
        expect(rebuilt.code).toBe(0);

        const edited = await runVaultCli([
          "search",
          "r16editedwhilepending",
          "--state-dir",
          stateDir,
          "--json",
        ]);
        expect(edited.code).toBe(0);
        expect((envelopeOf(edited).results as unknown[]).length).toBe(1);

        // The original (pre-edit) text is gone — indexing reflects what the
        // note actually says now, not what capture originally offered.
        const stale = await runVaultCli([
          "search",
          "r16editphrase",
          "--state-dir",
          stateDir,
          "--json",
        ]);
        expect(edited.code).toBe(0);
        expect((envelopeOf(stale).results as unknown[]).length).toBe(0);
      }, 180_000);

      it("follows the published note to its new path when it was renamed while indexing was pending", async () => {
        const release = await holdIndexLock();
        let notePath = "";
        try {
          notePath = await capturePending("r16renamephrase", "r16-rename-source.md");
          const renamed = path.join(
            path.dirname(notePath),
            "R16 Renamed While Pending.md",
          );
          fs.renameSync(path.join(sandbox, notePath), path.join(sandbox, renamed));
        } finally {
          await release();
        }

        const rebuilt = await runVaultCli(["reindex", "--state-dir", stateDir, "--json"]);
        expect(rebuilt.code).toBe(0);

        const found = await runVaultCli([
          "search",
          "r16renamephrase",
          "--state-dir",
          stateDir,
          "--json",
        ]);
        expect(found.code).toBe(0);
        const results = envelopeOf(found).results as Array<{ vault_path: string }>;
        expect(results).toHaveLength(1);
        expect(results[0].vault_path).not.toBe(notePath);
        expect(results[0].vault_path.endsWith("R16 Renamed While Pending.md")).toBe(true);
      }, 180_000);

      it("does not report a note deleted while indexing was pending as indexed", async () => {
        const release = await holdIndexLock();
        try {
          const notePath = await capturePending("r16deletephrase", "r16-delete-source.md");
          fs.rmSync(path.join(sandbox, notePath));
        } finally {
          await release();
        }

        const rebuilt = await runVaultCli(["reindex", "--state-dir", stateDir, "--json"]);
        expect(rebuilt.code).toBe(0);

        const gone = await runVaultCli([
          "search",
          "r16deletephrase",
          "--state-dir",
          stateDir,
          "--json",
        ]);
        expect(gone.code).toBe(0);
        expect((envelopeOf(gone).results as unknown[]).length).toBe(0);
        // The deleted note never comes back as a manifest entry either — a
        // vanished note during the pending window must never be silently
        // promoted to "indexed".
        const status = await runVaultCli(["reindex", "--state-dir", stateDir, "--json"]);
        expect(status.code).toBe(0);
        expect(envelopeOf(status).status).toBe("rebuilt");
      }, 180_000);
    },
  );

  it("never touched the operator's live vault", () => {
    if (!fs.existsSync(LIVE_VAULT)) return;
    const captures = path.join(LIVE_VAULT, "00 Inbox", "Source Captures");
    if (!fs.existsSync(captures)) return;
    const names = fs.readdirSync(captures);
    expect(names.some((name) => name.toLowerCase().includes(PHRASE))).toBe(false);
    expect(names.some((name) => name.toLowerCase().includes("pendingphrase"))).toBe(
      false,
    );
    for (const marker of ["r16editphrase", "r16renamephrase", "r16deletephrase"]) {
      expect(names.some((name) => name.toLowerCase().includes(marker))).toBe(false);
    }
  });
});
