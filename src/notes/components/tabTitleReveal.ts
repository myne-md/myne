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

/** Constant speed, in CSS pixels per second, for the travelling half.
 *
 *  45 px/s is roughly six characters a second at the tab's type size: fast
 *  enough to cross a long title in a couple of seconds, slow enough to read
 *  while it moves. The previous version used `ease-in-out` and a duration
 *  proportional to the distance, which made every title start slowly, race in
 *  the middle and land softly: a spring, not a marquee, and the acceleration is
 *  what a reader perceives as "jumpy" rather than as motion. */
const REVEAL_SPEED_PX_PER_S = 45;

/** The hold before the text starts moving. Long, because this is where the text
 *  sits after coming back and where the eye needs to re-acquire the start of the
 *  line. */
const REVEAL_HOLD_START_MS = 1_600;

/** The hold at the far end. Short: it exists so the last characters are read as
 *  an ending rather than as the instant the word reverses. */
const REVEAL_HOLD_END_MS = 600;

/** One cycle of the reveal: hold, travel out, hold, travel back.
 *
 *  **Pure, and the numbers are the point.** The cycle is constant speed with
 *  explicit holds rather than an easing curve: an easing function has no way to
 *  express "wait, move, wait, move back", so the previous three-keyframe version
 *  expressed the movement with `ease-in-out` and the pacing was whatever the
 *  curve happened to do at that distance.
 *
 *  The return trip is animated rather than a jump. A marquee that snaps back
 *  reads as a glitch in a tab strip, where the text is short and the eye is on
 *  it; the hold after the return is what makes the snap unnecessary.
 */
export function marqueeTiming(
  shift: number,
): { frames: { transform: string; offset: number }[]; duration: number } {
  const distance = Math.max(0, shift);
  const travelMs = (distance / REVEAL_SPEED_PX_PER_S) * 1_000;
  const duration = REVEAL_HOLD_START_MS + travelMs + REVEAL_HOLD_END_MS + travelMs;
  const holdStart = REVEAL_HOLD_START_MS / duration;
  const travel = travelMs / duration;
  const holdEnd = REVEAL_HOLD_END_MS / duration;
  const end = `translateX(-${distance}px)`;
  return {
    frames: [
      { transform: "translateX(0)", offset: 0 },
      { transform: "translateX(0)", offset: holdStart },
      { transform: end, offset: holdStart + travel },
      { transform: end, offset: holdStart + travel + holdEnd },
      { transform: "translateX(0)", offset: 1 },
    ],
    duration,
  };
}

/** Where the strip must scroll to centre `tabLeft` in `viewport`.
 *
 *  Pure, because jsdom has no layout: the component's effect can only be proven
 *  to FIRE in a unit test, not to land on the right pixel. Clamped at zero so the
 *  first tab does not scroll into blank space; the browser clamps the other end.
 */
export function centreScrollLeft(
  tabLeft: number,
  tabWidth: number,
  viewport: number,
): number {
  if (!Number.isFinite(tabLeft) || !Number.isFinite(tabWidth) || !Number.isFinite(viewport)) {
    return 0;
  }
  return Math.max(0, tabLeft - (viewport - tabWidth) / 2);
}
