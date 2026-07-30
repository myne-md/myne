// Flow-logic: Settings → Privacy → Task reminders (MYND-619 tasks 6, 8, 11).
// Headless Chromium + mock IPC — NOT end-to-end. It proves the three settings
// surfaces behave: the per-device switch persists, the horizon line states a
// date, and the precise-delivery affordance appears exactly when it applies.
//
// **What this tier cannot touch, and no harness can:** whether the operating
// system actually fires a registration while Myne is closed, whether it survives
// a reboot, and where a tap lands after unlock. Those are the manual per-platform
// checklist in `docs/dev/reminders-device-checklist.md` — this spec deliberately
// asserts nothing about them rather than asserting something weaker and letting
// the checklist look redundant.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Settings → Privacy, where the reminder block lives (a block, not a rail entry). */
async function openPrivacy(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  // The rail row is labelled `settings.panelTitle.privacy` = "Privacy & security",
  // not "Privacy" — an exact-text match on the short form never resolves.
  await page.getByText("Privacy & security", { exact: true }).click();
}

test.describe("mobile task-reminder settings", () => {
  test("the switch is on by default, and turning it off persists + hides the block", async ({
    page,
  }) => {
    await installMockIpc(page, { exactAlarm: "approximate" });
    await page.goto("/");
    await openPrivacy(page);

    const row = page.getByTestId("settings.reminders-row");
    await expect(row).toBeVisible();
    // An absent preference reads as ENABLED — reading it as off would silently
    // disable reminders on every existing vault.
    await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("settings.reminders-horizon")).toBeVisible();

    await row.getByRole("switch").click();

    // The write reached the device-local setter…
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __remindersEnabledWrites?: boolean[] }).__remindersEnabledWrites))
      .toEqual([false]);
    // …and the surfaces that only make sense while reminders are on are gone:
    // there is no horizon to state and no delivery precision to caveat.
    await expect(page.getByTestId("settings.reminders-horizon")).toHaveCount(0);
    await expect(page.getByTestId("settings.reminder-exact-row")).toHaveCount(0);
  });

  test("the horizon line states a date, not a day count", async ({ page }) => {
    await installMockIpc(page, { prefs: { reminder_horizon_days: 7 } });
    await page.goto("/");
    await openPrivacy(page);

    const line = page.getByTestId("settings.reminders-horizon");
    await expect(line).toBeVisible();

    // "through <date>" is checkable against a calendar; "7 days" makes the reader
    // do the arithmetic and get it wrong. Computed here the same way the surface
    // does — in the LOCAL calendar, which is the part a UTC shift gets wrong.
    const expected = await page.evaluate(() => {
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())}`;
    });
    await expect(line).toContainText(expected);
  });

  test("the precise-delivery affordance appears only where the permission exists", async ({
    page,
  }) => {
    // The iOS / no-such-permission case: a row saying "not applicable" would be a
    // caveat about a limitation the user's phone does not have.
    await installMockIpc(page, { exactAlarm: "not-applicable" });
    await page.goto("/");
    await openPrivacy(page);

    await expect(page.getByTestId("settings.reminders-row")).toBeVisible();
    await expect(page.getByTestId("settings.reminder-exact-row")).toHaveCount(0);
    await expect(page.getByTestId("settings.reminder-exact-helper")).toHaveCount(0);
  });

  test("approximate delivery states the fallback and offers the platform screen", async ({
    page,
  }) => {
    await installMockIpc(page, {
      exactAlarm: "approximate",
      exactAlarmAfterRequest: "exact",
    });
    await page.goto("/");
    await openPrivacy(page);

    // The fallback is STATED, verbatim, rather than left for a late reminder to
    // teach. Asserted as the full literal — a substring match would pass a
    // future softening of the sentence.
    await expect(page.getByTestId("settings.reminder-exact-helper")).toHaveText(
      "Android batches wake-ups to save battery, so reminders arrive around the time you set rather than exactly on it. Allowing exact timing removes the delay.",
    );

    // Nothing is requested until the user asks — the app never opens the screen
    // on its own, and there is no one-shot prompt to spend.
    expect(
      await page.evaluate(() => (window as unknown as { __exactAlarmRequests?: number }).__exactAlarmRequests),
    ).toBeUndefined();

    await page.getByTestId("settings.reminder-exact-allow").click();

    expect(
      await page.evaluate(() => (window as unknown as { __exactAlarmRequests?: number }).__exactAlarmRequests),
    ).toBe(1);

    // On return the state is re-read: the row stops offering something the user
    // has already done, and the caveat is withdrawn.
    await expect(page.getByTestId("settings.reminder-exact-value")).toHaveText("On");
    await expect(page.getByTestId("settings.reminder-exact-allow")).toHaveCount(0);
    await expect(page.getByTestId("settings.reminder-exact-helper")).toHaveCount(0);
  });
});
