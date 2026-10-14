// The live-note funnel and lifecycle (epic live-collab, `collab-editor-bridge`
// tasks 7 + 8).
//
// While a live session owns a note it is the SINGLE durable writer (`SYNC-33`):
// the backend refuses a stateless `note_update` on that note with
// `LiveSessionOpen`. So every `note_update` the app would make has to be routed
// through the session instead, and the session has to be opened when a note is
// shown in a pane and closed when it leaves.
//
// This module is that routing. It tracks, per process, the note ids whose live
// session this app opened, so a save can go straight to `liveSessionPatchFrontmatter`
// (which applies a minimal `update_text`) with no extra IPC, and falls back to the
// stateless `note_update` only for notes with no live session.
//
// Best-effort by design: a drawing note, a locked vault or a client without the
// session capability leaves the note UN-tracked, so the ordinary durable path is
// used and nothing refuses.

import {
  liveSessionClose,
  liveSessionOpen,
  liveSessionPatchFrontmatter,
  liveSessionSetPresence,
  liveSessionTakeRemoteSplices,
  type LocalSplice,
} from "../lib/live";
import { has } from "../platform/capabilities";

// A REFCOUNT per note id, not a set: two panes can show the same note, and the
// session is one per `(vault, note)` (`SYNC-34`), so the first pane to open it
// opens the session and only the last to close it drops the session. A set would
// have let one pane's unmount close the session out from under the other pane.
const openCounts = new Map<string, number>();

/** Whether a live session opened by this app currently owns `noteId`. */
export function isLiveNote(noteId: string): boolean {
  return openCounts.has(noteId);
}

/**
 * Report this device's local caret/selection for an open note so peers render its
 * cursor (`collab-presence-ui`). A no-op for a note with no live session, and for a
 * client with no awareness consumer (the web lane today: `live_session_set_presence`
 * is refused there and `liveCollabAwarenessCursors` is absent, so the invoke is
 * never attempted rather than fired and swallowed). `cursor`/`selection` are UTF-16
 * code units from the document start; the participant label is resolved
 * backend-side.
 */
export function reportLivePresence(
  noteId: string,
  cursor: number | null,
  selection: [number, number] | null,
): void {
  if (!has("liveCollabAwarenessCursors")) return;
  if (!isLiveNote(noteId)) return;
  void liveSessionSetPresence(noteId, cursor, selection, null).catch(() => {});
}

/**
 * Open (or attach to) the live session for `noteId` and take a hold on it. The
 * note id is counted OPTIMISTICALLY before the open resolves, so a save that lands
 * in the same tick is routed to the session rather than the refused `note_update`;
 * a failed open (drawing note, locked vault, absent capability) releases the hold
 * so the durable path resumes. A second pane showing the same note attaches to the
 * one session (`SYNC-34`).
 */
export async function openLiveNote(noteId: string): Promise<void> {
  if (!has("liveCollabPeerPresence")) return;
  const held = openCounts.get(noteId) ?? 0;
  openCounts.set(noteId, held + 1);
  if (held > 0) return; // the session is already open; this is an attach
  try {
    await liveSessionOpen(noteId);
  } catch {
    openCounts.delete(noteId);
  }
}

/**
 * Release a hold on `noteId`'s live session; the LAST release flushes and drops it
 * (note switch / pane unmount).
 */
export async function closeLiveNote(noteId: string): Promise<void> {
  const held = openCounts.get(noteId);
  if (held === undefined) return;
  if (held > 1) {
    openCounts.set(noteId, held - 1);
    return;
  }
  openCounts.delete(noteId);
  try {
    await liveSessionClose(noteId);
  } catch {
    // No session (already closed) or the vault left: nothing to flush.
  }
}

/**
 * The save funnel: while a live session owns `noteId`, persist `markdown` through
 * it and return `true`; otherwise return `false` and the caller uses the stateless
 * `note_update`. The session is the only writer, so the expected-base guard the
 * stateless path carries has nothing to race.
 */
export async function patchLiveNote(noteId: string, markdown: string): Promise<boolean> {
  if (!openCounts.has(noteId)) return false;
  try {
    await liveSessionPatchFrontmatter(noteId, markdown);
    return true;
  } catch (e) {
    // The session was closed out from under us (or never opened): release and
    // fall back to the durable path rather than failing the save.
    if (isLiveNotOpen(e)) {
      openCounts.delete(noteId);
      return false;
    }
    throw e;
  }
}

/**
 * Drain the body splices a sync pull merged into `noteId`'s open session
 * (`collab-editor-bridge` task 7), for the pane to dispatch as ONE `ChangeSet`.
 * Empty when the note is not live or nothing merged.
 */
export async function takeRemoteSplices(noteId: string): Promise<LocalSplice[]> {
  if (!openCounts.has(noteId)) return [];
  return liveSessionTakeRemoteSplices(noteId);
}

/** The `LiveSessionCommandError` is `{ kind: "NotOpen" }` (or a bare string). */
function isLiveNotOpen(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    (e as { kind?: unknown }).kind === "NotOpen"
  );
}
