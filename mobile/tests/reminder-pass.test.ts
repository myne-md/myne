// The bounded reminder pass (MYND-619 task 5).
//
// Delivery itself cannot be driven by any harness — whether the operating system
// actually fires a registration while Myne is closed is a manual measurement. So
// every property that CAN be tested is tested here, against a notifier that
// actually holds state rather than a stub, because a stub would agree with a
// pass that had quietly stopped reconciling.

import { describe, it, expect } from "vitest";
import type { PendingReminder, VaultTask } from "@myne/reminder-schedule";
import {
  boundedReminders,
  runBoundedReminderPass,
  REMINDER_MAX_PENDING,
  REMINDER_PLATFORM_CAP,
  REMINDER_VAULTS_PER_DEVICE,
} from "../src/lib/reminderPass";

/** A notifier that behaves like a platform: it remembers, and replaces by id. */
function fakeNotifier() {
  const held = new Map<string, string>();
  const calls: string[] = [];
  return {
    held,
    calls,
    notifier: {
      listPending: async (): Promise<readonly PendingReminder[]> =>
        [...held].map(([id, at]) => ({ id, at })),
      schedule: async (payload: { id: string; at: string }): Promise<void> => {
        calls.push(`schedule:${payload.id}`);
        held.set(payload.id, payload.at);
      },
      cancel: async (id: string): Promise<void> => {
        calls.push(`cancel:${id}`);
        held.delete(id);
      },
    },
  };
}

/** A line-task with a reminder at `remind`. Nothing else matters to the pass. */
function task(noteId: string, lineIndex: number, remind: string): VaultTask {
  return {
    noteId,
    noteTitle: null,
    noteFolder: null,
    lineIndex,
    rawLine: `- [ ] something [remind:: ${remind}]`,
    completed: false,
    oversized: false,
    remind,
  };
}

// Valid days are 2..7: NOW is 2026-08-01 08:00 and the horizon is 7 days, so
// 2026-08-08T09:00 is already past it. An out-of-horizon fixture would make
// the bound look like it bit when the horizon had done the work.
const at = (day: number, hour = 9): string =>
  `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00`;

/** 2026-08-01 08:00 local — before every instant the helpers above produce. */
const NOW = new Date(2026, 7, 1, 8, 0);
const clock = () => NOW;

describe("the bound is sized for a device, not for a vault", () => {
  // Registrations are per APP, not per vault — the platform has no idea vaults
  // exist — so several vaults on one device share one ceiling. If this
  // inequality ever stops holding, the platform starts silently dropping
  // registrations and nothing tells us which.
  it("leaves room for every vault the bound claims to account for", () => {
    expect(REMINDER_MAX_PENDING * REMINDER_VAULTS_PER_DEVICE).toBeLessThanOrEqual(
      REMINDER_PLATFORM_CAP,
    );
  });

  it("accounts for more than one vault", () => {
    expect(REMINDER_VAULTS_PER_DEVICE).toBeGreaterThan(1);
    expect(REMINDER_MAX_PENDING).toBeGreaterThan(0);
  });
});

describe("bounded selection", () => {
  const target: PendingReminder[] = [
    { id: "d", at: at(7) },
    { id: "b", at: at(3) },
    { id: "a", at: at(2) },
    { id: "c", at: at(5) },
  ];

  it("keeps the soonest, not the first seen", () => {
    expect(boundedReminders(target, 2).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns everything when the set is under the bound", () => {
    expect(boundedReminders(target, 10).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  // Not decoration: without a tie-break, two reminders at the same minute could
  // swap places between passes and the diff would report churn that is not there.
  it("breaks ties deterministically", () => {
    const same: PendingReminder[] = [
      { id: "z", at: at(2) },
      { id: "a", at: at(2) },
      { id: "m", at: at(2) },
    ];
    expect(boundedReminders(same, 2).map((r) => r.id)).toEqual(["a", "m"]);
    expect(boundedReminders([...same].reverse(), 2).map((r) => r.id)).toEqual(["a", "m"]);
  });

  it("does not mutate its input", () => {
    const before = target.map((r) => r.id);
    boundedReminders(target, 1);
    expect(target.map((r) => r.id)).toEqual(before);
  });

  it("registers nothing at a bound of zero", () => {
    expect(boundedReminders(target, 0)).toEqual([]);
    expect(boundedReminders(target, -1)).toEqual([]);
  });
});

describe("the pass registers a bounded set, not everything", () => {
  it("hands the platform exactly the soonest N", async () => {
    const { notifier, held } = fakeNotifier();
    const tasks = [task("n", 1, at(5)), task("n", 2, at(2)), task("n", 3, at(7))];

    const result = await runBoundedReminderPass({ tasks, notifier, clock, max: 2 });

    expect(result.scheduled).toBe(2);
    expect(result.failed).toBe(0);
    expect([...held.values()].sort()).toEqual([at(2), at(5)]);
  });

  it("is a no-op the second time", async () => {
    const { notifier, held, calls } = fakeNotifier();
    const tasks = [task("n", 1, at(5)), task("n", 2, at(2)), task("n", 3, at(7))];

    await runBoundedReminderPass({ tasks, notifier, clock, max: 2 });
    calls.length = 0;
    const second = await runBoundedReminderPass({ tasks, notifier, clock, max: 2 });

    expect(calls).toEqual([]);
    expect(second).toEqual({ scheduled: 0, cancelled: 0, failed: 0 });
    expect(held.size).toBe(2);
  });

  // The whole point of "replacing wholesale": a reminder pushed out of the bound
  // by a sooner one must be WITHDRAWN, not left registered. Otherwise the
  // platform accumulates exactly the registrations the bound exists to prevent.
  it("withdraws a reminder that a sooner one pushed out of the bound", async () => {
    const { notifier, held, calls } = fakeNotifier();
    const late = task("n", 1, at(7));
    const mid = task("n", 2, at(5));

    await runBoundedReminderPass({ tasks: [late, mid], notifier, clock, max: 2 });
    expect(held.size).toBe(2);

    calls.length = 0;
    const soon = task("n", 3, at(2));
    await runBoundedReminderPass({ tasks: [late, mid, soon], notifier, clock, max: 2 });

    expect(held.size).toBe(2);
    expect([...held.values()].sort()).toEqual([at(2), at(5)]);
    // Cancel precedes schedule — a moved set must never briefly hold both.
    expect(calls[0]?.startsWith("cancel:")).toBe(true);
    expect(calls.some((c) => c.startsWith("schedule:"))).toBe(true);
  });

  it("withdraws everything when the bound drops to zero", async () => {
    const { notifier, held } = fakeNotifier();
    const tasks = [task("n", 1, at(2)), task("n", 2, at(5))];

    await runBoundedReminderPass({ tasks, notifier, clock, max: 2 });
    const result = await runBoundedReminderPass({ tasks, notifier, clock, max: 0 });

    expect(result.cancelled).toBe(2);
    expect(held.size).toBe(0);
  });

  // Inherited from the shared core rather than reimplemented — asserted so a
  // future "optimisation" that stops delegating gets caught.
  it("still excludes completed tasks and instants beyond the horizon", async () => {
    const { notifier, held } = fakeNotifier();
    const done = { ...task("n", 1, at(2)), completed: true };
    const farAway = task("n", 2, "2026-12-31T09:00");
    const noReminder = { ...task("n", 3, at(3)), remind: undefined };

    await runBoundedReminderPass({
      tasks: [done, farAway, noReminder, task("n", 4, at(3))],
      notifier,
      clock,
      max: 10,
    });

    expect(held.size).toBe(1);
    expect([...held.values()]).toEqual([at(3)]);
  });

  // This runs from an unlock hook. An exception there would surface as a crash
  // for a feature the user may not even have enabled.
  it("never throws when the platform refuses everything", async () => {
    const hostile = {
      listPending: async (): Promise<readonly PendingReminder[]> => {
        throw new Error("no");
      },
      schedule: async (): Promise<void> => {
        throw new Error("no");
      },
      cancel: async (): Promise<void> => {
        throw new Error("no");
      },
    };

    const result = await runBoundedReminderPass({
      tasks: [task("n", 1, at(2))],
      notifier: hostile,
      clock,
      max: 10,
    });

    expect(result.failed).toBe(1);
    expect(result.scheduled).toBe(0);
  });
});

describe("no platform repeating trigger exists to be used", () => {
  // The payload that crosses the seam has nowhere to put a repeat rule, which is
  // a stronger guarantee than "we do not set one". Recurrence stays a vault-side
  // concept: one pending occurrence at a time, re-derived by the next pass.
  it("what is handed to the platform is only { id, at }", async () => {
    const seen: Record<string, unknown>[] = [];
    const notifier = {
      listPending: async (): Promise<readonly PendingReminder[]> => [],
      schedule: async (payload: PendingReminder): Promise<void> => {
        seen.push(payload as unknown as Record<string, unknown>);
      },
      cancel: async (): Promise<void> => {},
    };

    await runBoundedReminderPass({
      tasks: [{ ...task("n", 1, at(2)), repeat: "every week" }],
      notifier,
      clock,
      max: 10,
    });

    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).sort()).toEqual(["at", "id"]);
    expect(JSON.stringify(seen)).not.toContain("week");
  });
});
