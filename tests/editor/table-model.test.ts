// @vitest-environment jsdom
//
// Pure model + serializer for editable GFM tables (MYND-162, task 1).
// The DOM-free core: parse → transform → serialize, plus a live round-trip
// proving the CM-parsed `buildTableModel` projects to the same canonical bytes.

import { describe, expect, it, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { buildTableModel, gridFromModel } from "../../src/editor/decorations/table";
import {
  addColumn,
  addRow,
  deleteColumn,
  deleteRow,
  emptyTableGrid,
  moveColumn,
  moveRow,
  nextCell,
  parseTableSource,
  serializeTable,
  setAlign,
  setCell,
  type TableGrid,
} from "../../src/editor/decorations/table-model";

const CANONICAL = ["| a | b |", "| --- | --- |", "| c | d |"].join("\n");

/** Parse a source string, mutate, re-serialize — the common test shape. */
function roundtrip(source: string): string {
  const grid = parseTableSource(source);
  expect(grid).not.toBeNull();
  return serializeTable(grid!);
}

describe("serializeTable / parseTableSource round-trip", () => {
  it("is byte-identical for already-canonical input", () => {
    expect(roundtrip(CANONICAL)).toBe(CANONICAL);
  });

  it("normalizes non-canonical input and is idempotent on a second pass", () => {
    const messy = ["|a|b|", "|:--|--:|", "| 1 |  |", "|x|"].join("\n");
    const once = roundtrip(messy);
    expect(once).toBe(
      ["| a | b |", "| :--- | ---: |", "| 1 |  |", "| x |  |"].join("\n"),
    );
    // Second pass over the canonical output changes nothing.
    expect(roundtrip(once)).toBe(once);
  });

  it("returns null for a delimiter-less fragment", () => {
    expect(parseTableSource("| just one line |")).toBeNull();
  });

  it("preserves a single-column table", () => {
    const src = ["| h |", "| --- |", "| x |"].join("\n");
    expect(roundtrip(src)).toBe(src);
  });

  it("serializes a header-only table (header + delimiter + one body row)", () => {
    expect(serializeTable(emptyTableGrid(2, 1))).toBe(
      ["|  |  |", "| --- | --- |", "|  |  |"].join("\n"),
    );
  });

  it("round-trips escaped pipes (display \\| stays escaped on serialize)", () => {
    const src = ["| a | b |", "| --- | --- |", "| x \\| y | z |"].join("\n");
    const grid = parseTableSource(src)!;
    // The cell holds the display form `x | y` …
    expect(grid.rows[1]![0]).toBe("x | y");
    // … and serialize re-escapes it so the bytes round-trip.
    expect(serializeTable(grid)).toBe(src);
  });

  it("fits ragged rows to the delimiter column count (pad short, drop long)", () => {
    const src = ["| a | b | c |", "| --- | --- | --- |", "| 1 |", "| 1 | 2 | 3 | 4 |"].join(
      "\n",
    );
    expect(roundtrip(src)).toBe(
      ["| a | b | c |", "| --- | --- | --- |", "| 1 |  |  |", "| 1 | 2 | 3 |"].join("\n"),
    );
  });
});

describe("alignment", () => {
  it("round-trips every alignment to its canonical delimiter", () => {
    const src = ["| a | b | c | d |", "| :--- | :---: | ---: | --- |", "| 1 | 2 | 3 | 4 |"].join(
      "\n",
    );
    expect(roundtrip(src)).toBe(src);
  });

  it("setAlign updates the delimiter row", () => {
    const grid = parseTableSource(CANONICAL)!;
    const aligned = setAlign(grid, 1, "center");
    expect(serializeTable(aligned)).toBe(
      ["| a | b |", "| --- | :---: |", "| c | d |"].join("\n"),
    );
  });
});

describe("column transforms", () => {
  const grid = parseTableSource(CANONICAL)!;

  it("addColumn appends an empty column on the right", () => {
    expect(serializeTable(addColumn(grid, grid.align.length))).toBe(
      ["| a | b |  |", "| --- | --- | --- |", "| c | d |  |"].join("\n"),
    );
  });

  it("addColumn inserts in the middle", () => {
    expect(serializeTable(addColumn(grid, 1))).toBe(
      ["| a |  | b |", "| --- | --- | --- |", "| c |  | d |"].join("\n"),
    );
  });

  it("deleteColumn removes the targeted column", () => {
    expect(serializeTable(deleteColumn(grid, 0))).toBe(
      ["| b |", "| --- |", "| d |"].join("\n"),
    );
  });

  it("deleteColumn is a no-op on a single-column table", () => {
    const single = parseTableSource(["| h |", "| --- |", "| x |"].join("\n"))!;
    expect(deleteColumn(single, 0)).toBe(single);
  });

  it("moveColumn moves header + every body cell together", () => {
    expect(serializeTable(moveColumn(grid, 0, 1))).toBe(
      ["| b | a |", "| --- | --- |", "| d | c |"].join("\n"),
    );
  });
});

describe("row transforms", () => {
  const grid = parseTableSource(CANONICAL)!;

  it("addRow appends an empty body row", () => {
    expect(serializeTable(addRow(grid, grid.rows.length))).toBe(
      ["| a | b |", "| --- | --- |", "| c | d |", "|  |  |"].join("\n"),
    );
  });

  it("addRow inserts below the header (index 1)", () => {
    expect(serializeTable(addRow(grid, 1))).toBe(
      ["| a | b |", "| --- | --- |", "|  |  |", "| c | d |"].join("\n"),
    );
  });

  it("deleteRow removes a body row", () => {
    const two = parseTableSource(
      ["| a | b |", "| --- | --- |", "| c | d |", "| e | f |"].join("\n"),
    )!;
    expect(serializeTable(deleteRow(two, 1))).toBe(
      ["| a | b |", "| --- | --- |", "| e | f |"].join("\n"),
    );
  });

  it("deleteRow can remove the last body row, leaving a header-only table", () => {
    // grid = header + one body row; deleting the body leaves just the header.
    expect(serializeTable(deleteRow(grid, 1))).toBe(
      ["| a | b |", "| --- | --- |"].join("\n"),
    );
  });

  it("deleteRow can remove the header — the next row becomes the header", () => {
    expect(serializeTable(deleteRow(grid, 0))).toBe(
      ["| c | d |", "| --- | --- |"].join("\n"),
    );
  });

  it("deleteRow is a no-op on a single-row table (always keeps ≥1 row)", () => {
    const single = parseTableSource(["| h |", "| --- |"].join("\n"))!;
    expect(deleteRow(single, 0)).toBe(single);
  });

  it("moveRow can reorder the header row too (corner-cell drag); row at index 0 becomes header", () => {
    const grid = parseTableSource(
      ["| h1 | h2 |", "| --- | --- |", "| 1 | 1 |"].join("\n"),
    )!;
    expect(serializeTable(moveRow(grid, 0, 1))).toBe(
      ["| 1 | 1 |", "| --- | --- |", "| h1 | h2 |"].join("\n"),
    );
  });

  it("moveRow reorders body rows and leaves the header on top", () => {
    const three = parseTableSource(
      ["| h1 | h2 |", "| --- | --- |", "| 1 | 1 |", "| 2 | 2 |", "| 3 | 3 |"].join("\n"),
    )!;
    expect(serializeTable(moveRow(three, 3, 1))).toBe(
      ["| h1 | h2 |", "| --- | --- |", "| 3 | 3 |", "| 1 | 1 |", "| 2 | 2 |"].join("\n"),
    );
  });
});

describe("setCell", () => {
  const grid = parseTableSource(CANONICAL)!;

  it("replaces a single cell's text", () => {
    expect(serializeTable(setCell(grid, 1, 0, "ZZ"))).toBe(
      ["| a | b |", "| --- | --- |", "| ZZ | d |"].join("\n"),
    );
  });

  it("escapes a pipe typed into a cell", () => {
    expect(serializeTable(setCell(grid, 0, 0, "x | y"))).toBe(
      ["| x \\| y | b |", "| --- | --- |", "| c | d |"].join("\n"),
    );
  });

  it("is a no-op for an out-of-range cell", () => {
    expect(setCell(grid, 9, 9, "z")).toBe(grid);
  });
});

describe("nextCell navigation resolution (3 rows × 2 cols)", () => {
  const ROWS = 3; // header + 2 body
  const COLS = 2;

  it("next walks reading order and wraps across rows", () => {
    expect(nextCell(ROWS, COLS, { row: 0, col: 0 }, "next")).toEqual({ row: 0, col: 1 });
    expect(nextCell(ROWS, COLS, { row: 0, col: 1 }, "next")).toEqual({ row: 1, col: 0 });
  });

  it("next past the very last cell signals append", () => {
    expect(nextCell(ROWS, COLS, { row: 2, col: 1 }, "next")).toBe("append");
  });

  it("prev walks back and wraps; past the first cell is null", () => {
    expect(nextCell(ROWS, COLS, { row: 1, col: 0 }, "prev")).toEqual({ row: 0, col: 1 });
    expect(nextCell(ROWS, COLS, { row: 0, col: 0 }, "prev")).toBeNull();
  });

  it("up/down move within the column and stop at the edges", () => {
    expect(nextCell(ROWS, COLS, { row: 1, col: 1 }, "up")).toEqual({ row: 0, col: 1 });
    expect(nextCell(ROWS, COLS, { row: 0, col: 1 }, "up")).toBeNull();
    expect(nextCell(ROWS, COLS, { row: 1, col: 0 }, "down")).toEqual({ row: 2, col: 0 });
    expect(nextCell(ROWS, COLS, { row: 2, col: 0 }, "down")).toBeNull(); // never appends
  });
});

describe("immutability", () => {
  it("transforms never mutate the input grid", () => {
    const grid = parseTableSource(CANONICAL)!;
    const snapshot = serializeTable(grid);
    addColumn(grid, 0);
    addRow(grid, 1);
    setCell(grid, 1, 0, "mutated?");
    expect(serializeTable(grid)).toBe(snapshot);
  });
});

// The live CM path must project to the same canonical bytes as the pure parse.
describe("live buildTableModel → gridFromModel → serialize", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = null;
    host = null;
  });

  function firstTableGrid(doc: string): TableGrid {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [markdown({ base: markdownLanguage, extensions: [Wikilink] })],
      }),
      parent: host,
    });
    forceParsing(view, doc.length, 5000);
    let node: SyntaxNode | null = null;
    syntaxTree(view.state).iterate({
      enter: (n) => {
        if (n.name === "Table" && node === null) {
          node = n.node;
          return false;
        }
        return undefined;
      },
    });
    expect(node).not.toBeNull();
    const model = buildTableModel(view.state, node!);
    expect(model).not.toBeNull();
    return gridFromModel(model!);
  }

  it("matches the pure parse for the same canonical source", () => {
    const doc = `${CANONICAL}\n`;
    expect(serializeTable(firstTableGrid(doc))).toBe(CANONICAL);
  });

  it("normalizes irregular padding identically to parseTableSource", () => {
    const doc = ["|a|b|c|", "|:--|--:|---|", "| 1 |   |3|", "|x|", ""].join("\n");
    expect(serializeTable(firstTableGrid(doc))).toBe(roundtrip(doc));
  });
});
