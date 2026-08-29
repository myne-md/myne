// @vitest-environment jsdom
//
// The editor "…" menu's SUBMENU mode, added so the four export formats collapse
// into one "Export…" row. The sidebar's `ContextMenu` grew the same affordance
// in the same change; the two are separate implementations because the menus are
// separate components (an anchored dropdown against a menu placed at a click),
// so both are asserted separately. What they share is the format LIST, which
// `noteExportMenu.test.ts` covers.
//
// The behaviours worth pinning are the same three that break first: a parent row
// must not act, a child must dismiss the whole menu, and the submenu must not
// leak into the parent's keyboard cycle in a way that skips rows.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  NoteActionsMenu,
  type NoteActionMenuItem,
} from "../../src/notes/components/NoteActionsMenu";

afterEach(cleanup);

function openMenu(items: NoteActionMenuItem[]) {
  render(<NoteActionsMenu label="More" items={items} />);
  fireEvent.click(screen.getByTestId("editor.note-actions-menu"));
}

function rowByAction(action: string): HTMLElement {
  const found = screen
    .getAllByTestId("editor.note-actions-menu-item")
    .find((el) => el.getAttribute("data-action") === action);
  if (found === undefined) throw new Error(`no menu row ${action}`);
  return found;
}

function rowActions(): string[] {
  return screen
    .getAllByTestId("editor.note-actions-menu-item")
    .map((el) => el.getAttribute("data-action") ?? "");
}

describe("NoteActionsMenu submenu", () => {
  it("marks a parent row as a popup and starts it closed", () => {
    openMenu([
      {
        kind: "action",
        action: "export",
        label: "Export…",
        onSelect: vi.fn(),
        children: [{ action: "export-html", label: "HTML", onSelect: vi.fn() }],
      },
    ]);
    const parent = rowByAction("export");
    expect(parent.getAttribute("aria-haspopup")).toBe("menu");
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    expect(rowActions()).toEqual(["export"]);
  });

  it("opens the children on hover and marks the parent expanded", () => {
    openMenu([
      {
        kind: "action",
        action: "export",
        label: "Export…",
        onSelect: vi.fn(),
        children: [
          { action: "export-markdown", label: "Markdown", onSelect: vi.fn() },
          { action: "export-html", label: "HTML", onSelect: vi.fn() },
        ],
      },
    ]);
    fireEvent.mouseEnter(rowByAction("export"));
    expect(rowActions()).toEqual(["export", "export-markdown", "export-html"]);
    expect(rowByAction("export").getAttribute("aria-expanded")).toBe("true");
  });

  it("does NOT fire the parent's own action when the parent is clicked", () => {
    const parentSelect = vi.fn();
    openMenu([
      {
        kind: "action",
        action: "export",
        label: "Export…",
        onSelect: parentSelect,
        children: [{ action: "export-html", label: "HTML", onSelect: vi.fn() }],
      },
    ]);
    fireEvent.click(rowByAction("export"));
    expect(parentSelect).not.toHaveBeenCalled();
    // ...and the menu stays open, since the children are the point.
    expect(rowActions()).toContain("export-html");
  });

  it("selecting a child runs its action and dismisses the whole menu", () => {
    const childSelect = vi.fn();
    openMenu([
      {
        kind: "action",
        action: "export",
        label: "Export…",
        onSelect: vi.fn(),
        children: [{ action: "export-html", label: "HTML", onSelect: childSelect }],
      },
    ]);
    fireEvent.mouseEnter(rowByAction("export"));
    fireEvent.click(rowByAction("export-html"));
    expect(childSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("editor.note-actions-menu-item")).toBeNull();
  });

  it("hovering a plain sibling closes the open submenu", () => {
    openMenu([
      {
        kind: "action",
        action: "export",
        label: "Export…",
        onSelect: vi.fn(),
        children: [{ action: "export-html", label: "HTML", onSelect: vi.fn() }],
      },
      { kind: "action", action: "trash", label: "Trash", onSelect: vi.fn() },
    ]);
    fireEvent.mouseEnter(rowByAction("export"));
    expect(rowActions()).toContain("export-html");
    fireEvent.mouseEnter(rowByAction("trash"));
    expect(rowActions()).not.toContain("export-html");
  });

  it("does not leave a submenu open across a close and reopen of the menu", () => {
    // A module-scope-ish leak: the submenu state must not survive its menu, or
    // reopening the "…" paints the children before the pointer went near the
    // parent row.
    openMenu([
      {
        kind: "action",
        action: "export",
        label: "Export…",
        onSelect: vi.fn(),
        children: [{ action: "export-html", label: "HTML", onSelect: vi.fn() }],
      },
    ]);
    fireEvent.mouseEnter(rowByAction("export"));
    expect(rowActions()).toContain("export-html");
    const button = screen.getByTestId("editor.note-actions-menu");
    fireEvent.click(button); // close
    fireEvent.click(button); // reopen
    expect(rowActions()).toEqual(["export"]);
  });
  it("Escape closes ONE level, and focus follows it both times", () => {
    // The menu used to close outright on the first press, which contradicted
    // the contract `ContextMenu` states for the same gesture, and it restored
    // focus on neither step. The restore is not cosmetic: the arrow-key handler
    // is an `onKeyDown` on the menu's own div, so focus landing on `<body>`
    // leaves the menu on screen and keyboard-dead.
    openMenu([
      {
        kind: "action",
        action: "export",
        label: "Export…",
        onSelect: vi.fn(),
        children: [{ action: "export-html", label: "HTML", onSelect: vi.fn() }],
      },
    ]);
    const trigger = screen.getByTestId("editor.note-actions-menu");
    fireEvent.click(rowByAction("export"));
    expect(rowActions()).toContain("export-html");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(rowActions()).toEqual(["export"]);
    expect(document.activeElement).toBe(rowByAction("export"));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("editor.note-actions-menu-item")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("a horizontal arrow leaves the submenu without closing the menu", () => {
    // Entering is ArrowDown, since the submenu renders inline and the cycle
    // walks into it in reading order. Leaving had no key at all. Both
    // directions are accepted because the submenu opens on the inline-start
    // side, which swaps under RTL.
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      openMenu([
        {
          kind: "action",
          action: "export",
          label: "Export…",
          onSelect: vi.fn(),
          children: [{ action: "export-html", label: "HTML", onSelect: vi.fn() }],
        },
      ]);
      fireEvent.click(rowByAction("export"));
      rowByAction("export-html").focus();
      fireEvent.keyDown(screen.getAllByRole("menu")[0]!, { key, bubbles: true });
      expect(rowActions(), key).toEqual(["export"]);
      expect(document.activeElement, key).toBe(rowByAction("export"));
      cleanup();
    }
  });

  it("puts no unroled element between the menu and its items", () => {
    // `aria-required-children`: every child of a `role="menu"` must carry a
    // menu role. The positioning wrapper used to render around EVERY row, so
    // one parent row's need for `position: relative` made the whole menu
    // non-conforming.
    openMenu([
      {
        kind: "action",
        action: "export",
        label: "Export…",
        onSelect: vi.fn(),
        children: [{ action: "export-html", label: "HTML", onSelect: vi.fn() }],
      },
      { kind: "action", action: "trash", label: "Trash", onSelect: vi.fn() },
    ]);
    const menu = screen.getAllByRole("menu")[0]!;
    for (const child of Array.from(menu.children)) {
      const role = child.getAttribute("role");
      expect(["menuitem", "menu", "none", "separator"], child.outerHTML.slice(0, 80))
        .toContain(role);
    }
    // A plain row is the button itself, with no wrapper at all.
    expect(rowByAction("trash").parentElement).toBe(menu);
  });

  it("hides the decorative chevron from the accessibility tree", () => {
    openMenu([
      {
        kind: "action",
        action: "export",
        label: "Export…",
        onSelect: vi.fn(),
        children: [{ action: "export-html", label: "HTML", onSelect: vi.fn() }],
      },
    ]);
    const chevron = rowByAction("export").querySelector("svg")?.closest("span");
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
  });
});
