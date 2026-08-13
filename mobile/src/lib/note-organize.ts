// Trash / archive / soft-delete over a note's managed frontmatter — the mobile
// counterpart to the desktop `src/notes/{trashNote,archiveNote}.ts`. Uses the
// byte-exact frontmatter surgery ported from `src/dialect/surgery.ts`, so a note
// trashed/archived on mobile reads identically on desktop (sync-compatible).

import {
  patchTrashedField,
  patchArchivedField,
  patchFolderField,
  patchUpdatedField,
  readTrashedFromFmBody,
  readArchivedFromFmBody,
  readDeletedFromFmBody,
  readTemplateFromFmBody,
  readConflictFromFmBody,
  readTitleFromFmBody,
} from "../dialect/surgery";
import { locateFrontmatter } from "../dialect/lezer/frontmatter";
import { normalizeFolderPath } from "../dialect/folderPath";
import { noteRead, noteUpdate } from "./notes";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Stamp the note's `updated:` frontmatter to now — the byte-exact desktop save
 *  surgery. Applied at every note create/edit site so the list can show a
 *  last-edited relative time (and it rides sync byte-identically). */
export function stampUpdated(text: string, iso: string = new Date().toISOString()): string {
  return dec.decode(patchUpdatedField(enc.encode(text), iso));
}

// Every note-parse chokepoint below is defensive: a single unparseable note
// (malformed frontmatter, a lezer edge case, an unexpected byte sequence) must
// degrade to a safe default, NEVER throw — otherwise one bad note in the vault
// takes down the whole notes list ("Couldn't load your notes") or a render.

/** The frontmatter block's inner body (between the `---` lines), or "" when the
 *  note has no leading frontmatter. Feeds the value-strict readers. */
export function frontmatterBody(text: string): string {
  try {
    const loc = locateFrontmatter(text);
    return loc ? text.slice(loc.bodyStart, loc.bodyEnd) : "";
  } catch {
    return "";
  }
}

/** The note content AFTER the frontmatter block (the visible markdown). */
export function bodyAfterFrontmatter(text: string): string {
  try {
    const loc = locateFrontmatter(text);
    return loc ? text.slice(loc.blockEnd) : text;
  } catch {
    return text;
  }
}

/** The managed `title:` frontmatter value, or null when unset. */
export function frontmatterTitle(text: string): string | null {
  try {
    return readTitleFromFmBody(frontmatterBody(text));
  } catch {
    return null;
  }
}

const FOLDER_LINE_RE = /^[ \t]*folder[ \t]*:[ \t]*(.*)$/;

/** The note's `folder:` path (canonical trailing-slash), or null (root/unfiled).
 *  There is no surgery `readFolder` helper, so this parses the line directly. */
export function readNoteFolder(text: string): string | null {
  try {
    for (const line of frontmatterBody(text).split("\n")) {
      const m = FOLDER_LINE_RE.exec(line);
      if (!m) continue;
      let v = m[1].trim();
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
        v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      } else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
        v = v.slice(1, -1);
      }
      return v === "" ? null : v;
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/** Move a note to a folder (null = root). Bumps `updated:` — a move IS a content
 *  modification (matches desktop moveNote, unlike trash/archive). */
export async function moveNoteToFolder(id: string, folder: string | null): Promise<void> {
  const withFolder = patchFolderField(enc.encode(await noteRead(id)), normalizeFolderPath(folder));
  const bumped = patchUpdatedField(withFolder, new Date().toISOString());
  await noteUpdate(id, dec.decode(bumped));
}

export interface NoteFlags {
  trashed: string | null;
  archived: string | null;
  deleted: string | null;
  template: boolean;
  conflict: boolean;
}

// #260/#46: the selection predicates are SHARED now. They used to be
// re-implemented here and as `useMemo`s in `EditorFlow`, and the two clients'
// answers to "is this note part of the working set" drifted independently —
// which is how `98acbcc9`'s tombstone filter reached desktop's Trash list and
// never reached mobile's, leaving "Delete permanently" a visible no-op.
//
// Re-exported rather than replaced at the call sites so this module's existing
// consumers keep their import, and so there is exactly one definition.
export {
  isArchivedNote,
  isConflictCopy,
  isListedTemplate,
  isLiveNote,
  isResolverCandidate,
  isTemplateNote,
  isTombstoned,
  isTrashedNote,
} from "@myne/editor/host/notes/selectors";

/** Read all managed flags from raw note text (pure — for list filtering).
 *  Defensive: an unparseable note is treated as a plain live note (all flags
 *  clear) rather than throwing and breaking the whole list. */
export function readNoteFlags(text: string): NoteFlags {
  const clear: NoteFlags = { trashed: null, archived: null, deleted: null, template: false, conflict: false };
  try {
    const body = frontmatterBody(text);
    return {
      trashed: readTrashedFromFmBody(body),
      archived: readArchivedFromFmBody(body),
      deleted: readDeletedFromFmBody(body),
      template: readTemplateFromFmBody(body),
      conflict: readConflictFromFmBody(body),
    };
  } catch {
    return clear;
  }
}

// ── Soft-delete / archive mutations ─────────────────────────────────────────
// Trash ⊥ archive: each clears the other first. Neither bumps `updated:` (moving
// to trash/archive is not a content edit) — matches desktop trashNote/archiveNote.

export async function trashNote(id: string): Promise<void> {
  const cleared = patchArchivedField(enc.encode(await noteRead(id)), null);
  const trashed = patchTrashedField(cleared, new Date().toISOString());
  await noteUpdate(id, dec.decode(trashed));
}

export async function restoreNote(id: string): Promise<void> {
  const restored = patchTrashedField(enc.encode(await noteRead(id)), null);
  await noteUpdate(id, dec.decode(restored));
}

export async function archiveNote(id: string): Promise<void> {
  const cleared = patchTrashedField(enc.encode(await noteRead(id)), null);
  const archived = patchArchivedField(cleared, new Date().toISOString());
  await noteUpdate(id, dec.decode(archived));
}

export async function unarchiveNote(id: string): Promise<void> {
  const unarchived = patchArchivedField(enc.encode(await noteRead(id)), null);
  await noteUpdate(id, dec.decode(unarchived));
}
