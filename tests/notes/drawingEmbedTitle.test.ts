// Auto-naming for inline drawings (#213 / MYND-634). The inline `![[Drawing N]]`
// embed resolves BY TITLE, so `nextDrawingTitle` must never hand back a title an
// existing drawing already uses.

import { describe, it, expect } from "vitest";
import { nextDrawingTitle, type DrawingTitleRecord } from "../../src/notes/drawingEmbedTitle";

describe("nextDrawingTitle (#213)", () => {
  it("starts at Drawing 1 when there are no drawings", () => {
    expect(nextDrawingTitle([])).toBe("Drawing 1");
  });

  it("ignores non-drawing notes (only kind:drawing count)", () => {
    const cache: DrawingTitleRecord[] = [
      { title: "Drawing 5", kind: "note" }, // a prose note that happens to be named so
      { title: "Meeting", kind: "note" },
    ];
    expect(nextDrawingTitle(cache)).toBe("Drawing 1");
  });

  it("returns one past the highest existing Drawing N", () => {
    const cache: DrawingTitleRecord[] = [
      { title: "Drawing 1", kind: "drawing" },
      { title: "Drawing 3", kind: "drawing" },
      { title: "Sketch", kind: "drawing" }, // non-numbered drawing — not counted
    ];
    expect(nextDrawingTitle(cache)).toBe("Drawing 4");
  });

  it("skips gaps rather than reusing them (max+1, never a hole)", () => {
    const cache: DrawingTitleRecord[] = [
      { title: "Drawing 2", kind: "drawing" },
      { title: "Drawing 7", kind: "drawing" },
    ];
    // Reusing the gap (Drawing 1/3…) risks colliding with a title still resolving
    // in a not-yet-refreshed embed; max+1 is always free.
    expect(nextDrawingTitle(cache)).toBe("Drawing 8");
  });

  it("tolerates a null-title drawing", () => {
    const cache: DrawingTitleRecord[] = [
      { title: null, kind: "drawing" },
      { title: "Drawing 2", kind: "drawing" },
    ];
    expect(nextDrawingTitle(cache)).toBe("Drawing 3");
  });
});
