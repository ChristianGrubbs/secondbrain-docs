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

## Local files: allowed roots

Upstream's file-access policy applies unchanged: a local path is captured only when it sits under an allowed root, and the default root is `~/Documents` (`scraper.security.fileAccess.allowedRoots: ["$DOCUMENTS"]`). A path elsewhere is refused as `fetch-failed` ("outside the configured allowed roots"), exit 1, nothing published. The per-call override is `DOCS_MCP_SCRAPER_SECURITY_FILE_ACCESS_ALLOWED_ROOTS='["/that/folder"]'`; the wrapper does not widen it.

## Live evidence

Every entry names the SHA, the Node version, the command, the exit code, and where the note landed. The collection id `AudienceView` was normalised to the folder `30 Tools-Models/Doc Sets/audienceview/`.

### 2026-09-15 — R2 `fccabebb2a833119968704db309879c3fb2562d1`, Node v22.23.2, arm64

Wrapper: the `bin/sb-docs` shipped in ai-stack [PR #652](https://github.com/ChristianGrubbs/ai-stack/pull/652) (squash `590c5ab4`), run from its pre-merge copy because `~/ai-stack` was held by another session's lease at the time. Operator-designated URLs. All commands through the wrapper with `--json`.

| Step | Command | Exit | Result |
| --- | --- | --- | --- |
| Capture URL 1 | `capture https://api.ovationtix.com/public/events_api.jsp --collection AudienceView` | 0 | `published`, `index: indexed`, `moc: linked`; note `AudienceView Professional API Documentation Events API 2df0add15a3a.md`; `content_sha256 707c708f33b8e04af5f64b50c5cbf524747b1fafd645743403d5abdd094f45d7` |
| Capture URL 2 (JS-rendered Salesforce community page) | `capture "https://help.audienceview.com/unlimited/s/knowledge-base?language=en_US" --collection AudienceView` | 0 | `published`, `index: indexed`, `moc: linked`; note `Help Articles & Documentation f4b13c9c4e66.md`; `content_sha256 2ba50f43c0d70a74a07891de3550152c1af53cac5194264ab7c446ea889feac5` |
| Capture local path with spaces and Unicode, first attempt | `capture ".../Tásk 7 Prüfung — live proof/Löcal nöte with spaces ✓.md"` from the session scratchpad | 1 | `skipped: fetch-failed`, `index: not-attempted`, `run_error` "outside the configured allowed roots" — the default root is `~/Documents` |
| Same, with `DOCS_MCP_SCRAPER_SECURITY_FILE_ACCESS_ALLOWED_ROOTS` naming that folder | same command | 0 | `published`, `index: indexed`, `moc: linked`; `sourceUrl` is the percent-encoded `file://` form of the exact path; note `Task 7 live proof — local file with spaces and Unicode 9cb24be00195.md`; `content_sha256 9065528c04ec50f00a0acc751e9509e08d5743f890820933c4bfed5581469475`, publication digest `471529d9ef00ca872ab9624a5376ff8bfe7681e19f12118820a04aa4d843b2a4` |
| Search body phrase | `search "sternenklare Prüfung siebzehn" --collection AudienceView` | 0 | `status: ok`, 1 result (the local note), `omitted: []`, `refreshed: 0` |
| Search across the URL notes | `search "Events API show information client" --collection AudienceView` | 0 | `status: ok`, 6 excerpts across both URL notes, `omitted: []` |
| Read | `read "30 Tools-Models/Doc Sets/audienceview/Task 7 live proof — local file with spaces and Unicode 9cb24be00195.md"` | 0 | complete note with frontmatter (`source_id 9cb24be0…`, `collection: audienceview`, `publisher_version: 3.1.0`) |
| Doctor (R2) | `doctor` | 0 | `stateDir ~/Library/Application Support/SecondBrainDocs`, `pending: []`, `ownershipCount: 3`, three per-source locks plus the index lock, none busy |

### Rollback rehearsal R2 → R1 → R2 (same day)

R1 `89e3a5652cc1295e6890b60d234ccb16331b1985` was built in a linked worktree (`git worktree add --detach`, `npm ci`, `npm run build`, Node v22.23.2) and selected with `SB_DOCS_DIST=<worktree>/dist/vault-cli.js`; the shared state directory and the R2-captured notes were left in place.

| Step | Release | Exit | Result |
| --- | --- | --- | --- |
| `doctor` | R1 | 0 | same `stateDir`, `ownershipCount: 3`, the same three source locks and the index lock, none busy — R1 reads R2's durable state without migration |
| `search "sternenklare Prüfung siebzehn"` | R1 | 0 | `status: ok`, 1 result, `omitted: []` — R1 serves R2's index generation without a rebuild |
| `read` of the local note | R1 | 0 | complete note |
| `search` (same query) | R2 | 0 | identical result |
| `doctor` | R2 | 0 | identical report |

Verdict: R1 and R2 are compatible over the shared durable state in both directions; rollback to R1 is available. Not exercised: capturing under R1, which was kept read-only so the live collection holds notes from one publisher version only.

## Residual limitations carried from Task 6

- A conflict-candidate note does not copy local assets (row F06).
- Borderless PDF tables convert as running text (row F07, xberg limit).
- FTS/document divergence at an unchanged row count is not detected (row D01).
- Pruning retention is as recorded in `docs/migration-qualification.md`.
