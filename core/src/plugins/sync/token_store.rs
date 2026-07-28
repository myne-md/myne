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

/// The storage seam's closed error, straight through (phase3-web-client task 86).
impl From<IoFailureKind> for TokenStoreError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        TokenStoreError::Io { io_error_kind }
    }
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
///
/// **Async since phase3-web-client task 86**, because the storage seam is: OPFS
/// handle acquisition cannot be done synchronously, so a browser-backed store
/// has no synchronous implementation to write. The trait was already the right
/// seam — a keychain provider was always going to replace `FileTokenStore`
/// behind it — this only widens it enough for the third client.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait TokenStore {
    /// Persist `token` for this device.
    async fn store(
        &self,
        io: &dyn crate::vault_io::VaultIo,
        dir: &Path,
        token: &[u8],
    ) -> Result<(), TokenStoreError>;
    /// Read this device's token, or `None` if absent.
    async fn read(
        &self,
        io: &dyn crate::vault_io::VaultIo,
        dir: &Path,
    ) -> Result<Option<Vec<u8>>, TokenStoreError>;
    /// Remove this device's token (local logout / device removal). Idempotent.
    async fn clear(
        &self,
        io: &dyn crate::vault_io::VaultIo,
        dir: &Path,
    ) -> Result<(), TokenStoreError>;
}

/// The `0600` restricted-permission file store — the v1 default for both desktop
/// and mobile (SYNC-34). Keychain providers (MYND-463/464) replace it behind the
/// [`TokenStore`] seam without changing any command body.
#[derive(Debug, Default, Clone, Copy)]
pub struct FileTokenStore;

#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
impl TokenStore for FileTokenStore {
    async fn store(
        &self,
        io: &dyn crate::vault_io::VaultIo,
        dir: &Path,
        token: &[u8],
    ) -> Result<(), TokenStoreError> {
        file_store(io, dir, token).await
    }
    async fn read(
        &self,
        io: &dyn crate::vault_io::VaultIo,
        dir: &Path,
    ) -> Result<Option<Vec<u8>>, TokenStoreError> {
        file_read(io, dir).await
    }
    async fn clear(
        &self,
        io: &dyn crate::vault_io::VaultIo,
        dir: &Path,
    ) -> Result<(), TokenStoreError> {
        file_clear(io, dir).await
    }
}

/// **Session-scoped** token store: the token lives in RAM for as long as the
/// Worker does, and nothing is written anywhere (phase3-web-client task 37).
///
/// # Why the browser gets this and not [`FileTokenStore`]
///
/// The per-device token is a credential, and a browser may be running on a
/// machine that is not the user's — `threat-model.md` §7's whole premise. So the
/// web client's token **must not outlive the tab**: closing it leaves no durable
/// credential behind, and the next session re-authenticates through the ordinary
/// SCRAM handshake rather than resuming from stored state.
///
/// # What is deliberately NOT session-scoped
///
/// `device_id` still persists (in `sync-state.json`). That asymmetry is the
/// decision, not an oversight: `device_id` is an IDENTIFIER, not a credential —
/// revoking a token never touches it (SYNC-2) — and session-scoping it too would
/// mint a new device on every reload, landing the browser back in "pending,
/// awaiting approval from another device" every single time. Task 33 names that
/// outcome as fatal, and it would also grow the account's device roster by one
/// row per tab open.
///
/// # Lifetime, precisely
///
/// One `OnceLock<Mutex<…>>` per module instance, and a wasm module instance IS
/// the Worker. Killing the Worker — which is what closing the tab does — drops
/// the map. Nothing else is needed to make "session close discards it" true.
#[derive(Debug, Default, Clone, Copy)]
pub struct SessionTokenStore;

/// The session map, keyed by vault dir so two vaults cannot see each other's
/// token (the same isolation `FileTokenStore` gets from the filesystem).
fn session_slots() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, Vec<u8>>> {
    static SLOTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, Vec<u8>>>,
    > = std::sync::OnceLock::new();
    SLOTS.get_or_init(Default::default)
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
impl TokenStore for SessionTokenStore {
    async fn store(
        &self,
        _io: &dyn crate::vault_io::VaultIo,
        dir: &Path,
        token: &[u8],
    ) -> Result<(), TokenStoreError> {
        // `_io` is unused and that is the point: this store touches no storage
        // seam at all, so there is nothing for an eviction, a backup or a forensic
        // read of the origin's OPFS to find.
        session_slots()
            .lock()
            .map_err(|_| TokenStoreError::Io {
                io_error_kind: IoFailureKind::Other,
            })?
            .insert(dir.to_path_buf(), token.to_vec());
        Ok(())
    }
    async fn read(
        &self,
        _io: &dyn crate::vault_io::VaultIo,
        dir: &Path,
    ) -> Result<Option<Vec<u8>>, TokenStoreError> {
        Ok(session_slots()
            .lock()
            .map_err(|_| TokenStoreError::Io {
                io_error_kind: IoFailureKind::Other,
            })?
            .get(dir)
            .cloned())
    }
    async fn clear(
        &self,
        _io: &dyn crate::vault_io::VaultIo,
        dir: &Path,
    ) -> Result<(), TokenStoreError> {
        session_slots()
            .lock()
            .map_err(|_| TokenStoreError::Io {
                io_error_kind: IoFailureKind::Other,
            })?
            .remove(dir);
        Ok(())
    }
}

/// The default token store for THIS client.
///
/// Native (desktop + mobile): the `0600` file (SYNC-34), until a keychain
/// provider replaces it (MYND-463/464) — this is still the single place that
/// swap happens.
///
/// **wasm: [`SessionTokenStore`]**, because a browser must leave no durable
/// credential on a machine that may not be the user's (task 37). The choice is
/// made HERE rather than at the nine call sites for the same reason the file
/// store was: a per-site decision is one a new call site can get wrong.
#[cfg(not(target_arch = "wasm32"))]
pub fn default_store() -> FileTokenStore {
    FileTokenStore
}

/// See the native arm.
#[cfg(target_arch = "wasm32")]
pub fn default_store() -> SessionTokenStore {
    SessionTokenStore
}

fn token_path(dir: &Path) -> PathBuf {
    dir.join(TOKEN_FILE)
}

/// Store the token in the restricted-permission fallback file (`0600` on Unix).
/// The bytes are hex-encoded so the file is a plain token line.
async fn file_store(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
    token: &[u8],
) -> Result<(), TokenStoreError> {
    let path = token_path(dir);
    let mut hex = String::with_capacity(token.len() * 2 + 1);
    for b in token {
        hex.push_str(&format!("{b:02x}"));
    }
    // The terminator is what makes a truncated write detectable — see
    // [`TOKEN_TERMINATOR`]. Written as part of the same single `write` call, so
    // there is no window where the body exists without it.
    hex.push(TOKEN_TERMINATOR as char);
    // `WriteOpts::default()` carries `private: true`, which the seam's native arm
    // routes to `atomic_write_private` — the temp is created owner-only (`0600`)
    // from the start, so the token file is never briefly group/world-readable in
    // a create-then-chmod window. On the wasm arm `private` is a documented
    // no-op, correctly: OPFS is origin-scoped, so there is no other principal on
    // the origin to exclude.
    //
    // The final `0600` normalization moved INTO `atomic_write_private` with task
    // 86 (`normalize_private_mode`). It is a permission mechanic of the native
    // write, so it belongs beside the write — and keeping a `#[cfg(unix)]`
    // `std::fs` call here would have held this file on the IO-seam ratchet for a
    // line wasm32 can never reach.
    io.write(&path, hex.as_bytes(), crate::vault_io::WriteOpts::default())
        .await?;
    Ok(())
}

/// The terminator every token file ends with, and the reason the format has one
/// at all (phase3-web-client task 84).
///
/// A hex line has no structure a truncation breaks: **a prefix of a hex line is
/// a hex line**. So a token file cut short does not fail to parse — it decodes
/// cleanly to a SHORT token, which is sent to the server, rejected 401, and
/// parks the sync loop for 15 minutes behind "auth failed". Neither a length
/// check nor the hex validation can tell the two apart, because nothing in the
/// format records how long the payload was supposed to be.
///
/// One trailing byte fixes that: a write that did not finish does not have it.
///
/// **The store this was added for no longer exists** — the browser holds its
/// token in RAM (task 37), and `atomic_write` already makes the native file
/// all-or-nothing, so no writer in the product can produce a truncated one
/// today. It stays because it costs one byte, it is the only thing that would
/// catch a future store whose writes are not atomic, and removing it would be a
/// second format flip with a second silent re-claim for every existing device.
const TOKEN_TERMINATOR: u8 = b'\n';

/// Decode one stored copy of the token file: an even-length ASCII-hex line
/// followed by [`TOKEN_TERMINATOR`]. `None` for anything else.
///
/// Separate from [`file_read`] because it is what [`crate::singleton::open_newest`]
/// consults per candidate — see that call for why the choice has to be made by
/// the decoder rather than by the read.
///
/// **Files written before the terminator existed read as `None`**, and that is
/// the deliberate choice rather than a legacy branch: an absent token is
/// silently re-claimed by `try_claim_token` under the unlocked `root_key`
/// (already-approved devices need no new approval), so the migration cost is one
/// extra handshake on one cycle, invisible to the user. A permanent
/// accept-either branch would cost more than that forever, and would re-admit
/// exactly the ambiguity the terminator removes.
fn decode_token_line(bytes: &[u8]) -> Option<Vec<u8>> {
    let body = bytes.strip_suffix(&[TOKEN_TERMINATOR])?;
    let s = std::str::from_utf8(body).ok()?;
    if s.is_empty() || !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Read the token from the fallback file, or `None` if absent.
///
/// **Through [`crate::singleton::open_newest`], not [`crate::vault_io::VaultIo::read`]**
/// (phase3-web-client task 84), for the reason task 86 found the hard way with
/// the sync sidecars and this file was missed by: on a container store `read`
/// returns the newest **structurally intact** copy, meaning the newest whose
/// generation frame parses — and a write torn a few bytes in leaves a valid
/// frame wrapping a PREFIX of the hex line. That prefix is still even-length
/// hex about half the time, so it decodes to a short token that gets sent to the
/// server, rejected 401, and parks the sync loop for 15 minutes while a complete
/// token sat in the other slot. The verifier here is "is this a whole hex line",
/// so that has to be the thing choosing the copy.
///
/// A non-UTF-8 or non-hex file is treated as absent, exactly as before:
/// "unusable" has one answer here (re-claim the token), not two.
async fn file_read(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
) -> Result<Option<Vec<u8>>, TokenStoreError> {
    let path = token_path(dir);
    match crate::singleton::open_newest(io, &path, |bytes| decode_token_line(bytes).ok_or(())).await
    {
        Ok(token) => Ok(Some(token)),
        Err(crate::singleton::OpenOutcome::Absent) => Ok(None),
        Err(crate::singleton::OpenOutcome::Undecodable(())) => Ok(None),
        Err(crate::singleton::OpenOutcome::Io(crate::io_failure_kind::IoFailureKind::NotFound)) => {
            Ok(None)
        }
        Err(crate::singleton::OpenOutcome::Io(kind)) => Err(kind.into()),
    }
}

/// Remove the fallback token file (on local logout / device removal).
async fn file_clear(io: &dyn crate::vault_io::VaultIo, dir: &Path) -> Result<(), TokenStoreError> {
    let path = token_path(dir);
    match io.remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => Ok(()),
        Err(kind) => Err(kind.into()),
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

    #[async_trait::async_trait]
    impl TokenStore for MockTokenStore {
        async fn store(
            &self,
            _io: &dyn crate::vault_io::VaultIo,
            dir: &Path,
            token: &[u8],
        ) -> Result<(), TokenStoreError> {
            self.slots
                .lock()
                .unwrap()
                .insert(dir.to_path_buf(), token.to_vec());
            Ok(())
        }
        async fn read(
            &self,
            _io: &dyn crate::vault_io::VaultIo,
            dir: &Path,
        ) -> Result<Option<Vec<u8>>, TokenStoreError> {
            Ok(self.slots.lock().unwrap().get(dir).cloned())
        }
        async fn clear(
            &self,
            _io: &dyn crate::vault_io::VaultIo,
            dir: &Path,
        ) -> Result<(), TokenStoreError> {
            self.slots.lock().unwrap().remove(dir);
            Ok(())
        }
    }

    /// Drive an async body on a current-thread runtime. The `TokenStore` trait
    /// became async with task 86 (the storage seam is), so every test here is a
    /// one-line wrap rather than a rewrite — and each still drives the REAL
    /// `FileTokenStore` against a real temp dir.
    fn rt<F: std::future::Future>(f: F) -> F::Output {
        crate::test_support::block_on(f)
    }

    /// The seam the file store writes through.
    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    #[test]
    fn file_store_roundtrip_and_absent_default() {
        rt(async {
            let store = FileTokenStore;
            let dir = tmpdir("rt");
            assert_eq!(store.read(&IO, &dir).await.unwrap(), None);
            let token = vec![0xde, 0xad, 0xbe, 0xef];
            store.store(&IO, &dir, &token).await.unwrap();
            assert_eq!(store.read(&IO, &dir).await.unwrap(), Some(token));
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[cfg(unix)]
    #[test]
    fn file_store_is_0600() {
        rt(async {
            use std::os::unix::fs::PermissionsExt;
            let store = FileTokenStore;
            let dir = tmpdir("perm");
            store.store(&IO, &dir, &[0x01, 0x02]).await.unwrap();
            let mode = std::fs::metadata(token_path(&dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "fallback token file must be 0600");
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn file_clear_removes_token_idempotent() {
        rt(async {
            let store = FileTokenStore;
            let dir = tmpdir("clr");
            store.store(&IO, &dir, &[0xaa]).await.unwrap();
            store.clear(&IO, &dir).await.unwrap();
            assert_eq!(store.read(&IO, &dir).await.unwrap(), None);
            // Idempotent on absent.
            store.clear(&IO, &dir).await.unwrap();
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn default_store_is_file_backed() {
        rt(async {
            // The v1 resolver returns the file store for both clients (SYNC-34).
            let store = default_store();
            let dir = tmpdir("def");
            store.store(&IO, &dir, &[0x11, 0x22]).await.unwrap();
            // Observable via the file path (proves it is FileTokenStore, not a mock).
            assert!(token_path(&dir).exists());
            std::fs::remove_dir_all(&dir).ok();
        });
    }

    #[test]
    fn mock_store_roundtrip_and_isolation() {
        rt(async {
            let store = MockTokenStore::default();
            let a = PathBuf::from("/dev/a");
            let b = PathBuf::from("/dev/b");
            assert_eq!(store.read(&IO, &a).await.unwrap(), None);
            store.store(&IO, &a, &[1, 2, 3]).await.unwrap();
            assert_eq!(store.read(&IO, &a).await.unwrap(), Some(vec![1, 2, 3]));
            // Distinct dirs are isolated.
            assert_eq!(store.read(&IO, &b).await.unwrap(), None);
            store.clear(&IO, &a).await.unwrap();
            assert_eq!(store.read(&IO, &a).await.unwrap(), None);
        });
    }

    /// The session store writes NOTHING to the storage seam.
    ///
    /// This is task 37's first acceptance criterion — "token never persisted to
    /// OPFS or durable browser storage" — asserted rather than argued. It is
    /// driven through a `VaultIo` that PANICS on any call, so a future edit that
    /// quietly started persisting (a cache, a debug dump, a "just write it once
    /// for recovery") fails here instead of shipping a durable credential onto a
    /// machine the threat model says may not be the user's.
    #[test]
    fn the_session_store_never_touches_storage() {
        struct Forbidden;
        #[async_trait::async_trait]
        impl crate::vault_io::VaultIo for Forbidden {
            async fn read(&self, _: &Path) -> crate::vault_io::IoResult<Vec<u8>> {
                panic!("the session token store must not read storage")
            }
            async fn read_prefix(&self, _: &Path, _: usize) -> crate::vault_io::IoResult<Vec<u8>> {
                panic!("the session token store must not read storage")
            }
            async fn write(
                &self,
                _: &Path,
                _: &[u8],
                _: crate::vault_io::WriteOpts,
            ) -> crate::vault_io::IoResult<()> {
                panic!("the session token store must not WRITE storage")
            }
            async fn remove_file(&self, _: &Path) -> crate::vault_io::IoResult<()> {
                panic!("the session token store must not touch storage")
            }
            async fn remove_dir_all(&self, _: &Path) -> crate::vault_io::IoResult<()> {
                panic!("the session token store must not touch storage")
            }
            async fn create_dir_all(&self, _: &Path) -> crate::vault_io::IoResult<()> {
                panic!("the session token store must not touch storage")
            }
            async fn read_dir(
                &self,
                _: &Path,
            ) -> crate::vault_io::IoResult<Vec<crate::vault_io::DirEntry>> {
                panic!("the session token store must not touch storage")
            }
            async fn exists(&self, _: &Path) -> crate::vault_io::IoResult<bool> {
                panic!("the session token store must not touch storage")
            }
            async fn is_dir(&self, _: &Path) -> crate::vault_io::IoResult<bool> {
                panic!("the session token store must not touch storage")
            }
            async fn rename(&self, _: &Path, _: &Path) -> crate::vault_io::IoResult<()> {
                panic!("the session token store must not touch storage")
            }
        }

        rt(async {
            let store = SessionTokenStore;
            let dir = PathBuf::from("/session/vault-a");
            let other = PathBuf::from("/session/vault-b");
            assert_eq!(store.read(&Forbidden, &dir).await.unwrap(), None);
            store.store(&Forbidden, &dir, &[0xAA; 32]).await.unwrap();
            assert_eq!(
                store.read(&Forbidden, &dir).await.unwrap(),
                Some(vec![0xAA; 32])
            );
            // Two vaults cannot see each other's token — the isolation the file
            // store gets from the filesystem, kept here by the key.
            assert_eq!(store.read(&Forbidden, &other).await.unwrap(), None);
            store.clear(&Forbidden, &dir).await.unwrap();
            assert_eq!(store.read(&Forbidden, &dir).await.unwrap(), None);
        });
    }

    /// A pre-terminator token file reads as ABSENT, not as a token.
    ///
    /// Pins the migration as a decision rather than letting it be an accident:
    /// every device upgrading across this change reads `None` once and
    /// re-claims under the unlocked `root_key` (no user approval — the device is
    /// already approved), which costs one extra handshake on one cycle. Stated
    /// here so that a future "let's accept both forms" change has to argue with
    /// a test instead of quietly re-admitting the ambiguity the terminator
    /// removes.
    #[test]
    fn a_legacy_unterminated_token_file_reads_as_absent() {
        let dir = tmpdir("legacy-token");
        rt(async {
            use crate::vault_io::VaultIo as _;
            let legacy = "aa".repeat(32); // the old format: hex, no terminator
            crate::vault_io::StdVaultIo
                .write(
                    &token_path(&dir),
                    legacy.as_bytes(),
                    crate::vault_io::WriteOpts::default(),
                )
                .await
                .unwrap();
            assert_eq!(FileTokenStore.read(&IO, &dir).await.unwrap(), None);
        });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
