// Theme application (MYND-110) — the SINGLE place that mutates the
// `<html data-theme>` attribute.
//
// Called from two sites:
//   - `App.tsx` on every stage transition (editor entry → the stored pref;
//     any non-editor stage, incl. lock + boot → `null`).
//   - `Settings → Appearance` for an immediate in-session change.
//
// The mapping mirrors the pure-CSS hybrid in `styles/tokens.css`:
//   - "light" / "dark" / "amoled" → explicit `data-theme` attribute (overrides the OS).
//   - null (≡ system)  → REMOVE the attribute → the `prefers-color-scheme`
//     @media block follows the OS live, with zero JS matchMedia.
//
// Removing the attribute on every non-editor stage is the UI-layer image of
// zeroize-on-lock: `data-theme` present ⟺ vault unlocked & explicit pref. A
// locked vault's screen never leaks the user's chosen theme to a device
// holder (A6); pre-unlock + System both follow the OS (the only coherent
// behavior, since the explicit choice lives in the encrypted vault.prefs and
// is unknowable while locked).

import { setCustomTheme, type ThemeChoice } from "./prefs";
import { applyOrnamentAttributes, clearOrnamentAttributes } from "@myne/ornaments";
import { readAppearanceCanon } from "./themeCanon";
import { isDarkBackground } from "./syntaxTheme";
import { clampPalette, readMeasureDefaults } from "./themeMeasure";
import type { ThemePalette } from "./themes";

// The CSS-custom-property keys most recently written by `applyCustomTheme`, so
// `clearCustomTheme` removes EXACTLY those (and nothing else) on revert. A
// custom theme is applied via the CSSOM (`root.style.setProperty`), which is
// NOT subject to the `style-src` CSP and adds no inline `<style>` element — so
// custom themes need no CSP change (custom-themes epic, MYND-297; SYNC-7).
let appliedCustomKeys: string[] = [];

/** Set/remove `<html data-theme>` from a stored theme choice. `null` ≡ system. */
export function applyTheme(choice: ThemeChoice | null): void {
  // A built-in / system choice supersedes any active custom palette — clear the
  // custom CSS vars first so switching custom → built-in (or locking) reverts
  // cleanly. This is the load-bearing A6 path: `applyTheme(null)` on lock / any
  // non-editor stage removes every custom var, so a locked screen leaks neither
  // the built-in attribute NOR a custom palette.
  clearCustomTheme();
  const root = document.documentElement;
  if (choice === "light" || choice === "dark" || choice === "amoled") {
    root.setAttribute("data-theme", choice);
  } else {
    root.removeAttribute("data-theme");
  }
}

/**
 * Apply a validated custom-theme palette (a `--token → value` map from
 * `read_custom_theme`) to `:root` via the CSSOM. A custom theme OVERRIDES
 * Light/Dark/System, so the built-in `data-theme` attribute is dropped. Only
 * `--*` keys are written; the values were already value-shape-allowlist
 * validated host-side (the injection guard, MYND-111), and per-property
 * `setProperty` cannot inject a second declaration regardless.
 *
 * ── THE THEME IS A PARTIAL PALETTE, AND THAT IS WHY THE CANON IS SEEDED ─────
 * A theme file carries the 21 required tokens plus whichever optional ones its
 * author set. The shipped gallery themes carry a fraction of the sheet's colour
 * tokens and omit whole families: the dark ones set no label colour and no
 * highlight at all. Painting only the file's keys therefore left those families on
 * the built-in LIGHT values of `:root`, because dropping `data-theme` is what this
 * function does first: a dark theme came out with light-mode label chips, light
 * highlight washes, light graph group dots and light shadow scrims.
 * `deriveSyntaxTokensForTheme` (MYND-356/527) patched the syntax family of that
 * bug only, which is how the rest stayed invisible.
 *
 * So the palette is applied as `{ ...canon, ...palette }`: every token the theme
 * omits comes from the built-in canon FOR THE APPEARANCE THE THEME DECLARES, and
 * every token the theme sets keeps the author's value. The canonical set and the
 * reading rule live in `themeCanon.ts`.
 *
 * The website's theme builder is on the same rule (`myne-website#93`): its preview
 * merges the canon for the declared appearance too, over a table held to the
 * captured sheet name by name and value by value, and it retired its own port of
 * `deriveSyntaxTokensForTheme` in the same change. One difference is deliberate
 * and stays: the builder paints through its value allowlist, so the three
 * `--shadow-*` canon entries do not land there (a shadow is a multi-part value the
 * allowlist has no grammar for). Widening a security gate to close a shadow
 * difference is not a trade worth making, and the builder's own test pins which
 * tokens it skips.
 */
export function applyCustomTheme(palette: Record<string, string>): void {
  const root = document.documentElement;
  clearCustomTheme();
  // Read the built-in measure defaults BEFORE `data-theme` is dropped and while
  // no custom palette is painted — that ordering is what makes this the built-in
  // value rather than the previous theme's, and reading beats a hardcoded table
  // because it cannot drift from `tokens.css` (deep-customization, myne#394).
  const measureDefaults = readMeasureDefaults(root);
  // The appearance comes from the theme's OWN background, never from whichever
  // built-in happened to be active: a dark theme applied while Light was on still
  // needs the dark canon for the families it omits.
  const canon = readAppearanceCanon(root, palette);
  const dark = isDarkBackground(palette["--paper"] ?? "");
  root.removeAttribute("data-theme");
  root.style.setProperty("color-scheme", dark ? "dark" : "light");
  // Colour and ornament keys pass through untouched; measure keys are bounded to
  // 0.5×–2× of their default, and one that cannot be bounded (unit mismatch, no
  // known default) is skipped rather than painted unbounded — an unusable window
  // is the failure the envelope exists to prevent.
  const { applied } = clampPalette(palette, measureDefaults);
  // Ornament selections reach CSS as root attributes (CSS cannot branch on a
  // custom property's value) plus the `data-o-on` flag the layer is scoped
  // under. The shared package owns both, so no client can reflect and forget.
  applyOrnamentAttributes(root, applied);
  const keys: string[] = [];
  // Canon FIRST, palette second: the author's value always wins.
  for (const [key, value] of Object.entries({ ...canon, ...applied })) {
    // `--_o-*` is the ornament layer's private namespace — `--_o-ceiling` is the
    // bound the tint wash is clamped by. The key grammar allows `_`, so a palette
    // can carry one; the host filters it on read, and this is the second line of
    // that defence for any path that reaches here without one (myne#394).
    if (key.startsWith("--") && !key.startsWith("--_")) {
      root.style.setProperty(key, value);
      keys.push(key);
    }
  }
  appliedCustomKeys = keys;
}

/** Remove every custom-theme CSS var previously set by `applyCustomTheme`. */
export function clearCustomTheme(): void {
  const root = document.documentElement;
  for (const key of appliedCustomKeys) root.style.removeProperty(key);
  root.style.removeProperty("color-scheme");
  appliedCustomKeys = [];
  // Off with the palette: a leftover attribute would keep a locked screen wearing
  // the vault's ornament (A6), exactly like a leftover variable.
  clearOrnamentAttributes(root);
}

/**
 * Make `name` the active custom theme: persist the selection, THEN paint the
 * palette. Disk-first on purpose — a crash between the two leaves the vault
 * consistent and only the screen stale, never the reverse.
 *
 * Lives here rather than in `themes.ts` because it ends in a DOM mutation;
 * `themes.ts` is the IPC-wrapper layer.
 */
export async function activateCustomTheme(name: string, palette: ThemePalette): Promise<void> {
  await setCustomTheme(name);
  applyCustomTheme(palette);
}
