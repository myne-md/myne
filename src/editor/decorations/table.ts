// GFM pipe-table rendering for the Phase 1 editor.
//
// PRD `editor-mvp-tables` (myne-agents/features/editor-mvp-tables/prd.md),
// grill 2026-05-28 (myne-agents/sessions/grill/2026-05-28-gfm-table-render.md).
//
// Decision (grill Q1-Q4): a complete GFM `Table` node renders as a read-only
// real `<table>` block widget — `Decoration.replace({ widget, block: true })`
// over the whole node. A true grid (cell borders, cross-row column alignment,
// contained horizontal scroll) needs all rows inside ONE DOM node; CM6 wraps
// each line in its own `.cm-line`, so per-row / per-cell widgets cannot
// cross-align. Hence one whole-block widget. Source stays canonical — the
// widget never mutates the buffer, so byte-stable round-trip is trivial.
//
// Block-replace decorations MUST be provided through a `StateField`, not a
// `ViewPlugin` (CM6 contract) — `frontmatter.ts` is the in-repo precedent.
// This file deliberately diverges from `frontmatter.ts` in TWO ways, both
// arriving across this feature's tasks: (1) the table widget is READ-ONLY
// (frontmatter's is an always-on editable Properties widget); (2) reveal is
// cursor-aware whole-table — Task 2 (`editor-mvp-tables` #2) makes the field
// selection-aware so the grid drops to raw pipe source when the cursor enters
// the table. THIS task (#1) renders the grid always-on; editing/reveal is #2.

import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type Extension,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type KeyBinding,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { revealActive, selectionTouchesLines } from "./cursor-aware";
import { makeCursorAwareStateField } from "./plugin-factory";

/** Per-column horizontal alignment; `null` = default (renders left). */
export type ColumnAlign = "left" | "center" | "right" | null;

interface TableRowModel {
  readonly cells: readonly string[];
  /** Document offset of this row's source line start — the selection target
   *  for click-to-edit (clicking the row places the cursor here, triggering
   *  whole-table reveal). */
  readonly from: number;
  readonly header: boolean;
}

interface TableModel {
  /** Raw source slice of the whole `Table` node. */
  readonly source: string;
  /** Document offset of the table's start. Part of `eq()` so a table that
   *  shifts position rebuilds the widget rather than reusing stale row
   *  offsets in the click handler. */
  readonly from: number;
  readonly align: readonly ColumnAlign[];
  readonly rows: readonly TableRowModel[];
}

/**
 * Split one pipe-table row into trimmed cell strings.
 *
 * Splits on `|` that is not backslash-escaped, drops the empty segments
 * produced by a leading / trailing pipe, trims each cell, and unescapes
 * `\|` → `|` for display. Robust to: empty cells (`| 1 |   | 3 |`), rows
 * without outer pipes (`a | b`), and escaped pipes inside a cell
 * (`x \| y | z` → `["x | y", "z"]`). Empty cells are preserved positionally
 * (only the leading/trailing pipe artifacts are dropped, not genuine
 * whitespace-only cells).
 */
export function splitTableRow(rawLine: string): string[] {
  const parts = rawLine.trim().split(/(?<!\\)\|/);
  if (parts.length > 1 && parts[0] === "") parts.shift();
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.map((c) => c.trim().replace(/\\\|/g, "|"));
}

/**
 * Parse a GFM delimiter row (`|:---|:--:|---:|`) into per-column alignment.
 * `:---` left, `:--:` center, `---:` right, `---` default (`null`).
 */
export function parseDelimiterAlign(delimiterRow: string): ColumnAlign[] {
  return splitTableRow(delimiterRow).map((seg) => {
    const left = seg.startsWith(":");
    const right = seg.endsWith(":");
    if (left && right) return "center";
    if (left) return "left";
    if (right) return "right";
    return null;
  });
}

/** Pad with empty cells or truncate so a row matches the column count. */
function fitRow(cells: string[], columns: number): string[] {
  if (cells.length === columns) return cells;
  if (cells.length > columns) return cells.slice(0, columns);
  return cells.concat(Array.from({ length: columns - cells.length }, () => ""));
}

/**
 * Build the render model from a `Table` syntax node. The column count is
 * canonically the delimiter row's; header and body rows are fit to it
 * (GFM: extra body cells dropped, missing body cells empty). Returns `null`
 * if the node is missing its header or delimiter child (defensive — the
 * parser only emits `Table` when both exist, so this should not happen).
 */
function buildTableModel(state: EditorState, table: SyntaxNode): TableModel | null {
  let headerSrc: string | null = null;
  let headerFrom = 0;
  let delimiterSrc: string | null = null;
  const bodySrcs: { src: string; from: number }[] = [];

  for (let child = table.firstChild; child; child = child.nextSibling) {
    const text = state.doc.sliceString(child.from, child.to);
    if (child.name === "TableHeader") {
      headerSrc = text;
      headerFrom = child.from;
    }
    // The whole separator row is a single direct-child `TableDelimiter`
    // node (the per-pipe delimiters live nested inside TableHeader/TableRow).
    else if (child.name === "TableDelimiter") delimiterSrc = text;
    else if (child.name === "TableRow") bodySrcs.push({ src: text, from: child.from });
  }

  if (headerSrc === null || delimiterSrc === null) return null;

  const align = parseDelimiterAlign(delimiterSrc);
  const columns = align.length;
  const rows: TableRowModel[] = [
    { cells: fitRow(splitTableRow(headerSrc), columns), from: headerFrom, header: true },
    ...bodySrcs.map((b) => ({
      cells: fitRow(splitTableRow(b.src), columns),
      from: b.from,
      header: false,
    })),
  ];
  return {
    source: state.doc.sliceString(table.from, table.to),
    from: table.from,
    align,
    rows,
  };
}

class TableWidget extends WidgetType {
  constructor(private readonly model: TableModel) {
    super();
  }

  // Equal when source AND start offset match — so a table that shifts position
  // (even with unchanged text) rebuilds, keeping the click handler's row
  // offsets correct. Within those, CM6 skips DOM rebuilds.
  eq(other: TableWidget): boolean {
    return (
      other.model.source === this.model.source &&
      other.model.from === this.model.from
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const { align, rows } = this.model;
    const scroll = document.createElement("div");
    scroll.className = "cm-table-scroll";

    const table = document.createElement("table");
    table.className = "cm-table";

    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    let bodyIndex = 0;
    for (const row of rows) {
      const tr = document.createElement("tr");
      const cellTag = row.header ? "th" : "td";
      if (row.header) {
        tr.className = "cm-table-row";
      } else {
        tr.className =
          bodyIndex % 2 === 1 ? "cm-table-row cm-table-row-alt" : "cm-table-row";
        bodyIndex++;
      }
      row.cells.forEach((cell, col) => {
        const el = document.createElement(cellTag);
        el.className = row.header ? "cm-table-header" : "cm-table-cell";
        applyAlign(el, align[col]);
        el.textContent = cell; // textContent — never innerHTML (TB2: no injection)
        tr.appendChild(el);
      });
      // Click-to-edit: place the cursor on this row's source line and focus,
      // which triggers whole-table reveal. The widget handles the event itself
      // (ignoreEvent → true) because a block widget is atomic — letting CM
      // handle the click would resolve it to a block boundary (the line below).
      tr.addEventListener("mousedown", (event) => {
        event.preventDefault();
        view.dispatch({
          selection: { anchor: row.from },
          userEvent: "select.pointer",
        });
        view.focus();
      });
      (row.header ? thead : tbody).appendChild(tr);
    }
    table.appendChild(thead);
    table.appendChild(tbody);

    scroll.appendChild(table);
    return scroll;
  }

  // The widget owns its pointer events (see the per-row mousedown handler in
  // toDOM). Returning true keeps CM from also handling the click — for an
  // atomic block widget CM would resolve a click to a block boundary (the
  // line below the table), which is the wrong target.
  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown";
  }
}

function applyAlign(cell: HTMLElement, align: ColumnAlign): void {
  if (align !== null) cell.style.textAlign = align;
}

/**
 * Decoration set for the current state. Pure function of `(state, focused)`
 * so the reveal decision is deterministically testable without driving DOM
 * focus events. For each complete `Table` node: emit a block-replace widget,
 * UNLESS the editor is focused AND a selection touches a line spanned by the
 * table — in that case emit nothing so the raw pipe source shows for editing
 * (whole-table cursor reveal). Reveal is gated on focus so a table the cursor
 * happens to sit in does not stay raw when the editor is unfocused (matches
 * the `isCursorLine` focus discipline used by the other decorations).
 */
export function buildTableDecorations(
  state: EditorState,
  focused: boolean,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return undefined;
      const model = buildTableModel(state, node.node);
      if (model === null) return false;
      // Span whole lines so the block-replace boundaries sit on line edges.
      const fromLine = state.doc.lineAt(node.from);
      const toLine = state.doc.lineAt(node.to);
      const revealed =
        focused && selectionTouchesLines(state, fromLine.number, toLine.number);
      if (!revealed) {
        builder.add(
          fromLine.from,
          toLine.to,
          Decoration.replace({ widget: new TableWidget(model), block: true }),
        );
      }
      return false; // don't descend into the table's children
    },
  });
  return builder.finish();
}

// Whole-table reveal is gated on `revealActive` (editor focused OR in-note find
// open — see `cursor-aware.ts`), threaded into state since this block-replace
// StateField has no `view`. The find clause lets navigating find onto a match
// inside a folded table un-fold it even though the find input, not the editor
// content, holds DOM focus (MYND-175). `makeCursorAwareStateField` owns the
// recompute gate + focus field/tracker ordering.
export function tableDecorations(): Extension {
  return makeCursorAwareStateField((state) =>
    buildTableDecorations(state, revealActive(state)),
  );
}

// --- Arrow-into-table navigation ----------------------------------------
//
// A rendered table is an atomic block widget, so CM steps OVER it: arrowing
// down from the line above a table lands on the line below it, never inside.
// These commands detect when a vertical cursor move would skip a table and
// redirect the cursor INTO the table's source instead (first row entering
// downward, last row entering upward), which triggers whole-table reveal.

/**
 * Given the current line and the line a vertical move would land on, return
 * the document offset to enter a table that the move would otherwise skip, or
 * `null` if no table is skipped. Downward (`targetLine > headLine`) → the
 * first source line of the nearest skipped table; upward → the last source
 * line of the nearest skipped table. Pure (no layout) so it is unit-testable;
 * the layout-dependent `moveVertically` call lives in the commands below.
 */
export function findTableEntry(
  state: EditorState,
  headLine: number,
  targetLine: number,
): number | null {
  const doc = state.doc;
  const tree = syntaxTree(state);

  if (targetLine > headLine) {
    let result: number | null = null;
    tree.iterate({
      from: doc.line(headLine).to,
      to: doc.line(Math.min(targetLine, doc.lines)).to,
      enter: (node) => {
        if (result !== null) return false;
        if (node.name === "Table") {
          const first = doc.lineAt(node.from).number;
          if (first > headLine && first <= targetLine) {
            result = doc.line(first).from;
          }
          return false;
        }
        return undefined;
      },
    });
    return result;
  }

  if (targetLine < headLine) {
    // Nearest table above head: keep the last match in document order.
    let result: number | null = null;
    tree.iterate({
      from: doc.line(Math.max(targetLine, 1)).from,
      to: doc.line(headLine).from,
      enter: (node) => {
        if (node.name === "Table") {
          const last = doc.lineAt(node.to).number;
          if (last >= targetLine && last < headLine) {
            result = doc.line(last).from;
          }
          return false;
        }
        return undefined;
      },
    });
    return result;
  }

  return null;
}

function enterTable(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  const main = state.selection.main;
  if (!main.empty) return false; // plain cursor only; let selection-extend skip
  const target = view.moveVertically(
    EditorSelection.cursor(main.head),
    forward,
  ).head;
  const headLine = state.doc.lineAt(main.head).number;
  const targetLine = state.doc.lineAt(target).number;
  if (targetLine === headLine) return false; // no vertical progress (wrapped line)
  const entry = findTableEntry(state, headLine, targetLine);
  if (entry === null) return false;
  view.dispatch({ selection: EditorSelection.cursor(entry), userEvent: "select" });
  return true;
}

export const tableKeymap: readonly KeyBinding[] = [
  { key: "ArrowDown", run: (view) => enterTable(view, true) },
  { key: "ArrowUp", run: (view) => enterTable(view, false) },
];
