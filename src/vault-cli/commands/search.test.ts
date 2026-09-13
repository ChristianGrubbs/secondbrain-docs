/**
 * Tests for `sb-docs search`: it retrieves saved vault documents from the
 * derived index, verifies every hit against the vault, and distinguishes "no
 * results" from "this operation could not run".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../utils/config";
import { sha256 } from "../../vault/identity";
import { ObsidianCli } from "../../vault/ObsidianCli";
import { renderSourceNote } from "../../vault/render";
import type { CliResult, SourceDocument } from "../../vault/types";
import { VaultIndex } from "../../vault/VaultIndex";
import { createVaultCli } from "../index";
import type { SearchEnvelope } from "./search";

/** In-memory stand-in for `obsidian-cli`, list and read only. */
class FakeVault {
  readonly notes = new Map<string, string>();

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

    return { code: 2, stdout: "", stderr: `unexpected subcommand: ${command}` };
  };
}

const BODY = `# Hypervisor Notes

The zymurgical subsystem is documented here for operators, with enough
surrounding prose that the splitter has a real paragraph to work with.

| Command | Purpose |
| --- | --- |
| \`run\` | Executes the documented step |
`;

const document: SourceDocument = {
  sourceUrl: "https://example.com/zymurgical",
  requestedUrl: "https://example.com/zymurgical",
  collection: "inbox",
  version: "",
  title: "Hypervisor Notes",
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-search-"));
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

/** Runs `sb-docs search` with injected state, vault and output sinks. */
async function runSearch(args: string[], index?: VaultIndex): Promise<void> {
  await createVaultCli(["search", ...args], {
    search: {
      stateDir,
      vaultPath: vaultDir,
      cli: new ObsidianCli(vault.run),
      appConfig: loadConfig(),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      lock: { timeoutMs: 150, pollMs: 10 },
      ...(index === undefined ? {} : { index }),
    },
  })
    .exitProcess(false)
    .fail(false)
    .parseAsync();
}

/** Parses the single JSON envelope a `--json` run prints. */
function envelope(): SearchEnvelope {
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]) as SearchEnvelope;
}

describe("sb-docs search", () => {
  it("returns the documented envelope for a saved note", async () => {
    vault.notes.set(rendered.path, rendered.markdown);
    await makeIndex().rebuild({ collection: "inbox" });

    await runSearch(["zymurgical", "--json"]);

    const report = envelope();
    expect(report.status).toBe("ok");
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      source_url: document.sourceUrl,
      vault_path: rendered.path,
      version: "",
      digest: sha256(rendered.markdown),
    });
    expect(report.results[0].excerpt).toContain("zymurgical");
    expect(process.exitCode).not.toBe(1);
  });

  it("exits 0 with no results rather than treating an empty answer as a failure", async () => {
    await runSearch(["nothingatallmatchesthis", "--json"]);

    expect(envelope().results).toEqual([]);
    expect(process.exitCode).not.toBe(1);
    expect(err).toEqual([]);
  });

  it("reports its own operation unavailable and exits nonzero under a held lock", async () => {
    vault.notes.set(rendered.path, rendered.markdown);
    const holder = makeIndex();
    await holder.rebuild({ collection: "inbox" });

    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = holder.withIndexLock(() => held);

    try {
      await runSearch(["zymurgical", "--json"]);
    } finally {
      release();
      await holding;
    }

    const report = envelope();
    expect(report.status).toBe("unavailable");
    expect(report.results).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("❌ search unavailable");

    // The prior generation is untouched: the same query works once the lock is
    // free again.
    out.length = 0;
    await runSearch(["zymurgical", "--json"]);
    expect(envelope().results).toHaveLength(1);
  });

  it("omits a hit whose note has gone and says so on stderr", async () => {
    vault.notes.set(rendered.path, rendered.markdown);
    await makeIndex().rebuild({ collection: "inbox" });
    vault.notes.delete(rendered.path);

    await runSearch(["zymurgical", "--json"]);

    const report = envelope();
    expect(report.status).toBe("partial");
    expect(report.results).toEqual([]);
    expect(report.omitted).toEqual([
      { source_url: document.sourceUrl, vault_path: rendered.path, reason: "missing" },
    ]);
    expect(err.join("\n")).toContain("omitted missing");
  });

  it("prints human-readable lines when --json is not given", async () => {
    vault.notes.set(rendered.path, rendered.markdown);
    await makeIndex().rebuild({ collection: "inbox" });

    await runSearch(["zymurgical"]);

    expect(out[0]).toContain(rendered.path);
    expect(out.join("\n")).toContain(`sha256:${sha256(rendered.markdown)}`);
  });

  it("rejects a non-positive limit", async () => {
    await expect(runSearch(["anything", "--limit", "0"])).rejects.toThrow(
      /--limit must be positive/,
    );
  });
});
