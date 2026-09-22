// @vitest-environment jsdom
//
// The three-region keyboard model (myne-md/myne#728, task 2). The editor body
// had no keyboard exit at all: Tab indents and must keep indenting, so a
// keyboard-first user who reached the note could not leave it. The exit is a
// region model, and this spec holds the two halves of it that can go wrong
// silently.
//
//   - The CYCLE rule, as a pure function: wrapping, the "focus is nowhere yet"
//     start, and the case that actually bites, which is a user standing in a
//     region that has since stopped accepting focus (they collapsed the
//     sidebar they were in). Doing nothing there is indistinguishable from a
//     dead key.
//   - The DOM rule: a region is declared by an attribute, the entry target is
//     the region's point rather than its first tab stop, and a collapsed
//     sidebar is skipped because its content is `inert` - which every focusable
//     selector in the tree still matches.

import { afterEach, describe, expect, it } from "vitest";
import {
  REGION_ATTR,
  REGION_IDS,
  cycleRegion,
  currentRegion,
  focusRegion,
  nextRegionId,
  reachableRegions,
  regionEntryTarget,
  regionOf,
  regionRoot,
} from "../../src/lib/regions";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Build a shell: each entry is a region id and the HTML inside its root. */
function shell(regions: Array<[string, string]>, rootAttrs = ""): void {
  document.body.innerHTML = regions
    .map(([id, inner]) => `<div ${REGION_ATTR}="${id}" ${rootAttrs}>${inner}</div>`)
    .join("");
}

describe("the region cycle rule", () => {
  const all = REGION_IDS;

  it("cycles forward in declared order and wraps", () => {
    expect(nextRegionId("sidebar", all)).toBe("editor");
    expect(nextRegionId("editor", all)).toBe("right-panel");
    expect(nextRegionId("right-panel", all)).toBe("sidebar");
  });

  it("cycles backward and wraps the other way", () => {
    expect(nextRegionId("sidebar", all, false)).toBe("right-panel");
    expect(nextRegionId("right-panel", all, false)).toBe("editor");
  });

  it("starts at the first region when focus is nowhere", () => {
    expect(nextRegionId(null, all)).toBe("sidebar");
  });

  it("skips a region that is not reachable", () => {
    // The right panel is absent (a non-note tab has none), so the cycle is two
    // stops, not three with a dead one.
    expect(nextRegionId("editor", ["sidebar", "editor"])).toBe("sidebar");
  });

  it("lands somewhere when the current region has stopped accepting focus", () => {
    // The user collapsed the sidebar they were standing in. Returning null here
    // reads to them as a broken key.
    expect(nextRegionId("sidebar", ["editor", "right-panel"])).toBe("editor");
  });

  it("reports nothing only when nothing is reachable", () => {
    expect(nextRegionId("editor", [])).toBeNull();
    expect(nextRegionId(null, [])).toBeNull();
  });
});

describe("a region is declared in the DOM", () => {
  it("finds a region root by its attribute", () => {
    shell([["sidebar", "<button>a</button>"]]);
    expect(regionRoot("sidebar")).not.toBeNull();
    expect(regionRoot("editor")).toBeNull();
  });

  it("reports the region an element sits in, and null outside every region", () => {
    shell([["editor", '<button id="inside">a</button>']]);
    document.body.insertAdjacentHTML("beforeend", '<button id="outside">b</button>');
    expect(regionOf(document.getElementById("inside"))).toBe("editor");
    expect(regionOf(document.getElementById("outside"))).toBeNull();
  });

  it("ignores an attribute value that is not a region", () => {
    shell([["sidebar-ish", "<button>a</button>"]]);
    expect(regionOf(document.querySelector("button"))).toBeNull();
  });
});

describe("entering a region", () => {
  it("lands on the first focusable element by default", () => {
    shell([["sidebar", "<button>first</button><button>second</button>"]]);
    expect(focusRegion("sidebar")).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toBe("first");
  });

  it("lands on the EDITOR TEXT, not on the tab strip above it", () => {
    // The whole point of asking for the editor region is the text. Its first
    // focusable element is a tab, which is the wrong place to be dropped.
    shell([
      [
        "editor",
        '<div role="tab" tabindex="0">a tab</div>' +
          '<div class="cm-content" contenteditable="true">body</div>',
      ],
    ]);
    expect(focusRegion("editor")).toBe(true);
    expect((document.activeElement as HTMLElement).className).toBe("cm-content");
  });

  it("refuses an inert region rather than focusing nothing", () => {
    // A collapsed sidebar stays MOUNTED at width 0 with its content inert, so
    // its buttons still match every focusable selector in the tree.
    shell([["sidebar", '<div inert><button>hidden</button></div>']]);
    const root = regionRoot("sidebar");
    expect(root).not.toBeNull();
    expect(regionEntryTarget(root as HTMLElement, "sidebar")).toBeNull();
    expect(focusRegion("sidebar")).toBe(false);
  });

  it("refuses a region with nothing focusable in it", () => {
    shell([["right-panel", "<p>all hidden</p>"]]);
    expect(focusRegion("right-panel")).toBe(false);
  });

  it("reports false for a region that is not rendered", () => {
    shell([["sidebar", "<button>a</button>"]]);
    expect(focusRegion("right-panel")).toBe(false);
  });

  it("counts only the regions that can actually be entered", () => {
    shell([
      ["sidebar", '<div inert><button>collapsed</button></div>'],
      ["editor", '<div class="cm-content" contenteditable="true">body</div>'],
      ["right-panel", "<p>nothing focusable</p>"],
    ]);
    expect(reachableRegions()).toEqual(["editor"]);
  });
});

describe("cycling moves focus for real", () => {
  function threeRegions(): void {
    shell([
      ["sidebar", '<button id="s">notes</button>'],
      ["editor", '<div class="cm-content" contenteditable="true" id="e">body</div>'],
      ["right-panel", '<button id="r">panel</button>'],
    ]);
  }

  it("walks the three regions and comes back round", () => {
    threeRegions();
    expect(cycleRegion()).toBe("sidebar");
    expect(document.activeElement?.id).toBe("s");
    expect(cycleRegion()).toBe("editor");
    expect(document.activeElement?.id).toBe("e");
    expect(cycleRegion()).toBe("right-panel");
    expect(document.activeElement?.id).toBe("r");
    expect(cycleRegion()).toBe("sidebar");
    expect(document.activeElement?.id).toBe("s");
  });

  it("reports which region holds focus", () => {
    threeRegions();
    expect(currentRegion()).toBeNull();
    focusRegion("editor");
    expect(currentRegion()).toBe("editor");
  });

  it("steps over a collapsed region instead of stalling in it", () => {
    shell([
      ["sidebar", '<button id="s">notes</button>'],
      ["editor", '<div class="cm-content" contenteditable="true" id="e">body</div>'],
      ["right-panel", "<div inert><button>collapsed</button></div>"],
    ]);
    focusRegion("editor");
    expect(cycleRegion()).toBe("sidebar");
    expect(document.activeElement?.id).toBe("s");
  });
});
