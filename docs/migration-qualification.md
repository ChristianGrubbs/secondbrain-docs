# CLI vault capture: Task 6 qualification report

Status: 6A, 6B, 6C and 6D are all evidence-backed below (packets 1 and 2).
Task 6 as a whole is **not accepted**: F06 fails on an unresolved operator
decision, F07 fails on a confirmed external converter limit, and D01/D03 are
confirmed limits/defects deliberately left unfixed per this packet's scope.
See `docs/plans/2026-09-13-cli-vault-capture-tasks-6-7.md` for the full task
definition and acceptance criteria.

**Packet-2 corrections to packet 1:** **F06 and F07 are recorded as fail**,
not "pass with known gap" — the plan requires local-asset preservation (F06)
and table-structure assertions (F07) as qualifying conditions for those rows,
not optional extras, so a row that fails either requirement fails the row.
See their entries below and the "Decisions needed" section for F06's blocking
choice.

## Header: baseline and toolchain

- Fork HEAD at start of this packet: `8a6b85f3ba247c76305ab006dd9f2c2b595aa6f6`
  (`docs(vault): refresh remaining capture migration tasks (#8)`).
- Upstream merge-base: `acb8247e2e95c3bff0bc5f67f7f3f926d56560c4` (as recorded in the
  task dispatch; not re-derived in this packet).
- Node: `v22.23.2` (`/opt/homebrew/opt/node@22/bin` on `PATH`), npm `10.9.8`, arch
  `arm64`, native module ABI `127` (verified: `better-sqlite3` and `sqlite-vec`
  load; `./dist/vault-cli.js --version` prints `3.1.0`).
- Playwright: `Version 1.61.1`; Chromium builds present under
  `~/Library/Caches/ms-playwright/`: `chromium-1208`, `chromium-1228`,
  `chromium-1234` (plus matching `chromium_headless_shell-*` and `ffmpeg-1011`).
  `npx playwright install chromium` had already been run for this worktree.
- `obsidian-cli`: `~/ai-stack/bin/obsidian-cli`, present; it has no `--version`/
  `version` subcommand (`obsidian-cli help` lists none) — recorded as a fact, not
  invented.
- Isolated locations used by every fixture run in `test/vault-capture-e2e.test.ts`:
  a fresh `mkdtemp` vault (`00 Inbox` pre-created) as `OBSIDIAN_VAULT`, a fresh
  `mkdtemp` state dir passed as `--state-dir`, and a `config.yaml` written inside
  that state dir and passed as `DOCS_MCP_CONFIG` (`allowedRoots: [os.tmpdir()]`,
  open network). The operator's real config, state directory and vault
  (`/Volumes/3M/Obsidian`) are never referenced by any fixture row. The suite's
  first test (`ran the override gate before capturing anything`) proves
  `obsidian-cli status` reports the throwaway vault before any capture runs, and
  the suite's last test (`never touched the operator's live vault`) asserts none
  of this packet's collection folders exist under the live vault's Inbox or Doc
  Sets roots.
- The unset-`DOCS_MCP_CONFIG` sandboxed-home probe (6D scope) was **not** run in
  this packet — it belongs to 6D and would require a sandboxed home/config
  environment; every row here uses an explicit `DOCS_MCP_CONFIG`.

## F-rows: format/behavior qualification (6B)

Suite: `test/vault-capture-e2e.test.ts`, `describe("sb-docs capture format/behavior
qualification")`. Verification command and result: `npx vitest run
test/vault-capture-e2e.test.ts` → **38 tests passed** (includes F, C, X (incl.
SIGTERM/SIGHUP browser-cleanup), M and D03 rows; wall time ~150s, dominated by
the X03 signal-cleanup tests' grace periods and F20's nine-member per-outcome
qualification).

**Packet 3 correction (MAJOR 3, 2026-09-13 Codex frontier review):** every row
below now runs the shared `assertQualifiedNote` helper — reads the saved note
via disk + `sb-docs read`, asserts every required fact in the saved bytes,
frontmatter identity (`source_id`, `version`, `source_url`/`requested_url`),
the whole-note digest, exactly one MOC link, and that `sb-docs search`
resolves the note's identity (path + digest) under the right collection/
version scope — not merely an envelope-markdown substring check. F02 is
pinned to README-specific text (not a generic package-name string that also
appears elsewhere in the repo) and now targets the README's own blob URL
directly, because a base-repo-URL crawl with `--max-pages 5` does not reliably
include README.md (confirmed by a real run: GitHub's tree order returned five
`.agent/skills/*` files and the wiki page, never README.md).

| ID | Row | Source/fixture (sha256 or revision) | Result | Evidence |
| --- | --- | --- | --- | --- |
| F01 | Single docs page | `https://www.rfc-editor.org/rfc/rfc2549.txt` (live, dated 2026-09-13) | pass | Test "F01…"; full contract via `assertQualifiedNote` (fact `"Avian Carriers"`, frontmatter, digest, one MOC link, search identity, full `read`) |
| F02 | GitHub README | `https://github.com/arabold/docs-mcp-server/blob/main/README.md` (live, `main` branch, dated 2026-09-13) | pass | Test "F02…"; direct README blob capture (see packet-3 correction above); full contract pinned to `"Grounded Docs: Your AI's Up-to-Date Documentation Expert"` |
| F03 | GitHub blob | `https://github.com/arabold/docs-mcp-server/blob/main/package.json` (live, `main` branch, dated 2026-09-13) | pass | Test "F03…"; `--max-depth 1 --max-pages 2`; full contract; see Defect 2 below |
| F04 | Bounded two-page site | in-process `node:http` fixture server (root + 1 child link) | pass | Test "F04…"; full contract applied to both the root and child outcome independently (source-URL-matched, not `outcomes[0]`/`outcomes[1]` positional) |
| F05 | JS-rendered page | `https://quotes.toscrape.com/js/` (live, dated 2026-09-13) | pass | Test "F05…"; full contract, fact `"Albert Einstein"`, proving Playwright rendering ran |
| F06 | Local Markdown | `test/fixtures/vault-capture/local-notes.md` sha256 `e82c0813d1355ccd3214290f05ce735590d428750f957cbbcc22c737869625d2` + `pixel.png` sha256 `431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460` | **fail** | Test "F06: local Markdown preserves body/code fence/Unicode, but FAILS the row's local-asset-preservation requirement"; body, fenced code block and Unicode (`café`, `日本語`) preserved and `read` full-byte match, but the row's required local-asset copy+link does not happen: the local `./pixel.png` reference is preserved as literal text and the image itself is never copied beside the saved note (asserted: `assetCopied === false`). Root cause: `VaultCaptureService` has no local-asset step, and every vault write goes through `obsidian-cli`, which has no binary/attachment write command (`obsidian-cli help`: `create`/`write`/`append`/`section-insert`/`move` are Markdown-note-only). See "Decisions needed" below. |
| F07 | Text PDF with a table | `test/fixtures/vault-capture/table.pdf` sha256 `1cc1b3c320e2c4bdcc82eccb9cc9f273b9b9de19bf21f1c3f8c90f19a8f3a898` (generated by `test/fixtures/vault-capture/generate-table-pdf.mjs`) | **fail (converter limit, external dependency)** | Test "F07: text PDF with a table preserves cell text, but FAILS the row's table-structure requirement (converter limit)"; cell text preserved (`Mercury`, `87.97`, `Earth`, `365.26`), but no Markdown table is produced. Probed `@xberg-io/xberg`'s `extract()` directly against this fixture with (a) default options and (b) `pdfOptions: { extractTables: true, allowSingleColumnTables: true }` — both calls returned `document.tables === []` and identical flattened-prose `content`. The PDF table detector does not recognize this fixture's column-aligned text as a table at all; `DocumentPipeline.extractContent` has nothing structured to prefer over prose. No scoped fix is available in this fork's code — this is `@xberg-io/xberg`'s PDF table detector, an external dependency. |
| F08 | DOCX | `test/fixtures/sample.docx` sha256 `269329fc7ae54b3f289b3ac52efde387edc2e566ef9a48d637e841022c7e0eab` | pass | Test "F08…"; full contract, fact `"Continued Lists"` (a stable converted section, not a stub) |
| F09 | Mixed-file directory | `test/fixtures/vault-capture/mixed-dir/` (`alpha.md`, `beta.txt`, `gamma.json`) | pass | Test "F09…"; full contract applied **per file** (3 outcomes, each source-matched and independently qualified — not a joined-bodies substring check) |
| F10 | Same source at two versions | synthetic `versioned.md`, per-version tokens `ONLYINV1TOKEN`/`ONLYINV2TOKEN` | pass | Test "F10…"; full contract applied **per version** including version-scoped `search`, plus explicit cross-version isolation (v1's token returns zero results under `--version v2` and vice versa) |
| F11 | Manually edited existing capture | synthetic `editable.md`, sentinel `SNOZZBERRY-3301` | pass | Test "F11: a manually edited existing capture…"; also serves as **X01** (exit 2) — see X-rows |
| F12 | Acquisition/conversion failure | in-process `node:http` 404 root | pass | Test "F12: an acquisition failure (404 root)…"; also serves as **X02** (exit 1) — see X-rows |
| F13 | PPTX | `test/fixtures/sample.pptx` sha256 `8765677cdf43181ef41657cedf28485b5f2cbf166667218c217af07f8336c96f` | pass | Test "F13…"; full contract, facts `"Presentation Title Text"` + `"Subtitle Text"` (verified directly from the fixture's slide XML — MAJOR 2 correction; length-only assertion replaced) |
| F14 | XLSX | `test/fixtures/sample.xlsx` sha256 `d694112f5603126b551e1afedf3c961ab071926167ae6e4c509a2679918b74e4` | pass | Test "F14…"; full contract, facts `"\| X \| Y \|"`, `"\| 7 \| 34 \|"`, `"\| 11 \| 21 \|"` (exact cells read from the committed fixture's sheet1.xml — MAJOR 2 correction; length-only assertion replaced) |
| F15 | ipynb | `test/fixtures/sample.ipynb` sha256 `8754b567dff9986e9cb4fd85226cecfce359c73fbc1ee340917428a3637d0b83` | pass | Test "F15…"; full contract, facts `"This is a test notebook for document pipeline testing."` (prose cell) AND `"print('Hello from Jupyter!')"` (code cell) — MAJOR 2 correction; length-only assertion replaced |
| F16 | JSON | `test/fixtures/json.json` sha256 `bab3dfd2a6c992e4bf589eee05fc9650cc9d6988660b947a7a87b99420d108f9` | pass | Test "F16…"; full contract, facts: key `"slideshow"` AND its nested value `"Wake up to WonderWidgets!"` — MAJOR 2 correction; key-only assertion replaced |
| F17 | XML | `test/fixtures/xml.xml` sha256 `8af142cb967d18f96520013a33760bbf5459f60a521d224a4ddd40c7794758bc` | pass | Test "F17…"; full contract, fact `"Wake up to WonderWidgets!"` — MAJOR 2 correction; length-only assertion replaced |
| F18 | Plain text | `test/fixtures/vault-capture/plain.txt` sha256 `5e647be72c971c0abca6de25c20a0e1874c623482d20fd1cf2f5c4383c2fd02e` | pass | Test "F18…"; full contract, fact `"FLUMPADOODLE-9182"` |
| F19 | Source code | `test/fixtures/vault-capture/source-code.py` sha256 `a5a9f1f24f6a1d246572415b8e36128ddbbe44fc17b60eeaee25016e4dfadbce` | pass | Test "F19…"; full contract, facts `"QUAGGLE-4471"` + `"quaggle_factor"` |
| F20 | ZIP archive | `test/fixtures/archive.zip` sha256 `116f68b99de8e3028c24df4fc825e409e694b1f6e762c994a3b41492717f377a` (9 members) | pass | **MAJOR 4 correction (2026-09-13 Codex frontier review):** all nine members are now frozen with an expected disposition, replacing the old "≥5 of 9" threshold. A real run confirmed all nine publish (sample.xlsx, sample.pptx, sample.pdf, sample.ipynb, sample.docx, robots.txt, json.json, html.html, xml.xml — none excluded, including `robots.txt`, which is not treated as a crawl-exclusion signal inside an already-local archive). Test "F20…" asserts exact outcome membership (9, not ≥5), a member-specific fact per file, one MOC link, saved-byte digest, `search` identity and full `read` per published member. |

## C-rows: real-CLI first-capture directory bootstrapping (6B)

Each row uses its own brand-new throwaway vault (not the shared F-row sandbox) and
the real `obsidian-cli`, verified with the same override-gate check before
capturing.

| ID | Row | Result | Evidence |
| --- | --- | --- | --- |
| C01 | First capture, no `00 Inbox` folder present | pass | Test "C01: first capture with no inbox folder present…"; exit 0, note published under `00 Inbox/Source Captures/`, folder bootstrapped by the real CLI |
| C02 | First capture, no `30 Tools-Models` (Doc Sets) parent and no named collection folder | pass | Test "C02: first capture with no Doc Sets parent and no named collection folder…"; exit 0, `30 Tools-Models/Doc Sets/c02-brand-new/index.md` created |
| C03 | Collection name with spaces and Unicode (`café 日本語 collection`) | pass | Test "C03: collection name with spaces and Unicode…"; exit 0, MOC created at the literal Unicode path, sentinel retrievable via `sb-docs search` |
| C04 | Established mixed-case collection folder (`MixedCase-Docs`) reused on a second capture argued as `mixedcase-docs` | pass | Test "C04: an established mixed-case collection folder is reused…"; exactly one case-insensitive folder exists after both captures (macOS APFS is case-insensitive/case-preserving; the assertion is "no second variant," not exact-casing preservation — see the in-test comment) |

The unit-level missing-directory diagnostics required by 6B (`not a directory` vs.
`no such directory for:`) were already present in `src/vault/ObsidianCli.test.ts`
(lines ~160-166) before this packet; not duplicated here.

## X-rows: process-boundary exit codes (6B)

| ID | Row | Result | Evidence |
| --- | --- | --- | --- |
| X01 | Partial/useful-but-incomplete capture — exit 2 | pass (reused) | F11's process-level test IS this row: a manual edit conflict on recapture asserts `run.code === 2`, `publication.status === "conflict"`, and the human edit plus the original sentinel both survive in the saved note |
| X02 | All-failed/no-useful-publication — exit 1 | pass (reused) | F12's process-level test IS this row: a 404 root asserts `run.code === 1` and `envelope.run_error` is set |
| X03 | Cancelled via SIGINT — exit 130 | pass, after a genuine defect fix (Defect 3 below) | Test "X03: SIGINT cancellation exits 130 and preserves outcomes published before the abort"; root page publishes, then a real OS-level `SIGINT` is sent mid-fetch of a deliberately slow child page; `run.code === 130`, `envelope.cancelled === true`, ≥1 published outcome, and the root's saved note remains independently searchable after cancellation |
| X03b | SIGINT/SIGTERM/SIGHUP browser-cleanup (MAJOR 1 addition, packet 3) | pass | Three new `it.each` tests, "SIGINT/SIGTERM/SIGHUP during a browser-rendered capture leaves no Chromium descendants or leaked temp profile dirs": for each signal, live Chromium pids are recorded via `pgrep -f ms-playwright` at signal time, and none remain alive after a grace period; no new `*playwright*`-named temp profile directory is left behind |

Publication exceptions not incrementing the upstream acquisition-failure counter
is covered by existing `VaultCaptureService.test.ts` unit evidence (not
duplicated at the process level in this packet, per the plan's "add process
coverage only where absent").

## M-rows: subprocess/vault-access measurements (6B, accepted cost, no threshold)

Instrumented via `SB_DOCS_LOG=1` + `SB_DOCS_LOG_FILE` JSONL plus wall-clock
`performance.now()` around the CLI invocation. **Corrected in packet 3** (MINOR
7, 2026-09-13 Codex frontier review): `lock.acquired`/`index.upserted` counts
are index-internal, not subprocess/vault-access counts. `src/vault/ObsidianCli.ts`
(`createObsidianCliRunner`) now emits one `vault.cli_invoked` event per spawned
`obsidian-cli` process, classified `list`/`read`/`write`/`other`
(`classifyObsidianCliSubcommand`), so real subprocess and vault-access counts
are reported separately from the index-internal counts. No cache and no
pass/fail threshold were introduced — these are recorded measurements only.

| ID | Row | Elapsed | Lock acquisitions | Index upserts | obsidian-cli subprocesses | list / read / write | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M01 | F04 two-page site | ~4.9s (single run; includes cold Playwright launch) | 4 | 2 | 18 | 3 / 10 / 5 | Test "M01: F04 two-page site…"; `console.log("[M01] ...")` |
| M02 | F09 mixed-file directory (3 files) | ~2.2s | 6 | 3 | 28 | 4 / 17 / 7 | Test "M02: F09 mixed-file directory…"; `console.log("[M02] ...")` |

The accepted per-capture full-collection vault scan is the measured cost shown
above; the plan explicitly forbids inventing a threshold or installing a cache
to make this look faster, so none was added.

## Decisions needed (blocking F06 acceptance)

Row F06 fails because there is no way to preserve a local document asset
(e.g. a Markdown-relative image) that respects the "all vault access uses
`obsidian-cli`" invariant: `VaultCaptureService` has no local-asset copy/link
step today, and `obsidian-cli` has no binary/attachment write command
(`obsidian-cli help` lists only `create`/`write`/`append`/`section-insert`/
`move`, all Markdown-note operations). Three options, none implemented in
this packet:

(a) **Add an attachment command to `obsidian-cli`** in `~/ai-stack` (e.g. a
    `obsidian-cli attach <relative-dest> < bytes` that writes a binary file
    into the vault through the same tokenized/CAS-aware path as note writes).
    Keeps the invariant intact; requires an `~/ai-stack` change outside this
    repository.
(b) **Permit a direct filesystem copy for binary assets only** (Markdown
    writes still go through `obsidian-cli`; only non-text attachments bypass
    it). Narrows the invariant with an explicit, reviewed exception.
(c) **Accept the limitation and drop local-asset preservation from the row**
    — document F06 as a permanent, accepted gap rather than a blocking defect,
    and update the plan's 6A requirement accordingly.

This packet does not choose an option; the operator/reviewer decision gates
whether F06 can ever pass as specified.

## Defects found and fixed during this packet

1. **`f:src/scraper/strategies/GitHubScraperStrategy.ts:617-627`** (row F03): a
   GitHub blob URL given directly as the capture root only *discovered* itself
   as a link at depth 0; `BaseScraperStrategy` seeds its `visited` set with the
   root URL before the crawl starts, so that self-referential link was
   permanently deduped and never revisited — real capture of a bare blob URL
   silently produced zero outcomes (exit 1, no `run_error`) at any
   `--max-depth`/`--max-pages`. Fixed by fetching and processing the blob
   content directly at depth 0 via the existing `GitHubRepoProcessor`, with a
   process-level demonstration (F03) and a corrected unit regression in
   `src/scraper/strategies/GitHubScraperStrategy.test.ts` ("should fetch and
   process a single blob file URL directly at depth 0…").
2. Same root-cause class also affected **F02** (base repo URL): the depth-0
   discovery step is correct for a *multi-file* repo crawl (children are meant
   to be revisited at depth 1), but the CLI's own default `--max-depth 0`
   means a caller must pass `--max-depth 1` to actually fetch any of it. This
   is a documented CLI default interacting with GitHub's two-phase discovery,
   not a code defect — recorded as a **usage note**, not a fix: F02/F03's test
   rows now pass `--max-depth 1` explicitly (as would any real caller wanting
   GitHub content, not just a link list).
3. **`f:src/scraper/fetcher/BrowserFetcher.ts:317-323`** (row X03): Playwright
   installs its own default `SIGINT` handler that force-closes the browser and
   exits the process directly. On a real OS-level `SIGINT` during a
   browser-rendered capture, that handler raced and won against `sb-docs
   capture`'s own SIGINT handler (`src/vault-cli/commands/capture.ts`), which
   aborts gracefully and prints the exit-130 JSON envelope — the process
   exited 130 with the browser torn down but **no envelope was ever printed on
   stdout**, silently breaking the documented "clients inspect the full JSON
   envelope" contract for real cancellation (confirmed by direct process
   probing outside vitest before the fix: empty stdout, `EXIT 130`, no JSON).
   Fixed by passing `handleSIGINT: false` to `chromium.launch()`, leaving
   *that one signal's* cleanup to the CLI's own handler.
   **Packet-3 correction (MAJOR 1, 2026-09-13 Codex frontier review):** the
   original fix over-broadly also disabled `handleSIGTERM`/`handleSIGHUP`,
   removing cleanup paths the CLI does not replace — `capture.ts` bridges only
   `SIGINT`, and this launcher is shared with the upstream HTML-scraping
   middleware, which bridges none of the three signals. `handleSIGTERM` and
   `handleSIGHUP` are now left at Playwright's own default (`true`), since
   Playwright's own handlers are what reliably reap the detached browser
   process tree and its temp profile directory on those signals. Verified by
   direct process probing before/after: sending `SIGTERM`/`SIGHUP` to a
   browser-rendered capture reaps every Chromium descendant pid within the
   grace period in both cases (the overall CLI process is not itself killed
   by either signal in this environment, since Playwright's own driver
   intercepts them — no cancellation contract is claimed for SIGTERM/SIGHUP,
   only "no leaked descendants/temp dirs"). Regression:
   `src/scraper/fetcher/BrowserFetcher.test.ts` ("disables only Playwright's
   own SIGINT handling…") plus three new process-level tests in
   `test/vault-capture-e2e.test.ts` ("SIGINT/SIGTERM/SIGHUP during a
   browser-rendered capture leaves no Chromium descendants or leaked temp
   profile dirs") that enumerate live Chromium pids via `pgrep -f
   ms-playwright` at signal time and assert none remain after a grace period,
   plus a temp-dir leak check.
4. **`f:src/vault-cli/commands/capture.ts:85` / `f:src/vault-cli/commands/search.ts:74`**
   (present in the worktree before this packet, carried forward and verified
   here): yargs reserves the `version` key for its own top-level `--version`
   flag, so without `.version(false)` on each subcommand, `capture --version
   <label>` / `search --version <label>` silently dropped `<label>` and every
   capture/search ran against the unversioned (`""`) source. Fixed with
   `.version(false)` per subcommand; regression tests already present in
   `capture.test.ts` and `search.test.ts` (see `git diff` on this branch).
5. Two test-suite bugs (not product defects), fixed in `test/vault-capture-e2e.test.ts`:
   F07 originally referenced its fixture at the real repo path instead of a
   temp copy under the config's `allowedRoots`, failing `fetch-failed`/exit 1
   unconditionally; and F06's `read`-vs-saved-bytes comparison did not account
   for the `read` command's own trailing newline (a `console.log`-style line
   printer), which is an output-formatting artifact, not data loss.

## Verification run log

Packet 1:

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (2 formatting fixes on new/edited test files; no logic changes).
- `npx vitest run test/vault-capture-e2e.test.ts` — **29 passed / 29** (F01-F20, C01-C04, X03, M01-M02).
- `npx vitest run src/vault/ObsidianCli.test.ts` — passed as part of the combined targeted run below (missing-directory diagnostics already present; no changes needed this packet).
- `npx vitest run src/scraper/strategies/GitHubScraperStrategy.test.ts` — **38 passed / 38** (includes the corrected blob-URL unit test).
- `npx vitest run src/scraper/fetcher/BrowserFetcher.test.ts` — **12 passed / 12** (includes the new signal-handling regression).
- Combined targeted run — `npx vitest run src/vault-cli/commands/capture.test.ts src/vault-cli/commands/search.test.ts src/vault/ObsidianCli.test.ts` — **37 passed / 37**.
- `npm test` (full suite) — **148 files / 2312 tests passed**, exit 0.

Packet 2 (F06/F07 corrections, 6C, 6D):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (formatting only; no logic changes).
- `npx vitest run test/vault-capture-e2e.test.ts` — **35 passed / 35** (F01-F20 with corrected F06/F07, C01-C04, X03, M01-M02, D03 × 6).
- `npx vitest run src/vault/VaultIndex.test.ts` — **94 passed / 94** (R01-R09 ×2 paths with digest + second-collection-untouched assertions, R11, R12/R13, D01, D02, plus all pre-existing coverage).
- `npx vitest run test/vault-index-e2e.test.ts` — **21 passed / 21** (new R10 × 8 cases, R16 × 3 cases, plus all pre-existing coverage; wall time ~226s — real subprocess spawns).
- `npm test` (full suite) — **148 files / 2333 tests passed**, exit 0 (packet-1 total was 148 files / 2312 tests; packet 2 adds 21 new/extended assertions across `VaultIndex.test.ts`, `test/vault-index-e2e.test.ts` and `test/vault-capture-e2e.test.ts`'s D03 describe, net of test-count changes from renaming rather than adding two existing F06/F07 tests).
- `git diff --numstat` — no new binary blobs; no literal NUL bytes introduced in `.ts` sources by packet 2's edits.

## 6C rows: damaged state cannot become a false miss (packet 2)

Unit-level evidence: `src/vault/VaultIndex.test.ts`, `describe("the upsert path
recovers everything the search path does")` (the nine-shape `damages` table,
both `it.each` blocks), `describe("two collections")`, `describe("failures
after a generation has begun")`. Verification: `npx vitest run
src/vault/VaultIndex.test.ts` → **94 passed / 94**.

Process-level evidence: `test/vault-index-e2e.test.ts`, two new `describe`
blocks (`R10: process-level damaged-index representatives` and `R16: a note
edited/renamed/deleted while its update waits under a held index lock`).
Verification: `npx vitest run test/vault-index-e2e.test.ts` → **21 passed /
21** (wall time ~226s; real subprocess spawns per case).

**Packet 3 correction (MAJOR 5, 2026-09-13 Codex frontier review):** the
R01-R09 unit tests previously ran per-note `search` calls *before* inspecting
the manifest/database, which matters because `search` itself repairs
whatever damage it finds — an incomplete writer-side repair could be masked
by that later search before the ordering fix. Both `it.each` blocks now
inspect the manifest AND the database (`storedChunks`, including the second
collection's row count via `expectOtherCollectionUntouched`) immediately
after `upsert`/`search` resolves and before any further query. A new fixture
test, "an incomplete writer-left artifact is caught by direct inspection, but
invisible after search has already repaired it", constructs exactly this
case to prove the ordering matters: it demonstrates that a fragile,
incomplete on-disk artifact is observable via direct inspection but becomes
invisible once a `search` call has already repaired it. The process-level R10
tests in `test/vault-index-e2e.test.ts` already inspected `readIndexState`
before any follow-up `search`; that ordering needed no change, and both R10
tests now additionally assert `chunkRows` (database row count), not only
manifest vault-path membership.

| ID | Row | Result | Evidence |
| --- | --- | --- | --- |
| R01 | Impossible pointer target (search + upsert) | pass | `damages[0]`, both `it.each` blocks |
| R02 | Malformed pointer JSON (search + upsert) | pass | `damages[1]` |
| R03 | Deleted pointer with generations remaining (search + upsert) | pass | `damages[2]` |
| R04 | Deleted generation directory (search + upsert) | pass | `damages[3]` |
| R05 | Old manifest format (search + upsert) | pass | `damages[4]` |
| R06 | Non-object manifest row (search + upsert) | pass | `damages[5]` |
| R07 | Previous store encoding (search + upsert) | pass | `damages[6]` |
| R08 | Missing database (search + upsert) | pass | `damages[7]` |
| R09 | Unreadable database (search + upsert) | pass | `damages[8]` |
| R10 | Process-level representatives: malformed pointer, deleted pointer, malformed manifest row, deleted database, through `search` and a `capture` that triggers `upsert` | pass | `test/vault-index-e2e.test.ts` describe "R10: process-level damaged-index representatives (search and upsert)", 8 test cases (4 shapes × search/upsert); membership inspected via `readIndexState` directly (manifest + `documents` row count), not top-N search |
| R11 | Never-built vs. honest miss vs. damaged-with-notes, distinguished | pass | `VaultIndex.test.ts` "distinguishes never-built, honest miss and damaged-with-notes (R11)": all three envelopes checked side by side; never-built and honest-miss both legitimately `status: ok` + empty; damaged-with-notes recovers real results and is asserted `not.toEqual([])` |
| R12 | Two collections (A, B): rebuild A, then B, delete only derived index data, reconstruct both; manifests inspected before any search | pass | `VaultIndex.test.ts` "reconstructs every collection after the whole index is deleted" (pre-existing, cited) plus the new "preserves manual edits, excludes conflicts, and keeps version identities distinct across a two-collection full reconstruction (R12/R13)" |
| R13 | Full index loss with saved notes present, vs. a never-built control; manual edits preserved; conflict candidates excluded; case/whitespace-distinct version identities stay distinct | pass | Same new test as R12. This index never fetches an original external source — only saved vault bytes — so "deny the original fetch" is satisfied by construction (`vault.writes` stays empty throughout); recorded rather than separately probed |
| R14 | Generation-construction failure mid-build: no bad promotion, prior generation unchanged | pass (pre-existing coverage, cited) | `VaultIndex.test.ts` `describe("failures after a generation has begun")`: "keeps the prior generation when indexing fails part way through", "keeps the prior generation when verification rejects what was persisted" |
| R15 | Held index lock: capture exits 0 with `index: pending`; search/reindex fail visibly; release + rebuild recovers | pass (pre-existing coverage, cited) | `test/vault-index-e2e.test.ts` `describe("with the index lock held by another process")` plus "picks up the pending note on the next reindex" |
| R16 | A note edited, renamed, or deleted while its update waits under a held lock; the reindex/search outcome describes the actual state | pass | `test/vault-index-e2e.test.ts` new describe "R16: a note edited/renamed/deleted while its update waits under a held index lock", 3 test cases: edit → new content searchable, old content gone; rename → found at new path via source-identity discovery, not the pending path; delete → search returns zero results and reindex still reports `status: "rebuilt"` (never a stale "indexed" claim for a vanished note) |

Frontmatter exclusion, saved-byte digests, and no-fetch/no-embedding/no-listener
assertions are preserved throughout: the new R01-R09/R11-R13 tests reuse
`sha256(note.markdown)` digest checks already established in this file;
`FakeVault` records no writes (`vault.writes`) in any of the new tests; the
process-level R10/R16 tests reuse the existing `no-listen-guard.mjs`
`listenCalls` assertions already wired into `runVaultCli`.

## 6D rows: residual issues (packet 2)

| ID | Item | Result | Evidence |
| --- | --- | --- | --- |
| D01 | Post-promotion FTS/document divergence at unchanged row count | **accepted limit, confirmed not detected** | `VaultIndex.test.ts` "does NOT detect documents_fts content diverging from documents at an unchanged row count (D01, accepted limit)": directly rewrites one `documents_fts` row's content (bypassing the upstream trigger that keeps it and `documents` in sync) with both tables' row counts unchanged before/after; `search` returns `status: "ok"` with no omission entry describing the divergence — the probe was run and the limitation is confirmed, not claimed fixed. Source of the accepted-limit disposition: Task 5 review, MOC log 2026-09-13 (per this packet's dispatch instructions). |
| D02 | Generation pruning retention is best-effort | **pass (tolerance proven)** | `VaultIndex.test.ts` "logs and tolerates a generation-pruning removal failure without losing the active generation (D02)": makes a stale generation directory unremovable (chmod 0o555, which blocks deletion of files inside it — a portable failure mode, since chmod 000 on a directory is not reliably enforced for the owning user on every filesystem), rebuilds twice more; the active generation and its search results are unaffected throughout, the leftover directory is confirmed still present (not silently lost track of), `pruneGenerations`' existing `index.prune_failed` warning log covers the "record leftovers" requirement, and restoring permissions + one more rebuild proves the next pruning pass retries and succeeds. No exact retained-generation count is asserted; no durable publication state is touched. |
| D03 | `loadConfig()` auto-writes the system config when `DOCS_MCP_CONFIG` is unset | **confirmed defect, not fixed (per this packet's explicit instruction)** | `test/vault-capture-e2e.test.ts` new describe "D03: DOCS_MCP_CONFIG-unset config auto-write, in a sandboxed HOME (6D probe)". Verified first that `os.homedir()` honours a sandboxed `HOME` env var on this Node/macOS combination (`env-paths`' macOS branch reads it), so the probe cannot touch the operator's real `~/Library/Preferences/docs-mcp-server/config.yaml`. Results per command with `DOCS_MCP_CONFIG` unset and no prior config file: `search` — config **created**; `read` — config **NOT created**; `reindex` — config **created**; `capture` — config **created**. With a pre-existing user config present, running `search` **overwrites it** (bytes changed, full default config merged in) — worse than scoped as "auto-write when absent," since an existing file is not protected either. This packet does not modify `loadConfig()`; Task 7 must ship either read-only loading for vault commands or an enforced explicit `DOCS_MCP_CONFIG` on every installed entry point, per the plan's disposition. |

## Release candidate R1 (candidate, not accepted)

This branch's HEAD after packet 2 is a **candidate** R1, not an accepted
release — Task 6 is not complete until the operator/reviewer resolves the F06
"Decisions needed" blocker and this candidate passes review.

- Branch: `worktree-task6-qualification`.
- Node: `v22.23.2`, npm `10.9.8`, arch `arm64`, native module ABI `127`.
- Chromium: Playwright `1.61.1`, `chromium-1234` (also `1208`/`1228` cached from
  earlier lockfile revisions), resolved under `~/Library/Caches/ms-playwright/`.
- `obsidian-cli`: `~/ai-stack/bin/obsidian-cli` (no version subcommand to record
  a version string from).
- Lockfile: `package-lock.json` sha256 to be recorded by whoever packages this
  candidate for install (not computed in this report — record it at packaging
  time so it reflects the exact commit being packaged).
- Full-suite result on this exact head: see "Verification run log" below.

## Packet 3: Codex frontier review fixes (2026-09-13)

Codex frontier review (gpt-6-astra, label `task6-qualification-r1`) of
`8a6b85f...217210ab` returned issues-found with 6 major + 2 minor findings.
All eight are addressed on this branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| MAJOR 1 | `BrowserFetcher.launchBrowser` disables only `handleSIGINT`; `handleSIGTERM`/`handleSIGHUP` stay at Playwright's default. Added SIGINT/SIGTERM/SIGHUP process tests verifying no Chromium descendants or leaked temp profile dirs. | `src/scraper/fetcher/BrowserFetcher.ts`, `.test.ts`; `test/vault-capture-e2e.test.ts` X03b rows |
| MAJOR 2 | F13/F14/F15/F17 assert real fixture facts (verified directly from the fixture's own XML/JSON, since `create-office-fixtures.ts` is a stale generator); F16 asserts a key AND its value. | `test/vault-capture-e2e.test.ts` F13-F17 |
| MAJOR 3 | One shared `assertQualifiedNote` helper (facts, frontmatter, digest, one MOC link, `search` identity, full `read`) applied to every successful outcome in every F/C row; F02 pinned to README-specific text via a direct blob capture; `scripts/live-check-vault.mjs` uses the same contract and reports `blocked` (never `pass`) when capture doesn't publish. | `test/vault-capture-e2e.test.ts` (all F/C rows), `scripts/live-check-vault.mjs` |
| MAJOR 4 | F20 freezes all nine ZIP members with an expected disposition (all nine publish, confirmed by direct inspection) and asserts exact membership plus full per-member qualification. | `test/vault-capture-e2e.test.ts` F20 |
| MAJOR 5 | R01-R09 unit tests inspect manifest+database before any search; a new fixture test proves the ordering matters. | `src/vault/VaultIndex.test.ts` |
| MAJOR 6 | The throwaway-vault guard is extracted into `scripts/lib/vault-guard.mjs`, canonicalizes the supplied destination (catching symlink aliases), and handles an absent live vault without throwing. | `scripts/lib/vault-guard.mjs`, `.test.ts` |
| MINOR 7 | `ObsidianCli.ts` emits a `vault.cli_invoked` JSONL event per subprocess, classified list/read/write; M01/M02 report those counts separately from lock/upsert counts. | `src/vault/ObsidianCli.ts`, `test/vault-capture-e2e.test.ts` M01/M02 |
| MINOR 8 | D03 asserts the expected created/not-created outcome per command and that each process reached its command handler, not just logs. | `test/vault-capture-e2e.test.ts` D03 |

## What this packet does not claim

- Task 6 is not accepted. Packet 2 (6C, 6D) is evidence-backed above, but:
  - F06 remains a **fail** blocked on an operator decision (see "Decisions
    needed").
  - F07 remains a **fail (converter limit)** with no available fix in this
    fork.
  - D01 and D03 are **confirmed limits/defects**, deliberately not fixed in
    this packet.
- No release has been installed or packaged; "Release candidate R1" above
  records facts about this branch's HEAD, not a packaged artifact.
- This report does not choose between the F06 options (a)/(b)/(c) — that is
  the operator's decision to make.
