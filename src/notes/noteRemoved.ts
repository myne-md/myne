// Cross-device removal detection + signal for an open note (myne-md/myne#839).
//
// A note that leaves the LIVE tree (soft-trashed, archived, or carrying the
// `deleted:` sync tombstone) must close its open pane(s) however it got there.
// The local path is the backend `notes://deleted` event; a note pulled from
// ANOTHER device is applied straight to disk by the sync engine and never
// reaches `note_update_from_host`, so no such event fires and a pop-out (or an
// open tab) would keep showing a note that is gone. The pull does bump the
// reload nonce, so `PaneView` re-reads the note body there; this module turns
// that read into the same signal, using the SAME value-strict readers the
// sidebar's `loadNoteBatch` uses, so the tree and the editor cannot disagree.
//
// The signal is a window event (the `TASK_WRITE_EVENT` pattern) rather than a
// new workspace-context member: the removal decision lives where the body is
// read, and the terminal state lives in `Editor`, which already listens to
// window events.

import { parseFrontmatter } from "../dialect/visitors/frontmatter";
import {
  readArchivedFromFmBody,
  readDeletedFromFmBody,
  readTrashedFromFmBody,
} from "../dialect";
import type { NoteId } from "./sidebarState";

/** True when a decrypted note body is no longer part of the live tree. */
export function isRemovedFromLiveTree(body: string): boolean {
  // `parseFrontmatter().raw` is the frontmatter body (between the fences),
  // exactly what the value-strict readers expect, and the same source
  // `loadNoteBatch` feeds them via its own slice.
  const raw = parseFrontmatter(body).raw;
  if (raw === null || raw.length === 0) return false;
  return (
    readTrashedFromFmBody(raw) !== null ||
    readArchivedFromFmBody(raw) !== null ||
    readDeletedFromFmBody(raw) !== null
  );
}

export const NOTE_REMOVED_EVENT = "myne:note-removed";

export type NoteRemovedDetail = { noteId: NoteId };

/** Announce that `noteId` left the live tree, so every open surface closes it. */
export function dispatchNoteRemoved(noteId: NoteId): void {
  window.dispatchEvent(
    new CustomEvent<NoteRemovedDetail>(NOTE_REMOVED_EVENT, {
      detail: { noteId },
    }),
  );
}
