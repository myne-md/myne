// Guards the coloring regression (MYND-154): the code HighlightStyle colors
// tokens via `var(--syntax-*)`, but those resolve only if the RUNTIME stylesheet
// the app actually loads defines them. The palette first landed only in the
// canonical source (agent-tooling/docs/design/colors_and_type.css), so code rendered
// monochrome. This test fails if the runtime tokens go missing again, in either
// theme.
//
// The runtime sheet is `client-core/src/tokens.css` since myne-md/myne#478 moved
// the palette out of the two per-client copies; every client imports it from its
// own entry point. That move is what this test caught in the branch that made
// it, which is the right failure: the path is a constant, so a palette that goes
// somewhere else fails here by name rather than being compared against a file
// that no longer holds it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css: string = readFileSync(
  new URL("../../client-core/src/tokens.css", import.meta.url),
  "utf8",
);

// The role names the code HighlightStyle maps to (code-highlight.ts).
const SYNTAX_TOKENS = [
  "keyword",
  "string",
  "comment",
  "number",
  "variable",
  "property",
  "function",
  "type",
  "operator",
  "tag",
  "meta",
  "invalid",
];

describe("runtime --syntax-* tokens (client-core/src/tokens.css)", () => {
  it("defines every --syntax-* token the code HighlightStyle references", () => {
    for (const token of SYNTAX_TOKENS) {
      expect(css).toContain(`--syntax-${token}:`);
    }
  });

  it("defines them in BOTH the light (:root) and dark ([data-theme=dark]) blocks", () => {
    const darkStart = css.indexOf('[data-theme="dark"]');
    expect(darkStart).toBeGreaterThan(0);
    const light = css.slice(0, darkStart);
    const dark = css.slice(darkStart);
    for (const token of SYNTAX_TOKENS) {
      expect(light, `light --syntax-${token}`).toContain(`--syntax-${token}:`);
      expect(dark, `dark --syntax-${token}`).toContain(`--syntax-${token}:`);
    }
  });
});
