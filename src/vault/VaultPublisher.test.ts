import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { collectionPath, sha256, sourceId } from "./identity";
import { ObsidianCli } from "./ObsidianCli";
import type { CliResult, SourceDocument } from "./types";
import { VaultPublisher } from "./VaultPublisher";

/**
 * Markdown that exercises everything publication must not mangle: a GFM table,
 * a fenced code block, non-ASCII text, and a literal shell substitution string
 * that must survive verbatim rather than being expanded by a shell.
 */
const SOURCE_MARKDOWN = `# uv Projects

Résumé of the — “quoted” — workflow… 日本語 ✅

| Flag | Meaning |
| --- | --- |
| \`--frozen\` | Do not update the lockfile |

\`\`\`bash
uv run --frozen -- python -c 'print("$(whoami)")'
\`\`\`

Literal, never expanded: \`$(rm -rf /)\` and \${HOME} and \`backtick\`.
`;

function makeDocument(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    sourceUrl: "https://docs.astral.sh/uv/guides/projects/",
    requestedUrl: "https://docs.astral.sh/uv/guides/projects/",
    collection: "inbox",
    version: "",
    title: "Working on Projects with uv",
    markdown: SOURCE_MARKDOWN,
    sourceContentType: "text/html",
    capturedAt: "2026-09-10T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * In-memory stand-in for the `obsidian-cli` process.
 *
 * It records every argument array and stdin payload so tests can assert the
 * exact process contract, and it also holds note bytes so tests can assert the
 * resulting vault state. Its exit codes mirror the documented CLI: 3 for a
 * create-only collision, 1 for a missing note, 4 for a setext-heading refusal.
 */
class FakeObsidianCliProcess {
  readonly invocations: { args: string[]; stdin: string | null }[] = [];
  readonly notes = new Map<string, string>();
  /** Notes whose headings should be treated as setext, forcing exit 4. */
  readonly setextNotes = new Set<string>();

  run = async (args: string[], stdin: string | null): Promise<CliResult> => {
    this.invocations.push({ args, stdin });
    const [command, notePath] = args;

    if (command === "create") {
      if (this.notes.has(notePath)) {
        return {
          code: 3,
          stdout: "",
          stderr: "obsidian-cli: note changed since sha256:<absent> — re-read and retry",
        };
      }
      this.notes.set(notePath, stdin ?? "");
      return {
        code: 0,
        stdout: `wrote ${(stdin ?? "").length} bytes -> ${notePath}`,
        stderr: "",
      };
    }

    if (command === "read") {
      const existing = this.notes.get(notePath);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${notePath}` };
      }
      return { code: 0, stdout: existing, stderr: "" };
    }

    if (command === "section-insert") {
      const heading = args[2];
      const existing = this.notes.get(notePath);
      if (existing === undefined) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a file: ${notePath}` };
      }
      if (this.setextNotes.has(notePath)) {
        return { code: 4, stdout: "", stderr: "setext headings are not supported" };
      }
      const lines = existing.split("\n");
      const headingIndex = lines.indexOf(heading);
      if (headingIndex === -1) {
        return {
          code: 1,
          stdout: "",
          stderr: `obsidian-cli: heading not found (must match a whole line, outside code fences) in ${notePath}: ${heading}`,
        };
      }
      lines.splice(headingIndex + 1, 0, stdin ?? "");
      this.notes.set(notePath, lines.join("\n"));
      return {
        code: 0,
        stdout: `inserted under "${heading}" -> ${notePath}`,
        stderr: "",
      };
    }

    return { code: 2, stdout: "", stderr: `unknown subcommand: ${command}` };
  };
}

/** Splits a rendered note into its YAML frontmatter and its body. */
function splitNote(note: string): { frontmatter: string; body: string } {
  const match = note.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`note has no frontmatter:\n${note}`);
  return { frontmatter: match[1], body: match[2] };
}

describe("VaultPublisher", () => {
  let cli: FakeObsidianCliProcess;
  let publisher: VaultPublisher;

  beforeEach(() => {
    cli = new FakeObsidianCliProcess();
    publisher = new VaultPublisher(new ObsidianCli(cli.run));
  });

  it("publishes one source note under the reserved inbox collection", async () => {
    const publication = await publisher.publish(makeDocument());

    expect(publication.status).toBe("published");
    expect(publication.moc).toBe("linked");
    expect(publication.path.startsWith("00 Inbox/Source Captures/")).toBe(true);
    expect(cli.notes.has(publication.path)).toBe(true);
  });

  it("preserves the source markdown body byte for byte", async () => {
    const publication = await publisher.publish(makeDocument());
    const { body } = splitNote(cli.notes.get(publication.path) ?? "");

    expect(body).toBe(SOURCE_MARKDOWN);
  });

  it("never lets a shell substitution string reach the process as an argument", async () => {
    await publisher.publish(makeDocument());

    for (const { args } of cli.invocations) {
      for (const arg of args) {
        expect(arg).not.toContain("$(");
        expect(arg).not.toContain("rm -rf");
      }
    }
    // The dangerous text is carried on stdin instead, unexpanded.
    const created = cli.invocations.find((invocation) => invocation.args[0] === "create");
    expect(created?.stdin).toContain("$(rm -rf /)");
  });

  it("round-trips the documented metadata through YAML", async () => {
    const document = makeDocument();
    const publication = await publisher.publish(document);
    const { frontmatter } = splitNote(cli.notes.get(publication.path) ?? "");
    const metadata = parseYaml(frontmatter);

    expect(metadata).toMatchObject({
      type: "source",
      source_url: document.sourceUrl,
      requested_url: document.requestedUrl,
      source_id: sourceId(document),
      collection: "inbox",
      version: "",
      captured_at: document.capturedAt,
      source_content_type: "text/html",
      content_sha256: sha256(SOURCE_MARKDOWN),
      publisher: "secondbrain-docs",
    });
    expect(typeof metadata.publisher_version).toBe("string");
    expect(metadata.publisher_version.length).toBeGreaterThan(0);
  });

  it("keeps the source identity stable when only the title changes", async () => {
    const original = makeDocument();
    const retitled = makeDocument({ title: "uv — Working on Projects (2026 edition)" });

    expect(sourceId(retitled)).toBe(sourceId(original));
  });

  it("gives the same source a different identity under a different collection", async () => {
    expect(sourceId(makeDocument({ collection: "uv" }))).not.toBe(
      sourceId(makeDocument()),
    );
  });

  it("routes an explicitly named collection to its doc set folder, preserving its case", () => {
    expect(collectionPath("inbox")).toBe("00 Inbox/Source Captures");
    // The live vault already holds `30 Tools-Models/Doc Sets/SpotOn Restaurant API`,
    // so the folder keeps the given casing; only the identity is normalized.
    expect(collectionPath("SpotOn Restaurant API")).toBe(
      "30 Tools-Models/Doc Sets/SpotOn Restaurant API",
    );
  });

  it("normalizes collection case for identity but not for the folder", () => {
    expect(sourceId(makeDocument({ collection: "SpotOn Restaurant API" }))).toBe(
      sourceId(makeDocument({ collection: "spoton restaurant api" })),
    );
  });

  it("sanitizes a hostile title into a safe path inside the collection", async () => {
    const publication = await publisher.publish(
      makeDocument({ title: "../../etc/passwd: a *very* bad/title" }),
    );

    expect(publication.path.startsWith("00 Inbox/Source Captures/")).toBe(true);
    expect(publication.path).not.toContain("..");
    expect(publication.path).not.toContain(":");
    expect(publication.path.endsWith(".md")).toBe(true);
  });

  it("writes exactly one MOC link after capturing the same source twice", async () => {
    const first = await publisher.publish(makeDocument());
    const second = await publisher.publish(makeDocument());

    expect(first.status).toBe("published");
    expect(second.status).toBe("unchanged");

    const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";
    const links = index
      .split("\n")
      .filter((line) => line.includes(first.path.replace(/\.md$/, "")));
    expect(links).toHaveLength(1);
  });

  it("treats a later capture of unchanged content as unchanged, not a conflict", async () => {
    const first = await publisher.publish(makeDocument());
    const later = await publisher.publish(
      makeDocument({ capturedAt: "2026-11-01T09:30:00.000Z" }),
    );

    expect(later.status).toBe("unchanged");
    // The original note keeps its first captured_at byte for byte.
    expect(cli.notes.get(first.path)).toBe(first.markdown);
    expect(cli.notes.get(first.path)).toContain("captured_at: 2026-09-10T12:00:00.000Z");
  });

  it("reports a conflict when the source body actually changed", async () => {
    const first = await publisher.publish(makeDocument());
    const changed = await publisher.publish(
      makeDocument({ markdown: `${SOURCE_MARKDOWN}\nA new paragraph.\n` }),
    );

    expect(changed.status).toBe("conflict");
    expect(cli.notes.get(first.path)).toBe(first.markdown);
  });

  // Path freezing across a title change needs source_id discovery, which Task 3
  // introduces in discovery.ts. Task 2 only guarantees the identity is stable.

  it("preserves an existing note whose bytes differ and reports a conflict", async () => {
    const first = await publisher.publish(makeDocument());
    cli.notes.set(first.path, "# Hand edited by a human\n");

    const second = await publisher.publish(makeDocument());

    expect(second.status).toBe("conflict");
    expect(cli.notes.get(first.path)).toBe("# Hand edited by a human\n");
  });

  it("creates the collection index with a Sources heading when it is absent", async () => {
    await publisher.publish(makeDocument());
    const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";

    expect(index).toContain("## Sources");
  });

  it("reports a pending MOC instead of rewriting an index that lacks the heading", async () => {
    cli.notes.set(
      "00 Inbox/Source Captures/index.md",
      "# Source Captures\n\n## Something Else\n",
    );

    const publication = await publisher.publish(makeDocument());

    expect(publication.status).toBe("published");
    expect(publication.moc).toBe("pending");
    expect(cli.notes.get("00 Inbox/Source Captures/index.md")).toBe(
      "# Source Captures\n\n## Something Else\n",
    );
  });

  it("reports a pending MOC when the index uses setext headings", async () => {
    cli.notes.set(
      "00 Inbox/Source Captures/index.md",
      "Source Captures\n===\n\n## Sources\n",
    );
    cli.setextNotes.add("00 Inbox/Source Captures/index.md");

    const publication = await publisher.publish(makeDocument());

    expect(publication.status).toBe("published");
    expect(publication.moc).toBe("pending");
  });

  it("rejects empty source markdown rather than writing a blank note", async () => {
    await expect(publisher.publish(makeDocument({ markdown: "   \n" }))).rejects.toThrow(
      /empty/i,
    );
    expect(cli.notes.size).toBe(0);
  });

  it("does not duplicate the MOC link when two captures race", async () => {
    const [first, second] = await Promise.all([
      publisher.publish(makeDocument()),
      publisher.publish(makeDocument()),
    ]);

    const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";
    const links = index
      .split("\n")
      .filter((line) => line.includes(first.path.replace(/\.md$/, "")));

    expect(links).toHaveLength(1);
    expect([first.status, second.status].sort()).toEqual(["published", "unchanged"]);
  });
});
