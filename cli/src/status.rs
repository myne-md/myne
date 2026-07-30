//! The CLI's own reader for the desktop's `cli-status` marker
//! (`src-tauri/src/cli_bridge/status.rs`'s wire shape).
//!
//! Deliberately a separate, independent copy rather than a shared type —
//! same reasoning as `src-tauri/src/cli_bridge/framing.rs`'s own doc
//! comment: a wire *contract*, not shared Rust code, so this binary never
//! depends on `myne-desktop`. That module's doc comment names this crate as
//! "the production reader" of the shape decoded here.

use crate::paths;

/// The door's classified state, decoded from one ASCII byte
/// (`D`/`L`/`O`) — mirrors `cli_bridge::gate::DoorState` exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoorState {
    Disabled,
    Locked,
    Open,
}

/// Decode a status-marker byte string. `None` on anything unrecognized —
/// callers treat that the same as "marker absent" (best-effort, advisory
/// only; see the desktop-side module's own doc comment on why a stale or
/// garbled marker is never a security boundary).
pub fn parse(bytes: &[u8]) -> Option<DoorState> {
    match bytes {
        b"D" => Some(DoorState::Disabled),
        b"L" => Some(DoorState::Locked),
        b"O" => Some(DoorState::Open),
        _ => None,
    }
}

/// Read + decode the status marker under an already-resolved app-data dir.
/// `None` covers both "the file does not exist" (the app is not running at
/// all) and "the content is unrecognized" (a partial/garbled write) — the
/// caller (`backend::ipc`) maps both to the same "app not running" outcome,
/// which is the fail-safe read in both cases.
pub fn read(app_data_dir: &std::path::Path) -> Option<DoorState> {
    let bytes = std::fs::read(paths::status_path(app_data_dir)).ok()?;
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
        assert_eq!(parse(b"DL"), None);
    }

    #[test]
    fn read_returns_none_when_the_marker_file_does_not_exist() {
        let dir =
            std::env::temp_dir().join(format!("myne-cli-status-absent-{}", std::process::id()));
        assert!(read(&dir).is_none());
    }

    #[test]
    fn read_round_trips_a_written_marker() {
        let dir = std::env::temp_dir().join(format!(
            "myne-cli-status-rw-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        std::fs::write(paths::status_path(&dir), b"L").expect("write marker");
        assert_eq!(read(&dir), Some(DoorState::Locked));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
