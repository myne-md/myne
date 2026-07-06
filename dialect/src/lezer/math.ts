// Inline math extension (`$…$`) for the Myne dialect (MYND-48, math-katex).
//
// Block `$$…$$` is handled at the decoration layer (a regex block widget, like
// embedded-html blocks) — `$$` is unambiguous, so it needs no parser node. The
// hard part is INLINE `$…$` disambiguation vs currency, written here per the
// Pandoc/Obsidian rules the grill pinned (`sessions/grill/2026-06-08-math-katex.md`):
//   - opening `$` must NOT be followed by whitespace or a digit (`$5` = currency);
//   - closing `$` must NOT be preceded by whitespace;
//   - `$$` is not inline (block);
//   - a `$…$` run does not cross a line break.
//
// InlineMath is a LEAF node (no inline children parsed inside), so `#tags` /
// emphasis do not parse within math — the SYNC-9 math-zone exclusion is
// structural (and inline-tag's deny-list already excludes `$`, §3.7.2). Math
// also never fires inside code: code spans/blocks consume their range first.

import type { InlineContext, MarkdownConfig } from "@lezer/markdown";

const DOLLAR = 36; // '$'
const SPACE = 32;
const TAB = 9;

function isSpace(c: number): boolean {
  return c === SPACE || c === TAB || c === 10 || c === 13;
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

export const Math: MarkdownConfig = {
  defineNodes: [{ name: "InlineMath" }, { name: "MathMark" }],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== DOLLAR) return -1;
        if (cx.char(pos + 1) === DOLLAR) return -1; // `$$` open → block, not inline
        if (cx.char(pos - 1) === DOLLAR) return -1; // 2nd `$` of a `$$` — not an open
        const after = cx.char(pos + 1);
        if (after === -1 || isSpace(after) || isDigit(after)) return -1; // currency / empty
        for (let i = pos + 1; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10 || c === 13) break; // single-line only
          if (c === DOLLAR) {
            if (cx.char(i + 1) === DOLLAR) continue; // `$$` — not a clean inline close
            const before = cx.char(i - 1);
            if (before === SPACE || before === TAB) continue; // space before close → not a close
            return cx.addElement(
              cx.elt("InlineMath", pos, i + 1, [
                cx.elt("MathMark", pos, pos + 1),
                cx.elt("MathMark", i, i + 1),
              ]),
            );
          }
        }
        return -1;
      },
      before: "Emphasis",
    },
  ],
};
