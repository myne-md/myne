// Flow-logic: PIN quick-unlock redeem (E2E-gap #54 — only biometric was
// covered). Headless Chromium + mock IPC — NOT end-to-end. With a configured,
// session-available PIN credential the unlock screen shows the PIN surface; a
// correct PIN routes to the editor, a wrong PIN surfaces the remaining-attempts
// error and stays on the PIN form. The real PIN-derived wrap-key redeem
// (Argon2id + keychain) stays a device check.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const PIN_AVAILABLE = { configured: true, method: "pin" as const, available: true };

test.describe("mobile PIN quick-unlock", () => {
  test("correct PIN → editor", async ({ page }) => {
    await installMockIpc(page, { lockedVault: true, quickUnlock: PIN_AVAILABLE });
    await page.goto("/");

    await expect(page.getByTestId("unlock-pin-submit")).toBeVisible();
    await page.getByTestId("unlock-pin").fill("135790");
    await page.getByTestId("unlock-pin-submit").click();

    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  });

  test("wrong PIN → remaining-attempts error, stays on the PIN form", async ({ page }) => {
    await installMockIpc(page, {
      lockedVault: true,
      quickUnlock: PIN_AVAILABLE,
      pinRedeemError: { kind: "WrongCredential", detail: { remaining: 2 } },
    });
    await page.goto("/");

    await page.getByTestId("unlock-pin").fill("000000");
    await page.getByTestId("unlock-pin-submit").click();

    await expect(page.getByTestId("unlock-pin-error")).toBeVisible();
    await expect(page.getByTestId("unlock-pin-submit")).toBeVisible();
  });
});
