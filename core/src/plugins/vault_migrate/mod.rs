// SPDX-License-Identifier: AGPL-3.0-only
//! Vault-generation helpers that still have a live caller.
//!
//! This module used to carry the whole-vault v0.1 -> v0.2 migration
//! (`spec/protocol.md` §10.4.1) and the `NTV6 -> NTV7 -> NTV8` upgrade chain.
//! Every vault created by this build is born v0.2 (`NTV8` for a person-born
//! vault, `NTV5` for a password-only one), and the product accepts no
//! pre-v0.13 vault, so those paths had no reachable input and were removed.
//!
//! Two things kept a caller and stay here:
//!
//! * [`adopt`] — a peer's newer `vault.meta` is staged and promoted through the
//!   sync plane, which moves between v0.2 generations and is not a version
//!   migration.
//! * [`b2b`] — minting the group tier for a password-only (`NTV5`) vault when
//!   its owner enables sharing. That vault is created today, so this path is
//!   live.

pub(crate) mod adopt;
pub mod b2b;

use crate::vault_io::VaultIo;
use std::path::Path;

const STALE_UNDER_REPLACED_ROOT: &[&str] = &[
    "vault.search",
    "vault.workspace",
    "vault.indices",
    "vault.graph",
    // A retired family, kept because an older v0.2 session really did build this
    // file: it answers "what did the OLD root seal", and a migration meeting one
    // still has to drop it.
    "vault.embeddings",
    "vault.quickunlock",
    "vault.quickunlock.attempts",
    "vault.head-state",
];

/// Remove every artefact [`STALE_UNDER_REPLACED_ROOT`] names, plus `also`, plus
/// the per-attachment extracted-text cache subtree.
///
/// Best-effort throughout: a delete failure must never abort a committed re-key
/// or a promotion the user's credential already proved. What is left behind is
/// undecryptable bytes, which every reader on this path already tolerates.
pub(crate) async fn drop_artefacts_sealed_under_replaced_root(
    io: &dyn VaultIo,
    vault_root: &Path,
    also: &[&str],
) {
    for stale in STALE_UNDER_REPLACED_ROOT.iter().chain(also) {
        let _ = io.remove_file(&vault_root.join(stale)).await;
    }
    // `attachments-text/` (`MYE1`, §9.15) is a rebuildable search-extraction
    // cache under the old key — the whole subtree goes, so it re-extracts on
    // demand rather than lingering undecryptable.
    let _ = io
        .remove_dir_all(&vault_root.join("attachments-text"))
        .await;
}
