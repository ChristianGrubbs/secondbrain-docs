# Fork boundary

This repository is a user-owned fork of [`arabold/docs-mcp-server`](https://github.com/arabold/docs-mcp-server). It exists to add one thing — a CLI-only `sb-docs` command that captures source material into an Obsidian vault — while keeping the upstream source rebaseable.

## Binding

| Field | Value |
| --- | --- |
| Fork root | `/Volumes/3M/github-repos/secondbrain-docs` |
| `origin` | `git@github.com:ChristianGrubbs/secondbrain-docs.git` |
| `upstream` | `git@github.com:arabold/docs-mcp-server.git` |
| Upstream SHA at fork | `acb8247e2e95c3bff0bc5f67f7f3f926d56560c4` |
| Upstream package version | 3.1.0 |
| License | MIT preserved, Copyright (c) 2025 Andre Rabold |

## What the fork adds

| Path | Role |
| --- | --- |
| `src/vault-cli/index.ts` | `createVaultCli(argv, deps): Argv` — the restricted yargs program |
| `src/vault-cli/commands/capture.ts` | `sb-docs capture <input>` — URL, local path or bounded crawl into the vault; SIGINT-bridged `AbortController`; `--json` envelope |
| `src/vault-cli/commands/capture.test.ts` | Unit and integration contract for the capture command (real `node:http` fixture server, `file://` Markdown and PDF) |
| `src/vault-cli/commands/doctor.ts` | `sb-docs doctor` — capture state report and `--adopt` |
| `src/vault-cli/commands/doctor.test.ts` | Unit contract for the doctor command |
| `src/vault/VaultCaptureService.ts` | `capture()` — awaits the publisher inside the upstream progress callback; outcomes keyed by final URL + depth + terminal status; `counts`, `run_error`, exit 0/2/1/130 |
| `src/vault/VaultCaptureService.test.ts` | Unit contract for outcome keying, dedup, cancellation and exit codes |
| `src/vault/VaultPublisher.ts` | `VaultPublisher` — create / unchanged / replace (CAS) / conflict publication of one source note plus one MOC link, recovery of interrupted journal entries |
| `src/vault/VaultPublisher.test.ts` | Unit contract for the publisher |
| `src/vault/PublicationJournal.ts` | Journal, ownership records, per-source lock, JSONL logger |
| `src/vault/PublicationJournal.test.ts` | Unit contract for that durable state |
| `src/vault/discovery.ts` | `scanNotes` / `discoverSources` — the one recursive scan, and the `source_id` map that freezes note paths |
| `src/vault/discovery.test.ts` | Unit contract for discovery |
| `src/vault/ObsidianCli.ts` | Argument-array subprocess wrapper over `obsidian-cli`, note bytes on stdin; both missing-note and both missing-directory diagnostics read as absent |
| `src/vault/ObsidianCli.test.ts` | Unit contract for the process wrapper |
| `src/vault/lock.ts` | `withExclusiveLock` / `readLockHolder` — the one interprocess lock primitive, shared by the per-source publication lock and the state-level index lock |
| `src/vault/VaultIndex.ts` | `VaultIndex` — `upsert` / `rebuild` / `search` over the saved notes; generations, atomic pointer, derived manifest |
| `src/vault/VaultIndex.test.ts` | Unit and integration contract for the derived index, against a real SQLite store |
| `src/vault-cli/commands/search.ts` | `sb-docs search <query>` — FTS retrieval with digest verification and stale refresh |
| `src/vault-cli/commands/search.test.ts` | Unit contract for the search command |
| `src/vault-cli/commands/read.ts` | `sb-docs read <note-path>` — the complete note through `obsidian-cli`, never chunk reassembly |
| `src/vault-cli/commands/read.test.ts` | Unit contract for the read command |
| `src/vault-cli/commands/reindex.ts` | `sb-docs reindex` — rebuilds a collection's index from saved notes into a fresh generation |
| `src/vault-cli/commands/reindex.test.ts` | Unit contract for the reindex command |
| `src/vault/identity.ts` | `source_id`, collection paths, filename and link sanitisation |
| `src/vault/render.ts` | Source-note and collection-index rendering, semantic digest, frontmatter parsing |
| `src/vault/types.ts` | `SourceDocument`, `Publication`, `Publisher`, `CliRunner` |
| `src/vault-cli/main.ts` | Executable entry, built to `dist/vault-cli.js` |
| `src/vault-cli/index.test.ts` | Unit contract for the program shape |
| `test/vault-cli-e2e.test.ts` | Process-level checks against the built executable |
| `test/vault-publish-e2e.test.ts` | Real `obsidian-cli` publication into a throwaway vault via `OBSIDIAN_VAULT`; asserts the live vault is untouched |
| `test/fixtures/vault-cli/no-listen-guard.mjs` | `net.Server.prototype.listen` recorder used by that suite |
| `test/fixtures/vault/lock-holder.ts` | Child process that holds a real per-source lock (multiprocess lock tests) |
| `test/fixtures/vault/publish-crash.ts` | Child process that publishes and SIGKILLs itself at a chosen journal phase |
| `test/vault-index-e2e.test.ts` | Process-level capture / search / read / reindex against the built executable, including a held index lock |
| `test/fixtures/vault/index-lock-holder.ts` | Child process that holds the state-level index lock (process-level index tests) |
| `test/vault-capture-e2e.test.ts` | Task 6 (6A/6B) format/behavior qualification (F01-F20), real-CLI first-capture bootstrapping (C01-C04), process-boundary exit codes (X03), and subprocess/vault-access measurements (M01-M02), all against the built executable and a real `obsidian-cli` |
| `test/fixtures/vault-capture/` | Deterministic fixtures for the F-rows: `local-notes.md` + `pixel.png` (Markdown + local image), `table.pdf` (+ `generate-table-pdf.mjs` generator), `mixed-dir/` (three-file directory capture), `plain.txt`, `source-code.py` |
| `docs/migration-qualification.md` | The Task 6 row-by-row qualification report this suite backs |
| `scripts/live-check-vault.mjs` | Runs the live (network-dependent) rows against an explicitly designated throwaway vault, through the same publication-contract check `test/vault-capture-e2e.test.ts` uses (facts, one MOC link, `search` identity, full `read`), and prints a JSON summary; used by Task 7 |
| `scripts/lib/vault-guard.mjs` | `assertNotLiveVault`/`isInsideLiveVault` — canonicalizes both the live-vault path and the caller's destination (resolving the nearest existing ancestor for not-yet-created paths) so a symlink alias into the live vault cannot bypass the guard; handles an absent live vault explicitly instead of throwing |
| `scripts/lib/vault-guard.test.ts` | Unit contract for the guard: symlink-alias bypass, not-yet-created destination, absent live vault, a real child/symlink whose own name starts with `".."` (round-2 regression) |
| `scripts/lib/qualification-contract.mjs` | `qualifyNote` — the one shared end-to-end publication-qualification contract (facts, frontmatter identity, whole-note digest, one MOC link, `search` identity, full `read`), used by both `test/vault-capture-e2e.test.ts` and `scripts/live-check-vault.mjs` |
| `scripts/lib/qualification-contract.test.ts` | Unit contract for `qualifyNote`: a well-formed pass, and rejections for a missing fact, a wrong digest, missing `source_id`, a version mismatch, a wrong `source_url`, a bad MOC link count, an unresolved search, and an incomplete `read` |
| `docs/fork-boundary.md` | This file |

Upstream files changed, and nothing else:

- `package.json` — added the `sb-docs` bin mapping alongside `docs-mcp-server`.
- `vite.config.ts` — added the `vault-cli` library entry, and generalized the `preserve-shebang` plugin from the hardcoded `index.js` to every chunk in `executableChunks`.
- `src/scraper/types.ts` — additive optional fields on `ScraperProgressEvent`: `outcome` (`"not-modified" | "not-found" | "fetch-failed"`) and a sanitized `errorMessage`. Existing consumers ignore both.
- `src/scraper/strategies/BaseScraperStrategy.ts` (and its test) — emits tagged terminal events for 304, 404 and per-page acquisition or conversion exceptions regardless of `shouldCount`, using the final `result.url`; a fatal root 404 is tagged exactly once. Page-count and failure-threshold semantics are unchanged.
- `src/scraper/strategies/GitHubScraperStrategy.ts` (and its test) — Task 6 qualification fix (row F03): a single GitHub blob URL given directly as the capture root is now fetched and processed in place at depth 0 instead of re-announcing itself as a "discovered" link, which `BaseScraperStrategy`'s pre-seeded `visited` set permanently deduped, silently producing zero outcomes at any `--max-depth`/`--max-pages`.
- `src/scraper/fetcher/BrowserFetcher.ts` (and its test) — Task 6 qualification fix (row X03): `chromium.launch()` passes `handleSIGINT: false` so Playwright's own SIGINT handler no longer races and wins against `sb-docs capture`'s own SIGINT handler, which previously left a real Ctrl-C during a browser-rendered capture exiting 130 with no JSON envelope ever printed. `handleSIGTERM`/`handleSIGHUP` stay at Playwright's default (round-2 correction, MAJOR 1/B: the original fix over-broadly disabled those too, removing cleanup paths the CLI does not replace). A test-only env hook, `SB_DOCS_TEST_DISABLE_SIGNAL_CLEANUP=1`, reproduces the round-1 bug on demand for negative-control testing; never set outside `test/vault-capture-e2e.test.ts`/`BrowserFetcher.test.ts`.
- `src/vault-cli/commands/capture.ts` — round-3 addition (MAJOR 3): a second test-only hook, `SB_DOCS_TEST_KEEP_ALIVE_ON_SIGNAL=1`, registers no-op SIGTERM/SIGHUP listeners so the host process survives those signals instead of dying on Node's default disposition. Paired with `SB_DOCS_TEST_DISABLE_SIGNAL_CLEANUP`, this isolates "Playwright's own cleanup is disabled" from "the host process died" for the signal-cleanup negative control in `test/vault-capture-e2e.test.ts`. Inert unless explicitly set; never set outside that test file.
- `src/vault/VaultIndex.ts` — `storeVersion` is now exported (previously private) so `VaultIndex.test.ts` can compute the exact stored-version key for database-identity assertions (round 3, MAJOR 1).
- `src/vault-cli/commands/capture.ts` / `capture.test.ts` and `src/vault-cli/commands/search.ts` / `search.test.ts` — Task 6 qualification fix: each subcommand now calls `.version(false)` so yargs' reserved top-level `--version` flag no longer silently swallows the subcommand's own `--version <label>` string option.
- `src/vault/ObsidianCli.ts` (and its test) — Task 6 qualification instrumentation (MINOR 7): `createObsidianCliRunner` now accepts an optional `logger` and emits one `vault.cli_invoked` JSONL event (gated by `SB_DOCS_LOG`, same as every other vault event) per spawned `obsidian-cli` subprocess, classified `list`/`read`/`write`/`other` via the new exported `classifyObsidianCliSubcommand`.
- `vite.config.ts` — test `include` now also covers `scripts/**/*.test.ts`, so `scripts/lib/vault-guard.test.ts` runs in the default `npm test`.

## Rules this fork keeps

- **No listener from the CLI.** `sb-docs` must never start an MCP, HTTP or worker server. `src/vault-cli/main.ts` reaches none of the upstream server entry points, and `test/vault-cli-e2e.test.ts` asserts that a run records zero `net.Server.prototype.listen` calls.
- **No upstream default action.** `createVaultCli` never calls `createDefaultAction` or any upstream server command registration. It is a sibling of `createCli`, not a wrapper around it.
- **One lock primitive.** `src/vault/lock.ts` owns the SQLite `BEGIN EXCLUSIVE` mechanics; `PublicationJournal.withLock` and `VaultIndex.withIndexLock` both delegate to it and neither reimplements it. It is not reentrant, so helpers that run inside a critical section take it as given.
- **One frontmatter parser.** `parseNoteFrontmatter` in `src/vault/render.ts` is the only one. The migration plan suggested `gray-matter` for indexing; using the existing parser instead keeps the body bytes an index chunk is built from identical to the body bytes publication compares, and adds no dependency.
- **The index is derived, the vault is not.** Everything under `<stateDir>/index` can be deleted and rebuilt from the notes themselves. Reconciliation removes a vanished note from the index only — never from the vault — and no index path ever writes a note.
- **One index per collection.** Each collection owns its generations and its pointer under `<stateDir>/index/collections/<key>`, so rebuilding one collection cannot discard another and restoring a deleted index is one `reindex` per collection.
- **Store identity is injective.** Upstream normalizes versions in two places with two rules — lowercase on write and search, lowercase *and trim* through `normalizeVersionRef` — while source identity is case- and whitespace-sensitive. The index therefore keys its store by `sv` plus a digest of the exact label: hexadecimal, so neither rule can alter it, and injective, so `Release`, `release` and `" Release"` are three documents and none can be answered with another's text. The readable label lives in the manifest, which is what every envelope reports.
- **An index that cannot answer is never mistaken for one with nothing to say.** A generation is a pointer, a directory, a manifest, a database file, rows inside it, and an encoding those rows are keyed by. One classification checks all six before any caller trusts it; anything short of usable rebuilds from discovery and says which part was missing. Only a writing caller may initialize a collection nothing has ever indexed, and only that case — a generation that exists and is broken is repaired by rebuilding, never by writing one note into it.
- **The store encoding is fingerprinted, not declared.** `STORE_ENCODING_ID` is a digest of `storeVersion`'s own output over a fixed set of probe labels, recorded in every manifest. Changing the mapping changes the fingerprint in the same commit, so generations written by the old mapping are detected and rebuilt instead of being queried with keys they never held. The manifest version describes the document's shape; this describes what the database beside it is keyed by, and they are checked separately.
- **Verification samples the splitter's output, not the note.** A Markdown body is converted before it is chunked, so a token in an HTML comment or an unused reference definition exists in the note and in no chunk. Probes are chosen from what was actually persisted, so a probe can only fail when persistence failed.
- **Upstream semantics stay untouched.** Existing upstream commands, their meanings, the web UI and the MCP source all remain as shipped, so rebases stay cheap.
- **Both build defines are preserved.** `__APP_VERSION__` and `__POSTHOG_API_KEY__` are still injected, and the native externals list is unchanged.

## Exact commands

Run everything from the fork root (or a linked worktree of it):

```bash
cd /Volumes/3M/github-repos/secondbrain-docs
```

### Install

```bash
npm ci
```

`npm ci` installs from the lockfile without mutating it. Use `npm install` only for an intentional dependency change.

### Environment

| Variable | Role |
| --- | --- |
| `OBSIDIAN_VAULT` | Vault every `obsidian-cli` call operates on. |
| `SB_DOCS_LOG` | `1`/`true`/`yes` enables the JSONL event log; off by default. |
| `SB_DOCS_LOG_FILE` | Redirects that log away from `~/Library/Logs/SecondBrainDocs/events.jsonl`, which is what lets a test assert on a run's own events. |
| `DOCS_MCP_CONFIG` | Upstream's read-only configuration file. Setting it also stops a run rewriting the operator's own `config.yaml`. |

### Provision the browser

Upstream's `postinstall` deliberately skips browser provisioning, so it is a separate, required step — the JS-rendered source class does not work without it:

```bash
npx playwright install chromium
```

This installs the Chromium build locked to the repository's Playwright version, into `~/Library/Caches/ms-playwright`.

### Check

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run test:unit
```

`test:unit` is `vitest run src`, so it covers `src/vault-cli/index.test.ts` and needs no build.

### Build

```bash
npm run build
```

Produces two executables with shebangs and mode 755: `dist/index.js` (upstream) and `dist/vault-cli.js` (`sb-docs`).

### Verify the built CLI

```bash
npx vitest run test/vault-cli-e2e.test.ts
```

This suite spawns `dist/vault-cli.js` **directly**, not through `node`, so a missing shebang, a missing executable bit or an undefined build-time global fails here rather than at install time. It requires a prior `npm run build`; the default `npm test` does not build first, so run the build before it. `npm run test:e2e` builds automatically via its `pretest:e2e` hook.

```bash
./dist/vault-cli.js --help
```

### Verify retrieval end to end

```bash
npx vitest run test/vault-index-e2e.test.ts
```

This suite also requires a prior `npm run build`, plus `~/ai-stack/bin/obsidian-cli`; it skips itself when the CLI is absent. It captures into a throwaway vault named by `OBSIDIAN_VAULT` and asserts the live vault is untouched.

### Delete and rebuild the index

The index is disposable by construction. Deleting it and rebuilding reproduces
searchable current vault content without fetching a single source:

```bash
rm -rf "$HOME/Library/Application Support/SecondBrainDocs/index"
```

```bash
./dist/vault-cli.js reindex --collection inbox
```

Run that once per collection: the index is per collection, so rebuilding one
leaves every other collection's index exactly as it was.

```bash
./dist/vault-cli.js reindex --collection <other-collection>
```

## Host requirements

- Node.js 22 or newer. `better-sqlite3` ships a Node-ABI-pinned native binary; do not raise the engine floor.
- Apple Silicon arm64 native dependencies: `better-sqlite3`, `sqlite-vec`, `tree-sitter`, `@xberg-io/xberg`.
- Chromium provisioned as above. No container runtime is required.
