// @vitest-environment jsdom
//
// Guards the roving-tabindex rule the accessibility pass shares across every
// composite widget (myne-md/myne#728, task 1): exactly one item tabbable, arrows
// wrapping at both ends, Home/End landing on the ends, orientation honoured so
// a horizontal tab strip ignores ArrowDown, and DOM FOCUS following the active
// index rather than only the tabindex attribute moving.

import { useState, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import {
  rovingTargetIndex,
  useRovingFocus,
} from "@myne/editor/host/lib/roving-focus";

// Vitest runs without globals here, so testing-library's auto-cleanup (which
// registers on the global `afterEach`) never fires and every render would leave
// its tablist in the document.
afterEach(cleanup);

describe("rovingTargetIndex", () => {
  it("wraps forward and backward at the ends", () => {
    expect(rovingTargetIndex(3, 2, "ArrowRight")).toBe(0);
    expect(rovingTargetIndex(3, 0, "ArrowLeft")).toBe(2);
    expect(rovingTargetIndex(3, 0, "ArrowDown")).toBe(1);
    expect(rovingTargetIndex(3, 1, "ArrowUp")).toBe(0);
  });

  it("lands Home and End on the ends", () => {
    expect(rovingTargetIndex(5, 3, "Home")).toBe(0);
    expect(rovingTargetIndex(5, 1, "End")).toBe(4);
  });

  it("ignores the cross-axis key for a fixed orientation", () => {
    expect(rovingTargetIndex(3, 1, "ArrowDown", "horizontal")).toBeNull();
    expect(rovingTargetIndex(3, 1, "ArrowRight", "vertical")).toBeNull();
    expect(rovingTargetIndex(3, 1, "ArrowDown", "vertical")).toBe(2);
  });

  it("ignores keys that are not roving keys", () => {
    expect(rovingTargetIndex(3, 1, "Tab")).toBeNull();
    expect(rovingTargetIndex(3, 1, "Enter")).toBeNull();
  });

  it("returns null for an empty group and clamps a stale active index", () => {
    expect(rovingTargetIndex(0, 0, "ArrowRight")).toBeNull();
    expect(rovingTargetIndex(3, 9, "ArrowRight")).toBe(1);
  });
});

/** A minimal tablist-shaped harness: the primitive owns focus, the harness owns
 *  what "active" means (exactly as a real widget does). */
function Harness({
  count,
  initial,
  onActiveIndexChange,
}: {
  count: number;
  initial: number;
  onActiveIndexChange?: (index: number) => void;
}) {
  const [active, setActive] = useState(initial);
  const roving = useRovingFocus({
    count,
    activeIndex: active,
    orientation: "horizontal",
    itemSelector: '[role="tab"]',
    onActiveIndexChange: (index) => {
      setActive(index);
      onActiveIndexChange?.(index);
    },
  });
  return (
    <div
      ref={roving.containerRef as RefObject<HTMLDivElement>}
      role="tablist"
      aria-label="tabs"
      onKeyDown={roving.onKeyDown}
    >
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          role="tab"
          tabIndex={roving.tabIndexFor(i)}
          data-index={i}
        >
          {`t${i}`}
        </div>
      ))}
    </div>
  );
}

describe("useRovingFocus", () => {
  it("keeps exactly one item in the Tab order", () => {
    render(<Harness count={3} initial={1} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((el) => el.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("puts the Tab stop on the first item when nothing is active yet", () => {
    render(<Harness count={3} initial={-1} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((el) => el.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("moves focus and the active index on an arrow key", () => {
    const onActiveIndexChange = vi.fn();
    render(<Harness count={3} initial={0} onActiveIndexChange={onActiveIndexChange} />);
    const tabs = screen.getAllByRole("tab");
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.getAttribute("tabindex")).toBe("0");
  });

  it("wraps backward from the first item", () => {
    render(<Harness count={3} initial={0} />);
    const tabs = screen.getAllByRole("tab");
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[2]);
  });

  it("ignores the cross-axis key", () => {
    const onActiveIndexChange = vi.fn();
    render(<Harness count={3} initial={0} onActiveIndexChange={onActiveIndexChange} />);
    const tabs = screen.getAllByRole("tab");
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowDown" });
    expect(onActiveIndexChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tabs[0]);
  });
});

describe("the group's arrows belong to the group's own items", () => {
  it("ignores a key that bubbled up from a descendant that is not an item", () => {
    // The handler sits on the CONTAINER, so without a target guard it
    // swallows every arrow a descendant needs for itself: a text input, a
    // contenteditable, a nested list. Neither call site can reach that today,
    // which is why the guard belongs in the shared primitive rather than in
    // the next caller's head.
    const onActiveIndexChange = vi.fn();
    const preventDefault = vi.fn();
    const { result } = renderHook(() =>
      useRovingFocus({
        count: 3,
        activeIndex: 0,
        onActiveIndexChange,
        itemSelector: '[role="tab"]',
      }),
    );
    // A target that resolves to no item: an input inside the container.
    result.current.onKeyDown({
      key: "ArrowRight",
      preventDefault,
      target: { closest: () => null },
    });
    expect(onActiveIndexChange).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("acts when the key came from one of the items", () => {
    const onActiveIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useRovingFocus({
        count: 3,
        activeIndex: 0,
        onActiveIndexChange,
        itemSelector: '[role="tab"]',
      }),
    );
    result.current.onKeyDown({
      key: "ArrowRight",
      preventDefault: vi.fn(),
      target: { closest: () => ({}) },
    });
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
  });

  it("acts when no target is given at all, so existing callers are unchanged", () => {
    const onActiveIndexChange = vi.fn();
    const { result } = renderHook(() =>
      useRovingFocus({
        count: 3,
        activeIndex: 0,
        onActiveIndexChange,
        itemSelector: '[role="tab"]',
      }),
    );
    result.current.onKeyDown({ key: "ArrowRight", preventDefault: vi.fn() });
    expect(onActiveIndexChange).toHaveBeenCalledWith(1);
  });
});

/** Manual activation plus a shrinking count: the state that leaves
 *  `focusOverride` past the new end. */
function ShrinkHarness({ count }: { count: number }) {
  const [n, setN] = useState(count);
  const roving = useRovingFocus({
    count: n,
    activeIndex: 0,
    manualActivation: true,
    orientation: "horizontal",
    itemSelector: '[role="tab"]',
  });
  return (
    <div
      ref={roving.containerRef as RefObject<HTMLDivElement>}
      role="tablist"
      aria-label="tabs"
      onKeyDown={roving.onKeyDown}
    >
      <button data-testid="shrink" onClick={() => setN((v) => v - 1)} />
      {Array.from({ length: n }, (_, i) => (
        <div key={i} role="tab" tabIndex={roving.tabIndexFor(i)} data-index={i}>
          {`t${i}`}
        </div>
      ))}
    </div>
  );
}

describe("useRovingFocus when the group shrinks", () => {
  it("keeps exactly one Tab stop when the focused item is removed", () => {
    // Under manual activation the hook owns the focused index. Arrow to the
    // LAST tab, then close it: the count drops while `focusOverride` still
    // points at the old last index. Without a clamp `tabIndexFor` matches no
    // item, the group loses its single `tabIndex=0`, and the whole strip drops
    // out of the Tab order. jsdom's fixture can hold this because it shrinks
    // the count under a focused override, which is the state the defect needs.
    render(<ShrinkHarness count={3} />);
    let tabs = screen.getAllByRole("tab");
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    // focusOverride is now 2 (the last item).
    fireEvent.click(screen.getByTestId("shrink"));
    tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    const stops = tabs.map((el) => el.getAttribute("tabindex"));
    expect(stops.filter((v) => v === "0")).toHaveLength(1);
  });
});
