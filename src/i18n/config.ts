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
// not all 49 Argos languages are shipped). Labels are in each language's own
// script/orthography.
//
// RTL: layout direction follows the active locale (it is NOT a separate user
// setting). {@link RTL_LANGUAGES} is the single machine-readable source of that
// truth, consumed by the desktop chrome (`src/i18n/index.ts` sets
// `documentElement.dir`), the editor's neutral-note fallback, and the mobile
// client (which imports this same module). See `myne-agents/epics/rtl-support`.

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" }, // RTL
  { code: "bn", label: "বাংলা" },
  { code: "cs", label: "Čeština" },
  { code: "da", label: "Dansk" },
  { code: "de", label: "Deutsch" },
  { code: "el", label: "Ελληνικά" },
  { code: "es", label: "Español" },
  { code: "fa", label: "فارسی" }, // RTL
  { code: "fi", label: "Suomi" },
  { code: "fr", label: "Français" },
  { code: "hi", label: "हिन्दी" },
  { code: "hu", label: "Magyar" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "it", label: "Italiano" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "nb", label: "Norsk bokmål" },
  { code: "nl", label: "Nederlands" },
  { code: "pa", label: "ਪੰਜਾਬੀ" }, // LTR (Gurmukhi) — NOT in RTL_LANGUAGES
  { code: "pl", label: "Polski" },
  { code: "pt", label: "Português" },
  { code: "ro", label: "Română" },
  { code: "ru", label: "Русский" },
  { code: "sv", label: "Svenska" },
  { code: "sw", label: "Kiswahili" },
  { code: "th", label: "ไทย" },
  { code: "tr", label: "Türkçe" },
  { code: "uk", label: "Українська" },
  { code: "ur", label: "اردو" }, // RTL
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
 * in `docs/decisions.md`.
 */
export const LANGUAGE_STORAGE_KEY = "myne.lang";

export const SUPPORTED_CODES: readonly string[] = SUPPORTED_LANGUAGES.map(
  (l) => l.code,
);

/**
 * Locales whose script is right-to-left. The one source of truth for direction
 * across both clients (SYNC-1, `myne-agents/epics/rtl-support`).
 *
 * Membership is by SCRIPT, not by whether the locale ships yet: Arabic, Urdu and
 * Persian (Perso-Arabic script) are RTL. Note the two easy mistakes this set is
 * written to avoid — Punjabi (`pa`) defaults to Gurmukhi and is **LTR** (its
 * Shahmukhi variant would be RTL, but `pa`/`pa-IN` is Gurmukhi); Hebrew (`he`)
 * is RTL by script and is listed here so it resolves correctly if ever added as
 * a UI locale, even though it is not in `SUPPORTED_LANGUAGES` today.
 */
export const RTL_LANGUAGES: ReadonlySet<string> = new Set([
  "ar", // Arabic
  "ur", // Urdu
  "fa", // Persian / Farsi
  "he", // Hebrew (script-RTL; not a shipped UI locale yet)
]);

/** True if `code`'s script is right-to-left. Matches the primary subtag, so
 *  `ar-EG` resolves the same as `ar`. */
export function isRtl(code: string | null | undefined): boolean {
  if (!code) return false;
  return RTL_LANGUAGES.has(code.slice(0, 2).toLowerCase());
}

/** The document direction (`"rtl"` / `"ltr"`) for a locale code. */
export function directionFor(code: string | null | undefined): "rtl" | "ltr" {
  return isRtl(code) ? "rtl" : "ltr";
}
