// Pure zoom/pan math for the attachment lightbox (MYND-594). No DOM — asserts
// the transform algebra directly: clamping, zoom-toward-a-point, off-stage pan
// constraint (the "image can't be stranded" acceptance criterion), fit↔100%
// toggle, and the displayed percentage.

import { describe, expect, it } from "vitest";
import {
  clampK,
  computeBounds,
  constrainPan,
  fitState,
  isFit,
  panBy,
  stepZoom,
  toggleFitHundred,
  zoomAbout,
  zoomPercent,
  type ZoomBounds,
} from "../../editor/src/attachments/image-zoom";

// A 1000×500 stage; the image fits at 800×400 (k=1) and is 3200px natural wide,
// so 1:1 ("100%") is k=4.
const B: ZoomBounds = computeBounds(1000, 500, 800, 400, 3200);

describe("computeBounds", () => {
  it("derives 100% from natural/fit and caps the max", () => {
    expect(B.hundredPercentK).toBe(4); // 3200 / 800
    expect(B.minK).toBe(1);
    expect(B.maxK).toBe(4); // min(8, max(4, 3))
  });

  it("a small image (natural ≤ fit) still allows a 3× max and 100% == fit", () => {
    const small = computeBounds(1000, 500, 800, 400, 600); // natural < fit
    expect(small.hundredPercentK).toBe(1);
    expect(small.maxK).toBe(3);
  });
});

describe("clampK", () => {
  it("clamps into [minK, maxK]", () => {
    expect(clampK(0.2, B)).toBe(1);
    expect(clampK(99, B)).toBe(4);
    expect(clampK(2, B)).toBe(2);
  });
});

describe("fitState / constrainPan", () => {
  it("fit centres the image and is k=1", () => {
    const f = fitState(B);
    expect(f.k).toBe(1);
    expect(f.tx).toBe(100); // (1000 - 800) / 2
    expect(f.ty).toBe(50); // (500 - 400) / 2
    expect(isFit(f, B)).toBe(true);
  });

  it("a scaled image larger than the stage cannot be panned off-screen", () => {
    // At k=2 the image is 1600×800 — larger than the 1000×500 stage on both axes.
    // A wild pan is clamped so both edges still cover the stage interior.
    const strayed = { k: 2, tx: 5000, ty: 5000 };
    const c = constrainPan(strayed, B);
    // tx clamped to [stageW - scaledW, 0] = [-600, 0]
    expect(c.tx).toBeLessThanOrEqual(0);
    expect(c.tx).toBeGreaterThanOrEqual(1000 - 1600);
    expect(c.ty).toBeLessThanOrEqual(0);
    expect(c.ty).toBeGreaterThanOrEqual(500 - 800);
  });
});

describe("zoomAbout", () => {
  it("keeps the pinned point fixed on the image content", () => {
    const start = fitState(B); // k=1, tx=100, ty=50
    // Zoom to 2× about the stage point (500, 250).
    const z = zoomAbout(start, 2, 500, 250, B);
    expect(z.k).toBe(2);
    // The content point under (500,250) before was (500-100)/1 = 400; after the
    // zoom it must still map to 500: tx2 + 400*2 == 500 → tx2 == -300, then
    // constrained (image 1600 wide > stage) → within [-600, 0], so -300 stands.
    expect(z.tx).toBe(-300);
  });

  it("clamps at the max and is a no-op when already there", () => {
    const maxed = zoomAbout(fitState(B), 99, 500, 250, B);
    expect(maxed.k).toBe(4);
    expect(zoomAbout(maxed, 99, 500, 250, B)).toBe(maxed); // identity when k unchanged
  });
});

describe("toggleFitHundred", () => {
  it("fit → 100%, then 100%-ish → back to fit", () => {
    const f = fitState(B);
    const hundred = toggleFitHundred(f, 500, 250, B);
    expect(hundred.k).toBe(4); // 100%
    expect(zoomPercent(hundred, B)).toBe(100);
    const back = toggleFitHundred(hundred, 500, 250, B);
    expect(back.k).toBe(1);
    expect(isFit(back, B)).toBe(true);
  });

  it("for a small image (fit==100%) toggles to 2× rather than no-op", () => {
    const small = computeBounds(1000, 500, 800, 400, 600);
    const z = toggleFitHundred(fitState(small), 500, 250, small);
    expect(z.k).toBe(2);
  });
});

describe("stepZoom + panBy", () => {
  it("steps in and out about the centre and recovers fit", () => {
    let s = fitState(B);
    s = stepZoom(s, +1, B);
    expect(s.k).toBeCloseTo(1.25, 5);
    s = stepZoom(s, -1, B);
    expect(s.k).toBeCloseTo(1, 5);
    expect(isFit(s, B)).toBe(true);
  });

  it("panBy is a no-op at fit (image ≤ stage stays centred)", () => {
    const f = fitState(B);
    const p = panBy(f, 200, 200, B);
    expect(p.tx).toBe(f.tx); // re-centred by the constraint
    expect(p.ty).toBe(f.ty);
  });
});

describe("zoomPercent", () => {
  it("reports fit and 1:1 relative to 100%", () => {
    expect(zoomPercent(fitState(B), B)).toBe(25); // fit is 800/3200 = 25%
    expect(zoomPercent({ k: 4, tx: 0, ty: 0 }, B)).toBe(100);
  });
});
