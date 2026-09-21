// Pure zoom/pan math for the attachment image lightbox (MYND-594). No DOM, no
// events — just the transform algebra, so it is unit-testable and shared by the
// lightbox's wheel / pinch / double-tap / keyboard / button paths. The DOM
// controller in `lightbox.ts` owns the element wiring and calls into these.
//
// Model: the image sits in a `stage` (the viewport) and carries
// `transform: translate(tx, ty) scale(k)` with `transform-origin: 0 0`, so `tx`/
// `ty` are the image's top-left in stage coordinates and `k` scales from the
// FIT size (`k = 1` shows the image object-fit-contained; `k = hundredPercentK`
// shows it at 1:1 device-independent pixels). This mirrors the knowledge-graph
// canvas transform (`GraphCanvas.tsx`) — no new dependency, the ticket's
// "reuse the in-house pan/zoom" note.

/** The view transform: scale + top-left translate, in stage px. */
export interface ZoomState {
  readonly k: number;
  readonly tx: number;
  readonly ty: number;
}

/** Fixed geometry derived once per image (on load / resize). */
export interface ZoomBounds {
  /** Minimum scale — always 1 (fit-to-stage). */
  readonly minK: number;
  /** Maximum scale — enough to reach 1:1 on a large scan, with a sane ceiling. */
  readonly maxK: number;
  /** Scale at which the image is 1:1 with its natural pixels (the "100%" mark). */
  readonly hundredPercentK: number;
  readonly stageW: number;
  readonly stageH: number;
  /** The image's rendered box at `k = 1` (object-fit: contain within the cap). */
  readonly fitW: number;
  readonly fitH: number;
}

/** Per-step zoom factor for the +/− buttons and keyboard. */
export const ZOOM_STEP = 1.25;
/** Wheel sensitivity (matches the graph canvas). */
export const WHEEL_ZOOM_RATE = 0.001;

/** Derive the bounds from stage + fit + natural width. `fitW`/`fitH` are the
 *  image's rendered size at k=1; `naturalW` is its intrinsic pixel width. */
export function computeBounds(
  stageW: number,
  stageH: number,
  fitW: number,
  fitH: number,
  naturalW: number,
): ZoomBounds {
  // fitW ≤ naturalW (contain only scales down), so this is ≥ 1.
  const hundredPercentK = fitW > 0 ? Math.max(1, naturalW / fitW) : 1;
  // Always allow at least 3× fit (so a small image is still inspectable), up to
  // 1:1 for a big scan, capped at 8× so a huge image can't zoom into a blur.
  const maxK = Math.min(8, Math.max(hundredPercentK, 3));
  return { minK: 1, maxK, hundredPercentK, stageW, stageH, fitW, fitH };
}

/** Clamp a raw scale into `[minK, maxK]`. */
export function clampK(k: number, b: ZoomBounds): number {
  return Math.min(b.maxK, Math.max(b.minK, k));
}

/**
 * Constrain the translate so the (scaled) image can never be stranded off the
 * stage: on each axis, if the scaled image is larger than the stage its edges
 * are clamped to the stage interior (no dead margin), otherwise it is centered.
 * Zooming back out therefore always recovers a centered image.
 */
export function constrainPan(s: ZoomState, b: ZoomBounds): ZoomState {
  const clampAxis = (t: number, scaled: number, stage: number): number => {
    if (scaled <= stage) return (stage - scaled) / 2; // center on this axis
    return Math.min(0, Math.max(stage - scaled, t)); // keep both edges covering
  };
  return {
    k: s.k,
    tx: clampAxis(s.tx, b.fitW * s.k, b.stageW),
    ty: clampAxis(s.ty, b.fitH * s.k, b.stageH),
  };
}

/** The fit view: k = 1, centered. */
export function fitState(b: ZoomBounds): ZoomState {
  return constrainPan({ k: b.minK, tx: 0, ty: 0 }, b);
}

/**
 * The scale at which the content's WIDTH matches the stage.
 *
 * This is the mermaid viewer's rest scale (myne-md/myne#708): a diagram is drawn
 * as large as the column allows rather than fit to the smaller of the two axes,
 * because fitting a tall diagram to a short box is what myne-md/myne#629 records
 * as "every node a sub-pixel dot". `fitW` is the contained box, so this is >= 1
 * and is exactly 1 when width is already the binding axis.
 */
export function fitWidthK(b: ZoomBounds): number {
  return b.fitW > 0 ? b.stageW / b.fitW : b.minK;
}

/**
 * The rest scale for a viewer whose default is "fit the width, never upscale
 * past natural size". `hundredPercentK` is the natural mark, so the min of the
 * two upscales a small diagram only as far as its own pixels.
 */
export function restK(b: ZoomBounds): number {
  return clampK(Math.min(fitWidthK(b), b.hundredPercentK), b);
}

/** The rest view: fit to width (capped at natural), centred. */
export function restState(b: ZoomBounds): ZoomState {
  return constrainPan({ k: restK(b), tx: 0, ty: 0 }, b);
}

/** Is the view at its rest scale? */
export function isRest(s: ZoomState, b: ZoomBounds): boolean {
  return Math.abs(s.k - restK(b)) < 1e-3;
}

/**
 * Zoom to `k2raw` (clamped) while keeping the stage point `(cx, cy)` pinned to
 * the same image content — i.e. zoom toward the cursor / pinch midpoint.
 */
export function zoomAbout(
  s: ZoomState,
  k2raw: number,
  cx: number,
  cy: number,
  b: ZoomBounds,
): ZoomState {
  const k2 = clampK(k2raw, b);
  if (k2 === s.k) return s;
  const tx = cx - (cx - s.tx) * (k2 / s.k);
  const ty = cy - (cy - s.ty) * (k2 / s.k);
  return constrainPan({ k: k2, tx, ty }, b);
}

/** Pan by a stage-space delta, constrained. */
export function panBy(s: ZoomState, dx: number, dy: number, b: ZoomBounds): ZoomState {
  return constrainPan({ k: s.k, tx: s.tx + dx, ty: s.ty + dy }, b);
}

/** Is the view essentially at fit (k = 1)? */
export function isFit(s: ZoomState, b: ZoomBounds): boolean {
  return Math.abs(s.k - b.minK) < 1e-3;
}

/**
 * Double-click / double-tap behaviour: at fit, zoom to 100% about `(cx, cy)`
 * (or to 2× fit when the image is already ≤ its natural size, so the gesture is
 * never a no-op); otherwise return to fit.
 */
export function toggleFitHundred(
  s: ZoomState,
  cx: number,
  cy: number,
  b: ZoomBounds,
): ZoomState {
  if (!isFit(s, b)) return fitState(b);
  const target =
    b.hundredPercentK > b.minK + 1e-3
      ? b.hundredPercentK
      : Math.min(b.maxK, b.minK * 2);
  return zoomAbout(s, target, cx, cy, b);
}

/** Zoom one step in (`dir > 0`) or out (`dir < 0`) about the stage centre. */
export function stepZoom(s: ZoomState, dir: number, b: ZoomBounds): ZoomState {
  const factor = dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  return zoomAbout(s, s.k * factor, b.stageW / 2, b.stageH / 2, b);
}

/** The user-facing zoom percentage (100% = 1:1 pixels). */
export function zoomPercent(s: ZoomState, b: ZoomBounds): number {
  return Math.round((s.k / b.hundredPercentK) * 100);
}
