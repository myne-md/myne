// Hand-rolled positioning helper for editor floating UI surfaces (slash
// menu + selection toolbar + URL overlay).
//
// PRD `editor-mvp-baseline` Implementation Decisions § positioning. Per
// grill 2026-05-16 Q4: hand-rolled, zero new dep. VirtualList paradigm
// (`decisions.md` 2026-05-15 "Sidebar virtualization") carries the
// precedent — "start hand-rolled, swap to library only if dogfood reveals
// edge cases."
//
// Coverage:
//   - viewport-edge clamp (left / right): pull surface inward if it would
//     overflow the window.
//   - flip-above-when-no-room-below: if the surface won't fit below the
//     anchor + has room above, flip placement.
//
// Three callsites: `src/editor/slash/plugin.ts`, `src/editor/toolbar/
// plugin.ts`, `src/editor/toolbar/url-overlay.tsx`.

export type Rect = { left: number; top: number; right: number; bottom: number };

export type PositionResult = {
  /** Final left coordinate (viewport-clamped). */
  left: number;
  /** Final top coordinate (above or below anchor, viewport-clamped). */
  top: number;
  /** `true` when the surface was flipped above the anchor. */
  flipped: boolean;
};

const VIEWPORT_PADDING = 8;

/**
 * Compute the surface's `(left, top)` given an anchor rectangle and the
 * surface's intrinsic width + height. Prefers placing the surface BELOW the
 * anchor (slash menu anchored to cursor) or ABOVE (selection toolbar);
 * caller picks via `preferredPlacement`.
 */
export function computePosition(args: {
  anchor: Rect;
  surfaceWidth: number;
  surfaceHeight: number;
  preferredPlacement: "below" | "above";
  /** Vertical gap between anchor edge and surface edge. */
  gap?: number;
  /** Viewport size; defaults to `window.innerWidth/Height` when omitted. */
  viewport?: { width: number; height: number };
}): PositionResult {
  const {
    anchor,
    surfaceWidth,
    surfaceHeight,
    preferredPlacement,
    gap = 4,
  } = args;
  const viewport = args.viewport ?? {
    width: typeof window !== "undefined" ? window.innerWidth : 1280,
    height: typeof window !== "undefined" ? window.innerHeight : 800,
  };

  // Horizontal: align surface's left to anchor's left, then clamp.
  let left = anchor.left;
  if (left + surfaceWidth + VIEWPORT_PADDING > viewport.width) {
    left = viewport.width - surfaceWidth - VIEWPORT_PADDING;
  }
  if (left < VIEWPORT_PADDING) {
    left = VIEWPORT_PADDING;
  }

  // Vertical: try preferred placement first; flip if it doesn't fit AND the
  // opposite side has more room.
  const roomBelow = viewport.height - anchor.bottom - gap - VIEWPORT_PADDING;
  const roomAbove = anchor.top - gap - VIEWPORT_PADDING;
  let top: number;
  let flipped: boolean;
  if (preferredPlacement === "below") {
    if (surfaceHeight <= roomBelow || roomBelow >= roomAbove) {
      top = anchor.bottom + gap;
      flipped = false;
    } else {
      top = anchor.top - gap - surfaceHeight;
      flipped = true;
    }
  } else {
    if (surfaceHeight <= roomAbove || roomAbove >= roomBelow) {
      top = anchor.top - gap - surfaceHeight;
      flipped = false;
    } else {
      top = anchor.bottom + gap;
      flipped = true;
    }
  }

  // Vertical clamp (final safety net for tiny viewports).
  if (top + surfaceHeight + VIEWPORT_PADDING > viewport.height) {
    top = viewport.height - surfaceHeight - VIEWPORT_PADDING;
  }
  if (top < VIEWPORT_PADDING) {
    top = VIEWPORT_PADDING;
  }

  return { left, top, flipped };
}
