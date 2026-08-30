//! Reading a SOURCE vault's added dictionary words during a vault import.
//!
//! Desktop-side because the personal dictionary is: the `MYD1` framing is in
//! `protocol`, but the payload type and the spell engine that consumes it live
//! in `src-tauri/src/spell/`, and `myne-core` cannot reach them. That the
//! feature is desktop-only anyway (the `importer` plugin is absent on web and
//! mobile) makes the placement free rather than a compromise.
//!
//! ## Why the added words cross and the ignore set does not
//!
//! `protocol.md` §9.13 holds two sets. The **added-words** set is per-word user
//! vocabulary: names, project terms, private words the user taught the spell
//! checker. Carrying it is a set union with no conflict semantics to get wrong,
//! and NOT carrying it has an immediate visible cost, since every domain term in
//! the notes just imported comes up red-underlined.
//!
//! The **vault-wide ignore** set is not carried. It is explicitly vault-scoped,
//! which makes it closer to a preference than to content: importing another
//! vault's ignore decisions would silently change spell-check behaviour for
//! words that have nothing to do with the import, on notes the user never
//! touched. That is the same reason prefs, themes and workspace layout are on
//! the not-imported list, and the reason the user would not notice is that the
//! change is a warning that stops appearing.
//!
//! This command returns the added words only. There is no parameter that would
//! return the ignore set, because a parameter is how the distinction erodes.

use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{derive_subkey_versioned, SubkeyRole};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

/// Failure surface for the source-dictionary read.
///
/// An unreadable dictionary is NOT collapsed to "no words". §9.13.4's
/// fall-back-to-empty exists for a vault opening its OWN dictionary, where the
/// next write repairs it; here the consequence of guessing empty is that the
/// user is told nothing crossed when in fact nothing was read, which is a
/// different sentence in the import report.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ImportSourceDictionaryError {
    #[error("no import source is open for that vault")]
    SessionClosed,
    #[error("source vault.meta is invalid")]
    InvalidSourceVaultMeta,
    #[error("the source dictionary could not be read")]
    Unreadable,
    #[error("io error")]
    Io,
}

/// The source vault's added words, and nothing else.
#[derive(Debug, Serialize)]
pub struct SourceDictionaryWords {
    /// The added-words set, NFC-normalized and sorted as the codec stores it.
    pub personal_words: Vec<String>,
}

/// Read the source vault's added dictionary words through its open import slot.
///
/// NOT a `#[tauri::command]`, and that is deliberate rather than an oversight.
/// The frontend calls [`import_source_merge_dictionary`] below, which does the
/// read and the write in one call; this half has no caller across IPC, so
/// registering it would be command surface with no consumer and an ACL row
/// permitting something nobody invokes. `scripts/check-ipc-binding-callers.mjs`
/// is what noticed, from the TypeScript side, inside the same change.
pub async fn import_source_dictionary<R: Runtime>(
    source_vault_id: String,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<SourceDictionaryWords, ImportSourceDictionaryError> {
    use myne_core::plugins::vault_unlock::import_source;

    let source_id = myne_core::vault_id::VaultId::parse_optional(Some(source_vault_id.as_str()))
        .ok_or(ImportSourceDictionaryError::SessionClosed)?;
    let host = myne_core::host::tauri_host::TauriHost::new(app);

    // Borrow rather than take: `with_keys` lends the key material for the length
    // of the closure and cannot hand it out, so no caller here can hold a second
    // vault's `root_key` past its own statement.
    // `.clone()` on the `Zeroizing`, not a copy of the array inside it. The
    // seam lends a wrapper precisely so this line cannot hand a bare `[u8; 32]`
    // out: a bare array is `Copy`, so it would live to the end of this command
    // across two `.await` points and drop unwiped, which is the thing
    // `protocol/CLAUDE.md`'s memory-hygiene rule exists to stop.
    let root_key = import_source::with_keys(state.inner(), source_id, |root, _items, _id| {
        root.clone()
    })
    .await
    .ok_or(ImportSourceDictionaryError::SessionClosed)?;

    let source_root = myne_core::paths::vault_root_for_id_from_host(&host, source_id)
        .map_err(|_| ImportSourceDictionaryError::SessionClosed)?;

    // The SOURCE's generation and account hash. Both are the source's: the
    // dictionary KEK derives under the vault's own generation and the blob's AAD
    // binds the vault's own account hash, so borrowing either from the target
    // fails the tag for a reason no error message could explain.
    let (version, account_number_hash) =
        match myne_core::plugins::attachments::commands::read_account_number_hash(
            &myne_core::vault_io::StdVaultIo,
            &source_root.join("vault.meta"),
        )
        .await
        {
            Ok(Ok(pair)) => pair,
            Ok(Err(_)) => return Err(ImportSourceDictionaryError::InvalidSourceVaultMeta),
            Err(_) => return Err(ImportSourceDictionaryError::Io),
        };

    added_words_from_dir(&source_root, &root_key, version, &account_number_hash)
}

/// What the dictionary carry did, for the import report.
#[derive(Debug, Serialize)]
pub struct DictionaryCarry {
    /// Words that were NOT already in the target's personal set.
    pub added: usize,
    /// Words read from the source, whether or not the target already had them.
    pub read: usize,
}

/// Read the source vault's added words and union them into the TARGET's
/// personal dictionary, in one call and one persist.
///
/// Replaces "read here, then loop `add_to_personal_dictionary` from the
/// frontend", which cost one IPC round trip and one full `vault.dictionary`
/// re-seal PER WORD, and whose only available count was the number of calls it
/// made rather than the number of words that were new.
///
/// The ignore set is still not carried, and still cannot be: this reads through
/// [`added_words_from_dir`], which returns the added words and has no parameter
/// that would return anything else.
#[tauri::command]
pub async fn import_source_merge_dictionary<R: Runtime>(
    source_vault_id: String,
    state: State<'_, VaultRuntimeState>,
    spell: State<'_, crate::spell::state::SpellState>,
    app: AppHandle<R>,
) -> Result<DictionaryCarry, ImportSourceDictionaryError> {
    let words = import_source_dictionary(source_vault_id, state.clone(), app.clone())
        .await?
        .personal_words;
    let read = words.len();
    if read == 0 {
        return Ok(DictionaryCarry { added: 0, read: 0 });
    }

    // The target vault, resolved the same way `add_to_personal_dictionary`
    // resolves it. NOT the source: this is the write half.
    let dir = crate::paths::vault_dir_for_id(&app, state.active_vault_id().await)
        .map_err(|_| ImportSourceDictionaryError::Io)?;
    // #255's refusal, inherited deliberately: persisting a set we never managed
    // to read would overwrite the target's stored dictionary with one built
    // from the source alone. Refuse instead, and the import reports it.
    if !spell.is_hydrated() {
        return Err(ImportSourceDictionaryError::Unreadable);
    }
    let (snapshot, added) = spell
        .merge_personal(&words)
        .ok_or(ImportSourceDictionaryError::Io)?;
    crate::spell::sync::persist_dictionary_with_dir(&dir, state.inner(), &snapshot)
        .await
        .map_err(|_| ImportSourceDictionaryError::Io)?;
    Ok(DictionaryCarry { added, read })
}

/// Testable core: read a vault directory's `vault.dictionary` under `root_key`
/// and return its ADDED words.
///
/// Split out from the command so the ignore-set exclusion can be asserted
/// without a Tauri runtime. That assertion is the reason this function exists:
/// the exclusion is a product decision, not an implementation detail, and a
/// decision with no test is a decision the next refactor reverses.
pub fn added_words_from_dir(
    vault_root: &std::path::Path,
    root_key: &[u8; protocol::AEAD_KEY_LEN],
    version: protocol::MetaVersion,
    account_number_hash: &[u8; protocol::VAULT_META_ACCOUNT_HASH_LEN],
) -> Result<SourceDictionaryWords, ImportSourceDictionaryError> {
    let dict_key = derive_subkey_versioned(version, root_key, SubkeyRole::PersonalDictKey);
    let data =
        crate::spell::sync::hydrate_payload_from_dir(vault_root, &dict_key, account_number_hash)
            .map_err(|e| match e {
                crate::spell::sync::SpellSyncError::Io => ImportSourceDictionaryError::Io,
                _ => ImportSourceDictionaryError::Unreadable,
            })?;

    // The ignore set is dropped HERE, at the one place it could have crossed,
    // rather than being filtered by a caller. A caller that forgets is a bug
    // nobody sees; a field that is never returned cannot be forgotten.
    Ok(SourceDictionaryWords {
        personal_words: data.personal_words,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spell::dictionary::PersonalDictionaryData;
    use myne_core::test_support::ScopedTempDir;
    use protocol::encode_dictionary_blob_versioned;

    const ROOT: [u8; protocol::AEAD_KEY_LEN] = [0xC1; protocol::AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; protocol::VAULT_META_ACCOUNT_HASH_LEN] =
        [0xC2; protocol::VAULT_META_ACCOUNT_HASH_LEN];

    fn seal_dictionary(root: &std::path::Path, personal: &[&str], ignore: &[&str]) {
        let data = PersonalDictionaryData {
            personal_words: personal.iter().map(|s| s.to_string()).collect(),
            ignore_words: ignore.iter().map(|s| s.to_string()).collect(),
        };
        let dict_key = derive_subkey_versioned(
            protocol::MetaVersion::V0_1,
            &ROOT,
            SubkeyRole::PersonalDictKey,
        );
        let blob = encode_dictionary_blob_versioned(
            protocol::MetaVersion::V0_1,
            &dict_key,
            &ACCOUNT_HASH,
            &data.encode(),
        )
        .expect("seal dictionary");
        std::fs::write(root.join("vault.dictionary"), blob).expect("write dictionary");
    }

    /// The decision from the design session, asserted directly: the added words
    /// cross and the vault-wide ignore set does not. Both sets are present in
    /// the source, so a regression that carried everything would show up here
    /// rather than in a user's spell-check months later.
    #[test]
    fn added_words_cross_and_the_ignore_set_does_not() {
        let tmp = ScopedTempDir::new("import-dict").expect("temp");
        seal_dictionary(
            tmp.path(),
            &["Kubernetes", "myne", "Ünsalan"],
            &["definately", "teh"],
        );

        let out = added_words_from_dir(
            tmp.path(),
            &ROOT,
            protocol::MetaVersion::V0_1,
            &ACCOUNT_HASH,
        )
        .expect("the dictionary reads");

        assert_eq!(out.personal_words, vec!["Kubernetes", "myne", "Ünsalan"]);
        // The ignore words are not merely filtered out of a returned list, they
        // have nowhere to be: `SourceDictionaryWords` has one field.
        assert!(
            !out.personal_words
                .iter()
                .any(|w| w == "teh" || w == "definately"),
            "an ignore-set word must never appear among the added words"
        );
    }

    /// A source vault that never taught the spell checker anything reads as an
    /// empty set, not as an error. `hydrate_payload_from_dir` treats an absent
    /// file as the one benign absence, and this pins that the import path
    /// inherits that rather than reporting a failure the user cannot act on.
    #[test]
    fn a_vault_with_no_dictionary_reads_as_empty() {
        let tmp = ScopedTempDir::new("import-dict-absent").expect("temp");
        let out = added_words_from_dir(
            tmp.path(),
            &ROOT,
            protocol::MetaVersion::V0_1,
            &ACCOUNT_HASH,
        )
        .expect("an absent dictionary is not an error");
        assert!(out.personal_words.is_empty());
    }

    /// A dictionary sealed under a DIFFERENT vault's key is `Unreadable`, not
    /// empty. Collapsing it to empty would tell the user nothing crossed when
    /// in fact nothing was read, and those are different sentences in the
    /// import report.
    #[test]
    fn a_dictionary_from_another_vault_is_unreadable_not_empty() {
        let tmp = ScopedTempDir::new("import-dict-wrongkey").expect("temp");
        seal_dictionary(tmp.path(), &["present"], &[]);

        let other_root = [0xD9u8; protocol::AEAD_KEY_LEN];
        let err = added_words_from_dir(
            tmp.path(),
            &other_root,
            protocol::MetaVersion::V0_1,
            &ACCOUNT_HASH,
        )
        .expect_err("the AEAD tag must refuse");
        assert!(matches!(err, ImportSourceDictionaryError::Unreadable));
    }
}
