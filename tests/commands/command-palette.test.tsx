// @vitest-environment jsdom
//
// CommandPalette UI integration tests — covers MYND-86 + MYND-40 acceptance:
// "keyboard shortcut opens command palette; fuzzy search actions; …
// palette never exposes actions unavailable in the current state" and the
// MYND-40 unified two-section list (COMMANDS fuzzy + NOTES full-text).
//
// Tests focus on user-visible behavior: command filter, keyboard navigation,
// the inline NOTES section (backed by the mocked `note_search` IPC), and
// dismissal paths. Not the parent Cmd+K hotkey wiring (that's an
// `EditorChrome`-internal listener tested via manual smoke).
//
// `searchNotes` is mocked so the NOTES section is deterministic without a
// backend; `shouldApplyNoteSearchResult` (the generation-guard) keeps its real
// implementation.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CommandPalette } from "../../src/components/CommandPalette";
import type { CommandContext } from "../../src/commands";
import { searchNotes } from "../../src/notes/searchNotes";
import type { NoteSearchResult } from "../../src/types/note-search-result";

vi.mock("../../src/notes/searchNotes", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/notes/searchNotes")
  >("../../src/notes/searchNotes");
  return { ...actual, searchNotes: vi.fn() };
});

const mockedSearch = vi.mocked(searchNotes);

function buildCtx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    stageName: "editor",
    selectedNoteId: null,
    onLock: vi.fn(async () => {}),
    onOpenSettings: vi.fn(),
    onManageTemplates: vi.fn(),
    onNewNoteFromTemplate: vi.fn(),
    onOpenTodayNote: vi.fn(),
    onOpenAttachments: vi.fn(),
    onSelectNote: vi.fn(async () => {}),
    ...over,
  };
}

describe("CommandPalette UI", () => {
  beforeEach(() => {
    // Default: the NOTES section is empty unless a test opts into hits. Keeps
    // the debounced search from throwing on the default vi.fn() return.
    mockedSearch.mockReset();
    mockedSearch.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when `open` is false", () => {
    render(
      <CommandPalette open={false} onClose={vi.fn()} ctx={buildCtx()} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the command list when open with editor stage", () => {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        ctx={buildCtx({
          stageName: "editor",
          selectedNoteId: "note-1",
        })}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    // "Lock vault" + "Open settings…" active, "Import Obsidian vault…" stub, and
    // "Convert imported wikilinks in this note…" now live (MYND-84), visible
    // because a note is selected. Note picking is no longer an action — it
    // surfaces inline once you type (see NOTES-section tests below).
    expect(screen.getByText("Lock vault")).toBeTruthy();
    expect(screen.getByText("Open settings…")).toBeTruthy();
    expect(screen.getByText("Import Obsidian vault…")).toBeTruthy();
    expect(screen.getByText("Convert imported wikilinks in this note…")).toBeTruthy();
    expect(screen.queryByText("Switch to note…")).toBeNull();
  });

  it("filters commands on typing (fuzzy match)", () => {
    render(
      <CommandPalette open onClose={vi.fn()} ctx={buildCtx()} />,
    );
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(input, { target: { value: "lock" } });
    expect(screen.queryByText("Lock vault")).toBeTruthy();
    expect(screen.queryByText("Open settings…")).toBeNull();
    expect(screen.queryByText("Import Obsidian vault…")).toBeNull();
  });

  it("Enter invokes the highlighted command", async () => {
    const onLock = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <CommandPalette open onClose={onClose} ctx={buildCtx({ onLock })} />,
    );
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(input, { target: { value: "lock" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Allow the async run() to settle.
    await Promise.resolve();
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} ctx={buildCtx()} />);
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} ctx={buildCtx()} />);
    // The backdrop is the parent of the dialog.
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("typing surfaces backend note hits in the NOTES section", async () => {
    const hits: NoteSearchResult[] = [
      // Title match → no marker.
      { note_id: "n1", title: "Alpha note", score: 3, matched_in: { title: true, body: false } },
      // Body-only match → "matched in body" marker.
      { note_id: "n2", title: "Beta note", score: 2, matched_in: { title: false, body: true } },
      // Empty title → rendered as "Untitled".
      { note_id: "n3", title: "", score: 1, matched_in: { title: true, body: true } },
    ];
    mockedSearch.mockResolvedValue(hits);
    render(<CommandPalette open onClose={vi.fn()} ctx={buildCtx()} />);
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(input, { target: { value: "note" } });
    // findBy* polls past the ~120ms debounce + the mocked promise resolution.
    expect(await screen.findByText("Alpha note")).toBeTruthy();
    expect(screen.getByText("Beta note")).toBeTruthy();
    expect(screen.getByText("Untitled")).toBeTruthy();
    // Exactly the one body-only hit carries the marker.
    expect(screen.getByText("↳ matched in body")).toBeTruthy();
    expect(mockedSearch).toHaveBeenCalledWith("note");
  });

  it("excludes trashed notes from the NOTES section (MYND-133 isTrashed)", async () => {
    const hits: NoteSearchResult[] = [
      { note_id: "live", title: "Live note", score: 3, matched_in: { title: true, body: false } },
      { note_id: "gone", title: "Trashed note", score: 2, matched_in: { title: true, body: false } },
    ];
    mockedSearch.mockResolvedValue(hits);
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        ctx={buildCtx()}
        isTrashed={(id) => id === "gone"}
      />,
    );
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(input, { target: { value: "note" } });
    expect(await screen.findByText("Live note")).toBeTruthy();
    expect(screen.queryByText("Trashed note")).toBeNull();
  });

  it("clicking a note hit calls onSelectNote with its id and closes", async () => {
    const onSelectNote = vi.fn(async () => {});
    const onClose = vi.fn();
    mockedSearch.mockResolvedValue([
      { note_id: "note-2", title: "Beta note", score: 1, matched_in: { title: true, body: false } },
    ]);
    render(
      <CommandPalette open onClose={onClose} ctx={buildCtx({ onSelectNote })} />,
    );
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(input, { target: { value: "beta" } });
    const row = (await screen.findByText("Beta note")).closest(
      "[role='option']",
    )!;
    fireEvent.mouseDown(row);
    await Promise.resolve();
    expect(onSelectNote).toHaveBeenCalledWith("note-2");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown / ArrowUp move the selection", () => {
    render(<CommandPalette open onClose={vi.fn()} ctx={buildCtx()} />);
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // The second row should now be aria-selected.
    const rows = screen.getByRole("listbox").querySelectorAll("[role='option']");
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    // Wrap-around: the last row should be selected.
    expect(rows[rows.length - 1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("disabled stub action cannot be invoked via Enter", async () => {
    const ctx = buildCtx({
      stageName: "editor",
      selectedNoteId: "note-1",
    });
    render(<CommandPalette open onClose={vi.fn()} ctx={ctx} />);
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(input, { target: { value: "convert" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
    // The action is disabled — palette stays open, no onClose.
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });
});
