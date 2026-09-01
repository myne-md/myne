// @vitest-environment jsdom
//
// The Android precise-delivery affordance, driven directly (MYND-619 task 6).
//
// **This file exists because myne#508 gated the block off the settings sheet
// and would otherwise have taken its coverage with it.** `ExactAlarmBlock` now
// renders only when `remindersReachTheOs()` is true, which is `false` today: no
// mobile build registers a reminder with an operating system, so offering to
// make delivery precise, and asking Android for the `SCHEDULE_EXACT_ALARM`
// special access to do it, would be asking for a Play-Console-declared
// permission to sharpen a delivery that never happens.
//
// The flow-logic spec that used to prove the request path went through the
// sheet, so gating the block made those assertions unreachable and they were
// replaced by an absence check. That is the right assertion for the sheet and
// the wrong place to leave the request path: the predicate flips on the change
// that wires `mobile/src/lib/reminderPass.ts`, the block returns, and the flow
// it returns with would have had no end-to-end proof left anywhere.
//
// So the block is driven here instead of through the screen. The gate is the
// sheet's; the behaviour is the block's, and it stays covered while the gate is
// shut.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExactAlarmBlock } from "../src/components/ReminderSettings";
import { REMINDER_APPROXIMATE_DELIVERY_SENTENCE } from "../src/lib/load-bearing-copy";
import type { ExactAlarmApi, ReminderExactness } from "../src/lib/reminders";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

afterEach(cleanup);

/** The platform surface, as the block injects it in tests. `afterRequest` is
 *  how the granted-and-came-back case is driven: a mock cannot leave the app. */
function api(status: ReminderExactness, afterRequest?: ReminderExactness) {
  const calls = { requests: 0 };
  let current = status;
  const impl: ExactAlarmApi = {
    status: async () => current,
    request: async () => {
      calls.requests += 1;
      if (afterRequest !== undefined) current = afterRequest;
    },
  };
  return { impl, calls };
}

describe("the precise-delivery block", () => {
  it("renders nothing where the permission does not exist", async () => {
    // iOS, or any platform without the concept. A row saying "not applicable"
    // would be a caveat about a limitation the user's phone does not have.
    const { impl } = api("not-applicable");
    const resolved = vi.fn();
    render(<ExactAlarmBlock api={impl} onResolved={resolved} />);
    await waitFor(() => expect(resolved).toHaveBeenCalledWith("not-applicable"));
    expect(screen.queryByTestId("settings.reminder-exact-row")).toBeNull();
    expect(screen.queryByTestId("settings.reminder-exact-helper")).toBeNull();
  });

  it("states the fallback verbatim and asks for nothing on its own", async () => {
    // The sentence is load-bearing copy: its wording is a promise about
    // behaviour, so it is asserted by full literal. A substring match would
    // pass a future softening.
    const { impl, calls } = api("approximate");
    const resolved = vi.fn();
    render(<ExactAlarmBlock api={impl} onResolved={resolved} />);
    await waitFor(() => expect(resolved).toHaveBeenCalledWith("approximate"));

    expect(screen.getByTestId("settings.reminder-exact-helper").textContent).toBe(
      REMINDER_APPROXIMATE_DELIVERY_SENTENCE,
    );
    // Nothing is consumed by opening the platform screen, so there is nothing to
    // spend and no reason to open it unasked. The app never does.
    expect(calls.requests).toBe(0);
  });

  it("opens the platform screen only when asked, and re-reads on return", async () => {
    // `request()` opens a settings screen rather than a one-shot dialog, so the
    // state is re-read when the user comes back: the row stops offering
    // something they have already done, and the caveat is withdrawn.
    const { impl, calls } = api("approximate", "exact");
    const resolved = vi.fn();
    render(<ExactAlarmBlock api={impl} onResolved={resolved} />);
    await waitFor(() => expect(resolved).toHaveBeenCalledWith("approximate"));

    fireEvent.click(screen.getByTestId("settings.reminder-exact-allow"));
    await waitFor(() => expect(resolved).toHaveBeenCalledWith("exact"));

    expect(calls.requests).toBe(1);
    // The readout replaces the button. Asserted by presence rather than by
    // text: `i18n` is not initialised in this environment, so `t()` returns the
    // key, and the only string here whose exact wording is a promise is the
    // load-bearing sentence above, which is a constant rather than a key.
    expect(screen.getByTestId("settings.reminder-exact-value")).toBeTruthy();
    expect(screen.queryByTestId("settings.reminder-exact-allow")).toBeNull();
    expect(screen.queryByTestId("settings.reminder-exact-helper")).toBeNull();
  });

  it("treats a surface that cannot answer as approximate, never as exact", async () => {
    // Showing the caveat when it was not needed is a smaller failure than a
    // reminder quietly arriving late after the app implied it would not.
    const impl: ExactAlarmApi = {
      status: async () => {
        throw new Error("no such screen on this build");
      },
      request: async () => {},
    };
    const resolved = vi.fn();
    render(<ExactAlarmBlock api={impl} onResolved={resolved} />);
    await waitFor(() => expect(resolved).toHaveBeenCalledWith("approximate"));
    expect(screen.getByTestId("settings.reminder-exact-helper")).toBeTruthy();
  });
});
