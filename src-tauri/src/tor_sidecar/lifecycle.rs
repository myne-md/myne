// SPDX-License-Identifier: AGPL-3.0-only
//! The sidecar's lifecycle state machine — pure, so the interesting
//! transitions can be asserted without a Tor network, a subprocess, or a clock.
//!
//! Everything that can happen to the arti sidecar is an [`Event`]; the phase is
//! a four-state enum matching what the transport and the UI see
//! (`myne_core::plugins::sync::proxy::TorProxyState`). Keeping the machine here
//! and the plumbing in `supervisor` means the two rules that are easy to get
//! subtly wrong — a stopped sidecar's exit is not a failure, and a failure
//! never becomes "ready" again without a restart — are one `match` away from a
//! reviewer instead of buried in thread callbacks.

/// The sidecar's phase. The port lives beside it in the supervisor, not in the
/// phase, because a port is meaningful in exactly one of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Spawned, waiting for arti to report a completed bootstrap.
    Starting,
    /// Bootstrapped, SOCKS listener answering.
    Ready,
    /// Spawn failed, bootstrap timed out, or the process died unexpectedly.
    Failed,
    /// Not running.
    Stopped,
}

/// Everything the supervisor can observe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// The host asked for the sidecar (the toggle went on).
    StartRequested,
    /// The child process was launched.
    Spawned,
    /// `std::process::Command::spawn` failed (no sidecar binary, no exec
    /// permission, …).
    SpawnFailed,
    /// arti logged that it finished bootstrapping AND its SOCKS listener
    /// answered a method-negotiation probe.
    BootstrapConfirmed,
    /// Bootstrap did not complete inside the deadline.
    BootstrapTimedOut,
    /// The host asked for the sidecar to go away (toggle off, or app quit).
    StopRequested,
    /// The child exited. Whether that is a failure depends entirely on whether
    /// we asked for it — hence the `Stopped` arm below.
    ChildExited,
}

/// The transition table.
///
/// Two arms carry the weight:
///
/// * `Stopped + ChildExited → Stopped`. `stop()` kills the child and *then*
///   the reaper observes the exit it caused. Treating that as `Failed` would
///   raise the fail-closed banner every single time the user turns the toggle
///   off — a security warning fired by the safe action, which is how users
///   learn to ignore security warnings.
/// * `Failed + BootstrapConfirmed → Failed`. A late line from a process that
///   already died (the stderr pipe drains after the exit is seen) must not
///   resurrect the sidecar into a state that promises a working tunnel.
pub fn transition(phase: Phase, event: Event) -> Phase {
    use Event::*;
    use Phase::*;
    match (phase, event) {
        // A stop request always wins, from any phase.
        (_, StopRequested) => Stopped,

        (Stopped | Failed, StartRequested) => Starting,
        (Starting | Ready, StartRequested) => phase, // already running; idempotent

        (Starting, Spawned) => Starting,
        (_, SpawnFailed) => Failed,

        (Starting, BootstrapConfirmed) => Ready,
        (Ready, BootstrapConfirmed) => Ready, // repeated confirmations are fine
        (Stopped | Failed, BootstrapConfirmed) => phase, // late line, see docs

        (Starting, BootstrapTimedOut) => Failed,
        (Ready | Failed | Stopped, BootstrapTimedOut) => phase, // stale deadline

        // An exit we did not ask for is a failure; one we did is just done.
        (Starting | Ready | Failed, ChildExited) => Failed,
        (Stopped, ChildExited) => Stopped,

        (Ready, Spawned) | (Failed, Spawned) | (Stopped, Spawned) => phase,
    }
}

#[cfg(test)]
mod tests {
    use super::Event::*;
    use super::Phase::*;
    use super::*;

    /// Drive a sequence from `Stopped` and return the final phase.
    fn run(events: &[Event]) -> Phase {
        events.iter().fold(Stopped, |p, e| transition(p, *e))
    }

    #[test]
    fn happy_path_start_to_ready_to_stop() {
        assert_eq!(run(&[StartRequested]), Starting);
        assert_eq!(run(&[StartRequested, Spawned]), Starting);
        assert_eq!(run(&[StartRequested, Spawned, BootstrapConfirmed]), Ready);
        assert_eq!(
            run(&[StartRequested, Spawned, BootstrapConfirmed, StopRequested]),
            Stopped
        );
    }

    /// Sync must stay paused for the whole bootstrap — `Starting` is not a
    /// waypoint the machine can skip past into something route-able.
    #[test]
    fn spawning_alone_never_reaches_ready() {
        assert_eq!(run(&[StartRequested, Spawned, Spawned]), Starting);
    }

    #[test]
    fn spawn_failure_and_bootstrap_timeout_both_fail() {
        assert_eq!(run(&[StartRequested, SpawnFailed]), Failed);
        assert_eq!(run(&[StartRequested, Spawned, BootstrapTimedOut]), Failed);
    }

    #[test]
    fn an_unrequested_exit_is_a_failure_in_every_running_phase() {
        assert_eq!(run(&[StartRequested, Spawned, ChildExited]), Failed);
        assert_eq!(
            run(&[StartRequested, Spawned, BootstrapConfirmed, ChildExited]),
            Failed
        );
    }

    /// The reaper always sees the exit `stop()` caused. That must not raise
    /// the fail-closed banner.
    #[test]
    fn the_exit_caused_by_stopping_stays_stopped() {
        assert_eq!(
            run(&[
                StartRequested,
                Spawned,
                BootstrapConfirmed,
                StopRequested,
                ChildExited
            ]),
            Stopped
        );
    }

    /// stderr drains after the exit is observed, so a bootstrap line can
    /// legitimately arrive from a dead process.
    #[test]
    fn a_late_bootstrap_line_cannot_resurrect_a_dead_sidecar() {
        assert_eq!(
            run(&[StartRequested, Spawned, ChildExited, BootstrapConfirmed]),
            Failed
        );
        assert_eq!(
            run(&[StartRequested, Spawned, StopRequested, BootstrapConfirmed]),
            Stopped
        );
    }

    #[test]
    fn a_failed_sidecar_restarts_from_starting() {
        assert_eq!(
            run(&[StartRequested, SpawnFailed, StartRequested]),
            Starting
        );
    }

    #[test]
    fn a_stale_timeout_after_ready_does_not_tear_down_a_working_tunnel() {
        assert_eq!(
            run(&[
                StartRequested,
                Spawned,
                BootstrapConfirmed,
                BootstrapTimedOut
            ]),
            Ready
        );
    }

    #[test]
    fn stop_wins_from_every_phase() {
        for phase in [Starting, Ready, Failed, Stopped] {
            assert_eq!(transition(phase, StopRequested), Stopped);
        }
    }
}
