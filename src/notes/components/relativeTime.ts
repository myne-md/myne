// Shared relative-time formatter for sidebar rows + the BottomBar
// `<SaveStatus>` (Task 27). One implementation, consumed by both;
// auto-tick via a single ~30s shared interval (`useTick` below).
//
// Per the 2026-05-15 MYND-82 grill Q11 (live-tick) + Q16 (relative-
// time honest sort signal). Output style aligns with `PRODUCT.md`
// voice "soft yet honest" — "just now", "2 min ago", "1 h ago",
// "3 days ago".

import { useEffect, useState } from "react";
import i18n from "../../i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Format a Date (or null fallback) as a sidebar/BottomBar suffix. */
export function formatRelativeTime(when: Date | null, now: Date = new Date()): string {
  if (when === null) return "";
  const delta = now.getTime() - when.getTime();
  if (delta < 0) return i18n.t("notes.relativeTime.justNow");
  if (delta < MINUTE) return i18n.t("notes.relativeTime.justNow");
  if (delta < HOUR) {
    const m = Math.floor(delta / MINUTE);
    return i18n.t("notes.relativeTime.minutesAgo", { m });
  }
  if (delta < DAY) {
    const h = Math.floor(delta / HOUR);
    return i18n.t("notes.relativeTime.hoursAgo", { h });
  }
  if (delta < WEEK) {
    const d = Math.floor(delta / DAY);
    return d === 1
      ? i18n.t("notes.relativeTime.yesterday")
      : i18n.t("notes.relativeTime.daysAgo", { d });
  }
  if (delta < 4 * WEEK) {
    const w = Math.floor(delta / WEEK);
    return w === 1
      ? i18n.t("notes.relativeTime.oneWeekAgo")
      : i18n.t("notes.relativeTime.weeksAgo", { w });
  }
  // For older entries fall back to absolute date (yyyy-mm-dd).
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, "0");
  const d = String(when.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Shared 30-second tick — call this hook in components that render
 * relative-time strings. All callers re-render on the same tick so
 * the page-wide auto-update is coherent and the interval count is
 * O(1) regardless of how many rows are visible.
 */
const TICK_INTERVAL_MS = 30_000;
const subscribers = new Set<() => void>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;

function ensureInterval() {
  if (intervalHandle !== null) return;
  intervalHandle = setInterval(() => {
    for (const fn of subscribers) fn();
  }, TICK_INTERVAL_MS);
}

function maybeStopInterval() {
  if (subscribers.size === 0 && intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export function useTick(): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const sub = () => setTick((n) => (n + 1) % 1_000_000);
    subscribers.add(sub);
    ensureInterval();
    return () => {
      subscribers.delete(sub);
      maybeStopInterval();
    };
  }, []);
  return Date.now();
}
