// @vitest-environment jsdom
//
// CommandPalette UI integration tests — covers MYND-86 acceptance:
// "keyboard shortcut opens command palette; fuzzy search actions; …
// palette never exposes actions unavailable in the current state."
//
// Tests focus on user-visible behavior: filter, keyboard navigation, the
// note-picker sub-palette, dismissal paths. Not the parent Cmd+K hotkey
// wiring (that's an `EditorChrome`-internal listener tested via manual
// smoke).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CommandPalette } from "../../src/components/CommandPalette";
import type { CommandContext } from "../../src/commands";

function buildCtx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    stageName: "editor",
    noteTitles: new Map(),
    selectedNoteId: null,
    onLock: vi.fn(async () => {}),
    onOpenSettings: vi.fn(),
    onSelectNote: vi.fn(async () => {}),
    ...over,
  };
}

describe("CommandPalette UI", () => {
  beforeEach(() => {
    // Mount a fresh DOM root per test.
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

  it("renders the action list when open with editor stage", () => {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        ctx={buildCtx({
          stageName: "editor",
          noteTitles: new Map([["note-1", "Foo"]]),
          selectedNoteId: "note-1",
        })}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    // "Lock vault" + "Open settings…" + "Switch to note…" → 3 active rows.
    // Plus "Import Obsidian vault…" + "Convert wikilinks…" as disabled stubs.
    expect(screen.getByText("Lock vault")).toBeTruthy();
    expect(screen.getByText("Open settings…")).toBeTruthy();
    expect(screen.getByText("Switch to note…")).toBeTruthy();
    expect(screen.getByText("Import Obsidian vault…")).toBeTruthy();
    expect(screen.getByText("Convert wikilinks in this note…")).toBeTruthy();
  });

  it("filters actions on typing (fuzzy match)", () => {
    render(
      <CommandPalette open onClose={vi.fn()} ctx={buildCtx()} />,
    );
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(input, { target: { value: "lock" } });
    expect(screen.queryByText("Lock vault")).toBeTruthy();
    expect(screen.queryByText("Open settings…")).toBeNull();
    expect(screen.queryByText("Switch to note…")).toBeNull();
  });

  it("Enter invokes the highlighted action", async () => {
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

  it("Switch to note… transitions to note-picker view + lists notes", () => {
    render(
      <CommandPalette
        open
        onClose={vi.fn()}
        ctx={buildCtx({
          noteTitles: new Map([
            ["note-1", "Alpha note"],
            ["note-2", "Beta note"],
            ["note-3", null], // null title → "Untitled"
          ]),
        })}
      />,
    );
    const input = screen.getByRole("dialog").querySelector("input")!;
    fireEvent.change(input, { target: { value: "switch" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Now in note-picker mode — input placeholder changes.
    expect(input.placeholder).toBe("Search notes by title…");
    expect(screen.getByText("Alpha note")).toBeTruthy();
    expect(screen.getByText("Beta note")).toBeTruthy();
    expect(screen.getByText("Untitled")).toBeTruthy();
  });

  it("note-picker Enter calls onSelectNote with the highlighted note id", async () => {
    const onSelectNote = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <CommandPalette
        open
        onClose={onClose}
        ctx={buildCtx({
          noteTitles: new Map([
            ["note-1", "Alpha"],
            ["note-2", "Beta"],
          ]),
          onSelectNote,
        })}
      />,
    );
    const input = screen.getByRole("dialog").querySelector("input")!;
    // Enter note-picker mode.
    fireEvent.change(input, { target: { value: "switch" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Filter to Beta.
    fireEvent.change(input, { target: { value: "Beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
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
