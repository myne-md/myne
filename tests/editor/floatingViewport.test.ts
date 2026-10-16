// @vitest-environment jsdom
//
// The visible viewport, and the two numbers a docked surface derives from it
// (myne-md/myne#884).
//
// # The case that makes this module exist
//
// On iOS WKWebView the LAYOUT viewport does not shrink when the software keyboard
// opens; the visible area does. `position: fixed; bottom: 0` is the layout
// viewport's bottom, so a sheet pinned with it sits behind the keyboard, and so
// does its Save button. `visualViewport.height` and `.offsetTop` are the two
// numbers that describe the difference, and `dockGeometry` is the arithmetic that
// turns them into an inline style.
//
// The three inputs below are the three platform shapes: keyboard open on a
// viewport that does not shrink, keyboard open on one that does, and iOS having
// scrolled the page to reveal a caret.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dockGeometry,
  subscribeVisibleViewport,
  visibleViewport,
} from "@myne/editor/floating/viewport";

/** A minimal `visualViewport` stand-in: jsdom does not implement one. */
function stubVisualViewport(init: { height: number; offsetTop: number }): {
  set: (next: { height: number; offsetTop: number }) => void;
  fire: (type: "resize" | "scroll") => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  const vv = {
    height: init.height,
    offsetTop: init.offsetTop,
    addEventListener: (type: string, cb: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners.get(type)?.delete(cb);
    },
  };
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return {
    set: (next) => {
      vv.height = next.height;
      vv.offsetTop = next.offsetTop;
    },
    fire: (type) => {
      for (const cb of listeners.get(type) ?? []) cb();
    },
  };
}

/** jsdom's own layout viewport height, so an assertion does not depend on a
 *  constant the environment is free to change. */
const LAYOUT = window.innerHeight;

afterEach(() => {
  Reflect.deleteProperty(window, "visualViewport");
  vi.restoreAllMocks();
});

describe("the visible viewport reading", () => {
  it("prefers visualViewport when the platform has one", () => {
    stubVisualViewport({ height: 508, offsetTop: 0 });
    expect(visibleViewport()).toEqual({ height: 508, offsetTop: 0, layoutHeight: LAYOUT });
  });

  it("falls back to the layout viewport when the platform has none", () => {
    expect(visibleViewport()).toEqual({
      height: LAYOUT,
      offsetTop: 0,
      layoutHeight: LAYOUT,
    });
  });
});

describe("dockGeometry", () => {
  it("lifts the surface above the keyboard when the layout viewport does not shrink", () => {
    // iOS: the layout viewport stays put, 508 of it is visible, so the sheet's
    // bottom edge must rise by the difference.
    expect(dockGeometry({ height: 508, offsetTop: 0, layoutHeight: LAYOUT })).toEqual({
      maxHeight: 508,
      bottom: LAYOUT - 508,
    });
  });

  it("sits on the real bottom edge when the layout viewport does shrink", () => {
    // Android's adjustResize: innerHeight is already the visible height.
    expect(dockGeometry({ height: 508, offsetTop: 0, layoutHeight: 508 })).toEqual({
      maxHeight: 508,
      bottom: 0,
    });
  });

  it("accounts for the page having been scrolled to reveal a caret", () => {
    // iOS moving the layout viewport: the visible area starts 20px down, so the
    // sheet's bottom edge is 20px closer to the layout bottom than the height alone
    // would suggest.
    expect(dockGeometry({ height: 508, offsetTop: 20, layoutHeight: LAYOUT })).toEqual({
      maxHeight: 508,
      bottom: LAYOUT - 528,
    });
  });

  it("never asks for a negative offset", () => {
    // A platform reporting a visible area taller than the layout viewport must not
    // push the surface below the screen.
    expect(dockGeometry({ height: 900, offsetTop: 0, layoutHeight: LAYOUT }).bottom).toBe(0);
  });
});

describe("subscribing to visible-viewport changes", () => {
  it("re-reads on resize, which is the keyboard arriving or leaving", () => {
    const fake = stubVisualViewport({ height: 508, offsetTop: 0 });
    const seen: number[] = [];
    const unsubscribe = subscribeVisibleViewport((vp) => seen.push(vp.height));

    fake.set({ height: LAYOUT, offsetTop: 0 });
    fake.fire("resize");

    expect(seen).toContain(LAYOUT);
    unsubscribe();
  });

  it("re-reads on scroll, which is iOS moving the page to reveal a caret", () => {
    const fake = stubVisualViewport({ height: 508, offsetTop: 0 });
    const seen: number[] = [];
    const unsubscribe = subscribeVisibleViewport((vp) => seen.push(vp.offsetTop));

    fake.set({ height: 508, offsetTop: 20 });
    fake.fire("scroll");

    expect(seen).toContain(20);
    unsubscribe();
  });

  it("stops answering after the unsubscribe", () => {
    const fake = stubVisualViewport({ height: 508, offsetTop: 0 });
    const cb = vi.fn();
    const unsubscribe = subscribeVisibleViewport(cb);
    unsubscribe();
    fake.fire("resize");
    fake.fire("scroll");
    expect(cb).not.toHaveBeenCalled();
  });
});
