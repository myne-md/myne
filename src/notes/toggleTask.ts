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
  // Imported as a VALUE (the re-export block below is types-and-names only, and
  // `instanceof` needs the binding) under an alias, so the re-export keeps the
  // public name.
  TaskWriteRefused as TaskWriteRefusedClass,
  type TaskWriteDeps,
} from "./taskWriteCore";
import type { VaultTask } from "./taskIndex";
import { reindexNoteFromBody } from "./vaultIndices";

/**
 * The desktop write: `saveNote`, then the index refresh.
 *
 * `saveNote` writes the note and nothing else — the live re-index that follows
 * a save is performed by the **autosave hook** (`useAutosave.ts`), not by the
 * save primitive. Every other cross-note writer reaches the index through some
 * path of its own; this one had none, so a tick written from a list wrote the
 * file and left the index reporting the old state. The row stayed unchecked,
 * and because `vaultIndicesApply` is also what bumps the index nonce, no task
 * surface even re-queried.
 *
 * Fire-and-forget, matching the autosave hook: a VaultIndices hiccup must not
 * turn a successful write into a failed one. The next reconcile self-heals.
 */
async function saveAndReindex(
  noteId: string,
  body: string,
  baseHashHex: string,
): Promise<string> {
  const stamped = await saveNote(noteId, body, baseHashHex);
  void reindexNoteFromBody(noteId, stamped);
  return stamped;
}

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
    writeNote: deps.writeNote ?? saveAndReindex,
    completeNoteTask: deps.completeNoteTask ?? completeNote,
    uncompleteNoteTask: deps.uncompleteNoteTask ?? uncompleteNote,
    announce: deps.announce ?? announceWrite,
    createConflictCopy: deps.createConflictCopy ?? createConflictCopyImpl,
    // Passed through rather than defaulted: the writer falls back to the system
    // clock itself, and a default here would be a second place to change the
    // day a recurring task advances from.
    today: deps.today,
  });
}

/** Convenience: flip whatever state the record currently reports. */
export async function toggleTask(task: VaultTask, deps?: TaskWriteDeps): Promise<void> {
  await setTaskCompleted(task, !task.completed, deps);
}

/**
 * Flip a task, swallowing a refusal into a warning.
 *
 * A refusal is not an error the user caused and it is not a crash — it is the
 * writer declining to write something it cannot verify. Surfaces that want to
 * explain one to the user pass their own handler to {@link setTaskCompleted}
 * instead; the two that don't (the task panes and the query block) share this,
 * so "what a refused toggle does" has one answer rather than one per surface.
 */
export async function toggleTaskSwallowingRefusal(
  task: VaultTask,
  flushDirtyPanes: () => Promise<void>,
): Promise<void> {
  try {
    await setTaskCompleted(task, !task.completed, { flushDirtyPanes });
  } catch (err) {
    if (err instanceof TaskWriteRefusedClass) {
      console.warn(`[tasks] write refused: ${err.reason}`);
      return;
    }
    throw err;
  }
}
