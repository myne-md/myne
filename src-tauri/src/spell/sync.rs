//! Personal-dictionary persistence + lifecycle (MYND-266 tasks 4-5).
//!
//! Bridges the encrypted `vault.dictionary` blob (`protocol::dictionary_blob`,
//! MYD1) to the live [`SpellState`]: hydrate on unlock, persist on add/ignore,
//! zeroize on lock — the `search_sync` residency discipline (§ 9.6.5 / § 9.12).
//!
//! Split like the protocol crate's `_raw`/convenience pair: the **pure cores**
//! (`persist_payload_to_dir` / `hydrate_payload_from_dir`) take the derived KEK
//! + account-hash directly and own the crypto+IO round-trip (fully unit-tested);
//! the thin `*_with_dir` wrappers fetch `root_key`/hash from the unlocked
//! `VaultRuntimeState` and derive the KEK (mirrors the proven `search_sync`
//! wrappers). Any failure on read collapses to the empty dictionary
//! (fall-back-to-empty, § 9.12.4); a spell-IO miss never blocks unlock/lock.

use super::dictionary::PersonalDictionaryData;
use super::state::SpellState;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{
    decode_dictionary_blob, derive_subkey, encode_dictionary_blob, parse_vault_meta, SubkeyRole,
    AEAD_KEY_LEN, VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::Path;
use tauri::{AppHandle, Manager, Runtime};
use zeroize::Zeroizing;

/// Build-time coupling guard: the `vault.meta` account-hash field and the
/// dictionary blob's AAD account-hash are the same 16-byte field.
const _: () = assert!(VAULT_META_ACCOUNT_HASH_LEN == protocol::DICTIONARY_BLOB_ACCOUNT_HASH_LEN);

/// Failure modes of the dictionary persist/hydrate wrappers. The caller
/// collapses read failures to the empty dictionary; write failures surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpellSyncError {
    /// Slot was not `Unlocked` (no `root_key`).
    SlotNotUnlocked,
    /// `vault.meta` missing/unreadable (needed for the AAD account-hash).
    InvalidVaultMeta,
    /// Filesystem failure writing `vault.dictionary`.
    Io,
    /// `encode_dictionary_blob` failed (structurally unreachable under fixed
    /// v0.1 AEAD params; mapped defensively).
    Encode,
}

fn read_account_number_hash(
    vault_meta_path: &Path,
) -> Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], SpellSyncError> {
    let bytes = std::fs::read(vault_meta_path).map_err(|_| SpellSyncError::Io)?;
    let meta = parse_vault_meta(&bytes).map_err(|_| SpellSyncError::InvalidVaultMeta)?;
    Ok(meta.account_number_hash)
}

/// PURE CORE — encrypt `data` to the `vault.dictionary` blob and atomically
/// write it under `vault_dir`. When `data` is empty, the file is removed
/// (best-effort) so an empty dictionary leaves no file (fall-back-to-empty on
/// read; keeps a no-dictionary vault byte-clean).
pub(crate) fn persist_payload_to_dir(
    vault_dir: &Path,
    dict_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    data: &PersonalDictionaryData,
) -> Result<(), SpellSyncError> {
    let path = vault_dir.join("vault.dictionary");
    if data.is_empty() {
        // Best-effort remove; absent == empty on read.
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let payload = data.encode();
    let blob = encode_dictionary_blob(dict_key, account_number_hash, &payload)
        .map_err(|_| SpellSyncError::Encode)?;
    crate::atomic_write::atomic_write(&path, &blob, /* replace = */ true)
        .map_err(|_| SpellSyncError::Io)?;
    Ok(())
}

/// PURE CORE — read + decrypt `vault.dictionary` under `vault_dir` into the
/// canonical data. Absent file / AEAD-fail / malformed payload → empty (the
/// fall-back-to-empty semantic, § 9.12.4).
pub(crate) fn hydrate_payload_from_dir(
    vault_dir: &Path,
    dict_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> PersonalDictionaryData {
    std::fs::read(vault_dir.join("vault.dictionary"))
        .ok()
        .and_then(|blob| {
            decode_dictionary_blob(dict_key, account_number_hash, &blob)
                .ok()
                .and_then(|pt| PersonalDictionaryData::decode(&pt))
        })
        .unwrap_or_default()
}

/// Persist the given `data` for the currently-unlocked vault (holds the write
/// guard across the atomic_write, SYNC-6). MUST be called while `Unlocked`.
pub(crate) async fn persist_dictionary_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    data: &PersonalDictionaryData,
) -> Result<(), SpellSyncError> {
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(SpellSyncError::SlotNotUnlocked)?;
    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"))?;
    let dict_key: Zeroizing<[u8; AEAD_KEY_LEN]> =
        derive_subkey(&root_key, SubkeyRole::PersonalDictKey);
    persist_payload_to_dir(vault_dir, &dict_key, &account_number_hash, data)
}

/// Hydrate the live [`SpellState`] personal/ignore sets from disk on unlock.
/// Best-effort: any failure leaves the sets empty.
pub(crate) async fn hydrate_dictionary_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    spell: &SpellState,
) -> Result<(), SpellSyncError> {
    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(SpellSyncError::SlotNotUnlocked)?;
    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"))?;
    let dict_key: Zeroizing<[u8; AEAD_KEY_LEN]> =
        derive_subkey(&root_key, SubkeyRole::PersonalDictKey);
    let data = hydrate_payload_from_dir(vault_dir, &dict_key, &account_number_hash);
    spell.hydrate_words(data);
    Ok(())
}

/// Best-effort hydrate on unlock: resolve the app-managed [`SpellState`] and
/// hydrate the personal/ignore sets from `vault.dictionary`. Dictionaries are NOT
/// loaded here — they are loaded lazily on first `spell_check` for the active
/// languages (and unloaded when deactivated), so unlock never pays the 23-dict
/// parse and RAM holds only the languages actually in use. Any miss leaves empty
/// sets — never blocks unlock.
pub async fn hydrate_spell<R: Runtime>(app: &AppHandle<R>, state: &VaultRuntimeState) {
    let Some(spell) = app.try_state::<SpellState>() else {
        return;
    };
    let Ok(vault_dir) = crate::paths::vault_dir_for_id(app, state.active_vault_id().await) else {
        tracing::warn!(
            event = "spell_hydrate_skip",
            reason = "vault_dir_resolution_failed"
        );
        return;
    };
    let _ = hydrate_dictionary_with_dir(&vault_dir, state, &spell).await;
}

/// Best-effort zeroize + reset of the in-RAM spell engine + personal/ignore
/// sets on lock teardown. Resolves the app-managed [`SpellState`] and clears it.
/// (Each add/ignore persists immediately, so there is nothing to flush on lock —
/// only the plaintext-derived RAM to wipe.)
pub fn zeroize_spell<R: Runtime>(app: &AppHandle<R>) {
    if let Some(spell) = app.try_state::<SpellState>() {
        spell.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spell::dictionary::PersonalDictionaryData;

    const KEY: [u8; AEAD_KEY_LEN] = [0x55; AEAD_KEY_LEN];
    const HASH: [u8; VAULT_META_ACCOUNT_HASH_LEN] = [0x7c; VAULT_META_ACCOUNT_HASH_LEN];

    fn tmp() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        // Unique-ish per run without Date/rand (forbidden): use a counter file
        // path derived from the test name via a nanosecond-free monotonic-ish
        // suffix is unavailable; use process id + an atomic counter.
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        p.push(format!(
            "myne-spell-sync-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).expect("mkdir");
        p
    }

    #[test]
    fn persist_then_hydrate_round_trips() {
        let dir = tmp();
        let data = PersonalDictionaryData {
            personal_words: vec!["Myne".into(), "tokio".into()],
            ignore_words: vec!["helllo".into()],
        };
        persist_payload_to_dir(&dir, &KEY, &HASH, &data).expect("persist");
        assert!(dir.join("vault.dictionary").exists());
        let back = hydrate_payload_from_dir(&dir, &KEY, &HASH);
        assert_eq!(back.personal_words, vec!["Myne", "tokio"]);
        assert_eq!(back.ignore_words, vec!["helllo"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn absent_file_hydrates_empty() {
        let dir = tmp();
        let back = hydrate_payload_from_dir(&dir, &KEY, &HASH);
        assert!(back.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_data_removes_the_file() {
        let dir = tmp();
        let data = PersonalDictionaryData {
            personal_words: vec!["x".into()],
            ignore_words: vec![],
        };
        persist_payload_to_dir(&dir, &KEY, &HASH, &data).expect("persist");
        assert!(dir.join("vault.dictionary").exists());
        // Now persist empty → file removed.
        persist_payload_to_dir(&dir, &KEY, &HASH, &PersonalDictionaryData::default())
            .expect("persist empty");
        assert!(!dir.join("vault.dictionary").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wrong_key_hydrates_empty_cross_vault() {
        let dir = tmp();
        let data = PersonalDictionaryData {
            personal_words: vec!["secret".into()],
            ignore_words: vec![],
        };
        persist_payload_to_dir(&dir, &KEY, &HASH, &data).expect("persist");
        // A different KEK (different vault) → AEAD fails → empty.
        let other = [0x11; AEAD_KEY_LEN];
        assert!(hydrate_payload_from_dir(&dir, &other, &HASH).is_empty());
        // A different account-hash (cross-vault AAD) → empty too.
        let other_hash = [0x22; VAULT_META_ACCOUNT_HASH_LEN];
        assert!(hydrate_payload_from_dir(&dir, &KEY, &other_hash).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_blob_hydrates_empty() {
        let dir = tmp();
        std::fs::write(dir.join("vault.dictionary"), b"not a MYD1 blob").expect("write");
        assert!(hydrate_payload_from_dir(&dir, &KEY, &HASH).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
