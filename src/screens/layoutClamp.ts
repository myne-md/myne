// Pure width-clamp logic for the editor's resizable sidebars (MYND-137).
//
// Kept free of React so it is trivially unit-testable; mirrors the
// "pure transitions exported for tests" discipline of `sidebarState.tsx`
// + `stage.ts`. Because no JS test runner is wired yet (see CLAUDE.md),
// the invariants are guarded by a DEV-only self-verify harness that runs
// once per module load (same shape as `stage.ts::verifyTransitionTable`).
// When a runner lands, `verifyClampInvariants` converts directly to a
// test suite.
//
// Two layers of clamp:
//   1. `clampSidebarWidth` — per-side [min, max] with garbage fallback.
//      Applied on every persisted/loaded read so a tampered or absent
//      `vault.prefs` width can never drive the UI out of range.
//   2. `clampSidebarWidthForLayout` — additionally caps the width so the
//      center pane keeps `CENTER_MIN_WIDTH` given the live container
//      width and the other sidebar's rendered width. Applied live during
//      a drag so one sidebar can't swallow the editor.

/** Per-side width bounds (px). Proposed in the MYND-137 Penpot pass and
 *  confirmed here against the editor's minimum content width. */
export interface WidthBounds {
  readonly min: number;
  readonly max: number;
}

export const LEFT_BOUNDS: WidthBounds = { min: 200, max: 420 };
export const RIGHT_BOUNDS: WidthBounds = { min: 240, max: 460 };

/** Guaranteed minimum width of the center editor pane (px). A drag can
 *  never push a sidebar wide enough to take the center below this. */
export const CENTER_MIN_WIDTH = 360;

/** Default widths when the user has never customized the layout — these
 *  match the pre-MYND-137 fixed widths (`NoteList` 260 / `RightSidebar`
 *  280) so an uncustomized vault looks identical to before. */
export const DEFAULT_LEFT_WIDTH = 260;
export const DEFAULT_RIGHT_WIDTH = 280;

/** Width (px) of a resize-handle hit zone — used as the inter-pane
 *  allowance when budgeting the center-pane minimum. */
export const RESIZE_HANDLE_HIT_ZONE = 8;

/**
 * Clamp a raw width to `[bounds.min, bounds.max]`, falling back to
 * `fallback` for any non-finite / non-positive garbage input (NaN,
 * Infinity, negative, a tampered persisted value). The result is a
 * rounded integer — widths are integer pixels (matching the `u32`
 * persisted form).
 */
export function clampSidebarWidth(
  raw: number,
  bounds: WidthBounds,
  fallback: number,
): number {
  const base = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  const clamped = Math.min(bounds.max, Math.max(bounds.min, base));
  return Math.round(clamped);
}

/**
 * Like {@link clampSidebarWidth} but additionally lowers the effective
 * maximum so the center pane retains at least {@link CENTER_MIN_WIDTH}
 * given the live `containerWidth` and the `otherSidebarWidth` (the other
 * sidebar's rendered width — 0 when it is collapsed). When the container
 * width is unknown / non-finite (e.g. first paint before measurement),
 * the center constraint is skipped and this degrades to
 * {@link clampSidebarWidth}.
 */
export function clampSidebarWidthForLayout(
  raw: number,
  bounds: WidthBounds,
  fallback: number,
  containerWidth: number,
  otherSidebarWidth: number,
): number {
  const perSide = clampSidebarWidth(raw, bounds, fallback);
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return perSide;
  }
  // The most this sidebar may be so the center keeps its minimum:
  //   container - thisWidth - otherWidth - 2 handle zones >= CENTER_MIN
  const budgetMax =
    containerWidth -
    otherSidebarWidth -
    RESIZE_HANDLE_HIT_ZONE * 2 -
    CENTER_MIN_WIDTH;
  // Never below the per-side minimum even on an extremely small window
  // (the OS window has its own min size; the sidebar keeps its floor and
  // the center gives up its minimum only in that degenerate case).
  const effectiveMax = Math.max(bounds.min, Math.min(bounds.max, budgetMax));
  return Math.round(Math.min(perSide, effectiveMax));
}

// ---- DEV-only self-verify harness ------------------------------------
//
// Runs once per module load in dev (gated by `import.meta.env.DEV`), the
// same pattern `stage.ts` uses for its transition table. Asserts the four
// clamp invariants the MYND-137 acceptance criteria call out: min, max,
// center-minimum, and garbage fallback. A failure throws loudly in dev so
// a regression is caught at load time; in production the harness is
// tree-shaken away.

/** Exported so a future test runner can call it directly. Throws on the
 *  first violated invariant. */
export function verifyClampInvariants(): void {
  const fail = (msg: string): never => {
    throw new Error(`[layoutClamp] invariant violated: ${msg}`);
  };

  // min: a too-small raw value clamps up to the floor.
  if (clampSidebarWidth(10, LEFT_BOUNDS, DEFAULT_LEFT_WIDTH) !== LEFT_BOUNDS.min) {
    fail("below-min must clamp to min");
  }
  // max: a too-large raw value clamps down to the ceiling.
  if (clampSidebarWidth(9999, RIGHT_BOUNDS, DEFAULT_RIGHT_WIDTH) !== RIGHT_BOUNDS.max) {
    fail("above-max must clamp to max");
  }
  // in-range passes through (rounded).
  if (clampSidebarWidth(300.4, LEFT_BOUNDS, DEFAULT_LEFT_WIDTH) !== 300) {
    fail("in-range must pass through rounded");
  }
  // garbage fallback: NaN / Infinity / negative → fallback (then clamped).
  for (const bad of [NaN, Infinity, -Infinity, -50, 0]) {
    const got = clampSidebarWidth(bad, LEFT_BOUNDS, DEFAULT_LEFT_WIDTH);
    if (got !== DEFAULT_LEFT_WIDTH) {
      fail(`garbage input ${bad} must fall back to default (${DEFAULT_LEFT_WIDTH}), got ${got}`);
    }
  }
  // center-minimum: on a narrow container, the effective max is lowered so
  // the center keeps its floor. container=900, other=280 (right open),
  // handles=16, centerMin=360 → budget for left = 900-280-16-360 = 244.
  const narrowLeft = clampSidebarWidthForLayout(
    420, // raw asks for the per-side max
    LEFT_BOUNDS,
    DEFAULT_LEFT_WIDTH,
    900,
    DEFAULT_RIGHT_WIDTH,
  );
  if (narrowLeft !== 244) {
    fail(`center-minimum must cap left to 244 on a 900px container, got ${narrowLeft}`);
  }
  // ...but on a wide container the per-side max still governs.
  const wideLeft = clampSidebarWidthForLayout(
    9999,
    LEFT_BOUNDS,
    DEFAULT_LEFT_WIDTH,
    1600,
    DEFAULT_RIGHT_WIDTH,
  );
  if (wideLeft !== LEFT_BOUNDS.max) {
    fail(`per-side max must govern on a wide container, got ${wideLeft}`);
  }
  // unknown container width degrades to the per-side clamp.
  if (
    clampSidebarWidthForLayout(300, LEFT_BOUNDS, DEFAULT_LEFT_WIDTH, NaN, 0) !== 300
  ) {
    fail("unknown container width must degrade to per-side clamp");
  }
}

if (import.meta.env.DEV) {
  verifyClampInvariants();
}
