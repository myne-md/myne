// `<Skeleton>` — the loading placeholder (myne-md/myne#778, epic #772 lane 7d).
//
// The convention this exists to make available, stated in `components.css` and
// repeated here because the decision is about WHAT IS KNOWN rather than taste:
//
//   under ~200ms      nothing at all. A spinner that flashes for three frames
//                     reads as a glitch, and makes the app feel slower than the
//                     pause it replaced.
//   known layout      a skeleton. Draw the shape of the answer, so content
//                     arrives INTO its outline instead of pushing the page
//                     around when it lands.
//   unknown/blocking  `<Spinner>` or a progress bar.
//
// Before this there was no third option, so every wait was a spinner or a word
// ("Decrypting…"), and a list of twelve rows arrived by shoving whatever was
// under it down the page.

import type { CSSProperties } from "react";

interface SkeletonProps {
  /**
   * How many text lines to draw. Omit for a single block sized by `style` — an
   * avatar, a thumbnail, a button-shaped gap.
   */
  lines?: number;
  /** Size and placement. The skeleton should match the real content's box. */
  style?: CSSProperties;
  testId?: string;
}

export function Skeleton({ lines, style, testId }: SkeletonProps) {
  return (
    <div
      className="myne-skeleton"
      data-lines={lines === undefined ? undefined : String(lines)}
      // State-carrying, so reduced motion SLOWS the shimmer rather than
      // freezing it (MYND-630). A frozen grey box is not a calmer loading
      // indicator, it is an unreadable one.
      data-motion="essential"
      // Decoration standing in for content that is not here yet. Announcing it
      // would read a row of empty boxes to a screen reader; the surface that
      // owns the wait is responsible for saying so in a live region.
      aria-hidden="true"
      style={style}
      data-testid={testId}
    >
      {lines !== undefined &&
        Array.from({ length: lines }, (_, i) => (
          <div key={i} className="myne-skeleton__line" />
        ))}
    </div>
  );
}
