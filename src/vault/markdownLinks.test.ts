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

  describe("text-run splitting at opaque nodes (round 6 scoped re-review MAJOR 1, third pass)", () => {
    it(// `collectVisibleText` used to return "" for a skipped node and
    // simply concatenate its neighbours, so `[[collection/` + (skipped
    // inline code) + `Fixture]]` reassembled into a false match. Splitting
    // into independent text runs at every opaque node (no separator
    // character of any kind) prevents that, and the real link placed
    // separately must still count exactly once.
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

    it(// MINOR (2026-09-13 Codex frontier review round 6, third pass): an
    // image REFERENCE (`![alt][ref]`, resolved against a `[ref]: url`
    // definition elsewhere) is a distinct mdast node type from a direct
    // image, and was missing dedicated committed coverage.
    "does not reassemble a pseudo-link fragmented by an image reference", () => {
      const markdown = `[[collection/![alt][ref]Fixture]]\n\n[ref]: https://example.com\nreal: [[${TARGET}]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it("does not reassemble a pseudo-link fragmented by inline HTML", () => {
      const markdown = `[[collection/<br>Fixture]]\nreal: [[${TARGET}]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });
  });

  describe(// MAJOR 2 (2026-09-13 Codex frontier review round 6, third pass): the
  // previous fix used a Unicode Private Use Area character (U+E000) as an
  // in-band boundary sentinel. That character is still ordinary text --
  // nothing stops a real vault path (built from a user-controlled note
  // title) from containing it, colliding with the sentinel. Boundaries
  // are now structural (an array of independent text runs), never a
  // character, so a target containing this exact code point cannot
  // collide with anything.
  "target containing the former sentinel character (U+E000)", () => {
    const PUA = "\uE000";
    const puaTarget = `collection/Foo${PUA}Bar`;

    it("counts a real, unfragmented link to a target containing U+E000 exactly once", () => {
      const markdown = `[[collection/Foo${PUA}Bar]]\n`;
      expect(countLinksTo({ markdown, target: puaTarget })).toBe(1);
    });

    it(// The collision this construct used to trigger: a pseudo-link
    // fragmented by an inline code span, checked against a target that
    // happens to contain the exact character the old sentinel used.
    // The old sentinel-character implementation returned 1 here
    // (confirmed by a standalone reproduction before this fix); the
    // array-of-runs implementation has no character to collide with.
    "does not let a pseudo-link fragmented by an opaque node collide with a U+E000-containing target", () => {
      const markdown = "[[collection/Foo`x`Bar]]\n";
      expect(countLinksTo({ markdown, target: puaTarget })).toBe(0);
    });
  });

  describe(// MAJOR 1 (2026-09-13 Codex frontier review round 6, third pass): the
  // raw-substring fast path this module briefly had ignored Markdown
  // escapes and character references, both of which remark resolves
  // differently from the raw bytes -- `\-` becomes a literal `-`, `&amp;`
  // becomes `&`. Neither contains the fast path's own trigger characters,
  // so both were wrongly fast-pathed to 0 even though a real parse finds
  // the link, which would have made the publisher insert a duplicate.
  // The fast path is removed entirely (see this module's top comment);
  // these fixtures now simply confirm a real parse always resolves them
  // correctly.
  "Markdown escapes and character references in targets (fast path removed, always parses)", () => {
    it("counts a link whose target contains a backslash-escaped hyphen", () => {
      const markdown = "[[collection/Foo\\-Bar]]\n";
      expect(countLinksTo({ markdown, target: "collection/Foo-Bar" })).toBe(1);
    });

    it("counts a link whose target contains a backslash-escaped underscore", () => {
      const markdown = "[[collection/Foo\\_Bar]]\n";
      expect(countLinksTo({ markdown, target: "collection/Foo_Bar" })).toBe(1);
    });

    it("counts a link whose target contains a backslash-escaped asterisk", () => {
      const markdown = "[[collection/Foo\\*Bar]]\n";
      expect(countLinksTo({ markdown, target: "collection/Foo*Bar" })).toBe(1);
    });

    it("counts a link whose target contains a named HTML character reference (&amp;)", () => {
      const markdown = "[[collection/Foo&amp;Bar]]\n";
      expect(countLinksTo({ markdown, target: "collection/Foo&Bar" })).toBe(1);
    });

    it("counts a link whose target contains a numeric HTML character reference (&#x26;)", () => {
      const markdown = "[[collection/Foo&#x26;Bar]]\n";
      expect(countLinksTo({ markdown, target: "collection/Foo&Bar" })).toBe(1);
    });
  });

  describe(// MAJOR (2026-09-13 Codex frontier review round 9, scoped): the alias
  // group `[^\]]*` stopped at the FIRST `]`, so an alias containing a
  // literal `]` -- written as a backslash escape (remark resolves `\]`
  // to a literal `]`) or an HTML character reference (`&#93;` also
  // resolves to `]`) -- was cut short there, the regex never found the
  // real `]]` closer, and the whole link failed to match at all
  // (returning 0), which would make the publisher insert a duplicate
  // note even though a real, well-formed link already exists.
  "alias containing a literal ] via escape or character reference", () => {
    it("counts a link whose alias contains a backslash-escaped closing bracket", () => {
      const markdown = `[[${TARGET}|Foo\\]Bar]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it("counts a link whose alias contains a numeric HTML character reference for ] (&#93;)", () => {
      const markdown = `[[${TARGET}|Foo&#93;Bar]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(1);
    });

    it(// The target portion must still be exact -- an alias's literal `]`
    // must never let the match creep past the real closing `]]` into
    // trailing document text.
    "does not let an alias's literal ] swallow trailing document text past the real closing ]]", () => {
      const markdown = `[[${TARGET}|Foo\\]Bar]] trailing text [[${TARGET}]]\n`;
      expect(countLinksTo({ markdown, target: TARGET })).toBe(2);
    });
  });

  describe(// MAJOR (2026-09-13 Codex frontier review round 10, scoped): the
  // round-9 alias scan `(?:(?!\]\]).)*` stops only at `]]`, so an
  // unterminated link's alias scan crosses a NESTED `[[` and "borrows" a
  // later link's closing `]]` -- `[[a|unterminated ] text [[b]]` wrongly
  // matched from `a`'s opener all the way to `b`'s closer, counting `a`
  // as linked (a false "already linked" result the publisher would
  // trust, suppressing the real link `a` still needs) while ALSO
  // counting `b`. Fixed by replacing the regex with an explicit linear
  // two-pointer scanner that treats an unterminated `[[` (one whose next
  // `]]` is preceded by a nested `[[`) as malformed and never lets it
  // borrow a later closer.
  "malformed unterminated link before a valid link (round 10 scoped re-review)", () => {
    it("counts 0 for the unterminated/malformed target and 1 for the real one that follows", () => {
      const markdown = "[[a|unterminated ] text [[b]]\n";
      expect(countLinksTo({ markdown, target: "a" })).toBe(0);
      expect(countLinksTo({ markdown, target: "b" })).toBe(1);
    });

    it(// BLOCKER (2026-09-13 Codex frontier review round 11, scoped): the
    // round-10 scanner re-ran `indexOf("]]", ...)` from the position
    // right after EVERY nested opener, so for `"[[".repeat(n) +
    // "valid]]"` every one of the `n` openers re-scanned forward toward
    // the SAME distant closer -- quadratic (measured on the round-10
    // implementation: ~4.8ms at 32KB, ~68ms at 128KB, ~273ms at 256KB).
    // The round-9/10 malformed-prefix benchmark above never caught this
    // because its input (`"[[a|x ] "` repeated) has no `]]` anywhere at
    // all, so the old scanner's very first iteration exited immediately
    // without ever reaching the nested-opener-replacement branch this
    // shape exercises. This benchmark repeats nested openers ending in
    // one genuine valid link, warms the parse cache first (isolating
    // this module's own scan cost from `remark-parse`'s), asserts the
    // final link IS still counted, and asserts the cost scales linearly
    // -- not quadratically -- from 128KB to 256KB, so a regression back
    // to the round-10 shape fails this test.
    "scans repeated nested unterminated openers ending in one valid link with linear, not quadratic, cost", () => {
      // MINOR 1 (2026-09-13 Codex frontier review round 12, scoped): a
      // single sample is too noisy at this scale -- the scan itself is
      // sub-millisecond, so `Math.max(sample * 3, 30)` degenerated into a
      // fixed 30ms ceiling (a much slower quadratic regression, e.g. 2ms
      // vs 8ms, would still false-pass against it) while a single
      // descheduled sample could just as easily false-fail. Repeating the
      // cached scan until the aggregate clearly rises above timer noise
      // (or a fixed iteration cap) and taking the MINIMUM per-iteration
      // time gives a robust statistic: the minimum is never inflated by a
      // GC pause or a descheduled tick, but a real algorithmic slowdown
      // still raises it on every iteration.
      function timeScanRobust(openerCount: number) {
        const chunk = `${"[[".repeat(openerCount)}valid]]`;
        countLinksTo({ markdown: chunk, target: "valid" }); // warm the parse cache

        let result: number | undefined;
        let minMs = Number.POSITIVE_INFINITY;
        let aggregateMs = 0;
        let iterations = 0;
        // Always take at least five samples so a slower (regressed) scan that
        // clears the 20 ms aggregate on its first call still gets a minimum
        // over several measurements rather than one possibly-descheduled one
        // (Codex scoped review round 13, 2026-09-13).
        while ((aggregateMs < 20 || iterations < 5) && iterations < 50) {
          const start = performance.now();
          result = countLinksTo({ markdown: chunk, target: "valid" });
          const elapsedMs = performance.now() - start;
          aggregateMs += elapsedMs;
          minMs = Math.min(minMs, elapsedMs);
          iterations += 1;
        }
        return { result, minMs, bytes: chunk.length, iterations };
      }

      const at128k = timeScanRobust(64000);
      expect(at128k.bytes).toBeGreaterThan(120000);
      expect(at128k.result).toBe(1);
      expect(at128k.minMs).toBeLessThan(200);

      const at256k = timeScanRobust(128000);
      expect(at256k.bytes).toBeGreaterThan(240000);
      expect(at256k.result).toBe(1);
      expect(at256k.minMs).toBeLessThan(200);

      // Linear cost roughly doubles from 128KB to 256KB; a quadratic
      // regression would roughly QUADRUPLE it. Allow generous headroom
      // (~3x) on the robust minimum -- no fixed floor needed now that the
      // statistic itself is stable across repeated samples.
      expect(at256k.minMs).toBeLessThan(at128k.minMs * 3);
    });
  });

  describe(// MINOR (2026-09-13 Codex frontier review round 11, scoped): these
  // four boundary shapes were exercised only ad hoc while designing the
  // scanner across rounds 9-11, never as committed fixtures. All four
  // already behave correctly with the current single-pass scanner
  // (confirmed here, not new bugs) -- this closes the coverage gap.
  "boundary shapes (table-driven, round 11 scoped re-review MINOR)", () => {
    it.each([
      {
        label: "adjacent links with no separator",
        markdown: "[[a]][[b]]",
        target: "a",
        expected: 1,
      },
      {
        label: "adjacent links with no separator (second target)",
        markdown: "[[a]][[b]]",
        target: "b",
        expected: 1,
      },
      {
        label: "empty alias",
        markdown: "[[a|]]",
        target: "a",
        expected: 1,
      },
      {
        label:
          // The first opener is replaced by the nested one before it
          // ever closes, so `a` never matches; `b` closes normally at
          // the first `]]`. The two characters remaining after that --
          // a second, unpaired `]]` -- are inert leftover text: no
          // opener is open when the scanner reaches them, so they are
          // consumed without starting or completing any match.
          "nested link with a trailing extra closer -- outer target must not match, inner target must, and the leftover `]]` is inert",
        markdown: "[[a|x[[b]]]]",
        target: "a",
        expected: 0,
      },
      {
        label: "nested link with a trailing extra closer (inner target)",
        markdown: "[[a|x[[b]]]]",
        target: "b",
        expected: 1,
      },
      {
        label: "a real link immediately followed by one extra stray ]",
        markdown: "[[a]]]",
        target: "a",
        expected: 1,
      },
    ])("$label", ({ markdown, target, expected }) => {
      expect(countLinksTo({ markdown, target })).toBe(expected);
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

  describe(// MAJOR 1 (2026-09-13 Codex frontier review round 6, third pass): the
  // raw-substring fast path this module briefly had was removed entirely
  // (see this module's top comment) because it could return a false "no
  // link" for a target reachable only through a Markdown escape or
  // character reference, which would make the publisher insert a
  // duplicate note -- a correctness bug worse than the performance cost
  // it was trying to avoid. `countLinksTo`/`hasLinkTo` now always parse;
  // the single-entry parse cache (kept, since it never changes the
  // result) is the only optimization left.
  "performance (round 6 scoped re-review MAJOR 2; fast path removed in round 6 third pass)", () => {
    function buildFlatListMoc(entries: number, salt: string): string {
      const lines: string[] = [`<!-- salt: ${salt} -->`];
      for (let i = 0; i < entries; i++) {
        lines.push(`- [[collection/Fixture ${i}|Fixture ${i}]]`);
      }
      return `${lines.join("\n")}\n`;
    }

    it(// Measured on this machine (always-parse, no fast path): ~500ms at
    // 10k entries, ~1.3-1.4s at 20k, ~7-15s at 50k, for BOTH the
    // absent-target and present-target cases (there is no longer a
    // parse-free path for either) -- roughly linear-to-quadratic in
    // total MOC size, since `VaultPublisher` calls this once per
    // publication. This is an accepted, measured, documented per-call
    // link-check cost, not the plan's protected full-collection scan;
    // real collection MOCs are orders of magnitude smaller than this
    // 20k-entry synthetic benchmark. A repeat call against the exact
    // same markdown string reuses the single-entry parse cache (measured
    // ~2-7ms), which is the only remaining optimization.
    "documents the measured full-parse cost on a large flat-list MOC, for both an absent and a present target", () => {
      const entries = 20000;
      // Two distinct strings (different "salt" comments) so the cache
      // cannot silently turn either "cold" measurement into a hit.
      const mocForAbsent = buildFlatListMoc(entries, "absent");
      const mocForPresent = buildFlatListMoc(entries, "present");
      const absentTarget = "collection/absent-target-not-in-moc";
      const presentTarget = `collection/Fixture ${entries - 1}`;

      const absentStart = performance.now();
      expect(countLinksTo({ markdown: mocForAbsent, target: absentTarget })).toBe(0);
      // Ceiling widened from 3000ms (round 6 third pass) after observing a
      // real flake under full-suite parallel load (measured ~7s on a
      // machine also running ~150 other concurrent test files) -- still
      // loose enough to catch a genuine regression, per this test's own
      // "generous ceilings for CI stability" philosophy.
      expect(performance.now() - absentStart).toBeLessThan(10000);

      const presentStart = performance.now();
      expect(countLinksTo({ markdown: mocForPresent, target: presentTarget })).toBe(1);
      const presentColdMs = performance.now() - presentStart;
      expect(presentColdMs).toBeLessThan(10000);

      // MINOR 2 (2026-09-13 Codex frontier review round 12, scoped): the
      // widened 2000ms absolute ceiling alone no longer proves the
      // single-entry cache is actually being hit, since a genuinely COLD
      // parse (~1.3-1.4s nominal, more under full-suite load) already
      // fits under it -- a silently lost/bypassed cache would still pass.
      // Require the cached call to be materially faster than the cold
      // parse it immediately follows (by a generous relative factor, not
      // just an absolute cap), using the minimum of a few repeated cached
      // samples so scheduler noise on one sample can't cause a false
      // failure.
      let minCachedMs = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 5; i++) {
        const cachedStart = performance.now();
        expect(countLinksTo({ markdown: mocForPresent, target: presentTarget })).toBe(1);
        minCachedMs = Math.min(minCachedMs, performance.now() - cachedStart);
      }
      expect(minCachedMs).toBeLessThan(2000);
      expect(minCachedMs).toBeLessThan(presentColdMs / 10);
    });

    it(// MINOR (2026-09-13 Codex frontier review round 6, third pass): a
    // cache-sequence regression -- the single-entry cache must never
    // serve a stale result for even a one-character-different string,
    // and reverting to the original string must re-hit correctly too
    // (proving the cache key really is the current string's exact
    // value, not some weaker fingerprint that could collide).
    "does not serve a stale cached result across a one-character-modified-then-reverted sequence", () => {
      const original = `- [[${TARGET}]]\n`;
      const modified = `- [[${TARGET}]] \n`; // one added trailing space
      const target = TARGET;

      expect(countLinksTo({ markdown: original, target })).toBe(1);
      expect(countLinksTo({ markdown: modified, target })).toBe(1);
      expect(countLinksTo({ markdown: original, target })).toBe(1);

      // A modification that actually changes the count must be seen
      // too, not masked by a stale cache entry.
      const withDuplicate = `- [[${TARGET}]]\n- [[${TARGET}]]\n`;
      expect(countLinksTo({ markdown: withDuplicate, target })).toBe(2);
      expect(countLinksTo({ markdown: original, target })).toBe(1);
    });
  });
});
