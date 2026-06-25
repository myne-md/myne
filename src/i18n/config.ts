// i18n configuration — the single source of truth for which languages the
// app ships and their native labels (shown in the Settings selector).
//
// English is the SOURCE language (the keys' canonical text lives in
// `locales/en/common.json`); every other locale is a translation that falls
// back to English per-key when empty. Adding a language is a two-step change:
// append it here AND add `locales/<code>/common.json` (start it as `{}` — run
// `pnpm i18n:extract`, then Weblate fills it). `src/i18n/index.ts` glob-loads
// every catalog, so no import edit is needed there. See `docs/dev/i18n.md`.
//
// Scope: the curated set that the self-hosted LibreTranslate MT engine loads
// (LibreTranslate has no lazy model loading and the host RAM is bounded, so
// not all 49 Argos languages are shipped). RTL languages (ar/he/fa/ur) are
// deferred until the UI has RTL layout support. Labels are in each language's
// own script/orthography.

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "cs", label: "Čeština" },
  { code: "da", label: "Dansk" },
  { code: "de", label: "Deutsch" },
  { code: "el", label: "Ελληνικά" },
  { code: "es", label: "Español" },
  { code: "fi", label: "Suomi" },
  { code: "fr", label: "Français" },
  { code: "hu", label: "Magyar" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "it", label: "Italiano" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "nb", label: "Norsk bokmål" },
  { code: "nl", label: "Nederlands" },
  { code: "pl", label: "Polski" },
  { code: "pt", label: "Português" },
  { code: "ro", label: "Română" },
  { code: "ru", label: "Русский" },
  { code: "sv", label: "Svenska" },
  { code: "tr", label: "Türkçe" },
  { code: "uk", label: "Українська" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "zh", label: "中文" },
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
 * in `design-notes.md`.
 */
export const LANGUAGE_STORAGE_KEY = "myne.lang";

export const SUPPORTED_CODES: readonly string[] = SUPPORTED_LANGUAGES.map(
  (l) => l.code,
);
