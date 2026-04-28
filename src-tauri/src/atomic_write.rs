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

    std::fs::rename(&tmp, path)?;
    Ok(())
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
