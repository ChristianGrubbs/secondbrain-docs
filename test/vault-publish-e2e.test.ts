/**
 * End-to-end publication against a real `obsidian-cli` process and a throwaway
 * vault.
 *
 * The first test is a safety gate, not a nicety: it proves — read-only, before
 * anything is mutated — that the CLI honours the `OBSIDIAN_VAULT` override. If
 * that assumption were wrong, every later test in this file would write into
 * the operator's live vault.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectionIndexPath, notePath, sha256, sourceId } from "../src/vault/identity";
import { createObsidianCliRunner, ObsidianCli } from "../src/vault/ObsidianCli";
import { PublicationJournal } from "../src/vault/PublicationJournal";
import type { SourceDocument } from "../src/vault/types";
import {
  SOURCE_UPDATES_INDEX,
  SOURCE_UPDATES_PATH,
  VaultPublisher,
} from "../src/vault/VaultPublisher";
import { createVaultCli } from "../src/vault-cli/index";

const cliPath = path.join(os.homedir(), "ai-stack", "bin", "obsidian-cli");
const cliAvailable = fs.existsSync(cliPath);
const LIVE_VAULT = "/Volumes/3M/Obsidian";

const SOURCE_MARKDOWN = `# Immich CLI

Unicode: Résumé — “quoted” — 日本語 ✅

| Command | Purpose |
| --- | --- |
| \`immich upload\` | Upload assets |

\`\`\`bash
immich upload --recursive ./photos
\`\`\`

Literal, never expanded: \`$(rm -rf /)\` and \${HOME}.
`;

/**
 * Reports whether the CLI at `cliPath` actually operates on `vaultPath` when
 * `OBSIDIAN_VAULT` names it.
 *
 * `status` is read-only, so this can be checked before any mutation. A CLI
 * that ignores the override — or fails to run at all — reports false.
 */
function honoursVaultOverride(cliPath: string, vaultPath: string): boolean {
  try {
    const status = execFileSync(cliPath, ["status"], {
      encoding: "utf8",
      env: { ...process.env, OBSIDIAN_VAULT: vaultPath },
    });
    return status.includes(`vault: ok (${vaultPath})`);
  } catch {
    return false;
  }
}

const document: SourceDocument = {
  sourceUrl: "https://docs.immich.app/features/command-line-interface/",
  requestedUrl: "https://docs.immich.app/features/command-line-interface/",
  collection: "inbox",
  version: "",
  title: "Immich CLI",
  markdown: SOURCE_MARKDOWN,
  sourceContentType: "text/html",
  capturedAt: "2026-09-10T12:00:00.000Z",
};

describe.skipIf(!cliAvailable)("vault publication E2E", () => {
  let sandbox: string;
  let stateDir: string;
  let publisher: VaultPublisher;

  /** Builds a publisher over the sandbox vault and the throwaway state dir. */
  const makePublisher = (): VaultPublisher =>
    new VaultPublisher(
      new ObsidianCli(createObsidianCliRunner({ vaultPath: sandbox, cliPath })),
      { stateDir, vaultPath: sandbox, publisherVersion: "0.0.0-test" },
    );

  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-vault-"));
    // Runtime state is durable and must never live inside a vault, not even a
    // throwaway one.
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-e2e-state-"));
    fs.mkdirSync(path.join(sandbox, "00 Inbox"), { recursive: true });

    // GATE. This runs before the publisher exists, so nothing in this file can
    // mutate a vault until the override is proven — including when a single
    // test is selected by name, because beforeAll always runs.
    if (!honoursVaultOverride(cliPath, sandbox)) {
      throw new Error(
        `REFUSING TO RUN: obsidian-cli did not report the sandbox vault ${sandbox}. ` +
          "Publishing now could mutate the operator's live vault.",
      );
    }

    publisher = makePublisher();
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("ran the override gate before constructing the publisher", () => {
    // The gate itself lives in beforeAll; this documents it and re-asserts.
    expect(honoursVaultOverride(cliPath, sandbox)).toBe(true);
  });

  it("detects a CLI that ignores the override", () => {
    const stub = path.join(sandbox, "lying-cli.mjs");
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env node\nconsole.log("vault: ok (${LIVE_VAULT})");\n`,
      { mode: 0o755 },
    );

    expect(honoursVaultOverride(stub, sandbox)).toBe(false);
  });

  it("writes the note bytes the publisher reported", async () => {
    const publication = await publisher.publish(document);

    expect(publication.status).toBe("published");
    expect(publication.path).toBe(notePath(document));

    const onDisk = fs.readFileSync(path.join(sandbox, publication.path), "utf8");
    expect(onDisk).toBe(publication.markdown);
    expect(sha256(onDisk)).toBe(publication.digest);
  });

  it("preserves the source body verbatim through a real process boundary", () => {
    const onDisk = fs.readFileSync(path.join(sandbox, notePath(document)), "utf8");
    const body = onDisk.split("\n---\n").slice(1).join("\n---\n");

    expect(body).toBe(SOURCE_MARKDOWN);
    expect(body).toContain("$(rm -rf /)");
    expect(body).toContain("日本語 ✅");
    expect(body).toContain("| `immich upload` | Upload assets |");
  });

  it("links the note exactly once from the collection index", async () => {
    // A second capture of identical content must not add a second link.
    const second = await publisher.publish(document);
    expect(second.status).toBe("unchanged");
    expect(second.moc).toBe("linked");

    const index = fs.readFileSync(path.join(sandbox, collectionIndexPath("inbox")), "utf8");
    const target = notePath(document).replace(/\.md$/, "");
    const links = index.split("\n").filter((line) => line.includes(target));

    expect(index).toContain("## Sources");
    expect(links).toHaveLength(1);
  });

  it("reads the published note back through obsidian-cli", async () => {
    const cli = new ObsidianCli(createObsidianCliRunner({ vaultPath: sandbox }));
    const readBack = await cli.readNote(notePath(document));

    expect(readBack).toContain("source_id:");
    expect(readBack).toContain("publisher: secondbrain-docs");
    expect(readBack).toContain("日本語 ✅");
  });

  it("replaces its own note through a real compare-and-swap write", async () => {
    const changed = { ...document, markdown: `${SOURCE_MARKDOWN}\nA new section.\n` };

    const publication = await publisher.publish(changed);

    expect(publication.status).toBe("replaced");
    expect(publication.path).toBe(notePath(document));
    const onDisk = fs.readFileSync(path.join(sandbox, publication.path), "utf8");
    expect(onDisk).toBe(publication.markdown);
    expect(onDisk).toContain("A new section.");
    expect(sha256(onDisk)).toBe(publication.digest);

    // Still one link, and still exactly one note in the collection.
    const index = fs.readFileSync(path.join(sandbox, collectionIndexPath("inbox")), "utf8");
    const target = notePath(document).replace(/\.md$/, "");
    expect(index.split("\n").filter((line) => line.includes(target))).toHaveLength(1);
  });

  it("preserves a human edit and writes a real incoming candidate", async () => {
    const notePathOnDisk = path.join(sandbox, notePath(document));
    const handEdited = `${fs.readFileSync(notePathOnDisk, "utf8")}\n\nA human wrote this.\n`;
    fs.writeFileSync(notePathOnDisk, handEdited);

    const publication = await publisher.publish({
      ...document,
      markdown: `${SOURCE_MARKDOWN}\nUpstream moved on.\n`,
    });

    expect(publication.status).toBe("conflict");
    expect(publication.conflictReason).toBe("manual-edit");
    // The human's bytes are still there, byte for byte.
    expect(fs.readFileSync(notePathOnDisk, "utf8")).toBe(handEdited);

    const candidate = publication.candidatePath ?? "";
    expect(candidate.startsWith(`${SOURCE_UPDATES_PATH}/`)).toBe(true);
    expect(fs.readFileSync(path.join(sandbox, candidate), "utf8")).toContain(
      "Upstream moved on.",
    );
    const updatesIndex = fs.readFileSync(path.join(sandbox, SOURCE_UPDATES_INDEX), "utf8");
    expect(
      updatesIndex.split("\n").filter((line) => line.includes(candidate.replace(/\.md$/, ""))),
    ).toHaveLength(1);
  });

  it("reports that state through a real doctor run", async () => {
    const lines: string[] = [];

    await createVaultCli(["doctor", "--json"], {
      doctor: {
        stateDir,
        vaultPath: sandbox,
        cli: new ObsidianCli(createObsidianCliRunner({ vaultPath: sandbox, cliPath })),
        stdout: (line) => lines.push(line),
        stderr: () => undefined,
      },
    })
      .exitProcess(false)
      .fail(false)
      .parseAsync();

    const report = JSON.parse(lines.join("\n"));
    expect(report.stateDir).toBe(fs.realpathSync(stateDir));
    expect(report.vaultPath).toBe(sandbox);
    expect(report.ownershipCount).toBeGreaterThan(0);
    // Every publication above ran to completion, so nothing is pending.
    expect(report.pending).toEqual([]);
  });

  describe("recovery after real process death", () => {
    const viteNode = path.join(process.cwd(), "node_modules", ".bin", "vite-node");
    const fixture = path.join(process.cwd(), "test", "fixtures", "vault", "publish-crash.ts");

    /**
     * Publishes one source in a child process that SIGKILLs itself at a chosen
     * journal phase.
     *
     * @returns The child's exit signal, which proves it was killed rather than
     *   having returned normally.
     */
    function publishAndDie(options: {
      crashAt: string;
      sourceUrl: string;
      title: string;
      body: string;
    }): Promise<NodeJS.Signals | null> {
      const bodyFile = path.join(stateDir, `body-${Buffer.from(options.title).toString("hex")}.md`);
      fs.writeFileSync(bodyFile, options.body);

      return new Promise((resolve, reject) => {
        // A fresh discovery cache per child is the point: each run is a
        // separate process, exactly as a real capture would be.
        const child = spawn(viteNode, [fixture], {
          env: {
            ...process.env,
            VAULT_PATH: sandbox,
            STATE_DIR: stateDir,
            CLI_PATH: cliPath,
            CRASH_AT: options.crashAt,
            SOURCE_URL: options.sourceUrl,
            TITLE: options.title,
            BODY_FILE: bodyFile,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code, signal) => {
          if (signal === null && code !== 0) {
            reject(new Error(`child failed (${code}): ${stderr}`));
            return;
          }
          resolve(signal);
        });
      });
    }

    it("recovers a capture whose process was killed after the note was written", async () => {
      const signal = await publishAndDie({
        crashAt: "note-written",
        sourceUrl: "https://example.invalid/killed-after-write",
        title: "Killed After Write",
        body: "# Killed After Write\n\nBody that reached the vault.\n",
      });
      expect(signal).toBe("SIGKILL");

      const journal = new PublicationJournal({ stateDir, vaultPath: sandbox });
      const pending = journal.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0].phase).toBe("note-written");

      const onDisk = fs.readFileSync(path.join(sandbox, pending[0].path), "utf8");
      expect(sha256(onDisk)).toBe(pending[0].proposedWholeNoteDigest);

      const report = await makePublisher().recoverPending();

      expect(report[0].classification).toBe("resumable");
      expect(report[0].completed).toBe(true);
      // The bytes the dead process wrote are still exactly the bytes on disk.
      expect(fs.readFileSync(path.join(sandbox, pending[0].path), "utf8")).toBe(onDisk);
      expect(new PublicationJournal({ stateDir, vaultPath: sandbox }).pending()).toEqual([]);

      const index = fs.readFileSync(path.join(sandbox, collectionIndexPath("inbox")), "utf8");
      const target = pending[0].path.replace(/\.md$/, "");
      expect(index.split("\n").filter((line) => line.includes(target))).toHaveLength(1);
    }, 120_000);

    it("recovers a capture killed before its journal entry was pruned", async () => {
      const signal = await publishAndDie({
        crashAt: "before-prune",
        sourceUrl: "https://example.invalid/killed-before-prune",
        title: "Killed Before Prune",
        body: "# Killed Before Prune\n\nFully published, never pruned.\n",
      });
      expect(signal).toBe("SIGKILL");

      const journal = new PublicationJournal({ stateDir, vaultPath: sandbox });
      const pending = journal.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0].phase).toBe("complete");
      const notePathOnDisk = path.join(sandbox, pending[0].path);
      const onDisk = fs.readFileSync(notePathOnDisk, "utf8");

      const report = await makePublisher().recoverPending();

      expect(report[0].completed).toBe(true);
      expect(new PublicationJournal({ stateDir, vaultPath: sandbox }).pending()).toEqual([]);
      expect(fs.readFileSync(notePathOnDisk, "utf8")).toBe(onDisk);
    }, 120_000);

    it("exits on its own after a capture, leaving no handle behind", async () => {
      // The lock heartbeat is a timer. If it were not unreferenced and cleared,
      // a process that finished its work would sit there forever, and this
      // promise — which only settles on close — would never resolve.
      const signal = await publishAndDie({
        crashAt: "none",
        sourceUrl: "https://example.invalid/exits-cleanly",
        title: "Exits Cleanly",
        body: "# Exits Cleanly\n\nBody.\n",
      });

      expect(signal).toBeNull();
    }, 120_000);

    it("exits after a real doctor run over the same state", async () => {
      const result = await new Promise<{ code: number | null; stdout: string }>(
        (resolve, reject) => {
          const child = spawn(
            viteNode,
            [
              path.join(process.cwd(), "src", "vault-cli", "main.ts"),
              "doctor",
              "--json",
              "--state-dir",
              stateDir,
            ],
            {
              env: { ...process.env, OBSIDIAN_VAULT: sandbox },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout }));
        },
      );

      expect(result.code).toBe(0);
      const report = JSON.parse(
        result.stdout.split("\n").find((line) => line.startsWith("{")) ?? "{}",
      );
      expect(report.vaultPath).toBe(sandbox);
      expect(report.ownershipCount).toBeGreaterThan(0);
    }, 120_000);

    it("does not trust a candidate whose baseline was never confirmed", async () => {
      const sourceUrl = "https://example.invalid/killed-mid-candidate";
      const body = "# Killed Mid Candidate\n\nOriginal body.\n";

      // Publish it, then let a human take the note over, so the next capture
      // has to preserve it and write an incoming candidate.
      await publishAndDie({ crashAt: "none", sourceUrl, title: "Killed Mid Candidate", body });
      const notePathOnDisk = path.join(
        sandbox,
        notePath({ ...document, sourceUrl, requestedUrl: sourceUrl, title: "Killed Mid Candidate" }),
      );
      fs.writeFileSync(notePathOnDisk, "# A human took this over\n");

      // The child dies between creating the candidate and confirming its
      // baseline in durable state.
      const signal = await publishAndDie({
        crashAt: "candidate-record",
        sourceUrl,
        title: "Killed Mid Candidate",
        body: `${body}\nUpstream changed.\n`,
      });
      expect(signal).toBe("SIGKILL");

      // Candidates are content addressed by source, and earlier tests in this
      // sandbox left their own, so only this source's are counted.
      const mine = sourceId({
        ...document,
        sourceUrl,
        requestedUrl: sourceUrl,
        title: "Killed Mid Candidate",
      }).slice(0, 12);
      const candidatesFor = () =>
        fs
          .readdirSync(path.join(sandbox, SOURCE_UPDATES_PATH))
          .filter((name) => name.startsWith(mine));

      const candidates = candidatesFor();
      expect(candidates).toHaveLength(1);
      const candidateOnDisk = path.join(sandbox, SOURCE_UPDATES_PATH, candidates[0]);

      // A metadata-only edit is semantically identical, so only a whole-note
      // baseline can catch it.
      const edited = fs
        .readFileSync(candidateOnDisk, "utf8")
        .replace(/^captured_at:.*$/m, "captured_at: 2027-03-03T03:03:03.000Z");
      fs.writeFileSync(candidateOnDisk, edited);

      const retried = await makePublisher().publish({
        ...document,
        sourceUrl,
        requestedUrl: sourceUrl,
        title: "Killed Mid Candidate",
        markdown: `${body}\nUpstream changed.\n`,
      });

      expect(retried.status).toBe("conflict");
      expect(retried.conflictReason).toBe("candidate-modified");
      expect(fs.readFileSync(candidateOnDisk, "utf8")).toBe(edited);
      expect(candidatesFor()).toHaveLength(1);
      expect(fs.readFileSync(notePathOnDisk, "utf8")).toBe("# A human took this over\n");
    }, 120_000);

    it("leaves a capture killed before its write retryable, with nothing written", async () => {
      const signal = await publishAndDie({
        crashAt: "prepared",
        sourceUrl: "https://example.invalid/killed-before-write",
        title: "Killed Before Write",
        body: "# Killed Before Write\n\nNever reached the vault.\n",
      });
      expect(signal).toBe("SIGKILL");

      const journal = new PublicationJournal({ stateDir, vaultPath: sandbox });
      const pending = journal.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0].phase).toBe("prepared");
      expect(fs.existsSync(path.join(sandbox, pending[0].path))).toBe(false);

      const report = await makePublisher().recoverPending();
      expect(report[0].classification).toBe("retryable");
      expect(report[0].completed).toBe(false);

      // The dead process also left its lock behind; a retry has to reclaim it.
      const retried = await makePublisher().publish({
        ...document,
        sourceUrl: "https://example.invalid/killed-before-write",
        requestedUrl: "https://example.invalid/killed-before-write",
        title: "Killed Before Write",
        markdown: "# Killed Before Write\n\nNever reached the vault.\n",
      });
      expect(retried.status).toBe("published");
      expect(fs.existsSync(path.join(sandbox, retried.path))).toBe(true);
    }, 120_000);
  });

  it("leaves the operator's live vault untouched", () => {
    if (!fs.existsSync(LIVE_VAULT)) return;
    expect(fs.existsSync(path.join(LIVE_VAULT, notePath(document)))).toBe(false);
  });
});
