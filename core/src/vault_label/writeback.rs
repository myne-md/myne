// SPDX-License-Identifier: AGPL-3.0
//! The write-through: the ONE path every event that changes a vault's name
//! takes into the sealed label store (myne-md/myne#411).
//!
//! Four events change what this device should hold for a vault, and they are
//! deliberately not four implementations:
//!
//! | Event | What it calls | Why |
//! |---|---|---|
//! | Unlock | [`persist_label_from_host`] | the `vault.prefs` `label` was just decrypted, so this is the only moment the name is knowable |
//! | Rename | [`persist_label_from_host`] | the new name has to reach the LOCKED picker without waiting for the next unlock |
//! | Clearing the name | [`persist_label_from_host`] with `None` | which REMOVES the file, see below |
//! | Vault deletion | [`forget_label`] | destroys the key, which is what the erase is |
//!
//! ## Why one function and not one per call site
//!
//! Two rules have to hold at every one of those events, and both are the kind
//! that decays when it is written three times:
//!
//! **The hide flag suppresses every write.** The reduction goes through
//! [`names_hidden_at_rest`], the same function the Settings row reads, so a
//! damaged flag file cannot mean "hidden" on the switch and "shown" to the
//! writer. That is not a hypothetical: the two answers are computed from the
//! same `Result` by the same rule precisely because a second `match` arm
//! somewhere else is how a switch comes to say one thing while the writer does
//! another.
//!
//! **Clearing a name REMOVES the file, it does not store an empty string.** The
//! codec refuses a zero-length plaintext ([`VaultLabelError::EmptyLabel`]), so
//! the empty case cannot be stored even by a caller that tried; routing it to
//! [`remove_label`] here is what turns that refusal into correct behaviour
//! rather than a logged failure.
//!
//! ## Deletion is not a write, so it is not suppressed
//!
//! [`forget_label`] does not consult the flag. With the flag on there is nothing
//! to destroy (the sweep already ran and reads never mint a key), so consulting
//! it would only add a way to skip an erase. Destroying a key that is already
//! gone succeeds.
//!
//! ## Best effort, always
//!
//! Both entry points return `()`. A device-local name cache is a convenience
//! for the picker, and failing a user's rename, unlock or vault deletion
//! because a keychain was unavailable would trade a real operation for a
//! cosmetic one. The failure is logged with a closed-enum kind and nothing
//! else.
//!
//! ## What no path here does
//!
//! No path writes a name in the clear. Both entries go through
//! [`super::store`], whose only writer seals through `MYL1`, and the
//! suppressed path writes nothing at all.

use crate::host::HostCtx;
use crate::vault_id::VaultId;
use crate::vault_io::VaultIo;
use crate::vault_label::error::{vault_label_error_kind, VaultLabelError};
use crate::vault_label::hide_flag::{
    hide_flag_path_from_host, names_hidden_at_rest, read_hide_vault_names,
};
use crate::vault_label::key::LabelKeychain;
use crate::vault_label::store::{erase, remove_label, write_label};
use std::path::Path;

/// Bring the sealed label store in line with a vault's current name.
///
/// `label` is the `vault.prefs` field verbatim: `None` (or `Some("")`, which is
/// the same fact wearing a different type) clears it, anything else sets it.
/// The value is not trimmed or normalised here on purpose, because a cached
/// name that differs from the one the vault carries is a second opinion about
/// the user's own text.
///
/// Answers `Ok(())` and touches nothing at all when names are hidden on this
/// device, which is the whole content of the privacy option on the write side.
pub async fn persist_label_at(
    io: &dyn VaultIo,
    flag_path: &Path,
    vault_root: &Path,
    vault_id: VaultId,
    label: Option<&str>,
    keychain: &dyn LabelKeychain,
) -> Result<(), VaultLabelError> {
    if names_hidden_at_rest(read_hide_vault_names(io, flag_path).await) {
        // Not an early return for tidiness: this is the suppression. Nothing
        // below runs, so no file is written and no keychain item is minted on a
        // device whose owner asked that no name be cached.
        return Ok(());
    }

    match label {
        // Clearing. `remove_label` alone is right here and `erase` would be
        // wrong: the vault still exists and will be unlocked again, so its key
        // has to survive to seal the next name. Destroying it would leave the
        // next write minting a fresh one for no reason.
        None | Some("") => remove_label(io, vault_root).await,
        Some(label) => write_label(io, vault_root, vault_id, label, keychain).await,
    }
}

/// [`persist_label_at`] against this device's own config directory, best-effort.
///
/// The flag path resolution failing is treated as hidden, i.e. the write is
/// suppressed. That is the same direction [`names_hidden_at_rest`] fails in and
/// for the same reason: not knowing whether a name may be cached is not a
/// licence to cache one.
pub async fn persist_label_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    vault_root: &Path,
    vault_id: VaultId,
    label: Option<&str>,
    keychain: &dyn LabelKeychain,
) {
    let Ok(flag_path) = hide_flag_path_from_host(host, io).await else {
        log_failure("flag_path_unresolved");
        return;
    };

    if let Err(e) = persist_label_at(io, &flag_path, vault_root, vault_id, label, keychain).await {
        log_failure(vault_label_error_kind(&e));
    }
}

/// Make one vault's cached name unreadable, for good: destroy its wrap key and
/// remove its file. Best-effort.
///
/// This is what vault deletion calls, and it is [`erase`] rather than
/// [`remove_label`] deliberately. `remove_label` leaves the key alive, and a
/// live key over ciphertext that may still exist on the medium is exactly the
/// shape that would weaken the per-`VaultId` cryptographic-erase guarantee
/// vault deletion carries today. The key destruction IS the erase; removing the
/// file is tidiness.
pub async fn forget_label(
    io: &dyn VaultIo,
    vault_root: &Path,
    vault_id: VaultId,
    keychain: &dyn LabelKeychain,
) {
    if let Err(e) = erase(io, vault_root, vault_id, keychain).await {
        log_failure(vault_label_error_kind(&e));
    }
}

fn log_failure(kind: &'static str) {
    tracing::debug!(
        stage = "vault_label_writeback",
        kind,
        "the sealed vault label could not be updated; the picker falls back"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use crate::vault_label::fake_keychain::FakeKeychain;
    use crate::vault_label::hide_flag::{
        write_hide_vault_names, HideVaultNamesConfig, HIDE_FLAG_FILE_NAME,
    };
    use crate::vault_label::store::{label_path, read_label, LabelRead};
    use crate::vault_label::test_ids::{vault, VAULT_A, VAULT_B};
    use std::path::PathBuf;

    /// One device: a vault root for A and one for B, and a config directory
    /// beside them holding the flag. The two directories are separate in
    /// production and separate here.
    struct Device {
        _dir: ScopedTempDir,
        flag_path: PathBuf,
        a: PathBuf,
        b: PathBuf,
    }

    fn device() -> Device {
        let dir = ScopedTempDir::new("vault-label-writeback").expect("scratch dir");
        let config = dir.path().join("config");
        std::fs::create_dir_all(&config).expect("config dir");
        let a = dir.path().join("vaults").join(VAULT_A);
        let b = dir.path().join("vaults").join(VAULT_B);
        for root in [&a, &b] {
            std::fs::create_dir_all(root).expect("vault root");
        }
        Device {
            _dir: dir,
            flag_path: config.join(HIDE_FLAG_FILE_NAME),
            a,
            b,
        }
    }

    fn hide(d: &Device) {
        block_on(async {
            write_hide_vault_names(
                &StdVaultIo,
                &d.flag_path,
                HideVaultNamesConfig { hidden: true },
            )
            .await
            .expect("write the flag");
        });
    }

    // ---- the write half ----------------------------------------------------

    #[test]
    fn a_name_is_sealed_and_reads_back() {
        // The unlock and rename case, which are the same call.
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("persist");
            assert_eq!(
                read_label(&StdVaultIo, &d.a, vault(VAULT_A), &keychain)
                    .await
                    .expect("read"),
                LabelRead::Label("Work".to_string())
            );
        });
    }

    #[test]
    fn a_rename_replaces_the_previous_name() {
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            for name in ["Work", "Tax Returns"] {
                persist_label_at(
                    &StdVaultIo,
                    &d.flag_path,
                    &d.a,
                    vault(VAULT_A),
                    Some(name),
                    &keychain,
                )
                .await
                .expect("persist");
            }
            assert_eq!(
                read_label(&StdVaultIo, &d.a, vault(VAULT_A), &keychain)
                    .await
                    .expect("read"),
                LabelRead::Label("Tax Returns".to_string())
            );
        });
        let bytes = std::fs::read(label_path(&d.a)).expect("read the file back");
        for name in ["Work", "Tax Returns"] {
            assert!(
                !bytes.windows(name.len()).any(|w| w == name.as_bytes()),
                "neither the old nor the new name may appear in the clear"
            );
        }
    }

    #[test]
    fn clearing_a_name_removes_the_file_rather_than_storing_an_empty_one() {
        // The codec refuses a zero-length plaintext, so "store the empty
        // string" is not one of the outcomes available. This asserts the
        // routing that makes that refusal into the right behaviour.
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("seed");
            assert!(label_path(&d.a).exists(), "seeded");

            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                None,
                &keychain,
            )
            .await
            .expect("clear");
        });
        assert!(!label_path(&d.a).exists(), "clearing removes the file");
    }

    #[test]
    fn an_empty_string_clears_exactly_as_none_does() {
        // `vault.prefs` carries `Option<String>` and the UI maps an empty input
        // to `None`, but a caller handing this an empty `Some` must not get a
        // logged `EmptyLabel` and a stale file left behind.
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("seed");
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some(""),
                &keychain,
            )
            .await
            .expect("clear with an empty string");
        });
        assert!(!label_path(&d.a).exists());
    }

    #[test]
    fn clearing_keeps_the_key_because_the_vault_is_still_there() {
        // The difference between clearing a name and deleting a vault. The key
        // has to survive to seal the next name; destroying it here would make
        // every clear-then-rename mint a fresh one.
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("seed");
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                None,
                &keychain,
            )
            .await
            .expect("clear");
        });
        assert!(keychain.read(VAULT_A).is_some(), "the key survives a clear");
    }

    #[test]
    fn clearing_a_name_this_device_never_held_succeeds() {
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                None,
                &keychain,
            )
            .await
            .expect("absent is the post-condition already");
        });
        assert!(keychain.accounts().is_empty(), "and no key was minted");
    }

    #[test]
    fn one_vaults_write_leaves_the_other_alone() {
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("write A");
        });
        assert!(!label_path(&d.b).exists());
        assert!(keychain.read(VAULT_B).is_none());
    }

    // ---- the suppression ---------------------------------------------------

    #[test]
    fn the_hide_flag_suppresses_the_write_entirely() {
        // The acceptance criterion, asserted from the disk and the keychain
        // rather than from the returned Ok, which a no-op also produces.
        let d = device();
        let keychain = FakeKeychain::empty();
        hide(&d);

        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("a suppressed write is not a failure");
        });

        assert!(!label_path(&d.a).exists(), "no sealed file was written");
        assert!(
            keychain.calls().is_empty(),
            "and the keychain was never touched, so no key was minted either"
        );
    }

    #[test]
    fn a_suppressed_write_leaves_nothing_at_all_in_the_vault_root() {
        // The hard rule: no plaintext name on any path. Asserted by listing the
        // directory rather than by inspecting the one file we expected.
        let d = device();
        let keychain = FakeKeychain::empty();
        hide(&d);
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Tax Returns"),
                &keychain,
            )
            .await
            .expect("suppressed");
        });
        let leftovers: Vec<_> = std::fs::read_dir(&d.a)
            .expect("list the vault root")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            leftovers.is_empty(),
            "a suppressed write must leave the vault root untouched, found {leftovers:?}"
        );
    }

    #[test]
    fn a_damaged_flag_file_suppresses_the_write() {
        // The reduction is `names_hidden_at_rest`'s, not a second one written
        // here: a file that exists and cannot be read means somebody used the
        // option, so the write does not happen.
        let d = device();
        let keychain = FakeKeychain::empty();
        std::fs::write(&d.flag_path, b"{not json").expect("damage the flag file");
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("a suppressed write is not a failure");
        });
        assert!(!label_path(&d.a).exists());
        assert!(keychain.calls().is_empty());
    }

    #[test]
    fn an_absent_flag_file_does_not_suppress_anything() {
        // The premise the whole suppression rests on. Without it a fresh
        // install would cache no name and nobody would have asked for that.
        let d = device();
        let keychain = FakeKeychain::empty();
        assert!(!d.flag_path.exists(), "no flag file, the shipped state");
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("persist");
        });
        assert!(label_path(&d.a).exists());
    }

    #[test]
    fn a_suppressed_clear_does_not_remove_a_file_either() {
        // Suppression is "touch nothing", not "do the destructive half". The
        // sweep that ran when the flag went on already removed every file, so
        // there is nothing here for this path to tidy.
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("seed while the option is off");
        });
        hide(&d);
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                None,
                &keychain,
            )
            .await
            .expect("suppressed clear");
        });
        assert!(
            label_path(&d.a).exists(),
            "the suppressed path does no IO at all; the sweep owns removal"
        );
    }

    // ---- keychainless devices ----------------------------------------------

    #[test]
    fn an_unavailable_keychain_writes_no_name_in_any_form() {
        // The Linux-with-no-secret-service shape. The forbidden alternative is
        // a plaintext fallback, so the assertion is about the directory rather
        // than about the returned error.
        let d = device();
        let none = FakeKeychain::unavailable();
        block_on(async {
            assert_eq!(
                persist_label_at(
                    &StdVaultIo,
                    &d.flag_path,
                    &d.a,
                    vault(VAULT_A),
                    Some("Work"),
                    &none,
                )
                .await,
                Err(VaultLabelError::KeychainUnavailable)
            );
        });
        let leftovers: Vec<_> = std::fs::read_dir(&d.a)
            .expect("list the vault root")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            leftovers.is_empty(),
            "no file at all, and in particular no plaintext one, found {leftovers:?}"
        );
    }

    #[test]
    fn clearing_works_on_a_device_with_no_keychain() {
        // Removal is a filesystem operation, so it must not be gated behind a
        // facility the device does not have.
        let d = device();
        let good = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &good,
            )
            .await
            .expect("seed");

            let none = FakeKeychain::unavailable();
            persist_label_at(&StdVaultIo, &d.flag_path, &d.a, vault(VAULT_A), None, &none)
                .await
                .expect("clear without a keychain");
        });
        assert!(!label_path(&d.a).exists());
    }

    // ---- deletion ----------------------------------------------------------

    #[test]
    fn forget_label_destroys_the_key_and_removes_the_file() {
        // What vault deletion owes the erase guarantee, asserted by reading the
        // keychain back rather than by trusting the call returned.
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("seed");
            forget_label(&StdVaultIo, &d.a, vault(VAULT_A), &keychain).await;
        });
        assert!(
            keychain.read(VAULT_A).is_none(),
            "the wrap key survived the deletion, so the name is still recoverable \
             from any copy of the ciphertext"
        );
        assert!(!label_path(&d.a).exists());
    }

    #[test]
    fn forget_label_is_scoped_to_one_vault() {
        // The per-`VaultId` half of the guarantee: deleting one vault may not
        // touch another's name.
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            for (root, id, name) in [(&d.a, VAULT_A, "Work"), (&d.b, VAULT_B, "Personal")] {
                persist_label_at(
                    &StdVaultIo,
                    &d.flag_path,
                    root,
                    vault(id),
                    Some(name),
                    &keychain,
                )
                .await
                .expect("seed");
            }
            forget_label(&StdVaultIo, &d.a, vault(VAULT_A), &keychain).await;

            assert!(keychain.read(VAULT_B).is_some(), "B's key survives");
            assert_eq!(
                read_label(&StdVaultIo, &d.b, vault(VAULT_B), &keychain)
                    .await
                    .expect("read B"),
                LabelRead::Label("Personal".to_string())
            );
        });
    }

    #[test]
    fn forget_label_runs_while_names_are_hidden() {
        // Deletion is not a write, so it is not suppressed. With the flag on
        // there is nothing left to destroy, and this asserts that the path
        // still completes rather than being skipped by a flag check somebody
        // added by symmetry.
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("seed while the option is off");
        });
        hide(&d);
        block_on(async {
            forget_label(&StdVaultIo, &d.a, vault(VAULT_A), &keychain).await;
        });
        assert!(keychain.read(VAULT_A).is_none());
        assert!(!label_path(&d.a).exists());
    }

    #[test]
    fn forget_label_on_a_vault_with_no_cached_name_succeeds() {
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            forget_label(&StdVaultIo, &d.a, vault(VAULT_A), &keychain).await;
        });
        assert!(keychain.read(VAULT_A).is_none());
    }

    #[test]
    fn forget_label_survives_a_vault_root_that_is_already_gone() {
        // Vault deletion unlinks the directory, and the erase runs afterwards
        // on purpose (a rejected delete must not destroy a surviving vault's
        // key). So the file half routinely finds nothing, and the key half is
        // what has to happen anyway.
        let d = device();
        let keychain = FakeKeychain::empty();
        block_on(async {
            persist_label_at(
                &StdVaultIo,
                &d.flag_path,
                &d.a,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await
            .expect("seed");
        });
        std::fs::remove_dir_all(&d.a).expect("unlink the vault root");
        block_on(async {
            forget_label(&StdVaultIo, &d.a, vault(VAULT_A), &keychain).await;
        });
        assert!(
            keychain.read(VAULT_A).is_none(),
            "the key is destroyed even though its file was already unlinked"
        );
    }

    // ---- the host-resolving wrapper ----------------------------------------

    #[test]
    fn the_host_wrapper_reads_the_flag_from_the_config_directory() {
        // The wiring between `app_config_dir` and the flag the sweep persists.
        // A wrapper that resolved the wrong directory would suppress nothing
        // and no test on `persist_label_at` would notice.
        let dir = ScopedTempDir::new("vault-label-writeback-host").expect("scratch dir");
        let host = crate::host::test_host::TestHost::new(dir.path());
        let vault_root = dir.path().join("data").join("vaults").join(VAULT_A);
        std::fs::create_dir_all(&vault_root).expect("vault root");
        let keychain = FakeKeychain::empty();

        block_on(async {
            persist_label_from_host(
                &host,
                &StdVaultIo,
                &vault_root,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await;
            assert!(
                label_path(&vault_root).exists(),
                "written with the flag off"
            );

            let flag_path = hide_flag_path_from_host(&host, &StdVaultIo)
                .await
                .expect("flag path");
            write_hide_vault_names(
                &StdVaultIo,
                &flag_path,
                HideVaultNamesConfig { hidden: true },
            )
            .await
            .expect("hide");
            std::fs::remove_file(label_path(&vault_root)).expect("clear the seeded file");

            persist_label_from_host(
                &host,
                &StdVaultIo,
                &vault_root,
                vault(VAULT_A),
                Some("Work"),
                &keychain,
            )
            .await;
        });
        assert!(
            !label_path(&vault_root).exists(),
            "the wrapper found the same flag the option writes, so the write was suppressed"
        );
    }

    #[test]
    fn the_host_wrapper_swallows_a_keychainless_device() {
        // Best-effort: a rename or an unlock must not fail because the name
        // cache could not be updated.
        let dir = ScopedTempDir::new("vault-label-writeback-besteffort").expect("scratch dir");
        let host = crate::host::test_host::TestHost::new(dir.path());
        let vault_root = dir.path().join("data").join("vaults").join(VAULT_A);
        std::fs::create_dir_all(&vault_root).expect("vault root");
        let none = FakeKeychain::unavailable();
        block_on(async {
            // Returns `()`, so the assertion is that this line compiles and
            // does not panic; the file assertion below is the observable half.
            persist_label_from_host(
                &host,
                &StdVaultIo,
                &vault_root,
                vault(VAULT_A),
                Some("Work"),
                &none,
            )
            .await;
        });
        assert!(!label_path(&vault_root).exists());
    }
}
