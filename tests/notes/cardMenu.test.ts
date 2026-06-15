// Unit tests for the card context-menu item set (Saved Views #5, MYND-275,
// task 8). The set is CLOSED and non-mutating — a saved view is a read-only
// projection, so the menu must never carry a delete / move / trash / rename
// verb. Deletion stays at the note's own location (the sidebar).

import { describe, expect, it, vi } from "vitest";
import {
  CARD_MENU_ITEM_IDS,
  buildCardMenuItems,
} from "../../src/notes/views/cardMenu";

const noopHandlers = () => ({
  open: vi.fn(),
  openInNewTab: vi.fn(),
  revealInFolder: vi.fn(),
  copyLink: vi.fn(),
});

describe("buildCardMenuItems", () => {
  it("surfaces exactly Open / Open in new tab / Reveal in folder / Copy link", () => {
    const items = buildCardMenuItems(noopHandlers());
    expect(items.map((i) => i.id)).toEqual([
      "open",
      "open-in-new-tab",
      "reveal-in-folder",
      "copy-link",
    ]);
    expect(items.map((i) => i.label)).toEqual([
      "Open",
      "Open in new tab",
      "Reveal in folder",
      "Copy link",
    ]);
  });

  it("contains NO mutating verb (closed item set)", () => {
    const ids = buildCardMenuItems(noopHandlers()).map((i) => i.id);
    for (const banned of ["delete", "move", "trash", "rename"]) {
      expect(ids).not.toContain(banned);
    }
    // No item is marked destructive.
    expect(
      buildCardMenuItems(noopHandlers()).some((i) => i.destructive),
    ).toBe(false);
    // The exported allow-list matches the built ids.
    expect(ids).toEqual([...CARD_MENU_ITEM_IDS]);
  });

  it("wires each item to its handler", () => {
    const h = noopHandlers();
    const items = buildCardMenuItems(h);
    items.find((i) => i.id === "open")!.onSelect();
    items.find((i) => i.id === "open-in-new-tab")!.onSelect();
    items.find((i) => i.id === "reveal-in-folder")!.onSelect();
    items.find((i) => i.id === "copy-link")!.onSelect();
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.openInNewTab).toHaveBeenCalledOnce();
    expect(h.revealInFolder).toHaveBeenCalledOnce();
    expect(h.copyLink).toHaveBeenCalledOnce();
  });
});
