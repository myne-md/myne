// SPDX-License-Identifier: AGPL-3.0-only
//! Device-local update preferences: `<app_config_dir>/update-prefs.json`.
//!
//! One field today: whether this device checks for updates automatically. It is
//! **device-local, not a `vault.prefs` field**, because it describes this
//! installation's network behaviour rather than vault content, and it must be
//! readable before any vault is unlocked (the check runs at launch).
//!
//! Absent or unreadable resolves to the shipped default, `auto_check: true`: the
//! check is what carries security patches, so the safe direction is on. This is
//! the opposite of a privacy-preserving default only in appearance; what leaves
//! the device is a version and a platform to a no-log origin, recorded in
//! `docs/threat-model.md`, and the user turns it off here if that is their
//! choice.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The file name under `<app_config_dir>`. Sibling of `screen-capture.json`,
/// `tor-routing.json` and the rest of that device-local plaintext family.
pub const UPDATE_PREFS_FILE_NAME: &str = "update-prefs.json";

/// The device-local update preferences as persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatePrefs {
    /// Whether this device checks for a signed update automatically. `true` is
    /// the shipped default.
    #[serde(default = "default_auto_check")]
    pub auto_check: bool,
}

fn default_auto_check() -> bool {
    true
}

impl Default for UpdatePrefs {
    fn default() -> Self {
        Self { auto_check: true }
    }
}

/// Read the preferences from `path`. Absent or unparseable both answer the
/// default rather than failing: this is a convenience toggle, and a damaged file
/// must not stop the launcher (the check is on by default either way).
pub fn read(path: &Path) -> UpdatePrefs {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => UpdatePrefs::default(),
    }
}

/// Persist the preferences to `path`, atomically.
pub fn write(path: &Path, prefs: UpdatePrefs) -> std::io::Result<()> {
    // An encode failure returns an error rather than an empty buffer, so a
    // failure never truncates the previous file (which would silently reset the
    // toggle) and never writes a default over the user's real choice.
    let bytes = serde_json::to_vec_pretty(&prefs)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    crate::atomic_write::atomic_write(path, &bytes, true)
}

/// Resolve `<app_config_dir>/update-prefs.json` from a host that can supply the
/// config directory. The directory is created if needed.
pub fn update_prefs_path(config_dir: PathBuf) -> PathBuf {
    config_dir.join(UPDATE_PREFS_FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;

    fn scratch(name: &str) -> (ScopedTempDir, PathBuf) {
        let dir = ScopedTempDir::new(&format!("update-prefs-{name}")).expect("scratch");
        let path = dir.path().join(UPDATE_PREFS_FILE_NAME);
        (dir, path)
    }

    #[test]
    fn absent_reads_as_the_default_on() {
        let (_dir, path) = scratch("absent");
        assert_eq!(read(&path), UpdatePrefs { auto_check: true });
    }

    #[test]
    fn an_unparseable_file_reads_as_the_default_too() {
        let (_dir, path) = scratch("corrupt");
        std::fs::write(&path, b"{ not json").expect("seed");
        assert_eq!(read(&path), UpdatePrefs { auto_check: true });
    }

    #[test]
    fn a_written_pref_round_trips_both_ways() {
        let (_dir, path) = scratch("roundtrip");
        for auto_check in [true, false] {
            write(&path, UpdatePrefs { auto_check }).expect("write");
            assert_eq!(read(&path), UpdatePrefs { auto_check });
        }
    }
}
