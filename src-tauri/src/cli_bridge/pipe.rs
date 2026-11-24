// SPDX-License-Identifier: AGPL-3.0-only
//! The Windows command door: a **named-pipe server**, the counterpart of
//! `socket.rs`'s Unix domain socket.
//!
//! `docs/threat-model.md`'s CLI-door entry has promised "a local Unix domain
//! socket (macOS/Linux) or named pipe (Windows)" since MYND-490. This is the
//! server half of that sentence; the client half is `cli/src/windows_pipe.rs`,
//! and the machinery (DACL, close-once handle, instance loop, write watchdog) is
//! [`crate::win_pipe`]'s so that this door and the clipper's relay cannot drift
//! apart in a security property they share.
//!
//! What is left here is what this ingress alone decides: the pipe NAME (from the
//! app-data dir, matching the CLI's own derivation), the dispatch call that
//! serves a connected handle, and the last-access marker the Settings panel
//! reads.
//!
//! ── Never executed ────────────────────────────────────────────────────────
//!
//! There is no Windows lane in this repository, so everything here compiles and
//! none of it has been RUN. The Unix arm's behaviour is covered by the tests in
//! `socket.rs`; this one's is covered by reading it. Stated rather than implied,
//! because "it builds" is the claim that gets mistaken for "it works" on a
//! platform nobody boots.

use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use crate::win_pipe::Server;

use super::activity::SharedLastAccess;
use super::dispatch::NoteLister;
use super::rate_limit::SharedRateLimiter;
use super::socket::{windows_pipe_name, IO_DEADLINE};

/// A running pipe listener, owned by the lifecycle supervisor. Same shape as the
/// Unix arm's handle so `cli_bridge::mod` needs no per-platform branch.
pub struct ListenerHandle {
    server: Server,
    last_access: SharedLastAccess,
}

/// Bind the command pipe for `app_data_dir` and serve connections on a
/// background thread until [`teardown`] is called. Same signature and contract
/// as `socket::spawn`.
pub fn spawn(
    app_data_dir: &Path,
    lister: Arc<dyn NoteLister>,
    limiter: Arc<SharedRateLimiter>,
    last_access: SharedLastAccess,
) -> io::Result<ListenerHandle> {
    let name: Vec<u16> = windows_pipe_name(app_data_dir)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let marker = last_access.clone();
    let server = Server::start(name, IO_DEADLINE, move |reader, writer| {
        super::dispatch::serve_connection(
            reader,
            writer,
            lister.as_ref(),
            &limiter,
            // The ceiling on reading the REQUEST, the same number as the Unix
            // arm's socket timeout and a different property: that bounds one
            // syscall, this bounds the whole frame. Nothing bounds what follows
            // dispatch, deliberately — it decrypts every candidate note.
            Some(super::framing::Budget::new(IO_DEADLINE)),
        );
        // Recorded for EVERY outcome, like the Unix arm: a refused, throttled or
        // malformed request still means something reached the door, which is
        // exactly what the indicator is there to say.
        marker.record(Instant::now());
    })?;
    Ok(ListenerHandle {
        server,
        last_access,
    })
}

/// Tear down a running listener: signal the accept loop to stop, close the live
/// instance so a blocked `ConnectNamedPipe` returns, and join off the caller's
/// thread.
///
/// Also clears the last-access marker, and it lives HERE rather than at the
/// supervisor's close arm so the reset is structurally welded to the door
/// closing: an age that outlived its session would tell the user something used
/// the CLI in a session they can no longer see.
pub fn teardown(handle: Option<ListenerHandle>) {
    let Some(mut h) = handle else { return };
    h.last_access.clear();
    h.server.stop_and_join();
}
