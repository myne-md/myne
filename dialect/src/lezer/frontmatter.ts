// Spec: docs/spec/markdown-dialect.md §3.6 (line-1-anchored detection).

export const FRONTMATTER_DELIMITER = "---";
export const NEWLINE = "\n";
export const FRONTMATTER_OPENER = FRONTMATTER_DELIMITER + NEWLINE;

export type FrontmatterRange = {
  blockStart: number;
  blockEnd: number;
  bodyStart: number;
  bodyEnd: number;
};

/**
 * Locate the line-1-anchored frontmatter block. Returns `null` for
 * sources without an opener-and-matching-closer. An opener without a
 * closer is treated as **no frontmatter** per §3.6, not as a parse
 * error — body starts from line 1.
 */
export function locateFrontmatter(source: string): FrontmatterRange | null {
  if (!source.startsWith(FRONTMATTER_OPENER)) {
    return null;
  }
  const bodyStart = FRONTMATTER_OPENER.length;

  let cursor = bodyStart;
  while (cursor < source.length) {
    const lineEnd = source.indexOf(NEWLINE, cursor);
    if (lineEnd === -1) {
      const line = source.substring(cursor);
      if (line === FRONTMATTER_DELIMITER) {
        return {
          blockStart: 0,
          blockEnd: source.length,
          bodyStart,
          bodyEnd: cursor,
        };
      }
      return null;
    }
    const line = source.substring(cursor, lineEnd);
    if (line === FRONTMATTER_DELIMITER) {
      return {
        blockStart: 0,
        blockEnd: lineEnd + NEWLINE.length,
        bodyStart,
        bodyEnd: cursor,
      };
    }
    cursor = lineEnd + NEWLINE.length;
  }

  return null;
}
