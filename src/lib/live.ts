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
 * session. Resolves with the session's WHOLE markdown after the patch.
 *
 * `expectedBaseHashHex` is the §11.3 expected-base guard on the live path: when
 * the session's own current text hashes differently, the command rejects with
 * `{kind:"BaseMismatch"}` and writes nothing. `base` is the text `markdown` was
 * derived from: when the session has moved past it, the core three-way merges
 * instead of replacing, so a save from a stale buffer keeps a peer's edit. Each
 * optional key is sent only when defined, so an unguarded write carries exactly
 * the two keys it always did.
 */
export async function liveSessionPatchFrontmatter(
  noteId: string,
  markdown: string,
  opts?: { expectedBaseHashHex?: string; base?: string },
): Promise<string> {
  const args: Record<string, string> = { noteId, markdown };
  if (opts?.expectedBaseHashHex !== undefined) {
    args.expectedBaseHashHex = opts.expectedBaseHashHex;
  }
  if (opts?.base !== undefined) args.base = opts.base;
  return invoke("plugin:live|live_session_patch_frontmatter", args);
}

/**
 * One local edit: replace the UTF-16 range `[from, to)` with `insert`. These are
 * the splices a sync pull merged into an open session hands the pane, which
 * dispatches them as one multi-range `ChangeSet`.
 *
 * The SHAPE is declared once, in `@myne/client-core/live-note`, because the
 * policy that drains them lives there and both clients receive the same one.
 * Re-exported here so this binding module's own importers are unchanged.
 */
export type { LocalSplice } from "@myne/client-core/live-note";
import type { LocalSplice } from "@myne/client-core/live-note";


/**
 * Drain the body splices a sync pull merged into this note's open session
 * (`collab-editor-bridge` task 7). The pane dispatches them as ONE CodeMirror
 * `ChangeSet` so its buffer catches up WITHOUT a reload. Empty when no pull merged
 * while the session was open.
 */
export async function liveSessionTakeRemoteSplices(noteId: string): Promise<LocalSplice[]> {
  return invoke("plugin:live|live_session_take_remote_splices", { noteId });
}

/**
 * The open session's current whole markdown, which is ahead of disk whenever a
 * live peer edit has landed since this device last wrote (myne-md/myne#849
 * review, D8). Rejects with `{kind:"NotOpen"}` for a note no session owns.
 *
 * The mobile twin is `mobile/src/lib/live.ts`; both clients register the command
 * and both read-modify-write funnels read a live note through it.
 */
export async function liveSessionRead(noteId: string): Promise<string> {
  return invoke("plugin:live|live_session_read", { noteId });
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
