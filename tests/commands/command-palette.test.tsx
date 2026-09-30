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
import { runAxe, formatViolations } from "../a11y/axe-config";

vi.mock("../../src/notes/searchNotes", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/notes/searchNotes")
  >("../../src/notes/searchNotes");
  return { ...actual, searchNotes: vi.fn() };
});

// The palette reads the Saved Views run-context for operator queries
// (MYND-303/307). These tests render the palette without its provider tree and
// exercise only plain (operator-free) queries, so a minimal stub that never
// throws is sufficient — the operator path is covered by the parser/ranker unit
// tests and the E2E scenario.
vi.mock("../../src/notes/views/useRunViewContext", () => {
  // A STABLE singleton — production `useRunViewContext` is memoized, so the
  // palette's `operatorDeps`/`runNoteSearch` identities are stable across
  // renders. A stub that returned a fresh object each call would churn those
  // identities and spin the debounced-search effect into a render loop.
  const ctx = {
    liveIds: new Set<string>(),
    resolvers: {
      hasTag: async () => [],
      inFolder: async () => [],
      search: async () => [],
      titleMatch: async () => [],
      hasTask: async () => [],
      propertyValues: async () => [],
    },
    rowFor: () => ({ title: null, folder: null }),
    recencyFallback: (ids: string[]) => ids,
  };
  return { useRunViewContext: () => ctx };
});

const mockedSearch = vi.mocked(searchNotes);

// The palette's ribbon pin toggle writes through `src/lib/prefs`. Mocked at
// the lib boundary so the tests assert the call rather than the IPC.
const setRibbonItems = vi.fn();
vi.mock("../../src/lib/prefs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/prefs")>();
  return { ...actual, setRibbonItems: (...a: unknown[]) => setRibbonItems(...a) };
});

function buildCtx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    stageName: "editor",
    selectedNoteId: null,
    // Visibility predicates may read ctx.prefs (e.g. note.archive's
    // archive_disabled gate) — an empty stub means "all defaults".
    prefs: {} as CommandContext["prefs"],
    onLock: vi.fn(async () => {}),
    onOpenSettings: vi.fn(),
    onManageTemplates: vi.fn(),
    onNewNoteFromTemplate: vi.fn(),
    onOpenTodayNote: vi.fn(),
    onOpenRandomNote: vi.fn(),
    onOpenAttachments: vi.fn(),
    onToggleStackedTabs: vi.fn(),
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
    setRibbonItems.mockReset().mockResolvedValue(undefined);
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
    // Source-agnostic since MYND-586: one import flow serves Obsidian, Notion,
    // Evernote, HTML and CSV, so the command can no longer name a single source.
    expect(screen.getByText("Import notes…")).toBeTruthy();
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

  it("names its results listbox (myne#728)", () => {
    // A listbox with no name announces as "list box" and nothing else, and the
    // dialog's own name does not carry down to it. The results are commands
    // AND notes, so the name says both.
    render(<CommandPalette open onClose={vi.fn()} ctx={buildCtx()} />);
    expect(screen.getByRole("listbox", { name: "Commands and notes" })).toBeTruthy();
  });

  it("is a combobox whose active descendant tracks the highlight (myne#728)", () => {
    // The input keeps focus while the arrows move a highlight inside the list,
    // so `aria-activedescendant` is the only thing that conveys the move. The
    // assertion is the PROPERTY: the id the input names must be the row that
    // is visually selected, not merely "an attribute is present".
    render(<CommandPalette open onClose={vi.fn()} ctx={buildCtx()} />);
    const input = screen.getByRole("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);

    const selectedId = (): string | null => input.getAttribute("aria-activedescendant");
    const highlighted = (): HTMLElement | undefined =>
      screen
        .getAllByRole("option")
        .find((el) => el.getAttribute("aria-selected") === "true");

    expect(document.getElementById(selectedId() ?? "")).toBe(highlighted());
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.getElementById(selectedId() ?? "")).toBe(highlighted());
  });

  it("claims no popup when the query matches nothing (myne#728)", () => {
    render(<CommandPalette open onClose={vi.fn()} ctx={buildCtx()} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "zzzzqqqq" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
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

  // The operator strip and the results are ONE list to the arrow keys. With a
  // single suggestion ("s" offers only "section:") the arrows used to cycle
  // that one row forever, and no result was reachable from the keyboard.
  it("arrows leave a one-row suggestion strip for the results and come back", () => {
    render(<CommandPalette open onClose={vi.fn()} ctx={buildCtx()} />);
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(input, { target: { value: "s" } });
    const strip = screen.getAllByTestId("palette.operator-suggestion");
    expect(strip.length).toBeGreaterThan(0);
    const selected = () =>
      Array.from(screen.getByRole("listbox").querySelectorAll("[role='option']")).findIndex(
        (r) => r.getAttribute("aria-selected") === "true",
      );
    // On open the strip is active and no result claims the highlight.
    expect(strip[0]!.getAttribute("data-active")).toBe("true");
    expect(selected()).toBe(-1);
    for (let i = 0; i < strip.length; i += 1) fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toBe(0);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toBe(1);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selected()).toBe(-1);
    expect(
      screen.getAllByTestId("palette.operator-suggestion").some((r) => r.getAttribute("data-active") === "true"),
    ).toBe(true);
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

  // Ribbon pin toggle (myne-md/myne#699): the pin button is mouse-first
  // (onMouseDown, pre-blur) but must also answer keyboard activation, which
  // arrives as a click with detail 0. A real mouse click (detail 1) must NOT
  // toggle twice.
  function renderPaletteWithEmptyRail() {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        ctx={buildCtx({
          stageName: "editor",
          selectedNoteId: "note-1",
          prefs: { ribbon_items: [] as string[] } as CommandContext["prefs"],
        })}
      />,
    );
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(input, { target: { value: "lock" } });
    const pins = screen.getAllByTestId("palette.pin");
    const pin = pins.find(
      (el) => el.getAttribute("data-command-id") === "vault.lock",
    )!;
    expect(pin).toBeTruthy();
    return pin;
  }

  it("pins the command on mousedown", () => {
    const pin = renderPaletteWithEmptyRail();
    fireEvent.mouseDown(pin);
    expect(setRibbonItems).toHaveBeenCalledTimes(1);
    expect(setRibbonItems).toHaveBeenCalledWith(["vault.lock"]);
  });

  it("does not toggle twice on the click that follows a mousedown", () => {
    const pin = renderPaletteWithEmptyRail();
    fireEvent.mouseDown(pin);
    expect(setRibbonItems).toHaveBeenCalledTimes(1);
    fireEvent.click(pin, { detail: 1 });
    expect(setRibbonItems).toHaveBeenCalledTimes(1);
  });

  it("nests no interactive control inside a role=option (myne#728)", async () => {
    // The jsdom half of the finding the real-render gate made. Nothing here
    // rendered the palette through axe before, which is why a
    // `nested-interactive` on 19 nodes survived every push and surfaced only
    // when the E2E baseline was deleted. A structural rule plus axe, so the
    // next control added to a row fails in a second rather than at a release.
    render(<CommandPalette open onClose={vi.fn()} ctx={buildCtx()} />);
    const nested = document.querySelectorAll(
      '[role="option"] button, [role="option"] a, [role="option"] input, [role="option"] [tabindex]:not([tabindex="-1"])',
    );
    expect(nested, "a listbox option is children-presentational").toHaveLength(0);

    const dialog = screen.getByTestId("palette.dialog");
    const results = await runAxe(dialog);
    expect(results.violations, formatViolations(results)).toEqual([]);
  });

  it("is a MOUSE affordance, out of the accessibility tree (myne#728)", () => {
    // It used to be a `<button>` inside a `role="option"`, which is
    // `nested-interactive`: `option` is children-presentational, so a
    // focusable control inside it is invalid. The real-render axe gate
    // reported 19 nodes once task 17 deleted the baseline that had been
    // hiding the rule. There is no DOM shape that keeps a focusable control
    // inside a listbox option, so the pin became decoration and the keyboard
    // path is Settings, Appearance, Customize ribbon, which is a full
    // keyboard-operable roster of the same pins.
    const pin = renderPaletteWithEmptyRail();
    expect(pin.tagName).toBe("SPAN");
    expect(pin.getAttribute("aria-hidden")).toBe("true");
    expect(pin.getAttribute("tabindex")).toBeNull();
    // And it is still findable by a pointer user: the tooltip carries the
    // name the `aria-label` used to.
    expect(pin.getAttribute("title")).toBeTruthy();
  });

  it("a failed pin write surfaces an error instead of failing silently", async () => {
    setRibbonItems.mockRejectedValueOnce(new Error("locked"));
    const pin = renderPaletteWithEmptyRail();
    fireEvent.mouseDown(pin);
    expect(await screen.findByTestId("palette.pin-error")).toBeTruthy();
    expect(screen.getByText("Could not pin the command.")).toBeTruthy();
  });
});
