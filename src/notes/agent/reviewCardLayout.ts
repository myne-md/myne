// The review card's width decision (myne-md/myne#894).
//
// The review used to be a full-screen dialog, so a two-column split diff always
// had a wide card to live in. It is now a card inside the conversation
// (`AgentReview` rendered by an assistant turn), and the conversation is rendered
// in two places with very different widths: the agent tab in the centre pane, and
// the AI chat in the right sidebar. At sidebar width a split diff gives each
// column roughly a third of what a line of note text needs, so the mode has to
// follow the box rather than be decided once.
//
// The split follows `settingsCompact.ts`'s shape deliberately, a pure
// width→decision function plus a thin `ResizeObserver` over it, because that
// file's header records the cost of the alternative: the decision was
// unit-tested while its wiring was not, and the observer was never attached, so
// the feature never fired at any width (myne-md/myne#556). Keeping the threshold
// in a pure function is what makes the WIRING testable, not a substitute for
// testing it.

import { useCallback, useRef, useState } from "react";

/**
 * Card width (px) at or above which a diff renders in two columns.
 *
 * The split diff's own header (`DiffView`) records why two columns beat a gutter
 * marker for "what is this replacing?", the reader needs the pair side by side.
 * What that needs is width: two columns of note text plus the row's padding stop
 * being readable somewhere under ~500px, and the sidebar's chat column is around
 * 380. 560 leaves the two columns ~250px each, which holds a sentence.
 */
export const REVIEW_CARD_SPLIT_MIN_WIDTH = 560;

/**
 * Pure decision: is the card too narrow for a two-column diff?
 *
 * A non-finite / non-positive width means "not measured yet", and the answer is
 * NOT narrow, matching `isSettingsCompact`'s pre-measure behaviour: the normal
 * layout shows until the first real measure, so a card that is never measured
 * (jsdom, a hidden pane) renders the shape the app ships rather than a
 * degraded one nobody asked for.
 */
export function isReviewCardNarrow(cardWidth: number): boolean {
  if (!Number.isFinite(cardWidth) || cardWidth <= 0) return false;
  return cardWidth < REVIEW_CARD_SPLIT_MIN_WIDTH;
}

/**
 * Observe a card's own width and answer {@link isReviewCardNarrow} for it.
 *
 * Feature-detected rather than assumed, for the reason `useScrollEdges` gives: an
 * unguarded `new ResizeObserver(...)` throws in any host that ships without one,
 * and losing the whole editor screen to a diff mode is not a trade worth making.
 * A callback ref on the React 19 contract, so there is one teardown path.
 */
export function useReviewCardNarrow<T extends HTMLElement>(): {
  ref: (node: T | null) => void;
  narrow: boolean;
} {
  const [narrow, setNarrow] = useState(false);
  const nodeRef = useRef<T | null>(null);

  const measure = useCallback(() => {
    const el = nodeRef.current;
    if (el === null) return;
    const next = isReviewCardNarrow(el.getBoundingClientRect().width);
    setNarrow((prev) => (prev === next ? prev : next));
  }, []);

  const ref = useCallback(
    (node: T | null) => {
      nodeRef.current = node;
      if (node === null) return;
      const ro =
        typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
      ro?.observe(node);
      if (ro === null && typeof window !== "undefined") {
        window.addEventListener("resize", measure);
      }
      measure();
      return () => {
        ro?.disconnect();
        if (ro === null && typeof window !== "undefined") {
          window.removeEventListener("resize", measure);
        }
        nodeRef.current = null;
      };
    },
    [measure],
  );

  return { ref, narrow };
}
