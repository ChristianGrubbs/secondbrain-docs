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
 * Recursively collects the visible (non-code) text of one phrasing-content
 * node. `code` and `inlineCode` nodes are skipped entirely -- their `value`
 * is never included, so a target mentioned only inside one can never be
 * mistaken for -- or, in the publisher, suppress -- a real link.
 *
 * @param {import("mdast").Node} node
 * @returns {string}
 */
function collectVisibleText(node) {
  if (node.type === "code" || node.type === "inlineCode") return "";
  if (node.type === "text" || node.type === "html") return node.value ?? "";
  if (Array.isArray(node.children)) {
    return node.children.map(collectVisibleText).join("");
  }
  return "";
}

/**
 * Counts real wikilink references to `target` in `markdown`
 * (`[[target]]`/`[[target|alias]]`), using a real CommonMark parse so
 * fenced code (any indentation, any fence character run length), indented
 * code blocks, and inline code spans (any backtick run length, single- or
 * multi-line) are never mistaken for prose, however they are written.
 *
 * @param options.markdown The Markdown to search.
 * @param options.target Vault path of the note, without its `.md` extension.
 * @returns {number} The number of distinct `[[target]]`/`[[target|alias]]` matches.
 */
export function countLinksTo({ markdown, target }) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, "g");

  const tree = processor.parse(markdown);
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
