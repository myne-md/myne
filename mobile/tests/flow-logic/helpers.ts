// Shared helpers for the flow-logic tier.
//
// These exist because two gestures are not expressible as a plain Playwright
// action against this app, and every spec that touches folders needs both:
//
//   • `longPress` — the row action sheets open on a 480ms hold, and Playwright's
//     `click()` completes far too fast to trip it. The press must be a bare
//     `pointerdown` with NO move/up, so the hold timer resolves.
//   • `expandFolder` — since MYND-561 the folder tree starts fully COLLAPSED
//     (desktop parity: the expand set is restored from `vault.workspace`, and a
//     fresh mock vault has none), so any assertion about a nested row must open
//     its parent chain first.
//
// Both were copy-pasted into two specs before this module existed; more specs
// touching nested rows are expected, so they live here now.

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
