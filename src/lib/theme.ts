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
import { deriveSyntaxTokensForTheme } from "./syntaxTheme";
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
 */
export function applyCustomTheme(palette: Record<string, string>): void {
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
  // MYND-356: a DARK custom theme's syntax roles that lack an override would else
  // inherit the built-in LIGHT syntax colors (unreadable on a dark surface).
  // Alias those roles to the design-tuned dark ramp instead — reusing approved
  // colors, deriving light-vs-dark from the theme's own background luminance.
  // Applied AFTER the palette so it never clobbers a role the theme set itself;
  // `deriveSyntaxTokensForTheme` fills only the roles the theme omits (MYND-527:
  // per-role, since the gallery themes define just 5 of 12) and returns `{}` for
  // a light theme. Tracked in `keys` so `clearCustomTheme` reverts them on
  // switch/lock.
  for (const [key, value] of Object.entries(deriveSyntaxTokensForTheme(palette))) {
    root.style.setProperty(key, value);
    keys.push(key);
  }
  appliedCustomKeys = keys;
}

/** Remove every custom-theme CSS var previously set by `applyCustomTheme`. */
export function clearCustomTheme(): void {
  const root = document.documentElement;
  for (const key of appliedCustomKeys) root.style.removeProperty(key);
  appliedCustomKeys = [];
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
