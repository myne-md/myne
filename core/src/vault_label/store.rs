// SPDX-License-Identifier: AGPL-3.0-only
//! On-disk half of the sealed label store: `<vault-root>/vault.label`
//! (`protocol.md` § 9.22).
//!
//! One file per vault, beside `vault.quickunlock` and written with the same
//! owner-only, atomic-replace discipline every vault-internal file gets
//! ([`WriteOpts::default`]). It goes through the [`VaultIo`] seam rather than
//! `std::fs`, not because a browser will ever run this (the web client holds
//! exactly one vault per origin, so it has no picker) but because the seam is
//! how every file in this crate is reached, and reaching around it is how a
//! module ends up native-only by accident.
//!
//! ## What each answer means
//!
//! [`read_label`] returns a [`LabelRead`], and the three cases are three
//! different facts rather than three flavours of failure:
//!
//! - [`LabelRead::Absent`]: no file. This device has never unlocked that
//!   vault, so there is no key with which to know its name, and the picker's
//!   neutral fallback is the honest answer rather than a gap.
//! - [`LabelRead::Label`]: the name.
//! - [`LabelRead::Unreadable`]: a file exists that can never be read again.
//!   its key was destroyed, or the vault directory was restored onto a device
//!   that never held one. The caller deletes the orphan and falls back,
//!   silently, because there is nothing the user could do about it.
//!
//! A keychain that is missing **as a whole** is not one of those three: it is
//! [`VaultLabelError::KeychainUnavailable`], because it is the one failure a
//! user can be told something true about.
//!
//! ## What no path does
//!
//! No path here writes a name in plaintext. If the keychain cannot supply a
//! key, the write fails and the picker falls back; the alternative would look
//! identical on screen while voiding the erase guarantee, which is the worst
//! combination available.

use crate::io_failure_kind::IoFailureKind;
use crate::vault_id::VaultId;
use crate::vault_io::{VaultIo, WriteOpts};
use crate::vault_label::error::VaultLabelError;
use crate::vault_label::key::{destroy_key, existing_key, get_or_create_key, LabelKeychain};
use protocol::vault_label_blob::{
    decode_vault_label_blob, encode_vault_label_blob, MAX_VAULT_LABEL_PLAINTEXT_LEN,
};
use std::path::{Path, PathBuf};

/// The sealed label file's name at the vault root. Beside `vault.quickunlock`,
/// and OUT of the § 9.11.3 backup allowlist (which is a closed allowlist, so
/// "out" is the default rather than an exclusion anyone maintains).
pub const VAULT_LABEL_FILE_NAME: &str = "vault.label";

/// What this device knows about one vault's name. See the module header for why
/// the three cases are facts rather than error flavours.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LabelRead {
    /// No sealed label file for this vault.
    Absent,
    /// The vault's name.
    Label(String),
    /// A file exists but can never be decoded again. Delete it and fall back.
    Unreadable,
}

/// `<vault-root>/vault.label`.
pub fn label_path(vault_root: &Path) -> PathBuf {
    vault_root.join(VAULT_LABEL_FILE_NAME)
}

/// Read one vault's cached name.
///
/// The file is read FIRST, and only a present file makes this touch the
/// keychain. That ordering is what keeps the common case quiet on a device with
/// no keychain: a vault that was never named has no file, so the picker gets
/// [`LabelRead::Absent`] instead of an unavailable-keychain error it would have
/// to swallow on every launch.
///
/// The decoded name crosses IPC as an ordinary `String`, exactly as
/// `vault.prefs.label` already does; it is the user's own text and is treated as
/// AS3-sensitive, which here means it is never logged, never put in an error
/// variant, and never written anywhere but this sealed file.
pub async fn read_label(
    io: &dyn VaultIo,
    vault_root: &Path,
    vault_id: VaultId,
    keychain: &dyn LabelKeychain,
) -> Result<LabelRead, VaultLabelError> {
    let path = label_path(vault_root);
    let blob = match io.read(&path).await {
        Ok(bytes) => bytes,
        Err(IoFailureKind::NotFound) => return Ok(LabelRead::Absent),
        Err(kind) => return Err(VaultLabelError::Io(kind)),
    };

    // The key exists or it does not; this path never mints one, because a fresh
    // key opens nothing and minting here would turn "unreadable" into "readable
    // as empty" on the next write.
    let wrap_key = match existing_key(keychain, vault_id) {
        Ok(key) => key,
        Err(VaultLabelError::KeyMissing) => return Ok(LabelRead::Unreadable),
        Err(e) => return Err(e),
    };

    match decode_vault_label_blob(&wrap_key, vault_id.as_uuid().as_bytes(), &blob) {
        // A decoded label that is not UTF-8 is a corrupt or foreign file, which
        // is the same fact as a failed decode: unreadable, delete, fall back.
        Ok(plaintext) => match core::str::from_utf8(&plaintext) {
            Ok(label) => Ok(LabelRead::Label(label.to_string())),
            Err(_) => {
                log_unreadable("not_utf8");
                Ok(LabelRead::Unreadable)
            }
        },
        Err(e) => {
            // The variant name, never the bytes: a decode failure is diagnostic,
            // and the plaintext it failed to produce is the user's own text.
            log_unreadable(blob_error_kind(&e));
            Ok(LabelRead::Unreadable)
        }
    }
}

/// Write one vault's name, minting the vault's wrap key on first use.
///
/// An empty label is refused rather than stored: clearing a name removes the
/// file ([`remove_label`]), and refusing it here is what makes that structural
/// instead of a rule every call site has to remember.
pub async fn write_label(
    io: &dyn VaultIo,
    vault_root: &Path,
    vault_id: VaultId,
    label: &str,
    keychain: &dyn LabelKeychain,
) -> Result<(), VaultLabelError> {
    if label.is_empty() {
        return Err(VaultLabelError::EmptyLabel);
    }
    if label.len() > MAX_VAULT_LABEL_PLAINTEXT_LEN {
        return Err(VaultLabelError::LabelTooLong);
    }

    let wrap_key = get_or_create_key(keychain, vault_id)?;
    let blob = encode_vault_label_blob(&wrap_key, vault_id.as_uuid().as_bytes(), label.as_bytes())
        .map_err(|_| VaultLabelError::Backend)?;

    io.write(&label_path(vault_root), &blob, WriteOpts::default())
        .await
        .map_err(VaultLabelError::Io)?;

    // The field name and nothing else. The label is the user's own input.
    tracing::info!(event = "vault_label_written");
    Ok(())
}

/// Remove one vault's sealed label file. An absent file is a successful remove:
/// the post-condition callers want is "there is no file", and there is not.
///
/// This alone is **not** an erase: the ciphertext it deletes stays recoverable
/// from the medium while its key lives. Use [`erase`].
pub async fn remove_label(io: &dyn VaultIo, vault_root: &Path) -> Result<(), VaultLabelError> {
    match io.remove_file(&label_path(vault_root)).await {
        Ok(()) | Err(IoFailureKind::NotFound) => Ok(()),
        Err(kind) => Err(VaultLabelError::Io(kind)),
    }
}

/// Make one vault's name unreadable: destroy its wrap key, then remove its file.
///
/// **Key first.** Destroying the key is what the erase actually is, because
/// rewriting or deleting a plaintext file cannot reach bytes already on the
/// medium (`decisions.md` 2026-05-07 settled this for the project when it
/// rejected platform-specific secure-delete). Removing the file afterwards is
/// tidiness, and doing it in the other order would leave a window in which the
/// file is gone and its key is not.
///
/// The file removal runs even when the key destruction failed, and the key's
/// error is the one returned: a partial erase must not report success.
pub async fn erase(
    io: &dyn VaultIo,
    vault_root: &Path,
    vault_id: VaultId,
    keychain: &dyn LabelKeychain,
) -> Result<(), VaultLabelError> {
    let key_result = destroy_key(keychain, vault_id);
    let file_result = remove_label(io, vault_root).await;
    key_result.and(file_result)
}

/// Closed-enum mapping from a codec failure to a static log tag. Mirrors
/// `graph_layout`'s `graph_layout_blob_error_kind`: the tag is a diagnostic, and
/// no variant of it can carry a byte of the blob.
fn blob_error_kind(e: &protocol::vault_label_blob::VaultLabelBlobError) -> &'static str {
    use protocol::vault_label_blob::VaultLabelBlobError as E;
    match e {
        E::HeaderTooShort => "header_too_short",
        E::MagicMismatch => "magic_mismatch",
        E::ProtocolVersionMismatch => "protocol_version_mismatch",
        E::VaultIdMismatch => "vault_id_mismatch",
        E::CiphertextLenOverflow => "ciphertext_len_overflow",
        E::CiphertextTruncated => "ciphertext_truncated",
        E::TrailingBytes => "trailing_bytes",
        E::CannotDecrypt => "aead_fail",
        E::RandomnessUnavailable => "randomness_unavailable",
    }
}

fn log_unreadable(kind: &'static str) {
    tracing::debug!(
        stage = "vault_label_read",
        kind,
        "sealed vault label is unreadable; falling back"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use crate::vault_label::fake_keychain::FakeKeychain;
    use crate::vault_label::key::{keychain_account, VAULT_LABEL_WRAP_KEY_LEN};
    use crate::vault_label::test_ids::{vault, VAULT_A, VAULT_B};

    /// Two vault roots under one scratch directory, the way `vaults/<id>/`
    /// actually lays out on disk.
    struct Roots {
        _dir: ScopedTempDir,
        a: PathBuf,
        b: PathBuf,
    }

    fn roots() -> Roots {
        let dir = ScopedTempDir::new("vault-label-store").expect("scratch dir");
        let a = dir.path().join(VAULT_A);
        let b = dir.path().join(VAULT_B);
        std::fs::create_dir_all(&a).expect("vault A root");
        std::fs::create_dir_all(&b).expect("vault B root");
        Roots { _dir: dir, a, b }
    }

    #[test]
    fn writes_then_reads_a_name() {
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain)
                .await
                .expect("write");
            assert_eq!(
                read_label(&StdVaultIo, &r.a, vault(VAULT_A), &keychain)
                    .await
                    .expect("read"),
                LabelRead::Label("Work".to_string())
            );
        });
    }

    #[test]
    fn a_rewrite_replaces_the_previous_name() {
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain)
                .await
                .expect("write");
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Personal", &keychain)
                .await
                .expect("rewrite");
            assert_eq!(
                read_label(&StdVaultIo, &r.a, vault(VAULT_A), &keychain)
                    .await
                    .expect("read"),
                LabelRead::Label("Personal".to_string())
            );
        });
    }

    #[test]
    fn a_vault_this_device_never_named_reads_as_absent() {
        // The never-unlocked-here case. It resolves structurally (there is no
        // file) rather than through a branch that could be got wrong.
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            assert_eq!(
                read_label(&StdVaultIo, &r.a, vault(VAULT_A), &keychain)
                    .await
                    .expect("read"),
                LabelRead::Absent
            );
        });
        assert!(
            keychain.calls().is_empty(),
            "no file means the keychain is never touched"
        );
    }

    #[test]
    fn the_written_file_carries_the_myl1_magic_and_not_the_name() {
        // The point of the whole family: what lands on disk is sealed. Assert it
        // from the bytes rather than from the fact that a write returned Ok.
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Tax Returns", &keychain)
                .await
                .expect("write");
        });
        let bytes = std::fs::read(label_path(&r.a)).expect("read the file back");
        assert_eq!(&bytes[0..4], b"MYL1");
        assert!(
            !bytes.windows(11).any(|w| w == b"Tax Returns"),
            "the plaintext name must not appear anywhere in the file"
        );
    }

    #[test]
    fn each_vault_gets_its_own_file_and_its_own_key() {
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain)
                .await
                .expect("write A");
            write_label(&StdVaultIo, &r.b, vault(VAULT_B), "Personal", &keychain)
                .await
                .expect("write B");
        });
        let mut accounts = keychain.accounts();
        accounts.sort();
        assert_eq!(accounts, vec![VAULT_A.to_string(), VAULT_B.to_string()]);
        assert_ne!(
            keychain.read(VAULT_A),
            keychain.read(VAULT_B),
            "two vaults, two keys"
        );
    }

    #[test]
    fn vault_as_file_does_not_open_as_vault_bs() {
        // The cross-vault case at the store level: A's sealed file placed where
        // B's would be, read as B, with B's key already present so the read gets
        // past the key lookup.
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain)
                .await
                .expect("write A");
            write_label(&StdVaultIo, &r.b, vault(VAULT_B), "Personal", &keychain)
                .await
                .expect("write B");

            // Move A's file over B's.
            std::fs::copy(label_path(&r.a), label_path(&r.b)).expect("copy A's file over B's");

            assert_eq!(
                read_label(&StdVaultIo, &r.b, vault(VAULT_B), &keychain)
                    .await
                    .expect("read B"),
                LabelRead::Unreadable,
                "a file from another vault must never render as this vault's name"
            );
        });
    }

    #[test]
    fn a_file_whose_key_was_destroyed_reads_as_unreadable() {
        // The restore-onto-a-new-machine shape, and the per-vault erase seen
        // from the reader's side.
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain)
                .await
                .expect("write");
            destroy_key(&keychain, vault(VAULT_A)).expect("destroy the key");

            assert_eq!(
                read_label(&StdVaultIo, &r.a, vault(VAULT_A), &keychain)
                    .await
                    .expect("read"),
                LabelRead::Unreadable
            );
        });
        // And reading did not resurrect a key.
        assert!(keychain.accounts().is_empty());
    }

    #[test]
    fn a_corrupt_file_reads_as_unreadable_rather_than_erroring_the_picker() {
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain)
                .await
                .expect("write");
            let mut bytes = std::fs::read(label_path(&r.a)).expect("read back");
            let last = bytes.len() - 1;
            bytes[last] ^= 0xff;
            std::fs::write(label_path(&r.a), &bytes).expect("corrupt it");

            assert_eq!(
                read_label(&StdVaultIo, &r.a, vault(VAULT_A), &keychain)
                    .await
                    .expect("read must not error"),
                LabelRead::Unreadable
            );
        });
    }

    #[test]
    fn erase_destroys_the_key_and_removes_the_file_for_one_vault_only() {
        // The assertion the whole feature rests on, made by reading the keychain
        // and the filesystem back rather than by trusting the call returned Ok.
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain)
                .await
                .expect("write A");
            write_label(&StdVaultIo, &r.b, vault(VAULT_B), "Personal", &keychain)
                .await
                .expect("write B");

            erase(&StdVaultIo, &r.a, vault(VAULT_A), &keychain)
                .await
                .expect("erase A");

            assert!(keychain.read(VAULT_A).is_none(), "A's key is gone");
            assert!(!label_path(&r.a).exists(), "A's file is gone");
            assert!(keychain.read(VAULT_B).is_some(), "B's key survives");
            assert_eq!(
                read_label(&StdVaultIo, &r.b, vault(VAULT_B), &keychain)
                    .await
                    .expect("read B"),
                LabelRead::Label("Personal".to_string()),
                "B's name is still readable"
            );
        });
    }

    #[test]
    fn erase_is_idempotent() {
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            erase(&StdVaultIo, &r.a, vault(VAULT_A), &keychain)
                .await
                .expect("erase with nothing to erase");
        });
    }

    #[test]
    fn erase_destroys_the_key_before_it_removes_the_file() {
        // Ordering, not tidiness: the key destruction IS the erase, so a crash
        // between the two must leave unreadable ciphertext rather than a live
        // key beside a deleted file.
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain)
                .await
                .expect("write");
            erase(&StdVaultIo, &r.a, vault(VAULT_A), &keychain)
                .await
                .expect("erase");
        });
        let account = keychain_account(vault(VAULT_A));
        assert_eq!(
            keychain.calls().last(),
            Some(&format!("delete {account}")),
            "the last keychain call is the destruction"
        );
    }

    #[test]
    fn remove_label_alone_leaves_the_key_alive() {
        // Recorded so nobody reaches for it as an erase: it is the clear-the-name
        // half, and on its own it deletes recoverable ciphertext beside a live
        // key.
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain)
                .await
                .expect("write");
            remove_label(&StdVaultIo, &r.a).await.expect("remove");
        });
        assert!(!label_path(&r.a).exists());
        assert!(
            keychain.read(VAULT_A).is_some(),
            "remove_label is not an erase, and this is the difference"
        );
    }

    #[test]
    fn removing_an_absent_file_succeeds() {
        let r = roots();
        block_on(async {
            remove_label(&StdVaultIo, &r.a)
                .await
                .expect("absent is the post-condition already");
        });
    }

    #[test]
    fn an_empty_label_is_refused_rather_than_stored() {
        let r = roots();
        let keychain = FakeKeychain::empty();
        block_on(async {
            assert_eq!(
                write_label(&StdVaultIo, &r.a, vault(VAULT_A), "", &keychain).await,
                Err(VaultLabelError::EmptyLabel)
            );
        });
        assert!(!label_path(&r.a).exists());
        assert!(keychain.accounts().is_empty(), "and no key was minted");
    }

    #[test]
    fn an_over_cap_label_is_refused() {
        let r = roots();
        let keychain = FakeKeychain::empty();
        let long = "x".repeat(MAX_VAULT_LABEL_PLAINTEXT_LEN + 1);
        block_on(async {
            assert_eq!(
                write_label(&StdVaultIo, &r.a, vault(VAULT_A), &long, &keychain).await,
                Err(VaultLabelError::LabelTooLong)
            );
        });
        assert!(!label_path(&r.a).exists());
    }

    #[test]
    fn an_unavailable_keychain_writes_nothing_at_all() {
        // The Linux-with-no-secret-service shape. The assertion that matters is
        // the second one: the name is not on disk in any form.
        let r = roots();
        let keychain = FakeKeychain::unavailable();
        block_on(async {
            assert_eq!(
                write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain).await,
                Err(VaultLabelError::KeychainUnavailable)
            );
        });
        assert!(
            !label_path(&r.a).exists(),
            "no file at all, and in particular no plaintext one"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&r.a)
            .expect("list the vault root")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            leftovers.is_empty(),
            "an unavailable keychain must leave the vault root untouched, found {leftovers:?}"
        );
    }

    #[test]
    fn an_unavailable_keychain_surfaces_on_read_of_an_existing_file() {
        // Distinct from `Unreadable`: the file is fine and the facility is not,
        // which is the state the Privacy row has to be able to render.
        let r = roots();
        let good = FakeKeychain::empty();
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &good)
                .await
                .expect("write");
            let none = FakeKeychain::unavailable();
            assert_eq!(
                read_label(&StdVaultIo, &r.a, vault(VAULT_A), &none).await,
                Err(VaultLabelError::KeychainUnavailable)
            );
        });
    }

    #[test]
    fn a_short_keychain_item_does_not_seal_a_file_nothing_can_open() {
        // A corrupt key item is re-minted on the write path, so the file that
        // lands is openable with what the keychain now holds.
        let r = roots();
        let keychain = FakeKeychain::empty();
        keychain.put(VAULT_A, vec![0x22; VAULT_LABEL_WRAP_KEY_LEN - 1]);
        block_on(async {
            write_label(&StdVaultIo, &r.a, vault(VAULT_A), "Work", &keychain)
                .await
                .expect("write");
            assert_eq!(
                read_label(&StdVaultIo, &r.a, vault(VAULT_A), &keychain)
                    .await
                    .expect("read"),
                LabelRead::Label("Work".to_string())
            );
        });
    }

    #[test]
    fn the_file_sits_at_the_vault_root_beside_vault_quickunlock() {
        let r = roots();
        assert_eq!(label_path(&r.a), r.a.join("vault.label"));
        assert_eq!(VAULT_LABEL_FILE_NAME, "vault.label");
    }
}
