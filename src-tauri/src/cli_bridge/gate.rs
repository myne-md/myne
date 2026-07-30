//! Pure classification of the CLI door's state (cli-thin-client task 3;
//! MYND-490; `design-notes.md` "CLI terminal access is a default-off,
//! unlock-gated local socket with a folder exclusion list (MYND-490)";
//! `docs/threat-model.md` §7).
//!
//! The command socket exists ONLY while `cli_enabled` is true AND the vault
//! is unlocked — created the instant both hold, torn down the instant
//! either stops holding. This module is the decision core: no IO, no
//! socket, no tokio, so the transitions [`super::spawn_lifecycle_supervisor`]
//! drives are unit-tested without a runtime.

/// The CLI door's classified state, from the two gate conditions
/// (`design-notes.md`'s "three real controls" minus the exclusion list,
/// which task 5 owns).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoorState {
    /// `cli_enabled` is false (or not yet observed true this session). The
    /// command socket does not exist; task 4 maps this to the "enable it in
    /// Settings" exit code.
    Disabled,
    /// `cli_enabled` is true but the vault is locked. The command socket
    /// does not exist; task 4 maps this to the "unlock Myne" exit code.
    Locked,
    /// Both hold: the command socket exists and accepts connections.
    Open,
}

/// Classify the door from `(cli_enabled, unlocked)`.
pub fn classify(cli_enabled: bool, unlocked: bool) -> DoorState {
    match (cli_enabled, unlocked) {
        (true, true) => DoorState::Open,
        (true, false) => DoorState::Locked,
        (false, _) => DoorState::Disabled,
    }
}

/// Whether the command socket should exist for this door state. [`DoorState::Open`]
/// is the only state that opens it — `docs/threat-model.md` §7's accepted
/// residual ("any program running as the same user can drive the CLI and
/// read everything in scope") applies exactly while this is true.
pub fn socket_should_be_open(door: DoorState) -> bool {
    matches!(door, DoorState::Open)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_when_cli_off_regardless_of_lock() {
        assert_eq!(classify(false, false), DoorState::Disabled);
        assert_eq!(classify(false, true), DoorState::Disabled);
    }

    #[test]
    fn locked_when_enabled_but_vault_locked() {
        assert_eq!(classify(true, false), DoorState::Locked);
    }

    #[test]
    fn open_when_enabled_and_unlocked() {
        assert_eq!(classify(true, true), DoorState::Open);
    }

    #[test]
    fn only_open_wants_the_socket() {
        assert!(!socket_should_be_open(DoorState::Disabled));
        assert!(!socket_should_be_open(DoorState::Locked));
        assert!(socket_should_be_open(DoorState::Open));
    }

    // The four transitions the supervisor drives end to end (task 3's own
    // "How verified"): toggling the enable switch and locking/unlocking the
    // vault each flip `socket_should_be_open` at the documented edge, never
    // early and never late.
    #[test]
    fn four_transitions_flip_the_socket_at_the_documented_edge() {
        // 1. disabled+locked -> enabled+locked (toggle on while locked):
        //    stays closed — the door needs unlock too.
        assert!(!socket_should_be_open(classify(false, false)));
        assert!(!socket_should_be_open(classify(true, false)));
        // 2. enabled+locked -> enabled+unlocked (unlock while enabled): opens.
        assert!(socket_should_be_open(classify(true, true)));
        // 3. enabled+unlocked -> enabled+locked (lock while enabled, e.g.
        //    auto-lock): closes, with NO code path specific to this feature
        //    (auto_lock.rs is untouched — see module docs).
        assert!(!socket_should_be_open(classify(true, false)));
        // 4. enabled+unlocked -> disabled+unlocked (toggle off while
        //    unlocked): closes.
        assert!(!socket_should_be_open(classify(false, true)));
    }

    #[test]
    fn disabled_and_locked_are_distinct_door_states() {
        // Both close the socket, but task 4 must be able to tell them apart
        // (see `super::status`) — they are different `DoorState` variants,
        // not one collapsed "closed" bit.
        assert_ne!(classify(false, true), classify(true, false));
    }
}
