// @vitest-environment jsdom
//
// HotkeysPanel (MYND-304; hotkeys-panel-view + rebind-flow). Pins the read-only
// listing (grouping, override ?? default, []→Not set, fixed-marking, search) AND
// the interactive rebind (capture→validate→conflict-warn→persist, remove, reset,
// reset-all). usePrefs is mocked at the hook seam.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

let keymap: Record<string, string[]> = {};
const setKeymapBinding = vi.fn();
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { keymap }, setKeymapBinding, reload: vi.fn() }),
}));

import { HotkeysPanel } from "../../src/components/settings/HotkeysPanel";

beforeEach(() => {
  keymap = {};
  setKeymapBinding.mockReset();
  cleanup();
});

function rowFor(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="hotkeys.row"][data-command-id="${id}"]`);
}
function within(id: string, testid: string): HTMLElement | null {
  return rowFor(id)!.querySelector(`[data-testid="${testid}"]`);
}

describe("HotkeysPanel — listing", () => {
  it("renders the default binding glyph (non-mac jsdom → Ctrl+…)", () => {
    render(<HotkeysPanel />);
    expect(rowFor("graph.show")!.textContent).toContain("Ctrl+Shift+G");
  });

  it("shows override over default; []-override → Not set; CM rows fixed", () => {
    keymap = { "graph.show": ["Mod-g"], "note.new-tab": [] };
    render(<HotkeysPanel />);
    expect(rowFor("graph.show")!.textContent).toContain("Ctrl+G");
    expect(within("note.new-tab", "hotkeys.binding-empty")).not.toBeNull();
    expect(rowFor("editor.bold")!.getAttribute("data-rebindable")).toBe("false");
  });

  it("fuzzy-filters by query", () => {
    render(<HotkeysPanel />);
    fireEvent.change(screen.getByTestId("hotkeys.search"), { target: { value: "split" } });
    expect(rowFor("pane.split-row")).not.toBeNull();
    expect(rowFor("graph.show")).toBeNull();
  });
});

describe("HotkeysPanel — interactive rebind", () => {
  it("captures a valid chord and persists it (appended)", () => {
    keymap = {};
    render(<HotkeysPanel />);
    fireEvent.click(within("graph.show", "hotkeys.add-binding")!);
    const input = within("graph.show", "hotkeys.capture-input")!;
    // jsdom is non-mac → the accelerator is ctrlKey (→ canonical "Mod").
    fireEvent.keyDown(input, { key: "j", ctrlKey: true });
    // graph.show default is Mod-Shift-g; appended → [default, Mod-j].
    expect(setKeymapBinding).toHaveBeenCalledWith("graph.show", ["Mod-Shift-g", "Mod-j"]);
  });

  it("rejects a bare key (no modifier) — does not persist, shows reason", () => {
    render(<HotkeysPanel />);
    fireEvent.click(within("note.new-tab", "hotkeys.add-binding")!);
    fireEvent.keyDown(within("note.new-tab", "hotkeys.capture-input")!, { key: "a" });
    expect(setKeymapBinding).not.toHaveBeenCalled();
    expect(screen.getByTestId("hotkeys.warning")).toBeTruthy();
  });

  it("warns on a conflicting chord but assigns anyway (warn-only)", () => {
    // app.open-settings default = Mod-, ; bind note.new-tab to Mod-, too.
    render(<HotkeysPanel />);
    fireEvent.click(within("note.new-tab", "hotkeys.add-binding")!);
    // ctrlKey (non-mac accelerator) → "Mod-," — collides with app.open-settings default.
    fireEvent.keyDown(within("note.new-tab", "hotkeys.capture-input")!, { key: ",", ctrlKey: true });
    expect(screen.getByTestId("hotkeys.warning").textContent).toContain("Open settings");
    expect(setKeymapBinding).toHaveBeenCalledWith("note.new-tab", ["Mod-t", "Mod-,"]);
  });

  it("removes a binding (→ explicit-unbind [] when last)", () => {
    keymap = { "note.new-tab": ["Mod-t"] };
    render(<HotkeysPanel />);
    fireEvent.click(within("note.new-tab", "hotkeys.remove-binding")!);
    expect(setKeymapBinding).toHaveBeenCalledWith("note.new-tab", []);
  });

  it("restores a command default (null) when overridden", () => {
    keymap = { "graph.show": ["Mod-g"] };
    render(<HotkeysPanel />);
    fireEvent.click(within("graph.show", "hotkeys.reset")!);
    expect(setKeymapBinding).toHaveBeenCalledWith("graph.show", null);
  });

  it("shows a persistent conflict indicator on commands sharing a chord", () => {
    // Bind note.new-tab onto app.open-settings' default chord (Mod-,) → both conflict.
    keymap = { "note.new-tab": ["Mod-,"] };
    render(<HotkeysPanel />);
    expect(within("note.new-tab", "hotkeys.conflict-indicator")).not.toBeNull();
    expect(within("app.open-settings", "hotkeys.conflict-indicator")).not.toBeNull();
    // A non-conflicting command has no indicator.
    expect(within("graph.show", "hotkeys.conflict-indicator")).toBeNull();
  });

  it("reset-all (after confirm) clears every override to default", () => {
    keymap = { "graph.show": ["Mod-g"], "note.new-tab": ["Mod-x"] };
    render(<HotkeysPanel />);
    fireEvent.click(screen.getByTestId("hotkeys.reset-all"));
    fireEvent.click(screen.getByTestId("hotkeys.reset-all-yes"));
    expect(setKeymapBinding).toHaveBeenCalledWith("graph.show", null);
    expect(setKeymapBinding).toHaveBeenCalledWith("note.new-tab", null);
  });
});
