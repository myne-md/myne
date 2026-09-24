// @vitest-environment jsdom
//
// The bounded mermaid viewer (myne-md/myne#708): the viewBox read, the session
// key, and the DOM shape the control bar owes E2E. jsdom has no layout, so the
// pan/zoom maths is covered by `image-zoom.test.ts` and the controller's own
// paths are exercised in the running app; what is asserted here is what a driver
// can see and what the guard rails depend on.

import { describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import {
  buildMermaidViewer,
  mermaidNaturalSize,
  mermaidSourceKey,
} from "../../editor/src/decorations/mermaid-viewer";
import { mermaidZoomStore } from "../../editor/src/attachments/session-caches";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgWithViewBox(box: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", box);
  return svg;
}

function fakeView(): EditorView {
  return {
    scrollDOM: { clientHeight: 500 },
    requestMeasure() {},
  } as unknown as EditorView;
}

const TESTIDS = [
  "editor.mermaid.zoom-in",
  "editor.mermaid.zoom-out",
  "editor.mermaid.reset",
  "editor.mermaid.pan-up",
  "editor.mermaid.pan-down",
  "editor.mermaid.pan-left",
  "editor.mermaid.pan-right",
  "editor.mermaid.edit",
  "editor.mermaid.expand",
];

describe("mermaidNaturalSize", () => {
  it("reads the width and height off the viewBox", () => {
    expect(mermaidNaturalSize(svgWithViewBox("0 0 800 600"))).toEqual({ w: 800, h: 600 });
    expect(mermaidNaturalSize(svgWithViewBox("0,0,12,7"))).toEqual({ w: 12, h: 7 });
  });

  it("refuses a box it cannot read, and one over the availability cap", () => {
    for (const box of ["", "0 0 800", "0 0 a b", "0 0 -1 10", "0 0 20001 10", "0 0 10 20001"]) {
      expect(mermaidNaturalSize(svgWithViewBox(box))).toBeNull();
    }
  });
});

describe("mermaidSourceKey", () => {
  it("is stable for one source and distinct across sources", () => {
    const code = "flowchart LR\n  A --> B";
    expect(mermaidSourceKey(code)).toBe(mermaidSourceKey(code));
    expect(mermaidSourceKey("a")).not.toBe(mermaidSourceKey("b"));
  });
});

describe("buildMermaidViewer", () => {
  it("wraps the LIVE svg in a viewport and renders the control bar", () => {
    const card = document.createElement("div");
    const svg = svgWithViewBox("0 0 400 200");
    card.appendChild(svg);

    const viewer = buildMermaidViewer({
      view: fakeView(),
      card,
      code: "graph TD\n  A --> B",
      onEdit: () => {},
    });

    expect(viewer).not.toBeNull();
    const viewport = card.querySelector(".cm-mermaid-viewport");
    expect(viewport).not.toBeNull();
    // The same node, moved, never cloned or re-serialised (threat-model §7).
    expect(viewport?.querySelector("svg")).toBe(svg);
    for (const tid of TESTIDS) {
      expect(card.querySelector(`[data-testid="${tid}"]`)).not.toBeNull();
    }
    // Every control carries an accessible name.
    for (const button of card.querySelectorAll(".cm-mermaid-control")) {
      expect(button.getAttribute("aria-label")).toBeTruthy();
    }
    viewer?.destroy();
  });

  it("leaves the card exactly as drawn when the viewBox is unreadable", () => {
    const card = document.createElement("div");
    const svg = svgWithViewBox("");
    card.appendChild(svg);
    const viewer = buildMermaidViewer({
      view: fakeView(),
      card,
      code: "not a diagram",
      onEdit: () => {},
    });
    expect(viewer).toBeNull();
    expect(card.querySelector(".cm-mermaid-viewport")).toBeNull();
    expect(card.querySelector("svg")).toBe(svg);
  });

  it("routes the edit control to the callback", () => {
    const card = document.createElement("div");
    card.appendChild(svgWithViewBox("0 0 100 100"));
    let edits = 0;
    buildMermaidViewer({
      view: fakeView(),
      card,
      code: "graph TD\n  A --> B",
      onEdit: () => {
        edits += 1;
      },
    });
    (card.querySelector('[data-testid="editor.mermaid.edit"]') as HTMLElement).click();
    expect(edits).toBe(1);
  });

  it("a BARE wheel over the viewport is handled and zooms (#742)", () => {
    // jsdom has no layout: measure() would read clientWidth 0, init() would
    // return with bounds === null, and every wheel would early-return. That is
    // a fixture that can never reach the state under test (myne-md/myne#613's
    // vacuous-fixture shape). Stub the box dims the mermaid measure path and
    // computeBounds read so bounds resolve for real.
    //
    // Fixture numbers, chosen so the assertions below are exact rather than
    // approximate: stage 640x275 (capHeight = 500 * 0.55 = 275), viewBox
    // 400x200 → fitW 550, naturalW 400 → hundredPercentK 1, restK 1, so the
    // rest percent is 100 and each wheel moves it measurably.
    const proto = Element.prototype;
    const savedW = Object.getOwnPropertyDescriptor(proto, "clientWidth");
    const savedH = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 640 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 275 });
    try {
      const card = document.createElement("div");
      // Attached, because the assertion below is about a handler HOISTED to the
      // document: a card that never entered the tree could not be seen by one,
      // so the negative path would pass for the wrong reason.
      document.body.appendChild(card);
      const svg = svgWithViewBox("0 0 400 200");
      card.appendChild(svg);
      const code = "graph TD\n  A --> B";
      const viewer = buildMermaidViewer({
        view: fakeView(),
        card,
        code,
        onEdit: () => {},
      });
      const viewport = card.querySelector(".cm-mermaid-viewport") as HTMLElement | null;
      expect(viewport).not.toBeNull();

      const key = mermaidSourceKey(code);
      mermaidZoomStore.delete(key);

      const wheel = (deltaY: number): WheelEvent => {
        const e = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
        viewport!.dispatchEvent(e);
        return e;
      };

      // The claim of #742 in one assertion: a bare wheel (no ctrl/meta) is
      // HANDLED, not passed through to the note's scroller. wheel: "modifier"
      // returns before preventDefault on this event, so both this line and the
      // store write below go red the moment the mode reverts.
      const zoomIn = wheel(-100);
      expect(zoomIn.defaultPrevented).toBe(true);
      const up = mermaidZoomStore.get(key);
      expect(up, "the bare wheel committed no zoom percent").toBeDefined();
      expect(up!).toBeGreaterThan(100);

      // And it is a zoom, in the wheel's own direction: scrolling back down
      // returns the percent toward rest. One-directional commits would pass
      // the assertions above.
      const zoomOut = wheel(100);
      expect(zoomOut.defaultPrevented).toBe(true);
      const down = mermaidZoomStore.get(key);
      expect(down!).toBeLessThan(up!);

      // The scope half of the claim: a wheel OUTSIDE the viewport (on the card,
      // which is where the note's scroller sits relative to the widget) is not
      // ours. It must not be preventDefaulted, and it must commit nothing. A
      // handler hoisted to the document would pass every assertion above while
      // breaking "the note keeps scrolling everywhere else", so the card is
      // attached and the event is dispatched at it for that reason.
      const outside = new WheelEvent("wheel", {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      card.dispatchEvent(outside);
      expect(outside.defaultPrevented).toBe(false);
      expect(mermaidZoomStore.get(key)).toBe(down!);

      viewer?.destroy();
      card.remove();
    } finally {
      if (savedW) Object.defineProperty(proto, "clientWidth", savedW);
      else delete (proto as unknown as Record<string, unknown>).clientWidth;
      if (savedH) Object.defineProperty(proto, "clientHeight", savedH);
      else delete (proto as unknown as Record<string, unknown>).clientHeight;
    }
  });
});
