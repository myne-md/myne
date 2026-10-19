// @vitest-environment jsdom
//
// Unit tests for the saved-view LIST renderer (MYND-278). Behaviour-level:
// fabricate a `SavedView` + `ViewResult`, assert one row per note (title +
// inline typed detail), group headings, the empty state, the read-only
// guarantee, and the navigation click matrix.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListView } from "../../src/notes/views/listView";
import type { SavedView } from "../../src/lib/prefs";
import type { StoredProperty, ViewResult, ViewRow } from "../../src/notes/queryEngine";

afterEach(cleanup);

function listDef(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "v1",
    name: "Reading",
    view_type: "list",
    filters: { kind: "all" },
    columns: ["status"],
    ...over,
  };
}

const row = (
  noteId: string,
  title: string | null,
  values: Record<string, StoredProperty | undefined> = {},
): ViewRow => ({ noteId, title, folder: null, values });

const str = (value: string): StoredProperty => ({ key: "", type: "string", value });

describe("ListView", () => {
  it("renders one row per note with data-note-id, title, and inline detail", () => {
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [row("n1", "Alpha", { status: str("Reading") }), row("n2", "Beta")],
        },
      ],
    };
    render(<ListView def={listDef()} result={result} />);
    expect(screen.getByTestId("view.list")).toBeTruthy();
    const rows = screen.getAllByTestId("view.list-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-note-id")).toBe("n1");
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Reading")).toBeTruthy(); // inline typed detail
  });

  it("renders group headings with counts and the no-value label", () => {
    const result: ViewResult = {
      groups: [
        { key: "Fiction", type: "string", rows: [row("n1", "A")] },
        { key: "", type: "none", rows: [row("n2", "B")] },
      ],
    };
    render(<ListView def={listDef({ group_by: "genre" })} result={result} />);
    const headings = screen.getAllByTestId("view.group-heading");
    expect(headings).toHaveLength(2);
    expect(headings[0]!.textContent).toContain("Fiction");
    expect(headings[1]!.textContent).toContain("No value");
  });

  it("empty result → view.empty, no rows", () => {
    render(<ListView def={listDef()} result={{ groups: [] }} />);
    expect(screen.getByTestId("view.empty")).toBeTruthy();
    expect(screen.queryByTestId("view.list-row")).toBeNull();
  });

  it("opens the note via the click intent matrix", () => {
    const onOpenNote = vi.fn();
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha")] }],
    };
    render(<ListView def={listDef()} result={result} onOpenNote={onOpenNote} />);
    const rowEl = screen.getByTestId("view.list-row");
    fireEvent.click(rowEl);
    expect(onOpenNote).toHaveBeenLastCalledWith("n1", { newTab: false, toSide: false });
    fireEvent.click(rowEl, { ctrlKey: true });
    expect(onOpenNote).toHaveBeenLastCalledWith("n1", { newTab: true, toSide: false });
  });

  it("is a read-only projection (no input / contenteditable / draggable)", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha", { status: str("x") })] }],
    };
    const { container } = render(<ListView def={listDef()} result={result} />);
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("[contenteditable]")).toBeNull();
    expect(container.querySelector("[draggable='true']")).toBeNull();
  });
});
