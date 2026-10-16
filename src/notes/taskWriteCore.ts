// The task write path, with its IO required rather than defaulted (MYND-620
// task 2).
//
// Split out of `toggleTask.ts` so a second client can use it. That file keeps
// the desktop bindings — `readNote`, `saveNote`, `completeNote`, the
// conflict-copy IPC — as module-level defaults, and ESM imports are eager, so
// importing it at all drags the whole desktop note-IO tree in. Mobile has its
// own IO for every one of those and would have had to **reimplement the
// sequence** instead.
//
// The sequence is the load-bearing part, which is exactly why it must not exist
// twice: flush dirty panes, verify the stored raw line still matches disk,
// flip the marker (carrying a recurring task's next occurrence with it), write
// with the content hash, and only then announce. Every step is there because of
// a specific way a task write goes wrong, and two copies would drift on
// whichever step a reader thought was incidental.
//
// Nothing here imports IO. `sha256Hex` is a pure hash, `isBaseMismatchError` is
// a type guard, `VaultTask` is a type, and the dialect helpers are line
// arithmetic — so this module resolves from any client without pulling a
// platform in.

import { sha256Hex } from "./baseHash";
import { isBaseMismatchError } from "../types/note-update-error";
import { todayCivilDate, type CivilDate } from "../dialect/civilDate";
import {
  matchesMaterializedOccurrence,
  planNextOccurrence,
} from "../dialect/taskRecurrence";
import type { VaultTask } from "./taskIndex";
import { TASK_LINE_RE } from "@myne/dialect/taskMarker";
import { isTaskLine, planTaskFieldWrite } from "@myne/dialect/taskFieldWriter";
import {
  parseTaskFields,
  parseTaskInstant,
  type TaskFields,
} from "@myne/dialect/taskFields";

// Re-exported so a consumer needs only this module — `taskIndex.ts` itself is
// Tauri- and React-coupled and must not be aliased into another client.
export type { VaultTask };

/**
 * A task's stable row identity. `(noteId, lineIndex)` is unique across the
 * vault; a note-task has no line, so it keys on `note`.
 *
 * It lives beside the writer rather than beside a surface because **more than
 * one surface mints it and the writer is what consumes it**: the panel's rows
 * and the query block's rows must agree byte-for-byte, or a toggle dispatched
 * by one cannot be resolved by the other. Two spellings of "which task is this"
 * would drift in the quietest possible way — the row renders, the write misses.
 */
export function taskRowKey(task: Pick<VaultTask, "noteId" | "lineIndex">): string {
  return `${task.noteId}:${task.lineIndex ?? "note"}`;
}

/**
 * Broadcast after a task write so any pane showing that note reloads its body.
 *
 * A bare window signal carrying the note id, following the `close-active-tab`
 * precedent: the writer has no route into the workspace React context that owns
 * the pane tree, and threading a callback through every task surface would put
 * the same plumbing in three places.
 */
export const TASK_WRITE_EVENT = "myne-task-written";

export type TaskWriteEventDetail = { noteId: string };

/** Why a task write was refused. Each is a distinct, explainable condition. */
export type TaskWriteRefusal =
  | "oversized"
  | "line-changed"
  | "line-missing"
  /**
   * The backend rejected the write because the note on disk had moved on since
   * the read — a sync pull-apply raced us (§11.3 expected-base guard). Nothing
   * was written, and the intended body was preserved as a keep-both conflict
   * copy rather than overwriting what sync delivered.
   */
  | "base-mismatch";

/**
 * A refusal, not a failure. Distinguished from an IPC error so a caller can show
 * an explanation instead of a generic "couldn't save".
 */
export class TaskWriteRefused extends Error {
  constructor(
    readonly reason: TaskWriteRefusal,
    readonly noteId: string,
  ) {
    super(`task write refused (${reason}) for note ${noteId}`);
    this.name = "TaskWriteRefused";
  }
}

/** Seams, injected so the writer is testable without a running vault. */
/**
 * The IO this module needs, all of it required.
 *
 * Optional-with-a-default is what made the original untransportable: a default
 * is an eager import. Every client names its own.
 */
export type RequiredTaskWriteIo = Required<
  Omit<TaskWriteDeps, "flushDirtyPanes" | "today">
> & {
  flushDirtyPanes?: () => Promise<void>;
  today?: () => CivilDate;
};

export type TaskWriteDeps = {
  /** Flush every pane with unsaved keystrokes. Omitted in tests. */
  flushDirtyPanes?: () => Promise<void>;
  /**
   * Today, for advancing a recurring task. Omitted → the system clock.
   *
   * Deliberately NOT part of the required set: every client already names its
   * own IO for the other members, and making this one mandatory would break
   * each of them for a value they have no opinion about.
   */
  today?: () => CivilDate;
  readNote?: (noteId: string) => Promise<string>;
  writeNote?: (noteId: string, body: string, baseHashHex: string) => Promise<unknown>;
  completeNoteTask?: (noteId: string) => Promise<void>;
  uncompleteNoteTask?: (noteId: string) => Promise<void>;
  /** Emit the reload signal. Omitted → a real window event. */
  announce?: (noteId: string) => void;
  /**
   * Preserve a rejected write as a keep-both copy (MYND-617 task 7). Injected
   * so the writer can be tested without the conflict-copy IPC.
   */
  createConflictCopy?: (body: string, originalNoteId: string) => Promise<string>;
};

/** The default announcement: a bare window event carrying the note id. */
export function announceWrite(noteId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TaskWriteEventDetail>(TASK_WRITE_EVENT, { detail: { noteId } }),
  );
}

/**
 * Flip a task line's marker. Returns null when the line carries no marker.
 *
 * A line already in the requested state comes back **byte-identical**, and the
 * comparison is on the marker's MEANING rather than on the rendered string.
 * That distinction is the whole point: `[X]` and `[x]` both mean completed, so
 * re-asserting "completed" on an imported `[X]` must not rewrite it to `[x]`.
 * Doing so would be a normalization §6 C1 says this layer does not perform, and
 * `TaskRecord`'s own doc promises the uppercase marker survives untouched.
 */
export function flipMarker(line: string, completed: boolean): string | null {
  // `TASK_LINE_RE` rather than a restated shape. The restated one accepted
  // `- [ ]foo`, which the parser does not read as a task at all, so flipping a
  // checkbox on such a line rewrote a character no reader treats as one
  // (myne-md/myne#593).
  const match = TASK_LINE_RE.exec(line);
  if (match === null) return null;
  const current = match[2]!;
  if ((current === "x" || current === "X") === completed) return line;
  const prefix = match[1]!;
  const marker = completed ? "[x]" : "[ ]";
  return `${prefix}${marker}${line.slice(match[0].length)}`;
}

/**
 * Materialize or un-materialize a recurring task's next occurrence, in place.
 *
 * The mirror of what the editor's checkbox does (`@myne/editor`'s
 * `completeRecurringTask` / `uncompleteRecurringTask`) — same computation, same
 * conditions, applied to a line array instead of a CodeMirror document, because
 * a task ticked from a list is usually in a note no pane has open. Both surfaces
 * call the same dialect functions, so neither can drift from the other.
 *
 * `sourceLine` is the line as it stood BEFORE the marker flip: materialization
 * reads the unticked line, and orphan detection recomputes from the ticked one.
 *
 * Line-count changes are safe here because the whole body is re-joined and
 * written as one note, and the index is rebuilt from what was written — nothing
 * downstream holds a line number across this call.
 *
 * A CRLF note's lines each end in a stray `\r` after the `\n` split. It is
 * stripped before the arithmetic and restored after, so a materialized
 * occurrence carries the file's own line ending rather than introducing a second
 * one — the same care `flipMarker` takes by slicing rather than rebuilding.
 */
function applyRecurrence(
  lines: string[],
  lineIndex: number,
  sourceLine: string,
  completed: boolean,
  today: CivilDate,
): void {
  const cr = sourceLine.endsWith("\r") ? "\r" : "";
  const source = cr === "" ? sourceLine : sourceLine.slice(0, -1);

  if (completed) {
    const occurrence = planNextOccurrence(source, today);
    if (occurrence !== null) lines.splice(lineIndex + 1, 0, `${occurrence}${cr}`);
    return;
  }

  const successor = lines[lineIndex + 1];
  if (successor === undefined) return;
  // An occurrence we cannot positively identify is user content — leave it.
  if (!matchesMaterializedOccurrence(source, successor.replace(/\r$/, ""), today)) return;
  lines.splice(lineIndex + 1, 1);
}

/**
 * Complete or un-complete `task`. The one write path for every task surface.
 *
 * Rejects with {@link TaskWriteRefused} when the record cannot be written
 * safely, and with whatever the IPC layer propagates otherwise.
 */
export async function writeTaskCompletion(
  task: VaultTask,
  completed: boolean,
  io: RequiredTaskWriteIo,
): Promise<void> {
  const {
    flushDirtyPanes,
    readNote,
    writeNote,
    completeNoteTask,
    uncompleteNoteTask,
    announce,
    createConflictCopy,
    today,
  } = io;

  // Flush BEFORE anything reads. A pane holding unsaved keystrokes has a newer
  // body than disk, and patching the stale copy would be undone by the flush.
  await flushDirtyPanes?.();

  // A note-task has no line to locate — the whole note is the task — so it goes
  // through the frontmatter patcher. The locator IS the discriminator; keeping
  // the branch here is what lets every reader surface stay unaware of it.
  if (task.lineIndex === null) {
    if (completed) await completeNoteTask(task.noteId);
    else await uncompleteNoteTask(task.noteId);
    announce(task.noteId);
    return;
  }

  // An over-cap record carries a truncated raw line, so the verification below
  // is impossible. Refuse rather than write something unverifiable.
  if (task.oversized) throw new TaskWriteRefused("oversized", task.noteId);

  const source = await readNote(task.noteId);
  const lines = source.split("\n");
  const current = lines[task.lineIndex];
  if (current === undefined) throw new TaskWriteRefused("line-missing", task.noteId);

  // The index is a cache and may be an autosave behind. The stored raw line is
  // the evidence that the record still describes reality; a mismatch means the
  // note moved and this write would land on the wrong text.
  if (current.replace(/\r$/, "") !== task.rawLine) {
    throw new TaskWriteRefused("line-changed", task.noteId);
  }

  const next = flipMarker(current, completed);
  if (next === null) throw new TaskWriteRefused("line-changed", task.noteId);
  if (next === current) return; // already in the requested state — no write

  lines[task.lineIndex] = next;
  // A recurring task carries its next occurrence with it, in the SAME write —
  // one note body, one hash guard, one snapshot. Reads `current`, the line as it
  // stood before the flip.
  applyRecurrence(lines, task.lineIndex, current, completed, (today ?? todayCivilDate)());
  const body = lines.join("\n");

  // The content-hash guard: if a sync pull-apply raced this write, the backend
  // rejects it and nothing is clobbered.
  //
  // The hash is passed **always**, not optionally. Every other cross-note writer
  // in the codebase omits it — but those patch idempotent frontmatter fields,
  // and a body-line checkbox flip is not idempotent-safe: applied to a body the
  // user has since edited, it lands on the wrong line. The **transactional batch
  // writer must not be used here** for the same reason: it takes no hash and
  // does not take the write lock, so it races the sync engine.
  try {
    await writeNote(task.noteId, body, await sha256Hex(source));
  } catch (err) {
    if (!isBaseMismatchError(err)) throw err;
    // Keep-both, not overwrite: the body this tick WOULD have written is
    // preserved as a conflict copy, and what sync delivered stays on disk
    // untouched. No write, no snapshot, no index touch on the original.
    await createConflictCopy(body, task.noteId);
    throw new TaskWriteRefused("base-mismatch", task.noteId);
  }
  announce(task.noteId);
}

/** The four editable inline fields, in the same vocabulary the field editor
 *  uses.
 *
 *  Declared here rather than imported from `@myne/editor`, because this module
 *  is the VIEW-FREE half of the write path and an editor import would put the
 *  editor in a list surface's graph. The two unions are structurally identical;
 *  what the equivalence spec holds is that the writers AGREE on every kind its
 *  table lists, which is not the same as catching a member added to one side
 *  alone (myne-md/myne#884 review).
 */
export type TaskFieldKind = "due" | "remind" | "repeat" | "priority";

/**
 * Rewrite one inline field on a task line, view-free. Returns the new line, or
 * `null` when the line already reads exactly as the write would.
 *
 * **The same coercion the editor's span-based write performs**, then the same
 * `planTaskFieldWrite` edit applied to the line instead of dispatched at a view.
 * The duplication is bounded by `tests/notes/taskFieldWrite.test.ts`, which
 * drives both over one table: the editor's half needs an `EditorView`, and this
 * half must not know the editor exists. A value `parseTaskInstant` refuses is
 * carried as `malformed` rather than dropped, so a list edit cannot delete a
 * typo the user typed.
 *
 * The caller must hand it a task line; `planTaskFieldWrite` has no opinion about
 * list markers, because its caller owns any conversion.
 */
export function rewriteTaskField(
  line: string,
  kind: TaskFieldKind,
  value: string,
): string | null {
  const current = parseTaskFields(line);
  const next: TaskFields = { ...current };

  if (kind === "priority") {
    next.priority = value === "" ? undefined : (value as TaskFields["priority"]);
  } else if (kind === "repeat") {
    next.repeat = value === "" ? undefined : value;
  } else {
    const instant = value === "" ? null : parseTaskInstant(value);
    next[kind] = instant ?? undefined;
    if (instant === null && value !== "") {
      next.malformed = [
        ...current.malformed.filter((f) => f.key !== kind),
        // `raw` is left empty rather than carrying a byte-shaped string: the
        // dialect writer emits `raw` in place of `key`/`value` exactly when the
        // value contains a `]` (taskFieldWriter.ts), and no value this function
        // is handed can (the editor's own coercion does the same).
        { key: kind, value, raw: "" },
      ];
    } else {
      next.malformed = current.malformed.filter((f) => f.key !== kind);
    }
  }

  const edit = planTaskFieldWrite(line, next);
  if (edit === null) return null;
  return line.slice(0, edit.range.start) + edit.text + line.slice(edit.range.end);
}

/**
 * One inline field's SOURCE value on a task line, or `undefined` when the line
 * does not carry that field.
 *
 * The read half of {@link rewriteTaskField}, so a caller holding only a record's
 * raw line can answer what the field editor should prefill. A value that did not
 * parse is reported as absent rather than as its raw bytes, which matches what
 * the note's own chips do: an unreadable date renders as plain text with a hint,
 * not as a chip, so there is nothing for a surface to prefill from either.
 */
export function readTaskField(line: string, kind: TaskFieldKind): string | undefined {
  const fields = parseTaskFields(line);
  if (kind === "priority") return fields.priority;
  if (kind === "repeat") return fields.repeat;
  const instant = fields[kind];
  if (instant === undefined) return undefined;
  return instant.time === undefined ? instant.date : `${instant.date} ${instant.time}`;
}

/**
 * The IO a field rewrite needs. Deliberately NOT the completion path's full set:
 * a field never touches the frontmatter, so the note-completion pair and the
 * recurrence clock are absent rather than accepted-and-ignored. A client that
 * already satisfies the wider type satisfies this one structurally.
 */
export type TaskFieldWriteIo = Required<
  Omit<
    TaskWriteDeps,
    "flushDirtyPanes" | "today" | "completeNoteTask" | "uncompleteNoteTask"
  >
> & {
  /** Flush every pane with unsaved keystrokes. Omitted in tests. */
  flushDirtyPanes?: () => Promise<void>;
};

/**
 * Rewrite one inline field on `task`'s line. The second mutation beside
 * {@link writeTaskCompletion}, for the same reason it exists: a surface with no
 * editor in it has to be able to write, and the sequence that makes that safe is
 * not one a second caller should reimplement.
 *
 * Rejects with {@link TaskWriteRefused} when the record cannot be written safely
 * (a stale stored line, an over-cap record, a line that has gone or is no longer
 * a task), and with whatever the IPC layer propagates otherwise.
 */
export async function writeTaskField(
  task: VaultTask,
  kind: TaskFieldKind,
  value: string,
  io: TaskFieldWriteIo,
): Promise<void> {
  const { flushDirtyPanes, readNote, writeNote, announce, createConflictCopy } = io;

  // Flush BEFORE anything reads: a pane holding unsaved keystrokes has a newer
  // body than disk, and patching the stale copy would be undone by the flush.
  await flushDirtyPanes?.();

  // A note-task has no line: its "fields" are the note's own frontmatter, which
  // the completion path patches and this mutation does not. The locator IS the
  // discriminator, exactly as it is there.
  if (task.lineIndex === null) throw new TaskWriteRefused("line-missing", task.noteId);

  // An over-cap record carries a truncated raw line, so the verification below
  // is impossible. Refuse rather than write something unverifiable.
  if (task.oversized) throw new TaskWriteRefused("oversized", task.noteId);

  const source = await readNote(task.noteId);
  const lines = source.split("\n");
  const current = lines[task.lineIndex];
  if (current === undefined) throw new TaskWriteRefused("line-missing", task.noteId);

  // The index is a cache and may be an autosave behind. The stored raw line is
  // the evidence the record still describes reality; a mismatch means the note
  // moved and this write would land on the wrong text. The terminator is the
  // file's business, so a CRLF note is not a mismatch.
  const cr = current.endsWith("\r") ? "\r" : "";
  const lineText = cr === "" ? current : current.slice(0, -1);
  if (lineText !== task.rawLine) throw new TaskWriteRefused("line-changed", task.noteId);

  // A task line, not prose. The writer appends a field to ANY line it is handed
  // (its caller owns the conversion), so a row whose line has since become a
  // paragraph would otherwise turn that paragraph into a task.
  if (!isTaskLine(lineText)) throw new TaskWriteRefused("line-changed", task.noteId);

  const rewritten = rewriteTaskField(lineText, kind, value);
  if (rewritten === null) return; // already reads as the write would - no write

  lines[task.lineIndex] = `${rewritten}${cr}`;
  const body = lines.join("\n");

  // The content-hash guard, for the reason the marker flip carries it: a sync
  // pull-apply racing this write is rejected by the backend rather than
  // clobbered. The hash is of what was READ, and the transactional batch writer
  // takes no hash at all, so it must not be used here.
  try {
    await writeNote(task.noteId, body, await sha256Hex(source));
  } catch (err) {
    if (!isBaseMismatchError(err)) throw err;
    // Keep-both, not overwrite: the body this edit WOULD have written is
    // preserved as a conflict copy, and what sync delivered stays on disk
    // untouched. No write, no snapshot, no index touch on the original.
    await createConflictCopy(body, task.noteId);
    throw new TaskWriteRefused("base-mismatch", task.noteId);
  }
  announce(task.noteId);
}

