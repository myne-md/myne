// @vitest-environment jsdom
//
// The type page's role pairing (myne-md/myne#847 task 13).
//
// A size on its own is half a specimen: the same `--text-3xl` at
// `--leading-tight` is a heading and at `--leading-relaxed` a pull quote. The
// page reads the pairing out of the component sheet's `.t-*` blocks, so this
// asserts that reading rather than the hand-copied table it replaced.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseTypeRoles } from "../../stories/src/stories/foundations";

describe("the type role reader", () => {
  it("reads the three properties that make a step on the scale", () => {
    const css = `
      .t-h1 {
        font-family: var(--font-display);
        font-size: var(--text-3xl);
        line-height: var(--leading-tight);
        font-weight: var(--weight-semibold);
      }
    `;
    expect(parseTypeRoles(css)).toEqual([
      {
        role: "t-h1",
        size: "var(--text-3xl)",
        leading: "var(--leading-tight)",
        weight: "var(--weight-semibold)",
        tracking: "",
        transform: "",
      },
    ]);
  });

  it("skips a block that is not a step on the scale", () => {
    // `.t-mono` is a family variant: it carries no `font-size`, and rendering
    // it would put a duplicate line in the specimen whose size is a lie.
    const css = `
      .t-mono { font-family: var(--font-mono); font-size: var(--text-sm); }
      .t-nofont { font-family: var(--font-mono); }
    `;
    expect(parseTypeRoles(css).map((r) => r.role)).toEqual(["t-mono"]);
  });

  it("carries an optional tracking and transform when the role declares them", () => {
    const css = `.t-eyebrow { font-size: var(--text-xs); letter-spacing: var(--tracking-caps); text-transform: uppercase; }`;
    const [role] = parseTypeRoles(css);
    expect(role.tracking).toBe("var(--tracking-caps)");
    expect(role.transform).toBe("uppercase");
  });

  it("finds the roles in the sheet that ships", () => {
    // The non-vacuity half: the parser must read the real file, not just a
    // fixture. A rename of the `.t-` prefix would otherwise leave the page
    // rendering nothing while every fixture case above still passed.
    //
    // Read from disk rather than through `?raw`: Vitest resolves a `.css`
    // import to an empty module, so the `?raw` form the component uses at build
    // time is empty here and an assertion on it would prove nothing.
    const css: string = readFileSync("src/styles/tokens.css", "utf8");
    expect(css.length).toBeGreaterThan(1000);
    const roles = parseTypeRoles(css).map((r) => r.role);
    expect(roles).toContain("t-h1");
    expect(roles).toContain("t-body");
    expect(roles).toContain("t-caption");
  });
});
