// i18n runtime — react-i18next over JSON catalogs that ship inside the binary.
// There is no HTTP backend and no translation server: nothing here reaches a
// third party, which is the property that matters for Myne's
// no-network-by-default posture. Non-English catalogs are separate chunks of
// the SAME bundle, so on the web client the active one is fetched from the app's
// own origin at boot (on desktop it is read off disk); on neither client does a
// UI string come from anywhere but the build the user already has. Imported for
// its side effect from `main.tsx` before the React tree mounts.
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

// ENGLISH IS STATIC; every other catalog is a lazy chunk.
//
// The split is not an optimisation detail, it is what makes the failure modes
// survivable. English is the per-key fallback for all 30 translations, so if it
// were fetched and the fetch failed, `t()` would return its own dotted key for
// EVERY string — a fully-booted app rendering `unlock.submit` and
// `welcome.createCta`, with nothing thrown, nothing logged and no fail-closed
// screen. Importing it statically makes that state unreachable again: English
// arrives with the entry chunk or the app does not start at all, exactly as it
// behaved when the whole glob was eager.
//
// The other 30 are lazy because eager does not survive full catalogs: the
// translations weigh ~7 MB of JSON, and eager put all of them in the entry's
// static graph, i.e. in the web client's FIRST LOAD (1922.5 KiB gzip, 37% over
// the ratchet in `scripts/check-web-bundle-budget.mjs`). Nobody needs 30
// languages to render one, and a translation chunk that fails to load has a
// correct answer available — fall back to the English that is already here.
//
// Adding a language is still just a new `locales/<code>/common.json` file plus a
// `SUPPORTED_LANGUAGES` entry; the locale code comes from the glob path. Empty
// catalogs remain fine: i18next falls back to English per key.
import enCatalog from "../../locales/en/common.json";

const catalogs = import.meta.glob<{ default: Record<string, unknown> }>(
  "../../locales/*/common.json",
);

const catalogPath = (code: string) => `../../locales/${code}/common.json`;

/** The catalog for `code`, or null if there is no such file or it fails to load.
 *  Never called for English — see the static import above. */
async function loadCatalog(code: string): Promise<Record<string, unknown> | null> {
  const loader = catalogs[catalogPath(code)];
  if (!loader) return null;
  try {
    return (await loader()).default;
  } catch {
    // A translation chunk that will not load must not take the app down, and it
    // does not have to: English is in the entry chunk, so the UI degrades to the
    // fallback language rather than to raw keys or a blank screen.
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

// INITIALISE SYNCHRONOUSLY, with English, before anything can await.
//
// `main.tsx` imports this module first because module-level `i18n.t(...)` calls
// (command catalogs, error maps) must resolve against loaded resources instead
// of freezing raw keys. What actually delivers that is the DEPENDENCY EDGE: every
// such module does `import i18n from "../i18n"`, so its body cannot run until
// this one has. It is NOT delivered by the top-level await below — a synchronous
// sibling with no edge to this module (e.g. `main.tsx`'s
// `@myne/editor/drawing/excalidraw-asset-path`) executes while an async sibling
// is still suspended; that is ordinary `InnerModuleEvaluation` behaviour, not a
// quirk. Keeping `init` above the first await is what makes the edge sufficient:
// by the time any importer's body runs, `i18n.t` answers in English at worst.
//
// So: do not move this init below the await, and do not rely on the await for
// ordering. The await exists for the ACTIVE LOCALE only, and `main.tsx`'s own
// body (the React mount) does wait for it, because a parent module does wait for
// its async dependencies.
i18n.use(initReactI18next).init({
  resources: { [FALLBACK_LANGUAGE]: { common: enCatalog } } as Resource,
  lng: FALLBACK_LANGUAGE,
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
  // English is bundled and the active locale is installed below, before this
  // module finishes evaluating — so by the time anything renders there is
  // nothing left to wait for. Suspense would never have anything to suspend on,
  // and disabling it keeps components mountable without a Suspense boundary
  // (and renderable in unit tests without extra setup).
  react: { useSuspense: false },
});

// Now the active locale, if it is not the one already installed. This is the
// module's only await, and `main.tsx` mounts React after it settles.
if (initialLng !== FALLBACK_LANGUAGE) {
  const initialCatalog = await loadCatalog(initialLng);
  if (initialCatalog) {
    i18n.addResourceBundle(initialLng, "common", initialCatalog, true, true);
    await i18n.changeLanguage(initialLng);
  }
  else {
    // The chunk failed to load. Stay on English — correct text in the wrong
    // language is the honest degradation — and put `<html dir lang>` back in
    // step with what is actually rendering, which the optimistic call above set
    // to the locale we did not get. Leaving `dir="rtl"` on English text would be
    // a worse artefact than the untranslated text itself. The stored preference
    // is untouched, so the next launch retries.
    applyDocumentDirection(FALLBACK_LANGUAGE);
  }
}

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
 *
 * Resolves `true` when the language actually changed, `false` when the
 * translation chunk could not be loaded (the UI stays on the previous language)
 * or when a later `setLanguage` superseded this one mid-fetch. The persisted
 * preference is written FIRST and kept even on failure: the user asked for this
 * language, a chunk fetch that failed once is likely to succeed next launch, and
 * silently reverting their stored choice would hide the problem rather than fix
 * it.
 */
export async function setLanguage(code: LanguageCode): Promise<boolean> {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    // Persistence failed (storage disabled) — the in-memory switch below still
    // applies for this session.
  }
  const seq = ++languageSwitchSeq;
  if (!i18n.hasResourceBundle(code, "common")) {
    const catalog = await loadCatalog(code);
    if (seq !== languageSwitchSeq) return false; // superseded mid-fetch
    if (!catalog) return false; // chunk unavailable — stay where we are
    i18n.addResourceBundle(code, "common", catalog, true, true);
  }
  await i18n.changeLanguage(code);
  return true;
}
