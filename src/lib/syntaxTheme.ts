// Colour-math helpers for the theme apply path: parse a CSS colour, measure its
// WCAG relative luminance, and answer whether a background counts as dark.
//
// They exist so the appearance of a custom theme is decided by MEASUREMENT of the
// theme's own `--paper`, not by whichever built-in was active when it was applied
// (MYND-356). `theme.ts::applyCustomTheme` uses `isDarkBackground` to pick which
// built-in colour canon to seed the tokens the theme omits; `SYNTAX_TOKEN_ROLES`
// is the syntax third of the optional-token roster that seed walks.
//
// Pure by design: no DOM here, so the arithmetic is testable on its own.

/** The 12 code-syntax token roles — mirrors `--syntax-*` in `styles/tokens.css`. */
export const SYNTAX_TOKEN_ROLES = [
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
] as const;

/** Parse a CSS color to 0–255 RGB, or `null` when the form is not one this
 *  detector understands.
 *
 *  Covers every form the theme value allowlist admits (`theme-validator`:
 *  three-, four-, six- and eight-digit hex, `rgb()`/`rgba()` with commas or
 *  spaces, `hsl()`/`hsla()`), because appearance classification reads the
 *  theme's own `--paper`: a form it mis-reads as unparseable makes a dark theme
 *  take the light canon, which is the defect this detector exists to prevent.
 *  A genuinely unknown form still answers `null` (the safe no-change fallback).
 */
export function parseColorToRgb(value: string): [number, number, number] | null {
  const v = value.trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3,8})$/);
  if (hex !== null) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (h.length === 6 || h.length === 8) {
      const n = Number.parseInt(h.slice(0, 6), 16);
      return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    }
    return null;
  }
  const fn = v.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
  if (fn === null) return null;
  const parts = (fn[2]!.match(/[-+]?[\d.]+%?/g) ?? []).slice(0, 3);
  if (parts.length < 3) return null;
  const nums = parts.map((t) => Number.parseFloat(t));
  if (!nums.every((n) => Number.isFinite(n))) return null;
  if (fn[1]!.startsWith("rgb")) {
    const channels = nums.map((n, i) => (parts[i]!.endsWith("%") ? (n * 255) / 100 : n));
    return channels.map((x) => Math.max(0, Math.min(255, x))) as [number, number, number];
  }
  const h = ((nums[0]! % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, nums[1]!)) / 100;
  const light = Math.max(0, Math.min(100, nums[2]!)) / 100;
  const a = sat * Math.min(light, 1 - light);
  const k = (n: number): number => (n + h / 30) % 12;
  const f = (n: number): number => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)) as [number, number, number];
}

/** WCAG relative luminance (0 = black … 1 = white) of an sRGB color. */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** True when `background` is dark — WCAG relative luminance below 0.5, the
 *  neutral midpoint (the least-arbitrary "closer to black than white" cut).
 *  Unparseable → false (keep the light default: the safe no-change fallback). */
export function isDarkBackground(background: string): boolean {
  const rgb = parseColorToRgb(background);
  return rgb !== null && relativeLuminance(rgb) < 0.5;
}
