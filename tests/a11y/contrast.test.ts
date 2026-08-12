// Static WCAG AA contrast verification of the primary design tokens (MYND-93,
// task 8). The E2E-axe tier (task 7) checks contrast on the live render; this is
// the fast, deterministic guard at the token SOURCE — it parses the canonical
// hex values from `docs/design/colors_and_type.css` and asserts every primary
// text/control pair clears WCAG 2.1 AA (>=4.5:1) in BOTH light and dark.
//
// Per the MYND-93 decision, a contrast failure on a primary token is a design-
// canon bug fixed at the token source — `docs/design/colors_and_type.css`, with
// `DESIGN.md`/`DESIGN.json` corrected in the same change — never a per-component
// override. This test makes such a regression fail loudly.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../docs/design/colors_and_type.css", import.meta.url)),
  "utf8",
);

/** Resolve a token's literal 6-digit hex from the canon CSS. */
function hex(token: string): string {
  const m = css.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${token} not found (or not a literal hex)`);
  return m[1];
}

/** Relative luminance of an sRGB hex per WCAG 2.x. */
function luminance(h: string): number {
  const chan = (i: number) => {
    const c = parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(1) + 0.0722 * chan(2);
}

/** WCAG contrast ratio between two hex colors (1..21). */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5; // normal-text threshold

describe("primary token contrast meets WCAG AA", () => {
  // Light mode: foreground inks + accent over the paper background.
  it.each([
    ["fg-1 (ink-1)", "ink-1", "paper"],
    ["fg-2 (ink-2)", "ink-2", "paper"],
    ["fg-3 (ink-3)", "ink-3", "paper"],
    ["accent (links/focus)", "accent", "paper"],
  ])("light: %s on bg-1 clears AA", (_label, fg, bg) => {
    expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(AA);
  });

  it("light: accent-on (button label) on accent clears AA", () => {
    expect(contrast(hex("accent-on"), hex("accent"))).toBeGreaterThanOrEqual(AA);
  });

  // Dark mode: the `--_*-dark` source values.
  it.each([
    ["fg-1", "_ink-1-dark", "_paper-dark"],
    ["fg-2", "_ink-2-dark", "_paper-dark"],
    ["fg-3", "_ink-3-dark", "_paper-dark"],
    ["accent", "_accent-dark", "_paper-dark"],
  ])("dark: %s on bg-1 clears AA", (_label, fg, bg) => {
    expect(contrast(hex(fg), hex(bg))).toBeGreaterThanOrEqual(AA);
  });

  it("dark: accent-on on accent clears AA", () => {
    expect(
      contrast(hex("_accent-on-dark"), hex("_accent-dark")),
    ).toBeGreaterThanOrEqual(AA);
  });
});
