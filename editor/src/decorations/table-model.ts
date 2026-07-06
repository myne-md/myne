// Pure, DOM-free model + (de)serializer for GFM pipe tables.
//
// This is the deep module the editable-table feature (MYND-162) is a thin shell
// over: the CM6 widget, navigation, and structural affordances all reduce to
// `parse → transform → serialize` over this grid. Keeping it free of CodeMirror
// and DOM types makes the byte-level round-trip the highest-value unit-test
// surface (`tests/editor/table-model.test.ts`).
//
// Canonical serialization is **single-space padded** (`| a | b |`, delimiter
// `| --- |`). It never re-pads to content width, so a one-cell edit produces the
// smallest predictable rewrite. Decision: grill 2026-06-13 (Q2/B) — supersedes
// MYND-139's "surgical, no-reformat / byte-stable round-trip" for the editable
// case (see design-notes.md).

/** Per-column horizontal alignment; `null` = default (renders left). */
export type ColumnAlign = "left" | "center" | "right" | null;

/**
 * The editable table representation: alignment per column plus a row matrix.
 * `rows[0]` is the header; `rows[1..]` are body rows. Every row has
 * `align.length` cells, each in **display form** (trimmed, `\|` unescaped to
 * `|`). The GFM delimiter row is NOT stored as a row — it is derived from
 * `align` on serialize.
 */
export interface TableGrid {
  readonly align: readonly ColumnAlign[];
  readonly rows: readonly (readonly string[])[];
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
export function fitRow(cells: string[], columns: number): string[] {
  if (cells.length === columns) return cells;
  if (cells.length > columns) return cells.slice(0, columns);
  return cells.concat(Array.from({ length: columns - cells.length }, () => ""));
}

// --- Parse + serialize ----------------------------------------------------

/**
 * Parse a `Table` node's raw source slice into a `TableGrid`. Pure string
 * processing — mirrors `buildTableModel` (the CM-node parser in `table.ts`) but
 * needs no EditorState, so it round-trips in the node test environment. Returns
 * `null` if the source has fewer than two non-blank lines (header + delimiter).
 *
 * The column count is canonically the delimiter row's; header and body rows are
 * fit to it (extra cells dropped, missing cells empty).
 */
export function parseTableSource(source: string): TableGrid | null {
  const lines = source.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const align = parseDelimiterAlign(lines[1]!);
  const columns = align.length;
  if (columns === 0) return null;
  const rows: string[][] = [
    fitRow(splitTableRow(lines[0]!), columns),
    ...lines.slice(2).map((l) => fitRow(splitTableRow(l), columns)),
  ];
  return { align, rows };
}

function escapeCell(cell: string): string {
  return cell.replace(/\|/g, "\\|");
}

function delimiterCell(align: ColumnAlign): string {
  switch (align) {
    case "left":
      return ":---";
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}

function pipeRow(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

/**
 * Serialize a grid back to canonical single-space GFM. Header line, delimiter
 * line (from `align`), then one line per body row. No trailing newline — the
 * caller splices this over the original `Table` node's line span. Idempotent:
 * `serializeTable(parseTableSource(serializeTable(g)))` equals `serializeTable(g)`.
 */
export function serializeTable(grid: TableGrid): string {
  const [header = [], ...body] = grid.rows;
  const lines = [
    pipeRow(header),
    `| ${grid.align.map(delimiterCell).join(" | ")} |`,
    ...body.map(pipeRow),
  ];
  return lines.join("\n");
}

/** A fresh empty grid with `columns` columns and `bodyRows` body rows, all cells
 *  empty and every column default-aligned. `/table` inserts `emptyTableGrid(2, 1)`. */
export function emptyTableGrid(columns: number, bodyRows: number): TableGrid {
  const cols = Math.max(1, columns);
  const blankRow = (): string[] => Array.from({ length: cols }, () => "");
  return {
    align: Array.from({ length: cols }, () => null as ColumnAlign),
    rows: [blankRow(), ...Array.from({ length: Math.max(0, bodyRows) }, blankRow)],
  };
}

// --- Pure transforms ------------------------------------------------------
//
// Every transform returns a NEW grid (never mutates) and preserves the grid
// invariant: `rows.length >= 2` (header + >=1 body), `align.length >= 1`, and
// every row has exactly `align.length` cells. Operations that would break an
// invariant (deleting the last column / body row) are no-ops returning the
// input grid unchanged.

const clamp = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(n, lo), hi);

function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

function insertItem<T>(arr: readonly T[], at: number, item: T): T[] {
  const next = [...arr];
  next.splice(at, 0, item);
  return next;
}

/** Replace the text of cell `(row, col)`. Out-of-range → unchanged. */
export function setCell(
  grid: TableGrid,
  row: number,
  col: number,
  text: string,
): TableGrid {
  if (row < 0 || row >= grid.rows.length) return grid;
  if (col < 0 || col >= grid.align.length) return grid;
  return {
    align: grid.align,
    rows: grid.rows.map((r, ri) =>
      ri === row ? r.map((c, ci) => (ci === col ? text : c)) : r,
    ),
  };
}

/** Insert an empty column at index `at` (clamped to `[0, columns]`). */
export function addColumn(grid: TableGrid, at: number): TableGrid {
  const idx = clamp(at, 0, grid.align.length);
  return {
    align: insertItem(grid.align, idx, null),
    rows: grid.rows.map((r) => insertItem(r, idx, "")),
  };
}

/** Remove column `col`. No-op if only one column remains. */
export function deleteColumn(grid: TableGrid, col: number): TableGrid {
  if (grid.align.length <= 1) return grid;
  if (col < 0 || col >= grid.align.length) return grid;
  return {
    align: grid.align.filter((_, i) => i !== col),
    rows: grid.rows.map((r) => r.filter((_, i) => i !== col)),
  };
}

/** Move column `from` to index `to` (header + every body cell move together). */
export function moveColumn(grid: TableGrid, from: number, to: number): TableGrid {
  const cols = grid.align.length;
  if (from < 0 || from >= cols || to < 0 || to >= cols || from === to) return grid;
  return {
    align: moveItem(grid.align, from, to),
    rows: grid.rows.map((r) => moveItem(r, from, to)),
  };
}

/** Insert an empty body row at row index `at` (clamped to `[1, rows.length]`;
 *  index 0 is the header and is never displaced). */
export function addRow(grid: TableGrid, at: number): TableGrid {
  const idx = clamp(at, 1, grid.rows.length);
  const blank = Array.from({ length: grid.align.length }, () => "");
  return { align: grid.align, rows: insertItem(grid.rows, idx, blank) };
}

/** Remove row `row` (any row, header or body — whichever is left at index 0
 *  becomes the header on serialize). No-op only if it would empty the table; at
 *  least one row always remains. */
export function deleteRow(grid: TableGrid, row: number): TableGrid {
  if (row < 0 || row >= grid.rows.length || grid.rows.length <= 1) return grid;
  return { align: grid.align, rows: grid.rows.filter((_, i) => i !== row) };
}

/** Reorder row `from` to index `to`. Any row may move, including the header
 *  (row 0) — whichever row ends at index 0 becomes the header on serialize, so a
 *  corner-cell drag can reorder the top row too. Out-of-range / same → unchanged. */
export function moveRow(grid: TableGrid, from: number, to: number): TableGrid {
  const n = grid.rows.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return grid;
  return { align: grid.align, rows: moveItem(grid.rows, from, to) };
}

/** Set column `col`'s alignment. Out-of-range → unchanged. */
export function setAlign(
  grid: TableGrid,
  col: number,
  align: ColumnAlign,
): TableGrid {
  if (col < 0 || col >= grid.align.length) return grid;
  return {
    align: grid.align.map((a, i) => (i === col ? align : a)),
    rows: grid.rows,
  };
}

// --- Cell navigation (pure resolution; DOM focus wiring lives in table.ts) ---

export interface CellPos {
  readonly row: number;
  readonly col: number;
}

export type NavDirection = "next" | "prev" | "up" | "down";

/** "append" means a navigation ran past the last cell and a new row should be
 *  created (Tab at the end of the table). `null` means no move (edge reached). */
export type CellTarget = CellPos | "append" | null;

/**
 * Resolve the cell a navigation keystroke lands on. `rows` counts the header
 * (row 0) plus body rows; `cols` is the column count.
 *
 * - `next` / `prev`: reading-order, wrapping across rows. `next` past the very
 *   last cell → `"append"` (Tab grows the table); `prev` past the first → `null`.
 * - `up` / `down`: within the same column. Past either edge → `null` (only Tab
 *   appends; arrows never do).
 */
export function nextCell(
  rows: number,
  cols: number,
  pos: CellPos,
  dir: NavDirection,
): CellTarget {
  const { row, col } = pos;
  if (dir === "next") {
    if (col + 1 < cols) return { row, col: col + 1 };
    if (row + 1 < rows) return { row: row + 1, col: 0 };
    return "append";
  }
  if (dir === "prev") {
    if (col - 1 >= 0) return { row, col: col - 1 };
    if (row - 1 >= 0) return { row: row - 1, col: cols - 1 };
    return null;
  }
  if (dir === "up") return row - 1 >= 0 ? { row: row - 1, col } : null;
  return row + 1 < rows ? { row: row + 1, col } : null;
}
