// Trash / archive / soft-delete over a note's managed frontmatter — the mobile
// counterpart to the desktop `src/notes/{trashNote,archiveNote}.ts`. Uses the
// byte-exact frontmatter surgery ported from `src/dialect/surgery.ts`, so a note
// trashed/archived on mobile reads identically on desktop (sync-compatible).

import { mutateDeliberateFolders } from "./prefs";
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
  readKindFromFmBody,
  readTitleFromFmBody,
  type NoteKind,
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
  const norm = await moveNoteToFolderWithoutRegistering(id, folder);
  // myne-md/myne#613: the destination folder is registered the first time a note
  // lands in it, so moving the note back out later leaves the folder standing.
  // The desktop twin is `src/notes/moveNote.ts`; registration sites are
  // per-client, which is why this is not inherited from the shared tree.
  if (norm !== null) {
    void mutateDeliberateFolders({ add: [norm] }).catch(() => {});
  }
}

/**
 * The move itself, with no folder registration. Returns the normalized
 * destination so a caller can register ONCE for many moves.
 *
 * For the folder rename, which re-roots every note in a subtree: registering per
 * note there cost one full `vault.prefs` re-encrypt and one nonce advance per
 * note, landing outside the `withPrefsBatch` that exists to stop exactly that,
 * and every one of them was redundant because the rename's own mutation already
 * states the re-rooted set. Desktop's twin is `moveNoteWithoutRegistering`
 * (`src/notes/moveNote.ts`).
 */
export async function moveNoteToFolderWithoutRegistering(
  id: string,
  folder: string | null,
): Promise<string | null> {
  const norm = normalizeFolderPath(folder);
  const current = await noteRead(id);
  const withFolder = patchFolderField(enc.encode(current), norm);
  const bumped = patchUpdatedField(withFolder, new Date().toISOString());
  await noteUpdate(id, dec.decode(bumped), undefined, current);
  return norm;
}

export interface NoteFlags {
  trashed: string | null;
  archived: string | null;
  deleted: string | null;
  template: boolean;
  conflict: boolean;
  /**
   * The note's canonical `kind:` value, or `null`.
   *
   * Read for ONE decision, and it is the desktop's: a `kind: event` note belongs to
   * the calendar, not the notes list (myne-md/myne#1037). The filter sits in
   * `liveNotes` and NOT in `isLiveNote`, because the host's calendar read skips a
   * record whose `live` flag is false.
   */
  kind: NoteKind;
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
  const clear: NoteFlags = {
    trashed: null,
    archived: null,
    deleted: null,
    template: false,
    conflict: false,
    kind: null,
  };
  try {
    const body = frontmatterBody(text);
    return {
      trashed: readTrashedFromFmBody(body),
      archived: readArchivedFromFmBody(body),
      deleted: readDeletedFromFmBody(body),
      template: readTemplateFromFmBody(body),
      conflict: readConflictFromFmBody(body),
      kind: readKindFromFmBody(body),
    };
  } catch {
    return clear;
  }
}

// ── Soft-delete / archive mutations ─────────────────────────────────────────
// Trash ⊥ archive: each clears the other first. Neither bumps `updated:` (moving
// to trash/archive is not a content edit) — matches desktop trashNote/archiveNote.

export async function trashNote(id: string): Promise<void> {
  const current = await noteRead(id);
  const cleared = patchArchivedField(enc.encode(current), null);
  const trashed = patchTrashedField(cleared, new Date().toISOString());
  await noteUpdate(id, dec.decode(trashed), undefined, current);
}

export async function restoreNote(id: string): Promise<void> {
  const current = await noteRead(id);
  const restored = patchTrashedField(enc.encode(current), null);
  await noteUpdate(id, dec.decode(restored), undefined, current);
}

export async function archiveNote(id: string): Promise<void> {
  const current = await noteRead(id);
  const cleared = patchTrashedField(enc.encode(current), null);
  const archived = patchArchivedField(cleared, new Date().toISOString());
  await noteUpdate(id, dec.decode(archived), undefined, current);
}

export async function unarchiveNote(id: string): Promise<void> {
  const current = await noteRead(id);
  const unarchived = patchArchivedField(enc.encode(current), null);
  await noteUpdate(id, dec.decode(unarchived), undefined, current);
}
