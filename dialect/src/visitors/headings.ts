// Spec: docs/spec/markdown-dialect.md §3.1 (ATX canonical, Setext
// recognized for round-trip but never emitted).

import type { SyntaxNode, Tree } from "@lezer/common";
import { assembleOutsideSkips } from "../internal/skip-ranges";
import { parser } from "../lezer/parser";
import type { HeadingLevel, HeadingRef } from "../types";

const ATX_LEVEL_BY_NAME: Readonly<Record<string, HeadingLevel>> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
};

const SETEXT_LEVEL_BY_NAME: Readonly<Record<string, HeadingLevel>> = {
  SetextHeading1: 1,
  SetextHeading2: 2,
};

const SKIP_EXACT_NAMES: ReadonlySet<string> = new Set(["URL", "LinkTitle"]);

function shouldSkip(name: string): boolean {
  return SKIP_EXACT_NAMES.has(name) || name.endsWith("Mark");
}

// @lezer/markdown does NOT produce explicit Text nodes for plain text
// within a heading — text lives in the gaps between Mark nodes. Collect
// the skip ranges (markers, URLs, link titles) and assemble the rest.
function inlineText(source: string, headingNode: SyntaxNode): string {
  const skipRanges: Array<[number, number]> = [];

  const collectSkips = (node: SyntaxNode): void => {
    if (shouldSkip(node.name)) {
      skipRanges.push([node.from, node.to]);
      return;
    }
    let cursor: SyntaxNode | null = node.firstChild;
    while (cursor !== null) {
      collectSkips(cursor);
      cursor = cursor.nextSibling;
    }
  };
  let child: SyntaxNode | null = headingNode.firstChild;
  while (child !== null) {
    collectSkips(child);
    child = child.nextSibling;
  }

  return assembleOutsideSkips(source, skipRanges, {
    start: headingNode.from,
    end: headingNode.to,
  }).trim();
}

export function extractHeadings(source: string, tree?: Tree): HeadingRef[] {
  if (source.length === 0) return [];
  const t = tree ?? parser.parse(source);
  const results: HeadingRef[] = [];
  t.iterate({
    enter: (nodeRef) => {
      const name = nodeRef.name;
      const level = ATX_LEVEL_BY_NAME[name] ?? SETEXT_LEVEL_BY_NAME[name];
      if (level === undefined) return undefined;
      const node = nodeRef.node;
      results.push({
        level,
        text: inlineText(source, node),
        raw: source.substring(node.from, node.to),
        byteRange: { start: node.from, end: node.to },
      });
      return false;
    },
  });
  return results;
}
