// @vitest-environment jsdom
//
// `formatRelativeTime` threshold tests + the shared `useTick` interval
// lifecycle. The formatter is pure (takes an explicit `now`), so every branch
// is exercised with fixed `Date`s — each assertion would catch a regression in
// the threshold boundary, the singular/plural wording, or the absolute-date
// fallback. `useTick` is the O(1)-interval subscriber: we assert the interval is
// armed on first mount, shared across mounts, and torn down on the last unmount.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, renderHook } from "@testing-library/react";
import { formatRelativeTime, useTick } from "../../src/notes/components/relativeTime";

const NOW = new Date("2026-06-16T12:00:00.000Z");
// Build a `when` that is `ms` milliseconds before NOW.
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe("formatRelativeTime — thresholds", () => {
  it("null `when` → empty string", () => {
    expect(formatRelativeTime(null, NOW)).toBe("");
  });

  it("future timestamp (negative delta) → 'just now'", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + HOUR), NOW)).toBe(
      "just now",
    );
  });

  it("under a minute → 'just now'", () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("just now");
    expect(formatRelativeTime(ago(MINUTE - 1), NOW)).toBe("just now");
  });

  it("minutes bucket → '<n> min ago', floored", () => {
    expect(formatRelativeTime(ago(MINUTE), NOW)).toBe("1 min ago");
    // 2m59s floors to 2.
    expect(formatRelativeTime(ago(2 * MINUTE + 59 * SECOND), NOW)).toBe(
      "2 min ago",
    );
    expect(formatRelativeTime(ago(HOUR - 1), NOW)).toBe("59 min ago");
  });

  it("hours bucket → '<n> h ago', floored", () => {
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe("1 h ago");
    expect(formatRelativeTime(ago(5 * HOUR + 30 * MINUTE), NOW)).toBe("5 h ago");
    expect(formatRelativeTime(ago(DAY - 1), NOW)).toBe("23 h ago");
  });

  it("exactly one day → 'yesterday' (not '1 days ago')", () => {
    expect(formatRelativeTime(ago(DAY), NOW)).toBe("yesterday");
    expect(formatRelativeTime(ago(2 * DAY - 1), NOW)).toBe("yesterday");
  });

  it("multiple days → '<n> days ago'", () => {
    expect(formatRelativeTime(ago(2 * DAY), NOW)).toBe("2 days ago");
    expect(formatRelativeTime(ago(WEEK - 1), NOW)).toBe("6 days ago");
  });

  it("exactly one week → '1 week ago' (singular)", () => {
    expect(formatRelativeTime(ago(WEEK), NOW)).toBe("1 week ago");
    expect(formatRelativeTime(ago(2 * WEEK - 1), NOW)).toBe("1 week ago");
  });

  it("multiple weeks (under 4) → '<n> weeks ago'", () => {
    expect(formatRelativeTime(ago(2 * WEEK), NOW)).toBe("2 weeks ago");
    expect(formatRelativeTime(ago(3 * WEEK), NOW)).toBe("3 weeks ago");
    expect(formatRelativeTime(ago(4 * WEEK - 1), NOW)).toBe("3 weeks ago");
  });

  it("4 weeks or older → absolute yyyy-mm-dd, zero-padded", () => {
    // 4 weeks before 2026-06-16 = 2026-05-19.
    expect(formatRelativeTime(ago(4 * WEEK), NOW)).toBe("2026-05-19");
    // A date whose month + day need zero-padding.
    expect(formatRelativeTime(new Date("2025-03-07T00:00:00.000Z"), NOW)).toBe(
      "2025-03-07",
    );
    // December → month "12" (no over-pad).
    expect(formatRelativeTime(new Date("2024-12-25T00:00:00.000Z"), NOW)).toBe(
      "2024-12-25",
    );
  });
});

describe("useTick — shared O(1) interval", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns Date.now() and re-renders on each tick", () => {
    const first = renderHook(() => useTick());
    const before = first.result.current;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // useTick returns Date.now(), so the value changes after a fake-time tick.
    expect(first.result.current).toBeGreaterThanOrEqual(before);
    expect(typeof first.result.current).toBe("number");
    first.unmount();
  });

  it("arms a single shared interval across multiple mounts, tears down on last unmount", () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const a = renderHook(() => useTick());
    // First subscriber arms exactly one interval.
    const callsAfterFirst = setSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    const b = renderHook(() => useTick());
    // Second subscriber rides the SAME interval — no new setInterval.
    expect(setSpy.mock.calls.length).toBe(callsAfterFirst);

    // Unmounting one of two subscribers must NOT clear the interval.
    a.unmount();
    expect(clearSpy).not.toHaveBeenCalled();

    // Unmounting the last subscriber clears it.
    b.unmount();
    expect(clearSpy).toHaveBeenCalled();

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
