// Spec: docs/spec/markdown-dialect.md §3.6 (frontmatter), §3 (body).

import { parser } from "./lezer/parser";
import {
  FRONTMATTER_OPENER,
  type FrontmatterRange,
  locateFrontmatter,
} from "./lezer/frontmatter";
import { parseFrontmatter } from "./visitors/frontmatter";
import { extractHeadings } from "./visitors/headings";
import { extractWikilinks } from "./visitors/wikilinks";
import { extractInlineTags } from "./visitors/inlineTags";
import { extractMediaRefs } from "./visitors/mediaRefs";
import { extractFullText } from "./visitors/fullText";
import type { ByteRange, ParseError, ParseResult } from "./types";

const utf8Decoder = new TextDecoder("utf-8");

function decodeIfBytes(input: Uint8Array | string): string {
  return typeof input === "string" ? input : utf8Decoder.decode(input);
}

// Lezer doesn't have a Frontmatter parse-tree node yet; its body parser
// sees the YAML lines as paragraphs / Setext headings / etc. Filter at
// the aggregator level until a future polish task promotes Frontmatter
// to a real `MarkdownConfig` node.
function filterOutsideFrontmatter<T extends { byteRange: ByteRange }>(
  items: T[],
  fm: ByteRange | null,
): T[] {
  if (fm === null) return items;
  return items.filter(
    (item) => item.byteRange.end <= fm.start || item.byteRange.start >= fm.end,
  );
}

function detectBodyErrors(
  source: string,
  fm: FrontmatterRange | null,
): ParseError[] {
  // Lezer recovery silently absorbs `---` opener-without-closer; surface
  // it as a structured warning so importer UIs can display it. (Wikilink
  // and fenced-code unclosed validators are reserved in the type union
  // for future tasks.)
  if (fm === null && source.startsWith(FRONTMATTER_OPENER)) {
    return [
      {
        kind: "frontmatter-unclosed",
        severity: "error",
        message:
          "Frontmatter opener `---` at line 1 has no matching closer; body parsed as if no frontmatter were present",
        openerLine: 1,
      },
    ];
  }
  return [];
}

const EMPTY_RESULT: ParseResult = {
  frontmatter: { raw: null, parsed: null, byteRange: null, error: null },
  headings: [],
  wikilinks: [],
  inlineTags: [],
  mediaRefs: [],
  fullText: "",
  errors: [],
};

export function parse(input: Uint8Array | string): ParseResult {
  const source = decodeIfBytes(input);
  if (source.length === 0) return { ...EMPTY_RESULT };

  const tree = parser.parse(source);
  const fm = locateFrontmatter(source);
  const frontmatter = parseFrontmatter(source);
  const fmRange = frontmatter.byteRange;

  return {
    frontmatter,
    headings: filterOutsideFrontmatter(extractHeadings(source, tree), fmRange),
    wikilinks: filterOutsideFrontmatter(extractWikilinks(source, tree), fmRange),
    inlineTags: filterOutsideFrontmatter(extractInlineTags(source, tree), fmRange),
    mediaRefs: filterOutsideFrontmatter(extractMediaRefs(source, tree), fmRange),
    fullText: extractFullText(source, tree, fm),
    errors: detectBodyErrors(source, fm),
  };
}
