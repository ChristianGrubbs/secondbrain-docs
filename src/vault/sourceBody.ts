/**
 * Body normalisation for sources that arrive as Markdown.
 *
 * The publisher prepends its own frontmatter to every note, so a frontmatter
 * block the source itself served can never be the note's frontmatter: it
 * renders as a stray `---` block at the top of the body. This module drops
 * that leading block (valid YAML or not) before publication; the title it may
 * carry has already been read by the scraper's metadata extractor.
 */

const LEADING_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/**
 * Whether a source content type is Markdown.
 *
 * @param contentType The `sourceContentType` recorded for the page, with or
 *   without parameters.
 */
export function isMarkdownContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const essence = contentType.split(";")[0].trim().toLowerCase();
  return essence === "text/markdown" || essence === "text/x-markdown";
}

/**
 * Removes one frontmatter block from the very start of a Markdown body, plus
 * the blank lines that followed it. A `---` that is never closed by another
 * `---` line is a thematic break and is left alone.
 *
 * @param markdown The source body as the scraper produced it.
 * @returns The body without its leading frontmatter block.
 */
export function stripLeadingFrontmatter(markdown: string): string {
  const match = markdown.match(LEADING_FRONTMATTER);
  if (!match) return markdown;
  return markdown.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
}
