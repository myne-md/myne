// The graph's pointer-sequence policy (myne-md/myne#727), as a pure module.
//
// The renderer's pointer handling is canvas plumbing and cannot be exercised
// without a canvas, which is exactly why the DECISION inside it used to be
// untested: "a press on a node that never moves is a click, a press that moves
// is a placement" lived in a branch inside `onPointerUp`. Keeping the decision
// here means the rule is asserted directly instead of by driving a synthetic
// pointer into a canvas from an end-to-end scenario and reading the outcome.
//
// It is deliberately small. It answers two questions and nothing else: has this
// movement become a drag, and what does lifting the pointer mean.

/** Screen pixels of movement below which a press is still a click. This is the
 *  same budget the renderer always used for "did this pan move", so the click
 *  target does not change with this change. */
export const DRAG_THRESHOLD_PX = 2;

/** Whether movement of `dx, dy` screen pixels has become a drag. */
export function crossedDragThreshold(dx: number, dy: number): boolean {
  return Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX;
}

/**
 * What lifting the pointer means, given what the press hit and whether the
 * pointer moved in between.
 *
 * `node-place` is the one that carries the feature: a node dragged to a new
 * position is HELD only while the pointer is down, and released on pointer up,
 * so the link force pulls it back through its connections. There is no pin
 * concept, and nothing about the placement is deliberately persisted; what
 * survives is whatever the settled layout is.
 */
export type ReleaseIntent =
  | { kind: "background-tap" }
  | { kind: "pan" }
  | { kind: "node-click"; id: string }
  | { kind: "node-place"; id: string };

export function classifyRelease(
  pressedNodeId: string | null,
  moved: boolean,
): ReleaseIntent {
  if (pressedNodeId === null) {
    return moved ? { kind: "pan" } : { kind: "background-tap" };
  }
  return moved
    ? { kind: "node-place", id: pressedNodeId }
    : { kind: "node-click", id: pressedNodeId };
}
