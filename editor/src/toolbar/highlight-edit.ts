// Caret-aware highlight editing (MYND-637). The selection toolbar's highlight
// control is create-only today: it always WRAPS the selection. That makes
// editing an existing highlight impossible without diving into raw HTML — the
// ticket's complaint #1. This module detects the highlight ENCLOSING the current
// selection (yellow `==…==` or colored `<mark class="hl-*">…</mark>`) and rewrites
// it in place: change colour, swap yellow↔colour, or remove — keeping the inner
// text and leaving storage as `<mark class="hl-*">` / `==` (untouched, MYND-285).
//
// Detection is line-scoped: a highlight and the selection editing it sit on one
// line in every real case (`==` never spans lines; a colored `<mark>` is authored
// inline). A selection spanning lines, or only partly overlapping a highlight,
// returns null — the control falls back to plain create-wrap.

import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { HIGHLIGHT_CLASSES } from "../html/sanitize";

// Only an allowlisted colour is an editable colored highlight — matching what
// colored-highlight.ts paints and what the sanitizer keeps (MYND-637). An unknown
// `hl-*` in the buffer is not treated as one.
const HL_SET: ReadonlySet<string> = new Set(HIGHLIGHT_CLASSES);

/** A highlight that fully contains the current selection. `color` is an `hl-*`
 *  token — `hl-yellow` for a `==` highlight, `hl-<name>` for a `<mark>`. */
export interface EnclosingHighlight {
  kind: "eq" | "mark";
  color: string; // hl-yellow | hl-green | …
  outerFrom: number; // start of `==` / `<mark …>`
  outerTo: number; // end of `==` / `</mark>`
  innerFrom: number; // first char of the highlighted text
  innerTo: number; // just past the highlighted text
}

const MARK_RE = /<mark class="(hl-[a-z-]+)">([\s\S]*?)<\/mark>/gi;
const EQ_RE = /==(.+?)==/g; // single-line, non-greedy; `.` excludes newlines

/** The highlight enclosing selection `[from, to]`, or null. A `<mark>` is
 *  preferred over a `==` at the same spot (a colored highlight can't also be a
 *  yellow one). */
export function detectEnclosingHighlight(
  state: EditorState,
  from: number,
  to: number,
): EnclosingHighlight | null {
  const line = state.doc.lineAt(from);
  if (to > line.to) return null; // spans lines — out of scope, fall back to create
  const base = line.from;
  const text = state.doc.sliceString(line.from, line.to);

  MARK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARK_RE.exec(text)) !== null) {
    const color = m[1].toLowerCase();
    if (!HL_SET.has(color)) continue; // unknown class — not an editable highlight
    const start = base + m.index;
    const end = start + m[0].length;
    if (start <= from && end >= to) {
      const innerFrom = start + m[0].indexOf(">") + 1;
      const innerTo = end - "</mark>".length;
      return {
        kind: "mark",
        color,
        outerFrom: start,
        outerTo: end,
        innerFrom,
        innerTo,
      };
    }
  }

  EQ_RE.lastIndex = 0;
  while ((m = EQ_RE.exec(text)) !== null) {
    const start = base + m.index;
    const end = start + m[0].length;
    if (start <= from && end >= to) {
      return {
        kind: "eq",
        color: "hl-yellow",
        outerFrom: start,
        outerTo: end,
        innerFrom: start + 2,
        innerTo: end - 2,
      };
    }
  }
  return null;
}

/** The source bytes wrapping `inner` in the given colour — the byte-identical
 *  counterpart of the toolbar's create swatches (`==` for yellow, `<mark …>`
 *  otherwise). Storage stays the settled `hl-*` form. */
function wrapInColor(color: string, inner: string): string {
  return color === "hl-yellow"
    ? `==${inner}==`
    : `<mark class="${color}">${inner}</mark>`;
}

/** Rewrite the enclosing highlight to `targetColor`. Choosing the CURRENT colour
 *  toggles the highlight OFF (strips the markers, keeps the text) — so the active
 *  swatch and the Remove item are one code path. The new span is left selected so
 *  the toolbar stays up and re-reflects the change. */
export function applyHighlightEdit(
  view: EditorView,
  enc: EnclosingHighlight,
  targetColor: string,
): void {
  const inner = view.state.doc.sliceString(enc.innerFrom, enc.innerTo);
  const insert = targetColor === enc.color ? inner : wrapInColor(targetColor, inner);
  view.dispatch({
    changes: { from: enc.outerFrom, to: enc.outerTo, insert },
    selection: { anchor: enc.outerFrom, head: enc.outerFrom + insert.length },
    userEvent: "toolbar.highlight",
  });
  view.focus();
}
