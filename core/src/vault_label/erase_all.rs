// SPDX-License-Identifier: AGPL-3.0-only
//! The device-wide erase sweep: make EVERY vault's cached name unreadable.
//!
//! [`store::erase`] is the per-vault operation and this is the whole-device one.
//! It is the working half of the hide-vault-names option ([`super::hide_flag`]):
//! the flag stops future writes, and this makes the names already written
//! unreadable. Neither alone is the feature.
//!
//! ## What it sweeps, and why that set
//!
//! [`crate::vault_registry::discover_vaults`] is the discovery authority
//! (SYNC-10): a scan of `vaults/`, not the `registry.json` cache. Sweeping the
//! cache instead would leave a name sealed beside a vault the cache had not
//! caught up with, and the cache is explicitly non-authoritative, so the erase
//! would be as complete as a file nobody promises anything about.
//!
//! A directory flagged `well_formed = false` is swept too. Whether a vault has
//! a readable `vault.meta` says nothing about whether it has a `vault.label`,
//! and the one thing an erase may not do is skip a file because the directory
//! around it looked broken.
//!
//! ## Every vault is attempted, and the first failure is still returned
//!
//! A failure on one vault does not stop the others. Aborting on the first would
//! leave later vaults' names readable, which is the outcome the user asked to
//! prevent, and it would do so silently from their side, since the option would
//! simply have errored. So the sweep runs to the end and reports the first error
//! it hit.
//!
//! **A partial erase reports failure.** The `Err` is what stops the caller
//! persisting the flag, which is what stops the screen claiming an erase that
//! did not happen (`super::hide_flag`'s ordering argument).

use crate::vault_io::VaultIo;
use crate::vault_label::error::VaultLabelError;
use crate::vault_label::key::LabelKeychain;
use crate::vault_label::store::erase;
use crate::vault_registry::discover_vaults;
use std::path::Path;

/// Destroy every per-vault wrap key and remove every `vault.label` file under
/// `<base>/vaults/`.
///
/// `base` is `<app_data_dir>`. Idempotent: a device with no vaults, or one
/// already swept, is a successful no-op.
///
/// Returns the FIRST error encountered, after attempting every vault. See the
/// module header for why both halves of that sentence matter.
pub async fn erase_all_labels(
    io: &dyn VaultIo,
    base: &Path,
    keychain: &dyn LabelKeychain,
) -> Result<(), VaultLabelError> {
    let discovered = discover_vaults(base);
    let mut first_error: Option<VaultLabelError> = None;
    let mut swept = 0usize;

    for vault in &discovered {
        match erase(io, &vault.root, vault.id, keychain).await {
            Ok(()) => swept += 1,
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
    }

    // Counts only. A `VaultId` is a vault-stable correlation tag and is
    // DENY-listed for logging (`src-tauri/AGENTS.md`), and the label is the
    // user's own text.
    tracing::info!(
        event = "vault_labels_erased",
        swept,
        failed = discovered.len() - swept,
    );

    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::VAULTS_DIR_NAME;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use crate::vault_label::fake_keychain::FakeKeychain;
    use crate::vault_label::store::{label_path, write_label, LabelRead};
    use crate::vault_label::test_ids::{vault, VAULT_A, VAULT_B};
    use std::path::PathBuf;

    /// An `<app_data_dir>` with `vaults/<id>/` directories for A and B, each
    /// carrying the `vault.meta` marker `discover_vaults` classifies on.
    struct Device {
        _dir: ScopedTempDir,
        base: PathBuf,
        a: PathBuf,
        b: PathBuf,
    }

    fn device() -> Device {
        let dir = ScopedTempDir::new("vault-label-erase-all").expect("scratch dir");
        let base = dir.path().to_path_buf();
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
            a,
            b,
        }
    }

    /// Seed both vaults with a sealed name, and assert the seeding worked so a
    /// later "it is gone" assertion cannot pass vacuously.
    fn seed_two_named_vaults(d: &Device, keychain: &FakeKeychain) {
        block_on(async {
            write_label(&StdVaultIo, &d.a, vault(VAULT_A), "Work", keychain)
                .await
                .expect("seed A");
            write_label(&StdVaultIo, &d.b, vault(VAULT_B), "Personal", keychain)
                .await
                .expect("seed B");
        });
        assert!(label_path(&d.a).exists(), "A seeded");
        assert!(label_path(&d.b).exists(), "B seeded");
        assert!(keychain.read(VAULT_A).is_some(), "A's key seeded");
        assert!(keychain.read(VAULT_B).is_some(), "B's key seeded");
    }

    #[test]
    fn the_sweep_destroys_every_key_and_removes_every_file() {
        // THE assertion the whole option rests on, and it is made by reading
        // the keychain and the filesystem back afterwards. `is_ok()` would
        // prove nothing here: a sweep that did nothing at all also returns Ok.
        let d = device();
        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);

        block_on(async {
            erase_all_labels(&StdVaultIo, &d.base, &keychain)
                .await
                .expect("sweep");
        });

        assert!(
            keychain.read(VAULT_A).is_none(),
            "vault A's wrap key survived the sweep; the ciphertext is still readable"
        );
        assert!(
            keychain.read(VAULT_B).is_none(),
            "vault B's wrap key survived the sweep; the ciphertext is still readable"
        );
        assert!(
            keychain.accounts().is_empty(),
            "the sweep must leave no vault-label key at all, found {:?}",
            keychain.accounts()
        );
        assert!(!label_path(&d.a).exists(), "vault A's file survived");
        assert!(!label_path(&d.b).exists(), "vault B's file survived");
    }

    #[test]
    fn after_the_sweep_no_name_is_readable_and_none_is_on_disk_in_the_clear() {
        // The reader's side of the same fact, plus the hard rule: whatever the
        // sweep leaves behind, none of it is a plaintext name.
        let d = device();
        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);

        block_on(async {
            erase_all_labels(&StdVaultIo, &d.base, &keychain)
                .await
                .expect("sweep");
            for (root, id) in [(&d.a, VAULT_A), (&d.b, VAULT_B)] {
                assert_eq!(
                    crate::vault_label::store::read_label(&StdVaultIo, root, vault(id), &keychain)
                        .await
                        .expect("read must not error"),
                    LabelRead::Absent,
                    "an erased vault reads as having no name at all"
                );
            }
        });

        for (root, name) in [(&d.a, "Work"), (&d.b, "Personal")] {
            let leftovers: Vec<_> = std::fs::read_dir(root)
                .expect("list the vault root")
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .collect();
            for path in leftovers {
                let bytes = std::fs::read(&path).unwrap_or_default();
                assert!(
                    !bytes.windows(name.len()).any(|w| w == name.as_bytes()),
                    "the plaintext name {name:?} appears in {:?} after the sweep",
                    path.file_name()
                );
            }
        }
    }

    #[test]
    fn a_directory_with_no_vault_meta_is_swept_too() {
        // `well_formed = false` says something about `vault.meta`, and nothing
        // about whether a `vault.label` is sitting next to it.
        let d = device();
        std::fs::remove_file(d.b.join("vault.meta")).expect("make B not-well-formed");
        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);

        block_on(async {
            erase_all_labels(&StdVaultIo, &d.base, &keychain)
                .await
                .expect("sweep");
        });

        assert!(keychain.read(VAULT_B).is_none(), "B's key is gone");
        assert!(!label_path(&d.b).exists(), "B's file is gone");
    }

    #[test]
    fn the_sweep_is_idempotent_and_a_device_with_no_vaults_is_a_no_op() {
        let d = device();
        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);

        block_on(async {
            erase_all_labels(&StdVaultIo, &d.base, &keychain)
                .await
                .expect("first sweep");
            erase_all_labels(&StdVaultIo, &d.base, &keychain)
                .await
                .expect("second sweep over nothing");
        });

        let empty = ScopedTempDir::new("vault-label-erase-none").expect("scratch dir");
        block_on(async {
            erase_all_labels(&StdVaultIo, empty.path(), &keychain)
                .await
                .expect("a device with no vaults/ dir at all");
        });
    }

    #[test]
    fn an_unavailable_keychain_fails_the_sweep_rather_than_reporting_an_erase() {
        // The Linux-with-no-secret-service shape. Reporting Ok here would be
        // the worst answer available: the caller would persist the flag and the
        // screen would claim an erase over ciphertext whose key is untouched.
        let d = device();
        let good = FakeKeychain::empty();
        seed_two_named_vaults(&d, &good);

        let none = FakeKeychain::unavailable();
        block_on(async {
            assert_eq!(
                erase_all_labels(&StdVaultIo, &d.base, &none).await,
                Err(VaultLabelError::KeychainUnavailable),
                "a sweep that could not destroy a key must not report success"
            );
        });
    }

    #[test]
    fn every_vault_is_attempted_even_when_an_earlier_one_fails() {
        // Aborting on the first failure would leave later vaults' names
        // readable, which is precisely what the user asked to prevent.
        let d = device();
        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);
        keychain.fail_delete_for(VAULT_A);

        let result = block_on(async { erase_all_labels(&StdVaultIo, &d.base, &keychain).await });

        assert_eq!(
            result,
            Err(VaultLabelError::Backend),
            "the failure is reported rather than swallowed"
        );
        assert!(
            keychain.read(VAULT_A).is_some(),
            "A's key is the one that could not be destroyed"
        );
        assert!(
            keychain.read(VAULT_B).is_none(),
            "B was still attempted, and its key is gone"
        );
        assert!(!label_path(&d.b).exists(), "and B's file with it");
    }

    #[test]
    fn the_sweep_touches_nothing_but_the_label_files() {
        // A vault is not a label. The sweep must not take the vault with it.
        let d = device();
        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);
        std::fs::write(d.a.join("vault.prefs"), b"prefs bytes").expect("seed a sibling");

        block_on(async {
            erase_all_labels(&StdVaultIo, &d.base, &keychain)
                .await
                .expect("sweep");
        });

        assert!(d.a.join("vault.meta").is_file(), "vault.meta survives");
        assert!(d.a.join("vault.prefs").is_file(), "vault.prefs survives");
        assert!(d.a.is_dir(), "the vault directory itself survives");
    }

    #[test]
    fn the_sweep_set_is_the_disk_scan_rather_than_the_registry_cache() {
        // The registry is explicitly non-authoritative and self-heals from the
        // scan. Sweeping IT would leave a name sealed beside a vault the cache
        // had not caught up with.
        let d = device();
        std::fs::create_dir_all(d.base.join(VAULTS_DIR_NAME)).expect("vaults dir");
        std::fs::write(
            d.base.join(VAULTS_DIR_NAME).join("registry.json"),
            br#"{"version":1,"vaults":[]}"#,
        )
        .expect("an empty registry cache that knows about neither vault");

        let keychain = FakeKeychain::empty();
        seed_two_named_vaults(&d, &keychain);

        block_on(async {
            erase_all_labels(&StdVaultIo, &d.base, &keychain)
                .await
                .expect("sweep");
        });

        assert!(
            keychain.accounts().is_empty(),
            "both vaults were swept despite an empty registry cache"
        );
        assert!(!label_path(&d.a).exists());
        assert!(!label_path(&d.b).exists());
    }
}
