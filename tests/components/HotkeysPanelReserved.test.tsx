// @vitest-environment jsdom
//
// HotkeysPanel × host-reserved chords (phase3-web-client task 66).
//
// A separate file from `HotkeysPanel.test.tsx` because it needs the WEB seam
// mounted under the panel, and that file's whole point is the desktop
// behaviour — which this change must leave untouched. Both run.
//
// The seam is faked rather than importing `web/src/platform/keyboard` so the
// assertions are about the PANEL's rules (refuse hard, warn-and-allow
// unreliable, never rewrite storage) and not about which chords a browser
// happens to take; the table itself is asserted in
// `tests/web/reserved-chords.test.ts`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

let keymap: Record<string, string[]> = {};
const setKeymapBinding = vi.fn();
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { keymap }, setKeymapBinding, reload: vi.fn() }),
}));

vi.mock("../../src/platform/keyboard", () => ({
  reservedChord: (chord: string) =>
    chord === "Mod-w"
      ? { chord, tier: "hard", browsers: ["chromium", "firefox", "safari"], actionKey: "closeTab" }
      : chord === "Mod-o"
        ? { chord, tier: "unreliable", browsers: ["chromium"], actionKey: "openFile" }
        : null,
  allReservedChords: () => [],
}));

const { HotkeysPanel } = await import("../../src/components/settings/HotkeysPanel");

beforeEach(() => {
  keymap = {};
  setKeymapBinding.mockReset();
  cleanup();
});

function rowFor(id: string): HTMLElement {
  return document.querySelector(
    `[data-testid="hotkeys.row"][data-command-id="${id}"]`,
  ) as HTMLElement;
}
function within(id: string, testid: string): HTMLElement | null {
  return rowFor(id).querySelector(`[data-testid="${testid}"]`);
}

describe("binding a chord the host reserves", () => {
  it("refuses a HARD reservation and explains what the browser does with it", () => {
    render(<HotkeysPanel />);
    fireEvent.click(within("graph.show", "hotkeys.add-binding")!);
    // jsdom is non-mac, so the accelerator is ctrlKey → canonical `Mod-w`.
    fireEvent.keyDown(within("graph.show", "hotkeys.capture-input")!, {
      key: "w",
      ctrlKey: true,
    });
    expect(setKeymapBinding).not.toHaveBeenCalled();
    const warning = document.querySelector('[data-testid="hotkeys.warning"]')!;
    expect(warning.textContent).toContain("closes the tab");
  });

  it("ALLOWS an unreliable one, with a warning rather than a refusal", () => {
    // It does reach Myne in some browsers. Refusing would take away a shortcut
    // that works on the machine the user is sitting at.
    render(<HotkeysPanel />);
    fireEvent.click(within("graph.show", "hotkeys.add-binding")!);
    fireEvent.keyDown(within("graph.show", "hotkeys.capture-input")!, {
      key: "o",
      ctrlKey: true,
    });
    expect(setKeymapBinding).toHaveBeenCalledWith("graph.show", ["Mod-Shift-g", "Mod-o"]);
    expect(document.querySelector('[data-testid="hotkeys.warning"]')!.textContent).toContain(
      "opens a file",
    );
  });

  it("still binds a chord the host does not want", () => {
    render(<HotkeysPanel />);
    fireEvent.click(within("graph.show", "hotkeys.add-binding")!);
    fireEvent.keyDown(within("graph.show", "hotkeys.capture-input")!, {
      key: "j",
      ctrlKey: true,
    });
    expect(setKeymapBinding).toHaveBeenCalledWith("graph.show", ["Mod-Shift-g", "Mod-j"]);
  });
});

describe("a stored binding the host reserves", () => {
  it("is surfaced as unavailable rather than left silently dead", () => {
    keymap = { "graph.show": ["Mod-w"] };
    render(<HotkeysPanel />);
    const chip = within("graph.show", "hotkeys.binding-reserved")!;
    expect(chip).not.toBeNull();
    expect(chip.getAttribute("data-reserved-tier")).toBe("hard");
    expect(chip.getAttribute("title")).toContain("closes the tab");
  });

  it("is NOT rewritten — the keymap syncs, and it works on the user's desktop", () => {
    // The load-bearing one. `vault.prefs` carries the keymap between clients, so
    // a web session that "fixed" this binding would reach across and break
    // desktop. Rendering the panel must therefore write nothing at all.
    keymap = { "graph.show": ["Mod-w"], "note.new-tab": ["Mod-t"] };
    render(<HotkeysPanel />);
    expect(setKeymapBinding).not.toHaveBeenCalled();
    expect(rowFor("graph.show").textContent).toContain("Ctrl+W");
  });

  it("leaves every other binding unmarked", () => {
    keymap = { "graph.show": ["Mod-j"] };
    render(<HotkeysPanel />);
    expect(within("graph.show", "hotkeys.binding-reserved")).toBeNull();
  });
});
