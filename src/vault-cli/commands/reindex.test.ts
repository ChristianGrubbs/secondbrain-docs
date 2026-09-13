/**
 * Tests for `sb-docs reindex`: it rebuilds the derived index from saved vault
 * notes without fetching a source, and a rebuild it cannot run leaves the
 * previous generation serving searches.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../utils/config";
import { ObsidianCli } from "../../vault/ObsidianCli";
import { renderSourceNote } from "../../vault/render";
import type { CliResult, SourceDocument } from "../../vault/types";
import { VaultIndex } from "../../vault/VaultIndex";
import { createVaultCli } from "../index";
import type { ReindexEnvelope } from "./reindex";

/** In-memory stand-in for `obsidian-cli`, list and read only. */
class FakeVault {
  readonly notes = new Map<string, string>();
  /** Any argument vector that is not a read or a list. */
  readonly writes: string[] = [];

  run = async (args: string[], _stdin: string | null): Promise<CliResult> => {
    const [command, target] = args;

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

    if (command === "read") {
      const existing = this.notes.get(target);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${target}` };
      }
      return { code: 0, stdout: existing, stderr: "" };
    }

    this.writes.push(args.join(" "));
    return { code: 2, stdout: "", stderr: `unexpected subcommand: ${command}` };
  };
}

const BODY = `# Thaumaturgy

The thaumaturgical procedure is documented here for operators, with enough
surrounding prose that the splitter has a real paragraph to work with.
`;

const document: SourceDocument = {
  sourceUrl: "https://example.com/thaumaturgy",
  requestedUrl: "https://example.com/thaumaturgy",
  collection: "inbox",
  version: "",
  title: "Thaumaturgy",
  markdown: BODY,
  sourceContentType: "text/html",
  capturedAt: "2026-09-12T10:00:00.000Z",
};

const rendered = renderSourceNote(document, { publisherVersion: "9.9.9" });

const temporaries: string[] = [];
let stateDir: string;
let vaultDir: string;
let vault: FakeVault;
let out: string[];
let err: string[];
let previousExitCode: typeof process.exitCode;
const opened: VaultIndex[] = [];

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-reindex-"));
  temporaries.push(root);
  stateDir = path.join(root, "state");
  vaultDir = path.join(root, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  vault = new FakeVault();
  out = [];
  err = [];
  previousExitCode = process.exitCode;
});

afterEach(async () => {
  for (const index of opened.splice(0)) await index.shutdown();
  process.exitCode = previousExitCode;
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds an index over the fake vault, registered for teardown. */
function makeIndex(): VaultIndex {
  const index = new VaultIndex(new ObsidianCli(vault.run), {
    stateDir,
    vaultPath: vaultDir,
    appConfig: loadConfig(),
    lock: { timeoutMs: 150, pollMs: 10 },
  });
  opened.push(index);
  return index;
}

/** Runs `sb-docs reindex` with injected state, vault and output sinks. */
async function runReindex(args: string[]): Promise<void> {
  await createVaultCli(["reindex", ...args], {
    reindex: {
      stateDir,
      vaultPath: vaultDir,
      cli: new ObsidianCli(vault.run),
      appConfig: loadConfig(),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      lock: { timeoutMs: 150, pollMs: 10 },
    },
  })
    .exitProcess(false)
    .fail(false)
    .parseAsync();
}

/** Parses the single JSON envelope a `--json` run prints. */
function envelope(): ReindexEnvelope {
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]) as ReindexEnvelope;
}

/**
 * Reads the generation one collection's pointer currently names.
 *
 * Each collection owns its own pointer, so this needs an index instance to
 * resolve the collection's directory rather than a fixed path.
 */
function activeGeneration(index: VaultIndex, collection = "inbox"): string {
  return JSON.parse(
    fs.readFileSync(path.join(index.collectionRoot(collection), "current.json"), "utf8"),
  ).generation as string;
}

describe("sb-docs reindex", () => {
  it("rebuilds from saved notes and reports what it cost", async () => {
    vault.notes.set(rendered.path, rendered.markdown);

    await runReindex(["--json"]);

    const report = envelope();
    expect(report.status).toBe("rebuilt");
    expect(report.report).toMatchObject({
      collection: "inbox",
      notesIndexed: 1,
      noteReads: 1,
      embeddingsActive: false,
    });
    expect(report.report?.chunks).toBeGreaterThan(0);
    expect(process.exitCode).not.toBe(1);
    // A rebuild reads the vault and never writes to it.
    expect(vault.writes).toEqual([]);
  });

  it("prints human-readable lines when --json is not given", async () => {
    vault.notes.set(rendered.path, rendered.markdown);

    await runReindex([]);

    expect(out[0]).toContain("rebuilt inbox into gen-");
    expect(out.join("\n")).toContain("embeddings: disabled");
  });

  it("reports unavailable and exits nonzero under a held lock, leaving the generation intact", async () => {
    vault.notes.set(rendered.path, rendered.markdown);
    const holder = makeIndex();
    await holder.rebuild({ collection: "inbox" });
    const generation = activeGeneration(holder);

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = holder.withIndexLock(() => held);

    try {
      await runReindex(["--json"]);
    } finally {
      release();
      await holding;
    }

    expect(envelope()).toMatchObject({ status: "unavailable" });
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("❌ reindex unavailable");
    expect(activeGeneration(holder)).toBe(generation);
  });

  it("keeps the previous generation when the rebuild itself fails", async () => {
    vault.notes.set(rendered.path, rendered.markdown);
    await runReindex(["--json"]);
    const generation = envelope().report?.generation;
    const reader = makeIndex();
    expect(generation).toBe(activeGeneration(reader));

    // The vault backend goes away mid-flight: every read now fails hard.
    vault.notes.clear();
    vault.notes.set(rendered.path, rendered.markdown);
    const broken = new ObsidianCli(async (args) =>
      args[0] === "read"
        ? { code: 2, stdout: "", stderr: "obsidian-cli: vault backend unavailable" }
        : vault.run(args, null),
    );

    out.length = 0;
    await createVaultCli(["reindex", "--json"], {
      reindex: {
        stateDir,
        vaultPath: vaultDir,
        cli: broken,
        appConfig: loadConfig(),
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
    })
      .exitProcess(false)
      .fail(false)
      .parseAsync();

    expect(envelope().status).toBe("failed");
    expect(process.exitCode).toBe(1);
    expect(activeGeneration(reader)).toBe(generation);
  });

  it("imports an explicitly listed unmanaged note read-only", async () => {
    const legacy = "00 Inbox/Source Captures/Handwritten Legacy Note.md";
    vault.notes.set(legacy, `# Legacy\n\nThe quixotical section predates this tool.\n`);

    await runReindex(["--json", "--inventory", legacy]);

    expect(envelope().report?.notesIndexed).toBe(1);
    expect(vault.writes).toEqual([]);
  });
});
