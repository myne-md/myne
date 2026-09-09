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
    hooks: State<'_, myne_core::hooks::Hooks>,
    source: ImportSource,
    // Optional original-creation timestamp (UNIX seconds) for the imported file;
    // omitted by the ordinary paste/drop/import path (stamps "now"). Set when
    // re-materializing a file that carries its own creation time (a restore /
    // migration import) so the unused-cleanup grace window measures from the
    // file's real age, not the moment of import.
    created_at: Option<u64>,
) -> Result<ImportedAttachment, AttachmentImportError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(AttachmentImportError::from)?;
    // MYND-441: the image-OCR opt-out gates THIS path too, not only the
    // background worker. Without it, a user who turned the switch off would
    // still pay three model passes per imported image — and, for a scanned PDF,
    // still block this IPC while they wait. An unreadable prefs blob reads as
    // ON, matching the worker: a prefs read failure must not silently disable a
    // search feature.
    let ocr_enabled = myne_core::plugins::prefs::commands::prefs_read_with_dir(
        &dir,
        state.inner(),
        &myne_core::vault_io::StdVaultIo,
    )
    .await
    .map(|p| p.attachment_ocr_enabled)
    .unwrap_or(true);
    let extractor = if ocr_enabled {
        crate::plugins::attachments::extract::extract
    } else {
        crate::plugins::attachments::extract::extract_deferring_ocr
    };
    let result = attachment_import_with_dir_ext(
        &myne_core::vault_io::StdVaultIo,
        &myne_core::host::tauri_host::TauriHost::new(app.clone()),
        &dir,
        state.inner(),
        source,
        // The ordinary paste / drop / file-pick path: bytes arriving from
        // outside the vault for the first time, so the user's compression
        // preference is the answer about them. `created_at` is `Some` only when
        // the caller is re-materializing a file that carries its own age.
        myne_core::plugins::attachments::commands::IngestPolicy {
            created_at_override: created_at,
            compression: myne_core::plugins::attachments::commands::IngestCompression::Apply,
        },
        extractor,
    )
    .await;
    // MYND-468: a fresh import (not a dedup hit) is a local sync change — the
    // blob + catalog must push on the next coalesced cycle.
    if matches!(&result, Ok(imported) if !imported.deduplicated) {
        hooks.bump_local_change();
    }
    result
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
            membership: None,
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
        attachment_import_with_dir_ext(
            &myne_core::vault_io::StdVaultIo,
            &myne_core::host::test_host::TestHost::new("/nonexistent-import-desktop-test-host"),
            vault_dir,
            state,
            source,
            myne_core::plugins::attachments::commands::IngestPolicy::fresh(),
            extract::extract,
        )
        .await
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

    /// Importing a scanned image makes it searchable, through the whole desktop
    /// path rather than through any one half of it.
    ///
    /// **`image-ocr-search`'s io1 measured this to be broken and nothing here
    /// could say where.** That scenario imports this exact fixture through the
    /// real IPC and then cannot find the note by a word only the pixels contain;
    /// the gate added to it reported an EMPTY MYE1 entry. Every unit below it
    /// passes: the OCR pipeline reads the fixture, ingest compression preserves
    /// what it reads, `is_ocr_image` accepts the compressed container, and the
    /// weights are present and real. The composition had no test at all, so the
    /// one place the failure could live was the one place nothing looked.
    ///
    /// This is that place: the real extractor, the real import, the real cache,
    /// on the runner that actually builds the product. It either fails and names
    /// the layer, or it passes and moves the search elsewhere.
    #[test]
    fn importing_a_scanned_image_caches_text_search_can_find() {
        // Skips only on a checkout without Git-LFS blobs, never on a real load
        // failure — see `ocr::init_bundled_models_for_tests`.
        if !init_ocr_for_tests() {
            return;
        }
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let png = std::fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("core")
                    .join("tests")
                    .join("fixtures")
                    .join("ocr-sample.png"),
            )
            .expect("fixture reads");

            let imported = import_desktop(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: png,
                    filename: Some("fatura-taramasi.png".to_string()),
                },
            )
            .await
            .expect("import succeeds");

            let id = hex_decode_id(&imported.id).expect("valid id");
            let key = derive_subkey(&[SEED_ROOT; 32], SubkeyRole::AttachmentTextKey);
            let cached =
                text_cache::read_extracted(tmp.path(), &key, &[SEED_ACCOUNT_HASH; 16], &id).expect(
                    "an OCR'd image must leave an MYE1 entry; its absence is what io1 sees \
                         from the outside as a note that cannot be found by its own pixels",
                );
            assert_eq!(
                cached.status,
                extract::ExtractStatus::Ok,
                "extracted {} char(s) with status {:?}",
                cached.text.chars().count(),
                cached.status
            );
            assert!(
                cached.text.to_lowercase().contains("invoice"),
                "the cached text must carry the word the image renders, got {:?}",
                cached.text
            );
        });
    }

    /// Install the bundled OCR weights, reporting whether this checkout has any.
    /// Panics when the weights are present and will not load — see
    /// `ocr::init_bundled_models_for_tests` for why the two must not look alike.
    fn init_ocr_for_tests() -> bool {
        myne_core::plugins::attachments::ocr::init_bundled_models_for_tests()
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
            let result = attachment_clean_unused_with_dir(
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::test_host::TestHost::new("/nonexistent-import-desktop-test-host"),
                tmp.path(),
                &state,
                vec![imported.id.clone()],
            )
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

            attachment_delete_with_dir(
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::test_host::TestHost::new("/nonexistent-import-desktop-test-host"),
                tmp.path(),
                &state,
                imported.id.clone(),
            )
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
