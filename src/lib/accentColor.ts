// Custom accent color (Appearance → Accent color).
//
// A DEVICE-LOCAL UI preference (localStorage, like the display language in
// `src/i18n`), NOT a synced/encrypted `vault.prefs` field. Two consequences that
// keep it inside the app's A6 posture:
//   1. It is APPLIED only while the vault is unlocked (the editor stage) and
//      CLEARED on lock / every non-editor stage — see `App.tsx`, alongside
//      `applyTheme`. So a locked screen never shows the user's chosen accent,
//      exactly like the theme.
//   2. The stored value is a bare color string; device-local at rest is the same
//      trust level as the language pref. (Promoting it to a synced encrypted pref
//      is a later cross-stack change.)
//
// Applied via the CSSOM (`root.style.setProperty`) — the same NOT-CSP-subject
// path `applyCustomTheme` uses. The five accent design tokens are DERIVED from
// the single chosen base with `color-mix()` (supported in the desktop WebView),
// so hover/press track the active theme automatically (mixing toward `--fg-1`
// darkens on a light theme and lightens on a dark one, matching how the built-in
// accent ramps are hand-tuned per theme). `--accent-on` is computed as black or
// white by the base's luminance so on-accent text always reads.

const ACCENT_KEY = "myne.accentColor";

/** The CSS custom properties we override for a custom accent (removed on clear). */
const ACCENT_VARS = [
  "--accent",
  "--accent-hover",
  "--accent-press",
  "--accent-soft",
  "--accent-on",
] as const;

/** Read the stored accent (a `#rrggbb` string), or `null` when unset/unavailable. */
export function readAccent(): string | null {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    return v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Persist (or clear, with `null`) the accent. Does not apply it — call
 *  {@link applyAccent} to paint. */
export function writeAccent(color: string | null): void {
  try {
    if (color === null) localStorage.removeItem(ACCENT_KEY);
    else localStorage.setItem(ACCENT_KEY, color);
  } catch {
    /* private mode / disabled storage — accent just won't persist */
  }
}

/** sRGB relative luminance (WCAG) of a `#rrggbb` color, 0..1. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const chan = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = chan((n >> 16) & 0xff);
  const g = chan((n >> 8) & 0xff);
  const b = chan(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Paint (or clear, with `null`) the custom accent on `:root`. Sets the five
 * accent tokens via the CSSOM; `null` removes them so the theme's own accent
 * shows through again.
 */
export function applyAccent(color: string | null): void {
  const root = document.documentElement;
  if (color === null || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    for (const v of ACCENT_VARS) root.style.removeProperty(v);
    return;
  }
  // On-accent ink: dark for a light accent, white for a dark one — so a checkmark
  // or a primary-button label stays legible at any chosen hue.
  const on = luminance(color) > 0.5 ? "#0b0b09" : "#ffffff";
  root.style.setProperty("--accent", color);
  // Mix toward the foreground ink so the derived shades follow the active theme's
  // light/dark direction automatically.
  root.style.setProperty(
    "--accent-hover",
    `color-mix(in srgb, ${color} 85%, var(--fg-1))`,
  );
  root.style.setProperty(
    "--accent-press",
    `color-mix(in srgb, ${color} 72%, var(--fg-1))`,
  );
  root.style.setProperty(
    "--accent-soft",
    `color-mix(in srgb, ${color} 22%, transparent)`,
  );
  root.style.setProperty("--accent-on", on);
}
