// SPDX-License-Identifier: AGPL-3.0
//! The client side of the local door: one dial per call, one frame each way.
//!
//! ## The connection that survives a lock is THIS one (the stdio session)
//!
//! The desktop's command socket exists only while external access is on and the
//! vault is unlocked, and locking tears it down unconditionally. That teardown is
//! deliberate and untouched here: what the shim owns is the connection the CLIENT
//! holds, which is stdio and never closes because of a lock. A tool call dials the
//! door afresh, so an unlock simply makes the next dial succeed. Three properties
//! follow, and each was a rejected alternative in the design:
//!
//! - No call is held open until unlock. The door's own IO deadline would break
//!   it, cancellation would stop working, and a process sitting in a call starts
//!   to look like activity to the auto-lock timer, which is the A6 line the CLI
//!   door is careful not to cross.
//! - No reconnect-per-call is asked of the CLIENT. Its session is one pipe for
//!   as long as it lasts.
//! - Nothing in this file reads or resets the auto-lock idle timer. This binary
//!   has no such API and sends no lifecycle command at all; the only request it
//!   ever writes is a tool call ([`crate::server`]), which `transport_test.rs`
//!   asserts against a recording door.
//!
//! ## The local socket is the only socket type this binary may ever have
//!
//! `src-tauri/scripts/ai-no-network-check.sh` scans a fixed root list for a fixed
//! pattern list, and this crate is outside both: `mcp/` is not in
//! `AI_EGRESS_ROOTS`, and the patterns name `TcpStream`, `TcpListener`,
//! `UdpSocket` and address resolution but not `UnixStream::connect`. That
//! omission is a DECISION, not an oversight, and it is recorded here because
//! nothing else states it: a Unix domain socket cannot leave the machine, so a
//! dial to the app's own 0600 socket is not an egress surface. The constraint
//! that follows is binding on every later change: this binary gains no socket
//! type other than the local Unix domain socket and no HTTP client of any kind,
//! and if it ever does, the root list and the pattern list are extended in the
//! SAME change rather than after it.
//!
//! ## Why the path constants are duplicated
//!
//! `myne-mcp` depends on neither `myne-desktop` nor `myne-core`, so the socket
//! location is a wire contract reproduced here exactly as `cli/src/paths.rs`
//! reproduces it. `scripts/check-cli-sidecar.mjs` reads this file and fails,
//! naming it, when any copy drifts from `tauri.conf.json` or from
//! `cli_bridge/{socket,status}.rs`.

use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::errors::Refusal;
use crate::status::{self, DoorState};

/// The desktop bundle identifier (`src-tauri/tauri.conf.json`'s `identifier`).
/// Tauri's `app_data_dir()` is `dirs::data_dir().join(identifier)` exactly.
const BUNDLE_IDENTIFIER: &str = "md.myne.desktop";

/// Basename of the command socket inside the app-data dir. Matches
/// `src-tauri/src/cli_bridge/socket.rs::SOCKET_BASENAME` exactly.
pub const SOCKET_BASENAME: &str = "cli.sock";

/// The door's wire prefix: a fixed 4-byte little-endian `u32` body length.
pub const LENGTH_PREFIX_BYTES: usize = 4;

/// Bound on one frame body, matching both existing ends of this wire. Enforced
/// from the declared length BEFORE anything is allocated, in both directions.
pub const MAX_FRAME_BODY: usize = 16 * 1024 * 1024;

/// One answer from the door, after its envelope was checked.
#[derive(Debug, PartialEq)]
pub enum DoorAnswer {
    /// `{"ok": true, "result": <MCP CallToolResult>}`. `result` is absent on a
    /// success that carries nothing, which is not the same as a malformed one.
    Ok { result: Option<Value> },
    /// `{"ok": false, "error": {"kind": …, "message": …}}`.
    Refused { kind: String, message: String },
}

/// A door client bound to one app-data dir.
///
/// It holds no connection between calls on purpose (see the module docs).
#[derive(Debug)]
pub struct Transport {
    /// `None` when the platform data directory cannot be resolved at all, which
    /// every caller treats as "the app is not running": there is nowhere to look.
    app_data_dir: Option<PathBuf>,
}

impl Transport {
    /// The real running desktop's app-data dir.
    pub fn new() -> Self {
        Self {
            app_data_dir: app_data_dir(),
        }
    }

    /// Point at an explicit app-data dir. Test-only, and the reason it is
    /// test-only is that a production caller able to choose the directory could
    /// choose one that is not the running app's.
    #[cfg(test)]
    pub fn at(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir: Some(app_data_dir),
        }
    }

    /// Send one already-encoded door request and decode the answer.
    ///
    /// A closed door is classified from the status marker, which is why this
    /// returns [`Refusal`] rather than an IO error: the caller's job is to choose
    /// a sentence, not to interpret a socket error.
    pub fn call(&self, request: &Value) -> Result<DoorAnswer, Refusal> {
        // Windows named pipes are unimplemented in BOTH existing doors (the PRD
        // puts them out of scope), so there is nothing to dial on this platform
        // yet. Answering "unreachable" keeps the refusal taxonomy identical
        // everywhere instead of compiling this arm out.
        #[cfg(not(unix))]
        {
            let _ = request;
            return Err(Refusal::DoorUnreachable);
        }

        #[cfg(unix)]
        {
            let Some(dir) = &self.app_data_dir else {
                return Err(Refusal::AppNotRunning);
            };
            // Dial FIRST, marker second, deliberately. The marker is advisory and
            // the socket is the authority, so a call is never refused on the
            // marker alone while the door is actually open: a refusal this
            // process invents is a call that never reached the host's rate
            // limiter.
            let mut stream = match dial(dir) {
                Some(stream) => stream,
                None => return Err(classify_closed_door(dir)),
            };

            let body = serde_json::to_vec(request).map_err(|_| Refusal::DoorUnreachable)?;
            write_frame(&mut stream, &body).map_err(|_| Refusal::DoorUnreachable)?;
            let reply = read_frame(&mut stream).map_err(|_| Refusal::DoorUnreachable)?;
            decode_answer(&reply).ok_or(Refusal::DoorUnreachable)
        }
    }
}

impl Default for Transport {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve the running desktop's app-data dir. `None` when the platform's data
/// directory cannot be determined (an unusual environment, e.g. `$HOME` unset).
pub fn app_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join(BUNDLE_IDENTIFIER))
}

/// Resolve the command-socket path under an already-resolved app-data dir.
pub fn socket_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SOCKET_BASENAME)
}

/// Which of the three states a closed door is in, from the marker.
///
/// `Disabled` and `Locked` are the two states a user can act on. An ABSENT or
/// unrecognized marker is `AppNotRunning`. A marker that says OPEN while the
/// socket refused is the one-tick race, and it is answered as unreachable rather
/// than as one of the three: telling the user to start an app that is running
/// would be worse than saying the door did not answer.
fn classify_closed_door(app_data_dir: &Path) -> Refusal {
    match status::read(app_data_dir) {
        Some(DoorState::Disabled) => Refusal::DoorDisabled,
        Some(DoorState::Locked) => Refusal::VaultLocked,
        Some(DoorState::Open) => Refusal::DoorUnreachable,
        None => Refusal::AppNotRunning,
    }
}

/// Dial the door. `None` on any failure: the caller only needs "it did not
/// answer", and the reason is the marker's to state.
#[cfg(unix)]
fn dial(app_data_dir: &Path) -> Option<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(socket_path(app_data_dir)).ok()
}

/// Write one length-prefixed frame.
fn write_frame(stream: &mut impl Write, body: &[u8]) -> std::io::Result<()> {
    if body.len() > MAX_FRAME_BODY {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "request exceeds the frame cap",
        ));
    }
    stream.write_all(&(body.len() as u32).to_le_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

/// Read one length-prefixed frame, refusing an oversized one on the prefix so a
/// peer cannot make this process allocate a length it chose.
fn read_frame(stream: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
    stream.read_exact(&mut prefix)?;
    let declared = u32::from_le_bytes(prefix) as usize;
    if declared > MAX_FRAME_BODY {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "reply exceeds the frame cap",
        ));
    }
    let mut body = vec![0u8; declared];
    stream.read_exact(&mut body)?;
    Ok(body)
}

/// Decode the door's `ok` / `error` envelope.
///
/// `None` means the bytes are not a reply this binary can use, which the caller
/// answers as unreachable: a peer that is not the app is not evidence about the
/// vault's state.
fn decode_answer(bytes: &[u8]) -> Option<DoorAnswer> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    match value.get("ok")?.as_bool()? {
        true => Some(DoorAnswer::Ok {
            result: value.get("result").cloned(),
        }),
        false => {
            let error = value.get("error")?;
            Some(DoorAnswer::Refused {
                kind: error.get("kind")?.as_str()?.to_string(),
                message: error.get("message")?.as_str()?.to_string(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_success_envelope_decodes_with_and_without_a_result() {
        assert_eq!(
            decode_answer(br#"{"ok":true,"result":{"content":[]}}"#),
            Some(DoorAnswer::Ok {
                result: Some(serde_json::json!({ "content": [] }))
            })
        );
        assert_eq!(
            decode_answer(br#"{"ok":true}"#),
            Some(DoorAnswer::Ok { result: None })
        );
    }

    #[test]
    fn a_refusal_envelope_carries_the_kind_and_the_message() {
        assert_eq!(
            decode_answer(br#"{"ok":false,"error":{"kind":"rate_limited","message":"slow down"}}"#),
            Some(DoorAnswer::Refused {
                kind: "rate_limited".to_string(),
                message: "slow down".to_string(),
            })
        );
    }

    #[test]
    fn anything_that_is_not_an_envelope_decodes_to_nothing() {
        // Each of these would otherwise be forwarded to a client as if the app
        // had answered, including a bare `{"ok":true}` read as a success.
        for bytes in [
            &b""[..],
            b"not json",
            br#"{"error":{"kind":"x","message":"y"}}"#,
            br#"{"ok":"true"}"#,
            br#"{"ok":false}"#,
            br#"{"ok":false,"error":{"kind":1,"message":"y"}}"#,
            br#"[]"#,
        ] {
            assert_eq!(decode_answer(bytes), None, "accepted {bytes:?}");
        }
    }

    #[test]
    fn a_frame_round_trips_through_the_wire_encoding() {
        let body = br#"{"cmd":"mcp_call"}"#.to_vec();
        let mut wire: Vec<u8> = Vec::new();
        write_frame(&mut wire, &body).expect("write");
        assert_eq!(
            &wire[..LENGTH_PREFIX_BYTES],
            &(body.len() as u32).to_le_bytes(),
            "the prefix is a 4-byte little-endian body length"
        );
        assert_eq!(read_frame(&mut wire.as_slice()).expect("read"), body);
    }

    #[test]
    fn a_reply_over_the_cap_is_refused_before_it_is_allocated() {
        let mut wire: Vec<u8> = Vec::new();
        wire.extend_from_slice(&((MAX_FRAME_BODY as u32) + 1).to_le_bytes());
        // No body at all: reading must fail on the prefix, not by allocating the
        // length the peer declared.
        let error = read_frame(&mut wire.as_slice()).expect_err("oversized prefix");
        assert_eq!(error.kind(), ErrorKind::InvalidData);
    }

    #[test]
    fn a_truncated_reply_is_an_error_rather_than_a_short_frame() {
        let mut wire: Vec<u8> = Vec::new();
        wire.extend_from_slice(&8u32.to_le_bytes());
        wire.extend_from_slice(b"short");
        assert!(read_frame(&mut wire.as_slice()).is_err());
    }
}
