// myne-md/myne#908 item 3 — the unfocused pane must be legible as "not this one".
//
// The rule under test is the style decision, not the render: a split workspace
// dims the pane you are NOT in, and a single pane has nothing to contrast with.
// The load-bearing half is that note TEXT is never dimmed, so the scrim is a
// token wash at a low opacity over the whole section rather than an opacity on
// the body. Asserting the token keeps a hardcoded rgba from creeping back in.

import { describe, expect, it } from "vitest";
import { paneScrimStyle } from "../../src/notes/components/sharedStyles";

describe("paneScrimStyle", () => {
  it("returns nothing for the focused pane", () => {
    expect(paneScrimStyle(true, 2)).toBeNull();
  });

  it("returns nothing when there is only one pane", () => {
    expect(paneScrimStyle(false, 1)).toBeNull();
  });

  it("washes an unfocused pane in a split, from a token and below 10%", () => {
    const style = paneScrimStyle(false, 2);
    expect(style).not.toBeNull();
    expect(style?.background).toBe("var(--scrim)");
    expect(Number(style?.opacity)).toBeLessThan(0.1);
    // No colour literal: the wash must follow the theme.
    expect(String(style?.background)).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
  });

  it("does not swallow pointer events meant for the note", () => {
    expect(paneScrimStyle(false, 3)?.pointerEvents).toBe("none");
  });
});
