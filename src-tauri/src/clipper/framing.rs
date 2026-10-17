// SPDX-License-Identifier: AGPL-3.0
//! Native-messaging length-prefixed framing reader/writer (TB10).
//!
//! The Chrome/Firefox native-messaging wire format is a 4-byte
//! **little-endian** `u32` length prefix followed by exactly that many
//! bytes of UTF-8 JSON, on stdin (ext→host) / stdout (host→ext).
//!
//! This module owns ONLY the wire framing — read a length-prefixed frame,
//! write a length-prefixed frame, with the size caps enforced AT THE
//! FRAME BOUNDARY so a hostile or buggy sender can never make the host
//! allocate an unbounded buffer or block forever waiting for a frame body
//! it will never receive. Content validation (UTF-8, path-traversal, MIME
//! re-sniff, the note-body sub-cap) lives in [`super::validation`]; this
//! module is deliberately content-agnostic — it returns raw bytes.
//!
//! ## Untrusted-input discipline (TB10)
//!
//! This is an EXTERNAL ingress NOT governed by the Tauri capability ACL
//! (TB6). Every byte arriving here is hostile (A14 — a compromised
//! extension build, or any local process that learned the native-host
//! manifest path). The framing reader therefore:
//!
//! - reads the 4-byte prefix and rejects a frame whose declared length
//!   exceeds [`MAX_EXT_TO_HOST_FRAME`] **before allocating the body
//!   buffer** (no `Vec::with_capacity(attacker_u32)` amplification);
//! - treats a short read on the prefix or the body as a TRUNCATED frame
//!   and returns a typed error — never a panic, never a silent partial
//!   accept;
//! - on the writer side, refuses to emit a reply larger than
//!   [`MAX_HOST_TO_EXT_REPLY`] (the ACK/confirm channel stays tiny).
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — frame
//! bodies carry note plaintext (the same secret class as `password`);
//! this module never logs a frame body, only the closed [`FrameError`]
//! variant name and the (non-secret) declared/observed lengths.

use std::io::{Read, Write};

use super::{MAX_EXT_TO_HOST_FRAME, MAX_HOST_TO_EXT_REPLY};

/// The native-messaging length prefix is a fixed 4-byte little-endian
/// `u32` (Chrome/Firefox wire format). Named so the read/write sites and
/// the tests share one source of truth.
pub const LENGTH_PREFIX_BYTES: usize = 4;

/// Closed failure taxonomy for the framing layer.
///
/// No payload carries a frame body or an OS path — every variant is a
/// bounded, DENY-list-clean value (a variant name, or non-secret
/// declared/observed byte counts). A `FrameError` is the host's signal to
/// abort the current frame without panicking; the caller decides whether
/// to stay silent (unpaired) or emit a bounded error reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// The peer closed the stream cleanly at a frame boundary — the
    /// 4-byte length prefix could not be read because EOF arrived first
    /// with ZERO bytes consumed. This is the normal "extension
    /// disconnected" signal, not a hostile event; the host loop exits
    /// quietly on it.
    Eof,

    /// A frame was truncated: the stream ended mid-prefix or mid-body
    /// (fewer bytes than the declared length were available). Carries the
    /// declared body length and the number of body bytes actually read so
    /// the failure is diagnosable without ever logging the bytes.
    Truncated {
        /// The body length the 4-byte prefix declared.
        declared_len: usize,
        /// How many body bytes were actually read before EOF.
        read_len: usize,
    },

    /// The declared frame length exceeds [`MAX_EXT_TO_HOST_FRAME`]. The
    /// body is NEVER allocated or read — the host rejects on the prefix
    /// alone (no allocation amplification). Carries the declared length
    /// and the cap so the caller can surface a precise rejection.
    Oversized {
        /// The body length the 4-byte prefix declared.
        declared_len: usize,
        /// The enforced cap ([`MAX_EXT_TO_HOST_FRAME`]).
        cap: usize,
    },

    /// A host→ext reply exceeded [`MAX_HOST_TO_EXT_REPLY`] at write time.
    /// The reply channel is bounded tiny by contract (SYNC-10); a reply
    /// over the cap is a host-side bug (the host composes the reply), so
    /// this is refused rather than truncated.
    ///
    /// Constructed by [`write_frame`] on the task-5 reply path
    /// (`host::run_envelope_loop` → `framing::write_frame`).
    ReplyOversized {
        /// The reply body length the host attempted to write.
        len: usize,
        /// The enforced cap ([`MAX_HOST_TO_EXT_REPLY`]).
        cap: usize,
    },

    /// An underlying IO error on the stream that is not a clean EOF.
    /// Reduced to a closed [`crate::io_failure_kind::IoFailureKind`] so no
    /// kernel-path-bearing `io::Error::Display` crosses a logging or IPC
    /// boundary.
    Io(crate::io_failure_kind::IoFailureKind),
}

impl FrameError {
    /// Stable `&'static str` label for tracing (the closed-enum mapping
    /// rule — never `?e` Debug-format a frame error, use this helper so a
    /// new variant compile-fails the match instead of silently widening
    /// what is logged).
    pub fn label(&self) -> &'static str {
        match self {
            FrameError::Eof => "eof",
            FrameError::Truncated { .. } => "truncated",
            FrameError::Oversized { .. } => "oversized",
            FrameError::ReplyOversized { .. } => "reply_oversized",
            FrameError::Io(_) => "io",
        }
    }
}

/// Read one length-prefixed native-messaging frame from `reader`,
/// returning the raw body bytes (content-agnostic — UTF-8 + the
/// note-body sub-cap are [`super::validation`]'s job).
///
/// Wire format: a 4-byte little-endian `u32` length prefix, then exactly
/// that many body bytes.
///
/// Rejection discipline (every byte is hostile):
/// - a clean EOF at the frame boundary → [`FrameError::Eof`] (normal
///   disconnect; the loop exits quietly);
/// - a prefix that declares more than [`MAX_EXT_TO_HOST_FRAME`] →
///   [`FrameError::Oversized`] **before any body allocation**;
/// - fewer body bytes available than declared → [`FrameError::Truncated`];
/// - any other IO failure → [`FrameError::Io`] (closed-enum reduced).
///
/// Never panics on adversarial input.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Vec<u8>, FrameError> {
    // --- length prefix --------------------------------------------------
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
    match read_exact_or_eof(reader, &mut prefix)? {
        PrefixRead::Eof => return Err(FrameError::Eof),
        PrefixRead::Partial(read_len) => {
            // The stream ended mid-prefix: a truncated header. We declare
            // length 0 (unknown — we never saw the full prefix) and report
            // the partial byte count so the failure is diagnosable.
            return Err(FrameError::Truncated {
                declared_len: 0,
                read_len,
            });
        }
        PrefixRead::Full => {}
    }

    // Little-endian per the native-messaging wire contract.
    let declared_len = u32::from_le_bytes(prefix) as usize;

    // --- cap check BEFORE allocation -----------------------------------
    // The cap is enforced on the DECLARED length so a hostile prefix can
    // never drive an unbounded `Vec` allocation: we reject on the 4-byte
    // prefix alone and never touch the body.
    if declared_len > MAX_EXT_TO_HOST_FRAME {
        return Err(FrameError::Oversized {
            declared_len,
            cap: MAX_EXT_TO_HOST_FRAME,
        });
    }

    // A zero-length frame is structurally valid at the framing layer
    // (validation will reject empty JSON downstream).
    let mut body = vec![0u8; declared_len];
    let read_len = read_full(reader, &mut body)?;
    if read_len != declared_len {
        return Err(FrameError::Truncated {
            declared_len,
            read_len,
        });
    }

    Ok(body)
}

/// Write one length-prefixed native-messaging reply to `writer`.
///
/// Refuses a reply larger than [`MAX_HOST_TO_EXT_REPLY`]
/// ([`FrameError::ReplyOversized`]) — the confirm/ACK channel is bounded
/// tiny by contract (SYNC-10). On success the 4-byte little-endian prefix
/// plus the body are flushed.
///
/// Called by `host::run_envelope_loop` (via `host::act_on_outcome`) to emit
/// the tiny `accepted | error | locked` reply composed by
/// [`super::envelope::encode_reply`] (the task-5 reply path).
pub fn write_frame<W: Write>(writer: &mut W, body: &[u8]) -> Result<(), FrameError> {
    // The reply/ACK channel is bounded tiny by contract (SYNC-10).
    write_frame_capped(writer, body, MAX_HOST_TO_EXT_REPLY)
}

/// Write a length-prefixed frame, refusing a body larger than `cap`.
///
/// The reply path passes the tiny [`MAX_HOST_TO_EXT_REPLY`]; the host→app
/// FORWARD path (`relay::forward_stdio_over_socket`) passes
/// [`MAX_EXT_TO_HOST_FRAME`] — a frame `read_frame` already accepted (up to 64
/// MiB). Capping the forward at the reply size silently dropped every clip
/// larger than 1 MiB (e.g. any image-bearing capture, which JSON-inflates ~3-4×).
pub fn write_frame_capped<W: Write>(
    writer: &mut W,
    body: &[u8],
    cap: usize,
) -> Result<(), FrameError> {
    if body.len() > cap {
        return Err(FrameError::ReplyOversized {
            len: body.len(),
            cap,
        });
    }
    // `cap` is at most MAX_EXT_TO_HOST_FRAME (64 MiB) < u32::MAX and `body.len()`
    // is bounded by the check above, so the `as u32` truncation is lossless.
    let prefix = (body.len() as u32).to_le_bytes();
    writer
        .write_all(&prefix)
        .map_err(|e| FrameError::Io(crate::io_failure_kind::from_io_error_kind(e.kind())))?;
    writer
        .write_all(body)
        .map_err(|e| FrameError::Io(crate::io_failure_kind::from_io_error_kind(e.kind())))?;
    writer
        .flush()
        .map_err(|e| FrameError::Io(crate::io_failure_kind::from_io_error_kind(e.kind())))?;
    Ok(())
}

/// Outcome of attempting to fill the fixed-size length prefix.
enum PrefixRead {
    /// All [`LENGTH_PREFIX_BYTES`] were read.
    Full,
    /// EOF arrived with zero bytes read — a clean frame-boundary close.
    Eof,
    /// EOF arrived after `n` (`0 < n < LENGTH_PREFIX_BYTES`) bytes — a
    /// truncated header.
    Partial(usize),
}

/// Read exactly `buf.len()` bytes, distinguishing a clean boundary EOF
/// (zero bytes) from a mid-prefix truncation (some bytes) from success.
fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<PrefixRead, FrameError> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => {
                return Ok(if filled == 0 {
                    PrefixRead::Eof
                } else {
                    PrefixRead::Partial(filled)
                });
            }
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                return Err(FrameError::Io(crate::io_failure_kind::from_io_error_kind(
                    e.kind(),
                )))
            }
        }
    }
    Ok(PrefixRead::Full)
}

/// Read up to `buf.len()` body bytes, returning how many were read before
/// EOF. A short count is surfaced by the caller as [`FrameError::Truncated`].
fn read_full<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<usize, FrameError> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                return Err(FrameError::Io(crate::io_failure_kind::from_io_error_kind(
                    e.kind(),
                )))
            }
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Build a wire frame: 4-byte LE length prefix + body. Test helper.
    fn framed(body: &[u8]) -> Vec<u8> {
        let mut v = (body.len() as u32).to_le_bytes().to_vec();
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn write_frame_capped_accepts_above_reply_cap_up_to_forward_cap() {
        // A 2 MiB body (over the 1 MiB reply cap) must succeed at the 64 MiB
        // forward cap — the clip-forward path a plain write_frame silently broke.
        let body = vec![0xABu8; 2 * 1024 * 1024];
        let mut out = Vec::new();
        write_frame_capped(&mut out, &body, MAX_EXT_TO_HOST_FRAME).expect("under forward cap");
        let mut cursor = Cursor::new(out);
        assert_eq!(read_frame(&mut cursor).expect("read back"), body);
    }

    #[test]
    fn write_frame_capped_rejects_above_cap() {
        let mut out = Vec::new();
        let err = write_frame_capped(&mut out, &[0u8; 8], 4).unwrap_err();
        assert!(matches!(err, FrameError::ReplyOversized { len: 8, cap: 4 }));
    }

    #[test]
    fn write_frame_still_enforces_the_tiny_reply_cap() {
        let body = vec![0u8; MAX_HOST_TO_EXT_REPLY + 1];
        let mut out = Vec::new();
        assert!(matches!(
            write_frame(&mut out, &body).unwrap_err(),
            FrameError::ReplyOversized { .. }
        ));
    }

    #[test]
    fn frame_round_trips() {
        let payload = br#"{"markdown":"hello"}"#;
        // Write through the writer, read back through the reader.
        let mut out = Vec::new();
        write_frame(&mut out, payload).expect("write must succeed");
        let mut cursor = Cursor::new(out);
        let got = read_frame(&mut cursor).expect("read must succeed");
        assert_eq!(got, payload);
    }

    #[test]
    fn empty_body_frame_round_trips() {
        let mut out = Vec::new();
        write_frame(&mut out, b"").expect("write must succeed");
        // 4-byte prefix declaring 0, no body.
        assert_eq!(out, vec![0, 0, 0, 0]);
        let mut cursor = Cursor::new(out);
        let got = read_frame(&mut cursor).expect("read must succeed");
        assert_eq!(got, b"");
    }

    #[test]
    fn prefix_is_little_endian() {
        // A 1-byte body → prefix bytes [1,0,0,0] (LE), not [0,0,0,1] (BE).
        let mut out = Vec::new();
        write_frame(&mut out, b"x").expect("write must succeed");
        assert_eq!(&out[..LENGTH_PREFIX_BYTES], &[1, 0, 0, 0]);
    }

    #[test]
    fn reads_multiple_back_to_back_frames() {
        let mut wire = Vec::new();
        wire.extend_from_slice(&framed(b"first"));
        wire.extend_from_slice(&framed(b"second"));
        let mut cursor = Cursor::new(wire);
        assert_eq!(read_frame(&mut cursor).unwrap(), b"first");
        assert_eq!(read_frame(&mut cursor).unwrap(), b"second");
        // A clean EOF at the boundary after the last frame.
        assert_eq!(read_frame(&mut cursor), Err(FrameError::Eof));
    }

    #[test]
    fn clean_eof_at_boundary_is_eof_not_truncated() {
        // Empty stream → the first prefix read hits EOF with zero bytes.
        let mut cursor = Cursor::new(Vec::<u8>::new());
        assert_eq!(read_frame(&mut cursor), Err(FrameError::Eof));
    }

    #[test]
    fn truncated_prefix_is_rejected_without_panic() {
        // Only 2 of the 4 prefix bytes present.
        let mut cursor = Cursor::new(vec![0x10, 0x00]);
        match read_frame(&mut cursor) {
            Err(FrameError::Truncated { read_len, .. }) => assert_eq!(read_len, 2),
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn truncated_body_is_rejected_without_panic() {
        // Prefix declares 10 bytes, only 4 are present.
        let mut wire = (10u32).to_le_bytes().to_vec();
        wire.extend_from_slice(b"abcd");
        let mut cursor = Cursor::new(wire);
        match read_frame(&mut cursor) {
            Err(FrameError::Truncated {
                declared_len,
                read_len,
            }) => {
                assert_eq!(declared_len, 10);
                assert_eq!(read_len, 4);
            }
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn oversized_frame_is_rejected_on_prefix_without_allocating_body() {
        // Declare a length one byte over the cap. The body is NOT present
        // in the stream at all — proving the reject happens on the prefix
        // alone, before any body read/allocation. A real frame this size
        // would never be allocated, which is the whole point.
        let declared = (MAX_EXT_TO_HOST_FRAME + 1) as u32;
        let wire = declared.to_le_bytes().to_vec(); // prefix only, no body
        let mut cursor = Cursor::new(wire);
        match read_frame(&mut cursor) {
            Err(FrameError::Oversized { declared_len, cap }) => {
                assert_eq!(declared_len, MAX_EXT_TO_HOST_FRAME + 1);
                assert_eq!(cap, MAX_EXT_TO_HOST_FRAME);
            }
            other => panic!("expected Oversized, got {other:?}"),
        }
    }

    #[test]
    fn frame_exactly_at_cap_is_accepted() {
        // A frame whose declared length is exactly the cap is allowed
        // (the cap is inclusive). Use a small stand-in body but declare
        // the cap? No — we must actually provide the bytes for a non-
        // truncated read, which would be 64 MiB. Instead assert the
        // boundary logic directly: a declared length == cap must NOT be
        // Oversized. We test with a tiny real cap-sized check via the
        // prefix path by declaring `cap` and providing a truncation — the
        // error must be Truncated (passed the cap gate), never Oversized.
        let declared = MAX_EXT_TO_HOST_FRAME as u32;
        let wire = declared.to_le_bytes().to_vec(); // no body → truncated
        let mut cursor = Cursor::new(wire);
        match read_frame(&mut cursor) {
            Err(FrameError::Truncated { declared_len, .. }) => {
                assert_eq!(declared_len, MAX_EXT_TO_HOST_FRAME);
            }
            other => panic!("expected Truncated (cap gate passed), got {other:?}"),
        }
    }

    #[test]
    fn reply_over_cap_is_refused_not_truncated() {
        let oversized = vec![b'x'; MAX_HOST_TO_EXT_REPLY + 1];
        let mut out = Vec::new();
        match write_frame(&mut out, &oversized) {
            Err(FrameError::ReplyOversized { len, cap }) => {
                assert_eq!(len, MAX_HOST_TO_EXT_REPLY + 1);
                assert_eq!(cap, MAX_HOST_TO_EXT_REPLY);
            }
            other => panic!("expected ReplyOversized, got {other:?}"),
        }
        // Nothing was written — refusal, not truncation.
        assert!(out.is_empty());
    }

    #[test]
    fn reply_exactly_at_cap_is_accepted() {
        let at_cap = vec![b'x'; MAX_HOST_TO_EXT_REPLY];
        let mut out = Vec::new();
        write_frame(&mut out, &at_cap).expect("a reply exactly at the cap is allowed");
        assert_eq!(out.len(), LENGTH_PREFIX_BYTES + MAX_HOST_TO_EXT_REPLY);
    }

    #[test]
    fn error_labels_are_stable() {
        assert_eq!(FrameError::Eof.label(), "eof");
        assert_eq!(
            FrameError::Truncated {
                declared_len: 0,
                read_len: 0
            }
            .label(),
            "truncated"
        );
        assert_eq!(
            FrameError::Oversized {
                declared_len: 0,
                cap: 0
            }
            .label(),
            "oversized"
        );
        assert_eq!(
            FrameError::ReplyOversized { len: 0, cap: 0 }.label(),
            "reply_oversized"
        );
        assert_eq!(
            FrameError::Io(crate::io_failure_kind::IoFailureKind::Other).label(),
            "io"
        );
    }
}
