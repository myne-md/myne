// IPC primitive for the `note_update` Tauri command.
//
// **Internal — direct callers should prefer `saveNote(noteId, body)` from
// `./saveNote.ts`** (the canonical autosave path that composes
// `patchUpdatedField` surgery BEFORE this primitive per `decisions.md`
// 2026-05-09 "Frontmatter byte-level surgery owned by TS dialect module").
// Calling `noteUpdate` directly without surgery means the frontmatter
// `updated:` field won't advance — a quiet contract violation.
//
// `decisions.md` 2026-05-07 "`note_update` IPC: stateless overwrite,
// verb-noun naming, UI-level autosave coalescing" pins this as the
// canonical IPC; γ1+γ2 hybrid coalescing lives in `./saveNote.ts` +
// `./useAutosave.ts` (Tasks 12 + 26 of the `notes-sidebar-autosave` PRD).

import { invoke } from "../platform/core";

/**
 * Re-encrypt an existing `.myn` note in place. Stateless idempotent
 * overwrite primitive — autosave coalescing lives at the React-hook
 * layer, not here.
 *
 * `expectedBaseHashHex` (optional, §11.3 expected-base guard): SHA-256
 * hex of the UTF-8 plaintext the caller believes is currently on disk.
 * When present and the disk has moved on (a sync pull-apply raced the
 * editor), the backend rejects with `{kind:"BaseMismatch"}` and writes
 * NOTHING. Omitted → legacy last-write-wins (every non-autosave caller).
 *
 * Rejects with a `NoteUpdateError` (see `src/types/note-update-error.ts`).
 */
export async function noteUpdate(
  noteId: string,
  plaintext: string,
  expectedBaseHashHex?: string,
): Promise<void> {
  await invoke<void>(
    "plugin:notes|note_update",
    expectedBaseHashHex === undefined
      ? { noteId, plaintext }
      : { noteId, plaintext, expectedBaseHashHex },
  );
}
