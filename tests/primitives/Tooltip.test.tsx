// @vitest-environment jsdom
//
// `<Tooltip>` — the three behaviours that are about FEEL and so have no other
// way of being checked (myne-md/myne#773).
//
// Each was reported from use rather than found in the code, and none of them
// type-checks into existence: a tooltip that opens late, one that is cut off at
// the window edge and one that sits still while the pointer moves are all
// perfectly valid React.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Tooltip, resetTooltipWarmth } from "../../src/components/primitives/Tooltip";

/**
 * jsdom lays nothing out, so a trigger has no box and the bubble no width —
 * and both are exactly what the clamp is computed from. Stub them or the
 * assertions below are about zeroes.
 */
function placeTrigger(el: Element, rect: Partial<DOMRect>): void {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
      ...rect,
      toJSON: () => ({}),
    }) as DOMRect;
}

function bubble(): HTMLElement {
  return screen.getByRole("tooltip");
}

beforeEach(() => {
  resetTooltipWarmth();
  vi.useFakeTimers();
  // The rail's real geometry: a 40px button at the left edge of the window.
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function Harness({ label = "Open attachments…" }: { label?: string }) {
  return (
    <Tooltip label={label} placement="bottom">
      <button type="button" data-testid="trigger">
        x
      </button>
    </Tooltip>
  );
}

/** Mount, give the wrapper a box, and return the wrapper span. */
function mountAt(left: number, width = 40): HTMLElement {
  const { container } = render(<Harness />);
  const wrap = container.firstElementChild as HTMLElement;
  placeTrigger(wrap, { left, right: left + width, width, top: 100, bottom: 140, height: 40 });
  return wrap;
}

describe("a cold tooltip waits, a warm one does not", () => {
  it("does not open on the frame the pointer arrives", () => {
    const wrap = mountAt(4);
    fireEvent.mouseEnter(wrap, { clientX: 24 });
    expect(
      screen.queryByRole("tooltip"),
      "a pointer merely crossing a control must not flash its label",
    ).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole("tooltip")).not.toBeNull();
  });

  it("opens the NEXT one with no wait at all", () => {
    // The behaviour that makes a rail of icons readable: the dwell exists to
    // ignore a cursor in transit, and has no job once the user is demonstrably
    // reading labels. Paying it per button is what made scanning feel slow.
    const first = mountAt(4);
    fireEvent.mouseEnter(first, { clientX: 24 });
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByRole("tooltip")).not.toBeNull();
    fireEvent.mouseLeave(first);
    expect(screen.queryByRole("tooltip")).toBeNull();

    cleanup();
    const second = mountAt(4);
    fireEvent.mouseEnter(second, { clientX: 24 });
    expect(
      screen.queryByRole("tooltip"),
      "a second tooltip within the warm window must be instant",
    ).not.toBeNull();
  });

  it("does not warm up from a hover that never opened anything", () => {
    // A pointer that crossed a trigger without dwelling must not buy the NEXT
    // trigger an instant open, or the dwell is defeated by the exact traffic it
    // exists to ignore. Injecting the unconditional `lastClosedAt = Date.now()`
    // leaves both tests above green.
    const first = mountAt(4);
    fireEvent.mouseEnter(first, { clientX: 24 });
    fireEvent.mouseLeave(first); // left before the dwell elapsed
    cleanup();

    const second = mountAt(4);
    fireEvent.mouseEnter(second, { clientX: 24 });
    expect(
      screen.queryByRole("tooltip"),
      "a crossing must leave the next tooltip cold",
    ).toBeNull();
  });
});

describe("the bubble stays inside the window", () => {
  // Width is what the clamp is computed from, and jsdom reports 0 for every
  // element. Stubbing it on the PROTOTYPE means the bubble has a width on its
  // very first measure, so these two cases never touch the pointer-tracking
  // path — a test that needed a `mousemove` to reach the clamp would go red
  // when tracking broke, and say the wrong thing about why.
  beforeEach(() => {
    Object.defineProperty(HTMLDivElement.prototype, "offsetWidth", {
      value: 180,
      configurable: true,
    });
  });
  afterEach(() => {
    delete (HTMLDivElement.prototype as unknown as Record<string, unknown>).offsetWidth;
  });

  it("does not hang off the left edge on a rail button", () => {
    // The reported bug. The bubble was centred on the trigger with
    // `translateX(-50%)` and nothing else, so on the left ribbon — 40px buttons
    // at x≈24 — every label longer than ~48px was cut in half by the window.
    // `max-width` bounded the WIDTH and never the position.
    const wrap = mountAt(4);
    fireEvent.mouseEnter(wrap, { clientX: 24 });
    act(() => { vi.advanceTimersByTime(200); });
    expect(
      parseFloat(bubble().style.left),
      "half the bubble must not be off-screen",
    ).toBeGreaterThanOrEqual(180 / 2);
  });

  it("does not hang off the right edge either", () => {
    const wrap = mountAt(1160);
    fireEvent.mouseEnter(wrap, { clientX: 1180 });
    act(() => { vi.advanceTimersByTime(200); });
    expect(parseFloat(bubble().style.left)).toBeLessThanOrEqual(1200 - 180 / 2);
  });
});

describe("the bubble follows the pointer", () => {
  it("re-centres on the cursor's x while it moves over the trigger", () => {
    // Only x. Following on both axes puts the label under the pointer, over
    // the very thing being pointed at.
    const wrap = mountAt(400, 200);
    fireEvent.mouseEnter(wrap, { clientX: 420 });
    act(() => { vi.advanceTimersByTime(200); });
    const el = bubble();
    Object.defineProperty(el, "offsetWidth", { value: 80, configurable: true });
    fireEvent.mouseMove(wrap, { clientX: 420 });
    const before = { left: parseFloat(el.style.left), top: el.style.top };
    fireEvent.mouseMove(wrap, { clientX: 560 });
    expect(parseFloat(el.style.left), "x must track the cursor").toBeGreaterThan(
      before.left,
    );
    expect(el.style.top, "y must stay pinned to the trigger").toBe(before.top);
  });
});
