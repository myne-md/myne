// Flow-logic: the daily-driver password unlock (MYND E2E-gap #34). Headless
// Chromium against the dev server with mock IPC — NOT an end-to-end suite (no
// device, no real Argon2id, no Rust). What IS flow-testable: a locked `Exists`
// vault renders the password form; a correct submit routes to the editor; a
// rejected `unlock` surfaces the non-distinguishing error and keeps the user on
// the form. The real on-device Argon2id derivation stays a device-matrix check.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("mobile password unlock", () => {
  test("correct password → editor", async ({ page }) => {
    await installMockIpc(page, { lockedVault: true });
    await page.goto("/");

    await expect(page.getByTestId("unlock-submit")).toBeVisible();
    await page.getByTestId("unlock-password").fill("correct horse battery staple");
    await page.getByTestId("unlock-submit").click();

    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  });

  test("wrong password → non-distinguishing error, stays on the form", async ({ page }) => {
    await installMockIpc(page, {
      lockedVault: true,
      unlockError: { kind: "InvalidCredentialOrVault" },
    });
    await page.goto("/");

    await page.getByTestId("unlock-password").fill("not the password");
    await page.getByTestId("unlock-submit").click();

    await expect(page.getByTestId("unlock-error")).toBeVisible();
    // Still on the password form — no editor, no leak of which half was wrong.
    await expect(page.getByTestId("unlock-submit")).toBeVisible();
    await expect(page.getByTestId("workspace.app-header")).toHaveCount(0);
  });
});
