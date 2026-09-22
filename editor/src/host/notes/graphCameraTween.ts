// The graph camera's tween (myne-md/myne#727), as a pure module.
//
// The camera used to be ASSIGNED: `fitToContent` computed a transform and wrote
// it into the view, so the graph teleported between framings. A live graph
// cannot do that, because the one thing that reads as "a picture" rather than
// "a place" is a viewport that jumps.
//
// Two things here are decisions rather than arithmetic, and both are asserted
// in `tests/notes/graphCameraTween.test.ts`:
//
//   - the DURATION is in the 250-350 ms band, so a move is legible without
//     making the user wait for the interface;
//   - the ZOOM interpolates geometrically rather than linearly. Halfway through
//     a 1x to 4x zoom, a linear ramp is at 2.5x, which reads as "slowing down
//     at the end" to the eye; the geometric midpoint is 2x, which reads as
//     even.
//
// Reducing motion is NOT handled here. The gate is a JavaScript media-query
// read in the renderer, because a CSS media query provably cannot reach canvas
// animation; this module only knows how to move the camera.

import type { ViewTransform } from "./graphCulling";

/** How long a programmatic camera move takes. Inside the 250-350 ms band the
 *  design system uses for a transition that must be noticed but not waited on. */
export const CAMERA_TWEEN_MS = 280;

function clamp01(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Standard ease-out cubic: fast at the start, settling at the end. */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - (1 - c) ** 3;
}

/**
 * The view transform at `progress` (0 to 1) between two framings, out of range
 * clamped. Zoom is interpolated geometrically so the perceived zoom rate is
 * even; pan is linear.
 */
export function tweenTransform(
  from: ViewTransform,
  to: ViewTransform,
  progress: number,
): ViewTransform {
  const t = easeOutCubic(progress);
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    k: from.k * (to.k / from.k) ** t,
  };
}
