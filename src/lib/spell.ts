// Tauri IPC wrappers for the `spell` plugin (MYND-262 / MYND-266).
//
// - `spellCheck(words, langs)` — batch per-viewport spell check (SYNC-8).
//   Infallible on the Rust side: returns an empty array when no vault/dicts are
//   loaded (locked / not yet hydrated), so the editor decoration layer can call
//   it freely without error handling.
// - `addToPersonalDictionary(word)` / `ignoreWordInVault(word)` —
//   Slot::Unlocked-gated writers (SYNC-7/13). They update the live engine
//   immediately (the squiggle clears) and persist the encrypted
//   `vault.dictionary` blob; a rejected promise means the disk write failed.
//
// `BUNDLED_SPELL_LANGUAGES` mirrors the Rust `commands::BUNDLED_LANGUAGES`
// manifest (MYND-263 t4) — the single source the settings language picker
// (MYND-267) renders. v1 = 23 languages (en-US + 22 that load in spellbook and
// carry AGPL-compatible licenses). TR/da/gl/uk/el and the GPL-2.0-only dicts are
// excluded (SYNC-12 + size/compat). Adding a bundled language is a one-site
// change on each side (and a hash-pin in dict_manifest.rs).

import { invoke } from "@tauri-apps/api/core";

/** Per-word spell verdict (mirrors the Rust `SpellWord`). */
export type SpellWord = {
  /** The word as supplied (so the caller maps back to its document range). */
  word: string;
  /** True if the word is misspelled (not in any active dict / personal / ignore). */
  misspelled: boolean;
  /** Ranked suggestions (unbounded); the UI caps the display (SYNC-14). */
  suggestions: string[];
};

/**
 * The languages bundled + loadable at v1 — the single source the settings
 * language picker renders (never hard-coded elsewhere). Mirrors the Rust
 * `spell::commands::BUNDLED_LANGUAGES` (23 languages; TR deferred per SYNC-12:
 * spellbook 0.4.2 rejects the tr `.aff`'s flag-0).
 */
export const BUNDLED_SPELL_LANGUAGES = [
  "en-US",
  "bg",
  "ca",
  "de",
  "en-GB",
  "es",
  "fa",
  "fr",
  "he",
  "hr",
  "hu",
  "it",
  "ko",
  "lt",
  "lv",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sv",
] as const;

/**
 * The default active language set for a fresh vault (SYNC-15): the OS/UI locale
 * if it (or its base language) is bundled, otherwise just en-US. Always includes
 * en-US so the union (SYNC-11) covers English technical terms in any-language
 * prose. Matches an exact tag (`de`) or a region variant's base (`de-DE` → `de`).
 */
export function defaultActiveLanguages(osLocale?: string): string[] {
  const bundled = new Set<string>(BUNDLED_SPELL_LANGUAGES);
  const set = new Set<string>(["en-US"]);
  if (osLocale) {
    if (bundled.has(osLocale)) set.add(osLocale);
    else {
      const base = osLocale.split("-")[0];
      if (bundled.has(base)) set.add(base);
    }
  }
  return [...set];
}

/** Batch-check `words` against the active `langs` (SYNC-11 union). The engine
 * lazy-loads each active language's dictionary on first use. */
export async function spellCheck(
  words: string[],
  langs: string[],
): Promise<SpellWord[]> {
  return invoke<SpellWord[]>("plugin:spell|spell_check", { words, langs });
}

/** Tell the engine which languages are active so it can free the dictionaries of
 * deactivated ones (RAM reclaim; newly-active ones lazy-load on the next check).
 * Pass `[]` when spell-check is turned off to free all loaded dictionaries. */
export async function setActiveSpellLanguages(langs: string[]): Promise<void> {
  await invoke<void>("plugin:spell|spell_set_active_languages", { langs });
}

/** Add `word` to the vault's personal dictionary (persists vault.dictionary). */
export async function addToPersonalDictionary(word: string): Promise<void> {
  await invoke<void>("plugin:spell|add_to_personal_dictionary", { word });
}

/** Add `word` to the vault-wide ignore set (persists vault.dictionary). */
export async function ignoreWordInVault(word: string): Promise<void> {
  await invoke<void>("plugin:spell|ignore_word_in_vault", { word });
}
