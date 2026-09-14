import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sha256, sourceId } from "./identity";
import { ATTACHMENTS_ROOT, localizeLocalAssets } from "./localAssets";
import type { SourceDocument } from "./types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sourceDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-docs-assets-"));
  dirs.push(dir);
  return dir;
}

function doc(dir: string, markdown: string): SourceDocument {
  const file = path.join(dir, "notes.md");
  fs.writeFileSync(file, markdown);
  return {
    sourceUrl: pathToFileURL(file).href,
    requestedUrl: file,
    collection: "Local Notes",
    version: "",
    title: "Notes",
    markdown,
    sourceContentType: "text/markdown",
    capturedAt: "2026-09-14T00:00:00.000Z",
  };
}

const FOLDER = "30 Tools-Models/Doc Sets/Local Notes";
const ENCODED_FOLDER = "30%20Tools-Models/Doc%20Sets/Local%20Notes";

const prefixOf = (input: SourceDocument): string =>
  `${ATTACHMENTS_ROOT}/${FOLDER}/${sourceId(input).slice(0, 12)}`;

const encodedPrefixOf = (input: SourceDocument): string =>
  `${ATTACHMENTS_ROOT}/${ENCODED_FOLDER}/${sourceId(input).slice(0, 12)}`;

describe("localizeLocalAssets", () => {
  it("rewrites a relative image embed to a deterministic _attachments path and lists the asset", () => {
    const dir = sourceDir();
    fs.writeFileSync(path.join(dir, "pixel.png"), Buffer.from([0x89, 0x50]));
    const input = doc(dir, "Diagram: ![pixel](./pixel.png)\n");
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toEqual([
      {
        localPath: path.join(dir, "pixel.png"),
        vaultPath: `${prefixOf(input)}/pixel.png`,
      },
    ]);
    expect(localized.markdown).toBe(
      `Diagram: ![pixel](${encodedPrefixOf(input)}/pixel.png)\n`,
    );
    expect(localized.sourceUrl).toBe(input.sourceUrl);
  });

  it("leaves remote, absolute, data, Markdown and missing references untouched", () => {
    const dir = sourceDir();
    fs.writeFileSync(path.join(dir, "other.md"), "# other");
    const markdown = [
      "![r](https://example.com/a.png)",
      "![a](/abs/a.png)",
      "![d](data:image/png;base64,AAAA)",
      "![m](./other.md)",
      "![gone](./missing.png)",
      "",
    ].join("\n");
    const input = doc(dir, markdown);
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toEqual([]);
    expect(localized.markdown).toBe(markdown);
  });

  it("does nothing for non-file sources", () => {
    const dir = sourceDir();
    fs.writeFileSync(path.join(dir, "pixel.png"), "x");
    const input = {
      ...doc(dir, "![p](./pixel.png)\n"),
      sourceUrl: "https://example.com/notes.md",
    };
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toEqual([]);
    expect(localized).toBe(input);
  });

  it("copies one asset once when it is embedded twice and decodes percent-encoded names", () => {
    const dir = sourceDir();
    fs.writeFileSync(path.join(dir, "my pic.png"), "x");
    const input = doc(dir, "![a](my%20pic.png) ![b](./my%20pic.png)\n");
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toEqual([
      {
        localPath: path.join(dir, "my pic.png"),
        vaultPath: `${prefixOf(input)}/my pic.png`,
      },
    ]);
    expect(localized.markdown).toBe(
      `![a](${encodedPrefixOf(input)}/my%20pic.png) ![b](${encodedPrefixOf(input)}/my%20pic.png)\n`,
    );
  });

  it("leaves a directory that merely shares an image name untouched", () => {
    const dir = sourceDir();
    fs.mkdirSync(path.join(dir, "pixel.png"));
    const input = doc(dir, "![p](./pixel.png)\n");
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toEqual([]);
    expect(localized.markdown).toBe(input.markdown);
  });

  it("never rewrites image-looking text inside fenced or inline code", () => {
    const dir = sourceDir();
    fs.writeFileSync(path.join(dir, "pixel.png"), "x");
    const markdown = [
      "```bash",
      'echo "![pixel](./pixel.png)"',
      "```",
      "",
      "    ![pixel](./pixel.png)",
      "",
      "Inline `![pixel](./pixel.png)` stays, but ![pixel](./pixel.png) moves.",
      "",
    ].join("\n");
    const input = doc(dir, markdown);
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toHaveLength(1);
    const moved = `![pixel](${encodedPrefixOf(input)}/pixel.png)`;
    expect(localized.markdown).toBe(
      markdown.replace("but ![pixel](./pixel.png) moves", `but ${moved} moves`),
    );
    expect(localized.markdown.match(/!\[pixel\]\(\.\/pixel\.png\)/g)).toHaveLength(3);
  });

  it("handles angle-bracket destinations with spaces and parentheses, and keeps titles", () => {
    const dir = sourceDir();
    fs.writeFileSync(path.join(dir, "shot (1).png"), "x");
    const input = doc(dir, 'See ![a shot](<./shot (1).png> "The title") here.\n');
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toEqual([
      {
        localPath: path.join(dir, "shot (1).png"),
        vaultPath: `${prefixOf(input)}/shot (1).png`,
      },
    ]);
    expect(localized.markdown).toBe(
      `See ![a shot](${encodedPrefixOf(input)}/shot%20(1).png "The title") here.\n`,
    );
  });

  it("rewrites the definition a reference-style image resolves through, not plain link definitions", () => {
    const dir = sourceDir();
    fs.writeFileSync(path.join(dir, "pixel.png"), "x");
    fs.writeFileSync(path.join(dir, "data.csv"), "a,b");
    const markdown = [
      "Figure: ![pixel][fig]",
      "",
      "Download [the data][csv].",
      "",
      "[fig]: ./pixel.png",
      "[csv]: ./data.csv",
      "",
    ].join("\n");
    const input = doc(dir, markdown);
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toEqual([
      {
        localPath: path.join(dir, "pixel.png"),
        vaultPath: `${prefixOf(input)}/pixel.png`,
      },
    ]);
    expect(localized.markdown).toBe(
      markdown.replace(
        "[fig]: ./pixel.png",
        `[fig]: ${encodedPrefixOf(input)}/pixel.png`,
      ),
    );
  });

  it("keeps two same-basename assets from different directories distinct", () => {
    const dir = sourceDir();
    fs.mkdirSync(path.join(dir, "images", "a"), { recursive: true });
    fs.mkdirSync(path.join(dir, "images", "b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "images", "a", "pixel.png"), "A");
    fs.writeFileSync(path.join(dir, "images", "b", "pixel.png"), "B");
    const input = doc(dir, "![a](images/a/pixel.png) ![b](images/b/pixel.png)\n");
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toEqual([
      {
        localPath: path.join(dir, "images", "a", "pixel.png"),
        vaultPath: `${prefixOf(input)}/images/a/pixel.png`,
      },
      {
        localPath: path.join(dir, "images", "b", "pixel.png"),
        vaultPath: `${prefixOf(input)}/images/b/pixel.png`,
      },
    ]);
    expect(localized.markdown).toBe(
      `![a](${encodedPrefixOf(input)}/images/a/pixel.png) ![b](${encodedPrefixOf(input)}/images/b/pixel.png)\n`,
    );
  });

  it("hashes the relative path of an asset that lives above the source directory", () => {
    const parent = sourceDir();
    const dir = path.join(parent, "docs");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(parent, "pixel.png"), "x");
    const input = doc(dir, "![up](../pixel.png)\n");
    const { assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toEqual([
      {
        localPath: path.join(parent, "pixel.png"),
        vaultPath: `${prefixOf(input)}/${sha256("../pixel.png").slice(0, 8)}/pixel.png`,
      },
    ]);
  });
});
