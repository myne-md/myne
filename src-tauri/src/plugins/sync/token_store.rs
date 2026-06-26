//! Per-device token storage (MYND-425 task 4, SYNC-16).
//!
//! The per-device sync token is a credential: it authenticates push/pull/device
//! calls. It is **device-local, never synced**, and revoking it never touches
//! `device_id` (SYNC-2).
//!
//! Two tiers:
//! - **OS keychain (strong path)** — the production target on macOS/Windows:
//!   `thisDeviceOnly`, readable while the vault is locked so background sync
//!   works, the MYQ1 / quick-unlock provider pattern. This is **OS-FFI +
//!   R3-adjacent** (the macOS `security-framework` seam is itself "pending
//!   primitive-level review", `plugins/quick_unlock/macos.rs`) and is **not**
//!   wired here — it lands with the quick-unlock keychain seam under review.
//! - **Restricted-permission file fallback (this module)** — a `0600`
//!   device-local file under the app data dir. Implemented + tested here.
//!   **Honestly weaker** than the OS keychain: an `0600` file is readable by any
//!   process running as the same OS user (no per-app isolation, no
//!   locked-state hardware gating). It is the documented Linux fallback (no
//!   universal Linux keychain) and the dev/test path.

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Device-local token file name (under the app data dir; never synced).
pub const TOKEN_FILE: &str = "sync-token";

/// Token-store failures.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum TokenStoreError {
    /// Filesystem error reading/writing the fallback token file.
    #[error("filesystem error on the device-local token file")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
}

impl From<std::io::Error> for TokenStoreError {
    fn from(e: std::io::Error) -> Self {
        TokenStoreError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

fn token_path(dir: &Path) -> PathBuf {
    dir.join(TOKEN_FILE)
}

/// Store the token in the restricted-permission fallback file (`0600` on Unix).
/// The bytes are hex-encoded so the file is a plain token line.
pub fn store_token_fallback(dir: &Path, token: &[u8]) -> Result<(), TokenStoreError> {
    let path = token_path(dir);
    let mut hex = String::with_capacity(token.len() * 2);
    for b in token {
        hex.push_str(&format!("{b:02x}"));
    }
    // Atomic replace, then tighten permissions to 0600 (Unix).
    crate::atomic_write::atomic_write(&path, hex.as_bytes(), true)?;
    set_restricted_perms(&path)?;
    Ok(())
}

#[cfg(unix)]
fn set_restricted_perms(path: &Path) -> Result<(), TokenStoreError> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(0o600);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_restricted_perms(_path: &Path) -> Result<(), TokenStoreError> {
    // Non-Unix: the OS-keychain path is the production target; the fallback file
    // relies on the user-profile ACL. (No-op; documented as weaker.)
    Ok(())
}

/// Read the token from the fallback file, or `None` if absent.
pub fn read_token_fallback(dir: &Path) -> Result<Option<Vec<u8>>, TokenStoreError> {
    let path = token_path(dir);
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            let s = s.trim();
            if s.is_empty()
                || !s.len().is_multiple_of(2)
                || !s.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Ok(None);
            }
            let bytes: Option<Vec<u8>> = (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
                .collect();
            Ok(bytes)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Remove the fallback token file (on local logout / device removal).
pub fn clear_token_fallback(dir: &Path) -> Result<(), TokenStoreError> {
    let path = token_path(dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myne-tokstore-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn roundtrip_and_absent_default() {
        let dir = tmpdir("rt");
        assert_eq!(read_token_fallback(&dir).unwrap(), None);
        let token = vec![0xde, 0xad, 0xbe, 0xef];
        store_token_fallback(&dir, &token).unwrap();
        assert_eq!(read_token_fallback(&dir).unwrap(), Some(token));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn fallback_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmpdir("perm");
        store_token_fallback(&dir, &[0x01, 0x02]).unwrap();
        let mode = std::fs::metadata(token_path(&dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "fallback token file must be 0600");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_removes_token() {
        let dir = tmpdir("clr");
        store_token_fallback(&dir, &[0xaa]).unwrap();
        clear_token_fallback(&dir).unwrap();
        assert_eq!(read_token_fallback(&dir).unwrap(), None);
        // Idempotent on absent.
        clear_token_fallback(&dir).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}
