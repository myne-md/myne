// KaTeX math renderer (MYND-48, task 1). Renders valid LaTeX to KaTeX HTML;
// returns an error (no throw) for invalid; block mode emits katex-display.

import { describe, expect, it } from "vitest";
import { loadMathRenderer } from "../../src/editor/math/render-math";

describe("KaTeX math renderer", () => {
  it("renders valid inline LaTeX to KaTeX HTML", async () => {
    const render = await loadMathRenderer();
    const { html, error } = render("E = mc^2", false);
    expect(error).toBeNull();
    expect(html).toContain("katex");
  });

  it("returns an error for invalid LaTeX (no throw)", async () => {
    const render = await loadMathRenderer();
    const { html, error } = render("\\frac{1}{", false);
    expect(error).not.toBeNull();
    expect(html).toBe("");
  });

  it("renders block (display) math", async () => {
    const render = await loadMathRenderer();
    const { html } = render("\\int_0^1 x\\,dx", true);
    expect(html).toContain("katex-display");
  });
});
