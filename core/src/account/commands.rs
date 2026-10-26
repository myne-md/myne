// SPDX-License-Identifier: AGPL-3.0
//! The account-record command surface (the account/vault split,
//! `decisions.md` 2026-09-07).
//!
//! Commands over [`super::store`]: list the account grouping, move a vault
//! between accounts, and split a vault into a new account. All are reachable
//! **pre-unlock** (the picker is the surface they govern), and none touches vault
//! content.
//!
//! There is no rename: an account has no name (`docs/decisions/ui/0728`), and the
//! heading a client draws for a group comes from that group's own vault names.
//! The account number a user shows on this surface is the person identity's,
//! derived from the phrase, not a property of this record.
//!
//! ## No path here writes user text
//!
//! The only values that cross IPC are hex account ids, canonical vault ids and
//! the hide-vault-names refusal. Nothing is user-authored, so there is no string
//! that could be logged, quoted in an error, or written in the clear.

use crate::account::error::AccountError;
use crate::account::store::{
    hex, hide_names_on, load_account, load_account_tracked, write_account, Account, ACCOUNT_ID_LEN,
};
use crate::io_failure_kind::IoFailureKind;
use crate::vault_id::VaultId;
use crate::vault_io::VaultIo;
use crate::vault_label::key::LabelKeychain;
use serde::Serialize;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// One account in the grouping view: the account id and its member vault ids.
/// The DENY-list-clean IPC projection of an [`Account`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountView {
    /// The account id, hex-encoded (16 bytes → 32 hex chars).
    pub id: String,
    /// The member vault ids, canonical 36-char strings.
    pub vaults: Vec<String>,
}

impl From<&Account> for AccountView {
    fn from(a: &Account) -> Self {
        AccountView {
            id: hex(a.account_id),
            vaults: a.vaults.iter().map(|v| v.to_string()).collect(),
        }
    }
}

/// Failure surface for the command set. No `String` and no path, and **no
/// variant can carry user text** (there is none to carry).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AccountCommandError {
    /// The record file could not be read or written.
    #[error("filesystem error on the account record")]
    Io { io_error_kind: IoFailureKind },
    /// This device has no usable OS keychain, so there is no record and no
    /// grouping. Vaults keep working standalone.
    #[error("device keychain unavailable")]
    KeychainUnavailable,
    /// The named vault is not a member of any account (or does not exist).
    #[error("vault not found in any account")]
    VaultNotFound,
    /// Opaque backend failure.
    #[error("account record backend failure")]
    Backend,
    /// Account grouping is suppressed while hide-vault-names is on.
    #[error("account actions unavailable while vault names are hidden")]
    Hidden,
    /// The on-disk record is undecryptable, so persisting a rebuild would
    /// destroy bytes a restored key could still open. The mutation is
    /// refused; the caller keeps the in-memory view.
    #[error("account record unreadable, refusing to overwrite")]
    RecordUnreadable,
    /// No vault is unlocked. Move and split are refused on a locked device: a
    /// locked-screen observer may read the grouping but must not persist a
    /// regrouping without any vault password (myne-md/myne#684 land gate).
    #[error("account mutations require an unlocked vault")]
    Locked,
}

impl From<AccountError> for AccountCommandError {
    fn from(e: AccountError) -> Self {
        match e {
            AccountError::KeychainUnavailable => AccountCommandError::KeychainUnavailable,
            AccountError::Io(kind) => AccountCommandError::Io {
                io_error_kind: kind,
            },
            AccountError::Hidden => AccountCommandError::Hidden,
            AccountError::RecordUnreadable => AccountCommandError::RecordUnreadable,
            _ => AccountCommandError::Backend,
        }
    }
}

/// List the account grouping. Returns an empty `Vec` when there is no account
/// (no vaults, or the keychain is unavailable), which is the standalone state.
///
/// Returns empty while hide-vault-names is on: group headers name accounts on
/// the lock screen, so they follow the same suppression as vault names, with
/// zero frontend changes (no accounts means standalone rows and no headers).
pub async fn list_accounts_at(
    io: &dyn VaultIo,
    config_dir: &Path,
    base: &Path,
    keychain: &dyn LabelKeychain,
) -> Result<Vec<AccountView>, AccountCommandError> {
    if hide_names_on(io, config_dir).await {
        return Ok(vec![]);
    }
    let record = load_account(io, config_dir, base, keychain).await?;
    Ok(record.accounts.iter().map(AccountView::from).collect())
}

/// Move `vault_id` into the account owning `target_vault_id`. Both must be
/// members of some account; the source account is pruned if it becomes empty.
///
/// Rejected while hide-vault-names is on, like the other mutations.
pub async fn move_vault_at(
    io: &dyn VaultIo,
    config_dir: &Path,
    base: &Path,
    keychain: &dyn LabelKeychain,
    vault_id: VaultId,
    target_vault_id: VaultId,
) -> Result<Vec<AccountView>, AccountCommandError> {
    if hide_names_on(io, config_dir).await {
        return Err(AccountCommandError::Hidden);
    }
    let mut loaded = load_account_tracked(io, config_dir, base, keychain).await?;
    if !loaded.writable() {
        return Err(AccountCommandError::RecordUnreadable);
    }
    let record = &mut loaded.record;
    if vault_id == target_vault_id {
        return Ok(record.accounts.iter().map(AccountView::from).collect());
    }
    // Find the source and target accounts.
    let source_idx = record
        .accounts
        .iter()
        .position(|a| a.vaults.contains(&vault_id))
        .ok_or(AccountCommandError::VaultNotFound)?;
    let target_idx = record
        .accounts
        .iter()
        .position(|a| a.vaults.contains(&target_vault_id))
        .ok_or(AccountCommandError::VaultNotFound)?;

    if source_idx == target_idx {
        // Same account: a no-op.
        return Ok(record.accounts.iter().map(AccountView::from).collect());
    }

    // Remove from source, add to target.
    record.accounts[source_idx]
        .vaults
        .retain(|v| *v != vault_id);
    record.accounts[target_idx].vaults.push(vault_id);
    // Prune the source account if empty.
    record.accounts.retain(|a| !a.vaults.is_empty());

    write_account(io, config_dir, keychain, &*record).await?;
    Ok(record.accounts.iter().map(AccountView::from).collect())
}

/// Split `vault_id` into a fresh account. The source account is pruned if it
/// becomes empty.
///
/// Rejected while hide-vault-names is on, like the other mutations.
pub async fn split_vault_at(
    io: &dyn VaultIo,
    config_dir: &Path,
    base: &Path,
    keychain: &dyn LabelKeychain,
    vault_id: VaultId,
) -> Result<Vec<AccountView>, AccountCommandError> {
    if hide_names_on(io, config_dir).await {
        return Err(AccountCommandError::Hidden);
    }
    let mut loaded = load_account_tracked(io, config_dir, base, keychain).await?;
    if !loaded.writable() {
        return Err(AccountCommandError::RecordUnreadable);
    }
    let record = &mut loaded.record;
    let source_idx = record
        .accounts
        .iter()
        .position(|a| a.vaults.contains(&vault_id))
        .ok_or(AccountCommandError::VaultNotFound)?;

    record.accounts[source_idx]
        .vaults
        .retain(|v| *v != vault_id);
    record.accounts.retain(|a| !a.vaults.is_empty());

    let mut new_id = [0u8; ACCOUNT_ID_LEN];
    getrandom::getrandom(&mut new_id).map_err(|_| AccountCommandError::Backend)?;
    record.accounts.push(Account {
        account_id: new_id,
        vaults: vec![vault_id],
    });

    write_account(io, config_dir, keychain, &*record).await?;
    Ok(record.accounts.iter().map(AccountView::from).collect())
}

// ---- layer 1: the host-taking cores ----------------------------------------

/// [`list_accounts_at`] against the device's own directories.
pub async fn list_accounts_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    keychain: &dyn LabelKeychain,
) -> Result<Vec<AccountView>, AccountCommandError> {
    let (base, config_dir) = dirs(host)?;
    list_accounts_at(io, &config_dir, &base, keychain).await
}

/// [`move_vault_at`] against the device's own directories.
pub async fn move_vault_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    keychain: &dyn LabelKeychain,
    vault_id: VaultId,
    target_vault_id: VaultId,
) -> Result<Vec<AccountView>, AccountCommandError> {
    let (base, config_dir) = dirs(host)?;
    move_vault_at(io, &config_dir, &base, keychain, vault_id, target_vault_id).await
}

/// [`split_vault_at`] against the device's own directories.
pub async fn split_vault_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    keychain: &dyn LabelKeychain,
    vault_id: VaultId,
) -> Result<Vec<AccountView>, AccountCommandError> {
    let (base, config_dir) = dirs(host)?;
    split_vault_at(io, &config_dir, &base, keychain, vault_id).await
}

fn dirs(host: &dyn crate::host::HostCtx) -> Result<(PathBuf, PathBuf), AccountCommandError> {
    let base = host.app_data_dir().map_err(|_| AccountCommandError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    let config_dir = host.app_config_dir().map_err(|_| AccountCommandError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    Ok((base, config_dir))
}

// ---- layer 2: the IPC wrappers ---------------------------------------------

/// List the account grouping. Reachable pre-unlock.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn account_list<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<AccountView>, AccountCommandError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    list_accounts_from_host(
        &host,
        &crate::vault_io::StdVaultIo,
        crate::vault_label::key::platform_keychain(),
    )
    .await
}

/// Move `vault_id` into the account owning `target_vault_id`.
///
/// Refused while hide-vault-names is on, like the other mutations, and when
/// no vault is unlocked.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn account_move<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
    vault_id: String,
    target_vault_id: String,
) -> Result<Vec<AccountView>, AccountCommandError> {
    if state.inner().active_vault_id().await.is_none() {
        return Err(AccountCommandError::Locked);
    }
    let host = crate::host::tauri_host::TauriHost::new(app);
    let vault_id = VaultId::parse(&vault_id).map_err(|_| AccountCommandError::VaultNotFound)?;
    let target_vault_id =
        VaultId::parse(&target_vault_id).map_err(|_| AccountCommandError::VaultNotFound)?;
    move_vault_from_host(
        &host,
        &crate::vault_io::StdVaultIo,
        crate::vault_label::key::platform_keychain(),
        vault_id,
        target_vault_id,
    )
    .await
}

/// Split `vault_id` into a fresh account.
///
/// Refused when no vault is unlocked, like the other mutations.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn account_split<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
    vault_id: String,
) -> Result<Vec<AccountView>, AccountCommandError> {
    if state.inner().active_vault_id().await.is_none() {
        return Err(AccountCommandError::Locked);
    }
    let host = crate::host::tauri_host::TauriHost::new(app);
    let vault_id = VaultId::parse(&vault_id).map_err(|_| AccountCommandError::VaultNotFound)?;
    split_vault_from_host(
        &host,
        &crate::vault_io::StdVaultIo,
        crate::vault_label::key::platform_keychain(),
        vault_id,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use crate::vault_label::fake_keychain::FakeKeychain;
    use std::path::PathBuf;

    struct Device {
        _dir: ScopedTempDir,
        base: PathBuf,
        config: PathBuf,
    }

    fn device() -> Device {
        let dir = ScopedTempDir::new("account-cmds").expect("scratch");
        let base = dir.path().join("data");
        let config = dir.path().join("config");
        std::fs::create_dir_all(&config).expect("config");
        Device {
            _dir: dir,
            base,
            config,
        }
    }

    fn seed_vault(base: &Path) -> VaultId {
        let id = VaultId::mint();
        let dir = base.join("vaults").join(id.to_string());
        std::fs::create_dir_all(&dir).expect("vault dir");
        std::fs::write(dir.join("vault.meta"), b"any").expect("meta");
        id
    }

    #[test]
    fn upgrade_with_n_vaults_produces_one_account_with_n_members() {
        let d = device();
        let a = seed_vault(&d.base);
        let b = seed_vault(&d.base);
        let c = seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        block_on(async {
            let views = list_accounts_at(&StdVaultIo, &d.config, &d.base, &keychain)
                .await
                .expect("list");
            assert_eq!(views.len(), 1, "one account");
            assert_eq!(views[0].vaults.len(), 3, "three members");
            let mut ids: Vec<String> = views[0].vaults.clone();
            ids.sort();
            let mut expected = vec![a.to_string(), b.to_string(), c.to_string()];
            expected.sort();
            assert_eq!(ids, expected);
        });
    }

    #[test]
    fn split_moves_a_vault_into_a_fresh_account() {
        let d = device();
        let a = seed_vault(&d.base);
        let b = seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        block_on(async {
            let views = split_vault_at(&StdVaultIo, &d.config, &d.base, &keychain, a)
                .await
                .expect("split");
            assert_eq!(views.len(), 2, "two accounts after split");
            let mut all: Vec<String> = views.iter().flat_map(|v| v.vaults.clone()).collect();
            all.sort();
            let mut expected = vec![a.to_string(), b.to_string()];
            expected.sort();
            assert_eq!(all, expected);
        });
    }

    #[test]
    fn move_between_accounts_round_trips() {
        let d = device();
        let a = seed_vault(&d.base);
        let _b = seed_vault(&d.base);
        let c = seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        block_on(async {
            // Split a into its own account first, so there are two accounts.
            split_vault_at(&StdVaultIo, &d.config, &d.base, &keychain, a)
                .await
                .expect("split");
            // Now move c into a's account.
            let views = move_vault_at(&StdVaultIo, &d.config, &d.base, &keychain, c, a)
                .await
                .expect("move");
            assert_eq!(views.len(), 2, "still two accounts");
            // a's account now holds a and c.
            let a_account = views
                .iter()
                .find(|v| v.vaults.contains(&a.to_string()))
                .unwrap();
            assert!(a_account.vaults.contains(&c.to_string()));
        });
    }

    #[test]
    fn an_unavailable_keychain_lists_nothing_and_never_errors() {
        let d = device();
        seed_vault(&d.base);
        let none = FakeKeychain::unavailable();
        block_on(async {
            let views = list_accounts_at(&StdVaultIo, &d.config, &d.base, &none)
                .await
                .expect("list");
            assert!(views.is_empty(), "no keychain → no grouping");
        });
        assert!(
            !crate::account::store::account_path(&d.config).exists(),
            "and no record file was written"
        );
    }

    /// The grouping is the only secret this file holds, so that is what the
    /// sealing claim is asserted on. Until `docs/decisions/ui/0728` the record
    /// also carried an account label and this test named it; a check whose
    /// subject has been deleted passes forever, so the assertion moved to the
    /// values a write still produces: the account id and the member vault ids.
    #[test]
    fn the_record_file_carries_no_plaintext_grouping() {
        let d = device();
        let a = seed_vault(&d.base);
        let b = seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        block_on(async {
            // A split is what persists a record: listing deliberately does not.
            split_vault_at(&StdVaultIo, &d.config, &d.base, &keychain, a)
                .await
                .expect("split");
        });
        let bytes = std::fs::read(crate::account::store::account_path(&d.config)).expect("read");
        for id in [a.to_string(), b.to_string()] {
            assert!(
                !bytes.windows(id.len()).any(|w| w == id.as_bytes()),
                "a plaintext member vault id must not appear anywhere in the file"
            );
        }
        assert!(
            !bytes.windows(8).any(|w| w == b"account_"),
            "the plaintext record JSON must not appear anywhere in the file"
        );
    }

    #[test]
    fn a_corrupt_record_rebuilds_from_the_scan() {
        let d = device();
        let a = seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        std::fs::write(
            crate::account::store::account_path(&d.config),
            b"not a record {{{",
        )
        .expect("corrupt");
        block_on(async {
            let views = list_accounts_at(&StdVaultIo, &d.config, &d.base, &keychain)
                .await
                .expect("list");
            assert_eq!(views.len(), 1);
            assert_eq!(views[0].vaults, vec![a.to_string()]);
        });
    }

    #[test]
    fn the_account_id_is_hex_encoded() {
        let d = device();
        seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        block_on(async {
            let views = list_accounts_at(&StdVaultIo, &d.config, &d.base, &keychain)
                .await
                .expect("list");
            assert_eq!(views[0].id.len(), ACCOUNT_ID_LEN * 2);
        });
    }

    #[test]
    fn list_never_writes_a_record_file() {
        let d = device();
        seed_vault(&d.base);
        seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        block_on(async {
            let views = list_accounts_at(&StdVaultIo, &d.config, &d.base, &keychain)
                .await
                .expect("list");
            assert_eq!(views.len(), 1, "grouping still reads");
        });
        assert!(
            !crate::account::store::account_path(&d.config).exists(),
            "listing must not persist the in-memory rebuild"
        );
    }

    #[test]
    fn mutations_refuse_rather_than_overwrite_unreadable_bytes() {
        let d = device();
        let a = seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        let path = crate::account::store::account_path(&d.config);
        std::fs::write(&path, b"not a record {{{").expect("corrupt");
        block_on(async {
            // No keychain key for these bytes: the source is Unreadable.
            assert_eq!(
                split_vault_at(&StdVaultIo, &d.config, &d.base, &keychain, a).await,
                Err(AccountCommandError::RecordUnreadable)
            );
        });
        assert_eq!(
            std::fs::read(&path).expect("read"),
            b"not a record {{{",
            "a refused mutation must not touch the undecryptable bytes"
        );
    }

    #[test]
    fn list_preserves_unreadable_bytes() {
        let d = device();
        seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        let path = crate::account::store::account_path(&d.config);
        std::fs::write(&path, b"not a record {{{").expect("corrupt");
        block_on(async {
            let views = list_accounts_at(&StdVaultIo, &d.config, &d.base, &keychain)
                .await
                .expect("list");
            assert_eq!(views.len(), 1, "caller still gets the rebuild");
        });
        assert_eq!(
            std::fs::read(&path).expect("read"),
            b"not a record {{{",
            "the undecryptable bytes must survive the list"
        );
    }

    fn hide_the_names(config: &Path) {
        std::fs::write(config.join("vault-names.json"), br#"{"hidden": true}"#).expect("flag");
    }

    #[test]
    fn list_returns_empty_while_names_are_hidden() {
        let d = device();
        let a = seed_vault(&d.base);
        seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        block_on(async {
            // A split persists a record, so the suppression below is proved
            // against a stored grouping rather than against a rebuild.
            split_vault_at(&StdVaultIo, &d.config, &d.base, &keychain, a)
                .await
                .expect("split");
        });
        hide_the_names(&d.config);
        block_on(async {
            let views = list_accounts_at(&StdVaultIo, &d.config, &d.base, &keychain)
                .await
                .expect("list");
            assert!(views.is_empty(), "hidden means no grouping leaves IPC");
        });
    }

    #[test]
    fn mutations_are_rejected_while_names_are_hidden() {
        let d = device();
        let a = seed_vault(&d.base);
        let keychain = FakeKeychain::empty();
        hide_the_names(&d.config);
        block_on(async {
            assert_eq!(
                split_vault_at(&StdVaultIo, &d.config, &d.base, &keychain, a).await,
                Err(AccountCommandError::Hidden)
            );
        });
    }
}
