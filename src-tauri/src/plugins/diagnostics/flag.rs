//! The device-local switch for the diagnostic log (myne-md/myne#860).
//!
//! One JSON file under `<app_config_dir>`, sibling of `tor-routing.json` and
//! `plain-file.json`, and the rule that it can only ever say whether **this
//! device** writes a diagnostic log.
//!
//! **Its own file, not a `vault.prefs` field, and that is forced rather than
//! stylistic.** The subscriber is installed once, at process start, and
//! `lib.rs` does that before any vault is unlocked. `vault.prefs` is an AEAD
//! blob whose read happens in `run_post_unlock_pipeline`, so a flag living
//! there cannot be read when the sink has to decide what to do. The
//! consequence of getting this wrong is not a slow path: the boot sequence,
//! the picker, the unlock, Argon2id and the migration would be unloggable even
//! with logging on, which is the window where a crash is least reproducible.
//! Same reasoning, and the same family, as `plain-file.json`'s own header.
//!
//! **Absent resolves to OFF, and that is the opposite direction from the
//! plain-file gate next door.** That gate guards a normal feature and answers
//! `true` when absent, because a device that never wrote the file has made no
//! choice. This one guards a persistent plaintext artefact, so a device that
//! never wrote the file has written no log, and "absent" and "off" are the
//! same state. Unreadable or malformed also resolves to off: writing plaintext
//! to disk on the strength of bytes nobody can parse is the direction this
//! file must never take.
//!
//! **Off is written, never deleted.** Turning the toggle off persists
//! `enabled: false` rather than removing the file, so the file's mere
//! existence carries no information about the choice. Deleting it on off would
//! make presence mean "on" and absence mean "off", which is one bit of at-rest
//! signal this feature has no reason to emit.
//!
//! Errors are closed, `Serialize`, and carry no `String` and no path: a path
//! in an error message is a disclosure (`src-tauri/AGENTS.md` DENY list).

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The file name under `<app_config_dir>`. Sibling of `tor-routing.json`.
const FILE_NAME: &str = "diagnostic-log.json";

/// The flag as persisted. One field, so a future second setting gets its own
/// file rather than a read-modify-write hazard here.
///
/// **`enabled` is required and carries no `serde(default)`**, and that is a
/// destruction guard rather than a schema preference: `logging::init` runs the
/// erase at boot when the file states `false`, so a document that states nothing
/// (`{}`, or a foreign object like `{"other": true}`) must read as `None` from
/// `read_flag_written` instead of as an explicit off. With the default in place
/// the boot path deleted the user's log files on evidence that said nothing
/// (myne#860 review).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticLogFlag {
    /// Whether this device writes a diagnostic log.
    pub enabled: bool,
}

/// Failure surface for writing the flag. Closed, so the UI switches on it
/// rather than reading prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail")]
pub enum DiagnosticLogFlagError {
    /// Filesystem error on `diagnostic-log.json` or on resolving its directory.
    #[error("filesystem error on the diagnostic-log flag")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
}

fn io(e: std::io::Error) -> DiagnosticLogFlagError {
    DiagnosticLogFlagError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    }
}

/// `<app_config_dir>/diagnostic-log.json`.
pub fn flag_path_in(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE_NAME)
}

/// Whether this device writes a diagnostic log.
///
/// Never errors. An absent file answers `false` (logging is opt-in), and so
/// does an unreadable or malformed one. See the module doc for why those are
/// the same answer here but differ next door in `plain_file::gate`.
pub fn read_flag(path: &Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<DiagnosticLogFlag>(&raw)
            .map(|flag| flag.enabled)
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// The flag's value as the FILE states it, or `None` when the file states
/// nothing.
///
/// Deliberately distinct from [`read_flag`], which collapses three states into
/// `false`. The erase pass at boot may only run on `Some(false)`: `None` means
/// absent, unreadable or malformed, and a read failure must never become a
/// destruction. `read_flag` stays the reader every other caller wants, because
/// for them "off", "unreadable" and "absent" really are one answer.
pub fn read_flag_written(path: &Path) -> Option<bool> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<DiagnosticLogFlag>(&raw)
        .ok()
        .map(|flag| flag.enabled)
}

/// Persist the flag.
///
/// Atomic write (temp file in the same directory, then rename) so a concurrent
/// reader never observes a half-written file: a reader that saw one would
/// answer `false`, which fails closed but is still a lie about a setting the
/// user just flipped.
pub fn write_flag(path: &Path, enabled: bool) -> Result<(), DiagnosticLogFlagError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    let body = serde_json::to_vec(&DiagnosticLogFlag { enabled }).map_err(|_| {
        DiagnosticLogFlagError::Io {
            io_error_kind: IoFailureKind::Other,
        }
    })?;
    // The canonical durable-write helper: temp, fsync, rename, and cleanup on
    // the failure path. This file is OURS (the app config dir), so the fixed
    // temp name is safe here; the user-owned destination case is the export
    // path, which uses the unclobbered variant.
    crate::atomic_write::atomic_write(path, &body, true).map_err(io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;

    #[test]
    fn absent_file_is_off() {
        // Logging is opt-in: a device that never wrote this file writes no log,
        // so absence and off are the same state.
        let dir = ScopedTempDir::new("diagnostic-log-flag-absent").expect("tempdir");
        assert!(!read_flag(&flag_path_in(dir.path())));
    }

    #[test]
    fn unreadable_path_fails_closed() {
        // A path that EXISTS but cannot be read as a file (here: a directory)
        // is corruption-class, not absence-class, and answers off like absence.
        let dir = ScopedTempDir::new("diagnostic-log-flag-unreadable").expect("tempdir");
        let path = flag_path_in(dir.path());
        std::fs::create_dir(&path).expect("seed directory where the file belongs");
        assert!(!read_flag(&path));
    }

    #[test]
    fn round_trips_both_values() {
        let dir = ScopedTempDir::new("diagnostic-log-flag-roundtrip").expect("tempdir");
        let path = flag_path_in(dir.path());

        write_flag(&path, true).expect("write true");
        assert!(read_flag(&path));

        write_flag(&path, false).expect("write false");
        assert!(!read_flag(&path));
    }

    #[test]
    fn the_written_value_distinguishes_absent_and_malformed_from_off() {
        // The one place the two readers must disagree: the boot erase runs on
        // `Some(false)` and on nothing else, so a read failure has to answer
        // `None` rather than `false` or it becomes a destruction (myne#860
        // review).
        let dir = ScopedTempDir::new("diagnostic-log-flag-written").expect("tempdir");
        let path = flag_path_in(dir.path());

        assert_eq!(
            read_flag_written(&path),
            None,
            "absent states nothing, so nothing may be erased on its account"
        );
        assert!(!read_flag(&path), "and the other reader still says off");

        std::fs::write(&path, b"{ not json").expect("seed malformed");
        assert_eq!(
            read_flag_written(&path),
            None,
            "malformed states nothing either"
        );
        assert!(!read_flag(&path));

        // A document that parses but STATES NOTHING is the same answer, and this
        // is the case `#[serde(default)]` used to turn into an explicit off: the
        // boot erase then ran on evidence that said nothing and deleted the
        // user's log files (myne#860 review).
        for silent in [&b"{}"[..], &br#"{"other": true}"#[..]] {
            std::fs::write(&path, silent).expect("seed silent document");
            assert_eq!(
                read_flag_written(&path),
                None,
                "a document that names no choice must read as None"
            );
            assert!(
                !read_flag(&path),
                "and the fail-closed reader still says off"
            );
        }

        write_flag(&path, false).expect("write off");
        assert_eq!(
            read_flag_written(&path),
            Some(false),
            "an explicit off is the one answer the erase may act on"
        );

        write_flag(&path, true).expect("write on");
        assert_eq!(read_flag_written(&path), Some(true));
    }

    #[test]
    fn turning_off_writes_the_value_rather_than_removing_the_file() {
        // Presence must not encode the CHOICE. It does carry one bit, and the
        // threat model states it rather than claiming it away: a file that
        // exists says the toggle was used at least once, which is what the
        // sibling screen-capture bullet records for the identically shaped
        // file (myne#860 review).
        let dir = ScopedTempDir::new("diagnostic-log-flag-off-persisted").expect("tempdir");
        let path = flag_path_in(dir.path());

        write_flag(&path, true).expect("write true");
        write_flag(&path, false).expect("write false");
        assert!(
            path.exists(),
            "off must persist a value, not delete the file"
        );
        assert!(!read_flag(&path));
    }

    #[test]
    fn malformed_file_fails_closed() {
        let dir = ScopedTempDir::new("diagnostic-log-flag-malformed").expect("tempdir");
        let path = flag_path_in(dir.path());
        std::fs::write(&path, b"{ not json").expect("seed malformed");
        assert!(!read_flag(&path));
    }

    #[test]
    fn a_foreign_json_object_fails_closed() {
        let dir = ScopedTempDir::new("diagnostic-log-flag-foreign").expect("tempdir");
        let path = flag_path_in(dir.path());
        std::fs::write(&path, br#"{"other": true}"#).expect("seed foreign");
        // The parse FAILS on the missing field, because `enabled` is required
        // rather than `#[serde(default)]`, and `read_flag` folds that error to
        // `false`. That is what keeps a document which names no choice away from
        // `read_flag_written`'s `Some(false)`, and so away from the boot erase.
        assert!(!read_flag(&path));
    }

    #[test]
    fn the_file_name_is_the_documented_sibling() {
        let dir = Path::new("/tmp/x");
        assert_eq!(flag_path_in(dir), Path::new("/tmp/x/diagnostic-log.json"));
    }

    #[test]
    fn write_leaves_no_temp_behind() {
        let dir = ScopedTempDir::new("diagnostic-log-flag-tempfile").expect("tempdir");
        let path = flag_path_in(dir.path());
        write_flag(&path, true).expect("write");
        assert!(!path.with_extension("json.tmp").exists());
    }
}
