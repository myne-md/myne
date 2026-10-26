// @vitest-environment jsdom
//
// Unit tests for the saved-view TABLE renderer (MYND-277). Behaviour-level:
// fabricate a `SavedView` + `ViewResult`, assert the column header, one row per
// note, typed cells, group headings, the empty state, the sticky Name column,
// the read-only guarantee, and the navigation click matrix.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The bulk path's three seams, mocked only so the RESTORE OFFER can be driven
// with and without a snapshot id. Everything else in this file renders the real
// component against fabricated view results.
const setNoteField = vi.hoisted(() => vi.fn());
const snapshotRestore = vi.hoisted(() => vi.fn());
const flush = vi.hoisted(() => vi.fn());

vi.mock("../../src/notes/setNoteField", () => ({
  NOTE_FIELD_WRITE_EVENT: "myne-note-field-written",
  setNoteField,
}));
vi.mock("../../src/notes/snapshots", () => ({ snapshotRestore }));
vi.mock("../../src/notes/flushBeforeFrontmatterWrite", () => ({
  flushBeforeFrontmatterWrite: () => flush(),
}));

import { TableView } from "../../src/notes/views/tableView";
import type { SavedView } from "../../src/lib/prefs";
import type { StoredProperty, ViewResult, ViewRow } from "../../src/notes/queryEngine";
import { clearBulkUndoForLock } from "../../src/notes/views/bulkUndoJournal";

afterEach(cleanup);

beforeEach(() => {
  setNoteField.mockReset();
  snapshotRestore.mockReset().mockResolvedValue(undefined);
  flush.mockReset().mockResolvedValue(undefined);
  clearBulkUndoForLock();
});

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
    // The pinned element is the CELL, not the text node: the cell now carries the
    // bulk-selection toggle beside the title, so a title-only query would find the
    // ellipsis box instead of the sticky column. The assertion is unchanged.
    const name = screen.getByTestId("view.table-name-cell");
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

  it("offers bulk selection only for a view that declares write fields", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha")] }],
    };
    const { unmount } = render(<TableView def={tableDef()} result={result} />);
    // No declared write authority → no selection affordance at all. A read-only
    // view must not hint at a write it can never make.
    expect(screen.queryByTestId("view.bulk-bar")).toBeNull();
    expect(screen.queryByTestId("view.bulk-select-row")).toBeNull();
    unmount();

    render(
      <TableView def={tableDef({ write_fields: ["status"] })} result={result} />,
    );
    expect(screen.getByTestId("view.bulk-bar")).toBeTruthy();
    const toggle = screen.getByTestId("view.bulk-select-row");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // And the Apply button reports the derived selection size.
    expect(
      (screen.getByTestId("view.bulk-apply") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("offers no restore when the written notes carry no pre-write snapshot, and says why", async () => {
    // A note in the current on-disk format is a CRDT note: its change graph IS its
    // history, so `note_set_field` captures no snapshot and reports none. The
    // button used to render anyway and could only answer "Restored 0." on every
    // vault created today, which is an offer without a capability.
    setNoteField.mockResolvedValue({ snapshotId: null });
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [row("n1", "Alpha", { status: str("x") }), row("n2", "Beta")],
        },
      ],
    };
    render(<TableView def={tableDef({ write_fields: ["status"] })} result={result} />);
    for (const toggle of screen.getAllByTestId("view.bulk-select-row")) {
      fireEvent.click(toggle);
    }
    fireEvent.click(screen.getByTestId("view.bulk-apply"));
    await screen.findByTestId("view.bulk-nothing-to-restore");
    expect(screen.queryByTestId("view.bulk-restore")).toBeNull();
  });

  it("offers the restore as soon as one written note has a snapshot", async () => {
    setNoteField
      .mockResolvedValueOnce({ snapshotId: "s1" })
      .mockResolvedValueOnce({ snapshotId: null });
    const result: ViewResult = {
      groups: [
        {
          key: "",
          type: "none",
          rows: [row("n1", "Alpha", { status: str("x") }), row("n2", "Beta")],
        },
      ],
    };
    render(<TableView def={tableDef({ write_fields: ["status"] })} result={result} />);
    for (const toggle of screen.getAllByTestId("view.bulk-select-row")) {
      fireEvent.click(toggle);
    }
    fireEvent.click(screen.getByTestId("view.bulk-apply"));
    await screen.findByTestId("view.bulk-restore");
    expect(screen.queryByTestId("view.bulk-nothing-to-restore")).toBeNull();
  });

  it("is a read-only projection (no editable CELL: input / contenteditable / draggable)", () => {
    const result: ViewResult = {
      groups: [{ key: "", type: "none", rows: [row("n1", "Alpha", { status: str("x") })] }],
    };
    // The promise is about CELLS: a calm table of typed cells, never a
    // spreadsheet. The assertion is scoped to the rows and the header because the
    // bulk bar above the table legitimately carries one `<input>` (the value a
    // bulk set will write) — a bar is not a cell, and a blanket query over the
    // whole component would have to be weakened for a view that declares NO write
    // fields either, which is the case the promise actually governs.
    const readOnly = render(<TableView def={tableDef()} result={result} />);
    const body = () => readOnly.container.querySelectorAll('[data-testid="view.table-row"], [data-testid="view.table-header"]');
    for (const node of body()) {
      expect(node.querySelector("input")).toBeNull();
      expect(node.querySelector("[contenteditable]")).toBeNull();
      expect(node.querySelector("[draggable='true']")).toBeNull();
    }
    expect(readOnly.container.querySelector("input")).toBeNull();
    readOnly.unmount();

    // And the same holds for a view that DECLARES write fields: bulk selection is
    // a `role="checkbox"` button, so nothing inside a row became editable.
    const writable = render(
      <TableView def={tableDef({ write_fields: ["status"] })} result={result} />,
    );
    for (const node of writable.container.querySelectorAll(
      '[data-testid="view.table-row"], [data-testid="view.table-header"]',
    )) {
      expect(node.querySelector("input")).toBeNull();
      expect(node.querySelector("[contenteditable]")).toBeNull();
      expect(node.querySelector("[draggable='true']")).toBeNull();
    }
  });
});
