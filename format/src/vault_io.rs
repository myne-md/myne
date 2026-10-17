// SPDX-License-Identifier: AGPL-3.0
//! The vault filesystem seam, host-free half.
//!
//! Moved out of `myne-core` so the `format/` crate can carry the `VaultIo`
//! trait without dragging the `StdVaultIo` implementation, which needs
//! `myne-core`'s `task::run_blocking` and `atomic_write`. The trait and its
//! supporting types live here; the native and wasm implementations stay in
//! their host crates.
//!
//! The export walk in this crate does NOT take `&dyn VaultIo` — it is the
//! native-only `std::fs` path a decrypter can run with no host (see
//! `export_walk`'s own header). What takes the trait is `myne-core`'s export
//! command, which stages through the seam and delegates the tree build here.
//!
//! # Why it is async, which is forced rather than chosen
//!
//! OPFS handle acquisition is asynchronous and a Worker cannot block its event
//! loop on a promise, so there is no synchronous implementation to write. The
//! `#[async_trait]` attribute is required because Rust 1.96's native
//! async-fn-in-trait is not `dyn`-compatible, and core holds `&dyn VaultIo`.

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
/// A deliberately tiny pair, added for the quarantine listing. Both fields
/// exist on both arms: `std::fs::Metadata` on native, and OPFS's
/// `FileSystemFileHandle.getFile()` → `File.size` / `File.lastModified` in a
/// browser.
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
/// today, because the wasm arm implements **none** of the temp-file mechanics
/// that distinguish them and would otherwise carry three identical bodies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteOpts {
    /// Overwrite an existing file. When `false`, a write to an existing path
    /// fails rather than replacing it.
    pub replace: bool,
    /// Create with owner-only permissions (`0600` on Unix).
    ///
    /// **A no-op on the wasm arm, correctly:** OPFS is origin-scoped, so there
    /// is no other principal on the origin to exclude.
    pub private: bool,
    /// Use a randomized temp-file name that never clobbers a pre-existing file.
    ///
    /// For writes to a **user-owned destination** (the export commands), where a
    /// fixed `<path>.tmp` could silently truncate a user's own file.
    pub unclobbered: bool,
}

impl Default for WriteOpts {
    /// The vault-internal default: replace, owner-only, fixed temp name.
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
/// sites rather than from a guess at what a filesystem is. The long tail of
/// `std::fs` collapses because most of it is one operation in different
/// clothes: `read_to_string` is [`read`](VaultIo::read) plus a UTF-8 decode, and
/// `metadata`/`symlink_metadata` are, at every production site, existence checks.
///
/// **Deliberately not here:** streaming reads. The eight `File::open` sites are
/// attachment reads that stream to avoid holding a large file in memory twice,
/// and `read() -> Vec<u8>` does not preserve that.
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
    async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>>;

    /// Write a whole file.
    ///
    /// On the native arm this carries `atomic_write`'s durability contract
    /// verbatim: temp file → `fsync` → platform rename → parent-directory sync,
    /// so a crash leaves either the previous file or no file, never a
    /// half-written one.
    async fn write(&self, path: &Path, bytes: &[u8], opts: WriteOpts) -> IoResult<()>;

    /// Every stored copy of a singleton file, **newest first**.
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
    /// which is also unordered. A caller that needs a stable order sorts.
    async fn read_dir(&self, path: &Path) -> IoResult<Vec<DirEntry>>;

    /// Whether a path exists.
    async fn exists(&self, path: &Path) -> IoResult<bool>;

    /// Whether a path exists **and is a directory**.
    async fn is_dir(&self, path: &Path) -> IoResult<bool>;

    /// Size + last-modified for one file, without reading it.
    ///
    /// Defaults to "unknown" rather than being required.
    async fn stat(&self, path: &Path) -> IoResult<Option<FileStat>> {
        let _ = path;
        Ok(None)
    }

    /// Move a file.
    async fn rename(&self, from: &Path, to: &Path) -> IoResult<()>;
}
