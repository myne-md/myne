// Spec: docs/spec/markdown-dialect.md §3 (recognized syntax),
// §3.5 (wikilink display alias-vs-target rule), §3.6 (frontmatter).

import type { SyntaxNode, Tree } from "@lezer/common";
import { assembleOutsideSkips } from "../internal/skip-ranges";
import { parser } from "../lezer/parser";
import { type FrontmatterRange, locateFrontmatter } from "../lezer/frontmatter";

const SKIP_EXACT_NAMES: ReadonlySet<string> = new Set([
  "URL",
  "LinkTitle",
  "CodeInfo",
  "WikilinkHeading",
  "WikilinkBlockId",
  // Dialect comments `%%…%%` (MYND-315): the whole node — body included — is
  // dialect-hidden, so document statistics exclude it (SYNC-1), matching the
  // HTML / PDF / stripped-TXT projections. The `.md` export stays verbatim
  // (SYNC-2) — that path never runs through this projection.
  "DialectComment",
  "DialectCommentBlock",
]);

function shouldSkipUnconditionally(name: string): boolean {
  return SKIP_EXACT_NAMES.has(name) || name.endsWith("Mark");
}

/**
 * Decoration-stripped, frontmatter-excluded, code-block-included plain text,
 * with the source whitespace **preserved** (NOT collapsed, NOT trimmed). This is
 * the substrate for character / space / paragraph counting (`documentStats.ts`),
 * which needs the real whitespace + line breaks that {@link extractFullText}
 * destroys. For word counting / search, prefer the collapsed `extractFullText`.
 *
 * Pass `fm` when the caller (e.g. `parse()`) has already located the
 * frontmatter range — avoids a redundant scan.
 */
export function extractBodyText(
  source: string,
  tree?: Tree,
  fm?: FrontmatterRange | null,
): string {
  if (source.length === 0) return "";

  const fmRange = fm === undefined ? locateFrontmatter(source) : fm;
  const t = tree ?? parser.parse(source);

  const skipRanges: Array<[number, number]> = [];
  if (fmRange !== null) skipRanges.push([fmRange.blockStart, fmRange.blockEnd]);

  // Single tree iteration: collect generic skips AND the conditional
  // WikilinkTarget-when-alias-present skip in one pass.
  t.iterate({
    enter: (nodeRef) => {
      if (shouldSkipUnconditionally(nodeRef.name)) {
        skipRanges.push([nodeRef.from, nodeRef.to]);
        return false;
      }
      if (nodeRef.name === "Wikilink") {
        const node = nodeRef.node;
        let hasAlias = false;
        let target: SyntaxNode | null = null;
        let cursor: SyntaxNode | null = node.firstChild;
        while (cursor !== null) {
          if (cursor.name === "WikilinkAlias") hasAlias = true;
          else if (cursor.name === "WikilinkTarget") target = cursor;
          cursor = cursor.nextSibling;
        }
        if (hasAlias && target !== null) {
          skipRanges.push([target.from, target.to]);
        }
      }
      return undefined;
    },
  });

  return assembleOutsideSkips(source, skipRanges, {
    start: 0,
    end: source.length,
  });
}

/**
 * Decoration-stripped, frontmatter-excluded, code-block-included plain
 * text. Whitespace runs collapse to single space; output is trimmed. Thin
 * wrapper over {@link extractBodyText} (the collapse + trim is the only
 * difference) — used by word count and search.
 *
 * Pass `fm` when the caller (e.g. `parse()`) has already located the
 * frontmatter range — avoids a redundant scan.
 */
export function extractFullText(
  source: string,
  tree?: Tree,
  fm?: FrontmatterRange | null,
): string {
  return extractBodyText(source, tree, fm).replace(/\s+/gu, " ").trim();
}
