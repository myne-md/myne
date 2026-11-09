// @vitest-environment jsdom
// The drag phase of the long press, and the one path that used to leak
// (myne-md/myne#1037 review).
//
// `onPointerCancel` is how a long drag usually ends on a phone: without
// `touch-action: none` the browser takes the pan over mid-gesture. `onEnd` is the
// only place the caller clears its lifted row, so a cancel that skipped it left a
// row drawn at 55% opacity with nothing to put it back until the next hold.

import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHold } from "../src/app/flows/editor/chrome/useHold";

const evt = (x: number, y: number) => ({ clientX: x, clientY: y, preventDefault: () => {} });

describe("useHold drag", () => {
  it("ends the drag with moved=false when the browser cancels the pointer", () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const onStart = vi.fn();
    const { result } = renderHook(() =>
      useHold(undefined, { onStart, onEnd }),
    );
    act(() => result.current.handlers.onPointerDown(evt(10, 10)));
    act(() => vi.advanceTimersByTime(500));
    expect(onStart).toHaveBeenCalledTimes(1);
    act(() => result.current.handlers.onPointerCancel());
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]?.[1]).toBe(false);
    vi.useRealTimers();
  });

  it("reports where the finger was, so the drop can resolve", () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const { result } = renderHook(() =>
      useHold(undefined, { onStart: () => {}, onEnd }),
    );
    act(() => result.current.handlers.onPointerDown(evt(10, 10)));
    act(() => vi.advanceTimersByTime(500));
    act(() => result.current.handlers.onPointerMove(evt(40, 220)));
    act(() => result.current.handlers.onPointerCancel());
    expect(onEnd.mock.calls[0]?.[0]).toEqual({ x: 40, y: 220 });
    vi.useRealTimers();
  });

  it("does not fire an end for a gesture that never started dragging", () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const { result } = renderHook(() =>
      useHold(undefined, { onStart: () => {}, onEnd }),
    );
    act(() => result.current.handlers.onPointerDown(evt(10, 10)));
    act(() => result.current.handlers.onPointerCancel());
    expect(onEnd).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
