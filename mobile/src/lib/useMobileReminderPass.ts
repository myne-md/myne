// The phone's reminder pass, actually running (myne-md/myne#1037).
//
// Until this hook existed, `reminderPass.ts` was written, tested and called by
// nothing: on a phone no reminder fired, for a task or for an event. The file said so
// in its own comments, and so did the settings sheet.
//
// What the pass needs is a CALLER and four triggers, and that is the whole of this
// module:
//
// 1. **on unlock** — the vault just became readable, so the schedule can be rebuilt;
// 2. **on resume** — a phone is backgrounded for days, and the OS may have dropped
//    registrations it no longer wants to hold;
// 3. **on a change** — a task ticked or an event moved must move its reminder too;
// 4. **on a slow tick** — while the app is open, so a reminder that falls inside the
//    window during a long session is still registered.
//
// One rule keeps the OS honest across all four: the pass is RECONCILING, not additive.
// Running it twice is a no-op, and running it after a deletion withdraws what was
// registered, which is why there is no `cancel` call anywhere in this file.
//
// What crosses into the OS stays `{ id, at }` and a fixed, content-free body: the
// notification body is owned by the native side, so no note text reaches the platform
// store (`threat-model.md` §7).

import { useEffect, useRef, useState } from "react";
import type { CalendarRow } from "@myne/vault-indices";
import { resolveDayAnchor } from "@myne/dialect/event";
import { REMINDER_MAX_PENDING, runBoundedReminderPass } from "./reminderPass";
import { createReminderNotifier, createReminderPermissionApi, remindersReachTheOs } from "./reminders";
import { vaultIndicesCalendarRange } from "./calendar";
import { usePrefs } from "./use-prefs";
import { TASK_WRITE_EVENT, useVaultTasks } from "./tasks";

/** How long the app may sit open before the schedule is rebuilt once more. */
const TICK_MINUTES = 15;

/**
 * Whether this app run has already asked for the notification permission.
 *
 * Module scope, not a ref: the editor remounts on every lock and unlock, and a
 * per-mount flag asks again each time, which is the shape that turns a prompt into
 * noise the user dismisses without reading. The comment said "once per app run" while
 * the code did once per mount, and the test that was supposed to catch it asserted a
 * range wide enough to admit both (`toBeLessThanOrEqual(2)`).
 */
let askedForPermission = false;

/**
 * Forget that the permission was asked, for a test that mounts the hook more than
 * once in one process.
 *
 * Exported rather than reached through `vi.resetModules`, which would re-import the
 * notifier and the scheduler too and make the test's mocks a second thing under test.
 */
export function resetPermissionAsk(): void {
  askedForPermission = false;
}

/** `YYYY-MM-DD`, the device's own day. */
function todayString(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The window the pass needs: today, plus the horizon it schedules within. */
function windowFor(now: Date, horizonDays: number): { start: string; end: string } {
  const end = new Date(now.getTime() + horizonDays * 86_400_000);
  return { start: todayString(now), end: todayString(end) };
}

/** The reminders the calendar contributes, in the shape the pass consumes. */
export function eventSourcesFrom(rows: readonly CalendarRow[]): { noteId: string; start: string; allDay: boolean; occurrenceDate: string | null; remind: string | null }[] {
  return rows
    .filter((row) => row.remind !== null && row.remind !== "")
    .map((row) => ({
      noteId: row.noteId,
      start: row.start,
      allDay: row.allDay,
      occurrenceDate: row.occurrenceDate ?? row.start.slice(0, 10),
      remind: row.remind,
    }));
}

/**
 * Run the reminder pass from the app's own lifecycle.
 *
 * Returns the last result so a diagnostics screen can say what happened; the app does
 * not need it to function, and nothing here throws, because a reminder that fails to
 * register must not stop a vault from opening.
 */
export function useMobileReminderPass(): { scheduled: number; cancelled: number; failed: number } | null {
  const { prefs } = usePrefs();
  const enabled = prefs.reminders_enabled;
  const horizonDays = prefs.reminder_horizon_days ?? 7;
  const { tasks } = useVaultTasks();
  const [result, setResult] = useState<{ scheduled: number; cancelled: number; failed: number } | null>(null);

  // The task list is a NEW array on every render, so it cannot be an effect
  // dependency: doing that re-ran the whole pass (two IPC reads and up to sixty-four
  // registrations) on every keystroke-driven render of the editor. The effect keys on
  // the SETTINGS instead, and a change to the data arrives through the write event
  // below, which is the signal that actually means "a task moved".
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  useEffect(() => {
    if (!enabled || !remindersReachTheOs()) return;
    let cancelled = false;
    const notifier = createReminderNotifier();

    const run = async () => {
      // The permission is asked at the FIRST pass rather than at the settings toggle,
      // because that is the moment it has a reason a user can see: the app is about to
      // put something in the notification list. A refusal leaves the pass running and
      // simply achieves nothing, which is the same outcome as scheduling into a denied
      // permission, minus the lie.
      if (!askedForPermission) {
        askedForPermission = true;
        try {
          const api = createReminderPermissionApi();
          const status = await api.status();
          // `not-determined` is iOS/Android's "never asked"; a granted or denied state
          // is a decision the user already made, and re-asking is how a prompt becomes
          // noise. `unavailable` means the platform has no notification model at all.
          if (status === "not-determined") await api.request();
        } catch {
          // A platform with no permission model needs no prompt.
        }
      }

      const now = new Date();
      const { start, end } = windowFor(now, horizonDays);
      let rows: readonly CalendarRow[] = [];
      try {
        rows = (await vaultIndicesCalendarRange(start, end, true)).rows;
      } catch {
        // A locked or unreadable vault means no event reminders THIS pass; the task
        // half still runs, because the two sources fail independently.
        rows = [];
      }
      if (cancelled) return;

      const outcome = await runBoundedReminderPass({
        tasks: tasksRef.current,
        events: eventSourcesFrom(rows),
        // Through the shared resolver, not the raw value: `calendar_settings` is a
        // SHARED pref, so a device can receive a value its own setter never validated,
        // and `targetEventReminders` interpolates whatever it is given. A bad value
        // used to produce `Invalid Date` and silently drop every all-day reminder.
        dayAnchor: resolveDayAnchor(prefs.calendar_settings?.day_reminder_anchor),
        notifier,
        clock: () => new Date(),
        horizonDays,
        max: REMINDER_MAX_PENDING,
      });
      if (!cancelled) setResult(outcome);
    };

    void run();

    // Resume is the trigger that matters on a phone: the app can sit in the background
    // for a week, and the platform may have pruned registrations in the meantime.
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    // A ticked task or an edited event is the change that must move a reminder, and
    // every write funnels through this one event on both clients.
    const onTaskWrite = () => void run();
    window.addEventListener(TASK_WRITE_EVENT, onTaskWrite);
    const tick = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, TICK_MINUTES * 60_000);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(TASK_WRITE_EVENT, onTaskWrite);
      clearInterval(tick);
    };
  }, [enabled, horizonDays, prefs.calendar_settings?.day_reminder_anchor]);

  return result;
}
