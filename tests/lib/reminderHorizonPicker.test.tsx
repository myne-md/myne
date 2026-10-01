// @vitest-environment jsdom
//
// The registration-horizon row (myne#508).
//
// What it covers is the gap the issue named, so every assertion is about the
// CHOICE reaching the setter rather than about the setter working:
// `setReminderHorizonDays` shipped with a Rust core, an ACL row and its own
// tests, and no caller on either client.
//
// Its own file because `reminderSettings.test.tsx` is about the switch's
// load-bearing copy and pins the platform tier by full-literal equality; this
// row is deliberately NOT gated on that tier (the horizon reaches
// `runReminderPass` on every build), so mixing the two would blur which
// assertions depend on it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { REMINDER_HORIZON_CHOICES, REMINDER_HORIZON_DAYS } from "../../src/lib/reminderSchedule";
import { ReminderHorizonSettings } from "../../src/components/settings/ReminderSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

afterEach(cleanup);

/** The picker's trigger. The row is a `Select` since myne-md/myne#769; its
 *  selected value rides on the trigger's `data-value` and its options exist
 *  only while the menu is open. */
const trigger = (): HTMLElement => screen.getByTestId("settings.reminders-horizon-picker");

/** Open the menu and return its options, in order. */
const openOptions = (): HTMLElement[] => {
  fireEvent.click(trigger());
  return screen.getAllByRole("option");
};

/** The open menu's option for `days`. Options share one testid (they are a
 *  portal'd list), so they are addressed by the `data-value` each carries. */
const option = (days: number): HTMLElement => {
  const found = openOptions().find((el) => el.dataset.value === String(days));
  if (found === undefined) throw new Error(`no horizon option for ${days}`);
  return found;
};

describe("the horizon row", () => {
  it("hands the chosen horizon to the caller's setter", () => {
    // The whole issue in one assertion: before this change nothing anywhere
    // called the setter, so a user who wanted a different registration window
    // had no way to ask for one.
    const onChange = vi.fn();
    render(
      <ReminderHorizonSettings
        enabled
        horizonDays={null}
        onChange={onChange}
        today="2026-07-28"
      />,
    );
    fireEvent.click(option(1));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("renders on this build rather than behind a tier that never activates", () => {
    // Gating the row on `showsInAppOnlyLimitation()` would hide it in every
    // shipping build, and would also satisfy `check-ipc-binding-callers.mjs`
    // with a branch nothing renders, the exact invisibility that let this bug
    // ship. The LINE is tier-gated; the control is not.
    render(
      <ReminderHorizonSettings
        enabled
        horizonDays={7}
        onChange={() => {}}
        today="2026-07-28"
      />,
    );
    expect(screen.getByTestId("settings.reminders-horizon-row")).toBeTruthy();
    // And the helper says what it bounds on this tier, so the control is never
    // a knob whose meaning is stated nowhere.
    expect(screen.getByTestId("settings.reminders-horizon-helper")).toBeTruthy();
  });

  it("announces the helper with the group, not just beside it", () => {
    // `SettingRow` generates the helper's id and hands it to the control's
    // render function; without `aria-describedby` the sentence is read as
    // unrelated text after the control, which for a setting whose meaning IS
    // that sentence is the same as not having one.
    render(
      <ReminderHorizonSettings
        enabled
        horizonDays={7}
        onChange={() => {}}
        today="2026-07-28"
      />,
    );
    const described = screen
      .getByTestId("settings.reminders-horizon-picker")
      .getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(screen.getByTestId("settings.reminders-horizon-helper").id).toBe(described);
  });

  it("offers the shared choices, and no others", () => {
    // Both clients render `REMINDER_HORIZON_CHOICES`; a picker holding its own
    // list is the drift #52 recorded about the date derivation, one step
    // earlier, on a preference that is device-local and so never reconciled.
    render(
      <ReminderHorizonSettings
        enabled
        horizonDays={7}
        onChange={() => {}}
        today="2026-07-28"
      />,
    );
    const offered = openOptions().map((el) => Number(el.dataset.value));
    expect(offered).toEqual([...REMINDER_HORIZON_CHOICES]);
  });

  it("shows the default for a vault that never set one", () => {
    // `null` is a legitimate persisted state meaning "the default", not an
    // error. A picker showing the shortest option instead would misreport the
    // window actually in force.
    render(
      <ReminderHorizonSettings
        enabled
        horizonDays={null}
        onChange={() => {}}
        today="2026-07-28"
      />,
    );
    expect(trigger().dataset.value).toBe(String(REMINDER_HORIZON_DAYS));
  });

  it("labels each option in the active locale, with no catalog key per option", () => {
    // `Intl.NumberFormat`'s unit style, not five keys saying "7d" in each of 32
    // catalogs. English is what the test locale resolves to; the point being
    // pinned is that the label is a formatted quantity rather than a raw number
    // or a missing-key string.
    render(
      <ReminderHorizonSettings
        enabled
        horizonDays={7}
        onChange={() => {}}
        today="2026-07-28"
      />,
    );
    // The trigger carries the CURRENT choice's label; the rest live in the
    // menu, so both halves are read where they actually render.
    expect(trigger().textContent).toBe("7 days");
    expect(option(1).textContent).toBe("1 day");
  });

  it("renders nothing at all while reminders are off", () => {
    // A window over a feature the switch above has turned off is a control for
    // a mechanism that is not running.
    render(
      <ReminderHorizonSettings
        enabled={false}
        horizonDays={7}
        onChange={() => {}}
        today="2026-07-28"
      />,
    );
    expect(screen.queryByTestId("settings.reminders-horizon-row")).toBeNull();
  });

  it("omits the horizon LINE while the build registers with no operating system", () => {
    // `reminderTier()` reports `in-app-only` on every platform in this build
    // (`reminderPlatform.ts`), so "registered through 3 August" would describe a
    // mechanism that is not running. The control stays; the sentence does not.
    render(
      <ReminderHorizonSettings
        enabled
        horizonDays={7}
        onChange={() => {}}
        today="2026-07-28"
      />,
    );
    expect(screen.queryByTestId("settings.reminders.horizon")).toBeNull();
  });
});
