// @vitest-environment jsdom
//
// Unit tests for the saved-view TABLE renderer (MYND-277). Behaviour-level:
// fabricate a `SavedView` + `ViewResult`, assert the column header, one row per
// note, typed cells, group headings, the empty state, the sticky Name column,
// the read-only guarantee, and the navigation click matrix.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TableView } from "../../src/notes/views/tableView";
import type { SavedView } from "../../src/lib/prefs";
import type { StoredProperty, ViewResult, ViewRow } from "../../src/notes/queryEngine";

afterEach(cleanup);

function tableDef(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "v1",
    name: "Tasks",
    view_type: "table",
    filters: { kind: "all" },
    columns: ["status", "due"],
    ...over,
  };
}

const row = (
  noteId: string,
  title: string | null,
  values: Record<string, StoredProperty | undefined> = {},
): ViewRow => ({ noteId, title, folder: null, values });

const str = (value: string): StoredProperty => ({ key: "", type: "string", value });

describe("TableView", () => {
  it("renders a column header + one row per note with data-note-id and typed cells", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [row("n1", "Alpha", { status: str("Done") }), row("n2", "Beta")],
        },
      ],
    };
    render(<TableView def={tableDef()} result={result} />);
    expect(screen.getByTestId("view.table")).toBeTruthy();
    expect(screen.getByTestId("view.table-header")).toBeTruthy();
    const rows = screen.getAllByTestId("view.table-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-note-id")).toBe("n1");
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy(); // the status property cell
  });

  it("excludes the cover-image column from the displayed columns", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha", { cover: str("x") })] }],
    };
    render(
      <TableView def={tableDef({ columns: ["cover", "status"], image: "cover" })} result={result} />,
    );
    // header shows "status" but NOT "cover"
    const header = screen.getByTestId("view.table-header");
    expect(header.textContent).toContain("status");
    expect(header.textContent).not.toContain("cover");
  });

  it("renders group headings with counts and the no-value label", () => {
    const result: ViewResult = {
      groups: [
        { key: "Done", type: "string", rows: [row("n1", "A")] },
        { key: "", type: "none", rows: [row("n2", "B")] },
      ],
    };
    render(<TableView def={tableDef({ group_by: "status" })} result={result} />);
    const headings = screen.getAllByTestId("view.group-heading");
    expect(headings).toHaveLength(2);
    expect(headings[0]!.textContent).toContain("Done");
    expect(headings[1]!.textContent).toContain("No value");
  });

  it("empty result → view.empty, no header or rows", () => {
    render(<TableView def={tableDef()} result={{ groups: [] }} />);
    expect(screen.getByTestId("view.empty")).toBeTruthy();
    expect(screen.queryByTestId("view.table-header")).toBeNull();
    expect(screen.queryByTestId("view.table-row")).toBeNull();
  });

  it("pins the Name column (position:sticky, inset-inline-start:0)", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha")] }],
    };
    render(<TableView def={tableDef()} result={result} />);
    const name = screen.getByText("Alpha");
    expect(name.style.position).toBe("sticky");
    // Logical property (RTL migration): the pinned column anchors to the leading
    // edge via `inset-inline-start` (= `left` in LTR).
    expect(name.style.insetInlineStart).toBe("0px");
  });

  it("opens the note via the click intent matrix (plain / mod / middle)", () => {
    const onOpenNote = vi.fn();
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha")] }],
    };
    render(<TableView def={tableDef()} result={result} onOpenNote={onOpenNote} />);
    const rowEl = screen.getByTestId("view.table-row");
    fireEvent.click(rowEl);
    expect(onOpenNote).toHaveBeenLastCalledWith("n1", { newTab: false, toSide: false });
    fireEvent.click(rowEl, { metaKey: true });
    expect(onOpenNote).toHaveBeenLastCalledWith("n1", { newTab: true, toSide: false });
    fireEvent.click(rowEl, { altKey: true });
    expect(onOpenNote).toHaveBeenLastCalledWith("n1", { newTab: false, toSide: true });
    fireEvent(
      rowEl,
      new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
    );
    expect(onOpenNote).toHaveBeenLastCalledWith("n1", { newTab: true, toSide: false });
  });

  it("is a read-only projection (no input / contenteditable / draggable)", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha", { status: str("x") })] }],
    };
    const { container } = render(<TableView def={tableDef()} result={result} />);
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("[contenteditable]")).toBeNull();
    expect(container.querySelector("[draggable='true']")).toBeNull();
  });
});
