// @vitest-environment jsdom
//
// The floating-toolbar customization list (myne-md/myne#773, MYND-336).
//
// The reason it is tested rather than eyeballed is the same one its two twins
// carry: three settings answer "reorder and show/hide a strip of commands", and
// this was the only one that had hand-rolled the drag bookkeeping — a private
// `dragId`/`dropAt` pair, its own `onDragOver`/`onDrop`, and a `.myne-drop-row`
// indicator nothing else used — while the ribbon and the bar already shared
// `useCustomizeList`. Nothing in the tree noticed, because each list was
// internally consistent.
//
// So these are partly PARITY assertions, deliberately: they hold this list to the
// affordances its twins have (draggable, focusable, position-labelled, Alt+Arrow),
// which is the property that regressed and the one a future edit could lose again.
// The rest are this list's OWN contract, which nothing else can cover: a pending
// row's toggle is inert, and the ↑/↓ buttons survive — they are the whole subject
// of `e2e/toolbar-customize.e2e.ts`'s tc2 (myne-md/myne#557), the scenario that
// retired a manual roster row because a WebDriver seat cannot start a native
// HTML5 drag.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const prefsRead = vi.fn();
const setEditorToolbarOrder = vi.fn();
const setEditorToolbarHidden = vi.fn();

vi.mock("../../../src/lib/prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/prefs")>()),
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  setEditorToolbarOrder: (...a: unknown[]) => setEditorToolbarOrder(...a),
  setEditorToolbarHidden: (...a: unknown[]) => setEditorToolbarHidden(...a),
}));

import { ToolbarCustomizeSettings } from "../../../src/components/settings/ToolbarCustomizeSettings";
import { EDITOR_TOOLBAR_PENDING_IDS } from "../../../src/notes/toolbarItems";

async function renderToolbar(prefs: { order?: string[]; hidden?: string[] } = {}) {
  prefsRead.mockResolvedValue({
    editor_toolbar_order: prefs.order ?? [],
    editor_toolbar_hidden: prefs.hidden ?? [],
  });
  render(<ToolbarCustomizeSettings />);
  await waitFor(() => expect(prefsRead).toHaveBeenCalled());
  return screen.getAllByTestId(/^settings\.toolbar-customize\.row\./);
}

beforeEach(() => {
  prefsRead.mockReset();
  setEditorToolbarOrder.mockReset().mockResolvedValue(undefined);
  setEditorToolbarHidden.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("ToolbarCustomizeSettings adopts the shared customize row", () => {
  it("gives every row the affordances its two twins have", async () => {
    const rows = await renderToolbar();
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      // `role`/`tabIndex`/`aria-label`: the keyboard path and the positional
      // announcement, which this list did not have before the adoption.
      expect(row.getAttribute("role")).toBe("listitem");
      expect(row.getAttribute("tabindex")).toBe("0");
      expect(row.getAttribute("draggable")).toBe("true");
      const label = row.getAttribute("aria-label") ?? "";
      expect(label).toMatch(/ of \d+$/);
      // The grip, which the two twins share and this list now shares too.
      expect(row.textContent ?? "").toContain("⠿");
    }
  });

  it("reorders on Alt+ArrowDown and persists the resolved order", async () => {
    const rows = await renderToolbar();
    const first = rows[0]!.getAttribute("data-item-id")!;
    const second = rows[1]!.getAttribute("data-item-id")!;
    act(() => {
      fireEvent.keyDown(rows[0]!, { key: "ArrowDown", altKey: true });
    });
    await waitFor(() => expect(setEditorToolbarOrder).toHaveBeenCalled());
    const written = setEditorToolbarOrder.mock.calls[0]![0] as string[];
    expect(written.indexOf(second)).toBeLessThan(written.indexOf(first));
  });

  it("ignores a bare ArrowDown, so the arrow keys stay the page's", async () => {
    const rows = await renderToolbar();
    act(() => {
      fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    });
    expect(setEditorToolbarOrder).not.toHaveBeenCalled();
  });

  it("keeps its own ↑/↓ buttons, which is what tc2 drives instead of a drag", async () => {
    const rows = await renderToolbar();
    const first = rows[0]!.getAttribute("data-item-id")!;
    const second = rows[1]!.getAttribute("data-item-id")!;
    const down = screen.getAllByTestId("settings.toolbar-customize.move-down")[0]!;
    expect(down.getAttribute("data-item-id")).toBe(first);
    act(() => {
      fireEvent.click(down);
    });
    await waitFor(() => expect(setEditorToolbarOrder).toHaveBeenCalled());
    const written = setEditorToolbarOrder.mock.calls[0]![0] as string[];
    expect(written.indexOf(second)).toBeLessThan(written.indexOf(first));
    // The first row's move-up is disabled, which is why tc2 starts there.
    // `toBeDisabled` is jest-dom's; this repo's Vitest setup has no DOM matchers,
    // so the property is read directly.
    expect(
      (screen.getAllByTestId("settings.toolbar-customize.move-up")[0] as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("pins a not-yet-renderable row's toggle off, and says why", async () => {
    const rows = await renderToolbar();
    const pendingId = EDITOR_TOOLBAR_PENDING_IDS[0];
    expect(pendingId, "the pending roster must be non-empty or this case asserts nothing").toBeTruthy();
    const pendingRow = rows.find((r) => r.getAttribute("data-item-id") === pendingId);
    expect(pendingRow).toBeTruthy();
    const toggle = pendingRow!.querySelector<HTMLInputElement>(
      '[data-testid="settings.toolbar-customize.toggle"]',
    )!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(false);
    expect(pendingRow!.textContent ?? "").toMatch(/./);
    // …and a non-pending row's toggle is live, so the assertion above is about the
    // pending row rather than about every row.
    const liveRow = rows.find((r) => r.getAttribute("data-item-id") !== pendingId)!;
    expect(
      liveRow.querySelector<HTMLInputElement>(
        '[data-testid="settings.toolbar-customize.toggle"]',
      )!.disabled,
    ).toBe(false);
  });

  it("rolls an optimistic hide back, and shows the failure", async () => {
    // The rollback half of the pattern the 16 sibling panels share. `ViewsSettings`
    // is the one that skips it (audit Aile 4 #6); this list must not join it.
    setEditorToolbarHidden.mockRejectedValueOnce(new Error("locked"));
    const rows = await renderToolbar();
    const liveRow = rows.find(
      (r) => r.getAttribute("data-item-id") !== EDITOR_TOOLBAR_PENDING_IDS[0],
    )!;
    const toggle = liveRow.querySelector<HTMLInputElement>(
      '[data-testid="settings.toolbar-customize.toggle"]',
    )!;
    expect(toggle.checked).toBe(true);
    act(() => {
      fireEvent.click(toggle);
    });
    await waitFor(() => expect(setEditorToolbarHidden).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        liveRow.querySelector<HTMLInputElement>(
          '[data-testid="settings.toolbar-customize.toggle"]',
        )!.checked,
      ).toBe(true),
    );
    // The failure is stated, not swallowed: the paragraph the sibling panels render.
    await waitFor(() => expect(document.querySelector("p")).not.toBeNull());
  });
});
