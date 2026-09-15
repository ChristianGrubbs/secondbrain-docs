import matter from "gray-matter";
import { logger } from "../../utils/logger";
import type { ContentProcessorMiddleware, MiddlewareContext } from "./types";

/**
 * Reads a `title:` line straight out of a leading `---` block that the YAML
 * parser rejected. Only the first block at the very start of the document is
 * considered; matching surrounding quotes are removed.
 *
 * @returns The raw title, or null when there is no leading block or it
 *   carries no non-empty `title:` line.
 */
export function recoverTitleFromRawFrontmatter(content: string): string | null {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) return null;
  const line = block[1].match(/^title:[ \t]*(.+?)[ \t]*$/m);
  if (!line) return null;
  let value = line[1];
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Middleware to extract the title from Markdown content.
 * Prioritizes YAML frontmatter 'title' field, falls back to first H1 heading.
 */
export class MarkdownMetadataExtractorMiddleware implements ContentProcessorMiddleware {
  /**
   * Processes the context to extract the title from Markdown.
   * @param context The current processing context.
   * @param next Function to call the next middleware.
   */
  async process(context: MiddlewareContext, next: () => Promise<void>): Promise<void> {
    try {
      let title = "Untitled";
      let frontmatterTitle: string | undefined;

      // 1. Try to extract title from YAML frontmatter
      try {
        const file = matter(context.content);
        if (file.data && file.data.title !== undefined && file.data.title !== null) {
          // Convert to string to handle numeric titles (e.g. title: 2024)
          frontmatterTitle = String(file.data.title).trim();
        }
      } catch (err) {
        // Log warning but continue - don't crash the pipeline for bad frontmatter
        logger.warn(
          `Failed to parse markdown frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (frontmatterTitle && frontmatterTitle.length > 0) {
        title = frontmatterTitle;
      } else {
        // 2. Fallback: Extract first H1 heading
        const match = context.content.match(/^#\s+(.*)$/m);
        if (match?.[1]) {
          title = match[1].trim();
        } else {
          // 3. Fork fallback (2026-09-15): the frontmatter block exists but
          // is not valid YAML (an unquoted `title:` containing a colon is the
          // common case, e.g. higgsfield.ai's served Markdown) and the body
          // has no H1. The raw `title:` line is still unambiguous.
          const recovered = recoverTitleFromRawFrontmatter(context.content);
          if (recovered !== null) {
            title = recovered;
          }
        }
      }

      context.title = title;
    } catch (error) {
      context.errors.push(
        new Error(
          `Failed to extract metadata from Markdown: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }

    await next();
  }
}
