// SPDX-License-Identifier: AGPL-3.0
//! The vault filesystem seam (phase3-web-client task 17).
//!
//! # Why this exists
//!
//! `myne-core` reached the filesystem through `std::fs` directly, at **38
//! production files**. On `wasm32-unknown-unknown` those calls compile and then
//! fail at runtime — the same shape of trap as `tokio::task::spawn_blocking`
//! (task 80), and caught by nothing in either build. This is the third and last
//! of the three seams that make the crate host-independent:
//!
//! | Seam | Module | What it abstracts |
//! |---|---|---|
//! | [`crate::host`] | `host.rs` | app-data/config paths, event emission, the clock |
//! | [`crate::task`] | `task.rs` | blocking execution and timers |
//! | **[`VaultIo`]** | this module | the filesystem |
//!
//! # Why it is async, which is forced rather than chosen
//!
//! OPFS handle acquisition — `navigator.storage.getDirectory()`,
//! `getDirectoryHandle()`, `getFileHandle()`, `createSyncAccessHandle()` — is
//! **asynchronous**, and a Worker cannot block its event loop on a promise.
//! Reads and writes *through* an acquired handle are synchronous, but a handle
//! cannot be obtained synchronously and cannot be pre-acquired for note files
//! whose names are not yet known. So there is no synchronous implementation to
//! write; this is not a performance trade.
//!
//! The alternative — an in-memory VFS with an async flush behind it — is
//! excluded by a **recorded decision**, not by taste. `decisions.md` 2026-07-26
//! ("OPFS container layout diverges…") specifies double-buffered `.a`/`.b`
//! singletons where "on open, the newest copy that passes AEAD verification
//! wins". That scheme is about what is *durably on disk after a crash*, which a
//! cache reporting success before the bytes land makes meaningless.
//!
//! # Why `#[async_trait]` and not native `async fn` in trait
//!
//! Core holds this as `&dyn VaultIo`, exactly as it holds `&dyn HostCtx`, and
//! Rust 1.96's native async-fn-in-trait is not `dyn`-compatible. The `Send`
//! bound has to differ per target — native futures cross tokio's threads and
//! must be `Send`; wasm futures hold `JsValue` and cannot be — hence the
//! conditional attribute rather than one blanket one.
//!
//! # The DENY-list discipline travels with the errors
//!
//! Every method returns [`IoFailureKind`], never `std::io::Error`. That is not
//! ergonomics: `std::io::Error`'s `Display` includes the path on some kernels,
//! and this crate's errors reach the page (`src-tauri/CLAUDE.md`, secret-handling
//! logging discipline). The closed enum has no payload that could carry one.

use crate::io_failure_kind::IoFailureKind;
use std::path::Path;

/// `Result` with the seam's closed error type.
pub type IoResult<T> = Result<T, IoFailureKind>;

/// One entry from [`VaultIo::read_dir`].
///
/// Carries the **name**, not a full path. Two reasons: OPFS yields names from an
/// async iterator over a directory handle and has no path API at all, so a path
/// would have to be reassembled; and every caller already holds the parent it
/// passed in, so the reassembly is trivial and unambiguous on its side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    /// The entry's file name, with no directory component.
    pub name: String,
    /// `true` for a directory.
    ///
    /// OPFS distinguishes only files from directories — there are no symlinks,
    /// no devices, no sockets. That is a strictly smaller vocabulary than a real
    /// filesystem's, and the seam exposes the intersection so a caller cannot
    /// write logic that only works on one target.
    pub is_dir: bool,
}

/// What a caller can learn about a file WITHOUT reading it.
///
/// A deliberately tiny pair (phase3-web-client task 87), added for the
/// quarantine listing — the "Recovered notes" surface shows each entry's size
/// and age so a user can tell two copies of the same note apart. Both fields
/// exist on both arms: `std::fs::Metadata` on native, and OPFS's
/// `FileSystemFileHandle.getFile()` → `File.size` / `File.lastModified` in a
/// browser.
///
/// Kept OFF [`DirEntry`] on purpose. A directory listing is cheap on both arms;
/// stat is not — OPFS needs a handle acquisition per entry — so folding these
/// into `read_dir` would make every listing pay for metadata almost no caller
/// wants. Here the cost is at the call site, where it is visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStat {
    /// Size in bytes.
    pub size: u64,
    /// Last-modified time, epoch milliseconds. `None` when the platform will not
    /// say — treated as "unknown", never as "epoch".
    pub modified_epoch_ms: Option<u64>,
}

/// How a write should be performed.
///
/// One options struct rather than the three entry points `atomic_write` has
/// today ([`crate::atomic_write::atomic_write`], `_private`, `_unclobbered`),
/// because the wasm arm implements **none** of the temp-file mechanics that
/// distinguish them and would otherwise carry three identical bodies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteOpts {
    /// Overwrite an existing file. When `false`, a write to an existing path
    /// fails rather than replacing it.
    pub replace: bool,
    /// Create with owner-only permissions (`0600` on Unix).
    ///
    /// **A no-op on the wasm arm, correctly:** OPFS is origin-scoped, so there
    /// is no other principal on the origin to exclude. Recorded here rather than
    /// left as a silent difference.
    pub private: bool,
    /// Use a randomized temp-file name that never clobbers a pre-existing file.
    ///
    /// For writes to a **user-owned destination** (the export commands), where a
    /// fixed `<path>.tmp` could silently truncate a user's own file. Vault-
    /// internal writes leave this `false` — the fixed temp name is part of the
    /// recognized-artifact vocabulary there (`vault.meta.tmp` recovery
    /// detection). Also a no-op on the wasm arm, which has no temp file.
    pub unclobbered: bool,
}

impl Default for WriteOpts {
    /// The vault-internal default: replace, owner-only, fixed temp name.
    ///
    /// `replace: true` because that is what every vault-resident caller does —
    /// a blob is rewritten in place. `private: true` because a vault file is
    /// never meant to be readable by another local user.
    fn default() -> Self {
        Self {
            replace: true,
            private: true,
            unclobbered: false,
        }
    }
}

impl WriteOpts {
    /// A write to a user-chosen export destination: no clobbering, no `0600`.
    ///
    /// Not `private`: the file is the user's, at a path they picked, and forcing
    /// owner-only permissions on it would be this application deciding how the
    /// user's own files are shared.
    pub fn export() -> Self {
        Self {
            replace: true,
            private: false,
            unclobbered: true,
        }
    }

    /// Create-new semantics: fail if the path already exists.
    pub fn create_new() -> Self {
        Self {
            replace: false,
            ..Self::default()
        }
    }
}

/// The filesystem, as `myne-core` uses it.
///
/// Eight methods, derived from a measured survey of the crate's production call
/// sites rather than from a guess at what a filesystem is — see
/// `myne-agents/features/phase3-web-client/core-io-seam-design.md` §1. The long
/// tail of `std::fs` collapses because most of it is one operation in different
/// clothes: `read_to_string` is [`read`](VaultIo::read) plus a UTF-8 decode, and
/// `metadata`/`symlink_metadata` are, at every production site, existence checks.
///
/// **Deliberately not here:** streaming reads. The eight `File::open` sites are
/// attachment reads that stream to avoid holding a large file in memory twice,
/// and `read() -> Vec<u8>` does not preserve that. Attachments are tasks 18/44,
/// where a chunked API can be shaped by a real caller instead of guessed at now.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait VaultIo: Send + Sync {
    /// Read a whole file.
    async fn read(&self, path: &Path) -> IoResult<Vec<u8>>;

    /// Read at most `len` bytes from the start of a file.
    ///
    /// Returns fewer bytes than asked for at end-of-file; the caller checks the
    /// length rather than receiving an error, because "shorter than expected" is
    /// a normal answer for a truncated or foreign file.
    ///
    /// **Shaped by a real caller, as `core-io-seam-design.md` §5 said it should
    /// be.** That section deferred a chunked API until something needed one;
    /// `note_nonce::scan_on_disk_manifest` is it — the decryption-free staleness
    /// scan reads the first **47 bytes** of every `.myn` to extract its
    /// `content_nonce`. Through whole-file [`read`](VaultIo::read) a 400-note
    /// vault would pull every complete blob (up to 16 MiB each) to look at 47
    /// bytes, on the unlock path.
    ///
    /// Both arms do this natively: `File::read_exact` into a small buffer, and
    /// OPFS `handle.read(buf, { at: 0 })` — which is the primitive OPFS actually
    /// offers, so this is the *simpler* call there, not a workaround.
    ///
    /// Still not general streaming: no offset, no cursor. The attachment paths
    /// (tasks 18/44) are what would justify those, and they can extend this when
    /// they arrive.
    async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>>;

    /// Write a whole file.
    ///
    /// On the native arm this carries `atomic_write`'s durability contract
    /// verbatim: temp file → `fsync` → platform rename → parent-directory sync,
    /// so a crash leaves either the previous file or no file, never a
    /// half-written one.
    ///
    /// **The wasm arm cannot make that promise.** OPFS offers `flush()` and no
    /// crash-atomicity guarantee, and the Phase 0 spike measured Safari not
    /// implementing `move()` at all — so a rename-based port has no correct
    /// implementation on a browser this product ships to. That gap is what task
    /// 18's double-buffered `.a`/`.b` scheme closes, one layer above this seam.
    /// It is stated here so no caller reads "write returned Ok" as "durable on
    /// every target".
    async fn write(&self, path: &Path, bytes: &[u8], opts: WriteOpts) -> IoResult<()>;

    /// Every stored copy of a singleton file, **newest first** (task 18).
    ///
    /// The caller decrypts the first entry; if AEAD verification fails it tries
    /// the next, and reports corruption only when the list is exhausted. That
    /// loop is the crash recovery, and it lives at one helper
    /// ([`crate::singleton::open_newest`]) rather than at every reader.
    ///
    /// **The default implementation is the native arm and is exactly today's
    /// behaviour** — one copy, the file itself. Desktop and mobile keep the
    /// durability contract they already have (temp → fsync → rename → parent
    /// sync), where a torn file cannot exist, so "the candidates" is a
    /// one-element list and nothing about their behaviour changes.
    ///
    /// The OPFS arm overrides it because it *has* no such contract: browsers
    /// give `flush()` and no crash atomicity, and Safari implements no `move()`
    /// at all. There, one logical singleton is two alternating files carrying a
    /// generation, and this is where the newest-first ordering comes from
    /// (`decisions.md` 2026-07-26, "OPFS container layout diverges…").
    ///
    /// An empty list means the file does not exist; an `Err` means the store
    /// could not be consulted. Those are different answers and callers already
    /// distinguish them.
    async fn read_candidates(&self, path: &Path) -> IoResult<Vec<Vec<u8>>> {
        match self.read(path).await {
            Ok(bytes) => Ok(vec![bytes]),
            Err(IoFailureKind::NotFound) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    /// Remove one file. Absent is an error ([`IoFailureKind::NotFound`]), not
    /// success — callers that want idempotence say so at the call site, where
    /// the intent is visible.
    async fn remove_file(&self, path: &Path) -> IoResult<()>;

    /// Remove a directory and everything under it.
    async fn remove_dir_all(&self, path: &Path) -> IoResult<()>;

    /// Create a directory and any missing parents. Succeeds if it already exists.
    async fn create_dir_all(&self, path: &Path) -> IoResult<()>;

    /// List a directory's immediate children.
    ///
    /// Order is **unspecified** on both arms, matching `std::fs::read_dir`,
    /// which is also unordered. A caller that needs a stable order sorts —
    /// relying on the incidental order of one platform is how a test passes on
    /// macOS and fails in CI.
    async fn read_dir(&self, path: &Path) -> IoResult<Vec<DirEntry>>;

    /// Whether a path exists.
    ///
    /// Folds the production `metadata` / `symlink_metadata` sites, which are all
    /// existence checks. The symlink *distinction* those draw is deliberately
    /// not exposed: OPFS has no symlinks, so a caller written against it would
    /// silently mean something different per target. The two `secret_export`
    /// containment guards that genuinely need `canonicalize` +
    /// `symlink_metadata` stay host-only, behind the `tauri-ipc` gate, rather
    /// than being weakened into this seam.
    async fn exists(&self, path: &Path) -> IoResult<bool>;

    /// Whether a path exists **and is a directory**.
    ///
    /// Separate from [`Self::exists`] rather than folded into it, because the
    /// distinction is load-bearing in exactly one place and silently wrong
    /// everywhere it is missing: `note_create` and `note_delete` both carry a
    /// defensive canary for "`<vault>/notes` has been replaced by a regular
    /// file" (dev-tools manipulation, disk corruption, a cross-process race).
    /// `exists()` answers `true` for that file, so a canary built on it reports
    /// a healthy vault — the failure this one exists to catch.
    ///
    /// Added after `exists()` alone silently disarmed that canary and a desktop
    /// test caught it (task 13). Both arms can answer precisely: `Path::is_dir`
    /// natively, `getDirectoryHandle` on OPFS.
    async fn is_dir(&self, path: &Path) -> IoResult<bool>;

    /// Size + last-modified for one file, without reading it.
    ///
    /// Defaults to "unknown" rather than being required: the only caller is the
    /// quarantine listing, and a test double or a future backing store that
    /// cannot answer should degrade to a listing with no size and no age — a
    /// cosmetically poorer surface — instead of failing to list at all. The two
    /// real implementations both override it.
    async fn stat(&self, path: &Path) -> IoResult<Option<FileStat>> {
        let _ = path;
        Ok(None)
    }

    /// Move a file.
    ///
    /// **The wasm arm must not implement this with OPFS `move()`** — the Phase 0
    /// spike reproduced Safari throwing `TypeError` for it at both 400 and 3 000
    /// files. Copy-then-unlink is the portable shape, and its non-atomicity is
    /// exactly why task 18's double-buffer needs no rename at all.
    async fn rename(&self, from: &Path, to: &Path) -> IoResult<()>;
}

// ── native implementation ────────────────────────────────────────────────────
//
// Gated off wasm rather than feature-gated: `std::fs` on wasm32 is a stub whose
// every call fails at runtime, so compiling this arm there would produce exactly
// the silent breakage the seam exists to prevent.
#[cfg(not(target_arch = "wasm32"))]
pub mod std_io {
    use super::*;
    use crate::io_failure_kind::from_io_error_kind;

    /// [`VaultIo`] over `std::fs`, for the desktop and mobile hosts.
    ///
    /// Every method is a **one-line forward** to the code that was already
    /// there — in particular [`crate::atomic_write`] keeps owning the durability
    /// mechanics rather than having them reimplemented here. That is the same
    /// property `task.rs`'s tokio forward has, and for the same reason: it makes
    /// "no behaviour change on desktop" checkable by *reading* the code, not
    /// only by running the suite.
    #[derive(Debug, Default, Clone, Copy)]
    pub struct StdVaultIo;

    /// Run a blocking filesystem call off the async executor.
    ///
    /// Through [`crate::task::run_blocking`], not `tokio::task::spawn_blocking`
    /// directly — `scripts/check-core-task-seam.mjs` enforces that, and the
    /// reason it exists is this exact shape of call.
    async fn blocking<F, T>(f: F) -> IoResult<T>
    where
        F: FnOnce() -> std::io::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        match crate::task::run_blocking(f).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(e)) => Err(from_io_error_kind(e.kind())),
            // The blocking pool dropped the task (panic, or runtime shutdown).
            // Not a filesystem condition, so it collapses to `Other` rather than
            // inventing a kind — and it is genuinely rare enough that a distinct
            // variant would be a permanent cost for a diagnostic that never fires.
            Err(_) => Err(IoFailureKind::Other),
        }
    }

    #[async_trait::async_trait]
    impl VaultIo for StdVaultIo {
        async fn read(&self, path: &Path) -> IoResult<Vec<u8>> {
            let path = path.to_path_buf();
            blocking(move || std::fs::read(path)).await
        }

        async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>> {
            let path = path.to_path_buf();
            blocking(move || {
                use std::io::Read;
                let mut f = std::fs::File::open(path)?;
                let mut buf = vec![0u8; len];
                // `read` in a loop, NOT `read_exact`: a file shorter than `len`
                // must yield what it has, not an `UnexpectedEof` error. The loop
                // is because one `read` may return fewer bytes than requested
                // even mid-file.
                let mut filled = 0;
                while filled < len {
                    match f.read(&mut buf[filled..])? {
                        0 => break,
                        n => filled += n,
                    }
                }
                buf.truncate(filled);
                Ok(buf)
            })
            .await
        }

        async fn write(&self, path: &Path, bytes: &[u8], opts: WriteOpts) -> IoResult<()> {
            let path = path.to_path_buf();
            let bytes = bytes.to_vec();
            blocking(move || {
                if opts.unclobbered {
                    crate::atomic_write::atomic_write_unclobbered(&path, &bytes, opts.replace)
                } else if opts.private {
                    crate::atomic_write::atomic_write_private(&path, &bytes, opts.replace)
                } else {
                    crate::atomic_write::atomic_write(&path, &bytes, opts.replace)
                }
            })
            .await
        }

        async fn remove_file(&self, path: &Path) -> IoResult<()> {
            let path = path.to_path_buf();
            blocking(move || std::fs::remove_file(path)).await
        }

        async fn remove_dir_all(&self, path: &Path) -> IoResult<()> {
            let path = path.to_path_buf();
            blocking(move || std::fs::remove_dir_all(path)).await
        }

        async fn create_dir_all(&self, path: &Path) -> IoResult<()> {
            let path = path.to_path_buf();
            blocking(move || std::fs::create_dir_all(path)).await
        }

        async fn read_dir(&self, path: &Path) -> IoResult<Vec<DirEntry>> {
            let path = path.to_path_buf();
            blocking(move || {
                let mut out = Vec::new();
                for entry in std::fs::read_dir(path)? {
                    let entry = entry?;
                    out.push(DirEntry {
                        // Lossy on purpose. A non-UTF-8 name cannot be a Myne
                        // artefact (every name this crate writes is hex, a UUID,
                        // or a fixed ASCII literal), and the alternative —
                        // failing the whole listing — would make one stray file
                        // dropped in the vault directory by something else break
                        // an unlock.
                        name: entry.file_name().to_string_lossy().into_owned(),
                        is_dir: entry.file_type()?.is_dir(),
                    });
                }
                Ok(out)
            })
            .await
        }

        async fn stat(&self, path: &Path) -> IoResult<Option<FileStat>> {
            let p = path.to_path_buf();
            blocking(move || {
                let m = match std::fs::metadata(&p) {
                    Ok(m) => m,
                    // A file that vanished between the listing and the stat is
                    // "unknown", not an error: the caller is decorating a row it
                    // already has, and failing the whole listing over one racing
                    // entry would be the wrong trade.
                    Err(_) => return Ok(None),
                };
                let modified_epoch_ms = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64);
                Ok(Some(FileStat {
                    size: m.len(),
                    modified_epoch_ms,
                }))
            })
            .await
        }

        async fn exists(&self, path: &Path) -> IoResult<bool> {
            let path = path.to_path_buf();
            // `try_exists`, NOT `exists()`: the latter collapses "no" and "I
            // could not tell" (a permission error on a parent) into `false`,
            // which would report a vault as absent when it is merely
            // unreadable — and the recovery paths for those two are opposite.
            blocking(move || path.try_exists()).await
        }

        async fn is_dir(&self, path: &Path) -> IoResult<bool> {
            let path = path.to_path_buf();
            // `Path::is_dir()` swallows the reason (it is `metadata().is_ok_and(..)`),
            // which is correct here: the caller asks a yes/no question and an
            // unreadable path is not a directory it can use either way.
            blocking(move || Ok(path.is_dir())).await
        }

        async fn rename(&self, from: &Path, to: &Path) -> IoResult<()> {
            let from = from.to_path_buf();
            let to = to.to_path_buf();
            blocking(move || std::fs::rename(from, to)).await
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use std_io::StdVaultIo;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// Exercise the trait through `&dyn` rather than the concrete type.
    ///
    /// Deliberate: `dyn`-compatibility is a *requirement* of this seam (core
    /// holds `&dyn VaultIo` exactly as it holds `&dyn HostCtx`), and it is the
    /// property that would silently break if someone converted the trait to
    /// native `async fn`. Calling through the concrete type would still compile
    /// in that case.
    fn io() -> Box<dyn VaultIo> {
        Box::new(StdVaultIo)
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = ScopedTempDir::new("vault-io").unwrap();
        let path = dir.path().join("blob.bin");
        rt().block_on(async {
            let io = io();
            io.write(&path, b"hello", WriteOpts::default())
                .await
                .unwrap();
            assert_eq!(io.read(&path).await.unwrap(), b"hello");
        });
    }

    #[test]
    fn read_prefix_returns_only_the_prefix_and_tolerates_a_short_file() {
        let dir = ScopedTempDir::new("vault-io").unwrap();
        let path = dir.path().join("blob.bin");
        rt().block_on(async {
            let io = io();
            io.write(&path, b"0123456789", WriteOpts::default())
                .await
                .unwrap();
            assert_eq!(io.read_prefix(&path, 4).await.unwrap(), b"0123");
            // Asking for MORE than the file holds yields what there is — not an
            // error. `read_exact` would have failed here, which is why the
            // native arm loops on `read` instead.
            assert_eq!(io.read_prefix(&path, 100).await.unwrap(), b"0123456789");
            assert_eq!(io.read_prefix(&path, 0).await.unwrap(), b"");
        });
    }

    #[test]
    fn read_prefix_reports_a_missing_file_as_not_found() {
        let dir = ScopedTempDir::new("vault-io").unwrap();
        rt().block_on(async {
            assert_eq!(
                io().read_prefix(&dir.path().join("nope"), 8)
                    .await
                    .unwrap_err(),
                IoFailureKind::NotFound
            );
        });
    }

    #[test]
    fn a_missing_file_reads_as_not_found_not_as_empty() {
        // The failure this pins: a `read` that returned `Ok(vec![])` for an
        // absent file would make a missing `vault.meta` look like a zero-byte
        // one, and the caller would report corruption instead of absence.
        let dir = ScopedTempDir::new("vault-io").unwrap();
        rt().block_on(async {
            let err = io().read(&dir.path().join("nope")).await.unwrap_err();
            assert_eq!(err, IoFailureKind::NotFound);
        });
    }

    #[test]
    fn create_new_refuses_an_existing_path_and_default_replaces_it() {
        let dir = ScopedTempDir::new("vault-io").unwrap();
        let path = dir.path().join("once.bin");
        rt().block_on(async {
            let io = io();
            io.write(&path, b"first", WriteOpts::create_new())
                .await
                .unwrap();

            let err = io
                .write(&path, b"second", WriteOpts::create_new())
                .await
                .unwrap_err();
            assert_ne!(
                err,
                IoFailureKind::NotFound,
                "should fail on EXISTS, not absence"
            );
            assert_eq!(
                io.read(&path).await.unwrap(),
                b"first",
                "must not have been clobbered"
            );

            io.write(&path, b"second", WriteOpts::default())
                .await
                .unwrap();
            assert_eq!(io.read(&path).await.unwrap(), b"second");
        });
    }

    #[test]
    fn read_dir_reports_files_and_directories_by_name() {
        let dir = ScopedTempDir::new("vault-io").unwrap();
        rt().block_on(async {
            let io = io();
            io.create_dir_all(&dir.path().join("sub/deeper"))
                .await
                .unwrap();
            io.write(&dir.path().join("a.myn"), b"x", WriteOpts::default())
                .await
                .unwrap();

            let mut entries = io.read_dir(dir.path()).await.unwrap();
            // Sorted HERE, not relied upon: `read_dir` order is unspecified on
            // both arms, and a test that depended on it would pass on one
            // platform and fail on another.
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            assert_eq!(
                entries,
                vec![
                    DirEntry {
                        name: "a.myn".into(),
                        is_dir: false
                    },
                    DirEntry {
                        name: "sub".into(),
                        is_dir: true
                    },
                ]
            );
        });
    }

    #[test]
    fn exists_distinguishes_present_absent_and_directories() {
        let dir = ScopedTempDir::new("vault-io").unwrap();
        let file = dir.path().join("here.bin");
        rt().block_on(async {
            let io = io();
            assert!(!io.exists(&file).await.unwrap());
            io.write(&file, b"x", WriteOpts::default()).await.unwrap();
            assert!(io.exists(&file).await.unwrap());
            assert!(
                io.exists(dir.path()).await.unwrap(),
                "a directory exists too"
            );
        });
    }

    #[test]
    fn remove_file_reports_absence_rather_than_succeeding_quietly() {
        // Idempotence is the CALLER's choice, made visibly at its own site. A
        // seam that swallowed this would hide a genuine "the file I was about to
        // delete was already gone" — which, for a vault, is worth noticing.
        let dir = ScopedTempDir::new("vault-io").unwrap();
        rt().block_on(async {
            let err = io()
                .remove_file(&dir.path().join("ghost"))
                .await
                .unwrap_err();
            assert_eq!(err, IoFailureKind::NotFound);
        });
    }

    #[test]
    fn remove_dir_all_takes_the_subtree() {
        let dir = ScopedTempDir::new("vault-io").unwrap();
        let sub = dir.path().join("sub");
        rt().block_on(async {
            let io = io();
            io.create_dir_all(&sub.join("deeper")).await.unwrap();
            io.write(&sub.join("deeper/x.bin"), b"x", WriteOpts::default())
                .await
                .unwrap();
            io.remove_dir_all(&sub).await.unwrap();
            assert!(!io.exists(&sub).await.unwrap());
        });
    }

    #[test]
    fn is_dir_distinguishes_a_directory_from_a_file_and_from_absence() {
        // The regression this pins: `exists()` answers `true` for a FILE, so a
        // "is `<vault>/notes` still a directory?" canary built on it silently
        // never fires. A desktop test caught that; this keeps the seam honest.
        let dir = ScopedTempDir::new("vault-io").unwrap();
        let file = dir.path().join("a-file");
        rt().block_on(async {
            let io = io();
            io.write(&file, b"x", WriteOpts::default()).await.unwrap();
            assert!(
                io.is_dir(dir.path()).await.unwrap(),
                "a directory is a directory"
            );
            assert!(
                !io.is_dir(&file).await.unwrap(),
                "a FILE is not a directory"
            );
            assert!(
                !io.is_dir(&dir.path().join("nothing")).await.unwrap(),
                "an absent path is not a directory"
            );
            // …and `exists` deliberately does NOT make that distinction, which
            // is why both methods exist.
            assert!(io.exists(&file).await.unwrap());
        });
    }

    #[test]
    fn rename_moves_content_and_leaves_no_source() {
        let dir = ScopedTempDir::new("vault-io").unwrap();
        let (from, to) = (dir.path().join("a"), dir.path().join("b"));
        rt().block_on(async {
            let io = io();
            io.write(&from, b"payload", WriteOpts::default())
                .await
                .unwrap();
            io.rename(&from, &to).await.unwrap();
            assert_eq!(io.read(&to).await.unwrap(), b"payload");
            assert!(!io.exists(&from).await.unwrap());
        });
    }

    #[test]
    fn create_dir_all_is_idempotent() {
        let dir = ScopedTempDir::new("vault-io").unwrap();
        let deep = dir.path().join("a/b/c");
        rt().block_on(async {
            let io = io();
            io.create_dir_all(&deep).await.unwrap();
            io.create_dir_all(&deep).await.unwrap(); // must not error
            assert!(io.exists(&deep).await.unwrap());
        });
    }

    #[test]
    fn the_native_write_really_goes_through_atomic_write() {
        // The seam's claim is that the native arm delegates to `atomic_write`
        // VERBATIM, keeping desktop durability unchanged. The observable
        // signature of that path is the temp sibling it uses and cleans up: a
        // successful write leaves `<path>` and NOTHING else in the directory.
        // A naive `std::fs::write` would also pass that — so this additionally
        // pins the property a plain write does NOT have: the destination is
        // never observed truncated-then-filled, because it is renamed into
        // place. Checked here by the weaker but real invariant that no `.tmp`
        // residue survives, which `std::fs::write` cannot fail and
        // `atomic_write` could.
        let dir = ScopedTempDir::new("vault-io").unwrap();
        let path = dir.path().join("vault.meta");
        rt().block_on(async {
            let io = io();
            io.write(&path, b"meta", WriteOpts::default())
                .await
                .unwrap();
            let names: Vec<String> = io
                .read_dir(dir.path())
                .await
                .unwrap()
                .into_iter()
                .map(|e| e.name)
                .collect();
            assert_eq!(
                names,
                vec!["vault.meta".to_string()],
                "stray temp left behind"
            );
        });
    }
}
