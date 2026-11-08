// The reminder scheduling decision core (MYND-618 task 3).
//
// This is where the real coverage lives, and the reason is structural: whether
// the operating system actually fires a registration while Myne is closed is a
// **manual measurement** the harness cannot drive. So every property that can be
// tested is tested here, or it is not tested anywhere.

import { describe, expect, it } from "vitest";
import {
  diffReminders,
  horizonEndDate,
  REMINDER_HORIZON_CHOICES,
  REMINDER_HORIZON_DAYS,
  reminderId,
  resolveHorizonDays,
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

  it("includes the last instant inside the horizon, and nothing on the day after", () => {
    // NOW is 2026-07-28, so a 7-day horizon covers through 2026-08-03: today
    // plus six, the day `horizonEndDate` names and the settings line states.
    //
    // The second half is the assertion that changed in myne#508. The cutoff was
    // a rolling `now + N × 86_400_000`, so 08-04 09:00 was admitted while the
    // line said "through 3 August". The display and the registered set were
    // two different claims about one bound, and at N=1 the gap was a whole day
    // of instants the user was told were not registered.
    expect(horizonEndDate(NOW, 7)).toBe("2026-08-03");
    expect(targetReminders([task({ remind: "2026-08-03 23:00" })], NOW, 7)).toHaveLength(1);
    expect(targetReminders([task({ remind: "2026-08-04 09:00" })], NOW, 7)).toEqual([]);
    expect(REMINDER_HORIZON_DAYS).toBe(7);
  });

  it("empties at the last minute of the day on a one-day horizon, and refills after midnight", () => {
    // `from` and `to` are the same string during that minute, so the set is
    // empty. Correct rather than degenerate: a one-day horizon covers today,
    // and at 23:59 no instant today is still in the future. What it costs is
    // one minute of churn at the boundary, because the pass cancels what it
    // holds and re-registers on the other side. Pinned so the shape is a
    // recorded property, not something the OS tier discovers.
    const lastMinute = new Date(2026, 6, 28, 23, 59);
    const tomorrow = [task({ remind: "2026-07-29 09:00" })];
    expect(targetReminders(tomorrow, lastMinute, 1)).toEqual([]);

    // One minute later it is a new day, and tomorrow's reminder is today's.
    const justAfter = new Date(2026, 6, 29, 0, 0);
    expect(targetReminders(tomorrow, justAfter, 1)).toHaveLength(1);

    // The wider horizons have no such minute: 3 days from 23:59 still reaches
    // into the days after it.
    expect(targetReminders(tomorrow, lastMinute, 3)).toHaveLength(1);
  });

  it("registers a midnight reminder at horizon 1, which the two bounds used to drop between them", () => {
    // The case the test above sidesteps by using 09:00. An instant at exactly
    // 00:00 is excluded by `at > to` on the previous day, whose `to` is that
    // day's 23:59, and a pass re-runs within 60 s, so the first pass of the new
    // day sees `from` equal to the instant. Under `at <= from` it was in the
    // target set on neither side of midnight and no timer was ever armed for it.
    const midnight = [task({ remind: "2026-07-29 00:00" })];

    // The previous day: correctly out of range, and it is `to` that excludes it.
    const dayBefore = new Date(2026, 6, 28, 23, 59);
    expect(targetReminders(midnight, dayBefore, 1)).toEqual([]);

    // The first pass of the new day, where `from` is the instant itself. This is
    // the assertion that fails under `at <= from`.
    const atMidnight = new Date(2026, 6, 29, 0, 0);
    expect(targetReminders(midnight, atMidnight, 1)).toHaveLength(1);

    // One minute later it is past, and past instants are still skipped. Stated
    // so the fix cannot be read as admitting overdue reminders: it widens the
    // lower bound by exactly one minute, the one the instant is due in.
    const laterThatDay = new Date(2026, 6, 29, 0, 1);
    expect(targetReminders(midnight, laterThatDay, 1)).toEqual([]);
  });

  it("skips an instant strictly in the past and admits one due this minute", () => {
    // The other half of moving the bound from `<=` to `<`, so the change cannot
    // be read as admitting overdue reminders. `from` is minute-resolution.
    const now = new Date(2026, 6, 29, 9, 0);
    expect(targetReminders([task({ remind: "2026-07-29 09:00" })], now, 1)).toHaveLength(1);
    expect(targetReminders([task({ remind: "2026-07-29 08:59" })], now, 1)).toEqual([]);
  });

  it("covers today and only today at the shortest horizon", () => {
    // The choice the issue was actually asking for, and the one where a rolling
    // 24-hour cutoff was most obviously wrong: "registered through today" has
    // to mean today.
    expect(targetReminders([task({ remind: "2026-07-28 23:00" })], NOW, 1)).toHaveLength(1);
    expect(targetReminders([task({ remind: "2026-07-29 09:00" })], NOW, 1)).toEqual([]);
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

// #52: the horizon END DATE lives next to the cutoff it describes.
//
// The two clients derived it independently and drifted: desktop rendered
// `today + (N - 1)` and mobile rendered `today + N`, so the same vault told two
// devices two different dates — and mobile's was a day LATER than any reminder
// `targetReminders` would actually register.
describe("horizonEndDate", () => {
  it("is inclusive of today", () => {
    // A 1-day horizon covers today and nothing else.
    expect(horizonEndDate(new Date(2026, 7, 3, 9, 0), 1)).toBe("2026-08-03");
    expect(horizonEndDate(new Date(2026, 7, 3, 9, 0), 7)).toBe("2026-08-09");
  });

  it("crosses month and year boundaries in the LOCAL calendar", () => {
    // A UTC-based shift would name the wrong day for anyone far enough east or
    // west, on a line whose entire job is being checkable against a calendar.
    expect(horizonEndDate(new Date(2026, 0, 31, 23, 30), 7)).toBe("2026-02-06");
    expect(horizonEndDate(new Date(2026, 11, 31, 0, 30), 2)).toBe("2027-01-01");
    expect(horizonEndDate(new Date(2028, 1, 28, 12, 0), 2)).toBe("2028-02-29");
  });

  it("defaults to the shared horizon", () => {
    const today = new Date(2026, 7, 1, 12, 0);
    expect(horizonEndDate(today)).toBe(horizonEndDate(today, REMINDER_HORIZON_DAYS));
  });

  it("never names a day past the cutoff targetReminders enforces", () => {
    // The property the drift violated: every date the line claims must be one
    // the scheduler would actually register a reminder for.
    const today = new Date(2026, 7, 3, 0, 0);
    const end = horizonEndDate(today, REMINDER_HORIZON_DAYS);
    const cutoff = new Date(
      today.getTime() + REMINDER_HORIZON_DAYS * 86_400_000,
    );
    const p = (n: number): string => String(n).padStart(2, "0");
    const cutoffDay = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())}`;
    expect(end <= cutoffDay).toBe(true);
  });
});

// The two clients must name the SAME day for the same horizon (#52). The
// signatures differ by input type — desktop holds a `YYYY-MM-DD` string, mobile
// holds a `Date` — which is why the shared helper did not simply replace both;
// what matters is that the derivations agree.
describe("horizon date parity across clients", () => {
  it("agrees with the desktop settings line", async () => {
    const { horizonThrough } = await import(
      "../../src/components/settings/ReminderSettings"
    );
    // Every value a client can actually hold: the four offered choices, plus
    // `null` for a vault that never chose one. Both sides take the STORED
    // value, so both resolve it the same way; passing a raw out-of-range number
    // to `horizonEndDate` would compare a resolved input against an unresolved
    // one and prove nothing about either.
    for (const days of [...REMINDER_HORIZON_CHOICES, null]) {
      const today = new Date(2026, 0, 31, 12, 0);
      expect(horizonThrough(days, "2026-01-31")).toBe(
        horizonEndDate(today, resolveHorizonDays(days)),
      );
    }
  });

  it("names the same day for a stored horizon neither client offers", async () => {
    // A hand-edited blob or a future build can store anything. Both clients
    // clamp through `resolveHorizonDays`, so they agree on what it means rather
    // than one of them honouring it and the other not.
    const { horizonThrough } = await import(
      "../../src/components/settings/ReminderSettings"
    );
    const today = new Date(2026, 0, 31, 12, 0);
    // `4` is the case the endpoints hide. `0`, `-3` and `999` all clamp ONTO a
    // member of the choice set, so a version of `resolveHorizonDays` that
    // snapped to the nearest offered choice would pass them too. Four is
    // in-range and off-set, which is the only input that tells the two
    // behaviours apart.
    for (const stored of [0, -3, 999, 4]) {
      expect(horizonThrough(stored, "2026-01-31")).toBe(
        horizonEndDate(today, resolveHorizonDays(stored)),
      );
    }
  });

  it("clamps at the derivation, so a caller cannot opt out by passing a raw value", () => {
    // `targetReminders` and `horizonEndDate` still carry
    // `horizonDays: number = REMINDER_HORIZON_DAYS`, which is an opt-in bound:
    // a caller handing a stored value straight in opts out by omission, and
    // mobile's pass is the next thing that will do exactly that. A stored `0`
    // reaching them unclamped names YESTERDAY, so the cutoff falls before
    // `from` and the pass withdraws every reminder the notifier holds.
    expect(horizonEndDate(NOW, 0)).toBe(horizonEndDate(NOW, 1));
    expect(targetReminders([task({ remind: "2026-07-28 23:00" })], NOW, 0)).toHaveLength(1);
    expect(targetReminders([task({ remind: "2026-07-28 23:00" })], NOW, -5)).toHaveLength(1);
    // And the ceiling, from the other side: a value past the default cannot
    // widen the window threat-model.md 7 accepts.
    expect(horizonEndDate(NOW, 999)).toBe(horizonEndDate(NOW, REMINDER_HORIZON_DAYS));
  });

  it("clamps into the range and does NOT snap onto the offered set", () => {
    // The scheduler has to honour the horizon actually stored: snapping `4` to a
    // neighbouring choice would make the pass register a window the user never
    // asked for, so what an off-set value costs is a picker with no segment
    // selected rather than a wrong one. Both clients resolve through this, so
    // both show the same nothing.
    expect(resolveHorizonDays(4)).toBe(4);
    expect([...REMINDER_HORIZON_CHOICES]).not.toContain(4);
    expect((REMINDER_HORIZON_CHOICES as readonly number[]).indexOf(resolveHorizonDays(4))).toBe(-1);

    // The range ends are what it does clamp, and `0` is the one that mattered:
    // `??` passed it through, and a zero-day horizon renders "registered through
    // yesterday" while registering nothing at all.
    expect(resolveHorizonDays(0)).toBe(1);
    expect(resolveHorizonDays(-3)).toBe(1);
    expect(resolveHorizonDays(999)).toBe(REMINDER_HORIZON_DAYS);
    expect(resolveHorizonDays(2.7)).toBe(2);
    // `NaN` is the value the clamp alone cannot catch: `Math.max(NaN, 1)` and
    // `Math.min(NaN, 7)` are both `NaN`, and a `NaN` horizon builds the cutoff
    // string "NaN-NaN-NaNT23:59", which every real instant sorts below. The
    // bound would vanish in the widest direction on exactly the input this
    // function exists to survive.
    expect(resolveHorizonDays(Number.NaN)).toBe(REMINDER_HORIZON_DAYS);
    expect(resolveHorizonDays(Number.POSITIVE_INFINITY)).toBe(REMINDER_HORIZON_DAYS);
    expect(targetReminders([task({ remind: "2026-09-01 09:00" })], NOW, Number.NaN)).toEqual([]);
  });
});

// The picker's option set is shared for the reason #52 recorded about the date
// derivation: two clients deriving the same thing apart is how one vault told
// two devices two different answers. These hold the SET to the properties both
// clients' renderers assume of it.
describe("the horizon choices (myne#508)", () => {
  it("is an ascending set of whole positive days containing the default", () => {
    // Four properties of one array, because they fail together and a reader
    // asking "what must this list satisfy" wants one place to look.
    //
    // The default's membership is the load-bearing one: both pickers resolve
    // `resolveHorizonDays(stored)` to an index, and a default outside the list
    // resolves to -1, which renders no selected segment at all for a vault
    // whose real horizon is seven days. Zero or a negative would register
    // nothing while the copy still said "registered through <date>", and a
    // fraction would make `shiftDay` produce a non-date.
    const days = [...REMINDER_HORIZON_CHOICES];
    expect(days).toContain(REMINDER_HORIZON_DAYS);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
    expect(new Set(days).size).toBe(days.length);
    for (const d of days) {
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThan(0);
    }
  });

  it("stays inside `Segmented`'s option band, which is what keeps both pickers one shape", () => {
    // `agent-tooling/docs/design/README.md` ("Which picker"): `Segmented` is 2-4 options and
    // `Select` takes over at 5. A fifth choice would push the desktop into a
    // dropdown while mobile kept a segmented control, so the count is a design
    // constraint rather than a preference.
    expect(REMINDER_HORIZON_CHOICES.length).toBeGreaterThanOrEqual(2);
    expect(REMINDER_HORIZON_CHOICES.length).toBeLessThanOrEqual(4);
  });

  it("resolves a never-set horizon to the default and an explicit one to itself", () => {
    // `null` is a legitimate persisted state, not an error. Both clients' lines
    // and both clients' pickers go through this, so it is the one place the
    // question is answered.
    expect(resolveHorizonDays(null)).toBe(REMINDER_HORIZON_DAYS);
    expect(resolveHorizonDays(1)).toBe(1);
  });
});
