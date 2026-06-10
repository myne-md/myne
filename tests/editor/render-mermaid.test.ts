// Mermaid renderer lazy-load + contract (MYND-49, task 1). The real SVG render
// needs a browser layout engine (jsdom lacks getBBox), so this covers the
// loader contract + the error/fallback path via the test loader override.

import { describe, expect, it } from "vitest";
import {
  loadMermaidRenderer,
  setMermaidLoader,
} from "../../src/editor/mermaid/render-mermaid";

describe("mermaid renderer contract", () => {
  it("lazy-loads a renderer and returns SVG on success", async () => {
    const restore = setMermaidLoader(
      async () => async (id, code) => ({
        svg: `<svg id="${id}">${code.length}</svg>`,
        error: null,
      }),
    );
    const render = await loadMermaidRenderer();
    const { svg, error } = await render("m1", "graph TD; A-->B");
    expect(error).toBeNull();
    expect(svg).toContain("<svg");
    restore();
  });

  it("returns an error (no throw) on a render failure → caller falls back", async () => {
    const restore = setMermaidLoader(
      async () => async () => ({ svg: "", error: "Parse error" }),
    );
    const render = await loadMermaidRenderer();
    const { svg, error } = await render("m2", "not a diagram");
    expect(svg).toBe("");
    expect(error).toBe("Parse error");
    restore();
  });
});
