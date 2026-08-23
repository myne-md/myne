// @vitest-environment jsdom
//
// The size class is a pure function of two window measurements — myne-md/myne#557,
// the two `layout.size-classes` bullets.
//
// The roster rows asked a person to open the app on an iPad, drag it into Split
// View, check that the layout falls back to the phone shape with the pane still
// usable and the editor's content preserved, then open the keyboard on an
// Android phone in landscape and check that the layout does not flip while
// typing. Two devices, one of them running a gesture nobody can script.
//
// `computeSizeClass` reads exactly two things — `window.screen` and
// `window.innerWidth` — and its own doc says the flow tier drives it purely by
// viewport. Split View delivers nothing a resize cannot reproduce, so the
// breakpoints are a table, and the IME guard is one assertion:
//
//   hold `screen` constant, shrink `innerWidth`, assert the class does not move.
//
// That is the whole of the second roster row. The Android IME shrinks the
// LAYOUT VIEWPORT when the keyboard opens; a guard that read the window height
// would flip the size class mid-typing, remount the editor and dismiss the
// keyboard — an open-close oscillation the user experiences as the keyboard
// fighting them. The guard reads `screen`, which the IME does not touch.
//
// What stays out of scope, deliberately: whether the panes LOOK right at each
// class, and whether the editor's buffer survives the remount. Both are DOM
// assertions on a rendered tree and belong to the Playwright flow tier, which
// already drives this by viewport.

import { afterEach, describe, expect, it } from "vitest";
import { computeSizeClass } from "../src/formfactor/SizeClassContext";

/** The documented breakpoints, restated so a change to either fails here. */
const PHONE_DEVICE_MAX = 480;
const MEDIUM_MIN = 700;
const EXPANDED_MIN = 1000;

const originalScreen = Object.getOwnPropertyDescriptor(window, "screen");
const originalInnerWidth = window.innerWidth;

/** Pin the device's physical screen and the window's CSS width. */
function device(screenW: number, screenH: number, innerWidth: number): void {
  Object.defineProperty(window, "screen", {
    configurable: true,
    value: { width: screenW, height: screenH } as Screen,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: innerWidth,
  });
}

afterEach(() => {
  if (originalScreen) Object.defineProperty(window, "screen", originalScreen);
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalInnerWidth,
  });
});

// ── 1. The breakpoints, as a table ──────────────────────────────────────────

describe("the size class over a tablet's screen", () => {
  // An iPad Pro 11": 834 x 1194 CSS px. Its smaller dimension clears the phone
  // guard, so the class follows the window width — which is exactly what Split
  // View changes.
  const TABLET: [number, number] = [834, 1194];

  it.each([
    [1194, "expanded"],
    [1000, "expanded"],
    [999, "medium"],
    [834, "medium"],
    [700, "medium"],
    [699, "compact"],
    [507, "compact"],
    [320, "compact"],
  ] as const)("a %ipx window is %s", (width, expected) => {
    device(TABLET[0], TABLET[1], width);
    expect(computeSizeClass()).toBe(expected);
  });

  it("Split View is a resize and nothing more", () => {
    // The roster row's actual subject. iPadOS Split View gives the app a
    // narrower window; the app's response is entirely a function of that width,
    // so every Split View ratio is already covered by the table above.
    device(TABLET[0], TABLET[1], 1194);
    expect(computeSizeClass()).toBe("expanded");
    device(TABLET[0], TABLET[1], 507); // roughly the 1/2 split
    expect(computeSizeClass()).toBe("compact");
    device(TABLET[0], TABLET[1], 320); // the 1/3 slide-over
    expect(computeSizeClass()).toBe("compact");
    device(TABLET[0], TABLET[1], 1194); // …and back
    expect(computeSizeClass()).toBe("expanded");
  });

  it("the boundaries are inclusive at the bottom, on both of them", () => {
    // Off-by-one at a breakpoint is a layout that is one pixel wrong for one
    // window size and correct everywhere else — the least likely thing to be
    // noticed by eye and the most likely to be got wrong in a rewrite.
    device(TABLET[0], TABLET[1], EXPANDED_MIN);
    expect(computeSizeClass()).toBe("expanded");
    device(TABLET[0], TABLET[1], EXPANDED_MIN - 1);
    expect(computeSizeClass()).toBe("medium");
    device(TABLET[0], TABLET[1], MEDIUM_MIN);
    expect(computeSizeClass()).toBe("medium");
    device(TABLET[0], TABLET[1], MEDIUM_MIN - 1);
    expect(computeSizeClass()).toBe("compact");
  });
});

// ── 2. The phone guard ──────────────────────────────────────────────────────

describe("a phone is compact whatever its window says", () => {
  // A large phone in landscape is ~950 CSS px wide, which would otherwise read
  // as `medium` and put a two-pane tablet layout on a phone.
  it("phone landscape stays compact despite a wide window", () => {
    device(430, 932, 932); // iPhone 15 Pro Max, landscape
    expect(computeSizeClass()).toBe("compact");
  });

  it("takes the MINIMUM of both screen axes, so it is orientation-proof", () => {
    // Portrait and landscape are the same device and must answer the same.
    device(430, 932, 430);
    expect(computeSizeClass()).toBe("compact");
    device(932, 430, 932);
    expect(computeSizeClass()).toBe("compact");
  });

  it("the guard's own boundary", () => {
    // A device whose smaller dimension is exactly the cap is NOT phone-guarded,
    // so it follows the window width like a tablet.
    device(PHONE_DEVICE_MAX, 1000, 1000);
    expect(computeSizeClass()).toBe("expanded");
    device(PHONE_DEVICE_MAX - 1, 1000, 1000);
    expect(computeSizeClass()).toBe("compact");
  });
});

// ── 3. The IME guard ────────────────────────────────────────────────────────

describe("the keyboard cannot flip the size class", () => {
  it("a shrinking window does not move the class on a phone", () => {
    // The Android IME shrinks the layout viewport. Hold `screen` constant and
    // sweep `innerWidth` down through every breakpoint: on a phone the
    // `deviceMin < 480` short-circuit makes the answer UNCONDITIONAL, so not
    // one of these may differ.
    const seen = new Set<string>();
    for (const w of [932, 800, 700, 699, 500, 430, 320, 200]) {
      device(430, 932, w);
      seen.add(computeSizeClass());
    }
    expect(
      [...seen],
      "the size class moved while the window shrank. On a phone that is the " +
        "keyboard opening: the class flips, the editor remounts, the keyboard " +
        "is dismissed, and the whole thing oscillates.",
    ).toEqual(["compact"]);
  });

  it("reads window.screen rather than window.innerHeight", () => {
    // The mechanism, asserted directly: a height change alone must move
    // nothing, because the IME's effect IS a height change.
    device(834, 1194, 1194);
    const before = computeSizeClass();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    expect(computeSizeClass()).toBe(before);
  });

  it("a TABLET does re-class on a genuine width change, so the guard is not global", () => {
    // Without this the guard could be "always compact" and pass everything
    // above.
    device(834, 1194, 1194);
    expect(computeSizeClass()).toBe("expanded");
    device(834, 1194, 600);
    expect(computeSizeClass()).toBe("compact");
  });
});

// ── 4. The headless arm ─────────────────────────────────────────────────────

describe("no window at all", () => {
  it("answers compact rather than throwing", () => {
    // The module is imported during SSR-less prerender and by tests that never
    // touch the DOM; a throw here would take the whole tree down.
    const saved = globalThis.window;
    // @ts-expect-error — deliberately removing the global
    delete globalThis.window;
    try {
      expect(computeSizeClass()).toBe("compact");
    } finally {
      globalThis.window = saved;
    }
  });
});
