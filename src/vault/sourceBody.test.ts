import { describe, expect, it } from "vitest";
import { isMarkdownContentType, stripLeadingFrontmatter } from "./sourceBody";

describe("stripLeadingFrontmatter", () => {
  it("removes a leading valid frontmatter block and the blank line after it", () => {
    const body = "---\ntitle: Real\ntags: [a]\n---\n\n# Heading\n\nText";
    expect(stripLeadingFrontmatter(body)).toBe("# Heading\n\nText");
  });

  it("removes a leading malformed frontmatter block the same way", () => {
    // The served block need not be valid YAML to be a frontmatter block;
    // once the publisher prepends its own, a second `---` block is body noise.
    const body =
      "---\ndescription: x\ntitle: Higgsfield Meets GPT Image 2.5: How It Works\n---\n\n![img](x.png)\n\nText";
    expect(stripLeadingFrontmatter(body)).toBe("![img](x.png)\n\nText");
  });

  it("accepts CRLF line endings", () => {
    expect(stripLeadingFrontmatter("---\r\ntitle: T\r\n---\r\n\r\nBody")).toBe("Body");
  });

  it("leaves a body untouched when the block is not at the very start", () => {
    const body = "Intro\n\n---\ntitle: T\n---\nBody";
    expect(stripLeadingFrontmatter(body)).toBe(body);
  });

  it("leaves a thematic break alone", () => {
    // `---` followed by prose, never closed: a horizontal rule, not frontmatter.
    const body = "---\n\nParagraph after a rule";
    expect(stripLeadingFrontmatter(body)).toBe(body);
  });

  it("leaves an unclosed block alone", () => {
    const body = "---\ntitle: T\nBody without a closing fence";
    expect(stripLeadingFrontmatter(body)).toBe(body);
  });

  it("returns an empty body when the document is only frontmatter", () => {
    expect(stripLeadingFrontmatter("---\ntitle: T\n---\n")).toBe("");
  });
});

describe("isMarkdownContentType", () => {
  it("matches text/markdown and text/x-markdown with parameters", () => {
    expect(isMarkdownContentType("text/markdown")).toBe(true);
    expect(isMarkdownContentType("text/markdown; charset=utf-8")).toBe(true);
    expect(isMarkdownContentType("text/x-markdown")).toBe(true);
    expect(isMarkdownContentType("TEXT/MARKDOWN")).toBe(true);
  });

  it("rejects HTML, plain text and undefined", () => {
    expect(isMarkdownContentType("text/html")).toBe(false);
    expect(isMarkdownContentType("text/plain")).toBe(false);
    expect(isMarkdownContentType(undefined)).toBe(false);
  });
});
