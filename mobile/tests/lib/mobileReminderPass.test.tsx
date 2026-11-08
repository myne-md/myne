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
      rows: [
        {
          noteId: "standup",
          title: "Standup",
          folder: "Calendar/",
          calendar: null,
          start: "2026-11-10 09:15",
          end: null,
          allDay: false,
          occurrenceOf: "standup",
          occurrenceDate: "2026-11-10",
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
          start: "2026-11-11 09:15",
          end: null,
          allDay: false,
          occurrenceOf: null,
          occurrenceDate: null,
          conflicts: false,
          repeat: null,
          remind: null,
          repeatUnrecognized: false,
        },
      ],
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
      tasks: [
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
      ],
      reload: () => undefined,
    }),
  };
});

import { resetPermissionAsk, useMobileReminderPass } from "../../src/lib/useMobileReminderPass";

beforeEach(() => {
  resetPermissionAsk();
  calls.length = 0;
  permission.status = "not-determined";
  permission.requested = 0;
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

  it("asks for the notification permission once, and only when it has never been decided", async () => {
    const first = renderHook(() => useMobileReminderPass());
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    first.unmount();
    // A second mount inside one app run must not ask again: the prompt is a question,
    // not a habit.
    const second = renderHook(() => useMobileReminderPass());
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
    second.unmount();
    // EXACTLY once: 0 is the defect this change exists to fix (a permission never
    // requested, so a notification is registered and never delivered) and 2 is the
    // opposite (a prompt a user meets on every unlock).
    expect(permission.requested).toBe(1);
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
