#!/usr/bin/env node
/**
 * Runs the network-dependent "live" rows (F01 single docs page, F02 GitHub
 * README, F03 GitHub blob, F05 JS-rendered page) against the built
 * `dist/vault-cli.js`, an explicitly designated throwaway vault, and a
 * throwaway state directory + `DOCS_MCP_CONFIG`. Prints one JSON summary
 * line to stdout so Task 7 can consume it as a scripted live-surface check.
 *
 * MAJOR 3 / MAJOR C (2026-09-13 Codex frontier review, rounds 1 and 2): each
 * row runs the exact same `qualifyNote` contract
 * `test/vault-capture-e2e.test.ts` uses (facts in saved bytes, frontmatter
 * identity, whole-note digest, exactly one MOC link, `search` resolving the
 * note's identity, `read` returning the complete saved bytes) from the one
 * shared module `scripts/lib/qualification-contract.mjs` — not a
 * second, independently drifting, weaker copy. A row whose network
 * dependency is unavailable is reported as `"blocked"`, never `"pass"`.
 *
 * No listener is started; nothing here reads or writes the operator's real
 * vault, state directory, or `DOCS_MCP_CONFIG`.
 *
 * Usage:
 *   node scripts/live-check-vault.mjs --vault /absolute/throwaway/vault [--state-dir DIR]
 *
 * `--vault` is required and MUST be a throwaway directory (never the
 * operator's live vault at /Volumes/3M/Obsidian) — this script refuses to
 * run against that path.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNotLiveVault, assertNotSymlink } from "./lib/vault-guard.mjs";
import { qualifyNote } from "./lib/qualification-contract.mjs";

const LIVE_VAULT = "/Volumes/3M/Obsidian";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultCliEntry = path.join(projectRoot, "dist", "vault-cli.js");

/**
 * Resolves and guard-checks the state directory and config path for one
 * run, WITHOUT performing any filesystem write -- this is what lets
 * `scripts/live-check-vault.test.ts` prove rejection happens before any
 * write, using a fake `liveVaultPath` rather than the real live vault
 * (MAJOR 2, 2026-09-13 Codex frontier review, round 4).
 *
 * @param options.stateDirArg The raw `--state-dir` argument, or undefined
 *   to use a fresh `mkdtemp` directory.
 * @param options.liveVaultPath The live vault path to guard against.
 * @param options.overwriteConfig Whether an existing config.yaml may be
 *   replaced.
 * @returns `{ stateDir, configFile, configPreexisted }` on success.
 * @throws If the resolved state directory or config path is the live vault
 *   or a symlink alias into it, or if config.yaml already exists and
 *   `overwriteConfig` is not set.
 */
export function resolveGuardedState({ stateDirArg, liveVaultPath, overwriteConfig }) {
  const stateDir = stateDirArg
    ? path.resolve(stateDirArg)
    : fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-livecheck-state-"));

  // MAJOR 1 (2026-09-13 Codex frontier review, round 5): a DANGLING
  // config.yaml symlink (or a dangling symlinked state dir) whose target
  // does not yet exist made `realpathSync` throw inside
  // `resolveNearestExistingAncestor`, which then fell back to the
  // symlink's own external parent directory -- silently bypassing
  // containment entirely, even though `writeFileSync`/`mkdirSync` would
  // still follow the symlink into the live vault. Symlinks are rejected
  // outright here, before the containment check ever runs, rather than
  // attempting to resolve a target that may not exist.
  assertNotSymlink(stateDir, "state directory");
  assertNotLiveVault(stateDir, liveVaultPath);

  const configFile = path.join(stateDir, "config.yaml");
  // Checked separately from `stateDir`: a caller could in principle pass a
  // `configFile`-shaped symlink alias distinct from `stateDir` itself in a
  // future revision of this script, and this keeps the guard from
  // depending on that never changing.
  assertNotSymlink(configFile, "config.yaml");
  assertNotLiveVault(configFile, liveVaultPath);

  const configPreexisted = fs.existsSync(configFile);
  if (configPreexisted && !overwriteConfig) {
    throw new Error(
      `refusing to overwrite existing config at ${configFile} -- pass --overwrite-config to replace it explicitly, or use a different --state-dir`,
    );
  }

  return { stateDir, configFile, configPreexisted };
}

/** Parses `--flag value` pairs from argv; unknown flags are ignored. */
function parseArgs(argv) {
  const args = { overwriteConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--vault") args.vault = argv[++i];
    if (argv[i] === "--state-dir") args.stateDir = argv[++i];
    if (argv[i] === "--overwrite-config") args.overwriteConfig = true;
  }
  return args;
}

function fail(message) {
  console.error(`live-check-vault: ${message}`);
  process.exit(1);
}

// Runs the CLI body only when this file is the program's entry point --
// `scripts/live-check-vault.test.ts` imports `resolveGuardedState` from
// this same module, and top-level argv-parsing/exit-on-missing-`--vault`
// code must not fire (and abort the whole test process) on import.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  await main();
}

async function main() {
const args = parseArgs(process.argv.slice(2));
if (!args.vault) {
  fail("--vault <absolute-throwaway-vault-path> is required");
}
const vaultPath = path.resolve(args.vault);
try {
  // Canonicalizes the *supplied* destination too (resolving the nearest
  // existing ancestor when the vault directory doesn't exist yet), so a
  // symlink alias pointing into the live vault cannot bypass this guard —
  // and handles an absent live vault explicitly rather than letting
  // `realpathSync` throw.
  assertNotLiveVault(vaultPath, LIVE_VAULT);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
if (!fs.existsSync(vaultCliEntry)) {
  fail(`${vaultCliEntry} does not exist — run \`npm run build\` first`);
}

const cliPath = path.join(os.homedir(), "ai-stack", "bin", "obsidian-cli");
if (!fs.existsSync(cliPath)) {
  fail(`obsidian-cli not found at ${cliPath}`);
}

fs.mkdirSync(path.join(vaultPath, "00 Inbox"), { recursive: true });

// MAJOR 2 (2026-09-13 Codex frontier review, round 4): only `--vault` was
// guard-checked. A supplied `--state-dir` inside the live vault (or a
// symlink alias into it) was created and its config.yaml overwritten
// immediately, before any capture ran and before the vault guard ever saw
// it. The state directory and config path now go through the exact same
// containment check `--vault` uses, and an existing config.yaml is never
// silently overwritten, all before any write.
let stateDir;
let configFile;
try {
  ({ stateDir, configFile } = resolveGuardedState({
    stateDirArg: args.stateDir,
    liveVaultPath: LIVE_VAULT,
    overwriteConfig: args.overwriteConfig,
  }));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
fs.mkdirSync(stateDir, { recursive: true });

fs.writeFileSync(
  configFile,
  [
    "scraper:",
    "  security:",
    "    fileAccess:",
    "      mode: allowedRoots",
    "      allowedRoots:",
    `        - ${JSON.stringify(os.tmpdir())}`,
    "      followSymlinks: true",
    "    network:",
    "      allowPrivateNetworks: true",
    "      allowedHosts:",
    '        - "*"',
  ].join("\n"),
  "utf8",
);

// Prove the override before any live capture, exactly like the e2e suite.
const status = execFileSync(cliPath, ["status"], {
  encoding: "utf8",
  env: { ...process.env, OBSIDIAN_VAULT: vaultPath },
});
if (!status.includes(`vault: ok (${vaultPath})`)) {
  fail(`obsidian-cli did not report the throwaway vault ${vaultPath}; refusing to capture`);
}

/** Runs the built CLI directly and returns `{code, stdout, stderr}` plus the parsed JSON envelope (or null). */
function runCli(cliArgs) {
  const result = spawnSync(vaultCliEntry, cliArgs, {
    encoding: "utf8",
    env: { ...process.env, OBSIDIAN_VAULT: vaultPath, DOCS_MCP_CONFIG: configFile },
    timeout: 120_000,
  });
  const line = (result.stdout ?? "").split("\n").find((l) => l.startsWith("{"));
  let envelope = null;
  try {
    envelope = line ? JSON.parse(line) : null;
  } catch {
    envelope = null;
  }
  return {
    envelope,
    asCliResult: { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" },
  };
}

/**
 * Runs one live row through the full shared qualification contract.
 *
 * A network-dependent failure to reach the source at all (spawn error,
 * timeout, or a run that never produced any published outcome) is reported
 * as `"blocked"`, never `"pass"` -- distinct from a genuine assertion
 * failure (`"fail"`), which means the endpoint answered but the contract
 * broke.
 */
async function runRow(id, { captureArgs, collection, facts, query, sourceUrlContains }) {
  const { envelope, asCliResult: captureResult } = runCli([
    "capture",
    ...captureArgs,
    "--collection",
    collection,
    "--state-dir",
    stateDir,
    "--json",
  ]);

  const outcome = envelope?.outcomes?.[0];
  if (captureResult.code !== 0 || !outcome || outcome.publication?.status !== "published") {
    return {
      id,
      status: "blocked",
      reason: `capture did not publish (exit ${captureResult.code}, ${
        envelope?.run_error ?? captureResult.stderr?.slice(0, 300) ?? "no envelope"
      })`,
    };
  }

  const result = await qualifyNote({
    vaultPath,
    notePath: outcome.publication.path,
    expectedDigest: outcome.publication.digest,
    facts,
    collection,
    query,
    version: "",
    sourceUrlContains,
    runCli: async (cliArgs) => {
      const withStateDir =
        cliArgs[0] === "read" ? cliArgs : [...cliArgs, "--state-dir", stateDir];
      return runCli(withStateDir).asCliResult;
    },
  });

  return result.ok
    ? { id, status: "pass", notePath: result.notePath, digest: result.digest }
    : { id, status: "fail", reason: result.reason, notePath: result.notePath };
}

const rows = [
  await runRow("F01", {
    captureArgs: ["https://www.rfc-editor.org/rfc/rfc2549.txt"],
    collection: "livecheck-f01-single-page",
    facts: ["Avian Carriers"],
    query: "Avian Carriers",
    sourceUrlContains: "rfc2549.txt",
  }),
  await runRow("F02", {
    // See the matching comment in test/vault-capture-e2e.test.ts: a base
    // repo URL crawl with a small --max-pages does not reliably include
    // README.md (GitHub's tree listing is not alphabetical); capturing the
    // README's own blob URL directly is deterministic.
    captureArgs: [
      "https://github.com/arabold/docs-mcp-server/blob/main/README.md",
      "--max-depth",
      "1",
      "--max-pages",
      "2",
    ],
    collection: "livecheck-f02-github-readme",
    facts: ["Grounded Docs: Your AI's Up-to-Date Documentation Expert"],
    query: "Grounded Docs",
    sourceUrlContains: "README.md",
  }),
  await runRow("F03", {
    captureArgs: [
      "https://github.com/arabold/docs-mcp-server/blob/main/package.json",
      "--max-depth",
      "1",
      "--max-pages",
      "2",
    ],
    collection: "livecheck-f03-github-blob",
    facts: ["docs-mcp-server"],
    query: "docs-mcp-server",
    sourceUrlContains: "package.json",
  }),
  await runRow("F05", {
    captureArgs: ["https://quotes.toscrape.com/js/"],
    collection: "livecheck-f05-js-rendered",
    facts: ["Albert Einstein"],
    query: "Albert Einstein",
    sourceUrlContains: "quotes.toscrape.com",
  }),
];

const summary = {
  ts: new Date().toISOString(),
  vaultPath,
  stateDir,
  rows,
  // A blocked row is never a pass; only rows that ran the full contract and
  // matched every assertion count toward allPassed.
  allPassed: rows.every((r) => r.status === "pass"),
  anyBlocked: rows.some((r) => r.status === "blocked"),
};

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.allPassed ? 0 : 1);
}
