// Drag-tab-out decision core (myne-md/myne#678, epic #173).
//
// HTML5 drag-and-drop has no "dropped outside the OS window" event, so the
// TabStrip's `dragend` handler decides detachment from three observable facts:
// the drop effect, the pointer's SCREEN coordinates at drag end, and the current
// window's outer bounds (read via the platform window seam — `core:window` size +
// position queries, which are reads the main window already holds). This module
// is the pure decision so it is Vitest-tested without a DOM or a live window; the
// TabStrip glue reads the three inputs and calls it.

/** A rectangle in SCREEN coordinates (outer window bounds). */
export type ScreenRect = { x: number; y: number; width: number; height: number };

/** A point in SCREEN coordinates (a `dragend` event's `screenX`/`screenY`). */
export type ScreenPoint = { x: number; y: number };

/**
 * Whether a tab `dragend` should detach the note into its own window.
 *
 * True only when the drag ended with NO valid drop target (`dropEffect` is
 * `"none"` — a pane/folder drop consumes the payload and reports `"move"`) AND
 * the pointer is OUTSIDE the current window's outer bounds. The bounds test is
 * what separates "dragged out onto the desktop / a second monitor" (detach) from
 * a cancelled drag or an invalid drop still inside the window (do nothing) — the
 * two cases that also report `dropEffect: "none"`.
 *
 * `pointer` is `null` when the platform gave no screen coordinates (some Linux
 * WebKit `dragend`s); treated as inside (no detach) rather than guessing.
 */
export function shouldDetachOnDrop(
  dropEffect: string,
  pointer: ScreenPoint | null,
  windowBounds: ScreenRect,
): boolean {
  if (dropEffect !== "none") return false;
  if (pointer === null) return false;
  const insideX =
    pointer.x >= windowBounds.x && pointer.x <= windowBounds.x + windowBounds.width;
  const insideY =
    pointer.y >= windowBounds.y && pointer.y <= windowBounds.y + windowBounds.height;
  return !(insideX && insideY);
}
