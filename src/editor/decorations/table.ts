// GFM pipe-table rendering + in-place editing for the Phase 1 editor.
//
// PRD `editor-table-editing` (myne-agents/features/editor-table-editing/prd.md,
// MYND-162), grill 2026-06-13. Builds on `editor-mvp-tables` (MYND-139).
//
// A complete GFM `Table` node renders as a real `<table>` block widget —
// `Decoration.replace({ widget, block: true })` over the whole node. A true grid
// (cell borders, cross-row column alignment, contained horizontal scroll) needs
// all rows inside ONE DOM node; CM6 wraps each line in its own `.cm-line`, so
// per-row / per-cell widgets cannot cross-align. Hence one whole-block widget.
// Block-replace decorations MUST be provided through a `StateField`, not a
// `ViewPlugin` (CM6 contract) — `frontmatter.ts` is the in-repo precedent.
//
// Editing model (grill 2026-06-13): cells are edited IN PLACE, Obsidian-style —
// the raw pipe/delimiter source is never shown for a top-level table. Each cell
// is a single-line form field (the frontmatter Properties-widget model): focus a
// cell → it shows its inline source; commit on blur/Enter writes the WHOLE table
// back as canonical single-space GFM via `setCell` + `serializeTable` (grill
// Q2/B — always reformat). Escape reverts. A native `<input>` (not
// `contenteditable`) keeps paste plain-text by construction (TB2).
//
// SAFETY GATE: only a table whose parent is the Document root is editable. A
// nested table (blockquote, list item) keeps the read-only whole-table cursor
// reveal — its line prefixes (`> `, indent) would be stripped by canonical
// re-serialization, corrupting the surrounding block. `model.editable` carries
// this; reveal + arrow-into-table entry apply only when it is false.

import { syntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Extension,
  type RangeSet,
  RangeSetBuilder,
  Transaction,
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
import { renderInlineCell } from "./table-inline";
import i18n from "../../i18n";
import {
  addColumn,
  addRow,
  type CellPos,
  type ColumnAlign,
  deleteColumn,
  deleteRow,
  fitRow,
  moveColumn,
  moveRow,
  type NavDirection,
  nextCell,
  parseDelimiterAlign,
  serializeTable,
  setCell,
  splitTableRow,
  type TableGrid,
} from "./table-model";

/**
 * Cross-rebuild focus hand-off. A cell commit dispatches a doc change, which
 * rebuilds the whole widget DOM — so to land focus in the *next* cell after
 * Tab/arrow navigation, the committing widget records the target here and the
 * freshly-built widget consumes it (keyed by view; matched on table offset).
 */
const pendingFocus = new WeakMap<EditorView, { from: number; row: number; col: number }>();

/**
 * Active drag-reorder, tracked module-side instead of via `DataTransfer` (which
 * jsdom does not fully implement and which we don't need for same-document
 * reordering). `tableFrom` scopes a drop to the originating table.
 */
let dragState: { kind: "col" | "row"; from: number; tableFrom: number } | null = null;

/**
 * Request that, when the table starting at `from` next renders, it auto-enters
 * edit on cell `(row, col)`. Used by the `/table` slash insert to land the cursor
 * in the first cell. Consumed (once) by the rebuilt widget's `toDOM`.
 */
export function requestTableCellFocus(
  view: EditorView,
  from: number,
  row: number,
  col: number,
): void {
  pendingFocus.set(view, { from, row, col });
}


// The pure model helpers moved to `table-model.ts` (the DOM-free core, MYND-162).
// Re-exported here for back-compat: external callers + tests still import them
// from `./table`.
export {
  type ColumnAlign,
  parseDelimiterAlign,
  splitTableRow,
} from "./table-model";

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
  /** Editable in place iff the table is a top-level block (direct child of the
   *  Document root). Nested tables (blockquote, list item) keep the read-only
   *  whole-table reveal — canonical re-serialization would strip their line
   *  prefixes (`> `, indent) and corrupt the surrounding block. */
  readonly editable: boolean;
}

/**
 * Build the render model from a `Table` syntax node. The column count is
 * canonically the delimiter row's; header and body rows are fit to it
 * (GFM: extra body cells dropped, missing body cells empty). Returns `null`
 * if the node is missing its header or delimiter child (defensive — the
 * parser only emits `Table` when both exist, so this should not happen).
 */
export function buildTableModel(state: EditorState, table: SyntaxNode): TableModel | null {
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
    // Top-level tables only: a nested table's line prefixes would not survive
    // canonical re-serialization (see the SAFETY GATE note at the top).
    editable: isTopLevelTable(table),
  };
}

/**
 * Project a live `TableModel` down to the pure `TableGrid` the editing core
 * (`table-model.ts`) operates on — `align` plus the row/cell matrix
 * (`rows[0]` = header), dropping the document offsets. The bridge from the
 * CM-parsed model to the DOM-free transform + serialize pipeline.
 */
export function gridFromModel(model: TableModel): TableGrid {
  return { align: model.align, rows: model.rows.map((r) => r.cells) };
}

class TableWidget extends WidgetType {
  constructor(private readonly model: TableModel) {
    super();
  }

  // Equal when source, start offset, AND editability match — so a table that
  // shifts position, changes text, or crosses the editable boundary rebuilds.
  // Within those, CM6 skips DOM rebuilds.
  eq(other: TableWidget): boolean {
    return (
      other.model.source === this.model.source &&
      other.model.from === this.model.from &&
      other.model.editable === this.model.editable
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const { align, rows, editable } = this.model;
    const tableFrom = this.model.from;

    const table = document.createElement("table");
    table.className = "cm-table";
    table.setAttribute("data-testid", "table.grid");
    table.setAttribute("data-editable", String(editable));

    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    // Row/col → cell element, so navigation (and the pending-focus hand-off
    // below) can address a cell without re-querying the DOM.
    const cellEls: HTMLElement[][] = [];
    let rowIndex = 0;
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
      const r = rowIndex;
      const rowEls: HTMLElement[] = [];
      row.cells.forEach((cell, col) => {
        const el = document.createElement(cellTag);
        el.className = row.header ? "cm-table-header" : "cm-table-cell";
        el.setAttribute("data-testid", "table.cell");
        el.setAttribute("data-row", String(r));
        el.setAttribute("data-col", String(col));
        applyAlign(el, align[col]);
        // Rendered content lives in its own span so the cell's affordance
        // buttons (siblings) survive a re-render and never pollute cell text.
        const textSpan = document.createElement("span");
        textSpan.className = "cm-table-cell-text";
        renderCellContent(textSpan, cell); // textContent — never innerHTML (TB2)
        el.appendChild(textSpan);
        if (editable) {
          el.addEventListener("mousedown", (event) => {
            // Already editing this cell → let the click reach the input so the
            // native caret moves to where the user clicked (don't re-enter edit).
            if (cellHost(el).querySelector("input") !== null) return;
            event.preventDefault();
            this.beginEdit(view, el, r, col, cell, event);
          });
          appendCellAffordances(el, view, tableFrom, row.header, r, col);
          // Every cell is a drop target for both axes, so a reorder can land
          // anywhere on a row/column and the insertion line spans it fully.
          wireReorderDrop(el, view, "col", col, tableFrom);
          wireReorderDrop(el, view, "row", r, tableFrom);
        }
        rowEls.push(el);
        tr.appendChild(el);
      });
      cellEls.push(rowEls);
      if (!editable) {
        // Read-only nested table (blockquote / list): click reveals this row's
        // raw source line for editing. A block widget is atomic, so the widget
        // dispatches the selection itself (letting CM handle it would resolve to
        // the block boundary, the line below the table).
        tr.addEventListener("mousedown", (event) => {
          event.preventDefault();
          view.dispatch({
            selection: { anchor: row.from },
            userEvent: "select.pointer",
          });
          view.focus();
        });
      }
      (row.header ? thead : tbody).appendChild(tr);
      rowIndex++;
    }
    table.appendChild(thead);
    table.appendChild(tbody);

    if (!editable) {
      // Read-only nested table: inline-block scroll inside a block spacer
      // (mirrors `.cm-mermaid` > `.cm-mermaid-card`).
      const scroll = document.createElement("div");
      scroll.className = "cm-table-scroll";
      scroll.appendChild(table);
      const block = document.createElement("div");
      block.className = "cm-table-block";
      block.appendChild(scroll);
      return block;
    }

    // Editable: ONE constrained scroll container. `contain: inline-size` (theme)
    // stops the wide table from growing `.cm-content` to max-content, so a long
    // table scrolls INSIDE this box and never the editor; its padding forms the
    // gutters (top = column handles, left = row handles, right/bottom = add `+`).
    const wrap = document.createElement("div");
    wrap.className = "cm-table-editable";
    wrap.appendChild(table);
    wrap.appendChild(
      revealOnHover(
        makeAffordanceButton("cm-table-add-col", "table.add-column", i18n.t("editor.table.addColumn"), () =>
          applyTableTransform(view, tableFrom, (g) => addColumn(g, g.align.length)),
        ),
      ),
    );
    wrap.appendChild(
      revealOnHover(
        makeAffordanceButton("cm-table-add-row", "table.add-row", i18n.t("editor.table.addRow"), () =>
          applyTableTransform(view, tableFrom, (g) => addRow(g, g.rows.length)),
        ),
      ),
    );

    // Consume a pending focus hand-off: after a commit-and-navigate rebuilt this
    // widget, re-enter edit on the target cell. Scheduled (microtask) so the new
    // DOM is attached before `focus()`.
    const pending = pendingFocus.get(view);
    if (pending !== undefined && pending.from === this.model.from) {
      pendingFocus.delete(view);
      const targetEl = cellEls[pending.row]?.[pending.col];
      const targetSrc = rows[pending.row]?.cells[pending.col];
      if (targetEl !== undefined && targetSrc !== undefined) {
        queueMicrotask(() => this.beginEdit(view, targetEl, pending.row, pending.col, targetSrc));
      }
    }
    return wrap;
  }

  // The widget owns all its events: a native `<input>` (editable cells) or a
  // self-dispatched reveal (nested tables) handles them. Returning true keeps
  // CM from re-routing them into its content layer (which would move the cursor
  // to a block boundary and steal input focus).
  ignoreEvent(): boolean {
    return true;
  }

  /**
   * Enter edit mode for cell `(row, col)`: swap the rendered cell for a
   * single-line `<input>` seeded with the cell's inline source, focused. Commit
   * on blur / Enter (writes canonical source); Escape reverts with no doc change.
   */
  private beginEdit(
    view: EditorView,
    el: HTMLElement,
    row: number,
    col: number,
    source: string,
    event?: MouseEvent,
  ): void {
    const host = cellHost(el);
    if (host.querySelector("input") !== null) return; // already editing this cell
    // Resolve the caret from the click + freeze the rendered width — both while
    // the rendered text is still present (the caret API needs it; the width keeps
    // the cell from collapsing once the text is replaced by the input).
    const caret = event !== undefined ? caretOffsetAt(host, event, source.length) : source.length;
    const frozenWidth = host.offsetWidth;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "cm-table-cell-input";
    input.value = source;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", i18n.t("editor.table.cellAriaLabel"));
    input.setAttribute("data-testid", "table.cell-input");
    // Replace the rendered text with the input (replaceChildren — NOT append — so a
    // plain-text node can't show through and collide with the input text), and pin
    // the host's min-width to the frozen rendered width so the cell keeps its size.
    host.classList.add("cm-table-cell-editing");
    host.style.minWidth = `${frozenWidth}px`;
    host.replaceChildren(input);
    input.focus();
    input.setSelectionRange(caret, caret);

    // `handled` suppresses the blur-commit once a keystroke (Escape / navigation)
    // has already resolved this edit — otherwise removing the focused input from
    // the DOM would fire blur and double-commit.
    let handled = false;
    input.addEventListener("keydown", (keyEvent) => {
      if (keyEvent.key === "Enter") {
        keyEvent.preventDefault();
        input.blur(); // commit via blur
      } else if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        handled = true;
        revertCell(host, source); // revert, drop the input
      } else if (keyEvent.key === "Tab") {
        keyEvent.preventDefault();
        handled = true;
        // Tab is the only key that grows the table past its last cell.
        this.navigate(view, el, row, col, source, input.value, keyEvent.shiftKey ? "prev" : "next", true);
      } else {
        const dir = arrowDirection(keyEvent, input);
        if (dir !== null) {
          keyEvent.preventDefault();
          handled = true;
          this.navigate(view, el, row, col, source, input.value, dir, false);
        }
      }
    });
    input.addEventListener("blur", () => {
      // A real change dispatches → the StateField rebuilds the whole widget,
      // replacing this DOM, so restoring `el` would be wasted (guarded by the
      // returned flag). An unchanged / no-op value restores the rendered cell.
      if (!handled && !this.commitCell(view, row, col, input.value)) {
        revertCell(host, source);
      }
    });
  }

  /**
   * Re-resolve the live table at this widget's position (defensive against any
   * edit since render), apply the single-cell change, and dispatch the canonical
   * re-serialization over the table's exact source span. Returns true iff a doc
   * change was dispatched.
   */
  private commitCell(
    view: EditorView,
    row: number,
    col: number,
    next: string,
  ): boolean {
    const live = liveTableAt(view.state, this.model.from);
    if (live === null) return false;
    return dispatchGridTransform(view, live, (g) => setCell(g, row, col, next), "table.set-cell");
  }

  /**
   * Commit cell `(row, col)` then move focus to the neighbour resolved by `dir`.
   * Tab past the last cell appends a new row (story 6). When the commit changes
   * bytes, the dispatch rebuilds the widget and `pendingFocus` lands focus in the
   * target cell; when it does not (already-canonical, unchanged value), focus the
   * target cell directly in the current DOM.
   */
  private navigate(
    view: EditorView,
    el: HTMLElement,
    row: number,
    col: number,
    source: string,
    value: string,
    dir: NavDirection,
    allowAppend: boolean,
  ): void {
    const host = cellHost(el);
    const live = liveTableAt(view.state, this.model.from);
    if (live === null) {
      revertCell(host, source);
      return;
    }
    const target = nextCell(live.rows.length, live.align.length, { row, col }, dir);
    if (target === null || (target === "append" && !allowAppend)) {
      // Edge reached (or an arrow that must not grow the table): commit and exit.
      // Reuse the already-resolved `live` — no second tree walk.
      const committed = dispatchGridTransform(
        view,
        live,
        (g) => setCell(g, row, col, value),
        "table.set-cell",
      );
      if (!committed) revertCell(host, source);
      return;
    }

    let grid = setCell(gridFromModel(live), row, col, value);
    let focus: CellPos;
    if (target === "append") {
      grid = addRow(grid, grid.rows.length);
      focus = { row: grid.rows.length - 1, col: 0 };
    } else {
      focus = target;
    }

    const serialized = serializeTable(grid);
    if (serialized === live.source) {
      // No byte change (canonical + unchanged value, plain neighbour): no
      // rebuild — restore this cell and focus the neighbour in the current DOM.
      revertCell(host, source);
      const container = el.closest(".cm-table-editable");
      const targetEl = container === null ? null : cellElAt(container, focus.row, focus.col);
      const targetSrc = live.rows[focus.row]?.cells[focus.col];
      if (targetEl !== null && targetSrc !== undefined) {
        this.beginEdit(view, targetEl, focus.row, focus.col, targetSrc);
      }
      return;
    }

    pendingFocus.set(view, { from: live.from, row: focus.row, col: focus.col });
    view.dispatch({
      changes: { from: live.from, to: live.from + live.source.length, insert: serialized },
      userEvent: "table.set-cell",
    });
  }
}

/** Which navigation direction an arrow keystroke means, or `null` if the caret
 *  is mid-text (where the arrow should move the caret, not the cell). Left/Right
 *  cross cells only at the text boundary; Up/Down always move rows. */
function arrowDirection(
  event: KeyboardEvent,
  input: HTMLInputElement,
): NavDirection | null {
  if (event.key === "ArrowUp") return "up";
  if (event.key === "ArrowDown") return "down";
  const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
  const atEnd =
    input.selectionStart === input.value.length &&
    input.selectionEnd === input.value.length;
  if (event.key === "ArrowLeft" && atStart) return "prev";
  if (event.key === "ArrowRight" && atEnd) return "next";
  return null;
}

/** The `<td>`/`<th>` at grid `(row, col)` within a rendered `.cm-table-scroll`
 *  (row 0 = header). */
function cellElAt(scroll: Element, row: number, col: number): HTMLElement | null {
  const table = scroll.querySelector("table");
  if (table === null) return null;
  const tr =
    row === 0
      ? table.querySelector("thead tr")
      : (table.querySelector("tbody")?.children[row - 1] ?? null);
  return (tr?.children[col] as HTMLElement | undefined) ?? null;
}

/**
 * The single mutation path for every table edit (cell commit + structural
 * affordances): serialize `live` after `transform` and dispatch over the table's
 * exact source span — only if the bytes changed. Returns true iff a doc change
 * was dispatched. Takes an already-resolved `live` so callers on a hot path don't
 * re-walk the syntax tree.
 */
function dispatchGridTransform(
  view: EditorView,
  live: TableModel,
  transform: (grid: TableGrid) => TableGrid,
  userEvent: string,
): boolean {
  const serialized = serializeTable(transform(gridFromModel(live)));
  if (serialized === live.source) return false;
  view.dispatch({
    changes: { from: live.from, to: live.from + live.source.length, insert: serialized },
    userEvent,
  });
  return true;
}

/** Re-resolve the live table at `from` and dispatch a transform through
 *  `dispatchGridTransform`. Entry point for the structural affordances. */
function applyTableTransform(
  view: EditorView,
  from: number,
  transform: (grid: TableGrid) => TableGrid,
): void {
  const live = liveTableAt(view.state, from);
  if (live !== null) dispatchGridTransform(view, live, transform, "table.structure");
}

/** The cell's content span (where rendered marks / the edit input live), or the
 *  cell itself as a fallback. */
function cellHost(el: HTMLElement): HTMLElement {
  return (el.querySelector(".cm-table-cell-text") as HTMLElement | null) ?? el;
}

/** A top-level table (direct child of the Document root) is safely
 *  re-serializable — the editable SAFETY GATE. A nested table (blockquote, list
 *  item) carries line prefixes that canonical serialization would strip. */
function isTopLevelTable(table: SyntaxNode): boolean {
  return table.parent !== null && table.parent.name === "Document";
}

/** True when the document's last line belongs to an editable table — i.e. there
 *  is no caret position at the end (the table is atomic), so landing the caret
 *  below it needs a fresh trailing line. */
function lastBlockIsEditableTable(state: EditorState): boolean {
  const lastLine = state.doc.lineAt(state.doc.length);
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(lastLine.from, 1);
  while (node !== null) {
    if (node.name === "Table") return isTopLevelTable(node);
    node = node.parent;
  }
  return false;
}

/**
 * Append a cell's structural affordances: delete-column + alignment toggle +
 * reorder grip on each header cell; delete-row + reorder grip on the first cell
 * of each body row. Each consumes its own mousedown so a click acts rather than
 * entering edit. `isHeader` ⇒ header cell; `col === 0` ⇒ a body row's first cell.
 */
function appendCellAffordances(
  el: HTMLElement,
  view: EditorView,
  tableFrom: number,
  isHeader: boolean,
  row: number,
  col: number,
): void {
  // Separate `if`s (not else-if) so a CORNER cell triggers both edges — e.g. the
  // top-left cell gets the column handle (top edge) AND the row handle (left edge).
  if (isHeader) {
    // Column gutter (above the column): reorder handle + delete-column, side by side.
    el.appendChild(
      makeDragGrip("cm-table-handle cm-table-handle-col", "table.reorder-column", i18n.t("editor.table.reorderColumn"), "col", col, tableFrom),
    );
    const delCol = makeAffordanceButton("cm-table-del cm-table-del-col", "table.delete-column", i18n.t("editor.table.deleteColumn"), () =>
      applyTableTransform(view, tableFrom, (g) => deleteColumn(g, col)),
    );
    delCol.setAttribute("data-col", String(col));
    el.appendChild(delCol);
  }
  if (col === 0) {
    // Row gutter (left of the row): reorder handle + delete-row for EVERY row
    // (incl. the header — `moveRow`/`deleteRow` now allow it; whatever lands at
    // row 0 becomes the header).
    el.appendChild(
      makeDragGrip("cm-table-handle cm-table-handle-row", "table.reorder-row", i18n.t("editor.table.reorderRow"), "row", row, tableFrom),
    );
    const delRow = makeAffordanceButton("cm-table-del cm-table-del-row", "table.delete-row", i18n.t("editor.table.deleteRow"), () =>
      applyTableTransform(view, tableFrom, (g) => deleteRow(g, row)),
    );
    delRow.setAttribute("data-row", String(row));
    el.appendChild(delRow);
  }
}

/**
 * A small affordance button (add / delete row+column). `mousedown` is used (not
 * click) and the event is consumed so it never bubbles into a cell's
 * `beginEdit`; the widget owns its events (`ignoreEvent` → true).
 */
function makeAffordanceButton(
  className: string,
  testId: string,
  ariaLabel: string,
  onActivate: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  // The glyph is a CSS `::before` (theme.ts) so the button has no text content —
  // keeping it out of the cell's `textContent` when it sits inside a cell.
  btn.setAttribute("aria-label", ariaLabel);
  btn.setAttribute("data-testid", testId);
  btn.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  });
  return btn;
}

/** Reveal an affordance via JS mouseenter/leave (toggles `.cm-revealed`) rather
 *  than CSS `:hover`. The widget rebuilds its DOM on every edit, after which CSS
 *  `:hover` can stay stale until the next mouse move (the affordance "sticks"
 *  open); a freshly-built element with no `.cm-revealed` class starts hidden and
 *  reveals only on a real mouseenter. */
function revealOnHover(el: HTMLElement): HTMLElement {
  el.addEventListener("mouseenter", () => el.classList.add("cm-revealed"));
  el.addEventListener("mouseleave", () => el.classList.remove("cm-revealed"));
  return el;
}

/** A draggable six-dot grip that begins a row/column reorder. Uses native HTML5
 *  drag with module-side `dragState` (no DataTransfer). `mousedown` is consumed
 *  so grabbing the grip never enters cell edit. */
function makeDragGrip(
  className: string,
  testId: string,
  ariaLabel: string,
  kind: "col" | "row",
  index: number,
  tableFrom: number,
): HTMLElement {
  const grip = document.createElement("span");
  grip.className = className;
  grip.setAttribute("draggable", "true");
  grip.setAttribute("aria-label", ariaLabel);
  grip.setAttribute("data-testid", testId);
  grip.setAttribute(kind === "col" ? "data-col" : "data-row", String(index));
  grip.addEventListener("mousedown", (event) => event.stopPropagation());
  grip.addEventListener("dragstart", () => {
    dragState = { kind, from: index, tableFrom };
    markDragging(grip, kind, index, true); // highlight what's being dragged (#13)
  });
  grip.addEventListener("dragend", () => {
    dragState = null;
    clearDragArtifacts(grip.closest(".cm-table"));
  });
  return grip;
}

/** The cells of the row (kind "row") or column (kind "col") that `ref` belongs
 *  to — used to apply a class across a whole row/column (drag highlight + the
 *  full-width insertion line). */
function rowOrColCells(ref: HTMLElement, kind: "col" | "row", index: number): HTMLElement[] {
  const table = ref.closest(".cm-table");
  if (table === null) return [ref];
  return kind === "row"
    ? (Array.from(ref.closest("tr")?.children ?? []) as HTMLElement[])
    : Array.from(table.querySelectorAll<HTMLElement>(`[data-testid="table.cell"][data-col="${index}"]`));
}

/** Highlight (or un-highlight) the whole row/column being dragged, so the user
 *  can see what they're moving. */
function markDragging(
  grip: HTMLElement,
  kind: "col" | "row",
  index: number,
  on: boolean,
): void {
  for (const cell of rowOrColCells(grip, kind, index)) {
    cell.classList.toggle("cm-table-dragging", on);
  }
}

/** Strip every transient drag class (drag highlight + drop-edge indicators). */
function clearDragArtifacts(table: Element | null): void {
  table
    ?.querySelectorAll(".cm-table-dragging, .cm-table-drop-col, .cm-table-drop-row")
    .forEach((c) => c.classList.remove("cm-table-dragging", "cm-table-drop-col", "cm-table-drop-row"));
}

/** Make `el` a drop target for a `kind` reorder onto `index` within the table at
 *  `tableFrom`. Reorders header + body together (column) or whole rows (row). */
function wireReorderDrop(
  el: HTMLElement,
  view: EditorView,
  kind: "col" | "row",
  index: number,
  tableFrom: number,
): void {
  const accepts = (): boolean =>
    dragState !== null && dragState.kind === kind && dragState.tableFrom === tableFrom;
  const dropClass = kind === "col" ? "cm-table-drop-col" : "cm-table-drop-row";
  const setLine = (on: boolean): void => {
    for (const cell of rowOrColCells(el, kind, index)) cell.classList.toggle(dropClass, on);
  };
  el.addEventListener("dragover", (event) => {
    if (accepts()) {
      event.preventDefault(); // allow the drop
      setLine(true); // full-width insertion line across the target row/column (#13)
    }
  });
  el.addEventListener("dragleave", () => setLine(false));
  el.addEventListener("drop", (event) => {
    setLine(false);
    if (!accepts()) return;
    event.preventDefault();
    const from = dragState!.from;
    dragState = null;
    clearDragArtifacts(el.closest(".cm-table"));
    if (from === index) return;
    applyTableTransform(view, tableFrom, (g) =>
      kind === "col" ? moveColumn(g, from, index) : moveRow(g, from, index),
    );
  });
}

/** Render a non-active cell's inline marks (bold/italic/code/link) as safe DOM
 *  (TB2: createElement/textContent, never innerHTML — see `table-inline.ts`).
 *  The active/edited cell shows raw source in its `<input>` instead. */
function renderCellContent(el: HTMLElement, source: string): void {
  renderInlineCell(el, source);
}

/** Leave edit mode for a cell host: drop the editing state (the hidden sizer +
 *  input) and re-render. Used on Escape / no-op blur (a real commit rebuilds the
 *  whole widget instead). */
function revertCell(host: HTMLElement, source: string): void {
  host.classList.remove("cm-table-cell-editing");
  host.style.minWidth = "";
  renderCellContent(host, source);
}

/** Character offset within `host`'s rendered text at a click point, clamped to
 *  `[0, max]`. Uses the browser caret-from-point API so the caret lands where the
 *  user clicked; returns `max` (end) when the API is unavailable (e.g. jsdom) or
 *  the point can't be resolved. */
function caretOffsetAt(host: HTMLElement, event: MouseEvent, max: number): number {
  const fromPoint = (
    document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }
  ).caretRangeFromPoint;
  if (typeof fromPoint !== "function") return max;
  const point = fromPoint.call(document, event.clientX, event.clientY);
  if (point === null) return max;
  try {
    const measure = document.createRange();
    measure.selectNodeContents(host);
    measure.setEnd(point.startContainer, point.startOffset);
    return Math.min(measure.toString().length, max);
  } catch {
    return max;
  }
}

/**
 * Re-parse the live `Table` node covering `pos` into a model. Used at commit
 * time so a cell edit always serializes against the current document, never a
 * snapshot that a concurrent edit could have invalidated.
 */
function liveTableAt(state: EditorState, pos: number): TableModel | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  while (node !== null && node.name !== "Table") node = node.parent;
  return node === null ? null : buildTableModel(state, node);
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
      // Editable (top-level) tables are never revealed — they are edited in
      // place. Only nested tables fall back to whole-table cursor reveal.
      const revealed =
        !model.editable &&
        focused &&
        selectionTouchesLines(state, fromLine.number, toLine.number);
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
// Editable tables must be ATOMIC for the document cursor: a block-replace
// decoration alone still lets the cursor + selection enter the hidden pipe
// source (so typing merges into it and a select-all + bold wraps the whole
// widget's source in `**`, corrupting it). Registering the same span with
// `EditorView.atomicRanges` makes cursor motion / selection / backspace treat
// the table as one indivisible unit — editing happens only through the cell
// inputs. Nested (read-only, reveal-on-cursor) tables are deliberately NOT
// atomic, so the cursor can still enter them to reveal the raw source.
// Tree-keyed cache (mirrors the wikilink-chip pattern) so cursor moves don't
// re-walk the document.
const tableAtomicCache = new WeakMap<
  ReturnType<typeof syntaxTree>,
  RangeSet<Decoration>
>();

function cachedTableAtomicRanges(view: EditorView): RangeSet<Decoration> {
  const tree = syntaxTree(view.state);
  const cached = tableAtomicCache.get(tree);
  if (cached !== undefined) return cached;
  const state = view.state;
  const builder = new RangeSetBuilder<Decoration>();
  tree.iterate({
    enter: (node) => {
      if (node.name !== "Table") return undefined;
      const model = buildTableModel(state, node.node);
      if (model !== null && model.editable) {
        const fromLine = state.doc.lineAt(node.from);
        const toLine = state.doc.lineAt(node.to);
        builder.add(fromLine.from, toLine.to, Decoration.replace({}));
      }
      return false; // don't descend into the table
    },
  });
  const finished = builder.finish();
  tableAtomicCache.set(tree, finished);
  return finished;
}

/** True when `pos` is the start of a blank line that immediately follows a
 *  table — i.e. typing there would be absorbed as a new table row. */
function lineWouldJoinTableAbove(state: EditorState, pos: number): boolean {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  if (pos !== line.from || line.text.trim() !== "" || line.number === 1) return false;
  const prevLine = doc.line(line.number - 1);
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(prevLine.to, -1);
  while (node !== null) {
    if (node.name === "Table") return true;
    node = node.parent;
  }
  return false;
}

/**
 * Keep a blank line between a table and content typed on the line directly
 * below it. `@lezer/markdown` absorbs any non-blank line immediately after a
 * table as a new row, so without this, typing under a table grows the table.
 * When a non-newline insertion lands at the start of a blank, table-adjacent
 * line, prepend a newline so the blank line — and the separation — survives.
 */
const tableAbsorbGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  // Skip the table's own edits + slash inserts (they manage their own spacing).
  if (userEvent !== undefined && (userEvent.startsWith("table.") || userEvent === "slash.apply")) {
    return tr;
  }
  let guardAt: number | null = null;
  tr.changes.iterChanges((fromA, _toA, _fromB, _toB, inserted) => {
    if (guardAt !== null || inserted.length === 0) return;
    if (inserted.line(1).text === "" && inserted.lines > 1) return; // already starts with a newline
    if (lineWouldJoinTableAbove(tr.startState, fromA)) guardAt = fromA;
  });
  if (guardAt === null) return tr;
  // Re-issue the user's change, then a separating newline after it (sequential,
  // so `guardAt` is in the post-change document — the blank line lands before the
  // typed text and the caret follows down onto the separated line).
  return [tr, { changes: { from: guardAt, insert: "\n" }, sequential: true }];
});

/**
 * Click-below-to-focus-end: clicking the empty area below the document's content
 * lands the caret on the last line — creating a trailing line first when the last
 * block is a table (atomic, so there is no caret position directly beneath it and
 * the click would otherwise do nothing). General affordance, surfaced by the
 * editable table (MYND-162 feedback: "clicking under the last entry should focus
 * the last line").
 */
const clickBelowToFocusEnd = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
    // Act only on clicks BELOW the last rendered line (`coordsAtPos` is the last
    // line's own bottom — `.cm-content` itself fills the scroller). Never steals a
    // cell click, which lands on a line well above this.
    const doc = view.state.doc;
    const endCoords = view.coordsAtPos(doc.length);
    if (endCoords === null || event.clientY <= endCoords.bottom) return false;
    // Land the caret on the existing last editable line — do NOT add a new line.
    // The one exception: when the final block is an editable table, there is no
    // caret position at the end (it's atomic), so a trailing line is created.
    if (lastBlockIsEditableTable(view.state)) {
      view.dispatch({
        changes: { from: doc.length, insert: "\n" },
        selection: { anchor: doc.length + 1 },
        userEvent: "input",
      });
    } else {
      view.dispatch({ selection: { anchor: doc.length }, userEvent: "select.pointer" });
    }
    view.focus();
    return true;
  },
  // A double-click on an editable table would otherwise select the whole atomic
  // range (CM word-select snaps to the atomic unit). Suppress that — but still
  // allow native word-select inside a focused cell input.
  dblclick(event) {
    const target = event.target as HTMLElement | null;
    if (target === null) return false;
    if (target.closest(".cm-table-cell-input") !== null) return false; // editing — let it select a word
    if (target.closest(".cm-table-editable") === null) return false; // not on an editable table
    event.preventDefault();
    return true;
  },
});

export function tableDecorations(): Extension {
  return [
    makeCursorAwareStateField((state) =>
      buildTableDecorations(state, revealActive(state)),
    ),
    EditorView.atomicRanges.of(cachedTableAtomicRanges),
    tableAbsorbGuard,
    clickBelowToFocusEnd,
  ];
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
  // Arrow-into-table reveal applies only to nested (read-only) tables. An
  // editable top-level table is entered by clicking a cell (keyboard cell entry
  // lands in the navigation task); arrowing past it just steps over.
  const table = liveTableAt(state, entry);
  if (table === null || table.editable) return false;
  view.dispatch({ selection: EditorSelection.cursor(entry), userEvent: "select" });
  return true;
}

export const tableKeymap: readonly KeyBinding[] = [
  { key: "ArrowDown", run: (view) => enterTable(view, true) },
  { key: "ArrowUp", run: (view) => enterTable(view, false) },
];
