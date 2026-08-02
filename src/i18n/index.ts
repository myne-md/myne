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

import i18n, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import {
  directionFor,
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_CODES,
  type LanguageCode,
} from "./config";

// Glob-import every locale catalog (eager → bundled, no async). Adding a
// language is then just a new `locales/<code>/common.json` file plus a
// `SUPPORTED_LANGUAGES` entry — no edit here. The locale code comes from the
// path. Empty catalogs are fine: i18next falls back to English per key.
const catalogs = import.meta.glob<{ default: Record<string, unknown> }>(
  "../../locales/*/common.json",
  { eager: true },
);
const resources: Resource = {};
for (const [path, mod] of Object.entries(catalogs)) {
  const code = /\/locales\/([^/]+)\/common\.json$/.exec(path)?.[1];
  if (code) resources[code] = { common: mod.default };
}

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

/**
 * Reflect a locale's writing direction onto the document root: `<html dir>` +
 * `<html lang>`. This is what makes the whole shared UI mirror for RTL locales
 * (`ar`/`ur`/`fa`) via CSS logical properties + `[dir="rtl"]` rules.
 *
 * Direction follows the LANGUAGE, which is device-local and rendered pre-unlock
 * (Welcome/Unlock screens are already translated). It therefore does NOT clear
 * on vault lock — unlike the theme, which lives in the encrypted `vault.prefs`
 * and is zeroized on lock to avoid an A6 personalization leak. `dir` reveals
 * nothing the already-rendered translated strings don't. (SYNC-2.)
 */
function applyDocumentDirection(code: string): void {
  if (typeof document === "undefined") return; // non-DOM host (e.g. worker/tests without jsdom)
  const root = document.documentElement;
  root.setAttribute("dir", directionFor(code));
  root.setAttribute("lang", code);
}

const initialLng = detectInitialLanguage();
applyDocumentDirection(initialLng);

// Keep `<html dir>` in step with any language change, however it is triggered
// (the setLanguage() path below, or a direct i18n.changeLanguage()).
i18n.on("languageChanged", (lng) => applyDocumentDirection(lng));

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLng,
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
