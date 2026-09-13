import { describe, expect, it } from "vitest";
import { countLinksTo, hasLinkTo } from "./markdownLinks.mjs";

const TARGET = "collection/Fixture";

describe("markdownLinks", () => {
  it("counts a plain wikilink", () => {
    expect(countLinksTo({ markdown: `- [[${TARGET}]]\n`, target: TARGET })).toBe(1);
  });

  it("counts a plain wikilink with an alias", () => {
    expect(countLinksTo({ markdown: `- [[${TARGET}|Fixture]]\n`, target: TARGET })).toBe(
      1,
    );
  });

  it(// Verifies the documented probe result markdownLinks.mjs relies on:
  // remark's core parser (no wikilink plugin installed) treats `[[...]]`
  // as ordinary literal text, not special syntax -- confirmed via
  // `remark-parse`'s mdast output showing `[[target|alias]]` surviving
  // verbatim inside a single `text` node's `value`.
  "treats [[...]] as plain text, not special remark syntax (documented probe)", () => {
    expect(hasLinkTo({ markdown: `[[${TARGET}]]`, target: TARGET })).toBe(true);
    // A target that is NOT present at all must not match -- proving the
    // regex is doing real work, not just "any bracket pair passes".
    expect(hasLinkTo({ markdown: `[[some/other/note]]`, target: TARGET })).toBe(false);
  });

  it(// A wikilink split across text nodes by an emphasis/strong/link node
  // (remark still parses `*...*` as an `emphasis` node even inside
  // `[[...]]`) must still be reassembled and matched as one string,
  // per-paragraph.
  "reassembles a wikilink split across text nodes by emphasis before matching", () => {
    const markdown = `- [[collection/*Fixture*]]\n`;
    expect(countLinksTo({ markdown, target: "collection/Fixture" })).toBe(1);
  });

  it(// MAJOR 1+2 (2026-09-13 Codex frontier review round 6, scoped): the
  // hand-rolled fence stripper this module replaced only recognized a
  // fence line starting at column 0; CommonMark allows a fence indented
  // 1-3 spaces. A real link elsewhere in the same document must still
  // count exactly once.
  "strips a fence indented 1-3 spaces, still counting a real link elsewhere exactly once", () => {
    const markdown = `   \`\`\`\n   - [[${TARGET}]]\n   \`\`\`\nreal: [[${TARGET}]]\n`;
    expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
  });

  it(// A 4+-space-indented block is CommonMark's *indented* code block (a
  // different construct from a fence entirely) and must be stripped too.
  "strips a 4+-space-indented code block, still counting a real link elsewhere exactly once", () => {
    const markdown = `    - [[${TARGET}]]\nreal: [[${TARGET}]]\n`;
    expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
  });

  it(// The hand-rolled stripper treated ANY line starting with the fence
  // character as a closer, even with trailing non-whitespace after it --
  // CommonMark requires the closing fence line to contain nothing but the
  // fence characters (optionally trailing whitespace). A line like
  // "``` trailing" does NOT close the fence, so everything up to the next
  // real closing fence is still code, and a link placed after that real
  // close must count exactly once.
  "does not treat a closing fence line with trailing text as closing the fence", () => {
    const markdown =
      "```\n" +
      `- [[${TARGET}]]\n` +
      "``` trailing\n" +
      "```\n" +
      `real: [[${TARGET}]]\n`;
    expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
  });

  it(// CommonMark: a backtick-fenced code block's info string must not
  // itself contain a backtick -- if it does, the line is not a valid
  // fence opener at all, and the following lines are ordinary prose.
  "does not treat a backtick opener whose info string contains backticks as a fence", () => {
    const markdown = `\`\`\` \`info\` \nreal: [[${TARGET}]]\n\`\`\`\n`;
    expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
  });

  it(// The hand-rolled stripper's inline-span regex only matched a
  // single-backtick pair on one line; a multi-backtick-delimited span
  // (`` `` ... `` ``) was not recognized as one unit.
  "strips a multi-backtick inline code span, still counting a real link elsewhere exactly once", () => {
    const markdown = `See \`\` [[${TARGET}]] \`\` above.\nreal: [[${TARGET}]]\n`;
    expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
  });

  it(// The hand-rolled stripper operated one line at a time, so an inline
  // code span spanning a line break was invisible to it.
  "strips a multiline inline code span, still counting a real link elsewhere exactly once", () => {
    const markdown = `See \`\n[[${TARGET}]]\n\` above.\nreal: [[${TARGET}]]\n`;
    expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
  });

  it(// A double-backtick-delimited span containing a literal single
  // backtick inside it (CommonMark: content backtick runs shorter than
  // the delimiter run are literal) -- a "mismatched delimiter run" the
  // hand-rolled single-backtick-pair regex could misjudge the boundary
  // of. A real link outside the span must still count exactly once.
  "handles a mismatched delimiter run inside an inline code span correctly", () => {
    const markdown = `See \`\` code \` still code \`\` then real: [[${TARGET}]] here.\n`;
    expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
  });

  it(// Text that looks like a fence marker, but appears inside an inline
  // code span (not at the start of its own line as a block construct),
  // must never enter "fence state" -- it is just part of the span's
  // content.
  "does not let fence-looking text inside an inline span enter fence state", () => {
    const markdown = `Note: \`\`\`\`\` above marks a fence, e.g. real: [[${TARGET}]].\n`;
    expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
  });

  it("rejects more than one real link (duplicate)", () => {
    const markdown = `- [[${TARGET}]]\n- [[${TARGET}]]\n`;
    expect(countLinksTo({ markdown, target: TARGET })).toBe(2);
  });
});
