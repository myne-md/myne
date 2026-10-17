// SPDX-License-Identifier: AGPL-3.0
//! Length-prefixed frame reader/writer for the CLI bridge socket
//! (cli-thin-client task 3).
//!
//! Mirrors the framing DISCIPLINE of `clipper::framing` (TB10) — a 4-byte
//! little-endian length prefix, the cap enforced BEFORE the body is
//! allocated, and no panic on truncated/oversized/malformed input — as its
//! own small, decoupled module: the CLI bridge is a same-user-only local
//! IPC surface inside TB2 (`docs/threat-model.md` §7: "Everything stays
//! inside TB2 — no new trust boundary"), not the clipper's external TB10
//! ingress, so it earns its own cap and its own closed error type rather
//! than sharing the clipper's `MAX_EXT_TO_HOST_FRAME` (a TB10-sized 64 MiB
//! cap this surface has no reason to inherit).
//!
//! Content dispatch is explicitly OUT of scope here (task 4 owns the
//! request/reply payload shapes) — this module returns raw bytes only.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — a frame
//! body may carry note plaintext (task 6/8's `show`/`new`); this module
//! never logs a frame body, only the closed [`FrameError`] variant name and
//! non-secret declared/observed byte counts.

use std::io::{Read, Write};

/// The length prefix is a fixed 4-byte little-endian `u32`.
pub const LENGTH_PREFIX_BYTES: usize = 4;

/// Bound on one frame body. Generous enough for a `myne new` stdin payload
/// (task 8) while still rejecting an unbounded allocation from a hostile or
/// buggy same-user peer BEFORE the body is read. Revisit if a later task's
/// payload shape genuinely needs more; there is no wire reason it should.
pub const MAX_FRAME_BODY: usize = 16 * 1024 * 1024;

/// Closed failure taxonomy for the framing layer. No payload carries a
/// frame body or an OS path — every variant is a bounded, DENY-list-clean
/// value (a variant name, or non-secret declared/observed byte counts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// The peer closed the stream cleanly at a frame boundary — the 4-byte
    /// length prefix could not be read because EOF arrived first with ZERO
    /// bytes consumed. Not hostile; the normal "peer disconnected" signal.
    Eof,
    /// A frame was truncated: the stream ended mid-prefix or mid-body
    /// (fewer bytes than the declared length were available).
    Truncated {
        declared_len: usize,
        read_len: usize,
    },
    /// The declared frame length exceeds [`MAX_FRAME_BODY`]. The body is
    /// NEVER allocated or read — rejected on the prefix alone (no
    /// allocation amplification from an attacker-controlled length).
    Oversized { declared_len: usize, cap: usize },
    /// An underlying IO error that is not a clean EOF, reduced to a closed
    /// [`crate::io_failure_kind::IoFailureKind`] so no kernel-path-bearing
    /// `io::Error::Display` crosses a logging boundary.
    Io(crate::io_failure_kind::IoFailureKind),
}

impl FrameError {
    /// Stable `&'static str` label for tracing — never `?e` Debug-format a
    /// frame error (the closed-enum mapping rule).
    pub fn label(&self) -> &'static str {
        match self {
            FrameError::Eof => "eof",
            FrameError::Truncated { .. } => "truncated",
            FrameError::Oversized { .. } => "oversized",
            FrameError::Io(_) => "io",
        }
    }
}

fn io_err(e: std::io::Error) -> FrameError {
    FrameError::Io(crate::io_failure_kind::from_io_error_kind(e.kind()))
}

enum PrefixRead {
    Full,
    Eof,
}

/// Read exactly `buf.len()` bytes, or report a clean EOF (zero bytes
/// consumed) vs a truncated read (some bytes consumed, then EOF).
fn read_exact_or_eof<R: Read>(
    reader: &mut R,
    buf: &mut [u8],
    budget: Option<Budget>,
) -> Result<PrefixRead, FrameError> {
    let mut total = 0;
    while total < buf.len() {
        match reader.read(&mut buf[total..]) {
            Ok(0) => {
                if total == 0 {
                    return Ok(PrefixRead::Eof);
                }
                return Err(FrameError::Truncated {
                    declared_len: buf.len(),
                    read_len: total,
                });
            }
            Ok(n) => total += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(io_err(e)),
        }
        if budget.is_some_and(Budget::spent) {
            return Err(FrameError::Io(crate::io_failure_kind::from_io_error_kind(
                std::io::ErrorKind::TimedOut,
            )));
        }
    }
    Ok(PrefixRead::Full)
}

/// Read as many bytes as the stream offers (up to `buf.len()`), stopping at
/// a clean EOF without treating it as an error — the caller compares the
/// count read against the declared length to detect truncation.
fn read_up_to<R: Read>(
    reader: &mut R,
    buf: &mut [u8],
    budget: Option<Budget>,
) -> Result<usize, FrameError> {
    let mut total = 0;
    while total < buf.len() {
        if budget.is_some_and(Budget::spent) {
            return Err(FrameError::Io(crate::io_failure_kind::from_io_error_kind(
                std::io::ErrorKind::TimedOut,
            )));
        }
        match reader.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(io_err(e)),
        }
    }
    Ok(total)
}

/// A wall-clock ceiling on ONE frame read, checked between syscalls.
///
/// **Why the socket's own `SO_RCVTIMEO` is not this.** That option is a
/// PER-SYSCALL bound: it resets every time a read returns data. The loops in
/// this module read until the buffer fills, so a peer that sends one byte every
/// 9 s never trips a 10 s `SO_RCVTIMEO` and holds its handler thread for as long
/// as it likes. The rate limiter cannot charge such a peer anything either,
/// because it is checked after the frame is read. Sixteen of them reach the
/// command socket's in-flight cap and the door stops answering.
///
/// **Scoped to the READ, deliberately.** An earlier attempt at the same property
/// armed the socket module's watchdog on every connection, which put a hard
/// wall-clock bound from accept over the whole exchange INCLUDING dispatch. That
/// is a compute cap on a request that decrypts every candidate note, so a
/// healthy `myne list` on a large vault would be killed mid-flight and the CLI
/// would report a generic IO failure. The peer's pace is the thing that needs
/// bounding; the vault's size is not.
#[derive(Clone, Copy)]
pub struct Budget {
    started: std::time::Instant,
    limit: std::time::Duration,
}

impl Budget {
    pub fn new(limit: std::time::Duration) -> Self {
        Self {
            started: std::time::Instant::now(),
            limit,
        }
    }

    fn spent(self) -> bool {
        self.started.elapsed() >= self.limit
    }
}

/// Read one length-prefixed frame from `reader`, returning the raw body
/// bytes (content-agnostic — task 4 owns interpreting them).
///
/// Never panics on adversarial or malformed input: a declared length over
/// [`MAX_FRAME_BODY`] is rejected before any body allocation; a truncated
/// prefix or body is a typed error, never an `unwrap`/`expect`/index panic.
/// The budget is a REQUIRED argument rather than an `Option` with a default,
/// because a default here is the shape `AGENTS.md` records under "a guard
/// parameter with a default value is an opt-in guard": the arm that never fires
/// is the one a new call site silently takes, and the one call site that matters
/// is the socket. Every caller states whether its reader has a peer to pace.
/// `None` is correct for a `Cursor`, which cannot stall.
///
/// See [`Budget`] for why the socket's own `SO_RCVTIMEO` is not this, and why
/// the ceiling stops at the read rather than spanning the whole exchange.
pub fn read_frame_within<R: Read>(
    reader: &mut R,
    budget: Option<Budget>,
) -> Result<Vec<u8>, FrameError> {
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
    match read_exact_or_eof(reader, &mut prefix, budget)? {
        PrefixRead::Eof => return Err(FrameError::Eof),
        PrefixRead::Full => {}
    }
    let declared_len = u32::from_le_bytes(prefix) as usize;
    if declared_len > MAX_FRAME_BODY {
        return Err(FrameError::Oversized {
            declared_len,
            cap: MAX_FRAME_BODY,
        });
    }
    let mut body = vec![0u8; declared_len];
    let read_len = read_up_to(reader, &mut body, budget)?;
    if read_len != declared_len {
        return Err(FrameError::Truncated {
            declared_len,
            read_len,
        });
    }
    Ok(body)
}

/// Write one length-prefixed frame to `writer`. Refuses (rather than
/// truncates) a body over [`MAX_FRAME_BODY`] — an over-cap write is a
/// caller bug, not a wire condition to silently paper over.
///
/// Task 4's `dispatch::serve_connection` is the first production writer
/// (the command socket's reply path).
pub fn write_frame<W: Write>(writer: &mut W, body: &[u8]) -> Result<(), FrameError> {
    if body.len() > MAX_FRAME_BODY {
        return Err(FrameError::Oversized {
            declared_len: body.len(),
            cap: MAX_FRAME_BODY,
        });
    }
    let len = body.len() as u32;
    writer.write_all(&len.to_le_bytes()).map_err(io_err)?;
    writer.write_all(body).map_err(io_err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// A peer that hands over one byte at a time, slowly, without ever closing.
    ///
    /// The exact shape `Budget` exists for: every `read` returns data, so the
    /// socket's own `SO_RCVTIMEO` never fires, and the loop would otherwise run
    /// for as long as the peer keeps dribbling.
    struct Dribble {
        remaining: usize,
        per_read: std::time::Duration,
    }

    impl Read for Dribble {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.remaining == 0 || buf.is_empty() {
                return Ok(0);
            }
            std::thread::sleep(self.per_read);
            self.remaining -= 1;
            buf[0] = 0;
            Ok(1)
        }
    }

    #[test]
    fn a_dribbling_peer_is_cut_off_by_the_read_budget() {
        // 40 ms of budget against a peer offering one byte every 10 ms into a
        // four-byte length prefix. Without the budget this returns only when the
        // peer decides to stop.
        let mut peer = Dribble {
            remaining: 4096,
            per_read: std::time::Duration::from_millis(10),
        };
        let budget = Budget::new(std::time::Duration::from_millis(40));
        let started = std::time::Instant::now();
        let out = read_frame_within(&mut peer, Some(budget));
        let took = started.elapsed();

        assert!(
            matches!(out, Err(FrameError::Io(_))),
            "a spent budget must end the read as an IO failure, got {out:?}"
        );
        // A liveness ceiling rather than a bound under test: it only distinguishes
        // "the budget ended it" from "the peer did".
        assert!(
            took < std::time::Duration::from_secs(5),
            "the read ran for {took:?}, so the budget did not end it"
        );
    }

    #[test]
    fn no_budget_means_no_ceiling_and_the_same_peer_runs_on() {
        // The other direction, so the test above cannot pass because the reader
        // errors for some unrelated reason. The same peer with `None` gets
        // through its prefix and is bounded only by what it sends.
        let mut peer = Dribble {
            remaining: 4,
            per_read: std::time::Duration::from_millis(1),
        };
        // Four bytes of zero prefix, then EOF: a declared length of 0 and an
        // empty body, which is a legal frame.
        assert_eq!(read_frame_within(&mut peer, None), Ok(Vec::new()));
    }

    use super::*;
    use std::io::Cursor;

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut v = (body.len() as u32).to_le_bytes().to_vec();
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn round_trips_a_frame() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"hello").unwrap();
        let mut cur = Cursor::new(buf);
        assert_eq!(read_frame_within(&mut cur, None).unwrap(), b"hello");
    }

    #[test]
    fn empty_body_round_trips() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"").unwrap();
        let mut cur = Cursor::new(buf);
        assert_eq!(read_frame_within(&mut cur, None).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn clean_eof_at_a_frame_boundary_is_reported_not_panicked() {
        let mut cur = Cursor::new(Vec::<u8>::new());
        assert_eq!(read_frame_within(&mut cur, None), Err(FrameError::Eof));
    }

    #[test]
    fn truncated_prefix_is_reported_not_panicked() {
        let mut cur = Cursor::new(vec![1u8, 2]); // 2 of 4 prefix bytes
        match read_frame_within(&mut cur, None) {
            Err(FrameError::Truncated { .. }) => {}
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn truncated_body_is_reported_not_panicked() {
        let mut wire = (100u32).to_le_bytes().to_vec(); // declares 100 bytes
        wire.extend_from_slice(b"only three"); // far fewer than declared
        let mut cur = Cursor::new(wire);
        match read_frame_within(&mut cur, None) {
            Err(FrameError::Truncated {
                declared_len: 100,
                read_len: 10,
            }) => {}
            other => panic!("expected Truncated{{100,10}}, got {other:?}"),
        }
    }

    #[test]
    fn oversized_prefix_is_rejected_before_any_body_allocation() {
        // A declared length far past MAX_FRAME_BODY, with NO body bytes
        // following. If the code tried to allocate/read the body first this
        // would hang or panic; it must reject on the prefix alone.
        let declared = (MAX_FRAME_BODY + 1) as u32;
        let wire = declared.to_le_bytes().to_vec(); // prefix only, no body
        let mut cur = Cursor::new(wire);
        assert_eq!(
            read_frame_within(&mut cur, None),
            Err(FrameError::Oversized {
                declared_len: MAX_FRAME_BODY + 1,
                cap: MAX_FRAME_BODY,
            })
        );
    }

    #[test]
    fn write_refuses_an_over_cap_body() {
        let big = vec![b'a'; MAX_FRAME_BODY + 1];
        let mut buf = Vec::new();
        match write_frame(&mut buf, &big) {
            Err(FrameError::Oversized { .. }) => {}
            other => panic!("expected Oversized, got {other:?}"),
        }
        assert!(buf.is_empty(), "a refused write must not partially write");
    }

    #[test]
    fn a_batch_of_malformed_inputs_never_panics() {
        let cases: Vec<Vec<u8>> = vec![
            vec![],
            vec![0xFF],
            vec![0xFF, 0xFF, 0xFF, 0xFF], // declares ~4 GiB, no body
            vec![0, 0, 0, 0],             // declares 0 bytes — valid empty frame
            framed(b"{}"),
            {
                let mut v = framed(b"{}");
                v.truncate(v.len() - 1); // chop the last body byte
                v
            },
        ];
        for case in cases {
            let mut cur = Cursor::new(case);
            let _ = read_frame_within(&mut cur, None); // must return, never panic
        }
    }
}
