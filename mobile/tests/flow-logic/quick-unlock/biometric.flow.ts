// Flow-logic: the Face ID / Touch ID quick-unlock surfaces (MYND-329 mobile
// biometric). Drives headless Chromium against the dev server with mock IPC —
// NOT an end-to-end suite (no device, no Rust, no real Face ID; the OS
// biometric sheet is system UI a WebView test can never reach — see
// myne-agents/docs/dev/mobile-e2e-options.md §6.3). What this tier CAN pin down is the
// flow logic around the prompt: the auto-prompt on unlock entry, the
// cancel → retry surface, the password fallback, and the settings toggle
// round-trip.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("biometric quick-unlock — unlock screen", () => {
  test("redeemable biometric credential auto-prompts and unlocks to the editor", async ({ page }) => {
    await installMockIpc(page, {
      lockedVault: true,
      quickUnlock: { configured: true, method: "biometric", available: true },
    });
    await page.goto("/");

    // The auto-prompt fires on entry; the mock redeem resolves → editor. The
    // editor header's Settings button is the stable "we are in the editor" mark.
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  });

  test("cancelled prompt lands on the retry surface; retry works", async ({ page }) => {
    await installMockIpc(page, {
      lockedVault: true,
      quickUnlock: { configured: true, method: "biometric", available: true },
      biometricRedeemError: { kind: "Cancelled" },
    });
    await page.goto("/");

    // Auto-prompt → mock Cancelled → the UN-02-style failure surface. A cancel
    // must NOT loop the prompt: the retry is a user tap.
    const bio = page.getByTestId("unlock-biometric");
    await expect(bio).toBeVisible();
    await expect(bio).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("unlock-biometric-retry")).toBeVisible();

    // Retry re-fires the redeem (still Cancelled in the mock) — stays failed.
    await page.getByTestId("unlock-biometric-retry").click();
    await expect(bio).toHaveAttribute("data-state", "failed");
  });

  test("password fallback from the biometric surface, and back", async ({ page }) => {
    await installMockIpc(page, {
      lockedVault: true,
      quickUnlock: { configured: true, method: "biometric", available: true },
      biometricRedeemError: { kind: "Cancelled" },
    });
    await page.goto("/");

    await expect(page.getByTestId("unlock-biometric")).toBeVisible();
    await page.getByTestId("unlock-use-password").click();
    await expect(page.getByTestId("unlock-password")).toBeVisible();

    // The escape hatch is two-way: the password form offers the biometric
    // surface back (method-aware link).
    await page.getByTestId("unlock-use-biometric").click();
    await expect(page.getByTestId("unlock-biometric")).toBeVisible();
  });

  test("a session-cold credential (available: false) never shows the biometric surface", async ({ page }) => {
    await installMockIpc(page, {
      lockedVault: true,
      quickUnlock: { configured: true, method: "biometric", available: false },
    });
    await page.goto("/");

    // Spring-loaded gate: configured on disk but no full unlock this session →
    // the password form, with no biometric affordance offered.
    await expect(page.getByTestId("unlock-password")).toBeVisible();
    await expect(page.getByTestId("unlock-biometric")).not.toBeVisible();
    await expect(page.getByTestId("unlock-use-biometric")).not.toBeVisible();
  });
});

test.describe("biometric quick-unlock — settings", () => {
  /** Settings → Vault → the quick-unlock row, switched ON, which is what opens
   *  the setup inline. The row is the desktop's: a switch with its setup beneath
   *  it, not a drill-down panel, so the biometric affordance is a button in that
   *  setup rather than a second switch. */
  async function openQuickUnlockSetup(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).first().click();
    // Quick unlock lives in the `vault` category since myne-md/myne#880 task 12.
    await page.getByTestId("settings.category-vault").click();
    await page.getByTestId("settings.quick-unlock-row").getByRole("switch").click();
  }

  test("the Face ID button sets the credential up, and the row says so", async ({ page }) => {
    await installMockIpc(page, {});
    await openQuickUnlockSetup(page);

    await page.getByTestId("settings.quick-unlock-setup-biometric").click();

    // No toast: the row's own sentence is the confirmation, and it names the
    // method the credential uses. A toast said the same thing twice, and on this
    // screen the row is never out of view when it fires.
    await expect(
      page.getByTestId("settings.quick-unlock-row").getByText("Configured via Face ID"),
    ).toBeVisible();
    await expect(
      page.getByTestId("settings.quick-unlock-row").getByRole("switch"),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("switching the row off disables the credential in place", async ({ page }) => {
    await installMockIpc(page, {
      quickUnlock: { configured: true, method: "biometric", available: true },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByTestId("settings.category-vault").click();

    const toggle = page.getByTestId("settings.quick-unlock-row").getByRole("switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();

    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(
      page.getByTestId("settings.quick-unlock-row").getByText("Re-enter after auto-lock"),
    ).toBeVisible();
  });

  test("HardwareUnavailable surfaces an honest error", async ({ page }) => {
    await installMockIpc(page, {
      biometricSetupError: { kind: "HardwareUnavailable" },
    });
    await openQuickUnlockSetup(page);

    await page.getByTestId("settings.quick-unlock-setup-biometric").click();

    await expect(page.getByText("Face ID isn't available on this device.")).toBeVisible();
  });

  test("BiometricAuthFailed names the real cause", async ({ page }) => {
    // iOS reports errSecAuthFailed from SecItemAdd when it cannot create the
    // biometric item, most often because no Face ID / Touch ID is enrolled.
    // Before myne-md/myne#830 that fell through to the generic "Couldn't set up
    // quick unlock"; the copy must offer enrolment as the remedy.
    await installMockIpc(page, {
      biometricSetupError: { kind: "BiometricAuthFailed" },
    });
    await openQuickUnlockSetup(page);

    await page.getByTestId("settings.quick-unlock-setup-biometric").click();

    await expect(
      page.getByText(
        "Face ID couldn't be set up. Make sure it is enabled in your device settings, or use a PIN instead.",
      ),
    ).toBeVisible();
  });
});
