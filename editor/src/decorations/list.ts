// Plain bullet / ordered list rendering (MYND-208, render-conformance-harness
// task 4; `decisions.md` 2026-06-08 — reverses the prior implicit
// "lists render highlight-only" status).
//
// Cursor-aware, like emphasis / inline-code: OFF the marker's line, the raw
// list marker is replaced with a rendered glyph (`-`/`*`/`+` → `•` at top level,
// `◦` when nested; ordered `n.` stays a number but is muted) and the line gets a
// hanging indent so wrapped lines align under the body, not the marker. ON the
// line, the raw `- ` / `1. ` source is revealed for editing. Render-only — the
// buffer is never mutated (§6 C1).
//
// Task-list items (`- [ ]` / `- [x]`) are owned by `task-list.ts` (it hides the
// `-` and renders a checkbox); this decoration SKIPS them so the two don't both
// claim the marker. Nesting indent itself comes from the source's leading
// whitespace (which CM6 renders); this only swaps the glyph + adds the
// hanging-indent line box.

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { isCursorLine } from "./cursor-aware";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";

// The bullet is drawn by CSS (a filled disc top-level, a hollow ring when
// nested) rather than a Unicode glyph — `•` and `◦` render at wildly different
// sizes/baselines across fonts (the tiny-high-dot vs big-ring look), so a CSS
// circle keeps both consistent and crisp.
class ListBulletWidget extends WidgetType {
  constructor(private readonly nested: boolean) {
    super();
  }
  eq(other: ListBulletWidget): boolean {
    return other.nested === this.nested;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.nested
      ? "cm-list-bullet cm-list-bullet-ring"
      : "cm-list-bullet";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

/** True if the list item starting at this mark is a GFM task item (`- [ ]` /
 *  `- [x]`), which `task-list.ts` owns — `list.ts` leaves those alone. */
function isTaskItem(doc: string): boolean {
  return /^\s*\[[ xX]\]/.test(doc);
}

/** Number of ancestor list nodes above this one (0 = top level). */
function listDepth(node: { parent: { name: string; parent: unknown } | null }): number {
  let depth = 0;
  let cur = node.parent;
  while (cur !== null) {
    if (cur.name === "BulletList" || cur.name === "OrderedList") depth++;
    cur = (cur as { parent: { name: string; parent: unknown } | null }).parent;
  }
  // The mark's immediate list ancestor counts as level 1 in the walk; map to a
  // 0-based depth for glyph selection.
  return Math.max(0, depth - 1);
}

/** True if this list item is nested inside a blockquote. Such lines already get
 *  their left padding (to clear the quote bar) from `blockquote.ts`; adding the
 *  list's own negative-text-indent hanging indent ON TOP pulls the marker LEFT of
 *  the bar (the markers-collide-with-blockquote bug). So we skip the hanging
 *  indent there and let the quote padding position the marker after the bar. */
function inBlockquote(node: { parent: { name: string; parent: unknown } | null }): boolean {
  for (let cur = node.parent; cur !== null; ) {
    if (cur.name === "Blockquote") return true;
    cur = (cur as { parent: { name: string; parent: unknown } | null }).parent;
  }
  return false;
}

/** Rendered width of the bullet widget, in `ch` — `.cm-list-bullet`'s `width:
 *  1ch` plus its `margin-right: 0.4ch` (theme.ts). Keep in step with that rule:
 *  they are the same measurement expressed on two sides of the DOM. */
const BULLET_WIDTH_CH = 1.4;

/** A tab's column width, matching the editor's `tabSize`. */
const TAB_COLS = 4;

/** Leading indentation of `text`, in columns (tabs expanded). */
function leadingCols(text: string): number {
  let cols = 0;
  for (const ch of text) {
    if (ch === " ") cols += 1;
    else if (ch === "\t") cols += TAB_COLS;
    else break;
  }
  return cols;
}

/**
 * The hanging indent a list line needs so its WRAPPED lines sit under the body
 * text, in `ch`.
 *
 * Measured against what is actually painted, which differs by state:
 * - off-cursor bullet — the raw marker is replaced by the widget, so the body
 *   starts at `indent + BULLET_WIDTH_CH`;
 * - off-cursor ordered — the number stays as text, so the body starts after the
 *   marker and its trailing space;
 * - on-cursor (either) — the raw source is revealed, so the body starts at the
 *   source column of the first content character.
 *
 * Computing all three keeps the wrap column stable when the caret enters and
 * leaves the line, instead of shifting by the widget-vs-source width difference.
 */
function hangingIndentCh(
  doc: EditorView["state"]["doc"],
  line: { from: number; to: number; text: string },
  markFrom: number,
  markTo: number,
  view: EditorView,
): number {
  const indent = leadingCols(line.text);
  const markerLen = markTo - markFrom;
  const trailing = doc.sliceString(markTo, line.to).match(/^[ \t]*/);
  const gap = trailing ? leadingCols(trailing[0]) : 0;
  const rawOffset = indent + markerLen + gap;

  if (isCursorLine(view, line.from, line.to)) return rawOffset;

  const marker = doc.sliceString(markFrom, markTo);
  // Bullets render as the fixed-width widget; ordered markers keep their digits.
  return /^[-*+]$/.test(marker) ? indent + BULLET_WIDTH_CH : rawOffset;
}

function buildListDecorations(view: EditorView): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  const doc = view.state.doc;
  const seenLines = new Set<number>();

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "ListMark") return undefined;
        const line = doc.lineAt(node.from);
        const afterMark = doc.sliceString(node.to, Math.min(node.to + 4, line.to));
        if (isTaskItem(afterMark)) return undefined; // task-list owns it

        // Hanging indent on every list-item line — EXCEPT inside a blockquote,
        // where the quote bar + padding owns the line's left edge (see
        // `inBlockquote`).
        //
        // MYND-626: the indent is MEASURED per line, not a fixed 1.5em. A fixed
        // value cannot be right for more than one shape at a time: the bullet
        // widget is `1ch + 0.4ch` wide (theme `.cm-list-bullet`), an ordered
        // marker is as wide as its own digits, and a nested item carries leading
        // source whitespace that the first line renders but a wrapped line does
        // not. At one nesting level the old constant was already ~2x the real
        // offset, which is what pushed wrapped lines visibly right of the body
        // column instead of hanging under it.
        if (!seenLines.has(line.from) && !inBlockquote(node.node)) {
          seenLines.add(line.from);
          const offset = hangingIndentCh(doc, line, node.from, node.to, view);
          decorations.push(
            Decoration.line({
              class: "cm-list-item-line",
              attributes: {
                style: `text-indent:-${offset}ch;padding-left:calc(${offset}ch + 6px)`,
              },
            }).range(line.from),
          );
        }

        // Glyph / mute is cursor-aware: reveal the raw marker on the line.
        if (isCursorLine(view, line.from, line.to)) return undefined;

        const marker = doc.sliceString(node.from, node.to);
        if (/^[-*+]$/.test(marker)) {
          // Replace the marker AND its trailing whitespace with the bullet; the
          // gap to the body is the bullet's `margin-right` (theme), so a leftover
          // source space doesn't widen it into the "too much gap" look.
          const rest = doc.sliceString(node.to, line.to);
          const ws = rest.match(/^[ \t]+/);
          const contentStart = node.to + (ws ? ws[0].length : 0);
          decorations.push(
            Decoration.replace({
              widget: new ListBulletWidget(listDepth(node.node) > 0),
            }).range(node.from, contentStart),
          );
        } else if (/^\d+[.)]$/.test(marker)) {
          decorations.push(
            Decoration.mark({ class: "cm-list-number" }).range(node.from, node.to),
          );
        }
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function listDecorations(): Extension {
  return makeCursorAwareDecorationPlugin(buildListDecorations);
}
