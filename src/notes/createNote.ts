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

import { invoke } from "../platform/core";
import { buildInitialPlaintext } from "../dialect";
import { normalizeFolderPath } from "../dialect/folderPath";
import { mutateDeliberateFolders } from "../lib/prefs";

/**
 * Encrypt + atomically write a new `.myn` note, and register the folder it lands
 * in. Returns the canonical lowercase-hyphenated 36-char `NoteId`.
 *
 * Rejects with a `NoteCreateError` (see `src/types/note-create-error.ts`).
 *
 * **`folder` is required, and that is the fix rather than the signature**
 * (myne-md/myne#613). At-fill first landed at the four surfaces somebody thought
 * of, and the daily note, a note from a template, a folder note, a duplicate, a
 * drawing and every template instantiation registered nothing, while decision
 * 0541 claimed the rule for all of them. The unlock back-fill does not close it
 * either: it walks LIVE notes, so a daily folder emptied by trashing every daily
 * note stayed gone. A defaulted argument would have left the next create path
 * silently unregistered too; a required one makes the compiler name every
 * caller, which is `CLAUDE.md`'s own "a default is the arm that never fires".
 *
 * Pass `null` for the vault root, and for a BULK caller that issues its own
 * single registration afterwards. Each prefs write re-encrypts the whole blob,
 * so a hundred notes must not cost a hundred writes; the importer and the
 * example-vault seeder pass `null` and say so at the call.
 *
 * The registration is fire-and-forget and ADD-only: it can never claim a
 * removal, so the worst a failure costs is that the folder is not remembered
 * yet, and never the note.
 */
export async function noteCreate(
  plaintext: string,
  folder: string | null,
): Promise<string> {
  const id = await invoke<string>("plugin:notes|note_create", { plaintext });
  const norm = normalizeFolderPath(folder);
  if (norm !== null) {
    void mutateDeliberateFolders({ add: [norm] }).catch(() => {});
  }
  return id;
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
  const norm = normalizeFolderPath(folder);
  return await noteCreate(buildInitialPlaintext(norm), norm);
}
