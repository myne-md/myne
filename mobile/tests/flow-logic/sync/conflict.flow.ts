// Flow-logic: the conflict-resolution surface (MYND-461 / MYND-462 T3). Drives
// headless Chromium against the dev server with mock IPC — NOT an end-to-end suite
// (no device, no Rust, no real transport). A `conflicts` status surfaces the in-feed
// count banner; tapping it opens the conflicts sheet. With no conflict-copy notes
// in the mock roster the sheet shows its empty state — the banner→sheet wiring is
// what this exercises.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("sync conflict surface", () => {
  test("conflicts status → count banner → opens the conflicts sheet", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "conflicts", count: 2 },
      pendingConflicts: [],
    });
    await page.goto("/");

    const banner = page.getByTestId("sync.conflict-count-banner");
    await expect(banner).toBeVisible();
    await banner.click();

    // The sheet opens; with no conflict-copy notes in the mock it shows empty state.
    await expect(page.getByTestId("conflicts.empty")).toBeVisible();
  });
});
