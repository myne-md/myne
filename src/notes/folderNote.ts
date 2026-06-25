// Folder-note CRUD — TS orchestrators over the existing note IPC (MYND-370).
//
// `folder_index:` is the 6th Myne-managed canonical FM field (markdown-dialect
// §3.6.1). A folder note is just a `.myn` note carrying `folder_index: true`
// whose `folder:` names the folder it indexes, so every operation here is a TS
// orchestrator over the existing `note_create` / `note_update` primitives — **no
// new backend command, no new capability-ACL entry**, exactly like `templates.ts`
// / `trashNote.ts` / `moveNote.ts`.
//
// Like the template/trash orchestrators (and unlike `saveNote`/`renameNote`), the
// set/unset actions call `note_update` directly WITHOUT bumping `updated:`:
// flipping the index flag is not a content edit, so the user-meaningful "last
// edited" timestamp must not advance — the same documented exception to the
// index.ts "noteUpdate only from saveNote" discipline that `trashNote.ts` relies
// on.

import {
  buildInitialPlaintext,
  patchFolderIndexField,
  patchTitleField,
} from "../dialect";
import { normalizeFolderPath } from "../dialect/folderPath";
import i18n from "../i18n";
import { noteCreate } from "./createNote";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Mint a brand-new index note for `folderPath`: a `.myn` note carrying
 * `folder: <path>` + `folder_index: true`, titled after the folder's last
 * segment, created through the existing `note_create` IPC (the backend mints the
 * UUIDv7 identity). Works for an empty folder too — the note's own `folder:`
 * brings the folder into existence in the derived tree. Returns the new `NoteId`
 * so the caller can open it. Rejects with whatever `note_create` propagates.
 */
export async function createFolderNote(folderPath: string): Promise<string> {
  const norm = normalizeFolderPath(folderPath);
  // Annotated wide so the `patch*` returns (bare `Uint8Array`) reassign cleanly
  // under TS 6.0's stricter typed-array buffer generic.
  let bytes: Uint8Array = encoder.encode(buildInitialPlaintext(norm));
  bytes = patchTitleField(bytes, folderNoteTitle(norm));
  bytes = patchFolderIndexField(bytes, true);
  return await noteCreate(decoder.decode(bytes));
}

/**
 * Designate an existing note as the index note of its folder by writing
 * `folder_index: true` into its frontmatter (state A/B/C). Idempotent. Does NOT
 * bump `updated:` (flag toggle, not a content edit). The note indexes whichever
 * folder its own `folder:` currently names — callers wanting to move it into a
 * folder first should do that via the normal move path. Rejects with whatever
 * `noteRead` / `noteUpdate` propagate.
 */
export async function setFolderIndex(noteId: string): Promise<void> {
  const current = await noteRead(noteId);
  const marked = patchFolderIndexField(encoder.encode(current), true);
  await noteUpdate(noteId, decoder.decode(marked));
}

/**
 * Remove the index designation from a note by deleting its `folder_index:` field
 * (state D). The exact inverse of {@link setFolderIndex}: touches only the
 * `folder_index:` line, leaving title, body, folder, `updated:`, and any user
 * fields byte-preserved. The note stays an ordinary, live note. No-op-safe on a
 * note that is not an index note. Rejects with the underlying IPC error.
 */
export async function unsetFolderIndex(noteId: string): Promise<void> {
  const current = await noteRead(noteId);
  const cleared = patchFolderIndexField(encoder.encode(current), false);
  await noteUpdate(noteId, decoder.decode(cleared));
}

/** The default title for a freshly-created folder note: the folder's last
 *  segment (e.g. `"Projects/Myne/"` → `"Myne"`), or `"Index"` for a root-level
 *  create with no segment. */
function folderNoteTitle(folder: string | null): string {
  if (folder === null) return i18n.t("notes.folderNote.defaultTitle");
  const segs = folder.split("/").filter((s) => s.length > 0);
  return segs[segs.length - 1] ?? i18n.t("notes.folderNote.defaultTitle");
}
