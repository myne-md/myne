// CSV → GFM table note (importer-breadth epic, MYND-584).
//
// A CSV imports as ONE note containing a GFM pipe table — explicitly NOT one note
// per row. A note-per-row adapter would make Myne a database importer, colliding
// with the `vision.md` "No Notion-style feature creep. No databases, no kanban
// boards" anti-feature — the same ground on which `.canvas` is skipped — and it is
// the same reconciliation the `.base` import already chose: map an external
// database construct onto an EXISTING Myne primitive rather than adding a new one.
// Here the CSV becomes content, not structure. (Grill 2026-07-25 Q5.)
//
// The canonical GFM serializer is reused (`@myne/editor/decorations/table-model`),
// the same one `dialect/clip.ts` uses, so there is one definition of Myne's table
// form rather than a second one here.

import { fitRow, serializeTable } from "@myne/editor/decorations/table-model";
import { parseCsv } from "./parseCsv";

/**
 * Row ceiling. The dialect has no table virtualization, so a 50 000-row CSV would
 * become one unusable note. Hitting the cap is TRUNCATION, NOT FAILURE — the
 * `MAX_XML_PART_LEN` precedent in the attachment extractor — and the drop is
 * reported so it is never silent. The source file is never modified.
 */
export const MAX_CSV_ROWS = 500;

/** Widest row the table may carry; a wider row is truncated and reported. */
export const MAX_CSV_COLUMNS = 64;

export interface CsvTableResult {
  markdown: string;
  /** Construct names for the per-note lossy channel. Empty when nothing was cut. */
  lossy: readonly string[];
  /** Data rows emitted (excludes the header row). */
  rows: number;
}

/** Optional per-cell transform — the Notion adapter uses it to link the title column. */
export type CellMapper = (cell: string, column: number, row: number) => string;

/**
 * Turn CSV text into a single note's markdown.
 *
 * The first row becomes the table header. A header-less CSV is indistinguishable
 * from one with a header, so the first row is always promoted: a GFM pipe table
 * without a delimiter row does not parse as a table at all, and emitting something
 * inert would be worse than treating row 1 as the header.
 */
export function csvToTableMarkdown(text: string, mapCell?: CellMapper): CsvTableResult {
  const parsed = parseCsv(text);
  const lossy = new Set<string>();

  if (parsed.length === 0) {
    return { markdown: "", lossy: ["empty-csv"], rows: 0 };
  }

  let grid = parsed;
  if (grid.length > MAX_CSV_ROWS + 1) {
    grid = grid.slice(0, MAX_CSV_ROWS + 1); // +1 keeps the header
    lossy.add("csv-rows-truncated");
  }

  let width = grid.reduce((m, r) => Math.max(m, r.length), 0);
  if (width > MAX_CSV_COLUMNS) {
    width = MAX_CSV_COLUMNS;
    lossy.add("csv-columns-truncated");
  }
  if (width === 0) {
    return { markdown: "", lossy: ["empty-csv"], rows: 0 };
  }

  const rows = grid.map((r, rowIndex) =>
    fitRow(
      r
        .slice(0, width)
        // A cell cannot span lines in a pipe table; pipe-escaping is the
        // serializer's job, so only the newline collapse belongs here.
        .map((cell, col) => {
          const value = cell.replace(/\s+/g, " ").trim();
          return mapCell ? mapCell(value, col, rowIndex) : value;
        }),
      width,
    ),
  );

  return {
    markdown: serializeTable({
      align: Array.from({ length: width }, () => null),
      rows,
    }),
    lossy: [...lossy].sort(),
    rows: Math.max(0, rows.length - 1),
  };
}
