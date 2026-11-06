// @vitest-environment jsdom
//
// `AnchoredPanel` and the surfaces that moved onto it (myne-md/myne#867).
//
// Two claims, and both are about a defect that shipped:
//
//   1. **The panel is drawn in the BODY, not inside its trigger's ancestors.**
//      The original case was the memory popover, a hand-written
//      `position: absolute` box inside the chat header's button: the chat panel
//      is narrower than the box, so the card grew leftward past the panel edge
//      and the panel's `overflow` cut its text off. Nothing could see it: the card
//      and every word in it were in the DOM the whole time, and a test that finds
//      one by testid passes on a panel the user cannot read. That popover is gone
//      (myne-md/myne#1020 removed its button), and the claim is the primitive's,
//      so it is held here by the two surfaces that still wear it.
//   2. **A panel wider than its anchor is pulled back inside the window.** `left`
//      is clamped against the ANCHOR's box in the first pass, and the panel's own
//      box is decided by its content, so a wide panel overhung the edge the
//      clamp was measured against.
//
// jsdom does not lay out, so the rectangles in the second test are INJECTED. The
// injection has to be able to express the overhanging case, which is why it
// stubs the panel's own box rather than the anchor's alone: a fixture that can
// only describe a narrow panel cannot hold the defect.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";

import { AnchoredPanel } from "../../src/components/primitives/AnchoredPanel";
import { UsedInNotesPopover } from "../../src/components/attachments/UsedInNotesPopover";


afterEach(cleanup);

/** A rectangle with the fields the placement code reads. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    width,
    height,
    top,
    left,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * Give specific elements a box. Everything else keeps jsdom's zero rectangle,
 * so the only boxes in play are the ones a test states out loud.
 */
function stubRects(byTestId: Record<string, DOMRect>): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const id = this.getAttribute("data-testid") ?? "";
    const box = byTestId[id];
    return box ?? original.call(this);
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

/** The panel's own `left`/`max-width`, as the component wrote them. */
function placement(el: HTMLElement): { left: number; right: number } {
  const left = Number.parseFloat(el.style.left.replace("px", ""));
  const width = Number.parseFloat(el.style.maxWidth.replace("px", ""));
  return { left, right: left + width };
}

/** A panel on a trigger inside a clipping ancestor: the shape both defects need. */
function Harness({
  children,
  onClose = () => {},
  point = null,
  align,
  maxWidth,
}: {
  children?: React.ReactNode;
  onClose?: () => void;
  point?: { x: number; y: number } | null;
  align?: "start" | "end";
  maxWidth?: number;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  return (
    <div data-testid="narrow" style={{ overflow: "hidden", width: 200 }}>
      <span ref={anchorRef} data-testid="anchor" style={{ display: "inline-flex" }}>
        trigger
      </span>
      <AnchoredPanel
        open
        onClose={onClose}
        anchorRef={anchorRef}
        point={point}
        align={align}
        maxWidth={maxWidth}
        testId="panel"
      >
        {children}
      </AnchoredPanel>
    </div>
  );
}

describe("AnchoredPanel: where the panel is drawn", () => {

  it("draws in the body, outside the ancestor whose overflow used to clip it", async () => {
    render(<Harness>body text</Harness>);
    const panel = await screen.findByTestId("panel");
    expect(document.body.contains(panel)).toBe(true);
    expect(screen.getByTestId("narrow").contains(panel)).toBe(false);
  });

  it("closes on Escape, and there is exactly ONE handler for it", async () => {
    // The memory popover used to install its own Escape listener beside this
    // one, so a single press closed the card twice (myne-md/myne#867). The
    // assertion is the call count, not the close: a second handler would still
    // close it, and would still be wrong.
    const onClose = vi.fn();
    render(<Harness onClose={onClose}>body</Harness>);
    await screen.findByTestId("panel");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pulls a panel wider than its anchor back inside the window", async () => {
    // The anchor sits near the right edge, so the first pass places the panel at
    // `innerWidth - minWidth - EDGE`; the panel then turns out to be 420 wide,
    // which overhangs by 104px and must be pulled back.
    const innerWidth = window.innerWidth;
    const restore = stubRects({
      anchor: rect(innerWidth - 44, 60, 20, 20),
      panel: rect(0, 0, 420, 200),
    });
    try {
      render(<Harness>wide</Harness>);
      const panel = await screen.findByTestId("panel");
      await waitFor(() => {
        // The panel's real width is the 420 its content wants (capped by the
        // window, which it is not here), so the invariant is `left + 420`.
        expect(placement(panel).left + 420).toBeLessThanOrEqual(innerWidth - 8);
      });
    } finally {
      restore();
    }
  });

  it("caps the panel at the caller's maxWidth rather than at the window's", async () => {
    // The caller's cap travels as a PROP, not through `style`: the placement
    // writes its own `maxWidth` last, so a `style` value would be dropped and a
    // long note title would stretch the popover to the window's width.
    render(<Harness maxWidth={320}>wide</Harness>);
    const panel = await screen.findByTestId("panel");
    expect(Number.parseFloat(panel.style.maxWidth)).toBe(320);
  });
});

describe("AnchoredPanel: a cursor point (a context menu)", () => {
  // The shape the attachments library's right-click menu uses: the point is a
  // zero-size trigger, so it gets the same flip and the same edge clamp as an
  // anchored panel instead of a second copy of that arithmetic.
  it("opens with its left edge at the pointer, not at the anchor", async () => {
    render(
      <Harness point={{ x: 400, y: 200 }} align="start">
        item
      </Harness>,
    );
    const panel = await screen.findByTestId("panel");
    // The anchor is at the document's origin (jsdom lays nothing out), so an
    // ANCHORED panel would land at EDGE; only the point can put it at 400.
    expect(Number.parseFloat(panel.style.left)).toBe(400);
    // `placeMenu` keeps its gap below the trigger, and here the point is the
    // trigger.
    expect(Number.parseFloat(panel.style.top)).toBe(204);
  });

  it("clamps a point near the right edge back inside the window", async () => {
    const innerWidth = window.innerWidth;
    render(
      <Harness point={{ x: innerWidth - 10, y: 200 }} align="start">
        item
      </Harness>,
    );
    const panel = await screen.findByTestId("panel");
    // Default `minWidth` is 160, so the clamp caps `left` at innerWidth - 168.
    expect(Number.parseFloat(panel.style.left)).toBe(innerWidth - 160 - 8);
  });
});

describe("UsedInNotesPopover: it uses the primitive", () => {
  function Harness() {
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    return (
      <div data-testid="tile" style={{ overflow: "hidden", width: 120 }}>
        <button ref={anchorRef} data-testid="attachments.used-in-notes-trigger">
          Used in 0 notes
        </button>
        <UsedInNotesPopover
          noteIds={[]}
          cache={new Map()}
          onJump={() => {}}
          onClose={() => {}}
          anchorRef={anchorRef}
        />
      </div>
    );
  }

  it("draws its list in the body, outside the tile that would clip it", async () => {
    render(<Harness />);
    const menu = await screen.findByRole("menu");
    // The tile clips (`overflow: hidden`) and the grid scrolls; both are why the
    // panel is portaled rather than positioned inside its trigger.
    expect(screen.getByTestId("tile").contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    // The panel is the primitive's, and it carries THIS caller's cap (320)
    // rather than the window's — the maxWidth the popover names as a prop.
    const panel = menu.parentElement as HTMLElement;
    expect(Number.parseFloat(panel.style.maxWidth)).toBe(320);
    // The empty state is the locale's own copy, so the list is really rendered.
    expect(menu.textContent).toBe("Not used in any note.");
  });
});
