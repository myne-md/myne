// Spec: agent-tooling/docs/spec/markdown-dialect.md §3.2. Markdown `![alt](src)` form ONLY
// — the `![[image.png]]` wikilink-embed form is consumed first by the
// wikilink lezer extension (registered `before: "Link"`) and lives under
// the wikilinks visitor with `embed: true`.

import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "../lezer/parser";
import type { MediaRef } from "../types";

const CHAR_OPEN_PAREN = 0x28;

// lezer-markdown Image children (in order): LinkMark `![`, alt inline content,
// LinkMark `]`, LinkMark `(`, URL, optional LinkTitle, LinkMark `)`. The `(`
// LinkMark partitions siblings into alt and url portions; the latest `]`
// before `(` closes the alt.
function readImage(
  source: string,
  imageNode: SyntaxNode,
): { alt: string; src: string } | null {
  const openMark = imageNode.firstChild;
  if (openMark === null || openMark.name !== "LinkMark") return null;
  const altStart = openMark.to;

  let urlNode: SyntaxNode | null = null;
  let altCloseMark: SyntaxNode | null = null;
  let foundOpenParen = false;
  let cursor: SyntaxNode | null = openMark.nextSibling;
  while (cursor !== null) {
    if (cursor.name === "URL") {
      urlNode = cursor;
    } else if (cursor.name === "LinkMark") {
      const ch = source.charCodeAt(cursor.from);
      if (ch === CHAR_OPEN_PAREN) {
        foundOpenParen = true;
      } else if (!foundOpenParen) {
        altCloseMark = cursor;
      }
    }
    cursor = cursor.nextSibling;
  }
  if (altCloseMark === null || urlNode === null) return null;

  return {
    alt: source.substring(altStart, altCloseMark.from),
    src: source.substring(urlNode.from, urlNode.to),
  };
}

export function extractMediaRefs(source: string, tree?: Tree): MediaRef[] {
  if (source.length === 0) return [];
  const t = tree ?? parser.parse(source);
  const results: MediaRef[] = [];
  t.iterate({
    enter: (nodeRef) => {
      if (nodeRef.name !== "Image") return undefined;
      const node = nodeRef.node;
      const parts = readImage(source, node);
      if (parts === null) return false;
      results.push({
        raw: source.substring(node.from, node.to),
        byteRange: { start: node.from, end: node.to },
        alt: parts.alt,
        src: parts.src,
      });
      return false;
    },
  });
  return results;
}
