// Colour-math helpers the theme apply path uses to decide an appearance: parse a
// CSS colour, measure its WCAG luminance, and answer "is this background dark".
// Pure logic, no DOM. The palette SEEDING that consumes them lives in
// `theme.ts::applyCustomTheme` (it reads the canon off the live stylesheet, so it
// needs a document and cannot be tested here).

import { describe, expect, it } from "vitest";
import {
  isDarkBackground,
  parseColorToRgb,
  relativeLuminance,
} from "../../src/lib/syntaxTheme";

describe("parseColorToRgb", () => {
  it("parses #rrggbb", () => {
    expect(parseColorToRgb("#1a2b3c")).toEqual([0x1a, 0x2b, 0x3c]);
  });
  it("parses shorthand #rgb", () => {
    expect(parseColorToRgb("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
  });
  it("parses rgb()/rgba() and clamps", () => {
    expect(parseColorToRgb("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
    expect(parseColorToRgb("rgba(300, 0, 0, 0.5)")).toEqual([255, 0, 0]);
  });
  it("parses every form the theme value allowlist admits", () => {
    // 8-digit hex, space-separated rgb() and hsl() are all admitted by
    // `theme-validator`, so a theme may legitimately declare its `--paper` in
    // any of them. Classifying one as unreadable made a dark theme take the
    // LIGHT canon, which is the whole defect this detector guards.
    expect(parseColorToRgb("#0e0e10ff")).toEqual([0x0e, 0x0e, 0x10]);
    expect(parseColorToRgb("rgb(16 16 20)")).toEqual([16, 16, 20]);
    expect(parseColorToRgb("hsl(240 20% 8%)")).toEqual([16, 16, 24]);
    expect(parseColorToRgb("hsl(200 50% 50%)")).toEqual([64, 149, 191]);
  });
  it("returns null for forms it cannot read", () => {
    expect(parseColorToRgb("var(--paper)")).toBeNull();
    expect(parseColorToRgb("currentColor")).toBeNull();
    expect(parseColorToRgb("")).toBeNull();
  });
});

describe("relativeLuminance + isDarkBackground", () => {
  it("black is dark, white is light", () => {
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
    expect(isDarkBackground("#000000")).toBe(true);
    expect(isDarkBackground("#ffffff")).toBe(false);
  });
  it("a near-black paper is dark, a near-white paper is light", () => {
    expect(isDarkBackground("#0a0a0a")).toBe(true); // built-in dark paper
    expect(isDarkBackground("#faf8f3")).toBe(false); // built-in light paper
  });
  it("unparseable background is treated as NOT dark (safe fallback)", () => {
    expect(isDarkBackground("var(--paper)")).toBe(false);
  });
});
