/**
 * Tests for `sb-docs doctor`: it reports durable state and adopts a note on an
 * explicit operator instruction, and it never deletes anything.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256, sourceId } from "../../vault/identity";
import { ObsidianCli } from "../../vault/ObsidianCli";
import { PublicationJournal } from "../../vault/PublicationJournal";
import type { CliResult, SourceDocument } from "../../vault/types";
import { VaultPublisher } from "../../vault/VaultPublisher";
import { createVaultCli } from "../index";

/** In-memory stand-in for the `obsidian-cli` process, create/read/write only. */
class FakeVault {
  readonly notes = new Map<string, string>();

  anchorOf(notePath: string): string {
    const existing = this.notes.get(notePath);
    return existing === undefined ? "sha256:<absent>" : `sha256:${sha256(existing)}`;
  }

  run = async (args: string[], stdin: string | null): Promise<CliResult> => {
    const [command, target] = args;

    if (command === "create") {
      if (this.notes.has(target)) {
        return { code: 3, stdout: "", stderr: "obsidian-cli: note changed" };
      }
      this.notes.set(target, stdin ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "write") {
      const ifMatchIndex = args.indexOf("--if-match");
      const expected = ifMatchIndex === -1 ? null : args[ifMatchIndex + 1];
      if (expected !== null && expected !== this.anchorOf(target)) {
        return { code: 3, stdout: "", stderr: "obsidian-cli: note changed" };
      }
      this.notes.set(target, stdin ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "read") {
      const existing = this.notes.get(target);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${target}` };
      }
      return {
        code: 0,
        stdout: existing,
        stderr: args.includes("--with-anchor")
          ? `anchor: ${this.anchorOf(target)}\n`
          : "",
      };
    }

    if (command === "section-insert") {
      const existing = this.notes.get(target);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${target}` };
      }
      const lines = existing.split("\n");
      const at = lines.indexOf(args[2]);
      if (at === -1) {
        return { code: 1, stdout: "", stderr: "obsidian-cli: heading not found" };
      }
      lines.splice(at + 1, 0, stdin ?? "");
      this.notes.set(target, lines.join("\n"));
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "list") {
      const dir = target.replace(/\/$/, "");
      const entries = new Set<string>();
      for (const candidate of this.notes.keys()) {
        if (!candidate.startsWith(`${dir}/`)) continue;
        const head = candidate.slice(dir.length + 1).split("/")[0];
        if (head) entries.add(`${dir}/${head}`);
      }
      if (entries.size === 0) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a directory: ${dir}` };
      }
      return { code: 0, stdout: `${[...entries].sort().join("\n")}\n`, stderr: "" };
    }

    return { code: 2, stdout: "", stderr: `unknown subcommand: ${command}` };
  };
}

const temporaries: string[] = [];
let stateDir: string;
let vaultDir: string;
let vault: FakeVault;
let out: string[];
let err: string[];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

const document: SourceDocument = {
  sourceUrl: "https://docs.astral.sh/uv/guides/projects/",
  requestedUrl: "https://docs.astral.sh/uv/guides/projects/",
  collection: "inbox",
  version: "",
  title: "Working on Projects with uv",
  markdown: "# uv Projects\n\nBody.\n",
  sourceContentType: "text/html",
  capturedAt: "2026-09-10T12:00:00.000Z",
};

beforeEach(() => {
  stateDir = makeTempDir("sb-docs-doctor-state-");
  vaultDir = makeTempDir("sb-docs-doctor-vault-");
  vault = new FakeVault();
  out = [];
  err = [];
});

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `sb-docs doctor` with injected state, vault and output sinks. */
async function runDoctor(args: string[]): Promise<void> {
  await createVaultCli(["doctor", ...args], {
    doctor: {
      stateDir,
      vaultPath: vaultDir,
      cli: new ObsidianCli(vault.run),
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  })
    .exitProcess(false)
    .fail(false)
    .parseAsync();
}

/** Parses the single JSON envelope a `--json` run prints. */
function envelope(): Record<string, unknown> {
  return JSON.parse(out.join("\n"));
}

function makePublisher(): VaultPublisher {
  return new VaultPublisher(new ObsidianCli(vault.run), {
    stateDir,
    vaultPath: vaultDir,
    lock: { timeoutMs: 2000, pollMs: 5 },
  });
}

describe("sb-docs doctor", () => {
  it("reports the state directory, the vault and an empty journal", async () => {
    await runDoctor(["--json"]);

    const report = envelope();
    expect(report.stateDir).toBe(fs.realpathSync(stateDir));
    expect(report.vaultPath).toBe(vaultDir);
    expect(report.pending).toEqual([]);
    expect(report.ownershipCount).toBe(0);
  });

  it("prints a human-readable report without --json", async () => {
    await makePublisher().publish(document);

    await runDoctor([]);

    const text = out.join("\n");
    expect(text).toContain(stateDir);
    expect(text).toContain("ownership records: 1");
    expect(text).toContain("pending journal entries: 0");
  });

  it("reports the per-source locks it can see", async () => {
    await makePublisher().publish(document);

    await runDoctor(["--json"]);

    const locks = envelope().locks as {
      source: string;
      ownerToken: string | null;
      busy: boolean;
    }[];
    expect(locks).toHaveLength(1);
    expect(locks[0].busy).toBe(false);
    expect(typeof locks[0].ownerToken).toBe("string");
  });

  it("names the locks in its human-readable report", async () => {
    await makePublisher().publish(document);

    await runDoctor([]);

    expect(out.join("\n")).toContain("locks: 1");
  });

  it("classifies a pending journal entry it can resume", async () => {
    const publication = await makePublisher().publish(document);
    const journal = new PublicationJournal({ stateDir, vaultPath: vaultDir });
    journal.prepare({
      sourceId: sourceId(document),
      path: publication.path,
      priorWholeNoteDigest: publication.digest,
      proposedWholeNoteDigest: publication.digest,
      bytes: publication.markdown,
    });
    journal.advance(sourceId(document), "note-written");

    await runDoctor(["--json"]);

    const report = envelope();
    const pending = report.pending as { classification: string; phase: string }[];
    expect(pending).toHaveLength(1);
    expect(pending[0].classification).toBe("resumable");
    expect(pending[0].phase).toBe("note-written");
  });

  it("classifies a pending entry over a manually edited note as a conflict", async () => {
    const publication = await makePublisher().publish(document);
    const journal = new PublicationJournal({ stateDir, vaultPath: vaultDir });
    journal.prepare({
      sourceId: sourceId(document),
      path: publication.path,
      priorWholeNoteDigest: sha256("something else entirely"),
      proposedWholeNoteDigest: sha256("a proposal never written"),
      bytes: "---\ntype: source\n---\nproposed\n",
    });

    await runDoctor(["--json"]);

    const pending = (envelope().pending as { classification: string }[])[0];
    expect(pending.classification).toBe("conflict");
  });

  it("leaves pending state in place rather than clearing it", async () => {
    const publication = await makePublisher().publish(document);
    const journal = new PublicationJournal({ stateDir, vaultPath: vaultDir });
    journal.prepare({
      sourceId: sourceId(document),
      path: publication.path,
      priorWholeNoteDigest: null,
      proposedWholeNoteDigest: sha256("x"),
      bytes: "---\ntype: source\n---\nproposed\n",
    });

    await runDoctor(["--json"]);

    expect(
      new PublicationJournal({ stateDir, vaultPath: vaultDir }).pending(),
    ).toHaveLength(1);
    expect(fs.existsSync(path.join(stateDir, "journal"))).toBe(true);
  });

  it("adopts a note's current bytes as the new baseline and prints the digest", async () => {
    const publication = await makePublisher().publish(document);
    const edited = `${publication.markdown}\nA human paragraph.\n`;
    vault.notes.set(publication.path, edited);

    await runDoctor(["--adopt", publication.path, "--json"]);

    const report = envelope();
    expect(report.adopted).toMatchObject({
      path: publication.path,
      digest: sha256(edited),
      sourceId: sourceId(document),
    });
    expect(
      new PublicationJournal({ stateDir, vaultPath: vaultDir }).readOwnership(
        sourceId(document),
      ),
    ).toMatchObject({ path: publication.path, digest: sha256(edited) });
    // The note itself is never rewritten by adoption.
    expect(vault.notes.get(publication.path)).toBe(edited);
  });

  it("turns a later capture of an adopted note into a replacement", async () => {
    const publication = await makePublisher().publish(document);
    const edited = `${publication.markdown}\nA human paragraph.\n`;
    vault.notes.set(publication.path, edited);

    const beforeAdoption = await makePublisher().publish({
      ...document,
      markdown: "# uv Projects\n\nUpstream changed.\n",
    });
    expect(beforeAdoption.status).toBe("conflict");

    await runDoctor(["--adopt", publication.path]);

    const afterAdoption = await makePublisher().publish({
      ...document,
      markdown: "# uv Projects\n\nUpstream changed.\n",
    });
    expect(afterAdoption.status).toBe("replaced");
    expect(vault.notes.get(publication.path)).toContain("Upstream changed.");
  });

  it("refuses to adopt a note that does not exist", async () => {
    await expect(runDoctor(["--adopt", "00 Inbox/nope.md"])).rejects.toThrow(/not/i);
    expect(
      new PublicationJournal({ stateDir, vaultPath: vaultDir }).ownershipCount(),
    ).toBe(0);
  });

  it("refuses to adopt a note that carries no source id", async () => {
    vault.notes.set("00 Inbox/hand written.md", "# Mine\n");

    await expect(runDoctor(["--adopt", "00 Inbox/hand written.md"])).rejects.toThrow(
      /source_id/,
    );
    expect(
      new PublicationJournal({ stateDir, vaultPath: vaultDir }).ownershipCount(),
    ).toBe(0);
  });

  it("keeps diagnostics off the JSON stream", async () => {
    await runDoctor(["--json"]);

    expect(() => envelope()).not.toThrow();
    expect(out).toHaveLength(1);
  });

  it("refuses a state directory inside the vault", async () => {
    await expect(
      createVaultCli(["doctor", "--json"], {
        doctor: {
          stateDir: path.join(vaultDir, "state"),
          vaultPath: vaultDir,
          cli: new ObsidianCli(vault.run),
          stdout: (line) => out.push(line),
          stderr: (line) => err.push(line),
        },
      })
        .exitProcess(false)
        .fail(false)
        .parseAsync(),
    ).rejects.toThrow(/vault/i);
  });
});
