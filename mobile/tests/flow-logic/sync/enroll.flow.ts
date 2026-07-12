// Flow-logic: the enroll flow's stage transitions (MYND-459 / MYND-462 T3). Drives
// headless Chromium against the dev server with mock IPC — NOT an end-to-end suite
// (no device, no Rust, no real transport). Navigates Settings → Sync → Add this device,
// submits an account# + password, and asserts the pending-approval transition when
// the mock `sync_enroll` returns `{ approved: false }`.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

async function openSyncSettings(page: import("@playwright/test").Page) {
  await page.goto("/");
  // Editor header → Settings (aria-label) → the "Sync" category row.
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText("Sync", { exact: true }).click();
  await expect(page.getByTestId("sync.settings")).toBeVisible();
}

test.describe("sync enroll flow", () => {
  test("Settings → Sync → Add this device reaches the enroll form", async ({ page }) => {
    await installMockIpc(page, { syncStatus: { state: "not_enrolled" } });
    await openSyncSettings(page);
    await page.getByTestId("sync.settings.add-device").click();
    await expect(page.getByTestId("sync.enroll")).toBeVisible();
  });

  test("password enroll → pending-approval transition", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "not_enrolled" },
      enrollResult: { approved: false }, // held by the approval gate
    });
    await openSyncSettings(page);
    await page.getByTestId("sync.settings.add-device").click();

    await page.getByTestId("sync.enroll.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.enroll.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.enroll.submit").click();

    // The mock returns `{ approved: false }` → the pending notice renders verbatim.
    await expect(page.getByTestId("sync.enroll.pending")).toBeVisible();
  });

  test("wrong account → the single non-distinguishing banner", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "not_enrolled" },
      enrollError: { kind: "BadRequest" }, // any credential/account/meta fault
    });
    await openSyncSettings(page);
    await page.getByTestId("sync.settings.add-device").click();

    await page.getByTestId("sync.enroll.account-input").fill("MY-0000-0000-0000-0000-0000");
    await page.getByTestId("sync.enroll.password-input").fill("whatever");
    await page.getByTestId("sync.enroll.submit").click();

    await expect(page.getByTestId("sync.enroll.error")).toBeVisible();
  });
});
