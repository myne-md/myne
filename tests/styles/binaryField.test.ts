// @vitest-environment jsdom
//
// The `01` field's exemption conditions (myne-md/myne#776, `design-notes/ui/0618`).
//
// This is a continuous `requestAnimationFrame` loop, which `PRODUCT.md`
// principle 4 forbids by default. `0616` admits it BY NAME and the conditions
// below are part of that admission rather than polish on top of it — an
// implementation missing any of them is not covered by the entry. So they are
// tested, not asserted in a comment.
//
// The cost is the point. The website runs this for the seconds somebody reads a
// hero; the app runs for hours, on a laptop, with a sidebar section, a rail tab
// and a pane all potentially empty at once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANIMATING_BUDGET,
  animatingFieldCount,
  mountBinaryField,
} from "../../client-core/src/binaryField";

let rafCalls = 0;
let reduceMotion = false;
let observers: { cb: IntersectionObserverCallback; el: Element }[] = [];

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  // jsdom has no layout, so the field would measure 0×0 and skip its grid.
  c.getBoundingClientRect = () => ({
    width: 300, height: 200, top: 0, left: 0, right: 300, bottom: 200, x: 0, y: 0,
    toJSON: () => ({}),
  });
  // jsdom ships no 2D context without the `canvas` package; a recording stub is
  // enough, because what is under test is the LIFECYCLE, not the pixels.
  (c as unknown as { getContext: () => unknown }).getContext = () => ({
    setTransform: () => {}, clearRect: () => {}, fillText: () => {},
    font: "", textBaseline: "", fillStyle: "",
  });
  document.body.appendChild(c);
  return c;
}

beforeEach(() => {
  rafCalls = 0;
  reduceMotion = false;
  observers = [];
  vi.stubGlobal("requestAnimationFrame", () => {
    rafCalls++;
    return rafCalls;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      cb: IntersectionObserverCallback;
      observe(el: Element) {
        observers.push({ cb: this.cb, el });
      }
      disconnect() {}
    },
  );
  window.matchMedia = ((q: string) => ({
    matches: q.includes("prefers-reduced-motion") ? reduceMotion : false,
    media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/**
 * A canvas that RECORDS what it was asked to paint, rather than only that it
 * was asked. The ink tests below are about the colour, so a stub that throws
 * `fillStyle` away cannot hold the defect they exist to catch.
 */
function makeRecordingCanvas(): { canvas: HTMLCanvasElement; fills: string[] } {
  const fills: string[] = [];
  const c = document.createElement("canvas");
  c.getBoundingClientRect = () => ({
    width: 300, height: 200, top: 0, left: 0, right: 300, bottom: 200, x: 0, y: 0,
    toJSON: () => ({}),
  });
  const ctx = {
    setTransform: () => {}, clearRect: () => {},
    fillText: () => { fills.push(String(ctx.fillStyle)); },
    font: "", textBaseline: "", fillStyle: "",
  };
  (c as unknown as { getContext: () => unknown }).getContext = () => ctx;
  document.body.appendChild(c);
  return { canvas: c, fills };
}

/** The `r,g,b` of every colour the field painted, deduplicated. */
function inksIn(fills: string[]): string[] {
  const seen = new Set<string>();
  for (const f of fills) {
    const m = f.match(/^rgba\(([^,]+,[^,]+,[^,]+),/);
    if (m !== null) seen.add(m[1]!);
  }
  return [...seen];
}

/** The largest alpha the field painted — the glow's ceiling at a given ink. */
function maxAlpha(fills: string[]): number {
  let hi = 0;
  for (const f of fills) {
    const m = f.match(/,\s*([\d.]+)\)$/);
    if (m !== null) hi = Math.max(hi, Number(m[1]));
  }
  return hi;
}

/**
 * The smallest alpha the field painted — the REST ramp, which is the other
 * half of the ink decision and the half `maxAlpha` cannot see. The glow only
 * ever ADDS, so the darkest cell in a frame is the one the glow reaches least,
 * and with the orbit pinned (below) two frames differ there by rest gain alone.
 */
function minAlpha(fills: string[]): number {
  let lo = Infinity;
  for (const f of fills) {
    const m = f.match(/,\s*([\d.]+)\)$/);
    if (m !== null) lo = Math.min(lo, Number(m[1]));
  }
  return lo;
}

function stubInk(color: string): void {
  const real = window.getComputedStyle.bind(window);
  vi.stubGlobal("getComputedStyle", (el: Element, pseudo?: string | null) => {
    if (el instanceof HTMLCanvasElement) return { color } as CSSStyleDeclaration;
    return real(el, pseudo ?? undefined);
  });
}

/** Report every observed canvas as on-screen. */
function reveal(): void {
  for (const o of observers) {
    o.cb([{ isIntersecting: true } as IntersectionObserverEntry], null as never);
  }
}

/** ...and as scrolled back out of view. */
function conceal(): void {
  for (const o of observers) {
    o.cb([{ isIntersecting: false } as IntersectionObserverEntry], null as never);
  }
}

describe("the field does not animate until it is on screen", () => {
  it("starts no loop before the observer reports it visible", () => {
    const h = mountBinaryField(makeCanvas());
    expect(rafCalls, "an unrevealed field must not be spinning a loop").toBe(0);
    h.destroy();
  });

  it("STOPS and releases its slot when scrolled back out of view", () => {
    // The case the mount-time check cannot reach. An empty state that has been
    // scrolled past is the common one in a long settings column or a rail tab
    // the user moved away from, and it is where an unpaused loop would burn
    // hours of battery on pixels nobody can see.
    //
    // Injecting the removal of the `!onScreen` guard leaves the previous test
    // GREEN, because at mount `start()` is simply never called — so that test
    // alone proves nothing about the guard. This one does.
    const h = mountBinaryField(makeCanvas());
    reveal();
    expect(animatingFieldCount()).toBe(1);
    conceal();
    expect(
      animatingFieldCount(),
      "an off-screen field must give its budget slot back, not merely stop drawing",
    ).toBe(0);
    reveal();
    expect(animatingFieldCount(), "and take one again on return").toBe(1);
    h.destroy();
  });

  it("starts once revealed, and stops on destroy", () => {
    const h = mountBinaryField(makeCanvas());
    reveal();
    expect(rafCalls).toBeGreaterThan(0);
    expect(animatingFieldCount()).toBe(1);
    h.destroy();
    expect(animatingFieldCount(), "destroy must release the budget slot").toBe(0);
  });
});

/** jsdom reports `document.hidden === false` always, so it has to be forced. */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

describe("a backgrounded tab does not animate", () => {
  it("starts no loop while the document is hidden", () => {
    // Without forcing `document.hidden`, removing this check is INVISIBLE to
    // every other test here — jsdom's value never changes, so the fixture can
    // never reach the state the guard exists for. Injection is what found that.
    setHidden(true);
    const h = mountBinaryField(makeCanvas());
    reveal();
    expect(animatingFieldCount(), "a hidden tab must not hold a budget slot").toBe(0);
    setHidden(false);
    h.destroy();
  });

  it("stops on visibilitychange and resumes when the tab returns", () => {
    const h = mountBinaryField(makeCanvas());
    reveal();
    expect(animatingFieldCount()).toBe(1);

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(animatingFieldCount(), "backgrounding must release the slot").toBe(0);

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(animatingFieldCount(), "and returning must take it back").toBe(1);
    h.destroy();
  });
});

describe("reduced motion paints once and never loops", () => {
  it("runs no rAF at all, rather than a slowed one", () => {
    // It is DECORATION, so it does not take MYND-630's `data-motion="essential"`
    // exemption — that exists for motion carrying state, where freezing reads
    // as hung. Nothing here is hung if it holds still.
    reduceMotion = true;
    const h = mountBinaryField(makeCanvas());
    reveal();
    expect(rafCalls).toBe(0);
    h.destroy();
  });
});

describe("a process-wide budget caps concurrent fields", () => {
  it("lets at most the budget animate, and the rest paint statically", () => {
    // Empty states cluster: a fresh vault can show one in the sidebar, one in a
    // rail tab and one in the open pane simultaneously. The NUMBER is read from
    // the module rather than written here — it has changed once already (the
    // glow came off the cursor, which made a starved field visibly different
    // from a live one and a per-frame repaint into a per-flicker one), and a
    // literal would have made that a test edit rather than a decision.
    const handles = Array.from({ length: ANIMATING_BUDGET + 2 }, () =>
      mountBinaryField(makeCanvas()),
    );
    reveal();
    expect(animatingFieldCount()).toBe(ANIMATING_BUDGET);
    for (const h of handles) h.destroy();
    expect(animatingFieldCount()).toBe(0);
  });

  it("frees a slot when an animating field is destroyed", () => {
    const a = mountBinaryField(makeCanvas());
    const b = mountBinaryField(makeCanvas());
    reveal();
    expect(animatingFieldCount()).toBe(2);
    a.destroy();
    expect(animatingFieldCount(), "a destroyed field must not hold its slot").toBe(1);
    b.destroy();
    expect(animatingFieldCount()).toBe(0);
  });
});

describe("the budget cannot be corrupted by repeated teardown", () => {
  it("does not decrement twice, so the count never goes negative", () => {
    // A negative count would let UNLIMITED fields animate thereafter, silently
    // — the kind of leak that only ever shows up as battery drain.
    //
    // What protects this is the `budgeted` flag, not the `destroyed` one: the
    // second `destroy()` finds `budgeted === false` and decrements nothing.
    // Naming the right guard matters, because injecting a break in `destroyed`
    // leaves this green and would have read as the test being vacuous.
    const h = mountBinaryField(makeCanvas());
    reveal();
    h.destroy();
    h.destroy();
    h.destroy();
    expect(animatingFieldCount()).toBe(0);

    // And the budget still works afterwards: a corrupted count would let one
    // more than the budget through here.
    const held = Array.from({ length: ANIMATING_BUDGET + 1 }, () =>
      mountBinaryField(makeCanvas()),
    );
    reveal();
    expect(animatingFieldCount()).toBe(ANIMATING_BUDGET);
    for (const x of held) x.destroy();
  });
});

describe("the ink comes from the theme, not from the source", () => {
  // The defect this is written against SHIPPED: the ink was the website's
  // hardcoded near-white, ported verbatim along with the canvas. In every dark
  // theme that is correct and in every light one it is near-white digits on
  // near-white paper — a field that is not faint but absent, which is what the
  // user reported. Nothing could have caught it: it type-checks, it paints, and
  // the pixels it paints are the right shape in the wrong colour.

  it("paints with the canvas's own computed colour", () => {
    stubInk("rgb(26, 26, 23)");
    const { canvas, fills } = makeRecordingCanvas();
    const h = mountBinaryField(canvas);
    reveal();
    expect(fills.length, "the mount paints one frame unconditionally").toBeGreaterThan(0);
    expect(inksIn(fills), "every cell takes the theme ink").toEqual(["26,26,23"]);
    h.destroy();
  });

  it("follows a theme switch, which repaints nothing on its own", () => {
    // A canvas holds pixels, not styles, so re-resolving `--fg-1` under it
    // changes nothing until something repaints. On a field past the animation
    // budget, or under reduced motion, that something is never.
    stubInk("rgb(26, 26, 23)");
    const { canvas, fills } = makeRecordingCanvas();
    const h = mountBinaryField(canvas);
    reveal();
    expect(inksIn(fills)).toEqual(["26,26,23"]);

    fills.length = 0;
    stubInk("rgb(232, 231, 223)");
    document.documentElement.setAttribute("data-theme", "dark");
    return new Promise<void>((resolve) => {
      // MutationObserver delivers on a microtask.
      queueMicrotask(() => {
        expect(
          inksIn(fills),
          "a theme switch must re-read the ink AND repaint with it",
        ).toEqual(["232,231,223"]);
        document.documentElement.removeAttribute("data-theme");
        h.destroy();
        resolve();
      });
    });
  });

  it("lifts the rest ramp for dark ink and weakens its glow", () => {
    // Theming the colour alone leaves the RAMP wrong, and it is wrong in two
    // directions at once. At the same alpha, dark ink on light paper lands a
    // SMALLER luminance step than light ink on dark paper, so the rest ramp is
    // lifted; the glow goes the other way and lands near-black on light paper
    // at the strength the dark theme needs, so the glow is weakened.
    // Injecting either half alone leaves the two tests above green, because the
    // colour is right either way.
    //
    // The orbit is randomized per instance, so it is pinned here: without that
    // the two frames differ by where each field's glow happens to be and the
    // comparison measures luck.
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.5);
    stubInk("rgb(232, 231, 223)");
    const light = makeRecordingCanvas();
    const a = mountBinaryField(light.canvas);
    reveal();
    a.destroy();

    stubInk("rgb(26, 26, 23)");
    const dark = makeRecordingCanvas();
    const b = mountBinaryField(dark.canvas);
    reveal();
    b.destroy();
    rand.mockRestore();

    expect(
      minAlpha(dark.fills),
      "dark ink is lifted at rest, or the light themes draw a field nobody sees",
    ).toBeGreaterThan(minAlpha(light.fills));
    expect(
      maxAlpha(dark.fills),
      "and its glow is weaker, or the lit digits read as holes in the card",
    ).toBeLessThan(maxAlpha(light.fills));
  });
});

describe("the glow sweeps on its own, differently per field", () => {
  it("lights cells with no pointer anywhere near it", () => {
    // The change the user asked for, and the reason it is not cosmetic: the
    // glow used to be the only thing that revealed the field, and it appeared
    // only under a cursor. A keyboard user, a screenshot and every idle moment
    // saw a flat grid. Injecting `moveGlow` back to a parked (-9999, -9999)
    // leaves every other test here green.
    stubInk("rgb(26, 26, 23)");
    const { canvas, fills } = makeRecordingCanvas();
    const h = mountBinaryField(canvas);
    reveal();
    expect(
      maxAlpha(fills),
      "the first frame must already be lit somewhere — nothing has hovered it",
    ).toBeGreaterThan(0.3);
    h.destroy();
  });

  it("gives two fields different orbits", () => {
    // Empty states cluster ADJACENTLY, and two fields sweeping in lockstep read
    // as one mechanism driving both — the thing decoration must never look
    // like. The randomization is per MOUNT, so the same component in two places
    // does not agree with itself either.
    //
    // This reads the orbit off the handle rather than comparing painted
    // frames, and the difference is the whole test: the first version compared
    // frames, and it PASSED an injection that gave every field the same orbit,
    // because the grid is randomized too. Eight fields moving in lockstep still
    // paint eight different frames. It was measuring the thing next to the
    // thing it named.
    const handles = Array.from({ length: 8 }, () =>
      mountBinaryField(makeCanvas()),
    );
    const orbits = new Set(
      handles.map((h) => `${h.orbit.ms}|${h.orbit.dir}|${h.orbit.phase}|${h.orbit.squash}`),
    );
    for (const h of handles) h.destroy();
    expect(orbits.size, "eight fields must not share one orbit").toBeGreaterThan(1);
  });

  it("keeps every orbit inside its stated bounds", () => {
    // The set-size test above passes on randomness of ANY shape, including a
    // bug that returns a period of half a second or a squash of zero. These are
    // the numbers that make it read as a slow wash rather than a strobe.
    for (let i = 0; i < 40; i++) {
      const h = mountBinaryField(makeCanvas());
      expect(h.orbit.ms).toBeGreaterThanOrEqual(14_000);
      expect(h.orbit.ms).toBeLessThanOrEqual(26_000);
      expect(Math.abs(h.orbit.dir)).toBe(1);
      expect(h.orbit.phase).toBeGreaterThanOrEqual(0);
      expect(h.orbit.phase).toBeLessThan(Math.PI * 2);
      expect(h.orbit.squash).toBeGreaterThan(0.5);
      h.destroy();
    }
  });
});
