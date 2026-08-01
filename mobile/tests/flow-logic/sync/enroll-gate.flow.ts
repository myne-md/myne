// Flow-logic: WHO is offered "Add this device" in the Sync hub
// (myne-md/myne-mobile#38). Drives headless Chromium against the dev server
// with mock IPC — NOT an end-to-end suite (no device, no Rust, no transport).
//
// The row used to render unconditionally, so a phone that was already enrolled
// and syncing still listed it, and tapping it opened the enrol form for a
// device that is already a member. That is not merely confusing: `sync_enroll`
// mints a FRESH `device_id`, so submitting it leaves a second pending
// registration on the account rather than doing nothing.
//
// `sync_status` decides, which is why a canned status is the whole fixture
// here: the roster is exactly what a device awaiting approval cannot read, and
// the status is derived from disk by the shared core.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import { ENROLL_PENDING_NOTICE } from "../../../src/lib/load-bearing-copy";

/** Open Settings → Sync: the header gear, then the "Sync" category row. */
async function openSyncSettings(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText("Sync", { exact: true }).click();
  await expect(page.getByTestId("sync.settings")).toBeVisible();
}

test.describe("the enrol gate in the Sync hub", () => {
  test("not-enrolled → the row is offered (this is what it is FOR)", async ({ page }) => {
    // Pinned first, so a "fix" that simply deleted the row cannot pass the
    // three assertions below — a fresh device would then have no way in.
    await installMockIpc(page, { syncStatus: { state: "not_enrolled" } });
    await openSyncSettings(page);
    await expect(page.getByTestId("sync.settings.add-device")).toBeVisible();
    await expect(page.getByTestId("sync.settings.awaiting-approval")).toHaveCount(0);
  });

  test("enrolled and syncing → the row is gone, the device list stays", async ({ page }) => {
    // The reported bug. `idle` means a token is on disk: this device is a
    // member and cannot be added again.
    await installMockIpc(page, { syncStatus: { state: "idle" } });
    await openSyncSettings(page);
    await expect(page.getByTestId("sync.settings.add-device")).toHaveCount(0);
    // Nothing else in DEVICES is lost — approving a NEW device still happens
    // here, which is why the section is gated row-by-row rather than hidden.
    await expect(page.getByTestId("sync.settings.devices")).toBeVisible();
  });

  test("awaiting approval → the row is withheld and the wait is stated", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "pending" } });
    await openSyncSettings(page);
    await expect(page.getByTestId("sync.settings.add-device")).toHaveCount(0);
    // Full-literal equality, never a substring: the sentence is load-bearing
    // copy shared byte-for-byte with the other clients (SYNC-42), and a
    // substring match would pass a softened rewrite.
    await expect(page.getByTestId("sync.settings.awaiting-approval")).toHaveText(
      ENROLL_PENDING_NOTICE,
    );
  });

  test("a failed cycle is not an invitation to register again", async ({ page }) => {
    // `error` still means a token is on disk — the transport failed, the
    // membership did not. Re-enrolling here would add a device, not fix a sync.
    await installMockIpc(page, { syncStatus: { state: "error", detail: "offline" } });
    await openSyncSettings(page);
    await expect(page.getByTestId("sync.settings.add-device")).toHaveCount(0);
  });
});
