// Daily-notes "open today" resolver (MYND-191).
//
// A pure, deterministic function that answers "which note is today's note?" —
// the testable core of the daily-notes feature. Given a host-injected `now`,
// the `daily_date_format` + `daily_folder` prefs, and the note list, it:
//   1. computes today's date-title string from `now` via the format (LOCAL
//      clock — the host injects `now`; no clock read here);
//   2. searches for a note whose `folder:` == the daily folder AND `title:` ==
//      the date string, comparing both under the dialect identity rule
//      (case-fold + NFC, via `foldSegment`) so `Daily/` matches a `daily/`
//      variant and an NFC/NFD date-title variant resolves to the same note;
//   3. excludes trashed + template-flagged notes (same exclusion machinery as
//      trash/templates);
//   4. returns the matched note ("open") or a "create" signal.
// Renamed-title and moved-out-of-folder notes intentionally no longer match —
// the key is folder + date-title by design (predictable, not magical).
//
// Daily-notes is a bounded plain-markdown skeleton + date navigation over
// ordinary notes — NOT a calendar/date-object model (anti-Notion, vision.md:59).

import { foldSegment, folderKey, normalizeFolderPath } from "../dialect/folderPath";
import type { TitleRecord } from "./loadNoteBatch";
import type { NoteId } from "./sidebarState";

/** Canonical default daily folder when `daily_folder` is unset (None ≡ default). */
export const DEFAULT_DAILY_FOLDER = "Daily/";
/** Canonical default daily date format when `daily_date_format` is unset. */
export const DEFAULT_DAILY_DATE_FORMAT = "YYYY-MM-DD";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Format `now` into a date-title string per a daily date-format. v1 supports the
 * tokens `YYYY` (4-digit year), `MM` (2-digit month), `DD` (2-digit day) — the
 * `YYYY-MM-DD` default plus common separator variants (`YYYY/MM/DD`, etc.).
 * Replaced longest-token-first; any other characters pass through literally.
 * LOCAL time — `now.getFullYear()`/`getMonth()`/`getDate()` are local-clock.
 */
export function formatDailyDate(now: Date, format: string): string {
  return format
    .replace(/YYYY/g, String(now.getFullYear()))
    .replace(/MM/g, pad2(now.getMonth() + 1))
    .replace(/DD/g, pad2(now.getDate()));
}

/** Resolution result: open the existing today-note, or create one. */
export type DailyResolution =
  | { kind: "open"; id: NoteId; dateTitle: string }
  | { kind: "create"; dateTitle: string; folder: string | null };

/**
 * Resolve today's note (idempotent open-or-create). Pure: all clock input is the
 * caller-injected `now`. Match = folder + date-title under case-fold + NFC,
 * excluding trashed + template notes. Returns `{kind:"open"}` with the matched
 * note id, or `{kind:"create"}` with the date-title + the folder to create in.
 */
export function resolveTodayNote(
  now: Date,
  dailyDateFormat: string | null,
  dailyFolder: string | null,
  notes: readonly TitleRecord[],
): DailyResolution {
  const format = dailyDateFormat ?? DEFAULT_DAILY_DATE_FORMAT;
  const dateTitle = formatDailyDate(now, format);
  const folderNorm = normalizeFolderPath(dailyFolder ?? DEFAULT_DAILY_FOLDER);
  const wantFolder = folderNorm == null ? "" : foldSegment(folderNorm);
  const wantTitle = foldSegment(dateTitle);

  for (const n of notes) {
    // Exclude trashed + templates (same machinery as the sidebar live set).
    if (n.trashed != null || n.template === true) continue;
    if (folderKey(n.folder) !== wantFolder) continue;
    if (n.title == null || foldSegment(n.title) !== wantTitle) continue;
    return { kind: "open", id: n.noteUuid as NoteId, dateTitle };
  }
  return { kind: "create", dateTitle, folder: folderNorm };
}
