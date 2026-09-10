import { beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { collectionPath, notePath, sha256, sourceId } from "./identity";
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
  /** Notes whose headings should be treated as setext. */
  readonly setextNotes = new Set<string>();
  /** Folders that exist without holding a note directly. */
  readonly folders = new Set<string>();

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
        // The installed CLI reports this as exit 1, not exit 4.
        return {
          code: 1,
          stdout: "",
          stderr: `obsidian-cli: setext heading layout in ${notePath} (a line underlined by === or ---): section-insert only supports ATX (#) headings`,
        };
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

    if (command === "list") {
      const dir = notePath.replace(/\/$/, "");
      const entries = new Set<string>();
      for (const candidate of [...this.notes.keys(), ...this.folders]) {
        if (!candidate.startsWith(`${dir}/`)) continue;
        const rest = candidate.slice(dir.length + 1);
        const head = rest.split("/")[0];
        if (head) entries.add(`${dir}/${head}`);
      }
      if (entries.size === 0 && !this.folders.has(dir)) {
        return { code: 1, stdout: "", stderr: `obsidian-cli: not a directory: ${dir}` };
      }
      return { code: 0, stdout: `${[...entries].sort().join("\n")}\n`, stderr: "" };
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

// Regressions for the 2026-09-10 Codex review of commit 72a6407.
describe("VaultPublisher review regressions", () => {
  let cli: FakeObsidianCliProcess;
  let publisher: VaultPublisher;

  beforeEach(() => {
    cli = new FakeObsidianCliProcess();
    publisher = new VaultPublisher(new ObsidianCli(cli.run));
  });

  describe("filename budget", () => {
    it("uses a short hash prefix rather than the full source id", async () => {
      const publication = await publisher.publish(makeDocument());
      const basename = publication.path.split("/").pop() ?? "";

      expect(basename).toContain(sourceId(makeDocument()).slice(0, 12));
      expect(basename).not.toContain(sourceId(makeDocument()));
    });

    it("keeps the basename inside the 255-byte filesystem limit for CJK titles", async () => {
      const publication = await publisher.publish(
        makeDocument({ title: "日本語".repeat(200) }),
      );
      const basename = publication.path.split("/").pop() ?? "";

      expect(Buffer.byteLength(basename, "utf8")).toBeLessThanOrEqual(255);
    });

    it("never truncates an astral character into a lone surrogate", async () => {
      const publication = await publisher.publish(
        makeDocument({ title: "𝔘".repeat(300) }),
      );
      const basename = publication.path.split("/").pop() ?? "";

      // Valid astral characters are surrogate PAIRS; only an unpaired half is a defect.
      expect(basename).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
      expect(Buffer.byteLength(basename, "utf8")).toBeLessThanOrEqual(255);
    });

    it("falls back to the full identity when a different source holds the short path", async () => {
      const shortPath = notePath(makeDocument());
      // A different source already occupies the short filename.
      cli.notes.set(
        shortPath,
        '---\ntype: source\nsource_url: https://example.invalid/other\nsource_id: 0000000000000000000000000000000000000000000000000000000000000000\nversion: ""\nsource_content_type: text/html\n---\nsomething else\n',
      );

      const publication = await publisher.publish(makeDocument());

      expect(publication.status).toBe("published");
      expect(publication.path).not.toBe(shortPath);
      expect(publication.path).toContain(sourceId(makeDocument()));
      // The other source's note is untouched.
      expect(cli.notes.get(shortPath)).toContain("something else");
    });
  });

  describe("MOC link detection", () => {
    it("recognizes an existing link a human stripped the alias from", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(indexPath, `# Source Captures\n\n## Sources\n- [[${target}]]\n`);

      await publisher.publish(makeDocument());

      const links = (cli.notes.get(indexPath) ?? "")
        .split("\n")
        .filter((line) => line.includes(target));
      expect(links).toHaveLength(1);
    });

    it("does not count a link inside a fenced code block as a live link", async () => {
      const first = await publisher.publish(makeDocument());
      const indexPath = "00 Inbox/Source Captures/index.md";
      const target = first.path.replace(/\.md$/, "");
      cli.notes.set(
        indexPath,
        `# Source Captures\n\n## Sources\n\n\`\`\`\n- [[${target}]]\n\`\`\`\n`,
      );

      const republished = await publisher.publish(makeDocument());

      expect(republished.moc).toBe("linked");
      const index = cli.notes.get(indexPath) ?? "";
      const liveLinks = index
        .split("```")
        .filter((_, i) => i % 2 === 0)
        .join("")
        .split("\n")
        .filter((line) => line.includes(target));
      expect(liveLinks).toHaveLength(1);
    });

    it("cannot be made to inject a second link through a hostile title", async () => {
      const publication = await publisher.publish(
        makeDocument({ title: "Innocent]]\n- [[Evil Injected Note|pwned" }),
      );

      const index = cli.notes.get("00 Inbox/Source Captures/index.md") ?? "";
      const wikilinks = index.match(/\[\[/g) ?? [];

      expect(publication.moc).toBe("linked");
      // The hostile text survives as inert display text, never as a second link.
      expect(wikilinks).toHaveLength(1);
      expect(index).not.toContain("[[Evil Injected Note");
      const sourcesSection = index.split("## Sources")[1] ?? "";
      expect(sourcesSection.trim().split("\n")).toHaveLength(1);
    });
  });

  describe("collection folder resolution", () => {
    it("reuses an existing folder's established spelling for a case variant", async () => {
      cli.folders.add("30 Tools-Models/Doc Sets/SpotOn Restaurant API");

      const publication = await publisher.publish(
        makeDocument({ collection: "spoton restaurant api" }),
      );

      expect(
        publication.path.startsWith("30 Tools-Models/Doc Sets/SpotOn Restaurant API/"),
      ).toBe(true);
    });

    it("refuses to publish when two folders claim one collection identity", async () => {
      cli.folders.add("30 Tools-Models/Doc Sets/SpotOn Restaurant API");
      cli.folders.add("30 Tools-Models/Doc Sets/spoton restaurant api");

      await expect(
        publisher.publish(makeDocument({ collection: "SpotOn Restaurant API" })),
      ).rejects.toThrow(/ambiguous/i);
    });
  });

  describe("semantic comparison", () => {
    it("treats a quoted scalar containing an escape sequence as changed, not unchanged", async () => {
      const document = makeDocument({ requestedUrl: "https://example.invalid/a\\nb" });
      const first = await publisher.publish(document);

      // A human re-quotes the scalar so YAML now decodes it as a real newline.
      const rewritten = (cli.notes.get(first.path) ?? "").replace(
        /^requested_url:.*$/m,
        'requested_url: "https://example.invalid/a\\nb"',
      );
      cli.notes.set(first.path, rewritten);

      const second = await publisher.publish(document);

      expect(second.status).toBe("conflict");
      expect(cli.notes.get(first.path)).toBe(rewritten);
    });

    it("republishes an unchanged multiline version without reporting a conflict", async () => {
      const document = makeDocument({ version: "release\nnotes" });
      await publisher.publish(document);

      const second = await publisher.publish(document);

      expect(second.status).toBe("unchanged");
    });

    it("treats an unparseable frontmatter block as a conflict", async () => {
      const first = await publisher.publish(makeDocument());
      cli.notes.set(first.path, "---\n:\n  - [unclosed\n---\nbody\n");

      const second = await publisher.publish(makeDocument());

      expect(second.status).toBe("conflict");
      expect(cli.notes.get(first.path)).toContain("unclosed");
    });
  });

  it("links exactly once when another writer creates the index first", async () => {
    const indexPath = "00 Inbox/Source Captures/index.md";
    const realRun = cli.run;
    let intercepted = false;

    // Another process creates the index between our read and our create.
    const racingCli = new ObsidianCli(async (args, stdin) => {
      if (!intercepted && args[0] === "create" && args[1] === indexPath) {
        intercepted = true;
        cli.notes.set(indexPath, "# Source Captures\n\n## Sources\n");
      }
      return realRun(args, stdin);
    });

    const racingPublisher = new VaultPublisher(racingCli);
    const publication = await racingPublisher.publish(makeDocument());

    expect(publication.moc).toBe("linked");
    const links = (cli.notes.get(indexPath) ?? "")
      .split("\n")
      .filter((line) => line.includes(publication.path.replace(/\.md$/, "")));
    expect(links).toHaveLength(1);
  });
});
