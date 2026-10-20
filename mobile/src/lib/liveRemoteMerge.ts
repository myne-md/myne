// The mobile editor's remote-merge drain (myne-md/myne#849).
//
// The drain itself is shared with the desktop pane and lives in
// `@myne/editor/live-remote-merge`, whose header states what it is for and why it
// reads the session rather than trusting the queued splices. What stays here is
// the one thing this client supplies that the shared package cannot import: its
// platform seam's `listen`.

import {
  installRemoteMergeDrain as installShared,
  type RemoteMergeDeps as SharedDeps,
  type RemoteMergeDrain,
} from "@myne/editor/live-remote-merge";
import { listen } from "../platform/event";

export {
  applySplicesToText,
  diffSplices,
  rebaseOnto,
  REMOTE_MERGE_EVENTS,
  type RemoteMergeDrain,
  type RemoteSplice,
} from "@myne/editor/live-remote-merge";

/** What the drain needs from the screen; the event subscription is this module's. */
export type RemoteMergeDeps = Omit<SharedDeps, "listen">;

/**
 * Subscribe the drain for the mounted editor screen. The note id is read through
 * `deps.currentNoteId()` rather than captured.
 */
export function installRemoteMergeDrain(deps: RemoteMergeDeps): RemoteMergeDrain {
  return installShared({ ...deps, listen: (event, handler) => listen<string>(event, handler) });
}
