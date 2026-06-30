// Tauri IPC wrappers for the `notes` plugin's note-CRUD commands.
//
// Mirrors the DESKTOP note primitives (`src/notes/createNote.ts`,
// `readNote.ts`, `updateNote.ts`, `deleteNote.ts`, `listNotes.ts`):
// the exact `"plugin:notes|<command>"` invoke strings and argument
// shapes are reproduced 1:1 so the mobile editor/list talk to the same
// Rust plugin contract. Adapted to a single thin module here (the
// desktop splits these across `src/notes/`, which also carries the
// dialect / frontmatter-surgery helpers the mobile UI does not yet use).
//
// Plaintext lifetime is best-effort on the JS side — V8 strings are
// immutable and not zeroizable; the load-bearing zeroize is Rust-side
// via `Zeroizing<String>` (`src-tauri/CLAUDE.md` "Plaintext IPC across
// the WebView boundary").
//
// Each command rejects (never resolves) with its matching `Note*Error`
// discriminated union; those are re-exported below so callers can
// narrow a caught rejection.

import { invoke } from "@tauri-apps/api/core";
import type { NoteCreateError } from "../types/note-create-error";
import type { NoteReadError } from "../types/note-read-error";
import type { NoteUpdateError } from "../types/note-update-error";
import type { NoteDeleteError } from "../types/note-delete-error";
import type { NoteListError } from "../types/note-list-error";

export type {
  NoteCreateError,
  NoteReadError,
  NoteUpdateError,
  NoteDeleteError,
  NoteListError,
};

/**
 * Encrypt + atomically write a new `.myn` note. Returns the canonical
 * lowercase-hyphenated 36-char `NoteId` string.
 *
 * Rejects with a {@link NoteCreateError}. Arg shape mirrors the desktop
 * `note_create` command exactly: `{ plaintext }` (NOT `{ body }`).
 */
export async function noteCreate(plaintext: string): Promise<string> {
  return await invoke<string>("plugin:notes|note_create", { plaintext });
}

/**
 * Read + AEAD-decrypt an existing `.myn` note by `NoteId`. Returns the
 * UTF-8 plaintext.
 *
 * Rejects with a {@link NoteReadError}.
 */
export async function noteRead(noteId: string): Promise<string> {
  return await invoke<string>("plugin:notes|note_read", { noteId });
}

/**
 * Re-encrypt an existing `.myn` note in place. Stateless idempotent
 * overwrite primitive — autosave coalescing lives at the UI layer, not
 * here. Arg shape: `{ noteId, plaintext }`.
 *
 * Rejects with a {@link NoteUpdateError}.
 */
export async function noteUpdate(
  noteId: string,
  plaintext: string,
): Promise<void> {
  await invoke<void>("plugin:notes|note_update", { noteId, plaintext });
}

/**
 * Hard-delete a `.myn` note. Cryptographic erase is structural via the
 * v0.1 key hierarchy (`unlink` removes both ciphertext and wrapped
 * item-key in one op).
 *
 * Rejects with a {@link NoteDeleteError}; `NoteNotFound` is strict at
 * IPC, idempotent at UI.
 */
export async function noteDelete(noteId: string): Promise<void> {
  await invoke<void>("plugin:notes|note_delete", { noteId });
}

/**
 * Enumerate all note IDs in the vault. Metadata-only; no decryption.
 * Returns canonical lowercase-hyphenated 36-char UUIDv7 strings, sorted
 * ascending per the Rust contract.
 *
 * Rejects with a {@link NoteListError}.
 */
export async function noteList(): Promise<string[]> {
  return await invoke<string[]>("plugin:notes|note_list");
}
