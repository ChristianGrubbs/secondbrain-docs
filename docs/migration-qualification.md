# CLI vault capture: Task 6 qualification report

Status: 6A, 6B, 6C and 6D are all evidence-backed below (packets 1 and 2), with
twelve further reviewer-driven correction rounds (packets 3, 4, 5, 6, 7, 8, 9,
10, 11, 12, 13 and 14 — see those sections near the end). Task 6 as a whole
was **not accepted** at candidate R1 (`89e3a56`): F06 failed on an unresolved
operator decision, F07 failed on what was recorded as an external converter
limit, and D03 was a confirmed defect. **Packet 15 (2026-09-14) resolves all
three** — see "Packet 15: F06/F07/D03 resolution" near the end for root causes
and evidence — leaving D01 as the one accepted, documented limit. See
`docs/plans/2026-09-13-cli-vault-capture-tasks-6-7.md` for the full task
definition and acceptance criteria. Final full-suite result for R1, run twice:
**152 files / 2476 tests passed**, exit 0 both times; packet 15's own totals
are recorded in its section.

**Packet-2 corrections to packet 1:** **F06 and F07 were recorded as fail**,
not "pass with known gap" — the plan requires local-asset preservation (F06)
and table-structure assertions (F07) as qualifying conditions for those rows,
not optional extras, so a row that fails either requirement fails the row.
Both rows pass as of packet 15; the "F06 decision" section records how the
blocking choice was resolved.

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
| F06 | Local Markdown | `test/fixtures/vault-capture/local-notes.md` sha256 `eeaf2ae953cf063b0504646f4f23a7febab88094daf2283707ec348879ac412c` (packet 15 adds an image-looking line INSIDE the code fence; packet-1 hash was `e82c0813…`) + `pixel.png` sha256 `431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460` | **pass** (packet 15, 2026-09-14) | Test "F06: local Markdown preserves body/code fence/Unicode AND copies+links its local image asset"; the saved body is asserted byte-equal to the source body with exactly one change (the real embed), so the fenced code block — including its `![not-an-image](./pixel.png)` line, which is NOT rewritten — Unicode (`café`, `日本語`) and `read` full bytes are all proven, AND the relative `./pixel.png` embed is rewritten to `_attachments/30 Tools-Models/Doc Sets/f06-local-markdown/<source_id[0:12]>/pixel.png`, the bytes land there through the real `obsidian-cli attach` (byte-equal to the fixture, asserted), the saved note embeds the percent-encoded vault path and no longer the `./pixel.png` literal, and the JSON envelope's `publication.attachments` names the landed path. Root cause was the missing asset step plus the missing sanctioned binary write; resolved by option (a) — `obsidian-cli attach` shipped in ai-stack #638 (`736f4abd`, 2026-09-14) — and the new `src/vault/localAssets.ts` + `VaultPublisher.attachAssets` step, which attaches before the note write so a link never dangles. Embeds are located as mdast `image` nodes (plus the `definition` a reference-style `imageReference` resolves through) by the same `remark-parse` toolchain `markdownLinks.mjs` uses, never by regex, so code fences and inline code are untouched and angle-bracket/titled/parenthesised destinations are handled by the parser; the destination keeps each asset's path relative to the source (`<source_id[0:12]>/images/a/pixel.png`), or an 8-hex hash of that relative path when it climbs above the source directory, so same-basename assets never collide. Assets are (re)attached on the create, replace AND unchanged paths (idempotent `--force`), so a deleted attachment is re-landed on the next capture. Scope: `file://` sources only; a conflict candidate note does not copy assets (documented). Generated destinations percent-encode parentheses as well (a bare Markdown destination ends at the first unbalanced `)`), definition rewrites keep the label's original bytes (escapes intact) and only the FIRST definition of a duplicated label is rewritten, as CommonMark resolves it (2026-09-14 Codex scoped re-review r2). Unit contract: `src/vault/localAssets.test.ts` (13, reparsed with remark to prove references still resolve) and the `local asset preservation (row F06)` describe in `src/vault/VaultPublisher.test.ts` (6, including CAS-retry-with-asset and unchanged-after-deletion). |
| F07 | Text PDF with a table | `test/fixtures/vault-capture/table.pdf` sha256 `0d7647a586bc834534e072dd13b023f3f17e80c0bf86fcb3a0c3be86b9beff66` (generated by `test/fixtures/vault-capture/generate-table-pdf.mjs`, ruled since packet 15) | **pass** (packet 15, 2026-09-14) | Test "F07: text PDF with a ruled table preserves cell text AND table structure"; `content` carries `| Planet | Orbital Period (days) |`, `| --- | --- |`, `| Mercury | 87.97 |`, `| Earth | 365.26 |` through the unchanged `DocumentPipeline`. Root cause was the fixture, not the pipeline: the packet-1 generator emitted absolutely positioned text with NO ruling lines, and xberg's PDF table detection (native grid pass, then heuristic pass) only recognizes ruled grids — probed 2026-09-14 on the pinned 1.0.14 and on 1.1.5 with default and `extractTables` options: borderless 2- and 3-column variants return `tables: []` on both, the same generator with stroked cell borders returns `tables: 1` and a Markdown table on 1.0.14. Borderless column-aligned text therefore remains a recorded, accepted `@xberg-io/xberg` limit (no upgrade: 1.1.x is an incompatible API and does not change this). |
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
| X03b | SIGINT/SIGTERM/SIGHUP browser-cleanup (MAJOR 1 addition, packet 3; rewritten packet 4, MAJOR B; negative control corrected packet 5, MAJOR 3) | pass (unverified before packet 4's rewrite -- the packet-3 version used a machine-wide `pgrep` snapshot that flaked under vitest parallelism and let the fixture page complete naturally; packet 4's negative control was itself vacuous -- see below) | `it.each` "SIGINT/SIGTERM/SIGHUP during a browser-rendered capture leaves no Chromium descendants or a leaked temp profile dir": the fixture page never responds; Chromium descendants are found by walking real `ps` ancestry from the child's own pid; the actual `--user-data-dir` is checked for leaks; SIGINT's exit code (130) and SIGTERM/SIGHUP's host-survives-while-browser-is-reaped outcome are asserted. **Real negative control** (packet 5): `it.each` "negative control: with cleanup disabled, %s leaves a real Chromium descendant and its profile dir alive (proves the assertions can fail)" runs the ACTUAL cleanup case with `SB_DOCS_TEST_DISABLE_SIGNAL_CLEANUP=1` plus a new test-only keep-alive hook (`SB_DOCS_TEST_KEEP_ALIVE_ON_SIGNAL=1` in `capture.ts`) so the host survives the signal in isolation from Playwright's own cleanup, and proves the SAME assertions the healthy case uses (chromium-still-alive, profile-dir-leaked) correctly FAIL to hold. The packet-4 "negative control" (a bare `sleep` pid checked with `kill(pid,0)`) has been removed -- it never exercised browser discovery, signal delivery, or the cleanup case at all. |

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

## F06 decision (resolved 2026-09-14 — option (a))

**Resolution:** option (a) was taken. `obsidian-cli attach` shipped in ai-stack [#638](https://github.com/ChristianGrubbs/ai-stack/pull/638) (`736f4abd`, 2026-09-14) as the one sanctioned binary write, and packet 15 wires it in (`src/vault/localAssets.ts`, `VaultPublisher.attachAssets`). The invariant "all vault access uses `obsidian-cli`" is intact. The original analysis follows unchanged.

Row F06 failed because there was no way to preserve a local document asset
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

Packet 2 did not choose an option; the decision was made on 2026-09-14 by
shipping option (a) in ai-stack, and F06 passes as specified.

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

Packet 3 (Codex frontier review fixes):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (formatting only; no logic changes).
- `npx vitest run src/scraper/fetcher/BrowserFetcher.test.ts` — **12 passed / 12**.
- `npx vitest run src/vault/ObsidianCli.test.ts` — **10 passed / 10**.
- `npx vitest run scripts/lib/vault-guard.test.ts` — **7 passed / 7**.
- `npx vitest run src/vault/VaultIndex.test.ts` — **95 passed / 95**.
- `npx vitest run test/vault-capture-e2e.test.ts` — **38 passed / 38** (wall time ~150-158s; adds three SIGTERM/SIGHUP browser-cleanup tests and reworks every F/C row onto the shared contract).
- `npx vitest run test/vault-index-e2e.test.ts` — **21 passed / 21** (wall time ~226s).
- `npm test` (full suite, exact final commit) — **149 files / 2346 tests passed**, exit 0.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes introduced in `.ts`/`.mjs` sources by packet 3's edits.

Packet 4 (Codex frontier review round 2 fixes):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (formatting only; no logic changes).
- `npx vitest run scripts/lib/vault-guard.test.ts` — **12 passed / 12** (dotted-child, dotted-symlink and negative-control regression cases added).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **9 passed / 9** (new file: well-formed pass plus 8 rejection cases).
- `npx vitest run src/scraper/fetcher/BrowserFetcher.test.ts` — **14 passed / 14** (new negative-control-support test for the env hook).
- `npx vitest run src/vault/VaultIndex.test.ts` — **96 passed / 96** (R12/R13 rewritten with database inspection, whitespace-distinct version, and a new deleted-database ordering case).
- `npx vitest run test/vault-capture-e2e.test.ts` — **40 passed / 40** (wall time ~132s -- faster than packet 3 despite more tests, because the rewritten signal-cleanup tests poll for real state instead of fixed delays).
- **Full `npm test` run TWICE** on the exact final commit, per the coordinator's addendum (their independent run had found the packet-3 SIGTERM test flaking under parallelism): run 1 — **150 files / 2364 tests passed**, exit 0; run 2 — **150 files / 2364 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes introduced in `.ts`/`.mjs` sources by packet 4's edits.

Packet 5 (Codex frontier review round 3 fixes):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (formatting only; no logic changes).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **11 passed / 11** (2 new missing/empty-digest rejection cases).
- `npx vitest run src/vault-cli/commands/capture.test.ts` — **22 passed / 22** (unaffected by the new keep-alive hook).
- `npx vitest run src/vault/VaultIndex.test.ts` — **97 passed / 97** (R12/R13 exact-identity rewrite plus a new wrong-membership regression fixture).
- `npx vitest run test/vault-capture-e2e.test.ts` — **41 passed / 41** (real negative control replacing the vacuous sleep-pid check).
- **Full `npm test` run TWICE** on the exact final commit: run 1 — **150 files / 2368 tests passed**, exit 0; run 2 — **150 files / 2368 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes introduced in `.ts`/`.mjs` sources by packet 5's edits (a stray NUL byte introduced by a tool-encoding artifact mid-edit was caught and removed before committing).

Packet 6 (Codex frontier review round 4 fixes):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (no fixes needed on `.mjs` files; formatting only elsewhere).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **15 passed / 15** (5 new MOC-matching cases: plain-text-only, longer-prefix sibling, malformed syntax, valid aliased link, plus the pre-existing zero/duplicate case).
- `npx vitest run scripts/lib/vault-guard.test.ts` — **12 passed / 12** (unaffected).
- `npx vitest run scripts/live-check-vault.test.ts` — **8 passed / 8** (new file: `resolveGuardedState` throwaway/live-vault/symlink-alias/existing-config/overwrite cases).
- `npx vitest run src/vault/VaultIndex.test.ts` — **97 passed / 97** (unaffected).
- `npx vitest run test/vault-capture-e2e.test.ts` — **41 passed / 41** (every F/C row's MOC assertion now runs through the corrected real-link matcher, since `assertQualifiedNote` delegates to `qualifyNote`).
- Smoke-tested `scripts/live-check-vault.mjs` directly against a real throwaway vault after the `isMainModule`/`resolveGuardedState` refactor — still `allPassed: true`, exit 0, for all four live rows.
- **Full `npm test` run TWICE** on the exact final commit: run 1 — **151 files / 2380 tests passed**, exit 0; run 2 — **151 files / 2380 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes introduced in `.ts`/`.mjs`/`.test.ts` sources by packet 6's edits.

Packet 7 (Codex frontier review round 5 fixes):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (2 import-order fixes on `VaultPublisher.ts`/`live-check-vault.mjs`; no logic changes).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **19 passed / 19** (4 new cases: backtick-fence-only, tilde-fence-only, inline-code-only rejections, plus a real-link-alongside-code-example acceptance).
- `npx vitest run scripts/lib/vault-guard.test.ts` — **17 passed / 17** (5 new `isSymlinkPath`/`assertNotSymlink` unit cases).
- `npx vitest run scripts/live-check-vault.test.ts` — **10 passed / 10** (2 new cases: external `config.yaml` symlinked to an existing/nonexistent live-vault file).
- `npx vitest run src/vault/VaultPublisher.test.ts` — **77 passed / 77** (2 new regressions: tilde-fence and inline-code-span mentions do not suppress the real link).
- `npx vitest run test/vault-publish-e2e.test.ts` — **16 passed / 16** (unaffected; confirms the shared-module refactor didn't change publisher behavior end-to-end).
- Standalone script confirmed the pre-fix (backtick-only) `stripCodeFences` would return a false-positive link count of 1 for both the tilde-fence and inline-code fixtures, and the new "config.yaml symlinked to a NONEXISTENT live-vault file" case in `scripts/live-check-vault.test.ts` failed (`toThrow` received `undefined`) against the pre-fix `resolveGuardedState` — both findings reproduced test-first before their fixes landed.
- Smoke-tested `scripts/live-check-vault.mjs` directly against a real throwaway vault after the guard/matcher changes — still `allPassed: true`, exit 0, for all four live rows.
- **Full `npm test` run TWICE** on the exact final commit: run 1 — **151 files / 2393 tests passed**, exit 0; run 2 — **151 files / 2393 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes introduced in `.ts`/`.mjs`/`.test.ts` sources by packet 7's edits.

Packet 8 (Codex scoped re-review round 6 fixes):

- `npm run typecheck` — clean (no errors); confirms `remark`/`remark-parse`/`unified`/`unist-util-visit` import cleanly from the `.mjs` module under `allowJs`.
- `npm run lint` — clean after `npm run lint:fix` (1 template-literal style fix; no logic changes).
- `npx vitest run src/vault/markdownLinks.test.ts` — **13 passed / 13** (new file: plain/aliased link, plain-text-syntax probe, emphasis-split reassembly, all 8 named CommonMark edge cases, duplicate rejection).
- `npx vitest run src/vault/VaultPublisher.test.ts` — **84 passed / 84** (7 new end-to-end regressions for 7 of the 8 constructs).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **27 passed / 27** (8 new cases covering all 8 constructs).
- `npx vitest run scripts/lib/vault-guard.test.ts` — **17 passed / 17** (unaffected by the TSDoc/named-param changes; `assertNotSymlink` call sites updated).
- `npx vitest run scripts/live-check-vault.test.ts` — **11 passed / 11** (1 new case: dangling `stateDirArg` symlink into a nonexistent live-vault path).
- `npx vitest run test/vault-publish-e2e.test.ts` — **16 passed / 16** (unaffected).
- `npx vitest run test/vault-capture-e2e.test.ts` — **41 passed / 41** (unaffected; every row still routes through the shared, now `remark`-based, contract).
- Standalone script confirmed the pre-fix hand-rolled `stripCodeAndInlineSpans`/`countLinksTo` returned the wrong count (2 instead of 1, or 0 instead of 1) for 5 of the 8 named constructs; the same script against the new `remark`-based implementation returned exactly 1 for all 8.
- Smoke-tested `scripts/live-check-vault.mjs` directly against a real throwaway vault after the rewrite — still `allPassed: true`, exit 0, for all four live rows.
- **Full `npm test` run TWICE** on the exact final commit: run 1 — **152 files / 2422 tests passed**, exit 0; run 2 — **152 files / 2422 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes introduced in `.ts`/`.mjs`/`.test.ts` sources by packet 8's edits.

Packet 9 (controller unist-util-visit fix + Codex scoped re-review round 7 fixes):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (formatting only; no logic changes).
- `npm run build` — clean; confirms Vite bundles `remark`/`remark-parse`/`unified` fine without `unist-util-visit`.
- `npx vitest run src/vault/markdownLinks.test.ts` — **26 passed / 26** (13 new cases: 4 boundary-sentinel fragmentation regressions, 1 block-HTML scope-decision fixture, 7 structural-coverage fixtures, 1 benchmark test).
- `npx vitest run src/vault/VaultPublisher.test.ts` — **87 passed / 87** (3 new end-to-end regressions for inline-code/hard-break/image fragmentation).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **31 passed / 31** (4 new cases: 3 fragmentation rejections, 1 block-HTML rejection).
- `npx vitest run scripts/lib/vault-guard.test.ts` — **17 passed / 17** (unaffected).
- `npx vitest run scripts/live-check-vault.test.ts` — **11 passed / 11** (unaffected).
- `npx vitest run test/vault-publish-e2e.test.ts` — **16 passed / 16** (unaffected).
- `npx vitest run test/vault-capture-e2e.test.ts` — **41 passed / 41** (unaffected).
- Standalone scripts confirmed both majors test-first: the pre-fix module returned 1 (bug) instead of 0 for inline-code/hard-break/image fragmentation fixtures before the boundary sentinel; the MAJOR 2 fast path's first draft itself broke the emphasis/strong/link reassembly tests (caught by the committed test suite, not a standalone script) before the `POSSIBLE_FRAGMENTING_MARKUP` gate was added. Benchmark measured absent-case ~0.1-0.4ms, present-cold-case ~1.4s at 20k entries (matching the reviewer's own measured numbers), present-cached-case ~4-13ms.
- Smoke-tested `scripts/live-check-vault.mjs` directly against a real throwaway vault after the rewrite — still `allPassed: true`, exit 0, for all four live rows.
- **Full `npm test` run TWICE** on the exact final commit: run 1 — **152 files / 2442 tests passed**, exit 0; run 2 — **152 files / 2442 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes introduced in `.ts`/`.mjs`/`.test.ts` sources by packet 9's edits (the boundary sentinel is a Unicode Private Use Area character, `U+E000`, never a NUL byte).

Packet 10 (Codex scoped re-review round 8 fixes, BLOCKER resolved):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (formatting only; no logic changes).
- `npm run build` — clean.
- `npx vitest run src/vault/markdownLinks.test.ts` — **38 passed / 38** (**corrected by packet 11, MINOR 2**: 9 new cases -- 5 Markdown-escape/character-reference fixtures, 1 imageReference fragmentation fixture, 2 U+E000-target fixtures, 1 cache-sequence regression -- plus the existing benchmark test modified in place, not a new test, to use two distinct MOC strings with its absent-case ceiling widened from <50ms to <3000ms to reflect the always-parse design).
- `npx vitest run src/vault/VaultPublisher.test.ts` — **90 passed / 90** (3 new end-to-end regressions: escaped-hyphen link, character-reference link, and U+E000-target link all recognized as already-linked, no duplicate inserted).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **34 passed / 34** (3 new acceptance cases: escaped-hyphen target, character-reference target, U+E000-containing target).
- `npx vitest run scripts/lib/vault-guard.test.ts` — **17 passed / 17** (unaffected).
- `npx vitest run scripts/live-check-vault.test.ts` — **11 passed / 11** (unaffected).
- `npx vitest run test/vault-publish-e2e.test.ts` — **16 passed / 16** (unaffected).
- `npx vitest run test/vault-capture-e2e.test.ts` — **41 passed / 41** (unaffected).
- Both majors verified test-first: a standalone reproduction of the round-6-third-pass sentinel-character implementation returned 1 (bug, false positive) for a pseudo-link fragmented by an inline code span checked against a target containing the literal `U+E000` character, before the array-of-runs rewrite; the same reproduction against the new implementation returned 0. The escape/character-reference fixtures were confirmed to fail against the (now-removed) fast path before its removal. Benchmark re-measured with two distinct MOC strings (so the parse cache could not mask either "cold" measurement): absent-case and present-case both now cost ~500ms at 10k entries, ~1.3-1.4s at 20k, ~7-15s at 50k (no longer asymmetric, since there is no fast path); a repeat call on the exact same string still costs ~2-7ms via the retained single-entry cache.
- Smoke-tested `scripts/live-check-vault.mjs` directly against a real throwaway vault after the rewrite — still `allPassed: true`, exit 0, for all four live rows.
- **Full `npm test` run TWICE** on the exact final commit: run 1 — **152 files / 2457 tests passed**, exit 0; run 2 — **152 files / 2457 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes introduced in `.ts`/`.mjs`/`.test.ts` sources by packet 10's edits (every U+E000 fixture was written via an explicit `\uE000` JS/TS escape sequence, verified byte-for-byte, never a literal glyph typed through an edit tool, and never a NUL byte).

Packet 11 (Codex scoped re-review round 9 fixes):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (formatting only; no logic changes).
- `npm run build` — clean.
- `npx vitest run src/vault/markdownLinks.test.ts` — **38 passed / 38** (3 new alias-bracket cases: escaped `]`, character-referenced `]`, trailing-text-not-swallowed).
- `npx vitest run src/vault/VaultPublisher.test.ts` — **93 passed / 93** (2 new alias-bracket duplicate-prevention regressions, 1 new imageReference end-to-end regression).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **37 passed / 37** (2 new alias-bracket acceptance cases, 1 new imageReference rejection case).
- `npx vitest run scripts/lib/vault-guard.test.ts` — **17 passed / 17** (unaffected).
- `npx vitest run scripts/live-check-vault.test.ts` — **11 passed / 11** (unaffected).
- `npx vitest run test/vault-publish-e2e.test.ts` — **16 passed / 16** (unaffected).
- `npx vitest run test/vault-capture-e2e.test.ts` — **41 passed / 41** (unaffected).
- The MAJOR finding verified test-first: both alias-bracket fixtures returned 0 against the pre-fix regex before the alias-group fix (`(?:(?!\]\]).)*`) landed. Confirmed no regression across the existing duplicate-link, malformed-syntax, and longer-sibling-prefix rejection tests.
- Smoke-tested `scripts/live-check-vault.mjs` directly against a real throwaway vault — still `allPassed: true`, exit 0, for all four live rows.
- **Full `npm test` run TWICE** on the exact final commit: run 1 — **152 files / 2466 tests passed**, exit 0; run 2 — **152 files / 2466 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes or PUA glyphs introduced by packet 11's edits; the one pre-existing literal `U+E000` glyph found in `markdownLinks.test.ts:165` (a round-10-reviewer-caught leftover from an earlier edit-tool call) was converted to an explicit `\uE000` escape sequence as part of this packet's MINOR 2 fix.

Packet 12 (Codex scoped re-review round 10 fixes):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean after `npm run lint:fix` (formatting only; no logic changes).
- `npm run build` — clean.
- `npx vitest run src/vault/markdownLinks.test.ts` — **40 passed / 40** (2 new cases: malformed-unterminated-link-before-valid-link correctness, and a performance regression proving this module's own scan step completes well under 200ms once the parse cache is warm).
- `npx vitest run src/vault/VaultPublisher.test.ts` — **94 passed / 94** (1 new end-to-end regression: the publisher adds the real link for a malformed/unterminated target without duplicating the well-formed link that follows it).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **38 passed / 38** (1 new acceptance case).
- `npx vitest run scripts/lib/vault-guard.test.ts` — **17 passed / 17** (unaffected).
- `npx vitest run scripts/live-check-vault.test.ts` — **11 passed / 11** (unaffected).
- `npx vitest run test/vault-publish-e2e.test.ts` — **16 passed / 16** (unaffected).
- `npx vitest run test/vault-capture-e2e.test.ts` — **41 passed / 41** (unaffected).
- The MAJOR finding verified test-first: `countLinksTo({ markdown: "[[a|unterminated ] text [[b]]\n", target: "a" })` returned `1` (bug) against the round-9 regex before the linear-scanner rewrite. Root-caused the reported performance regression by isolating `processor.parse()` alone (see this packet's table entry above and the module's own top comment) — confirmed the superlinear cost lives in `remark-parse`/`micromark`'s own bracket-resolution algorithm for pathologically bracket-dense malformed input, not in this module's counting logic (measured linear, sub-5ms even at 224KB, once isolated from parsing).
- Smoke-tested `scripts/live-check-vault.mjs` directly against a real throwaway vault — still `allPassed: true`, exit 0, for all four live rows.
- **Full `npm test` run TWICE** on the exact final commit: run 1 — **152 files / 2470 tests passed**, exit 0; run 2 — **152 files / 2470 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes or PUA glyphs introduced by packet 12's edits.

Packet 13 (Codex scoped re-review round 11 fixes):

- `npm run typecheck` — clean (no errors; fixed one new implicit-`any` parameter in the replaced benchmark test).
- `npm run lint` — clean after `npm run lint:fix` (formatting only; no logic changes).
- `npm run build` — clean.
- `npx vitest run src/vault/markdownLinks.test.ts` — **46 passed / 46** (the round-10 performance test replaced with the reviewer's exact repeated-nested-opener-plus-valid-link benchmark; 6 new table-driven boundary-shape cases).
- `npx vitest run src/vault/VaultPublisher.test.ts` — **94 passed / 94** (unaffected; confirms the scanner rewrite is behavior-preserving for every existing end-to-end regression).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **38 passed / 38** (unaffected).
- `npx vitest run scripts/lib/vault-guard.test.ts` — **17 passed / 17** (unaffected).
- `npx vitest run scripts/live-check-vault.test.ts` — **11 passed / 11** (unaffected).
- `npx vitest run test/vault-publish-e2e.test.ts` — **16 passed / 16** (unaffected).
- `npx vitest run test/vault-capture-e2e.test.ts` — **41 passed / 41** (unaffected).
- The BLOCKER verified test-first: a standalone benchmark measured ~68ms for `"[[".repeat(64000) + "valid]]"` (128KB) against the pre-fix round-10 scanner in the same process where the new single-pass scanner measured ~0.25ms at the same input size — reproducing the reviewer's reported quadratic curve and confirming the fix eliminates it (128KB and 256KB both now complete in well under 1ms).
- **Incidental flake fix, unrelated to this round's finding:** the second full-suite run below initially failed once with `expected 7083ms to be less than 3000ms` on the pre-existing (round 6/8) `documents the measured full-parse cost on a large flat-list MOC` benchmark -- a genuine timing flake under full-suite parallel CPU contention (confirmed by an immediate clean re-run at the same commit, no code change, all 152/2476 passing). Widened that benchmark's ceilings (3000ms → 10000ms for the two cold-parse assertions, 500ms → 2000ms for the cached-repeat assertion) to absorb full-suite-load variance while still failing a genuine regression, per this test file's own established "generous ceilings for CI stability" philosophy. This is a test-infrastructure hardening, not a functional change.
- Smoke-tested `scripts/live-check-vault.mjs` directly against a real throwaway vault — still `allPassed: true`, exit 0, for all four live rows.
- **Full `npm test` run TWICE** on the exact final commit: run 1 — **152 files / 2476 tests passed**, exit 0; run 2 — **152 files / 2476 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes or PUA glyphs introduced by packet 13's edits.

Packet 14 (Codex scoped re-review round 12 fixes):

- `npm run typecheck` — clean (no errors).
- `npm run lint` — clean (no fixes needed).
- `npx vitest run src/vault/markdownLinks.test.ts` — **46 passed / 46** (same test count; both fixed tests are hardened in place, not added/removed). Stability-checked with 5 consecutive standalone runs of the scaling test and 3 of the cache-detection test, all passing.
- `npx vitest run src/vault/VaultPublisher.test.ts` — **94 passed / 94** (unaffected).
- `npx vitest run scripts/lib/qualification-contract.test.ts` — **38 passed / 38** (unaffected).
- `npx vitest run scripts/lib/vault-guard.test.ts` — **17 passed / 17** (unaffected).
- `npx vitest run scripts/live-check-vault.test.ts` — **11 passed / 11** (unaffected).
- `npx vitest run test/vault-publish-e2e.test.ts` — **16 passed / 16** (unaffected).
- `npx vitest run test/vault-capture-e2e.test.ts` — **41 passed / 41** (unaffected).
- Both minors are test-harness robustness fixes only -- no change to `markdownLinks.mjs`'s scanner logic, consistent with the reviewer's own exhaustive equivalence probe (14,648,436 input/target combinations, no mismatch) confirming that logic already correct.
- Smoke-tested `scripts/live-check-vault.mjs` directly against a real throwaway vault — still `allPassed: true`, exit 0, for all four live rows.
- **Full `npm test` run TWICE** on the exact final commit: run 1 — **152 files / 2476 tests passed**, exit 0; run 2 — **152 files / 2476 tests passed**, exit 0. Identical counts both times.
- `git diff --numstat` — no new binary blobs; no literal NUL bytes or PUA glyphs introduced by packet 14's edits.

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
| R12 | Two collections (A, B) each with multiple notes: rebuild A, then B, delete only derived index data, reconstruct both; the EXACT SET of distinct database note identities (via the same `(page.url, version)` join `searchStore` itself resolves hits through — not manifest, not text parsed from `content`) equals the expected set for BOTH collections, per-note database CONTENT carries the right body, and manifest digests are checked alongside (not instead of) the database check — all before any search runs; extended to a deleted-database ordering case and a wrong-membership-at-equal-row-count regression fixture | pass (round-3 corrected; round 2's version only asserted a `>=` total row count and checked digests against the manifest, not the database — see Packet 5, MAJOR 1) | `VaultIndex.test.ts` "preserves manual edits, excludes conflicts, and keeps version identities distinct across a two-collection full reconstruction (R12/R13)"; "a deleted database after a two-collection reconstruction is caught by direct inspection, not masked by search (R12/R13)"; "rejects a database with wrong note membership at the same total row count as a healthy generation (R12/R13)" |
| R13 | Full index loss with saved notes present, vs. a never-built control; manual edits preserved; conflict candidates excluded; case- AND whitespace-distinct (`"Release"`/`"release"`/`" Release"`) version identities stay distinct, verified at the database identity level (`storeVersion`-keyed) | pass (round-2 corrected: whitespace-distinct version added; round-3 corrected: database-level identity, not manifest — see Packet 4 MAJOR D, Packet 5 MAJOR 1) | Same tests as R12. This index never fetches an original external source — only saved vault bytes — so "deny the original fetch" is satisfied by construction (`vault.writes` stays empty throughout) |
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
| D03 | `loadConfig()` auto-writes the system config when `DOCS_MCP_CONFIG` is unset | **fixed** (packet 15, 2026-09-14) | Root cause: upstream `loadConfig()` (`src/utils/config.ts`) treats the default system path as writable and unconditionally `saveConfigFile()`s the merged defaults (and quarantines/rewrites an invalid-shape file); `search`/`capture`/`reindex` called it with no options. Fix: fork-local `LoadConfigOptions.readOnly` (recorded in `docs/fork-boundary.md`), passed by all three vault commands; `read` never loaded config. Evidence: `src/utils/config.test.ts` "readOnly: ..." ×3 (no file created; existing bytes preserved; invalid-shape file left in place, no quarantine sibling) and `test/vault-capture-e2e.test.ts` D03 describe flipped — `search`/`read`/`reindex`/`capture` each assert the sandboxed default config is NOT created, and "an existing user config's bytes are PRESERVED when DOCS_MCP_CONFIG is unset" asserts byte equality after `search`. The negative control (broken obsidian-cli backend fails visibly) is unchanged. This is the plan's "read-only loading for vault commands" disposition; Task 7's installed wrapper no longer needs explicit-config containment for correctness, though setting `DOCS_MCP_CONFIG` there remains fine. |
| D04 | A failed browser render can publish as a successful capture | **recorded limit, not fixed** (DOM settle rev 3, 2026-09-15) | Upstream `WebScraperStrategy` (`src/scraper/strategies/WebScraperStrategy.ts`, "Log errors from pipeline") only logs `processed.errors` and returns `FetchStatus.SUCCESS` for any nonempty text, so a Playwright timeout on a JavaScript shell (one `Loading` line, no articles) becomes a published note and can `replace` a previously useful one. Observed once on the AudienceView URL when a mobile fingerprint was drawn (vault note "2026-09-15 Evidence - DOM settle step 0 trace"); the desktop-only fingerprint default removes that trigger, not this failure mode. Making required-render failures fatal is a shared crawl-semantics change for every page and is deliberately out of the rev 3 slice. `# TODO 2026-09-15: decide whether a required-render failure should fail the page (`fetch-failed`, exit 1) instead of publishing the shell; add the forced-render-failure capture regression with it.` |

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

## Packet 4: Codex frontier review round 2 fixes (2026-09-13)

Codex round 2 (label `task6-qualification-r2`) on `8a6b85f...1f378b8` returned
issues-found with 4 major + 1 minor. Findings 2, 4 and 7 from round 1 were
confirmed closed and the R01-R09 ordering fix confirmed sound. All five new
findings are addressed on this branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| MAJOR A | `isInsideLiveVault` treated any relative path starting with the two characters `".."` as outside, so a real child named e.g. `..qualification-probe` was misclassified as outside (and live-check could have captured *inside* the live vault). Now only `relative === ".."` or `relative.startsWith(".." + path.sep)` counts as outside. Added existing/nonexistent dotted-child fixtures, a dotted symlink alias, and a negative control reproducing the old bug side by side with the fix. | `scripts/lib/vault-guard.mjs`, `.test.ts` |
| MAJOR B | The SIGINT/SIGTERM/SIGHUP cleanup tests previously (a) let the fixture page complete naturally, satisfying the test even with a no-op cleanup; (b) used a machine-wide `pgrep -f ms-playwright` snapshot, which the coordinator's independent full-`npm test` run demonstrated flaking under vitest parallelism when other suites launch Chromium concurrently; (c) never checked the actual `--user-data-dir` or asserted signal delivery. Rewritten: the fixture page never responds (cannot complete naturally); Chromium descendants are found by walking `ps -axo pid,ppid,command` ancestry from THIS child's own pid; the actual `--user-data-dir` argument is extracted and checked for leaks; SIGINT's delivered exit code (130) is asserted, and SIGTERM/SIGHUP assert the host process itself stays alive while only the browser is reaped. Full `npm test` run twice at the end (see Verification run log) to directly address the coordinator's flakiness finding. | `test/vault-capture-e2e.test.ts` X-rows |
| MAJOR C | F11 checked only two surviving substrings after the conflict (other manual bytes could vanish undetected); C04 checked exit codes and folder count without qualifying either saved note; F20 omitted frontmatter identity checks; `scripts/live-check-vault.mjs` duplicated a weaker, independently-drifting contract. The shared contract is now one module, `scripts/lib/qualification-contract.mjs` (`qualifyNote`), used by both the suite (`assertQualifiedNote` delegates to it) and `live-check-vault.mjs`; F11 asserts exact whole-note byte equality for the post-edit state plus retrieval after the conflict, and qualifies the initial publication too; C04 qualifies both outcomes fully; F20's per-member loop now runs the full contract. Unit tests for `qualifyNote` include malformed-metadata and wrong-digest fixtures proving the contract rejects them. | `scripts/lib/qualification-contract.mjs`, `.test.ts`; `test/vault-capture-e2e.test.ts` F11/C04/F20; `scripts/live-check-vault.mjs` |
| MAJOR D | R12/R13 inspected only manifests before searches (never the database), seeded only one note in the second collection, and tested case-distinct but not whitespace-distinct versions. Now inspects database rows/digests for both collections (each seeded with 2+ notes) before any search, adds a `" Release"` (leading-whitespace) version alongside `"Release"`/`"release"`, and extends the missing-database ordering fixture to the two-collection reconstruction path. | `src/vault/VaultIndex.test.ts` |
| MINOR E | The D03 `read` probe used a nonexistent note path and a weak "stderr doesn't look like a yargs error" check that trivially passes on empty stderr; the sandboxed `HOME` also relocates `OBSIDIAN_CLI_PATH`, so an unaddressed ENOENT could masquerade as "note not found" (mitigated already by `symlinkObsidianCliInto`, but not proven). Now seeds a real note and asserts `read` returns its complete bytes with exit 0; a new negative-control test breaks the obsidian-cli symlink and confirms `read` fails visibly (nonzero exit, not the seeded content) rather than being silently absorbed. | `test/vault-capture-e2e.test.ts` D03 |

Row-status honesty per the coordinator's instruction: **R12/R13 and the
SIGINT/SIGTERM/SIGHUP process rows (X03/X03b) were unverified prior to this
packet's fixes**; they are recorded as pass above and in the R-row/X-row
tables only because the rewritten assertions in this packet now pass. See
"Verification run log" for the exact commands and the two full-suite runs.

## Packet 5: Codex frontier review round 3 fixes (2026-09-13)

Codex round 3 (label `task6-qualification-r3`) on `8a6b85f...951ecb1` returned
issues-found with 3 major findings. Round-2 findings A and E were confirmed
closed, the `BrowserFetcher` test hook confirmed inert in production, and the
F06/F07/D01/D03 honesty framing confirmed. All three new findings are
addressed on this branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| MAJOR 1 | R12/R13's database check asserted only a `>=` total row count and validated digests against the manifest, not the database -- a database missing one sibling while another supplied enough padding chunks would have passed, and a later search would silently repair it. Now asserts the EXACT SET of distinct `(page.url, version)` database identities for both collections (the same join `searchStore` itself resolves hits through, not manifest text or `content`-parsed text), checks per-note database content for the right phrase, and rejects cross-contamination. A new regression fixture repoints one sibling's database rows onto another's page at the identical total row count and proves the exact-set check rejects it while a count-only check would not. | `src/vault/VaultIndex.ts` (`storeVersion` exported for test use), `src/vault/VaultIndex.test.ts` |
| MAJOR 2 | `qualifyNote` skipped digest validation entirely when `expectedDigest` was `undefined`, so a capture regression that omitted the digest from its own envelope still qualified. The digest is now REQUIRED (non-empty string) and compared unconditionally; a missing/empty digest is itself a contract failure with an explicit reason. | `scripts/lib/qualification-contract.mjs`, `.test.ts` (two new rejection cases: `undefined` and `""`) |
| MAJOR 3 | The packet-4 "negative control" only proved `kill(pid, 0)` recognizes a supplied `sleep` pid -- it bypassed browser discovery, signal delivery, profile tracking, and the cleanup case entirely, so it proved nothing about whether the real assertions would catch a genuine regression. Replaced with a real end-to-end negative control: the ACTUAL cleanup case runs with `SB_DOCS_TEST_DISABLE_SIGNAL_CLEANUP=1`, plus a new test-only no-op signal listener (`SB_DOCS_TEST_KEEP_ALIVE_ON_SIGNAL=1`, registered in `src/vault-cli/commands/capture.ts`, inert unless explicitly set) that keeps the host process alive on SIGTERM/SIGHUP so "Playwright's cleanup is disabled" can be observed in isolation from "the host process died" (Chromium's own CDP pipe transport otherwise treats the parent dying as its own shutdown signal, regardless of `handleSIGTERM`/`handleSIGHUP`). The exact same browser-descendant and profile-dir assertions the healthy case uses now correctly FAIL to hold when cleanup is genuinely disabled. | `src/vault-cli/commands/capture.ts`, `test/vault-capture-e2e.test.ts` (X-rows) |

Row-status honesty: **R12/R13's database-identity claim and X03b's negative
control were both weaker than represented prior to this packet** (see the
row entries above for what actually changed). See "Verification run log" for
the exact commands and the two full-suite runs required for this packet.

## Packet 6: Codex frontier review round 4 fixes (2026-09-13)

Codex round 4 (label `task6-qualification-r4`) on `8a6b85f...a50fc4e` returned
issues-found with 2 major findings. All three round-3 findings were confirmed
closed, both test-only hooks confirmed inert in production, and the
`storeVersion` export confirmed fine. Both new findings are addressed on this
branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| MAJOR 1 | The shared contract's MOC check counted substring occurrences of the extensionless note path, so a MOC containing only plain text mentioning the path (or a longer sibling path sharing the same prefix) qualified with zero navigable links. `countMocLinksTo` now mirrors `hasLinkTo`/`stripCodeFences` in `src/vault/VaultPublisher.ts` exactly -- the fork's own publisher-emitted `[[target]]`/`[[target\|alias]]` syntax -- and counts real link matches. The suite's own dead-code duplicate matcher (`readMoc`/`countOccurrences`/`mocLinkTarget`/`frontmatterField` in `test/vault-capture-e2e.test.ts`, unused once every row routed through `qualifyNote`) was removed rather than left to rot. | `scripts/lib/qualification-contract.mjs`, `.test.ts` (5 new cases); `test/vault-capture-e2e.test.ts` |
| MAJOR 2 | Only `--vault` went through the live-vault guard in `live-check-vault.mjs`; a supplied `--state-dir` inside the live vault (or a symlink alias into it) was created and its `config.yaml` overwritten immediately, before any capture ran. The state directory and config path now go through the same containment check as `--vault`, and an existing `config.yaml` is never silently overwritten (requires `--overwrite-config`), all before any write. The validation logic was extracted into an exported, side-effect-free `resolveGuardedState` so it could be unit-tested against a fake live vault without ever touching the real one; the script's CLI body now runs only when the file is the program's entry point (`isMainModule`), so importing that function for testing does not trigger argv parsing or an exit. | `scripts/live-check-vault.mjs`, new `scripts/live-check-vault.test.ts` (8 cases) |

See "Verification run log" for the exact commands and the two full-suite runs
required for this packet.

## Packet 7: Codex frontier review round 5 fixes (2026-09-13)

Codex round 5 (label `task6-qualification-r5`) on `8a6b85f...89908ce` returned
issues-found with 2 major findings, both adjudicated valid and narrow ("last
fix round before a scoped routine-tier re-review"). Both are addressed on
this branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| MAJOR 1 | `live-check-vault.mjs`'s guard resolved a not-yet-created path's *nearest existing ancestor* to check containment, but a DANGLING `config.yaml` symlink (or a dangling symlinked state dir) whose target does not exist makes `realpathSync` throw for the symlink itself; the code fell back to treating the symlink's own external parent as canonical, so containment silently passed while `writeFileSync`/`mkdirSync` would still follow the symlink into the live vault. Rather than attempt to resolve a target that may not exist, `scripts/lib/vault-guard.mjs` gained `isSymlinkPath`/`assertNotSymlink`, which `lstat`s the path itself (never following it) and rejects any symlinked state dir or `config.yaml` outright, before the containment check runs. | `scripts/lib/vault-guard.mjs` (new `isSymlinkPath`/`assertNotSymlink`, 5 new unit tests), `scripts/live-check-vault.mjs` (`resolveGuardedState` calls both before `assertNotLiveVault`), `scripts/live-check-vault.test.ts` (2 new cases: external `config.yaml` symlinked to an EXISTING live-vault file, and to a NONEXISTENT one — both rejected before any write, live-vault bytes/state untouched) |
| MAJOR 2 | The round-4 `stripCodeFences` (in both `scripts/lib/qualification-contract.mjs` and its copy `hasLinkTo`/`stripCodeFences` in `src/vault/VaultPublisher.ts`) only recognized backtick fences: a target mentioned only inside a `~~~`-fenced block or an inline code span (`` `[[target]]` ``) still counted as a real link. In the publisher this was a genuine product bug, not just a tooling gap — `hasLinkTo` returning true for a code-example mention made `linkFromIndex` believe the note was already linked and skip adding the real link, leaving a published note with zero navigable MOC links. Extracted the ONE shared implementation `src/vault/markdownLinks.mjs` (`stripCodeAndInlineSpans`/`countLinksTo`/`hasLinkTo`), which strips both fence styles (respecting CommonMark's fence-closing rule: the same character, repeated at least as many times as the opener) and inline code spans, before counting/detecting links. Both `VaultPublisher.ts` and `qualification-contract.mjs` now import this one module instead of each carrying its own copy. | `src/vault/markdownLinks.mjs` (new shared module), `src/vault/VaultPublisher.ts` (`hasLinkTo`/`stripCodeFences` removed, imports the shared module), `src/vault/VaultPublisher.test.ts` (2 new regressions: tilde-fenced and inline-code-span mentions do not suppress the real link; `linksTo` test helper switched to the shared stripper so it doesn't itself misclassify a tilde/inline mention), `scripts/lib/qualification-contract.mjs` (`countMocLinksTo` now delegates to the shared module), `scripts/lib/qualification-contract.test.ts` (4 new cases: backtick-fence-only, tilde-fence-only, inline-code-only rejections, plus a real-link-alongside-a-code-example acceptance proving exactly one match) |

Both fixes were verified test-first: a standalone script reproduced the old
backtick-only `stripCodeFences` returning a false-positive link count of 1
for both the tilde-fence and inline-code fixtures before the shared module
existed, and the new "NONEXISTENT symlink target" `live-check-vault.test.ts`
case failed against the pre-fix `resolveGuardedState` (`toThrow` received
`undefined`) before `assertNotSymlink` was added. See "Verification run log"
for the exact commands and the two full-suite runs required for this packet.

## Packet 8: Codex scoped re-review round 6 fixes (2026-09-13)

A scoped Codex re-review (label `task6-qualification-r6-scoped`) of the
packet-7 diff (`89908ce...2a57d39`) returned issues-found: the round-5
symlink guard and the `.mjs` import shape were confirmed closed/fine, but 2
major, 2 minor and 1 nit findings remained, all on the round-6/packet-7 diff
itself. All five are addressed on this branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| MAJOR 1+2 | `src/vault/markdownLinks.mjs`'s hand-rolled line-based fence/inline-span stripper was not CommonMark-correct: it missed fences indented 1-3 spaces, accepted a closing fence line with trailing non-whitespace text as if it closed the fence, accepted a backtick opener whose info string itself contained backticks (not a valid fence per CommonMark), and its same-line single-backtick-pair inline-span regex mishandled multi-backtick spans, multiline spans, and mismatched delimiter runs. Rather than extend the hand-rolled parser further, it was replaced entirely with the `remark`/`remark-parse`/`unified` toolchain already in the dependency tree (also used by `src/splitter/SemanticMarkdownSplitter.ts`; no new dependency): parses to an mdast tree, walks it skipping `code`/`inlineCode` nodes, and counts wikilinks in the remaining text. Verified by probe that remark (no wikilink plugin) treats `[[target]]`/`[[target\|alias]]` as ordinary literal text, and that a wikilink split across text nodes by an emphasis node (e.g. `[[collection/*Fixture*]]`) needs its per-paragraph text reassembled before matching -- both documented in the module. | `src/vault/markdownLinks.mjs` (rewritten), new `src/vault/markdownLinks.test.ts` (13 tests: plain link, aliased link, the plain-text probe, emphasis-split reassembly, all 8 named CommonMark edge cases, duplicate rejection), `src/vault/VaultPublisher.test.ts` (7 new end-to-end regressions covering 7 of the 8 constructs; the 4+-space-indented-code-block construct is deliberately not repeated as a full publish/insert round-trip there -- see the comment explaining why that specific construct's indentation semantics change once a list item precedes it, a correct CommonMark reparse, not a counting defect), `scripts/lib/qualification-contract.test.ts` (8 new cases covering all 8 constructs) |
| MINOR 1 | `scripts/live-check-vault.test.ts` only had `resolveGuardedState` call-site fixtures for a symlink *alias directory* (pointing at the live vault root) and an external *config.yaml* symlinked into the live vault; it lacked a case for `stateDirArg` itself being a dangling symlink into a nonexistent live-vault path. | `scripts/live-check-vault.test.ts` (new case: dangling `stateDirArg` symlink into a nonexistent live-vault target, asserting rejection and that nothing is created at the dangling target or inside the live vault) |
| MINOR 2 | `scripts/lib/vault-guard.mjs`'s round-5 edit left `isInsideLiveVault`'s original TSDoc block orphaned directly above the newly-inserted `isSymlinkPath`, and `isSymlinkPath` had no docblock of its own. | `scripts/lib/vault-guard.mjs` (TSDoc restored immediately above `isInsideLiveVault`; `isSymlinkPath` given its own docblock) |
| NIT | `countLinksTo(markdown, target)` and `assertNotSymlink(candidatePath, label)` used same-typed positional parameters, against the repo convention of a named options object for functions with more than one parameter of the same type. | `src/vault/markdownLinks.mjs` (`countLinksTo`/`hasLinkTo` now take `{ markdown, target }`), `scripts/lib/vault-guard.mjs` (`assertNotSymlink` now takes `{ candidatePath, label }`), all call sites updated: `src/vault/VaultPublisher.ts`, `scripts/lib/qualification-contract.mjs`, `scripts/live-check-vault.mjs`, `scripts/lib/vault-guard.test.ts` |

Both majors were verified test-first: a standalone script running the
pre-fix hand-rolled `stripCodeAndInlineSpans`/`countLinksTo` against 5 of the
8 constructs showed it returning the wrong count (2 instead of 1, or 0
instead of 1) for every one of them; the same script against the new
`remark`-based implementation returned exactly 1 for all 8 constructs. See
"Verification run log" for the exact commands and the two full-suite runs
required for this packet.

## Packet 9: Codex scoped re-review round 7 fixes (2026-09-13)

Two controller/reviewer findings on the packet-8 diff, addressed together:

1. A controller finding (fix-now, small): `src/vault/markdownLinks.mjs`
   imported `unist-util-visit`, which is not declared in `package.json` --
   only a transitive dependency of `remark-parse`. Replaced with a small
   local recursive `walk(node, visitor)` over `node.children`, keeping the
   `code`/`inlineCode` skip semantics identical. No `package.json`/
   `package-lock.json` change.
2. A scoped Codex re-review (label `task6-qualification-r7-scoped`) of
   `2a57d39...3f7b1dd` returned issues-found: 2 major, 1 minor, all in
   `src/vault/markdownLinks.mjs`. Addressed on this branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| MAJOR 1 | `collectVisibleText` returned `""` for a skipped node (`inlineCode`, `break`, `image`) and simply concatenated the surrounding siblings, so a wikilink fragmented by one of those (e.g. `[[collection/` + `` `x` `` + `Fixture]]`) was silently reassembled into a false match -- the exact bug this module exists to prevent, moved up one level. Every node whose content must never be concatenated with its neighbours (`code`, `inlineCode`, `break`, `image`, `imageReference`, `html`, `footnote`, `footnoteReference`) now contributes a Unicode Private Use Area boundary character (`U+E000`, never a NUL byte) instead of an empty string, so a wikilink can never span across one. | `src/vault/markdownLinks.test.ts` (4 new cases: inline-code-split, hard-break-split, image-split, inline-HTML-split, all must count 0), `src/vault/VaultPublisher.test.ts` (3 new end-to-end regressions: the publisher still adds the real link when the only pre-existing mention is fragmented), `scripts/lib/qualification-contract.test.ts` (3 new rejection cases) |
| MAJOR 2 | Every `countLinksTo`/`hasLinkTo` call reparsed the whole MOC; measured ~508ms at 10k entries, ~1.4s at 20k, ~13.8s at 50k, and `VaultPublisher` calls it once per publication, trending quadratic on bulk capture. Added a substring fast path (`markdown.includes("[[" + target)`) that returns 0 without parsing when the literal target text is absent, plus a single-entry parse cache keyed by exact markdown-string identity. **Correctness note beyond the finding's literal proposal:** the naive fast path as first implemented broke MAJOR 1's own emphasis/strong/link reassembly requirement (a target split by `*`/`_`/a real link can be raw-byte-absent yet parse-present) -- fixed by only trusting the substring-absence shortcut when the document also contains none of `*`, `_`, `` ]( ``, `` ][ `` (the only "transparent" constructs that remove characters on parse); a hard break/inline code/image/HTML can only ever ADD an unmatchable boundary character, so those never risk a false negative and don't need to gate the fast path. This is a link-check cost, not the plan's protected full-collection scan. | `src/vault/markdownLinks.test.ts` (benchmark-style test: 20k-entry flat-list MOC, absent case < 50ms measured ~0.1-0.4ms, present-cold case < 3s measured ~1.4s, present-cached case < 500ms measured ~4-13ms) |
| MINOR | Root-level (block) `html` nodes were never scanned (not `paragraph`/`heading`/`tableCell`), so `<div>\n[[target]]\n</div>` counted 0. Read `src/vault/render.ts`: `renderCollectionIndex` never emits block HTML -- the publisher's own MOCs are always a heading plus a flat Markdown bullet list -- so this is now a documented deliberate scope decision: ALL `html` nodes (block or inline) are opaque, exactly like `code`/`inlineCode`. Added dedicated committed tests for the previously-probed-only structural cases: inline HTML, headings, list items, blockquotes, a pipe-table line (remark-parse core has no GFM table support, so it is scanned as plain paragraph text), strong/link reassembly, and cross-block non-merging. | `src/vault/markdownLinks.test.ts` (1 block-HTML fixture + 7 structural-coverage fixtures), `scripts/lib/qualification-contract.test.ts` (1 new rejection case for the block-HTML scope decision) |

Both majors were verified test-first: the failing assertions surfaced
immediately when the new fixtures were added against the pre-fix module
(reassembly fixtures failed with "expected 1, got 0" before the boundary
sentinel; the MAJOR 2 fast path's own regression against MAJOR 1 was caught
the same way and fixed before committing). See "Verification run log" for
the exact commands; this round's coordinator guidance was "full suite once
is enough for this change unless anything else changes" for the controller
finding, but since the r7-scoped findings changed more, the full suite was
run twice per the standing rule.

## Packet 10: Codex scoped re-review round 8 fixes (2026-09-13, BLOCKER resolved)

A scoped Codex re-review (label `task6-qualification-r8-scoped`) of the
packet-9 diff (`3f7b1dd...fed86b6`) returned a **BLOCKER**: 2 major + 1 minor,
both majors on the exact constructs round 8's own coordinator guidance had
asked for the previous round, so the fix approach changed rather than just
patching the prior fix. Both addressed with a design change, not a patch:

| Finding | Decision and what changed | Evidence |
| --- | --- | --- |
| MAJOR 1 | The raw-substring fast path ignored Markdown escapes (`\-`) and character references (`&amp;`/`&#x26;`) that remark resolves differently from the raw bytes, so `[[collection/Foo\-Bar]]` for target `collection/Foo-Bar` returned 0 unless unrelated markup happened to force the parse path -- the publisher would then insert a duplicate note. **The fast path and its gating regex (`POSSIBLE_FRAGMENTING_MARKUP`) are REMOVED entirely; `countLinksTo`/`hasLinkTo` always parse.** The single-entry parse cache is kept (correctness-preserving: it never changes the result, only whether a repeat call on the exact same string re-parses). The measured full-parse cost is now documented in the module's own top comment and here as an accepted, measured limit: ~508ms at 10k entries, ~1.4s at 20k, ~13.8s at 50k in a single flat-list MOC -- real collection MOCs are orders of magnitude smaller. No fast path, no threshold beyond the loose benchmark ceilings already present (the absent-target ceiling was raised from <50ms to <3000ms, since it is no longer parse-free). | `src/vault/markdownLinks.test.ts` (5 new cases: escaped hyphen/underscore/asterisk, named and numeric character references; performance test's absent-case ceiling widened and its own comment corrected), `src/vault/VaultPublisher.test.ts` (2 new end-to-end regressions: escaped-hyphen and character-reference links recognized as already-linked, no duplicate inserted), `scripts/lib/qualification-contract.test.ts` (2 new acceptance cases) |
| MAJOR 2 | `U+E000` (the boundary sentinel introduced in round 6's third pass) is valid filename/source text -- nothing stops a real note title (user-controlled free text) from containing it, colliding with the sentinel and letting a fragmented pseudo-link falsely match a target that happens to contain that exact code point (confirmed by a standalone reproduction: the sentinel-based implementation returned 1, not 0, for this construct before the fix). **Boundaries are no longer serialized as a character at all.** `collectVisibleText` was replaced by `collectVisibleTextRuns`/`textRunsOf`, which appends into an ARRAY of independent text runs (mutated in place), starting a brand-new run at every opaque node and joining only transparent children (emphasis, strong, link, ...) into the current run; wikilinks are counted per run. No sentinel, no possible collision. | `src/vault/markdownLinks.test.ts` (2 new cases: a real, unfragmented link to a U+E000-containing target counts exactly once; a pseudo-link fragmented by an opaque node does not collide with such a target), `src/vault/VaultPublisher.test.ts` (1 new end-to-end regression), `scripts/lib/qualification-contract.test.ts` (1 new acceptance case) |
| MINOR | `markdownLinks.test.ts` lacked a dedicated `imageReference` (`![alt][ref]`) fragmentation fixture (distinct mdast node type from a direct image) and a cache-sequence regression proving the single-entry cache never serves a stale result across a modify-then-revert sequence. | `src/vault/markdownLinks.test.ts` (1 new imageReference fixture; 1 new cache-sequence test: original → one-character-modified → original → a genuinely-different count → back to original, asserting the count at every step) |

Both majors were verified test-first, including a direct reproduction of the
U+E000 collision against the pre-fix sentinel-character implementation
(returned 1, confirmed the bug, before switching to the array-of-runs
design). See "Verification run log" for the exact commands and the two
full-suite runs required for this packet.

## Packet 11: Codex scoped re-review round 9 fixes (2026-09-13)

A scoped Codex re-review (label `task6-qualification-r9-scoped`) of the
packet-10 diff (`fed86b6...814dad7`) confirmed the round-8 core fix sound (no
raw shortcut, structural runs, cache, exact target prefix, benchmark) and
returned 1 major + 2 minor findings, all addressed on this branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| MAJOR | The wikilink regex's alias group (`(\|[^\]]*)?`, predates this branch) stops at the FIRST `]`. An alias written with a backslash-escaped bracket (`Foo\]Bar`, which remark resolves to a literal `]`) or an HTML character reference (`&#93;`, also resolves to `]`) made the whole `[[target\|alias]]` pattern fail to find its real `]]` closer, returning 0 -- the publisher would then insert a duplicate note, or the contract would wrongly reject an already-qualified note. Fixed by replacing the alias group with `(?:(?!\]\]).)*` (an "s"-flag lazy scan that matches any character, including a lone `]`, and stops only right before the real closing `]]`); the target portion is untouched -- still an exact, escaped match. Confirmed no regression across the existing suite (duplicate-link rejection, malformed-syntax rejection, and the longer-sibling-prefix rejection all still pass unchanged). | `src/vault/markdownLinks.test.ts` (3 new cases: escaped-bracket alias, character-referenced-bracket alias, and a case proving the alias's literal `]` does not swallow trailing document text past the real `]]`), `src/vault/VaultPublisher.test.ts` (2 new end-to-end duplicate-prevention regressions), `scripts/lib/qualification-contract.test.ts` (2 new acceptance cases) |
| MINOR 1 | The `imageReference` fragmentation regression added at the unit level in packet 10 lacked matching coverage at the publisher and contract levels. | `src/vault/VaultPublisher.test.ts` (1 new end-to-end regression: a pseudo-link fragmented by an image reference is not a live link, and the publisher still adds the real one), `scripts/lib/qualification-contract.test.ts` (1 new rejection case) |
| MINOR 2 | `docs/migration-qualification.md`'s packet-10 verification-run-log entry over-counted the new/changed `markdownLinks.test.ts` tests (claimed 12; the diff added 9 new cases plus modified the existing benchmark test in place, not 12 new tests), and `markdownLinks.test.ts:165`'s `const PUA = ...` line held a literal `U+E000` glyph typed through an earlier edit-tool call rather than an explicit escape sequence, contradicting the fork's own "no literal private-use glyphs in source" discipline established across this whole review chain. Corrected the packet-10 test-count line directly (see "Verification run log"), and converted the literal glyph to an explicit `\uE000` JS/TS escape sequence (verified byte-for-byte: the file had exactly one literal `U+E000` character before this fix, zero after, and it was never a NUL byte at any point). | `src/vault/markdownLinks.test.ts:165` (now `const PUA = "\uE000";`); packet-10's own verification-run-log entry, corrected in place |

The MAJOR finding was verified test-first: the escaped-bracket and
character-referenced-bracket alias fixtures both returned 0 against the
pre-fix regex (confirmed via a standalone script) before the alias-group
fix landed. See "Verification run log" for the exact commands and the two
full-suite runs required for this packet.

## Packet 12: Codex scoped re-review round 10 fixes (2026-09-13)

A scoped Codex re-review (label `task6-qualification-r10-scoped`) of the
packet-11 diff (`814dad7...c765cd1`) confirmed valid aliases, adjacency,
`]]]`, duplicate/prefix rejection, imageReference coverage, report counts,
and PUA escaping all sound, and returned 1 major finding, addressed on this
branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| MAJOR | The round-9 alias scan `(?:(?!\]\]).)*` stops only at `]]`, never at a nested `[[`, so an unterminated link's alias scan could cross a NESTED `[[` and "borrow" a LATER link's closing `]]`: `[[a\|unterminated ] text [[b]]` wrongly matched from `a`'s opener all the way to `b`'s closer, counting `a` as already linked (a false "already linked" result the publisher would trust, suppressing the real link `a` still needs) while also correctly counting `b`. Repeated malformed prefixes were also superlinear (measured: ~257ms at 28KB, ~1.87s at 112KB with the round-9 regex). Fixed by replacing the regex-based alias matching ENTIRELY with an explicit linear two-pointer scanner (`countWikilinksInRun`): for each `[[`, find the next `]]`; if a nested `[[` occurs first, the outer `[[` is unterminated/malformed and is skipped (retried from the nested `[[`) rather than ever borrowing a later closer. Target and alias are both compared as plain strings (no regex, no escaping needed). **Root-caused the reported performance regression while building this fix**: measuring `processor.parse()` alone (before any of this module's own counting logic runs) on the same repeated-malformed-prefix input reproduces the identical superlinear growth (~1.2s at 112KB, ~4.9s at 224KB) -- essentially all of the wall-clock cost is `remark-parse`'s/`micromark`'s own CommonMark link/bracket-resolution algorithm for documents with many unmatched `[[` sequences, not this module's counting logic (verified linear and sub-5ms even at 224KB, isolated from parsing). A real, publisher-authored MOC is always a flat list of individually-balanced `- [[target\|alias]]` lines and can never reach this pathological shape (a 112KB WELL-FORMED flat list parses in ~110ms); only a hand-corrupted or deliberately hostile MOC could. This is a genuine upstream dependency-level limitation, not something fixable in this module without either abandoning full CommonMark parsing (rejected for correctness reasons in round 8's BLOCKER) or upgrading `remark-parse`/`micromark`, which is out of this module's scope -- flagged here for the coordinator/controller to decide whether a dedicated dependency-upgrade investigation is warranted. | `src/vault/markdownLinks.mjs` (`countWikilinksInRun`, replacing the regex entirely), `src/vault/markdownLinks.test.ts` (2 new cases: malformed-unterminated-link-before-valid-link counting 0/1 correctly, and a performance regression proving this module's OWN scan step -- isolated by warming the single-entry parse cache first -- completes well under 200ms even on a 112KB repeated-malformed-prefix document), `src/vault/VaultPublisher.test.ts` (1 new end-to-end regression: the publisher adds the real link for the malformed/unterminated target without duplicating the genuinely well-formed link that follows it), `scripts/lib/qualification-contract.test.ts` (1 new acceptance case) |

The MAJOR finding was verified test-first: `countLinksTo({ markdown: "[[a|unterminated ] text [[b]]\n", target: "a" })` returned `1` (bug) against the pre-fix regex, and the same repeated-malformed-prefix content measured ~1.7-1.8s end-to-end before this fix (dominated by parse, as established above). See "Verification run log" for the exact commands and the two full-suite runs required for this packet.

## Packet 13: Codex scoped re-review round 11 fixes (2026-09-13)

A scoped Codex re-review (label `task6-qualification-r11-scoped`) of the
packet-12 diff (`c765cd1...408acdd`) confirmed the supported wikilink syntax
correct, the `remark-parse`/`micromark` attribution for the earlier
performance finding sound (matching the reviewer's own parse-only timings),
and that Obsidian itself documents `|` and nested `[[` as invalid inside a
wikilink target -- so rejecting them is safe for publisher-authored MOCs.
Returned 1 BLOCKER + 1 minor, both addressed on this branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| BLOCKER | Round 10's `countWikilinksInRun` was not actually linear: `open`/`close`/`nextOpen` were each found with a fresh `indexOf` call from the current position on every iteration, so for `"[[".repeat(n) + "valid]]"` every one of the `n` nested openers re-scanned forward toward the SAME distant closer -- quadratic (measured on round 10: ~4.8ms at 32KB, ~68ms at 128KB, ~273ms at 256KB). The round-10 benchmark never caught this because its input (`"[[a\|x ] "` repeated) has no `]]` anywhere, so that scanner's first iteration exited immediately without ever reaching the nested-opener-replacement branch this new shape exercises. Replaced with a genuinely single-pass scan: one index advances monotonically (never backward, never re-searching from an earlier position), tracking at most one "current opener" position; a `[[` seen while an opener is open REPLACES it (the abandoned opener is the malformed case); a `]]` seen while an opener is open evaluates the span and clears the opener; a `]]` with no opener open is inert. Verified: sub-1ms at 256KB for the exact shape that broke round 10 (down from ~273ms). | `src/vault/markdownLinks.mjs` (`countWikilinksInRun` rewritten as a true single pass), `src/vault/markdownLinks.test.ts` (the round-10 benchmark replaced with the reviewer's exact prescription: repeated nested openers ending in one valid link, parse cache warmed, asserts the final link is still counted, and asserts 256KB costs no more than ~3x the 128KB cost so a quadratic regression fails) |
| MINOR | Four boundary shapes exercised only ad hoc while designing the scanner across rounds 9-11 lacked committed fixtures: adjacent links with no separator, an empty alias, a nested link with a trailing extra closer, and a real link followed by one stray extra `]`. All four already behaved correctly (confirmed, not new bugs) -- this closes the coverage gap. | `src/vault/markdownLinks.test.ts` (a new table-driven `it.each` block covering all four shapes, with the nested-trailing-closer case's fixture comment explaining exactly what happens to the leftover `]]`: it is inert once the inner link closes, since no opener is open when the scanner reaches it) |

The BLOCKER was verified test-first: `bench("[[".repeat(64000) + "valid]]")`
measured ~68ms against the pre-fix round-10 scanner and ~0.25ms against the
new single-pass scanner in the same process, at the same input size. See
"Verification run log" for the exact commands and the two full-suite runs
required for this packet.

## Packet 14: Codex scoped re-review round 12 fixes (2026-09-13)

A scoped Codex re-review (label `task6-qualification-r12-scoped`) of the
packet-13 diff (`408acdd...28e90df`) confirmed the single-pass scanner
correct via an exhaustive equivalence probe over 14,648,436 input/target
combinations (no mismatch) and the fixture matrix complete. Returned 2 minor
findings, both about test-harness robustness rather than the scanner logic
itself, addressed on this branch:

| Finding | What changed | Evidence |
| --- | --- | --- |
| MINOR 1 | The scaling assertion `Math.max(at128k.elapsedMs * 3, 30)` degenerated to a fixed 30ms ceiling because the scan itself is sub-millisecond -- a much slower quadratic regression (e.g. 2ms at 128KB, 8ms at 256KB) would still false-pass against a 30ms floor, while a single descheduled sample could just as easily false-fail. Fixed by repeating the cached scan until the aggregate clearly rises above timer noise (or a 50-iteration cap) and taking the MINIMUM per-iteration time as the statistic: the minimum is never inflated by a GC pause or a descheduled tick, but a genuine algorithmic slowdown still raises it on every iteration. The ratio assertion (256KB ≤ 3x 128KB) now runs on that robust statistic with no artificial floor; the absolute 200ms cap per size is kept. | `src/vault/markdownLinks.test.ts` (`timeScanRobust` replacing the single-sample `timeScan`); stability-checked with 5 consecutive standalone runs, all passing |
| MINOR 2 | The round-13 widened 2000ms cached-call ceiling no longer detects a lost or bypassed single-entry parse cache, since a genuinely COLD parse (~1.3-1.4s nominal) already fits comfortably under that ceiling -- a silent cache regression would still pass. Fixed by recording the immediately-preceding cold-present duration in the same test and requiring the cached call to be materially faster by a generous relative factor (cached < cold / 10), using the minimum of 5 repeated cached samples so scheduler noise on any one sample can't cause a false failure; the absolute 2000ms ceiling is kept as a secondary check. | `src/vault/markdownLinks.test.ts` (the cached-call section of the large-flat-list-MOC benchmark); stability-checked with 3 consecutive standalone runs, all passing |

Both fixes are test-harness hardening only -- no change to `markdownLinks.mjs`
itself, consistent with the reviewer's confirmation that the scanner logic is
already correct. See "Verification run log" for the exact commands and the
two full-suite runs required for this packet.

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

## Packet 15: F06/F07/D03 resolution (2026-09-14)

Systematic-debugging session on 2026-09-14 (plan:
`docs/plans/2026-09-14-task6-f06-f07-d03-fixes.md`). Root causes, in the
rows above: F06 — no asset step and, until ai-stack #638, no sanctioned
binary write; F07 — the fixture had no ruling lines and xberg only detects
ruled grids (fixture defect, not a pipeline defect; borderless text stays a
recorded converter limit); D03 — upstream `loadConfig()` auto-writes the
default path and the vault commands passed no options.

Changes:

- `src/utils/config.ts` (upstream, recorded in `docs/fork-boundary.md`):
  `LoadConfigOptions.readOnly`; `search`/`capture`/`reindex` pass it.
- `src/vault/ObsidianCli.ts`: `attachFile(localPath, vaultPath)` wrapping
  `obsidian-cli attach ... --force`; `attach` classified as a write for the
  M-row subprocess counts.
- `src/vault/localAssets.ts` (new): `localizeLocalAssets(input, folder)` —
  parser-based (`remark-parse` mdast `image`/`definition` nodes, never
  regex) rewrite of `file://`-relative Markdown image embeds to
  `_attachments/<collection folder>/<source_id[0:12]>/<path relative to the
  source>` (8-hex hash of the relative path when it climbs above the source)
  plus the asset manifest; remote/absolute/`data:`/`.md`/missing/non-file
  targets and anything inside code are left byte-identical.
- `src/vault/VaultPublisher.ts`: localizes before rendering (so digests and
  ownership describe the linked note), attaches every asset before the note
  write on the create, replace and unchanged paths, emits
  `capture.asset_attached` JSONL events, and reports `Publication.attachments`.
- `test/fixtures/vault-capture/generate-table-pdf.mjs` + `table.pdf`: ruled
  table; new sha256 in row F07.
- Tests: `src/utils/config.test.ts` (+3), `src/vault/ObsidianCli.test.ts`
  (+5), `src/vault/localAssets.test.ts` (new, 13), `src/vault/VaultPublisher.test.ts`
  (+6, fake CLI gained `attach`), `test/vault-capture-e2e.test.ts` (F06, F07
  and the D03 describe now assert the fixed behaviour).

Review: Codex `gpt-5.6-sol`/medium, integration class, author
`claude-fable-5-1` (`review-run` label `task6-row-fixes-r1`) confirmed F07 as
a legitimate ruled-table fixture and D03's read-only paths, and raised four
F06 findings — regex rewriting inside code / missing parser-valid image
forms, same-basename collisions, no re-attach on the unchanged path, and an
over-claimed fence assertion — all fixed in the second commit of this
packet's PR and re-reviewed scoped (`task6-row-fixes-r2`), which confirmed
them closed and found three parser-rewrite edge cases (unmatched
parentheses in generated destinations, definition labels rebuilt without
their escapes, duplicate definitions rewritten beyond the first) — fixed in
the third commit and re-reviewed scoped (`task6-row-fixes-r3`).

Evidence totals are recorded in the project MOC log line for this packet's
PR, alongside the reviewer record.
