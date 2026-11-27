// SPDX-License-Identifier: AGPL-3.0-only
//! The file layer under the Windows label store: item naming, the atomic write, and
//! the unlink.
//!
//! Extracted from the DPAPI store itself for one reason: DPAPI does not exist on the
//! machine this was written on, so a store that sealed and wrote in one function would
//! be compiled by nothing and tested by nothing. The seal is the part that needs
//! Windows; the part that can lose a name is here, and here it runs and is tested on a
//! Linux host.
//!
//! Three failure modes this layer exists to prevent, in order of cost:
//!
//! - **A truncated item reads as absent and silently drops a cached name.** So a write
//!   goes to a sibling temporary path and is renamed into place: a crash mid-write
//!   leaves the old item or the new one, never half of either.
//! - **An account name that reaches a path separator addresses a file outside the
//!   directory.** Names come from `core` and are a `VaultId` rendering or the reserved
//!   `account-record` string, so this is a belt on a caller that already cannot pass
//!   anything else; it is here because the name becomes a file name.
//! - **An absent item reported as an error.** Deleting what is not there succeeds,
//!   because the post-condition every caller wants is "the key is gone".

use std::path::{Path, PathBuf};

/// Directory of the sealed items inside the app config directory.
///
/// Beside `person-auth.json` rather than in the vault tree: these keys belong to the
/// DEVICE, so a per-vault directory would delete them with the vault that happened to be
/// open when they were written.
pub(crate) const DIR: &str = "device-keys";

/// Distinguishes concurrent writers of the same item, for the temporary name only.
static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Whether a name may become a file name here.
pub(crate) fn safe_account_name(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= 64
        && account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// One item's path, or `None` when the name is not one this store may address.
pub(crate) fn item_path(dir: &Path, account: &str) -> Option<PathBuf> {
    safe_account_name(account).then(|| dir.join(format!("{account}.dpapi")))
}

/// Read an item's sealed bytes. `Ok(None)` is "no such item", the ordinary state for a
/// vault this device has never unlocked.
pub(crate) fn read_item(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(blob) => Ok(Some(blob)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Write an item's sealed bytes, atomically.
pub(crate) fn write_item_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // One temporary name per WRITER, not per item: two writers sealing the same account at
    // once would otherwise interleave into one temporary file, and the loser's rename would
    // copy a torn blob into place or fail outright.
    let unique = format!(
        "{}.{}.{:x}.dpapi.tmp",
        path.file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id(),
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let tmp = path.with_file_name(unique);
    // `sync_all` before the rename, then the canonical write-through rename
    // (`format::atomic_write::finalize_atomic`). Without the flush the rename can become
    // durable before the bytes do, and a crash leaves a truncated destination that
    // `read_item` hands to unseal and the store reports as absent.
    let written = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        std::io::Write::write_all(&mut file, bytes)?;
        file.sync_all()
    })();
    match written.and_then(|()| crate::atomic_write::finalize_atomic(&tmp, path, true)) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Leave nothing behind that a later scan could mistake for an item.
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Remove an item. An absent item is a successful remove.
pub(crate) fn remove_item(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A scratch directory of this test binary's own, under the layer's real directory
    /// name, so cases cannot collide and none of them touches the running app's config
    /// directory.
    fn scratch() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir()
            .join(format!(
                "myne-label-store-files-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ))
            .join(DIR);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_vault_id_rendering_and_the_reserved_name_are_both_addressable() {
        let dir = Path::new("/config/device-keys");
        let vault = "0192f4c1-9a3e-7c4d-8b21-4d5e6f708192";
        assert_eq!(
            item_path(dir, vault),
            Some(dir.join(format!("{vault}.dpapi"))),
            "a VaultId rendering is the ordinary account name"
        );
        assert_eq!(
            item_path(dir, "account-record"),
            Some(dir.join("account-record.dpapi"))
        );
    }

    #[test]
    fn a_name_that_could_address_another_path_is_refused() {
        // The failure this pins: a name carrying a separator or a dot segment writes
        // somewhere else entirely, and the erase then deletes the wrong file.
        let dir = Path::new("/config/device-keys");
        for name in ["../account-record", "a/b", "a\\b", "..", ".", "", " spaced"] {
            assert_eq!(item_path(dir, name), None, "{name:?} must be refused");
        }
        assert!(
            !safe_account_name(&"a".repeat(65)),
            "a long name is refused"
        );
    }

    #[test]
    fn an_absent_item_reads_as_absent_rather_than_failing() {
        let dir = scratch();
        let path = dir.join("nothing.dpapi");
        assert_eq!(read_item(&path).expect("absent is not a fault"), None);
        assert!(remove_item(&path).is_ok(), "deleting nothing succeeds");
    }

    #[test]
    fn a_write_lands_atomically_and_reads_back() {
        let dir = scratch();
        let path = dir.join("items").join("account-record.dpapi");
        write_item_atomic(&path, b"sealed-bytes").expect("write");
        assert_eq!(
            read_item(&path).expect("read").as_deref(),
            Some(&b"sealed-bytes"[..])
        );
        // No temporary path survives a successful write: a leftover would be a second
        // file beside the item, which nothing addresses.
        let siblings: Vec<_> = std::fs::read_dir(path.parent().expect("parent"))
            .expect("list")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(
            siblings,
            vec![std::ffi::OsString::from("account-record.dpapi")]
        );
    }

    #[test]
    fn a_second_write_replaces_the_first_and_leaves_no_temporary_behind() {
        let dir = scratch();
        let path = dir.join("v.dpapi");
        write_item_atomic(&path, b"first").expect("first write");
        write_item_atomic(&path, b"second").expect("second write");
        assert_eq!(
            read_item(&path).expect("read").as_deref(),
            Some(&b"second"[..])
        );
        assert!(!path.with_extension("dpapi.tmp").exists());
    }

    #[test]
    fn a_remove_takes_only_the_named_item() {
        // The per-vault erase guarantee, at this layer: destroying one vault's item must
        // leave every other vault's item readable.
        let dir = scratch();
        let a = dir.join("a.dpapi");
        let b = dir.join("b.dpapi");
        write_item_atomic(&a, b"a-key").expect("write a");
        write_item_atomic(&b, b"b-key").expect("write b");
        remove_item(&a).expect("remove a");
        assert_eq!(read_item(&a).expect("read a"), None);
        assert_eq!(
            read_item(&b).expect("read b").as_deref(),
            Some(&b"b-key"[..]),
            "the other item must survive"
        );
    }
}
