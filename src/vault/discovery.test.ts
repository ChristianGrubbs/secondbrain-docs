/**
 * Tests for source discovery: the recursive scan that freezes a note's path to
 * its `source_id` rather than to its title.
 */

import { describe, expect, it } from "vitest";
import { discoverSources } from "./discovery";
import { ObsidianCli } from "./ObsidianCli";
import type { CliResult } from "./types";

/** Minimal read/list stand-in for `obsidian-cli`, holding note bytes. */
class FakeVault {
  readonly notes = new Map<string, string>();
  readonly reads: string[] = [];
  readonly lists: string[] = [];

  run = async (args: string[], _stdin: string | null): Promise<CliResult> => {
    const [command, target] = args;

    if (command === "list") {
      this.lists.push(target);
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

    if (command === "read") {
      this.reads.push(target);
      const existing = this.notes.get(target);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${target}` };
      }
      return { code: 0, stdout: existing, stderr: "" };
    }

    return { code: 2, stdout: "", stderr: `unexpected subcommand: ${command}` };
  };
}

/** Builds a managed-looking note carrying one `source_id`. */
function note(sourceId: string, title = "A Title"): string {
  return `---\ntype: source\ntitle: ${JSON.stringify(title)}\nsource_id: ${sourceId}\n---\nbody\n`;
}

const FOLDER = "00 Inbox/Source Captures";

describe("discoverSources", () => {
  it("returns an empty map for a folder that does not exist", async () => {
    const vault = new FakeVault();

    const map = await discoverSources({
      cli: new ObsidianCli(vault.run),
      collectionPath: FOLDER,
    });

    expect(map.size).toBe(0);
  });

  it("maps each source id to the note that carries it", async () => {
    const vault = new FakeVault();
    vault.notes.set(`${FOLDER}/first aaaa.md`, note("aaaa"));
    vault.notes.set(`${FOLDER}/second bbbb.md`, note("bbbb"));

    const map = await discoverSources({
      cli: new ObsidianCli(vault.run),
      collectionPath: FOLDER,
    });

    expect(map.get("aaaa")).toEqual([`${FOLDER}/first aaaa.md`]);
    expect(map.get("bbbb")).toEqual([`${FOLDER}/second bbbb.md`]);
  });

  it("recurses into subfolders, which the CLI's one-level list does not do", async () => {
    const vault = new FakeVault();
    vault.notes.set(`${FOLDER}/nested/deep/third cccc.md`, note("cccc"));

    const map = await discoverSources({
      cli: new ObsidianCli(vault.run),
      collectionPath: FOLDER,
    });

    expect(map.get("cccc")).toEqual([`${FOLDER}/nested/deep/third cccc.md`]);
  });

  it("coerces a numeric source id to a string", async () => {
    const vault = new FakeVault();
    vault.notes.set(
      `${FOLDER}/numeric 12345.md`,
      "---\ntype: source\nsource_id: 12345\n---\nbody\n",
    );

    const map = await discoverSources({
      cli: new ObsidianCli(vault.run),
      collectionPath: FOLDER,
    });

    expect(map.get("12345")).toEqual([`${FOLDER}/numeric 12345.md`]);
  });

  it("reports a duplicate source id as two paths rather than picking one", async () => {
    const vault = new FakeVault();
    vault.notes.set(`${FOLDER}/original aaaa.md`, note("aaaa", "Original"));
    vault.notes.set(`${FOLDER}/copy aaaa.md`, note("aaaa", "A Copy"));

    const map = await discoverSources({
      cli: new ObsidianCli(vault.run),
      collectionPath: FOLDER,
    });

    expect(map.get("aaaa")).toEqual([
      `${FOLDER}/copy aaaa.md`,
      `${FOLDER}/original aaaa.md`,
    ]);
  });

  it("ignores notes without frontmatter and index notes", async () => {
    const vault = new FakeVault();
    vault.notes.set(`${FOLDER}/index.md`, "---\ntype: moc\n---\n\n## Sources\n");
    vault.notes.set(`${FOLDER}/handwritten.md`, "# Just a note\n");
    vault.notes.set(`${FOLDER}/managed aaaa.md`, note("aaaa"));

    const map = await discoverSources({
      cli: new ObsidianCli(vault.run),
      collectionPath: FOLDER,
    });

    expect([...map.keys()]).toEqual(["aaaa"]);
  });

  it("reads only Markdown notes", async () => {
    const vault = new FakeVault();
    vault.notes.set(`${FOLDER}/managed aaaa.md`, note("aaaa"));
    vault.notes.set(`${FOLDER}/attachment.png`, "binary-ish");

    const vaultCli = new ObsidianCli(vault.run);
    await discoverSources({ cli: vaultCli, collectionPath: FOLDER });

    expect(vault.reads).toEqual([`${FOLDER}/managed aaaa.md`]);
  });

  it("bounds how many notes it reads at once", async () => {
    const vault = new FakeVault();
    for (let index = 0; index < 12; index += 1) {
      vault.notes.set(`${FOLDER}/note ${index}.md`, note(`id-${index}`));
    }

    let inFlight = 0;
    let peak = 0;
    const cli = new ObsidianCli(async (args, stdin) => {
      if (args[0] !== "read") return vault.run(args, stdin);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await vault.run(args, stdin);
      inFlight -= 1;
      return result;
    });

    const map = await discoverSources({ cli, collectionPath: FOLDER, concurrency: 4 });

    expect(map.size).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
