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
});
