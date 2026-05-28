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
import { forceParsing } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import {
  buildTableDecorations,
  findTableEntry,
  parseDelimiterAlign,
  splitTableRow,
  tableDecorations,
} from "../../src/editor/decorations/table";

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

  it("inserts cell text via textContent — no HTML injection (TB2)", () => {
    const doc = ["| a | b |", "|---|---|", "| <b>x</b> | y |", ""].join("\n");
    mounted = mount(doc);
    // The angle-bracket content is literal text, not a parsed <b> element.
    expect(mounted.host.querySelector(".cm-table b")).toBeNull();
    const firstCell = mounted.host.querySelector(".cm-table tbody td");
    expect(firstCell!.textContent).toBe("<b>x</b>");
  });

  it("clicking a rendered row places the cursor on THAT row's source line, not the line below (story 10)", () => {
    // Regression: a block-replace widget is atomic, so letting CM handle the
    // click resolved it to the block boundary (the line below the table). The
    // widget's own mousedown handler must dispatch a selection onto the
    // clicked row's source line instead.
    const doc = [
      "| a | b |", // line 1 — header
      "|---|---|", // line 2 — delimiter
      "| 1 | 2 |", // line 3 — body row 0
      "| 3 | 4 |", // line 4 — body row 1
      "", //          line 5 — after the table
    ].join("\n");
    mounted = mount(doc);

    const bodyRows = mounted.host.querySelectorAll(".cm-table tbody tr");
    expect(bodyRows.length).toBe(2);
    bodyRows[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    const head = mounted.view.state.selection.main.head;
    const line = mounted.view.state.doc.lineAt(head).number;
    expect(line).toBe(4); // the clicked body row, NOT line 5 (below the table)
  });

  it("clicking the header row places the cursor on the header source line", () => {
    const doc = ["| a | b |", "|---|---|", "| 1 | 2 |", ""].join("\n");
    mounted = mount(doc);
    const headerRow = mounted.host.querySelector(".cm-table thead tr");
    headerRow!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const head = mounted.view.state.selection.main.head;
    expect(mounted.view.state.doc.lineAt(head).number).toBe(1);
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

// Reveal decision is a pure function of (state, focused) — tested directly so
// it doesn't depend on flaky jsdom focus events. A view is mounted only to
// force a complete parse; the focus argument is passed explicitly.
describe("whole-table cursor reveal (buildTableDecorations)", () => {
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
    forceParsing(view, doc.length, 5000);
    return view.state;
  }

  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = null;
    host = null;
  });

  const TABLE = ["| a | b |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |", ""].join("\n");

  it("renders (1 block decoration) when the selection is outside the table and focused", () => {
    const base = parsedState(TABLE);
    const state = base.update({ selection: { anchor: base.doc.length } }).state;
    expect(buildTableDecorations(state, true).size).toBe(1);
  });

  it("reveals (0 decorations) when focused and the selection head is on a table line", () => {
    const base = parsedState(TABLE);
    const state = base.update({ selection: { anchor: 3 } }).state; // header row
    expect(buildTableDecorations(state, true).size).toBe(0);
  });

  it("does NOT reveal when the selection is inside the table but the editor is unfocused (story 13)", () => {
    const base = parsedState(TABLE);
    const state = base.update({ selection: { anchor: 3 } }).state;
    expect(buildTableDecorations(state, false).size).toBe(1);
  });

  it("reveals only the table the cursor is in (two tables)", () => {
    const doc =
      ["| a | b |", "|---|---|", "| 1 | 2 |", "", "| c | d |", "|---|---|", "| 5 | 6 |", ""].join(
        "\n",
      );
    const base = parsedState(doc);
    const state = base.update({ selection: { anchor: 3 } }).state; // first table
    // First table revealed, second still rendered → exactly 1 block decoration.
    expect(buildTableDecorations(state, true).size).toBe(1);
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
    forceParsing(view, DOC.length, 5000);
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

describe("byte-stable round-trip (criterion 4 guard)", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = null;
    host = null;
  });

  it("render → reveal → re-render leaves an irregular-padding table byte-identical", () => {
    // Irregular padding + ragged widths + no spaces — the renderer must never
    // normalize or re-pad. Nothing in the table code dispatches a doc change.
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
    forceParsing(view, doc.length, 5000);

    const before = view.state.doc.toString();
    // Cursor into the table (reveal attempt), then back out (re-render).
    view.dispatch({ selection: { anchor: 2 } });
    view.requestMeasure();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.requestMeasure();

    expect(view.state.doc.toString()).toBe(before);
  });
});
