// @vitest-environment jsdom
//
// Vitest-axe structural tracer (MYND-93, task 1). Proves the Vitest tier of the
// accessibility gate works end-to-end:
//   1. a real interactive component (the Select primitive) passes the WCAG AA
//      structural/ARIA rule set, and
//   2. the gate has teeth — a deliberately name-less control is flagged.
//
// Contrast is intentionally out of scope here (jsdom can't compute it); the
// E2E tier owns contrast. Further per-screen a11y specs build on this harness.

import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Select, type SelectOption } from "../../src/components/primitives/Select";
import { runAxe, formatViolations } from "./axe-config";

afterEach(() => cleanup());

type Flavor = "a" | "b" | "c";
const OPTIONS: readonly SelectOption<Flavor>[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie" },
];

describe("a11y gate — Vitest tier", () => {
  it("a labelled interactive primitive has zero structural/ARIA violations", async () => {
    const { container } = render(
      <Select
        value={"a" as Flavor}
        options={OPTIONS}
        onChange={() => {}}
        aria-label="Flavor"
      />,
    );
    const results = await runAxe(container);
    expect(results.violations, formatViolations(results)).toEqual([]);
  });

  it("flags a control with no accessible name (the gate has teeth)", async () => {
    const { container } = render(
      <div>
        <button type="button" />
      </div>,
    );
    const results = await runAxe(container);
    const ids = results.violations.map((v) => v.id);
    expect(ids).toContain("button-name");
  });
});
