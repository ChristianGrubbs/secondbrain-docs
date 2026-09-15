/**
 * Body normalisation for sources that arrive as Markdown.
 *
 * The publisher prepends its own frontmatter to every note, so a frontmatter
 * block the source itself served can never be the note's frontmatter: it
 * renders as a stray `---` block at the top of the body. This module drops
 * that leading block (valid YAML or not) before publication; the title it may
 * carry has already been read by the scraper's metadata extractor.
 */

import { MimeTypeUtils } from "../utils/mimeTypeUtils";

const DELIMITER = /^---[ \t]*$/;
const KEY_LINE = /^[A-Za-z0-9_.-]+:(?:[ \t]|$)/;

/**
 * Whether a source content type is one of the repository's Markdown types
 * (`text/markdown`, `text/x-markdown`, `text/mdx`, `text/x-gfm`).
 *
 * @param contentType The `sourceContentType` recorded for the page, with or
 *   without parameters.
 */
export function isMarkdownContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const essence = contentType.split(";")[0].trim().toLowerCase();
  return MimeTypeUtils.isMarkdown(essence);
}

/**
 * Removes one frontmatter block from the very start of a Markdown body, plus
 * the blank lines that followed it.
 *
 * A block is frontmatter only when it has the shape of one: an opening `---`
 * on the first line, a closing `---` line, no blank line in between, and at
 * least one `key:` line. A leading `---` that is followed by a blank line or
 * by prose is a thematic break, and the scan never reaches past a blank line,
 * so a later `---` inside a paragraph or a code fence cannot close it.
 *
 * @param markdown The source body as the scraper produced it.
 * @returns The body without its leading frontmatter block.
 */
export function stripLeadingFrontmatter(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines.length < 3 || !DELIMITER.test(lines[0])) return markdown;

  let sawKey = false;
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (DELIMITER.test(line)) {
      close = i;
      break;
    }
    if (line.trim().length === 0) return markdown;
    if (KEY_LINE.test(line)) sawKey = true;
  }
  if (close === -1 || !sawKey) return markdown;

  // Re-slice the original text so the body keeps its own line endings.
  let consumed = 0;
  const newline = /\r?\n/g;
  for (let i = 0; i <= close; i += 1) {
    const match = newline.exec(markdown);
    if (match === null) {
      consumed = markdown.length;
      break;
    }
    consumed = match.index + match[0].length;
  }
  return markdown.slice(consumed).replace(/^(?:[ \t]*\r?\n)+/, "");
}
