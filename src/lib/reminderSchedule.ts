// The reminder scheduling decision core (MYND-618, task 3).
//
// A **pure** function from (task list, clock, horizon) to the set of reminders
// that should currently be registered, plus the diff against what is registered.
// The OS notifier is injected, following the existing scheduler-dependencies
// shape, so this is fully testable without any platform at all.
//
// That matters more here than usual: **delivery itself cannot be driven by the
// test harness.** Whether the operating system actually fires a registration
// while Myne is closed is a manual measurement, so every property that CAN be
// tested has to be tested here, or it is not tested anywhere.
//
// IDEMPOTENT BY CONSTRUCTION. The pass computes the target set and reconciles;
// running it twice produces no second-time change, because the second run's
// diff against the now-current state is empty. A rebuilt or missing index
// therefore cannot orphan platform state: the next pass cancels whatever is
// registered and no longer wanted, whatever put it there.
//
// THE HORIZON IS SHORT ON PURPOSE. Pending reminder times leave the AEAD
// envelope and sit in OS-owned plaintext (`threat-model.md` §7), so the fewer
// that are registered at a time, the less is exposed. It is a privacy bound
// first and a resource bound second.

import type { VaultTask } from "../notes/taskIndex";

// Re-exported so a consumer of this module needs only this module. Mobile
// reaches it through the `@myne/reminder-schedule` alias (MYND-619 task 5) and
// would otherwise have to name a relative path out of its own repository to
// spell the input type of the functions below.
export type { VaultTask };

/** How far ahead reminders are registered with the OS. */
export const REMINDER_HORIZON_DAYS = 7;

/** One reminder as the OS holds it. Content-free by design — see below. */
export type PendingReminder = {
  /**
   * Stable identity, derived from the task's location rather than its text, so
   * editing a task's wording does not orphan its registration.
   */
  readonly id: string;
  /** Local wall-clock instant, `YYYY-MM-DDTHH:MM`. */
  readonly at: string;
};

/**
 * What the OS is asked to show.
 *
 * **Content-free by default**: the body carries no task text and no note
 * identifier. The registration lives in OS-owned plaintext storage and can
 * surface on a locked screen, so putting the task's words in it would hand
 * content to a shoulder-surfer for a convenience nobody asked for.
 */
export type ReminderPayload = {
  readonly id: string;
  readonly at: string;
};

/** The injected OS surface. Every method may fail; none may throw upward. */
export type ReminderNotifier = {
  /** Currently registered reminders, as the OS reports them. */
  listPending: () => Promise<readonly PendingReminder[]>;
  schedule: (payload: ReminderPayload) => Promise<void>;
  cancel: (id: string) => Promise<void>;
};

/** Injected clock. This module never reads the wall clock itself. */
export type ReminderClock = () => Date;

/** Identity of a task's reminder: its note plus its line, never its text. */
export function reminderId(task: VaultTask): string {
  return `myne.reminder.${task.noteId}.${task.lineIndex ?? "note"}`;
}

/** `YYYY-MM-DDTHH:MM` from a stored instant, defaulting a missing time to 09:00. */
function instantOf(raw: string): string {
  const [date, time] = raw.split(/[ T]/);
  // A date with no time means "that day"; 09:00 local is the only defensible
  // default — midnight would fire while the user is asleep, and a
  // notification nobody sees is the same as no notification.
  return `${date}T${(time ?? "09:00").slice(0, 5)}`;
}

/** `Date` → the same `YYYY-MM-DDTHH:MM` local shape, for comparison. */
function localStamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}T${p(at.getHours())}:${p(at.getMinutes())}`;
}

/**
 * `YYYY-MM-DDTHH:MM` → a `Date` in the **local** zone.
 *
 * Local is the only reading that agrees with how the reminder was written: a
 * stored instant is a wall-clock time carrying no offset (`markdown-dialect.md`
 * §3.8 — an offset-bearing value does not type at all), so 09:00 means 09:00
 * where the user is. Built from explicit fields rather than `new Date(string)`,
 * whose treatment of a bare `T`-form has changed across engines and versions.
 *
 * Exported because both consumers that need it — the scheduler's sleep
 * computation and the in-app notifier's timer — would otherwise each carry
 * their own copy, and two parsers that disagree by an hour is a bug nobody
 * would look for.
 */
export function parseLocalInstant(at: string): Date {
  const [date, time] = at.split("T");
  const [y, m, d] = (date ?? "").split("-").map(Number);
  const [hh, mm] = (time ?? "").split(":").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
}

/**
 * The reminders that SHOULD be registered right now.
 *
 * Excluded, each for its own reason:
 *   - **completed tasks** — the work is done; a reminder would be noise;
 *   - **tasks with no `remind`** — a due date is not a request to be nudged,
 *     and treating it as one would notify a user who never asked. Tested
 *     `== null`, not `=== undefined`: the `MYI1` row serializes `Option<String>`
 *     as `null`, and this module is reached by clients that hand their fetch's
 *     rows straight in, so a strict-undefined check lets a `null` through to
 *     `instantOf`'s `raw.split(…)` — a throw inside a background pass, which
 *     surfaces as an unhandled rejection rather than as anything a user sees;
 *   - **instants in the past** — the moment has gone; firing late is worse
 *     than not firing, because it reads as the reminder being wrong;
 *   - **instants beyond the horizon** — see the privacy bound above.
 */
export function targetReminders(
  tasks: readonly VaultTask[],
  now: Date,
  horizonDays: number = REMINDER_HORIZON_DAYS,
): PendingReminder[] {
  const from = localStamp(now);
  const horizon = new Date(now.getTime() + horizonDays * 86_400_000);
  const to = localStamp(horizon);

  const out: PendingReminder[] = [];
  for (const task of tasks) {
    if (task.completed) continue;
    if (task.remind == null) continue;
    const at = instantOf(task.remind);
    if (at <= from || at > to) continue;
    out.push({ id: reminderId(task), at });
  }
  // Sorted so two runs over the same input produce byte-identical output — a
  // diff that depended on iteration order would report spurious churn.
  out.sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
  return out;
}

/** What a reconcile pass would do. Computed, so it can be asserted directly. */
export type ReminderDiff = {
  readonly schedule: readonly PendingReminder[];
  readonly cancel: readonly string[];
};

/**
 * The diff from `current` to `target`.
 *
 * A reminder whose **time changed** appears in both halves — cancel then
 * reschedule — because no OS surface here offers an atomic move, and pretending
 * otherwise would leave the old time registered.
 */
export function diffReminders(
  current: readonly PendingReminder[],
  target: readonly PendingReminder[],
): ReminderDiff {
  const currentById = new Map(current.map((r) => [r.id, r.at]));
  const targetById = new Map(target.map((r) => [r.id, r.at]));

  const schedule = target.filter((r) => currentById.get(r.id) !== r.at);
  const cancel = current
    .filter((r) => targetById.get(r.id) !== r.at)
    .map((r) => r.id);
  return { schedule, cancel };
}

/** The outcome of a pass. Failures are counted, never thrown. */
export type ReminderPassResult = {
  readonly scheduled: number;
  readonly cancelled: number;
  /** Operations the notifier refused. A pass with failures is still a pass. */
  readonly failed: number;
};

/**
 * Reconcile the OS registration set against the task list.
 *
 * **Never throws.** A notifier that fails — permission revoked, platform
 * unavailable, a transient error — must not take down the caller, because this
 * runs from an unlock hook and a periodic tick where an exception would surface
 * as a crash for a feature the user may not even have enabled. Failures are
 * counted and the pass continues; the next pass retries by construction, since
 * the target set is recomputed from scratch every time.
 */
export async function runReminderPass(
  tasks: readonly VaultTask[],
  notifier: ReminderNotifier,
  clock: ReminderClock,
  horizonDays: number = REMINDER_HORIZON_DAYS,
): Promise<ReminderPassResult> {
  let current: readonly PendingReminder[] = [];
  try {
    current = await notifier.listPending();
  } catch {
    // An unreadable current set is treated as empty: re-registering something
    // already registered is harmless (the OS replaces by id), while giving up
    // would leave the user with no reminders at all.
    current = [];
  }

  const target = targetReminders(tasks, clock(), horizonDays);
  const { schedule, cancel } = diffReminders(current, target);

  let scheduled = 0;
  let cancelled = 0;
  let failed = 0;

  // Cancel first. Scheduling first would briefly hold both the old and the new
  // time for a moved reminder, and a duplicate notification is the failure a
  // user actually notices.
  for (const id of cancel) {
    try {
      await notifier.cancel(id);
      cancelled++;
    } catch {
      failed++;
    }
  }
  for (const reminder of schedule) {
    try {
      await notifier.schedule({ id: reminder.id, at: reminder.at });
      scheduled++;
    } catch {
      failed++;
    }
  }

  return { scheduled, cancelled, failed };
}
