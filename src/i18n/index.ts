// i18n runtime — react-i18next initialised with statically-bundled JSON
// catalogs (no HTTP backend: translations ship inside the binary, so the
// app never makes a network request to fetch UI strings — aligned with
// Myne's no-network-by-default posture). Imported for its side effect from
// `main.tsx` before the React tree mounts.
//
// IMPORTANT — load-bearing copy stays OUT of i18n. The non-distinguishing
// security banners and honest-egress sentences in `src/lib/load-bearing-copy.ts`
// are NOT keys here: their exact wording is a privacy property (a mistranslation
// could reintroduce a distinguishing leg) and E2E asserts them by full English
// literal equality. Those constants are rendered verbatim regardless of locale.
// See `docs/dev/i18n.md` "Load-bearing copy".

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import enCommon from "../../locales/en/common.json";
import trCommon from "../../locales/tr/common.json";
import deCommon from "../../locales/de/common.json";
import frCommon from "../../locales/fr/common.json";
import {
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_CODES,
  type LanguageCode,
} from "./config";

/**
 * Pick the boot language: an explicit device-local override wins; else the
 * OS/browser locale matched by primary subtag (`tr-TR` → `tr`); else English.
 */
function detectInitialLanguage(): LanguageCode {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && SUPPORTED_CODES.includes(stored)) {
      return stored as LanguageCode;
    }
  } catch {
    // localStorage unavailable (private mode / non-browser host) — fall through.
  }
  try {
    const nav = navigator.language?.slice(0, 2).toLowerCase();
    if (nav && SUPPORTED_CODES.includes(nav)) {
      return nav as LanguageCode;
    }
  } catch {
    // navigator unavailable — fall through to the source language.
  }
  return FALLBACK_LANGUAGE;
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: enCommon },
    tr: { common: trCommon },
    de: { common: deCommon },
    fr: { common: frCommon },
  },
  lng: detectInitialLanguage(),
  fallbackLng: FALLBACK_LANGUAGE,
  defaultNS: "common",
  ns: ["common"],
  // React already escapes interpolated values — double-escaping would corrupt
  // them.
  interpolation: { escapeValue: false },
  // Treat a missing/empty translation as absent so `fallbackLng` (English)
  // fills it, rather than rendering an empty string.
  returnEmptyString: false,
  returnNull: false,
  // Resources are bundled synchronously (no async HTTP backend), so a
  // translation is ready on the first render — Suspense would never have
  // anything to wait for. Disabling it keeps components mountable without a
  // Suspense boundary (and renderable in unit tests without extra setup).
  react: { useSuspense: false },
});

export default i18n;

/**
 * Switch the active language and persist the choice device-locally. The
 * `changeLanguage` call notifies every `useTranslation()` subscriber, so the
 * UI re-renders in the new language without a reload.
 */
export function setLanguage(code: LanguageCode): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    // Persistence failed (storage disabled) — the in-memory switch below still
    // applies for this session.
  }
  void i18n.changeLanguage(code);
}
