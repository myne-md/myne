// @vitest-environment jsdom
//
// Mermaid diagram rendering (MYND-49, tasks 2+3). The decoration specializes a
// ```mermaid fence into a block widget that async-renders SVG (or falls back to
// a monospace card on error). The conformance harness stubs the loader, so this
// test dispatches a renderer directly. (Real mermaid SVG isn't rendered here —
// jsdom lacks getBBox — so we drive a fake renderer.)

import { afterEach, describe, expect, it } from "vitest";
import {
  type MermaidRenderer,
  setMermaidRenderer,
} from "../../src/editor/decorations/mermaid";
import {
  type Mounted,
  mount,
  query,
  roundTripBytes,
  teardown,
} from "./_conformance";

const tick = () => new Promise((r) => setTimeout(r, 0));

const okRenderer: MermaidRenderer = async (id, code) => ({
  svg: `<svg id="${id}" data-len="${code.length}"><g></g></svg>`,
  error: null,
});
const failRenderer: MermaidRenderer = async () => ({
  svg: "",
  error: "Parse error on line 1",
});

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

const DIAGRAM = "before\n\n```mermaid\ngraph TD\n  A-->B\n```\n";

function withMermaid(renderer: MermaidRenderer): Mounted {
  const mounted = mount(DIAGRAM, 0); // cursor off the block
  mounted.view.dispatch({ effects: setMermaidRenderer.of(renderer) });
  mounted.view.requestMeasure();
  return mounted;
}

describe("mermaid rendering", () => {
  it("specializes a ```mermaid fence into a mermaid widget (not a code card)", () => {
    m = withMermaid(okRenderer);
    expect(query(m, ".cm-mermaid")).not.toBeNull();
    // fenced-code must NOT also render a card for the mermaid block.
    expect(query(m, ".cm-code-card-body")).toBeNull();
  });

  it("renders the SVG once the async render resolves", async () => {
    m = withMermaid(okRenderer);
    await tick();
    expect(query(m, ".cm-mermaid svg")).not.toBeNull();
  });

  it("falls back to a monospace card on render error", async () => {
    m = withMermaid(failRenderer);
    await tick();
    expect(query(m, ".cm-mermaid-fallback")).not.toBeNull();
    expect(query(m, ".cm-mermaid-fallback pre")?.textContent).toContain("graph TD");
  });

  it("round-trips a mermaid block byte-identical", () => {
    expect(roundTripBytes(DIAGRAM)).toBe(DIAGRAM);
  });
});
