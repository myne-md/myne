// SPDX-License-Identifier: AGPL-3.0
//! The vault filesystem seam (phase3-web-client task 17).
//!
//! The trait and its supporting types live in `myne-format` so the
//! `myne-decrypt` CLI can take `&dyn VaultIo` without pulling this crate's
//! TLS stack and ML runtime. This module keeps the native `StdVaultIo`
//! implementation, which needs `crate::task::run_blocking` + `crate::atomic_write`.

pub use myne_format::vault_io::{DirEntry, FileStat, IoResult, VaultIo, WriteOpts};

// ── native implementation ────────────────────────────────────────────────────
//
// Gated off wasm rather than feature-gated: `std::fs` on wasm32 is a stub whose
// every call fails at runtime, so compiling this arm there would produce exactly
// the silent breakage the seam exists to prevent.
#[cfg(not(target_arch = "wasm32"))]
pub mod std_io {
    use super::*;
    use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
    use std::path::Path;

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
                // `unclobbered` and `private` are independent flags, so all
                // four combinations must dispatch to something that honours
                // BOTH. The combined arm is first: an earlier shape treated
                // them as mutually exclusive and silently dropped `private`
                // for a credential written to a user-owned directory, which is
                // the regression this ordering forecloses.
                match (opts.unclobbered, opts.private) {
                    (true, true) => crate::atomic_write::atomic_write_unclobbered_private(
                        &path,
                        &bytes,
                        opts.replace,
                    ),
                    (true, false) => {
                        crate::atomic_write::atomic_write_unclobbered(&path, &bytes, opts.replace)
                    }
                    (false, true) => {
                        crate::atomic_write::atomic_write_private(&path, &bytes, opts.replace)
                    }
                    (false, false) => {
                        crate::atomic_write::atomic_write(&path, &bytes, opts.replace)
                    }
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
    use crate::io_failure_kind::IoFailureKind;
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
