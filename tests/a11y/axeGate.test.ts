// @vitest-environment jsdom
//
// The gate itself (myne-md/myne#728, task 17).
//
// `PRODUCT.md` has committed Myne to WCAG 2.2 AA since before this pass;
// `agent-tooling/design-notes/ui/0263` gated 2.1. The tag set is the whole of that
// difference, and it is one line, which is exactly why it needs a test: a
// merge that drops `wcag22aa` reverts the bar with nothing else changing and
// every other accessibility test in this tree still green.
//
// The other half is the axe BASELINE. `e2e/a11y-axe.e2e.ts` used to filter
// four rule ids, and the filter was by RULE rather than by node, so a rule
// with one bad node left and a rule with forty read identically. Nobody could
// tell a full fix from a partial one. It is deleted rather than emptied,
// because an empty baseline is an invitation to put something back in, and
// this spec is what notices if somebody does.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  LAYOUT_ONLY_RULES,
  WCAG_AA_TAGS,
  baseAxeOptions,
  runAxe,
} from "./axe-config";

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the bar is WCAG 2.2 AA", () => {
  it("carries the 2.2 tag, and still every tag below it", () => {
    expect(WCAG_AA_TAGS).toContain("wcag22aa");
    for (const tag of ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]) {
      expect(WCAG_AA_TAGS, `${tag} must not be dropped on the way up`).toContain(tag);
    }
  });

  it("is ONE tag set, shared by both tiers", () => {
    // The E2E helper imports this constant rather than restating it. If it
    // ever stops, the two tiers can measure different bars while both look
    // green.
    const e2e = code("e2e/support/axe.ts");
    expect(e2e).toContain("WCAG_AA_TAGS");
    expect(e2e).toContain('from "../../tests/a11y/axe-config"');
    expect(baseAxeOptions.runOnly).toEqual({ type: "tag", values: [...WCAG_AA_TAGS] });
  });
});

describe("the layout rules run in the tier that has layout", () => {
  it("names target-size beside color-contrast", () => {
    // `target-size` arrives WITH the 2.2 tag. jsdom reports every box as zero
    // by zero, so there it can only be noise.
    expect(LAYOUT_ONLY_RULES).toContain("target-size");
    expect(LAYOUT_ONLY_RULES).toContain("color-contrast");
  });

  it("disables both in jsdom, and lets only contrast be asked back", async () => {
    // `contrast: true` exists for the one spec that feeds axe a fixture with
    // explicit colours. There is no equivalent fixture for target-size, and a
    // rule measuring a zero-sized box would report on nothing.
    const div = document.createElement("div");
    div.textContent = "x";
    document.body.appendChild(div);
    const plain = await runAxe(div);
    const withContrast = await runAxe(div, { contrast: true });
    const ran = (r: Awaited<ReturnType<typeof runAxe>>): string[] =>
      [...r.passes, ...r.violations, ...r.incomplete, ...r.inapplicable].map((x) => x.id);
    expect(ran(plain)).not.toContain("color-contrast");
    expect(ran(plain)).not.toContain("target-size");
    expect(ran(withContrast)).toContain("color-contrast");
    expect(ran(withContrast), "target-size has no jsdom fixture").not.toContain(
      "target-size",
    );
    div.remove();
  });
});

describe("the axe baseline is gone", () => {
  const gate = code("e2e/a11y-axe.e2e.ts");

  it("filters nothing", () => {
    // Comments stripped: the header EXPLAINS the deletion by name, and a
    // scanner that reads prose would report on prose.
    expect(gate).not.toContain("KNOWN_PREEXISTING_DEBT");
    expect(gate).not.toContain("newViolations");
  });

  it("asserts on the violations themselves", () => {
    const asserts = gate.match(/expect\(violations, formatAxe\(violations\)\)\.toEqual\(\[\]\)/g);
    expect(asserts?.length ?? 0, "every scenario asserts the raw result").toBeGreaterThanOrEqual(5);
  });

  it("covers the screens it claims to", () => {
    // Non-vacuity: a file with the filter removed AND the scenarios removed
    // would satisfy the two rules above.
    expect((gate.match(/describeE2E\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});
