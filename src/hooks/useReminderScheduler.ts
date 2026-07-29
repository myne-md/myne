// `useReminderScheduler` — reminders while the app is open (MYND-618, task 4).
//
// The shape follows `useBackupScheduler`: mounted only on the post-unlock
// surface, so the Editor's lifetime IS the scheduler's window; a **catch-up
// pass on mount** (i.e. on unlock) heals anything missed while the app was
// closed, and a periodic re-check keeps a long session accurate.
//
// **One deliberate divergence from that pattern, and it should be visible in
// the code rather than inherited silently:** the backup scheduler's tick is
// five minutes, which is right for a daily-or-coarser schedule and far too slow
// for a reminder the user set to the minute. This hook computes a timer **to
// the next instant** instead, with a bounded floor and ceiling. A copy of the
// five-minute tick would have shipped a "reminder" that arrives up to five
// minutes late, which is not a reminder.
//
// It never throws. A failure is recorded and the next pass retries by
// construction — the target set is recomputed from scratch each time, so a
// missed pass leaves no residue.

import { useEffect, useRef } from "react";
import {
  runReminderPass,
  targetReminders,
  type ReminderNotifier,
  type ReminderPassResult,
} from "../lib/reminderSchedule";
import type { VaultTask } from "../notes/taskIndex";

/**
 * Never sleep longer than this, however far away the next reminder is.
 *
 * Two reasons, both real: the task list changes underneath us (an edit adds a
 * reminder sooner than the one we timed for), and a machine that slept through
 * the timer needs a bounded worst case for noticing.
 */
export const MAX_SLEEP_MS = 60_000;

/**
 * Never sleep shorter than this.
 *
 * A reminder due *now* would otherwise spin the pass in a tight loop for the
 * second it takes the instant to pass.
 */
export const MIN_SLEEP_MS = 1_000;

/** Milliseconds until the next registered instant, clamped into the bounds. */
export function msUntilNextPass(
  tasks: readonly VaultTask[],
  now: Date,
  horizonDays?: number,
): number {
  const next = targetReminders(tasks, now, horizonDays)[0];
  if (next === undefined) return MAX_SLEEP_MS;
  // `at` is a local wall-clock stamp; parsing it as local is what makes the
  // comparison agree with how the reminder was written.
  const [date, time] = next.at.split("T");
  const [y, m, d] = date!.split("-").map(Number);
  const [hh, mm] = time!.split(":").map(Number);
  const delta = new Date(y!, m! - 1, d!, hh!, mm!).getTime() - now.getTime();
  return Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, delta));
}

export type ReminderSchedulerOptions = {
  /** Off entirely when false — no pass, no timer, and no OS registration. */
  enabled: boolean;
  tasks: readonly VaultTask[];
  notifier: ReminderNotifier | null;
  /** Injected in tests; production reads the wall clock here and nowhere else. */
  clock?: () => Date;
  /** Observability hook. A failure is reported, never thrown. */
  onPass?: (result: ReminderPassResult) => void;
};

/**
 * Drive the reminder pass while the app is open and the vault unlocked.
 *
 * The pass re-runs whenever the task list changes as well as on the timer,
 * because a reminder the user just typed should register immediately rather
 * than at the next tick — and since the pass is idempotent, an extra run costs
 * nothing.
 */
export function useReminderScheduler(options: ReminderSchedulerOptions): void {
  const { enabled, tasks, notifier, clock = () => new Date(), onPass } = options;
  // Kept in a ref so the timer closure always sees the current list without
  // being torn down and rebuilt on every keystroke-driven index change.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const onPassRef = useRef(onPass);
  onPassRef.current = onPass;

  useEffect(() => {
    if (!enabled || notifier === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pass = async (): Promise<void> => {
      if (cancelled) return;
      let result: ReminderPassResult;
      try {
        result = await runReminderPass(tasksRef.current, notifier, clock);
      } catch {
        // `runReminderPass` is already total; this is belt-and-braces so a
        // future change there cannot turn an unlock into a crash.
        result = { scheduled: 0, cancelled: 0, failed: 1 };
      }
      if (cancelled) return;
      onPassRef.current?.(result);
      // Re-arm to the NEXT instant rather than to a fixed coarse interval.
      timer = setTimeout(() => void pass(), msUntilNextPass(tasksRef.current, clock()));
    };

    // The catch-up pass, on mount — i.e. on unlock.
    void pass();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // `tasks` is intentionally in the dependency list: a newly typed reminder
    // must register immediately rather than at the next tick, and the pass is
    // idempotent so the extra run is free.
  }, [enabled, notifier, tasks, clock]);
}
