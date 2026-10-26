// myne-md/myne#908 item 3 — the unfocused pane must read as "not this one".
//
// The treatment is a BRIGHTNESS reduction, and that is the whole finding: an
// overlay has to pick a colour, and every colour is wrong on some theme. A
// foreground wash lightened a dark pane (a highlight, not a recession) and a
// black wash is invisible on AMOLED. Lowering brightness means the same thing
// everywhere.

import { describe, expect, it } from "vitest";
import { paneDimStyle } from "../../src/notes/components/sharedStyles";

describe("paneDimStyle", () => {
  it("returns nothing for the focused pane", () => {
    expect(paneDimStyle(true, 2)).toBeNull();
  });

  it("returns nothing when there is only one pane", () => {
    expect(paneDimStyle(false, 1)).toBeNull();
  });

  it("lowers the unfocused pane's brightness in a split", () => {
    expect(paneDimStyle(false, 2)).toEqual({ filter: "brightness(0.8)" });
  });

  it("is not an overlay: no colour, no box shadow, no stacking level", () => {
    const style = paneDimStyle(false, 3);
    expect(style?.background).toBeUndefined();
    expect(style?.boxShadow).toBeUndefined();
    expect(style?.zIndex).toBeUndefined();
    expect(style?.position).toBeUndefined();
  });

  it("keeps the other pane readable rather than hiding it", () => {
    const filter = String(paneDimStyle(false, 2)?.filter);
    const value = Number(filter.match(/brightness\(([\d.]+)\)/)?.[1]);
    expect(value).toBeGreaterThanOrEqual(0.75);
    expect(value).toBeLessThan(1);
  });
});
