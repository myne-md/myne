//! The device-local gate for the plain-file editor (myne-md/myne#788).
//!
//! One JSON file under `<app_config_dir>`, sibling of `tor-routing.json`, and
//! the rule that it can only ever say whether **this device** may open plain
//! files.
//!
//! **Its own file, not a `vault.prefs` field, and that is load-bearing rather
//! than stylistic.** The surface this gate guards must work with the vault
//! locked and on a device that has no vault at all, and `vault.prefs` is
//! unreadable in both states: it lives inside the encrypted prefs blob. The
//! grill session had assumed the existing `developer_mode` preference would do
//! this job; exploration found it is per-vault, so the gate is its own
//! device-local file, the same class as `tor-routing.json` and
//! `screen-capture.json`. See the feature's decisions entry.
//!
//! **Which way each failure falls: absent resolves to ENABLED, while
//! unreadable or malformed resolves to disabled.** The feature is ON by default
//! (amended 2026-10-01): a device that has never written this file has made no
//! choice, and the plain-file editor is a normal feature rather than a
//! Developer-options opt-in. A file that EXISTS but cannot be trusted is a
//! different state, though, and is read as off: opening plaintext on the
//! strength of bytes nobody can parse is the direction this file must never
//! take, so absence and corruption answer differently on purpose.
//!
//! Errors are closed, `Serialize`, and carry no `String` and no path: a path
//! in an error message is a disclosure (`src-tauri/AGENTS.md` DENY list).

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The file name under `<app_config_dir>`. Sibling of `tor-routing.json`.
const FILE_NAME: &str = "plain-file.json";

/// The gate as persisted. One field, so a future second setting gets its own
/// file rather than a read-modify-write hazard here.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlainFileGate {
    /// Whether the plain-file editor is enabled on this device.
    #[serde(default)]
    pub enabled: bool,
}

/// Failure surface for writing the gate. Closed, so the UI switches on it
/// rather than reading prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail")]
pub enum PlainFileGateError {
    /// Filesystem error on `plain-file.json` or on resolving its directory.
    #[error("filesystem error on the plain-file gate")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
}

fn io(e: std::io::Error) -> PlainFileGateError {
    PlainFileGateError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    }
}

/// `<app_config_dir>/plain-file.json`.
pub fn gate_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE_NAME)
}

/// Whether the plain-file editor is enabled on this device.
///
/// Never errors. An ABSENT file answers `true` (the feature is on by default);
/// an unreadable or malformed one answers `false`. The two are deliberately
/// different states: see the module doc.
pub fn read_gate(path: &Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<PlainFileGate>(&raw)
            .map(|gate| gate.enabled)
            .unwrap_or(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

/// Persist the gate.
///
/// Atomic write (temp file in the same directory, then rename) so a concurrent
/// reader never observes a half-written file: a reader that saw one would
/// answer `false`, which fails closed but is still a lie about a setting the
/// user just flipped.
pub fn write_gate(path: &Path, enabled: bool) -> Result<(), PlainFileGateError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    let body =
        serde_json::to_vec(&PlainFileGate { enabled }).map_err(|_| PlainFileGateError::Io {
            io_error_kind: IoFailureKind::Other,
        })?;
    // The canonical durable-write helper: temp, fsync, rename, and cleanup on
    // the failure path. This file is OURS (the app config dir), so the fixed
    // temp name is safe here; the user-owned destination case is the note path
    // in `handles.rs`.
    crate::atomic_write::atomic_write(path, &body, true).map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;

    #[test]
    fn absent_file_is_enabled() {
        // The feature is on by default: a device that never wrote this file has
        // made no choice, so absence answers enabled.
        let dir = ScopedTempDir::new("plain-file-gate-absent").expect("tempdir");
        assert!(read_gate(&gate_path_in(dir.path())));
    }

    #[test]
    fn unreadable_path_fails_closed() {
        // A path that EXISTS but cannot be read as a file (here: a directory)
        // is corruption-class, not absence-class, and answers disabled.
        let dir = ScopedTempDir::new("plain-file-gate-unreadable").expect("tempdir");
        let path = gate_path_in(dir.path());
        std::fs::create_dir(&path).expect("seed directory where the file belongs");
        assert!(!read_gate(&path));
    }

    #[test]
    fn round_trips_both_values() {
        let dir = ScopedTempDir::new("plain-file-gate-roundtrip").expect("tempdir");
        let path = gate_path_in(dir.path());

        write_gate(&path, true).expect("write true");
        assert!(read_gate(&path));

        write_gate(&path, false).expect("write false");
        assert!(!read_gate(&path));
    }

    #[test]
    fn malformed_file_fails_closed() {
        let dir = ScopedTempDir::new("plain-file-gate-malformed").expect("tempdir");
        let path = gate_path_in(dir.path());
        std::fs::write(&path, b"{ not json").expect("seed malformed");
        assert!(!read_gate(&path));
    }

    #[test]
    fn a_foreign_json_object_fails_closed() {
        let dir = ScopedTempDir::new("plain-file-gate-foreign").expect("tempdir");
        let path = gate_path_in(dir.path());
        std::fs::write(&path, br#"{"other": true}"#).expect("seed foreign");
        // `enabled` is `#[serde(default)]`, so a valid object without the key
        // reads as disabled rather than as an error.
        assert!(!read_gate(&path));
    }

    #[test]
    fn the_file_name_is_the_documented_sibling() {
        let dir = Path::new("/tmp/x");
        assert_eq!(gate_path_in(dir), Path::new("/tmp/x/plain-file.json"));
    }

    #[test]
    fn write_leaves_no_temp_behind() {
        let dir = ScopedTempDir::new("plain-file-gate-tempfile").expect("tempdir");
        let path = gate_path_in(dir.path());
        write_gate(&path, true).expect("write");
        assert!(!path.with_extension("json.tmp").exists());
    }
}
