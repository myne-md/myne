// Spec: docs/spec/wikilink.md §2, docs/spec/markdown-dialect.md §3.5.

import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "../lezer/parser";
import type { WikilinkRef, WikilinkTargetKind } from "../types";

export function classifyTarget(target: string): WikilinkTargetKind {
  if (target.includes("/")) return "vault-path";
  if (target.endsWith(".md")) return "vault-path";
  return "title";
}

function childText(
  source: string,
  parent: SyntaxNode,
  name: string,
): string | null {
  let cursor: SyntaxNode | null = parent.firstChild;
  while (cursor !== null) {
    if (cursor.name === name) {
      return source.substring(cursor.from, cursor.to);
    }
    cursor = cursor.nextSibling;
  }
  return null;
}

export function extractWikilinks(source: string, tree?: Tree): WikilinkRef[] {
  if (source.length === 0) return [];
  const t = tree ?? parser.parse(source);
  const results: WikilinkRef[] = [];
  t.iterate({
    enter: (nodeRef) => {
      if (nodeRef.name !== "Wikilink") return undefined;
      const node = nodeRef.node;
      const raw = source.substring(node.from, node.to);
      const embed = source.charCodeAt(node.from) === 33;
      const target = childText(source, node, "WikilinkTarget") ?? "";
      const alias = childText(source, node, "WikilinkAlias");
      const heading = childText(source, node, "WikilinkHeading");
      const blockId = childText(source, node, "WikilinkBlockId");
      results.push({
        raw,
        byteRange: { start: node.from, end: node.to },
        embed,
        target,
        targetKind: classifyTarget(target),
        alias,
        heading,
        blockId,
      });
      return false;
    },
  });
  return results;
}
