// Detached-window restore PLAN (myne-md/myne#678 task 6, epic #173, SYNC-10).
//
// The pure half of restoring popped-out windows on the next launch (behind the
// startup_open:"last" preference). It takes the persisted detached entries (note
// id + last geometry, read from the device-local MYW1 vault.workspace blob), the
// current display list and the primary display, and returns the note+geometry
// pairs to re-spawn, each geometry already clamped onto a currently-connected
// display by `clampDetachedGeometry` (so an entry saved on a now-unplugged
// second monitor is pulled back onto the primary rather than re-spawned
// off-screen). The actual window spawn (a host command) and the display read (a
// platform-seam call) are the app-dependent tails the restore effect supplies;
// this module is the decision, so it is Vitest-tested without a live window.

import {
  clampDetachedGeometry,
  type Display,
  type WindowGeometry,
} from "./detachedGeometry";

/** One persisted detached window: the note it held and where it last was. */
export type DetachedEntry = { noteId: string; geometry: WindowGeometry };

/** One window to re-spawn: the note id and its clamped-on-screen geometry. */
export type DetachedSpawn = { noteId: string; geometry: WindowGeometry };

/**
 * Plan the detached-window restore: clamp each persisted entry's geometry onto a
 * currently-connected display and return the spawn list, preserving order.
 *
 * Deliberately total and side-effect-free. A duplicate note id is NOT
 * de-duplicated here (single-instance is the host command's job on spawn,
 * SYNC-6); an entry whose note no longer exists still plans a spawn and the
 * spawned window surfaces its own missing-note state, the same way the
 * "specific" startup mode does, so restore never has to read note bodies.
 */
export function planDetachedRestore(
  entries: readonly DetachedEntry[],
  displays: readonly Display[],
  primary: Display,
): DetachedSpawn[] {
  return entries.map((entry) => ({
    noteId: entry.noteId,
    geometry: clampDetachedGeometry(entry.geometry, displays, primary),
  }));
}
