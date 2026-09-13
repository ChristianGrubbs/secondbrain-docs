import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { qualifyNote, sha256 } from "./qualification-contract.mjs";

describe("qualifyNote", () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "qualification-contract-test-"));
    fs.mkdirSync(path.join(vaultPath, "collection"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  /** Writes a well-formed saved note plus a MOC linking it exactly once. */
  function writeNoteAndMoc(body: string): { notePath: string; savedBytes: string } {
    const savedBytes = [
      "---",
      "type: source",
      "title: Fixture",
      "source_url: https://example.com/fixture",
      "requested_url: https://example.com/fixture",
      "source_id: abc123",
      "collection: collection",
      'version: ""',
      "---",
      body,
    ].join("\n");
    const notePath = "collection/Fixture abc123.md";
    fs.writeFileSync(path.join(vaultPath, notePath), savedBytes, "utf8");
    fs.writeFileSync(
      path.join(vaultPath, "collection", "index.md"),
      `- [[${notePath.replace(/\.md$/, "")}]]\n`,
      "utf8",
    );
    return { notePath, savedBytes };
  }

  function fakeRunCli(overrides: Partial<Record<string, { code: number; stdout: string; stderr: string }>> = {}) {
    return async (args: string[]) => {
      const key = args[0];
      if (overrides[key]) return overrides[key] as { code: number; stdout: string; stderr: string };
      if (key === "search") {
        return { code: 0, stdout: JSON.stringify({ results: [] }), stderr: "" };
      }
      if (key === "read") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected args" };
    };
  }

  it("passes for a well-formed note with matching digest, facts, MOC link, search identity and full read", async () => {
    const { notePath, savedBytes } = writeNoteAndMoc("FACT-ALPHA-1001");
    const digest = sha256(savedBytes);
    const runCli = fakeRunCli({
      search: {
        code: 0,
        stdout: JSON.stringify({ results: [{ vault_path: notePath, digest }] }),
        stderr: "",
      },
      read: { code: 0, stdout: `${savedBytes}\n`, stderr: "" },
    });

    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: digest,
      facts: ["FACT-ALPHA-1001"],
      collection: "collection",
      query: "FACT-ALPHA-1001",
      version: "",
      sourceUrlContains: "example.com",
      runCli,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a missing fact", async () => {
    const { notePath, savedBytes } = writeNoteAndMoc("no such fact here");
    const digest = sha256(savedBytes);
    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: digest,
      facts: ["MISSING-FACT-9999"],
      runCli: fakeRunCli(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing facts/);
  });

  it(
    // MAJOR C (2026-09-13 Codex frontier review, round 2): the contract
    // must reject a wrong-digest claim, not silently accept it.
    "rejects a wrong-digest claim (outcome's reported digest does not match saved bytes)",
    async () => {
      const { notePath } = writeNoteAndMoc("FACT-BETA-1002");
      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        facts: ["FACT-BETA-1002"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/digest mismatch/);
    },
  );

  it(
    // MAJOR 2 (2026-09-13 Codex frontier review, round 3): a capture
    // regression that omits the digest from its own envelope must NOT
    // silently qualify -- the contract previously skipped digest
    // validation entirely when `expectedDigest` was `undefined`.
    "rejects a missing publication digest (undefined) even though the saved note itself is well-formed",
    async () => {
      const { notePath } = writeNoteAndMoc("FACT-IOTA-1009");
      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: undefined,
        facts: ["FACT-IOTA-1009"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/missing publication digest/);
    },
  );

  it("rejects an empty-string publication digest the same way as a missing one", async () => {
    const { notePath } = writeNoteAndMoc("FACT-KAPPA-1010");
    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: "",
      facts: ["FACT-KAPPA-1010"],
      runCli: fakeRunCli(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing publication digest/);
  });

  it("rejects malformed metadata: missing source_id", async () => {
    const notePath = "collection/no-source-id.md";
    const savedBytes = [
      "---",
      "type: source",
      "title: No Source Id",
      'version: ""',
      "---",
      "FACT-GAMMA-1003",
    ].join("\n");
    fs.writeFileSync(path.join(vaultPath, notePath), savedBytes, "utf8");
    fs.writeFileSync(
      path.join(vaultPath, "collection", "index.md"),
      `- [[${notePath.replace(/\.md$/, "")}]]\n`,
      "utf8",
    );

    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: sha256(savedBytes),
      facts: ["FACT-GAMMA-1003"],
      runCli: fakeRunCli(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/source_id/);
  });

  it("rejects a version mismatch", async () => {
    const { notePath, savedBytes } = writeNoteAndMoc("FACT-DELTA-1004");
    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: sha256(savedBytes),
      facts: ["FACT-DELTA-1004"],
      version: "v2",
      runCli: fakeRunCli(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/version/);
  });

  it("rejects a wrong source_url", async () => {
    const { notePath, savedBytes } = writeNoteAndMoc("FACT-EPSILON-1005");
    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: sha256(savedBytes),
      facts: ["FACT-EPSILON-1005"],
      sourceUrlContains: "totally-different-domain.example",
      runCli: fakeRunCli(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/source_url/);
  });

  it("rejects more than one MOC link (or zero)", async () => {
    const { notePath, savedBytes } = writeNoteAndMoc("FACT-ZETA-1006");
    fs.writeFileSync(
      path.join(vaultPath, "collection", "index.md"),
      `- [[${notePath.replace(/\.md$/, "")}]]\n- [[${notePath.replace(/\.md$/, "")}]]\n`,
      "utf8",
    );

    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: sha256(savedBytes),
      facts: ["FACT-ZETA-1006"],
      runCli: fakeRunCli(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/MOC link count/);
  });

  it(
    // MAJOR 1 (2026-09-13 Codex frontier review, round 4): a MOC containing
    // only the note's path as plain text -- no `[[...]]` wikilink syntax at
    // all -- must not qualify. A substring match against the extensionless
    // path (the round-3 implementation) would have accepted this.
    "rejects a MOC that only mentions the note's path as plain text, with no wikilink",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-LAMBDA-1011");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `Plain text only: ${target}\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-LAMBDA-1011"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // A longer sibling target sharing the same prefix (e.g. the note's path
    // plus " 2") must not be counted as a link to the shorter target -- the
    // matcher requires the exact target immediately followed by `|` or `]]`.
    "rejects a MOC whose only link targets a longer sibling path sharing the same prefix",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-MU-1012");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `- [[${target} 2|Fixture 2]]\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-MU-1012"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it("rejects malformed link syntax (missing closing brackets)", async () => {
    const { notePath, savedBytes } = writeNoteAndMoc("FACT-NU-1013");
    const target = notePath.replace(/\.md$/, "");
    fs.writeFileSync(
      path.join(vaultPath, "collection", "index.md"),
      `- [[${target}\n`,
      "utf8",
    );

    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: sha256(savedBytes),
      facts: ["FACT-NU-1013"],
      runCli: fakeRunCli(),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/MOC link count 0/);
  });

  it(
    // MAJOR 2 (2026-09-13 Codex frontier review, round 5): a target that
    // appears only inside a backtick-fenced code block must not count as a
    // real link.
    "rejects a MOC whose only mention of the target is inside a backtick-fenced code block",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-OMICRON-1015");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `Example:\n\`\`\`\n- [[${target}]]\n\`\`\`\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-OMICRON-1015"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // MAJOR 2 (2026-09-13 Codex frontier review, round 5): round 4's
    // stripCodeFences only recognized backtick fences; a target mentioned
    // only inside a tilde-fenced code block was still counted as a real
    // link.
    "rejects a MOC whose only mention of the target is inside a tilde-fenced code block",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-PI-1016");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `Example:\n~~~\n- [[${target}]]\n~~~\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-PI-1016"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // MAJOR 2 (2026-09-13 Codex frontier review, round 5): a target
    // mentioned only inside an inline code span (not a fenced block) must
    // not count as a real link either.
    "rejects a MOC whose only mention of the target is inside an inline code span",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-RHO-1017");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `See the example \`[[${target}]]\` above.\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-RHO-1017"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // A real link alongside an unrelated code example mentioning the same
    // target must still count as exactly one real link -- the code example
    // must not be double-counted, and must not suppress the real link
    // either.
    "counts exactly one real link when a code example also mentions the target",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-SIGMA-1018");
      const target = notePath.replace(/\.md$/, "");
      const digest = sha256(savedBytes);
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `- [[${target}|Fixture]]\n\nExample:\n\`\`\`\n- [[${target}]]\n\`\`\`\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: digest,
        facts: ["FACT-SIGMA-1018"],
        collection: "collection",
        query: "FACT-SIGMA-1018",
        runCli: fakeRunCli({
          search: {
            code: 0,
            stdout: JSON.stringify({ results: [{ vault_path: notePath, digest }] }),
            stderr: "",
          },
          read: { code: 0, stdout: `${savedBytes}\n`, stderr: "" },
        }),
      });

      expect(result.ok).toBe(true);
    },
  );

  it(
    // MAJOR 1+2 (2026-09-13 Codex frontier review, round 6, scoped): the
    // hand-rolled fence stripper only recognized a fence starting at column
    // 0; CommonMark allows a fence indented 1-3 spaces.
    "rejects a MOC whose only mention of the target is inside a fence indented 1-3 spaces",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-TAU-1019");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `Example:\n  \`\`\`\n  - [[${target}]]\n  \`\`\`\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-TAU-1019"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // A 4+-space-indented block is CommonMark's *indented* code block, a
    // different construct from a fence entirely, and must be stripped too.
    "rejects a MOC whose only mention of the target is inside a 4+-space-indented code block",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-UPSILON-1020");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `Example:\n\n    - [[${target}]]\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-UPSILON-1020"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // CommonMark requires a closing fence line to contain nothing but the
    // fence characters (optionally trailing whitespace); a line with
    // trailing text does NOT close the fence, so a link between it and the
    // real closing fence is still code, and only the real link after the
    // true close counts.
    "counts exactly one real link when a fence's bogus closing line (with trailing text) does not actually close it",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-PHI-1021");
      const target = notePath.replace(/\.md$/, "");
      const digest = sha256(savedBytes);
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `\`\`\`\n- [[${target}]]\n\`\`\` trailing\n\`\`\`\nreal: [[${target}]]\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: digest,
        facts: ["FACT-PHI-1021"],
        collection: "collection",
        query: "FACT-PHI-1021",
        runCli: fakeRunCli({
          search: {
            code: 0,
            stdout: JSON.stringify({ results: [{ vault_path: notePath, digest }] }),
            stderr: "",
          },
          read: { code: 0, stdout: `${savedBytes}\n`, stderr: "" },
        }),
      });

      expect(result.ok).toBe(true);
    },
  );

  it(
    // CommonMark: a backtick-fenced code block's info string must not
    // itself contain a backtick -- such a line is not a valid fence opener
    // at all, so the following content (including a real link) is ordinary
    // prose, not code.
    "counts exactly one real link when a backtick opener's info string itself contains backticks (not a valid fence)",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-CHI-1022");
      const target = notePath.replace(/\.md$/, "");
      const digest = sha256(savedBytes);
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        "``` `info` \n" + `real: [[${target}]]\n` + "```\n",
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: digest,
        facts: ["FACT-CHI-1022"],
        collection: "collection",
        query: "FACT-CHI-1022",
        runCli: fakeRunCli({
          search: {
            code: 0,
            stdout: JSON.stringify({ results: [{ vault_path: notePath, digest }] }),
            stderr: "",
          },
          read: { code: 0, stdout: `${savedBytes}\n`, stderr: "" },
        }),
      });

      expect(result.ok).toBe(true);
    },
  );

  it(
    // The hand-rolled stripper's inline-span regex only matched a
    // single-backtick pair on one line; a multi-backtick-delimited span
    // was not recognized as one unit.
    "rejects a MOC whose only mention of the target is inside a multi-backtick inline code span",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-PSI-1023");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `See \`\` [[${target}]] \`\` above.\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-PSI-1023"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // The hand-rolled stripper operated one line at a time, so an inline
    // code span spanning a line break was invisible to it.
    "rejects a MOC whose only mention of the target is inside a multiline inline code span",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-OMEGA-1024");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `See \`\n[[${target}]]\n\` above.\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-OMEGA-1024"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // A double-backtick-delimited span containing a literal single backtick
    // inside it -- a "mismatched delimiter run" the hand-rolled
    // single-backtick-pair regex could misjudge the boundary of.
    "rejects a MOC whose only mention of the target is inside a mismatched-delimiter-run inline code span",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-ALPHA2-1025");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `See \`\` code \` still code, [[${target}]] \`\` here.\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-ALPHA2-1025"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // Text that looks like a fence marker, but appears inline with no
    // matching closing backtick run anywhere in the same paragraph, is an
    // unmatched backtick run -- CommonMark treats it as literal text, not a
    // code span and never a block-level fence (fences only open at the
    // start of a line). The real link on the same line must still count.
    "counts exactly one real link when fence-looking text appears inline with no matching close",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-BETA2-1026");
      const target = notePath.replace(/\.md$/, "");
      const digest = sha256(savedBytes);
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `Note: \`\`\`\`\` marks a fence, e.g. real: [[${target}]].\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: digest,
        facts: ["FACT-BETA2-1026"],
        collection: "collection",
        query: "FACT-BETA2-1026",
        runCli: fakeRunCli({
          search: {
            code: 0,
            stdout: JSON.stringify({ results: [{ vault_path: notePath, digest }] }),
            stderr: "",
          },
          read: { code: 0, stdout: `${savedBytes}\n`, stderr: "" },
        }),
      });

      expect(result.ok).toBe(true);
    },
  );

  it(
    // MAJOR 1 (2026-09-13 Codex frontier review round 6, second scoped
    // re-review): a wikilink fragmented by an inline code span must not be
    // reassembled into a false match.
    "rejects a MOC whose only mention of the target is a pseudo-link fragmented by an inline code span",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-GAMMA2-1027");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `[[${target.slice(0, 5)}\`x\`${target.slice(5)}]]\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-GAMMA2-1027"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // A hard line break fragmenting a pseudo-link must not be reassembled
    // into a false match.
    "rejects a MOC whose only mention of the target is a pseudo-link fragmented by a hard line break",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-DELTA2-1028");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `[[${target.slice(0, 5)}  \n${target.slice(5)}]]\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-DELTA2-1028"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // An image fragmenting a pseudo-link must not be reassembled into a
    // false match.
    "rejects a MOC whose only mention of the target is a pseudo-link fragmented by an image",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-EPSILON2-1029");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `[[${target.slice(0, 5)}![alt](url)${target.slice(5)}]]\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-EPSILON2-1029"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // MINOR (2026-09-13 Codex frontier review round 6, second scoped
    // re-review): renderCollectionIndex never emits block HTML, so a link
    // mentioned only inside a raw HTML block is deliberately not counted,
    // exactly like a link inside a code fence is not -- a documented scope
    // decision, not an oversight.
    "rejects a MOC whose only mention of the target is inside a raw HTML block",
    async () => {
      const { notePath, savedBytes } = writeNoteAndMoc("FACT-ZETA2-1030");
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `<div>\n[[${target}]]\n</div>\n`,
        "utf8",
      );

      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: sha256(savedBytes),
        facts: ["FACT-ZETA2-1030"],
        runCli: fakeRunCli(),
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/MOC link count 0/);
    },
  );

  it(
    // MAJOR 1 (2026-09-13 Codex frontier review round 6, third pass): the
    // raw-substring fast path this module briefly had ignored Markdown
    // escapes -- `\-` is resolved by remark to a literal `-` -- so a MOC
    // link written this way around a target containing a hyphen would have
    // been fast-pathed to "no link" (MOC link count 0), a false rejection
    // of an actually-qualified note.
    "accepts a MOC link to a target containing a hyphen, written with a backslash escape",
    async () => {
      const savedBytes = [
        "---",
        "type: source",
        "title: Foo-Bar",
        "source_url: https://example.com/foo-bar",
        "requested_url: https://example.com/foo-bar",
        "source_id: abc124",
        "collection: collection",
        'version: ""',
        "---",
        "FACT-ETA2-1031",
      ].join("\n");
      const notePath = "collection/Foo-Bar abc124.md";
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(path.join(vaultPath, notePath), savedBytes, "utf8");
      const escapedTarget = target.replace(/-/g, "\\-");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `- [[${escapedTarget}]]\n`,
        "utf8",
      );

      const digest = sha256(savedBytes);
      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: digest,
        facts: ["FACT-ETA2-1031"],
        collection: "collection",
        query: "FACT-ETA2-1031",
        runCli: fakeRunCli({
          search: {
            code: 0,
            stdout: JSON.stringify({ results: [{ vault_path: notePath, digest }] }),
            stderr: "",
          },
          read: { code: 0, stdout: `${savedBytes}\n`, stderr: "" },
        }),
      });

      expect(result.ok).toBe(true);
    },
  );

  it(
    // Same bug shape, character references: `&amp;` is resolved by remark
    // to a literal `&`.
    "accepts a MOC link to a target containing an ampersand, written with an HTML character reference",
    async () => {
      const savedBytes = [
        "---",
        "type: source",
        "title: Foo&Bar",
        "source_url: https://example.com/foo-and-bar",
        "requested_url: https://example.com/foo-and-bar",
        "source_id: abc125",
        "collection: collection",
        'version: ""',
        "---",
        "FACT-THETA2-1032",
      ].join("\n");
      const notePath = "collection/Foo&Bar abc125.md";
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(path.join(vaultPath, notePath), savedBytes, "utf8");
      const referencedTarget = target.replace(/&/g, "&amp;");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `- [[${referencedTarget}]]\n`,
        "utf8",
      );

      const digest = sha256(savedBytes);
      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: digest,
        facts: ["FACT-THETA2-1032"],
        collection: "collection",
        query: "FACT-THETA2-1032",
        runCli: fakeRunCli({
          search: {
            code: 0,
            stdout: JSON.stringify({ results: [{ vault_path: notePath, digest }] }),
            stderr: "",
          },
          read: { code: 0, stdout: `${savedBytes}\n`, stderr: "" },
        }),
      });

      expect(result.ok).toBe(true);
    },
  );

  it(
    // MAJOR 2 (2026-09-13 Codex frontier review round 6, third pass): the
    // former sentinel character (U+E000) is ordinary text; nothing stops a
    // real vault path from containing it. A real, unfragmented link must
    // still qualify.
    "accepts a MOC link to a target containing the former sentinel character (U+E000)",
    async () => {
      const puaTitle = "Foo\uE000Bar";
      const savedBytes = [
        "---",
        "type: source",
        `title: ${puaTitle}`,
        "source_url: https://example.com/foo-pua-bar",
        "requested_url: https://example.com/foo-pua-bar",
        "source_id: abc126",
        "collection: collection",
        'version: ""',
        "---",
        "FACT-IOTA2-1033",
      ].join("\n");
      const notePath = `collection/${puaTitle} abc126.md`;
      const target = notePath.replace(/\.md$/, "");
      fs.writeFileSync(path.join(vaultPath, notePath), savedBytes, "utf8");
      fs.writeFileSync(
        path.join(vaultPath, "collection", "index.md"),
        `- [[${target}]]\n`,
        "utf8",
      );

      const digest = sha256(savedBytes);
      const result = await qualifyNote({
        vaultPath,
        notePath,
        expectedDigest: digest,
        facts: ["FACT-IOTA2-1033"],
        collection: "collection",
        query: "FACT-IOTA2-1033",
        runCli: fakeRunCli({
          search: {
            code: 0,
            stdout: JSON.stringify({ results: [{ vault_path: notePath, digest }] }),
            stderr: "",
          },
          read: { code: 0, stdout: `${savedBytes}\n`, stderr: "" },
        }),
      });

      expect(result.ok).toBe(true);
    },
  );

  it("accepts a valid single wikilink with an alias, matching the publisher's own emitted syntax", async () => {
    const { notePath, savedBytes } = writeNoteAndMoc("FACT-XI-1014");
    const target = notePath.replace(/\.md$/, "");
    fs.writeFileSync(
      path.join(vaultPath, "collection", "index.md"),
      `- [[${target}|Fixture]]\n`,
      "utf8",
    );
    const digest = sha256(savedBytes);

    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: digest,
      facts: ["FACT-XI-1014"],
      collection: "collection",
      query: "FACT-XI-1014",
      runCli: fakeRunCli({
        search: {
          code: 0,
          stdout: JSON.stringify({ results: [{ vault_path: notePath, digest }] }),
          stderr: "",
        },
        read: { code: 0, stdout: `${savedBytes}\n`, stderr: "" },
      }),
    });

    expect(result.ok).toBe(true);
  });

  it("rejects when search does not resolve the note's identity", async () => {
    const { notePath, savedBytes } = writeNoteAndMoc("FACT-ETA-1007");
    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: sha256(savedBytes),
      facts: ["FACT-ETA-1007"],
      collection: "collection",
      query: "FACT-ETA-1007",
      runCli: fakeRunCli({ search: { code: 0, stdout: JSON.stringify({ results: [] }), stderr: "" } }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not resolve/);
  });

  it("rejects when read does not return the complete saved bytes", async () => {
    const { notePath, savedBytes } = writeNoteAndMoc("FACT-THETA-1008");
    const result = await qualifyNote({
      vaultPath,
      notePath,
      expectedDigest: sha256(savedBytes),
      facts: ["FACT-THETA-1008"],
      runCli: fakeRunCli({ read: { code: 0, stdout: "truncated garbage", stderr: "" } }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/complete saved bytes/);
  });
});
