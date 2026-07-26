// Flow-logic: the Settings → Sync USAGE section (MYND-570). Storage used against
// its effective ceiling, enrolled devices against their cap, and the operator
// freeze row.
//
// The load-bearing case is `0 = unlimited`, the server's own convention for both
// ceilings. A self-hosted instance (or the hosted free beta) reports `0`, and the
// UI must then show the bare figure with NO limit, NO error and NO upsell — a
// hosted-only commercial concept must never be forced onto a self-hoster (TB5).
//
// Drives headless Chromium against the dev server with mock IPC; NOT end-to-end.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Open Settings → Sync: the header gear, then the "Sync" category row. */
async function openSyncSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText("Sync", { exact: true }).click();
}

const GIB = 1024 * 1024 * 1024;

test.describe("sync usage section (Settings → Sync, MYND-570)", () => {
  test("hosted account with ceilings shows used-of-total for storage and devices", async ({
    page,
  }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      accountStatus: {
        stored_bytes: 3 * GIB,
        device_count: 2,
        frozen: false,
        quota_bytes: 10 * GIB,
        max_devices: 5,
      },
    });
    await page.goto("/");
    await openSyncSettings(page);

    await expect(page.getByTestId("sync.usage-storage")).toContainText("3.0 GB");
    await expect(page.getByTestId("sync.usage-storage")).toContainText("10.0 GB");
    await expect(page.getByTestId("sync.usage-devices")).toContainText("2");
    await expect(page.getByTestId("sync.usage-devices")).toContainText("5");
    await expect(page.getByTestId("sync.usage-frozen")).toHaveCount(0);
  });

  test("no ceilings (self-hosted) shows bare figures — no limit, no error, no upsell", async ({
    page,
  }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      accountStatus: {
        stored_bytes: 3 * GIB,
        device_count: 2,
        frozen: false,
        quota_bytes: 0,
        max_devices: 0,
      },
    });
    await page.goto("/");
    await openSyncSettings(page);

    const storage = page.getByTestId("sync.usage-storage");
    await expect(storage).toContainText("3.0 GB");
    // `0` must never be rendered as a ceiling.
    await expect(storage).not.toContainText("0 B");
    await expect(page.getByTestId("sync.usage-devices")).not.toContainText("0");
  });

  test("frozen account surfaces its own row", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      accountStatus: {
        stored_bytes: 1 * GIB,
        device_count: 1,
        frozen: true,
        quota_bytes: 10 * GIB,
        max_devices: 5,
      },
    });
    await page.goto("/");
    await openSyncSettings(page);

    await expect(page.getByTestId("sync.usage-frozen")).toBeVisible();
  });

  test("no /account/status route omits the section entirely (no error state)", async ({ page }) => {
    // Default mock returns null — an older or self-hosted server without the route.
    await installMockIpc(page, { syncStatus: { state: "idle" } });
    await page.goto("/");
    await openSyncSettings(page);

    await expect(page.getByTestId("sync.usage-storage")).toHaveCount(0);
    await expect(page.getByTestId("sync.usage-devices")).toHaveCount(0);
    // The rest of the Sync surface still renders.
    await expect(page.getByTestId("sync.settings.status")).toBeVisible();
  });
});
