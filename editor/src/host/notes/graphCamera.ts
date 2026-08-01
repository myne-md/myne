// The graph camera — the half of the old mobile kernel that survived
// (myne-md/myne#200). Its physics half is gone (one d3 kernel now lives in
// `graphLayout.ts`), but its camera was the better answer and is now shared.
//
// The split is the point: `graphLayout` produces geometry in a fixed virtual
// box, identical on every device; the camera decides how a particular screen
// looks at that geometry. Same map, different window — which is why layout is
// shared and the view transform is not.

import type { ViewTransform } from "./graphCulling";

/** Pinch/wheel zoom clamp. The floor is low enough that {@link fitTransform}
 *  can fit a large vault's cloud into a phone box (a 0.3-style floor would
 *  fight it); the ceiling is the desktop wheel-zoom ceiling. */
export const K_MIN = 0.05;
export const K_MAX = 8;

/** Clamp a zoom level into the supported range. */
export function clampK(k: number): number {
  return Math.max(K_MIN, Math.min(K_MAX, k));
}

/**
 * The view that fits the bounding box of `positions` into a `width`×`height`
 * box with `padding` screen-px on every side, zoom capped at `maxK` (so a
 * two-node graph doesn't fill the screen) and floored at {@link K_MIN}.
 *
 * Run when a layout becomes ready (hydrated / worker-applied / cold seed) and
 * on double-tap. It is what makes a layout computed in the shared virtual box
 * — or persisted under a different orientation or window size — reachable
 * without hunting for it.
 */
export function fitTransform(
  positions: ReadonlyArray<{ x: number; y: number }>,
  width: number,
  height: number,
  padding = 32,
  maxK = 1.5,
): ViewTransform {
  if (positions.length === 0) return { x: 0, y: 0, k: 1 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of positions) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bw = maxX - minX,
    bh = maxY - minY;
  const k =
    bw === 0 && bh === 0
      ? 1
      : Math.max(
          K_MIN,
          Math.min(
            maxK,
            (width - 2 * padding) / Math.max(bw, 1e-6),
            (height - 2 * padding) / Math.max(bh, 1e-6),
          ),
        );
  // Centre the scaled bbox in the screen box: screen = graph * k + translate.
  const bcx = (minX + maxX) / 2,
    bcy = (minY + maxY) / 2;
  return { x: width / 2 - bcx * k, y: height / 2 - bcy * k, k };
}
