// MYND-356 (design-neutral half): light-vs-dark syntax-palette selection for a
// custom theme by its background luminance. Pure logic — no DOM.

import { describe, expect, it } from "vitest";
import {
  SYNTAX_TOKEN_ROLES,
  deriveSyntaxTokensForTheme,
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
  it("returns null for unparseable forms", () => {
    expect(parseColorToRgb("hsl(200 50% 50%)")).toBeNull();
    expect(parseColorToRgb("var(--paper)")).toBeNull();
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

describe("deriveSyntaxTokensForTheme", () => {
  const DARK_CORE = { "--paper": "#101014" };
  const LIGHT_CORE = { "--paper": "#fbfbf7" };

  it("a dark theme WITHOUT its own syntax tokens gets the dark ramp aliases", () => {
    const out = deriveSyntaxTokensForTheme(DARK_CORE);
    expect(Object.keys(out)).toHaveLength(SYNTAX_TOKEN_ROLES.length);
    expect(out["--syntax-keyword"]).toBe("var(--_syntax-keyword-dark)");
    expect(out["--syntax-invalid"]).toBe("var(--_syntax-invalid-dark)");
  });

  it("a LIGHT theme gets no override (keeps the light default)", () => {
    expect(deriveSyntaxTokensForTheme(LIGHT_CORE)).toEqual({});
  });

  it("a role the theme defines itself is never overridden; omitted roles still fill", () => {
    const out = deriveSyntaxTokensForTheme({
      ...DARK_CORE,
      "--syntax-keyword": "#ff00ff",
    });
    // The theme's own keyword is left untouched; the other 11 roles fill.
    expect(out["--syntax-keyword"]).toBeUndefined();
    expect(Object.keys(out)).toHaveLength(SYNTAX_TOKEN_ROLES.length - 1);
    expect(out["--syntax-string"]).toBe("var(--_syntax-string-dark)");
    expect(out["--syntax-invalid"]).toBe("var(--_syntax-invalid-dark)");
  });

  it("a partial-set dark theme (gallery shape: 5 of 12 roles) fills the other 7", () => {
    // MYND-527: the shipped gallery themes define keyword/string/comment/number/
    // function only — the remaining 7 roles must still get the dark ramp.
    const provided = ["keyword", "string", "comment", "number", "function"];
    const palette: Record<string, string> = { ...DARK_CORE };
    for (const role of provided) palette[`--syntax-${role}`] = "#abcdef";
    const out = deriveSyntaxTokensForTheme(palette);
    expect(Object.keys(out)).toHaveLength(SYNTAX_TOKEN_ROLES.length - provided.length);
    for (const role of provided) expect(out[`--syntax-${role}`]).toBeUndefined();
    for (const role of ["variable", "property", "type", "operator", "tag", "meta", "invalid"]) {
      expect(out[`--syntax-${role}`]).toBe(`var(--_syntax-${role}-dark)`);
    }
  });

  it("a dark theme that ships ALL 12 roles gets no override", () => {
    const palette: Record<string, string> = { ...DARK_CORE };
    for (const role of SYNTAX_TOKEN_ROLES) palette[`--syntax-${role}`] = "#abcdef";
    expect(deriveSyntaxTokensForTheme(palette)).toEqual({});
  });

  it("a LIGHT theme with a partial syntax set still gets no override", () => {
    // Light background → keep the light `:root` defaults for the omitted roles.
    expect(
      deriveSyntaxTokensForTheme({ ...LIGHT_CORE, "--syntax-keyword": "#123456" }),
    ).toEqual({});
  });

  it("a theme with no --paper gets no override", () => {
    expect(deriveSyntaxTokensForTheme({ "--accent": "#123456" })).toEqual({});
  });
});
