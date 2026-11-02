// @vitest-environment jsdom
//
// The edge-swipe back gesture (myne-md/myne#970 item 24), tested as a hook rather
// than through a screen.
//
// What is worth pinning is the discrimination, not the plumbing: the gesture has
// to fire on a drag that starts at the bezel and travel right, and it must NOT
// fire on the three things that look similar from the outside — a drag that
// starts mid-pane (a list row's own swipe), a diagonal that is really a scroll,
// and a second drag after the first has already navigated. A hook that fires on
// any of those closes the screen under a user's finger, which is the failure mode
// worse than having no gesture at all.
//
// jsdom has no layout, so the values here are the ones the hook compares directly
// (clientX/clientY), not measured geometry. That is the whole reason the hook
// takes a touch rather than a rect.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMIT_DISTANCE_PX, EDGE_ZONE_PX, useEdgeSwipeBack } from "../../src/lib/edgeSwipeBack";

function Harness({ onBack }: { onBack: (() => void) | null }) {
  const handlers = useEdgeSwipeBack(onBack);
  return <div data-testid="pane" {...handlers} />;
}

/** One gesture: start at `fromX`, move to `toX` with an optional vertical drift. */
function swipe(
  el: HTMLElement,
  fromX: number,
  toX: number,
  drift = 0,
): void {
  fireEvent.touchStart(el, { touches: [{ clientX: fromX, clientY: 100 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: toX, clientY: 100 + drift }] });
  fireEvent.touchEnd(el, { touches: [] });
}

// This file's tree is a bare div rather than a screen, so nothing else unmounts
// it: without this the second `render` finds two panes and the query throws.
afterEach(() => cleanup());

describe("useEdgeSwipeBack (myne-md/myne#970 item 24)", () => {
  it("goes back on a drag from the edge that clears the commit distance", () => {
    const onBack = vi.fn();
    const { getByTestId } = render(<Harness onBack={onBack} />);
    swipe(getByTestId("pane"), 4, EDGE_ZONE_PX + COMMIT_DISTANCE_PX);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("ignores a drag that starts in the middle of the pane", () => {
    // A note row's own swipe starts well inside the content, and closing the
    // screen on it would make the list's gesture unusable.
    const onBack = vi.fn();
    const { getByTestId } = render(<Harness onBack={onBack} />);
    swipe(getByTestId("pane"), EDGE_ZONE_PX + 60, EDGE_ZONE_PX + 300);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("ignores a short drag, which is a tap with a shaky finger", () => {
    const onBack = vi.fn();
    const { getByTestId } = render(<Harness onBack={onBack} />);
    swipe(getByTestId("pane"), 4, 4 + COMMIT_DISTANCE_PX - 1);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("ignores a diagonal that is a scroll starting near the edge", () => {
    const onBack = vi.fn();
    const { getByTestId } = render(<Harness onBack={onBack} />);
    // Horizontal travel that would commit, but the finger went down the screen
    // further than it went across: this is a scroll, and it stays one.
    swipe(getByTestId("pane"), 4, 4 + COMMIT_DISTANCE_PX + 20, 200);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("fires once per gesture, however many moves it takes", () => {
    const onBack = vi.fn();
    const { getByTestId } = render(<Harness onBack={onBack} />);
    const el = getByTestId("pane");
    fireEvent.touchStart(el, { touches: [{ clientX: 2, clientY: 100 }] });
    fireEvent.touchMove(el, { touches: [{ clientX: 2 + COMMIT_DISTANCE_PX, clientY: 100 }] });
    fireEvent.touchMove(el, { touches: [{ clientX: 2 + COMMIT_DISTANCE_PX + 40, clientY: 100 }] });
    fireEvent.touchEnd(el, { touches: [] });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all where there is nowhere to go back to", () => {
    // Notes is the root of the list; a swipe there must not be a no-op that
    // still swallows the gesture.
    const { getByTestId } = render(<Harness onBack={null} />);
    const el = getByTestId("pane");
    expect(() => swipe(el, 4, EDGE_ZONE_PX + COMMIT_DISTANCE_PX)).not.toThrow();
  });
});
