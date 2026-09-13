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
