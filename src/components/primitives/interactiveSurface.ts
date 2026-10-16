// The hover and press halves as one spread, for the common case: an interactive
// surface that already deepens on hover and should also deepen on press
// (motion-system task 3, myne-md/myne#732).
//
// This module exists because a bare sibling pair is wrong, and the reason is
// worth stating so nobody "simplifies" it back:
//
//   {...hoverSurface({ disabled })}
//   {...pressSurface({ disabled })}          // WRONG
//
// `hoverSurface` defaults its hover fill to `--bg-3`, and `pressSurface` defaults
// its release fill to its resting fill. Taken separately, a press on a surface
// that left both defaults in place releases to `transparent` while the pointer is
// still over the element, and `pointerup` does not re-fire `mouseenter`, so the
// surface stays blank until the pointer leaves and comes back. Half of the call
// sites in this tree omit one or both fills, so restating them at every site would
// both miss and duplicate: the exact "one value in two places" failure this
// feature exists to remove.
//
// So the two defaults are reconciled here, ONCE. `hoverSurface` itself is
// untouched: it stays the hover primitive with its own behaviour and docs.
//
// Nothing in here decides what a press looks like. `pressSurface` owns that, and
// `NEUTRAL_PRESS_BG` / `ACCENT_PRESS_BG` are still the single source of the value.

import type { MouseEvent, PointerEvent } from "react";

import { hoverSurface } from "./hoverSurface";
import { pressSurface } from "./pressSurface";

/**
 * `hoverSurface`'s own hover default, restated here for exactly one reason: a
 * release has to land on the fill the surface is currently showing, and this
 * module cannot ask `hoverSurface` what it would have applied. It is pinned by a
 * test that drives both primitives with no fills and asserts they agree, so the
 * two cannot drift apart in silence.
 */
const DEFAULT_HOVER_BG = "var(--bg-3)";

interface InteractiveSurfaceOpts {
  /** Background at rest. Default `transparent`, matching `hoverSurface`. */
  restBg?: string;
  /** Background on pointer-over. Default `var(--bg-3)`, matching `hoverSurface`. */
  hoverBg?: string;
  /** Disabled control: no hover and no press, so nothing is attached. */
  disabled?: boolean;
  /** Accent surface, so the press uses the accent treatment. */
  accent?: boolean;
  /** Explicit press background, overriding the accent/neutral default. */
  pressBg?: string;
}

/**
 * The handler bag an interactive surface spreads. Exported so a caller that has
 * to chain its own effect on top (a colour change, a border change) can annotate
 * the object it returns without restating six signatures.
 */
export type InteractiveSurfaceHandlers = {
  onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel?: (e: PointerEvent<HTMLElement>) => void;
};

/**
 * Spreadable hover AND press handlers for one inline-styled interactive
 * surface. Replaces a `hoverSurface(...)` spread at any site that should also
 * confirm a press:
 *
 *   <button style={{ background: "transparent" }} {...interactiveSurface()}>…</button>
 *
 * The element keeps ownership of its resting `style.background`; these handlers
 * only mutate it transiently, so a custom theme still paints it from tokens.
 */
export function interactiveSurface(
  opts: InteractiveSurfaceOpts = {},
): InteractiveSurfaceHandlers {
  return {
    ...hoverSurface({
      restBg: opts.restBg,
      hoverBg: opts.hoverBg,
      disabled: opts.disabled,
    }),
    // The release lands on the fill the surface is showing, which on a pointer
    // device is the hover fill. On touch no hover ran, so the fill is the
    // caller's resting one; a release there is immediately followed by
    // `pointerleave`, which restores `restBg`, so the hover value is not stuck.
    ...pressSurface({
      restBg: opts.restBg,
      releaseBg: opts.hoverBg ?? DEFAULT_HOVER_BG,
      accent: opts.accent,
      pressBg: opts.pressBg,
      disabled: opts.disabled,
    }),
  };
}
