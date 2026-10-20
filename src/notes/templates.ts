// Template CRUD — TS orchestrators over the existing note IPC (MYND-187).
//
// `template:` is the 5th Myne-managed canonical FM field (markdown-dialect
// §3.6.1; storage contract in `decisions.md` 2026-06-07). Per SYNC-1-R / SYNC-9
// a template is just a `.myn` note carrying the flag, so every operation here
// is a TS orchestrator over the existing `note_create` / `note_update` /
// `note_list` / soft-trash primitives — **no new backend command, no new
// capability-ACL entry**, exactly like `trashNote.ts` / `moveNote.ts`.
//
// Like trash/move (and unlike `saveNote`/`renameNote`), the convert orchestrators
// call `note_update` directly WITHOUT bumping `updated:`: flipping the template
// flag is not a content edit, so the user-meaningful "last edited" timestamp must
// not advance. This is the same documented exception to the index.ts
// "noteUpdate only from saveNote" discipline that `trashNote.ts` relies on.

import {
  patchTemplateField,
  patchTitleField,
  TEMPLATE_FLAG_VALUE,
} from "../dialect";
import { noteCreate } from "./createNote";
import { flushBeforeFrontmatterWrite } from "./flushBeforeFrontmatterWrite";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";
import { noteList } from "./listNotes";
import { loadNoteBatch, type TitleRecord } from "./loadNoteBatch";
import { templateRecords } from "./sidebarState";
import { trashNote } from "./trashNote";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Mint a brand-new template: a `.myn` note carrying `title: <name>` +
 * `template: true` + the given body, created through the existing `note_create`
 * IPC (the backend mints the UUIDv7 identity — never UI-supplied, so the
 * template is rename-safe). Body is persisted verbatim; no `{{...}}` parsing
 * happens here (that is the variable engine's job at fill time). Returns the new
 * `NoteId`. Rejects with whatever `note_create` propagates.
 */
export async function createTemplate(
  name: string,
  body: string,
): Promise<string> {
  // Annotated wide (`Uint8Array<ArrayBufferLike>`) so the `patchTitleField`
  // return (bare `Uint8Array`) reassigns cleanly under TS 6.0's stricter
  // typed-array buffer generic — `encoder.encode()` narrows to `<ArrayBuffer>`.
  let bytes: Uint8Array = encoder.encode(body);
  // State A/B compose to canonical `---\ntitle: <name>\ntemplate: true\n---\n\n<body>`.
  bytes = patchTitleField(bytes, name);
  bytes = patchTemplateField(bytes, TEMPLATE_FLAG_VALUE);
  // A template note is filed nowhere: `createTemplate` writes `template: true`
  // and no `folder:`, so there is no folder to register.
  return await noteCreate(decoder.decode(bytes), null);
}

/**
 * Promote an ordinary note to a template by writing `template: true` into its
 * frontmatter (state A/B/C). Idempotent: converting an already-template note
 * just re-sets the canonical value. Does NOT bump `updated:` (flag toggle, not a
 * content edit). Rejects with whatever `noteRead` / `noteUpdate` propagate.
 */
export async function convertNoteToTemplate(noteId: string): Promise<void> {
  // Same class as `setNoteCover`, same reason (myne-md/myne#520): this is
  // read-patch-write against disk on a note that may be open and dirty, and it
  // is fired from the command palette, which is exactly the type-then-Cmd+K
  // window that fits inside one autosave debounce.
  await flushBeforeFrontmatterWrite();
  const current = await noteRead(noteId);
  const marked = patchTemplateField(encoder.encode(current), TEMPLATE_FLAG_VALUE);
  await noteUpdate(noteId, decoder.decode(marked), undefined, current);
}

/**
 * Demote a template back to an ordinary note by deleting its `template:` field
 * (state D). The exact inverse of {@link convertNoteToTemplate}: a
 * convert-then-convert-back round-trip touches only the `template:` line,
 * leaving title, body, folder, `updated:`, and any user fields byte-preserved
 * (no content copy, no new file). This is the **non-destructive** "remove from
 * templates" action — distinct from {@link deleteTemplate} (soft-trash). No-op-
 * safe on a note that is not a template. Rejects with the underlying IPC error.
 */
export async function convertTemplateToNote(noteId: string): Promise<void> {
  await flushBeforeFrontmatterWrite();
  const current = await noteRead(noteId);
  const demoted = patchTemplateField(encoder.encode(current), null);
  await noteUpdate(noteId, decoder.decode(demoted), undefined, current);
}

/**
 * Delete a template by **delegating to the normal note soft-trash flow** — a
 * deleted template writes the recoverable `trashed:` marker exactly like
 * deleting a note (not a hard erase, not an unflag). A soft-trashed template
 * leaves {@link listTemplates} (the filter excludes trashed) while remaining
 * restorable from the existing Trash panel; restore returns it to the template
 * set (its `template: true` flag is preserved through trash/restore). This keeps
 * **delete** (destructive-but-recoverable) cleanly distinct from
 * {@link convertTemplateToNote} (non-destructive demotion). Rejects with the
 * underlying `trashNote` error.
 */
export async function deleteTemplate(noteId: string): Promise<void> {
  await trashNote(noteId);
}

/**
 * The canonical template enumeration the management UI (#4) and picker (#5) both
 * call: every `template: true` note, **excluding** soft-trashed templates,
 * newest-updated first. Reuses the existing `note_list` + `loadNoteBatch` path
 * and the value-strict `template:` filter ({@link templateRecords}) — no new IPC.
 * Rejects with whatever `noteList` / `loadNoteBatch` propagate.
 */
export async function listTemplates(): Promise<TitleRecord[]> {
  const ids = await noteList();
  const records = await loadNoteBatch(ids);
  const cache = new Map(records.map((r) => [r.noteUuid, r]));
  return templateRecords(cache);
}
