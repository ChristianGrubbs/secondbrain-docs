/**
 * Process-boundary tests for the `obsidian-cli` wrapper.
 *
 * These drive real subprocesses rather than a fake, because every defect they
 * cover lives in the boundary itself: how stdout bytes are decoded, what
 * happens when the child stops reading stdin, and which exit codes the
 * installed CLI actually produces.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CasConflictError,
  classifyObsidianCliSubcommand,
  createObsidianCliRunner,
  HeadingFormatError,
  ObsidianCli,
  ObsidianCliError,
} from "./ObsidianCli";

const realCliPath = path.join(os.homedir(), "ai-stack", "bin", "obsidian-cli");
const realCliAvailable = fs.existsSync(realCliPath);

let scriptDir: string;

/** Writes an executable node script that stands in for `obsidian-cli`. */
function writeStubCli(name: string, body: string): string {
  const file = path.join(scriptDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

beforeAll(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-cli-"));
});

afterAll(() => {
  if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true });
});

describe("obsidian-cli process boundary", () => {
  it("decodes multibyte characters that straddle stdout chunk boundaries", async () => {
    // 200k copies of a 3-byte character guarantees the payload spans many
    // chunks, so any per-chunk decode produces replacement characters.
    const stub = writeStubCli(
      "big-unicode.mjs",
      `process.stdout.write("漢".repeat(200000));`,
    );
    const run = createObsidianCliRunner({ cliPath: stub });

    const result = await run(["read", "note.md", "--all"], null);

    expect(result.stdout).not.toContain("�");
    expect(result.stdout.length).toBe(200000);
    expect(result.stdout).toBe("漢".repeat(200000));
  });

  it("returns a typed failure instead of crashing when the child stops reading stdin", async () => {
    // Exits before consuming stdin, so writing a large payload raises EPIPE.
    const stub = writeStubCli(
      "early-exit.mjs",
      `process.stderr.write("obsidian-cli: refused\\n"); process.exit(1);`,
    );
    const cli = new ObsidianCli(createObsidianCliRunner({ cliPath: stub }));

    await expect(cli.createNote("note.md", "x".repeat(10_000_000))).rejects.toThrow(
      ObsidianCliError,
    );
  });

  it("surfaces a spawn failure as a rejection rather than an unhandled error", async () => {
    const run = createObsidianCliRunner({
      cliPath: path.join(scriptDir, "does-not-exist"),
    });

    await expect(run(["read", "note.md", "--all"], null)).rejects.toThrow();
  });

  it.runIf(realCliAvailable)(
    "reports both of the installed CLI's missing-note diagnostics as absent",
    async () => {
      // A note missing from an existing folder and a note whose folder does
      // not exist yet are different diagnostics, both exit 1, and both mean
      // "not there" — the second one is what every first capture into a new
      // collection reads.
      const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-absent-"));
      fs.mkdirSync(path.join(vault, "Notes"), { recursive: true });

      const cli = new ObsidianCli(
        createObsidianCliRunner({ vaultPath: vault, cliPath: realCliPath }),
      );

      expect(await cli.readNote("Notes/missing.md")).toBeNull();
      expect(await cli.readNote("Ghost/missing.md")).toBeNull();
      expect(await cli.readNoteWithAnchor("Notes/missing.md")).toBeNull();
      expect(await cli.readNoteWithAnchor("Ghost/missing.md")).toBeNull();

      fs.rmSync(vault, { recursive: true, force: true });
    },
  );

  it.runIf(realCliAvailable)(
    "round-trips an anchor through a compare-and-swap replacement",
    async () => {
      const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-cas-"));
      fs.mkdirSync(path.join(vault, "Notes"), { recursive: true });
      fs.writeFileSync(path.join(vault, "Notes", "cas.md"), "original\n");

      const cli = new ObsidianCli(
        createObsidianCliRunner({ vaultPath: vault, cliPath: realCliPath }),
      );

      const snapshot = await cli.readNoteWithAnchor("Notes/cas.md");
      expect(snapshot?.markdown).toBe("original\n");
      expect(snapshot?.anchor).toMatch(/^sha256:[0-9a-f]+$/);

      await cli.replaceNote("Notes/cas.md", "replaced\n", snapshot?.anchor ?? "");
      expect(fs.readFileSync(path.join(vault, "Notes", "cas.md"), "utf8")).toBe(
        "replaced\n",
      );

      // The burnt anchor must never write again.
      await expect(
        cli.replaceNote("Notes/cas.md", "third\n", snapshot?.anchor ?? ""),
      ).rejects.toThrow(CasConflictError);
      expect(fs.readFileSync(path.join(vault, "Notes", "cas.md"), "utf8")).toBe(
        "replaced\n",
      );

      fs.rmSync(vault, { recursive: true, force: true });
    },
  );

  it.runIf(realCliAvailable)(
    "maps the installed CLI's setext refusal to HeadingFormatError",
    async () => {
      // The installed CLI reports this as exit 1, not the exit 4 its help
      // text implies, so the wrapper must recognise the diagnostic.
      const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-setext-"));
      fs.mkdirSync(path.join(vault, "Notes"), { recursive: true });
      fs.writeFileSync(
        path.join(vault, "Notes", "setext.md"),
        "Source Captures\n===============\n\n## Sources\n",
      );

      const cli = new ObsidianCli(
        createObsidianCliRunner({ vaultPath: vault, cliPath: realCliPath }),
      );

      await expect(
        cli.insertUnderHeading("Notes/setext.md", "## Sources", "- x"),
      ).rejects.toThrow(HeadingFormatError);

      fs.rmSync(vault, { recursive: true, force: true });
    },
  );
  it("reports a directory that does not exist as absent, not as a failure", async () => {
    // The installed CLI has two phrasings for "no such directory", and only
    // one was recognised: a path that exists as a file says `not a directory`,
    // a path with no entry at all says `no such directory for:`. Treating the
    // second as a hard failure broke the first capture into any collection
    // outside the inbox, whose parent folder does not exist yet.
    for (const diagnostic of [
      "obsidian-cli: not a directory: 30 Tools-Models/Doc Sets",
      "obsidian-cli: no such directory for: 30 Tools-Models/Doc Sets",
    ]) {
      const cli = new ObsidianCli(async () => ({
        code: 1,
        stdout: "",
        stderr: `${diagnostic}\n`,
      }));

      await expect(cli.listDirectory("30 Tools-Models/Doc Sets")).resolves.toBeNull();
    }
  });

  it.runIf(realCliAvailable)(
    "reports an absent collection parent as absent against the installed CLI",
    async () => {
      const vault = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-listdir-"));
      const cli = new ObsidianCli(
        createObsidianCliRunner({ vaultPath: vault, cliPath: realCliPath }),
      );

      await expect(cli.listDirectory("30 Tools-Models/Doc Sets")).resolves.toBeNull();

      fs.rmSync(vault, { recursive: true, force: true });
    },
  );
});

describe("classifyObsidianCliSubcommand", () => {
  it("buckets list and read as their own categories, mutating verbs as write, and store-key as other", () => {
    expect(classifyObsidianCliSubcommand("list")).toBe("list");
    expect(classifyObsidianCliSubcommand("read")).toBe("read");
    for (const write of [
      "create",
      "write",
      "append",
      "section-insert",
      "move",
      "redirect-sweep",
    ]) {
      expect(classifyObsidianCliSubcommand(write)).toBe("write");
    }
    expect(classifyObsidianCliSubcommand("store-key")).toBe("other");
    expect(classifyObsidianCliSubcommand("status")).toBe("other");
  });
});

describe(// MINOR 7 (2026-09-13 Codex frontier review): one JSONL
// `vault.cli_invoked` event per spawned obsidian-cli subprocess, so M-row
// measurements can report actual subprocess/list/read/write counts
// instead of only lock/upsert counts.
"createObsidianCliRunner logging", () => {
  it("emits a vault.cli_invoked event with the subcommand and its category for every spawn", async () => {
    const stub = writeStubCli("logging-stub.mjs", `process.stdout.write("ok");`);
    const events: Array<{ event: string; ctx?: Record<string, unknown> }> = [];
    const run = createObsidianCliRunner({
      cliPath: stub,
      logger: (event) => {
        events.push({ event: event.event, ctx: event.ctx });
      },
    });

    await run(["read", "note.md", "--all"], null);
    await run(["list", "some/folder"], null);

    expect(events).toEqual([
      { event: "vault.cli_invoked", ctx: { subcommand: "read", category: "read" } },
      { event: "vault.cli_invoked", ctx: { subcommand: "list", category: "list" } },
    ]);
  });
});
