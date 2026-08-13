// Relative-time formatter for the note-list "last edited" subtitle — a faithful
// port of the desktop `src/notes/components/relativeTime.ts` buckets so mobile
// rows read identically, resolved through the SHARED i18n catalog (MYND-485) so
// the labels honor the active UI language + Weblate translations, reusing the
// exact desktop `notes.relativeTime.*` keys:
//   < 1 min   → "just now"
//   < 1 h     → "{m} min ago"
//   < 1 day   → "{h} h ago"
//   < 1 week  → "yesterday" / "{d} days ago"
//   < 4 weeks → "1 week ago" / "{w} weeks ago"
//   older     → absolute "YYYY-MM-DD"

import i18n from "@myne/i18n";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Pad to `YYYY-MM-DD` in local time (matches the desktop absolute fallback). */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diff = now.getTime() - date.getTime();
  if (diff < 0 || Number.isNaN(diff)) return isoDate(date);
  if (diff < MIN) return i18n.t("notes.relativeTime.justNow");
  if (diff < HOUR) return i18n.t("notes.relativeTime.minutesAgo", { m: Math.floor(diff / MIN) });
  if (diff < DAY) return i18n.t("notes.relativeTime.hoursAgo", { h: Math.floor(diff / HOUR) });
  if (diff < WEEK) {
    const days = Math.floor(diff / DAY);
    return days <= 1
      ? i18n.t("notes.relativeTime.yesterday")
      : i18n.t("notes.relativeTime.daysAgo", { d: days });
  }
  if (diff < 4 * WEEK) {
    const weeks = Math.floor(diff / WEEK);
    return weeks <= 1
      ? i18n.t("notes.relativeTime.oneWeekAgo")
      : i18n.t("notes.relativeTime.weeksAgo", { w: weeks });
  }
  return isoDate(date);
}
