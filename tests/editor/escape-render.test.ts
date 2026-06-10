// @vitest-environment jsdom
//
// Backslash-escape rendering (MYND-208, task 5). The `\` of an Escape node is
// hidden off-cursor (so `\*` reads as `*`) and revealed on-cursor; byte-stable.

import { afterEach, describe, expect, it } from "vitest";
import {
  type Mounted,
  focusAt,
  mount,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("escape rendering", () => {
  it("hides the backslash off-cursor so the escaped glyph reads cleanly", () => {
    m = mount("a \\*star\\* b\n");
    const text = renderedText(m);
    expect(text).toContain("*star*");
    expect(text).not.toContain("\\*");
  });

  it("renders an escaped backslash \\\\ as a single backslash", () => {
    m = mount("path C:\\\\temp end\n");
    const text = renderedText(m);
    // `\\` collapses to one visible backslash.
    expect(text).toContain("C:\\temp");
  });

  it("reveals the raw \\* when the cursor is inside the escape", () => {
    m = mount("x \\* y\n");
    focusAt(m, "x ".length + 1); // inside the `\*`
    expect(renderedText(m)).toContain("\\*");
  });

  it("round-trips escapes byte-identical", () => {
    const doc = "\\*a\\* \\_b\\_ \\` \\\\ \\# end\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});
