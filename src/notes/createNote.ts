// IPC primitive + action helper for note creation.
//
// `noteCreate(plaintext)` is the thin wrapper over the `note_create`
// Tauri command (backend mints a UUIDv7, encrypts the plaintext, atomic-
// writes the `.myn` blob). `createNote()` is the canonical "+ New Note"
// action helper.
//
// # A new note carries its `title:` from create (myne-md/myne#653)
//
// It used to send EMPTY plaintext for a root note, deferring frontmatter to the
// autosave path, while a note created inside a FOLDER got create-time
// frontmatter via `buildInitialPlaintext`. Two paths, two answers, and the root
// one produced a note with nowhere to put its name: no frontmatter block, so no
// `title:` line to type into, on a client where the title is frontmatter-only
// (`decisions.md` 2026-05-28, no first-`# H1` fallback). Combined with the
// sidebar taking focus on create, a freshly made note could not be titled at
// all: not in the note, because there was no field, and not in the sidebar,
// because that input vanishes when it loses focus.
//
// So both paths now go through one serializer and both carry `title: ""`.
//
// **The title is patched here rather than inside `buildInitialPlaintext`**, and
// the layering is deliberate. That function is a `dialect/` primitive whose
// `buildInitialPlaintext(null) === ""` identity is load-bearing: `surgery.ts`'s
// state-D folder delete collapses an emptied block wholesale so the result is
// byte-identical to an FM-less root note, and cites that equality as the reason.
// Widening the primitive would break the symmetry for every caller to fix a
// question only the "+ New Note" ACTION asks. `patchTitleField` on top answers
// it at the right layer and reuses the one title writer for both shapes: state A
// when the base is empty, state B when a `folder:` block is already there.
//
// Plaintext lifetime is best-effort on the JS side — V8 strings are
// immutable and not zeroizable; the load-bearing zeroize is Rust-side
// via `Zeroizing<String>` (`src-tauri/CLAUDE.md` "Plaintext IPC across
// the WebView boundary").

import { invoke } from "../platform/core";
import { buildInitialPlaintext, patchTitleField } from "../dialect";
import { normalizeFolderPath } from "../dialect/folderPath";
import { mutateDeliberateFolders } from "../lib/prefs";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

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
 * The plaintext a brand-new note is created with: a frontmatter block carrying
 * an empty `title:`, plus `folder:` when it is being created inside one.
 *
 * Exported so `tests/notes/createNotePlaintext.test.ts` can assert the bytes
 * without an IPC round trip, the shape is the whole point of myne#653, and a
 * test that could only observe it through `invoke` would be asserting the mock.
 */
export function initialNotePlaintext(folder: string | null): string {
  // `buildInitialPlaintext` supplies the `folder:` half (empty string at root,
  // per the state-D symmetry the header explains); the title patch supplies the
  // rest through the same writer every other `title:` write uses.
  const base = buildInitialPlaintext(normalizeFolderPath(folder));
  return utf8Decoder.decode(patchTitleField(utf8Encoder.encode(base), ""));
}

/**
 * "+ New Note" action helper. Returns the new `NoteId` so the caller can select
 * the new row in the sidebar.
 *
 * `folder` is the a2 create-timing path (grill 2026-05-29 Q7): a note created
 * inside a folder gets its `folder:` frontmatter written **at create**, so it
 * appears in the right place before the first edit. Since myne#653 a root note
 * carries create-time frontmatter too, see the header for why the two paths
 * converged and why the title is patched at this layer. The Rust `note_create`
 * stays dialect-blind: it receives this as opaque plaintext.
 */
export async function createNote(folder: string | null = null): Promise<string> {
  // No local normalize: `initialNotePlaintext` normalizes for the frontmatter
  // and `noteCreate` normalizes for the prefs registration, so a third pass here
  // was the same function run three times on one value.
  return await noteCreate(initialNotePlaintext(folder), folder);
}
