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

  describe("boundary sentinel (round 6 scoped re-review MAJOR 1)", () => {
    it(// `collectVisibleText` used to return "" for a skipped node and
    // simply concatenate its neighbours, so `[[collection/` + (skipped
    // inline code) + `Fixture]]` reassembled into a false match. A
    // boundary sentinel between the two halves prevents that, and the
    // real link placed separately must still count exactly once.
    "does not reassemble a pseudo-link fragmented by an inline code span", () => {
      const markdown = `[[collection/\`x\`Fixture]]\nreal: [[${TARGET}]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it("does not reassemble a pseudo-link fragmented by a hard line break", () => {
      const markdown = `[[collection/  \nFixture]]\nreal: [[${TARGET}]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it("does not reassemble a pseudo-link fragmented by an image", () => {
      const markdown = `[[collection/![alt](url)Fixture]]\nreal: [[${TARGET}]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it("does not reassemble a pseudo-link fragmented by inline HTML", () => {
      const markdown = `[[collection/<br>Fixture]]\nreal: [[${TARGET}]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });
  });

  describe("raw HTML scope decision (round 6 scoped re-review MINOR)", () => {
    it(// `renderCollectionIndex` in src/vault/render.ts never emits block
    // HTML -- the publisher's own MOCs are always a heading plus a flat
    // Markdown bullet list -- so a link mentioned only inside a raw HTML
    // block a human hand-edited in is deliberately NOT counted, exactly
    // like a link mentioned only inside a code fence is not. This is a
    // documented scope decision, not an oversight.
    "does not count a link that appears only inside a raw HTML block", () => {
      const markdown = `<div>\n[[${TARGET}]]\n</div>\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(0);
    });
  });

  describe("structural coverage (round 6 scoped re-review MINOR: committed fixtures for previously-probed-only cases)", () => {
    it("counts a link inside a heading", () => {
      const markdown = `## See [[${TARGET}]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it("counts a link inside a list item", () => {
      const markdown = `- [[${TARGET}]]\n- some other item\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it("counts a link inside a blockquote", () => {
      const markdown = `> See [[${TARGET}]] for details.\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it("counts a link inside a GFM-less table cell (pipe table via remark-parse core)", () => {
      // remark-parse's core (no remark-gfm) does not parse pipe tables at
      // all -- a `| ... |` line becomes ordinary paragraph text, still
      // scanned as a `paragraph`, so the link is still found.
      const markdown = `| [[${TARGET}]] | other |\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it("reassembles a wikilink split across text nodes by strong emphasis", () => {
      const markdown = `- [[collection/**Fixture**]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it(// A real Markdown link is transparent for reassembly purposes: its
    // clickable label text (here "Fixture", the entire remaining part of
    // the target) is genuinely visible content, so it is kept -- only
    // the `(url)`/`[...]` delimiter syntax around it vanishes on parse.
    "reassembles a wikilink split across text nodes by a real Markdown link", () => {
      const markdown = `- [[collection/[Fixture](https://example.com)]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it(// Two adjacent paragraphs, the first ending with the opening half of
    // a wikilink and the second starting with the closing half, must
    // NEVER be concatenated into a false match -- matching is scoped per
    // block (TEXT_CONTAINER_TYPES), not globally.
    "does not merge a pseudo-link split across two separate paragraphs", () => {
      const markdown = `[[collection/\n\nFixture]]\nreal: [[${TARGET}]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });
  });

  describe("performance (round 6 scoped re-review MAJOR 2)", () => {
    function buildFlatListMoc(entries: number): string {
      const lines: string[] = [];
      for (let i = 0; i < entries; i++) {
        lines.push(`- [[collection/Fixture ${i}|Fixture ${i}]]`);
      }
      return `${lines.join("\n")}\n`;
    }

    it(// Measured on this machine before the fast path: ~508ms at 10k
    // entries, ~1.4s at 20k, ~13.8s at 50k (roughly quadratic in total
    // MOC size, since VaultPublisher calls this once per publication).
    // The substring fast path makes the target-absent case parse-free
    // regardless of MOC size (measured well under 1ms at 20k); the
    // target-present case still requires a real parse (measured ~1.4s at
    // 20k, unaffected by the fast path since the substring genuinely is
    // present), but a repeat call against the exact same MOC string
    // reuses the single-entry parse cache (measured ~4ms). Ceilings here
    // are deliberately generous for CI stability -- this documents an
    // accepted, bounded per-call link-check cost, not the plan's
    // protected full-collection scan.
    "stays fast on a large flat-list MOC when the target is absent, and bounded when present", () => {
      const entries = 20000;
      const moc = buildFlatListMoc(entries);
      const absentTarget = "collection/absent-target-not-in-moc";
      const presentTarget = `collection/Fixture ${entries - 1}`;

      const absentStart = performance.now();
      expect(countLinksTo({ markdown: moc, target: absentTarget })).toBe(0);
      expect(performance.now() - absentStart).toBeLessThan(50);

      const presentStart = performance.now();
      expect(countLinksTo({ markdown: moc, target: presentTarget })).toBe(1);
      expect(performance.now() - presentStart).toBeLessThan(3000);

      // Same exact markdown string again -- the single-entry cache must
      // make this dramatically cheaper than the cold parse above.
      const cachedStart = performance.now();
      expect(countLinksTo({ markdown: moc, target: presentTarget })).toBe(1);
      expect(performance.now() - cachedStart).toBeLessThan(500);
    });
  });
});
