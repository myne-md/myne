// IPC wrapper for the `note_read` Tauri command.
//
// `protocol.md` §6.4 non-distinguishing rule: a `CannotDecrypt` rejection
// does not distinguish AEAD-tag failure from `items_key_id` mismatch from
// parse-level failure. The codec's internal sub-cause flows through
// `tracing::debug!` host-side; the WebView never sees it. UI:
// "Bu not okunamadı" with a single category.

import { invoke } from "../platform/core";

/**
 * Read + AEAD-decrypt an existing `.myn` note by `NoteId`. Returns the
 * UTF-8 plaintext.
 *
 * Rejects with a `NoteReadError` (see `src/types/note-read-error.ts`).
 */
export async function noteRead(noteId: string): Promise<string> {
  return await invoke<string>("plugin:notes|note_read", { noteId });
}
