// @vitest-environment jsdom
//
// The bottom-bar customization list (myne-md/myne#773).
//
// The reason it is tested rather than eyeballed is the thing that was wrong
// with it: it and the LEFT-RIBBON list answer the same question about two
// strips of the same app, and they had drifted into two different answers —
// the ribbon a drag-reorderable roster of icon rows, this one a flat column of
// switches. Nothing about either strip justified the difference, and nothing in
// the tree noticed, because both were internally consistent.
//
// So the assertions below are mostly PARITY assertions, deliberately: they hold
// this list to the affordances its twin has, which is the property that
// regressed and the one a future edit to either file could lose again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const prefsRead = vi.fn();
const setHiddenBarItems = vi.fn();
const setBarItemsOrder = vi.fn();

vi.mock("../../../src/lib/prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/prefs")>()),
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  setHiddenBarItems: (...a: unknown[]) => setHiddenBarItems(...a),
  setBarItemsOrder: (...a: unknown[]) => setBarItemsOrder(...a),
}));

import { BarCustomizeSettings } from "../../../src/components/settings/BarCustomizeSettings";
import {
  BAR_ITEMS,
  RIGHT_CLUSTER_DEFAULT_ORDER,
} from "../../../src/notes/barItemsOrder";

async function renderBar(
  prefs: { hidden_bar_items?: string[]; bar_items_order?: string[] } = {},
) {
  prefsRead.mockResolvedValue({
    hidden_bar_items: prefs.hidden_bar_items ?? [],
    bar_items_order: prefs.bar_items_order ?? [],
  });
  render(<BarCustomizeSettings />);
  await waitFor(() => expect(prefsRead).toHaveBeenCalled());
  return screen.getAllByTestId(/^settings\.bar-item\./);
}

beforeEach(() => {
  prefsRead.mockReset();
  setHiddenBarItems.mockReset().mockResolvedValue(undefined);
  setBarItemsOrder.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("it is the same list as the ribbon's, not a list that resembles it", () => {
  it("every row is draggable, focusable and position-labelled", async () => {
    const rows = await renderBar();
    expect(rows).toHaveLength(BAR_ITEMS.length);
    for (const [i, row] of rows.entries()) {
      expect(row.getAttribute("draggable"), "a row with no drag is not a roster").toBe(
        "true",
      );
      expect(row.getAttribute("tabindex")).toBe("0");
      expect(row.getAttribute("role")).toBe("listitem");
      expect(row.getAttribute("aria-label")).toContain(`${i + 1} of ${rows.length}`);
    }
  });

  it("every row carries a glyph", async () => {
    // The ribbon's rows have had one since it shipped, and it is most of why
    // the two lists did not read as the same idea. Nine names in a column is
    // a wall of text; nine names with glyphs is a list you can find a row in.
    const rows = await renderBar();
    for (const row of rows) {
      expect(row.querySelector("svg"), `${row.dataset.itemId} has no icon`).not.toBeNull();
    }
  });

  it("answers the rail's Alt+Arrow reorder contract", async () => {
    // A pointer-only reorder is a reorder some users cannot perform. The
    // ribbon has had this fallback; before this change there was nothing here
    // to fall back FROM.
    const rows = await renderBar();
    await act(async () => {
      fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    });
    expect(setBarItemsOrder, "a plain arrow must not reorder").not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(rows[0]!, { key: "ArrowDown", altKey: true });
    });
    expect(setBarItemsOrder).toHaveBeenCalledTimes(1);
    const [first, second] = RIGHT_CLUSTER_DEFAULT_ORDER;
    expect(setBarItemsOrder.mock.calls[0]![0]!.slice(0, 2)).toEqual([second, first]);
  });
});

describe("it still does the job it was added for", () => {
  it("toggles an item's visibility through the switch", async () => {
    // The block exists because the bar's own right-click menu is the ONLY other
    // place visibility can be changed, and it vanishes with the bar once the
    // last item is hidden. A control that can be turned off and not back on is
    // a bug, so this switch is a precondition of the bar being allowed to
    // disappear at all — not a convenience beside it.
    await renderBar();
    const toggle = screen.getByTestId("settings.bar-item-toggle.lock");
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(setHiddenBarItems).toHaveBeenCalledWith(["lock"]);
  });

  it("shows a hidden item as off", async () => {
    await renderBar({ hidden_bar_items: ["tags"] });
    expect(
      screen.getByTestId("settings.bar-item-toggle.tags").getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen.getByTestId("settings.bar-item-toggle.lock").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("lists items in the bar's DISPLAY order, not the roster's menu order", async () => {
    // The two are different sequences of the same nine ids, and rendering the
    // wrong one would mean a reordered bar and the surface that reorders it
    // disagreeing about where an item is. `BAR_ITEMS` puts view-mode second;
    // the bar draws workspace there.
    const rows = await renderBar();
    expect(rows.map((r) => r.dataset.itemId)).toEqual([...RIGHT_CLUSTER_DEFAULT_ORDER]);
    expect(
      BAR_ITEMS.map((i) => i.id),
      "the two orders must actually differ, or this test asserts nothing",
    ).not.toEqual([...RIGHT_CLUSTER_DEFAULT_ORDER]);
  });

  it("honours a stored order", async () => {
    const stored = ["lock", "tags"];
    const rows = await renderBar({ bar_items_order: stored });
    expect(rows.slice(0, 2).map((r) => r.dataset.itemId)).toEqual(stored);
  });
});
