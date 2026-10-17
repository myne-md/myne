// SPDX-License-Identifier: AGPL-3.0
//! Host↔app local IPC relay (TB10, task 6 — the deferred prerequisite).
//!
//! The native-messaging host runs as a SEPARATE OS process from the running
//! Myne app (the browser launches the binary with
//! [`super::host::NATIVE_MESSAGING_ARG`]). The app holds the keys, the vault
//! `Slot`, and the authoritative [`super::token::TokenRegistry`]; the host
//! holds NONE of those. This module is the channel that lets a validated frame
//! reach the key-holding app and the reply travel back.
//!
//! ## The exact mechanism
//!
//! - **Single-app-instance enforcement** is the already-vendored
//!   `tauri-plugin-single-instance` (registered in `lib.rs`, MYND-22): exactly
//!   one app process owns the vault at a time, so there is exactly one relay
//!   listener and no ambiguity about which process is the key-holder.
//! - **The local IPC channel** is a **Unix domain socket** on macOS/Linux
//!   ([`std::os::unix::net::UnixListener`] / `UnixStream`) — NOT a TCP port, so
//!   it is unreachable from the network and from other hosts. The socket file
//!   lives in the app-data dir (`<app_data_dir>/clipper.sock`) with
//!   **owner-only permissions (0600)** set via `fchmod`/`set_permissions`
//!   BEFORE it accepts a connection. On Windows the platform-native equivalent
//!   is a named pipe with an owner-only DACL; std has no named-pipe primitive,
//!   so the Windows arm is a documented seam (the dev/CI target is
//!   macOS/Linux) — see [`socket_path`] / [`bind_listener`].
//! - **The wire framing on the socket reuses the native-messaging framing**
//!   ([`super::framing`]): a 4-byte LE length prefix + body, with the SAME caps
//!   (ext→host ≤64 MiB, reply ≤1 MiB). The host forwards each ext→host frame
//!   verbatim and relays the app's reply frame back to stdout.
//!
//! ## Security properties
//!
//! 1. **Local-only.** A Unix domain socket is reachable only by a process on
//!    the same host with filesystem access to the socket path — never over the
//!    network (no TCP, no SSRF, no remote attacker). Co-resident processes are
//!    the only reach, and (2) bounds them.
//! 2. **Owner-only (0600).** The socket is `chmod 0600` so only the OS user who
//!    owns the running app can connect — a different local user cannot open it.
//! 3. **The app re-validates every forwarded frame as UNTRUSTED input.** The
//!    host is a thin, untrusted relay: the app does NOT trust that the host
//!    decoded the envelope, checked the token, enforced the caps, or honoured
//!    the rate limit. [`super::ingest::ingest_relayed_frame`] re-decodes the
//!    envelope, re-checks the token against the REAL registry, re-enforces the
//!    note-body cap on the decoded body, and re-enforces the rate limit —
//!    app-side, authoritatively — before forwarding the validated envelope to
//!    the WebView for assembly. A compromised or spoofed host gains nothing: a
//!    frame that does not validate app-side is silently ignored (no assembly,
//!    no reply).
//!
//! ## Testability
//!
//! The keyed app-side path ([`serve_connection`]) is generic over
//! `Read`/`Write`, so the full decode→re-validate→forward→reply loop is
//! unit-tested in-process over an in-memory pipe — no OS socket needed. The
//! socket plumbing ([`bind_listener`], [`forward_stdio_over_socket`]) is the
//! thin OS layer on top, covered by a Unix-only integration test where the
//! platform supports it.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — frames carry
//! note plaintext; this module logs only bounded outcome / framing labels,
//! never a body, path, or token.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use super::envelope::{self, VaultStatusSource};
use super::framing::{self, FrameError};
use super::ingest::{ingest_relayed_frame, ClipAssembler, IngestOutcome, PairingDispatcher};
use super::rate_limit::SharedRateLimiter;
use super::token::TokenRegistry;

/// How long the host waits for the app's reply frame before giving up (X2).
///
/// Must EXCEED the app's `relay_app::DISPATCH_TIMEOUT` (30 s): the app can park
/// up to that long while the WebView assembles a clip, then ALWAYS replies
/// (`accepted` / `error` / `locked`), so a legitimate clip is never cut off. The
/// slack bounds the OTHER case — when the app SILENTLY ignores an unpaired /
/// invalid / revoked frame (`IngestOutcome::SilentlyIgnored`) it neither replies
/// nor closes, so an unbounded read on the host's socket would hang **forever**,
/// stranding the host process and (until its own timeout) the extension. With
/// this bound the silent path yields a timed read and the host pump exits
/// cleanly; the extension sees the disconnect and surfaces an honest outcome.
pub const HOST_APP_REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(40);

/// The basename of the local IPC socket inside the app-data dir.
///
/// A fixed name (not a random one) so the host-mode process — which shares the
/// app's identity and therefore its `app_data_dir` — can locate the running
/// app's listener without an out-of-band rendezvous. The owner-only (0600)
/// perms, not obscurity, are the access control.
pub const SOCKET_BASENAME: &str = "clipper.sock";

/// Resolve the local IPC socket path under an already-resolved app-data dir.
///
/// `<app_data_dir>/clipper.sock`. The host process and the app process resolve
/// the same path because they share the app identity (same `app_data_dir`).
pub fn socket_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SOCKET_BASENAME)
}

/// Serve one relayed connection app-side: read frames, re-validate + forward
/// each one through the keyed ingest path, and write the reply frame back.
/// Loops until the peer (the host) disconnects (clean EOF) or a framing error
/// ends the stream.
///
/// This is the **security-load-bearing app-side handler**, generic over
/// `Read`/`Write` so it is exercised end-to-end over an in-memory pipe in unit
/// tests AND over a real `UnixStream` in production. Every frame is treated as
/// untrusted input — see [`super::ingest::ingest_relayed_frame`].
///
/// - [`IngestOutcome::SilentlyIgnored`] → write nothing (silent-to-unpaired,
///   re-enforced app-side regardless of what the host did);
/// - [`IngestOutcome::Replied`] → write the tiny `accepted | error | locked`
///   reply frame (≤1 MiB by `encode_reply` + `write_frame`).
pub fn serve_connection<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    registry: &TokenRegistry,
    status: &dyn VaultStatusSource,
    limiter: &SharedRateLimiter,
    assembler: &dyn ClipAssembler,
    pairing: &dyn PairingDispatcher,
) -> std::io::Result<()> {
    loop {
        match framing::read_frame(reader) {
            Ok(body) => {
                let outcome = ingest_relayed_frame(
                    &body,
                    registry,
                    status,
                    limiter,
                    assembler,
                    pairing,
                    Instant::now(),
                );
                match outcome {
                    IngestOutcome::SilentlyIgnored => {
                        // Silent: write nothing.
                    }
                    IngestOutcome::Replied(reply) => {
                        tracing::debug!(stage = "clip_relay", outcome = reply.status_label());
                        match envelope::encode_reply(&reply) {
                            Ok(bytes) => {
                                if let Err(e) = framing::write_frame(writer, &bytes) {
                                    tracing::debug!(
                                        stage = "clip_relay_reply",
                                        frame_error = e.label()
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::debug!(
                                    stage = "clip_relay_reply",
                                    validation_error = e.label()
                                );
                            }
                        }
                    }
                }
            }
            Err(FrameError::Eof) => return Ok(()),
            Err(e) => {
                // A malformed frame leaves the stream in an unknown sync state;
                // do not attempt a mid-stream resync (a re-framing attack
                // surface). Log the closed label and end the connection.
                tracing::debug!(stage = "clip_relay_frame", frame_error = e.label());
                return Ok(());
            }
        }
    }
}

/// The owner-only (0600), TOCTOU-closed UDS bind. It lives in `crate::uds`
/// because the CLI door binds its own socket with exactly this discipline
/// (`cli_bridge::socket`) — re-exported here so this module's own callers,
/// tests and doc links keep reaching it under the name they always used.
#[cfg(unix)]
pub use crate::uds::bind_listener;

/// The host-side relay: forward each ext→host frame from `host_reader`
/// (extension stdin) to the app over `app_writer` (the socket), and relay each
/// app reply from `app_reader` (the socket) back to `host_writer` (extension
/// stdout). Loops until either side disconnects.
///
/// The host is a THIN pass-through: it does no validation of its own (the app
/// re-validates everything). It only moves bytes between the native-messaging
/// stdio pair and the local socket, preserving the framing on both sides.
///
/// Generic over the four streams so the pump is unit-tested in-process; the
/// production wiring (`lib.rs`) backs `app_reader`/`app_writer` with a
/// `UnixStream` and `host_reader`/`host_writer` with real stdin/stdout.
pub fn forward_stdio_over_socket<HR, HW, AR, AW>(
    host_reader: &mut HR,
    host_writer: &mut HW,
    app_reader: &mut AR,
    app_writer: &mut AW,
) -> std::io::Result<()>
where
    HR: Read,
    HW: Write,
    AR: Read,
    AW: Write,
{
    loop {
        // Read one ext→host frame from the extension's stdin.
        let body = match framing::read_frame(host_reader) {
            Ok(b) => b,
            Err(FrameError::Eof) => return Ok(()), // extension disconnected
            Err(e) => {
                tracing::debug!(stage = "clip_relay_host_in", frame_error = e.label());
                return Ok(());
            }
        };
        // Forward it verbatim to the app over the socket (re-framed). Cap at the
        // ext→host frame size (64 MiB), NOT the tiny reply cap: `read_frame` above
        // already accepted this body up to 64 MiB, and the plain `write_frame`
        // (1 MiB reply cap) would silently drop every clip > 1 MiB — i.e. any
        // image-bearing capture.
        if let Err(e) = framing::write_frame_capped(app_writer, &body, super::MAX_EXT_TO_HOST_FRAME)
        {
            tracing::debug!(stage = "clip_relay_host_out", frame_error = e.label());
            return Ok(());
        }
        app_writer.flush()?;
        // Read the app's reply frame (if any). The app stays SILENT for an
        // unpaired/invalid/revoked frame (it neither replies nor closes), so a
        // reply is NOT guaranteed and the host must not block forever. The
        // production wiring (`lib.rs::run_host_relay`) sets a read timeout
        // (`HOST_APP_REPLY_TIMEOUT`, > the app's dispatch budget) on this socket,
        // so a silent app yields a timed read here → the `Err(e)` arm ends the
        // pump cleanly. A clean EOF (the app served + closed) also ends it.
        match framing::read_frame(app_reader) {
            Ok(reply) => {
                if let Err(e) = framing::write_frame(host_writer, &reply) {
                    tracing::debug!(stage = "clip_relay_reply_out", frame_error = e.label());
                    return Ok(());
                }
                let _ = host_writer.flush();
            }
            Err(FrameError::Eof) => return Ok(()),
            Err(e) => {
                tracing::debug!(stage = "clip_relay_app_in", frame_error = e.label());
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipper::envelope::{HostReply, StaticVaultStatus, VaultStatus};
    use std::cell::RefCell;
    use std::io::Cursor;

    const EXT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[derive(Default)]
    struct RecordingAssembler {
        assembled: RefCell<Vec<crate::clipper::envelope::HandoffEnvelope>>,
    }
    impl ClipAssembler for RecordingAssembler {
        fn assemble(
            &self,
            env: &crate::clipper::envelope::HandoffEnvelope,
        ) -> crate::clipper::ingest::AssembleOutcome {
            self.assembled.borrow_mut().push(env.clone());
            crate::clipper::ingest::AssembleOutcome::Accepted
        }
    }

    /// A [`PairingDispatcher`] that PANICS if dispatched — the clip + status
    /// serve-connection tests must NEVER route pairing (pairing routes BEFORE
    /// the token gate in `ingest_relayed_frame`, so a clip/status frame must
    /// never reach it).
    struct NeverPairing;
    impl PairingDispatcher for NeverPairing {
        fn begin_pair(&self, _extension_id: &str) -> crate::clipper::ingest::BeginPairOutcome {
            panic!("a clip / status serve_connection must never dispatch pairing");
        }
        fn await_pair(&self, _extension_id: &str) -> crate::clipper::ingest::PairDispatchOutcome {
            panic!("a clip / status serve_connection must never dispatch pairing");
        }
    }

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut v = (body.len() as u32).to_le_bytes().to_vec();
        v.extend_from_slice(body);
        v
    }

    /// A short-path socket file under `/tmp`, removed on drop.
    ///
    /// Unix domain socket paths are bounded by `SUN_LEN` (~104 bytes on
    /// macOS); the default test temp dir
    /// (`/var/folders/…/T/myne-test-…-<uuid>/`) blows that, so socket tests use
    /// a deliberately short `/tmp/myne-<n>.sock`. The PRODUCTION path
    /// (`<app_data_dir>/clipper.sock`, ~70 bytes on macOS) is well within the
    /// bound; only the test temp path is the problem.
    struct ShortSock(PathBuf);
    impl ShortSock {
        fn new() -> Self {
            // A short, UNIQUE name. `nanos` alone can repeat when parallel tests
            // call this within one coarse clock tick (macOS `SystemTime`
            // resolution), which races two sockets onto the same path — a later
            // `std::fs::write`/`bind` then hits the other test's socket with
            // `EOPNOTSUPP`. A per-process monotonic counter makes every path
            // unique regardless of clock granularity.
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let name = format!(
                "myn{}_{}.sock",
                n % 100_000_000,
                SEQ.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(&name);
            // On macOS temp_dir() can itself be long; fall back to /tmp which is
            // short and always present on the Unix CI/dev targets.
            let path = if path.as_os_str().len() > 90 {
                PathBuf::from(format!("/tmp/{name}"))
            } else {
                path
            };
            let _ = std::fs::remove_file(&path);
            ShortSock(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for ShortSock {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn paired_registry() -> (TokenRegistry, String) {
        let mut reg = TokenRegistry::new();
        let token = reg.issue(EXT).unwrap();
        let value = token.value().to_string();
        (reg, value)
    }

    fn clip_envelope(token: &str, body: &str) -> Vec<u8> {
        format!(
            r#"{{ "version": 1, "kind": "create-clip", "extension_id": "{EXT}",
                  "token": "{token}", "markdown_body": {body},
                  "source_url": "https://example.com/a" }}"#,
            body = serde_json::to_string(body).unwrap()
        )
        .into_bytes()
    }

    // ---- serve_connection: the keyed app-side handler over a pipe -------

    #[test]
    fn serve_connection_writes_a_note_and_replies_accepted_for_a_valid_clip() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::default();

        let wire = framed(&clip_envelope(&token, "# Clip\n\nbody"));
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        serve_connection(
            &mut reader,
            &mut writer,
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
        )
        .unwrap();

        // An envelope was forwarded for assembly through the keyed path,
        // carrying the provenance the WebView composes from.
        assert_eq!(assembler.assembled.borrow().len(), 1);
        assert_eq!(
            assembler.assembled.borrow()[0].source_url.as_deref(),
            Some("https://example.com/a")
        );
        // The reply frame is `accepted` with a confirm token.
        let mut rcur = Cursor::new(writer);
        let reply_body = framing::read_frame(&mut rcur).expect("a reply frame");
        let reply: HostReply = serde_json::from_slice(&reply_body).unwrap();
        assert!(matches!(reply, HostReply::Accepted { .. }));
    }

    #[test]
    fn serve_connection_is_silent_and_writes_nothing_for_an_unpaired_frame() {
        // The relay re-validates app-side: an unknown token → no note, no reply
        // (the silent-to-unpaired contract, re-enforced even though the host
        // forwarded the frame).
        let reg = TokenRegistry::new(); // nothing issued
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::default();

        let wire = framed(&clip_envelope("garbage-token", "body"));
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        serve_connection(
            &mut reader,
            &mut writer,
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
        )
        .unwrap();

        assert_eq!(assembler.assembled.borrow().len(), 0, "no note written");
        assert!(writer.is_empty(), "no reply written to an unpaired caller");
    }

    #[test]
    fn serve_connection_replies_locked_when_the_vault_is_locked() {
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Locked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::default();

        let wire = framed(&clip_envelope(&token, "body"));
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        serve_connection(
            &mut reader,
            &mut writer,
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
        )
        .unwrap();

        assert_eq!(assembler.assembled.borrow().len(), 0, "locked → no write");
        let mut rcur = Cursor::new(writer);
        let reply_body = framing::read_frame(&mut rcur).expect("a reply frame");
        let reply: HostReply = serde_json::from_slice(&reply_body).unwrap();
        assert_eq!(reply, HostReply::Locked);
    }

    #[test]
    fn serve_connection_handles_two_frames_two_independent_notes() {
        // Two clips of the same page over one connection → two writes (SYNC-16).
        let (reg, token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::default();

        let mut wire = framed(&clip_envelope(&token, "body one"));
        wire.extend_from_slice(&framed(&clip_envelope(&token, "body two")));
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        serve_connection(
            &mut reader,
            &mut writer,
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
        )
        .unwrap();

        assert_eq!(
            assembler.assembled.borrow().len(),
            2,
            "two clips → two notes"
        );
    }

    #[test]
    fn serve_connection_does_not_panic_on_a_truncated_frame() {
        let (reg, _token) = paired_registry();
        let status = StaticVaultStatus(VaultStatus::Unlocked);
        let limiter = SharedRateLimiter::default();
        let assembler = RecordingAssembler::default();

        // Prefix declares 1000 bytes, only a few present → Truncated; serve
        // ends cleanly.
        let mut wire = (1000u32).to_le_bytes().to_vec();
        wire.extend_from_slice(b"short");
        let mut reader = Cursor::new(wire);
        let mut writer: Vec<u8> = Vec::new();
        serve_connection(
            &mut reader,
            &mut writer,
            &reg,
            &status,
            &limiter,
            &assembler,
            &NeverPairing,
        )
        .unwrap();
        assert_eq!(assembler.assembled.borrow().len(), 0);
    }

    // ---- forward_stdio_over_socket: the host-side pump ------------------

    #[test]
    fn host_pump_forwards_a_frame_and_relays_the_reply() {
        // The host pump moves one ext→host frame to the "app" stream and one
        // reply back to "extension stdout", preserving framing on both sides.
        let host_in = framed(b"the-clip-frame");
        let mut host_reader = Cursor::new(host_in);
        let mut host_writer: Vec<u8> = Vec::new();

        // The "app" side: a buffer the pump writes the forwarded frame into,
        // and a canned reply frame the pump reads back.
        let mut app_writer: Vec<u8> = Vec::new();
        let app_reply = framed(br#"{"status":"locked"}"#);
        let mut app_reader = Cursor::new(app_reply);

        forward_stdio_over_socket(
            &mut host_reader,
            &mut host_writer,
            &mut app_reader,
            &mut app_writer,
        )
        .unwrap();

        // The forwarded frame reached the app verbatim (re-framed).
        let mut acur = Cursor::new(app_writer);
        let forwarded = framing::read_frame(&mut acur).expect("forwarded frame");
        assert_eq!(forwarded, b"the-clip-frame");
        // The app's reply reached the extension stdout (re-framed).
        let mut hcur = Cursor::new(host_writer);
        let relayed = framing::read_frame(&mut hcur).expect("relayed reply");
        assert_eq!(relayed, br#"{"status":"locked"}"#);
    }

    #[test]
    fn host_pump_exits_cleanly_on_extension_eof() {
        // No frame on the extension stdin → clean EOF → the pump exits without
        // touching the app side.
        let mut host_reader = Cursor::new(Vec::<u8>::new());
        let mut host_writer: Vec<u8> = Vec::new();
        let mut app_reader = Cursor::new(Vec::<u8>::new());
        let mut app_writer: Vec<u8> = Vec::new();
        forward_stdio_over_socket(
            &mut host_reader,
            &mut host_writer,
            &mut app_reader,
            &mut app_writer,
        )
        .unwrap();
        assert!(app_writer.is_empty(), "no frame forwarded on EOF");
        assert!(host_writer.is_empty());
    }

    // ---- socket path + binding (Unix) ----------------------------------

    #[test]
    fn socket_path_is_under_app_data_dir() {
        let p = socket_path(Path::new("/some/app/data"));
        assert_eq!(p, Path::new("/some/app/data/clipper.sock"));
    }

    #[cfg(unix)]
    #[test]
    fn bind_listener_sets_owner_only_0600_perms() {
        use std::os::unix::fs::PermissionsExt;
        let sock = ShortSock::new();
        let path = sock.path();
        let _listener = bind_listener(path).expect("bind the unix socket");
        let meta = std::fs::metadata(path).expect("socket metadata");
        // Owner-only: 0600 (rw-------). Mask off the file-type bits.
        assert_eq!(
            meta.permissions().mode() & 0o777,
            0o600,
            "the socket must be owner-only (0600)"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bind_listener_replaces_a_stale_socket_file() {
        // A leftover file at the path (previous unclean exit) must not block a
        // fresh bind.
        let sock = ShortSock::new();
        let path = sock.path();
        std::fs::write(path, b"stale").unwrap();
        let _listener = bind_listener(path).expect("bind over a stale file");
        assert!(path.exists());
    }

    // ---- end-to-end over a REAL Unix socket ----------------------------
    //
    // The full cross-process shape in-process: an app listener thread serves
    // the keyed path; the host pump forwards a clip frame over the real socket
    // and relays the reply. Proves the OS plumbing + the keyed handler compose.

    #[cfg(unix)]
    #[test]
    fn end_to_end_over_a_real_unix_socket_writes_a_note_and_relays_accepted() {
        use std::io::Write as _;
        use std::sync::mpsc;
        use std::thread;

        let sock = ShortSock::new();
        let path = sock.path().to_path_buf();
        let listener = bind_listener(&path).expect("bind");

        let (reg, token) = paired_registry();
        let (tx, rx) = mpsc::channel::<usize>();

        // App side: accept one connection, serve the keyed path, report the
        // number of notes written.
        let server = thread::spawn(move || {
            let status = StaticVaultStatus(VaultStatus::Unlocked);
            let limiter = SharedRateLimiter::default();
            let assembler = RecordingAssembler::default();
            let (mut stream, _addr) = listener.accept().expect("accept");
            let mut read_half = stream.try_clone().expect("clone");
            serve_connection(
                &mut read_half,
                &mut stream,
                &reg,
                &status,
                &limiter,
                &assembler,
                &NeverPairing,
            )
            .expect("serve");
            tx.send(assembler.assembled.borrow().len()).unwrap();
        });

        // Host side: connect, send one clip frame, read the reply.
        let mut client = std::os::unix::net::UnixStream::connect(&path).expect("connect");
        let frame = framed(&clip_envelope(&token, "# E2E\n\nbody"));
        client.write_all(&frame).expect("send clip");
        client.flush().unwrap();
        // Read the reply frame.
        let reply_body = framing::read_frame(&mut client).expect("reply frame");
        let reply: HostReply = serde_json::from_slice(&reply_body).unwrap();
        assert!(matches!(reply, HostReply::Accepted { .. }));
        // Close the client so the server's serve loop hits EOF and finishes.
        drop(client);

        let written = rx.recv().expect("server reported write count");
        assert_eq!(written, 1, "the clip was written app-side over the socket");
        server.join().unwrap();
    }
}
