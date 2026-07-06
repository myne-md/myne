// Relative-time formatter for the note-list "last edited" subtitle — a faithful
// port of the desktop `src/notes/components/relativeTime.ts` buckets so mobile
// rows read identically:
//   < 1 min   → "just now"
//   < 1 h     → "{m} min ago"
//   < 1 day   → "{h} h ago"
//   < 1 week  → "yesterday" / "{d} days ago"
//   < 4 weeks → "1 week ago" / "{w} weeks ago"
//   older     → absolute "YYYY-MM-DD"

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
  if (diff < MIN) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < WEEK) {
    const days = Math.floor(diff / DAY);
    return days <= 1 ? "yesterday" : `${days} days ago`;
  }
  if (diff < 4 * WEEK) {
    const weeks = Math.floor(diff / WEEK);
    return weeks <= 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  return isoDate(date);
}
