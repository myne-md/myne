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
import {
  DEFAULT_VIEW,
  dirFor,
  parseView,
  serialiseView,
  stageWidth,
} from "../../stories/src/axes";
import { formatBox, formatGaps, gaps } from "../../stories/src/measure";

describe("the view contract", () => {
  it("reads a bare story id, which is every link written before this change", () => {
    const view = parseView("#components/button/variants");
    expect(view.storyId).toBe("components/button/variants");
    expect(view.rtl).toBe("off");
    expect(view.theme).toBe("light");
  });

  it("round-trips the axes and the theme", () => {
    const view = {
      ...DEFAULT_VIEW,
      storyId: "components/button/variants",
      rtl: "both" as const,
      viewport: "tablet-768" as const,
      reducedMotion: true,
      forcedColors: true,
      theme: "amoled" as const,
    };
    expect(parseView(`#${serialiseView(view)}`)).toEqual(view);
  });

  it("round-trips the two mirrored axes on their own", () => {
    // Each is carried by its own key, so a link can turn on exactly one of them
    // rather than all-or-nothing.
    const onlyReduced = { ...DEFAULT_VIEW, reducedMotion: true };
    expect(parseView(`#${serialiseView(onlyReduced)}`)).toEqual(onlyReduced);
    const onlyForced = { ...DEFAULT_VIEW, forcedColors: true };
    expect(parseView(`#${serialiseView(onlyForced)}`)).toEqual(onlyForced);
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
    expect(view.rtl).toBe("off");
  });

  it("falls back to the default palette for an unknown theme", () => {
    expect(parseView("#components/button/variants?theme=nord").theme).toBe("light");
  });

  it("applies `dir` to the stage only when the axis is on", () => {
    expect(dirFor({ ...DEFAULT_VIEW, rtl: "on" })).toBe("rtl");
    expect(dirFor({ ...DEFAULT_VIEW, rtl: "both" })).toBe("rtl");
    expect(dirFor(DEFAULT_VIEW)).toBeUndefined();
  });
});

describe("the viewport presets", () => {
  it("honours a story's own width under `Fit`", () => {
    expect(stageWidth("fit", 360)).toBe("360px");
  });

  it("fills the stage under `Fit` when the story pins nothing", () => {
    expect(stageWidth("fit", undefined)).toBe("100%");
  });

  it("overrides a story's own width under any other preset", () => {
    // The story keeps the one fact only it can carry, and a preset is a
    // deliberate override rather than a silent one.
    expect(stageWidth("desktop-1280", 360)).toBe("1280px");
  });

  it("round-trips the preset through the URL", () => {
    const view = { ...DEFAULT_VIEW, viewport: "wide-1440" as const };
    expect(parseView(`#${serialiseView(view)}`)).toEqual(view);
  });
});

describe("the outline and fullscreen toggles", () => {
  it("round-trip on their own keys", () => {
    const outline = { ...DEFAULT_VIEW, outline: true };
    expect(parseView(`#${serialiseView(outline)}`)).toEqual(outline);
    const fullscreen = { ...DEFAULT_VIEW, fullscreen: true };
    expect(parseView(`#${serialiseView(fullscreen)}`)).toEqual(fullscreen);
  });

  it("are omitted from the URL at their defaults", () => {
    expect(serialiseView({ ...DEFAULT_VIEW, storyId: "a/b/c" })).toBe("a/b/c");
  });
});

describe("the measure arithmetic", () => {
  it("formats a box the way a reviewer would quote it", () => {
    expect(formatBox({ width: 1199.4, height: 32.6, top: 0, right: 0, bottom: 0, left: 0 })).toBe(
      "1199 x 33",
    );
  });

  it("reports the gap on each side of a contained element", () => {
    const outer = { width: 100, height: 100, top: 0, right: 100, bottom: 100, left: 0 };
    const inner = { width: 60, height: 60, top: 16, right: 84, bottom: 84, left: 16 };
    expect(gaps(inner, outer)).toEqual({ top: 16, right: 16, bottom: 16, left: 16 });
  });

  it("KEEPS a negative gap rather than clamping it", () => {
    // An element that overflows its parent is a finding, and clamping it to zero
    // would report the case a reviewer most needs to see as the case where
    // everything is fine.
    const outer = { width: 100, height: 100, top: 0, right: 100, bottom: 100, left: 0 };
    const overflowing = { width: 140, height: 40, top: -10, right: 130, bottom: 30, left: -10 };
    const gap = gaps(overflowing, outer);
    expect(gap.top).toBe(-10);
    expect(gap.left).toBe(-10);
  });

  it("says so when there is no gap rather than printing zeros", () => {
    expect(formatGaps({ top: 0, right: 0, bottom: 0, left: 0 })).toBe("no gap");
    expect(formatGaps({ top: 8, right: 0, bottom: 0, left: 8 })).toBe("top 8, left 8");
  });
});
