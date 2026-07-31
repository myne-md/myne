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
import { MARK_HL_RE, isOwnedHighlightClass } from "../html/sanitize";

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

/** The source markers that wrap text in `color` — `==` for yellow, `<mark …>`
 *  otherwise. The SINGLE source for both the toolbar's create swatches and the
 *  in-place edit path below; storage stays the settled `hl-*` form (MYND-285). */
export function highlightMarkers(color: string): readonly [string, string] {
  return color === "hl-yellow"
    ? ["==", "=="]
    : [`<mark class="${color}">`, "</mark>"];
}

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
  const contains = (start: number, end: number): boolean =>
    start <= from && end >= to;

  MARK_HL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARK_HL_RE.exec(text)) !== null) {
    const color = m[1].toLowerCase();
    if (!isOwnedHighlightClass(color)) continue; // unknown class — not editable
    const start = base + m.index;
    const end = start + m[0].length;
    if (contains(start, end)) {
      return {
        kind: "mark",
        color,
        outerFrom: start,
        outerTo: end,
        innerFrom: start + m[0].indexOf(">") + 1,
        innerTo: end - "</mark>".length,
      };
    }
  }

  EQ_RE.lastIndex = 0;
  while ((m = EQ_RE.exec(text)) !== null) {
    const start = base + m.index;
    const end = start + m[0].length;
    if (contains(start, end)) {
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

/** The source bytes wrapping `inner` in the given colour. */
function wrapInColor(color: string, inner: string): string {
  const [open, close] = highlightMarkers(color);
  return `${open}${inner}${close}`;
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
