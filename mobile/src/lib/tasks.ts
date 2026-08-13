// The mobile task data layer (MYND-620, task 2).
//
// Everything about *what a task is* — the filters, the sort comparator, the
// `due ?? remind` date axis, the scope predicates, and the write sequence — is
// consumed from the shared modules and **nothing is restated here**. This file
// is the mobile IO binding and the fetch, and that is deliberately all it is:
// the epic's whole position is that a change to the task rules happens once.
//
//   `@myne/task-filters`    the filter predicates + sort + `todayLocal`
//   `@myne/task-scope`      folder-AND-tags scoping
//   `@myne/task-write`      the write sequence, with its IO required
//   `@myne/note-completion` the note-task `done:` rules
//   `@myne/task-wire`       the `MYI1` row's null→absent conversion
//
// The one thing mobile owns is the fetch. `vault_indices_tasks` returns the
// whole vault's tasks with **no filtering, sorting or date comparison done in
// Rust** — a parameterized accessor would move the §3.6.4 type authority out of
// the dialect layer — so every surface filters over one shared list.

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  patchNoteCompletion,
  type NoteCompletionIo,
} from "@myne/note-completion";
import { writeTaskCompletion, type VaultTask } from "@myne/task-write";
import { fromWire, type VaultTaskWire } from "@myne/task-wire";
import { HAS_TAURI } from "./app-window";
import { noteRead, noteUpdate } from "./notes";
import { createConflictCopy } from "./conflictCopy";

export type { VaultTask };

/** Mobile note IO for the note-task `done:` patcher. */
const completionIo: NoteCompletionIo = {
  readNote: noteRead,
  writeNote: (noteId, body) => noteUpdate(noteId, body),
};

/**
 * The whole vault's line-tasks and note-tasks.
 *
 * Inert without a host so browser dev and the flow tier render an empty list
 * rather than throwing — a task surface that crashes when the backend is absent
 * would make every unrelated flow spec depend on this one.
 *
 * Decoded through `fromWire`, never cast: the command answers with the wire
 * shape, whose `Option<String>` fields arrive as `null`. Casting those rows to
 * `VaultTask[]` would not be skipping a formality, it would be asserting
 * something false about them — and the surfaces that believed the assertion
 * crashed on it (myne-md/myne-mobile#36).
 */
export async function vaultTasks(): Promise<readonly VaultTask[]> {
  if (!HAS_TAURI) return [];
  try {
    const rows = await invoke<VaultTaskWire[]>("plugin:vault-indices|vault_indices_tasks");
    return rows.map(fromWire);
  } catch {
    // A locked vault or an index that has not hydrated yet. Empty is the honest
    // answer; the next read after unlock returns the real list.
    return [];
  }
}

/**
 * Complete or un-complete a task, through the **shared** write sequence.
 *
 * The sequence is not reimplemented here — only its IO is named. That matters
 * more than it looks: the ordering (flush, verify the stored raw line still
 * matches disk, flip, write **with the content hash**, then announce) exists
 * step by step because of a specific way a task write goes wrong, and a second
 * copy would drift on whichever step a reader thought was incidental.
 *
 * `noteUpdate`'s `expectedBaseHashHex` is what makes the hash guard real on
 * mobile: without it a sync pull-apply racing this write would be clobbered.
 */
export async function setTaskCompleted(task: VaultTask, completed: boolean): Promise<void> {
  await writeTaskCompletion(task, completed, {
    readNote: noteRead,
    writeNote: (noteId, body, baseHashHex) => noteUpdate(noteId, body, baseHashHex),
    completeNoteTask: (noteId) =>
      patchNoteCompletion(completionIo, noteId, new Date().toISOString()),
    // `null` DELETES the field rather than writing a falsy value, so a note is
    // never left carrying `done: false` — the shared rule, not a mobile one.
    uncompleteNoteTask: (noteId) => patchNoteCompletion(completionIo, noteId, null),
    announce: announceTaskWrite,
    createConflictCopy,
  });
}

/** Fired after a task write so a surface showing that note re-reads it. */
export const TASK_WRITE_EVENT = "myne-task-written";

function announceTaskWrite(noteId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ noteId: string }>(TASK_WRITE_EVENT, { detail: { noteId } }),
  );
}

/**
 * The vault's tasks, re-read after every task write.
 *
 * Deliberately not a cache keyed on an index nonce like the desktop's: mobile
 * mounts at most one task surface at a time, so the single-fetch problem the
 * desktop store solves (three query blocks in one note re-fetching per
 * keystroke) does not exist here yet. Adding the machinery before the problem
 * would be inventing a cache to keep correct.
 */
export function useVaultTasks(): {
  tasks: readonly VaultTask[];
  reload: () => void;
} {
  const [tasks, setTasks] = useState<readonly VaultTask[]>([]);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void vaultTasks().then((rows) => {
      if (live) setTasks(rows);
    });
    return () => {
      live = false;
    };
  }, [nonce]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onWrite = (): void => reload();
    window.addEventListener(TASK_WRITE_EVENT, onWrite);
    return () => window.removeEventListener(TASK_WRITE_EVENT, onWrite);
  }, [reload]);

  return { tasks, reload };
}
