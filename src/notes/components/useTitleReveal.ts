// The in-place reveal for a truncated single-line title (myne-md/myne#908
// item 6), shared by the tab strip and the sidebar rows.
//
// Both surfaces show a title in a one-line ellipsis box, and the only way to read
// the rest was a native tooltip. The replacement is the text moving in place.
//
// Two details are the whole reason this is a hook rather than two copies:
//
//   1. **Measure one frame AFTER the reveal**, not during it. Hovering a sidebar
//      row also mounts its action affordances, which NARROW the title and can be
//      what truncates it in the first place; measuring in the same commit would
//      read the pre-hover width and compute no travel for a title that is about
//      to be clipped.
//   2. **Constant speed with a hold at each end.** The first shipped version
//      eased back and forth at a duration proportional to nothing, which read as
//      a bounce and was too fast to read. Travel is `shift / MARQUEE_PX_PER_MS`
//      both ways with the same hold at each end, so every title moves at the same
//      speed and rests for the same beat.
//
// Reduced motion still reveals, as an instant jump to the end: the title has to
// be readable, and nothing has to move.

import { useEffect, useRef, type RefObject } from "react";

import {
  MARQUEE_HOLD_MS,
  MARQUEE_PX_PER_MS,
  marqueeShift,
  prefersReducedMotion,
} from "./tabTitleReveal";

export interface TitleReveal {
  /** The clipping box. Its width is the visible width. */
  readonly boxRef: RefObject<HTMLDivElement | null>;
  /** The element that moves. Its scroll width is the full text. */
  readonly textRef: RefObject<HTMLElement | null>;
}

export function useTitleReveal(revealed: boolean, text: string): TitleReveal {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    const body = textRef.current;
    if (box === null || body === null) return;

    let anim: Animation | null = null;
    let frame = 0;

    const settle = () => {
      const shift = revealed
        ? marqueeShift(box.clientWidth, body.scrollWidth)
        : 0;
      if (shift === 0) {
        body.style.transform = "";
        return;
      }
      if (prefersReducedMotion() || typeof body.animate !== "function") {
        body.style.transform = `translateX(-${shift}px)`;
        return;
      }
      const travelMs = Math.max(1200, shift / MARQUEE_PX_PER_MS);
      const total = travelMs * 2 + MARQUEE_HOLD_MS * 2;
      anim = body.animate(
        [
          { transform: "translateX(0)", offset: 0 },
          { transform: "translateX(0)", offset: MARQUEE_HOLD_MS / total },
          {
            transform: `translateX(-${shift}px)`,
            offset: (MARQUEE_HOLD_MS + travelMs) / total,
          },
          {
            transform: `translateX(-${shift}px)`,
            offset: (MARQUEE_HOLD_MS * 2 + travelMs) / total,
          },
          { transform: "translateX(0)", offset: 1 },
        ],
        {
          duration: total,
          delay: 300,
          iterations: Infinity,
          easing: "linear",
        },
      );
    };

    frame = requestAnimationFrame(settle);

    return () => {
      cancelAnimationFrame(frame);
      anim?.cancel();
      body.style.transform = "";
    };
  }, [revealed, text]);

  return { boxRef, textRef };
}
