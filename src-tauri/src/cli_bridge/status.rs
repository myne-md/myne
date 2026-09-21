//! The CLI bridge's device-local status marker (cli-thin-client task 3).
//!
//! `cli-status` lives beside the command socket in the app-data dir and
//! carries ONE ASCII byte naming the current [`super::gate::DoorState`] —
//! `D` (Disabled) / `L` (Locked) / `O` (Open). It is written on every
//! [`super::spawn_lifecycle_supervisor`] tick where the door state changed,
//! independent of the command socket's own create/teardown.
//!
//! ## Why this file has to exist
//!
//! The command socket exists ONLY in [`super::gate::DoorState::Open`] — a
//! locked vault tears it down exactly like a disabled toggle does, so a bare
//! "connection refused" cannot by itself tell task 4's CLI apart "vault
//! locked" from "CLI access disabled", and task 3's own acceptance
//! criteria require both to be "distinguishable states at the protocol
//! level". This file is that mechanism: absent → the app is not running at
//! all (task 4's "app not running" exit code); present → the app IS running
//! and the byte names which of the other two doors it is.
//!
//! Content only, never a secret: one ASCII byte, no note ids, no folder
//! names, no paths (see src-tauri/AGENTS.md "Secret-handling logging
//! discipline" — the DENY list this file's shape never touches). Best
//! effort: a hard-kill leaves a stale marker behind, which is an
//! advisory-only wrong message (never a security boundary — the actual
//! access gate is the command socket's own existence, not this file).

use std::io;
use std::path::{Path, PathBuf};

use super::gate::DoorState;

/// The basename of the status marker inside the app-data dir, sibling to
/// [`super::socket::SOCKET_BASENAME`].
pub const STATUS_BASENAME: &str = "cli-status";

/// Resolve the status marker path under an already-resolved app-data dir.
pub fn status_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(STATUS_BASENAME)
}

fn byte_for(door: DoorState) -> &'static [u8] {
    match door {
        DoorState::Disabled => b"D",
        DoorState::Locked => b"L",
        DoorState::Open => b"O",
    }
}

/// Decode a status byte read from disk. `None` on any unrecognized content
/// — callers (task 4) treat that the same as "absent". Task 4's `cli/`
/// crate is the production reader (the desktop side only ever writes);
/// this is the tested reference decoder for [`write`]'s wire shape —
/// `allow(dead_code)` in non-test builds until task 4 lands its own reader.
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse(bytes: &[u8]) -> Option<DoorState> {
    match bytes {
        b"D" => Some(DoorState::Disabled),
        b"L" => Some(DoorState::Locked),
        b"O" => Some(DoorState::Open),
        _ => None,
    }
}

/// Write the current door state to the marker: temp-file-then-rename so a
/// concurrent reader (task 4) never observes a partial write. Through the
/// crate's canonical [`crate::atomic_write::atomic_write_private`] rather
/// than a hand-rolled write+rename — same contract, plus the failure-path
/// `.tmp` cleanup and the Windows `MoveFileExW` replace arm (a plain
/// `std::fs::rename` over an existing destination fails there, and this
/// function is not Unix-gated). Only ever called on a door-state CHANGE, so
/// the helper's `sync_all` is not on any per-tick path.
///
/// The `_private` sibling (0600 from the moment the temp exists) rather than
/// plain `atomic_write` (default umask, typically 0644): the BYTE is not a
/// secret — it is one of `D`/`L`/`O`, and this module's docs say so — but the
/// FACT is. `O` published at 0644 tells every other local account on a
/// multi-user machine that this user's vault is unlocked right now, and the
/// command socket sitting beside it is deliberately 0600 for exactly that
/// reason. The reader is the same user's own `myne`, so nothing needs the
/// wider mode.
pub fn write(app_data_dir: &Path, door: DoorState) -> io::Result<()> {
    crate::atomic_write::atomic_write_private(&status_path(app_data_dir), byte_for(door), true)
}

/// Best-effort removal (a clean-shutdown path this feature does not
/// currently wire — see module docs on why staleness is advisory-only).
#[cfg_attr(not(test), allow(dead_code))]
pub fn remove(app_data_dir: &Path) {
    let _ = std::fs::remove_file(status_path(app_data_dir));
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;

    #[test]
    fn round_trips_every_door_state() {
        for door in [DoorState::Disabled, DoorState::Locked, DoorState::Open] {
            assert_eq!(parse(byte_for(door)), Some(door));
        }
    }

    #[test]
    fn unrecognized_content_parses_to_none() {
        assert_eq!(parse(b""), None);
        assert_eq!(parse(b"garbage"), None);
        assert_eq!(parse(b"OL"), None);
    }

    #[test]
    fn write_then_read_round_trips_through_the_filesystem() {
        let dir = ScopedTempDir::new("cli-status-rw").expect("scoped tempdir");
        write(dir.path(), DoorState::Locked).expect("write status marker");
        let bytes = std::fs::read(status_path(dir.path())).expect("read status marker");
        assert_eq!(parse(&bytes), Some(DoorState::Locked));
    }

    #[test]
    fn a_later_write_overwrites_the_earlier_state() {
        let dir = ScopedTempDir::new("cli-status-overwrite").expect("scoped tempdir");
        write(dir.path(), DoorState::Disabled).expect("write disabled");
        write(dir.path(), DoorState::Open).expect("write open");
        let bytes = std::fs::read(status_path(dir.path())).expect("read status marker");
        assert_eq!(parse(&bytes), Some(DoorState::Open));
    }

    #[cfg(unix)]
    #[test]
    fn the_marker_is_owner_only_0600_like_the_socket_beside_it() {
        // The content is one of `D`/`L`/`O` and is not a secret; the FACT
        // that it says `O` is — it publishes "this user's vault is unlocked
        // right now" to every other local account if the mode is wide.
        use std::os::unix::fs::PermissionsExt;
        let dir = ScopedTempDir::new("cli-status-perms").expect("scoped tempdir");
        write(dir.path(), DoorState::Open).expect("write status marker");
        let meta = std::fs::metadata(status_path(dir.path())).expect("marker metadata");
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);

        // And a rewrite over the existing marker keeps the mode — the path
        // the supervisor actually takes on every door-state change.
        write(dir.path(), DoorState::Locked).expect("rewrite status marker");
        let meta = std::fs::metadata(status_path(dir.path())).expect("marker metadata");
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn remove_deletes_the_marker() {
        let dir = ScopedTempDir::new("cli-status-remove").expect("scoped tempdir");
        write(dir.path(), DoorState::Open).expect("write status marker");
        remove(dir.path());
        assert!(!status_path(dir.path()).exists());
    }

    #[test]
    fn no_marker_is_indistinguishable_from_app_not_running() {
        // Task 4's other leg of the three-way split: an ABSENT marker (never
        // written, or removed) is what "app not running" maps to — this test
        // just pins that reading a nonexistent marker path fails cleanly
        // rather than yielding a spurious DoorState.
        let dir = ScopedTempDir::new("cli-status-absent").expect("scoped tempdir");
        assert!(std::fs::read(status_path(dir.path())).is_err());
    }
}
