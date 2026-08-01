// What a recurring task line becomes when it is completed, un-completed or
// skipped — as plain line arithmetic, with no editor in sight (myne#198).
//
// The arithmetic used to live in `editor/src/decorations/task-recurrence.ts`,
// bound to a CodeMirror `EditorView`. That was fine while the editor's checkbox
// was the only surface that could tick a task — but it is not: the Tasks panel
// and the query block write through `src/notes/taskWriteCore.ts`, which patches
// a note that is usually **not open in any pane** and therefore has no view to
// hand over. Leaving the computation behind the view is what let one surface
// recur and the other not.
//
// So it lives here, where both callers can reach it: the editor wraps these in
// CodeMirror transactions, the writer applies them to a line array. There is one
// computation, and neither surface can drift from the other.
//
// **Nothing here dispatches, reads a clock, or touches IO.** `today` is a
// parameter for the same reason the editor's `Clock` was injectable — a hidden
// clock is untestable and, on a date boundary, non-deterministic.

import { parseTaskFields, type TaskFields } from "./taskFields";
import { planTaskFieldWrite, type TaskLineEdit } from "./taskFieldWriter";
import { parseRecurrenceSpec } from "./recurrence";
import {
  advancePair,
  formatCivilDate,
  parseCivilDate,
  type CivilDate,
} from "./civilDate";

/**
 * Whether `line`'s recurrence rule can actually be evaluated on this line
 * (myne#197).
 *
 * Three conditions: the line carries a `repeat` field, the closed vocabulary
 * reads the rule, and there is an anchor date to advance from (`due`, else
 * `remind`). **No `today` parameter** — none of the three depends on the
 * calendar, and a display layer asking this question must not read a clock.
 *
 * It exists because *parseable* and *evaluable* are different questions and the
 * chip layer was asking the first one while promising the second. A rule with no
 * anchor parses perfectly and then does nothing, which is the data-loss-shaped
 * silence `decorations/task-chip.ts` forbids itself.
 *
 * It reads the same three conditions `advancedFields` does. They stay separate
 * functions — one is a predicate, the other computes dates — but a test pins
 * their equivalence, so they cannot drift apart quietly.
 */
export function canRecur(line: string): boolean {
  const fields = parseTaskFields(line);
  if (fields.repeat === undefined) return false;
  if (!parseRecurrenceSpec(fields.repeat).ok) return false;

  const due = fields.due === undefined ? null : parseCivilDate(fields.due.date);
  const remind = fields.remind === undefined ? null : parseCivilDate(fields.remind.date);
  return due !== null || remind !== null;
}

/**
 * The advanced field set for `line`, or null when the rule cannot be evaluated.
 *
 * Null covers three distinct declines that share one answer — no rule, a rule
 * outside the vocabulary, and a rule with no anchor date to advance from. The
 * unrecognized case is deliberate: inventing "every day" would repeat a task the
 * user never asked to repeat. The anchorless case is myne#197's territory; here
 * it simply produces nothing.
 */
function advancedFields(
  line: string,
  today: CivilDate,
  completedOn?: CivilDate,
): TaskFields | null {
  const fields = parseTaskFields(line);
  if (fields.repeat === undefined) return null;

  const spec = parseRecurrenceSpec(fields.repeat);
  if (!spec.ok) return null;

  const due = fields.due === undefined ? undefined : parseCivilDate(fields.due.date);
  const remind = fields.remind === undefined ? undefined : parseCivilDate(fields.remind.date);
  const advanced = advancePair(spec.spec, {
    due: due ?? undefined,
    remind: remind ?? undefined,
    today,
    ...(completedOn === undefined ? {} : { completedOn }),
  });
  if (advanced.due === undefined && advanced.remind === undefined) return null;

  return {
    ...fields,
    // The next occurrence has not happened yet, so it carries no completion
    // field — whatever the source line carried.
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
}

/**
 * The next-occurrence line a completed recurring task materializes, or null.
 *
 * The result is a whole line, meant to be **inserted after** the completed one —
 * the completed line keeps its own bytes, so an imported file's untouched text
 * stays untouched (§6 C1).
 */
export function planNextOccurrence(line: string, today: CivilDate): string | null {
  const next = advancedFields(line, today);
  if (next === null) return null;

  // Rebuild through the single writer seam: description text preserved, fields
  // re-emitted in Myne's form.
  const edit = planTaskFieldWrite(line, next);
  const rebuilt =
    edit === null ? line : line.slice(0, edit.range.start) + edit.text + line.slice(edit.range.end);

  // The new line is unticked regardless of the source marker's case.
  return rebuilt.replace(/^(\s*[-*+]\s*)\[[xX]\]/, "$1[ ]");
}

/**
 * The in-place edit that skips `line`'s current occurrence, or null.
 *
 * Two differences from completion, and both follow from what skipping means —
 * "this occurrence did not happen and will not": no completion field is written,
 * and the existing line is advanced rather than a new one added, so the line
 * count does not grow. Leaving a ticked marker would be a lie, and leaving a
 * record of the skip would be per-occurrence history, which the epic rejected.
 *
 * Returned as a byte-range edit rather than a whole line so the caller can
 * dispatch the minimal change — the unchanged prefix never enters the
 * transaction, and the caret survives it.
 *
 * In completion-anchored mode there is no completion to anchor on, so skip
 * counts from today — the only defensible anchor for an occurrence that did not
 * happen.
 */
export function planSkippedOccurrence(line: string, today: CivilDate): TaskLineEdit | null {
  const next = advancedFields(line, today, today);
  if (next === null) return null;
  return planTaskFieldWrite(line, next);
}

/**
 * Whether `candidate` is exactly the occurrence `completedLine` materialized.
 *
 * Deleting user file content on a heuristic fails rarely but fails
 * unrecoverably, so this demands that everything line up: the candidate is a
 * task, its description matches, its dates equal what this module would have
 * computed, its other fields match, it is unticked, and it carries no completion
 * field. Equality against a **recomputed** line is what folds the first four
 * conditions into one comparison — nothing is remembered between the tick and
 * the un-tick, so there is no stored link to go stale.
 *
 * It remains a heuristic and should be treated as one in review. What brings the
 * residual risk down to acceptable is that the caller removes it in the same
 * transaction as the un-tick, so one undo restores both halves.
 */
export function matchesMaterializedOccurrence(
  completedLine: string,
  candidate: string,
  today: CivilDate,
): boolean {
  // What the completed line WOULD have produced, recomputed rather than
  // remembered.
  const expected = planNextOccurrence(completedLine.replace(/\[[xX]\]/, "[ ]"), today);
  if (expected === null) return false;

  return (
    candidate === expected &&
    /^\s*[-*+]\s*\[ \]/.test(candidate) &&
    parseTaskFields(candidate).done === undefined
  );
}
