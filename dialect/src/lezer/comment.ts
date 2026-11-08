// Comment extension (`%%…%%`) for the Myne markdown dialect (MYND-315,
// editor-comments).
//
// Spec: agent-tooling/docs/spec/markdown-dialect.md §3.2 (inline `%%…%%`) + §3.1 (block /
// multi-line `%%`…`%%`) + §3.7.5 (exclusion zones) + §6 (lossy-projection
// strip) + §8 (this parser config). GFM ships no comment construct and
// `@lezer/markdown` exports none, so this is a hand-rolled `MarkdownConfig`
// modeled on the sibling `highlight.ts` (the `==…==` inline delimiter) and
// `definition-list.ts` / `footnote.ts` (the leaf-block accumulation pattern).
//
// Two constructs, two hooks — both **TERMINATED-ONLY**:
//   - Inline `%%text%%` → a `DialectComment` node with `DialectCommentMark`
//     (`%%`) children, via the delimiter pair (exactly like Highlight's `==`).
//     An unmatched opening `%%` is left as plain text by the delimiter resolver
//     (no node) — the §3.2 "unterminated is inert" rule, for free.
//   - Block / multi-line `%%` … `%%` → a `DialectCommentBlock` node when a line
//     STARTS (after ≤3 spaces) with `%%` AND a closing `%%` appears later in
//     the same leaf-block run (same line or a following line). Implemented as a
//     `LeafBlockParser` (the def-list / link-reference pattern): it accumulates
//     lines, and on the FIRST line carrying a closing `%%` it commits;
//     `finish` (a blank line / EOF / another block opening) declines —
//     returning `false` — when no closing `%%` was seen, so the run reverts to
//     an ordinary Paragraph. That decline IS the §3.1 "unterminated is inert"
//     rule (a deliberate divergence from Obsidian's EOF-swallow — the safe
//     "my note didn't vanish" choice; bytes preserved per §6 C1 either way).
//
// The node names are DELIBERATELY distinct from `@lezer/markdown`'s reserved
// `Comment` (31) / `CommentBlock` (20) — those are HTML `<!-- -->` comment
// nodes the emitters already omit. The Myne `%%` dialect comment must be its
// own node so the strip targets it precisely.
//
// Exclusion zones (code fences / inline code / wikilinks / math-leaf /
// frontmatter, §3.7.5) are inherited STRUCTURALLY: the inline tokenizer runs
// only at outer-inline-text level (never descends into nested nodes), and the
// block leaf-parser only attaches to a paragraph-class line that literally
// starts with `%%` (a code fence / blockquote / list / heading line opens its
// own block first; frontmatter is detected line-1-anchored upstream).
// Recognize-and-render-only — emits nodes, never mutates source bytes (§6 C1).

import type {
  BlockContext,
  InlineContext,
  LeafBlock,
  LeafBlockParser,
  Line,
  MarkdownConfig,
} from "@lezer/markdown";

const CHAR_PERCENT = 37; // '%'

const CommentDelim = {
  resolve: "DialectComment",
  mark: "DialectCommentMark",
};

/**
 * Column of the first `%%` at or after `from` in `text` (a `%` immediately
 * followed by another `%`); -1 if none.
 */
function indexOfDelim(text: string, from: number): number {
  for (let i = from; i + 1 < text.length; i++) {
    if (
      text.charCodeAt(i) === CHAR_PERCENT &&
      text.charCodeAt(i + 1) === CHAR_PERCENT
    ) {
      return i;
    }
  }
  return -1;
}

/** True if `text` opens (at column 0) with `%%`. The leaf-block content always
 *  begins at the block's content column (leading indent already stripped). */
function opensWithDelim(text: string): boolean {
  return (
    text.charCodeAt(0) === CHAR_PERCENT && text.charCodeAt(1) === CHAR_PERCENT
  );
}

/**
 * Leaf-block parser for the multi-line `%%`…`%%` comment. `leaf.content`
 * accumulates the block's lines joined by `\n`, mapping 1:1 onto
 * `[leaf.start, leaf.start + leaf.content.length]` (lezer normalizes line
 * endings to `\n`), so a closer's column in `content` is its absolute position
 * minus `leaf.start`.
 */
class CommentBlockParser implements LeafBlockParser {
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    // Has the comment already closed on a PRIOR line (now in leaf.content)?
    const priorClose = indexOfDelim(leaf.content, 2);
    if (priorClose !== -1) {
      // Closed before this line — commit without consuming the current line so
      // it parses fresh as its own block.
      this.emit(cx, leaf, priorClose);
      return true;
    }
    // Otherwise, does the CURRENT line carry the closer? The combined text is
    // `leaf.content + "\n" + line.text`; the `\n` occupies one column.
    const offset = leaf.content.length + 1;
    const closeInLine = indexOfDelim(line.text, 0);
    if (closeInLine !== -1) {
      cx.nextLine(); // consume the closing line into the block
      this.emit(cx, leaf, offset + closeInLine);
      return true;
    }
    return false; // keep accumulating
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    // External termination (blank line / EOF / another block). Commit only if a
    // closing `%%` was actually seen in the accumulated content; otherwise
    // decline so the run stays an ordinary Paragraph (the inert rule).
    const close = indexOfDelim(leaf.content, 2);
    if (close === -1) return false;
    this.emit(cx, leaf, close);
    return true;
  }

  /** Emit the `DialectCommentBlock` spanning the opening `%%` through the
   *  closing `%%` (at column `closeCol` in the accumulated content). */
  private emit(cx: BlockContext, leaf: LeafBlock, closeCol: number): void {
    const from = leaf.start;
    const openMark = cx.elt("DialectCommentMark", from, from + 2);
    const closeFrom = from + closeCol;
    const closeMark = cx.elt("DialectCommentMark", closeFrom, closeFrom + 2);
    cx.addLeafElement(
      leaf,
      cx.elt("DialectCommentBlock", from, closeFrom + 2, [openMark, closeMark]),
    );
  }
}

export const Comment: MarkdownConfig = {
  defineNodes: [
    { name: "DialectCommentBlock", block: true },
    "DialectComment",
    "DialectCommentMark",
  ],
  parseBlock: [
    {
      name: "DialectCommentBlock",
      // A `%%`-opening line interrupts an open paragraph (a block comment may
      // follow prose without a blank line between), like footnote definitions.
      //
      // …but NOT an open comment block (myne#323). lezer consults these stops
      // BEFORE the leaf parsers' `nextLine`, and a multi-line comment's CLOSING
      // line also starts with `%%` — so this fired on the closer, broke out of
      // the line loop, and `finish` then found no closer in the accumulated
      // content and declined. The whole closer-on-its-own-line branch in
      // `nextLine` was unreachable, and the canonical multi-line shape the spec
      // documents parsed as ordinary prose.
      //
      // That is not a cosmetic miss: the comment is not dimmed, not excluded
      // from document statistics, and not stripped — so an editor-private
      // note-to-self ships verbatim in exported HTML, in the printed PDF and in
      // stripped TXT, and `hasDialectComment` answers false so nothing upstream
      // can warn.
      endLeaf(_cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
        const insideOpenComment =
          opensWithDelim(leaf.content) && indexOfDelim(leaf.content, 2) === -1;
        if (insideOpenComment) return false;
        return opensWithDelim(line.text.slice(line.pos));
      },
      // Attach the leaf parser when the leaf's first line starts with `%%`.
      leaf(_cx: BlockContext, leaf: LeafBlock): LeafBlockParser | null {
        return opensWithDelim(leaf.content) ? new CommentBlockParser() : null;
      },
    },
  ],
  parseInline: [
    {
      name: "DialectComment",
      // After Emphasis (same slot family as Highlight / Strikethrough) so
      // `**%%x%%**` nests predictably.
      after: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== CHAR_PERCENT || cx.char(pos + 1) !== CHAR_PERCENT) {
          return -1;
        }
        // `%%` both opens and closes a span; the resolver pairs them, and an
        // unmatched `%%` produces no node (inert).
        return cx.addDelimiter(CommentDelim, pos, pos + 2, true, true);
      },
    },
  ],
};
