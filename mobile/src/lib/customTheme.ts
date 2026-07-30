// Custom-palette application (mobile, MYND-598) — the SINGLE place that writes
// a vault custom theme's CSS variables onto the document root.
//
// The palettes arrive from `listCustomThemes()` (`themes.ts`), which reads them
// out of the encrypted `vault.themes` blob sync already delivers here. Mobile
// authors none of them; this module only paints one.
//
// Two constraints shape the implementation:
//
//   - **CSSOM, not a `<style>` element.** Writing each property with
//     `root.style.setProperty` keeps custom themes off the CSP's `style-src`
//     surface entirely — no inline stylesheet is created, so no CSP relaxation
//     is needed for a feature whose values are user-supplied. Per-property
//     `setProperty` also cannot smuggle a second declaration the way a
//     concatenated CSS string could.
//   - **Track what was written.** `clearCustomTheme` must remove exactly the
//     keys the last apply wrote — no more (it would clobber inline properties
//     other code owns) and no fewer (a locked screen would keep wearing the
//     vault's palette, which is far more revealing about vault contents than a
//     light/dark attribute; A6).
//
// The built-in light/dark/amoled attribute is `platform/theme.ts`'s job. The two
// meet only here: a custom theme OVERRIDES the built-in choice, so applying one
// drops `data-theme`.

import { deriveSyntaxTokensForTheme } from "@myne/syntax-theme";

import type { ThemePalette } from "./themes";

/** The CSS custom-property keys most recently written by `applyCustomTheme`. */
let appliedCustomKeys: string[] = [];

/**
 * Paint a custom-theme palette onto `:root` via the CSSOM, replacing whatever
 * palette was applied before it. Only `--*` keys are written — a palette map is
 * vault content and may carry non-token bookkeeping keys, which have no business
 * reaching the style attribute.
 *
 * A custom theme supersedes Light/Dark/System, so the built-in `data-theme`
 * attribute is removed; leaving it would let a built-in rule win a specificity
 * contest against the palette on tokens the palette does not define.
 */
export function applyCustomTheme(palette: ThemePalette): void {
  const root = document.documentElement;
  clearCustomTheme();
  root.removeAttribute("data-theme");

  const keys: string[] = [];
  for (const [key, value] of Object.entries(palette)) {
    if (key.startsWith("--")) {
      root.style.setProperty(key, value);
      keys.push(key);
    }
  }

  // A dark custom theme that defines no `--syntax-*` role of its own would
  // inherit the built-in LIGHT syntax colors and render code blocks unreadable.
  // The shared derivation (main repo `src/lib/syntaxTheme.ts`, aliased as
  // `@myne/syntax-theme`) aliases each role the palette OMITS to the design-tuned
  // `--_syntax-*-dark` ramp that `styles/tokens.css` defines unconditionally, and
  // returns `{}` for a light theme. Per-role rather than all-or-nothing: the
  // gallery themes define only 5 of the 12, and an all-or-nothing gate leaves the
  // other 7 wrong (desktop's MYND-527).
  //
  // Applied AFTER the palette so it can never clobber a role the theme chose,
  // and tracked in the same key list so the revert below covers it too.
  for (const [key, value] of Object.entries(deriveSyntaxTokensForTheme(palette))) {
    root.style.setProperty(key, value);
    keys.push(key);
  }

  appliedCustomKeys = keys;
}

/** Remove every custom-theme CSS variable the last `applyCustomTheme` wrote. */
export function clearCustomTheme(): void {
  const root = document.documentElement;
  for (const key of appliedCustomKeys) root.style.removeProperty(key);
  appliedCustomKeys = [];
}
