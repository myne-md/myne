// Flow-logic: the sync STATUS surface renders per state (MYND-461 / MYND-462 T3).
// Drives headless Chromium against the dev server with mock IPC; NOT an end-to-end
// suite (no device, no Rust, no real transport). The header glyph reads the single
// `use-sync-status` hook, so a canned `sync_status` fully drives what it shows.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("sync status surface", () => {
  test("idle → the header glyph shows the synced state", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "idle" } });
    await page.goto("/");
    const glyph = page.getByTestId("sync.header-glyph");
    await expect(glyph).toBeVisible();
    await expect(glyph).toHaveAttribute("aria-label", "Synced");
  });

  test("syncing → the glyph reflects the in-flight state", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "syncing" } });
    await page.goto("/");
    await expect(page.getByTestId("sync.header-glyph")).toHaveAttribute("aria-label", "Syncing…");
  });

  test("conflicts → the glyph shows the count + the count banner appears", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "conflicts", count: 2 } });
    await page.goto("/");
    await expect(page.getByTestId("sync.header-glyph-count")).toHaveText("2");
    await expect(page.getByTestId("sync.conflict-count-banner")).toBeVisible();
  });

  test("error → the glyph takes the error state", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "error", detail: "offline" } });
    await page.goto("/");
    await expect(page.getByTestId("sync.header-glyph")).toHaveAttribute("aria-label", "Sync error");
  });
});
