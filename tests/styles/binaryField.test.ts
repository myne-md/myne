// @vitest-environment jsdom
//
// The `01` field's exemption conditions (myne-md/myne#776, `design-notes/ui/0616`).
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
  it("lets at most two animate, and the rest paint statically", () => {
    // Empty states cluster: a fresh vault can show one in the sidebar, one in a
    // rail tab and one in the open pane simultaneously.
    const handles = [0, 1, 2, 3].map(() => mountBinaryField(makeCanvas()));
    reveal();
    expect(animatingFieldCount()).toBe(2);
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

    // And the budget still works afterwards: a corrupted count would let a
    // third field through here.
    const a = mountBinaryField(makeCanvas());
    const b = mountBinaryField(makeCanvas());
    const c = mountBinaryField(makeCanvas());
    reveal();
    expect(animatingFieldCount()).toBe(2);
    a.destroy();
    b.destroy();
    c.destroy();
  });
});
