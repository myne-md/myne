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

import { invoke } from "../platform/core";
import { normalizeFolderPath } from "../dialect/folderPath";
import { mutateDeliberateFolders } from "./prefs";
import { patchDeletedField } from "../dialect/surgery";
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
 * Encrypt + atomically write a new `.myn` note, and register the folder it lands
 * in. Returns the canonical lowercase-hyphenated 36-char `NoteId` string.
 *
 * Rejects with a {@link NoteCreateError}. The IPC arg shape mirrors the desktop
 * `note_create` command exactly: `{ plaintext }` (NOT `{ body }`).
 *
 * **`folder` is required, and that is the fix rather than the signature**
 * (myne-md/myne#613, review round 2). At-fill landed on this tree at TWO
 * `EditorFlow` save paths instead of at the chokepoint, so five create paths
 * that DO carry a folder registered nothing: the daily note (`daily.ts`, which
 * patches `folder:` from the `daily_folder` pref), `createSibling` (which reads
 * the source's folder and then dropped it, while desktop's `createDrawing.ts`
 * twin WAS wired), the app-background flush (so whether the folder was
 * remembered depended on whether the user pressed save or the app was
 * backgrounded), `templates.ts` and `conflictCopy.ts`. The unlock back-fill does
 * not cover them either: it walks LIVE notes, so a daily folder emptied by
 * trashing every daily note stays gone.
 *
 * A defaulted argument would have left the next create path silently
 * unregistered too, which is `CLAUDE.md`'s own "a default is the arm that never
 * fires". Required means the compiler names every caller. Byte-parity with
 * `src/notes/createNote.ts` is deliberate: `check-twin-drift.mjs` watches these
 * two, and the whole reason this defect existed on one side only is that the
 * signatures had diverged.
 *
 * Pass `null` for the vault root, and for a BULK caller that issues its own
 * single registration afterwards: each prefs write re-encrypts the whole blob.
 *
 * The registration is fire-and-forget and ADD-only, so it can never claim a
 * removal; the worst a failure costs is a folder not remembered yet, never the
 * note. Class 2 per `ignorePrefsWriteFailure`.
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
 * here. Arg shape: `{ noteId, plaintext }`, plus the optional
 * `expectedBaseHashHex` guard.
 *
 * `expectedBaseHashHex` (§11.3 expected-base guard, MYND-617 task 11):
 * SHA-256 hex of the UTF-8 plaintext the caller believes is currently on
 * disk. When present and the disk has moved on — a sync pull-apply raced
 * the write — the backend rejects with `{kind:"BaseMismatch"}` and writes
 * **nothing**.
 *
 * **The parameter was missing here, and the gap was never task-specific.**
 * The backend has always accepted it as optional; the mobile wrapper simply
 * never passed it, so **every** mobile note write was a blind overwrite of
 * whatever was on disk. On a note the user is not looking at, that discards
 * an edit sync had just pulled. Leaving the query block read-only on mobile
 * until this was fixed was considered and rejected: it would have turned an
 * existing defect into a permanent design decision.
 *
 * Omitting it keeps the legacy last-write-wins behaviour, so every existing
 * caller compiles and behaves exactly as before.
 *
 * Rejects with a {@link NoteUpdateError}.
 */
export async function noteUpdate(
  noteId: string,
  plaintext: string,
  expectedBaseHashHex?: string,
): Promise<void> {
  await invoke<void>(
    "plugin:notes|note_update",
    expectedBaseHashHex === undefined
      ? { noteId, plaintext }
      : { noteId, plaintext, expectedBaseHashHex },
  );
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
 * Tombstone a note under sync (MYND-426) — ported from desktop
 * `src/notes/deleteNote.ts`. Writes a `deleted: <now>` marker (RFC 3339 UTC)
 * into the note's frontmatter via `note_update` (a new version the vault head
 * commits) instead of a bare `unlink`: a bare absence cannot propagate through
 * the blind server and would risk resurrection, whereas a `deleted`-marked
 * version does. Then flags the sync engine so the next push sets the server
 * tombstone (horizon-GC reclaims the ciphertext after other devices pull it).
 */
export async function tombstoneNote(noteId: string): Promise<void> {
  const current = await noteRead(noteId);
  const tombstoned = patchDeletedField(new TextEncoder().encode(current), new Date().toISOString());
  await noteUpdate(noteId, new TextDecoder().decode(tombstoned));
  try {
    await invoke("plugin:sync|sync_mark_tombstone", { noteIdHex: noteId.replace(/-/g, "") });
  } catch {
    // Sync not configured / command unavailable — the `deleted:` field still propagates.
  }
}

/** True when a sync endpoint is configured (the under-sync reroute predicate). */
async function isSyncConfigured(): Promise<boolean> {
  try {
    const cfg = await invoke<{ endpoint_url: string | null }>("plugin:sync|sync_get_endpoint");
    return cfg.endpoint_url != null;
  } catch {
    return false;
  }
}

/**
 * Delete a note, rerouting under sync to a tombstone version (MYND-426) — ported
 * from desktop `deleteNoteRouted`. When a sync endpoint is configured the deletion
 * is a `deleted`-marked version that propagates to other devices; otherwise
 * (local-only) it is the hard cryptographic-erase unlink. Used by the purge-from-
 * Trash + template-delete paths so a mobile deletion actually reaches other devices
 * (a bare `note_delete` would drop the blob locally only and resurrect on next pull).
 */
export async function deleteNoteRouted(noteId: string): Promise<void> {
  if (await isSyncConfigured()) {
    await tombstoneNote(noteId);
  } else {
    await noteDelete(noteId);
  }
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
