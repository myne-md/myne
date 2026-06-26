// Regression guard for the load-bearing global focus ring (MYND-93, task 4).
//
// The audit found focus-ring coverage already comprehensive: every keyboard-
// focusable control shows an indicator via the global `:focus-visible` rule
// (native + [tabindex] + [role="button"]), a relocated wrapper ring (search
// pills, recovery-phrase cells), or an element-specific `:focus-visible`
// outline (CodeMirror buttons). The single most load-bearing piece is the
// global rule in tokens.css — if it is ever silently deleted, EVERY standard
// control loses its ring at once. This test pins it (DESIGN.json: "Always
// visible, never removed").

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tokensCss = readFileSync(
  fileURLToPath(new URL("../../src/styles/tokens.css", import.meta.url)),
  "utf8",
);
const colorsCss = readFileSync(
  fileURLToPath(new URL("../../docs/design/colors_and_type.css", import.meta.url)),
  "utf8",
);

describe("global focus ring (load-bearing)", () => {
  it("applies var(--ring) on :focus-visible to every standard interactive selector", () => {
    // Isolate the global focus-visible block and assert it paints the ring.
    const block = tokensCss.slice(
      tokensCss.indexOf("button:focus-visible"),
    );
    for (const selector of [
      "button:focus-visible",
      '[role="button"]:focus-visible',
      "input:focus-visible",
      "textarea:focus-visible",
      "select:focus-visible",
      "a:focus-visible",
      "[tabindex]:focus-visible",
    ]) {
      expect(tokensCss, `missing focus-visible selector: ${selector}`).toContain(
        selector,
      );
    }
    expect(block).toContain("box-shadow: var(--ring)");
  });

  it("defines the --ring token in the design-canon CSS", () => {
    expect(colorsCss).toMatch(/--ring:\s*0 0 0 2px var\(--bg-1\), 0 0 0 4px var\(--accent\)/);
  });
});
