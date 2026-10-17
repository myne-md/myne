// SPDX-License-Identifier: AGPL-3.0
//! Synchronous `vault.meta` + `MYC1` catalog reads for the desktop-only paths
//! that cannot await the storage seam (phase3-web-client task 44).
//!
//! # Why this exists
//!
//! Task 44 moved `myne_core::plugins::attachments` onto [`VaultIo`], which is
//! `async` because OPFS handle acquisition is — so `read_account_number_hash`
//! and `read_catalog` are `async fn`s now. Four desktop call sites cannot follow
//! them, and not because porting them is hard: they are **synchronous by
//! construction**, sitting inside `spawn_blocking` closures or plain sync
//! helpers.
//!
//! | Call site | Why it is synchronous |
//! |---|---|
//! | `ocr_queue` | a background sweep that runs entirely on a blocking worker |
//! | `search_sync` | the index rebuild, a sync function called from inside `spawn_blocking` |
//! | `desktop_commands` (×2) | the note/HTML attachment-export staging closures |
//!
//! Every one of them is gated out of the wasm build (`src-tauri` is not compiled
//! for `wasm32` at all), so `std::fs` here is correct rather than deferred —
//! the same status the io-seam ratchet already grants `export/commands.rs` and
//! the `captures` / `share_import` queues.
//!
//! # What is deliberately NOT duplicated
//!
//! The **decode** halves. `parse_vault_meta` and `read_or_empty` are called
//! here exactly as the async versions call them, so § 9.10.4's
//! fall-back-to-empty and the meta parse rule stay single-sourced in the
//! protocol crate. What this module owns is only the `std::fs::read` these
//! callers need instead of an `.await` — mirroring the precedent
//! `myne_core::plugins::export::commands` set for `vault.prefs`.
//!
//! There is no double-buffer arm and there should not be: a container-backed
//! store is a browser concern, and nothing that compiles into this crate has
//! one.
//!
//! [`VaultIo`]: myne_core::vault_io::VaultIo

use myne_core::plugins::attachments::commands::CatalogLoadError;
use protocol::{
    read_or_empty, AttachmentsCatalog, SubkeyRole, CATALOG_BLOB_ACCOUNT_HASH_LEN,
    VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::Path;

/// `vault.meta`'s `account_number_hash` — the catalog AAD identity (§ 9.10.3).
///
/// `Ok(None)` is "present but does not parse"; absence and every other IO
/// failure stay `Err`, which is the split the callers' `InvalidVaultMeta` vs
/// `Io` surfaces are built on.
pub fn read_account_number_hash(
    vault_meta_path: &Path,
) -> std::io::Result<Option<[u8; VAULT_META_ACCOUNT_HASH_LEN]>> {
    let bytes = std::fs::read(vault_meta_path)?;
    // Either generation (myne-md/myne#433): OCR queueing and attachment-text
    // indexing both gate on this hash.
    Ok(protocol::parse_vault_meta_any(&bytes)
        .map(|m| m.account_number_hash)
        .ok())
}

/// Read + decode the `MYC1` catalog, hard-erroring on any IO failure other than
/// absence (absent → the empty catalog, § 9.10.4's base case).
///
/// The hard-IO surface is the load-bearing half: every caller here is read-only
/// but feeds a decision — which attachments to OCR, which to index, which to
/// stage for export — and a masked-empty catalog would silently under-report.
pub fn read_catalog(
    catalog_path: &Path,
    catalog_key: &[u8; 32],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
) -> std::io::Result<AttachmentsCatalog> {
    match std::fs::read(catalog_path) {
        Ok(bytes) => Ok(read_or_empty(
            catalog_key,
            account_number_hash,
            Some(&bytes),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AttachmentsCatalog::empty()),
        Err(e) => Err(e),
    }
}

/// The full catalog-for-export ritual: meta hash → catalog KEK → read.
///
/// Returns the same closed [`CatalogLoadError`] the async core does, so the two
/// export staging closures keep their existing `match` arms verbatim.
pub fn load_catalog_for_export(
    vault_root: &Path,
    shared: &myne_core::plugins::vault_unlock::state::SharedSingletonKey,
) -> Result<AttachmentsCatalog, CatalogLoadError> {
    let account_number_hash = match read_account_number_hash(&vault_root.join("vault.meta")) {
        Ok(Some(h)) => h,
        Ok(None) => return Err(CatalogLoadError::InvalidVaultMeta),
        Err(e) => {
            return Err(CatalogLoadError::MetaIo(
                myne_core::io_failure_kind::from_io_error_kind(e.kind()),
            ))
        }
    };
    // Version-scoped (myne-md/myne#433). The migration re-seals the catalog to
    // `MYC5`, and `read_catalog` -> `read_or_empty` answers an EMPTY catalog
    // rather than an error when the KEK does not open it — so a v0.1 derivation
    // here did not fail the export, it exported a vault with no attachments.
    let version = std::fs::read(vault_root.join("vault.meta"))
        .ok()
        .and_then(|b| protocol::meta_version_of(&b))
        .unwrap_or(protocol::MetaVersion::V0_1);
    let catalog_key = shared.derive(version, SubkeyRole::AttachmentsCatalogKey);
    read_catalog(
        &vault_root.join("vault.attachments"),
        &catalog_key,
        &account_number_hash,
    )
    .map_err(|e| {
        CatalogLoadError::CatalogIo(myne_core::io_failure_kind::from_io_error_kind(e.kind()))
    })
}
