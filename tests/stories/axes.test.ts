// @vitest-environment jsdom
//
// The view contract (myne-md/myne#847 task 4).
//
// The fragment is the ONE thing a reviewer hands to somebody else, so it is
// parsed and serialised in one module and asserted here rather than trusted.
// Two properties matter most and each has its own case: a link written BEFORE
// this change (a bare story id) still resolves, and a view at its defaults
// serialises back to that same short form, so no existing link changes shape.

import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW, dirFor, parseView, serialiseView } from "../../stories/src/axes";

describe("the view contract", () => {
  it("reads a bare story id, which is every link written before this change", () => {
    const view = parseView("#components/button/variants");
    expect(view.storyId).toBe("components/button/variants");
    expect(view.rtl).toBe(false);
    expect(view.theme).toBe("light");
  });

  it("round-trips the axes and the theme", () => {
    const view = { storyId: "components/button/variants", rtl: true, theme: "amoled" as const };
    expect(parseView(`#${serialiseView(view)}`)).toEqual(view);
  });

  it("omits the defaults, so a default view serialises to the bare id", () => {
    expect(serialiseView({ ...DEFAULT_VIEW, storyId: "components/button/variants" })).toBe(
      "components/button/variants",
    );
  });

  it("ignores an unknown key rather than failing the parse", () => {
    // A link written by a newer catalogue, or by hand, must still open the story
    // it names: a fatal parse would turn a stale link into a blank page.
    const view = parseView("#components/button/variants?density=compact&nonsense=1");
    expect(view.storyId).toBe("components/button/variants");
    expect(view.rtl).toBe(false);
  });

  it("falls back to the default palette for an unknown theme", () => {
    expect(parseView("#components/button/variants?theme=nord").theme).toBe("light");
  });

  it("applies `dir` to the stage only when the axis is on", () => {
    expect(dirFor({ ...DEFAULT_VIEW, rtl: true })).toBe("rtl");
    expect(dirFor(DEFAULT_VIEW)).toBeUndefined();
  });
});
