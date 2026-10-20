// IPC wrapper for the `note_read` Tauri command.
//
// `protocol.md` §6.4 non-distinguishing rule: a `CannotDecrypt` rejection
// does not distinguish AEAD-tag failure from `items_key_id` mismatch from
// parse-level failure. The codec's internal sub-cause flows through
// `tracing::debug!` host-side; the WebView never sees it. UI:
// "Bu not okunamadı" with a single category.

import { invoke } from "../platform/core";
import { isLiveNote, readLiveNote } from "./liveNote";

/**
 * Read + AEAD-decrypt an existing `.myn` note by `NoteId`. Returns the
 * UTF-8 plaintext.
 *
 * **A note with an open live session is read from the SESSION, not from disk**
 * (myne-md/myne#849 review, D8; the mobile twin is `noteRead` in
 * `mobile/src/lib/notes.ts`). A live peer edit is applied to the session and not
 * flushed, so disk lags the session until this device's next write. The
 * read-modify-write writers (move, trash, archive, restore, the cover, the task
 * toggle, the conflict apply, the tombstone) read through this function and then
 * write through `noteUpdate`, which routes a live note through the session as a
 * whole-text replace. Reading disk there patched stale text over the session and
 * deleted the peer's edit, then broadcast the deletion. A session that closed
 * between the check and the read answers `null`, and disk is then current again,
 * because closing flushes.
 *
 * Rejects with a `NoteReadError` (see `src/types/note-read-error.ts`).
 */
export async function noteRead(noteId: string): Promise<string> {
  if (isLiveNote(noteId)) {
    const live = await readLiveNote(noteId);
    if (live !== null) return live;
  }
  return await invoke<string>("plugin:notes|note_read", { noteId });
}
