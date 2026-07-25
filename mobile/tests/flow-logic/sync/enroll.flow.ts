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

  test("the device-name field is pre-filled, editable, and lands on the new device", async ({
    page,
  }) => {
    // MYND-548: naming happens at the one moment the user is provably holding
    // this device. The suggestion comes from the Rust platform token — never from
    // `navigator`, which would be a second default-name heuristic.
    await installMockIpc(page, {
      syncStatus: { state: "not_enrolled" },
      enrollResult: { approved: true },
      devicePlatform: "ios",
      // The roster is mocked independently of enroll, so seed the row the
      // enrollment registers (the mock hands back this device_id).
      devices: [
        {
          device_id_hex: "aa11bb22cc33dd44ee55ff6677889900",
          approved: true,
          retired: false,
          is_current: true,
        },
      ],
    });
    await openSyncSettings(page);
    await page.getByTestId("sync.settings.add-device").click();

    const nameField = page.getByTestId("sync.enroll.device-name-input");
    await expect(nameField).toHaveValue("iPhone");

    await nameField.fill("Work phone");
    await page.getByTestId("sync.enroll.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.enroll.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.enroll.submit").click();

    // The name is forwarded to the CORE, which parks it and applies it in a later
    // prefs phase — so this tier asserts the hand-off, not the rendered row. That
    // the name actually reaches the other device is the desktop E2E's job.
    const forwarded = await page.evaluate(
      () => (window as unknown as { __enrollArgs?: { deviceName?: string } }).__enrollArgs,
    );
    expect(forwarded?.deviceName).toBe("Work phone");
  });

  test("submitting with the name field cleared falls back to the suggestion", async ({ page }) => {
    // A device must never arrive nameless: the blank falls back to the platform
    // suggestion (and the backend refuses a blank outright).
    await installMockIpc(page, {
      syncStatus: { state: "not_enrolled" },
      enrollResult: { approved: true },
      devicePlatform: "android",
      devices: [
        {
          device_id_hex: "aa11bb22cc33dd44ee55ff6677889900",
          approved: true,
          retired: false,
          is_current: true,
        },
      ],
    });
    await openSyncSettings(page);
    await page.getByTestId("sync.settings.add-device").click();

    await page.getByTestId("sync.enroll.device-name-input").fill("");
    await page.getByTestId("sync.enroll.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.enroll.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.enroll.submit").click();

    const forwarded = await page.evaluate(
      () => (window as unknown as { __enrollArgs?: { deviceName?: string } }).__enrollArgs,
    );
    expect(forwarded?.deviceName).toBe("Android phone");
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
