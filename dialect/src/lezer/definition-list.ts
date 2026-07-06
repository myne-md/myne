// Pandoc-style definition lists (`Term \n : Definition`) for the Myne markdown
// dialect.
//
// Spec: docs/spec/markdown-dialect.md §3 (recognized block syntax) + §8
// (informative parser config). The GFM grammar does NOT parse definition lists,
// so there is no AST node to decorate without this custom `MarkdownConfig`.
// MYND-152; scope reversal recorded in docs/decisions.md 2026-05-30.
//
// PINNED SUBSET (what this parser recognizes — the dialect, not just the code):
//   - A definition list is a TERM line (an ordinary paragraph-style first line,
//     not itself starting with `:`) immediately followed — no blank line
//     between — by one or more DEFINITION lines.
//   - A definition line is `:` + at least one space/tab + the definition text.
//     A bare `:` (empty definition) is allowed.
//   - Multiple consecutive definition lines attach as multiple definitions of
//     the same term.
//   - NOT in the subset (deliberately, to keep the parser correct + scoped):
//     the loose/blank-line-separated form, lazy continuation lines (a single
//     definition wrapping onto a non-`:` line), and multiple terms per
//     definition block. These remain ordinary paragraphs and round-trip
//     byte-stably. Future widening is a spec change, not a silent parser tweak.
//
// Mechanism: a `LeafBlockParser` (the same hook CommonMark uses for setext
// headings + link references) observes each paragraph; if its FIRST
// continuation line is a definition marker, it claims the block, consumes the
// run of marker lines itself, and emits the node. Otherwise it declines and the
// block falls back to a normal paragraph.

import type {
  BlockContext,
  LeafBlock,
  LeafBlockParser,
  Line,
  MarkdownConfig,
} from "@lezer/markdown";

const CHAR_COLON = 58; // :
const CHAR_SPACE = 32;
const CHAR_TAB = 9;

/**
 * If `line` is a definition-marker line (`:` + whitespace + content, or a bare
 * `:`), return the column in `line.text` where the description content starts;
 * otherwise return -1. Leading indentation is already skipped to `line.pos`.
 */
function definitionDescColumn(line: Line): number {
  if (line.next !== CHAR_COLON) return -1;
  const after = line.pos + 1;
  if (after >= line.text.length) return after; // bare ":" → empty description
  const ch = line.text.charCodeAt(after);
  if (ch !== CHAR_SPACE && ch !== CHAR_TAB) return -1; // require a space after ':'
  let col = after;
  while (
    col < line.text.length &&
    (line.text.charCodeAt(col) === CHAR_SPACE ||
      line.text.charCodeAt(col) === CHAR_TAB)
  ) {
    col++;
  }
  return col;
}

interface Definition {
  readonly markerFrom: number;
  readonly markerTo: number;
  readonly descFrom: number;
  readonly descTo: number;
  readonly descText: string;
}

class DefinitionListParser implements LeafBlockParser {
  private declined = false;
  private readonly definitions: Definition[] = [];

  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    if (this.declined) return false;
    const descCol = definitionDescColumn(line);

    if (this.definitions.length === 0 && descCol < 0) {
      // The line immediately after the term is not a marker → this is an
      // ordinary paragraph (tight form only). Decline permanently.
      this.declined = true;
      return false;
    }
    if (descCol < 0) {
      // A non-marker line after we've collected definitions ends the list (no
      // lazy continuation in the pinned subset). Emit, do NOT consume the line.
      this.emit(cx, leaf);
      return true;
    }

    // Record this marker line, then consume any further consecutive markers.
    let dc = descCol;
    do {
      const markerFrom = cx.lineStart + line.pos;
      this.definitions.push({
        markerFrom,
        markerTo: markerFrom + 1,
        descFrom: cx.lineStart + dc,
        descTo: cx.lineStart + line.text.length,
        descText: line.text.slice(dc),
      });
      if (!cx.nextLine() || line.pos >= line.text.length) break;
      dc = definitionDescColumn(line);
    } while (dc >= 0);

    this.emit(cx, leaf);
    return true;
  }

  finish(): boolean {
    // Reached only when no marker line ever appeared (e.g. a blank line or EOF
    // right after the term) — decline so the block stays a paragraph.
    return false;
  }

  private emit(cx: BlockContext, leaf: LeafBlock): void {
    const termFrom = leaf.start;
    const termTo = leaf.start + leaf.content.length;
    const children = [
      cx.elt(
        "DefinitionTerm",
        termFrom,
        termTo,
        cx.parser.parseInline(leaf.content, termFrom),
      ),
    ];
    for (const d of this.definitions) {
      children.push(cx.elt("DefinitionMarker", d.markerFrom, d.markerTo));
      children.push(
        cx.elt(
          "DefinitionDesc",
          d.descFrom,
          d.descTo,
          d.descTo > d.descFrom
            ? cx.parser.parseInline(d.descText, d.descFrom)
            : [],
        ),
      );
    }
    cx.addLeafElement(
      leaf,
      cx.elt("DefinitionList", termFrom, cx.prevLineEnd(), children),
    );
  }
}

export const DefinitionList: MarkdownConfig = {
  defineNodes: [
    { name: "DefinitionList", block: true },
    "DefinitionTerm",
    "DefinitionDesc",
    "DefinitionMarker",
  ],
  parseBlock: [
    {
      name: "DefinitionList",
      leaf(_cx: BlockContext, leaf: LeafBlock): LeafBlockParser | null {
        // Observe paragraph-style blocks whose first line is a plausible term:
        // non-empty and not itself a `:` definition line.
        if (leaf.content.length === 0) return null;
        if (leaf.content.charCodeAt(0) === CHAR_COLON) return null;
        return new DefinitionListParser();
      },
      before: "SetextHeading",
    },
  ],
};
