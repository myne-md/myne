//! Per-device token storage (MYND-425 task 4, SYNC-16) behind a provider seam.
//!
//! The per-device sync token is a credential: it authenticates push/pull/device
//! calls. It is **device-local, never synced**, and revoking it never touches
//! `device_id` (SYNC-2).
//!
//! ## Provider seam ([`TokenStore`])
//!
//! Storage is a trait ([`TokenStore`]) so later OS-keychain providers attach
//! **without touching command bodies** — the same shape as
//! `plugins::quick_unlock::provider::QuickUnlockProvider`. Two tiers:
//! - **OS keychain (strong path)** — the production target: `thisDeviceOnly`,
//!   readable while the vault is locked so background sync works. This is
//!   **OS-FFI + R3-adjacent** and is **not** wired here — desktop macOS/Windows
//!   lands as MYND-463, mobile iOS Keychain / Android Keystore as MYND-464.
//! - **Restricted-permission file fallback ([`FileTokenStore`], the v1 default
//!   for BOTH clients, SYNC-34)** — a `0600` device-local file under the app
//!   data dir. On desktop it is **honestly weaker** than the OS keychain (an
//!   `0600` file is readable by any process running as the same OS user — no
//!   per-app isolation, no locked-state hardware gating; the documented Linux
//!   fallback + the dev/test path). On mobile the app-private sandbox gives this
//!   file materially stronger isolation (per-app), which is why it is the
//!   accepted v1 mobile tier until the keychain provider lands.
//!
//! Token bytes are never logged (`src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline" DENY-list) — the trait impls carry that discipline.

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

/// Device-local per-device-token storage. `dir` is the device-local directory
/// the token lives under (the vault/app data dir). Implementors MUST NOT log or
/// serialize the token bytes.
pub trait TokenStore {
    /// Persist `token` for this device.
    fn store(&self, dir: &Path, token: &[u8]) -> Result<(), TokenStoreError>;
    /// Read this device's token, or `None` if absent.
    fn read(&self, dir: &Path) -> Result<Option<Vec<u8>>, TokenStoreError>;
    /// Remove this device's token (local logout / device removal). Idempotent.
    fn clear(&self, dir: &Path) -> Result<(), TokenStoreError>;
}

/// The `0600` restricted-permission file store — the v1 default for both desktop
/// and mobile (SYNC-34). Keychain providers (MYND-463/464) replace it behind the
/// [`TokenStore`] seam without changing any command body.
#[derive(Debug, Default, Clone, Copy)]
pub struct FileTokenStore;

impl TokenStore for FileTokenStore {
    fn store(&self, dir: &Path, token: &[u8]) -> Result<(), TokenStoreError> {
        file_store(dir, token)
    }
    fn read(&self, dir: &Path) -> Result<Option<Vec<u8>>, TokenStoreError> {
        file_read(dir)
    }
    fn clear(&self, dir: &Path) -> Result<(), TokenStoreError> {
        file_clear(dir)
    }
}

/// The default v1 token store resolver (both clients → [`FileTokenStore`]). The
/// single place a keychain provider swaps in later (MYND-463/464).
pub fn default_store() -> FileTokenStore {
    FileTokenStore
}

fn token_path(dir: &Path) -> PathBuf {
    dir.join(TOKEN_FILE)
}

/// Store the token in the restricted-permission fallback file (`0600` on Unix).
/// The bytes are hex-encoded so the file is a plain token line.
fn file_store(dir: &Path, token: &[u8]) -> Result<(), TokenStoreError> {
    let path = token_path(dir);
    let mut hex = String::with_capacity(token.len() * 2);
    for b in token {
        hex.push_str(&format!("{b:02x}"));
    }
    // Atomic replace with the temp created owner-only (`0600`) from the start,
    // so the token file is never briefly group/world-readable in a
    // create-then-chmod window (Unix). `set_restricted_perms` stays as a
    // final normalization: it is now redundant on the happy path, but it keeps
    // the exact-`0600` guarantee under any umask and makes a chmod failure
    // benign (the file is already `0600` before it runs).
    crate::atomic_write::atomic_write_private(&path, hex.as_bytes(), true)?;
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
fn file_read(dir: &Path) -> Result<Option<Vec<u8>>, TokenStoreError> {
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
fn file_clear(dir: &Path) -> Result<(), TokenStoreError> {
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
    use std::sync::Mutex;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myne-tokstore-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// In-memory [`TokenStore`] so the resolution/policy logic is
    /// host-unit-testable without touching the filesystem (mirrors
    /// `quick_unlock::provider::MockProvider`). Keyed by the dir so distinct
    /// devices/vaults stay isolated.
    #[derive(Default)]
    struct MockTokenStore {
        slots: Mutex<std::collections::HashMap<PathBuf, Vec<u8>>>,
    }

    impl TokenStore for MockTokenStore {
        fn store(&self, dir: &Path, token: &[u8]) -> Result<(), TokenStoreError> {
            self.slots
                .lock()
                .unwrap()
                .insert(dir.to_path_buf(), token.to_vec());
            Ok(())
        }
        fn read(&self, dir: &Path) -> Result<Option<Vec<u8>>, TokenStoreError> {
            Ok(self.slots.lock().unwrap().get(dir).cloned())
        }
        fn clear(&self, dir: &Path) -> Result<(), TokenStoreError> {
            self.slots.lock().unwrap().remove(dir);
            Ok(())
        }
    }

    #[test]
    fn file_store_roundtrip_and_absent_default() {
        let store = FileTokenStore;
        let dir = tmpdir("rt");
        assert_eq!(store.read(&dir).unwrap(), None);
        let token = vec![0xde, 0xad, 0xbe, 0xef];
        store.store(&dir, &token).unwrap();
        assert_eq!(store.read(&dir).unwrap(), Some(token));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn file_store_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let store = FileTokenStore;
        let dir = tmpdir("perm");
        store.store(&dir, &[0x01, 0x02]).unwrap();
        let mode = std::fs::metadata(token_path(&dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "fallback token file must be 0600");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_clear_removes_token_idempotent() {
        let store = FileTokenStore;
        let dir = tmpdir("clr");
        store.store(&dir, &[0xaa]).unwrap();
        store.clear(&dir).unwrap();
        assert_eq!(store.read(&dir).unwrap(), None);
        // Idempotent on absent.
        store.clear(&dir).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn default_store_is_file_backed() {
        // The v1 resolver returns the file store for both clients (SYNC-34).
        let store = default_store();
        let dir = tmpdir("def");
        store.store(&dir, &[0x11, 0x22]).unwrap();
        // Observable via the file path (proves it is FileTokenStore, not a mock).
        assert!(token_path(&dir).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn mock_store_roundtrip_and_isolation() {
        let store = MockTokenStore::default();
        let a = PathBuf::from("/dev/a");
        let b = PathBuf::from("/dev/b");
        assert_eq!(store.read(&a).unwrap(), None);
        store.store(&a, &[1, 2, 3]).unwrap();
        assert_eq!(store.read(&a).unwrap(), Some(vec![1, 2, 3]));
        // Distinct dirs are isolated.
        assert_eq!(store.read(&b).unwrap(), None);
        store.clear(&a).unwrap();
        assert_eq!(store.read(&a).unwrap(), None);
    }
}
