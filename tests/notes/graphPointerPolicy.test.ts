// The graph's pointer-sequence policy (myne-md/myne#727).
//
// The renderer cannot be driven in this suite, so the decision it used to hide
// in a branch is asserted here instead: press-and-release on a node is a click,
// press-move-release is a placement, and the boundary between them is one
// threshold rather than two slightly different ones.

import { describe, expect, it } from "vitest";
import {
  classifyRelease,
  crossedDragThreshold,
  DRAG_THRESHOLD_PX,
} from "@myne/editor/host/notes/graphPointerPolicy";

describe("crossedDragThreshold", () => {
  it("keeps a press that barely moved a click", () => {
    expect(crossedDragThreshold(0, 0)).toBe(false);
    expect(crossedDragThreshold(1, 1)).toBe(false);
    expect(crossedDragThreshold(DRAG_THRESHOLD_PX, 0)).toBe(false);
  });

  it("calls movement past the threshold a drag", () => {
    expect(crossedDragThreshold(DRAG_THRESHOLD_PX + 1, 0)).toBe(true);
    expect(crossedDragThreshold(0, -3)).toBe(true);
    // Deliberately per-axis summed rather than euclidean, matching the renderer
    // it replaced: a diagonal nudge of (2,2) is 4, over a threshold of 2.
    expect(crossedDragThreshold(2, 2)).toBe(true);
  });
});

describe("classifyRelease", () => {
  it("a press on empty space that did not move is a background tap", () => {
    // The double-tap refit hangs off this, which is why it is distinct from a
    // pan: a tap must not be treated as a zero-length pan.
    expect(classifyRelease(null, false)).toEqual({ kind: "background-tap" });
  });

  it("a press on empty space that moved is a pan", () => {
    expect(classifyRelease(null, true)).toEqual({ kind: "pan" });
  });

  it("a press on a node that did not move is a click", () => {
    expect(classifyRelease("note-a", false)).toEqual({ kind: "node-click", id: "note-a" });
  });

  it("a press on a node that moved is a placement, which releases the hold", () => {
    // This is the whole feature in one assertion: a placement is not a click,
    // so the pointer-up path releases the node rather than navigating, and the
    // link force is free to pull it back.
    expect(classifyRelease("note-a", true)).toEqual({ kind: "node-place", id: "note-a" });
  });

  it("an id is always carried through, so the caller never re-hit-tests", () => {
    for (const moved of [false, true]) {
      const intent = classifyRelease("note-b", moved);
      expect("id" in intent && intent.id).toBe("note-b");
    }
  });
});
