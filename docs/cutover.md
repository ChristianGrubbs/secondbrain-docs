# Cutover: running `sb-docs` through the shared skill

Updated 2026-09-15. This is the Task 7 record: how both agents reach the qualified CLI, how a compatible release is switched or rolled back, and the live evidence for the currently installed release. Task plan: `docs/plans/2026-09-13-cli-vault-capture-tasks-6-7.md` (Task 7). Qualification evidence: `docs/migration-qualification.md`.

## How agents reach the CLI

Both agents load one shared skill, `sb-docs`, from the stack catalog (`~/ai-stack/skills/sb-docs`, assigned global through `skill-scope`). The skill invokes one executable wrapper:

```text
~/ai-stack/bin/sb-docs <command> [options]
```

The wrapper prepends `/opt/homebrew/opt/node@22/bin` to `PATH` and execs `node /Volumes/3M/github-repos/secondbrain-docs/dist/vault-cli.js "$@"`. It never depends on the interactive shell's `PATH` (the login shell defaults to Node 26; `nvm` is not installed). Two environment overrides exist for rehearsal and tests only:

| Variable | Role |
| --- | --- |
| `SB_DOCS_DIST` | Path to another built `vault-cli.js` (rollback rehearsal, tests). |
| `SB_DOCS_NODE_BIN` | Directory holding the `node` to use; defaults to the Node 22 Homebrew keg. |

A missing executable or missing Node 22 exits 1 with a message naming the fix. The wrapper has no silent fallback.

Runtime state (publication journals, ownership records, per-source locks, index generations) lives in `~/Library/Application Support/SecondBrainDocs` and is shared by every release. It is never copied, snapshotted or restored as part of a switch; `sb-docs reindex` rebuilds derived index generations from the saved notes when needed.

## Installed release

| Field | Value |
| --- | --- |
| Repository | `/Volumes/3M/github-repos/secondbrain-docs` (`ChristianGrubbs/secondbrain-docs`) |
| Qualified SHA (R2) | `fccabebb2a833119968704db309879c3fb2562d1` (PR #10, Task 6 packet 15) |
| Previous qualified SHA (R1) | `89e3a5652cc1295e6890b60d234ccb16331b1985` (PR #9) |
| Toolchain | Node 22 (`/opt/homebrew/opt/node@22/bin`), `better-sqlite3` rebuilt for the Node 22 ABI, Playwright Chromium from `npx playwright install chromium` |
| Executable | `dist/vault-cli.js`, produced by `npm run build` |

## Switching to a compatible release

One recipe, for forward switches and rollbacks alike. Run every step with Node 22 first on `PATH`.

```bash
cd /Volumes/3M/github-repos/secondbrain-docs
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
git switch --detach <qualified-sha>
npm ci
npm run build
~/ai-stack/bin/sb-docs doctor
```

Then record the SHA, `node --version`, and the `doctor` output in this file. Rollback is the same recipe with the previous qualified SHA. There are no per-release directories, installers or pointer files; the checkout is the release. A release whose `doctor` cannot read the shared state directory is not compatible: do not switch to it, keep the current release, and fix forward.

Rehearsing without touching the working checkout: build the other SHA in a linked worktree and point `SB_DOCS_DIST` at its `dist/vault-cli.js`.

## Live evidence

Recorded below after each live run through the wrapper. Every entry names the SHA, the Node version, the command, the exit code, and where the note landed.

### Pending

- Live capture of one operator-designated URL and one local path with spaces and Unicode.
- Rollback rehearsal R2 → R1 → R2 by `SB_DOCS_DIST`.

## Residual limitations carried from Task 6

- A conflict-candidate note does not copy local assets (row F06).
- Borderless PDF tables convert as running text (row F07, xberg limit).
- FTS/document divergence at an unchanged row count is not detected (row D01).
- Pruning retention is as recorded in `docs/migration-qualification.md`.
