// Flow-logic: the 24-word recovery + password-reset flow (E2E-gap #35 — the
// only self-service account-recovery path; there is no email recovery by
// design). Headless Chromium + mock IPC — NOT end-to-end (no real BIP-39 →
// Argon2id-recovery derivation). What IS flow-testable: unlock → recovery-link
// → (skip account) → fill the 24-cell grid → decrypting → the non-dismissible
// password-reset → editor. The real phrase-derived key work stays a device
// check.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("mobile recovery + password reset", () => {
  test("recovery-link → skip account → 24-word grid → reset → editor", async ({ page }) => {
    await installMockIpc(page, { lockedVault: true });
    await page.goto("/");

    await page.getByTestId("unlock-recovery-link").click();

    // Account step (RC-01): the account number is optional — Skip by leaving it
    // empty and continuing to the phrase grid.
    const accountContinue = page.getByRole("button", { name: "Continue" });
    if (await accountContinue.isVisible().catch(() => false)) {
      const inputs = page.locator("input");
      if ((await inputs.count()) === 1) await accountContinue.click();
    }

    // Phrase grid (RC-02): 24 cells; the mock accepts any 24 words (real
    // BIP-39/Argon2id validation is a device check). Fill each, then submit.
    const cells = page.locator("input");
    await expect(cells).toHaveCount(24);
    for (let i = 0; i < 24; i++) await cells.nth(i).fill("ribbon");
    await page.getByRole("button", { name: /^Submit/ }).click();

    // Password reset (RC-04, non-dismissible): set a new device password.
    const pw = page.locator('input[type="password"]');
    await expect(pw).toHaveCount(2);
    await pw.nth(0).fill("correct horse battery staple");
    await pw.nth(1).fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  });
});
