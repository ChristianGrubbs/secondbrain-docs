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
| `src/vault-cli/commands/doctor.ts` | `sb-docs doctor` — capture state report and `--adopt` |
| `src/vault-cli/commands/doctor.test.ts` | Unit contract for the doctor command |
| `src/vault/PublicationJournal.ts` | Journal, ownership records, per-source lock, JSONL logger |
| `src/vault/PublicationJournal.test.ts` | Unit contract for that durable state |
| `src/vault/discovery.ts` | `discoverSources` — recursive `source_id` scan that freezes note paths |
| `src/vault/discovery.test.ts` | Unit contract for discovery |
| `src/vault-cli/main.ts` | Executable entry, built to `dist/vault-cli.js` |
| `src/vault-cli/index.test.ts` | Unit contract for the program shape |
| `test/vault-cli-e2e.test.ts` | Process-level checks against the built executable |
| `test/fixtures/vault-cli/no-listen-guard.mjs` | `net.Server.prototype.listen` recorder used by that suite |
| `test/fixtures/vault/lock-holder.ts` | Child process that holds a real per-source lock (multiprocess lock tests) |
| `test/fixtures/vault/publish-crash.ts` | Child process that publishes and SIGKILLs itself at a chosen journal phase |
| `docs/fork-boundary.md` | This file |

Upstream files changed, and nothing else:

- `package.json` — added the `sb-docs` bin mapping alongside `docs-mcp-server`.
- `vite.config.ts` — added the `vault-cli` library entry, and generalized the `preserve-shebang` plugin from the hardcoded `index.js` to every chunk in `executableChunks`.

## Rules this fork keeps

- **No listener from the CLI.** `sb-docs` must never start an MCP, HTTP or worker server. `src/vault-cli/main.ts` reaches none of the upstream server entry points, and `test/vault-cli-e2e.test.ts` asserts that a run records zero `net.Server.prototype.listen` calls.
- **No upstream default action.** `createVaultCli` never calls `createDefaultAction` or any upstream server command registration. It is a sibling of `createCli`, not a wrapper around it.
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

## Host requirements

- Node.js 22 or newer. `better-sqlite3` ships a Node-ABI-pinned native binary; do not raise the engine floor.
- Apple Silicon arm64 native dependencies: `better-sqlite3`, `sqlite-vec`, `tree-sitter`, `@xberg-io/xberg`.
- Chromium provisioned as above. No container runtime is required.
