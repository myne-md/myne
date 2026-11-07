// SPDX-License-Identifier: AGPL-3.0
//! The two readings the diagnostic block cannot take in the WebView
//! (myne-md/myne#991).
//!
//! The block is assembled in the page from fields the page already has. Two
//! fields have no such source on desktop, and this module is where the host
//! answers them:
//!
//! | Field | Why the page cannot answer it |
//! |---|---|
//! | `bundleHash` | a digest must be computed from the running artefact, and an artefact cannot contain its own digest |
//! | `storageUsedMb` + `storageFiles` | `navigator.storage.estimate()` measures the WebView's own origin store; a desktop vault is a directory of `.myn` files outside it, so the page's own answer is a fact about a different thing |
//!
//! # What the digest IS, and what it is not
//!
//! It is the SHA-256 of the running executable: the code payload of the
//! installed bundle. It is **not** the digest of the installer artefact — a
//! `.dmg`, `.deb`, `AppImage` or `.msi` hashes differently from the executable
//! inside it — so it does not match a published `SHA256SUMS`, and nobody should
//! try. What it does answer is the question the block is read for: are these two
//! reports from the same build, and did the binary under this version string
//! change.
//!
//! # Why the walk does not follow a symbolic link
//!
//! The same rule `myne_core::vault_sweep::count_residue` follows, for the same
//! two reasons: a link is one entry and not a subtree, so nothing here can be
//! made unbounded by a link, and the figure reported is a size the vault
//! actually occupies rather than one it points at.

use protocol::hex::encode_lower;
use std::path::Path;

/// The prefix the block prints before a SHA-256 digest.
///
/// The same spelling `version.json` uses for the served bundle's hash, so one
/// block line reads the same way on both clients. The VALUES differ in what
/// they cover (a bundle on web, the executable on desktop); `commands::build_digest`
/// states that difference.
pub(crate) const DIGEST_PREFIX: &str = "sha256:";

/// A vault directory's on-disk footprint, as the diagnostic block reports it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct VaultUsage {
    /// Sum of the sizes of the entries under the vault directory, in bytes.
    pub used_bytes: u64,
    /// Regular files and symbolic links under it. Directories are not counted:
    /// the question this answers is how many pieces the vault is spread over.
    pub files: u64,
}

/// The lowercase-hex SHA-256 of one file, streamed, with the block's prefix.
///
/// Streamed in 64 KiB reads rather than `std::fs::read`, because the file is the
/// application executable on every platform this ships on and reading it whole
/// would put a second copy of the bundle in memory to hash it.
pub(crate) fn digest_of_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let mut digest = String::with_capacity(DIGEST_PREFIX.len() + 64);
    digest.push_str(DIGEST_PREFIX);
    digest.push_str(&encode_lower(&hasher.finalize()));
    Ok(digest)
}

/// Measure a vault directory. A missing or unreadable directory is zero
/// entries rather than an error.
///
/// Zero rather than a refusal because the caller reports absence by omitting the
/// line, and a vault that has just been created has nothing under it yet: that
/// is a true reading of `0`, not a failure to read. An unreadable subtree inside
/// the directory is skipped the way `count_residue` skips it, so one bad
/// subdirectory costs its own share of the figure and never the whole reading.
pub(crate) fn usage_of_dir(dir: &Path) -> VaultUsage {
    fn walk(dir: &Path, acc: &mut VaultUsage) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                walk(&path, acc);
            } else {
                acc.files = acc.files.saturating_add(1);
                acc.used_bytes = acc.used_bytes.saturating_add(meta.len());
            }
        }
    }
    let mut acc = VaultUsage::default();
    walk(dir, &mut acc);
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "myne-diagnostics-measures-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// The digest of a known byte string, so the assertion is a value rather
    /// than "some hex came back". `"abc"` is the canonical SHA-256 vector
    /// (FIPS 180-4 / RFC 6234 A.1).
    #[test]
    fn digest_of_file_is_the_sha256_of_its_bytes_with_the_block_prefix() {
        let dir = temp_dir("digest");
        let file = dir.join("payload");
        std::fs::write(&file, b"abc").expect("write");
        let digest = digest_of_file(&file).expect("digest");
        assert_eq!(
            digest,
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Streamed in 64 KiB reads, so the multi-block path needs its OWN expected
        // value: a buffer boundary that dropped or repeated bytes leaves the small
        // case above green, and an inequality against that case is not a reading.
        // 200 000 bytes of `a` with byte 150 000 set to `b`, i.e. a payload that
        // spans four reads and differs from the block before the last one.
        let big = dir.join("big");
        let mut bytes = vec![b'a'; 200_000];
        bytes[150_000] = b'b';
        std::fs::write(&big, &bytes).expect("write");
        assert_eq!(
            digest_of_file(&big).expect("digest"),
            "sha256:0015551ee6878fb8fac81b40e6fa9d4092b7931e99214ec73d1b0ac716254a97"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_is_an_error_and_not_an_empty_digest() {
        let dir = temp_dir("missing");
        assert!(digest_of_file(&dir.join("absent")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn usage_counts_every_file_under_the_directory_and_its_subdirectories() {
        let dir = temp_dir("usage");
        std::fs::write(dir.join("a"), b"12345").expect("write");
        std::fs::create_dir_all(dir.join("notes")).expect("mkdir");
        std::fs::write(dir.join("notes").join("b"), b"123").expect("write");
        let usage = usage_of_dir(&dir);
        assert_eq!(usage.files, 2, "two files, not the directory itself");
        assert_eq!(usage.used_bytes, 8);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_directory_reads_as_zero_rather_than_failing() {
        let dir = temp_dir("usage-missing");
        let usage = usage_of_dir(&dir.join("never-created"));
        assert_eq!(usage, VaultUsage::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The link is an entry with its own (small) size, and the file it points at
    /// is neither counted nor measured. Without this, one link to `/` would make
    /// a diagnostic read walk a whole filesystem.
    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_is_one_entry_and_is_not_followed() {
        let dir = temp_dir("usage-symlink");
        let outside = dir.join("outside");
        std::fs::create_dir_all(&outside).expect("mkdir");
        std::fs::write(outside.join("big"), vec![0u8; 4096]).expect("write");
        let vault = dir.join("vault");
        std::fs::create_dir_all(&vault).expect("mkdir");
        std::os::unix::fs::symlink(&outside, vault.join("linked")).expect("symlink");
        let usage = usage_of_dir(&vault);
        assert_eq!(usage.files, 1);
        assert!(
            usage.used_bytes < 4096,
            "the 4096-byte file behind the link must not be measured: {}",
            usage.used_bytes
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
