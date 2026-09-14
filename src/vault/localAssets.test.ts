import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sourceId } from "./identity";
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

describe("localizeLocalAssets", () => {
  it("rewrites a relative image embed to a deterministic _attachments path and lists the asset", () => {
    const dir = sourceDir();
    fs.writeFileSync(path.join(dir, "pixel.png"), Buffer.from([0x89, 0x50]));
    const input = doc(dir, "Diagram: ![pixel](./pixel.png)\n");
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    const hash = sourceId(input).slice(0, 12);
    const vaultPath = `${ATTACHMENTS_ROOT}/${FOLDER}/${hash}/pixel.png`;
    expect(assets).toEqual([{ localPath: path.join(dir, "pixel.png"), vaultPath }]);
    expect(localized.markdown).toBe(
      `Diagram: ![pixel](${ATTACHMENTS_ROOT}/30%20Tools-Models/Doc%20Sets/Local%20Notes/${hash}/pixel.png)\n`,
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
    const hash = sourceId(input).slice(0, 12);
    expect(assets).toEqual([
      {
        localPath: path.join(dir, "my pic.png"),
        vaultPath: `${ATTACHMENTS_ROOT}/${FOLDER}/${hash}/my pic.png`,
      },
    ]);
    expect(localized.markdown.match(/my%20pic\.png\)/g)).toHaveLength(2);
    expect(localized.markdown).not.toContain("](my%20pic.png)");
  });

  it("leaves a directory that merely shares an image name untouched", () => {
    const dir = sourceDir();
    fs.mkdirSync(path.join(dir, "pixel.png"));
    const input = doc(dir, "![p](./pixel.png)\n");
    const { input: localized, assets } = localizeLocalAssets(input, FOLDER);
    expect(assets).toEqual([]);
    expect(localized.markdown).toBe(input.markdown);
  });
});
