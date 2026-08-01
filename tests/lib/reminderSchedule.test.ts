// The reminder scheduling decision core (MYND-618 task 3).
//
// This is where the real coverage lives, and the reason is structural: whether
// the operating system actually fires a registration while Myne is closed is a
// **manual measurement** the harness cannot drive. So every property that can be
// tested is tested here, or it is not tested anywhere.

import { describe, expect, it } from "vitest";
import {
  diffReminders,
  REMINDER_HORIZON_DAYS,
  reminderId,
  runReminderPass,
  targetReminders,
  type PendingReminder,
  type ReminderNotifier,
} from "../../src/lib/reminderSchedule";
import type { VaultTask } from "../../src/notes/taskIndex";

const NOW = new Date(2026, 6, 28, 10, 0); // 2026-07-28 10:00 local

function task(over: Partial<VaultTask> & { noteId?: string }): VaultTask {
  return {
    noteId: over.noteId ?? "n1",
    noteTitle: "Bills",
    noteFolder: null,
    lineIndex: 0,
    rawLine: "- [ ] x",
    completed: false,
    oversized: false,
    ...over,
  } as VaultTask;
}

/** A notifier that records what it was asked to do. */
function notifier(pending: PendingReminder[] = []) {
  const calls = { scheduled: [] as string[], cancelled: [] as string[] };
  const impl: ReminderNotifier = {
    listPending: async () => pending,
    schedule: async (p) => void calls.scheduled.push(`${p.id}@${p.at}`),
    cancel: async (id) => void calls.cancelled.push(id),
  };
  return { impl, calls };
}

describe("the target set", () => {
  it("includes an upcoming reminder", () => {
    const set = targetReminders([task({ remind: "2026-07-30 09:00" })], NOW);
    expect(set).toEqual([{ id: "myne.reminder.n1.0", at: "2026-07-30T09:00" }]);
  });

  it("drops completed tasks", () => {
    // The work is done; a reminder would be noise.
    expect(targetReminders([task({ remind: "2026-07-30 09:00", completed: true })], NOW)).toEqual(
      [],
    );
  });

  it("drops a task with no reminder — a due date is not a request to be nudged", () => {
    // Treating `due` as a reminder would notify a user who never asked.
    expect(targetReminders([task({ due: "2026-07-30" })], NOW)).toEqual([]);
  });

  it("drops a task whose reminder arrived as a wire `null`, without throwing", () => {
    // Same shape as the undated case above, different failure. `VaultTask` says
    // `remind?: string`, but the `MYI1` row serializes `Option<String>` as
    // `null`, and this module is aliased into a client that hands its fetch's
    // rows in directly — so a `=== undefined` guard let the null through to
    // `instantOf`'s `raw.split(…)`. Inside a background pass that surfaces as an
    // unhandled rejection, which is why the mixed case is asserted too: the
    // throw would take the valid registration down with it.
    const wireNull = task({ remind: null } as unknown as Partial<VaultTask>);
    expect(targetReminders([wireNull], NOW)).toEqual([]);
    expect(
      targetReminders([wireNull, task({ noteId: "n2", remind: "2026-07-30 09:00" })], NOW),
    ).toEqual([{ id: "myne.reminder.n2.0", at: "2026-07-30T09:00" }]);
  });

  it("drops an instant already past", () => {
    // Firing late reads as the reminder being wrong, which is worse than
    // not firing at all.
    expect(targetReminders([task({ remind: "2026-07-28 09:00" })], NOW)).toEqual([]);
  });

  it("drops an instant beyond the horizon — a privacy bound, not a resource one", () => {
    // Pending times sit in OS-owned plaintext, so the fewer registered the
    // better (threat-model.md §7).
    const far = targetReminders([task({ remind: "2026-09-01 09:00" })], NOW);
    expect(far).toEqual([]);
  });

  it("includes the last instant inside the horizon", () => {
    const edge = targetReminders([task({ remind: "2026-08-04 09:00" })], NOW, 7);
    expect(edge).toHaveLength(1);
    expect(REMINDER_HORIZON_DAYS).toBe(7);
  });

  it("defaults a date-only reminder to 09:00, not midnight", () => {
    // Midnight would fire while the user is asleep, and a notification nobody
    // sees is the same as no notification.
    const set = targetReminders([task({ remind: "2026-07-30" })], NOW);
    expect(set[0]!.at).toBe("2026-07-30T09:00");
  });

  it("identifies a reminder by LOCATION, never by text", () => {
    // Editing a task's wording must not orphan its registration.
    const a = task({ remind: "2026-07-30 09:00", rawLine: "- [ ] call mother" });
    const b = task({ remind: "2026-07-30 09:00", rawLine: "- [ ] call mum" });
    expect(reminderId(a)).toBe(reminderId(b));
  });

  it("gives a note-task its own stable id", () => {
    expect(reminderId(task({ lineIndex: null }))).toBe("myne.reminder.n1.note");
  });

  it("is deterministically ordered, so two runs produce identical output", () => {
    const tasks = [
      task({ noteId: "z", remind: "2026-07-30 09:00" }),
      task({ noteId: "a", remind: "2026-07-30 09:00" }),
    ];
    expect(targetReminders(tasks, NOW).map((r) => r.id)).toEqual(
      targetReminders([...tasks].reverse(), NOW).map((r) => r.id),
    );
  });
});

describe("the diff", () => {
  const at = "2026-07-30T09:00";

  it("schedules what is missing", () => {
    expect(diffReminders([], [{ id: "a", at }])).toEqual({
      schedule: [{ id: "a", at }],
      cancel: [],
    });
  });

  it("cancels what is no longer wanted", () => {
    expect(diffReminders([{ id: "a", at }], [])).toEqual({ schedule: [], cancel: ["a"] });
  });

  it("does nothing for an unchanged reminder", () => {
    expect(diffReminders([{ id: "a", at }], [{ id: "a", at }])).toEqual({
      schedule: [],
      cancel: [],
    });
  });

  it("a MOVED reminder appears in both halves", () => {
    // No OS surface here offers an atomic move; pretending otherwise would
    // leave the old time registered and fire twice.
    const moved = diffReminders([{ id: "a", at }], [{ id: "a", at: "2026-07-31T09:00" }]);
    expect(moved.cancel).toEqual(["a"]);
    expect(moved.schedule).toEqual([{ id: "a", at: "2026-07-31T09:00" }]);
  });
});

describe("the pass", () => {
  it("registers the computed set", async () => {
    const { impl, calls } = notifier();
    const result = await runReminderPass(
      [task({ remind: "2026-07-30 09:00" })],
      impl,
      () => NOW,
    );
    expect(calls.scheduled).toEqual(["myne.reminder.n1.0@2026-07-30T09:00"]);
    expect(result).toEqual({ scheduled: 1, cancelled: 0, failed: 0 });
  });

  it("running it twice changes nothing the second time", async () => {
    // Idempotent by construction: the second pass diffs against the now-current
    // state and finds nothing to do.
    const pending: PendingReminder[] = [];
    const impl: ReminderNotifier = {
      listPending: async () => pending,
      schedule: async (p) => void pending.push({ id: p.id, at: p.at }),
      cancel: async (id) => {
        const i = pending.findIndex((r) => r.id === id);
        if (i >= 0) pending.splice(i, 1);
      },
    };
    const tasks = [task({ remind: "2026-07-30 09:00" })];

    const first = await runReminderPass(tasks, impl, () => NOW);
    const second = await runReminderPass(tasks, impl, () => NOW);
    expect(first.scheduled).toBe(1);
    expect(second).toEqual({ scheduled: 0, cancelled: 0, failed: 0 });
  });

  it("cancels BEFORE it schedules", async () => {
    // Scheduling first would briefly hold both times for a moved reminder, and
    // a duplicate notification is the failure a user actually notices.
    const order: string[] = [];
    const impl: ReminderNotifier = {
      listPending: async () => [{ id: "myne.reminder.n1.0", at: "2026-07-29T09:00" }],
      schedule: async () => void order.push("schedule"),
      cancel: async () => void order.push("cancel"),
    };
    await runReminderPass([task({ remind: "2026-07-30 09:00" })], impl, () => NOW);
    expect(order).toEqual(["cancel", "schedule"]);
  });

  it("cancels an orphan the task list no longer knows about", async () => {
    // A rebuilt or missing index cannot leave platform state behind: the target
    // set is recomputed from scratch, so anything not in it is cancelled
    // whatever put it there.
    const { impl, calls } = notifier([{ id: "myne.reminder.gone.3", at: "2026-07-30T09:00" }]);
    await runReminderPass([], impl, () => NOW);
    expect(calls.cancelled).toEqual(["myne.reminder.gone.3"]);
  });

  it("drops a completed task out of the registered set", async () => {
    const { impl, calls } = notifier([{ id: "myne.reminder.n1.0", at: "2026-07-30T09:00" }]);
    await runReminderPass([task({ remind: "2026-07-30 09:00", completed: true })], impl, () => NOW);
    expect(calls.cancelled).toEqual(["myne.reminder.n1.0"]);
    expect(calls.scheduled).toEqual([]);
  });

  it("moves a changed reminder within the set", async () => {
    const { impl, calls } = notifier([{ id: "myne.reminder.n1.0", at: "2026-07-29T09:00" }]);
    await runReminderPass([task({ remind: "2026-07-31 14:30" })], impl, () => NOW);
    expect(calls.cancelled).toEqual(["myne.reminder.n1.0"]);
    expect(calls.scheduled).toEqual(["myne.reminder.n1.0@2026-07-31T14:30"]);
  });

  it("the payload carries no task text — content-free by default", async () => {
    // The registration sits in OS-owned plaintext and can surface on a locked
    // screen. Putting the task's words there would hand content to a
    // shoulder-surfer for a convenience nobody asked for.
    const payloads: unknown[] = [];
    const impl: ReminderNotifier = {
      listPending: async () => [],
      schedule: async (p) => void payloads.push(p),
      cancel: async () => {},
    };
    await runReminderPass(
      [task({ remind: "2026-07-30 09:00", rawLine: "- [ ] call the oncologist" })],
      impl,
      () => NOW,
    );
    expect(JSON.stringify(payloads)).not.toContain("oncologist");
    expect(Object.keys(payloads[0] as object).sort()).toEqual(["at", "id"]);
  });
});

describe("it never throws", () => {
  it("survives a notifier that cannot list", async () => {
    // An unreadable current set is treated as empty: re-registering something
    // already registered is harmless, while giving up leaves the user with no
    // reminders at all.
    const impl: ReminderNotifier = {
      listPending: async () => {
        throw new Error("permission revoked");
      },
      schedule: async () => {},
      cancel: async () => {},
    };
    const result = await runReminderPass([task({ remind: "2026-07-30 09:00" })], impl, () => NOW);
    expect(result.scheduled).toBe(1);
  });

  it("survives a notifier that cannot schedule, and counts the failure", async () => {
    const impl: ReminderNotifier = {
      listPending: async () => [],
      schedule: async () => {
        throw new Error("platform unavailable");
      },
      cancel: async () => {},
    };
    const result = await runReminderPass([task({ remind: "2026-07-30 09:00" })], impl, () => NOW);
    expect(result).toEqual({ scheduled: 0, cancelled: 0, failed: 1 });
  });

  it("survives a notifier that cannot cancel", async () => {
    const impl: ReminderNotifier = {
      listPending: async () => [{ id: "a", at: "2026-07-30T09:00" }],
      schedule: async () => {},
      cancel: async () => {
        throw new Error("nope");
      },
    };
    await expect(runReminderPass([], impl, () => NOW)).resolves.toMatchObject({ failed: 1 });
  });

  it("one failure does not abandon the rest of the pass", async () => {
    let n = 0;
    const impl: ReminderNotifier = {
      listPending: async () => [],
      schedule: async () => {
        n++;
        if (n === 1) throw new Error("transient");
      },
      cancel: async () => {},
    };
    const result = await runReminderPass(
      [
        task({ noteId: "a", remind: "2026-07-30 09:00" }),
        task({ noteId: "b", remind: "2026-07-30 10:00" }),
      ],
      impl,
      () => NOW,
    );
    expect(result).toEqual({ scheduled: 1, cancelled: 0, failed: 1 });
  });

  it("the clock is injected — the same tasks give different sets at different times", async () => {
    const tasks = [task({ remind: "2026-07-30 09:00" })];
    expect(targetReminders(tasks, NOW)).toHaveLength(1);
    // Two days later the instant is in the past.
    expect(targetReminders(tasks, new Date(2026, 7, 1, 10, 0))).toHaveLength(0);
  });

  it("never reads an ambient clock", async () => {
    // Structural, asserted against the source: a module that reached for the
    // wall clock could not be tested at its boundaries at all, and the
    // boundaries are the whole difficulty here.
    //
    // (Spying on the global `Date` constructor was the first attempt and is a
    // trap — it replaces the constructor and every `.getFullYear()` on an
    // instance stops working.)
    const raw = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/reminderSchedule.ts", "utf-8"),
    );
    // Comments are stripped first: a source-level check that could match its
    // own documentation would fail for the wrong reason (it did, once).
    const code = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/new Date\(\s*\)/);
    expect(code).not.toContain("Date.now()");
  });
});
