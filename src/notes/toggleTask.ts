// The single task-mutation writer (MYND-616 task 8; MYND-617 tasks 7 + 8).
//
// **One function completes or un-completes a task, whatever surface asked.** The
// vault-wide tab, the note-scoped panel and (later) the query block all call
// this; none of them writes bytes of its own.
//
// That is a requirement rather than a preference, and the reason is concrete:
// **the editor's own checkbox toggle cannot be reused.** It resolves the marker
// position live from the CodeMirror document, so it only works for a note that
// is currently open in a pane. A list row's task is usually in a note that is
// not open, and often in one that has never been opened this session.
//
// The order of operations is load-bearing:
//
//   1. **flush dirty open panes first.** A pane with unsaved keystrokes holds a
//      newer body than disk; reading disk before flushing would patch a stale
//      copy and the flush would then overwrite the patch. Flushing first makes
//      the read see what the user can see.
//   2. **verify the raw line still matches** before patching. The index is a
//      cache and can be one autosave behind; patching by line number alone
//      would tick whatever happens to be on that line now. The stored raw line
//      is the evidence, and disagreement is a refusal, never a guess.
//   3. **save with the content hash**, so a sync pull-apply that raced this
//      write is rejected by the backend rather than silently clobbered.
//   4. **signal open panes to reload**, so a note visible in a pane shows the
//      tick immediately instead of at the next reopen.
//
// On a hash mismatch the write is **refused** — no write, no snapshot, no index
// touch — and the body it would have written is preserved as a **keep-both
// conflict copy**, so a stale list can never overwrite what sync just pulled.
// The **transactional batch writer must not be used** on this path: it takes no
// hash and does not take the write lock, so it races the sync engine.
//
// An **oversized** record is refused with an explanation. Its raw line was
// truncated at the index cap, so step 2 cannot be performed at all — and a write
// that cannot be verified is exactly the write that silently corrupts a long
// task. Refusing is the honest failure.

import { completeNote, uncompleteNote } from "./completeNote";
import { createConflictCopy as createConflictCopyImpl } from "./conflictCopy";
import { noteRead } from "./readNote";
import { saveNote } from "./saveNote";
import {
  announceWrite,
  writeTaskCompletion,
  type TaskWriteDeps,
} from "./taskWriteCore";
import type { VaultTask } from "./taskIndex";

// The write path itself lives in `taskWriteCore.ts` with its IO required rather
// than defaulted, so a second client (mobile, MYND-620) can use the same
// sequence instead of reimplementing it. This module is the DESKTOP BINDING:
// it names the desktop IO and re-exports the rest unchanged, so nothing that
// imported from here has to move.
export {
  TASK_WRITE_EVENT,
  TaskWriteRefused,
  flipMarker,
  writeTaskCompletion,
  type RequiredTaskWriteIo,
  type TaskWriteDeps,
  type TaskWriteEventDetail,
  type TaskWriteRefusal,
} from "./taskWriteCore";

/**
 * Complete or un-complete `task`. The one write path for every task surface.
 *
 * Rejects with `TaskWriteRefused` when the record cannot be written safely, and
 * with whatever the IPC layer propagates otherwise.
 */
export async function setTaskCompleted(
  task: VaultTask,
  completed: boolean,
  deps: TaskWriteDeps = {},
): Promise<void> {
  await writeTaskCompletion(task, completed, {
    flushDirtyPanes: deps.flushDirtyPanes,
    readNote: deps.readNote ?? noteRead,
    writeNote: deps.writeNote ?? saveNote,
    completeNoteTask: deps.completeNoteTask ?? completeNote,
    uncompleteNoteTask: deps.uncompleteNoteTask ?? uncompleteNote,
    announce: deps.announce ?? announceWrite,
    createConflictCopy: deps.createConflictCopy ?? createConflictCopyImpl,
  });
}

/** Convenience: flip whatever state the record currently reports. */
export async function toggleTask(task: VaultTask, deps?: TaskWriteDeps): Promise<void> {
  await setTaskCompleted(task, !task.completed, deps);
}
