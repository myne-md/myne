// Flow-logic: the corrupted-vault fail-closed surface (E2E-gap #43). Headless
// Chromium + mock IPC — NOT end-to-end. A `Corrupted` vault.meta must boot to
// the fail-closed surface (NO password form — the security-load-bearing "don't
// silently proceed" guard) whose only exits are restore/close. The real
// at-rest corruption detection stays a desktop/device check.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("mobile corrupted-vault fail-closed", () => {
  test("Corrupted boot → fail-closed surface, no password form", async ({ page }) => {
    await installMockIpc(page, { corruptedVault: true });
    await page.goto("/");

    await expect(page.getByTestId("unlock-fail-closed")).toBeVisible();
    // The password form MUST NOT render — a user can't attempt to unlock a
    // vault whose meta is unreadable.
    await expect(page.getByTestId("unlock-submit")).toHaveCount(0);
    await expect(page.getByTestId("unlock-password")).toHaveCount(0);
  });
});
