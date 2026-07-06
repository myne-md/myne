//! Desktop `attachment_import` command wrapper (MYND-169 / MYND-328).
//!
//! The platform-agnostic import core lives in
//! `myne_core::plugins::attachments::commands::attachment_import_with_dir_ext`,
//! which takes the text-extraction *producer* as an injected closure so the
//! shared crate never pulls the desktop-only `lopdf`/`zip`/`quick-xml` deps.
//! This desktop wrapper injects the real extractor
//! ([`crate::plugins::attachments::extract::extract`]) so a desktop import
//! eagerly populates the `MYE1` extracted-text cache (search parity) — the
//! behavior the eager-extraction block had before the extraction into
//! `myne-core`. Mobile registers the core `attachment_import` command instead,
//! which is extraction-free (no cache written).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use myne_core::plugins::attachments::commands::{
    attachment_import_with_dir_ext, ImportSource, ImportedAttachment,
};
use myne_core::plugins::attachments::error::AttachmentImportError;
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use tauri::{AppHandle, Runtime, State};

/// `Slot::Unlocked`-gated attachment import with eager `MYE1` text extraction
/// (the desktop path). Resolves the active vault dir, then delegates to the
/// shared `attachment_import_with_dir_ext` core with the desktop text extractor
/// injected — so a fresh, extractable import (PDF / DOCX / text) is immediately
/// searchable by its contents. Mobile uses the extraction-free core command.
#[tauri::command]
pub async fn attachment_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    source: ImportSource,
) -> Result<ImportedAttachment, AttachmentImportError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(AttachmentImportError::from)?;
    attachment_import_with_dir_ext(
        &dir,
        state.inner(),
        source,
        crate::plugins::attachments::extract::extract,
    )
    .await
}

#[cfg(test)]
mod tests {
    use crate::plugins::attachments::commands::{
        attachment_clean_unused_with_dir, attachment_delete_with_dir,
        attachment_import_with_dir_ext, hex_decode_id, ImportSource,
    };
    use crate::plugins::attachments::extract;
    use crate::plugins::attachments::text_cache;
    use crate::plugins::vault_unlock::state::{
        fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
    };
    use crate::test_support::ScopedTempDir;
    use protocol::{derive_subkey, SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN};
    use std::path::Path;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    const SEED_ROOT: u8 = 0x42;
    const SEED_ITEMS: u8 = 0x99;
    const SEED_ITEMS_ID: u8 = 1;
    const SEED_ACCOUNT_HASH: u8 = 0x33;

    fn seed_vault_meta(dir: &Path, seed: u8) {
        let meta = protocol::VaultMeta {
            account_number_hash: [seed; VAULT_META_ACCOUNT_HASH_LEN],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [7u8; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
        };
        std::fs::write(
            dir.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed vault.meta");
    }

    async fn temp_vault() -> (ScopedTempDir, VaultRuntimeState) {
        let tmp = ScopedTempDir::new("attach-import-desktop").expect("scoped tempdir");
        seed_vault_meta(tmp.path(), SEED_ACCOUNT_HASH);
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(SEED_ROOT, SEED_ITEMS, SEED_ITEMS_ID),
            )
            .await;
        (tmp, state)
    }

    /// Import through the desktop path (real extractor injected) — the seam the
    /// desktop `attachment_import` command uses.
    async fn import_desktop(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        source: ImportSource,
    ) -> Result<
        myne_core::plugins::attachments::commands::ImportedAttachment,
        myne_core::plugins::attachments::error::AttachmentImportError,
    > {
        attachment_import_with_dir_ext(vault_dir, state, source, extract::extract).await
    }

    #[test]
    fn import_eagerly_caches_extracted_text() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let imported = import_desktop(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: b"searchable attachment body alpha".to_vec(),
                    filename: Some("note.txt".to_string()),
                },
            )
            .await
            .expect("import succeeds");

            let id = hex_decode_id(&imported.id).expect("valid id");
            let key = derive_subkey(&[SEED_ROOT; 32], SubkeyRole::AttachmentTextKey);
            let cached =
                text_cache::read_extracted(tmp.path(), &key, &[SEED_ACCOUNT_HASH; 16], &id)
                    .expect("MYE1 cache written at import");
            assert_eq!(cached.status, extract::ExtractStatus::Ok);
            assert!(cached.text.contains("searchable attachment body alpha"));
        });
    }

    #[test]
    fn import_unsupported_writes_no_text_cache() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            // Opaque bytes + an unsupported extension → octet-stream + Unsupported
            // → no cache blob (images/binaries are not text-cached).
            let imported = import_desktop(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: b"\x00\x01\x02 binary blob".to_vec(),
                    filename: Some("thing.bin".to_string()),
                },
            )
            .await
            .expect("import succeeds");

            let id = hex_decode_id(&imported.id).expect("valid id");
            assert!(
                !text_cache::cache_path(tmp.path(), &id).exists(),
                "no MYE1 cache blob for an unsupported attachment"
            );
        });
    }

    #[test]
    fn clean_unused_crypto_erases_the_mye1_text_cache() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            // Import a text attachment: eager extraction writes its MYE1 cache.
            let imported = import_desktop(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: b"searchable attachment body to be crypto-erased".to_vec(),
                    filename: Some("note.txt".to_string()),
                },
            )
            .await
            .expect("import succeeds");
            let id = hex_decode_id(&imported.id).expect("valid id");
            assert!(
                text_cache::cache_path(tmp.path(), &id).exists(),
                "MYE1 cache present after import"
            );

            // No note references it, so clean_unused deletes it. The MYE1 cache
            // MUST go too — otherwise the "permanently deleted" attachment's
            // searchable plaintext stays decryptable (§9.15.4 crypto-erase parity).
            let result =
                attachment_clean_unused_with_dir(tmp.path(), &state, vec![imported.id.clone()])
                    .await
                    .expect("clean_unused succeeds");
            assert_eq!(result.deleted, 1);
            assert!(
                !text_cache::cache_path(tmp.path(), &id).exists(),
                "MYE1 cache removed on clean_unused (crypto-erase parity)"
            );
        });
    }

    #[test]
    fn delete_removes_the_extracted_text_cache() {
        // MYND-328 Task 8: permanent delete erases the MYE1 cache (crypto-erase
        // parity with the MYA1 source).
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let imported = import_desktop(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: b"deletable searchable text body".to_vec(),
                    filename: Some("d.txt".to_string()),
                },
            )
            .await
            .expect("import succeeds");
            let id = hex_decode_id(&imported.id).expect("valid id");
            let key = derive_subkey(&[SEED_ROOT; 32], SubkeyRole::AttachmentTextKey);

            // Cache present after the eager import...
            assert!(
                text_cache::read_extracted(tmp.path(), &key, &[SEED_ACCOUNT_HASH; 16], &id)
                    .is_some(),
                "import eager-cached the text"
            );

            attachment_delete_with_dir(tmp.path(), &state, imported.id.clone())
                .await
                .expect("delete succeeds");

            // ...and gone after delete.
            assert!(
                !text_cache::cache_path(tmp.path(), &id).exists(),
                "delete removed the MYE1 cache blob"
            );
        });
    }
}
