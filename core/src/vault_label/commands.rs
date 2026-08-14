// SPDX-License-Identifier: AGPL-3.0
//! The hide-vault-names command pair (myne-md/myne#411).
//!
//! Two commands over [`super::hide_flag`] and [`super::erase_all`]: read the
//! device-local flag, and write it. Both are reachable **pre-unlock**, for the
//! same reason the sync-endpoint pair is: the behaviour they govern happens on
//! the picker, before any vault is open, and neither touches vault content.
//!
//! ## Writing the flag ON is the erase
//!
//! Setting the flag is not a preference write that something else later acts
//! on. The erase happens in the same operation, because a flag that promised an
//! erase and left it to a later pass would be a claim on screen with nothing
//! behind it until that pass ran.
//!
//! ## The order is the honesty property
//!
//! **Erase first, persist second.** The two failure modes are not symmetric:
//!
//! * Persist-then-erase, with the erase failing, leaves the flag ON over live
//!   keys and readable ciphertext. The picker draws neutral fallbacks, the
//!   Settings row reads "hidden", and nothing on screen distinguishes that from
//!   a completed erase. It is the exact shape `decisions.md` 2026-08-15 forbids
//!   for the plaintext fallback: identical on screen, guarantee void.
//! * Erase-then-persist, with the persist failing, leaves keys destroyed and the
//!   flag OFF. The names are gone (they come back one at a time as each vault is
//!   unlocked again), the row still reads "shown", and the user retries. Nothing
//!   claims more than happened.
//!
//! The second is recoverable and the first is a lie, so the erase goes first.
//! The same argument decides a PARTIAL erase: `erase_all_labels` reports the
//! failure, the `?` here stops the flag being written, and the row does not move.
//!
//! What the ordering does **not** close is a concurrent unlock writing a fresh
//! label between the sweep and the persist. It is stated rather than claimed
//! away: on desktop the Settings panel and the unlock screen are mutually
//! exclusive surfaces in one window, so the interleaving is not reachable from
//! the shipped UI, and the remedy if it ever were is one more toggle.
//!
//! ## Writing the flag OFF resurrects nothing
//!
//! It writes the flag and stops. There is nothing to restore: the keys are
//! destroyed, so the sealed files are ciphertext nobody can open, and names come
//! back one vault at a time as each is unlocked afresh. It touches no keychain,
//! which is what lets it succeed on a device that has none.
//!
//! ## No path here writes a name
//!
//! Neither command takes a label, returns a label, or logs one. The only
//! plaintext that exists on either path is the boolean.

use crate::io_failure_kind::IoFailureKind;
use crate::vault_io::VaultIo;
use crate::vault_label::erase_all::erase_all_labels;
use crate::vault_label::error::VaultLabelError;
use crate::vault_label::hide_flag::{
    hide_flag_path_from_host, names_hidden_at_rest, read_hide_vault_names, write_hide_vault_names,
    HideFlagError, HideVaultNamesConfig,
};
use crate::vault_label::key::LabelKeychain;
use serde::Serialize;
use std::path::Path;
use thiserror::Error;

/// What both commands report back: the flag as it now stands on disk.
///
/// A struct rather than a bare `bool` so the surfaces this feeds (the Privacy
/// row and, later, the keychain-unavailable state it has to render) can gain a
/// field without changing an IPC signature. Same shape and same reason as
/// [`crate::plugins::sync::tor_config`]'s view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HideVaultNamesView {
    /// `true` when vault names are hidden on this device.
    pub hidden: bool,
}

/// Failure surface for the command pair. No `String` and no path
/// (`src-tauri/CLAUDE.md` DENY list), and **no variant can carry a label**.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum HideVaultNamesError {
    /// The flag file, or a sealed label file during the erase, could not be
    /// read or written.
    #[error("filesystem error on the hide-vault-names flag")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// The flag file is present but unparseable.
    #[error("the hide-vault-names flag could not be parsed")]
    Parse,
    /// This device has no usable OS keychain, so no key can be destroyed and no
    /// erase can be performed. **The flag is not persisted** in this case: the
    /// option's whole content is the erase, and recording a preference that did
    /// nothing would put "hidden" on the row over untouched keys.
    #[error("device keychain unavailable")]
    KeychainUnavailable,
    /// A wrap key survived the sweep. The flag is not persisted, so nothing
    /// claims an erase that did not happen.
    #[error("a vault label key could not be destroyed")]
    EraseIncomplete,
}

impl From<HideFlagError> for HideVaultNamesError {
    fn from(e: HideFlagError) -> Self {
        match e {
            HideFlagError::Io { io_error_kind } => HideVaultNamesError::Io { io_error_kind },
            HideFlagError::Parse => HideVaultNamesError::Parse,
        }
    }
}

impl From<VaultLabelError> for HideVaultNamesError {
    /// The store's errors, reduced to what the caller of THIS pair can act on.
    ///
    /// `Backend` is the real case: a key destruction the OS refused. The other
    /// three variants (`KeyMissing`, `EmptyLabel`, `LabelTooLong`) are
    /// unreachable from an erase, because nothing on this path reads a label or
    /// writes one, so they share its arm rather than growing arms that would
    /// only ever be dead.
    fn from(e: VaultLabelError) -> Self {
        match e {
            VaultLabelError::KeychainUnavailable => HideVaultNamesError::KeychainUnavailable,
            VaultLabelError::Io(io_error_kind) => HideVaultNamesError::Io { io_error_kind },
            _ => HideVaultNamesError::EraseIncomplete,
        }
    }
}

// ---- layer 3: the inners, which take their resolved paths ------------------

/// Read the flag from `flag_path`.
///
/// Reduces through [`names_hidden_at_rest`], i.e. through the SAME rule every
/// other reader applies, so a damaged file reads as hidden here exactly as it
/// does on the write-suppression check. Reporting it as an error instead would
/// leave the row showing "shown" while no name was being cached.
pub async fn hide_vault_names_at(
    io: &dyn VaultIo,
    flag_path: &Path,
) -> Result<HideVaultNamesView, HideVaultNamesError> {
    Ok(HideVaultNamesView {
        hidden: names_hidden_at_rest(read_hide_vault_names(io, flag_path).await),
    })
}

/// Set the flag, performing the erase sweep in the same operation when it is
/// being turned on.
///
/// `base` is `<app_data_dir>` (what the sweep discovers vaults under) and
/// `flag_path` is `<app_config_dir>/vault-names.json`. Two directories because
/// they are two different things: vault data and a device setting. See the
/// module header for the ordering argument and for what turning it off does
/// not do.
pub async fn set_hide_vault_names_at(
    io: &dyn VaultIo,
    base: &Path,
    flag_path: &Path,
    keychain: &dyn LabelKeychain,
    hidden: bool,
) -> Result<HideVaultNamesView, HideVaultNamesError> {
    if hidden {
        // Erase FIRST. A `?` here is what stops the flag being persisted over
        // an erase that did not complete.
        erase_all_labels(io, base, keychain).await?;
    }

    write_hide_vault_names(io, flag_path, HideVaultNamesConfig { hidden }).await?;

    // The boolean only. Nothing on this path has ever held a label.
    tracing::info!(event = "hide_vault_names_set", hidden);
    Ok(HideVaultNamesView { hidden })
}

// ---- layer 1: the host-taking cores ----------------------------------------

/// [`hide_vault_names_at`] against the device's own config directory.
pub async fn hide_vault_names_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
) -> Result<HideVaultNamesView, HideVaultNamesError> {
    let flag_path = hide_flag_path_from_host(host, io).await?;
    hide_vault_names_at(io, &flag_path).await
}

/// [`set_hide_vault_names_at`] against the device's own data and config
/// directories.
pub async fn set_hide_vault_names_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    keychain: &dyn LabelKeychain,
    hidden: bool,
) -> Result<HideVaultNamesView, HideVaultNamesError> {
    let base = host.app_data_dir().map_err(|_| HideVaultNamesError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    let flag_path = hide_flag_path_from_host(host, io).await?;
    set_hide_vault_names_at(io, &base, &flag_path, keychain, hidden).await
}

// ---- layer 2: the IPC wrappers ---------------------------------------------

/// Read the device-local hide-vault-names flag. No vault access; reachable
/// pre-unlock, which is the only moment it matters.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn hide_vault_names<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<HideVaultNamesView, HideVaultNamesError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    hide_vault_names_from_host(&host, &crate::vault_io::StdVaultIo).await
}

/// Turn the device-local hide-vault-names option on or off. Turning it ON
/// destroys every per-vault wrap key and removes every sealed label file before
/// the flag is persisted; turning it off restores nothing.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_hide_vault_names<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    hidden: bool,
) -> Result<HideVaultNamesView, HideVaultNamesError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    set_hide_vault_names_from_host(
        &host,
        &crate::vault_io::StdVaultIo,
        crate::vault_label::key::platform_keychain(),
        hidden,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::VAULTS_DIR_NAME;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use crate::vault_label::fake_keychain::FakeKeychain;
    use crate::vault_label::hide_flag::HIDE_FLAG_FILE_NAME;
    use crate::vault_label::store::{label_path, write_label};
    use crate::vault_label::test_ids::{vault, VAULT_A, VAULT_B};
    use std::path::PathBuf;

    /// One device: an `<app_data_dir>` holding two vaults, and a config
    /// directory beside it holding the flag. Two directories, as in production.
    struct Device {
        _dir: ScopedTempDir,
        base: PathBuf,
        flag_path: PathBuf,
        a: PathBuf,
        b: PathBuf,
    }

    fn device() -> Device {
        let dir = ScopedTempDir::new("hide-vault-names").expect("scratch dir");
        let base = dir.path().join("data");
        let config = dir.path().join("config");
        std::fs::create_dir_all(&config).expect("config dir");
        let vaults = base.join(VAULTS_DIR_NAME);
        let a = vaults.join(VAULT_A);
        let b = vaults.join(VAULT_B);
        for root in [&a, &b] {
            std::fs::create_dir_all(root).expect("vault root");
            std::fs::write(root.join("vault.meta"), b"any vault.meta bytes").expect("seed meta");
        }
        Device {
            _dir: dir,
            base,
            flag_path: config.join(HIDE_FLAG_FILE_NAME),
            a,
            b,
        }
    }

    fn seed_two_named_vaults(d: &Device, keychain: &FakeKeychain) {
        block_on(async {
            write_label(&StdVaultIo, &d.a, vault(VAULT_A), "Work", keychain)
                .await
                .expect("seed A");
            write_label(&StdVaultIo, &d.b, vault(VAULT_B), "Personal", keychain)
                .await
                .expect("seed B");
        });
        assert!(
            label_path(&d.a).exists() && label_path(&d.b).exists(),
            "seeded"
        );
        assert!(
            keychain.read(VAULT_A).is_some() && keychain.read(VAULT_B).is_some(),
            "keys seeded"
        );
    }

    #[test]
    fn the_flag_reads_as_shown_before_anyone_touches_it() {
        let d = device();
        block_on(async {
            assert_eq!(
                hide_vault_names_at(&StdVaultIo, &d.flag_path).await,
                Ok(HideVaultNamesView { hidden: false })
            );
        });
        assert!(
            !d.flag_path.exists(),
            "and reading must not materialise the file"
        );
    }

    #[test]
    fn enabling_destroys_both_keys_and_removes_both_files() {
        // The task's own verification line: seed two vaults with labels, enable
        // the flag, then read the KEYCHAIN and the FILESYSTEM back. A no-op
        // also returns Ok, so `is_ok()` would prove nothing here.
        let d = device();
        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);

        block_on(async {
            assert_eq!(
                set_hide_vault_names_at(&StdVaultIo, &d.base, &d.flag_path, &keychain, true).await,
                Ok(HideVaultNamesView { hidden: true })
            );
        });

        assert!(
            keychain.read(VAULT_A).is_none(),
            "vault A's wrap key survived enabling the option"
        );
        assert!(
            keychain.read(VAULT_B).is_none(),
            "vault B's wrap key survived enabling the option"
        );
        assert!(!label_path(&d.a).exists(), "vault A's sealed file survived");
        assert!(!label_path(&d.b).exists(), "vault B's sealed file survived");

        block_on(async {
            assert_eq!(
                hide_vault_names_at(&StdVaultIo, &d.flag_path).await,
                Ok(HideVaultNamesView { hidden: true }),
                "and the flag is persisted, so the next launch still suppresses writes"
            );
        });
    }

    #[test]
    fn disabling_restores_nothing() {
        let d = device();
        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);

        block_on(async {
            set_hide_vault_names_at(&StdVaultIo, &d.base, &d.flag_path, &keychain, true)
                .await
                .expect("enable");
            set_hide_vault_names_at(&StdVaultIo, &d.base, &d.flag_path, &keychain, false)
                .await
                .expect("disable");
        });

        assert!(
            keychain.accounts().is_empty(),
            "turning the option off must not mint a key back"
        );
        assert!(!label_path(&d.a).exists(), "nor bring a file back");
        assert!(!label_path(&d.b).exists());
        block_on(async {
            assert_eq!(
                hide_vault_names_at(&StdVaultIo, &d.flag_path).await,
                Ok(HideVaultNamesView { hidden: false })
            );
        });
    }

    #[test]
    fn disabling_never_touches_the_keychain_at_all() {
        // Which is what lets it succeed on a device that has none.
        let d = device();
        let none = FakeKeychain::unavailable();
        block_on(async {
            assert_eq!(
                set_hide_vault_names_at(&StdVaultIo, &d.base, &d.flag_path, &none, false).await,
                Ok(HideVaultNamesView { hidden: false })
            );
        });
        assert!(none.calls().is_empty(), "no keychain call on the off path");
    }

    #[test]
    fn a_failed_erase_leaves_the_flag_unwritten() {
        // The ordering property, asserted from the disk rather than described:
        // a partial erase must not leave a persisted "hidden" behind it, or the
        // row would claim an erase that did not happen.
        let d = device();
        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);
        keychain.fail_delete_for(VAULT_A);

        block_on(async {
            assert_eq!(
                set_hide_vault_names_at(&StdVaultIo, &d.base, &d.flag_path, &keychain, true).await,
                Err(HideVaultNamesError::EraseIncomplete)
            );
        });

        assert!(
            !d.flag_path.exists(),
            "the flag file must not exist after an erase that did not complete"
        );
        block_on(async {
            assert_eq!(
                hide_vault_names_at(&StdVaultIo, &d.flag_path).await,
                Ok(HideVaultNamesView { hidden: false }),
                "so the row still reads `shown`, which is the truth"
            );
        });
        assert!(
            keychain.read(VAULT_A).is_some(),
            "A is the key that could not be destroyed"
        );
    }

    #[test]
    fn an_unavailable_keychain_refuses_to_enable_rather_than_recording_a_hollow_flag() {
        let d = device();
        let none = FakeKeychain::unavailable();
        block_on(async {
            assert_eq!(
                set_hide_vault_names_at(&StdVaultIo, &d.base, &d.flag_path, &none, true).await,
                Err(HideVaultNamesError::KeychainUnavailable)
            );
        });
        assert!(!d.flag_path.exists(), "and no flag was persisted");
    }

    #[test]
    fn enabling_on_a_device_with_nothing_cached_succeeds() {
        // The case that matters most for the erase's honesty: someone who sets
        // the option BEFORE the first unlock ever writes a name. There is
        // nothing to erase and the flag still lands.
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            assert_eq!(
                set_hide_vault_names_at(&StdVaultIo, &d.base, &d.flag_path, &keychain, true).await,
                Ok(HideVaultNamesView { hidden: true })
            );
        });
        assert!(keychain.accounts().is_empty());
    }

    #[test]
    fn no_path_writes_a_name_anywhere_on_the_device() {
        // The hard rule, asserted by listing the whole device afterwards rather
        // than by inspecting the one file we expected to be wrong.
        let d = device();
        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);

        block_on(async {
            set_hide_vault_names_at(&StdVaultIo, &d.base, &d.flag_path, &keychain, true)
                .await
                .expect("enable");
            set_hide_vault_names_at(&StdVaultIo, &d.base, &d.flag_path, &keychain, false)
                .await
                .expect("disable");
        });

        let mut checked = 0usize;
        for path in walk(d._dir.path()) {
            let bytes = std::fs::read(&path).unwrap_or_default();
            for name in ["Work", "Personal"] {
                assert!(
                    !bytes.windows(name.len()).any(|w| w == name.as_bytes()),
                    "the plaintext name {name:?} is on disk at {path:?}"
                );
            }
            checked += 1;
        }
        assert!(checked > 0, "the walk must actually have read some files");
    }

    /// Every regular file under `root`, recursively.
    fn walk(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(root) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
        out
    }
}
