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
 * Round 6 scoped re-review (2026-09-13) found two further defects in this
 * exact approach:
 *
 * MAJOR 1: `collectVisibleText` returned `""` for a skipped `inlineCode`
 * node and simply concatenated the surrounding siblings with nothing in
 * between, so a wikilink fragmented by an inline code span, a hard break, or
 * an image (e.g. `[[collection/` + `` `x` `` + `Fixture]]`) was silently
 * reassembled into a false match -- the exact bug this module exists to
 * prevent, just moved one level up. Every node whose own text must never be
 * concatenated with its neighbours now contributes a private-use-area
 * boundary character instead of an empty string, so a wikilink can never
 * span across one.
 *
 * MAJOR 2: every `countLinksTo`/`hasLinkTo` call reparsed the whole MOC from
 * scratch, and `VaultPublisher` calls it once per publication -- on a large,
 * flat, ever-growing MOC this trends quadratic with the number of already
 * captured sources (measured: ~508ms at 10k entries, ~1.4s at 20k, ~13.8s at
 * 50k). Two correctness-preserving speedups: (1) a plain substring check
 * (`markdown.includes("[[" + target)`) short-circuits to 0 without parsing
 * at all when the literal target text does not appear anywhere in the raw
 * source -- a real link (aliased or not) always contains that exact
 * substring in the raw bytes, so its absence proves there is no link,
 * without needing to know whether the substring (if present) is inside code
 * or prose; (2) a single-entry cache keyed by exact markdown-string identity
 * avoids reparsing the same MOC string across repeated calls in one process
 * (e.g. the qualification contract's own re-checks). This is a per-call
 * link-check cost, not the plan's protected full-collection scan, so a
 * bounded parse cost for a large-but-finite MOC is an accepted, documented
 * tradeoff (see the benchmark-style test in `markdownLinks.test.ts`), not a
 * violation of that protection.
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
 * A Unicode Private Use Area character, chosen as a boundary sentinel
 * because it can never appear in real Markdown source text (it has no
 * meaning to any Markdown or HTML author, and remark's parser never
 * produces it), so it can never itself become part of a false match, and it
 * always breaks apart the two sides of any node whose real content must
 * never be silently concatenated with its neighbours (MAJOR 1, 2026-09-13
 * Codex frontier review round 6, scoped re-review). NEVER a NUL byte
 * (`\x00`): several tools and hooks in this repo treat a literal NUL in a
 * source or test file as a corruption signal.
 */
const LINK_BOUNDARY = "\uE000";

/**
 * mdast node types whose own content must never be concatenated with their
 * neighbours: fenced/indented code, inline code, hard line breaks, images
 * (of either form), raw HTML (block or inline -- see the MINOR note in this
 * module's top comment), and footnote references (only reachable with a
 * plugin remark-parse alone never loads, kept for defense in depth). Each
 * contributes one `LINK_BOUNDARY` character instead of its own text, or of
 * an empty string.
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
 * Recursively collects the visible text of one phrasing-content node for
 * matching purposes. A `text` node contributes its literal value. A node in
 * `BOUNDARY_NODE_TYPES` contributes one `LINK_BOUNDARY` character -- never
 * its own text, and never an empty string that would let its neighbours
 * merge across it. Every other node with children (emphasis, strong, link,
 * paragraph, heading, tableCell, listItem, blockquote, ...) is transparent:
 * its children's collected text is concatenated directly, which is exactly
 * what lets a wikilink split by e.g. `*emphasis*` still reassemble.
 *
 * @param {import("mdast").Node} node
 * @returns {string}
 */
function collectVisibleText(node) {
  if (node.type === "text") return node.value ?? "";
  if (BOUNDARY_NODE_TYPES.has(node.type)) return LINK_BOUNDARY;
  if (Array.isArray(node.children)) {
    return node.children.map(collectVisibleText).join("");
  }
  return LINK_BOUNDARY;
}

/** Single-entry parse cache, keyed by exact markdown-string identity. */
let cachedMarkdown;
let cachedTree;

/**
 * Parses `markdown`, reusing the previous result when called again with the
 * literal same string (MAJOR 2, 2026-09-13 Codex frontier review round 6,
 * scoped re-review) -- a plain `===` string comparison is already the
 * length-then-byte-compare a manual hash check would amount to, so no
 * separate hash is needed for a single-entry cache.
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
 * Matches raw text that could make a wikilink's literal substring disappear
 * from the raw bytes while a real parse still finds it: emphasis/strong
 * delimiters (`*`/`_`) or the start of a real inline link/image destination
 * (`](`/`][`). Those are the only "transparent" constructs this module
 * reassembles (their own delimiter characters vanish from the collected
 * text, letting two raw-byte-separated runs become one contiguous match) --
 * see `TEXT_CONTAINER_TYPES`'s sibling logic in `collectVisibleText`.
 *
 * A hard break, inline code span, image, or raw HTML can also fragment a
 * wikilink's raw bytes, but those are all `BOUNDARY_NODE_TYPES` -- they can
 * only ever ADD an unmatchable character, never remove one, so they can
 * never turn a substring-absent raw text into a parse-present match; only a
 * transparent node whose own delimiters vanish on parse can do that, which
 * is exactly what this pattern catches (MAJOR 2, 2026-09-13 Codex frontier
 * review round 6, scoped re-review round 2: the initial fast path missed
 * this interaction with round 6's own emphasis/strong/link reassembly
 * requirement).
 */
const POSSIBLE_FRAGMENTING_MARKUP = /[*_]|\]\(|\]\[/;

/**
 * Counts real wikilink references to `target` in `markdown`
 * (`[[target]]`/`[[target|alias]]`), using a real CommonMark parse so
 * fenced code (any indentation, any fence character run length), indented
 * code blocks, inline code spans (any backtick run length, single- or
 * multi-line), hard breaks, images and raw HTML are never mistaken for
 * prose, however they are written, and can never be silently bridged into a
 * false match by concatenation.
 *
 * @param options.markdown The Markdown to search.
 * @param options.target Vault path of the note, without its `.md` extension.
 * @returns {number} The number of distinct `[[target]]`/`[[target|alias]]` matches.
 */
export function countLinksTo({ markdown, target }) {
  // A real, unfragmented link (aliased or not) always contains this exact
  // substring in the raw source, whether or not it is inside code -- so its
  // absence proves there is no link at all, without parsing, UNLESS the
  // document also contains markup that could fragment the raw bytes of an
  // otherwise-matching link while a real parse still reassembles it (MAJOR
  // 2). In that case we always fall through to a real parse.
  if (!POSSIBLE_FRAGMENTING_MARKUP.test(markdown) && !markdown.includes(`[[${target}`)) {
    return 0;
  }

  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, "g");

  const tree = parseCached(markdown);
  let count = 0;
  walk(tree, (node) => {
    if (TEXT_CONTAINER_TYPES.has(node.type)) {
      count += (collectVisibleText(node).match(pattern) ?? []).length;
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
