// Theme application (MYND-110) — the SINGLE place that mutates the
// `<html data-theme>` attribute.
//
// Called from two sites:
//   - `App.tsx` on every stage transition (editor entry → the stored pref;
//     any non-editor stage, incl. lock + boot → `null`).
//   - `Settings → Appearance` for an immediate in-session change.
//
// The mapping mirrors the pure-CSS hybrid in `styles/tokens.css`:
//   - "light" / "dark" → explicit `data-theme` attribute (overrides the OS).
//   - null (≡ system)  → REMOVE the attribute → the `prefers-color-scheme`
//     @media block follows the OS live, with zero JS matchMedia.
//
// Removing the attribute on every non-editor stage is the UI-layer image of
// zeroize-on-lock: `data-theme` present ⟺ vault unlocked & explicit pref. A
// locked vault's screen never leaks the user's chosen theme to a device
// holder (A6); pre-unlock + System both follow the OS (the only coherent
// behavior, since the explicit choice lives in the encrypted vault.prefs and
// is unknowable while locked).

import type { ThemeChoice } from "./prefs";

/** Set/remove `<html data-theme>` from a stored theme choice. `null` ≡ system. */
export function applyTheme(choice: ThemeChoice | null): void {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") {
    root.setAttribute("data-theme", choice);
  } else {
    root.removeAttribute("data-theme");
  }
}
