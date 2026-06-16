// @vitest-environment jsdom
//
// The `useResponsiveCollapse` ResizeObserver glue (MYND-192). The pure decision
// (`computeResponsiveCollapse`) is covered in `responsiveCollapse.test.ts`; this
// pins the HOOK branches that wrapper can't reach: the null-ref / no-observer
// pre-measure no-op, the initial synchronous measure, re-measure on observed
// resize, the state-dedup that bails a no-change tick, and observer disconnect on
// unmount.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { useResponsiveCollapse } from "../../src/screens/responsiveCollapse";

// A controllable ResizeObserver stub: capture the callback so the test can fire
// "resize" ticks, and track observe/disconnect for the lifecycle assertions.
let lastObserver: FakeResizeObserver | null = null;
const disconnectSpy = vi.fn();

class FakeResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    lastObserver = this;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    disconnectSpy();
  }
  fire(): void {
    this.cb([], this as unknown as ResizeObserver);
  }
}

function makeRef(width: number) {
  const el = document.createElement("div");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    width,
  } as DOMRect);
  const ref = createRef<HTMLDivElement>();
  (ref as { current: HTMLDivElement }).current = el;
  return { ref, el };
}

const L = 260;
const R = 280;

beforeEach(() => {
  lastObserver = null;
  disconnectSpy.mockReset();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useResponsiveCollapse", () => {
  it("forces nothing when the ref is null (pre-mount)", () => {
    const ref = createRef<HTMLDivElement>();
    const { result } = renderHook(() => useResponsiveCollapse(ref, L, R));
    expect(result.current).toEqual({
      forceLeftCollapsed: false,
      forceRightCollapsed: false,
    });
    expect(lastObserver).toBeNull(); // no observer wired without an element
  });

  it("forces nothing when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { ref } = makeRef(500);
    const { result } = renderHook(() => useResponsiveCollapse(ref, L, R));
    expect(result.current).toEqual({
      forceLeftCollapsed: false,
      forceRightCollapsed: false,
    });
  });

  it("measures immediately on mount (wide row keeps both)", () => {
    const { ref } = makeRef(1400);
    const { result } = renderHook(() => useResponsiveCollapse(ref, L, R));
    expect(result.current).toEqual({
      forceLeftCollapsed: false,
      forceRightCollapsed: false,
    });
    expect(lastObserver).not.toBeNull();
  });

  it("computes the right-first collapse on a mid-width row", () => {
    const { ref } = makeRef(700);
    const { result } = renderHook(() => useResponsiveCollapse(ref, L, R));
    expect(result.current).toEqual({
      forceLeftCollapsed: false,
      forceRightCollapsed: true,
    });
  });

  it("re-measures and updates when an observed resize narrows the row", () => {
    const { ref, el } = makeRef(1400);
    const { result } = renderHook(() => useResponsiveCollapse(ref, L, R));
    expect(result.current.forceRightCollapsed).toBe(false);

    // Shrink the element, then fire a resize tick.
    (el.getBoundingClientRect as ReturnType<typeof vi.fn>).mockReturnValue({
      width: 500,
    } as DOMRect);
    act(() => lastObserver!.fire());
    expect(result.current).toEqual({
      forceLeftCollapsed: true,
      forceRightCollapsed: true,
    });
  });

  it("keeps the SAME reference across a no-change resize tick (dedup)", () => {
    const { ref } = makeRef(1400);
    const { result } = renderHook(() => useResponsiveCollapse(ref, L, R));
    const first = result.current;
    act(() => lastObserver!.fire()); // same width → no state change
    expect(result.current).toBe(first); // identical reference (render bailed)
  });

  it("disconnects the observer on unmount", () => {
    const { ref } = makeRef(700);
    const { unmount } = renderHook(() => useResponsiveCollapse(ref, L, R));
    unmount();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });
});
