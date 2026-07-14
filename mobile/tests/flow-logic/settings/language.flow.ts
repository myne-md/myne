// Flow-logic: the Settings → Appearance display-language picker (MYND-485).
// Headless Chromium + mock IPC — NOT end-to-end. Proves the picker is present,
// that selecting a language re-renders the sheet instantly (a shared,
// tr-translated key re-labels) with no reload, and that the choice persists
// device-locally to `localStorage["myne.lang"]` (NOT vault.prefs — language must
// be selectable pre-unlock). The boot-from-storage detection itself is unit-
// tested in `tests/i18n/runtime.test.ts`.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("mobile display-language picker", () => {
  test("select a language → instant re-label + persists to myne.lang", async ({ page }) => {
    await installMockIpc(page, {});
    await page.goto("/");

    // Open Settings → Appearance (the settings gear + the category row).
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByText("Appearance", { exact: true }).click();

    const select = page.getByTestId("settings.language-select");
    await expect(select).toBeVisible();
    // Playwright boots English (navigator.language = en-US, no stored override).
    await expect(select).toHaveValue("en");

    // Switch to Turkish: the sheet re-renders immediately (the language label is a
    // shared, tr-translated catalog key → "Dil") with no reload, and the choice
    // is written to the device-local override key.
    await select.selectOption("tr");
    await expect(select).toHaveValue("tr");
    await expect(page.getByText("Dil", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("myne.lang"))).toBe("tr");

    // The choice survives a reload AND the app actually BOOTS from the stored
    // override (detectInitialLanguage reads myne.lang before the tree mounts):
    // after reload, the picker re-reflects Turkish with no re-selection.
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem("myne.lang"))).toBe("tr");
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByText("Appearance", { exact: true }).click();
    await expect(page.getByTestId("settings.language-select")).toHaveValue("tr");
  });
});
