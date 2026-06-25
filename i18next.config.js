// i18next-cli config — scans the React source for `t("…")` calls and keeps the
// locale catalogs in sync. Run `pnpm i18n:extract` (or `pnpm i18n:status` for a
// translation-progress summary).
//
// `locales/en/common.json` is the SOURCE catalog (hand-maintained English).
// Extraction ADDS newly-introduced keys; `removeUnusedKeys: false` means a key
// a translator/Weblate already filled is never deleted by a scan. After
// running, fill any new English value in `locales/en/common.json`, commit, and
// Weblate picks up the new source string on its next pull.
//
// See `docs/dev/i18n.md` for the full add-a-string workflow.

import { defineConfig } from "i18next-cli";

export default defineConfig({
  locales: ["en", "tr", "de", "fr"],
  extract: {
    input: ["src/**/*.{ts,tsx}"],
    output: "locales/{{language}}/{{namespace}}.json",
    // English is the source language: its catalog is hand-maintained and is
    // the per-key runtime fallback for every other locale.
    primaryLanguage: "en",
    defaultNS: "common",
    // Dots nest keys (`unlock.title` → { unlock: { title } }); we always use
    // the default `common` namespace, so disable the `:` namespace separator.
    keySeparator: ".",
    nsSeparator: false,
    // Stable, Weblate-friendly ordering.
    sort: true,
    // Never silently drop a key still present in a translation file — pruning a
    // removed-in-code key is a deliberate, by-hand edit.
    removeUnusedKeys: false,
    // A new key lands with an empty value: visibly unfilled in English (the dev
    // adds the text), and falls back to English at runtime in other locales.
    defaultValue: "",
  },
});
