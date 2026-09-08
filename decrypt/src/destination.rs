// SPDX-License-Identifier: AGPL-3.0
//! Plaintext destination care for `myne-decrypt`.
//!
//! The export writes plaintext to a user-chosen directory, which is the
//! deliberate TB3 egress the app's own export performs. This module is the
//! desktop analogue of `scripts/check-mobile-export-backup.mjs`: on macOS,
//! "Desktop & Documents Folders" iCloud sync is on by default for many users,
//! so `--out ~/Documents/export` uploads the whole note corpus to Apple.
//!
//! Two layers, and the first is the guarantee:
//! 1. An **unconditional** closing line naming the plaintext directory, on
//!    every run. Detection is a bonus, so a missed provider never reads as a
//!    clearance.
//! 2. A **named-provider warning** plus a `--yes` confirmation when the output
//!    directory is under a known cloud-synced root.
//!
//! The output directory is created `0700` so other local accounts cannot read
//! the plaintext by default.

use std::path::{Path, PathBuf};

/// A known cloud-sync root, by provider name and the path prefix that marks it.
struct CloudRoot {
    name: &'static str,
    /// A path component that, when present in the output path, marks it as
    /// under this provider's sync root.
    marker: &'static str,
}

/// The known cloud-sync roots. Deliberately a small, conservative list: a
/// false positive blocks the export at the worst possible moment for this
/// tool, so only the well-known default-sync locations are named.
const CLOUD_ROOTS: &[CloudRoot] = &[
    // iCloud Drive (macOS): "Desktop & Documents Folders" sync is on by
    // default for many users, so ~/Documents and ~/Desktop upload by default.
    CloudRoot {
        name: "iCloud Drive",
        marker: "Mobile Documents/com~apple~CloudDocs",
    },
    CloudRoot {
        name: "Dropbox",
        marker: "Dropbox",
    },
    CloudRoot {
        name: "Google Drive",
        marker: "Google Drive",
    },
    CloudRoot {
        name: "OneDrive",
        marker: "OneDrive",
    },
];

/// Detect whether `path` is under a known cloud-sync root, returning the
/// provider name. `None` means "not detected", which is deliberately NOT a
/// clearance — the unconditional closing line is the guarantee.
pub fn detect_cloud_root(path: &Path) -> Option<&'static str> {
    let s = path.to_string_lossy();
    CLOUD_ROOTS
        .iter()
        .find(|r| s.contains(r.marker))
        .map(|r| r.name)
}

/// Create the output directory with `0700` permissions (owner-only), creating
/// any missing parents. On Unix this is `std::fs::DirBuilder` with mode `0o700`;
/// on platforms without file modes it degrades to a plain create.
pub fn create_output_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path)
    }
}

/// The unconditional closing line, printed on every run. It names the plaintext
/// directory so the user is always told where their plaintext now lives.
///
/// Wired into the export path in task 7; until then it is constructed and
/// tested but has no caller.
#[allow(dead_code)]
pub fn closing_line(out_dir: &Path) -> String {
    format!("Exported plaintext to: {}", out_dir.to_string_lossy())
}

/// Resolve the output directory to an absolute path for the closing line and
/// the cloud-root probe (a relative path would make both ambiguous).
pub fn absolutize(path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p
    } else {
        std::env::current_dir().map(|cwd| cwd.join(&p)).unwrap_or(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_icloud_drive() {
        let p = Path::new("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Documents/out");
        assert_eq!(detect_cloud_root(p), Some("iCloud Drive"));
    }

    #[test]
    fn detects_dropbox() {
        let p = Path::new("/Users/x/Dropbox/out");
        assert_eq!(detect_cloud_root(p), Some("Dropbox"));
    }

    #[test]
    fn a_plain_directory_is_not_detected() {
        let p = Path::new("/Users/x/notes-export");
        assert_eq!(detect_cloud_root(p), None);
    }

    #[test]
    fn closing_line_names_the_directory() {
        let line = closing_line(Path::new("/tmp/out"));
        assert!(line.contains("/tmp/out"));
    }
}
