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
});
