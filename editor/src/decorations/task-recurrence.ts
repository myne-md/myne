// Materialize the next occurrence when a recurring task is ticked
// (MYND-615, tasks 7 and 9).
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

import type { EditorView } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import { parseTaskFields, type TaskFields } from "@myne/dialect/taskFields";
import { planTaskFieldWrite, serializeTaskFields } from "@myne/dialect/taskFieldWriter";
import {
  describeRecurrenceRule,
  parseRecurrenceSpec,
  type RecurrenceSpec,
} from "@myne/dialect/recurrence";
import {
  advancePair,
  formatCivilDate,
  parseCivilDate,
  type CivilDate,
} from "@myne/dialect/civilDate";

/** Today, as a civil date. Injected in tests; there is no hidden clock. */
export type Clock = () => CivilDate;

export const systemClock: Clock = () => {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
};

/** The next-occurrence line for a completed recurring task, or null. */
export function nextOccurrenceLine(line: string, today: CivilDate): string | null {
  const fields = parseTaskFields(line);
  if (fields.repeat === undefined) return null;

  const spec = parseRecurrenceSpec(fields.repeat);
  // An unrecognized rule materializes nothing — it must look unread rather than
  // silently behaving as some default (MYND-615 task 10 surfaces that state).
  if (!spec.ok) return null;

  const due = fields.due === undefined ? undefined : parseCivilDate(fields.due.date);
  const remind = fields.remind === undefined ? undefined : parseCivilDate(fields.remind.date);
  const advanced = advancePair(spec.spec, {
    due: due ?? undefined,
    remind: remind ?? undefined,
    today,
  });
  if (advanced.due === undefined && advanced.remind === undefined) return null;

  // The new occurrence carries the same rule and the advanced dates, and NO
  // completion field — it has not happened yet.
  const next: TaskFields = {
    ...fields,
    done: undefined,
    due:
      advanced.due === undefined
        ? undefined
        : { date: formatCivilDate(advanced.due), ...(fields.due?.time === undefined ? {} : { time: fields.due.time }) },
    remind:
      advanced.remind === undefined
        ? undefined
        : {
            date: formatCivilDate(advanced.remind),
            ...(fields.remind?.time === undefined ? {} : { time: fields.remind.time }),
          },
  };

  // Rebuild through the single writer seam: description text preserved, fields
  // re-emitted in Myne's form.
  const edit = planTaskFieldWrite(line, next);
  const rebuilt =
    edit === null ? line : line.slice(0, edit.range.start) + edit.text + line.slice(edit.range.end);

  // The new line is unticked regardless of the source marker's case.
  return rebuilt.replace(/^(\s*[-*+]\s*)\[[xX]\]/, "$1[ ]");
}

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

  const occurrence = nextOccurrenceLine(line.text, clock());
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
 * unrecoverably, so the removal happens only when SIX conditions all hold: the
 * next line is a task, its description matches exactly, its dates equal what this
 * function would have computed, its other fields match, it is unticked, and it
 * carries no completion field. Single-step reversibility — one undo restores
 * both halves — is what brings the residual risk down to acceptable. It is still
 * a heuristic and should be treated as one.
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

  // What this line WOULD have produced, recomputed rather than remembered.
  const expected = nextOccurrenceLine(line.text.replace(/\[[xX]\]/, "[ ]"), clock());
  if (expected === null) return false;

  const isOrphan =
    nextLine.text === expected &&
    /^\s*[-*+]\s*\[ \]/.test(nextLine.text) &&
    parseTaskFields(nextLine.text).done === undefined;

  if (!isOrphan) {
    // Leave it alone — an orphan we cannot positively identify is user content.
    return false;
  }

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
 * Skip the current occurrence (MYND-615 task 8).
 *
 * The same date computation as completion, with **two differences**: it writes no
 * completion field, and it updates the existing line **in place** rather than
 * adding one.
 *
 * Both follow from what skipping means — "this occurrence did not happen and will
 * not". Leaving a ticked marker would be a lie, and leaving a record of the skip
 * would be per-occurrence history, which the epic rejected. In
 * completion-anchored mode skip computes from today, since there is no completion
 * to anchor on.
 */
export function skipOccurrence(
  view: EditorView,
  markerFrom: number,
  clock: Clock = systemClock,
): boolean {
  const line = view.state.doc.lineAt(markerFrom);
  const fields = parseTaskFields(line.text);
  if (fields.repeat === undefined) return false;

  const spec = parseRecurrenceSpec(fields.repeat);
  if (!spec.ok) return false;

  const today = clock();
  const due = fields.due === undefined ? undefined : parseCivilDate(fields.due.date);
  const remind = fields.remind === undefined ? undefined : parseCivilDate(fields.remind.date);
  const advanced = advancePair(spec.spec, {
    due: due ?? undefined,
    remind: remind ?? undefined,
    today,
    // In completion-anchored mode there is no completion, so skip counts from
    // today — the only defensible anchor for an occurrence that did not happen.
    completedOn: today,
  });
  if (advanced.due === undefined && advanced.remind === undefined) return false;

  const next: TaskFields = {
    ...fields,
    // No completion field: the occurrence did not happen.
    done: undefined,
    due:
      advanced.due === undefined
        ? undefined
        : {
            date: formatCivilDate(advanced.due),
            ...(fields.due?.time === undefined ? {} : { time: fields.due.time }),
          },
    remind:
      advanced.remind === undefined
        ? undefined
        : {
            date: formatCivilDate(advanced.remind),
            ...(fields.remind?.time === undefined ? {} : { time: fields.remind.time }),
          },
  };

  const edit = planTaskFieldWrite(line.text, next);
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
