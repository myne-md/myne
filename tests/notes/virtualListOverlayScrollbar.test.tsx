// @vitest-environment jsdom
//
// The sidebar tree's scroll indicator (myne-md/myne#867, on the user's read:
// "hide the sidebar's scroll bar when idle too"). The native bar follows the OS
// setting and never hides on a Mac set to always show scroll bars, so the tree
// opts into the app's own `ScrollArea`, whose indicator shows on hover, focus
// and scroll only. The saved views keep the native bar, so the mode is opt-in.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { VirtualList } from "../../src/notes/components/VirtualList";

afterEach(cleanup);

// jsdom has no `ResizeObserver`, and VirtualList observes its container; a
// no-op stub is enough for asserting which scroller it mounted.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

const ITEMS = ["a", "b", "c"];

function rowsOf(container: HTMLElement): HTMLElement {
  // The element that scrolls: the ScrollArea's scroller in the overlay mode
  // (the rows sit in one wrapper inside it), the rows' own parent otherwise.
  const row = container.querySelector("[data-vrow-key]") as HTMLElement;
  return (row.closest(".myne-scrollarea") as HTMLElement | null) ?? (row.parentElement as HTMLElement);
}

describe("VirtualList: the overlay scrollbar mode", () => {
  it("scrolls inside the app's ScrollArea when asked to", () => {
    const { container } = render(
      <VirtualList items={ITEMS} renderItem={(i) => <span>{i}</span>} overlayScrollbar />,
    );
    expect(screen.getByText("a")).toBeDefined();
    expect(rowsOf(container).className).toContain("myne-scrollarea");
  });

  it("keeps the native scroller by default", () => {
    const { container } = render(
      <VirtualList items={ITEMS} renderItem={(i) => <span>{i}</span>} />,
    );
    const scroller = rowsOf(container);
    expect(scroller.className).not.toContain("myne-scrollarea");
    expect(scroller.style.overflowY).toBe("auto");
  });

  it("keeps the native scroller when the list scrolls sideways", () => {
    // The primitive draws no horizontal indicator, so the table's sideways
    // scroll would have no bar at all.
    const { container } = render(
      <VirtualList
        items={ITEMS}
        renderItem={(i) => <span>{i}</span>}
        overlayScrollbar
        overflowX="auto"
      />,
    );
    expect(rowsOf(container).className).not.toContain("myne-scrollarea");
  });
});

// The connection that matters (myne-md/myne#867 review, D9): the virtualizer
// must listen to the element that actually scrolls. Drop `scrollerRef` from the
// overlay branch and ScrollArea falls back to its own ref, so the tree stops
// moving its window as the user scrolls, which a three-item list never shows.
describe("VirtualList: the overlay scroller drives the virtual window", () => {
  it("renders later rows once the ScrollArea scroller is scrolled", async () => {
    const proto = HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 300 });
    try {
      const items = Array.from({ length: 500 }, (_, i) => `r${i}`);
      const { container } = render(
        <VirtualList items={items} renderItem={(i) => <span>{i}</span>} estimatedRowHeight={30} overlayScrollbar />,
      );
      expect(container.querySelector('[data-vrow-key="r200"]')).toBeNull();
      const scroller = rowsOf(container);
      scroller.scrollTop = 6000;
      await act(async () => {
        scroller.dispatchEvent(new Event("scroll"));
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(container.querySelector('[data-vrow-key="r200"]')).not.toBeNull();
      expect(container.querySelector('[data-vrow-key="r0"]')).toBeNull();
    } finally {
      if (original) Object.defineProperty(proto, "clientHeight", original);
      else delete (proto as { clientHeight?: number }).clientHeight;
    }
  });
});
