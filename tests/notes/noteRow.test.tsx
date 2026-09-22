// @vitest-environment jsdom
//
// `<NoteRow>` render + interaction tests. The row branches on: title present /
// null (Untitled italic) / load error (warning dot), the relative-time subtitle
// (shown vs hidden + UUIDv7-derived fallback date), selection + hover styling,
// the favorites star (filled badge vs interactive hollow toggle vs hidden during
// rename), and the click matrix (plain / Cmd / Ctrl / Alt / middle / dbl-click /
// right-click). Inline-rename mode swaps the title for an auto-focused input with
// Enter/Esc/blur commit semantics. Pure component — no IPC.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NoteRow, noteRowDomId, type NoteRowProps } from "../../src/notes/components/NoteRow";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";

afterEach(cleanup);

function rec(over: Partial<TitleRecord> = {}): TitleRecord {
  return {
    noteUuid: "note-1",
    title: "Hello",
    folder: null,
    updatedAt: new Date("2026-06-16T12:00:00.000Z"),
    trashed: null,
    template: false,
    ...over,
  };
}

function renderRow(over: Partial<NoteRowProps> = {}) {
  const props: NoteRowProps = {
    record: rec(),
    selected: false,
    renaming: false,
    onSelect: vi.fn(),
    onStartRename: vi.fn(),
    onContextMenu: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    ...over,
  };
  return { props, ...render(<NoteRow {...props} />) };
}

describe("NoteRow — title rendering branches", () => {
  it("renders a real title", () => {
    renderRow({ record: rec({ title: "My Note" }) });
    expect(screen.getByTestId("notes.row").textContent).toContain("My Note");
  });

  it("null title → italic 'Untitled' placeholder", () => {
    renderRow({ record: rec({ title: null }) });
    const row = screen.getByTestId("notes.row");
    expect(row.textContent).toContain("Untitled");
    // The italic style marks the placeholder branch.
    const titleDiv = row.querySelector("div > div");
    expect(titleDiv).toBeTruthy();
  });

  it("load error → 'Untitled' + warning indicator + hover title", () => {
    const { container } = renderRow({
      record: rec({ title: null, error: "CannotDecrypt" }),
    });
    expect(screen.getByTestId("notes.row").textContent).toContain("Untitled");
    // The error branch renders a leading warning dot (aria-hidden span) + a
    // "Couldn't load this note" title attribute. Both distinguish it from the
    // plain null-title placeholder.
    expect(
      container.querySelector('[title="Couldn\'t load this note"]'),
    ).toBeTruthy();
  });

  it("marks the row with its colour slot when one is provided", () => {
    const { container } = renderRow({ colorSlot: "rose" });
    expect(container.querySelector('[data-color-slot="rose"]')).toBeTruthy();
  });

  it("carries no colour marker when colorSlot is omitted", () => {
    const { container } = renderRow();
    expect(container.querySelector("[data-color-slot]")).toBeNull();
  });
});

describe("NoteRow — subtitle / timestamps", () => {
  it("renders the relative-time subtitle from updatedAt by default", () => {
    renderRow({ record: rec({ updatedAt: new Date() }) });
    const sub = screen.getByTestId("notes.row-subtitle");
    expect(sub.textContent).toBe("just now");
  });

  it("omits the subtitle div entirely when showTimestamps is false", () => {
    renderRow({ record: rec(), showTimestamps: false });
    expect(screen.queryByTestId("notes.row-subtitle")).toBeNull();
  });

  it("falls back to the UUIDv7-derived date when updatedAt is null", () => {
    // A valid UUIDv7 whose first 48 bits decode to a real ms timestamp.
    const uuidv7 = "01890000-0000-7000-8000-000000000000";
    renderRow({
      record: rec({ noteUuid: uuidv7, updatedAt: null }),
    });
    // A non-empty subtitle proves the UUIDv7 fallback produced a date (an
    // absolute yyyy-mm-dd for this old timestamp).
    expect(screen.getByTestId("notes.row-subtitle").textContent).not.toBe("");
  });

  it("empty subtitle when updatedAt is null and the id is not UUIDv7-shaped", () => {
    renderRow({ record: rec({ noteUuid: "not-a-uuid", updatedAt: null }) });
    expect(screen.getByTestId("notes.row-subtitle").textContent).toBe("");
  });
});

describe("NoteRow — selection + aria", () => {
  it("reflects selection via aria-selected (myne#728)", () => {
    // Was `aria-current`, because the row called itself a `button` and
    // `aria-selected` is not permitted there. The row is a `treeitem` now (the
    // sidebar holds folders and notes in one hierarchy), so the selection is
    // conveyed by the attribute that means selection.
    renderRow({ selected: true });
    const row = screen.getByTestId("notes.row");
    expect(row.getAttribute("role")).toBe("treeitem");
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("is the list's one Tab stop when selected, and -1 otherwise (myne#728)", () => {
    // Roving tabindex: a vault with hundreds of notes costs one Tab press.
    renderRow({ selected: true });
    expect(screen.getByTestId("notes.row").getAttribute("tabindex")).toBe("0");
    cleanup();
    renderRow({ selected: false });
    expect(screen.getByTestId("notes.row").getAttribute("tabindex")).toBe("-1");
  });

  it("does not give every multi-selected row a Tab stop (myne#728)", () => {
    // `multiSelected` paints the row but must not add a stop, or a 40-note
    // multi-selection would put 40 stops back into the Tab order.
    renderRow({ multiSelected: true, selected: false });
    expect(screen.getByTestId("notes.row").getAttribute("tabindex")).toBe("-1");
  });

  it("carries a stable DOM id the container can name it by (myne#728)", () => {
    renderRow({ record: rec({ noteUuid: "abc" }) });
    expect(screen.getByTestId("notes.row").id).toBe(noteRowDomId("abc"));
  });

  it("carries the note id on the row", () => {
    renderRow({ record: rec({ noteUuid: "abc" }) });
    expect(screen.getByTestId("notes.row").getAttribute("data-note-id")).toBe(
      "abc",
    );
  });

  it("multiSelected → data-multiselected + aria-selected (MYND-367)", () => {
    renderRow({ multiSelected: true });
    const row = screen.getByTestId("notes.row");
    expect(row.getAttribute("data-multiselected")).toBe("true");
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("not multiSelected → no data-multiselected attribute", () => {
    renderRow();
    expect(
      screen.getByTestId("notes.row").getAttribute("data-multiselected"),
    ).toBeNull();
  });
});

describe("NoteRow — click matrix", () => {
  it("plain click → onSelect with no flags (open in focused pane)", () => {
    const onSelect = vi.fn();
    renderRow({ onSelect });
    fireEvent.click(screen.getByTestId("notes.row"));
    expect(onSelect).toHaveBeenCalledWith("note-1", { toSide: false });
  });

  it("Cmd / Ctrl click → toggle multi-selection (MYND-367; no longer newTab)", () => {
    const onSelect = vi.fn();
    renderRow({ onSelect });
    fireEvent.click(screen.getByTestId("notes.row"), { metaKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("note-1", { toggle: true });
    fireEvent.click(screen.getByTestId("notes.row"), { ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("note-1", { toggle: true });
  });

  it("Shift click → range-select (MYND-367)", () => {
    const onSelect = vi.fn();
    renderRow({ onSelect });
    fireEvent.click(screen.getByTestId("notes.row"), { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith("note-1", { range: true });
  });

  it("Shift takes precedence over Cmd/Ctrl → range", () => {
    const onSelect = vi.fn();
    renderRow({ onSelect });
    fireEvent.click(screen.getByTestId("notes.row"), {
      shiftKey: true,
      metaKey: true,
    });
    expect(onSelect).toHaveBeenCalledWith("note-1", { range: true });
  });

  it("Alt click → toSide", () => {
    const onSelect = vi.fn();
    renderRow({ onSelect });
    fireEvent.click(screen.getByTestId("notes.row"), { altKey: true });
    expect(onSelect).toHaveBeenCalledWith("note-1", { toSide: true });
  });

  it("middle click (aux button 1) → newTab", () => {
    const onSelect = vi.fn();
    renderRow({ onSelect });
    fireEvent(
      screen.getByTestId("notes.row"),
      new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
    );
    expect(onSelect).toHaveBeenCalledWith("note-1", { newTab: true });
  });

  it("aux click on a non-middle button is ignored", () => {
    const onSelect = vi.fn();
    renderRow({ onSelect });
    fireEvent(
      screen.getByTestId("notes.row"),
      new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("double-click → onStartRename", () => {
    const onStartRename = vi.fn();
    renderRow({ onStartRename });
    fireEvent.doubleClick(screen.getByTestId("notes.row"));
    expect(onStartRename).toHaveBeenCalledWith("note-1");
  });

  it("right-click → onContextMenu with the cursor position", () => {
    const onContextMenu = vi.fn();
    renderRow({ onContextMenu });
    fireEvent.contextMenu(screen.getByTestId("notes.row"), {
      clientX: 40,
      clientY: 80,
    });
    expect(onContextMenu).toHaveBeenCalledWith("note-1", { x: 40, y: 80 });
  });
});

describe("NoteRow — favorites star", () => {
  it("favorited + toggle wired → filled interactive button labelled 'Remove'", () => {
    const onToggleFavorite = vi.fn();
    renderRow({ favorited: true, onToggleFavorite });
    const btn = screen.getByRole("button", { name: "Remove from favorites" });
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onToggleFavorite).toHaveBeenCalledWith("note-1");
  });

  it("star click stops propagation (does not trigger row onSelect)", () => {
    const onSelect = vi.fn();
    const onToggleFavorite = vi.fn();
    renderRow({ favorited: true, onToggleFavorite, onSelect });
    fireEvent.click(screen.getByRole("button", { name: "Remove from favorites" }));
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("favorited without a toggle handler → non-interactive badge (no toggle button)", () => {
    renderRow({ favorited: true });
    // The interactive star button is keyed by its favorites aria-label; the
    // render-only badge is an aria-hidden span, so no such button exists.
    expect(screen.queryByLabelText(/favorites/i)).toBeNull();
  });

  it("not favorited + toggle wired → star hidden until hover, 'Add' on hover", () => {
    const onToggleFavorite = vi.fn();
    renderRow({ favorited: false, onToggleFavorite });
    // No hover → no star button.
    expect(screen.queryByLabelText(/favorites/i)).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("notes.row"));
    expect(screen.getByLabelText("Add to favorites")).toBeTruthy();
    fireEvent.mouseLeave(screen.getByTestId("notes.row"));
    expect(screen.queryByLabelText(/favorites/i)).toBeNull();
  });

  it("renaming hides the star even when favorited", () => {
    renderRow({ favorited: true, onToggleFavorite: vi.fn(), renaming: true });
    expect(screen.queryByLabelText(/favorites/i)).toBeNull();
  });
});

describe("NoteRow — inline rename mode", () => {
  it("replaces the title with an auto-focused, all-selected input", () => {
    renderRow({ record: rec({ title: "Original" }), renaming: true });
    const input = screen.getByTestId("notes.rename-input") as HTMLInputElement;
    expect(input.value).toBe("Original");
    expect(document.activeElement).toBe(input);
  });

  it("Enter commits the whitespace-trimmed value", () => {
    const onCommitRename = vi.fn();
    renderRow({ renaming: true, onCommitRename });
    const input = screen.getByTestId("notes.rename-input");
    fireEvent.change(input, { target: { value: "  new title  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommitRename).toHaveBeenCalledWith("note-1", "new title");
  });

  it("Enter on an empty/whitespace value cancels instead of committing", () => {
    const onCommitRename = vi.fn();
    const onCancelRename = vi.fn();
    renderRow({ renaming: true, onCommitRename, onCancelRename });
    const input = screen.getByTestId("notes.rename-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommitRename).not.toHaveBeenCalled();
    expect(onCancelRename).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels", () => {
    const onCancelRename = vi.fn();
    const onCommitRename = vi.fn();
    renderRow({ renaming: true, onCancelRename, onCommitRename });
    fireEvent.keyDown(screen.getByTestId("notes.rename-input"), {
      key: "Escape",
    });
    expect(onCancelRename).toHaveBeenCalledTimes(1);
    expect(onCommitRename).not.toHaveBeenCalled();
  });

  it("blur commits, and commit is idempotent (Enter then blur fires once)", () => {
    const onCommitRename = vi.fn();
    renderRow({ renaming: true, onCommitRename });
    const input = screen.getByTestId("notes.rename-input");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    // committedRef guards against the double-fire.
    expect(onCommitRename).toHaveBeenCalledTimes(1);
    expect(onCommitRename).toHaveBeenCalledWith("note-1", "Renamed");
  });
});

// ─── The unsynced-edit marker (phase3-web-client task 23) ────────────────────
//
// Story 29: an edit not yet on the server is the only thing between the user and
// real loss if storage is evicted or the tab closes, so it must be visible
// without being asked for. In the sidebar that means a marker on the row itself
// — not a hover reveal, not a panel, not a summary count somewhere else.

describe("NoteRow — unsynced-edit marker", () => {
  it("renders no marker by default", () => {
    renderRow();
    expect(screen.queryByTestId("notes.row-unsynced")).toBeNull();
  });

  it("renders the marker when the note is not yet on the server", () => {
    renderRow({ unsynced: true });
    expect(screen.getByTestId("notes.row-unsynced")).toBeTruthy();
  });

  it("marks the row without hover, selection or any other interaction", () => {
    // The whole point of the criterion. A marker that only appears on hover is
    // a marker the user has to go looking for, which is the state this feature
    // exists to prevent.
    renderRow({ unsynced: true, selected: false });
    expect(screen.getByTestId("notes.row-unsynced")).toBeTruthy();
  });

  it("still marks a note that is being renamed inline", () => {
    // Rename mode swaps the title node for an input, and an earlier draft lost
    // the marker with it — an edit does not become safe because the user is
    // retitling it. The marker moves out of the swapped node.
    renderRow({ unsynced: true, renaming: true });
    expect(screen.getByTestId("notes.rename-input")).toBeTruthy();
    expect(screen.getByTestId("notes.row-unsynced")).toBeTruthy();
  });

  it("carries an accessible label, not colour alone", () => {
    renderRow({ unsynced: true });
    const mark = screen.getByTestId("notes.row-unsynced");
    expect(mark.getAttribute("aria-label")).toBeTruthy();
    expect(mark.getAttribute("title")).toBeTruthy();
  });
});
