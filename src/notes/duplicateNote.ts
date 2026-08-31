// `duplicateNote` — clone an existing note in place (MYND-332).
//
// Notesnook-parity: the NoteList context menu's "Duplicate" action. Pure
// frontend orchestration over the existing IPC primitives — no new Tauri
// command, because Rust `note_create` is deliberately dialect-blind (it
// receives opaque plaintext; `decisions.md` 2026-05-15) and all
// frontmatter `title:` surgery lives TS-side.
//
// Flow: read the source plaintext (`noteRead` → decrypt), derive the copy's
// title by appending " (kopya)", patch the `title:` + `updated:` frontmatter
// via the shared `renamedTitleBody` surgery, then `noteCreate` the result —
// which mints a fresh UUIDv7, wraps a fresh `item_key`, and atomic-writes a
// new `.myn` blob. The `folder:` / `template:` flags ride along untouched
// (the copy lands in the same folder; a duplicated template stays a
// template). A live note carries no `trashed:` flag, so none is copied.
//
// E2EE: the source plaintext is materialised locally only for the moment
// between decrypt and re-encrypt — the same exposure every note edit already
// incurs. Favorites / colors are NOT copied: those live in `vault.prefs`
// keyed by note id, and the copy is a brand-new id (clean slate).

import { readFolderFromFmBody, readTitleFromFmBody } from "../dialect";
import { normalizeFolderPath } from "../dialect/folderPath";
import { locateFrontmatter } from "../dialect/lezer/frontmatter";
import { noteCreate } from "./createNote";
import { noteRead } from "./readNote";
import { renamedTitleBody } from "./renameNote";

const COPY_SUFFIX = " (kopya)";
const UNTITLED_COPY = "(kopya)";

/**
 * Pure title-derivation: append the localized copy suffix, or fall back to a
 * bare "(kopya)" when the source is untitled / blank.
 */
export function duplicatedTitle(sourceTitle: string | null): string {
  const trimmed = sourceTitle?.trim() ?? "";
  return trimmed.length > 0 ? `${sourceTitle}${COPY_SUFFIX}` : UNTITLED_COPY;
}

/**
 * Read the frontmatter `title:` from a full note plaintext, or `null` when
 * there is no frontmatter block / no `title:` line.
 */
function readNoteTitle(bytes: string): string | null {
  const fm = locateFrontmatter(bytes);
  if (fm === null) return null;
  return readTitleFromFmBody(bytes.slice(fm.bodyStart, fm.bodyEnd));
}

/** The frontmatter `folder:` of a note plaintext, canonical, or `null` for the
 *  vault root. The duplicate lands where its source lives, so `noteCreate` needs
 *  it to register that folder (myne-md/myne#613). Read off the same frontmatter
 *  slice as the title above, and through the SAME scalar reader.
 *
 *  This was a hand-rolled regex plus a quote strip, and it was missing two of
 *  the house reader's rules: no trailing-comment strip, so `folder: Work # x`
 *  registered `Work # x/`, and no block-scalar reject, so `folder: |` registered
 *  `|/`. Neither is where the note lands. That matters more here than for a
 *  title because the value is PERSISTED, SYNCED and BUDGETED: a phantom entry
 *  becomes a real folder on every device, spends reserve the byte budget then
 *  refuses real additions against, and cannot be cleared by deleting the folder
 *  the note is really in. */
function readNoteFolderPath(bytes: string): string | null {
  const fm = locateFrontmatter(bytes);
  if (fm === null) return null;
  const scalar = readFolderFromFmBody(bytes.slice(fm.bodyStart, fm.bodyEnd));
  return normalizeFolderPath(scalar);
}

/**
 * Clone the note identified by `sourceId`. Returns the canonical
 * lowercase-hyphenated 36-char `NoteId` of the new copy.
 *
 * Rejects with whatever `noteRead` / `noteCreate` propagate (a
 * `NoteReadError` on the source read, or a `NoteCreateError` on the write).
 */
export async function duplicateNote(sourceId: string): Promise<string> {
  const bytes = await noteRead(sourceId);
  const dupBytes = renamedTitleBody(bytes, duplicatedTitle(readNoteTitle(bytes)));
  // The copy lands in the source's folder, so it registers it: a duplicate
  // is a note landing in a folder like any other (myne-md/myne#613).
  return await noteCreate(dupBytes, readNoteFolderPath(bytes));
}
