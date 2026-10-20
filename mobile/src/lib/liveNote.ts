// Mobile's wiring of the shared live-note policy.
//
// The policy (the per-note refcount, the open/close lifecycle, the save funnel)
// lives in `@myne/client-core/live-note`, because the desktop client makes the
// identical decision and two agreeing copies are how a writer-model change lands
// on one client only. What stays here is the HOST: the five transport bindings
// this client calls and the capability answers it consults. Both are injected, so
// the shared module keeps its no-host entry criterion.
//
// The desktop twin is `src/notes/liveNote.ts`, and the two files differ only in
// what they inject, which is exactly the seam's point.
//
// Re-exported one for one so a caller imports one module, exactly as on desktop.

import {
  createLiveNotePolicy,
  isLiveNotOpen,
  type LiveNoteHost,
} from "@myne/client-core/live-note";
import {
  liveSessionClose,
  liveSessionOpen,
  liveSessionPatchFrontmatter,
  liveSessionRead,
  liveSessionSetPresence,
  liveSessionTakeRemoteSplices,
} from "./live";
import { has } from "../platform/capabilities";

export type { LivePatchOptions, LocalSplice } from "@myne/client-core/live-note";

// The transports are wrapped in a call rather than passed as bare values, so each
// binding has a real call site in production. That is a convention here, not
// something a guard enforces: `scripts/check-ipc-binding-callers.mjs` still counts
// a bare mention as a caller (a strict call rule was tried and reverted, and the
// guard's own comment records why), and the desktop shim passes bare values and
// passes it (myne-md/myne#849 review).
const policy = createLiveNotePolicy({
  open: (noteId) => liveSessionOpen(noteId),
  close: (noteId) => liveSessionClose(noteId),
  patch: (noteId, markdown, opts) => liveSessionPatchFrontmatter(noteId, markdown, opts),
  takeRemoteSplices: (noteId) => liveSessionTakeRemoteSplices(noteId),
  setPresence: (noteId, cursor, selection, label) =>
    liveSessionSetPresence(noteId, cursor, selection, label),
  peerPresenceAvailable: () => has("liveCollabPeerPresence"),
  awarenessCursorsAvailable: () => has("liveCollabAwarenessCursors"),
} satisfies LiveNoteHost);

/** Whether a live session opened by this app currently owns `noteId`. The note
 * primitives ask it before a read (which then reads the session) and before a
 * delete (which refuses under a session that would re-write the note). */
export const isLiveNote = policy.isLiveNote;

/**
 * Open (or attach to) the live session for `noteId` and take a hold on it. A
 * second view of the same note attaches to the one session (`SYNC-34`).
 */
export const openLiveNote = policy.openLiveNote;

/**
 * Release a hold on `noteId`'s live session; the LAST release flushes and drops
 * it (note switch / editor exit).
 */
export const closeLiveNote = policy.closeLiveNote;

/**
 * Drop `noteId`'s live session outright, whatever views hold it, before an erase.
 * `true` when no session owns the note afterwards; `false` when the flush failed
 * and every hold was restored, so the caller must refuse rather than erase.
 */
export const evictLiveNote = policy.evictLiveNote;

/**
 * The save funnel: while a live session owns `noteId`, persist `markdown` through
 * it and return the session's text after the patch; otherwise return `null` and
 * the caller uses the stateless `note_update`. `opts.expectedBaseHashHex` is
 * checked by the session against its own text (a mismatch rejects with
 * `{kind:"BaseMismatch"}`), and `opts.base` makes the core merge rather than
 * replace when the session has moved past it.
 */
export const patchLiveNote = policy.patchLiveNote;

/**
 * Resolve once every `patchLiveNote` for `noteId` in flight NOW has settled. The
 * merge drain awaits it so this device's own write is not read back as a peer's.
 */
export const settledPatches = policy.settledPatches;

/** How many `patchLiveNote` calls for `noteId` have started; see the policy. */
export const patchEpoch = policy.patchEpoch;

/**
 * The session's current text for `noteId`, or `null` when no session owns it
 * (never opened, closed, or the vault left). A note this app holds no session for
 * is answered without an IPC hop.
 */
export async function readLiveNote(noteId: string): Promise<string | null> {
  if (!policy.isLiveNote(noteId)) return null;
  try {
    return await liveSessionRead(noteId);
  } catch (e) {
    if (isLiveNotOpen(e)) return null;
    throw e;
  }
}

/**
 * Drain the body splices a sync pull merged into `noteId`'s open session, for the
 * view to dispatch as one editor change.
 */
export const takeRemoteSplices = policy.takeRemoteSplices;

/**
 * Report this device's local caret/selection so peers render its cursor. A note
 * with no live session is a no-op: the policy returns before calling the host,
 * and the label it passes is always null.
 */
export const reportLivePresence = policy.reportLivePresence;
