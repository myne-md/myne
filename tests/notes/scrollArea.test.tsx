// @vitest-environment jsdom
//
// The custom scroll area (myne-md/myne#727).
//
// It exists because a `var()` inside `::-webkit-scrollbar-thumb` does NOT
// resolve against the scrolled element's cascade, it takes the root's BASE
// value, so the graph settings panel drew the LIGHT theme's thumb down a dark
// surface while every other scroller in the app looked right. The indicator is
// therefore a real element, and these are the four things a real element owes
// that the platform was giving away: the geometry, the decision to appear at
// all, the reveal, and the drag.
//
// jsdom has no layout, so the box is stubbed on the prototype. That is the point
// rather than a workaround: the component's whole job is a function of three
// integers (`clientHeight`, `scrollHeight`, `scrollTop`), and stubbing them is
// how a test drives the states that matter instead of hoping a fixture is tall
// enough.

import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScrollArea } from "../../src/components/primitives/ScrollArea";

let stubClientHeight = 0;
let stubScrollHeight = 0;
let stubScrollTop = 0;

beforeEach(() => {
  stubClientHeight = 0;
  stubScrollHeight = 0;
  stubScrollTop = 0;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return stubClientHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return stubScrollHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return stubScrollTop;
    },
    set(value: number) {
      stubScrollTop = value;
    },
  });
});

afterEach(cleanup);

describe("the indicator's gutter", () => {
  it("keeps the content out of the thumb's column", () => {
    // **jsdom has no layout, so this asserts the box that decides it.** The
    // thumb is positioned against the wrapper and drawn over the scroller's last
    // 8px, so content that reaches the end of its column has a bar across it,
    // which is what a right-aligned chat bubble did (myne-md/myne#848, on the
    // user's read). The scroller reserves the gutter as a margin, and the
    // thumb's own geometry (`inset-inline-end: 4px` + `width: 4px`) adds up to
    // the same number.
    renderArea();
    const scroller = screen.getByTestId("probe").firstElementChild as HTMLElement;
    expect(scroller.className).toContain("myne-scrollarea");
    expect(scroller.style.marginInlineEnd).toBe("var(--space-2)");
  });
});

describe("a caller that owns the scroll position", () => {
  it("gets the scroller element, and its scroll events", () => {
    // **The agent transcript's two needs** (myne-md/myne#848): it pins itself to
    // the bottom as turns arrive, and it must stop doing that the moment the
    // reader scrolls up. Both need the element; the second needs to know when it
    // moved. Two props, one relationship.
    const ref = createRef<HTMLDivElement>();
    const onScroll = vi.fn();
    render(
      <ScrollArea
        testId="probe"
        style={{ height: 100 }}
        scrollerRef={ref}
        onScroll={onScroll}
      >
        <div>content</div>
      </ScrollArea>,
    );
    expect(ref.current, "the caller never saw the scroller").not.toBeNull();
    // And it is the SCROLLER, not the wrapper: the class is what hides the
    // native bar, which is the whole reason this component exists.
    expect(ref.current!.className).toContain("myne-scrollarea");
    fireEvent.scroll(ref.current!);
    expect(onScroll).toHaveBeenCalledTimes(1);
  });

  it("keeps working with no caller attached", () => {
    // The default path, which every other consumer takes: no ref, no hook, and
    // the bar still appears when the content overflows.
    stubClientHeight = 100;
    stubScrollHeight = 400;
    renderArea();
    expect(screen.getByTestId("probe-thumb")).toBeTruthy();
  });
});

const renderArea = () =>
  render(
    <ScrollArea testId="probe" style={{ height: 100 }}>
      <div>content</div>
    </ScrollArea>,
  );

describe("ScrollArea", () => {
  it("renders no thumb at all when the content fits", () => {
    // Not "a hidden thumb": absent. A zero-height thumb that still occupies the
    // element tree is a thing a test can find and a screen reader can trip on.
    stubClientHeight = 200;
    stubScrollHeight = 180;
    renderArea();
    expect(screen.queryByTestId("probe-thumb")).toBeNull();
  });

  it("draws a thumb sized to the visible fraction, once there is overflow", () => {
    // 100 visible of 1000: a tenth of the track, floored at the grabbable
    // minimum. 100/1000 * 100 = 10, so the floor is what shows.
    stubClientHeight = 100;
    stubScrollHeight = 1000;
    renderArea();
    const thumb = screen.getByTestId("probe-thumb");
    expect(thumb.style.height).toBe("24px");
    expect(thumb.style.transform).toBe("translateY(0px)");
  });

  it("places the thumb by scroll position rather than by scroll fraction", () => {
    // The offset is a fraction of the TRAVEL (track minus thumb), not of the
    // track: using the track would put the thumb past the bottom edge at the
    // end of a scroll, which is the classic custom-scrollbar bug.
    stubClientHeight = 100;
    stubScrollHeight = 1000;
    renderArea();
    stubScrollTop = 450; // half of (1000 - 100)
    fireEvent.scroll(screen.getByTestId("probe").firstElementChild!);
    const thumb = screen.getByTestId("probe-thumb");
    expect(thumb.style.transform).toBe("translateY(38px)"); // half of (100 - 24)
  });

  it("reveals the thumb on pointer enter and hides it again on leave", () => {
    stubClientHeight = 100;
    stubScrollHeight = 1000;
    renderArea();
    const wrapper = screen.getByTestId("probe");
    const thumb = screen.getByTestId("probe-thumb");
    // Hidden by default: the bar is an affordance, not decoration.
    expect(thumb.getAttribute("data-visible")).toBe("false");
    fireEvent.pointerEnter(wrapper);
    expect(thumb.getAttribute("data-visible")).toBe("true");
    fireEvent.pointerLeave(wrapper);
    expect(thumb.getAttribute("data-visible")).toBe("false");
  });

  it("reveals the thumb on scroll, and hides it once the scrolling goes quiet", () => {
    vi.useFakeTimers();
    try {
      stubClientHeight = 100;
      stubScrollHeight = 1000;
      renderArea();
      const scroller = screen.getByTestId("probe").firstElementChild!;
      const thumb = screen.getByTestId("probe-thumb");
      fireEvent.scroll(scroller);
      expect(thumb.getAttribute("data-visible")).toBe("true");
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(thumb.getAttribute("data-visible")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drags the content 1:1 with the pointer, not with the scroll offset", () => {
    // The mapping that makes a drag feel right: the pointer's travel across the
    // thumb's OWN range (the track minus the thumb, 76px here) maps onto the
    // content's range (900px). Using the raw pointer delta would move the
    // content by 38px for a 38px drag and the thumb would outrun the hand on any
    // list longer than a screenful.
    stubClientHeight = 100;
    stubScrollHeight = 1000;
    renderArea();
    const thumb = screen.getByTestId("probe-thumb");
    thumb.setPointerCapture = () => {};
    thumb.releasePointerCapture = () => {};
    fireEvent.pointerDown(thumb, { pointerId: 1, clientY: 0 });
    // Half the thumb's travel (76 / 2 = 38) is half the content (900 / 2 = 450).
    fireEvent.pointerMove(thumb, { pointerId: 1, clientY: 38 });
    expect(stubScrollTop).toBeCloseTo(450, 5);
  });

  it("scrolls its own box, so the platform still owns the scrolling", () => {
    // The component owns the INDICATOR, not the scroll. That is deliberate: a
    // wheel, a trackpad gesture, a keyboard and a touch fling are all things the
    // platform does better, and this must not intercept any of them.
    stubClientHeight = 100;
    stubScrollHeight = 1000;
    renderArea();
    const scroller = screen.getByTestId("probe").firstElementChild!;
    expect(scroller.className).toContain("myne-scrollarea");
    expect(scroller.getAttribute("style")).toContain("overflow-y: auto");
  });
});
