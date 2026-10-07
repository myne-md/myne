// Flow-logic: the recovery-phrase Copy is gated, and the gate is currently SHUT
// (myne-md/myne#455, Tier 1). Headless Chromium against the dev server with mock
// IPC, NOT an end-to-end suite.
//
// # What these assert, and why it is "absent on both" rather than "iOS only"
//
// The platform rule is that Copy belongs on iOS and on no Android version. The
// SHIPPED behaviour today is narrower than that: `IOS_PASTEBOARD_VERIFIED` in
// `mobile/src/lib/clipboard.ts` is `false`, so the affordance renders nowhere at
// all. It is held there because the two pasteboard options the whole design
// rests on have been read in Apple's documentation and never observed on a
// device (`docs/dev/clipboard-sensitivity-verification.md`).
//
// So these tests assert what is true rather than what is intended. An earlier
// version asserted "iOS offers Copy", was recorded as passing, and then failed
// the moment the gate closed. A test that describes the intent while the code
// describes something else is not coverage, it is a second opinion.
//
// The platform half of the rule is unit-tested directly in
// `mobile/tests/clipboard-gate.test.ts`, which can drive both the flag and the
// platform. When the device checks pass and the flag flips, the iOS expectation
// here changes from `toHaveCount(0)` to `toBeVisible()` and the Android one does
// not move. That asymmetry is the point of having both.
//
// Nothing here says anything about the pasteboard itself: mock IPC means no
// plugin, no `UIPasteboard`, no confinement and no expiry.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const PASSWORD = "correct horse battery staple";

/** Walk Welcome to briefing to name to password to the recovery kit. */
async function reachKitStep(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  // First run is identity-first (myne-md/myne#768): the vault path is the
  // "Create a local vault instead" ghost button, not the old "Create a vault".
  await page.getByRole("button", { name: "Create a local vault instead" }).click();

  // The briefing's three acknowledgements, clicked by TEXT: the rows are labels
  // wrapping a checkbox, and checking the input alone does not enable Continue.
  for (const fragment of [
    "Myne has no access to my notes",
    "There is no password reset",
    "recovery phrase is the only way back",
  ]) {
    await page.getByText(fragment, { exact: false }).first().click();
  }
  await page.getByRole("button", { name: "Continue" }).click();

  // The vault-name step (myne-md/myne#468) sits between the briefing and the
  // password, and the kit's Copy copies the whole kit, header included.
  await page.getByTestId("create-vault.name-input").fill("Gate Kasa");
  await page.getByTestId("create-vault.name-continue").click();

  const pwInputs = page.locator('input[type="password"]');
  await expect(pwInputs).toHaveCount(2);
  await pwInputs.nth(0).fill(PASSWORD);
  await pwInputs.nth(1).fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();

  // The actions appear only once the whole phrase has been shown, so a user
  // cannot copy words they have not seen.
  await page.getByRole("button", { name: /Show words/ }).click();
}

test.describe("recovery-phrase Copy is gated on what the OS can hold", () => {
  test("iOS: no Copy while the pasteboard behaviour is unverified", async ({ page }) => {
    await installMockIpc(page, { freshDevice: true, devicePlatform: "ios" });
    await reachKitStep(page);

    // Save to file first, as the control: this assertion is an ABSENCE, and an
    // absence passes trivially if the step never rendered at all.
    await expect(page.getByRole("button", { name: "Save to file" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
  });

  test("Android: no Copy, and that one does not change when the gate opens", async ({ page }) => {
    await installMockIpc(page, { freshDevice: true, devicePlatform: "android" });
    await reachKitStep(page);

    await expect(page.getByRole("button", { name: "Save to file" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
  });
});
