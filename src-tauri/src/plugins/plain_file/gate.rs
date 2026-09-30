//! The device-local gate for the plain-file editor (myne-md/myne#788).
//!
//! One JSON file under `<app_config_dir>`, sibling of `tor-routing.json`, and
//! the rule that it can only ever say whether **this device** may open plain
//! files.
//!
//! **Its own file, not a `vault.prefs` field, and that is load-bearing rather
//! than stylistic.** The surface this gate guards must work with the vault
//! locked and on a device that has no vault at all, and `vault.prefs` is
//! unreadable in both states — it lives inside the encrypted prefs blob. The
//! grill session had assumed the existing `developer_mode` preference would do
//! this job; exploration found it is per-vault, so the gate is its own
//! device-local file, the same class as `tor-routing.json` and
//! `screen-capture.json`. See the feature's decisions entry.
//!
//! **Which way each failure falls: absent, unreadable or malformed all resolve
//! to disabled.** Failing open would open plaintext on a device whose config
//! failed to parse, which is the direction this file must never take.
//!
//! Errors are closed, `Serialize`, and carry no `String` and no path — a path
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
/// Never errors: absent, unreadable and malformed all answer `false`, which is
/// the fail-closed direction the module doc states.
pub fn read_gate(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<PlainFileGate>(&raw)
        .map(|gate| gate.enabled)
        .unwrap_or(false)
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
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(io)?;
    std::fs::rename(&tmp, path).map_err(io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;

    #[test]
    fn absent_file_is_disabled() {
        let dir = ScopedTempDir::new("plain-file-gate-absent").expect("tempdir");
        assert!(!read_gate(&gate_path_in(dir.path())));
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
