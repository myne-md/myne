// Flow-logic: the lost-both-secrets delete-vault cul-de-sac escape
// (MYND-108-bis, E2E-gap #36). Headless Chromium + mock IPC — NOT end-to-end.
// A user who lost password AND recovery phrase taps "Delete vault and start
// over" → confirm → welcome. The PartialDelete leg surfaces the terminal error
// banner + Continue exit. The real filesystem wipe stays a device check.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("mobile delete-vault escape", () => {
  test("confirm delete → vault_delete fires → welcome", async ({ page }) => {
    await installMockIpc(page, { lockedVault: true });
    await page.goto("/");

    await page.getByTestId("unlock-delete-link").click();
    await page.getByTestId("unlock-delete-confirm").click();

    // Lands back on Welcome (fresh-start), and the real delete IPC ran once.
    await expect(page.getByRole("button", { name: "Create a vault" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __vaultDeletes?: number }).__vaultDeletes ?? 0)).toBe(1);
  });

  test("PartialDelete → error banner + Continue terminal exit", async ({ page }) => {
    await installMockIpc(page, {
      lockedVault: true,
      deleteError: { kind: "PartialDelete" },
    });
    await page.goto("/");

    await page.getByTestId("unlock-delete-link").click();
    await page.getByTestId("unlock-delete-confirm").click();

    await expect(page.getByTestId("unlock-delete-error")).toBeVisible();
    await page.getByTestId("unlock-delete-continue").click();
    await expect(page.getByRole("button", { name: "Create a vault" })).toBeVisible();
  });
});
