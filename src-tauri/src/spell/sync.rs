//! Personal-dictionary persistence + lifecycle (MYND-266 tasks 4-5).
//!
//! Bridges the encrypted `vault.dictionary` blob (`protocol::dictionary_blob`,
//! MYD1) to the live [`SpellState`]: hydrate on unlock, persist on add/ignore,
//! zeroize on lock — the `search_sync` residency discipline (§ 9.6.5 / § 9.13).
//!
//! Split like the protocol crate's `_raw`/convenience pair: the **pure cores**
//! (`persist_payload_to_dir` / `hydrate_payload_from_dir`) take the derived KEK
//! + account-hash directly and own the crypto+IO round-trip (fully unit-tested);
//! the thin `*_with_dir` wrappers fetch `root_key`/hash from the unlocked
//! `VaultRuntimeState` and derive the KEK (mirrors the proven `search_sync`
//! wrappers). Any failure on read collapses to the empty dictionary
//! (fall-back-to-empty, § 9.13.4); a spell-IO miss never blocks unlock/lock.

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
    /// `vault.dictionary` EXISTS but could not be decrypted or parsed (#255).
    ///
    /// Distinct from [`Io`] because the remedy differs and from "empty" because
    /// treating it as empty is what destroyed the file: the next write persisted
    /// the empty default over a blob that was merely unread. A caller seeing
    /// this must decline to write, not retry.
    Unreadable,
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

/// PURE CORE — read + decrypt `vault.dictionary` under `vault_dir`.
///
/// **Absent is not the same as unreadable (#255).** § 9.13.4's fall-back-to-empty
/// is right for an ABSENT blob — a vault that has never added a word has no
/// dictionary, and empty is the correct answer, not a fallback. It was applied
/// to every failure alike, so a blob that existed and could not be read this
/// once (a Windows AV/backup tool holding an exclusive handle, a permission
/// change, an EIO) also became "empty" — and the next `add_to_personal_dictionary`
/// persisted that empty over the user's real file. `vault.dictionary` is not in
/// the sync blob set, so there is no peer copy to pull back: only a
/// `.myne-backup` restore recovers it.
///
/// So: `NotFound` → the empty default. Every other outcome is an error the
/// caller must NOT paper over with a write.
pub(crate) fn hydrate_payload_from_dir(
    vault_dir: &Path,
    dict_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> Result<PersonalDictionaryData, SpellSyncError> {
    let blob = match std::fs::read(vault_dir.join("vault.dictionary")) {
        Ok(b) => b,
        // The one benign absence. Anything else — permission denied, EIO, a
        // sharing violation — is a read that FAILED, not a vault with no words.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(_) => return Err(SpellSyncError::Io),
    };
    // An AEAD failure means the ciphertext was already unrecoverable, so no
    // write can make it worse — but an intact blob a future build cannot parse
    // is exactly what `dict_format_version` exists for, and overwriting it
    // would destroy a file a later version could still read. Both stay errors:
    // the caller declines to write rather than guessing which one it hit.
    let plaintext = decode_dictionary_blob(dict_key, account_number_hash, &blob).map_err(|_| {
        tracing::warn!(
            event = "dictionary_undecryptable",
            "vault.dictionary exists but could not be decrypted; refusing to treat it as empty"
        );
        SpellSyncError::Unreadable
    })?;
    PersonalDictionaryData::decode(&plaintext).ok_or_else(|| {
        tracing::warn!(
            event = "dictionary_unparseable",
            "vault.dictionary decrypted but did not parse; refusing to treat it as empty"
        );
        SpellSyncError::Unreadable
    })
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
/// A failed read leaves the state UN-HYDRATED rather than empty (#255), so the
/// write paths refuse instead of persisting an empty set over a file they never
/// managed to read.
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
    let data = hydrate_payload_from_dir(vault_dir, &dict_key, &account_number_hash)?;
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
        let back = hydrate_payload_from_dir(&dir, &KEY, &HASH).expect("hydrate");
        assert_eq!(back.personal_words, vec!["Myne", "tokio"]);
        assert_eq!(back.ignore_words, vec!["helllo"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn absent_file_hydrates_empty() {
        // The ONE benign absence: a vault that has never added a word has no
        // dictionary, and empty is the correct answer rather than a fallback.
        let dir = tmp();
        let back = hydrate_payload_from_dir(&dir, &KEY, &HASH).expect("absent is not an error");
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
    fn wrong_key_is_unreadable_not_empty() {
        let dir = tmp();
        let data = PersonalDictionaryData {
            personal_words: vec!["secret".into()],
            ignore_words: vec![],
        };
        persist_payload_to_dir(&dir, &KEY, &HASH, &data).expect("persist");
        // #255: a blob that EXISTS and does not decrypt is an error, not an
        // empty dictionary. Reporting empty here is what let the next write
        // persist empty over a file that was merely unread.
        let other = [0x11; AEAD_KEY_LEN];
        assert!(matches!(
            hydrate_payload_from_dir(&dir, &other, &HASH),
            Err(SpellSyncError::Unreadable)
        ));
        // A different account-hash (cross-vault AAD) — same verdict.
        let other_hash = [0x22; VAULT_META_ACCOUNT_HASH_LEN];
        assert!(matches!(
            hydrate_payload_from_dir(&dir, &KEY, &other_hash),
            Err(SpellSyncError::Unreadable)
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_blob_is_unreadable_not_empty() {
        let dir = tmp();
        std::fs::write(dir.join("vault.dictionary"), b"not a MYD1 blob").expect("write");
        assert!(matches!(
            hydrate_payload_from_dir(&dir, &KEY, &HASH),
            Err(SpellSyncError::Unreadable)
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The end-to-end shape of the defect: an unreadable blob must not become
    /// an empty one that the next write then persists.
    #[test]
    fn an_unreadable_blob_is_never_overwritten_by_a_hydrate() {
        let dir = tmp();
        let data = PersonalDictionaryData {
            personal_words: vec!["irreplaceable".into()],
            ignore_words: vec![],
        };
        persist_payload_to_dir(&dir, &KEY, &HASH, &data).expect("persist");
        let before = std::fs::read(dir.join("vault.dictionary")).expect("read blob");

        // Hydrate with the wrong key — the "could not read it this once" case.
        let wrong = [0x11; AEAD_KEY_LEN];
        assert!(hydrate_payload_from_dir(&dir, &wrong, &HASH).is_err());

        // The file is untouched; the words are still recoverable with the real
        // key. Before #255 the caller would have hydrated empty and the next
        // add would have written that empty over these bytes.
        let after = std::fs::read(dir.join("vault.dictionary")).expect("read blob");
        assert_eq!(before, after, "a failed read must not touch the blob");
        let recovered = hydrate_payload_from_dir(&dir, &KEY, &HASH).expect("still readable");
        assert_eq!(recovered.personal_words, vec!["irreplaceable"]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
