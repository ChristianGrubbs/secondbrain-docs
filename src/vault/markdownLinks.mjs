/**
 * The one shared Markdown link-detection implementation used by both the
 * publisher (`VaultPublisher.ts`) and the qualification tooling
 * (`scripts/lib/qualification-contract.mjs`) — a single implementation, not
 * two independently-drifting copies (MAJOR 2, 2026-09-13 Codex frontier
 * review round 5).
 *
 * Round 4's `stripCodeFences` only recognized backtick (```) fences and did
 * nothing about tilde (~~~) fences or inline code spans, so a target
 * mentioned only inside a `~~~` block or a `` `[[...]]` `` inline code span
 * was still counted as a real link. That is a real product bug in the
 * publisher too, not just a qualification-tooling gap: `VaultPublisher`'s
 * `hasLinkTo` used the exact same limited stripper, so it could believe a
 * code-example mention was already a live link and skip adding the real
 * one — leaving a published note with zero navigable MOC links.
 *
 * This implementation strips both fence styles (respecting CommonMark's
 * fence-closing rule: a fence only closes on a line starting with the same
 * character, repeated at least as many times as the opener) and inline code
 * spans, before counting wikilink syntax.
 */

/**
 * Removes fenced code blocks (backtick or tilde, 3+ characters, with a
 * closing fence requiring the same character and at least as many repeats)
 * and inline code spans (`` `...` ``) from `markdown`, so neither can be
 * mistaken for live prose/links.
 *
 * @param {string} markdown
 * @returns {string} `markdown` with all code fences and inline code spans removed.
 */
export function stripCodeAndInlineSpans(markdown) {
  const lines = markdown.split("\n");
  const kept = [];
  /** @type {string | null} */
  let fenceChar = null;
  let fenceLen = 0;

  for (const line of lines) {
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);

    if (fenceChar !== null) {
      // Inside a fence: only a line starting with the same character,
      // repeated at least as many times as the opener, closes it.
      if (fenceMatch && fenceMatch[1][0] === fenceChar && fenceMatch[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }

    if (fenceMatch) {
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      continue;
    }

    kept.push(line.replace(/`[^`]*`/g, ""));
  }

  return kept.join("\n");
}

/**
 * Counts real wikilink references to `target` in `markdown`
 * (`[[target]]`/`[[target|alias]]`), after removing fenced code blocks and
 * inline code spans so an example mention never counts as a live link.
 *
 * @param {string} markdown
 * @param {string} target Vault path of the note, without its `.md` extension.
 * @returns {number} The number of distinct `[[target]]`/`[[target|alias]]` matches.
 */
export function countLinksTo(markdown, target) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`, "g");
  return (stripCodeAndInlineSpans(markdown).match(pattern) ?? []).length;
}

/**
 * Reports whether `markdown` links to `target`, with or without an alias.
 *
 * @param {string} markdown
 * @param {string} target Vault path of the note, without its `.md` extension.
 * @returns {boolean}
 */
export function hasLinkTo(markdown, target) {
  return countLinksTo(markdown, target) > 0;
}
