// @vitest-environment jsdom
//
// Component tests for `src/components/settings/RibbonCustomizeSettings.tsx`
// (myne-md/myne#699). Covers the pr-review findings: roster rows are
// keyboard-focusable with a position label and answer the rail's Alt+Arrow
// reorder contract, and the add-picker closes on Escape returning focus to
// the Add button. The prefs setters are mocked at the lib boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const prefsRead = vi.fn();
const setRibbonItems = vi.fn();
const setRibbonVisible = vi.fn();

vi.mock("../../../src/lib/prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/prefs")>()),
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  setRibbonItems: (...a: unknown[]) => setRibbonItems(...a),
  setRibbonVisible: (...a: unknown[]) => setRibbonVisible(...a),
}));

import { RibbonCustomizeSettings } from "../../../src/components/settings/RibbonCustomizeSettings";
import { ribbonEligibleIds } from "../../../src/notes/ribbonItems";

const [ID_A, ID_B] = ribbonEligibleIds();

async function renderWithRail(items: string[]) {
  prefsRead.mockResolvedValue({ ribbon_items: items, ribbon_visible: true });
  render(<RibbonCustomizeSettings />);
  await waitFor(() => expect(prefsRead).toHaveBeenCalled());
  return screen.getAllByTestId("settings.ribbon-customize.row");
}

beforeEach(() => {
  prefsRead.mockReset();
  setRibbonItems.mockReset().mockResolvedValue(undefined);
  setRibbonVisible.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("RibbonCustomizeSettings roster keyboard contract", () => {
  it("rows are focusable listitems labelled with their position", async () => {
    const rows = await renderWithRail([ID_A, ID_B]);
    expect(rows).toHaveLength(2);
    for (const [i, row] of rows.entries()) {
      expect(row.getAttribute("tabindex")).toBe("0");
      expect(row.getAttribute("role")).toBe("listitem");
      expect(row.getAttribute("aria-label")).toContain(`${i + 1} of 2`);
    }
  });

  it("Alt+ArrowDown reorders the row, plain arrows do nothing", async () => {
    const rows = await renderWithRail([ID_A, ID_B]);
    await act(async () => {
      fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    });
    expect(setRibbonItems).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(rows[0]!, { key: "ArrowDown", altKey: true });
    });
    expect(setRibbonItems).toHaveBeenCalledTimes(1);
    expect(setRibbonItems).toHaveBeenCalledWith([ID_B, ID_A]);
  });

  it("Escape closes the add-picker and returns focus to the Add button", async () => {
    await renderWithRail([ID_A]);
    const add = screen.getByTestId("settings.ribbon-customize.add");
    fireEvent.click(add);
    expect(
      screen.getByTestId("settings.ribbon-customize.picker"),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    expect(
      screen.queryByTestId("settings.ribbon-customize.picker"),
    ).toBeNull();
    expect(document.activeElement).toBe(add);
  });
});
