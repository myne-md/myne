// IPC wrapper for the `note_list` Tauri command (MYND-28).
//
// Returns all `NoteId` strings under `<vault>/notes/`, sorted by
// UUIDv7 ascending per the Rust contract. The cheap half of the two-
// tier sidebar virtualization design — pairs with `loadNoteBatch`
// (which decrypts the viewport titles).
//
// Rejects with a `NoteListError` (see `src/types/note-list-error.ts`).

import { invoke } from "../platform/core";

/** Enumerate all note IDs in the vault. Metadata-only; no decryption. */
export async function noteList(): Promise<string[]> {
  return await invoke<string[]>("plugin:notes|note_list");
}
