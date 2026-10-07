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

import { Tooltip } from "../../src/components/primitives/Tooltip";
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

  it("takes the width the header leaves it, rather than hugging its label", () => {
    // The row is inside a `<Tooltip>`, whose wrapper is a real element between
    // the header's flex container and the button — so `ROW_STYLE`'s `flex: 1`
    // landed on a CHILD of the flex item and the free space never reached it.
    // The control sat at about a third of its width with the three create
    // buttons floating a long way to its right, and nothing reported it: the
    // tooltip worked, the button worked, and the layout was silently wrong.
    render(<SidebarSearchRow />);
    const button = screen.getByTestId("notes.sidebar-search");
    // The trigger still asks to grow.
    expect(button.style.flexGrow, "the trigger stopped growing").toBe("1");
    // And the wrapper between it and the header passes the ask through, which
    // is the half that was missing. Asserted on the PARENT, because that is
    // the element the header's flex algorithm actually sizes.
    const wrapper = button.parentElement;
    expect(wrapper, "no tooltip wrapper").not.toBeNull();
    expect(wrapper!.style.flexGrow, "the tooltip wrapper hugs its child").toBe("1");
    // `inline-flex` would size to content whatever the grow says.
    expect(wrapper!.style.display, "the wrapper is still inline").toBe("flex");
    // And it may shrink below its content, or a long label floors the row.
    expect(wrapper!.style.minWidth).toBe("0px");
  });

  it("does NOT stretch a tooltip that was not asked to", () => {
    // The default has to stay: every other call site wraps something that
    // should size to its content, and a wrapper that always grew would
    // stretch icon buttons across their toolbars.
    render(
      <Tooltip label="plain">
        <button type="button" data-testid="plain-trigger">x</button>
      </Tooltip>,
    );
    const wrapper = screen.getByTestId("plain-trigger").parentElement!;
    expect(wrapper.style.display).toBe("inline-flex");
    expect(wrapper.style.flexGrow).toBe("");
  });
});
