//! Atomic file-write helper.
//!
//! Writes `bytes` to a temp file alongside `path`, fsync's it, then
//! renames atomically over the destination. A crash mid-write leaves
//! either the previous file (or no file) — never a half-written one.

use std::io::Write;
use std::path::Path;

/// Write `bytes` to `path` atomically (temp + fsync + rename).
///
/// Constraints / behavior:
/// - Parent directory must already exist (caller's responsibility —
///   `vault_dir` does this).
/// - Temp file lives at `<path>.tmp`; collisions across concurrent
///   writers to the same `path` are not handled (v0.1 has at most one
///   writer per vault path).
/// - `fsync` happens on the temp file before rename; the parent
///   directory itself is NOT fsync'd. On most filesystems the rename
///   metadata persists through the next sync — for v0.1 this is
///   sufficient. A future hardening pass can add a parent-dir fsync.
/// - On Unix, `rename` replaces an existing destination atomically.
///   On Windows, `std::fs::rename` calls `MoveFileW` without
///   `MOVEFILE_REPLACE_EXISTING` so it returns `AlreadyExists` if the
///   destination is present; in that case [`rename_replacing`] falls
///   back to `remove_file` + `rename`, which is not strict-atomic but
///   keeps the on-disk state consistent for v0.1's single-writer
///   `vault.meta` use case (see [`rename_replacing`] for the failure
///   modes considered).
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = tmp_path(path);

    // Open + write + fsync.
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        // f drops here, releasing the file handle so rename can proceed
        // on Windows.
    }

    rename_replacing(&tmp, path)?;
    Ok(())
}

/// Rename `src` over `dst`, replacing an existing `dst` if present.
///
/// Unix `rename(2)` already has replace-existing semantics. Windows'
/// default `std::fs::rename` does not — it surfaces `AlreadyExists`.
/// The Windows arm retries with `remove_file` + `rename`, which is
/// not strict-atomic. The failure modes during the retry window:
///
/// - `remove_file` fails: `dst` keeps its old contents (caller sees
///   an IO error and the previous `vault.meta` is untouched).
/// - Process crashes between `remove_file` and `rename`: `dst` is
///   missing and `<dst>.tmp` is the only persisted bytes. v0.1's
///   commit flow surfaces this as the next-launch "vault folder
///   missing" condition; the user can re-run vault creation.
/// - Both succeed: `dst` has the new bytes.
///
/// A future hardening pass can replace this with `windows-sys`'
/// `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`
/// for true atomic replace; deferred to keep the dependency surface
/// minimal in Phase 1.
#[cfg(unix)]
fn rename_replacing(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::rename(src, dst)
}

#[cfg(windows)]
fn rename_replacing(src: &Path, dst: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            std::fs::remove_file(dst)?;
            std::fs::rename(src, dst)
        }
        Err(e) => Err(e),
    }
}

fn tmp_path(path: &Path) -> std::path::PathBuf {
    let mut p = path.to_path_buf();
    let name = p.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    let mut tmp_name = name;
    tmp_name.push(".tmp");
    p.set_file_name(tmp_name);
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// A minimal scoped temp directory: creates a unique-named dir
    /// under `std::env::temp_dir()` and removes it on drop. Avoids
    /// pulling `tempfile` as a dev-dep just for these tests.
    struct ScopedTempDir {
        path: std::path::PathBuf,
    }
    impl ScopedTempDir {
        fn new(label: &str) -> std::io::Result<Self> {
            let mut p = std::env::temp_dir();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            p.push(format!("myne-test-{label}-{nanos}"));
            std::fs::create_dir_all(&p)?;
            Ok(Self { path: p })
        }
        fn path(&self) -> &Path {
            &self.path
        }
    }
    impl Drop for ScopedTempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn atomic_write_creates_file_with_expected_contents() {
        let dir = ScopedTempDir::new("write-creates").unwrap();
        let target = dir.path().join("file.bin");
        let payload = b"hello vault.meta";
        atomic_write(&target, payload).unwrap();

        let mut buf = Vec::new();
        std::fs::File::open(&target)
            .unwrap()
            .read_to_end(&mut buf)
            .unwrap();
        assert_eq!(buf.as_slice(), payload);
    }

    #[test]
    fn atomic_write_overwrites_existing_file() {
        let dir = ScopedTempDir::new("write-overwrites").unwrap();
        let target = dir.path().join("file.bin");
        std::fs::write(&target, b"old").unwrap();
        atomic_write(&target, b"new").unwrap();

        let mut buf = Vec::new();
        std::fs::File::open(&target)
            .unwrap()
            .read_to_end(&mut buf)
            .unwrap();
        assert_eq!(buf.as_slice(), b"new");
    }

    #[test]
    fn atomic_write_cleans_up_temp_on_success() {
        let dir = ScopedTempDir::new("write-cleans-tmp").unwrap();
        let target = dir.path().join("file.bin");
        atomic_write(&target, b"x").unwrap();

        // After successful write, only the target exists; the .tmp is
        // renamed away.
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(entries.len(), 1, "entries: {entries:?}");
        assert_eq!(entries[0], "file.bin");
    }
}
