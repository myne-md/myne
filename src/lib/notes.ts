// Tauri IPC wrappers for the `notes` plugin commands (per-note CRUD).
//
// Plaintext lifetime is best-effort on the JS side — V8 strings are
// immutable and not zeroizable; the load-bearing zeroize is Rust-side
// via `Zeroizing<String>` (each plaintext-bearing command wraps the IPC
// argument on its first non-doc statement; see `src-tauri/CLAUDE.md`
// "Plaintext IPC across the WebView boundary"). Editor-side V8
// retention is the dominant leak window per the v0.1 trust model and
// is documented under `threat-model.md` §5 / A7.
//
// `noteId` strings are backend-minted UUIDv7 returned by `noteCreate`
// per `decisions.md` 2026-05-07 "Note UUIDv7 backend-gen; UI never
// names the destination" — the UI consumes them but never produces
// them. Rust-side `NoteId::parse` surfaces malformed strings as
// `InvalidNoteId` (a UI-bug-canary distinct from `NoteNotFound`).

import { invoke } from "@tauri-apps/api/core";

/**
 * Encrypt + atomically write a new `.myn` note. Returns the canonical
 * lowercase-hyphenated 36-char `NoteId` string.
 *
 * Rejects with a `NoteCreateError` (see `src/types/note-create-error.ts`).
 */
export async function noteCreate(plaintext: string): Promise<string> {
  return await invoke<string>("plugin:notes|note_create", { plaintext });
}

/**
 * Read + AEAD-decrypt an existing `.myn` note by `NoteId`. Returns the
 * UTF-8 plaintext.
 *
 * Rejects with a `NoteReadError` (see `src/types/note-read-error.ts`).
 * `CannotDecrypt` is a single non-distinguishing tag per `protocol.md`
 * §6.4; `InvalidPlaintextEncoding` is the distinct structural-corruption
 * category.
 */
export async function noteRead(noteId: string): Promise<string> {
  return await invoke<string>("plugin:notes|note_read", { noteId });
}

/**
 * Re-encrypt an existing `.myn` note in place under the persistent
 * `item_key` with a fresh `content_nonce` per `protocol.md` §6.3
 * (bytes 0..47+N byte-identical across revisions).
 *
 * Stateless idempotent overwrite primitive — autosave coalescing
 * (γ1+γ2 hibrit pattern) lives in the editor, not here. Rejects with
 * a `NoteUpdateError` (see `src/types/note-update-error.ts`).
 */
export async function noteUpdate(
  noteId: string,
  plaintext: string,
): Promise<void> {
  await invoke<void>("plugin:notes|note_update", { noteId, plaintext });
}

/**
 * Hard-delete a `.myn` note. Cryptographic erase is structural via the
 * v0.1 key hierarchy (`enc_item_key` removed with the file); no
 * platform-specific secure-delete. Soft-trash deferred to v0.2
 * (MYND-133).
 *
 * UI MUST surface a confirmation modal before calling this — body
 * "Bu not kalıcı olarak silinir ve geri getirilemez." with default-
 * focus on Cancel + brick-danger affirmative. Rejects with a
 * `NoteDeleteError` (see `src/types/note-delete-error.ts`); `NoteNotFound`
 * is strict at IPC, idempotent at UI.
 */
export async function noteDelete(noteId: string): Promise<void> {
  await invoke<void>("plugin:notes|note_delete", { noteId });
}
