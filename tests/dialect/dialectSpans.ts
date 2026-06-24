// Shared span-extraction helper for the dialect parse-recognition vector
// categories (footnote / highlight / wikilink / definition-list / inline-tag /
// math). Both the cross-implementation runner (`dialectParse.test.ts`) and the
// vector generator (`_genDialectVectors.test.ts`) import this so the "what is a
// recognized dialect span" definition lives in exactly one place.
//
// The cross-impl contract a span pins is parser-agnostic: "which byte ranges of
// the source are recognized as construct node X". A Lezer parse tree is a
// JS-side implementation detail; the vectors express ranges as UTF-8 BYTE
// offsets (not JS UTF-16 code-unit offsets), so a Rust/Swift/Kotlin port that
// walks bytes can assert against them directly. This module does the UTF-16 →
// UTF-8 conversion at the boundary.

import { parser } from "../../src/dialect/lezer/parser";

/** One recognized dialect node span, byte offsets over the UTF-8 source. */
export type DialectSpan = { node: string; from: number; to: number };

/** The set of node names each category pins, in `defineNodes` order. */
export const NODE_SETS: Record<string, readonly string[]> = {
  footnote: ["FootnoteDefinition", "FootnoteReference", "FootnoteLabel", "FootnoteMark"],
  highlight: ["Highlight", "HighlightMark"],
  wikilink: [
    "Wikilink",
    "WikilinkMark",
    "WikilinkTarget",
    "WikilinkAlias",
    "WikilinkHeading",
    "WikilinkBlockId",
  ],
  "definition-list": ["DefinitionList", "DefinitionTerm", "DefinitionDesc", "DefinitionMarker"],
  "inline-tag": ["InlineTag"],
  math: ["InlineMath", "MathMark"],
};

/**
 * Convert a UTF-16 code-unit index into `source` to a UTF-8 byte offset.
 * Lezer node boundaries always fall on character boundaries (never mid
 * surrogate pair), so slicing at `idx` is safe.
 */
export function utf16ToUtf8Offset(source: string, idx: number): number {
  return Buffer.byteLength(source.slice(0, idx), "utf8");
}

/**
 * Parse `source` and return every span whose node name is in `category`'s node
 * set, in document (pre-order) traversal order, with UTF-8 byte offsets.
 */
export function extractSpans(source: string, category: string): DialectSpan[] {
  const names = new Set(NODE_SETS[category]);
  if (names.size === 0) throw new Error(`unknown dialect category '${category}'`);
  const spans: DialectSpan[] = [];
  parser.parse(source).iterate({
    enter: (n) => {
      if (names.has(n.name)) {
        spans.push({
          node: n.name,
          from: utf16ToUtf8Offset(source, n.from),
          to: utf16ToUtf8Offset(source, n.to),
        });
      }
    },
  });
  return spans;
}

export function fromHex(hex: string): string {
  return Buffer.from(hex, "hex").toString("utf8");
}
export function toHex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}
