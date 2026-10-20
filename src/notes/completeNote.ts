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

import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";
import { patchNoteCompletion } from "./completeNoteCore";

// The class check and the state-C/state-D asymmetry live in `completeNoteCore.ts`
// with their IO required, so mobile (MYND-620) uses the same rules rather than
// restating them. This module is the DESKTOP BINDING and re-exports the rest, so
// nothing that imported from here has to move.
export { NotATaskNoteError, isTaskNote, type NoteCompletionIo } from "./completeNoteCore";

// One io per call, so the write carries the text ITS read returned as the merge
// base (myne-md/myne#849 review round 5). While a live session owns the note a
// peer edit can land between the read and the write, and a write with no base
// replaces the session's text and deletes it.
function ioForOneCall() {
  let read: string | undefined;
  return {
    readNote: async (noteId: string) => (read = await noteRead(noteId)),
    writeNote: (noteId: string, body: string) => noteUpdate(noteId, body, undefined, read),
  };
}

/**
 * Mark a note-task complete by writing `done: <now>` (RFC 3339 UTC).
 *
 * Idempotent in the state-C sense: completing an already-complete note refreshes
 * the timestamp.
 */
export async function completeNote(noteId: string): Promise<void> {
  await patchNoteCompletion(ioForOneCall(), noteId, new Date().toISOString());
}

/**
 * Mark a note-task incomplete by **deleting** its `done:` field (state D) — never
 * by writing a falsy value, so a note is never left carrying `done: false`.
 */
export async function uncompleteNote(noteId: string): Promise<void> {
  await patchNoteCompletion(ioForOneCall(), noteId, null);
}
