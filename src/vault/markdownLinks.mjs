/**
 * The one shared Markdown link-detection implementation used by both the
 * publisher (`VaultPublisher.ts`) and the qualification tooling
 * (`scripts/lib/qualification-contract.mjs`) — a single implementation, not
 * two independently-drifting copies (MAJOR 2, 2026-09-13 Codex frontier
 * review round 5).
 *
 * Round 5's hand-rolled line-based fence/inline-span stripper was not
 * CommonMark-correct (MAJOR 1+2, 2026-09-13 Codex frontier review round 6,
 * scoped): it missed fences indented 1-3 spaces, accepted a closing fence
 * line with trailing non-whitespace as if it closed the fence, accepted a
 * backtick opener whose info string itself contained backticks (which
 * CommonMark says is NOT a valid fence), and its same-line
 * single-backtick-pair inline-span regex mishandled multi-backtick and
 * multiline spans and mismatched delimiter runs. Rather than keep extending
 * a hand-rolled parser to chase each new CommonMark edge case, this parses
 * the Markdown with the `remark`/`unified` toolchain already in the
 * dependency tree (see `package.json`'s `remark`/`remark-parse`/`unified`
 * entries, also used by `src/splitter/SemanticMarkdownSplitter.ts`) to an
 * mdast tree, and counts wikilink syntax only in the parts of that tree
 * that are real prose -- never inside a `code` (fenced or indented) or
 * `inlineCode` node.
 *
 * Verified by probe (see `src/vault/markdownLinks.test.ts`): remark's core
 * `remark-parse` (no wikilink plugin installed) treats `[[target]]` /
 * `[[target|alias]]` as ordinary literal text -- it is not special syntax
 * to remark, so it always survives into a `text` node's `value` verbatim,
 * which is exactly what this module's regex matches against.
 *
 * Round 6 scoped re-review (2026-09-13) found two further defects, and a
 * second scoped re-review the same day found two more in the first round's
 * own fixes -- both since corrected here (see MAJOR 1 and MAJOR 2 below).
 *
 * MAJOR 1 (dropped after two revisions, 2026-09-13 Codex frontier review
 * round 6, THIRD pass): the module briefly had a raw-substring fast path
 * (`markdown.includes("[[" + target)`) to skip parsing when the target text
 * was provably absent, gated by a regex meant to detect when that shortcut
 * could be unsound. That gate still missed real cases: `\-`-style Markdown
 * escapes and `&amp;`-style character references are both resolved by
 * remark (an escaped `\-` becomes a literal `-`, `&amp;` becomes `&`)
 * without matching the gate's trigger characters, so `[[collection/Foo\-Bar]]`
 * for target `collection/Foo-Bar` raw-substring-missed and fast-pathed to 0
 * even though a real parse finds the link -- exactly the kind of duplicate-
 * insertion bug this module exists to prevent. There is no cheap,
 * enumerable set of "safe" trigger characters here: any construct remark
 * resolves differently from its raw bytes is a potential miss. The fast
 * path and its gate are REMOVED entirely; `countLinksTo`/`hasLinkTo` always
 * parse. The single-entry parse cache (below) is kept, since re-parsing the
 * exact same markdown string is pure waste, not a correctness tradeoff.
 * Measured full-parse cost (accepted, documented limit, not a fast-path
 * substitute): ~508ms at 10k entries, ~1.4s at 20k, ~13.8s at 50k in a
 * single flat-list MOC -- real collection MOCs are orders of magnitude
 * smaller than this synthetic benchmark (see the benchmark-style test in
 * `markdownLinks.test.ts`), and this is a per-call link-check cost, not the
 * plan's protected full-collection scan.
 *
 * MAJOR 2 (2026-09-13 Codex frontier review round 6, THIRD pass): the
 * previous fix used a Unicode Private Use Area character (`U+E000`) as an
 * in-band "boundary sentinel" to keep opaque-node content from
 * concatenating with its neighbours. That character is still ordinary,
 * matchable text -- nothing stops a real vault path (a note title, which is
 * user-controlled free text) from containing it, which could either
 * collide with the sentinel or be split by it. Boundaries are no longer
 * serialized as a character at all: `collectVisibleTextRuns` returns an
 * ARRAY of text runs, starting a new run at every opaque node and joining
 * only transparent children into the current run. Wikilinks are counted
 * per run, so no separator character of any kind is ever required or at
 * risk of colliding with real content.
 *
 * MINOR: root-level (block) `html` nodes were never scanned at all (they are
 * not `paragraph`/`heading`/`tableCell`), so a hand-edited MOC using raw
 * block HTML (e.g. `<div>\n[[collection/Fixture]]\n</div>`) would never be
 * recognized as already-linked. `renderCollectionIndex` in
 * `src/vault/render.ts` never emits block HTML -- the publisher's own MOCs
 * are always a heading plus a flat Markdown bullet list -- so this module
 * deliberately treats ALL `html` nodes (block or inline) as opaque, exactly
 * like `code`/`inlineCode`: a link mentioned only inside raw HTML (of either
 * shape) does not count as a real link, the same way one mentioned only
 * inside a code fence does not. This is a deliberate scope decision, not an
 * oversight -- see the fixture for it in `markdownLinks.test.ts`.
 */

import remarkParse from "remark-parse";
import { unified } from "unified";

/** One parser instance, reused across calls (parsing is the expensive part). */
const processor = unified().use(remarkParse);

/**
 * Calls `visitor` on every node in the tree, depth-first, including `tree`
 * itself. A small local replacement for `unist-util-visit`: that package is
 * only a transitive dependency of `remark-parse`, not declared directly in
 * `package.json` (controller finding, 2026-09-13), so relying on it via
 * hoisting is a dependency-hygiene defect -- a future lockfile change could
 * remove it and break this module (and `VaultPublisher.ts`, which imports
 * it) at runtime with no `package.json` diff to explain why.
 *
 * @param {import("mdast").Node} node
 * @param {(node: import("mdast").Node) => void} visitor
 */
function walk(node, visitor) {
  visitor(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visitor);
  }
}

/**
 * mdast node types whose direct (non-code) text content this module treats
 * as one contiguous span for matching -- so a wikilink split across
 * adjacent text nodes by an emphasis, strong or link node (e.g.
 * `[[collection/*Fixture*]]`) is still reassembled and matched as one
 * string, scoped to a single block so unrelated paragraphs can never be
 * concatenated into a false match.
 */
const TEXT_CONTAINER_TYPES = new Set(["paragraph", "heading", "tableCell"]);

/**
 * mdast node types whose own content must never be concatenated with their
 * neighbours: fenced/indented code, inline code, hard line breaks, images
 * (of either form), raw HTML (block or inline -- see the MINOR note in this
 * module's top comment), and footnote references (only reachable with a
 * plugin remark-parse alone never loads, kept for defense in depth). Each
 * one starts a new, independent text run (see `collectVisibleTextRuns`)
 * rather than contributing any character of its own -- not even a sentinel
 * (MAJOR 2, 2026-09-13 Codex frontier review round 6, third pass: an
 * earlier sentinel-character approach could collide with a real vault path
 * containing that exact character).
 */
const BOUNDARY_NODE_TYPES = new Set([
  "code",
  "inlineCode",
  "break",
  "image",
  "imageReference",
  "html",
  "footnote",
  "footnoteReference",
]);

/**
 * Appends the visible text of one phrasing-content node into `runs` (an
 * array of strings, mutated in place). A `text` node appends its literal
 * value onto the current (last) run. A node in `BOUNDARY_NODE_TYPES` starts
 * a brand-new, empty run -- ending the current one -- so its neighbours can
 * never be concatenated across it, without requiring any separator
 * character. Every other node with children (emphasis, strong, delete,
 * link, paragraph, heading, tableCell, listItem, blockquote, ...) is
 * transparent: its children are visited in order into the same run(s),
 * which is exactly what lets a wikilink split by e.g. `*emphasis*` still
 * reassemble within one run.
 *
 * @param {import("mdast").Node} node
 * @param {string[]} runs Mutated in place; always has at least one element.
 */
function collectVisibleTextRuns(node, runs) {
  if (node.type === "text") {
    runs[runs.length - 1] += node.value ?? "";
    return;
  }
  if (BOUNDARY_NODE_TYPES.has(node.type)) {
    runs.push("");
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectVisibleTextRuns(child, runs);
    return;
  }
  // An unknown leaf node type (defensive): never silently disappear into
  // the surrounding run.
  runs.push("");
}

/**
 * Returns the array of independent text runs for one text-container node
 * (see `TEXT_CONTAINER_TYPES`), split at every opaque node it contains.
 *
 * @param {import("mdast").Node} node
 * @returns {string[]}
 */
function textRunsOf(node) {
  const runs = [""];
  collectVisibleTextRuns(node, runs);
  return runs;
}

/** Single-entry parse cache, keyed by exact markdown-string identity. */
let cachedMarkdown;
let cachedTree;

/**
 * Parses `markdown`, reusing the previous result when called again with the
 * literal same string (MAJOR 1, 2026-09-13 Codex frontier review round 6,
 * third pass) -- a plain `===` string comparison is already the
 * length-then-byte-compare a manual hash check would amount to, so no
 * separate hash is needed for a single-entry cache. This is a pure
 * performance optimization: it never changes the result, unlike the
 * removed substring fast path (see this module's top comment).
 *
 * @param {string} markdown
 * @returns {import("mdast").Node}
 */
function parseCached(markdown) {
  if (markdown !== cachedMarkdown) {
    cachedTree = processor.parse(markdown);
    cachedMarkdown = markdown;
  }
  return cachedTree;
}

/**
 * Counts real wikilink references to `target` in `markdown`
 * (`[[target]]`/`[[target|alias]]`), using a real CommonMark parse so
 * fenced code (any indentation, any fence character run length), indented
 * code blocks, inline code spans (any backtick run length, single- or
 * multi-line), hard breaks, images and raw HTML are never mistaken for
 * prose, however they are written, and can never be silently bridged into a
 * false match by concatenation. Always parses -- see this module's top
 * comment for why a raw-substring fast path was tried and removed (Markdown
 * escapes and character references make raw-byte presence/absence
 * unreliable).
 *
 * @param options.markdown The Markdown to search.
 * @param options.target Vault path of the note, without its `.md` extension.
 * @returns {number} The number of distinct `[[target]]`/`[[target|alias]]` matches.
 */
export function countLinksTo({ markdown, target }) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // MAJOR (2026-09-13 Codex frontier review round 9, scoped): the alias
  // group used to be `[^\]]*`, which stops at the FIRST `]`. An alias
  // containing a literal `]` -- written as a backslash escape (`Foo\]Bar`,
  // remark resolves this to a literal `]`) or an HTML character reference
  // (`Foo&#93;Bar`, remark resolves this to `]` too) -- was cut short there,
  // so the regex never found the real `]]` closer and returned 0, which
  // would make the publisher insert a duplicate note. The alias group now
  // matches ANY character, including a lone `]`, and only stops right
  // before the actual closing `]]` (a negative lookahead per character,
  // not a greedy/lazy match against a single excluded character), so a
  // single `]` inside an alias is accepted and only a true `]]` ends the
  // link. The target portion is untouched -- still an exact, escaped match.
  const pattern = new RegExp(`\\[\\[${escaped}(\\|(?:(?!\\]\\]).)*)?\\]\\]`, "gs");

  const tree = parseCached(markdown);
  let count = 0;
  walk(tree, (node) => {
    if (TEXT_CONTAINER_TYPES.has(node.type)) {
      for (const run of textRunsOf(node)) {
        count += (run.match(pattern) ?? []).length;
      }
    }
  });
  return count;
}

/**
 * Reports whether `markdown` links to `target`, with or without an alias.
 *
 * @param options.markdown The Markdown to search.
 * @param options.target Vault path of the note, without its `.md` extension.
 * @returns {boolean}
 */
export function hasLinkTo({ markdown, target }) {
  return countLinksTo({ markdown, target }) > 0;
}
