// The collaborative-editor live-session commands (epic live-collab,
// `collab-editor-bridge` task 3), mobile transport bindings.
//
// The desktop twin is `src/lib/live.ts`, and this file is deliberately the same
// five wrappers over the same shared-core commands. A live session is the SINGLE
// durable writer for its note while open (`SYNC-33`): these wrappers open it,
// persist edits through it, and close it. While a session is open the backend
// REFUSES a stateless `note_update` for the same note with
// `NoteUpdateError::LiveSessionOpen`, and that refusal lives in `myne-core`, so
// it applies here the moment a session is open on this client.
//
// This module is the transport binding only, no policy lives here. The policy is
// `@myne/client-core/live-note`, shared with desktop; `./liveNote.ts` wires the
// two together.

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
 * Drain the body splices a sync pull merged into this note's open session. The
 * view dispatches them as ONE editor change so its buffer catches up without a
 * reload. Empty when no pull merged while the session was open.
 *
 * The splice SHAPE is declared once in `@myne/client-core/live-note`.
 */
export async function liveSessionTakeRemoteSplices(
  noteId: string,
): Promise<import("@myne/client-core/live-note").LocalSplice[]> {
  return invoke("plugin:live|live_session_take_remote_splices", { noteId });
}

/**
 * The open session's current whole markdown, which is ahead of disk whenever a
 * live peer edit has landed since this device last wrote (myne-md/myne#849
 * review). Rejects with `{kind:"NotOpen"}` for a note no session owns.
 *
 * The desktop twin is `src/lib/live.ts`; both clients register the command and
 * both read-modify-write funnels read a live note through it.
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
 * cursor. Best-effort: a note with no open session is a no-op, because the
 * policy's `reportLivePresence` returns before calling this for a note it holds
 * no session for, and it always passes `label: null`. `cursor` and `selection`
 * are UTF-16 code units from the document start.
 *
 * `label` rides the wire and no receiver uses it (`awarenessUpsert` discards a
 * frame-supplied name and the peer's label comes from the receiving device's own
 * identity resolver). The only caller passes null.
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
