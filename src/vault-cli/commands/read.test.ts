/**
 * Tests for `sb-docs read`: it returns the complete saved note through
 * `obsidian-cli`, never a reassembly of index chunks.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianCli } from "../../vault/ObsidianCli";
import type { CliResult } from "../../vault/types";
import { createVaultCli } from "../index";

/** In-memory stand-in for `obsidian-cli`, recording every invocation. */
class FakeVault {
  readonly notes = new Map<string, string>();
  readonly calls: string[][] = [];

  run = async (args: string[], _stdin: string | null): Promise<CliResult> => {
    this.calls.push(args);
    const [command, target] = args;
    if (command !== "read") {
      return { code: 2, stdout: "", stderr: `unexpected subcommand: ${command}` };
    }
    const existing = this.notes.get(target);
    if (existing === undefined) {
      return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${target}` };
    }
    return { code: 0, stdout: existing, stderr: "" };
  };
}

const NOTE_PATH = "00 Inbox/Source Captures/Immich CLI 0123456789ab.md";
const NOTE = `---
type: source
title: "Immich CLI"
source_url: https://immich.app/docs/cli
---
# Immich CLI

Unicode: Résumé — 日本語 ✅

\`\`\`bash
immich upload --recursive ./photos
\`\`\`
`;

let vault: FakeVault;
let out: string[];
let err: string[];
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  vault = new FakeVault();
  out = [];
  err = [];
  previousExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = previousExitCode;
});

/** Runs `sb-docs read` with an injected vault and output sinks. */
async function runRead(args: string[]): Promise<void> {
  await createVaultCli(["read", ...args], {
    read: {
      cli: new ObsidianCli(vault.run),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  })
    .exitProcess(false)
    .fail(false)
    .parseAsync();
}

describe("sb-docs read", () => {
  it("prints the complete note exactly as the vault holds it", async () => {
    vault.notes.set(NOTE_PATH, NOTE);

    await runRead([NOTE_PATH]);

    expect(out).toEqual([NOTE]);
    expect(err).toEqual([]);
    expect(process.exitCode).not.toBe(1);
  });

  it("reads the whole note rather than a range or a chunk", async () => {
    vault.notes.set(NOTE_PATH, NOTE);

    await runRead([NOTE_PATH]);

    expect(vault.calls).toEqual([["read", NOTE_PATH, "--all"]]);
  });

  it("reports a missing note and exits nonzero", async () => {
    await runRead(["00 Inbox/Source Captures/Nothing Here.md"]);

    expect(out).toEqual([]);
    expect(err).toEqual(["❌ no such note: 00 Inbox/Source Captures/Nothing Here.md"]);
    expect(process.exitCode).toBe(1);
  });
});
