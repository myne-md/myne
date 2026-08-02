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

// Glob-import every locale catalog, LAZILY — one emitted chunk per locale, and
// only the two a session actually needs (English, plus the active language) are
// fetched. Adding a language is still just a new `locales/<code>/common.json`
// file plus a `SUPPORTED_LANGUAGES` entry — no edit here; the locale code comes
// from the path.
//
// Eager was the original shape and it does not survive full catalogs: the 31
// translations weigh ~7 MB of JSON, and eager put every one of them in the
// entry's static graph, i.e. in the web client's FIRST LOAD (+523 KiB gzip, 37%
// over the ratchet in `scripts/check-web-bundle-budget.mjs`). Nobody needs 30
// languages to render one. Empty catalogs are still fine: i18next falls back to
// English per key.
const catalogs = import.meta.glob<{ default: Record<string, unknown> }>(
  "../../locales/*/common.json",
);

const catalogPath = (code: string) => `../../locales/${code}/common.json`;

/** The catalog for `code`, or null if there is no such file or it fails to load. */
async function loadCatalog(code: string): Promise<Record<string, unknown> | null> {
  const loader = catalogs[catalogPath(code)];
  if (!loader) return null;
  try {
    return (await loader()).default;
  } catch {
    // A chunk that will not load must not take the app down: English is bundled
    // by the time this can happen, so the UI degrades to the fallback language
    // rather than to a blank screen.
    return null;
  }
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

// English is always loaded — it is the per-key fallback for every other locale,
// so a missing translation resolves rather than rendering a raw key.
const resources: Resource = {};
const fallbackCatalog = await loadCatalog(FALLBACK_LANGUAGE);
if (fallbackCatalog) resources[FALLBACK_LANGUAGE] = { common: fallbackCatalog };
if (initialLng !== FALLBACK_LANGUAGE) {
  const initialCatalog = await loadCatalog(initialLng);
  if (initialCatalog) resources[initialLng] = { common: initialCatalog };
}

// TOP-LEVEL AWAIT, deliberately. `main.tsx` imports this module FIRST and the
// comment there is load-bearing: i18n must be initialised before any other
// module body runs, because module-level `i18n.t(...)` calls (command catalogs,
// error maps) would otherwise freeze raw keys. A module that awaits blocks the
// evaluation of everything imported after it, which is exactly the guarantee
// the eager version got for free — so lazy catalogs cost a chunk fetch, not the
// ordering property. Do not "fix" this by moving the await into a promise the
// module exports; that hands the ordering back to every caller.
await i18n.use(initReactI18next).init({
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
  // The active locale's resources are resolved above, before init — no async
  // HTTP backend, and nothing left to wait for once this module has evaluated.
  // Suspense would never have anything to suspend on, and disabling it keeps
  // components mountable without a Suspense boundary (and renderable in unit
  // tests without extra setup).
  react: { useSuspense: false },
});

export default i18n;

/** Guards against a fast double-switch: only the newest choice may win, however
 *  long its chunk takes relative to the one before it. */
let languageSwitchSeq = 0;

/**
 * Switch the active language and persist the choice device-locally. The
 * `changeLanguage` call notifies every `useTranslation()` subscriber, so the
 * UI re-renders in the new language without a reload.
 *
 * The catalog is added BEFORE `changeLanguage`, so the switch is still atomic
 * from the UI's point of view: there is no frame in which the new language is
 * active but its strings are not loaded. Awaiting is optional — callers that
 * ignore the promise behave exactly as they did when catalogs were eager.
 */
export async function setLanguage(code: LanguageCode): Promise<void> {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    // Persistence failed (storage disabled) — the in-memory switch below still
    // applies for this session.
  }
  const seq = ++languageSwitchSeq;
  if (!i18n.hasResourceBundle(code, "common")) {
    const catalog = await loadCatalog(code);
    if (seq !== languageSwitchSeq) return; // superseded mid-fetch
    if (catalog) i18n.addResourceBundle(code, "common", catalog, true, true);
  }
  await i18n.changeLanguage(code);
}
