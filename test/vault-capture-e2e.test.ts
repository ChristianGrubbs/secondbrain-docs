/**
 * Process-level format/behavior qualification for `sb-docs capture`, against
 * the built `dist/vault-cli.js` and a real `obsidian-cli` over a throwaway
 * vault. See `docs/migration-qualification.md` for the row-by-row report this
 * suite backs (stable IDs F01-F20).
 *
 * Every fixture row uses a controlled, explicit `DOCS_MCP_CONFIG` and
 * `--state-dir` so a run can never rewrite the operator's real config or
 * runtime state, and asserts the live vault at the end is byte-for-byte
 * untouched. Local capture inputs are copied into a fresh temp directory per
 * row (never referenced from `test/fixtures/` directly for anything that
 * becomes a *discovered link*): the upstream default folder-exclusion list
 * (`**\/test/**`) filters discovered children, so a directory capture rooted
 * inside this repo's own `test/` tree would silently see zero children. A
 * single-file capture is exempt (the root item is never filtered), which is
 * why other suites can reference `test/fixtures/*.pdf` directly.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "../src/vault/identity";
import { qualifyNote } from "../scripts/lib/qualification-contract.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const vaultCliEntry = path.join(projectRoot, "dist", "vault-cli.js");
const listenGuard = path.join(
  projectRoot,
  "test",
  "fixtures",
  "vault-cli",
  "no-listen-guard.mjs",
);
const fixturesDir = path.join(projectRoot, "test", "fixtures");

const cliPath = path.join(os.homedir(), "ai-stack", "bin", "obsidian-cli");
const cliAvailable = fs.existsSync(cliPath);
const LIVE_VAULT = "/Volumes/3M/Obsidian";
const NETWORK_AVAILABLE = process.env.SB_DOCS_QUALIFICATION_OFFLINE !== "1";

let sandbox: string;
let stateDir: string;
let configFile: string;
let allowedRootsDir: string;

/** Collection folder names this suite creates, checked absent from the live vault at the end. */
const COLLECTIONS_UNDER_TEST = [
  "f04-two-page",
  "f06-local-markdown",
  "f07-table-pdf",
  "f08-docx",
  "f09-mixed-dir",
  "f10-versions",
  "f11-edited",
  "f12-failure",
  "f13-pptx",
  "f14-xlsx",
  "f15-ipynb",
  "f16-json",
  "f17-xml",
  "f18-plaintext",
  "f19-source-code",
  "f20-zip",
  "f01-single-page",
  "f02-github-readme",
  "f03-github-blob",
  "f05-js-rendered",
  "x03-cancelled",
  "m01-two-page",
  "m02-mixed-dir",
  "sigclean-sigint",
  "sigclean-sigterm",
  "sigclean-sighup",
];

interface VaultCliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  listenCalls: string[];
}

/** Reports whether the CLI at `cliPath` actually operates on `vaultPath`. */
function honoursVaultOverride(cli: string, vaultPath: string): boolean {
  try {
    const status = execFileSync(cli, ["status"], {
      encoding: "utf8",
      env: { ...process.env, OBSIDIAN_VAULT: vaultPath },
    });
    return status.includes(`vault: ok (${vaultPath})`);
  } catch {
    return false;
  }
}

/** Runs the built vault CLI executable directly against the sandbox vault. */
interface RunVaultCliOptions {
  /** Overrides the shared sandbox vault (used by the C-rows' fresh vaults). */
  vaultPath?: string;
  /** Overrides the shared config file (used by the C-rows' fresh vaults). */
  configFile?: string;
  /** Extra environment variables layered on top of the base env (e.g. SB_DOCS_LOG). */
  env?: Record<string, string | undefined>;
  /** Called with the live child process before it's awaited (e.g. to send SIGINT). */
  onSpawn?: (proc: ReturnType<typeof spawn>) => void;
}

async function runVaultCli(
  args: string[],
  options: RunVaultCliOptions = {},
): Promise<VaultCliRun> {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-listen-"));
  const logPath = path.join(logDir, "listen.log");
  try {
    return await new Promise<VaultCliRun>((resolve, reject) => {
      const nodeOptions = [
        process.env.NODE_OPTIONS,
        `--import ${pathToFileURL(listenGuard).href}`,
      ]
        .filter(Boolean)
        .join(" ");

      const proc = spawn(vaultCliEntry, args, {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VITEST_WORKER_ID: undefined,
          NODE_OPTIONS: nodeOptions,
          SB_DOCS_LISTEN_LOG: logPath,
          OBSIDIAN_VAULT: options.vaultPath ?? sandbox,
          DOCS_MCP_CONFIG: options.configFile ?? configFile,
          ...options.env,
        },
        timeout: 180_000,
      });

      options.onSpawn?.(proc);

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
        resolve({ code, stdout, stderr, listenCalls });
      });
    });
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

/** Parses the single JSON envelope a `--json` run printed on stdout. */
function envelopeOf(run: VaultCliRun): Record<string, unknown> {
  const line = run.stdout.split("\n").find((candidate) => candidate.startsWith("{"));
  expect(line, `no JSON envelope on stdout: ${run.stdout}\n${run.stderr}`).toBeDefined();
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

/** Copies one fixture file into a fresh temp dir (outside any `test/` path). */
function copyFixtureToTemp(fixtureRelPath: string, destName?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-src-"));
  const source = path.join(fixturesDir, fixtureRelPath);
  const dest = path.join(dir, destName ?? path.basename(fixtureRelPath));
  fs.copyFileSync(source, dest);
  return dest;
}

/** Copies an entire fixture directory into a fresh temp dir. */
function copyFixtureDirToTemp(fixtureRelDir: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-dir-"));
  const dest = path.join(dir, path.basename(fixtureRelDir));
  fs.cpSync(path.join(fixturesDir, fixtureRelDir), dest, { recursive: true });
  return dest;
}

/** Writes a `DOCS_MCP_CONFIG` allowing file access under `allowedRootsDir` and open network. */
function writeConfig(configPath: string): void {
  fs.writeFileSync(
    configPath,
    [
      "scraper:",
      "  security:",
      "    fileAccess:",
      "      mode: allowedRoots",
      "      allowedRoots:",
      `        - ${JSON.stringify(fs.realpathSync(allowedRootsDir))}`,
      "      followSymlinks: true",
      "    network:",
      "      allowPrivateNetworks: true",
      "      allowedHosts:",
      '        - "*"',
    ].join("\n"),
    "utf8",
  );
}

// MAJOR 1 (2026-09-13 Codex frontier review, round 4): this suite's own
// former local readMoc/countOccurrences/mocLinkTarget/frontmatterField
// helpers were dead code once every row routed through `qualifyNote` (the
// one shared contract, imported below) -- removed to eliminate a duplicate,
// independently-driftable MOC/frontmatter matcher rather than leaving a
// second copy that nothing calls but could silently rot.

/**
 * MAJOR 3 (2026-09-13 Codex frontier review): the one shared end-to-end
 * publication-contract assertion every qualifying note in every row goes
 * through. Establishes, for one already-published outcome: every required
 * fact is present in the saved bytes, frontmatter identity metadata is
 * correct, exactly one MOC link exists for it, `sb-docs search` resolves it
 * by identity (path + digest) under the right collection/version scope, and
 * `sb-docs read` returns the complete saved bytes — not merely that capture
 * printed an envelope containing the right substring.
 */
async function assertQualifiedNote(options: {
  outcome: {
    publication?: { status: string; path: string; markdown: string; digest?: string };
  };
  facts: string[];
  query: string;
  collection: string;
  version?: string;
  sourceUrlContains?: string;
  /** Overrides for a note published outside the shared sandbox (the C-rows' own throwaway vaults). */
  vaultPath?: string;
  stateDirOverride?: string;
  configFileOverride?: string;
}): Promise<void> {
  const {
    outcome,
    facts,
    query,
    collection,
    version,
    sourceUrlContains,
    vaultPath = sandbox,
    stateDirOverride = stateDir,
    configFileOverride = configFile,
  } = options;
  expect(outcome.publication?.status).toBe("published");
  const notePath = outcome.publication?.path ?? "";

  const result = await qualifyNote({
    vaultPath,
    notePath,
    expectedDigest: outcome.publication?.digest,
    facts,
    collection,
    query,
    version: version ?? "",
    sourceUrlContains,
    runCli: async (args: string[]) => {
      const withStateDir = args[0] === "read" ? args : [...args, "--state-dir", stateDirOverride];
      const run = await runVaultCli(withStateDir, {
        vaultPath,
        configFile: configFileOverride,
      });
      return { code: run.code ?? 1, stdout: run.stdout, stderr: run.stderr };
    },
  });

  expect(result.ok, result.reason ?? "qualifyNote failed with no reason").toBe(true);
}

describe.skipIf(!cliAvailable)("sb-docs capture format/behavior qualification", () => {
  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-vault-"));
    fs.mkdirSync(path.join(sandbox, "00 Inbox"), { recursive: true });
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-state-"));
    allowedRootsDir = os.tmpdir();

    if (!honoursVaultOverride(cliPath, sandbox)) {
      throw new Error(
        `REFUSING TO RUN: obsidian-cli did not report the sandbox vault ${sandbox}. ` +
          "Capturing now could mutate the operator's live vault.",
      );
    }

    configFile = path.join(stateDir, "config.yaml");
    writeConfig(configFile);
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("ran the override gate before capturing anything", () => {
    expect(honoursVaultOverride(cliPath, sandbox)).toBe(true);
  });

  describe("F04 bounded two-page site", () => {
    let server: http.Server;
    let baseUrl: string;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>Root PLUMTASTIC-1101</h1><a href="${baseUrl}/child">Child</a></body></html>`,
          );
          return;
        }
        if (req.url === "/child") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h1>Child GRAVELWORTH-1102</h1></body></html>");
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("bind failed");
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("F04: captures root and child, one MOC link each, both retrievable", async () => {
      const run = await runVaultCli([
        "capture",
        `${baseUrl}/`,
        "--collection",
        "f04-two-page",
        "--max-pages",
        "5",
        "--max-depth",
        "1",
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(run.code).toBe(0);
      expect(run.listenCalls).toEqual([]);
      const envelope = envelopeOf(run);
      const outcomes = envelope.outcomes as Array<{
        index: string;
        sourceUrl: string;
        publication?: {
          status: string;
          path: string;
          markdown: string;
          moc: string;
          digest?: string;
        };
      }>;
      expect(outcomes).toHaveLength(2);
      for (const outcome of outcomes) {
        expect(outcome.publication?.status).toBe("published");
        expect(outcome.index).toBe("indexed");
      }

      const root = outcomes.find((o) => o.sourceUrl === `${baseUrl}/`);
      const child = outcomes.find((o) => o.sourceUrl === `${baseUrl}/child`);
      expect(root, "root outcome").toBeDefined();
      expect(child, "child outcome").toBeDefined();

      await assertQualifiedNote({
        outcome: root as (typeof outcomes)[number],
        facts: ["PLUMTASTIC-1101"],
        query: "PLUMTASTIC-1101",
        collection: "f04-two-page",
        version: "",
        sourceUrlContains: baseUrl,
      });
      await assertQualifiedNote({
        outcome: child as (typeof outcomes)[number],
        facts: ["GRAVELWORTH-1102"],
        query: "GRAVELWORTH-1102",
        collection: "f04-two-page",
        version: "",
        sourceUrlContains: `${baseUrl}/child`,
      });
    });
  });

  it("F06: local Markdown preserves body/code fence/Unicode, but FAILS the row's local-asset-preservation requirement", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-src-"));
    fs.copyFileSync(
      path.join(fixturesDir, "vault-capture", "local-notes.md"),
      path.join(sourceDir, "local-notes.md"),
    );
    fs.copyFileSync(
      path.join(fixturesDir, "vault-capture", "pixel.png"),
      path.join(sourceDir, "pixel.png"),
    );
    const sourceFile = path.join(sourceDir, "local-notes.md");

    const run = await runVaultCli([
      "capture",
      sourceFile,
      "--collection",
      "f06-local-markdown",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const envelope = envelopeOf(run);
    const outcomes = envelope.outcomes as Array<{
      publication?: { path: string; markdown: string };
    }>;
    expect(outcomes).toHaveLength(1);
    const markdown = outcomes[0].publication?.markdown ?? "";
    expect(markdown).toContain("WIBBLEFLUX-3390");
    expect(markdown).toContain('echo "wibbleflux"');
    expect(markdown).toContain("café");
    expect(markdown).toContain("日本語");

    const readBack = await runVaultCli(["read", outcomes[0].publication?.path ?? ""]);
    expect(readBack.code).toBe(0);
    const savedBytes = fs.readFileSync(
      path.join(sandbox, outcomes[0].publication?.path ?? ""),
      "utf8",
    );
    expect(readBack.stdout).toContain("WIBBLEFLUX-3390");
    // `read`'s stdout writer is a console.log-style line printer, which
    // appends exactly one trailing "\n" beyond the saved file's own bytes;
    // that's the CLI's line-oriented output convention, not truncated or
    // altered content, so the full-byte-preservation assertion accounts for
    // it explicitly rather than doing a loose `toContain`.
    expect(readBack.stdout).toBe(`${savedBytes}\n`);
    expect(savedBytes).toContain("WIBBLEFLUX-3390");

    // RECORDED FAIL (row F06 per docs/migration-qualification.md, per the
    // plan's 6A requirement that "required document-local assets must be
    // copied and linked before that row qualifies"): VaultCaptureService has
    // no local-asset copy/link step, so the relative `./pixel.png` reference
    // is preserved as literal text but the image itself is never copied
    // beside the saved note, and the link is not rewritten to a resolvable
    // vault path. This assertion documents the current (failing) truth; it
    // does not weaken the row's requirement. Fixing this by writing the
    // binary asset straight to the vault filesystem would violate the "all
    // vault access uses obsidian-cli" invariant, because obsidian-cli has no
    // binary/attachment write command (`obsidian-cli help` lists
    // create/write/append/section-insert/move for Markdown only). See the
    // "Decisions needed" section of docs/migration-qualification.md.
    const assetCopied = fs.existsSync(
      path.join(sandbox, path.dirname(outcomes[0].publication?.path ?? ""), "pixel.png"),
    );
    expect(assetCopied).toBe(false);
  });

  it("F07: text PDF with a table preserves cell text, but FAILS the row's table-structure requirement (converter limit)", async () => {
    // Copied into the allowed-roots temp dir like every other single-file
    // row: the sandbox config's `allowedRoots` only covers `os.tmpdir()`, so
    // referencing the fixture at its real repo path fails as
    // outside-allowed-roots before conversion is ever attempted.
    const pdfFixture = copyFixtureToTemp(path.join("vault-capture", "table.pdf"));
    expect(fs.existsSync(pdfFixture)).toBe(true);

    const run = await runVaultCli([
      "capture",
      pdfFixture,
      "--collection",
      "f07-table-pdf",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const envelope = envelopeOf(run);
    const outcomes = envelope.outcomes as Array<{ publication?: { markdown: string } }>;
    const markdown = outcomes[0].publication?.markdown ?? "";
    expect(markdown).toContain("Orbital Period Table");
    expect(markdown).toContain("Mercury");
    expect(markdown).toContain("87.97");
    expect(markdown).toContain("Earth");
    expect(markdown).toContain("365.26");
    // RECORDED FAIL (row F07 per docs/migration-qualification.md, per the
    // plan's 6B table-assertion requirement): extraction flattens the
    // two-column layout into a single prose line rather than a Markdown
    // table (`| ... | ... |` / pipe row). Probed directly against
    // `@xberg-io/xberg`'s `extract()` with both default options and
    // `pdfOptions: { extractTables: true, allowSingleColumnTables: true }`:
    // both calls returned `document.tables === []` for this fixture — the
    // PDF table extractor's grid/heuristic detector does not recognize this
    // fixture's column-aligned text as a table at all, so there is no
    // structured table data in the extraction result for DocumentPipeline to
    // prefer over flattened prose. This is an external converter limit, not
    // a defect in this fork's pipeline code; no scoped fix is available here.
    expect(markdown).not.toMatch(/\|.*Mercury.*\|/);
  });

  it("F08: DOCX preserves its factual body", async () => {
    const docxFixture = copyFixtureToTemp("sample.docx");
    const run = await runVaultCli([
      "capture",
      docxFixture,
      "--collection",
      "f08-docx",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const outcomes = envelopeOf(run).outcomes as Array<{
      publication?: { status: string; path: string; markdown: string; digest?: string };
    }>;
    // sample.docx is a Word-to-Markdown conversion fixture with a stable
    // "Continued Lists" section; a hit proves real conversion, not a stub.
    await assertQualifiedNote({
      outcome: outcomes[0],
      facts: ["Continued Lists"],
      query: "Continued Lists",
      collection: "f08-docx",
      version: "",
      sourceUrlContains: "sample.docx",
    });
  });

  it("F09: mixed-file directory publishes one note per file, each linked once", async () => {
    const mixedDir = copyFixtureDirToTemp(path.join("vault-capture", "mixed-dir"));
    const run = await runVaultCli([
      "capture",
      mixedDir,
      "--collection",
      "f09-mixed-dir",
      "--max-pages",
      "10",
      "--max-depth",
      "2",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const envelope = envelopeOf(run);
    const outcomes = envelope.outcomes as Array<{
      sourceUrl: string;
      publication?: { status: string; path: string; markdown: string; digest?: string };
    }>;
    expect(outcomes).toHaveLength(3);

    // Per file: the full qualification contract, not just a joined-bodies
    // substring check.
    const perFile: Array<{ sentinel: string; query: string; source: string }> = [
      { sentinel: "ALPHA-SENTINEL-7701", query: "ALPHA-SENTINEL-7701", source: "alpha.md" },
      { sentinel: "BETA-SENTINEL-7702", query: "BETA-SENTINEL-7702", source: "beta.txt" },
      { sentinel: "GAMMA-SENTINEL-7703", query: "GAMMA-SENTINEL-7703", source: "gamma.json" },
    ];
    for (const file of perFile) {
      const outcome = outcomes.find((o) => o.sourceUrl.endsWith(`/${file.source}`));
      expect(outcome, `outcome for ${file.source}`).toBeDefined();
      await assertQualifiedNote({
        outcome: outcome as (typeof outcomes)[number],
        facts: [file.sentinel],
        query: file.query,
        collection: "f09-mixed-dir",
        version: "",
        sourceUrlContains: file.source,
      });
    }
  });

  it("F10: same source captured at two versions produces two distinct notes", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-src-"));
    const sourceFile = path.join(sourceDir, "versioned.md");
    fs.writeFileSync(sourceFile, "# Versioned\n\nTAFFYLOOP-2201 body ONLYINV1TOKEN.\n");

    const v1 = await runVaultCli([
      "capture",
      sourceFile,
      "--collection",
      "f10-versions",
      "--version",
      "v1",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(v1.code).toBe(0);

    fs.writeFileSync(sourceFile, "# Versioned\n\nTAFFYLOOP-2201 body ONLYINV2TOKEN.\n");
    const v2 = await runVaultCli([
      "capture",
      sourceFile,
      "--collection",
      "f10-versions",
      "--version",
      "v2",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(v2.code).toBe(0);

    type Outcome = { publication?: { status: string; path: string; markdown: string; digest?: string } };
    const outcome1 = (envelopeOf(v1).outcomes as Outcome[])[0];
    const outcome2 = (envelopeOf(v2).outcomes as Outcome[])[0];
    const path1 = outcome1.publication?.path;
    const path2 = outcome2.publication?.path;
    expect(path1).toBeDefined();
    expect(path2).toBeDefined();
    expect(path1).not.toBe(path2);

    // Full contract per version, including version-scoped search: v1's
    // query must resolve under version "v1" and not leak into "v2", and
    // vice versa.
    await assertQualifiedNote({
      outcome: outcome1,
      facts: ["ONLYINV1TOKEN"],
      query: "ONLYINV1TOKEN",
      collection: "f10-versions",
      version: "v1",
      sourceUrlContains: "versioned.md",
    });
    await assertQualifiedNote({
      outcome: outcome2,
      facts: ["ONLYINV2TOKEN"],
      query: "ONLYINV2TOKEN",
      collection: "f10-versions",
      version: "v2",
      sourceUrlContains: "versioned.md",
    });

    // Cross-version isolation: v1's own version scope must not surface v2's
    // unique token, and vice versa (distinct tokens per version, not just
    // "v1"/"v2" substrings, so FTS partial-term scoring can't produce a
    // false-positive hit the way it can on shared words like "body").
    const crossed1 = await runVaultCli([
      "search",
      "ONLYINV2TOKEN",
      "--collection",
      "f10-versions",
      "--version",
      "v1",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect((envelopeOf(crossed1).results as unknown[]).length).toBe(0);
    const crossed2 = await runVaultCli([
      "search",
      "ONLYINV1TOKEN",
      "--collection",
      "f10-versions",
      "--version",
      "v2",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect((envelopeOf(crossed2).results as unknown[]).length).toBe(0);
  });

  it("F11: a manually edited existing capture keeps the human edit on recapture", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-src-"));
    const sourceFile = path.join(sourceDir, "editable.md");
    fs.writeFileSync(sourceFile, "# Editable\n\nSNOZZBERRY-3301 original body.\n");

    const first = await runVaultCli([
      "capture",
      sourceFile,
      "--collection",
      "f11-edited",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(first.code).toBe(0);
    const firstOutcome = (
      envelopeOf(first).outcomes as Array<{
        publication?: { status: string; path: string; markdown: string; digest?: string };
      }>
    )[0];
    const notePath = firstOutcome.publication?.path as string;

    // MAJOR C (2026-09-13 Codex frontier review, round 2): the full
    // contract on the initial publication, before the human edit -- not
    // only checked after the conflict, which previously left the first
    // capture's own facts/frontmatter/digest/MOC-link/search/read
    // unverified.
    await assertQualifiedNote({
      outcome: firstOutcome,
      facts: ["SNOZZBERRY-3301", "original body"],
      query: "SNOZZBERRY-3301",
      collection: "f11-edited",
      version: "",
      sourceUrlContains: "editable.md",
    });

    // A human appends a note directly in the vault, outside any capture.
    const before = fs.readFileSync(path.join(sandbox, notePath), "utf8");
    const expectedAfterEdit = `${before}\n> HUMAN-EDIT-4401: manual annotation, must survive recapture.\n`;
    fs.writeFileSync(path.join(sandbox, notePath), expectedAfterEdit);

    // The upstream source is unchanged but the saved note's whole-note
    // digest no longer matches what capture last wrote, so this is a manual
    // edit conflict, per Task 3's ownership contract: "useful but
    // incomplete" (exit 2), the manual edit is left in place rather than
    // clobbered, and the candidate is parked for review instead.
    const second = await runVaultCli([
      "capture",
      sourceFile,
      "--collection",
      "f11-edited",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(second.code).toBe(2);
    const secondOutcome = (
      envelopeOf(second).outcomes as Array<{ publication?: { status: string; moc: string } }>
    )[0].publication;
    expect(secondOutcome?.status).toBe("conflict");

    // MAJOR C: exact whole-note byte equality, not just two surviving
    // substrings (other manual bytes -- e.g. the blank line, the original
    // frontmatter, the exact quote-block formatting -- could otherwise
    // silently vanish and still pass a substring-only check).
    const after = fs.readFileSync(path.join(sandbox, notePath), "utf8");
    expect(after).toBe(expectedAfterEdit);

    // Retrieval after the conflict still returns the complete manually
    // edited bytes -- the conflict must not have clobbered anything a
    // reader would see.
    const readAfterConflict = await runVaultCli(["read", notePath]);
    expect(readAfterConflict.code).toBe(0);
    expect(readAfterConflict.stdout).toBe(`${expectedAfterEdit}\n`);
  });

  it("F12: an acquisition failure (404 root) is a genuine no-useful-publication exit 1", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("bind failed");
    try {
      const run = await runVaultCli([
        "capture",
        `http://127.0.0.1:${address.port}/`,
        "--collection",
        "f12-failure",
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(run.code).toBe(1);
      const envelope = envelopeOf(run);
      expect(envelope.run_error).toBeDefined();
      expect((envelope.outcomes as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("F13: PPTX preserves its factual body", async () => {
    const pptxFixture = copyFixtureToTemp("sample.pptx");
    const run = await runVaultCli([
      "capture",
      pptxFixture,
      "--collection",
      "f13-pptx",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const outcomes = envelopeOf(run).outcomes as Array<{
      publication?: { status: string; path: string; markdown: string; digest?: string };
    }>;
    // sample.pptx's actual slide 1 title/subtitle text, verified directly
    // from the fixture's slide XML (test/fixtures/create-office-fixtures.ts
    // is a stale generator that no longer matches the committed fixture).
    await assertQualifiedNote({
      outcome: outcomes[0],
      facts: ["Presentation Title Text", "Subtitle Text"],
      query: "Presentation Title Text",
      collection: "f13-pptx",
      version: "",
      sourceUrlContains: "sample.pptx",
    });
  });

  it("F14: XLSX preserves its factual cell content", async () => {
    const xlsxFixture = copyFixtureToTemp("sample.xlsx");
    const run = await runVaultCli([
      "capture",
      xlsxFixture,
      "--collection",
      "f14-xlsx",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const outcomes = envelopeOf(run).outcomes as Array<{
      publication?: { status: string; path: string; markdown: string; digest?: string };
    }>;
    // Exact cells read directly from the committed fixture's sheet XML
    // (test/fixtures/create-office-fixtures.ts is a stale generator that no
    // longer matches this file): header row X/Y (sharedStrings 0/1), and
    // two distinctive data rows: A8/B8 = 7/34, A12/B12 = 11/21.
    await assertQualifiedNote({
      outcome: outcomes[0],
      facts: ["| X | Y |", "| 7 | 34 |", "| 11 | 21 |"],
      query: "34",
      collection: "f14-xlsx",
      version: "",
      sourceUrlContains: "sample.xlsx",
    });
  });

  it("F15: ipynb preserves its factual content", async () => {
    const ipynbFixture = copyFixtureToTemp("sample.ipynb");
    const run = await runVaultCli([
      "capture",
      ipynbFixture,
      "--collection",
      "f15-ipynb",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const outcomes = envelopeOf(run).outcomes as Array<{
      publication?: { status: string; path: string; markdown: string; digest?: string };
    }>;
    // Prose (markdown cell) AND code (code cell) from test/fixtures/sample.ipynb.
    await assertQualifiedNote({
      outcome: outcomes[0],
      facts: [
        "This is a test notebook for document pipeline testing.",
        "print('Hello from Jupyter!')",
      ],
      query: "Hello from Jupyter",
      collection: "f15-ipynb",
      version: "",
      sourceUrlContains: "sample.ipynb",
    });
  });

  it("F16: JSON is captured as a readable source", async () => {
    const jsonFixture = copyFixtureToTemp("json.json");
    const run = await runVaultCli([
      "capture",
      jsonFixture,
      "--collection",
      "f16-json",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const outcomes = envelopeOf(run).outcomes as Array<{
      publication?: { status: string; path: string; markdown: string; digest?: string };
    }>;
    const original = fs.readFileSync(path.join(fixturesDir, "json.json"), "utf8");
    const parsed = JSON.parse(original);
    const firstKey = Object.keys(parsed)[0];
    // A key AND its value: `firstKey` is "slideshow"; its nested title value
    // "Wake up to WonderWidgets!" is the row's factual content proof.
    await assertQualifiedNote({
      outcome: outcomes[0],
      facts: [firstKey, parsed[firstKey].slides[0].title],
      query: "WonderWidgets",
      collection: "f16-json",
      version: "",
      sourceUrlContains: "json.json",
    });
  });

  it("F17: XML is captured as a readable source", async () => {
    const xmlFixture = copyFixtureToTemp("xml.xml");
    const run = await runVaultCli([
      "capture",
      xmlFixture,
      "--collection",
      "f17-xml",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const outcomes = envelopeOf(run).outcomes as Array<{
      publication?: { status: string; path: string; markdown: string; digest?: string };
    }>;
    // The title slide's text from test/fixtures/xml.xml.
    await assertQualifiedNote({
      outcome: outcomes[0],
      facts: ["Wake up to WonderWidgets!"],
      query: "WonderWidgets",
      collection: "f17-xml",
      version: "",
      sourceUrlContains: "xml.xml",
    });
  });

  it("F18: plain text preserves its exact sentinel", async () => {
    const txtFixture = copyFixtureToTemp(path.join("vault-capture", "plain.txt"));
    const run = await runVaultCli([
      "capture",
      txtFixture,
      "--collection",
      "f18-plaintext",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const outcomes = envelopeOf(run).outcomes as Array<{
      publication?: { status: string; path: string; markdown: string; digest?: string };
    }>;
    await assertQualifiedNote({
      outcome: outcomes[0],
      facts: ["FLUMPADOODLE-9182"],
      query: "FLUMPADOODLE-9182",
      collection: "f18-plaintext",
      version: "",
      sourceUrlContains: "plain.txt",
    });
  });

  it("F19: source code preserves its exact sentinel", async () => {
    const codeFixture = copyFixtureToTemp(path.join("vault-capture", "source-code.py"));
    const run = await runVaultCli([
      "capture",
      codeFixture,
      "--collection",
      "f19-source-code",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(run.code).toBe(0);
    const outcomes = envelopeOf(run).outcomes as Array<{
      publication?: { status: string; path: string; markdown: string; digest?: string };
    }>;
    await assertQualifiedNote({
      outcome: outcomes[0],
      facts: ["QUAGGLE-4471", "quaggle_factor"],
      query: "QUAGGLE-4471",
      collection: "f19-source-code",
      version: "",
      sourceUrlContains: "source-code.py",
    });
  });

  it(
    // MAJOR 4 (2026-09-13 Codex frontier review): all nine members of
    // test/fixtures/archive.zip are frozen with an expected disposition
    // (all nine publish here — confirmed by direct inspection of a real
    // capture run; none is expected to be excluded), a fact proving real
    // conversion (not a stub), and the full qualification contract per
    // published member — not "at least five of nine, something published."
    "F20: ZIP archive publishes exactly its nine frozen members, each qualified",
    async () => {
      const zipFixture = copyFixtureToTemp("archive.zip");
      const run = await runVaultCli([
        "capture",
        zipFixture,
        "--collection",
        "f20-zip",
        "--max-pages",
        "20",
        "--max-depth",
        "2",
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(run.code).toBe(0);
      const outcomes = envelopeOf(run).outcomes as Array<{
        sourceUrl: string;
        publication?: { status: string; path: string; markdown: string; digest?: string };
      }>;

      const expectedMembers: Array<{ member: string; facts: string[]; query: string }> = [
        { member: "sample.pptx", facts: ["Presentation Title Text"], query: "Presentation Title Text" },
        { member: "sample.xlsx", facts: ["| 7 | 34 |"], query: "34" },
        { member: "sample.pdf", facts: ["IP over Avian Carriers"], query: "Avian Carriers" },
        { member: "robots.txt", facts: ["Disallow: /deny"], query: "Disallow" },
        { member: "sample.ipynb", facts: ["print('Hello from Jupyter!')"], query: "Hello from Jupyter" },
        { member: "sample.docx", facts: ["Demonstration of DOCX support in calibre"], query: "calibre" },
        { member: "json.json", facts: ["slideshow", "Wake up to WonderWidgets!"], query: "WonderWidgets" },
        { member: "xml.xml", facts: ["Wake up to WonderWidgets!"], query: "WonderWidgets" },
        { member: "html.html", facts: ["Herman Melville", "Moby-Dick"], query: "Moby-Dick" },
      ];

      // Exact outcome membership: exactly these nine, nothing more, nothing
      // fewer.
      expect(outcomes).toHaveLength(expectedMembers.length);
      const actualMembers = outcomes.map((o) => o.sourceUrl.split("/").pop()).sort();
      expect(actualMembers).toEqual(expectedMembers.map((m) => m.member).sort());

      // Every member is expected to publish; assert that uniformly before
      // the per-member qualification loop.
      for (const outcome of outcomes) {
        expect(
          outcome.publication?.status,
          `${outcome.sourceUrl} expected to publish`,
        ).toBe("published");
      }

      // MAJOR C (2026-09-13 Codex frontier review, round 2): every member
      // now runs the full contract (facts, frontmatter identity, digest,
      // one MOC link, search identity, full read) via `qualifyNote`, not
      // just facts + digest + MOC + a separately re-derived search check.
      // `qualifyNote`'s search step only requires this note's identity to
      // be present among the results, so XML and JSON legitimately sharing
      // the query "WonderWidgets" is not a problem.
      for (const expected of expectedMembers) {
        const outcome = outcomes.find((o) => o.sourceUrl.endsWith(`/${expected.member}`));
        expect(outcome, `outcome for ${expected.member}`).toBeDefined();
        const notePath = outcome?.publication?.path ?? "";
        const result = await qualifyNote({
          vaultPath: sandbox,
          notePath,
          expectedDigest: outcome?.publication?.digest,
          facts: expected.facts,
          collection: "f20-zip",
          query: expected.query,
          version: "",
          sourceUrlContains: expected.member,
          runCli: async (args: string[]) => {
            const withStateDir =
              args[0] === "read" ? args : [...args, "--state-dir", stateDir];
            const run = await runVaultCli(withStateDir);
            return { code: run.code ?? 1, stdout: run.stdout, stderr: run.stderr };
          },
        });
        expect(result.ok, `${expected.member}: ${result.reason ?? "unknown failure"}`).toBe(true);
      }
    },
  );

  describe("C-rows: real-CLI first-capture directory bootstrapping", () => {
    /** Spins up a brand-new throwaway vault + state dir, verifies the override gate. */
    function freshVault(): { vaultPath: string; statePath: string; configPath: string } {
      const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-cvault-"));
      const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-cstate-"));
      const configPath = path.join(statePath, "config.yaml");
      writeConfig(configPath);
      if (!honoursVaultOverride(cliPath, vaultPath)) {
        throw new Error(`REFUSING TO RUN: obsidian-cli did not report vault ${vaultPath}`);
      }
      return { vaultPath, statePath, configPath };
    }

    it("C01: first capture with no inbox folder present bootstraps 00 Inbox/Source Captures", async () => {
      const { vaultPath, statePath, configPath } = freshVault();
      try {
        expect(fs.existsSync(path.join(vaultPath, "00 Inbox"))).toBe(false);
        const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-src-"));
        const sourceFile = path.join(sourceDir, "c01.txt");
        fs.writeFileSync(sourceFile, "C01-BOOTSTRAP-1001 no inbox folder yet.\n");

        const run = await runVaultCli(["capture", sourceFile, "--state-dir", statePath, "--json"], {
          vaultPath,
          configFile: configPath,
        });
        expect(run.code).toBe(0);
        const outcomes = envelopeOf(run).outcomes as Array<{
          publication?: { path: string; status: string; markdown: string; digest?: string };
        }>;
        const notePath = outcomes[0].publication?.path ?? "";
        expect(notePath.startsWith("00 Inbox/Source Captures/")).toBe(true);
        await assertQualifiedNote({
          outcome: outcomes[0],
          facts: ["C01-BOOTSTRAP-1001"],
          query: "C01-BOOTSTRAP-1001",
          collection: "inbox",
          version: "",
          sourceUrlContains: "c01.txt",
          vaultPath,
          stateDirOverride: statePath,
          configFileOverride: configPath,
        });
      } finally {
        fs.rmSync(vaultPath, { recursive: true, force: true });
        fs.rmSync(statePath, { recursive: true, force: true });
      }
    });

    it("C02: first capture with no Doc Sets parent and no named collection folder bootstraps both", async () => {
      const { vaultPath, statePath, configPath } = freshVault();
      try {
        expect(fs.existsSync(path.join(vaultPath, "30 Tools-Models"))).toBe(false);
        const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-src-"));
        const sourceFile = path.join(sourceDir, "c02.txt");
        fs.writeFileSync(sourceFile, "C02-BOOTSTRAP-1002 no Doc Sets parent yet.\n");

        const run = await runVaultCli(
          ["capture", sourceFile, "--collection", "c02-brand-new", "--state-dir", statePath, "--json"],
          { vaultPath, configFile: configPath },
        );
        expect(run.code).toBe(0);
        const outcomes = envelopeOf(run).outcomes as Array<{
          publication?: { path: string; status: string; markdown: string; digest?: string };
        }>;
        expect(
          fs.existsSync(path.join(vaultPath, "30 Tools-Models/Doc Sets/c02-brand-new/index.md")),
        ).toBe(true);
        await assertQualifiedNote({
          outcome: outcomes[0],
          facts: ["C02-BOOTSTRAP-1002"],
          query: "C02-BOOTSTRAP-1002",
          collection: "c02-brand-new",
          version: "",
          sourceUrlContains: "c02.txt",
          vaultPath,
          stateDirOverride: statePath,
          configFileOverride: configPath,
        });
      } finally {
        fs.rmSync(vaultPath, { recursive: true, force: true });
        fs.rmSync(statePath, { recursive: true, force: true });
      }
    });

    it("C03: collection name with spaces and Unicode is captured and retrievable", async () => {
      const { vaultPath, statePath, configPath } = freshVault();
      try {
        const collection = "café 日本語 collection";
        const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-src-"));
        const sourceFile = path.join(sourceDir, "c03.txt");
        fs.writeFileSync(sourceFile, "C03-UNICODE-1003 spaces and Unicode collection name.\n");

        const run = await runVaultCli(
          ["capture", sourceFile, "--collection", collection, "--state-dir", statePath, "--json"],
          { vaultPath, configFile: configPath },
        );
        expect(run.code).toBe(0);
        const outcomes = envelopeOf(run).outcomes as Array<{
          publication?: { path: string; status: string; markdown: string; digest?: string };
        }>;
        expect(
          fs.existsSync(path.join(vaultPath, "30 Tools-Models/Doc Sets", collection, "index.md")),
        ).toBe(true);
        await assertQualifiedNote({
          outcome: outcomes[0],
          facts: ["C03-UNICODE-1003"],
          query: "C03-UNICODE-1003",
          collection,
          version: "",
          sourceUrlContains: "c03.txt",
          vaultPath,
          stateDirOverride: statePath,
          configFileOverride: configPath,
        });
      } finally {
        fs.rmSync(vaultPath, { recursive: true, force: true });
        fs.rmSync(statePath, { recursive: true, force: true });
      }
    });

    it("C04: an established mixed-case collection folder is reused, never creating a second case variant", async () => {
      const { vaultPath, statePath, configPath } = freshVault();
      try {
        const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-src-"));
        const firstFile = path.join(sourceDir, "c04-first.txt");
        fs.writeFileSync(firstFile, "C04-MIXEDCASE-1004 first capture establishes casing.\n");

        const first = await runVaultCli(
          ["capture", firstFile, "--collection", "MixedCase-Docs", "--state-dir", statePath, "--json"],
          { vaultPath, configFile: configPath },
        );
        expect(first.code).toBe(0);
        expect(
          fs.existsSync(path.join(vaultPath, "30 Tools-Models/Doc Sets/MixedCase-Docs/index.md")),
        ).toBe(true);
        const firstOutcome = (
          envelopeOf(first).outcomes as Array<{
            publication?: { status: string; path: string; markdown: string; digest?: string };
          }>
        )[0];
        // MAJOR C (2026-09-13 Codex frontier review, round 2): qualify both
        // captures fully, not only their exit codes and the folder count.
        await assertQualifiedNote({
          outcome: firstOutcome,
          facts: ["C04-MIXEDCASE-1004"],
          query: "C04-MIXEDCASE-1004",
          collection: "MixedCase-Docs",
          version: "",
          sourceUrlContains: "c04-first.txt",
          vaultPath,
          stateDirOverride: statePath,
          configFileOverride: configPath,
        });

        const secondFile = path.join(sourceDir, "c04-second.txt");
        fs.writeFileSync(secondFile, "C04-MIXEDCASE-1005 second capture reuses the same folder.\n");
        // Deliberately different case on the argument to prove the CLI reuses
        // the already-established folder spelling rather than creating a
        // second, differently-cased sibling collection.
        const second = await runVaultCli(
          ["capture", secondFile, "--collection", "mixedcase-docs", "--state-dir", statePath, "--json"],
          { vaultPath, configFile: configPath },
        );
        expect(second.code).toBe(0);
        const secondOutcome = (
          envelopeOf(second).outcomes as Array<{
            publication?: { status: string; path: string; markdown: string; digest?: string };
          }>
        )[0];
        await assertQualifiedNote({
          outcome: secondOutcome,
          facts: ["C04-MIXEDCASE-1005"],
          query: "C04-MIXEDCASE-1005",
          collection: "mixedcase-docs",
          version: "",
          sourceUrlContains: "c04-second.txt",
          vaultPath,
          stateDirOverride: statePath,
          configFileOverride: configPath,
        });

        // The required invariant is "no second case variant" (a genuinely
        // new sibling folder differing only by case), not preservation of
        // the exact original casing string — macOS's case-insensitive,
        // case-preserving filesystem means a case-differing path argument
        // resolves to the same directory entry either way.
        const docSets = fs.readdirSync(path.join(vaultPath, "30 Tools-Models/Doc Sets"));
        const caseVariants = docSets.filter((name) => name.toLowerCase() === "mixedcase-docs");
        expect(caseVariants).toHaveLength(1);
      } finally {
        fs.rmSync(vaultPath, { recursive: true, force: true });
        fs.rmSync(statePath, { recursive: true, force: true });
      }
    });
  });

  describe("X-rows: process-boundary exit codes", () => {
    // X01 (exit 2, useful-but-incomplete) and X02 (exit 1, no useful
    // publication) already have real-CLI process-level coverage above:
    // F11's manual-edit conflict asserts exit 2 with the prior note
    // preserved, and F12's 404-root acquisition failure asserts exit 1 with
    // `run_error` set. See docs/migration-qualification.md rows X01/X02,
    // which reference those tests by title rather than duplicating them.

    it("X03: SIGINT cancellation exits 130 and preserves outcomes published before the abort", async () => {
      const server = http.createServer((req, res) => {
        // A deliberately slow second page gives the test a window to send
        // SIGINT after the first page has already published.
        const delayMs = req.url === "/slow" ? 15000 : 0;
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/html" });
          if (req.url === "/") {
            res.end(
              `<html><body><h1>X03-ROOT-2001</h1><a href="${baseUrl}/slow">Slow</a></body></html>`,
            );
            return;
          }
          res.end("<html><body><h1>X03-SLOW-2002</h1></body></html>");
        }, delayMs);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("bind failed");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      try {
        const run = await runVaultCli(
          [
            "capture",
            `${baseUrl}/`,
            "--collection",
            "x03-cancelled",
            "--max-pages",
            "5",
            "--max-depth",
            "1",
            "--state-dir",
            stateDir,
            "--json",
          ],
          {
            onSpawn: (proc) => {
              // Give the root page time to fetch, render via Playwright and
              // fully publish (cold Playwright launch alone takes ~1-2s in
              // this environment), then interrupt while the deliberately
              // slow child page is still mid-fetch.
              setTimeout(() => proc.kill("SIGINT"), 4000);
            },
          },
        );
        expect(run.code).toBe(130);
        const envelope = envelopeOf(run);
        expect(envelope.cancelled).toBe(true);
        const outcomes = envelope.outcomes as Array<{
          publication?: { status: string };
        }>;
        const published = outcomes.filter((o) => o.publication?.status === "published");
        expect(published.length).toBeGreaterThanOrEqual(1);

        // The root's published note must survive the cancellation; re-run
        // search for its sentinel to prove it is genuinely retrievable, not
        // merely reported in the aborted envelope.
        const rootFound = await runVaultCli([
          "search",
          "X03-ROOT-2001",
          "--collection",
          "x03-cancelled",
          "--state-dir",
          stateDir,
          "--json",
        ]);
        expect(rootFound.code).toBe(0);
        const rootResults =
          (envelopeOf(rootFound).results as Array<{ vault_path: string }>) ?? [];
        expect(rootResults).toHaveLength(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    interface PsEntry {
      pid: number;
      ppid: number;
      command: string;
    }

    /** One snapshot of every live process on the machine (pid, ppid, full command line). */
    function psSnapshot(): PsEntry[] {
      const raw = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
          if (!match) return null;
          return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
        })
        .filter((entry): entry is PsEntry => entry !== null);
    }

    /**
     * Every live descendant of `rootPid` (any depth), walked from a single
     * `ps` snapshot rather than a machine-wide substring match — this is
     * what makes the assertion immune to other concurrently-running test
     * files' own Chromium processes under vitest parallelism (MAJOR B,
     * 2026-09-13 Codex frontier review, round 2; a prior version of this
     * test used a machine-wide `pgrep -f ms-playwright`, which the
     * coordinator's independent full-`npm test` run demonstrated flaking
     * when other suites launched Chromium concurrently).
     */
    function descendantsOf(rootPid: number, snapshot: PsEntry[]): PsEntry[] {
      const byParent = new Map<number, PsEntry[]>();
      for (const entry of snapshot) {
        const siblings = byParent.get(entry.ppid) ?? [];
        siblings.push(entry);
        byParent.set(entry.ppid, siblings);
      }
      const result: PsEntry[] = [];
      const queue = [rootPid];
      while (queue.length > 0) {
        const pid = queue.shift() as number;
        for (const child of byParent.get(pid) ?? []) {
          result.push(child);
          queue.push(child.pid);
        }
      }
      return result;
    }

    /** This child's own Chromium descendants (by ancestry, not a global command-line match). */
    function chromiumDescendantsOf(rootPid: number): PsEntry[] {
      return descendantsOf(rootPid, psSnapshot()).filter((e) => /ms-playwright/.test(e.command));
    }

    /** The `--user-data-dir=<path>` Playwright passed to one Chromium command line, if any. */
    function userDataDirOf(command: string): string | undefined {
      return command.match(/--user-data-dir=(\S+)/)?.[1];
    }

    /** Polls until `predicate()` returns a non-empty/truthy value, or the timeout elapses. */
    async function pollUntil<T>(
      predicate: () => T,
      { timeoutMs, intervalMs = 200 }: { timeoutMs: number; intervalMs?: number },
    ): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      let last: T = predicate();
      while (Date.now() < deadline) {
        last = predicate();
        if (Array.isArray(last) ? last.length > 0 : Boolean(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      return last;
    }

    /** True if `pid` is still a live process (per POSIX kill(pid, 0) semantics). */
    function isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    /**
     * Runs one signal-cleanup case: spawns a browser-rendered capture whose
     * child page NEVER responds (so the process cannot finish naturally,
     * closing the "waits for natural completion" loophole), waits for a
     * real Chromium descendant of THIS child's own pid to appear, sends
     * the signal, and reports what happened for the caller to assert on.
     */
    async function runSignalCleanupCase(
      signal: "SIGINT" | "SIGTERM" | "SIGHUP",
      options: { disableCleanup?: boolean } = {},
    ): Promise<{
      chromiumFoundBeforeSignal: PsEntry[];
      userDataDir: string | undefined;
      chromiumStillAliveAfter: PsEntry[];
      userDataDirLeaked: boolean;
      hostStillAlive: boolean;
      closeCode: number | null;
      closeSignal: NodeJS.Signals | null;
      childPid: number;
    }> {
      const server = http.createServer((req, res) => {
        if (req.url === "/llms.txt") {
          res.writeHead(404);
          res.end();
          return;
        }
        if (req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body><h1>SIGCLEAN-ROOT</h1><a href="${baseUrl}/slow">Slow</a></body></html>`,
          );
          return;
        }
        // "/slow": never respond. The capture can never finish naturally,
        // so any observed cleanup is genuinely caused by the signal.
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("bind failed");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      let childPid = 0;
      let closeCode: number | null = null;
      let closeSignal: NodeJS.Signals | null = null;
      let resolveClosed = (): void => undefined;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });

      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-sigclean-log-"));
      const logFile = path.join(logDir, "listen.log");
      const proc = spawn(
        vaultCliEntry,
        [
          "capture",
          `${baseUrl}/`,
          "--collection",
          `sigclean-${signal.toLowerCase()}${options.disableCleanup ? "-negctl" : ""}`,
          "--max-pages",
          "5",
          "--max-depth",
          "1",
          "--state-dir",
          stateDir,
          "--json",
        ],
        {
          cwd: projectRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            VITEST_WORKER_ID: undefined,
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              `--import ${pathToFileURL(listenGuard).href}`,
            ]
              .filter(Boolean)
              .join(" "),
            SB_DOCS_LISTEN_LOG: logFile,
            OBSIDIAN_VAULT: sandbox,
            DOCS_MCP_CONFIG: configFile,
            ...(options.disableCleanup
              ? {
                  SB_DOCS_TEST_DISABLE_SIGNAL_CLEANUP: "1",
                  // Keeps the host alive on SIGTERM/SIGHUP so "Playwright's
                  // own cleanup is disabled" can be observed in isolation
                  // from "the host process died" (MAJOR 3, round 3).
                  SB_DOCS_TEST_KEEP_ALIVE_ON_SIGNAL: "1",
                }
              : {}),
          },
        },
      );
      childPid = proc.pid ?? 0;
      proc.on("close", (code, sig) => {
        closeCode = code;
        closeSignal = sig;
        resolveClosed();
      });

      try {
        // Synchronize on THIS child's own browser launch, not a fixed
        // delay: poll for a Chromium process whose ancestry leads back to
        // childPid.
        const chromiumFoundBeforeSignal = await pollUntil(() => chromiumDescendantsOf(childPid), {
          timeoutMs: 20_000,
          intervalMs: 250,
        });

        const userDataDir = chromiumFoundBeforeSignal
          .map((e) => userDataDirOf(e.command))
          .find((dir): dir is string => dir !== undefined);

        proc.kill(signal);

        // Give the signal handler (Playwright's own, or the CLI's for
        // SIGINT) time to act, polling until every previously-found
        // Chromium descendant pid is gone or the timeout elapses (this
        // loop's exit condition is the opposite of `pollUntil`'s, which
        // stops on the first non-empty result -- here we want to stop once
        // the "still alive" set becomes empty).
        const deadline = Date.now() + 8_000;
        let finalStillAlive = chromiumFoundBeforeSignal.filter((e) => isAlive(e.pid));
        while (finalStillAlive.length > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          finalStillAlive = chromiumFoundBeforeSignal.filter((e) => isAlive(e.pid));
        }

        const userDataDirLeaked = userDataDir !== undefined && fs.existsSync(userDataDir);
        const hostStillAlive = isAlive(childPid);

        // Wait briefly for a natural close (SIGINT's bridged case), without
        // blocking forever on SIGTERM/SIGHUP against a hung fixture.
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);

        return {
          chromiumFoundBeforeSignal,
          userDataDir,
          chromiumStillAliveAfter: finalStillAlive,
          userDataDirLeaked,
          hostStillAlive,
          closeCode,
          closeSignal,
          childPid,
        };
      } finally {
        // Test cleanup: the fixture never completes naturally for
        // SIGTERM/SIGHUP (the "/slow" request never responds), so the host
        // process must be force-killed regardless of outcome.
        if (isAlive(childPid)) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        for (const entry of chromiumDescendantsOf(childPid)) {
          try {
            process.kill(entry.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(logDir, { recursive: true, force: true });
      }
    }

    it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
      // MAJOR 1 / MAJOR B (2026-09-13 Codex frontier review, rounds 1 and
      // 2): a real %s sent to a browser-rendered capture must not leak
      // Chromium descendant processes or their temp profile directory —
      // regardless of whether the CLI itself bridges that signal into
      // cancellation (only SIGINT is bridged; SIGTERM/SIGHUP rely entirely
      // on Playwright's own default handlers). The fixture page never
      // responds, so the process cannot finish naturally and satisfy this
      // test by ordinary shutdown; the Chromium descendant set and temp
      // profile dir are THIS child's own (via ps ancestry), not a
      // machine-wide match that other concurrent test files' browsers could
      // satisfy.
      "%s during a browser-rendered capture leaves no Chromium descendants or a leaked temp profile dir",
      async (signal) => {
        const result = await runSignalCleanupCase(signal);

        expect(
          result.chromiumFoundBeforeSignal.length,
          "expected a Chromium descendant of this child to actually be running before signalling",
        ).toBeGreaterThan(0);
        expect(result.userDataDir, "expected a --user-data-dir on the Chromium command line").toBeDefined();

        expect(
          result.chromiumStillAliveAfter.map((e) => e.pid),
          `this child's own Chromium descendants still alive after ${signal}`,
        ).toEqual([]);
        expect(result.userDataDirLeaked, `temp profile dir leaked after ${signal}`).toBe(false);

        if (signal === "SIGINT") {
          // The CLI bridges SIGINT into graceful cancellation and exits
          // itself -- assert the actual delivered outcome.
          expect(result.closeCode).toBe(130);
        } else {
          // SIGTERM/SIGHUP are not bridged by the CLI; with the fixture
          // page never responding, the host process is expected to still
          // be alive (only the browser was reaped) -- proving the browser
          // cleanup was genuinely caused by Playwright's own signal
          // handler, not by the host process exiting on its own.
          expect(result.hostStillAlive, "expected the host process to still be alive").toBe(true);
        }
      },
      30_000,
    );

    it.each(["SIGTERM", "SIGHUP"] as const)(
      // MAJOR 3 (2026-09-13 Codex frontier review, round 3): the prior
      // "negative control" only proved kill(pid, 0) recognizes a supplied
      // sleep pid -- it never exercised browser discovery, signal
      // delivery, profile tracking, or the actual cleanup case, so it
      // proved nothing about whether the REAL assertions above would catch
      // a genuine regression. This runs the ACTUAL cleanup case with
      // Playwright's own SIGTERM/SIGHUP handling disabled
      // (`SB_DOCS_TEST_DISABLE_SIGNAL_CLEANUP=1`), while a test-only no-op
      // signal listener (`SB_DOCS_TEST_KEEP_ALIVE_ON_SIGNAL=1`, registered
      // in `capture.ts`, inert unless explicitly set) keeps the host
      // process alive so "cleanup disabled" can be observed in isolation
      // from "the host process died" (Chromium's CDP pipe transport
      // otherwise treats the parent's death as its own shutdown signal
      // regardless of `handleSIGTERM`/`handleSIGHUP`). With cleanup
      // genuinely disabled, the exact same browser-descendant and
      // profile-dir assertions the healthy-case tests use must REJECT this
      // run.
      "negative control: with cleanup disabled, %s leaves a real Chromium descendant and its profile dir alive (proves the assertions can fail)",
      async (signal) => {
        const result = await runSignalCleanupCase(signal, { disableCleanup: true });

        expect(
          result.chromiumFoundBeforeSignal.length,
          "expected a Chromium descendant of this child to actually be running before signalling",
        ).toBeGreaterThan(0);
        expect(result.userDataDir).toBeDefined();
        expect(
          result.hostStillAlive,
          "the keep-alive hook should have kept the host process alive despite cleanup being disabled",
        ).toBe(true);

        // The exact assertions the healthy-case test uses -- here they
        // must FAIL to hold, proving they are not vacuous.
        expect(
          result.chromiumStillAliveAfter.length,
          `expected at least one Chromium descendant to still be alive after ${signal} with cleanup disabled`,
        ).toBeGreaterThan(0);
        expect(
          result.userDataDirLeaked,
          `expected the temp profile dir to still exist after ${signal} with cleanup disabled`,
        ).toBe(true);
      },
      30_000,
    );
  });

  describe("M-rows: subprocess/vault access measurements (accepted cost, no threshold)", () => {
    it("M01: F04 two-page site — subprocess/vault-access counts and elapsed time", async () => {
      const server = http.createServer((req, res) => {
        if (req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body><h1>M01-ROOT</h1><a href="${baseUrl}/child">Child</a></body></html>`);
          return;
        }
        if (req.url === "/child") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h1>M01-CHILD</h1></body></html>");
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("bind failed");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-m01-"));
      const logFile = path.join(logDir, "log.jsonl");
      try {
        const startedAt = performance.now();
        const run = await runVaultCli(
          [
            "capture",
            `${baseUrl}/`,
            "--collection",
            "m01-two-page",
            "--max-pages",
            "5",
            "--max-depth",
            "1",
            "--state-dir",
            stateDir,
            "--json",
          ],
          { env: { SB_DOCS_LOG: "1", SB_DOCS_LOG_FILE: logFile } },
        );
        const elapsedMs = performance.now() - startedAt;
        expect(run.code).toBe(0);

        const events = fs.existsSync(logFile)
          ? fs
              .readFileSync(logFile, "utf8")
              .split("\n")
              .filter(Boolean)
              .map(
                (line) =>
                  JSON.parse(line) as {
                    event: string;
                    ctx?: { category?: string };
                  },
              )
          : [];
        const lockAcquisitions = events.filter((e) => e.event === "lock.acquired").length;
        const indexUpserts = events.filter((e) => e.event === "index.upserted").length;
        // MINOR 7 (2026-09-13 Codex frontier review): actual obsidian-cli
        // subprocess counts, classified by category, distinct from the
        // lock/upsert counts above.
        const cliInvocations = events.filter((e) => e.event === "vault.cli_invoked");
        const listCalls = cliInvocations.filter((e) => e.ctx?.category === "list").length;
        const readCalls = cliInvocations.filter((e) => e.ctx?.category === "read").length;
        const writeCalls = cliInvocations.filter((e) => e.ctx?.category === "write").length;

        // Recorded, not asserted against a threshold (no cache/threshold is
        // to be invented here per Task 6 6B): the accepted per-capture
        // full-collection vault scan is a measured cost.
        console.log(
          `[M01] two-page site: elapsedMs=${elapsedMs.toFixed(0)} lockAcquisitions=${lockAcquisitions} indexUpserts=${indexUpserts} subprocessTotal=${cliInvocations.length} vaultList=${listCalls} vaultRead=${readCalls} vaultWrite=${writeCalls}`,
        );
        expect(lockAcquisitions).toBeGreaterThan(0);
        expect(indexUpserts).toBeGreaterThan(0);
        expect(cliInvocations.length).toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(logDir, { recursive: true, force: true });
      }
    });

    it("M02: F09 mixed-file directory — subprocess/vault-access counts and elapsed time", async () => {
      const mixedDir = copyFixtureDirToTemp(path.join("vault-capture", "mixed-dir"));
      const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-m02-"));
      const logFile = path.join(logDir, "log.jsonl");
      try {
        const startedAt = performance.now();
        const run = await runVaultCli(
          [
            "capture",
            mixedDir,
            "--collection",
            "m02-mixed-dir",
            "--max-pages",
            "10",
            "--max-depth",
            "2",
            "--state-dir",
            stateDir,
            "--json",
          ],
          { env: { SB_DOCS_LOG: "1", SB_DOCS_LOG_FILE: logFile } },
        );
        const elapsedMs = performance.now() - startedAt;
        expect(run.code).toBe(0);

        const events = fs.existsSync(logFile)
          ? fs
              .readFileSync(logFile, "utf8")
              .split("\n")
              .filter(Boolean)
              .map(
                (line) =>
                  JSON.parse(line) as {
                    event: string;
                    ctx?: { category?: string };
                  },
              )
          : [];
        const lockAcquisitions = events.filter((e) => e.event === "lock.acquired").length;
        const indexUpserts = events.filter((e) => e.event === "index.upserted").length;
        const cliInvocations = events.filter((e) => e.event === "vault.cli_invoked");
        const listCalls = cliInvocations.filter((e) => e.ctx?.category === "list").length;
        const readCalls = cliInvocations.filter((e) => e.ctx?.category === "read").length;
        const writeCalls = cliInvocations.filter((e) => e.ctx?.category === "write").length;

        console.log(
          `[M02] mixed-dir (3 files): elapsedMs=${elapsedMs.toFixed(0)} lockAcquisitions=${lockAcquisitions} indexUpserts=${indexUpserts} subprocessTotal=${cliInvocations.length} vaultList=${listCalls} vaultRead=${readCalls} vaultWrite=${writeCalls}`,
        );
        expect(lockAcquisitions).toBeGreaterThan(0);
        expect(indexUpserts).toBeGreaterThanOrEqual(3);
        expect(cliInvocations.length).toBeGreaterThan(0);
      } finally {
        fs.rmSync(path.dirname(mixedDir), { recursive: true, force: true });
        fs.rmSync(logDir, { recursive: true, force: true });
      }
    });
  });

  describe.skipIf(!NETWORK_AVAILABLE)("live rows (network-dependent, dated 2026-09-13)", () => {
    it("F01: single docs page (RFC 2549, www.rfc-editor.org) captures its known text", async () => {
      const run = await runVaultCli([
        "capture",
        "https://www.rfc-editor.org/rfc/rfc2549.txt",
        "--collection",
        "f01-single-page",
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(run.code).toBe(0);
      const outcomes = envelopeOf(run).outcomes as Array<{
        publication?: { status: string; path: string; markdown: string; digest?: string };
      }>;
      await assertQualifiedNote({
        outcome: outcomes[0],
        facts: ["Avian Carriers"],
        query: "Avian Carriers",
        collection: "f01-single-page",
        version: "",
        sourceUrlContains: "rfc2549.txt",
      });
    });

    it("F02: GitHub README (arabold/docs-mcp-server) captures known project text", async () => {
      // MAJOR 3 (2026-09-13 Codex frontier review): a base-repo-URL crawl
      // with a small `--max-pages` does NOT reliably include README.md --
      // GitHub's tree listing is not alphabetical, and a real run with
      // `--max-pages 5` fetched five `.agent/skills/*` files and the wiki
      // page, never README.md. Capturing the README's own blob URL directly
      // (the same depth-0-is-discovery-only path F03 already exercises for
      // package.json) deterministically proves README capture, pinned to
      // text unique to README.md's own H1 rather than the generic package
      // name string that also appears in package.json and elsewhere in the
      // repo. GitHub revision captured: the `main` branch, dated 2026-09-13
      // (live row; content may drift upstream over time).
      const run = await runVaultCli([
        "capture",
        "https://github.com/arabold/docs-mcp-server/blob/main/README.md",
        "--collection",
        "f02-github-readme",
        "--max-depth",
        "1",
        "--max-pages",
        "2",
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(run.code).toBe(0);
      const outcomes = envelopeOf(run).outcomes as Array<{
        sourceUrl: string;
        publication?: { status: string; path: string; markdown: string; digest?: string };
      }>;
      await assertQualifiedNote({
        outcome: outcomes[0],
        facts: ["Grounded Docs: Your AI's Up-to-Date Documentation Expert"],
        query: "Grounded Docs",
        collection: "f02-github-readme",
        version: "",
        sourceUrlContains: "README.md",
      });
    });

    it("F03: GitHub blob (package.json) captures the exact package name", async () => {
      // Same depth-0-is-discovery-only behavior as F02: even a direct blob
      // URL only self-discovers at depth 0 (GitHubScraperStrategy.ts:609-634)
      // and is fetched as content when re-visited at depth 1. GitHub
      // revision captured: the `main` branch, dated 2026-09-13.
      const run = await runVaultCli([
        "capture",
        "https://github.com/arabold/docs-mcp-server/blob/main/package.json",
        "--collection",
        "f03-github-blob",
        "--max-depth",
        "1",
        "--max-pages",
        "2",
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(run.code).toBe(0);
      const outcomes = envelopeOf(run).outcomes as Array<{
        publication?: { status: string; path: string; markdown: string; digest?: string };
      }>;
      await assertQualifiedNote({
        outcome: outcomes[0],
        facts: ["docs-mcp-server"],
        query: "docs-mcp-server",
        collection: "f03-github-blob",
        version: "",
        sourceUrlContains: "package.json",
      });
    });

    it("F05: JS-rendered page (quotes.toscrape.com/js/) captures JS-injected text", async () => {
      const run = await runVaultCli([
        "capture",
        "https://quotes.toscrape.com/js/",
        "--collection",
        "f05-js-rendered",
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(run.code).toBe(0);
      const outcomes = envelopeOf(run).outcomes as Array<{
        publication?: { status: string; path: string; markdown: string; digest?: string };
      }>;
      await assertQualifiedNote({
        outcome: outcomes[0],
        facts: ["Albert Einstein"],
        query: "Albert Einstein",
        collection: "f05-js-rendered",
        version: "",
        sourceUrlContains: "quotes.toscrape.com",
      });
    });
  });

  it("never touched the operator's live vault", () => {
    if (!fs.existsSync(LIVE_VAULT)) return;
    for (const collection of COLLECTIONS_UNDER_TEST) {
      expect(fs.existsSync(path.join(LIVE_VAULT, "30 Tools-Models/Doc Sets", collection))).toBe(
        false,
      );
      expect(
        fs.existsSync(path.join(LIVE_VAULT, "00 Inbox/Source Captures", collection)),
      ).toBe(false);
    }
  });
});

describe.skipIf(!cliAvailable)(
  "D03: DOCS_MCP_CONFIG-unset config auto-write, in a sandboxed HOME (6D probe)",
  () => {
    /**
     * Spawns the built CLI with `DOCS_MCP_CONFIG` deliberately UNSET, inside
     * a sandboxed `HOME`/`XDG_CONFIG_HOME` so `loadConfig()`'s default
     * system-config path (`env-paths`, which this worktree confirmed honours
     * a sandboxed `HOME` on this platform — `os.homedir()` reads `$HOME`)
     * can never resolve to the operator's real
     * `~/Library/Preferences/docs-mcp-server/config.yaml`.
     */
    /**
     * `ObsidianCli`'s executable path is `$HOME/ai-stack/bin/obsidian-cli`,
     * resolved from `process.env.HOME` (`src/vault/ObsidianCli.ts`). A
     * sandboxed `HOME` therefore also relocates *that* lookup, not just
     * `env-paths`' config resolution — so the sandbox needs its own
     * `ai-stack/bin/obsidian-cli` symlinked to the real one, or every
     * command here would fail with `ENOENT` before ever reaching
     * `loadConfig()`.
     */
    function symlinkObsidianCliInto(home: string): void {
      const binDir = path.join(home, "ai-stack", "bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.symlinkSync(cliPath, path.join(binDir, "obsidian-cli"));
    }

    async function runWithUnsetConfig(
      args: string[],
      env: { home: string; vaultPath: string; stateDir: string },
    ): Promise<{ code: number | null; stdout: string; stderr: string }> {
      symlinkObsidianCliInto(env.home);
      return await new Promise((resolve, reject) => {
        const proc = spawn(vaultCliEntry, args, {
          cwd: projectRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            USER: process.env.USER,
            HOME: env.home,
            XDG_CONFIG_HOME: path.join(env.home, ".config"),
            OBSIDIAN_VAULT: env.vaultPath,
            // Deliberately NOT set: DOCS_MCP_CONFIG.
          },
          timeout: 60_000,
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => {
          stdout += d.toString();
        });
        proc.stderr.on("data", (d) => {
          stderr += d.toString();
        });
        proc.on("error", reject);
        proc.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    }

    /** The default system config path env-paths resolves on macOS under a given HOME. */
    function sandboxedConfigPath(home: string): string {
      return path.join(home, "Library", "Preferences", "docs-mcp-server", "config.yaml");
    }

    it("prints the resolved default config path honouring the sandboxed HOME (not the operator's real HOME)", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-verify-"));
      try {
        const result = execFileSync(
          process.execPath,
          ["-e", "console.log(require('os').homedir())"],
          { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" },
        );
        expect(result.trim()).toBe(home);
        expect(home).not.toBe(os.homedir());
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    // MINOR 8 (2026-09-13 Codex frontier review): confirmed findings from a
    // direct run of this exact probe, asserted explicitly rather than only
    // logged — this documents the current defect, it is not a guarantee of
    // desired behavior. If Task 7's config-containment fix lands, these
    // expectations flip and must be updated, not left silently green.
    const EXPECTED_CONFIG_CREATED: Record<string, boolean> = {
      search: true,
      read: false,
      reindex: true,
      capture: true,
    };

    for (const command of ["search", "read", "reindex", "capture"] as const) {
      it(`D03: "${command}" with DOCS_MCP_CONFIG unset — confirmed config-creation finding`, async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-home-"));
        const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-vault-"));
        const localStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-state-"));
        fs.mkdirSync(path.join(vaultPath, "00 Inbox"), { recursive: true });
        try {
          const configPath = sandboxedConfigPath(home);
          expect(fs.existsSync(configPath)).toBe(false);

          // MINOR E (2026-09-13 Codex frontier review, round 2): seed a real
          // note and assert `read` returns its complete bytes with exit 0,
          // rather than reading a nonexistent path and accepting a weak
          // "stderr doesn't look like a yargs usage error" check (which
          // trivially passes on empty stderr or an unrelated startup
          // failure). `symlinkObsidianCliInto` (called inside
          // `runWithUnsetConfig`) puts the REAL obsidian-cli in the
          // sandbox's `$HOME/ai-stack/bin/obsidian-cli` lookup path, so an
          // ENOENT there can no longer masquerade as "note not found".
          const seededNoteBody = "D03-READ-PROBE-2001 seeded note body.\n";
          if (command === "read") {
            fs.mkdirSync(path.join(vaultPath, "00 Inbox"), { recursive: true });
            fs.writeFileSync(path.join(vaultPath, "00 Inbox", "d03-seed.md"), seededNoteBody);
          }

          const commandArgs: Record<string, string[]> = {
            search: ["search", "anything", "--state-dir", localStateDir, "--json"],
            read: ["read", "00 Inbox/d03-seed.md"],
            reindex: ["reindex", "--state-dir", localStateDir, "--json"],
            capture: [
              "capture",
              "https://example.invalid/d03-probe",
              "--state-dir",
              localStateDir,
              "--json",
            ],
          };
          const result = await runWithUnsetConfig(commandArgs[command], {
            home,
            vaultPath,
            stateDir: localStateDir,
          });

          // Proves each process actually reached its command handler
          // (loadConfig() runs as part of that handler) rather than dying
          // on an argument-parsing error before ever touching config: every
          // command here produces either a JSON envelope on stdout (the
          // `--json` cases) or, for `read` (no `--json` in its real usage),
          // the complete seeded note bytes with exit 0.
          if (command === "read") {
            expect(
              result.code,
              `read exit code: stdout=${result.stdout} stderr=${result.stderr}`,
            ).toBe(0);
            expect(result.stdout).toBe(`${seededNoteBody}\n`);
          } else {
            const line = result.stdout.split("\n").find((l) => l.startsWith("{"));
            expect(line, `expected a JSON envelope on stdout: ${result.stdout}\n${result.stderr}`).toBeDefined();
          }

          const created = fs.existsSync(configPath);
          console.log(
            `[D03] ${command}: sandboxed default config ${created ? "WAS" : "was NOT"} created at ${configPath}`,
          );
          expect(created).toBe(EXPECTED_CONFIG_CREATED[command]);
          // The vault used here is never the operator's; the sandboxed HOME
          // used here is never the operator's real home directory either.
          expect(home).not.toBe(os.homedir());
        } finally {
          fs.rmSync(home, { recursive: true, force: true });
          fs.rmSync(vaultPath, { recursive: true, force: true });
          fs.rmSync(localStateDir, { recursive: true, force: true });
        }
      });
    }

    it(
      // MINOR E negative control (2026-09-13 Codex frontier review, round
      // 2): a failing backend (obsidian-cli symlink pointing at a
      // nonexistent binary) must fail visibly, never be silently absorbed
      // into "configCreated=false" as if it were a clean, successful
      // no-op. This proves the D03 rows above are actually exercising a
      // working `read`, not accidentally passing because any failure looks
      // the same as "no config written".
      "D03 negative control: a broken obsidian-cli backend fails read visibly, not silently",
      async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-broken-"));
        const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-broken-vault-"));
        const localStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-broken-state-"));
        fs.mkdirSync(path.join(vaultPath, "00 Inbox"), { recursive: true });
        try {
          // Deliberately broken: a symlink target that does not exist,
          // instead of the real obsidian-cli.
          const binDir = path.join(home, "ai-stack", "bin");
          fs.mkdirSync(binDir, { recursive: true });
          fs.symlinkSync(
            path.join(home, "does-not-exist-obsidian-cli"),
            path.join(binDir, "obsidian-cli"),
          );
          fs.writeFileSync(
            path.join(vaultPath, "00 Inbox", "d03-seed.md"),
            "D03-NEGATIVE-CONTROL-2002\n",
          );

          const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
            (resolve, reject) => {
              const proc = spawn(vaultCliEntry, ["read", "00 Inbox/d03-seed.md"], {
                cwd: projectRoot,
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                  PATH: process.env.PATH,
                  USER: process.env.USER,
                  HOME: home,
                  XDG_CONFIG_HOME: path.join(home, ".config"),
                  OBSIDIAN_VAULT: vaultPath,
                },
                timeout: 60_000,
              });
              let stdout = "";
              let stderr = "";
              proc.stdout.on("data", (d) => {
                stdout += d.toString();
              });
              proc.stderr.on("data", (d) => {
                stderr += d.toString();
              });
              proc.on("error", reject);
              proc.on("close", (code) => resolve({ code, stdout, stderr }));
            },
          );

          expect(result.code).not.toBe(0);
          expect(result.stdout).not.toBe("D03-NEGATIVE-CONTROL-2002\n\n");
        } finally {
          fs.rmSync(home, { recursive: true, force: true });
          fs.rmSync(vaultPath, { recursive: true, force: true });
          fs.rmSync(localStateDir, { recursive: true, force: true });
        }
      },
    );

    it(
      // RECORDED FINDING, not a passing guarantee: the plan asks this probe
      // to "assert its bytes are preserved" as the desired outcome, but the
      // measured reality is that `loadConfig()`'s default-system-path branch
      // rewrites the file it finds (merging in every default key) regardless
      // of which vault command ran. This is the exact D03 finding — recorded
      // here, not fixed, per this packet's explicit instruction not to touch
      // `loadConfig()`. The assertion documents the current (bad) truth so
      // this stays a real regression trigger: if Task 7's containment fix
      // lands, this test starts failing in the other direction and must be
      // updated, not silently left green either way.
      "D03: an existing user config's bytes are OVERWRITTEN when DOCS_MCP_CONFIG is unset (recorded finding, not fixed here)",
      async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-home-"));
        const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-vault-"));
        const localStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-state-"));
        fs.mkdirSync(path.join(vaultPath, "00 Inbox"), { recursive: true });
        try {
          const configPath = sandboxedConfigPath(home);
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          const existingBytes = "# a pre-existing user config\nembeddings: {}\n";
          fs.writeFileSync(configPath, existingBytes, "utf8");

          await runWithUnsetConfig(
            ["search", "anything", "--state-dir", localStateDir, "--json"],
            { home, vaultPath, stateDir: localStateDir },
          );

          const afterBytes = fs.readFileSync(configPath, "utf8");
          const preserved = afterBytes === existingBytes;
          console.log(
            `[D03] existing-config preservation: bytes ${preserved ? "UNCHANGED" : "CHANGED"} (finding: NOT preserved for "search" with DOCS_MCP_CONFIG unset)`,
          );
          // Confirmed finding: the pre-existing config is NOT preserved.
          expect(preserved).toBe(false);
          expect(afterBytes).not.toBe(existingBytes);
        } finally {
          fs.rmSync(home, { recursive: true, force: true });
          fs.rmSync(vaultPath, { recursive: true, force: true });
          fs.rmSync(localStateDir, { recursive: true, force: true });
        }
      },
    );
  },
);
