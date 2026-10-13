// The collaborative-editor live-session commands (epic live-collab,
// `collab-editor-bridge` task 3).
//
// A live session is the SINGLE durable writer for its note while open
// (`SYNC-33`): these wrappers open it, persist edits through it, and close it.
// While a session is open the backend REFUSES a stateless `note_update` for the
// same note with `NoteUpdateError::LiveSessionOpen`.
//
// A local body edit reaches the session as the WHOLE re-derived markdown
// (`liveSessionPatchFrontmatter`), and the CRDT layer records it as minimal
// splices, so there is no client-side splice entry point to keep in step. A
// received peer revision reaches the pane the other way round, as splices the
// pane dispatches (`liveSessionTakeRemoteSplices`). This module is the transport
// binding only, no policy lives here.

import { invoke } from "../platform/core";

/** Open (or attach to) a live session for `noteId`. Idempotent. */
export async function liveSessionOpen(noteId: string): Promise<void> {
  return invoke("plugin:live|live_session_open", { noteId });
}

/**
 * The durable frontmatter entry point: persist a re-derived note through the
 * session.
 */
export async function liveSessionPatchFrontmatter(
  noteId: string,
  markdown: string,
): Promise<void> {
  return invoke("plugin:live|live_session_patch_frontmatter", { noteId, markdown });
}

/**
 * One local edit: replace the UTF-16 range `[from, to)` with `insert`. These are
 * the splices a sync pull merged into an open session hands the pane, which
 * dispatches them as one multi-range `ChangeSet`.
 */
export interface LocalSplice {
  from: number;
  to: number;
  insert: string;
}

/**
 * Drain the body splices a sync pull merged into this note's open session
 * (`collab-editor-bridge` task 7). The pane dispatches them as ONE CodeMirror
 * `ChangeSet` so its buffer catches up WITHOUT a reload. Empty when no pull merged
 * while the session was open.
 */
export async function liveSessionTakeRemoteSplices(noteId: string): Promise<LocalSplice[]> {
  return invoke("plugin:live|live_session_take_remote_splices", { noteId });
}

/** Flush the pending durable write and drop the session. */
export async function liveSessionClose(noteId: string): Promise<void> {
  return invoke("plugin:live|live_session_close", { noteId });
}

/**
 * Report this device's local caret/selection for an open note so peers render its
 * cursor (`collab-presence-ui`). Best-effort: a note with no open session is a
 * no-op. `cursor` and `selection` are UTF-16 code units from the document start
 * (`selection` is `[anchor, head]`, or null for a bare caret).
 *
 * `label` rides the wire and no receiver uses it: `awarenessUpsert` discards a
 * frame-supplied name and the peer's label comes from the receiving device's own
 * identity resolver, so one device is named the same way by the roster and the
 * version history (`member-devices` task 5). The only caller passes null.
 */
export async function liveSessionSetPresence(
  noteId: string,
  cursor: number | null,
  selection: [number, number] | null,
  label: string | null,
): Promise<void> {
  return invoke("plugin:live|live_session_set_presence", {
    noteId,
    cursor,
    selection,
    label,
  });
}
