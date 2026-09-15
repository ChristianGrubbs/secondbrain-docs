# Cutover: running `sb-docs` through the shared skill

Updated 2026-09-15. This is the Task 7 record: how both agents reach the qualified CLI, how a compatible release is switched or rolled back, and the live evidence for the currently installed release. Task plan: `docs/plans/2026-09-13-cli-vault-capture-tasks-6-7.md` (Task 7). Qualification evidence: `docs/migration-qualification.md`.

## How agents reach the CLI

Both agents are meant to load one shared skill, `sb-docs`, from the stack catalog (`~/ai-stack/skills/sb-docs`), assigned global through `skill-scope`. The skill, its wrapper and the attic move of the old `sb-capture` tripwire are merged in ai-stack ([PR #652](https://github.com/ChristianGrubbs/ai-stack/pull/652) `590c5ab4`, [PR #653](https://github.com/ChristianGrubbs/ai-stack/pull/653) `978212b2`, [PR #654](https://github.com/ChristianGrubbs/ai-stack/pull/654) `0100534e`, [PR #655](https://github.com/ChristianGrubbs/ai-stack/pull/655) `182c8ffb` — the last two carry the Codex review fixes); the `skill-scope` assignment and the fresh-session proof for both agents are still pending (see "Live evidence"). The skill invokes one executable wrapper:

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
| **Active release (R3)** | `7aa85bddcd6e2b9ed41ce1e1c92408afdca12b41` (squash of [PR #11](https://github.com/ChristianGrubbs/secondbrain-docs/pull/11)), activated 2026-09-15 with the two-stage recipe below: stage 1 on the branch head `ae623b8` (content-identical to the squash; full suite 153 files / 2505 tests green with the worktree's own `npm ci`; `doctor` and `search` through `SB_DOCS_DIST` ok), stage 2 on the live checkout (`rm -rf dist`, `npm ci`, `npm run build`; `dist/vault-cli.js` sha256 `05d310b16a14779328dc35392e3aa7e1e0e0841d057e097633e56ce95b9704d2` on both the live checkout and the validated worktree; `doctor --json` clean; `capture --no-index` parses). Node v22.23.2, ABI 127 |
| Previous qualified SHA (R2) | `fccabebb2a833119968704db309879c3fb2562d1` (PR #10, Task 6 packet 15) — the release all live capture evidence below was produced on; R3 differs from it only by the parser fix |
| Older qualified SHA (R1) | `89e3a5652cc1295e6890b60d234ccb16331b1985` (PR #9); built in `/Volumes/3M/ai-stack-wt/secondbrain-docs/r1-rehearsal` as the rehearsed rollback target |
| What R3 changed | R2 plus one CLI fix — `capture --no-index` was rejected by yargs' boolean negation ("Unknown argument: index"); `createVaultCli` now sets `parserConfiguration({ "boolean-negation": false })` and `capture.test.ts` invokes the literal flag (publication, `index: not-attempted`, exit 0, no index root created). Deliberate contract consequence: the never-documented `--no-<flag>` negation forms (in practice only `--no-json`, whose flag already defaults to false) are rejected as unknown arguments on every vault command; `index.test.ts` pins that |
| Toolchain | Node v22.23.2 (`/opt/homebrew/opt/node@22/bin`), native ABI `process.versions.modules` = 127, arm64; `better-sqlite3` built for that ABI (loaded successfully by every `search`/`reindex` in the evidence below); Playwright Chromium from `npx playwright install chromium` |
| Executable | `dist/vault-cli.js`, produced by `npm run build` |

## Switching to a compatible release

One recipe, for forward switches and rollbacks alike, in two stages so the live checkout is never replaced by an unvalidated build. Run every step with Node 22 first on `PATH`.

**Stage 1 — validate the candidate without touching the live checkout.** Build it in a linked worktree and exercise it through the wrapper's override against the real shared state:

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
git -C /Volumes/3M/github-repos/secondbrain-docs worktree add --detach /Volumes/3M/ai-stack-wt/secondbrain-docs/<candidate-sha> <candidate-sha>
npm ci --prefix /Volumes/3M/ai-stack-wt/secondbrain-docs/<candidate-sha>
npm run build --prefix /Volumes/3M/ai-stack-wt/secondbrain-docs/<candidate-sha>
SB_DOCS_DIST=/Volumes/3M/ai-stack-wt/secondbrain-docs/<candidate-sha>/dist/vault-cli.js ~/ai-stack/bin/sb-docs doctor --json
SB_DOCS_DIST=/Volumes/3M/ai-stack-wt/secondbrain-docs/<candidate-sha>/dist/vault-cli.js ~/ai-stack/bin/sb-docs search "<a phrase from an existing note>" --collection <collection> --json
```

A candidate whose `doctor` cannot read the shared state directory, or whose `search` cannot serve the existing notes, is not compatible: stop here, keep the current release, and fix forward. Nothing has changed yet.

**Stage 2 — activate the validated SHA in the live checkout.** Record the current SHA first (`git -C /Volumes/3M/github-repos/secondbrain-docs rev-parse HEAD`) so activation can be undone. `dist/` is gitignored, so switching SHAs does not touch the old build: remove it explicitly before building, so that a failed `npm ci` or build leaves no executable behind and the wrapper refuses to run (its missing-executable path is tested in ai-stack) instead of serving the previous release under the new SHA.

```bash
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
git -C /Volumes/3M/github-repos/secondbrain-docs switch --detach <validated-sha>
rm -rf /Volumes/3M/github-repos/secondbrain-docs/dist
npm ci --prefix /Volumes/3M/github-repos/secondbrain-docs
npm run build --prefix /Volumes/3M/github-repos/secondbrain-docs
shasum -a 256 /Volumes/3M/github-repos/secondbrain-docs/dist/vault-cli.js /Volumes/3M/ai-stack-wt/secondbrain-docs/<validated-sha>/dist/vault-cli.js
~/ai-stack/bin/sb-docs doctor --json
```

The two `shasum` lines must match: the live executable is then byte-identical to the one stage 1 validated, which is the identity check that the running artifact belongs to the selected SHA. If stage 2 fails part-way, re-run stage 2 with the recorded prior SHA. Then record the SHA, the executable's sha256, `node --version`, `process.versions.modules`, and the `doctor` output in this file. Rollback is the same two stages with the previous qualified SHA. There are no per-release directories, installers or pointer files; the checkout is the release.

## Local files: allowed roots

Upstream's file-access policy applies unchanged: a local path is captured only when it sits under an allowed root, and the default root is `~/Documents` (`scraper.security.fileAccess.allowedRoots: ["$DOCUMENTS"]`). A path elsewhere is refused as `fetch-failed` ("outside the configured allowed roots"), exit 1, nothing published. The per-call override is `DOCS_MCP_SCRAPER_SECURITY_FILE_ACCESS_ALLOWED_ROOTS='["/that/folder"]'`; the wrapper does not widen it.

## Live evidence

Every entry names the SHA, the Node version, the command, the exit code, and where the note landed. The collection id `AudienceView` was normalised to the folder `30 Tools-Models/Doc Sets/audienceview/`.

### 2026-09-15 — R2 `fccabebb2a833119968704db309879c3fb2562d1`, Node v22.23.2, arm64

Wrapper: the `bin/sb-docs` shipped in ai-stack [PR #652](https://github.com/ChristianGrubbs/ai-stack/pull/652) (squash `590c5ab4`), run from its byte-identical pre-merge copy because `~/ai-stack` was held by another session's lease at the time. Operator-designated URLs. Every command ran through the wrapper; `capture`, `search`, `reindex` and `doctor` with `--json`, `read` as raw Markdown (it has no `--json`). Raw stdout, stderr and exit code of every run below are committed under [`docs/evidence/2026-09-15-task7/`](evidence/2026-09-15-task7/) as `<step>.out`, `<step>.err`, `<step>.exit` (its `README.txt` maps the capture files to their inputs). For the three successful captures the `.out`/`.err` files are the original run's stdout and stderr and the `.exit` files hold the exit code observed in the session transcript (0); the refused capture (`capture-local-outside-roots.*`) was re-run to record its full triplet; `node-abi.txt` holds the Node/ABI line.

| Step | Command | Exit | Result |
| --- | --- | --- | --- |
| Capture URL 1 | `capture https://api.ovationtix.com/public/events_api.jsp --collection AudienceView` | 0 | `published`, `index: indexed`, `moc: linked`; note `AudienceView Professional API Documentation Events API 2df0add15a3a.md`; `content_sha256 707c708f33b8e04af5f64b50c5cbf524747b1fafd645743403d5abdd094f45d7` |
| Capture URL 2 (JS-rendered Salesforce community page) | `capture "https://help.audienceview.com/unlimited/s/knowledge-base?language=en_US" --collection AudienceView` | 0 | `published`, `index: indexed`, `moc: linked`; note `Help Articles & Documentation f4b13c9c4e66.md`; `content_sha256 2ba50f43c0d70a74a07891de3550152c1af53cac5194264ab7c446ea889feac5` |
| Capture local path with spaces and Unicode, first attempt | `capture ".../Tásk 7 Prüfung — live proof/Löcal nöte with spaces ✓.md"` from the session scratchpad | 1 | `skipped: fetch-failed`, `index: not-attempted`, `run_error` "outside the configured allowed roots" — the default root is `~/Documents` |
| Same, with `DOCS_MCP_SCRAPER_SECURITY_FILE_ACCESS_ALLOWED_ROOTS` naming that folder | same command | 0 | `published`, `index: indexed`, `moc: linked`; `sourceUrl` is the percent-encoded `file://` form of the exact path; note `Task 7 live proof — local file with spaces and Unicode 9cb24be00195.md`; `content_sha256 9065528c04ec50f00a0acc751e9509e08d5743f890820933c4bfed5581469475`, publication digest `471529d9ef00ca872ab9624a5376ff8bfe7681e19f12118820a04aa4d843b2a4` |
| Search body phrase | `search "sternenklare Prüfung siebzehn" --collection AudienceView` | 0 | `status: ok`, 1 result (the local note), `omitted: []`, `refreshed: 0` |
| Search across the URL notes | `search "Events API show information client" --collection AudienceView` | 0 | `status: ok`, 6 excerpts across both URL notes, `omitted: []` |
| Read | `read "30 Tools-Models/Doc Sets/audienceview/Task 7 live proof — local file with spaces and Unicode 9cb24be00195.md"` | 0 | complete note with frontmatter (`source_id 9cb24be0…`, `collection: audienceview`, `publisher_version: 3.1.0`), raw Markdown on stdout (`r2-read-local.out`) |
| Reindex | `reindex --collection AudienceView --json` | 0 | `status: rebuilt`, generation `gen-2026-09-15T10-29-22-434Z-0`, 3 notes discovered / 3 indexed / 1 skipped (the collection MOC), 14 chunks, 1 directory scan, 4 note reads, 180 ms, embeddings disabled (`r2-reindex.out`) |
| Search after reindex | `search "sternenklare Prüfung siebzehn" --collection AudienceView --json` | 0 | `status: ok`, 1 result, `omitted: []` — the rebuilt generation serves the same hit (`r2-search-after-reindex.out`) |
| Doctor (R2) | `doctor --json` | 0 | `stateDir ~/Library/Application Support/SecondBrainDocs`, `pending: []`, `ownershipCount: 3`, three per-source locks plus the index lock, none busy (`r2-doctor.out`) |
| Node / native ABI | `node -p process.version + process.versions.modules` through the wrapper's Node | 0 | `node v22.23.2 abi 127 arch arm64` (`node-abi.txt`); every `search`/`reindex` above loaded `better-sqlite3` against that ABI |

### Rollback rehearsal R2 → R1 → R2 (same day)

R1 `89e3a5652cc1295e6890b60d234ccb16331b1985` was built in a linked worktree (`git worktree add --detach`, `npm ci`, `npm run build`, Node v22.23.2) and selected with `SB_DOCS_DIST=<worktree>/dist/vault-cli.js`; the shared state directory and the R2-captured notes were left in place.

| Step | Release | Exit | Result |
| --- | --- | --- | --- |
| `doctor --json` | R1 | 0 | same `stateDir`, `ownershipCount: 3`, the same three source locks and the index lock, none busy — R1 reads R2's durable state without migration (`r1-doctor.out`) |
| `search "sternenklare Prüfung siebzehn" --json` | R1 | 0 | `status: ok`, 1 result, `omitted: []` — R1 serves the generation R2's `reindex` built, without a rebuild (`r1-search-local.out`) |
| `read` of the local note | R1 | 0 | complete note (`r1-read-local.out`) |
| `search` (same query) | R2 | 0 | identical result after R1 ran (`r2-search-after-r1.out`) |
| `doctor --json` | R2 | 0 | identical report (`r2-doctor-after-r1.out`) |

Verdict, deliberately narrow: R1 can read R2-created durable state and R2-built index generations (`doctor`, `search`, `read`), and R2 still serves the same state after R1 has run over it. That is **read-only R2 → R1 → R2 compatibility**. Not proven: any R1 write (capture, reindex, adopt) against R2 state, or R2 consuming R1-written state — R1 was kept read-only so the live collection holds notes from one publisher version only. A rollback that must also capture under R1 needs that write-side rehearsal first.

### Pending acceptance items

- `skill-scope assign sb-docs --global` (and `remove sb-capture`) on this Mac, blocked on the `~/ai-stack` write lease held by another session at the time of writing.
- Fresh Claude Code and Codex sessions resolving the installed global skill and running all five commands through `~/ai-stack/bin/sb-docs` with a non-interactive `PATH`; until recorded here, the two-agent criterion of Task 7 is unproven and the evidence above stands for the wrapper and CLI only.

## Residual limitations carried from Task 6

- A conflict-candidate note does not copy local assets (row F06).
- Borderless PDF tables convert as running text (row F07, xberg limit).
- FTS/document divergence at an unchanged row count is not detected (row D01).
- Pruning retention is as recorded in `docs/migration-qualification.md`.
