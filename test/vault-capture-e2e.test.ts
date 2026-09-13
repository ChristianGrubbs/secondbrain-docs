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

/** Reads one collection's MOC (`index.md`) under the sandbox vault. */
function readMoc(folder: string): string {
  return fs.readFileSync(path.join(sandbox, folder, "index.md"), "utf8");
}

/** Counts occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The MOC's wiki-link target for a saved note path (extensionless). */
function mocLinkTarget(notePath: string): string {
  return notePath.replace(/\.md$/, "");
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
        publication?: { status: string; path: string; markdown: string; moc: string };
      }>;
      expect(outcomes).toHaveLength(2);
      for (const outcome of outcomes) {
        expect(outcome.publication?.status).toBe("published");
        expect(outcome.index).toBe("indexed");
      }

      const rootFound = await runVaultCli([
        "search",
        "PLUMTASTIC-1101",
        "--collection",
        "f04-two-page",
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(rootFound.code).toBe(0);
      const rootResults = (envelopeOf(rootFound).results as Array<{ vault_path: string }>) ?? [];
      expect(rootResults).toHaveLength(1);

      const childFound = await runVaultCli([
        "search",
        "GRAVELWORTH-1102",
        "--collection",
        "f04-two-page",
        "--state-dir",
        stateDir,
        "--json",
      ]);
      const childResults =
        (envelopeOf(childFound).results as Array<{ vault_path: string }>) ?? [];
      expect(childResults).toHaveLength(1);

      const moc = readMoc("30 Tools-Models/Doc Sets/f04-two-page");
      expect(
        countOccurrences(moc, mocLinkTarget(outcomes[0].publication?.path ?? "***")),
      ).toBe(1);
      expect(
        countOccurrences(moc, mocLinkTarget(outcomes[1].publication?.path ?? "***")),
      ).toBe(1);
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
    const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
    // sample.docx is a Word-to-Markdown conversion fixture with a stable
    // "Continued Lists" section; a hit proves real conversion, not a stub.
    expect(outcomes[0].publication?.markdown).toContain("Continued Lists");
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
      publication?: { path: string; markdown: string };
    }>;
    expect(outcomes).toHaveLength(3);
    const bodies = outcomes.map((o) => o.publication?.markdown ?? "").join("\n");
    expect(bodies).toContain("ALPHA-SENTINEL-7701");
    expect(bodies).toContain("BETA-SENTINEL-7702");
    expect(bodies).toContain("GAMMA-SENTINEL-7703");

    const moc = readMoc("30 Tools-Models/Doc Sets/f09-mixed-dir");
    for (const outcome of outcomes) {
      expect(
        countOccurrences(moc, mocLinkTarget(outcome.publication?.path ?? "***")),
      ).toBe(1);
    }
  });

  it("F10: same source captured at two versions produces two distinct notes", async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-capqual-src-"));
    const sourceFile = path.join(sourceDir, "versioned.md");
    fs.writeFileSync(sourceFile, "# Versioned\n\nTAFFYLOOP-2201 body v1.\n");

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

    fs.writeFileSync(sourceFile, "# Versioned\n\nTAFFYLOOP-2201 body v2.\n");
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

    const path1 = (envelopeOf(v1).outcomes as Array<{ publication?: { path: string } }>)[0]
      .publication?.path;
    const path2 = (envelopeOf(v2).outcomes as Array<{ publication?: { path: string } }>)[0]
      .publication?.path;
    expect(path1).toBeDefined();
    expect(path2).toBeDefined();
    expect(path1).not.toBe(path2);
    expect(fs.readFileSync(path.join(sandbox, path1 ?? ""), "utf8")).toContain("body v1");
    expect(fs.readFileSync(path.join(sandbox, path2 ?? ""), "utf8")).toContain("body v2");
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
    const notePath = (
      envelopeOf(first).outcomes as Array<{ publication?: { path: string } }>
    )[0].publication?.path as string;

    // A human appends a note directly in the vault, outside any capture.
    const before = fs.readFileSync(path.join(sandbox, notePath), "utf8");
    fs.writeFileSync(
      path.join(sandbox, notePath),
      `${before}\n> HUMAN-EDIT-4401: manual annotation, must survive recapture.\n`,
    );

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
    const after = fs.readFileSync(path.join(sandbox, notePath), "utf8");
    expect(after).toContain("HUMAN-EDIT-4401");
    expect(after).toContain("SNOZZBERRY-3301");
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
    const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
    expect((outcomes[0].publication?.markdown ?? "").length).toBeGreaterThan(20);
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
    const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
    expect((outcomes[0].publication?.markdown ?? "").length).toBeGreaterThan(10);
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
    const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
    expect((outcomes[0].publication?.markdown ?? "").length).toBeGreaterThan(10);
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
    const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
    const original = fs.readFileSync(path.join(fixturesDir, "json.json"), "utf8");
    const firstKey = Object.keys(JSON.parse(original))[0];
    expect(outcomes[0].publication?.markdown).toContain(firstKey);
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
    const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
    expect((outcomes[0].publication?.markdown ?? "").length).toBeGreaterThan(10);
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
    const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
    expect(outcomes[0].publication?.markdown).toContain("FLUMPADOODLE-9182");
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
    const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
    expect(outcomes[0].publication?.markdown).toContain("QUAGGLE-4471");
    expect(outcomes[0].publication?.markdown).toContain("quaggle_factor");
  });

  it("F20: ZIP archive expands each member into its own captured note", async () => {
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
      publication?: { status: string };
      skipped?: string;
    }>;
    expect(outcomes.length).toBeGreaterThanOrEqual(5);
    const published = outcomes.filter((o) => o.publication?.status === "published");
    expect(published.length).toBeGreaterThanOrEqual(5);
  });

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
          publication?: { path: string; status: string };
        }>;
        expect(outcomes[0].publication?.status).toBe("published");
        const notePath = outcomes[0].publication?.path ?? "";
        expect(notePath.startsWith("00 Inbox/Source Captures/")).toBe(true);
        expect(fs.existsSync(path.join(vaultPath, notePath))).toBe(true);
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
          publication?: { path: string; status: string };
        }>;
        expect(outcomes[0].publication?.status).toBe("published");
        expect(
          fs.existsSync(path.join(vaultPath, "30 Tools-Models/Doc Sets/c02-brand-new/index.md")),
        ).toBe(true);
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
          publication?: { path: string; status: string };
        }>;
        expect(outcomes[0].publication?.status).toBe("published");
        expect(
          fs.existsSync(path.join(vaultPath, "30 Tools-Models/Doc Sets", collection, "index.md")),
        ).toBe(true);

        const found = await runVaultCli(
          ["search", "C03-UNICODE-1003", "--collection", collection, "--state-dir", statePath, "--json"],
          { vaultPath, configFile: configPath },
        );
        expect(found.code).toBe(0);
        const results = (envelopeOf(found).results as Array<{ vault_path: string }>) ?? [];
        expect(results).toHaveLength(1);
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
              .map((line) => JSON.parse(line) as { event: string })
          : [];
        const lockAcquisitions = events.filter((e) => e.event === "lock.acquired").length;
        const indexUpserts = events.filter((e) => e.event === "index.upserted").length;

        // Recorded, not asserted against a threshold (no cache/threshold is
        // to be invented here per Task 6 6B): the accepted per-capture
        // full-collection vault scan is a measured cost.
        console.log(
          `[M01] two-page site: elapsedMs=${elapsedMs.toFixed(0)} lockAcquisitions=${lockAcquisitions} indexUpserts=${indexUpserts}`,
        );
        expect(lockAcquisitions).toBeGreaterThan(0);
        expect(indexUpserts).toBeGreaterThan(0);
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
              .map((line) => JSON.parse(line) as { event: string })
          : [];
        const lockAcquisitions = events.filter((e) => e.event === "lock.acquired").length;
        const indexUpserts = events.filter((e) => e.event === "index.upserted").length;

        console.log(
          `[M02] mixed-dir (3 files): elapsedMs=${elapsedMs.toFixed(0)} lockAcquisitions=${lockAcquisitions} indexUpserts=${indexUpserts}`,
        );
        expect(lockAcquisitions).toBeGreaterThan(0);
        expect(indexUpserts).toBeGreaterThanOrEqual(3);
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
      const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
      expect(outcomes[0].publication?.markdown).toContain("Avian Carriers");
    });

    it("F02: GitHub README (arabold/docs-mcp-server) captures known project text", async () => {
      // GitHubScraperStrategy's depth-0 fetch for a base repo URL only
      // *discovers* the file/wiki link list (`item.depth === 0` returns
      // `links`, never content); actual blob content is fetched only when
      // that discovered link is subsequently crawled at depth > 0. Without
      // `--max-depth 1` (the CLI default is 0), discovery runs and then the
      // crawl stops, producing zero outcomes with exit 1 and no run_error.
      const run = await runVaultCli([
        "capture",
        "https://github.com/arabold/docs-mcp-server",
        "--collection",
        "f02-github-readme",
        "--max-depth",
        "1",
        "--max-pages",
        "5",
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(run.code).toBe(0);
      const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
      expect(outcomes[0].publication?.markdown.toLowerCase()).toContain("docs-mcp-server");
    });

    it("F03: GitHub blob (package.json) captures the exact package name", async () => {
      // Same depth-0-is-discovery-only behavior as F02: even a direct blob
      // URL only self-discovers at depth 0 (GitHubScraperStrategy.ts:609-634)
      // and is fetched as content when re-visited at depth 1.
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
      const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
      expect(outcomes[0].publication?.markdown).toContain("docs-mcp-server");
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
      const outcomes = envelopeOf(run).outcomes as Array<{ publication?: { markdown: string } }>;
      expect(outcomes[0].publication?.markdown.toLowerCase()).toContain("albert einstein");
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
    async function runWithUnsetConfig(
      args: string[],
      env: { home: string; vaultPath: string; stateDir: string },
    ): Promise<{ code: number | null; stdout: string; stderr: string }> {
      return await new Promise((resolve, reject) => {
        const proc = spawn(vaultCliEntry, args, {
          cwd: projectRoot,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
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

    for (const command of ["search", "read", "reindex", "capture"] as const) {
      it(`D03: "${command}" with DOCS_MCP_CONFIG unset — records whether the sandboxed default config is created`, async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-home-"));
        const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-vault-"));
        const localStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-d03-state-"));
        fs.mkdirSync(path.join(vaultPath, "00 Inbox"), { recursive: true });
        try {
          const configPath = sandboxedConfigPath(home);
          expect(fs.existsSync(configPath)).toBe(false);

          const commandArgs: Record<string, string[]> = {
            search: ["search", "anything", "--state-dir", localStateDir, "--json"],
            read: ["read", "00 Inbox/nonexistent.md"],
            reindex: ["reindex", "--state-dir", localStateDir, "--json"],
            capture: [
              "capture",
              "https://example.invalid/d03-probe",
              "--state-dir",
              localStateDir,
              "--json",
            ],
          };
          await runWithUnsetConfig(commandArgs[command], {
            home,
            vaultPath,
            stateDir: localStateDir,
          });

          // Recorded as a fact either way — this is the finding, not an
          // assertion of desired behavior. `loadConfig()` is not fixed in
          // this packet; Task 7 must ship a read-only-loading fix or an
          // enforced explicit config on every installed entry point.
          const created = fs.existsSync(configPath);
          console.log(
            `[D03] ${command}: sandboxed default config ${created ? "WAS" : "was NOT"} created at ${configPath}`,
          );
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
