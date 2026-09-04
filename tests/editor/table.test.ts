// @vitest-environment jsdom
//
// GFM table rendering (PRD `editor-mvp-tables`, Task 1 — always-on grid).
//
// Two layers:
//   1. Pure-helper unit tests for delimiter-alignment derivation + row
//      splitting (empty cells, ragged rows, escaped pipes, no outer pipes).
//   2. jsdom mount smoke: a table renders as a real `<table>` with the right
//      shape, alignment is applied, and cell text is injection-safe
//      (textContent, never innerHTML).

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { assertParsed } from "./_parse-budget";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import {
  buildTableDecorations,
  findTableEntry,
  parseDelimiterAlign,
  splitTableRow,
  tableDecorations,
} from "../../src/editor/decorations/table";
import { slashCommands } from "../../src/editor/slash/commands";

describe("parseDelimiterAlign", () => {
  it("maps :--- / :--: / ---: / --- to left / center / right / default", () => {
    expect(parseDelimiterAlign("|:---|:--:|---:|---|")).toEqual([
      "left",
      "center",
      "right",
      null,
    ]);
  });

  it("handles a delimiter row without outer pipes", () => {
    expect(parseDelimiterAlign("---|:--:")).toEqual([null, "center"]);
  });
});

describe("splitTableRow", () => {
  it("splits a standard fully-piped row", () => {
    expect(splitTableRow("| a | b | c |")).toEqual(["a", "b", "c"]);
  });

  it("preserves empty cells positionally", () => {
    expect(splitTableRow("| 1 |   | 3 |")).toEqual(["1", "", "3"]);
  });

  it("handles rows without outer pipes", () => {
    expect(splitTableRow("a | b")).toEqual(["a", "b"]);
  });

  it("does not split on an escaped pipe and unescapes it for display", () => {
    expect(splitTableRow("x \\| y | z")).toEqual(["x | y", "z"]);
  });
});

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      // Park the cursor at the end, well outside the table — forward-compat
      // with Task 2's cursor-aware reveal (Task 1 renders always-on anyway).
      selection: { anchor: doc.length, head: doc.length },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Wikilink] }),
        tableDecorations(),
      ],
    }),
    parent: host,
  });
  view.requestMeasure();
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

describe("GFM table widget (jsdom)", () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted !== null) teardown(mounted);
    mounted = null;
  });

  it("renders a complete table as a <table> with header + body shape and alignment", () => {
    const doc = [
      "| Header 1 | Header 2 | Header 3 |",
      "|:---------|:--------:|---------:|",
      "| a        | b        | c        |",
      "| dd       | ee       | ff       |",
      "",
    ].join("\n");
    mounted = mount(doc);

    const table = mounted.host.querySelector("table.cm-table");
    expect(table).not.toBeNull();

    const ths = mounted.host.querySelectorAll(".cm-table th");
    expect(ths.length).toBe(3);
    expect(ths[0]!.textContent).toBe("Header 1");

    const bodyRows = mounted.host.querySelectorAll(".cm-table tbody tr");
    expect(bodyRows.length).toBe(2);

    // Alignment from the delimiter row: left / center / right.
    expect((ths[0] as HTMLElement).style.textAlign).toBe("left");
    expect((ths[1] as HTMLElement).style.textAlign).toBe("center");
    expect((ths[2] as HTMLElement).style.textAlign).toBe("right");

    // Zebra: the second body row carries the alt class.
    expect(bodyRows[1]!.classList.contains("cm-table-row-alt")).toBe(true);
  });

  it("renders ragged / empty cells without crashing (padded to column count)", () => {
    const doc = ["| a | b | c |", "|---|---|---|", "| 1 |   | 3 |", "| x |", ""].join(
      "\n",
    );
    mounted = mount(doc);
    const bodyRows = mounted.host.querySelectorAll(".cm-table tbody tr");
    expect(bodyRows.length).toBe(2);
    // Every body row is padded to 3 columns.
    bodyRows.forEach((tr) => {
      expect(tr.querySelectorAll("td").length).toBe(3);
    });
  });

  it("does not render an incomplete (delimiter-less) table as a grid", () => {
    const doc = "| just | a | header |\nnot a table yet\n";
    mounted = mount(doc);
    expect(mounted.host.querySelector("table.cm-table")).toBeNull();
  });

  it("renders inline marks in a blurred cell (story 3)", () => {
    const doc = ["| a | b |", "|---|---|", "| **bold** | [x](https://e.com) |", ""].join(
      "\n",
    );
    mounted = mount(doc);
    const cells = mounted.host.querySelectorAll(".cm-table tbody td");
    expect(cells[0]!.querySelector("strong")?.textContent).toBe("bold");
    expect(cells[1]!.querySelector("a.cm-link")?.getAttribute("data-cm-url")).toBe(
      "https://e.com",
    );
  });

  it("Tab commits the cell and moves the editor to the next cell (stories 4, 7)", async () => {
    const doc = ["| a | b |", "|---|---|", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const cell0 = mounted.host.querySelectorAll(".cm-table tbody td")[0] as HTMLElement;
    cell0.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const input = cell0.querySelector("input") as HTMLInputElement;
    input.value = "X";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    // Commit re-serialized the table to canonical form…
    expect(mounted.view.state.doc.toString()).toBe(
      ["| a | b |", "| --- | --- |", "| X | 2 |", ""].join("\n"),
    );
    // …and after the rebuild, focus lands in the next cell (1,1).
    await new Promise((r) => setTimeout(r, 0));
    const nextCellEl = mounted.host.querySelectorAll(".cm-table tbody td")[1] as HTMLElement;
    const nextInput = nextCellEl.querySelector("input") as HTMLInputElement | null;
    expect(nextInput).not.toBeNull();
    expect(nextInput!.value).toBe("2");
  });

  it("Tab past the last cell appends a new row and focuses its first cell (story 6)", async () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const lastCell = mounted.host.querySelectorAll(".cm-table tbody td")[1] as HTMLElement;
    lastCell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const input = lastCell.querySelector("input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    expect(mounted.view.state.doc.toString()).toBe(
      ["| a | b |", "| --- | --- |", "| 1 | 2 |", "|  |  |", ""].join("\n"),
    );
    await new Promise((r) => setTimeout(r, 0));
    const bodyRows = mounted.host.querySelectorAll(".cm-table tbody tr");
    expect(bodyRows.length).toBe(2);
    const newCell = bodyRows[1]!.querySelector("td") as HTMLElement;
    expect(newCell.querySelector("input")).not.toBeNull();
  });

  it("the add-column affordance appends a column (story 9)", () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const btn = mounted.host.querySelector('[data-testid="table.add-column"]')!;
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(mounted.view.state.doc.toString()).toBe(
      ["| a | b |  |", "| --- | --- | --- |", "| 1 | 2 |  |", ""].join("\n"),
    );
  });

  it("the add-row affordance appends a row (story 10)", () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const btn = mounted.host.querySelector('[data-testid="table.add-row"]')!;
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(mounted.view.state.doc.toString()).toBe(
      ["| a | b |", "| --- | --- |", "| 1 | 2 |", "|  |  |", ""].join("\n"),
    );
  });

  it("the per-header delete-column affordance removes that column (story 11)", () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const btn = mounted.host.querySelector(
      '[data-testid="table.delete-column"][data-col="1"]',
    )!;
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(mounted.view.state.doc.toString()).toBe(
      ["| a |", "| --- |", "| 1 |", ""].join("\n"),
    );
  });

  it("the top-left corner cell carries both a column and a row reorder handle (feedback)", () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const corner = mounted.host.querySelector('.cm-table thead th[data-col="0"]')!;
    expect(corner.querySelector('[data-testid="table.reorder-column"]')).not.toBeNull();
    expect(corner.querySelector('[data-testid="table.reorder-row"]')).not.toBeNull();
  });

  it("the per-row delete-row affordance removes that body row (story 11)", () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", ""].join("\n");
    mounted = mount(doc);
    const btn = mounted.host.querySelector(
      '[data-testid="table.delete-row"][data-row="1"]',
    )!;
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(mounted.view.state.doc.toString()).toBe(
      ["| a | b |", "| --- | --- |", "| 3 | 4 |", ""].join("\n"),
    );
  });

  it("affordance buttons do not pollute cell text content", () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const firstBodyCell = mounted.host.querySelector(".cm-table tbody td")!;
    // Cell (1,0) carries a delete-row button, but its text is just the content.
    expect(firstBodyCell.textContent).toBe("1");
  });

  it("dragging a column grip reorders the column header + body together (story 12)", () => {
    const doc = ["| a | b | c |", "| --- | --- | --- |", "| 1 | 2 | 3 |", ""].join("\n");
    mounted = mount(doc);
    const grip = mounted.host.querySelector(
      '[data-testid="table.reorder-column"][data-col="0"]',
    )!;
    const targetTh = mounted.host.querySelectorAll(".cm-table thead th")[2]!;
    grip.dispatchEvent(new Event("dragstart", { bubbles: true }));
    targetTh.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    // Column 0 ("a"/"1") moves to the end.
    expect(mounted.view.state.doc.toString()).toBe(
      ["| b | c | a |", "| --- | --- | --- |", "| 2 | 3 | 1 |", ""].join("\n"),
    );
  });

  it("dragging a row grip reorders whole rows (story 13)", () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", ""].join("\n");
    mounted = mount(doc);
    const grip = mounted.host.querySelector(
      '[data-testid="table.reorder-row"][data-row="1"]',
    )!;
    const targetRowCell = mounted.host.querySelectorAll(".cm-table tbody tr")[1]!
      .querySelector("td")!;
    grip.dispatchEvent(new Event("dragstart", { bubbles: true }));
    targetRowCell.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(mounted.view.state.doc.toString()).toBe(
      ["| a | b |", "| --- | --- |", "| 3 | 4 |", "| 1 | 2 |", ""].join("\n"),
    );
  });

  it("/table inserts a canonical empty 2×2 grid and focuses the first cell (story 15)", async () => {
    mounted = mount("/table");
    const cmd = slashCommands().find((c) => c.id === "table")!;
    expect(cmd).toBeDefined();
    cmd.apply(mounted.view, 0, "/table".length);

    expect(mounted.view.state.doc.toString()).toBe(
      ["|  |  |", "| --- | --- |", "|  |  |", ""].join("\n"),
    );
    await new Promise((r) => setTimeout(r, 0));
    const headerCell = mounted.host.querySelector(".cm-table thead th") as HTMLElement;
    expect(headerCell.querySelector("input")).not.toBeNull();
  });

  it("carries the E2E data-testid pass on the grid, cells, and editing input (SYNC-8)", () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    expect(mounted.host.querySelector('[data-testid="table.grid"]')).not.toBeNull();
    // Header cell (0,0) and body cell (1,1) addressable by row/col.
    expect(
      mounted.host.querySelector('[data-testid="table.cell"][data-row="0"][data-col="0"]'),
    ).not.toBeNull();
    const body11 = mounted.host.querySelector(
      '[data-testid="table.cell"][data-row="1"][data-col="1"]',
    ) as HTMLElement;
    expect(body11).not.toBeNull();
    body11.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(body11.querySelector('[data-testid="table.cell-input"]')).not.toBeNull();
  });

  it("/table inserts a blank-line-separated table so two tables never merge (feedback #7)", () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "/table"].join("\n");
    mounted = mount(doc);
    const f = doc.indexOf("/table");
    const cmd = slashCommands().find((c) => c.id === "table")!;
    cmd.apply(mounted.view, f, f + "/table".length);
    // A blank line now separates table 1's last row from the inserted table,
    // so @lezer/markdown parses them as two tables, not one merged grid.
    expect(mounted.view.state.doc.toString()).toContain("| 1 | 2 |\n\n|  |  |");
  });

  it("registers an editable table as an atomic range so the cursor can't enter its source (feedback #9)", () => {
    const doc = ["before", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "after"].join(
      "\n",
    );
    mounted = mount(doc);
    assertParsed(mounted.view);

    const covers = (pos: number): boolean => {
      let hit = false;
      for (const fn of mounted!.view.state.facet(EditorView.atomicRanges)) {
        fn(mounted!.view).between(pos, pos, (from, to) => {
          if (from <= pos && pos < to) hit = true;
        });
      }
      return hit;
    };

    expect(covers(doc.indexOf("| a | b |") + 3)).toBe(true); // inside the table → atomic
    expect(covers(2)).toBe(false); // inside "before" → freely editable
  });

  it("typing on the blank line directly below a table is not absorbed into it (feedback #4)", () => {
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    assertParsed(mounted.view);
    const blankLine = mounted.view.state.doc.line(4).from;
    mounted.view.dispatch({
      changes: { from: blankLine, insert: "x" },
      selection: { anchor: blankLine + 1 },
      userEvent: "input.type",
    });
    // The guard kept a blank line between the table and the typed text, so the
    // table stays 3 rows and "x" is a separate paragraph below it.
    expect(mounted.view.state.doc.toString()).toBe(
      ["| a | b |", "| --- | --- |", "| 1 | 2 |", "", "x"].join("\n"),
    );
  });

  it("clicking an occupied cell enters edit without selecting all (feedback)", () => {
    const doc = ["| a | b |", "| --- | --- |", "| hello | 2 |", ""].join("\n");
    mounted = mount(doc);
    const cell = mounted.host.querySelectorAll(".cm-table tbody td")[0] as HTMLElement;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const input = cell.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("hello");
    // Caret at the end, nothing selected (selectionStart === selectionEnd === len).
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(5);
  });

  it("inserts cell text via textContent — no HTML injection (TB2)", () => {
    const doc = ["| a | b |", "|---|---|", "| <b>x</b> | y |", ""].join("\n");
    mounted = mount(doc);
    // The angle-bracket content is literal text, not a parsed <b> element.
    expect(mounted.host.querySelector(".cm-table b")).toBeNull();
    const firstCell = mounted.host.querySelector(".cm-table tbody td");
    expect(firstCell!.textContent).toBe("<b>x</b>");
  });

  it("clicking a cell in a top-level table opens an inline editor seeded with the cell source (story 1)", () => {
    const doc = ["| a | b |", "|---|---|", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const before = mounted.view.state.doc.toString();
    const cell = mounted.host.querySelectorAll(".cm-table tbody td")[0] as HTMLElement;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    const input = cell.querySelector("input") as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input!.value).toBe("1");
    // Editing is local to the field — no doc change until commit.
    expect(mounted.view.state.doc.toString()).toBe(before);
  });

  it("editing a cell then blurring commits canonical source (stories 2, 7)", () => {
    const doc = ["| a | b |", "|---|---|", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const cell = mounted.host.querySelectorAll(".cm-table tbody td")[0] as HTMLElement;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const input = cell.querySelector("input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new FocusEvent("blur"));

    // The whole table re-serializes to canonical single-space form on commit.
    expect(mounted.view.state.doc.toString()).toBe(
      ["| a | b |", "| --- | --- |", "| hello | 2 |", ""].join("\n"),
    );
  });

  it("Escape reverts a cell edit with no doc change (story 8)", () => {
    const doc = ["| a | b |", "|---|---|", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const before = mounted.view.state.doc.toString();
    const cell = mounted.host.querySelectorAll(".cm-table tbody td")[0] as HTMLElement;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const input = cell.querySelector("input") as HTMLInputElement;
    input.value = "changed";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(mounted.view.state.doc.toString()).toBe(before);
    expect(cell.querySelector("input")).toBeNull();
    expect(cell.textContent).toBe("1");
  });

  it("committing an unchanged value on an already-canonical table makes no doc change", () => {
    // No-op guard: commit dispatches only when the re-serialized form differs
    // from the current source. On a canonical table an unchanged value matches,
    // so nothing is written and the cell is restored.
    const doc = ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const before = mounted.view.state.doc.toString();
    const cell = mounted.host.querySelectorAll(".cm-table tbody td")[0] as HTMLElement;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const input = cell.querySelector("input") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("blur")); // value unchanged

    expect(mounted.view.state.doc.toString()).toBe(before);
    expect(cell.querySelector("input")).toBeNull();
  });

  it("touching a cell on a non-canonical table reformats the whole table to canonical", () => {
    // The always-reformat contract (grill Q2/B): committing any cell normalizes
    // the entire table — a deliberate, documented departure from MYND-139's
    // byte-stable round-trip.
    const doc = ["|a|b|", "|---|---|", "|1|2|", ""].join("\n");
    mounted = mount(doc);
    const cell = mounted.host.querySelectorAll(".cm-table tbody td")[0] as HTMLElement;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const input = cell.querySelector("input") as HTMLInputElement;
    input.dispatchEvent(new FocusEvent("blur")); // value unchanged, table not canonical

    expect(mounted.view.state.doc.toString()).toBe(
      ["| a | b |", "| --- | --- |", "| 1 | 2 |", ""].join("\n"),
    );
  });

  it("unfocused editor renders the table as a grid even with the cursor inside it (story 13)", () => {
    // A freshly-mounted view is not focused, so its focus field defaults
    // false → tables render regardless of selection position. Dispatching a
    // selection inside the table must NOT reveal it while unfocused.
    const doc = ["| a | b |", "|---|---|", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    mounted.view.dispatch({ selection: { anchor: 4 } }); // inside header row
    mounted.view.requestMeasure();
    expect(mounted.host.querySelector("table.cm-table")).not.toBeNull();
  });
});

// Reveal gating is a pure function of (state, focused) — tested directly so it
// doesn't depend on flaky jsdom focus events. A view is mounted only to force a
// complete parse; the focus argument is passed explicitly. Editable (top-level)
// tables are never revealed; nested (blockquote / list) tables keep the
// whole-table cursor reveal as a safe read-only fallback.
describe("reveal gating (buildTableDecorations)", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  function parsedState(doc: string): EditorState {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc,
        extensions: [markdown({ base: markdownLanguage, extensions: [Wikilink] })],
      }),
      parent: host,
    });
    assertParsed(view);
    return view.state;
  }

  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = null;
    host = null;
  });

  const TABLE = ["| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |", ""].join("\n");
  // A blockquote-nested table — editable: false, so the reveal fallback applies.
  const QUOTED = ["> | a | b |", "> |---|---|", "> | 1 | 2 |", "", "after", ""].join("\n");

  it("a top-level table is never revealed — 1 block decoration with the cursor outside", () => {
    const base = parsedState(TABLE);
    const state = base.update({ selection: { anchor: base.doc.length } }).state;
    expect(buildTableDecorations(state, true).size).toBe(1);
  });

  it("a top-level table is never revealed even with the cursor on a table line + focused", () => {
    const base = parsedState(TABLE);
    const state = base.update({ selection: { anchor: 3 } }).state; // header row
    expect(buildTableDecorations(state, true).size).toBe(1);
  });

  it("a nested (blockquote) table reveals when focused and the cursor is on a table line", () => {
    const base = parsedState(QUOTED);
    const state = base.update({ selection: { anchor: 5 } }).state; // inside the quoted header
    expect(buildTableDecorations(state, true).size).toBe(0);
  });

  it("a nested table does NOT reveal when the editor is unfocused (story 13)", () => {
    const base = parsedState(QUOTED);
    const state = base.update({ selection: { anchor: 5 } }).state;
    expect(buildTableDecorations(state, false).size).toBe(1);
  });
});

// Arrow-into-table entry detection. Pure (no layout) so it's deterministic;
// the moveVertically wiring is exercised in the manual smoke.
describe("findTableEntry (arrow-into-table)", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  // Lines: 1 "before" / 2 header / 3 delimiter / 4 body / 5 blank / 6 "after".
  // The blank line 5 is REQUIRED — GFM absorbs a non-blank line directly after
  // a table as another row, so a paragraph must be blank-line-separated.
  const DOC = ["before", "| a | b |", "|---|---|", "| 1 | 2 |", "", "after"].join(
    "\n",
  );

  function parsed(): EditorState {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: [markdown({ base: markdownLanguage, extensions: [Wikilink] })],
      }),
      parent: host,
    });
    assertParsed(view);
    return view.state;
  }

  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = null;
    host = null;
  });

  it("downward move from above the table → enters the header (first) line", () => {
    const state = parsed();
    // Simulate a vertical move that would skip from line 1 past the table.
    const entry = findTableEntry(state, 1, 6);
    expect(entry).toBe(state.doc.line(2).from); // header line
  });

  it("upward move from below the table → enters the last body line", () => {
    const state = parsed();
    const entry = findTableEntry(state, 6, 1);
    expect(entry).toBe(state.doc.line(4).from); // last table line
  });

  it("returns null when no table is skipped", () => {
    const state = parsed();
    expect(findTableEntry(state, 4, 5)).toBeNull(); // line 4 (in table) → 5 (blank), no table starts between
    expect(findTableEntry(state, 1, 1)).toBeNull(); // no vertical progress
  });
});

describe("cursor movement never mutates the buffer", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = null;
    host = null;
  });

  it("moving the cursor onto / off an irregular-padding table leaves it byte-identical", () => {
    // Top-level tables render in place and never reveal — only an explicit cell
    // commit re-serializes. Merely moving the cursor must not normalize/re-pad.
    const doc = ["|a|b|c|", "|:--|--:|---|", "| 1 |   |3|", "|x|", ""].join("\n");
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          markdown({ base: markdownLanguage, extensions: [Wikilink] }),
          tableDecorations(),
        ],
      }),
      parent: host,
    });
    assertParsed(view);

    const before = view.state.doc.toString();
    // Cursor into the table (reveal attempt), then back out (re-render).
    view.dispatch({ selection: { anchor: 2 } });
    view.requestMeasure();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.requestMeasure();

    expect(view.state.doc.toString()).toBe(before);
  });
});
