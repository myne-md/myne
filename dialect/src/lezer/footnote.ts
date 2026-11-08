// Footnote extension for the Myne markdown dialect.
//
// Spec: myne-agents/docs/spec/markdown-dialect.md §3.4 (the two footnote constructs) + §8
// (informative parser config). GFM does NOT parse footnotes — the @lezer/markdown
// `GFM` bundle is `[Table, TaskList, Strikethrough, Autolink]` and the package
// exports no `Footnote` config — so there is no AST node to decorate without this
// custom `MarkdownConfig`. MYND-153.
//
// A minimal CUSTOM config (not the community example) keeps the dependency
// surface flat (no vendored file) and matches the pinned-subset discipline the
// sibling `definition-list.ts` established. Decision recorded in
// myne-agents/docs/decisions.md (2026-05-31, MYND-153).
//
// Two constructs, two hooks:
//   - Inline REFERENCE `[^id]` → `FootnoteReference` node, registered
//     `before: "Link"` so `[^…]` outranks standard `[text](url)` link parsing
//     (the Wikilink precedent). Children: `FootnoteMark` (`[^`), `FootnoteLabel`
//     (the id), `FootnoteMark` (`]`) — mirroring how `Link`/`Autolink` expose
//     `LinkMark` children so the decoration can locate + hide the brackets.
//   - Block DEFINITION `[^id]: text` → `FootnoteDefinition` **composite** block
//     node, registered `before: "LinkReference"` so a `[^1]: note` line is
//     claimed as a footnote definition rather than half-parsed as a CommonMark
//     link reference definition. The marker children are `FootnoteMark` (`[^`),
//     `FootnoteLabel` (the id), `FootnoteMark` (`]:`); the definition BODY is
//     parsed as nested block content (Paragraph, FencedCode, Blockquote, …) via
//     a composite-block continuation rule (`NodeSpec.composite`), so
//     multi-paragraph footnotes and fenced code / blockquotes *inside* a
//     footnote render correctly (MYND-153 AC#3).
//
// SUBSET (the dialect, not just the code):
//   - An identifier is a non-empty run of non-whitespace characters that
//     contains no `]` (§3.4 "any non-whitespace string is permitted").
//   - A definition is recognized when it STARTS a block line (after ≤3 spaces of
//     indentation): `[^id]:` optionally followed by content. A bare `[^id]:`
//     (empty definition) is allowed.
//   - The body continues onto following lines that are blank OR indented by at
//     least `FOOTNOTE_CONT_INDENT` (4) columns (the Pandoc / GitHub continuation
//     rule); it ends at the first non-blank line indented less than that. Ids
//     containing whitespace are not recognized (preserved byte-stably as text).
//
// Recognizer-only: emits nodes, never mutates source bytes (§3.7 / §6 C1
// discipline, generalized to footnotes).

import type {
  BlockContext,
  Line,
  MarkdownConfig,
} from "@lezer/markdown";
import { isWhitespace } from "./whitespace";

const CHAR_LBRACKET = 91; // [
const CHAR_RBRACKET = 93; // ]
const CHAR_CARET = 94; // ^
const CHAR_COLON = 58; // :
const CHAR_SPACE = 32;
const CHAR_TAB = 9;

/**
 * If `line` begins with a footnote-definition marker (`[^id]:`), return the
 * relevant columns within `line.text`; otherwise `null`. Leading indentation
 * is already skipped to `line.pos`. `contentCol` is the first column of the
 * definition text (after the `]:` and any single run of spaces/tabs); it equals
 * `line.text.length` for a bare `[^id]:` with no text.
 */
function matchDefinition(
  line: Line,
): { idStart: number; idEnd: number; markEnd: number; contentCol: number } | null {
  const text = line.text;
  const start = line.pos;
  if (text.charCodeAt(start) !== CHAR_LBRACKET) return null;
  if (text.charCodeAt(start + 1) !== CHAR_CARET) return null;
  const idStart = start + 2;
  let j = idStart;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === CHAR_RBRACKET) break;
    if (isWhitespace(c)) return null; // ids carry no whitespace
    j++;
  }
  if (j >= text.length || text.charCodeAt(j) !== CHAR_RBRACKET) return null;
  if (j === idStart) return null; // empty id `[^]:`
  const idEnd = j;
  if (text.charCodeAt(idEnd + 1) !== CHAR_COLON) return null;
  const markEnd = idEnd + 2; // past `]:`
  let k = markEnd;
  while (
    k < text.length &&
    (text.charCodeAt(k) === CHAR_SPACE || text.charCodeAt(k) === CHAR_TAB)
  ) {
    k++;
  }
  return { idStart, idEnd, markEnd, contentCol: k };
}

/** Columns a following line must be indented to stay part of a footnote body —
 *  the Pandoc / GitHub 4-space continuation rule. */
const FOOTNOTE_CONT_INDENT = 4;

/**
 * Composite-block continuation for `FootnoteDefinition`. Mirrors the built-in
 * `ListItem` rule: a line continues the footnote when it is blank (`next === -1`)
 * or indented at least `value` columns beyond the block's base; otherwise the
 * definition ends. On continuation it advances the base column so the body
 * parses as if un-indented (de-indented nested blocks).
 */
function footnoteContinue(_cx: BlockContext, line: Line, value: number): boolean {
  if (line.indent < line.baseIndent + value && line.next > -1) return false;
  line.moveBaseColumn(line.baseIndent + value);
  return true;
}

export const Footnote: MarkdownConfig = {
  defineNodes: [
    { name: "FootnoteDefinition", block: true, composite: footnoteContinue },
    "FootnoteReference",
    "FootnoteLabel",
    "FootnoteMark",
  ],
  parseBlock: [
    {
      name: "FootnoteDefinition",
      before: "LinkReference",
      // A footnote-definition line interrupts an open paragraph, so consecutive
      // definitions (`[^1]: a` / `[^2]: b` with no blank line) split into
      // separate nodes instead of the second lazily continuing the first's
      // paragraph. (An ordinary unindented paragraph line still lazily continues
      // an open footnote body — standard CommonMark, as with blockquotes/lists.)
      endLeaf(_cx: BlockContext, line: Line): boolean {
        return matchDefinition(line) !== null;
      },
      parse(cx: BlockContext, line: Line): boolean | null {
        const m = matchDefinition(line);
        if (m === null) return false;

        const lineStart = cx.lineStart;
        const from = lineStart + line.pos;

        // Open a composite block, attach the marker children, then move the base
        // past `]:` so the rest of this line — plus any indented continuation
        // lines (handled by `footnoteContinue`) — parses as the footnote's
        // nested block body. Returning null signals "composite started".
        cx.startComposite("FootnoteDefinition", line.pos, FOOTNOTE_CONT_INDENT);
        cx.addElement(cx.elt("FootnoteMark", from, lineStart + m.idStart)); // `[^`
        cx.addElement(cx.elt("FootnoteLabel", lineStart + m.idStart, lineStart + m.idEnd));
        cx.addElement(cx.elt("FootnoteMark", lineStart + m.idEnd, lineStart + m.markEnd)); // `]:`
        line.moveBase(m.markEnd);
        return null;
      },
    },
  ],
  parseInline: [
    {
      name: "FootnoteReference",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== CHAR_LBRACKET) return -1;
        if (cx.char(pos + 1) !== CHAR_CARET) return -1;
        const idStart = pos + 2;
        let scan = idStart;
        while (scan < cx.end) {
          const c = cx.char(scan);
          if (c === CHAR_RBRACKET) break;
          if (isWhitespace(c)) return -1; // ids carry no whitespace
          scan++;
        }
        if (scan >= cx.end || cx.char(scan) !== CHAR_RBRACKET) return -1;
        if (scan === idStart) return -1; // empty id `[^]`
        const idEnd = scan;
        const closeEnd = scan + 1;

        const children = [
          cx.elt("FootnoteMark", pos, idStart), // `[^`
          cx.elt("FootnoteLabel", idStart, idEnd),
          cx.elt("FootnoteMark", idEnd, closeEnd), // `]`
        ];
        return cx.addElement(
          cx.elt("FootnoteReference", pos, closeEnd, children),
        );
      },
    },
  ],
};
