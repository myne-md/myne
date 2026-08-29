// Single writer seam: typed record to bytes (MYND-611, task 3).
//
// THE ONLY MODULE IN THE CODEBASE THAT EMITS TASK-FIELD BYTES. A second body
// writer would be a regression against the recorded single-writer discipline, and
// this seam is what makes a future format switch a one-line change — both
// MYND-614's convert-on-edit (SYNC-30) and MYND-615's materialization (SYNC-34)
// route through here.
//
// Myne reads three dialects and writes ONE: Dataview-style bracketed fields with
// Myne's key names. Obsidian parity is a read goal, not a write goal — the
// consequence, accepted at the epic level, is that an imported task edited here
// drops out of the user's Obsidian Tasks view.
//
// Returns a change SPECIFICATION rather than dispatching, so the caller can bundle
// it into a single transaction and a single undo.

import type { Tree } from "@lezer/common";
import type { ByteRange } from "./types";
import { parser } from "./lezer/parser";
import type { PreservedTaskField, TaskFields, TaskInstant } from "./taskFields";
import type { LineTask } from "./visitors/lineTasks";
import { TASK_LINE_RE } from "./taskMarker";

/** A byte range to replace and the text to replace it with. */
export type TaskLineEdit = { range: ByteRange; text: string };

/**
 * The outcome of planning a write against an indexed record. A refusal and a
 * no-op are deliberately distinguishable: collapsing them would let a caller
 * treat a refused write as a successful one and report a change that never
 * happened.
 */
export type TaskWritePlan =
  | { ok: true; edit: TaskLineEdit | null }
  | { ok: false; reason: "oversized" };

function instant(value: TaskInstant): string {
  return value.time === undefined ? value.date : `${value.date} ${value.time}`;
}

function field(key: string, value: string): string {
  return `[${key}:: ${value}]`;
}

/**
 * A record as Myne writes it: the five typed fields in a stable order, then the
 * fields Myne recognized but does not type, then the ones whose values did not
 * parse. Stable order matters — an unstable one would make every edit produce a
 * spurious diff on the line.
 *
 * `preserved` and `malformed` are emitted verbatim by value, which is what keeps
 * a whole-line rewrite from destroying data Myne never understood — including
 * `onCompletion`, which is carried without ever being interpreted.
 */
export function serializeTaskFields(fields: TaskFields): string {
  const parts: string[] = [];

  if (fields.due !== undefined) parts.push(field("due", instant(fields.due)));
  if (fields.priority !== undefined) parts.push(field("priority", fields.priority));
  if (fields.remind !== undefined) parts.push(field("remind", instant(fields.remind)));
  if (fields.repeat !== undefined) parts.push(field("repeat", fields.repeat));
  if (fields.done !== undefined) parts.push(field("done", instant(fields.done)));

  const verbatim = (f: PreservedTaskField) => parts.push(field(f.key, f.value));
  fields.preserved.forEach(verbatim);
  fields.malformed.forEach(verbatim);

  return parts.join(" ");
}

/** Byte ranges of every `TaskField` node on the line, in document order. */
function fieldRanges(line: string, tree?: Tree): ByteRange[] {
  const t = tree ?? parser.parse(line);
  const ranges: ByteRange[] = [];
  t.iterate({
    enter: (n) => {
      if (n.name !== "TaskField") return undefined;
      ranges.push({ start: n.from, end: n.to });
      return false;
    },
  });
  return ranges;
}

/** `line` with every task-field span removed and doubled separators collapsed. */
function stripFieldSpans(line: string, ranges: readonly ByteRange[]): string {
  let out = "";
  let cursor = 0;
  for (const r of ranges) {
    out += line.slice(cursor, r.start);
    cursor = r.end;
  }
  out += line.slice(cursor);
  // Collapsing runs of whitespace repairs the doubled separators that removing
  // a field span leaves behind — but the LEADING run is not a separator, it is
  // the list indentation, and collapsing it moves a sub-task up a level. Split
  // it off, collapse the rest.
  const indent = /^[ \t]*/.exec(out)![0];
  return (
    indent +
    out
      .slice(indent.length)
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+$/, "")
  );
}

/**
 * The list-marker + checkbox prefix of a task line, plus the run of whitespace
 * `taskDescription` strips before the description starts. Shared by
 * `taskDescription` and `isTaskLine`, so the two cannot disagree about what
 * counts as a task line.
 *
 * Built FROM `TASK_LINE_RE` rather than restated. The restated version was lax:
 * `\\s*` after the checkbox accepts zero whitespace, so `- [ ]foo` passed here
 * while `@lezer/markdown`'s GFM `TaskList` leaf, which requires the separator,
 * does not see a task at all. A field written to such a line lands on something
 * no reader parses as a task (myne-md/myne#593).
 */
const TASK_LINE_MARKER = new RegExp(`${TASK_LINE_RE.source}[ \\t]*`);

/**
 * The same marker for STRIPPING it, where the separator is optional.
 *
 * Two different questions, and one shape cannot answer both. Deciding whether a
 * line IS a task requires the separator, because the parser requires it.
 * REMOVING the marker runs over text `stripFieldSpans` has already trimmed, so
 * on a line whose description is empty or was nothing but fields the separator
 * is gone by the time this runs, and a required one simply fails to match.
 *
 * That is not hypothetical: with the required form, `taskDescription("- [ ]
 * @due(2026-01-01)")` returned the literal `"- [ ]"` instead of `""`, and every
 * fields-only and every empty task rendered that string in the Tasks panel and
 * in every `task-query` block, in place of the untitled placeholder. `/due` on a
 * blank line auto-converts to `- [ ] ` and writes the field, so it is one
 * documented keystroke away.
 */
const TASK_LINE_MARKER_STRIP = new RegExp(
  `^(\\s*[-*+][ \\t]+)\\[([ xX])\\][ \\t]*`,
);

/**
 * Whether `line` is a line-task: a list marker followed by a `[ ]` / `[x]`
 * checkbox. Purely lexical — it does not look at the fields.
 *
 * Exported so a caller wanting to *add* a field to the caret's line (the `+`
 * affordance and the `/due` `/repeat` `/priority` slash commands) can tell a
 * task line from prose without restating the marker pattern, and auto-convert a
 * non-task line the same way `/todo` does.
 */
export function isTaskLine(line: string): boolean {
  return TASK_LINE_MARKER.test(line);
}

/**
 * A task line's **description**: the list marker, the checkbox and every task
 * field removed.
 *
 * This is what a task-list row displays, and it lives here rather than in the
 * consuming surface because it is the same derivation the writer already
 * performs to rebuild a line — both now call `stripFieldSpans`. A second
 * implementation in the panel would drift from this one the first time the
 * field grammar moved, and the two would disagree about what a task is *called*.
 *
 * Purely derived: nothing here emits bytes into a document.
 */
export function taskDescription(line: string, tree?: Tree): string {
  return stripFieldSpans(line, fieldRanges(line, tree))
    .replace(TASK_LINE_MARKER_STRIP, "")
    .trim();
}

/**
 * Put back the separator the parser requires after `[ ]`, when stripping left a
 * line that is nothing but its marker.
 *
 * `stripFieldSpans` ends by right-trimming, so clearing the last field from a
 * description-less task takes `- [ ] @due(2026-01-01)` to `- [ ]`. That line has
 * no separator, so `@lezer/markdown`'s GFM `TaskList` leaf does not see a task
 * at all and the checkbox disappears.
 *
 * Before the marker shapes were consolidated, both repair paths still accepted
 * it: `isTaskLine` and `flipMarker` each ended in `\s*`, which matches nothing.
 * They are now built on `TASK_LINE_RE` with its required-separator lookahead, so
 * the line this writer produced was one that no other writer in the tree could
 * flip or rewrite: a persisted task silently became prose the task machinery
 * would not touch again. The bytes were intact, so it was never data loss, and
 * that is exactly what made it quiet.
 *
 * The reachable path is one keystroke: `/due` on a blank line auto-converts to
 * `- [ ] ` and writes the field, and clearing that field again is the trigger.
 *
 * Restoring the space rather than refusing the write is the right half to fix.
 * The user asked for the field to go; the separator is the parser's requirement,
 * not their content.
 */
function restoreTaskSeparator(rewritten: string): string {
  const marker = TASK_LINE_MARKER_STRIP.exec(rewritten);
  if (marker === null) return rewritten;
  // Already carries the separator, or has a description after it.
  if (rewritten.length > marker[0].length) return rewritten;
  return `${rewritten} `;
}

/**
 * The change that rewrites `line`'s task fields as `next`.
 *
 * The whole line is converted, not just the field that changed: every task field
 * on it is re-emitted in Myne's form. That follows from the dialect rule that only
 * lines directly changed adopt canonical forms, and it is the behaviour MYND-614
 * task 7 makes active rather than latent.
 *
 * Description text is preserved byte-for-byte; only the field spans and the
 * whitespace that separated them are rewritten. Returns `null` when the line
 * already reads exactly as `next` would write it.
 */
export function planTaskFieldWrite(
  line: string,
  next: TaskFields,
  tree?: Tree,
): TaskLineEdit | null {
  const ranges = fieldRanges(line, tree);
  const serialized = serializeTaskFields(next);

  // Description = the line with every field span removed, collapsed where
  // removing a span left doubled separators behind. Shared with
  // `taskDescription`, which differs only in also dropping the list marker.
  const description = stripFieldSpans(line, ranges);

  const rewritten = restoreTaskSeparator(
    serialized === "" ? description : `${description}${description === "" ? "" : " "}${serialized}`,
  );

  if (rewritten === line) return null;

  // The edit spans from the first byte that actually differs to the end of the
  // line, so an unchanged prefix is never included in the transaction.
  let prefix = 0;
  const limit = Math.min(line.length, rewritten.length);
  while (prefix < limit && line[prefix] === rewritten[prefix]) prefix++;

  return {
    range: { start: prefix, end: line.length },
    text: rewritten.slice(prefix),
  };
}

/**
 * Plan a write against an **indexed record** rather than a raw line.
 *
 * This is the guard that makes the MYND-612 task-5 cap safe: an over-cap record
 * carries a truncated `rawLine`, and the raw line is the authority for the
 * pre-write verification, so writing from it would produce a line the writer
 * cannot verify — silently corrupting a task that is merely long. The refusal is
 * explicit and typed rather than a thrown error or a `null`, because a caller
 * must be able to tell "refused" from "nothing to change".
 */
export function planLineTaskWrite(task: LineTask, next: TaskFields): TaskWritePlan {
  if (task.oversized === true) return { ok: false, reason: "oversized" };
  return { ok: true, edit: planTaskFieldWrite(task.rawLine, next) };
}
