// MYND-356 (design-neutral half): pick the ALREADY-DESIGNED light-vs-dark code-
// syntax palette for a custom theme by its background's WCAG luminance.
//
// The FULL 356 — deriving syntax HUES from a theme's accent/palette — is a
// design decision owned by the theme gallery (MYND-346), and this module does
// NOT invent colors. It closes the concrete readability gap: a custom theme that
// omits its own `--syntax-*` tokens currently inherits the built-in LIGHT syntax
// palette, which is unreadable on a dark theme. Here we detect whether the
// theme's background is dark and, if so, alias the syntax tokens to the existing
// `--_syntax-*-dark` raw ramp (the same design-tuned, AA-checked values the
// built-in dark theme uses, defined unconditionally in `:root`) — reusing
// approved colors, inventing none. A theme that ships its OWN `--syntax-*` (a
// future gallery theme) is left untouched; a light theme keeps the light default.

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

/** Parse a CSS color (`#rgb` / `#rrggbb` / `rgb()`/`rgba()`) to 0–255 RGB, or
 *  `null` when the form is not one this detector understands. */
export function parseColorToRgb(value: string): [number, number, number] | null {
  const v = value.trim();
  const hex = v.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hex !== null) {
    let h = hex[1]!;
    if (h.length === 3) {
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    }
    const n = Number.parseInt(h, 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb !== null) {
    const c: [number, number, number] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (c.every((x) => Number.isFinite(x))) {
      return c.map((x) => Math.max(0, Math.min(255, x))) as [number, number, number];
    }
  }
  return null;
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

/**
 * The `--syntax-*` overrides to apply for a custom-theme `palette`, or `{}` for
 * none. Returns aliases to the built-in dark syntax ramp ONLY when the theme
 * (a) does not define any `--syntax-*` token itself AND (b) has a dark
 * background (`--paper`, a required core token). Pure — no DOM; the apply path
 * (`theme.ts::applyCustomTheme`) writes the result via the CSSOM.
 */
export function deriveSyntaxTokensForTheme(
  palette: Record<string, string>,
): Record<string, string> {
  const providesSyntax = Object.keys(palette).some((k) => k.startsWith("--syntax-"));
  if (providesSyntax) return {};
  const background = palette["--paper"];
  if (background === undefined || !isDarkBackground(background)) return {};
  const out: Record<string, string> = {};
  for (const role of SYNTAX_TOKEN_ROLES) {
    out[`--syntax-${role}`] = `var(--_syntax-${role}-dark)`;
  }
  return out;
}
