// i18n configuration — the single source of truth for which languages the
// app ships, their human-readable labels (shown in the Settings selector),
// and the device-local storage key for the user's explicit override.
//
// English is the SOURCE language (the keys' canonical text lives in
// `locales/en/common.json`); every other locale is a translation that
// falls back to English per-key when empty. Adding a language is a
// two-step change: append it here AND add `locales/<code>/common.json`
// (start it as `{}` — Weblate fills it). See `docs/dev/i18n.md`.

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "tr", label: "Türkçe" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

/** The source language — also the per-key fallback when a translation is empty. */
export const FALLBACK_LANGUAGE: LanguageCode = "en";

/**
 * Device-local override key. Language is a UI/device preference, not vault
 * data: it must be selectable BEFORE unlock (Welcome / Unlock screens render
 * pre-vault), so it cannot live in the encrypted `vault.prefs` blob. A
 * language code is non-secret (the OS locale and the rendered UI already
 * reveal it), so `localStorage` is an acceptable home — see the i18n entry
 * in `docs/decisions.md`.
 */
export const LANGUAGE_STORAGE_KEY = "myne.lang";

export const SUPPORTED_CODES: readonly string[] = SUPPORTED_LANGUAGES.map(
  (l) => l.code,
);
