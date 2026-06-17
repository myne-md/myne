// Single source of truth for the LOCAL-time date/time strings Myne inserts into
// note bodies — shared by the `{{date}}`/`{{time}}`/`{{datetime}}`/`{{weekday}}`
// template render context (`newNoteFromTemplate.ts::buildRenderContext`) and the
// `/date` `/day` `/time` `/now` slash commands (`editor/slash/commands.ts`).
//
// Local time only — a value stamped at 01:00 local in a positive UTC offset reads
// today's local calendar day, never the previous UTC day. There is no configurable
// format and no format mini-language (closed-registry / no-scripting discipline,
// w25-low-batch SYNC-5). RFC-3339-UTC is reserved for frontmatter-bound tokens;
// these are body inserts, so they are local (SYNC-4-R).

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD` in local time. */
export function formatLocalDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** `HH:mm` 24-hour in local time. */
export function formatLocalTime(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/** `YYYY-MM-DD HH:mm` (minute precision) in local time. */
export function formatLocalDateTime(now: Date): string {
  return `${formatLocalDate(now)} ${formatLocalTime(now)}`;
}

/** Localized long weekday name (host locale = app-language proxy until an in-app
 *  language setting lands). */
export function formatLocalWeekday(now: Date): string {
  return now.toLocaleDateString(undefined, { weekday: "long" });
}
