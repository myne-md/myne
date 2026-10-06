// Keyboard focus survives Windows high contrast (myne-md/myne#775).
//
// The app's focus indicator is `outline: none` plus `box-shadow: var(--ring)`.
// Under `forced-colors: active` the UA STRIPS `box-shadow` and leaves
// `outline: none` standing — so the app removes the platform's own indicator
// and then has its replacement removed from under it. Every control in the app
// loses keyboard focus indication, for exactly the users who most need it.
//
// Nothing in this tree could have caught it. `tests/a11y/` runs in jsdom, which
// has no forced-colors mode; the E2E lane runs in a Linux container against
// WebKitGTK, which has none either. So this is a source assertion rather than a
// render assertion, and it says so — what it can prove is that the repair is
// PRESENT and not silently deleted, which is the regression that would
// otherwise be invisible on every machine the project builds on.
//
// The observable half belongs to `desktop-windows` in the manual-test roster,
// which is the only surface that can actually show it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHEETS: ReadonlyArray<readonly [string, string]> = [
  ["desktop + web", "../../src/styles/tokens.css"],
  ["mobile", "../../mobile/src/styles/tokens.css"],
];

/** The body of the first `@media (forced-colors: active)` block, or null. */
function forcedColorsBlock(css: string): string | null {
  const at = css.indexOf("@media (forced-colors: active)");
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
    i++;
  }
  return css.slice(open + 1, i - 1);
}

describe("every client repairs its focus ring under forced colours", () => {
  for (const [name, rel] of SHEETS) {
    const css: string = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

    it(`${name}: has a forced-colors block at all`, () => {
      expect(
        forcedColorsBlock(css),
        "without one, keyboard focus is INVISIBLE in Windows high contrast",
      ).not.toBeNull();
    });

    it(`${name}: restores a real outline, which forced colours preserve`, () => {
      const block = forcedColorsBlock(css) ?? "";
      // `outline`, specifically. A box-shadow here would be stripped by the
      // very mode the block exists for, which is the original bug written twice.
      expect(block).toMatch(/outline:\s*2px solid Highlight/);
      expect(block).toContain("outline-offset");
      expect(block, "a box-shadow would be stripped again").not.toContain("box-shadow");
    });

    it(`${name}: covers the focusable element vocabulary, not just <button>`, () => {
      const block = forcedColorsBlock(css) ?? "";
      for (const sel of [
        "button:focus-visible",
        '[role="button"]:focus-visible',
        "input:focus-visible",
        "a:focus-visible",
        "[tabindex]:focus-visible",
      ]) {
        expect(block, `${sel} is missing from the repair`).toContain(sel);
      }
    });
  }
});

describe("state that is communicated by fill keeps its meaning", () => {
  it("opts the toggled controls out of colour substitution", () => {
    // Forced colours replace every background with the system canvas, so an
    // on/off switch, a selected segment and an unselected one become identical.
    // `forced-color-adjust: none` is the sanctioned opt-out for a control whose
    // colour IS its meaning; it is deliberately scoped to those and not applied
    // broadly, because opting the whole app out would defeat the mode.
    const css: string = readFileSync(
      fileURLToPath(new URL("../../src/styles/tokens.css", import.meta.url)),
      "utf8",
    );
    const block = forcedColorsBlock(css) ?? "";
    expect(block).toContain("forced-color-adjust: none");
    expect(block).toContain('.myne-switch[aria-checked="true"]');
  });
});
