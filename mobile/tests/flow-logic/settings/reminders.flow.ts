// Flow-logic: Settings → Privacy → Task reminders (MYND-619 tasks 6, 8, 11).
// Headless Chromium + mock IPC — NOT end-to-end. It proves the three settings
// surfaces behave: the per-device switch persists, the horizon picker reaches
// the device-local setter, and the precise-delivery affordance appears exactly
// when it applies. The horizon LINE is asserted ABSENT (myne#508): it claims an
// OS registration, and nothing on this client performs one yet.
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
    await expect(page.getByTestId("settings.reminders-horizon-picker")).toBeVisible();

    await row.getByRole("switch").click();

    // The write reached the device-local setter…
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __remindersEnabledWrites?: boolean[] }).__remindersEnabledWrites))
      .toEqual([false]);
    // …and the surfaces that only make sense while reminders are on are gone:
    // there is no horizon to state and no delivery precision to caveat.
    await expect(page.getByTestId("settings.reminders-horizon-picker")).toHaveCount(0);
    await expect(page.getByTestId("settings.reminder-exact-row")).toHaveCount(0);
  });

  test("the horizon line is not shown while nothing here registers with an OS", async ({
    page,
  }) => {
    // myne#508. "Reminders are registered through <date>" says an operating
    // system is holding these, and on this client nothing is: the pass that
    // would register them (`mobile/src/lib/reminderPass.ts`) has no production
    // caller, which `scripts/check-unwired.mjs` records. The sentence rendered
    // unconditionally, in 32 locales, and its own date was the only thing the
    // horizon control moved.
    //
    // `remindersReachTheOs()` is the predicate, and it flips on the change that
    // gives the pass a caller. This assertion flips with it.
    await installMockIpc(page, { prefs: { reminder_horizon_days: 7 } });
    await page.goto("/");
    await openPrivacy(page);

    await expect(page.getByTestId("settings.reminders-horizon-picker")).toBeVisible();
    await expect(page.getByTestId("settings.reminders-horizon")).toHaveCount(0);

    // And the row says which of the two it is. A bare label over four day
    // counts would leave a user acting on the horizon's documented privacy
    // reading with no bound in force and no way to know it.
    await expect(page.getByTestId("settings.reminders-horizon-helper")).toHaveText(
      "Saved on this device. Nothing reads it yet: this build does not deliver task reminders.",
    );
  });

  test("choosing a horizon reaches the device-local setter", async ({ page }) => {
    // The half myne#508 was actually about. `setReminderHorizonDays` had a Rust
    // core, an ACL row, its three-site registration and its own tests, and no
    // caller anywhere in `mobile/src`, so the horizon rendered and could never
    // be set. The first version of this fix was covered only by source-text
    // greps, which cannot fail when the handler is deleted: mobile's `Segmented`
    // takes `onChange` as optional and degrades silently to a presentational
    // control, so a dropped handler is pixel-identical and `tsc` accepts it.
    await installMockIpc(page, { prefs: { reminder_horizon_days: 7 } });
    await page.goto("/");
    await openPrivacy(page);

    // The default's segment is the selected one for a vault holding 7.
    await expect(page.getByTestId("settings.reminders-horizon-picker-7")).toHaveAttribute(
      "data-active",
      "true",
    );

    // The shortest offered horizon, which is the direction the issue asked for:
    // the preference is a privacy bound before a resource one, so what a user
    // wants from it is to TIGHTEN it.
    await page.getByTestId("settings.reminders-horizon-picker-1").click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __reminderHorizonWrites?: (number | null)[] })
              .__reminderHorizonWrites,
        ),
      )
      .toEqual([1]);
    await expect(page.getByTestId("settings.reminders-horizon-picker-1")).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  test("a horizon segment can be set from the keyboard", async ({ page }) => {
    // The `onKeyDown` block is the half a pointer test never reaches. Its own
    // comment says that without it the control is unreachable to a keyboard and
    // to every assistive technology that drives one, and deleting it left every
    // suite green: the pointer path, the roles and the source greps all pass.
    await installMockIpc(page, { prefs: { reminder_horizon_days: 7 } });
    await page.goto("/");
    await openPrivacy(page);

    await page.getByTestId("settings.reminders-horizon-picker-3").focus();
    await page.keyboard.press("Enter");

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __reminderHorizonWrites?: (number | null)[] })
              .__reminderHorizonWrites,
        ),
      )
      .toEqual([3]);
  });

  test("the horizon control is one tab stop, traversed with arrows", async ({ page }) => {
    // Announcing `role="radiogroup"` is a promise about the keyboard model, and
    // the first version of this control kept none of it: every segment carried
    // `tabIndex={0}`, so a four-option control was four tab stops and arrows did
    // nothing. A role whose contract is not honoured is worse than the
    // unannounced divs it replaced, because assistive technology now tells the
    // user something untrue about how to drive it.
    await installMockIpc(page, { prefs: { reminder_horizon_days: 7 } });
    await page.goto("/");
    await openPrivacy(page);

    const group = page.getByTestId("settings.reminders-horizon-picker");
    // Roving tabindex: exactly one segment is reachable by Tab, and it is the
    // selected one.
    await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
    await expect(page.getByTestId("settings.reminders-horizon-picker-7")).toHaveAttribute(
      "tabindex",
      "0",
    );

    // In a radiogroup an arrow SELECTS as it moves, so the write lands without
    // a second keystroke. 7 is the last of [1, 3, 5, 7], so one step right
    // wraps to the first.
    await page.getByTestId("settings.reminders-horizon-picker-7").focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __reminderHorizonWrites?: (number | null)[] })
              .__reminderHorizonWrites,
        ),
      )
      .toEqual([1]);
    await expect(page.getByTestId("settings.reminders-horizon-picker-1")).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  test("the horizon control is a radiogroup, not four unannounced divs", async ({ page }) => {
    // It ships on a phone, where the segments were `div`s with an `onClick`: no
    // role, no focus, no key handler, and no way for a spec to address one
    // except by its translated label. That last part is why this file had no
    // horizon-tap case for the first round of myne#508.
    await installMockIpc(page, { prefs: { reminder_horizon_days: 7 } });
    await page.goto("/");
    await openPrivacy(page);

    const group = page.getByTestId("settings.reminders-horizon-picker").getByRole("radiogroup");
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio")).toHaveCount(4);
  });

  test("the precise-delivery affordance is absent while nothing registers", async ({ page }) => {
    // myne#508 gated `ExactAlarmBlock` on `remindersReachTheOs()`, the same
    // predicate as the horizon line. It offers to make delivery precise, and
    // asks Android for the exact-alarm special access to do it, for a pass that
    // has no production caller: nothing is scheduled, so there is no
    // imprecision to fix. Requesting a permission Google requires a Play
    // Console declaration for, to improve a delivery that does not happen, is
    // the shape a store review is meant to catch.
    //
    // Seeded with `approximate`, which is the case that USED to render the row
    // and its fallback sentence, so this fails the moment the gate is dropped
    // rather than passing on a platform that would have hidden it anyway.
    await installMockIpc(page, {
      exactAlarm: "approximate",
      exactAlarmAfterRequest: "exact",
    });
    await page.goto("/");
    await openPrivacy(page);

    await expect(page.getByTestId("settings.reminders-row")).toBeVisible();
    await expect(page.getByTestId("settings.reminder-exact-row")).toHaveCount(0);
    await expect(page.getByTestId("settings.reminder-exact-helper")).toHaveCount(0);

    // And nothing was asked of the platform on the way past. The app never
    // opens that screen on its own, and with the block gated there is no button
    // that could.
    expect(
      await page.evaluate(
        () => (window as unknown as { __exactAlarmRequests?: number }).__exactAlarmRequests,
      ),
    ).toBeUndefined();
  });
});
