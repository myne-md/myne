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
// via `Zeroizing<String>` (`src-tauri/AGENTS.md` "Plaintext IPC across
// the WebView boundary").
//
// Each command rejects (never resolves) with its matching `Note*Error`
// discriminated union; those are re-exported below so callers can
// narrow a caught rejection.

import { invoke } from "../platform/core";
import { evictLiveNote, isLiveNote, patchLiveNote, readLiveNote } from "./liveNote";
import { normalizeFolderPath } from "../dialect/folderPath";
import { mutateDeliberateFolders } from "./prefs";
import { patchDeletedField, patchFolderField, patchTitleField } from "../dialect/surgery";
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
 * unregistered too, which is `AGENTS.md`'s own "a default is the arm that never
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
 * **A note with an open live session is read from the SESSION, not from disk**
 * (myne-md/myne#849 review, D8). A live peer edit is applied to the session and
 * not flushed (`core/src/plugins/live/awareness.rs`), so disk lags the session
 * until this device's next write. Every read-modify-write writer here (move,
 * trash, archive, restore, the cover, the template flag, the task toggle, the
 * conflict apply) reads through this function and then writes through
 * `noteUpdate`, which routes a live note through the session as a whole-text
 * replace. Reading disk there patched stale text over the session and deleted the
 * peer's edit, then broadcast the deletion. Reading the session makes the base the
 * text the patch is applied to. A session that closed between the check and the
 * read answers `null`, and disk is then current again, because closing flushes.
 *
 * Rejects with a {@link NoteReadError}.
 */
export async function noteRead(noteId: string): Promise<string> {
  if (isLiveNote(noteId)) {
    const live = await readLiveNote(noteId);
    if (live !== null) return live;
  }
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
 * `base` (live path only): the text `plaintext` was derived from. While a live
 * session owns the note and has moved past `base`, the core three-way merges
 * instead of replacing, so a save from a stale buffer keeps a peer's edit. The
 * stateless command has no use for it and does not receive it.
 *
 * `onApplied` (live path only): called with the session's text once the write
 * went through a session, before the call settles. The editor's own saves use it
 * to move their mirror of the session (`LivePatchOptions.onApplied`).
 *
 * Rejects with a {@link NoteUpdateError}.
 */
export async function noteUpdate(
  noteId: string,
  plaintext: string,
  expectedBaseHashHex?: string,
  base?: string,
  onApplied?: (after: string) => void,
): Promise<void> {
  // Live funnel (myne-md/myne#849 review, C1). While a live session owns the note
  // it is the SINGLE durable writer (`SYNC-33`), and the backend refuses this
  // stateless overwrite with `NoteUpdateError::LiveSessionOpen`. The funnel belongs
  // HERE rather than at the call site: this is the one place the command is
  // invoked, so every writer inherits it, which is exactly what the desktop twin
  // does (`src/notes/updateNote.ts`) and what mobile got wrong by funnelling only
  // the editor's autosave closure. Without this, the cover flush, the move flush,
  // trash/archive/restore, the task write, the explicit Save and the save-then-open
  // every list surface uses are all REFUSED on the note that is on screen.
  //
  // **The caller's `expectedBaseHashHex` goes WITH it** (myne-md/myne#849 review,
  // D8). The live path is the DEFAULT for whatever note is on screen, since a
  // session opens for any text note while the slot is unlocked, and a caller does
  // pass the hash: the task panel's `setTaskCompleted` (`mobile/src/lib/tasks.ts`),
  // whose whole sequence exists because a `BaseMismatch` preserves a keep-both copy
  // instead of clobbering a raced change. A live peer edit sits unflushed in the
  // session, so the text a caller hashed can be behind the session even though no
  // durable pull raced it. The session therefore evaluates the hash against its OWN
  // current text and rejects with the same `{kind:"BaseMismatch"}` the stateless
  // command uses, writing nothing, so the caller's keep-both branch fires on either
  // path. `noteRead` above reads a live note from the session, so an unguarded
  // read-modify-write writer patches the session's own text too, on both clients.
  if ((await patchLiveNote(noteId, plaintext, { expectedBaseHashHex, base, onApplied })) !== null) {
    return;
  }
  // The session can vanish DURING the call (a delete or a conflict-copy apply
  // evicting it while this write is in flight), and the funnel then answers
  // `null`. The caller skipped the §11.3 hash because a session owned the note, or
  // because it was told none does, so the stateless write below would land its
  // whole text unguarded (myne-md/myne#849 review). Whenever the caller said what
  // its text derives from, guard the fallback with that base: the resulting
  // `BaseMismatch` sends it down the keep-both path instead of over a peer's text.
  // The condition is about the CALL, not about `isLiveNote` at entry: the
  // evict-on-delete paths create exactly the state where no session owns the note
  // while an editor still holds the buffer, and that write is the one to protect.
  if (expectedBaseHashHex === undefined && base !== undefined) {
    expectedBaseHashHex = await sha256Hex(base);
  }

  await invoke<void>(
    "plugin:notes|note_update",
    expectedBaseHashHex === undefined
      ? { noteId, plaintext }
      : { noteId, plaintext, expectedBaseHashHex },
  );
}

/** SHA-256 of the UTF-8 encoding of `text`, as 64 lowercase hex chars (the §11.3 base hash). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
  // Evict the note's live session first (myne-md/myne#849 review). A session holds
  // the document and re-writes `<vault>/notes/<id>.myn` on its next flush, so
  // deleting or tombstoning under a live session means the erase lands and the very
  // next keystroke puts the note back, on the same device, under a user who was
  // told it was gone. Reachable from the Trash list, whose row both opens the note
  // and purges it. A no-op for a note no session owns.
  //
  // Evict, not `closeLiveNote` (review D7): this path holds no hold of its own, so
  // a release here released the editor's hold instead, and with two views on the
  // note the count stayed one short of the views for good. `evictLiveNote` drops
  // every hold and closes once. When the flush FAILS the session is still in the
  // registry and its next flush would undo the erase, so the holds come back and
  // this refuses visibly rather than deleting under it.
  if (!(await evictLiveNote(noteId))) {
    throw { kind: "LiveSessionOpen", noteId };
  }
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

/**
 * Create a note whose `title:` frontmatter is stamped from `name`, at `folder`
 * (`null` = the vault root).
 *
 * `note_create` takes plaintext, so a generated note's title has to be written
 * into the body before the call, and `noteCreate` then registers the folder.
 * That tail was hand-copied into every generator (the meeting drain and the
 * saved audio transcript, myne-md/myne#886 review), which is one place for the
 * two to drift apart; it lives here beside the note primitives instead.
 *
 * `daily.ts`'s `createNoteFromBody` is deliberately NOT a caller: it ALSO
 * stamps `updated:`, which is the period-note convention rather than this one.
 *
 * **A `folder` argument files the note, not just registers it.** `noteCreate`'s
 * own `folder` parameter only records a deliberate folder for the unlock
 * back-fill; the note's location lives in its `folder:` frontmatter, so passing
 * the folder here without patching the body would create the note at the vault
 * root and register a folder it is not in. That is what a photo-to-note capture
 * would have done for every user with "Default location for new notes" set to
 * anything but the root (myne-md/myne#926 review), so the patch happens here,
 * beside the title patch, and a caller that passes `null` is unchanged.
 */
export async function createTitledNote(
  body: string,
  name: string,
  folder: string | null = null,
): Promise<string> {
  let bytes = patchTitleField(new TextEncoder().encode(body), name);
  const target = normalizeFolderPath(folder);
  if (target !== null) bytes = patchFolderField(bytes, target);
  return await noteCreate(new TextDecoder().decode(bytes), target);
}
