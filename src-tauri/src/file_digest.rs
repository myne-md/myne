// SPDX-License-Identifier: AGPL-3.0-only
//! One streamed SHA-256 over a file.
//!
//! Two callers in this crate hash a file they did not write: the model store
//! fingerprints a weights file to decide whether a warm unlock can reuse its
//! marker, and the diagnostics plugin hashes the executable the process is
//! running from (myne-md/myne#991). The loop is eight lines, which is exactly
//! why it was written twice: the second copy carried a different return type, a
//! dropped precondition and no reader would notice the drift until one of the
//! two started hashing a file it should have refused.
//!
//! The precondition is the reason this is a function rather than a macro. A
//! non-regular file is refused before a byte is read: a FIFO or a device would
//! never return 0 and the read loop would never end, which is a hang in a
//! command that a user opened a settings panel to reach.

use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// The SHA-256 of one regular file's bytes.
///
/// Streamed in 64 KiB reads, so the peak cost is a buffer rather than a second
/// copy of a file that is hundreds of megabytes on both of today's callers.
///
/// # Errors
///
/// Any `std::io` failure from the stat, the open or a read, and
/// [`std::io::ErrorKind::InvalidInput`] when the path is not a regular file.
pub(crate) fn sha256_of_file(path: &Path) -> std::io::Result<[u8; 32]> {
    if !std::fs::metadata(path)?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
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
    Ok(hasher.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::sha256_of_file;
    use std::path::Path;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("myne-file-digest-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("payload");
        std::fs::write(&path, bytes).expect("write");
        path
    }

    /// `"abc"` is the canonical SHA-256 vector (FIPS 180-4 / RFC 6234 A.1), so
    /// the assertion is a value rather than "32 bytes came back".
    #[test]
    fn the_digest_is_the_sha256_of_the_bytes() {
        let path = temp_file("small", b"abc");
        assert_eq!(
            protocol::hex::encode_lower(&sha256_of_file(&path).expect("digest")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_dir_all(path.parent().expect("parent"));
    }

    /// A payload that spans four 64 KiB reads and differs from the block before
    /// the last one. Without its own expected value, a loop that stopped after
    /// the first read would leave the small case green.
    #[test]
    fn a_multi_block_file_hashes_every_block() {
        let mut bytes = vec![b'a'; 200_000];
        bytes[150_000] = b'b';
        let path = temp_file("big", &bytes);
        assert_eq!(
            protocol::hex::encode_lower(&sha256_of_file(&path).expect("digest")),
            "0015551ee6878fb8fac81b40e6fa9d4092b7931e99214ec73d1b0ac716254a97"
        );
        let _ = std::fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn a_missing_file_is_an_error_rather_than_an_empty_digest() {
        assert!(sha256_of_file(Path::new("/nonexistent/myne/digest")).is_err());
    }

    /// The precondition that keeps the read loop from hanging, pinned where a
    /// regression would be found: a directory is refused without being opened.
    #[test]
    fn a_non_regular_file_is_refused() {
        let dir = std::env::temp_dir().join(format!("myne-file-digest-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let error = sha256_of_file(&dir).expect_err("a directory is not a file");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
