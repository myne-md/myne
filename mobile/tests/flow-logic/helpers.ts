// Shared helpers for the flow-logic tier.
//
// These exist because the gestures below are not expressible as a plain
// Playwright action against this app, and more than one spec needs each:
//
//   • `longPress` — the row action sheets open on a 480ms hold, and Playwright's
//     `click()` completes far too fast to trip it. The press must be a bare
//     `pointerdown` with NO move/up, so the hold timer resolves.
//   • `expandFolder` — since MYND-561 the folder tree starts fully COLLAPSED
//     (desktop parity: the expand set is restored from `vault.workspace`, and a
//     fresh mock vault has none), so any assertion about a nested row must open
//     its parent chain first.
//   • `closeSheet` — the Settings sheet has no close button and no Escape
//     binding, so dismissal is a backdrop tap at a coordinate.
//   • `rootCustomProps` — the CSSOM applier's effect is only observable through
//     the style attribute's own key list, not a computed value.
//
// Each was copy-pasted into two or three specs before landing here; they live in
// this module so the next spec inherits them instead of making a fourth copy.

import { expect, type Page } from "@playwright/test";

/** Locate a folder row by its display name (`data-folder-path` carries the last
 *  segment, not the full path). */
export function folderRow(page: Page, name: string) {
  return page.locator(`[data-testid="notes.folder-row"][data-folder-path="${name}"]`);
}

/**
 * Open a folder's subtree so its nested rows render, and wait until the row
 * actually reports itself expanded — the disclosure is animated, so asserting on
 * a child immediately after the click races the render.
 */
export async function expandFolder(page: Page, name: string): Promise<void> {
  const row = folderRow(page, name);
  await row.click();
  await expect(row).toHaveAttribute("data-collapsed", "false");
}

/**
 * Fire a long-press on the first element matching `selector`: a bubbling
 * `pointerdown`, then wait past the 480ms hold threshold with no pointer
 * move/up so the row's hold timer resolves and opens its action sheet.
 */
export async function longPress(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error(`longPress: no element for ${sel}`);
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: r.x + 8, clientY: r.y + 8 }),
    );
  }, selector);
  await page.waitForTimeout(600);
}

/**
 * Dismiss the Settings sheet by tapping the backdrop above the card — the
 * Sheet's only programmatic exit (it has no close button; the alternatives are a
 * backdrop tap and a grabber drag). Escape is NOT bound.
 *
 * Reopening remounts the sheet, which drops any optimistic draft, so what the
 * reopened panel shows is DISK truth rather than the write that produced it.
 */
export async function closeSheet(page: Page): Promise<void> {
  await page.mouse.click(195, 50);
  await expect(page.getByTestId("sheet.card")).toHaveCount(0);
}

/**
 * Every `--*` custom property currently set on `<html>` by the CSSOM, as a
 * `key → value` map. Reading the style attribute's own key list (rather than a
 * computed value) is what distinguishes "the applier wrote it" from "a stylesheet
 * happened to define it", which is the whole point of the revert assertions.
 */
export function rootCustomProps(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const s = document.documentElement.style;
    const out: Record<string, string> = {};
    for (let i = 0; i < s.length; i++) {
      const key = s.item(i);
      if (key.startsWith("--")) out[key] = s.getPropertyValue(key);
    }
    return out;
  });
}

/**
 * The custom-theme fixture both MYND-598 specs seed `customThemes` with. Given
 * in the host's UTF-8 byte order (uppercase first) so a locale-collation
 * assertion over it is meaningful rather than incidental, and "Zinc" is a dark
 * palette defining none of the 12 syntax roles — which is what makes the shared
 * syntax-token derivation observable in the applied properties.
 */
export const SEEDED_THEMES = [
  {
    name: "Zinc",
    palette: {
      "--paper": "#101014",
      "--paper-2": "#191920",
      "--ink-1": "#e6e6ea",
      "--accent": "#7aa2f7",
      "--line-1": "#2a2a33",
    },
  },
  {
    name: "amber dusk",
    palette: {
      "--paper": "#fdf6e3",
      "--paper-2": "#f5ecd7",
      "--ink-1": "#3b3228",
      "--accent": "#b58900",
      "--line-1": "#e0d5bb",
    },
  },
];

/** Every `custom_theme` value written through `plugin:prefs|set_custom_theme`
 *  (recorded by the mock IPC layer). */
export function customThemeWrites(page: Page): Promise<(string | null)[]> {
  return page.evaluate(
    () => (window as unknown as { __customThemeWrites?: (string | null)[] }).__customThemeWrites ?? [],
  );
}
