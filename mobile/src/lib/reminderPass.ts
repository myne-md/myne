// The mobile reminder pass: the shared decision core, plus a bound (MYND-619,
// task 5).
//
// Mobile inherits the whole reconciliation model from `@myne/reminder-schedule`
// — the target set, the diff, cancel-before-schedule, idempotence — and adds
// exactly one thing: **a ceiling on how many reminders are handed to the
// platform at once.** Nothing here recomputes what that module already decides.
//
// ── Why we bound it ourselves rather than letting the platform ─────────────
//
// iOS keeps a limited number of pending local notifications per app. What
// happens at the ceiling is where documented and observed behaviour disagree —
// some accounts say the newest are dropped, some say the oldest are evicted —
// and either way the app is not told. A feature whose failure mode is "some of
// your reminders silently do not exist, and which ones depends on the OS
// version" is not a feature. So the selection is ours, it is explicit, and it is
// **soonest-first**: if something has to be lost, it is the furthest away, which
// is also the one most likely to be re-registered by a later pass before it
// matters.
//
// ── No platform repeating trigger ─────────────────────────────────────────
//
// iOS can register a single repeating notification that fires forever, which
// would remove the horizon problem entirely — and it is rejected. It fires
// whether or not the task was completed (the OS never learns about the tick), it
// writes the recurrence **rule** into the platform store rather than one instant
// (a much larger and longer-lived exposure), and the Android equivalent behaves
// differently, which would split one model into two. There is no repeat concept
// anywhere in this file, in the notifier, or in either native adapter — the
// payload that crosses the seam is `{ id, at }` and has nowhere to put one.

import {
  eventReminderId,
  reminderId,
  runReminderPassFor,
  targetRemindersFor,
  REMINDER_HORIZON_DAYS,
  type EventReminderSource,
  type PendingReminder,
  type ReminderClock,
  type ReminderNotifier,
  type ReminderPassResult,
  type VaultTask,
} from "@myne/reminder-schedule";

/**
 * How many pending local notifications the strictest platform holds per app.
 *
 * iOS is the binding constraint; Android's alarm limits are far higher, and the
 * same bound is applied there anyway so the two platforms keep **one** model
 * rather than two behaviours to reason about.
 */
export const REMINDER_PLATFORM_CAP = 64;

/**
 * How many vaults on one device the bound is sized for.
 *
 * Registrations are **per app, not per vault** — the platform has no idea vaults
 * exist — so several vaults on one device share this one ceiling. The PRD names
 * exactly that as one of the things that can approach the cap.
 *
 * This is a **tuning constant, not a compatibility one**: it is not written to
 * disk, not part of any wire format, and changing it later costs nothing but a
 * different number of registrations. It is set conservatively because both ways
 * of being wrong are not equal — under-registering means a reminder arrives from
 * a later pass instead of this one, while over-registering means the platform
 * silently drops something and nobody finds out. The conservative choice is also
 * the privacy-preferring one: every pending registration is a timestamp sitting
 * in OS-owned plaintext (`threat-model.md` §7), so fewer is strictly better.
 */
export const REMINDER_VAULTS_PER_DEVICE = 4;

/** The most reminders one vault registers at a time. */
export const REMINDER_MAX_PENDING = Math.floor(
  REMINDER_PLATFORM_CAP / REMINDER_VAULTS_PER_DEVICE,
);

/**
 * The soonest `max` reminders, in ascending instant order.
 *
 * Sorted by instant and then by id: the tie-break is not decoration, it is what
 * makes two runs over the same input produce the same set. Without it, two
 * reminders at the same minute could swap places between passes and the diff
 * would report churn that is not there.
 */
export function boundedReminders(
  target: readonly PendingReminder[],
  max: number = REMINDER_MAX_PENDING,
): PendingReminder[] {
  if (max <= 0) return [];
  const bySoonest = (a: PendingReminder, b: PendingReminder): number => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
  };
  return [...target].sort(bySoonest).slice(0, max);
}

/** Whether these sources would register anything at all — the question the
 *  permission prompt must answer before it may interrupt anybody. */
export function hasPendingReminders(
  sources: { tasks: readonly VaultTask[]; events?: readonly EventReminderSource[]; dayAnchor?: string },
  clock: ReminderClock,
  horizonDays: number = REMINDER_HORIZON_DAYS,
): boolean {
  return targetRemindersFor({ ...sources, events: sources.events ?? [] }, clock(), horizonDays).length > 0;
}

export type BoundedReminderPassOptions = {
  tasks: readonly VaultTask[];
  /**
   * The calendar's due reminders, when the caller has them.
   *
   * Optional rather than required so the existing call sites and tests keep their
   * meaning: a caller that omits the source arms the tasks and nothing else, which is
   * what this function did before the calendar existed.
   */
  events?: readonly EventReminderSource[];
  /** The wall-clock hour an all-day event's lead counts back from. */
  dayAnchor?: string;
  notifier: ReminderNotifier;
  clock: ReminderClock;
  horizonDays?: number;
  /** Injected in tests; production uses the platform-derived ceiling. */
  max?: number;
};

/**
 * Reconcile the platform's registration set against the **bounded** target.
 *
 * Implemented by narrowing the task list rather than by reimplementing the pass:
 * the bound decides which tasks are eligible this time, and the shared
 * `runReminderPass` does everything else — compute, diff, cancel, then schedule.
 * That is what keeps "cancel before schedule", "never throws" and "running twice
 * is a no-op" as one implementation instead of two that agree until they do not.
 *
 * **Each pass replaces the set wholesale**, and that falls out for free: the
 * shared pass cancels whatever the platform holds that the target no longer
 * contains, so a reminder pushed out of the bound by a sooner one is withdrawn
 * on the very next pass rather than lingering.
 */
export async function runBoundedReminderPass(
  options: BoundedReminderPassOptions,
): Promise<ReminderPassResult> {
  const {
    tasks,
    events = [],
    dayAnchor,
    notifier,
    clock,
    horizonDays = REMINDER_HORIZON_DAYS,
    max,
  } = options;

  // The bound is applied to the TARGET of both sources, then each source is narrowed
  // to the ids that survived. Doing it the other way round (bound the tasks, then add
  // the events) would let the events exceed the platform ceiling, which is the one
  // thing the bound exists to prevent: the strictest platform drops what it cannot
  // hold, silently.
  const sources = { tasks, events, dayAnchor };
  const kept = new Set(
    boundedReminders(targetRemindersFor(sources, clock(), horizonDays), max).map((r) => r.id),
  );
  return runReminderPassFor(
    {
      tasks: tasks.filter((task) => kept.has(reminderId(task))),
      events: events.filter((event) => kept.has(eventReminderId(event))),
      dayAnchor,
    },
    notifier,
    clock,
    horizonDays,
  );
}
