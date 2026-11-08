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
  parseLocalInstant,
  resolveHorizonDays,
  runReminderPassFor,
  targetRemindersFor,
  type EventReminderSource,
  type PendingReminder,
  type ReminderNotifier,
  type ReminderPassResult,
  type ReminderSources,
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
  events: readonly EventReminderSource[] = [],
  dayAnchor?: string,
): number {
  // `targetReminders` sorts by ID, not by instant, so `[0]` is the
  // lexicographically first reminder rather than the soonest. That sort exists
  // to keep the diff byte-stable and is correct for its own purpose; taking its
  // head as "the next instant" was a second reading it never promised. The
  // mobile twin needed an explicit comparator for the same reason
  // (`mobile/src/lib/reminderPass.ts`). Every existing test here passes a single
  // task, so the difference was unobservable.
  const next = targetRemindersFor({ tasks, events, dayAnchor }, now, horizonDays).reduce<
    PendingReminder | undefined
  >(
    (soonest, r) => (soonest === undefined || r.at < soonest.at ? r : soonest),
    undefined,
  );
  if (next === undefined) return MAX_SLEEP_MS;
  // `at` is a local wall-clock stamp; the shared parser is what keeps this
  // agreeing with the notifier's timer to the minute.
  const delta = parseLocalInstant(next.at).getTime() - now.getTime();
  return Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, delta));
}

export type ReminderSchedulerOptions = {
  /** Off entirely when false — no pass, no timer, and no OS registration. */
  enabled: boolean;
  tasks: readonly VaultTask[];
  /**
   * Event notes carrying a reminder, from the calendar's own range read.
   *
   * Required for the same reason `horizonDays` is: an optional field is an opt-in
   * wire, and omitting it would leave every event reminder unregistered with
   * nothing failing. Deleting the line at the call site is the compile error.
   */
  events: readonly EventReminderSource[];
  /** The wall-clock anchor an all-day event's reminder uses. */
  dayAnchor: string;
  notifier: ReminderNotifier | null;
  /**
   * The user's registration horizon. `null` is the vault that never chose one.
   *
   * myne#508: absent until then, so `runReminderPass`'s fourth parameter always
   * took its default and the pref could not reach the mechanism it names even
   * once something wrote it.
   *
   * **Required, not optional, and that is the fix rather than a style choice.**
   * An optional field is an opt-in wire: omitting it compiles, the pass silently
   * falls back to the default, and the preference stops reaching the mechanism
   * again with nothing reporting it. That is this issue's own defect one layer
   * up, and it is the shape `AGENTS.md` records under "A guard parameter with a
   * default value is an opt-in guard". Required means deleting the line in
   * `Editor.tsx` is a compile error naming the site, which no test can be
   * deleted around.
   */
  horizonDays: number | null;
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
  const { enabled, tasks, events, dayAnchor, notifier, horizonDays, clock: clockOption, onPass } = options;
  // Resolved to a number rather than left as `number | undefined` leaning on a
  // default parameter two modules away: both call sites below then read the
  // same value, and the dep array compares a primitive that changes only when
  // the user's horizon does.
  const horizon = resolveHorizonDays(horizonDays ?? null);
  // Kept in a ref so the timer closure always sees the current list without
  // being torn down and rebuilt on every keystroke-driven index change.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // The event list is held the same way, so a range read landing mid-timer does not
  // rebuild the effect and drop a reminder due in the same minute.
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const anchorRef = useRef(dayAnchor);
  anchorRef.current = dayAnchor;
  const onPassRef = useRef(onPass);
  onPassRef.current = onPass;
  // myne#318 — the default clock USED to be a destructuring default,
  // `clock = () => new Date()`, which allocates a fresh function identity on
  // every call and sat in the effect's dependency array. `EditorChrome` is the
  // app's hottest component (PaneView reports its readout up on every
  // autosave-status change and on the 200 ms doc-stats debounce), so the effect
  // tore down and re-ran several times per typing burst — each time paying a
  // full `listPending` + `targetReminders` over EVERY task in the vault, plus a
  // timer teardown and rebuild, for the whole unlocked session.
  //
  // Worse than the churn: `targetReminders` compares at minute granularity, so a
  // pass running at or after the due instant computes the reminder out of the
  // target set and cancels its pending delivery timer. The timer-driven pass is
  // always registered after the delivery timer at the same expiry, so delivery
  // wins by ordering — a RENDER-driven pass has no such ordering, and one
  // landing between the due instant and the still-queued delivery callback
  // silently drops that reminder. The window needs a busy main thread, which is
  // precisely the condition this churn creates.
  //
  // A ref-held default is stable across renders, so the effect keys only on the
  // things that actually change what it should do. An explicitly PASSED clock
  // stays in the dep list, since a caller swapping clocks means a different
  // schedule (and the tests do exactly that).
  const defaultClockRef = useRef<() => Date>(() => new Date());
  const clock = clockOption ?? defaultClockRef.current;

  useEffect(() => {
    if (!enabled || notifier === null) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pass = async (): Promise<void> => {
      if (cancelled) return;
      let result: ReminderPassResult;
      try {
        const sources: ReminderSources = {
          tasks: tasksRef.current,
          events: eventsRef.current,
          dayAnchor: anchorRef.current,
        };
        result = await runReminderPassFor(sources, notifier, clock, horizon);
      } catch {
        // `runReminderPass` is already total; this is belt-and-braces so a
        // future change there cannot turn an unlock into a crash.
        result = { scheduled: 0, cancelled: 0, failed: 1 };
      }
      if (cancelled) return;
      onPassRef.current?.(result);
      // Re-arm to the NEXT instant rather than to a fixed coarse interval.
      //
      // The horizon is threaded for correctness rather than for effect, and no
      // test can tell the two calls apart: `MAX_SLEEP_MS` is a minute, every
      // horizon is at least a day, so an instant outside the horizon and an
      // instant far inside it both clamp to the ceiling, and an instant close
      // enough to change the answer is inside every horizon by construction.
      // Passing it anyway is what keeps this call correct if that ceiling ever
      // rises, and saying so here is better than a test that cannot fail.
      timer = setTimeout(
        () => void pass(),
        msUntilNextPass(tasksRef.current, clock(), horizon, eventsRef.current, anchorRef.current),
      );
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
    //
    // `horizon` is there for the stronger version of the same reason. Widening
    // it only delays a registration, but SHORTENING it is the user tightening a
    // privacy bound over times already sitting in OS-owned plaintext, and those
    // are cancelled by the pass recomputing its target set. Leaving the change
    // to the next tick would let a horizon the user just cut to one day keep a
    // month of instants registered for up to `MAX_SLEEP_MS`.
  }, [enabled, notifier, tasks, horizon, clock]);
}
