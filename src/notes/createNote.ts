// IPC primitive + Q8 zero-payload action helper for note creation.
//
// `noteCreate(plaintext)` is the thin wrapper over the `note_create`
// Tauri command (backend mints a UUIDv7, encrypts the plaintext, atomic-
// writes the `.myn` blob). `createNote()` is the canonical "+ New Note"
// action helper per the 2026-05-15 MYND-82 grill Q8 — it sends an empty
// plaintext, leaving frontmatter injection to the autosave path per
// `decisions.md` 2026-05-07 "İlk save inject etmez".
//
// Plaintext lifetime is best-effort on the JS side — V8 strings are
// immutable and not zeroizable; the load-bearing zeroize is Rust-side
// via `Zeroizing<String>` (`src-tauri/CLAUDE.md` "Plaintext IPC across
// the WebView boundary").

import { invoke } from "@tauri-apps/api/core";
import { buildInitialPlaintext } from "../dialect";
import { normalizeFolderPath } from "../dialect/folderPath";

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
 * "+ New Note" action helper. Returns the new `NoteId` so the caller can
 * select the new row in the sidebar and trigger the auto-rename UX (Q16 ar1).
 *
 * `folder` is the a2 create-timing path (grill 2026-05-29 Q7): a note created
 * inside a folder gets its `folder:` frontmatter written **at create** (so it
 * appears in the right place before the first edit), via `buildInitialPlaintext`.
 * A root note (`folder` omitted / null) sends empty plaintext exactly as before
 * — `decisions.md` 2026-05-15 "İlk save inject etmez" still holds for root
 * notes; only the foldered case carries create-time FM. The Rust `note_create`
 * stays dialect-blind: it receives this as opaque plaintext.
 */
export async function createNote(folder: string | null = null): Promise<string> {
  return await noteCreate(buildInitialPlaintext(normalizeFolderPath(folder)));
}
