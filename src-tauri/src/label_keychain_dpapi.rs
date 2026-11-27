// SPDX-License-Identifier: AGPL-3.0-only
//! The Windows store for the two device-local label keys: DPAPI, user-scoped, with this
//! family's own entropy.
//!
//! Installed from [`crate::label_store`], which is the same file on every host.
//!
//! **Why a file per item.** Apple's keychain and the Linux Secret Service hold the ITEM
//! themselves, so this app writes no file of its own on those platforms (both are still
//! on-disk stores, and the spec's table says what each one guarantees). DPAPI is a sealing
//! function rather than a key-value store: it hands back a ciphertext that has to live
//! somewhere, and the only thing that makes a per-vault erase real is deleting that item's
//! bytes. So each item is one file under `device-keys/`, named after its account, and
//! destroying one item unlinks one file.
//!
//! **Two layers, split where the evidence is.** The naming, the atomic write and the
//! unlink live in [`crate::label_store_files`]. The policy over them is [`Items`], which
//! takes a directory and a [`Sealer`] and therefore compiles and is TESTED on a host with
//! no DPAPI. Only [`DpapiSealer`] and the install entry point are Windows, because DPAPI
//! is the one thing here that cannot exist anywhere else.
//!
//! **Scope is the current USER, never the machine**, for the reason the device key's store
//! states: a machine-scoped blob opens for every account on the box.
//!
//! A blob that does not open is treated as ABSENT rather than as an error. A different
//! Windows account, a re-imaged machine or a corrupted file all mean the key is
//! unrecoverable, and the honest consequence is the same one the erase produces: this
//! device falls back to the neutral vault label. It is not a licence to write a name in
//! the clear.

use crate::label_store_files::{item_path, read_item, remove_item, write_item_atomic, DIR};
use myne_core::vault_label::error::VaultLabelError;
use std::path::Path;
use zeroize::Zeroizing;

/// Entropy binds a blob to this app AND to this family, from the one list of families
/// (`crate::dpapi_entropy`): the device signing key seals under a different string, so its
/// blobs do not open here even if one were moved into this directory, and the reverse
/// holds too.
#[cfg(windows)]
const DPAPI_ENTROPY: &[u8] = crate::dpapi_entropy::LABEL_STORE_ENTROPY;

/// Sealing, as this store needs it. One implementation in production (DPAPI) and one in
/// the tests, which is what lets the store's policy be exercised where DPAPI does not run.
trait Sealer {
    fn seal(&self, plaintext: &[u8]) -> Result<Vec<u8>, ()>;
    fn unseal(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, ()>;
}

/// The store's policy over an explicit directory and sealer.
struct Items<'a> {
    dir: &'a Path,
    sealer: &'a dyn Sealer,
}

impl Items<'_> {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultLabelError> {
        let Some(path) = item_path(self.dir, account) else {
            return Err(refused_name());
        };
        let blob = match read_item(&path) {
            Ok(Some(blob)) => blob,
            Ok(None) => return Ok(None),
            Err(e) => {
                tracing::warn!(
                    stage = "label_store_dpapi",
                    op = "read",
                    kind = ?e.kind(),
                    "the sealed label key could not be read; the picker falls back to the \
                     neutral label"
                );
                return Err(VaultLabelError::Backend);
            }
        };
        match self.sealer.unseal(&blob) {
            Ok(plaintext) => Ok(Some(plaintext)),
            Err(()) => {
                // This user cannot open the blob: another Windows account, a re-imaged box,
                // a corrupted file, or a DPAPI failure that is merely TRANSIENT (the master
                // key not loaded yet on a roaming profile). The two are indistinguishable
                // here, so the bytes are LEFT ALONE rather than deleted: this is a READ, and
                // a read that destroys key material turns a transient failure into a lost
                // account grouping. The next successful write overwrites the same path.
                tracing::warn!(
                    stage = "label_store_dpapi",
                    op = "unprotect",
                    "the sealed label key does not open for this user; showing the neutral \
                     label and leaving the bytes in place"
                );
                Ok(None)
            }
        }
    }

    fn store(&self, account: &str, secret: &[u8]) -> Result<(), VaultLabelError> {
        let result = self.store_inner(account, secret);
        log_key_op("store", if result.is_ok() { "ok" } else { "refused" });
        result
    }

    fn store_inner(&self, account: &str, secret: &[u8]) -> Result<(), VaultLabelError> {
        let Some(path) = item_path(self.dir, account) else {
            return Err(refused_name());
        };
        let sealed = self
            .sealer
            .seal(secret)
            .map_err(|()| VaultLabelError::Backend)?;
        write_item_atomic(&path, &sealed).map_err(|e| {
            tracing::warn!(
                stage = "label_store_dpapi",
                op = "write",
                kind = ?e.kind(),
                "the label key could not be sealed to disk; this device keeps no name"
            );
            VaultLabelError::Backend
        })
    }

    fn delete(&self, account: &str) -> Result<(), VaultLabelError> {
        let result = match item_path(self.dir, account) {
            Some(path) => remove_item(&path).map_err(|e| {
                tracing::warn!(
                    stage = "label_store_dpapi",
                    op = "delete",
                    kind = ?e.kind(),
                    "the sealed label key could not be removed; the erase did not finish"
                );
                VaultLabelError::Backend
            }),
            None => Err(refused_name()),
        };
        log_key_op("delete", if result.is_ok() { "ok" } else { "refused" });
        result
    }
}

/// A refused NAME is a caller bug rather than a device state, and answers `Backend`; a
/// directory that cannot be resolved means there is no store, which is the state the
/// Privacy row renders and answers `KeychainUnavailable`.
fn refused_name() -> VaultLabelError {
    tracing::warn!(
        stage = "label_store_dpapi",
        event = "label_account_name_refused",
        "the account name is not one this store may address; no file was read or written"
    );
    VaultLabelError::Backend
}

/// One line per mutation, with a closed token rather than an error's text.
fn log_key_op(op: &'static str, result: &'static str) {
    tracing::info!(
        stage = "label_store_dpapi",
        op,
        result,
        "vault-label DPAPI operation"
    );
}

/// The production sealer, and the only part of this file that needs Windows.
#[cfg(windows)]
struct DpapiSealer;

#[cfg(windows)]
impl Sealer for DpapiSealer {
    fn seal(&self, plaintext: &[u8]) -> Result<Vec<u8>, ()> {
        crate::dpapi::protect(plaintext, DPAPI_ENTROPY)
    }
    fn unseal(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, ()> {
        crate::dpapi::unprotect(sealed, DPAPI_ENTROPY)
    }
}

/// Install DPAPI as `core`'s label store.
#[cfg(windows)]
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    myne_core::vault_label::key::install_host_keychain(Box::new(DpapiLabelStore {
        app: app.clone(),
    }));
}

#[cfg(windows)]
struct DpapiLabelStore<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

#[cfg(windows)]
impl<R: tauri::Runtime> DpapiLabelStore<R> {
    /// Where the sealed items live, or `None` when this host cannot resolve a directory.
    /// A resolution failure is "no store" rather than a fault: there is nowhere to write,
    /// and the picker falls back to the neutral label.
    fn dir(&self) -> Option<std::path::PathBuf> {
        use tauri::Manager;
        self.app
            .path()
            .app_config_dir()
            .ok()
            .map(|dir| dir.join(DIR))
    }
}

#[cfg(windows)]
impl<R: tauri::Runtime> myne_core::vault_label::key::LabelKeychain for DpapiLabelStore<R> {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultLabelError> {
        let Some(dir) = self.dir() else {
            return Err(VaultLabelError::KeychainUnavailable);
        };
        Items {
            dir: &dir,
            sealer: &DpapiSealer,
        }
        .get(account)
    }

    fn store(&self, account: &str, secret: &[u8]) -> Result<(), VaultLabelError> {
        let Some(dir) = self.dir() else {
            return Err(VaultLabelError::KeychainUnavailable);
        };
        Items {
            dir: &dir,
            sealer: &DpapiSealer,
        }
        .store(account, secret)
    }

    fn delete(&self, account: &str) -> Result<(), VaultLabelError> {
        let Some(dir) = self.dir() else {
            return Err(VaultLabelError::KeychainUnavailable);
        };
        Items {
            dir: &dir,
            sealer: &DpapiSealer,
        }
        .delete(account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A reversible stand-in that is NOT DPAPI: it marks its output so a test can tell a
    /// sealed item from the plaintext on disk, which is the property that matters here.
    struct FakeSealer;

    const MARK: &[u8] = b"sealed:";

    impl Sealer for FakeSealer {
        fn seal(&self, plaintext: &[u8]) -> Result<Vec<u8>, ()> {
            let mut out = MARK.to_vec();
            out.extend_from_slice(plaintext);
            Ok(out)
        }
        fn unseal(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, ()> {
            match sealed.strip_prefix(MARK) {
                Some(rest) => Ok(Zeroizing::new(rest.to_vec())),
                None => Err(()),
            }
        }
    }

    fn scratch() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir()
            .join(format!(
                "myne-label-store-dpapi-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ))
            .join(DIR);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn store<'a>(dir: &'a Path, sealer: &'a FakeSealer) -> Items<'a> {
        Items { dir, sealer }
    }

    #[test]
    fn an_item_round_trips_through_the_sealer_and_reaches_the_disk_sealed() {
        let dir = scratch();
        let sealer = FakeSealer;
        let items = store(&dir, &sealer);
        items
            .store("account-record", b"32-byte-key-material")
            .expect("store");
        assert_eq!(
            items
                .get("account-record")
                .expect("read")
                .expect("present")
                .as_slice(),
            b"32-byte-key-material"
        );
        // The bytes on disk are the sealer's output, never the key: this is the assertion
        // that would catch a store that wrote plaintext beside a correct read path.
        let raw = std::fs::read(dir.join("account-record.dpapi")).expect("item file");
        assert_eq!(raw, b"sealed:32-byte-key-material");
    }

    #[test]
    fn a_blob_that_does_not_open_reads_as_absent_and_is_left_in_place() {
        // The restore-onto-another-account path: the ciphertext is there and this user
        // cannot open it. Falling back to the neutral label is right. DELETING it is not:
        // a transient DPAPI failure (a profile still loading) is indistinguishable from a
        // foreign blob here, and a read that destroys key material turns a bad minute into
        // a lost account grouping. The next successful write overwrites the same path.
        let dir = scratch();
        let sealer = FakeSealer;
        let item = dir.join("0192f4c1-9a3e-7c4d-8b21-4d5e6f708192.dpapi");
        std::fs::write(&item, b"not ours").expect("seed a foreign blob");
        let items = store(&dir, &sealer);
        assert!(items
            .get("0192f4c1-9a3e-7c4d-8b21-4d5e6f708192")
            .expect("absent, not an error")
            .is_none());
        assert!(
            item.exists(),
            "a read must not destroy the bytes: a transient failure looks the same as a foreign blob"
        );
    }

    #[test]
    fn an_absent_item_reads_as_absent_and_deletes_cleanly() {
        let dir = scratch();
        let sealer = FakeSealer;
        let items = store(&dir, &sealer);
        assert!(items.get("account-record").expect("absent").is_none());
        items
            .delete("account-record")
            .expect("deleting nothing succeeds");
    }

    #[test]
    fn deleting_one_vaults_item_leaves_the_others() {
        let dir = scratch();
        let sealer = FakeSealer;
        let items = store(&dir, &sealer);
        let a = "0192f4c1-9a3e-7c4d-8b21-4d5e6f708192";
        let b = "0192f4c1-9a3e-7c4d-8b21-4d5e6f708193";
        items.store(a, b"key-a").expect("store a");
        items.store(b, b"key-b").expect("store b");
        items.delete(a).expect("delete a");
        assert!(items.get(a).expect("read a").is_none(), "a is gone");
        assert_eq!(
            items
                .get(b)
                .expect("read b")
                .expect("b survives")
                .as_slice(),
            b"key-b",
            "a per-vault erase must not take another vault's key"
        );
    }

    #[test]
    fn a_name_that_could_address_another_path_is_refused_on_every_operation() {
        let dir = scratch();
        let sealer = FakeSealer;
        let items = store(&dir, &sealer);
        for name in ["../escape", "a/b", ".."] {
            assert_eq!(
                items.store(name, b"x").unwrap_err(),
                VaultLabelError::Backend,
                "storing under {name:?} must be refused"
            );
            assert_eq!(items.get(name).unwrap_err(), VaultLabelError::Backend);
            assert_eq!(items.delete(name).unwrap_err(), VaultLabelError::Backend);
        }
        assert!(
            !dir.parent().expect("parent").join("escape.dpapi").exists(),
            "nothing was written outside the directory"
        );
    }
}
