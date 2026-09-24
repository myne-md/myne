// Shared pan/zoom DOM controller (MYND-594; generalised for the mermaid viewer,
// myne-md/myne#708).
//
// Owns the gesture wiring - wheel, pointer pan, two-finger pinch, double-tap /
// double-click toggle, keyboard - and drives one element's `transform` through a
// coalesced rAF, over the pure algebra in `image-zoom.ts`. It began as the
// attachment image lightbox's alone and is now parameterised over the
// transformed element and a content-box measurement, so the image lightbox and
// the mermaid viewer run the SAME implementation. That is the point: it is why
// `svg-pan-zoom` is not in the tree.
//
// The `stage` is the clipping + positioned ancestor; its content box is the
// viewport. `element` carries `translate(tx, ty) scale(k)` with
// `transform-origin: 0 0`, and its untransformed box is the content box at
// k = 1.

import {
  clampK,
  computeBounds,
  fitState,
  isFit,
  isRest,
  panBy,
  restState,
  stepZoom,
  toggleFitHundred,
  zoomAbout,
  zoomPercent,
  type ZoomBounds,
  type ZoomState,
  WHEEL_ZOOM_RATE,
} from "./image-zoom";

/** The measured content box, in stage px, at k = 1. */
export interface ContentBox {
  /** The content's rendered box with no transform applied (the contained box). */
  readonly fitW: number;
  readonly fitH: number;
  /** The content's intrinsic width, for the 100% mark. */
  readonly naturalW: number;
}

export interface ZoomPanOptions {
  readonly stage: HTMLElement;
  /** The transformed element: an `<img>` for the lightbox, an `<svg>` for the
   *  mermaid viewer. Only `style`, the layout box and the listeners are used. */
  readonly element: HTMLElement | SVGElement;
  /** Called whenever the zoom changes, with the new percentage. */
  readonly onPercent?: (pct: number) => void;
  /** Measure the untransformed content box. Return null until it is laid out.
   *  When omitted, `element` is measured as an `<img>` (naturalWidth + box). */
  readonly measure?: () => ContentBox | null;
  /** "contain": k = 1 shows the whole content (the image lightbox default).
   *  "width": the rest scale is fit-to-width, capped at natural (mermaid). */
  readonly rest?: "contain" | "width";
  /** "always": any wheel over the stage zooms (image lightbox, mermaid, and
   *  every other caller today). "modifier": only ctrl/meta zooms and a plain
   *  wheel keeps scrolling the page; no production caller passes it since
   *  myne-md/myne#742, and it stays as the documented alternative for a future
   *  surface that must live inside a scrolling page. */
  readonly wheel?: "always" | "modifier";
  /** Double-click / double-tap toggles rest <-> 100%. Off where double-click
   *  is the edit-source gesture (mermaid). */
  readonly doubleClick?: boolean;
  /** Pointer target for starting a pan; defaults to `element` when it is an
   *  HTMLElement, else to the stage. */
  readonly panTarget?: HTMLElement;
  /** Handle +/-/0 and the arrow keys on the stage (which must be focusable). */
  readonly keyboard?: boolean;
  /** Called after every committed change (mermaid: re-measure the editor). */
  readonly onCommit?: () => void;
  /** Initialise immediately instead of waiting for a `load` event. */
  readonly ready?: boolean;
}

export interface ZoomPanController {
  destroy(): void;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  /** Jump to a zoom percentage (100 = natural pixels), about the stage centre.
   *  Used to restore a session-remembered scale. */
  setPercent(pct: number): void;
  /** Pan by a stage-space delta (positive dy moves the content down), used by
   *  the pan-arrow controls. */
  pan(dx: number, dy: number): void;
  /** Recompute the bounds after the content or the stage changed size. */
  remeasure(): void;
}

/** Keyboard/button pan distance, in stage px. Matches the lightbox's feel. */
const PAN_STEP = 100;

/**
 * Wire pan/zoom onto `options.element` inside `options.stage`, over the pure
 * algebra in `image-zoom.ts`.
 */
export function mountZoom(options: ZoomPanOptions): ZoomPanController {
  const { stage, element } = options;
  const rest = options.rest ?? "contain";
  const wheelMode = options.wheel ?? "always";
  const keyboard = options.keyboard ?? true;
  const panTarget: HTMLElement =
    options.panTarget ?? (element instanceof HTMLElement ? element : stage);

  const restOf = (b: ZoomBounds): ZoomState => (rest === "width" ? restState(b) : fitState(b));
  const atRest = (s: ZoomState, b: ZoomBounds): boolean =>
    rest === "width" ? isRest(s, b) : isFit(s, b);

  let bounds: ZoomBounds | null = null;
  let state: ZoomState = { k: 1, tx: 0, ty: 0 };
  let raf = 0;
  // Active pointers by id -> last client position, for pan + pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  // Pinch baseline: distance + scale at gesture start.
  let pinch: { dist: number; k: number } | null = null;
  let panning = false;

  const stagePoint = (clientX: number, clientY: number) => {
    const r = stage.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const render = () => {
    raf = 0;
    element.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.k})`;
  };
  const schedule = () => {
    if (raf === 0) raf = requestAnimationFrame(render);
  };

  const updateCursor = () => {
    if (bounds === null) return;
    element.style.cursor = panning
      ? "grabbing"
      : atRest(state, bounds) && options.doubleClick === true
        ? "zoom-in"
        : "grab";
  };

  const commit = (next: ZoomState) => {
    if (bounds === null) return;
    state = next;
    schedule();
    updateCursor();
    options.onPercent?.(zoomPercent(state, bounds));
    options.onCommit?.();
  };

  /** Measure an `<img>`: its laid-out box at k=1 plus its intrinsic width. */
  const measureImage = (): ContentBox | null => {
    const img = element as unknown as {
      naturalWidth?: number;
      clientWidth: number;
      getBoundingClientRect(): DOMRect;
    };
    const naturalW = img.naturalWidth ?? 0;
    if (naturalW === 0) return null;
    const fitW = img.clientWidth || img.getBoundingClientRect().width;
    const fitH = element.clientHeight || element.getBoundingClientRect().height;
    if (fitW <= 0 || fitH <= 0) return null;
    return { fitW, fitH, naturalW };
  };

  const init = () => {
    const box = (options.measure ?? measureImage)();
    if (box === null || box.fitW <= 0 || box.fitH <= 0) return;
    bounds = computeBounds(
      stage.clientWidth,
      stage.clientHeight,
      box.fitW,
      box.fitH,
      box.naturalW,
    );
    state = restOf(bounds);
    render();
    updateCursor();
    options.onPercent?.(zoomPercent(state, bounds));
  };

  // ── Handlers ────────────────────────────────────────────────────────────────
  const onWheel = (e: WheelEvent) => {
    if (bounds === null) return;
    // "modifier": a bare wheel must scroll the note, so we neither zoom nor
    // preventDefault. A macOS trackpad pinch arrives as a ctrl+wheel event, so
    // one branch covers both the modifier and the pinch.
    if (wheelMode === "modifier" && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const p = stagePoint(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_RATE);
    commit(zoomAbout(state, state.k * factor, p.x, p.y, bounds));
  };

  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const onPointerDown = (e: PointerEvent) => {
    if (bounds === null || !panTarget.contains(e.target as Node)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Capture so a drag that leaves the element keeps panning. Guarded: a
    // synthetic pointer (tests) or an already-released id can throw here, and a
    // failed capture only costs off-element moves, never the gesture itself.
    try {
      panTarget.setPointerCapture(e.pointerId);
    } catch {
      /* non-fatal */
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: dist(a, b), k: state.k };
      panning = false;
    } else if (pointers.size === 1 && !atRest(state, bounds)) {
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
    if (panTarget.hasPointerCapture?.(e.pointerId)) {
      panTarget.releasePointerCapture(e.pointerId);
    }
    updateCursor();
  };

  const onDblClick = (e: MouseEvent) => {
    if (bounds === null || options.doubleClick !== true) return;
    e.preventDefault();
    const p = stagePoint(e.clientX, e.clientY);
    commit(toggleFitHundred(state, p.x, p.y, bounds));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (bounds === null) return;
    // stopPropagation for the keys the viewer owns: inside the editor the stage
    // is a descendant of CodeMirror's content DOM, whose own keymap would
    // otherwise see the same event (the lightbox sits outside CM and is
    // unaffected either way).
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      e.stopPropagation();
      commit(stepZoom(state, +1, bounds));
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      e.stopPropagation();
      commit(stepZoom(state, -1, bounds));
    } else if (e.key === "0") {
      e.preventDefault();
      e.stopPropagation();
      commit(restOf(bounds));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      commit(panBy(state, 0, PAN_STEP, bounds));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      commit(panBy(state, 0, -PAN_STEP, bounds));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      commit(panBy(state, PAN_STEP, 0, bounds));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      commit(panBy(state, -PAN_STEP, 0, bounds));
    }
  };

  /**
   * Recompute the bounds against the current stage + content, keeping the
   * user's zoom percentage where the new geometry allows it. Used on a window
   * resize and by the caller after the content re-lays-out.
   */
  const remeasure = () => {
    if (bounds === null) {
      init();
      return;
    }
    const pct = zoomPercent(state, bounds);
    element.style.transform = "";
    init();
    const b = bounds;
    if (b !== null && pct !== zoomPercent(state, b)) {
      const targetK = clampK((pct / 100) * b.hundredPercentK, b);
      commit(zoomAbout(restOf(b), targetK, b.stageW / 2, b.stageH / 2, b));
    }
  };

  // ── Wiring ──────────────────────────────────────────────────────────────────
  if (options.ready === true || options.measure !== undefined) init();
  else {
    const img = element as unknown as HTMLImageElement;
    if (img.complete && img.naturalWidth > 0) init();
    else img.addEventListener("load", init, { once: true });
  }

  stage.addEventListener("wheel", onWheel, { passive: false });
  panTarget.addEventListener("pointerdown", onPointerDown);
  panTarget.addEventListener("pointermove", onPointerMove);
  panTarget.addEventListener("pointerup", endPointer);
  panTarget.addEventListener("pointercancel", endPointer);
  panTarget.addEventListener("dblclick", onDblClick);
  if (keyboard) stage.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", remeasure);

  return {
    destroy() {
      if (raf !== 0) cancelAnimationFrame(raf);
      stage.removeEventListener("wheel", onWheel);
      panTarget.removeEventListener("pointerdown", onPointerDown);
      panTarget.removeEventListener("pointermove", onPointerMove);
      panTarget.removeEventListener("pointerup", endPointer);
      panTarget.removeEventListener("pointercancel", endPointer);
      panTarget.removeEventListener("dblclick", onDblClick);
      if (keyboard) stage.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", remeasure);
    },
    zoomIn() {
      if (bounds !== null) commit(stepZoom(state, +1, bounds));
    },
    zoomOut() {
      if (bounds !== null) commit(stepZoom(state, -1, bounds));
    },
    reset() {
      if (bounds !== null) commit(restOf(bounds));
    },
    setPercent(pct) {
      if (bounds === null) return;
      const b = bounds;
      const targetK = clampK((pct / 100) * b.hundredPercentK, b);
      commit(zoomAbout(restOf(b), targetK, b.stageW / 2, b.stageH / 2, b));
    },
    pan(dx, dy) {
      if (bounds !== null) commit(panBy(state, dx, dy, bounds));
    },
    remeasure,
  };
}
