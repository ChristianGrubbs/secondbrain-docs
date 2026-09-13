#!/usr/bin/env node
/**
 * Runs the network-dependent "live" rows (F01 single docs page, F02 GitHub
 * README, F03 GitHub blob, F05 JS-rendered page) against the built
 * `dist/vault-cli.js`, an explicitly designated throwaway vault, and a
 * throwaway state directory + `DOCS_MCP_CONFIG`. Prints one JSON summary
 * line to stdout so Task 7 can consume it as a scripted live-surface check.
 *
 * MAJOR 3 (2026-09-13 Codex frontier review): each row runs the same
 * end-to-end publication-contract check `test/vault-capture-e2e.test.ts`
 * uses (facts in saved bytes, exactly one MOC link, `search` resolves the
 * note's identity, `read` returns the complete saved bytes) — not just an
 * exit code plus one substring. A row whose network dependency is
 * unavailable is reported as `"blocked"`, never `"pass"`.
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
import { assertNotLiveVault } from "./lib/vault-guard.mjs";

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

/** Runs the built CLI directly and returns its parsed JSON envelope (or null). */
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
  return { result, envelope };
}

/** One frontmatter field extracted from saved note bytes, by exact YAML key. */
function frontmatterField(markdown, key) {
  const frontmatterBlock = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterBlock) return undefined;
  const line = frontmatterBlock[1].split("\n").find((l) => l.startsWith(`${key}:`));
  if (!line) return undefined;
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^"(.*)"$/, "$1");
}

/** Counts occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * Runs one live row through the full qualification contract used by
 * test/vault-capture-e2e.test.ts's `assertQualifiedNote`: facts in the
 * saved bytes, correct version scope, exactly one MOC link, `search`
 * resolving the note's identity (path + digest), and `read` returning the
 * complete saved bytes.
 *
 * A network-dependent failure to reach the source at all (spawn error,
 * timeout, or a run that never produced any outcome) is reported as
 * `"blocked"`, never `"pass"` -- distinct from a genuine assertion failure
 * (`"fail"`), which means the endpoint answered but the contract broke.
 */
function runRow(id, { captureArgs, collection, facts, query, sourceUrlContains }) {
  const { result: captureResult, envelope } = runCli([
    "capture",
    ...captureArgs,
    "--collection",
    collection,
    "--state-dir",
    stateDir,
    "--json",
  ]);

  const outcome = envelope?.outcomes?.[0];
  const notePath = outcome?.publication?.path;
  if (captureResult.status !== 0 || !outcome || outcome.publication?.status !== "published") {
    return {
      id,
      status: "blocked",
      reason: `capture did not publish (exit ${captureResult.status}, ${
        envelope?.run_error ?? captureResult.stderr?.slice(0, 300) ?? "no envelope"
      })`,
    };
  }

  const savedBytes = fs.readFileSync(path.join(vaultPath, notePath), "utf8");
  const missingFacts = facts.filter((fact) => !savedBytes.includes(fact));
  if (missingFacts.length > 0) {
    return { id, status: "fail", reason: `missing facts: ${missingFacts.join(", ")}`, notePath };
  }

  if (sourceUrlContains !== undefined) {
    const sourceUrl =
      frontmatterField(savedBytes, "source_url") ??
      frontmatterField(savedBytes, "requested_url");
    if (!sourceUrl?.includes(sourceUrlContains)) {
      return { id, status: "fail", reason: `source_url missing ${sourceUrlContains}`, notePath };
    }
  }

  const mocPath = path.join(vaultPath, path.dirname(notePath), "index.md");
  let mocLinkCount = -1;
  try {
    const moc = fs.readFileSync(mocPath, "utf8");
    mocLinkCount = countOccurrences(moc, notePath.replace(/\.md$/, ""));
  } catch {
    mocLinkCount = -1;
  }
  if (mocLinkCount !== 1) {
    return { id, status: "fail", reason: `MOC link count ${mocLinkCount}, expected 1`, notePath };
  }

  const { result: searchResult, envelope: searchEnvelope } = runCli([
    "search",
    query,
    "--collection",
    collection,
    "--state-dir",
    stateDir,
    "--json",
  ]);
  const match = (searchEnvelope?.results ?? []).find((r) => r.vault_path === notePath);
  if (searchResult.status !== 0 || !match || match.digest !== outcome.publication.digest) {
    return {
      id,
      status: "fail",
      reason: `search "${query}" did not resolve ${notePath} by identity`,
      notePath,
    };
  }

  const { result: readResult } = runCli(["read", notePath]);
  if (readResult.status !== 0 || readResult.stdout !== `${savedBytes}\n`) {
    return { id, status: "fail", reason: "read did not return complete saved bytes", notePath };
  }

  return { id, status: "pass", notePath, digest: outcome.publication.digest };
}

const rows = [
  runRow("F01", {
    captureArgs: ["https://www.rfc-editor.org/rfc/rfc2549.txt"],
    collection: "livecheck-f01-single-page",
    facts: ["Avian Carriers"],
    query: "Avian Carriers",
    sourceUrlContains: "rfc2549.txt",
  }),
  runRow("F02", {
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
  runRow("F03", {
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
  runRow("F05", {
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
