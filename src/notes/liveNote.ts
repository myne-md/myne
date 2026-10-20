// Desktop's wiring of the shared live-note policy.
//
// The policy itself (the refcount, the open/close lifecycle, the save funnel)
// lives in `@myne/client-core`, which is the repository's cross-client decision
// layer, because the mobile client makes the identical decision. What stays here
// is the HOST: the five transport bindings this client calls and the two
// capability answers it consults. Both are injected, so the shared module keeps
// its no-host entry criterion and neither client can drift from the other.
//
// The exports are re-exported one for one, so every existing importer
// (`src/notes/components/PaneView.tsx`, `src/notes/updateNote.ts`) is unchanged.
// That is the re-export-shim shape `client-core` documents for its consumers.

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
} from "../lib/live";
import { has } from "../platform/capabilities";

export type { LivePatchOptions, LocalSplice } from "@myne/client-core/live-note";

const policy = createLiveNotePolicy({
  open: liveSessionOpen,
  close: liveSessionClose,
  patch: liveSessionPatchFrontmatter,
  takeRemoteSplices: liveSessionTakeRemoteSplices,
  // The label rides the wire and no receiver uses it: `awarenessUpsert` discards
  // a frame-supplied name and the peer's label comes from the receiving device's
  // own identity resolver, so one device is named the same way by the roster and
  // the version history (`member-devices` task 5). The policy passes null.
  setPresence: liveSessionSetPresence,
  peerPresenceAvailable: () => has("liveCollabPeerPresence"),
  // The web lane has no awareness consumer: `live_session_set_presence` is
  // refused there and the cursor capability is absent, so the invoke is never
  // attempted rather than fired and swallowed.
  awarenessCursorsAvailable: () => has("liveCollabAwarenessCursors"),
} satisfies LiveNoteHost);

/** Whether a live session opened by this app currently owns `noteId`. */
export const isLiveNote = policy.isLiveNote;

/**
 * Open (or attach to) the live session for `noteId` and take a hold on it. A
 * second view of the same note attaches to the one session (`SYNC-34`).
 */
export const openLiveNote = policy.openLiveNote;

/**
 * Release a hold on `noteId`'s live session; the LAST release flushes and drops
 * it (note switch / view unmount).
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
 * is answered without an IPC hop. Byte-identical in shape to the mobile twin.
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
 * view to dispatch as ONE `ChangeSet`.
 */
export const takeRemoteSplices = policy.takeRemoteSplices;

/**
 * Report this device's local caret/selection so peers render its cursor. A no-op
 * for a note with no live session, and for a client with no awareness consumer.
 */
export const reportLivePresence = policy.reportLivePresence;
