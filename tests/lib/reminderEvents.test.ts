// Event reminders (myne-md/myne#1037, task 9).
//
// An event note is a SECOND source for the reminder pass that already exists, not a
// second scheduler. So these cases are about the one thing that changes: which
// instants the same pass registers, and what it refuses.
//
// The properties under test are the ones the threat model names (MYND-618,
// `agent-tooling/docs/threat-model.md` §7): a content-free payload, a short horizon, no new
// timer. The payload case is asserted against the object the notifier receives
// rather than against the code that builds it, because "no title in the body" is a
// claim about the bytes on the OS side.

import { describe, expect, it } from "vitest";
import {
  REMINDER_HORIZON_DAYS,
  eventReminderId,
  runReminderPassFor,
  targetEventReminders,
  targetRemindersFor,
  type EventReminderSource,
  type PendingReminder,
  type ReminderNotifier,
} from "../../src/lib/reminderSchedule";
import type { VaultTask } from "../../src/notes/taskIndex";

const NOW = new Date(2026, 6, 28, 10, 0); // 2026-07-28 10:00 local

function event(over: Partial<EventReminderSource> = {}): EventReminderSource {
  return {
    noteId: "e1",
    start: "2026-07-28 11:00",
    allDay: false,
    occurrenceDate: null,
    remind: "30m",
    ...over,
  };
}

function task(over: Partial<VaultTask> = {}): VaultTask {
  return {
    noteId: "t1",
    noteTitle: "Bills",
    noteFolder: null,
    lineIndex: 0,
    rawLine: "- [ ] x",
    completed: false,
    oversized: false,
    remind: "2026-07-28T12:00",
    ...over,
  } as VaultTask;
}

describe("targetEventReminders", () => {
  it("registers the start minus the lead", () => {
    expect(targetEventReminders([event()], NOW)).toEqual([
      { id: "myne.reminder.event.e1.2026-07-28", at: "2026-07-28T10:30" },
    ]);
  });

  it("appears and disappears with the field, which is the whole switch", () => {
    expect(targetEventReminders([event({ remind: null })], NOW)).toEqual([]);
    expect(targetEventReminders([event({ remind: "" })], NOW)).toEqual([]);
    expect(targetEventReminders([event({ remind: "1h" })], NOW)).toHaveLength(1);
  });

  it("anchors an all-day event at the preference, since the file carries no hour", () => {
    // Tomorrow, so the anchor is not already in the past at NOW.
    // One minute is the grammar's floor, so it is the lead that reveals the anchor
    // exactly rather than one minute out.
    const tomorrow = event({
      start: "2026-07-29",
      allDay: true,
      remind: "1m",
      occurrenceDate: "2026-07-29",
    });
    expect(targetEventReminders([tomorrow], NOW, REMINDER_HORIZON_DAYS, "09:00")).toEqual([
      { id: "myne.reminder.event.e1.2026-07-29", at: "2026-07-29T08:59" },
    ]);
    // The same event under a later anchor is a DIFFERENT instant at the same id,
    // which `diffReminders` turns into a cancel plus a schedule.
    expect(targetEventReminders([tomorrow], NOW, REMINDER_HORIZON_DAYS, "18:00")).toEqual([
      { id: "myne.reminder.event.e1.2026-07-29", at: "2026-07-29T17:59" },
    ]);
  });

  it("still refuses an all-day reminder whose lead has already gone", () => {
    // Today at 09:00 with a two-hour lead is 07:00, which is behind NOW.
    expect(
      targetEventReminders([event({ start: "2026-07-28", allDay: true, remind: "2h" })], NOW),
    ).toEqual([]);
  });

  it("gives each occurrence its own identity, so a weekly series registers four times", () => {
    const series = ["2026-07-28", "2026-08-04", "2026-08-11", "2026-08-18"].map((day) =>
      event({
        noteId: "series-1",
        start: `${day} 11:00`,
        occurrenceDate: day,
        remind: "30m",
      }),
    );
    const got = targetEventReminders(series, NOW, 7);
    // Horizontally 7 days covers only the first occurrence, which is the horizon
    // doing its job rather than a projection bug.
    expect(got.map((r) => r.id)).toEqual(["myne.reminder.event.series-1.2026-07-28"]);
    expect(targetEventReminders(series, NOW, 7)).toHaveLength(1);
  });

  it("carries a moved event's reminder with it, at the same id", () => {
    const before = targetEventReminders([event({ start: "2026-07-28 11:00" })], NOW);
    const after = targetEventReminders([event({ start: "2026-07-28 15:00" })], NOW);
    expect(before[0]!.id).toBe(after[0]!.id);
    expect(before[0]!.at).toBe("2026-07-28T10:30");
    expect(after[0]!.at).toBe("2026-07-28T14:30");
  });

  it("registers nothing for a lead beyond the horizon", () => {
    // 30 days before an event two hours away is 30 days in the past: the window
    // refuses it without a second rule.
    expect(targetEventReminders([event({ remind: "30d" })], NOW)).toEqual([]);
  });

  it("registers nothing for an event past the horizon", () => {
    expect(targetEventReminders([event({ start: "2026-08-30 11:00" })], NOW)).toEqual([]);
  });

  it("never registers an instant that has already gone", () => {
    expect(targetEventReminders([event({ start: "2026-07-28 09:00" })], NOW)).toEqual([]);
  });
});

describe("one pass over both sources", () => {
  it("schedules a task's reminder and an event's together", () => {
    const got = targetRemindersFor({ tasks: [task()], events: [event()] }, NOW);
    expect(got.map((r) => r.id)).toEqual([
      "myne.reminder.event.e1.2026-07-28",
      "myne.reminder.t1.0",
    ]);
  });

  it("keeps the identities apart, so a task and an event cannot collide", () => {
    const got = targetRemindersFor(
      { tasks: [task({ noteId: "same" })], events: [event({ noteId: "same" })] },
      NOW,
    );
    expect(new Set(got.map((r) => r.id)).size).toBe(2);
  });

  it("hands the notifier a content-free payload", async () => {
    const asked: Array<{ id: string; at: string }> = [];
    const notifier: ReminderNotifier = {
      listPending: async () => [],
      schedule: async (payload) => {
        asked.push({ ...payload });
      },
      cancel: async () => {},
    };
    await runReminderPassFor(
      { tasks: [task()], events: [event({ remind: "30m" })] },
      notifier,
      () => NOW,
    );
    expect(asked.length).toBe(2);
    for (const payload of asked) {
      // Exactly two fields: no title, no note text, nothing that could surface on
      // a locked screen as content.
      expect(Object.keys(payload).sort()).toEqual(["at", "id"]);
      expect(JSON.stringify(payload)).not.toContain("Bills");
      expect(JSON.stringify(payload)).not.toContain("Dentist");
    }
  });

  it("cancels an event's registration when the lead is removed", async () => {
    const calls = { scheduled: [] as string[], cancelled: [] as string[] };
    const notifier: ReminderNotifier = {
      listPending: async () => [{ id: eventReminderId(event()), at: "2026-07-28T10:30" }],
      schedule: async (payload) => {
        calls.scheduled.push(payload.id);
      },
      cancel: async (id) => {
        calls.cancelled.push(id);
      },
    };
    await runReminderPassFor({ tasks: [], events: [event({ remind: null })] }, notifier, () => NOW);
    expect(calls.cancelled).toEqual(["myne.reminder.event.e1.2026-07-28"]);
    expect(calls.scheduled).toEqual([]);
  });

  it("is idempotent, so a re-run registers nothing and cancels nothing", async () => {
    const registered: PendingReminder[] = targetRemindersFor({ tasks: [], events: [event()] }, NOW);
    const calls = { scheduled: 0, cancelled: 0 };
    const notifier: ReminderNotifier = {
      listPending: async () => registered,
      schedule: async () => {
        calls.scheduled += 1;
      },
      cancel: async () => {
        calls.cancelled += 1;
      },
    };
    const result = await runReminderPassFor({ tasks: [], events: [event()] }, notifier, () => NOW);
    expect(result).toEqual({ scheduled: 0, cancelled: 0, failed: 0 });
  });
});
