// @vitest-environment jsdom
//
// Math rendering (MYND-48, tasks 3+4). Inline `$…$` + block `$$…$$` render via
// KaTeX; invalid LaTeX shows source + a subtle error hint; cursor-reveal; byte-
// stable. The conformance harness stubs the renderer loader (never-resolve), so
// this test dispatches a real renderer directly.

import { afterEach, describe, expect, it } from "vitest";
import katex from "katex";
import {
  type MathRenderer,
  setMathRenderer,
} from "../../src/editor/decorations/math";
import {
  type Mounted,
  focusAt,
  mount,
  query,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

const renderer: MathRenderer = (latex, display) => {
  try {
    return {
      html: katex.renderToString(latex, {
        displayMode: display,
        throwOnError: true,
        output: "html",
      }),
      error: null,
    };
  } catch (e) {
    return { html: "", error: e instanceof Error ? e.message : String(e) };
  }
};

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

function withMath(doc: string, pos?: number): Mounted {
  const mounted = mount(doc, pos);
  mounted.view.dispatch({ effects: setMathRenderer.of(renderer) });
  mounted.view.requestMeasure();
  return mounted;
}

describe("inline math", () => {
  it("renders $E = mc^2$ as a KaTeX inline widget", () => {
    m = withMath("the $E = mc^2$ formula\n");
    expect(query(m, ".cm-math-inline")).not.toBeNull();
    expect(query(m, ".cm-math-inline .katex")).not.toBeNull();
    expect(renderedText(m)).not.toContain("$E = mc^2$");
  });

  it("reveals the raw $…$ source on-cursor", () => {
    m = withMath("a $x^2$ b\n");
    focusAt(m, 3); // inside $x^2$
    expect(renderedText(m)).toContain("$x^2$");
  });
});

describe("block math", () => {
  it("renders $$…$$ as a KaTeX display block", () => {
    m = withMath("text before\n\n$$\\int_0^1 x\\,dx$$\n", 0); // cursor off the block
    expect(query(m, ".cm-math-block")).not.toBeNull();
  });
});

describe("invalid LaTeX", () => {
  it("shows the source with an error hint (no throw, no broken render)", () => {
    m = withMath("bad $\\frac{1}{$ end\n");
    const err = query(m, ".cm-math-error");
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain("\\frac{1}{");
    expect(err!.getAttribute("title")).not.toBe("");
  });
});

describe("byte stability", () => {
  it("round-trips inline + block math + currency unchanged", () => {
    const doc = "$E=mc^2$ costs $5 and $$x+y$$ in $ € £\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});
