//! Spell-check Tauri commands + bundled-dictionary loader (MYND-262 t5,
//! MYND-263 t3-4, MYND-266 t5).
//!
//! - `spell_check` — batch per-viewport check (SYNC-8), infallible-empty when no
//!   vault/dicts are loaded (mirrors `note_search`).
//! - `add_to_personal_dictionary` / `ignore_word_in_vault` — Slot::Unlocked-gated
//!   writers (SYNC-7): update the live engine + persist the `vault.dictionary`
//!   blob (read-modify-write).
//! - `spell_check` lazily loads an active language's bundled `.aff`/`.dic` pair
//!   from the Tauri resource dir on first use (`ensure_languages_loaded`) — NOT on
//!   unlock — so RAM holds only the languages actually checked; an unparseable
//!   dict (e.g. TR's flag-0) is skipped best-effort (SYNC-12).
//! - `spell_set_active_languages` — unload deactivated languages (RAM reclaim).

use super::state::SpellState;
use super::sync::{persist_dictionary_with_dir, SpellSyncError};
use super::SpellWord;
use crate::paths::vault_dir_for_id;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager, Runtime, State};

/// The languages bundled + spellbook-loadable at v1 (SYNC-6 / SYNC-12).
/// Every wooorm/dictionaries Hunspell pair here is verified to load in spellbook
/// 0.4.2 (real-dictionary tests) and to carry an AGPL-3.0-compatible license
/// (permissive — MIT/BSD/Apache-2.0; or GPL-3.0 / LGPL-2.1+ / LGPL-3.0 / MPL-2.0;
/// or AGPL-3.0 native for he). Excluded: TR (`MalformedFlag(ZeroFlag)`), da + gl
/// (spellbook parse failure), uk (over-accepts arbitrary tokens), el (Greek —
/// loads, but the 19 MB dict is held back on bundle-size grounds), and the
/// GPL-2.0-only / CC-BY-SA / LPPL / EUPL dicts (AGPL-incompatible). The settings
/// picker (MYND-267) renders exactly this set; each entry is hash-pinned in
/// `dict_manifest::PINNED_DICT_FILES`.
pub const BUNDLED_LANGUAGES: &[&str] = &[
    "en-US", "bg", "ca", "de", "en-GB", "es", "fa", "fr", "he", "hr", "hu", "it", "ko", "lt", "lv",
    "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv",
];

/// Closed, serde-serializable write-error for the personal-dictionary commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum SpellWriteError {
    /// No vault unlocked (no `root_key` to derive the dictionary KEK).
    SlotNotUnlocked,
    /// `vault.meta` missing/unreadable (AAD account-hash).
    InvalidVaultMeta,
    /// Filesystem failure writing `vault.dictionary`.
    Io,
    /// `vault.dictionary` exists but could not be read this session (#255), so
    /// the in-RAM set does not reflect disk and writing it would destroy the
    /// stored one. The dictionary is not synced, so there would be no peer copy
    /// to pull back — only a `.myne-backup` restore. The user keeps their
    /// existing words; the add simply does not persist.
    DictionaryUnreadable,
}

impl From<SpellSyncError> for SpellWriteError {
    fn from(e: SpellSyncError) -> Self {
        match e {
            SpellSyncError::SlotNotUnlocked => SpellWriteError::SlotNotUnlocked,
            SpellSyncError::InvalidVaultMeta => SpellWriteError::InvalidVaultMeta,
            SpellSyncError::Io | SpellSyncError::Encode => SpellWriteError::Io,
            SpellSyncError::Unreadable => SpellWriteError::DictionaryUnreadable,
        }
    }
}

/// Lazily load any of `langs` not yet loaded (restricted to `BUNDLED_LANGUAGES`)
/// into `spell` from the Tauri resource dir. Called by `spell_check` on first use
/// of a language — OFF the unlock path, so unlock never pays the 23-dict parse and
/// RAM holds only the languages actually checked. `SpellState::languages_to_load`
/// marks each as attempted under one lock (so an absent/unparseable dict and
/// concurrent scans each read it at most once); the file I/O here runs lock-free.
/// Best-effort: a miss is logged by closed label and skipped.
/// Resource layout: `<resource_dir>/dictionaries/<lang>/index.{aff,dic}`.
fn ensure_languages_loaded<R: Runtime>(app: &AppHandle<R>, spell: &SpellState, langs: &[String]) {
    // Only bundled languages are loadable; ignore anything else the WebView sends.
    let wanted: Vec<String> = langs
        .iter()
        .filter(|l| BUNDLED_LANGUAGES.contains(&l.as_str()))
        .cloned()
        .collect();
    let to_load = spell.languages_to_load(&wanted);
    if to_load.is_empty() {
        return;
    }
    let Ok(resource_dir) = app.path().resource_dir() else {
        tracing::warn!(
            event = "spell_dicts_skip",
            reason = "resource_dir_unavailable"
        );
        return;
    };
    let dict_root = resource_dir.join("dictionaries");
    for lang in &to_load {
        match load_one_language(spell, &dict_root, lang) {
            Ok(()) => tracing::info!(event = "spell_dict_loaded", lang = lang.as_str()),
            Err(reason) => {
                tracing::warn!(event = "spell_dict_skip", lang = lang.as_str(), reason)
            }
        }
    }
}

/// Read + load a single language's `.aff`/`.dic` pair. Returns a closed static
/// reason on failure (never the dict bytes).
fn load_one_language(spell: &SpellState, dict_root: &Path, lang: &str) -> Result<(), &'static str> {
    let dir = dict_root.join(lang);
    let aff = std::fs::read_to_string(dir.join("index.aff")).map_err(|_| "aff_read_failed")?;
    let dic = std::fs::read_to_string(dir.join("index.dic")).map_err(|_| "dic_read_failed")?;
    spell
        .load_language(lang, &aff, &dic)
        .map_err(|_| "dict_parse_failed")
}

/// `spell_check` — batch-check `words` against the active `langs` (SYNC-11
/// union). Infallible: returns an empty vec when no dictionaries are loaded
/// (locked / not yet hydrated), never an error, never a leak (mirrors
/// `note_search`).
#[tauri::command]
pub async fn spell_check<R: Runtime>(
    app: AppHandle<R>,
    spell: State<'_, SpellState>,
    words: Vec<String>,
    langs: Vec<String>,
) -> Result<Vec<SpellWord>, ()> {
    // Lazy-load the active languages on first use (off the unlock path).
    ensure_languages_loaded(&app, spell.inner(), &langs);
    Ok(spell.check_batch(&words, &langs))
}

/// `spell_set_active_languages` — keep the engine's loaded dictionaries == the
/// active set by unloading deactivated languages (RAM reclaim). Newly-active
/// languages load lazily on the next `spell_check`. The settings UI calls this on
/// a language/toggle change (`langs` empty when spell-check is turned off).
/// Infallible best-effort.
#[tauri::command]
pub async fn spell_set_active_languages(
    spell: State<'_, SpellState>,
    langs: Vec<String>,
) -> Result<(), ()> {
    spell.retain_languages(&langs);
    Ok(())
}

/// `add_to_personal_dictionary` — add `word` to the vault's personal set
/// (SYNC-7): updates the live engine (squiggle clears immediately) then persists
/// the `vault.dictionary` blob. Slot::Unlocked-gated.
#[tauri::command]
pub async fn add_to_personal_dictionary<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    spell: State<'_, SpellState>,
    word: String,
) -> Result<(), SpellWriteError> {
    let dir =
        vault_dir_for_id(&app, state.active_vault_id().await).map_err(|_| SpellWriteError::Io)?;
    // #255: persisting a set we never managed to read would overwrite the
    // stored dictionary with an empty one. Refuse instead — the word stays
    // un-added, which is recoverable; the file would not be.
    if !spell.is_hydrated() {
        return Err(SpellWriteError::DictionaryUnreadable);
    }
    let snapshot = spell.add_personal(&word).ok_or(SpellWriteError::Io)?;
    persist_dictionary_with_dir(&dir, state.inner(), &snapshot)
        .await
        .map_err(SpellWriteError::from)
}

/// `ignore_word_in_vault` — add `word` to the vault-wide ignore set (SYNC-13):
/// updates the live engine then persists. Slot::Unlocked-gated.
#[tauri::command]
pub async fn ignore_word_in_vault<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    spell: State<'_, SpellState>,
    word: String,
) -> Result<(), SpellWriteError> {
    let dir =
        vault_dir_for_id(&app, state.active_vault_id().await).map_err(|_| SpellWriteError::Io)?;
    // Same refusal as `add_to_personal_dictionary` (#255) — the two writers
    // share one blob, so gating one and not the other would leave the hole open.
    if !spell.is_hydrated() {
        return Err(SpellWriteError::DictionaryUnreadable);
    }
    let snapshot = spell.add_ignore(&word).ok_or(SpellWriteError::Io)?;
    persist_dictionary_with_dir(&dir, state.inner(), &snapshot)
        .await
        .map_err(SpellWriteError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_languages_set_v1() {
        // 23 languages: en-US + 22 that load in spellbook + are AGPL-compatible.
        assert_eq!(BUNDLED_LANGUAGES.len(), 23);
        assert!(BUNDLED_LANGUAGES.contains(&"en-US"));
        assert!(BUNDLED_LANGUAGES.contains(&"de") && BUNDLED_LANGUAGES.contains(&"ru"));
        // Deferred / excluded never sneak in.
        for excluded in ["tr", "da", "gl", "uk", "el"] {
            assert!(
                !BUNDLED_LANGUAGES.contains(&excluded),
                "{excluded} must not be bundled"
            );
        }
        // No duplicates.
        let mut sorted = BUNDLED_LANGUAGES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted.len(),
            BUNDLED_LANGUAGES.len(),
            "no duplicate languages"
        );
    }

    #[test]
    fn write_error_maps_from_sync_error() {
        assert_eq!(
            SpellWriteError::from(SpellSyncError::SlotNotUnlocked),
            SpellWriteError::SlotNotUnlocked
        );
        assert_eq!(
            SpellWriteError::from(SpellSyncError::Encode),
            SpellWriteError::Io
        );
    }
}
