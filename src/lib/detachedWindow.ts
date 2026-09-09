// IPC wrapper for the `detached-window` plugin (myne-md/myne#678, epic #173).
//
// Opens a note in its own detached (pop-out) OS-level window. Host-spawned:
// page context has no window-create grant, so this asks the desktop host to
// build the `note-<id>` window (which carries the narrow `detached-note`
// capability, myne#677). Desktop-only, gate the caller on
// `has("detachedWindows")`; web and mobile cannot spawn OS windows.

import { invoke } from "../platform/core";
import type { WindowGeometry } from "../notes/detachedGeometry";
import type { DetachedEntry } from "../notes/detachedRestore";

// The desktop host stamps these two globals into a detached window's page at
// build time (`detached_window_open`'s init script: `window.__MYNE_DETACHED__ =
// true; window.__MYNE_DETACHED_NOTE_ID__ = "<id>"`). They are UPPERCASE on
// purpose so `check-web-no-test-hooks.mjs`'s lowercase `__myne*` scan never
// matches them, and they are never set on web or mobile (no OS window is
// spawned), so the accessors below answer "not detached" there by construction.
declare global {
  interface Window {
    __MYNE_DETACHED__?: boolean;
    __MYNE_DETACHED_NOTE_ID__?: string;
  }
}

/**
 * Ask the host to open (revealing an already-open note rather than duplicating
 * it, #678 single-instance) a detached window holding `noteId`. The note
 * plaintext is loaded by the new window via `note_read`; no key crosses IPC.
 *
 * Rejects with a `DetachedWindowError` (invalid-note-id / window-create-failed /
 * window-show-failed) surfaced from the host command.
 */
export async function openDetachedWindow(
  noteId: string,
  geometry?: WindowGeometry,
): Promise<void> {
  // `geometry` is the restore path (myne#678 task 6): the saved PHYSICAL bounds,
  // already clamped onto a connected display. Omitted on a fresh pop-out, where
  // the host lets the OS place the window.
  await invoke<void>("plugin:detached-window|detached_window_open", {
    noteId,
    geometry: geometry ?? null,
  });
}

/**
 * Snapshot the open detached windows' note ids + current PHYSICAL geometry
 * (myne#678 task 6, SYNC-10). The main window persists the result into the
 * device-local MYW1 workspace blob so a relaunch can restore the pop-outs. Window
 * bounds only, never content. Empty when nothing is popped out; on web/mobile the
 * command is absent (typed-unsupported), so callers gate on `has("detachedWindows")`.
 */
export async function detachedWindowsSnapshot(): Promise<DetachedEntry[]> {
  return await invoke<DetachedEntry[]>(
    "plugin:detached-window|detached_window_snapshot",
  );
}

/**
 * The note id a detached window was opened for (SYNC-1 `note-<id>`), or `null`
 * outside a detached window. `App.tsx` passes it to `<Editor detachedNoteId>` so
 * the pop-out opens that one note in a single pane with no sidebar (SYNC-6: the
 * note lives in exactly one surface, and a detached window cannot reach another).
 */
export function detachedNoteId(): string | null {
  try {
    const id = window.__MYNE_DETACHED_NOTE_ID__;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
