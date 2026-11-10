// @vitest-environment jsdom
// The phone's reminder pass actually runs (myne-md/myne#1037).
//
// Two claims, and they are the two that were false before this existed: the pass is
// CALLED by production, and the calendar reaches it beside the tasks. The scheduling
// library itself is tested where it lives; what is asserted here is the wiring.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const calls: unknown[] = [];
const permission = { asked: 0, status: "not-determined" as string, requested: 0 };
/** Whether the mocked vault holds anything a reminder would be registered for. The
 *  permission prompt turns on this, so a test has to be able to turn it off — and the
 *  rows have to be FUTURE-dated, because a reminder that has already passed is not
 *  registered and would answer the wrong question. */
const localCivil = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const inAnHour = (): Date => new Date(Date.now() + 3_600_000);
const data = { withReminders: true, eventStart: "" };

vi.mock("../../src/lib/reminderPass", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/reminderPass")>();
  return {
    ...actual,
    runBoundedReminderPass: async (options: unknown) => {
      calls.push(options);
      return { scheduled: 1, cancelled: 0, failed: 0 };
    },
  };
});

vi.mock("../../src/lib/reminders", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/reminders")>();
  return {
    ...actual,
    remindersReachTheOs: () => true,
    createReminderNotifier: () => ({
      listPending: async () => [],
      schedule: async () => undefined,
      cancel: async () => undefined,
      cancelAll: async () => undefined,
    }),
    createReminderPermissionApi: () => ({
      status: async () => permission.status,
      request: async () => {
        permission.requested += 1;
        return "granted";
      },
    }),
  };
});

vi.mock("../../src/lib/calendar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/calendar")>();
  return {
    ...actual,
    vaultIndicesCalendarRange: async () => ({
      rows: data.withReminders
        ? [
        {
          noteId: "standup",
          title: "Standup",
          folder: "Calendar/",
          calendar: null,
          start: data.eventStart,
          end: null,
          allDay: false,
          occurrenceOf: "standup",
          occurrenceDate: data.eventStart.slice(0, 10),
          conflicts: false,
          repeat: "every tuesday",
          remind: "10m",
          repeatUnrecognized: false,
        },
        {
          noteId: "no-lead",
          title: "No reminder",
          folder: "Calendar/",
          calendar: null,
          start: data.eventStart,
          end: null,
          allDay: false,
          occurrenceOf: null,
          occurrenceDate: null,
          conflicts: false,
          repeat: null,
          remind: null,
          repeatUnrecognized: false,
        },
          ]
        : [],
    }),
  };
});

vi.mock("../../src/lib/use-prefs", () => ({
  usePrefs: () => ({
    prefs: {
      reminders_enabled: true,
      reminder_horizon_days: 7,
      calendar_settings: { day_reminder_anchor: "08:00" },
    },
  }),
}));

vi.mock("../../src/lib/tasks", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lib/tasks")>();
  return {
    ...actual,
    useVaultTasks: () => ({
      tasks: data.withReminders
        ? [
        {
          noteId: "task-note",
          noteTitle: "Weekly review",
          noteFolder: "Notes/",
          lineIndex: 3,
          rawLine: "- [ ] Weekly review [due:: 2026-11-06]",
          completed: false,
          oversized: false,
          due: "2026-11-06",
        },
      ]
        : [],
      reload: () => undefined,
    }),
  };
});

import { resetPermissionAsk, useMobileReminderPass } from "../../src/lib/useMobileReminderPass";
import { TASK_WRITE_EVENT } from "../../src/lib/tasks";

beforeEach(() => {
  resetPermissionAsk();
  calls.length = 0;
  permission.status = "not-determined";
  permission.requested = 0;
  data.withReminders = true;
  data.eventStart = localCivil(inAnHour());
});

describe("useMobileReminderPass", () => {
  it("runs the pass with the tasks and the calendar's events", async () => {
    renderHook(() => useMobileReminderPass());
    await waitFor(() => expect(calls).toHaveLength(1));
    const options = calls[0] as { tasks: unknown[]; events: unknown[]; dayAnchor?: string };
    expect(options.tasks).toHaveLength(1);
    expect(options.events).toHaveLength(1);
    // The all-day anchor travels, or an all-day event's lead would count back from the
    // module default instead of the hour the user chose.
    expect(options.dayAnchor).toBe("08:00");
  });

  it("asks for the notification permission once, and never on the pass that opens the app", async () => {
    const mounted = renderHook(() => useMobileReminderPass());
    await waitFor(() => expect(calls).toHaveLength(1));
    // The MOUNT pass is the unlock, and it must ask nothing: that launch-time prompt
    // is what the owner reported, and Apple's guidance is to avoid requesting
    // permission at launch.
    expect(permission.requested).toBe(0);

    // A write is the moment the dialog explains itself: the user has just made
    // something a reminder would be registered for.
    window.dispatchEvent(new Event(TASK_WRITE_EVENT));
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(permission.requested).toBe(1));

    // A second write in the same app run asks nothing more: the prompt is a question,
    // not a habit.
    window.dispatchEvent(new Event(TASK_WRITE_EVENT));
    await waitFor(() => expect(calls.length).toBeGreaterThan(2));
    mounted.unmount();
    // EXACTLY once: 0 is the defect the previous change fixed (a permission never
    // requested, so a notification is registered and never delivered) and 2 is the
    // opposite (a prompt a user meets over and over).
    expect(permission.requested).toBe(1);
  });

  it("never asks a device that has no reminder to register", async () => {
    // The other half of the launch prompt: `reminders_enabled` defaults ON, so the
    // first pass always ran and the old code always asked. A device with nothing due
    // has no reminder for the dialog to be about.
    data.withReminders = false;
    renderHook(() => useMobileReminderPass());
    await waitFor(() => expect(calls).toHaveLength(1));
    window.dispatchEvent(new Event(TASK_WRITE_EVENT));
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
    expect(permission.requested).toBe(0);
  });

  it("hands the pass only the events that carry a lead", async () => {
    // Through the pass rather than through the mapper: the mapper is internal, and
    // what matters is the list the scheduler actually receives.
    renderHook(() => useMobileReminderPass());
    await waitFor(() => expect(calls).toHaveLength(1));
    const options = calls[0] as { events: { remind: string | null }[] };
    expect(options.events).toHaveLength(1);
    expect(options.events[0]?.remind).toBe("10m");
  });
});
