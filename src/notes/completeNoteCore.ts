// `completeNote` / `uncompleteNote` — the note-task lifecycle (MYND-613).
//
// `done:` is the 9th Myne-managed canonical FM field — the twelfth and newest
// member of the set (markdown-dialect §3.6.1). Ordinals here are TABLE positions,
// which is what every sibling comment means; the set size is twelve.
// Like `trashNote.ts` and `archiveNote.ts`, these are TS orchestrators over the
// existing `note_update` IPC primitive: **no backend command, no capability
// entry**, because completing a note only adds or removes a frontmatter field —
// structurally a note edit (decisions.md 2026-05-09, "Frontmatter byte-level
// surgery owned by TS dialect module").
//
// Two deliberate properties, both easy to get wrong:
//
//   - **`updated:` does not advance.** Flipping a managed flag is not a content
//     edit — the same rule trash and archive follow. This is *asymmetric* with
//     line-tasks, where ticking a checkbox genuinely rewrites note bytes and so
//     does bump the timestamp. The asymmetry is intended: one edits the note,
//     the other edits Myne's state about the note.
//
//   - **The action is gated on the class marker.** Completing a note that is not
//     a task would produce a note that is "completed" but is not work — state no
//     surface lists, and therefore invisible. The gate makes that unrepresentable
//     rather than merely discouraged.

import { patchDoneField, readKindFromFmBody, TASK_KIND_VALUE } from "../dialect";
import { locateFrontmatter } from "../dialect/lezer/frontmatter";

// Note-task completion with its IO required rather than imported (MYND-620
// task 2), for the same reason `taskWriteCore.ts` exists: mobile has its own
// note IO, and an eager default import would drag the desktop tree in. What is
// shared is the part that must not exist twice — the value-strict class check
// and the state-C/state-D asymmetry (complete writes a timestamp, uncomplete
// DELETES the field, so a note is never left carrying `done: false`).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The note IO this module needs. Every client names its own. */
export type NoteCompletionIo = {
  readNote: (noteId: string) => Promise<string>;
  writeNote: (noteId: string, body: string) => Promise<unknown>;
};

/** Thrown when a completion action is attempted on a note that is not a task. */
export class NotATaskNoteError extends Error {
  constructor(noteId: string) {
    super(`note ${noteId} does not carry the task class marker`);
    this.name = "NotATaskNoteError";
  }
}

/** Whether `source` carries the canonical `kind: task` marker (value-strict). */
export function isTaskNote(source: string): boolean {
  const fm = locateFrontmatter(source);
  if (fm === null) return false;
  return readKindFromFmBody(source.slice(fm.bodyStart, fm.bodyEnd)) === TASK_KIND_VALUE;
}

/**
 * Write (or delete, with `null`) a note-task's `done:` field.
 *
 * Rejects with {@link NotATaskNoteError} when the note does not carry the class
 * marker, and with whatever the injected IO propagates otherwise.
 */
export async function patchNoteCompletion(
  io: NoteCompletionIo,
  noteId: string,
  value: string | null,
): Promise<void> {
  const current = await io.readNote(noteId);
  if (!isTaskNote(current)) throw new NotATaskNoteError(noteId);
  const patched = patchDoneField(encoder.encode(current), value);
  await io.writeNote(noteId, decoder.decode(patched));
}
