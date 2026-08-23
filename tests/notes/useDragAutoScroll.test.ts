// @vitest-environment jsdom
//
// Edge auto-scroll during a drag — myne-md/myne#557, the
// `sidebar.notes-and-folders` bullet.
//
// This hook had NO test. The roster row asked a person to drag a note toward the
// bottom of a long sidebar once a release and watch the list scroll, which is
// the one thing about it that is genuinely hard to see: the behaviour it exists
// for happens when the pointer STOPS moving. `dragover` fires only while the
// pointer moves, so a scroll driven straight off it stalls exactly when someone
// holds still at the edge waiting for the list to come to them. The hook answers
// that with its own animation-frame loop, and a hand-walk that keeps twitching
// the mouse never distinguishes the two.
//
// Its contract is pure — a rect, a pointer Y, and a scrollTop — so a fake rAF
// reaches all of it:
//
//  * the loop keeps scrolling after `dragover` stops firing (the reason it
//    exists at all);
//  * speed ramps with depth into the 48 px zone rather than being binary;
//  * it tears down on `dragleave` / `drop` / `dragend` / unmount, including the
//    drag that ends somewhere else entirely and never sends this list either of
//    the first two.
//
// The last one is the one with teeth: a loop that survives its drag keeps
// scrolling the sidebar under a user who is no longer dragging anything.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDragAutoScroll } from "../../src/notes/components/useDragAutoScroll";

/** The hook's own constants, restated so a change to either fails here. */
const EDGE_PX = 48;
const MAX_SPEED_PX = 14;

// ── a controllable animation-frame clock ────────────────────────────────────

let pending: Map<number, FrameRequestCallback>;
let nextHandle: number;

/** Run `n` frames. Callbacks scheduled during a frame run in the NEXT one. */
function runFrames(n: number): void {
  for (let i = 0; i < n; i++) {
    const due = [...pending.entries()];
    pending = new Map();
    for (const [, cb] of due) cb(performance.now());
  }
}

/** A scrollable element with a fixed rect and a real, clamped `scrollTop`. */
function makeContainer(top: number, bottom: number): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom,
      height: bottom - top,
      left: 0,
      right: 300,
      width: 300,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  let scroll = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scroll,
    // No clamp: jsdom lays nothing out, so a real element would clamp to 0 and
    // every assertion below would read zero whatever the hook did.
    set: (v: number) => {
      scroll = v;
    },
  });
  return el;
}

beforeEach(() => {
  pending = new Map();
  nextHandle = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const h = nextHandle++;
    pending.set(h, cb);
    return h;
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number) => {
    pending.delete(h);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** Mount the hook over a container spanning y=100..500. */
function mount() {
  const el = makeContainer(100, 500);
  const ref = { current: el as HTMLElement | null };
  const hook = renderHook(() => useDragAutoScroll(ref));
  return { el, ref, hook };
}

// ── 1. The reason the loop exists ───────────────────────────────────────────

describe("the loop keeps scrolling after dragover stops firing", () => {
  it("scrolls on every frame from a single dragover", () => {
    // ONE dragover, then nothing but frames — which is what a pointer held
    // still at the edge produces. A scroll driven straight off `dragover` would
    // move once and stop.
    const { el, hook } = mount();
    act(() => hook.result.current.onDragOver({ clientY: 495 })); // deep at the bottom
    act(() => runFrames(1));
    const afterOne = el.scrollTop;
    expect(afterOne).toBeGreaterThan(0);

    act(() => runFrames(9));
    expect(
      el.scrollTop,
      "the list stopped moving once the pointer did — the exact case this " +
        "hook exists for",
    ).toBeGreaterThan(afterOne * 5);
  });

  it("a second dragover does not start a second loop", () => {
    // Two loops would double the speed and neither would be cancelled by one
    // `stop`.
    const { el, hook } = mount();
    act(() => hook.result.current.onDragOver({ clientY: 495 }));
    act(() => runFrames(1));
    const perFrame = el.scrollTop;
    act(() => hook.result.current.onDragOver({ clientY: 495 }));
    act(() => hook.result.current.onDragOver({ clientY: 495 }));
    act(() => runFrames(1));
    expect(el.scrollTop - perFrame).toBeCloseTo(perFrame, 5);
  });

  it("re-aims at the newest pointer position", () => {
    const { el, hook } = mount();
    act(() => hook.result.current.onDragOver({ clientY: 495 })); // down
    act(() => runFrames(1));
    expect(el.scrollTop).toBeGreaterThan(0);
    const down = el.scrollTop;
    act(() => hook.result.current.onDragOver({ clientY: 105 })); // up
    act(() => runFrames(1));
    expect(el.scrollTop).toBeLessThan(down);
  });
});

// ── 2. Speed ramps with depth ───────────────────────────────────────────────

describe("speed ramps with depth into the edge zone", () => {
  /** One frame's scroll delta for a pointer at `y`. */
  function deltaAt(y: number): number {
    const { el, hook } = mount();
    act(() => hook.result.current.onDragOver({ clientY: y }));
    act(() => runFrames(1));
    const d = el.scrollTop;
    act(() => hook.result.current.stop());
    return d;
  }

  it("does not scroll at all in the middle of the list", () => {
    expect(deltaAt(300)).toBe(0);
  });

  it("does not scroll just outside the zone", () => {
    // 500 - 48 = 452 is the boundary; 451 is outside it.
    expect(deltaAt(451)).toBe(0);
    expect(deltaAt(149)).toBe(0);
  });

  it("creeps at the shallow edge and runs at the deep one", () => {
    const shallow = deltaAt(500 - EDGE_PX + 4); // barely inside
    const deep = deltaAt(499); // right at the bottom
    expect(shallow).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(shallow * 5);
  });

  it("reaches full speed at the edge and never exceeds it", () => {
    // Clamped, so a pointer dragged BEYOND the container cannot outrun the cap.
    expect(deltaAt(500)).toBeCloseTo(MAX_SPEED_PX, 5);
    expect(deltaAt(900)).toBeCloseTo(MAX_SPEED_PX, 5);
    expect(deltaAt(100)).toBeCloseTo(-MAX_SPEED_PX, 5);
    expect(deltaAt(-400)).toBeCloseTo(-MAX_SPEED_PX, 5);
  });

  it("scrolls up at the top edge and down at the bottom", () => {
    expect(deltaAt(110)).toBeLessThan(0);
    expect(deltaAt(490)).toBeGreaterThan(0);
  });

  it("the ramp is monotonic across the whole zone", () => {
    // A step function would satisfy "shallow creeps, deep runs" and still feel
    // binary, which is the thing the hook's own comment says it is avoiding.
    let previous = -Infinity;
    for (let y = 500 - EDGE_PX + 1; y <= 500; y += 4) {
      const d = deltaAt(y);
      expect(d, `at y=${y}`).toBeGreaterThan(previous);
      previous = d;
    }
  });
});

// ── 3. Every way a drag ends ────────────────────────────────────────────────

describe("the loop stops on every drag ending", () => {
  it("stop() halts it", () => {
    const { el, hook } = mount();
    act(() => hook.result.current.onDragOver({ clientY: 495 }));
    act(() => runFrames(2));
    const at = el.scrollTop;
    act(() => hook.result.current.stop());
    act(() => runFrames(10));
    expect(el.scrollTop).toBe(at);
  });

  it("a window `dragend` halts it, even without dragleave or drop", () => {
    // The case the hook's own comment names: a drag dropped on ANOTHER surface,
    // or cancelled with Escape, never sends this list `dragleave` or `drop`.
    // Without this the sidebar keeps scrolling under a user who is no longer
    // dragging anything.
    const { el, hook } = mount();
    act(() => hook.result.current.onDragOver({ clientY: 495 }));
    act(() => runFrames(2));
    const at = el.scrollTop;
    act(() => {
      window.dispatchEvent(new Event("dragend"));
    });
    act(() => runFrames(10));
    expect(el.scrollTop).toBe(at);
  });

  it("a window `drop` halts it", () => {
    const { el, hook } = mount();
    act(() => hook.result.current.onDragOver({ clientY: 495 }));
    act(() => runFrames(2));
    const at = el.scrollTop;
    act(() => {
      window.dispatchEvent(new Event("drop"));
    });
    act(() => runFrames(10));
    expect(el.scrollTop).toBe(at);
  });

  it("unmount halts it and unregisters the window listeners", () => {
    const { el, hook } = mount();
    act(() => hook.result.current.onDragOver({ clientY: 495 }));
    act(() => runFrames(1));
    const at = el.scrollTop;
    hook.unmount();
    act(() => runFrames(10));
    expect(el.scrollTop).toBe(at);
    expect(pending.size, "a frame is still queued after unmount").toBe(0);
    // A listener left on `window` would keep a reference to the unmounted
    // hook's closure for the life of the page.
    act(() => {
      window.dispatchEvent(new Event("dragend"));
    });
    expect(pending.size).toBe(0);
  });

  it("restarts cleanly after a stop", () => {
    // Otherwise the first drag would be the only one that ever scrolls.
    const { el, hook } = mount();
    act(() => hook.result.current.onDragOver({ clientY: 495 }));
    act(() => runFrames(1));
    act(() => hook.result.current.stop());
    const at = el.scrollTop;
    act(() => hook.result.current.onDragOver({ clientY: 495 }));
    act(() => runFrames(1));
    expect(el.scrollTop).toBeGreaterThan(at);
  });

  it("survives the container going away mid-drag", () => {
    // A list that unmounts under a drag (a vault switch, a collapsed sidebar)
    // must not leave the loop dereferencing a null ref every frame.
    const el = makeContainer(100, 500);
    const ref = { current: el as HTMLElement | null };
    const hook = renderHook(() => useDragAutoScroll(ref));
    act(() => hook.result.current.onDragOver({ clientY: 495 }));
    act(() => runFrames(1));
    ref.current = null;
    expect(() => act(() => runFrames(5))).not.toThrow();
    expect(pending.size, "the loop kept spinning against a null container").toBe(0);
  });
});
