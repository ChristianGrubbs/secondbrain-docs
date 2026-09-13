#!/usr/bin/env node
/**
 * Runs the network-dependent "live" rows (F01 single docs page, F02 GitHub
 * README, F03 GitHub blob, F05 JS-rendered page) against the built
 * `dist/vault-cli.js`, an explicitly designated throwaway vault, and a
 * throwaway state directory + `DOCS_MCP_CONFIG`. Prints one JSON summary
 * line to stdout so Task 7 can consume it as a scripted live-surface check.
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
import { fileURLToPath } from "node:url";

const LIVE_VAULT = "/Volumes/3M/Obsidian";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vaultCliEntry = path.join(projectRoot, "dist", "vault-cli.js");

/** Parses `--flag value` pairs from argv; unknown flags are ignored. */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--vault") args.vault = argv[++i];
    if (argv[i] === "--state-dir") args.stateDir = argv[++i];
  }
  return args;
}

function fail(message) {
  console.error(`live-check-vault: ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
if (!args.vault) {
  fail("--vault <absolute-throwaway-vault-path> is required");
}
const vaultPath = path.resolve(args.vault);
if (vaultPath === LIVE_VAULT || vaultPath === fs.realpathSync(LIVE_VAULT).replace(/\/$/, "")) {
  fail(`refusing to run against the operator's live vault: ${LIVE_VAULT}`);
}
if (!fs.existsSync(vaultCliEntry)) {
  fail(`${vaultCliEntry} does not exist — run \`npm run build\` first`);
}

const cliPath = path.join(os.homedir(), "ai-stack", "bin", "obsidian-cli");
if (!fs.existsSync(cliPath)) {
  fail(`obsidian-cli not found at ${cliPath}`);
}

fs.mkdirSync(path.join(vaultPath, "00 Inbox"), { recursive: true });

const stateDir = args.stateDir
  ? path.resolve(args.stateDir)
  : fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-livecheck-state-"));
fs.mkdirSync(stateDir, { recursive: true });

const configFile = path.join(stateDir, "config.yaml");
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

/** Runs one live row's capture and returns a result summary. */
function runRow(id, { url, collection, maxDepth, maxPages, expectContains, expectContainsLower }) {
  const args = [
    "capture",
    url,
    "--collection",
    collection,
    "--state-dir",
    stateDir,
    "--json",
  ];
  if (maxDepth !== undefined) args.push("--max-depth", String(maxDepth));
  if (maxPages !== undefined) args.push("--max-pages", String(maxPages));

  const result = spawnSync(vaultCliEntry, args, {
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

  const markdown = envelope?.outcomes?.[0]?.publication?.markdown ?? "";
  const haystack = expectContainsLower ? markdown.toLowerCase() : markdown;
  const needle = expectContainsLower ?? expectContains;
  const factualStringFound = typeof needle === "string" ? haystack.includes(needle) : false;

  return {
    id,
    url,
    collection,
    exitCode: result.status,
    factualStringFound,
    outcomeCount: envelope?.outcomes?.length ?? 0,
    runError: envelope?.run_error ?? null,
    stderrExcerpt: (result.stderr ?? "").slice(0, 500),
  };
}

const rows = [
  runRow("F01", {
    url: "https://www.rfc-editor.org/rfc/rfc2549.txt",
    collection: "livecheck-f01-single-page",
    expectContains: "Avian Carriers",
  }),
  runRow("F02", {
    url: "https://github.com/arabold/docs-mcp-server",
    collection: "livecheck-f02-github-readme",
    maxDepth: 1,
    maxPages: 5,
    expectContainsLower: "docs-mcp-server",
  }),
  runRow("F03", {
    url: "https://github.com/arabold/docs-mcp-server/blob/main/package.json",
    collection: "livecheck-f03-github-blob",
    maxDepth: 1,
    maxPages: 2,
    expectContains: "docs-mcp-server",
  }),
  runRow("F05", {
    url: "https://quotes.toscrape.com/js/",
    collection: "livecheck-f05-js-rendered",
    expectContainsLower: "albert einstein",
  }),
];

const summary = {
  ts: new Date().toISOString(),
  vaultPath,
  stateDir,
  rows,
  allPassed: rows.every((r) => r.exitCode === 0 && r.factualStringFound),
};

console.log(JSON.stringify(summary, null, 2));
process.exit(summary.allPassed ? 0 : 1);
