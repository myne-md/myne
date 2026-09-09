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
    // iCloud Drive (macOS): the CloudDocs marker covers iCloud Drive itself.
    // ~/Documents and ~/Desktop (the "Desktop & Documents Folders" default)
    // carry no marker and are matched home-relative in `detect_cloud_root`.
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
/// clearance: the unconditional closing line is the guarantee.
pub fn detect_cloud_root(path: &Path) -> Option<&'static str> {
    let s = path.to_string_lossy();
    if let Some(hit) = CLOUD_ROOTS
        .iter()
        .find(|r| s.contains(r.marker))
        .map(|r| r.name)
    {
        return Some(hit);
    }
    // macOS "Desktop & Documents Folders" iCloud sync is on by default for
    // many users, so ~/Documents and ~/Desktop upload by default, yet neither
    // path contains the CloudDocs marker above. Match them home-relative.
    // Other platforms have no default-on folder sync in this tool's scope, so
    // the marker list is the whole check there.
    #[cfg(target_os = "macos")]
    if under_macos_default_sync(path) {
        return Some("iCloud Drive");
    }
    None
}

/// macOS only: true when `path` sits under ~/Documents or ~/Desktop, the two
/// folders "Desktop & Documents Folders" iCloud sync uploads by default.
#[cfg(target_os = "macos")]
fn under_macos_default_sync(path: &Path) -> bool {
    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };
    let home = Path::new(&home);
    path.starts_with(home.join("Documents")) || path.starts_with(home.join("Desktop"))
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
/// Called by `main.rs` after a successful export; unit-tested below.
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

    // macOS only: ~/Documents and ~/Desktop upload by default under
    // "Desktop & Documents Folders" sync, with no CloudDocs marker in the
    // path. Runs only on macOS because the check itself is macOS-gated.
    #[test]
    #[cfg(target_os = "macos")]
    fn detects_macos_default_sync_folders_home_relative() {
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", "/Users/x");
        let documents = detect_cloud_root(Path::new("/Users/x/Documents/export"));
        let desktop = detect_cloud_root(Path::new("/Users/x/Desktop/export"));
        let plain = detect_cloud_root(Path::new("/Users/x/notes-export"));
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        assert_eq!(documents, Some("iCloud Drive"));
        assert_eq!(desktop, Some("iCloud Drive"));
        assert_eq!(plain, None);
    }

    #[test]
    fn closing_line_names_the_directory() {
        let line = closing_line(Path::new("/tmp/out"));
        assert!(line.contains("/tmp/out"));
    }
}
