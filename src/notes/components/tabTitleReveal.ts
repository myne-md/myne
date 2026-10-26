// The truncated tab title's reveal (myne-md/myne#908 item 6).
//
// A tab title is a single-line ellipsis box, and the only way to read the rest
// of it was the native `title` tooltip, which is delayed, unstyleable, and
// unavailable on the tab's own pointer path. The replacement is an IN-PLACE
// marquee: no tooltip anywhere, the text itself moves.
//
// Two pieces are pure and therefore testable without layout:
//
//   - `marqueeShift` answers "how far, and should it move at all". A label that
//     fits must not move; a label that overflows by a pixel must not jitter
//     either, so the threshold is deliberate rather than `> 0`.
//   - `prefersReducedMotion` is the one switch that turns the motion off. Under
//     it the reveal still happens, as an INSTANT jump to the end of the text:
//     the title is still readable, which is the requirement, and nothing
//     animates, which is the accessibility requirement. That is why the reduced
//     path is not a tooltip: the user asked for the reveal in place, and a
//     tooltip is a different affordance.

/** How far a label must travel to be fully read. `0` means "it fits, do not
 *  move". The 1px tolerance absorbs sub-pixel measurement noise, which would
 *  otherwise animate a title that is visually complete. */
export function marqueeShift(clientWidth: number, scrollWidth: number): number {
  if (!Number.isFinite(clientWidth) || !Number.isFinite(scrollWidth)) return 0;
  if (clientWidth <= 0) return 0;
  const delta = Math.ceil(scrollWidth - clientWidth);
  return delta > 1 ? delta : 0;
}

/** True when the platform asks for no motion. Absent `matchMedia` (jsdom, a
 *  test harness) is treated as "no preference", which is the honest default:
 *  the app does not get to assume a disability. */
export function prefersReducedMotion(
  media:
    | { matches: boolean }
    | undefined = typeof window === "undefined"
    ? undefined
    : window.matchMedia?.("(prefers-reduced-motion: reduce)"),
): boolean {
  return media?.matches === true;
}

/** Travel speed for the in-place reveal, in CSS px per millisecond. 18 px/s:
 *  slow enough to read a word as it goes past, and slow enough that a 200px
 *  overflow takes about eleven seconds rather than the two the first version
 *  took. Constant, deliberately: the same speed on every tab is what makes the
 *  motion read as a mechanism rather than an animation. */
export const MARQUEE_PX_PER_MS = 0.018;

/** How long the text rests at each end before turning round. */
export const MARQUEE_HOLD_MS = 700;
