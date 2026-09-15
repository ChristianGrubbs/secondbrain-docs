DOM settle rev 3 — R4 live proof (2026-09-15)

Release: R4 = ebf66a192ea159960500e6ea60068909ad02ffb2 (squash of PR #13), live checkout on main.
Executable: dist/vault-cli.js sha256 in node-abi.txt (byte-identical to the stage-1 build in
.claude/worktrees/dom-settle-rev3 at c142226, content-identical to the squash).
Wrapper: /Volumes/3M/ai-stack-wt/ai-stack/sb-docs-skill/bin/sb-docs (ai-stack main 182c8ffb copy;
~/ai-stack itself is still lease-blocked at 67bc887f without the wrapper).

Precondition repaired first: the 2026-09-15 step-0 probe session ran real `sb-docs capture`
into a throwaway vault while sharing the live state directory, leaving the ownership record for
source f4b13c9c4e66 pointing at a digest the live note never had (35439b0d...). Three captures
with `--exclude-selector ".emptyListContent, .loadingIndicator"` therefore returned
`conflict` (exit 2) and wrote one conflict candidate to
`00 Inbox/Source Capture Updates/f4b13c9c4e66-6db5fd284dc4.md` (2 residual `Loading` lines:
the page-level `#auraLoadingBox` and one `.assistiveText` spinner label). The live note was
untouched (mtime = original capture). Repair: `sb-docs doctor --adopt "<live note path>"`
re-recorded the live note's digest 4ce09910... as the baseline. Those three conflict triplets
were overwritten by the runs below.

Runs (all through the wrapper, --json):
  capture "https://help.audienceview.com/unlimited/s/knowledge-base?language=en_US" \
    --collection AudienceView \
    --exclude-selector ".emptyListContent, .loadingIndicator, .auraLoadingBox, .assistiveText"

  capture-run1.*  exit 0  publication.status=replaced   index=indexed  digest 89d8a020ec08...
  capture-run2.*  exit 0  publication.status=unchanged  index=indexed  same digest
  capture-run3.*  exit 0  publication.status=unchanged  index=indexed  same digest

Live note after every run (30 Tools-Models/Doc Sets/audienceview/Help Articles & Documentation f4b13c9c4e66.md):
  `No topics yet.` / bare `Loading` lines: 0 (was 16)
  `View All` lines: 16
  article links (my.site.com/AudienceView/s/article): 18
