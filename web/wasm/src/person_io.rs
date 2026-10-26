// SPDX-License-Identifier: AGPL-3.0
//! The person credential, held in the Worker's memory for the session
//! (myne-md/myne#911 task 13).
//!
//! # Why this exists rather than a core change
//!
//! The web client's person plane needs two files: the sealed keypair
//! (`<app_config_dir>/person_keypair.sealed`) and the credential
//! (`<app_config_dir>/person-auth.json`, holding the device token). On every
//! other client both sit on disk, which is what lets a reload find the identity
//! where it left it.
//!
//! A browser must not do that. An origin's storage is readable by any script on
//! that origin, and a phrase-derived keypair at rest there is an **offline
//! cracking target** (Argon2id + the phrase) that no password change rotates:
//! exactly the asset `threat-model.md` A15/TB11 says a served bundle already
//! endangers, and the one A18 is about. So the two files live in this Worker's
//! memory for the session and nowhere else. A reload starts with an empty map,
//! the identity is re-derived from the phrase, and the phrase step's caveat says
//! so (`personCredentialPersisted` is absent on this client, which is what the
//! copy keys on).
//!
//! # Why it is a `VaultIo` wrapper and not a flag in `myne-core`
//!
//! `myne-core` has no business knowing which host it runs on: its own seam
//! documentation says so ("doing so would encode a 'web is special' assumption
//! into a seam whose whole value is that callers cannot tell which host they are
//! on"). The seam's job is to let the host decide where bytes go, and that is all
//! this does: the person files land in RAM instead of OPFS, and every other path
//! is forwarded untouched.
//!
//! **The interception is by FILE NAME**, deliberately. A directory-level rule
//! would swallow `sync-config.json` and `legal-consent.json`, which share
//! `<app_config_dir>` and MUST persist: a web user who configured a server and
//! accepted the terms must not lose both on reload.
//!
//! # What is not covered, stated rather than implied
//!
//! The map is per Worker and lives until the page goes away. A reload, a tab
//! close, or a Worker death loses it, and the phrase is the only way back. That
//! is the trade the feature chose over storing a cracking target.

use myne_core::io_failure_kind::IoFailureKind;
use myne_core::vault_io::{DirEntry, FileStat, IoResult, VaultIo, WriteOpts};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

thread_local! {
    /// The session's person files, keyed by the full path string the core hands
    /// in (so two vaults' worth of paths could never collide, though both person
    /// files are app-config-scoped and there is only one of each).
    static PERSON_FILES: RefCell<HashMap<String, Vec<u8>>> = RefCell::new(HashMap::new());
}

/// The two files that live in memory. **A file-name allowlist**, so a new
/// app-config file persists by default and only a deliberate addition becomes
/// volatile. `person-auth.json` holds the device token; `person_keypair.sealed`
/// holds the phrase-sealed keypair.
const VOLATILE_FILES: &[&str] = &["person-auth.json", "person_keypair.sealed"];

/// The map key for `path`, or `None` when this path persists normally.
fn volatile_key(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    VOLATILE_FILES
        .contains(&name)
        .then(|| path.to_string_lossy().into_owned())
}

/// A [`VaultIo`] that keeps the person credential in memory and forwards
/// everything else to `inner`.
pub struct SessionPersonIo<'a> {
    inner: &'a dyn VaultIo,
}

impl<'a> SessionPersonIo<'a> {
    #[must_use]
    pub fn new(inner: &'a dyn VaultIo) -> Self {
        Self { inner }
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
impl VaultIo for SessionPersonIo<'_> {
    async fn read(&self, path: &Path) -> IoResult<Vec<u8>> {
        if let Some(key) = volatile_key(path) {
            return PERSON_FILES.with(|files| match files.borrow().get(&key) {
                Some(bytes) => Ok(bytes.clone()),
                None => Err(IoFailureKind::NotFound),
            });
        }
        self.inner.read(path).await
    }

    async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>> {
        if let Some(key) = volatile_key(path) {
            return PERSON_FILES.with(|files| match files.borrow().get(&key) {
                Some(bytes) => Ok(bytes[..bytes.len().min(len)].to_vec()),
                None => Err(IoFailureKind::NotFound),
            });
        }
        self.inner.read_prefix(path, len).await
    }

    async fn write(&self, path: &Path, bytes: &[u8], opts: WriteOpts) -> IoResult<()> {
        if let Some(key) = volatile_key(path) {
            // `opts` is dropped: it carries the durability contract (create-new,
            // fsync, rename), and none of it means anything for a `HashMap`
            // write. There is no crash to survive and nothing to make durable.
            let _ = opts;
            PERSON_FILES.with(|files| {
                files.borrow_mut().insert(key, bytes.to_vec());
            });
            return Ok(());
        }
        self.inner.write(path, bytes, opts).await
    }

    async fn read_candidates(&self, path: &Path) -> IoResult<Vec<Vec<u8>>> {
        if volatile_key(path).is_some() {
            // The same shape the trait's default gives: zero candidates for an
            // absent file, one for a present one, and never an error for absent.
            return match self.read(path).await {
                Ok(bytes) => Ok(vec![bytes]),
                Err(IoFailureKind::NotFound) => Ok(Vec::new()),
                Err(e) => Err(e),
            };
        }
        self.inner.read_candidates(path).await
    }

    async fn remove_file(&self, path: &Path) -> IoResult<()> {
        if let Some(key) = volatile_key(path) {
            PERSON_FILES.with(|files| {
                files.borrow_mut().remove(&key);
            });
            return Ok(());
        }
        self.inner.remove_file(path).await
    }

    async fn remove_dir_all(&self, path: &Path) -> IoResult<()> {
        self.inner.remove_dir_all(path).await
    }

    async fn create_dir_all(&self, path: &Path) -> IoResult<()> {
        // Forwarded, and that is correct even for a volatile file's directory:
        // the directory itself is shared with the files that DO persist
        // (`sync-config.json`), so creating it is a real operation.
        self.inner.create_dir_all(path).await
    }

    async fn read_dir(&self, path: &Path) -> IoResult<Vec<DirEntry>> {
        // No volatile entry ever creates a directory, so a listing never has one
        // to hide. Stated here rather than left to be discovered: if a future
        // volatile path needed its own directory, this is the method that would
        // have to filter it out.
        self.inner.read_dir(path).await
    }

    async fn exists(&self, path: &Path) -> IoResult<bool> {
        if let Some(key) = volatile_key(path) {
            return Ok(PERSON_FILES.with(|files| files.borrow().contains_key(&key)));
        }
        self.inner.exists(path).await
    }

    async fn is_dir(&self, path: &Path) -> IoResult<bool> {
        self.inner.is_dir(path).await
    }

    async fn stat(&self, path: &Path) -> IoResult<Option<FileStat>> {
        if let Some(key) = volatile_key(path) {
            return Ok(PERSON_FILES.with(|files| {
                files.borrow().get(&key).map(|bytes| FileStat {
                    size: bytes.len() as u64,
                    // A `HashMap` entry has no modification time, and the seam
                    // says `None` means "the platform will not say" rather than
                    // the epoch. That is the honest answer here.
                    modified_epoch_ms: None,
                })
            }));
        }
        self.inner.stat(path).await
    }

    async fn rename(&self, from: &Path, to: &Path) -> IoResult<()> {
        // A volatile-to-volatile rename (nothing does this today) is handled so
        // the pair cannot half-move; anything else forwards, and a rename that
        // CROSSES the boundary is refused rather than silently turning a
        // memory-only file into a persisted one, which is the whole promise this
        // module makes.
        match (volatile_key(from), volatile_key(to)) {
            (Some(from_key), Some(to_key)) => PERSON_FILES.with(|files| {
                let mut files = files.borrow_mut();
                let Some(bytes) = files.remove(&from_key) else {
                    return Err(IoFailureKind::NotFound);
                };
                files.insert(to_key, bytes);
                Ok(())
            }),
            (None, None) => self.inner.rename(from, to).await,
            _ => Err(IoFailureKind::Other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for the OPFS io that records what actually reached "disk".
    #[derive(Default)]
    struct RecordingIo {
        written: std::sync::Mutex<Vec<(String, Vec<u8>)>>,
    }

    impl RecordingIo {
        fn written(&self) -> Vec<(String, Vec<u8>)> {
            self.written.lock().expect("test mutex").clone()
        }
    }

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl VaultIo for RecordingIo {
        async fn read(&self, _path: &Path) -> IoResult<Vec<u8>> {
            Err(IoFailureKind::NotFound)
        }
        async fn read_prefix(&self, _path: &Path, _len: usize) -> IoResult<Vec<u8>> {
            Err(IoFailureKind::NotFound)
        }
        async fn write(&self, path: &Path, bytes: &[u8], _opts: WriteOpts) -> IoResult<()> {
            self.written
                .lock()
                .expect("test mutex")
                .push((path.to_string_lossy().into_owned(), bytes.to_vec()));
            Ok(())
        }
        async fn remove_file(&self, _path: &Path) -> IoResult<()> {
            Ok(())
        }
        async fn remove_dir_all(&self, _path: &Path) -> IoResult<()> {
            Ok(())
        }
        async fn create_dir_all(&self, _path: &Path) -> IoResult<()> {
            Ok(())
        }
        async fn read_dir(&self, _path: &Path) -> IoResult<Vec<DirEntry>> {
            Ok(Vec::new())
        }
        async fn exists(&self, _path: &Path) -> IoResult<bool> {
            Ok(false)
        }
        async fn is_dir(&self, _path: &Path) -> IoResult<bool> {
            Ok(false)
        }
        async fn rename(&self, _from: &Path, _to: &Path) -> IoResult<()> {
            Ok(())
        }
    }

    /// The whole point, in one assertion: the person credential never reaches
    /// the store, and it is readable back within the same session.
    #[test]
    fn the_person_credential_never_reaches_the_store() {
        let inner = RecordingIo::default();
        let io = SessionPersonIo::new(&inner);
        let path = Path::new("/myne-config/person-auth.json");

        block_on(async {
            io.write(path, b"{\"token_hex\":\"aa\"}", WriteOpts::default())
                .await
                .expect("volatile write");
            let back = io.read(path).await.expect("volatile read");
            assert_eq!(back, b"{\"token_hex\":\"aa\"}");
            assert!(io.exists(path).await.expect("exists"));
            assert!(
                inner.written().is_empty(),
                "the person credential must not reach the store"
            );
        });
    }

    /// …and everything else still persists, which is the half a prefix rule
    /// would have broken: `sync-config.json` shares the directory.
    #[test]
    fn every_other_file_still_reaches_the_store() {
        let inner = RecordingIo::default();
        let io = SessionPersonIo::new(&inner);
        block_on(async {
            io.write(
                Path::new("/myne-config/sync-config.json"),
                b"{}",
                WriteOpts::default(),
            )
            .await
            .expect("persisted write");
            io.write(
                Path::new("/myne/vaults/x/vault.prefs"),
                b"prefs",
                WriteOpts::default(),
            )
            .await
            .expect("persisted write");
        });
        let written = inner.written();
        assert_eq!(written.len(), 2);
        assert_eq!(written[0].0, "/myne-config/sync-config.json");
        assert_eq!(written[1].0, "/myne/vaults/x/vault.prefs");
    }

    /// The sealed keypair is the second volatile file, and it is volatile for
    /// the same reason: it is phrase-derived.
    #[test]
    fn the_sealed_keypair_is_volatile_too() {
        let inner = RecordingIo::default();
        let io = SessionPersonIo::new(&inner);
        block_on(async {
            io.write(
                Path::new("/myne-config/person_keypair.sealed"),
                b"sealed",
                WriteOpts::default(),
            )
            .await
            .expect("volatile write");
        });
        assert!(inner.written().is_empty());
    }

    /// A rename that would turn a memory-only file into a persisted one is
    /// refused rather than allowed to leak it.
    #[test]
    fn a_rename_across_the_boundary_is_refused() {
        let inner = RecordingIo::default();
        let io = SessionPersonIo::new(&inner);
        block_on(async {
            io.write(
                Path::new("/myne-config/person-auth.json"),
                b"x",
                WriteOpts::default(),
            )
            .await
            .expect("volatile write");
            let moved = io
                .rename(
                    Path::new("/myne-config/person-auth.json"),
                    Path::new("/myne-config/person-auth.backup.json"),
                )
                .await;
            assert!(moved.is_err(), "a boundary-crossing rename must be refused");
            assert!(inner.written().is_empty());
        });
    }

    /// A minimal executor, so the tests above read as straight-line code. The
    /// futures here never yield, so polling once is enough.
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, Waker};
        let mut future = Box::pin(future);
        let waker = Waker::noop();
        let mut cx = Context::from_waker(waker);
        loop {
            match future.as_mut().poll(&mut cx) {
                Poll::Ready(value) => return value,
                Poll::Pending => continue,
            }
        }
    }
}
