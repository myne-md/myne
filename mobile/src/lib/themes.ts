// Custom-theme command wrapper (mobile) — the TS mirror of the vault-content
// `themes` Tauri plugin (`myne_core::plugins::themes`, surfaced on mobile by
// `src-tauri/src/plugins/themes/`). The palettes are VAULT CONTENT: they live in
// the encrypted `vault.themes` (`MYT1`) singleton blob (protocol.md § 9.21) that
// sync already delivers to this device, not in device-local plaintext.
//
// Mobile is a READ-ONLY consumer, so this file has exactly one call in it.
// `themes_read` / `themes_import` / `themes_export` / `themes_delete` are not
// registered on the mobile plugin and not granted by its ACL; calling them from
// here would be rejected by the ACL resolver, not silently succeed. Do not add
// wrappers for them "for parity" — desktop is where themes are authored.

import { invoke } from "@tauri-apps/api/core";

/** A theme's flat `--token → value` CSS-variable palette map. Mirror of Rust
 *  `ThemePalette` (a `BTreeMap<String, String>`). */
export type ThemePalette = Record<string, string>;

/**
 * One live custom theme as the list surface hands it out — mirror of Rust
 * `ThemeListEntry`. The palette rides along because `vault.themes` is a single
 * blob: the host decrypts and decodes every palette to answer a list at all, so
 * a name-only list would just force each palette to be bought back with its own
 * full decrypt. Callers must use the palette they already have here rather than
 * issuing a second read — which is also why `themes_read` is unexposed on mobile.
 *
 * Tombstoned entries never reach this surface, so `palette` is never empty.
 */
export interface CustomThemeEntry {
  name: string;
  palette: ThemePalette;
}

/**
 * List every live custom theme in the unlocked vault's `vault.themes` store —
 * name + palette each, in name order (the host's `BTreeMap` iteration; no
 * client-side re-sort needed). ONE decrypt covers the whole list.
 *
 * Returns `[]` for a vault that has no themes, and also for any recoverable
 * read failure (file absent / truncated / AEAD-fail / parse-fail): the host
 * collapses those to the empty store per § 9.21.4, because a cosmetic palette is
 * not load-bearing and an unreadable themes blob must never block the app.
 * Rejects only when the slot is locked (`SlotNotUnlocked`).
 */
export function listCustomThemes(): Promise<CustomThemeEntry[]> {
  return invoke<CustomThemeEntry[]>("plugin:themes|themes_list");
}
