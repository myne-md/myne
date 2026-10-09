// @vitest-environment node
//
// The foundations-coverage guard (myne-md/myne#845, injected-defect spec added in
// the myne-md/myne#847 review).
//
// The guard's rule is that it is proven by breaking it, not by running it, and
// this file is the half that was missing. It is why the executable half of the
// guard is now behind an `invokedDirectly` gate: without it, importing the file
// ran the checks and called `process.exit`, so no spec could reach `classify`.

import { describe, expect, it } from "vitest";
import { classify, declaredTokens } from "../../scripts/check-foundations-coverage.mjs";

describe("the foundations-coverage guard", () => {
  it("classifies a token a group claims", () => {
    expect(classify("--space-3", "12px")).toBe("spacing");
    expect(classify("--text-sm", "13px")).toBe("type");
    expect(classify("--duration-fast", "120ms")).toBe("motion");
    expect(classify("--z-modal", "40")).toBe("zIndex");
  });

  it("classifies a colour by its VALUE rather than its name", () => {
    // The seventh group is value-shaped: any token whose value reads as a colour
    // is one, which is why the colour half cannot be a name pattern.
    expect(classify("--accent", "#2c4a7a")).toBe("colours");
    expect(classify("--accent", "color-mix(in oklab, #000 20%, #fff)")).toBe("colours");
  });

  it("returns null for a token no group claims, which is the defect it catches", () => {
    // The injection: a new family lands in the sheet and nowhere in the
    // catalogue, and nothing else notices.
    expect(classify("--zzz-new-family", "1")).toBeNull();
  });

  it("reads every declaration, the first value winning", () => {
    const tokens = declaredTokens(":root { --a: 1; --a: 2; --b: 3; }");
    expect(tokens.get("--a")).toBe("1");
    expect(tokens.size).toBe(2);
  });
});
