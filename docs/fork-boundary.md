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
| `docs/fork-boundary.md` | This file |

Upstream files changed, and nothing else:

- `package.json` — added the `sb-docs` bin mapping alongside `docs-mcp-server`.
- `vite.config.ts` — added the `vault-cli` library entry, and generalized the `preserve-shebang` plugin from the hardcoded `index.js` to every chunk in `executableChunks`.
- `src/scraper/types.ts` — additive optional fields on `ScraperProgressEvent`: `outcome` (`"not-modified" | "not-found" | "fetch-failed"`) and a sanitized `errorMessage`. Existing consumers ignore both.
- `src/scraper/strategies/BaseScraperStrategy.ts` (and its test) — emits tagged terminal events for 304, 404 and per-page acquisition or conversion exceptions regardless of `shouldCount`, using the final `result.url`; a fatal root 404 is tagged exactly once. Page-count and failure-threshold semantics are unchanged.

## Rules this fork keeps

- **No listener from the CLI.** `sb-docs` must never start an MCP, HTTP or worker server. `src/vault-cli/main.ts` reaches none of the upstream server entry points, and `test/vault-cli-e2e.test.ts` asserts that a run records zero `net.Server.prototype.listen` calls.
- **No upstream default action.** `createVaultCli` never calls `createDefaultAction` or any upstream server command registration. It is a sibling of `createCli`, not a wrapper around it.
- **One lock primitive.** `src/vault/lock.ts` owns the SQLite `BEGIN EXCLUSIVE` mechanics; `PublicationJournal.withLock` and `VaultIndex.withIndexLock` both delegate to it and neither reimplements it. It is not reentrant, so helpers that run inside a critical section take it as given.
- **One frontmatter parser.** `parseNoteFrontmatter` in `src/vault/render.ts` is the only one. The migration plan suggested `gray-matter` for indexing; using the existing parser instead keeps the body bytes an index chunk is built from identical to the body bytes publication compares, and adds no dependency.
- **The index is derived, the vault is not.** Everything under `<stateDir>/index` can be deleted and rebuilt from the notes themselves. Reconciliation removes a vanished note from the index only — never from the vault — and no index path ever writes a note.
- **One index per collection.** Each collection owns its generations and its pointer under `<stateDir>/index/collections/<key>`, so rebuilding one collection cannot discard another and restoring a deleted index is one `reindex` per collection.
- **Store identity is injective.** Upstream lowercases every version it is given, while source identity is case sensitive, so the index keys its store by a lowercase token carrying a digest of the exact label. `Release` and `release` are two documents, and neither can ever be answered with the other's text.
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
