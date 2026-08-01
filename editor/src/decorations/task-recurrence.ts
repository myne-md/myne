// Materialize the next occurrence when a recurring task is ticked
// (MYND-615, tasks 7 and 9; wired to the checkbox by myne#198).
//
// **One transaction carries both changes** — the marker flip and the inserted
// next occurrence — so a single undo restores the original state. Two dispatches
// would mean two undos for one visible action.
//
// **The document is the idempotency key.** Materialization happens only on the
// unticked→ticked edge; a second click reads a ticked marker, produces an
// un-tick, and creates nothing. No side table, no guard flag, nothing to get out
// of sync.
//
// The insertion is a **splice**, not a re-serialization of the note, so an
// imported file's untouched bytes stay untouched (§6 C1).
//
// The line arithmetic itself lives in `@myne/dialect/taskRecurrence`, not here:
// the Tasks panel writes through `src/notes/taskWriteCore.ts` against a note
// that is usually not open in any pane, so it has no `EditorView` to pass. What
// remains in this file is the CodeMirror half — reading the marker, and turning
// a planned change into one transaction.

import type { EditorView } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import { serializeTaskFields } from "@myne/dialect/taskFieldWriter";
import {
  matchesMaterializedOccurrence,
  planNextOccurrence,
  planSkippedOccurrence,
} from "@myne/dialect/taskRecurrence";
import { describeRecurrenceRule, type RecurrenceSpec } from "@myne/dialect/recurrence";
import { todayCivilDate, type CivilDate } from "@myne/dialect/civilDate";

/** Today, as a civil date. Injected in tests; there is no hidden clock. */
export type Clock = () => CivilDate;

export const systemClock: Clock = todayCivilDate;

/**
 * The next-occurrence line for a completed recurring task, or null.
 *
 * Kept as a named export because it is this module's published surface; the
 * computation is the dialect's.
 */
export const nextOccurrenceLine = planNextOccurrence;

/**
 * Tick a recurring task and materialize its next occurrence in ONE transaction.
 *
 * Returns `false` when the line is not a recurring task, so the caller falls back
 * to an ordinary marker flip. Only ever called on the unticked→ticked edge.
 */
export function completeRecurringTask(
  view: EditorView,
  markerFrom: number,
  clock: Clock = systemClock,
): boolean {
  const line = view.state.doc.lineAt(markerFrom);
  const marker = view.state.doc.sliceString(markerFrom, markerFrom + 3);
  if (marker !== "[ ]") return false; // only the unticked→ticked edge materializes

  const occurrence = planNextOccurrence(line.text, clock());
  if (occurrence === null) return false;

  view.dispatch({
    changes: [
      // The marker flip.
      { from: markerFrom, to: markerFrom + 3, insert: "[x]" },
      // The insertion — a splice at the line end, so no surrounding byte moves.
      { from: line.to, to: line.to, insert: `\n${occurrence}` },
    ],
    userEvent: "myne.task-recurrence.materialize",
  });
  return true;
}

/**
 * Remove the orphaned occurrence when a completed recurring task is un-ticked
 * (MYND-615 task 9), **in the same transaction as the un-tick**.
 *
 * Deleting user file content on a heuristic fails rarely but fails
 * unrecoverably, so the removal happens only when SIX conditions all hold —
 * `matchesMaterializedOccurrence` is where they are checked. Single-step
 * reversibility — one undo restores both halves — is what brings the residual
 * risk down to acceptable. It is still a heuristic and should be treated as one.
 */
export function uncompleteRecurringTask(
  view: EditorView,
  markerFrom: number,
  clock: Clock = systemClock,
): boolean {
  const line = view.state.doc.lineAt(markerFrom);
  const marker = view.state.doc.sliceString(markerFrom, markerFrom + 3);
  if (marker !== "[x]" && marker !== "[X]") return false;

  if (line.number >= view.state.doc.lines) return false;
  const nextLine = view.state.doc.line(line.number + 1);

  // An orphan we cannot positively identify is user content — leave it alone.
  if (!matchesMaterializedOccurrence(line.text, nextLine.text, clock())) return false;

  view.dispatch({
    changes: [
      { from: markerFrom, to: markerFrom + 3, insert: "[ ]" },
      { from: line.to, to: nextLine.to, insert: "" },
    ],
    userEvent: "myne.task-recurrence.unmaterialize",
  });
  return true;
}

/** Exposed for tests: the serialized form of a record, through the one seam. */
export { serializeTaskFields };

/**
 * A rule rendered in the reader's language (MYND-615 task 11's display half).
 *
 * The dialect hands back a descriptor — an i18n key plus its values — rather than
 * a string, because it has no catalogue and must stay platform-agnostic. This is
 * the desktop/editor side that turns one into text.
 *
 * **Read-only by construction.** Nothing here ever reaches a write path: the
 * chip stores the source bytes separately from what it displays, so the file
 * keeps its canonical English and a language switch moves no byte. That
 * separation is the entire safety property — a localized label leaking into the
 * write seam would put two languages in one vault.
 *
 * Weekday and ordinal names go through the catalogue individually rather than as
 * a pre-joined English string, since translating "monday,friday" as one blob is
 * not something a catalogue can do.
 */
export function recurrenceLabel(spec: RecurrenceSpec): string {
  const descriptor = describeRecurrenceRule(spec.rule);
  const values: Record<string, string | number> = { ...descriptor.values };

  const days = values.days;
  if (typeof days === "string") {
    values.days = days
      .split(",")
      .map((day) => i18n.t(`recurrence.weekday.${day}`))
      .join(i18n.t("recurrence.weekdaySeparator"));
  }
  const weekday = values.weekday;
  if (typeof weekday === "string") values.weekday = i18n.t(`recurrence.weekday.${weekday}`);
  const ordinal = values.ordinal;
  if (typeof ordinal === "string") values.ordinal = i18n.t(`recurrence.ordinal.${ordinal}`);

  const rule = i18n.t(descriptor.key, values);
  // The anchoring mode is part of what the rule MEANS, so it is shown rather
  // than dropped — a user who opted into completion-anchoring must be able to
  // see that they did.
  return spec.mode === "completion" ? i18n.t("recurrence.whenDone", { rule }) : rule;
}

/**
 * Whether this line's current occurrence can be skipped.
 *
 * The `+` menu asks before offering the affordance, because the test that
 * matters is not "does this line carry a repeat field" but "can this rule
 * actually be evaluated on this line" — an unreadable rule, or one with no
 * anchor date, must not be offered an action that would silently do nothing.
 */
export function canSkipOccurrence(line: string, clock: Clock = systemClock): boolean {
  return planSkippedOccurrence(line, clock()) !== null;
}

/**
 * Skip the current occurrence (MYND-615 task 8).
 *
 * The same date computation as completion, with **two differences**: it writes no
 * completion field, and it updates the existing line **in place** rather than
 * adding one. Both follow from what skipping means — "this occurrence did not
 * happen and will not".
 *
 * `markerFrom` locates the line; any position on it will do.
 */
export function skipOccurrence(
  view: EditorView,
  markerFrom: number,
  clock: Clock = systemClock,
): boolean {
  const line = view.state.doc.lineAt(markerFrom);
  const edit = planSkippedOccurrence(line.text, clock());
  if (edit === null) return false;

  view.dispatch({
    changes: {
      from: line.from + edit.range.start,
      to: line.from + edit.range.end,
      insert: edit.text,
    },
    userEvent: "myne.task-recurrence.skip",
  });
  return true;
}
