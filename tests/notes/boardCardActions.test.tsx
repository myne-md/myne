// @vitest-environment jsdom
//
// A card's affordances: open, archive, trash (myne-md/myne#922 task 8).
//
// The board does not own these writes. The menu it draws is the SHARED
// `buildCardMenuItems` + `ContextMenu`, and both lifecycle items call the host
// path it was handed, which writes the reserved markers a manifest can never
// address. So the cases are:
//
//   - archive and trash are two distinct, labelled actions, not one "Delete";
//   - the trash one asks first, and the archive one does not;
//   - the card leaves the board on the next read, asserted on the NOTE's bytes
//     first and only then on the rendered lanes;
//   - a refusal is a stated line rather than a silent no-op.
//
// The host actions under test are the REAL writers (`archiveNote`,
// `trashNote`), not fakes that record a flag: the point is that the marker those
// writers produce is what takes the card off the board.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SavedView } from "../../src/lib/prefs";
import type { ViewResult } from "../../src/notes/queryEngine";

const h = vi.hoisted(() => ({
  /** note id -> plaintext, the vault the host writers actually read and write. */
  notes: new Map<string, string>(),
  refuseWrite: false,
  invoke: vi.fn(),
}));

vi.mock("../../src/platform/core", () => ({ invoke: h.invoke }));
vi.mock("../../src/notes/flushBeforeFrontmatterWrite", () => ({
  flushBeforeFrontmatterWrite: async () => {},
}));
vi.mock("../../src/notes/readNote", () => ({
  noteRead: async (noteId: string) => h.notes.get(noteId) ?? "",
}));

import { BoardView, type BoardCardActions } from "../../src/notes/views/boardView";
import { buildCardMenuItems } from "../../src/notes/views/cardMenu";
import { archiveNote } from "../../src/notes/archiveNote";
import { trashNote } from "../../src/notes/trashNote";

afterEach(cleanup);

const NOTE = (status: string, title: string) =>
  `---\nstatus: ${status}\ntitle: ${title}\n---\n${title} body.\n`;

beforeEach(() => {
  h.notes.clear();
  h.notes.set("n1", NOTE("Doing", "Draft the guide"));
  h.notes.set("n2", NOTE("Doing", "Draft the outline"));
  h.refuseWrite = false;
  h.invoke.mockReset();
  h.invoke.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      if (command !== "plugin:notes|note_update") {
        throw new Error(`unexpected command in this test: ${command}`);
      }
      if (h.refuseWrite) throw new Error("vault locked");
      h.notes.set(args.noteId as string, args.plaintext as string);
      return null;
    },
  );
});

function boardDef(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "b1",
    name: "Release board",
    view_type: "board",
    filters: { kind: "all" },
    group_by: "status",
    write_fields: ["status"],
    lanes: ["Backlog", "Doing"],
    ...over,
  };
}

/** The result the query engine would produce from the fake vault: a note whose
 *  own bytes carry `archived:` or `trashed:` is not in the working set, so it is
 *  in no lane. That is `isLiveNote`'s rule, restated here against the bytes. */
function result(): ViewResult {
  const live = (noteId: string): boolean => {
    const text = h.notes.get(noteId) ?? "";
    return !/^(archived|trashed|deleted):/m.test(text);
  };
  const doing = [
    { noteId: "n1", title: "Draft the guide" },
    { noteId: "n2", title: "Draft the outline" },
  ].filter((row) => live(row.noteId));
  return {
    groups: [
      { key: "Backlog", type: "string", rows: [] },
      {
        key: "Doing",
        type: "string",
        rows: doing.map((row) => ({
          ...row,
          folder: null,
          values: { status: { key: "status", type: "string" as const, value: "Doing" } },
        })),
      },
    ],
  };
}

/** The host's actions, as `ViewHost` wires them: every one leaves the board, and
 *  the two lifecycle ones are the app's real reserved-marker writers. */
function cardActions(over: Partial<BoardCardActions> = {}): BoardCardActions {
  return {
    open: vi.fn(),
    openInNewTab: vi.fn(),
    revealInFolder: vi.fn(),
    copyLink: vi.fn(),
    archive: (noteId) => archiveNote(noteId),
    trash: (noteId) => trashNote(noteId),
    ...over,
  };
}

function lane(value: string): HTMLElement {
  return screen
    .getAllByTestId("view.lane")
    .find((element) => element.getAttribute("data-lane-value") === value)!;
}

function openMenu(noteId: string): void {
  const card = document.querySelector(
    `[data-testid="view.card"][data-note-id="${noteId}"]`,
  ) as HTMLElement;
  fireEvent.contextMenu(card, { clientX: 20, clientY: 20 });
}

function menuItem(label: string): HTMLElement {
  return screen.getByRole("menuitem", { name: label });
}

function renderedNoteIds(): (string | null)[] {
  return screen.getAllByTestId("view.card").map((card) => card.getAttribute("data-note-id"));
}

describe("opening a card", () => {
  it("opens the note through the host's own seam", () => {
    const onOpenNote = vi.fn();
    render(<BoardView def={boardDef()} result={result()} onOpenNote={onOpenNote} />);
    const card = document.querySelector(
      '[data-testid="view.card"][data-note-id="n1"]',
    ) as HTMLElement;
    fireEvent.click(card);
    expect(onOpenNote).toHaveBeenCalledWith("n1", { newTab: false, toSide: false });
  });
});

describe("the card menu", () => {
  it("carries archive and trash as two distinct, labelled actions", () => {
    render(<BoardView def={boardDef()} result={result()} cardActions={cardActions()} />);
    openMenu("n1");
    expect(menuItem("Archive note")).toBeTruthy();
    expect(menuItem("Move note to trash")).toBeTruthy();
    // Neither is called "Delete", and they sit apart from the navigation items.
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    // The navigation half is still there: the board is a way in, not a dead end.
    expect(menuItem("Open")).toBeTruthy();
    expect(menuItem("Copy link")).toBeTruthy();
  });

  it("offers no lifecycle item on a host that has none", () => {
    render(<BoardView def={boardDef()} result={result()} />);
    // No host actions at all: no menu is drawn, so no mutating verb is on offer.
    openMenu("n1");
    expect(screen.queryByRole("menuitem", { name: "Archive note" })).toBeNull();
  });

  it("is the shared builder, not a second menu implementation", () => {
    // The read-only shape is unchanged, which is what keeps the gallery's menu
    // and the board's the same component with one optional tail.
    const readOnly = buildCardMenuItems({
      open: vi.fn(),
      openInNewTab: vi.fn(),
      revealInFolder: vi.fn(),
      copyLink: vi.fn(),
    }).map((item) => item.id);
    expect(readOnly).toEqual(["open", "open-in-new-tab", "reveal-in-folder", "copy-link"]);
    const withLifecycle = buildCardMenuItems(
      {
        open: vi.fn(),
        openInNewTab: vi.fn(),
        revealInFolder: vi.fn(),
        copyLink: vi.fn(),
      },
      { archive: vi.fn(), trash: vi.fn() },
    );
    expect(withLifecycle.map((item) => item.id)).toEqual([
      "open",
      "open-in-new-tab",
      "reveal-in-folder",
      "copy-link",
      "archive",
      "trash",
    ]);
    // The trash item is the destructive one, and only it.
    expect(withLifecycle.filter((item) => item.destructive).map((item) => item.id)).toEqual([
      "trash",
    ]);
  });
});

describe("archiving", () => {
  it("writes `archived:` on the note and takes the card off the board", async () => {
    const actions = cardActions();
    const { rerender } = render(
      <BoardView def={boardDef()} result={result()} cardActions={actions} />,
    );
    openMenu("n1");
    fireEvent.click(menuItem("Archive note"));

    await waitFor(() => expect(h.notes.get("n1")).toContain("archived:"));
    // The note's bytes: an archive marker, and no trash marker (archive ⊥ trash).
    expect(h.notes.get("n1")).toMatch(/^archived: /m);
    expect(h.notes.get("n1")).not.toMatch(/^trashed: /m);
    // The title and body are untouched, so the note is where its writer left it.
    expect(h.notes.get("n1")).toContain("title: Draft the guide");
    expect(h.notes.get("n1")).toContain("Draft the guide body.");

    // …and only now the rendered lanes, from a fresh read.
    rerender(<BoardView def={boardDef()} result={result()} cardActions={actions} />);
    expect(renderedNoteIds()).toEqual(["n2"]);
    expect(within(lane("Doing")).getAllByTestId("view.card")).toHaveLength(1);
  });
});

describe("trashing", () => {
  it("asks first, and does nothing until the question is answered", async () => {
    const actions = cardActions();
    render(<BoardView def={boardDef()} result={result()} cardActions={actions} />);
    openMenu("n1");
    fireEvent.click(menuItem("Move note to trash"));

    // A confirmation, carrying the app's own vocabulary for what happens next.
    expect(screen.getByText("Move to Trash?")).toBeTruthy();
    expect(screen.getByText("You can restore it from Trash later.")).toBeTruthy();
    expect(h.notes.get("n1")).not.toMatch(/^trashed: /m);

    fireEvent.click(screen.getByTestId("view.board-trash-confirm"));
    await waitFor(() => expect(h.notes.get("n1")).toMatch(/^trashed: /m));
    // A trashed note is recoverable, so the note is still on disk.
    expect(h.notes.get("n1")).toContain("title: Draft the guide");
  });

  it("cancels without writing anything", async () => {
    render(<BoardView def={boardDef()} result={result()} cardActions={cardActions()} />);
    openMenu("n1");
    fireEvent.click(menuItem("Move note to trash"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.notes.get("n1")).not.toMatch(/^trashed: /m);
    expect(screen.queryByText("Move to Trash?")).toBeNull();
  });
});

describe("a refused lifecycle action", () => {
  it("states the failure instead of doing nothing", async () => {
    h.refuseWrite = true;
    render(<BoardView def={boardDef()} result={result()} cardActions={cardActions()} />);
    openMenu("n1");
    fireEvent.click(menuItem("Archive note"));

    const line = await screen.findByTestId("view.board-action-error");
    expect(line.textContent).toBe("The note could not be archived.");
    // The note is byte-for-byte what it was, and the card is still there because
    // the note still is.
    expect(h.notes.get("n1")).toBe(NOTE("Doing", "Draft the guide"));
    expect(renderedNoteIds()).toEqual(["n1", "n2"]);
  });
});
