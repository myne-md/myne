// @vitest-environment jsdom
//
// The sidebar's search row (myne-md/myne#773 / A4).
//
// Two things are pinned, and the second is the one with teeth.
//
// The row replaced a `NOTES` heading that labelled a region which can only ever
// contain notes. What made that safe to delete is that the tree carries its own
// `aria-label` — so the region keeps an accessible name and only the redundant
// VISIBLE copy went.
//
// And the keycap shows the EFFECTIVE binding rather than the in-code default.
// `palette.toggle` is rebindable, so a hint read from `defaultBindings` keeps
// promising ⌘K to somebody who moved it. A wrong shortcut is worse than none,
// which is also why an unbound command renders no cap at all rather than a
// guess.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const prefsMock = vi.hoisted(() => ({ keymap: {} as Record<string, string[]> }));
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: prefsMock }),
}));

const ran: string[] = [];
vi.mock("../../src/notes/ribbonCommands", () => ({
  ribbonCommands: { run: (id: string) => ran.push(id) },
}));

import { SidebarSearchRow } from "../../src/notes/components/SidebarSearchRow";

afterEach(() => {
  cleanup();
  ran.length = 0;
  prefsMock.keymap = {};
});

describe("the sidebar search row", () => {
  it("runs the palette command, the same one the ribbon entry runs", () => {
    render(<SidebarSearchRow />);
    screen.getByTestId("notes.sidebar-search").click();
    // `palette.open`, not a second palette mechanism: the row and the rail
    // entry are one affordance expressed twice.
    expect(ran).toEqual(["palette.open"]);
  });

  /** Focus the row and return the tooltip bubble's text. */
  function tooltipText(): string {
    fireEvent.focus(screen.getByTestId("notes.sidebar-search"), { bubbles: true });
    const bubble = document.querySelector('[role="tooltip"]');
    return bubble?.textContent ?? "";
  }

  it("draws NO inline keycaps — the row stays quiet", () => {
    // The visual ask: de-boxed, and without the chord taking up the row.
    render(<SidebarSearchRow />);
    expect(screen.queryByTestId("keycaps")).toBeNull();
  });

  it("teaches the DEFAULT chord in the tooltip", () => {
    render(<SidebarSearchRow />);
    expect(tooltipText().toLowerCase()).toContain("k");
  });

  it("follows a REBOUND palette chord instead of the in-code default", () => {
    prefsMock.keymap = { "palette.toggle": ["Mod-Shift-p"] };
    render(<SidebarSearchRow />);
    const text = tooltipText().toLowerCase();
    // The override's own key, not `k`. Reading `defaultBindings` here would go
    // on showing the old chord forever, on the surface whose job is to teach it.
    expect(text).toContain("p");
    expect(text).not.toContain("⌘k");
  });

  it("shows no chord when the palette has been explicitly unbound", () => {
    // An explicit `[]` is an unbind, honoured verbatim by `effectiveChords`.
    // A guessed hint here would be a shortcut that does nothing.
    prefsMock.keymap = { "palette.toggle": [] };
    render(<SidebarSearchRow />);
    const text = tooltipText();
    expect(text.trim()).toBe("Search");
  });
});
