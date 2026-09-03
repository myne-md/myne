// "Today", as a value that changes when today does (myne-md/myne#557, the
// `tasks.panel` bullet).
//
// `TasksPane` and `NoteTasksPanel` both resolved the current civil date with
// `useMemo(() => todayLocal(new Date(), zone), [zone])`. A `useMemo` keyed on the
// zone re-runs when the ZONE changes and at no other time, so a window left open
// across midnight kept yesterday's date: the Today filter showed yesterday's
// tasks, the Overdue count stayed one short, and nothing on screen said so. The
// panel is a surface people leave open overnight, which is precisely the shape
// of bug a once-a-release hand-walk never catches — a reviewer opens the app and
// checks the buckets within a minute of opening it.
//
// # Why a timer and not a poll
//
// One `setTimeout` aimed at the next local midnight costs one wake-up a day. A
// per-minute poll would cost 1440 and would still be wrong at the boundary by up
// to a minute. The timer re-reads the real clock when it fires and reschedules
// from that, so an early or late fire self-corrects rather than compounding:
// firing early leaves the date unchanged and simply schedules the remainder.
//
// # Why `visibilitychange` as well
//
// A background tab's timers are throttled to almost nothing, and a suspended
// laptop runs none at all. Either way the timer fires late — sometimes hours
// late — and the panel would show the stale date until it did. Re-resolving when
// the document becomes visible closes that: the moment the user is looking at
// it, the date is right. That matters most on the web client, where the whole
// app IS a tab, and it costs nothing on desktop.

import { useEffect, useState } from "react";
import { todayLocal } from "./taskFilters";

/** A day, in ms. */
const DAY_MS = 86_400_000;

/**
 * Milliseconds from `now` to the next midnight in `zone` (or the machine's own
 * zone when `zone` is null), plus a one-second margin.
 *
 * The margin exists because a timer that fires at exactly 00:00:00.000 can be
 * delivered a hair early by clock rounding, which would resolve to yesterday and
 * schedule another full day. One second is invisible to a user and removes the
 * whole class.
 *
 * DST is handled by re-reading rather than by arithmetic: on a 23-hour day this
 * over-shoots into the new day (harmless — the caller re-reads the real date),
 * and on a 25-hour day it under-shoots, leaves the date unchanged, and the
 * caller schedules the remainder. Encoding the transition table here would be a
 * second implementation of something ICU already owns.
 */
export function msUntilNextLocalMidnight(now: Date, zone: string | null): number {
  const elapsed = msSinceLocalMidnight(now, zone);
  return DAY_MS - elapsed + 1_000;
}

/** Milliseconds elapsed since local midnight, in `zone`. */
function msSinceLocalMidnight(now: Date, zone: string | null): number {
  if (zone !== null) {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(now);
      const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
      return (
        at("hour") * 3_600_000 +
        at("minute") * 60_000 +
        at("second") * 1_000 +
        now.getMilliseconds()
      );
    } catch {
      // An unsupported zone falls through to the machine's own calendar rather
      // than throwing — the same posture `todayLocal` takes, and for the same
      // reason: "what time is it" is not a question that may fail.
    }
  }
  return (
    now.getHours() * 3_600_000 +
    now.getMinutes() * 60_000 +
    now.getSeconds() * 1_000 +
    now.getMilliseconds()
  );
}

/**
 * The current civil date in `zone` as `YYYY-MM-DD`, re-resolved when the local
 * day rolls over and whenever the document becomes visible again.
 *
 * Same value `todayLocal(new Date(), zone)` returns; the difference is that this
 * one does not go stale.
 */
export function useLocalToday(zone: string | null): string {
  const [today, setToday] = useState(() => todayLocal(new Date(), zone));

  useEffect(() => {
    // A zone change is a date change too — resolve immediately rather than
    // waiting for the next midnight in the NEW zone, which can be a day away.
    setToday(todayLocal(new Date(), zone));

    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const resolveAndReschedule = () => {
      if (disposed) return;
      setToday(todayLocal(new Date(), zone));
      timer = setTimeout(resolveAndReschedule, msUntilNextLocalMidnight(new Date(), zone));
    };

    timer = setTimeout(resolveAndReschedule, msUntilNextLocalMidnight(new Date(), zone));

    // The throttled-timer escape hatch. `setToday` with an unchanged value is a
    // no-op in React, so a visibility flip inside the same day re-renders
    // nothing.
    const onVisible = () => {
      if (document.visibilityState === "visible") setToday(todayLocal(new Date(), zone));
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [zone]);

  return today;
}
