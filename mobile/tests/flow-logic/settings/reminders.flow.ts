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
// checklist in `agent-tooling/docs/dev/reminders-device-checklist.md` — this spec deliberately
// asserts nothing about them rather than asserting something weaker and letting
// the checklist look redundant.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Settings → Privacy, where the reminder block lives (a block, not a rail entry). */
async function openPrivacy(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  // The rail row is labelled `settings.shell.panels.privacy` = "Privacy"
  // (myne-md/myne#880 task 12 aligned the mobile category to the desktop panel
  // name; it used to read "Privacy & security").
  await page.getByText("Privacy", { exact: true }).click();
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

  test("the horizon line names the delivery bound now that the pass has a caller", async ({
    page,
  }) => {
    // myne#508. "Reminders are registered through <date>" says an operating
    // system is holding these, and it was gated on `remindersReachTheOs()`
    // because the pass that would register them (`mobile/src/lib/reminderPass.ts`)
    // had no production caller. myne-md/myne#1037 gave it one
    // (`useMobileReminderPass`), so the predicate now answers `HAS_TAURI` and this
    // is the change its own comment said would flip the assertion: the sentence
    // is true here, and the inert helper is the one that is gone.
    await installMockIpc(page, { prefs: { reminder_horizon_days: 7 } });
    await page.goto("/");
    await openPrivacy(page);

    await expect(page.getByTestId("settings.reminders-horizon-picker")).toBeVisible();
    await expect(page.getByTestId("settings.reminders-horizon")).toContainText(
      "Reminders are registered through",
    );

    // And the row says which of the two it is. A bare label over four day
    // counts would leave a user acting on the horizon's documented privacy
    // reading with no bound in force and no way to know it.
    await expect(page.getByTestId("settings.reminders-horizon-helper")).toHaveText(
      "Reminders are set up this far in advance. Myne has to be open and unlocked for one to arrive.",
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
    );  });

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


    // **The focus half, which this case is named for and did not assert.**
    // Everything above is the WRITE path, which the preceding case already
    // covers, so the test passed with `segmentRefs.current[next]?.focus()`
    // deleted outright AND under the defect that was actually shipping: the ref
    // map recorded only the ACTIVE segment, so `focus()` on a non-active index
    // was a no-op by construction, and focus sat one step behind selection
    // permanently.
    //
    // Two assertions, because either alone still passes under that defect.
    // Focus must have MOVED to the newly selected segment, and the tab stop
    // must have moved with it, so exactly one segment remains reachable by Tab.
    await expect(page.getByTestId("settings.reminders-horizon-picker-1")).toBeFocused();
    await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
    await expect(page.getByTestId("settings.reminders-horizon-picker-1")).toHaveAttribute(
      "tabindex",
      "0",
    );

    // A SECOND press, which is what separates "focus lands once" from "focus
    // tracks selection". Under the shipped defect the second press fired from
    // the stale element, recomputed the same target and rewrote the same value,
    // so the write list stayed at [1] rather than growing.
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __reminderHorizonWrites?: (number | null)[] })
              .__reminderHorizonWrites,
        ),
      )
      .toEqual([1, 3]);
    await expect(page.getByTestId("settings.reminders-horizon-picker-3")).toBeFocused();
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

  test("the precise-delivery affordance is offered, and asks nothing until pressed", async ({
    page,
  }) => {
    // The same flip as the horizon line, and the same predicate: myne#508 gated
    // `ExactAlarmBlock` on `remindersReachTheOs()` because nothing was scheduled,
    // so there was no imprecision to fix. `useMobileReminderPass` schedules now
    // (myne-md/myne#1037), which makes the row the honest answer.
    //
    // Seeded with `approximate`, the state that renders the row and offers the
    // grant. The permission is still asked for ONLY on the press: opening
    // Settings must not request Android's exact-alarm special access, and the
    // counter is what makes that observable rather than assumed.
    await installMockIpc(page, {
      exactAlarm: "approximate",
      exactAlarmAfterRequest: "exact",
    });
    await page.goto("/");
    await openPrivacy(page);

    await expect(page.getByTestId("settings.reminders-row")).toBeVisible();
    await expect(page.getByTestId("settings.reminder-exact-row")).toBeVisible();
    await expect(page.getByTestId("settings.reminder-exact-helper")).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { __exactAlarmRequests?: number }).__exactAlarmRequests,
      ),
    ).toBeUndefined();

    await page.getByTestId("settings.reminder-exact-allow").click();

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __exactAlarmRequests?: number }).__exactAlarmRequests,
        ),
      )
      .toBe(1);
    // Granted, and the row stops offering what the user already did.
    await expect(page.getByTestId("settings.reminder-exact-value")).toHaveText("On");
    await expect(page.getByTestId("settings.reminder-exact-helper")).toHaveCount(0);
  });
});
