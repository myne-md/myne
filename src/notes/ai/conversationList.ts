// Two helpers the conversation lists share: what order their rows go in, and
// what date a row states.
//
// **Both lived twice, once per list** (myne-md/myne#848): `AgentHubList`'s rail
// and `ChatHistoryModal`, byte-identical in each case, carrying the same defect
// and the same fix. The date's fix is worth restating here because it is the kind
// of thing the second copy silently lacked: `new Date(0)` renders as 1970 and
// `new Date(undefined)` as the words "Invalid Date", so a row whose timestamp
// cannot be read stated a date anyway, and a date reads as a fact about the
// conversation rather than as a missing field.
//
// The relative-vs-absolute split is recorded, not a pref bypass: the mobile twin
// (`mobile/src/app/flows/AiHistorySheet.tsx`) renders the same field relatively
// while these two lists render it absolutely. So this is a display helper, not a
// second reading of the date/time prefs, the caller passes the locale and zone
// it already got from the shared display store.

import type { ConversationListRow } from "../../lib/chats";

/** Newest first: the list order, applied to every fetch path. */
export function byUpdatedDesc(rows: ConversationListRow[]): ConversationListRow[] {
  return [...rows].sort((a, b) => b.updated_at - a.updated_at);
}

/**
 * A row's date, or an empty string when it has no usable timestamp.
 *
 * An empty string is the honest answer and the caller falls back to `created_at`
 * before it gets here; what it must never do is invent one.
 */
export function relativeDay(
  updatedAt: number,
  locale: string,
  timeZone: string | null,
): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "";
  const date = new Date(updatedAt);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    ...(timeZone === null ? {} : { timeZone }),
  });
}
