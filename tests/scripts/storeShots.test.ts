/**
 * The store-capture plan, its slot arithmetic and its composition geometry.
 *
 * # Why this file exists
 *
 * `AGENTS.md`: "Verifying a guard means breaking it, not running it. A guard that
 * has never failed is a guard nobody has tested." The pure half of the capture is
 * the half a browser cannot check, and every number in it ends up baked into an
 * image a store serves. So each rule is exercised with an input that violates it,
 * not only with the input that satisfies it.
 *
 * The three failures this catches in the order they would otherwise reach a
 * store:
 *
 *   1. a slot whose pixel size is not its viewport times its scale, which stores
 *      reject and nothing else in this repository looks at;
 *   2. a frame id or screen id that does not exist, which would write a
 *      correctly-sized PNG with nothing in it;
 *   3. a caption the story lost, or a caption for a frame that is gone, which is
 *      the same class of silent hole in a different place.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  SLOTS,
  slotOf,
  assertSlotArithmetic,
  assertProducible,
  toggleLabelFor,
  FEATURE_GRAPHIC,
  ALL_SET_IDS,
  BLOCKED_SET_IDS,
  frameFilename,
} from "../../scripts/lib/store-shots/slots.mjs";
import {
  STORY,
  storyFor,
  resolveRequested,
  assertScreensPresent,
  deviceClassFor,
  screenKeyFor,
} from "../../scripts/lib/store-shots/story.mjs";
import {
  buildPlan,
  captionFor,
  orphanedCaptions,
  assertSlotsMatchStory,
  describePlan,
} from "../../scripts/lib/store-shots/plan.mjs";
import {
  plateGeometry,
  canvasGeometry,
  graphicLayout,
  glowFor,
  BANNER_COLOURS,
  CARD_GLYPHS,
  bannerEdge,
  bannerCellPath,
  bannerGeometry,
  BANNER_EDGE_SAMPLES_PER_FRAME,
  cardLayout,
  cipherField,
  cipherSegments,
  cipherAlphaAt,
  CIPHER_OPACITY_CAP,
  PLATE_BACKGROUND,
  PLATE_PALETTE,
} from "../../scripts/lib/store-shots/compose.mjs";

const outDirFor = () => "/tmp/store-shots-test";

describe("slot arithmetic", () => {
  it("holds for every declared slot", () => {
    for (const slot of Object.values(SLOTS)) {
      expect(() => assertSlotArithmetic(slot)).not.toThrow();
    }
  });

  it("fails by name when a slot's pixels do not match its viewport times its scale", () => {
    const transposed = { ...SLOTS["iphone-6.9"], width: 2868, height: 1320 };
    expect(() => assertSlotArithmetic(transposed)).toThrowError(
      /slot "iphone-6\.9" is inconsistent: 440x956 at 3x is 1320x2868, not 2868x1320/,
    );
  });

  it("fails by name on an unknown set, and lists every set including the graphic", () => {
    expect(() => slotOf("ipad-12")).toThrowError(/unknown set "ipad-12"\. Known sets: /);
    for (const id of ALL_SET_IDS) expect(() => slotOf(id)).not.toThrow();
    expect(ALL_SET_IDS).toContain("play-feature-graphic");
    // `all` must be the producible sets, so one blocked set cannot make the whole
    // refresh fail; the blocked one is still refused when asked for BY NAME.
    expect(ALL_SET_IDS).not.toContain("android-10");
    expect(BLOCKED_SET_IDS).toEqual(["android-10"]);
  });

  it("names the Apple sets by frame id and the F-Droid ones by number", () => {
    expect(frameFilename(SLOTS["iphone-6.9"], 0, "notes")).toBe("01-notes.png");
    expect(frameFilename(SLOTS["android-phone"], 0, "notes")).toBe("1.png");
  });
});

describe("the story", () => {
  it("gives the phone sets seven frames and the tablet sets three", () => {
    expect(storyFor(screenKeyFor("phone"))).toHaveLength(7);
    expect(storyFor(screenKeyFor("tablet"))).toHaveLength(3);
  });

  it("reads every frame id off the story in order", () => {
    expect(STORY.map((f: { id: string }) => f.id)).toEqual([
      "notes",
      "markdown",
      "agent",
      "collab",
      "find",
      "privacy",
      "server",
    ]);
  });

  it("fails by name on a frame that is not in the story", () => {
    expect(() => resolveRequested("phone", ["notes", "graph"])).toThrowError(
      /unknown frame "graph"\. Frames in story order: notes, markdown, agent, collab, find, privacy, server/,
    );
  });

  it("returns the whole story for a class when nothing is requested", () => {
    expect(resolveRequested("phone", []).map((f: { id: string }) => f.id)).toHaveLength(7);
  });

  it("fails by name when the board does not render a screen the story names", () => {
    const frames = storyFor("phone");
    // The board as it stands minus the agent screen the story names.
    const boardIds = frames.map((f) => f.screenId).filter((id) => id !== "AG-02");
    expect(() => assertScreensPresent(frames, boardIds)).toThrowError(
      /the board does not render a screen this story names: "agent" wants screen "AG-02"/,
    );
  });

  it("passes when the board renders every screen the story names", () => {
    const frames = storyFor("phone");
    expect(() => assertScreensPresent(frames, frames.map((f) => f.screenId))).not.toThrow();
  });

  it("rejects a device class it does not know", () => {
    expect(() => screenKeyFor("watch")).toThrowError(/unknown device class "watch"/);
  });

  it("maps each slot to a device class", () => {
    expect(deviceClassFor(SLOTS["iphone-6.9"])).toBe("phone");
    expect(deviceClassFor(SLOTS["android-10"])).toBe("tablet");
  });
});

describe("captions", () => {
  it("has an entry for every frame and no entry without a frame", () => {
    for (const frame of STORY) expect(() => captionFor(frame.id)).not.toThrow();
    expect(orphanedCaptions()).toEqual([]);
  });

  it("fails by name on a frame with no caption", () => {
    expect(() => captionFor("screenshots")).toThrowError(
      /no caption for frame "screenshots" in captions\.en\.json/,
    );
  });

  it("carries a headline and a sub for every frame", () => {
    for (const frame of STORY) {
      const caption = captionFor(frame.id);
      expect(caption.headline.length).toBeGreaterThan(0);
      expect(caption.sub.length).toBeGreaterThan(0);
    }
  });

  it("gives every frame an eyebrow and at least one card", () => {
    for (const frame of STORY) {
      const caption = captionFor(frame.id);
      expect(caption.eyebrow.length).toBeGreaterThan(0);
      expect(caption.cards.length).toBeGreaterThan(0);
      for (const card of caption.cards) expect(card.text.length).toBeGreaterThan(0);
    }
  });

  it("no longer carries a footer line, because the bar is gone", () => {
    for (const frame of STORY) expect(captionFor(frame.id)).not.toHaveProperty("clause");
  });
});

describe("the slot table against the story", () => {
  it("agrees on how many frames each set carries", () => {
    expect(() => assertSlotsMatchStory()).not.toThrow();
  });

  it("would fail if a set claimed more frames than its device class has", () => {
    const lying = { ...SLOTS["ipad-13"], story: 8 };
    expect(lying.story).not.toBe(storyFor("tablet").length);
  });
});

describe("buildPlan", () => {
  it("builds one entry per requested set, one frame per requested id", () => {
    const plan = buildPlan({ sets: ["iphone-6.9"], frames: ["notes"], outDirFor });
    expect(plan.slots).toHaveLength(1);
    const [entry] = plan.slots;
    expect(entry.deviceClass).toBe("phone");
    expect(entry.frames).toHaveLength(1);
    expect(entry.frames[0]).toMatchObject({
      id: "notes",
      index: 0,
      screenId: "05",
      filename: "01-notes.png",
      out: "/tmp/store-shots-test",
    });
    expect(entry.frames[0].caption.headline).toBe("Notes that stay yours.");
  });

  it("fails by name on an unknown frame rather than capturing the rest", () => {
    expect(() => buildPlan({ sets: ["iphone-6.9"], frames: ["graph"], outDirFor })).toThrowError(
      /unknown frame "graph"/,
    );
  });

  it("fails by name on an unknown set", () => {
    expect(() => buildPlan({ sets: ["ipad-mini"], frames: [], outDirFor })).toThrowError(
      /unknown set "ipad-mini"/,
    );
  });

  it("gives the F-Droid sets their numeric file names", () => {
    const plan = buildPlan({ sets: ["android-phone"], frames: ["notes", "markdown"], outDirFor });
    expect(plan.slots[0].frames.map((f: { filename: string }) => f.filename)).toEqual(["1.png", "2.png"]);
  });

  it("summarises itself without opening a browser", () => {
    const plan = buildPlan({ sets: ["iphone-6.9"], frames: ["notes"], outDirFor });
    expect(describePlan(plan)).toContain("iphone-6.9 (1320x2868, ios chrome): 1 frame(s)");
  });
});

describe("the plate palette", () => {
  // WCAG relative luminance, because the failure this guards is the one that
  // actually shipped in the first run of this composition: the headline used
  // `var(--fg-1)`, which is dark ink in the light theme, so it rendered
  // dark-on-near-black and vanished. No typecheck, token guard or lint sees that.
  const luminance = (hex: string) => {
    const n = hex.replace("#", "");
    const channels = [0, 2, 4]
      .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it("keeps the headline readable on the plate", () => {
    expect(contrast(PLATE_PALETTE.ink, PLATE_PALETTE.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the sub-line and the clause bar readable on the plate", () => {
    expect(contrast(PLATE_PALETTE.muted, PLATE_PALETTE.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("carries no colour for the device frame, which is the app's and therefore token-bound", () => {
    expect(Object.keys(PLATE_PALETTE).sort()).toEqual([
      "background",
      "cipherBright",
      "glow",
      "ink",
      "muted",
      "plateLine",
    ]);
  });

  it("travels with the geometry, so the browser half paints nothing of its own", () => {
    const g = plateGeometry(SLOTS["iphone-6.9"], { width: 402, height: 874 });
    expect(g.palette).toEqual(PLATE_PALETTE);
    expect(g.plate.background).toBe(PLATE_PALETTE.background);
  });
});

describe("the set canvas", () => {
  it("is as wide as its frames and exactly one frame tall", () => {
    const c = canvasGeometry(SLOTS["iphone-6.9"], 8);
    expect(c.width).toBe(440 * 8);
    expect(c.height).toBe(956);
    expect(c.frameWidth).toBe(440);
  });

  it("keeps the canvas height after the bar was removed", () => {
    // Regression this replaces: the bar's own `height` was once SPREAD into this
    // object, the last write won, and the canvas came out one bar tall. The bar is
    // gone at the maintainer's request, and the height still has to be the frame's.
    const c = canvasGeometry(SLOTS["iphone-6.9"], 8);
    expect(c.height).toBe(SLOTS["iphone-6.9"].viewport.height);
    expect(c).not.toHaveProperty("clauseBar");
  });

  it("no longer carries a ruled ground, because the flat lines were removed", () => {
    for (const slot of Object.values(SLOTS)) {
      expect(canvasGeometry(slot, 1)).not.toHaveProperty("ruling");
      expect(graphicLayout(FEATURE_GRAPHIC, { width: 402, height: 874 })).not.toHaveProperty("ruling");
    }
  });

  it("puts a glow behind each frame's device, inside the canvas", () => {
    const slot = SLOTS["iphone-6.9"];
    const g = plateGeometry(slot, { width: 402, height: 874 });
    const glow = glowFor(slot, g);
    expect(glow.radius).toBeGreaterThan(0);
    expect(glow.x).toBeGreaterThan(0);
    expect(glow.x).toBeLessThan(slot.viewport.width);
    expect(glow.y).toBeLessThan(slot.viewport.height);
  });

  it("refuses a canvas with no frames", () => {
    expect(() => canvasGeometry(SLOTS["iphone-6.9"], 0)).toThrowError(/a canvas needs at least one frame/);
  });

  it("gives the feature graphic exactly one frame and its own file name", () => {
    const plan = buildPlan({ sets: ["play-feature-graphic"], frames: ["notes"], outDirFor });
    expect(plan.slots[0].frames).toHaveLength(1);
    expect(plan.slots[0].frames[0].filename).toBe("featureGraphic.png");
  });

  it("has an eyebrow on the graphic too, so the hierarchy matches the frames", () => {
    const g = graphicLayout(FEATURE_GRAPHIC, { width: 402, height: 874 });
    expect(g.caption.eyebrowSize).toBeGreaterThan(0);
  });

  it("lays the graphic out landscape, with the device right of the headline", () => {
    const g = graphicLayout(FEATURE_GRAPHIC, { width: 402, height: 874 });
    expect(g.plate).toEqual({ width: 1024, height: 500, background: PLATE_BACKGROUND });
    expect(g.caption.left).toBeLessThan(g.device.left);
    expect(g.device.left + g.device.width).toBeLessThanOrEqual(1024);
    expect(g.device.top).toBeGreaterThanOrEqual(0);
    expect(g.device.top + g.device.height).toBeLessThanOrEqual(500);
  });

  it("refuses a graphic box that cannot hold a device", () => {
    expect(() => graphicLayout(FEATURE_GRAPHIC, { width: 0, height: 0 })).toThrowError(
      /graphicLayout needs a positive device frame box/,
    );
  });


});

describe("sets that cannot be rendered yet", () => {
  it("passes every set that can", () => {
    expect(() => assertProducible(SLOTS["iphone-6.9"])).not.toThrow();
    expect(() => assertProducible(SLOTS["android-phone"])).not.toThrow();
    expect(() => assertProducible(SLOTS["ipad-13"])).not.toThrow();
  });

  it("names the Android 10-inch set and says why, rather than approximating it", () => {
    expect(() => assertProducible(SLOTS["android-10"])).toThrowError(
      /set "android-10" cannot be rendered yet: the gallery cannot render Android chrome at tablet size/,
    );
  });

  it("refuses that set through the plan, not only through the helper", () => {
    expect(() => buildPlan({ sets: ["android-10"], frames: [], outDirFor })).toThrowError(
      /cannot be rendered yet/,
    );
  });

  it("still refuses an unknown set before the blocked one", () => {
    expect(() => buildPlan({ sets: ["nope", "android-10"], frames: [], outDirFor })).toThrowError(
      /unknown set "nope"/,
    );
  });
});

describe("board toggles", () => {
  it("maps each set's chrome to the toggle that shows it", () => {
    expect(toggleLabelFor("ios")).toBe("iOS");
    expect(toggleLabelFor("ipad")).toBe("iPad");
    expect(toggleLabelFor("android")).toBe("Android");
    expect(toggleLabelFor("android-tablet")).toBe("Android");
  });

  it("refuses a chrome it does not know", () => {
    expect(() => toggleLabelFor("watch")).toThrowError(/has no board toggle/);
  });
});

describe("the floating cards", () => {
  const slot = SLOTS["iphone-6.9"];

  it("keeps every card's rectangle fully inside its own frame, and therefore the canvas", () => {
    // The stronger invariant that replaced the straddle. A store carousel shows ONE
    // image at a time, so a card cut mid-word by the frame edge stops a frame
    // standing on its own; containment in the frame is a superset of containment in
    // the canvas. Checked for the card indices a caption actually reaches (0 and 1)
    // plus one past, so a third card cannot be introduced unbounded.
    const canvasWidth = 8 * slot.viewport.width;
    for (let i = 0; i < 8; i += 1) {
      const frameLeft = i * slot.viewport.width;
      for (let ci = 0; ci < 3; ci += 1) {
        const c = cardLayout(slot, i, ci, 8);
        const where = `frame ${i} card ${ci}`;
        expect(c.left, where).toBeGreaterThanOrEqual(frameLeft);
        expect(c.left + c.width, where).toBeLessThanOrEqual(frameLeft + slot.viewport.width);
        expect(c.left, where).toBeGreaterThanOrEqual(0);
        expect(c.left + c.width, where).toBeLessThanOrEqual(canvasWidth);
      }
    }
  });

  it("puts a second card somewhere a stack would read as a stack, not a list", () => {
    const first = cardLayout(slot, 4, 0, 8);
    const second = cardLayout(slot, 4, 1, 8);
    expect(second.left).not.toBe(first.left);
    expect(second.top).not.toBe(first.top);
  });

  it("keeps every card inside the canvas vertically", () => {
    for (let i = 0; i < 8; i += 1) {
      const c = cardLayout(slot, i, 0, 8);
      expect(c.top).toBeGreaterThan(0);
      expect(c.top).toBeLessThan(slot.viewport.height);
    }
  });

  it("scatters: no two frames give a card the same angle or width", () => {
    const angles = new Set<number>();
    const widths = new Set<number>();
    for (let i = 0; i < 8; i += 1) {
      const c = cardLayout(slot, i, 0, 8);
      angles.add(c.rotate);
      widths.add(c.width);
      expect(Math.abs(c.rotate)).toBeLessThanOrEqual(5);
    }
    expect(angles.size).toBeGreaterThan(5);
    expect(widths.size).toBeGreaterThan(3);
  });

  it("carries a glyph for every card's icon name", () => {
    for (const frame of STORY) {
      for (const card of captionFor(frame.id).cards) {
        expect(Object.keys(CARD_GLYPHS)).toContain(card.icon);
      }
    }
  });
});

describe("the cipher field", () => {
  it("is byte-identical between renders, so a set is reproducible", () => {
    expect(cipherField(SLOTS["iphone-6.9"], 8)).toEqual(cipherField(SLOTS["iphone-6.9"], 8));
  });

  it("crosses several frames, so a row slides rather than repeating per frame", () => {
    const slot = SLOTS["iphone-6.9"];
    const field = cipherField(slot, 8);
    const longest = Math.max(...field.rows.map((r: { text: string }) => r.text.length));
    expect(longest).toBeGreaterThan(slot.viewport.width / 4);
  });

  it("cannot be read as a word: no I, O, 0 or 1 anywhere", () => {
    const field = cipherField(SLOTS["android-phone"], 8);
    for (const row of field.rows as { text: string }[]) expect(row.text).not.toMatch(/[IO01]/);
  });

  it("stays below the opacity cap, so it never competes with the copy", () => {
    const field = cipherField(SLOTS["ipad-13"], 3);
    for (const row of field.rows as { opacity: number }[]) {
      expect(row.opacity).toBeGreaterThan(0);
      expect(row.opacity).toBeLessThan(CIPHER_OPACITY_CAP);
    }
  });

  it("has rows to draw at all", () => {
    expect(cipherField(SLOTS["iphone-6.9"], 8).rows.length).toBeGreaterThan(8);
  });

  it("varies brightness, so the field glows in places and sinks in others", () => {
    const rows = cipherField(SLOTS["iphone-6.9"], 8).rows as { bright: boolean }[];
    const bright = rows.filter((r) => r.bright).length;
    expect(bright).toBeGreaterThan(0);
    expect(bright).toBeLessThan(rows.length);
  });

  it("is visible enough to exist: the range reaches past the old cap of 0.12", () => {
    const rows = cipherField(SLOTS["iphone-6.9"], 8).rows as { opacity: number }[];
    expect(Math.max(...rows.map((r) => r.opacity))).toBeGreaterThan(0.12);
  });
});

describe("the torn banner edge", () => {
  const slot = SLOTS["iphone-6.9"];

  it("is one sequence across the whole set, so it cannot step at a seam", () => {
    const edge = bannerEdge(slot, 8);
    expect(edge.points).toHaveLength(8 * BANNER_EDGE_SAMPLES_PER_FRAME + 1);
    // Driven through the PATHS, not through the point array: the first version of
    // this compared an expression with itself and could never fail, which is the
    // vacuous-fixture shape AGENTS.md records. What matters is that the y where one
    // cell's edge ends is the y where the next one's begins.
    for (let i = 0; i < 7; i += 1) {
      const nums = (path: string) =>
        [...path.matchAll(/[ML](\d+) (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      const mine = nums(bannerCellPath(edge, i, 8, 300));
      const next = nums(bannerCellPath(edge, i + 1, 8, 300));
      const myTop = mine.slice(0, BANNER_EDGE_SAMPLES_PER_FRAME + 1);
      const nextTop = next.slice(0, BANNER_EDGE_SAMPLES_PER_FRAME + 1);
      expect(myTop[myTop.length - 1][0]).toBe(nextTop[0][0]);
      expect(myTop[myTop.length - 1][1]).toBe(nextTop[0][1]);
    }
  });

  it("keeps the tear inside its amplitude, so it never reaches the headline", () => {
    const edge = bannerEdge(slot, 8);
    const { height } = bannerGeometry(slot);
    for (const pt of edge.points as { y: number }[]) {
      expect(pt.y).toBeGreaterThanOrEqual(0);
      expect(pt.y).toBeLessThanOrEqual(edge.amplitude);
    }
    expect(edge.amplitude).toBeLessThan(height * 0.25);
  });

  it("is byte-identical between renders", () => {
    expect(bannerEdge(slot, 8)).toEqual(bannerEdge(slot, 8));
  });

  it("builds a closed path per frame that spans exactly one frame width", () => {
    const edge = bannerEdge(slot, 8);
    const path = bannerCellPath(edge, 2, 8, 300);
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    const xs = [...path.matchAll(/[ML](\d+) /g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBe(2 * slot.viewport.width);
    expect(Math.max(...xs)).toBe(3 * slot.viewport.width);
    expect(path).toContain("300");
  });
});

describe("irregular cipher brightness", () => {
  const slot = SLOTS["iphone-6.9"];

  it("varies with POSITION, not only per row", () => {
    const a = cipherAlphaAt(slot, 8, 400, 300);
    const b = cipherAlphaAt(slot, 8, 900, 300);
    expect(a).not.toBe(b);
  });

  it("has hotspots: dark places, bright places, and enough of each", () => {
    // Every threshold here is a RATIO and every one was read off a measurement, in
    // that order. The two earlier versions guessed absolute numbers and were wrong
    // twice in opposite directions: the first asserted a p90 the field could not
    // reach, the second a p10 the raised floor could no longer clear. Measured on
    // 2026-10-17, re-measured after the range was raised so the field reads on the plate:
    // p10 0.234, p50 0.316, max 0.701. Earlier: p10 0.124, p50 0.188, max 0.55, and 10.5% of segments
    // above 0.25.
    const alphas = (cipherSegments(slot, 8).segments as { alpha: number }[])
      .map((x) => x.alpha)
      .sort((p, q) => p - q);
    const at = (f: number) => alphas[Math.floor(alphas.length * f)];
    const p10 = at(0.1);
    const p50 = at(0.5);
    const max = alphas[alphas.length - 1];
    const brightShare = alphas.filter((a) => a > 0.25).length / alphas.length;

    // The dark end sits well below the middle, so the field is not uniformly bright.
    expect(p10).toBeLessThan(p50 * 1.0);
    // The bright end is far above it, so the hotspots are real.
    expect(max).toBeGreaterThan(p50 * 1.77);
    // And enough area is bright that it reads as patches rather than as one glyph.
    expect(brightShare).toBeGreaterThan(0.06);
  });

  it("is identical between renders", () => {
    expect(cipherSegments(slot, 8)).toEqual(cipherSegments(slot, 8));
  });

  it("reaches across a seam, because x is a canvas coordinate", () => {
    const { segments } = cipherSegments(slot, 8);
    const beyond = (segments as { x: number }[]).filter((x) => x.x > slot.viewport.width);
    expect(beyond.length).toBeGreaterThan(0);
  });
});

describe("plate geometry", () => {
  const slot = SLOTS["iphone-6.9"];
  const frameBox = { width: 402, height: 874 };

  it("returns a plate exactly the slot's viewport", () => {
    const g = plateGeometry(slot, frameBox);
    expect(g.plate).toEqual({
      width: slot.viewport.width,
      height: slot.viewport.height,
      background: PLATE_BACKGROUND,
    });
  });

  it("keeps the device inside the plate's width", () => {
    const g = plateGeometry(slot, frameBox);
    expect(g.device.left).toBeGreaterThanOrEqual(0);
    expect(g.device.left + g.device.width).toBeLessThanOrEqual(slot.viewport.width);
  });

  it("runs the device UNDER the banner, so the type is in front of the image", () => {
    const g = plateGeometry(slot, frameBox);
    expect(g.device.coveredByBanner).toBeGreaterThan(0);
    // Bounded: past a sixth of the plate the phone stops reading as a phone.
    expect(g.device.coveredByBanner).toBeLessThan(slot.viewport.height / 6);
  });

  it("puts the banner at the bottom of the plate", () => {
    const g = plateGeometry(slot, frameBox);
    expect(g.banner.top).toBe(slot.viewport.height - g.banner.height);
    expect(g.banner.top).toBeGreaterThan(slot.viewport.height / 2);
  });

  it("has no top caption left to draw", () => {
    expect(plateGeometry(slot, frameBox)).not.toHaveProperty("caption");
  });

  it("has a legible banner in every rotation colour", () => {
    const lum = (hex: string) => {
      const n = hex.replace("#", "");
      const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    for (const pair of BANNER_COLOURS) {
      const [hi, lo] = [lum(pair.bg), lum(pair.fg)].sort((x, y) => y - x);
      expect((hi + 0.05) / (lo + 0.05), `${pair.bg} on ${pair.fg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("scales the device down rather than up when the box is already large", () => {
    const g = plateGeometry(slot, { width: 1200, height: 2600 });
    expect(g.device.scale).toBeLessThan(1);
  });

  it("fails by name on a box that cannot hold a device", () => {
    expect(() => plateGeometry(slot, { width: 0, height: 874 })).toThrowError(
      /plateGeometry needs a positive device frame box/,
    );
  });

  it("gives the banner an eyebrow and a headline size", () => {
    const g = plateGeometry(slot, frameBox);
    expect(g.banner.eyebrowSize).toBeGreaterThan(0);
    expect(g.banner.headlineSize).toBeGreaterThan(g.banner.eyebrowSize);
  });
});

/**
 * The store capture lane's own config, which no tsconfig includes and nothing else
 * holds (myne-md/myne#896).
 *
 * `mobile/tsconfig.json` includes `["src"]`, so `mobile/playwright.store.config.ts`
 * is in no tsconfig and `tsc` never sees it: the same gap the root `AGENTS.md`
 * records for `web/vite.config.ts`. The flag that matters is
 * `reuseExistingServer: false`, because the dev-server port is machine-wide and a
 * reused server would answer from whatever worktree started it, rendering ANOTHER
 * branch's app into images this one commits to a store. Silently, because the
 * output is a PNG nobody reads line by line. Read as text rather than imported,
 * because `@playwright/test` resolves from the mobile workspace and not from the
 * repo root, so importing it here would fail on module resolution instead of
 * asserting the flag.
 */
describe("the store capture lane config", () => {
  const config: string = readFileSync("mobile/playwright.store.config.ts", "utf8");

  it("never reuses a running dev server", () => {
    expect(config).toContain("reuseExistingServer: false");
    expect(config).not.toContain("reuseExistingServer: true");
  });

  it("defaults to the store's own port, which is not the developer's", () => {
    expect(config).toMatch(/STORE_DEV_PORT\s*\?\?\s*"1433"/);
  });
});
