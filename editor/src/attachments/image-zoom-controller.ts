// DOM controller for the attachment image lightbox's zoom/pan (MYND-594). Owns
// the element wiring — wheel, pointer pan, two-finger pinch, double-tap toggle,
// keyboard — and drives the image's `transform` via a coalesced rAF, using the
// pure algebra in `image-zoom.ts`. Reuses the knowledge-graph canvas gesture
// shape (`GraphCanvas.tsx`); no new dependency.
//
// The `stage` is the lightbox backdrop: it is the image's positioned + clipping
// ancestor (`overflow: hidden`), and its content box is the viewport the image
// fits into. The image is `position: absolute; transform-origin: 0 0`.

import {
  clampK,
  computeBounds,
  fitState,
  isFit,
  panBy,
  stepZoom,
  toggleFitHundred,
  zoomAbout,
  zoomPercent,
  type ZoomBounds,
  type ZoomState,
  WHEEL_ZOOM_RATE,
} from "./image-zoom";

export interface ImageZoomController {
  destroy(): void;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
}

/**
 * Wire zoom/pan onto `img` inside `stage`. `onPercent` is called whenever the
 * zoom changes so the caller can update the controls' readout. The controller
 * self-initialises once the image has natural dimensions (immediately if it is
 * already loaded, else on `load`).
 */
export function mountImageZoom(
  stage: HTMLElement,
  img: HTMLImageElement,
  onPercent: (pct: number) => void,
): ImageZoomController {
  let bounds: ZoomBounds | null = null;
  let state: ZoomState = { k: 1, tx: 0, ty: 0 };
  let raf = 0;
  // Active pointers by id → last client position, for pan + pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  // Pinch baseline: the distance + midpoint (stage coords) + scale at gesture start.
  let pinch: { dist: number; k: number } | null = null;
  let panning = false;

  const stagePoint = (clientX: number, clientY: number) => {
    const r = stage.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const render = () => {
    raf = 0;
    img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.k})`;
  };
  const schedule = () => {
    if (raf === 0) raf = requestAnimationFrame(render);
  };

  const updateCursor = () => {
    if (bounds === null) return;
    img.style.cursor = panning
      ? "grabbing"
      : isFit(state, bounds)
        ? "zoom-in"
        : "grab";
  };

  const commit = (next: ZoomState) => {
    if (bounds === null) return;
    state = next;
    schedule();
    updateCursor();
    onPercent(zoomPercent(state, bounds));
  };

  const init = () => {
    if (img.naturalWidth === 0) return; // not decoded yet
    // Read the fit box with no transform applied (state starts at identity, and
    // render() has not run yet on first init).
    const fitW = img.clientWidth || img.getBoundingClientRect().width;
    const fitH = img.clientHeight || img.getBoundingClientRect().height;
    bounds = computeBounds(
      stage.clientWidth,
      stage.clientHeight,
      fitW,
      fitH,
      img.naturalWidth,
    );
    state = fitState(bounds);
    render();
    updateCursor();
    onPercent(zoomPercent(state, bounds));
  };

  // ── Handlers ────────────────────────────────────────────────────────────────
  const onWheel = (e: WheelEvent) => {
    if (bounds === null) return;
    e.preventDefault();
    const p = stagePoint(e.clientX, e.clientY);
    // Trackpad pinch arrives as a wheel with ctrlKey; treat both as zoom.
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_RATE);
    commit(zoomAbout(state, state.k * factor, p.x, p.y, bounds));
  };

  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const onPointerDown = (e: PointerEvent) => {
    if (bounds === null || e.target !== img) return; // background → dismiss (backdrop)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Capture so a drag that leaves the image keeps panning. Guarded: a
    // synthetic pointer (tests) or an already-released id can throw here, and a
    // failed capture only costs off-element moves — never the gesture itself.
    try {
      img.setPointerCapture(e.pointerId);
    } catch {
      /* non-fatal */
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: dist(a, b), k: state.k };
      panning = false;
    } else if (pointers.size === 1 && !isFit(state, bounds)) {
      panning = true;
    }
    updateCursor();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (bounds === null || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId)!;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch !== null) {
      const [a, b] = [...pointers.values()];
      const d = dist(a, b);
      if (pinch.dist > 0) {
        const mid = stagePoint((a.x + b.x) / 2, (a.y + b.y) / 2);
        commit(zoomAbout(state, pinch.k * (d / pinch.dist), mid.x, mid.y, bounds));
      }
    } else if (panning && pointers.size === 1) {
      commit(panBy(state, e.clientX - prev.x, e.clientY - prev.y, bounds));
    }
  };

  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) panning = false;
    if (img.hasPointerCapture?.(e.pointerId)) img.releasePointerCapture(e.pointerId);
    updateCursor();
  };

  const onDblClick = (e: MouseEvent) => {
    if (bounds === null) return;
    e.preventDefault();
    const p = stagePoint(e.clientX, e.clientY);
    commit(toggleFitHundred(state, p.x, p.y, bounds));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (bounds === null) return;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      commit(stepZoom(state, +1, bounds));
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      commit(stepZoom(state, -1, bounds));
    } else if (e.key === "0") {
      e.preventDefault();
      commit(fitState(bounds));
    }
  };

  const onResize = () => {
    if (bounds === null) return;
    // Recompute the fit box + bounds against the new stage; keep the current
    // zoom percentage where possible, re-constrained.
    const pct = zoomPercent(state, bounds);
    // Reset transform to read the untransformed fit box.
    img.style.transform = "";
    init();
    if (bounds !== null && pct !== zoomPercent(state, bounds)) {
      const targetK = clampK((pct / 100) * bounds.hundredPercentK, bounds);
      commit(zoomAbout(fitState(bounds), targetK, stage.clientWidth / 2, stage.clientHeight / 2, bounds));
    }
  };

  // ── Wiring ──────────────────────────────────────────────────────────────────
  if (img.complete && img.naturalWidth > 0) init();
  else img.addEventListener("load", init, { once: true });

  stage.addEventListener("wheel", onWheel, { passive: false });
  img.addEventListener("pointerdown", onPointerDown);
  img.addEventListener("pointermove", onPointerMove);
  img.addEventListener("pointerup", endPointer);
  img.addEventListener("pointercancel", endPointer);
  img.addEventListener("dblclick", onDblClick);
  stage.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);

  return {
    destroy() {
      if (raf !== 0) cancelAnimationFrame(raf);
      stage.removeEventListener("wheel", onWheel);
      img.removeEventListener("pointerdown", onPointerDown);
      img.removeEventListener("pointermove", onPointerMove);
      img.removeEventListener("pointerup", endPointer);
      img.removeEventListener("pointercancel", endPointer);
      img.removeEventListener("dblclick", onDblClick);
      stage.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    },
    zoomIn() {
      if (bounds !== null) commit(stepZoom(state, +1, bounds));
    },
    zoomOut() {
      if (bounds !== null) commit(stepZoom(state, -1, bounds));
    },
    reset() {
      if (bounds !== null) commit(fitState(bounds));
    },
  };
}
