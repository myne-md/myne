// i18next-cli config — scans the React source for `t("…")` calls and keeps the
// locale catalogs in sync. Run `pnpm i18n:extract` (or `pnpm i18n:status` for a
// translation-progress summary).
//
// `locales/en/common.json` is the SOURCE catalog (hand-maintained English).
// Extraction ADDS newly-introduced keys; `removeUnusedKeys: false` means a key
// that was already translated is never deleted by a scan. After running, fill
// any new English value in `locales/en/common.json`, commit, and translate the
// new key in whichever catalogs you are keeping current — the catalogs are
// authored in-repo (there is no external translation platform; Weblate was
// retired in `agent-tooling/design-notes/ui/0629`).
//
// See `agent-tooling/docs/dev/i18n.md` for the full add-a-string workflow.

import { defineConfig } from "i18next-cli";
import { presentSharedRoots } from "./scripts/lib/shared-roots.mjs";

// Every shared tree, from ONE roster (#273).
//
// **It was a hand-kept list, and the note above it said so** ("kept in step with
// `scripts/lib/shared-roots.mjs` by hand, because this file is consumed by the
// extractor CLI rather than by Node with an import"). It had drifted: the roster
// holds nine trees and this list held six, so `client-core/src`, `ornaments/src`
// and `stories/src` were never scanned and a `t()` key added there was invisible
// to the documented add-a-string procedure (`agent-tooling/docs/dev/i18n.md`) — the exact
// failure the note was written about, one package later (audit 2026-10-18 R0.4).
//
// The stated reason was wrong rather than merely stale: this file IS loaded by
// Node (it uses `export default` under `"type": "module"`), so importing the
// roster works, and it is what makes "one roster" a construction instead of a
// promise. `tests/scripts/i18nExtractRoster.test.ts` holds the two together, so a
// future hand-written copy of this list fails rather than drifting.
const { present: SHARED_PRESENT, missing: SHARED_MISSING } = presentSharedRoots();

// Fail by NAME on a root that is not in this checkout, rather than narrowing the
// scan in silence. A glob that matches nothing does not error: the extractor
// simply finds no keys, so every string in that tree stops being extracted and
// nothing says so.
if (SHARED_MISSING.length > 0) {
  throw new Error(
    `i18n extractor: shared root(s) absent from this checkout: ${SHARED_MISSING.join(", ")}. ` +
      `The extractor would silently stop seeing every string in them.`,
  );
}

export default defineConfig({
  locales: ["en","ar","bn","cs","da","de","el","es","fa","fi","fr","hi","hu","id","it","ja","ko","nb","nl","pa","pl","pt","ro","ru","sv","sw","th","tr","uk","ur","vi","zh"],
  extract: {
    // Desktop, web and mobile clients plus the shared SOURCE packages
    // (`editor/`, `dialect/`, `copy/`, `client-core/`, `ornaments/`) and the
    // story catalogue — all of them compile into more than one client and all of
    // them share these repo-root catalogs, so a single `pnpm i18n:extract` keeps
    // every client's `t("…")` keys in one source. Derived from
    // `scripts/lib/shared-roots.mjs`; see the note above for why that matters.
    //
    // NOTE — the mobile path moved when the client came in-repo
    // (decisions.md 2026-08-13), which is the class of edit a hand-kept list gets
    // wrong: a stale glob here does not error, so every mobile string silently
    // stops being extracted.
    input: SHARED_PRESENT.map((root) => `${root}/**/*.{ts,tsx}`),
    output: "locales/{{language}}/{{namespace}}.json",
    // English is the source language: its catalog is hand-maintained and is
    // the per-key runtime fallback for every other locale.
    primaryLanguage: "en",
    defaultNS: "common",
    // Dots nest keys (`unlock.title` → { unlock: { title } }); we always use
    // the default `common` namespace, so disable the `:` namespace separator.
    keySeparator: ".",
    nsSeparator: false,
    // Do NOT sort. `sort: true` looked like "stable ordering for catalogs edited
    // by hand", and it is the opposite: every run rewrites and re-orders all 32
    // catalogs (~2500 changed lines in `en` alone for one new key), which buries
    // the actual change, makes `git blame` on a string useless, and contradicts
    // the repo's positional-insertion rule (`src/AGENTS.md`, `agent-tooling/docs/dev/i18n.md`).
    // With it off, extraction leaves existing order alone and appends a new key
    // at the end. The result is an additions-only diff you then move next to its
    // siblings by hand.
    sort: false,
    // Never silently drop a key still present in a translation file — pruning a
    // removed-in-code key is a deliberate, by-hand edit.
    removeUnusedKeys: false,
    // A new key lands with an empty value: visibly unfilled in English (the dev
    // adds the text), and falls back to English at runtime in other locales.
    defaultValue: "",
  },
});
