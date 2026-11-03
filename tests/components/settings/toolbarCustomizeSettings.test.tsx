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
// The rest are this list's OWN contract, which nothing else can cover: the last
// visible row cannot be switched off, and the ↑/↓ buttons survive; they are the whole subject
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
import { EDITOR_TOOLBAR_ITEMS } from "../../../src/notes/toolbarItems";

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

  it("renders every vocabulary row as toggleable (the pin is gone, issue #970)", async () => {
    // The five list/quote/wikilink ids used to carry a disabled "Coming soon"
    // toggle because the floating toolbar skipped them. Their commands existed
    // all along and now render, so a disabled row here would be the lie: it would
    // say a control cannot be shown while the toolbar would happily show it.
    const rows = await renderToolbar();
    expect(rows).toHaveLength(EDITOR_TOOLBAR_ITEMS.length);
    for (const row of rows) {
      const toggle = row.querySelector<HTMLInputElement>(
        '[data-testid="settings.toolbar-customize.toggle"]',
      )!;
      expect(toggle.disabled, row.getAttribute("data-item-id") ?? "").toBe(false);
    }
    expect(document.body.textContent ?? "").not.toContain("Coming soon");
  });

  it("will not switch off the last visible control, and says why", async () => {
    // `resolveToolbarHidden` reads an empty stored list as "never customized", so
    // hiding everything would persist `[]` and read back as the defaults. The pin
    // used to keep every persisted value non-empty and so kept that reading
    // unambiguous; with the pin gone this rule does the same job, and a
    // formatting toolbar with no formatting is not a state worth supporting.
    const allShown = EDITOR_TOOLBAR_ITEMS.map((i) => i.id);
    const rows = await renderToolbar({ hidden: allShown.slice(1) });
    const visibleId = allShown[0]!;
    const visibleRow = rows.find((r) => r.getAttribute("data-item-id") === visibleId)!;
    const toggle = visibleRow.querySelector<HTMLInputElement>(
      '[data-testid="settings.toolbar-customize.toggle"]',
    )!;
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(visibleRow.textContent ?? "").toContain("Keep at least one");
    act(() => {
      fireEvent.click(toggle);
    });
    expect(setEditorToolbarHidden).not.toHaveBeenCalled();
    // A hidden row's toggle stays live, so the assertion above is about "last
    // visible" rather than about every checked box.
    const hiddenRow = rows.find((r) => r.getAttribute("data-item-id") !== visibleId)!;
    expect(
      hiddenRow.querySelector<HTMLInputElement>(
        '[data-testid="settings.toolbar-customize.toggle"]',
      )!.disabled,
    ).toBe(false);
    // And with two visible, both are live: the real second half, which the
    // first version of this test only ASSERTED ABOUT A CONSTANT
    // (`EDITOR_TOOLBAR_DEFAULT_HIDDEN.length`), so it could not have failed on
    // the drift it existed for. Hide one of the two and watch the write land.
    const twoVisible = await (async () => {
      cleanup();
      return renderToolbar({ hidden: allShown.slice(2) });
    })();
    const first = twoVisible.find(
      (r) => r.getAttribute("data-item-id") === allShown[0],
    )!;
    const firstToggle = first.querySelector<HTMLInputElement>(
      '[data-testid="settings.toolbar-customize.toggle"]',
    )!;
    expect(firstToggle.disabled).toBe(false);
    act(() => {
      fireEvent.click(firstToggle);
    });
    await waitFor(() => expect(setEditorToolbarHidden).toHaveBeenCalledTimes(1));
    expect(setEditorToolbarHidden.mock.calls[0]![0]).toContain(allShown[0]);
  });

  it("will not write the empty sentinel when the last hidden control is shown", async () => {
    // The mirror of the rule above, and the half that was missing (myne-md/myne#972
    // review, D8). `resolveToolbarHidden` reads `[]` as "never customized", so
    // un-hiding the only hidden control would persist `[]` and the user's whole
    // layout would silently revert to the default set on the next read. Hide is
    // bounded by `shownCount`; un-hide has to be bounded too, or the guard only
    // covers one direction.
    const allShown = EDITOR_TOOLBAR_ITEMS.map((i) => i.id);
    const hiddenId = allShown[0]!;
    const rows = await renderToolbar({ hidden: [hiddenId] });
    const hiddenRow = rows.find((r) => r.getAttribute("data-item-id") === hiddenId)!;
    const toggle = hiddenRow.querySelector<HTMLInputElement>(
      '[data-testid="settings.toolbar-customize.toggle"]',
    )!;
    expect(toggle.checked).toBe(false);
    expect(hiddenRow.textContent ?? "").toContain("Keep at least one hidden");
    act(() => {
      fireEvent.click(toggle);
    });
    expect(setEditorToolbarHidden).not.toHaveBeenCalled();

    // And with two hidden, the same click DOES write, so the assertion above is
    // about "last hidden" rather than about the toggle being inert.
    cleanup();
    setEditorToolbarHidden.mockClear();
    const two = await renderToolbar({ hidden: allShown.slice(0, 2) });
    const firstHidden = two.find((r) => r.getAttribute("data-item-id") === hiddenId)!;
    expect(firstHidden.textContent ?? "").not.toContain("Keep at least one hidden");
    act(() => {
      fireEvent.click(
        firstHidden.querySelector<HTMLInputElement>(
          '[data-testid="settings.toolbar-customize.toggle"]',
        )!,
      );
    });
    await waitFor(() => expect(setEditorToolbarHidden).toHaveBeenCalledTimes(1));
    expect(setEditorToolbarHidden.mock.calls[0]![0]).toEqual([allShown[1]]);
  });

  it("refuses to write over a layout it never read", async () => {
    // The failure this exists for: `prefsRead` rejects (locked, or a vault that
    // is not there yet), `hidden` is left holding the DEFAULTS, and one click
    // would persist those defaults over the user's stored layout. Nothing would
    // say so, the write itself succeeds, and the layout is gone with no undo.
    // A preference is recoverable by re-customizing, but "recoverable" is not
    // "not lost", so the write is refused until a read has succeeded.
    prefsRead.mockRejectedValueOnce(new Error("locked"));
    render(<ToolbarCustomizeSettings />);
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());

    const row = screen.getAllByTestId(/^settings\.toolbar-customize\.row\./)[0]!;
    const toggle = row.querySelector<HTMLInputElement>(
      '[data-testid="settings.toolbar-customize.toggle"]',
    )!;
    expect(toggle.disabled).toBe(true);
    act(() => {
      fireEvent.click(toggle);
    });
    act(() => {
      fireEvent.click(
        row.querySelector<HTMLButtonElement>(
          '[data-testid="settings.toolbar-customize.move-down"]',
        )!,
      );
    });
    expect(setEditorToolbarHidden).not.toHaveBeenCalled();
    expect(setEditorToolbarOrder).not.toHaveBeenCalled();
    // And the panel says why, rather than presenting rows that look live and
    // silently do nothing.
    expect(screen.getByText(/read-only until you reopen/i)).toBeTruthy();
  });

  it("rolls an optimistic hide back, and shows the failure", async () => {
    // The rollback half of the pattern the 16 sibling panels share. `ViewsSettings`
    // is the one that skips it (audit Aile 4 #6); this list must not join it.
    setEditorToolbarHidden.mockRejectedValueOnce(new Error("locked"));
    const rows = await renderToolbar();
    const liveRow = rows.find((r) => {
      const toggle = r.querySelector<HTMLInputElement>(
        '[data-testid="settings.toolbar-customize.toggle"]',
      );
      return toggle !== null && toggle.checked && !toggle.disabled;
    })!;
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
