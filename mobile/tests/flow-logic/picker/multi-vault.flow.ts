// Flow-logic: the ≥2-vault picker → select → unlock route (E2E-gap #55).
// Headless Chromium + mock IPC — NOT end-to-end. A user with two vaults boots
// to the picker; tapping a row reaches THAT vault's unlock screen (with the
// back-to-picker chevron). The real per-vault key isolation stays a device/
// desktop check.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("mobile multi-vault picker", () => {
  test("≥2 vaults boot to the picker and list both", async ({ page }) => {
    await installMockIpc(page, { multiVault: true });
    await page.goto("/");

    await expect(page.getByText("Choose a vault")).toBeVisible();
    await expect(page.getByText("Personal", { exact: true })).toBeVisible();
    await expect(page.getByText("Work", { exact: true })).toBeVisible();
  });

  test("selecting a row reaches that vault's unlock screen", async ({ page }) => {
    await installMockIpc(page, { multiVault: true });
    await page.goto("/");

    await page.getByText("Personal", { exact: true }).click();

    // Reached the password form; the back-to-picker chevron proves it came from
    // the picker (a mis-selected row is escapable).
    await expect(page.getByTestId("unlock-submit")).toBeVisible();
    await expect(page.getByTestId("unlock-back-to-picker")).toBeVisible();
  });
});
