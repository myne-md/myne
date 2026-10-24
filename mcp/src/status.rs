// SPDX-License-Identifier: AGPL-3.0
//! The door's status marker, as this binary reads it.
//!
//! `cli-status` lives beside the command socket in the app-data dir and carries
//! ONE ASCII byte naming the door's state: `D` (external access off), `L` (the
//! vault is locked), `O` (open). The desktop's lifecycle supervisor writes it on
//! every tick where that state changed (`src-tauri/src/cli_bridge/status.rs`).
//!
//! ## Why this is a copy rather than a shared crate
//!
//! The same reason `cli/src/status.rs` is one: this is a wire *contract*, not
//! shared Rust code, and `myne-mcp` deliberately depends on neither
//! `myne-desktop` nor `myne-core` (`mcp/Cargo.toml` says why). The copies are
//! held together by `scripts/check-cli-sidecar.mjs`, which reads this file too:
//! a state letter renamed on either side would decode to `None` here and read
//! as "the app is not running" while the app is running.
//!
//! ## Why the marker has to exist at all
//!
//! The command socket exists ONLY while the door is open, so a bare failed
//! connect cannot distinguish "the vault is locked" from "external access is
//! off". The marker is what splits those two, and an ABSENT marker is the third
//! state ("the app is not running"). It is advisory, never a boundary: the
//! access gate is the socket's own existence, and a stale marker after a crash
//! can at worst name the wrong one of two closed states.

use std::path::{Path, PathBuf};

/// The basename of the status marker inside the app-data dir. Matches
/// `src-tauri/src/cli_bridge/status.rs::STATUS_BASENAME` exactly.
pub const STATUS_BASENAME: &str = "cli-status";

/// The door's classified state, decoded from one ASCII byte. Mirrors
/// `cli_bridge::gate::DoorState` and `cli/src/status.rs::DoorState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoorState {
    /// `cli_enabled` (now the master switch for external access) is off.
    Disabled,
    /// The switch is on but the vault is locked.
    Locked,
    /// The switch is on and the vault is unlocked: the socket exists.
    Open,
}

/// Resolve the status-marker path under an already-resolved app-data dir.
pub fn status_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(STATUS_BASENAME)
}

/// Decode a status-marker byte string. `None` on anything unrecognized, which
/// callers treat exactly like an absent marker (best effort, never a boundary).
pub fn parse(bytes: &[u8]) -> Option<DoorState> {
    match bytes {
        b"D" => Some(DoorState::Disabled),
        b"L" => Some(DoorState::Locked),
        b"O" => Some(DoorState::Open),
        _ => None,
    }
}

/// Read and decode the marker under an already-resolved app-data dir.
pub fn read(app_data_dir: &Path) -> Option<DoorState> {
    let bytes = std::fs::read(status_path(app_data_dir)).ok()?;
    parse(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_door_state() {
        assert_eq!(parse(b"D"), Some(DoorState::Disabled));
        assert_eq!(parse(b"L"), Some(DoorState::Locked));
        assert_eq!(parse(b"O"), Some(DoorState::Open));
    }

    #[test]
    fn unrecognized_content_parses_to_none() {
        assert_eq!(parse(b""), None);
        assert_eq!(parse(b"garbage"), None);
        assert_eq!(parse(b"OL"), None);
        // Lower case is not the wire shape, and treating it as one would be a
        // decoder that guesses.
        assert_eq!(parse(b"l"), None);
    }

    #[test]
    fn reading_an_absent_marker_is_none() {
        let dir = std::env::temp_dir().join(format!(
            "myne-mcp-status-absent-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        assert!(read(&dir).is_none());
    }

    #[test]
    fn read_round_trips_a_written_marker() {
        let dir = std::env::temp_dir().join(format!(
            "myne-mcp-status-rw-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        std::fs::write(status_path(&dir), b"L").expect("write marker");
        assert_eq!(read(&dir), Some(DoorState::Locked));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
