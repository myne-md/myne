// Highlight inline extension (`==text==`) for the Myne dialect (MYND-156,
// inline-typography-extensions). `@lezer/markdown` ships Subscript / Superscript
// / Emoji configs but NOT a highlight config, so this is the one hand-rolled
// MarkdownConfig — modeled on the bundle's Strikethrough delimiter pattern,
// swapping `~~` for `==`.
//
// `==` opens and closes a Highlight; a third `=` disqualifies the run (mirrors
// Strikethrough's `~~~` guard) so `===` Setext-ish noise isn't mis-parsed.
// Recognize-only: the decoration renders it; bytes are never rewritten (§6 C1).

import type { InlineContext, MarkdownConfig } from "@lezer/markdown";

const EQ = 61; // '='

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

export const Highlight: MarkdownConfig = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark" }],
  parseInline: [
    {
      name: "Highlight",
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== EQ || cx.char(pos + 1) !== EQ || cx.char(pos + 2) === EQ) {
          return -1;
        }
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, true, true);
      },
      // After Emphasis so `**==x==**` nests predictably (same slot family as
      // Strikethrough, which registers after Emphasis in the GFM bundle).
      after: "Emphasis",
    },
  ],
};
