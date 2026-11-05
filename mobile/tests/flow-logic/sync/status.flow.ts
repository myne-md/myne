// Flow-logic: the sync STATUS surface now lives in Settings → Sync (MYND-481);
// the always-on general-UI header glyph was removed. A canned `sync_status`
// fully drives the status label + the Force-sync ("Sync now") affordance there,
// while critical conflicts still surface on the main UI via the SyncBanners
// error channel (the one sync signal that intentionally stays outside Settings).
// Drives headless Chromium against the dev server with mock IPC; NOT end-to-end.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Open Settings → Sync: the header gear, then the "Sync" category row. */
async function openSyncSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText("Sync", { exact: true }).click();
}

test.describe("sync status surface (Settings → Sync, MYND-481)", () => {
  test("idle → Settings shows the synced state + a Force-sync action", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "idle" } });
    await page.goto("/");
    await openSyncSettings(page);
    // "Synced", not the phone's old "On": both clients render the shared map now, and the two
    // had already drifted before this change (myne-md/myne#1027).
    await expect(page.getByTestId("sync.settings.status")).toContainText("Synced");
    await expect(page.getByTestId("sync.settings.sync-now")).toBeVisible();
  });

  test("syncing → Settings reflects the in-flight state", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "syncing" } });
    await page.goto("/");
    await openSyncSettings(page);
    await expect(page.getByTestId("sync.settings.status")).toContainText("Syncing…");
  });

  test("conflicts → the banner surfaces on the main UI + Settings shows the count", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "conflicts", count: 2 } });
    await page.goto("/");
    // The conflict alert channel stays in the general UI (MYND-481 keeps it —
    // status moving to Settings must not silence a critical conflict).
    await expect(page.getByTestId("sync.conflict-count-banner")).toBeVisible();
    await openSyncSettings(page);
    await expect(page.getByTestId("sync.settings.status")).toContainText("2 conflicts");
  });

  // "Offline" is gone from this surface entirely. It named a cause the class does not
  // establish (`sync_failed` is `Transport` OR `Other`), and the phone said it while the
  // computer said "Sync error" about the same state (myne-md/myne#1027). The honest generic
  // sentence is the shared map's, and the classes with a name of their own are pinned below.
  test("a generic failure says 'Sync error', not 'Offline'", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "error", detail: "sync_failed" } });
    await page.goto("/");
    await openSyncSettings(page);
    await expect(page.getByTestId("sync.settings.status")).toContainText("Sync error");
  });

  test("a locked identity is not reported as offline", async ({ page }) => {
    // The defect this pins: everything but a TLS failure used to read
    // "Offline", so a locked identity sent the user at a network that was
    // working. The whole point of the class split is that this row says what
    // the user can actually do.
    await installMockIpc(page, {
      syncStatus: { state: "error", detail: "identity_locked" },
    });
    await page.goto("/");
    await openSyncSettings(page);
    await expect(page.getByTestId("sync.settings.status")).toContainText(
      "Unlock your identity to sync",
    );
    await expect(page.getByTestId("sync.settings.status")).not.toContainText("Offline");
  });

  test("not-enrolled → no Force-sync (nothing to sync yet)", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "not_enrolled" } });
    await page.goto("/");
    await openSyncSettings(page);
    await expect(page.getByTestId("sync.settings.sync-now")).toHaveCount(0);
  });
});
