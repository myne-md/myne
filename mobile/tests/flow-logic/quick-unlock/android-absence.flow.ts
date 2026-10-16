// Flow-logic: Android offers no biometric affordance at all — myne-md/myne#557,
// the `unlock.biometric-quick-unlock` bullet.
//
// # What the roster row asked for, and why it could not answer it
//
// "On an Android device, confirm there is no biometric quick-unlock affordance."
// That is a per-release walk on hardware, and on the one platform where the
// answer is a NEGATIVE — which is the hardest kind of thing to check by hand,
// because "I did not see one" and "there is one and I missed it" look identical
// in a bug report.
//
// It is also the case with the most room to go quietly wrong. `decisions.md`
// 2026-07-26 makes omission NORMATIVE: an unavailable feature is omitted, never
// greyed out, because "a disabled control is an offer the platform cannot
// honour — it tells the user the feature exists here and they are doing
// something wrong". Android has no Keystore provider yet, so the backend answers
// `HardwareUnavailable`; a toggle that rendered disabled would be exactly the
// wrong shape, and a hand-walk that saw a greyed row would very likely read it
// as correct.
//
// # Why this tier can answer it
//
// The absence is a DOM query, the presence on iOS is the control arm that stops
// the absence from being vacuous, and the PIN path staying available is what
// makes the whole thing a difference rather than a removal.
//
// # Two different answers to "which platform am I", and this needs the UI's one
//
// Worth knowing before writing another platform-conditioned spec here, because
// it cost this file a first draft. Mobile has TWO platform sources:
//
//  * `App.tsx::detectPlatform()` sniffs `navigator.userAgent` and feeds
//    `PlatformProvider`, which is what every `usePlatform()` render branch reads
//    — including the biometric toggle's `!isAndroid` gate;
//  * `mobile/src/lib/prefs.ts::devicePlatform()` is an IPC call, and it is what
//    `mock-ipc.ts`'s `devicePlatform` config drives — the clipboard gate reads
//    that one.
//
// So setting the mock's `devicePlatform` to `"android"` changes nothing about
// the RENDER: headless Chromium's user agent says desktop Chrome, `isAndroid`
// stays false, and the biometric toggle draws. Every existing spec in this tier
// therefore runs as iOS whatever the mock says. `test.use({ userAgent })` drives
// the production sniff for real, which is what the assertions below need.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Settings → Vault → Quick unlock (myne-md/myne#880 task 12 moved quick unlock
 *  out of Privacy into the vault-scoped group). */
async function openQuickUnlockPanel(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByTestId("settings.category-vault").click();
  await page.getByTestId("settings.quick-unlock-row").click();
}

/** A real Android Chrome user agent — what `detectPlatform()` sniffs. */
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Mobile Safari/537.36";

test.describe("Android: the biometric affordance is absent, not disabled", () => {
  test.use({ userAgent: ANDROID_UA });

  test("no biometric toggle renders in any state", async ({ page }) => {
    await installMockIpc(page, {
      devicePlatform: "android",
      // The honest Android backend: no provider, so setup would refuse.
      biometricSetupError: { kind: "HardwareUnavailable" },
    });
    await openQuickUnlockPanel(page);

    // The panel itself is open — otherwise every absence below is trivially
    // true because nothing rendered at all.
    await expect(page.getByTestId("settings.quick-unlock-pin-setup")).toBeVisible();

    // Absent from the DOM, not merely hidden or disabled. `count()` rather than
    // a visibility assertion, because a disabled-but-present control is exactly
    // what this must fail on.
    await expect(page.getByTestId("settings.quick-unlock-biometric-toggle")).toHaveCount(0);
  });

  test("the PIN path is untouched — this is a difference, not a removal", async ({ page }) => {
    // The PIN path is "genuinely portable: Argon2id + three files under one
    // vault root, no OS secret involved" (`core-wasm-assessment.md`), which is
    // why the two are separate capabilities. Collapsing them would have made a
    // working feature look impossible on Android.
    await installMockIpc(page, { devicePlatform: "android" });
    await openQuickUnlockPanel(page);

    // The PIN setup form is what the panel offers when quick-unlock is not yet
    // configured, and it is present on the platform with no biometric provider.
    await expect(page.getByTestId("settings.quick-unlock-pin-setup")).toBeVisible();
    await expect(page.getByPlaceholder(/PIN/i).first()).toBeVisible();
  });

});

test.describe("iOS DOES offer it, so the absence above is not vacuous", () => {
  // No `test.use` — the tier's default user agent is not Android, which is the
  // iOS arm as far as `detectPlatform()` is concerned.
  test("the biometric toggle renders", async ({ page }) => {
    await installMockIpc(page, { devicePlatform: "ios" });
    await openQuickUnlockPanel(page);
    await expect(page.getByTestId("settings.quick-unlock-biometric-toggle")).toHaveCount(1);
  });
});

test.describe("Android: the unlock screen offers no biometric entry either", () => {
  test.use({ userAgent: ANDROID_UA });

  test("a locked vault goes straight to the password form", async ({ page }) => {
    // The settings row is one surface; the unlock screen is the other, and it
    // is the one a user meets first. A biometric prompt there on a platform
    // with no provider is a dead end rather than a greyed control.
    await installMockIpc(page, {
      devicePlatform: "android",
      lockedVault: true,
    });
    await page.goto("/");

    await expect(page.getByTestId("unlock-biometric")).toHaveCount(0);
    await expect(page.getByTestId("unlock-biometric-retry")).toHaveCount(0);
    // …and the password path is there, so the screen is not simply empty.
    await expect(page.getByTestId("unlock-password")).toBeVisible();
  });
});
