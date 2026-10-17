// SPDX-License-Identifier: AGPL-3.0
//! Length-prefixed frame reader/writer for the CLI bridge command socket —
//! the CLI's own copy, mirroring `src-tauri/src/cli_bridge/framing.rs`
//! exactly (a 4-byte little-endian length prefix, the cap enforced BEFORE
//! the body is allocated, no panic on truncated/oversized/malformed input).
//!
//! Deliberately a separate, independent implementation rather than a shared
//! crate dependency — same "own the cap for this surface, not a shared
//! type" reasoning the desktop-side module's own doc comment states for why
//! it didn't reuse `clipper::framing`'s cap. This binary must never depend
//! on `myne-desktop`.

use std::io::{Read, Write};

/// The length prefix is a fixed 4-byte little-endian `u32`.
pub const LENGTH_PREFIX_BYTES: usize = 4;

/// Bound on one frame body — matches the desktop side's own
/// `MAX_FRAME_BODY` (16 MiB). Rejecting a declared length over this cap
/// BEFORE any allocation guards against a hostile/buggy peer on either
/// side, even though both sides run as the same OS user.
pub const MAX_FRAME_BODY: usize = 16 * 1024 * 1024;

/// Closed failure taxonomy for the framing layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// The peer closed the stream cleanly at a frame boundary.
    Eof,
    /// A frame was truncated: fewer bytes than the declared length arrived.
    Truncated {
        declared_len: usize,
        read_len: usize,
    },
    /// The declared frame length exceeds [`MAX_FRAME_BODY`]; the body is
    /// never allocated or read.
    Oversized { declared_len: usize, cap: usize },
    /// An underlying IO error that is not a clean EOF.
    Io(std::io::ErrorKind),
}

impl FrameError {
    pub fn label(&self) -> &'static str {
        match self {
            FrameError::Eof => "eof",
            FrameError::Truncated { .. } => "truncated",
            FrameError::Oversized { .. } => "oversized",
            FrameError::Io(_) => "io",
        }
    }
}

enum PrefixRead {
    Full,
    Eof,
}

fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<PrefixRead, FrameError> {
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
            Err(e) => return Err(FrameError::Io(e.kind())),
        }
    }
    Ok(PrefixRead::Full)
}

fn read_up_to<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<usize, FrameError> {
    let mut total = 0;
    while total < buf.len() {
        match reader.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FrameError::Io(e.kind())),
        }
    }
    Ok(total)
}

/// Read one length-prefixed frame, returning the raw body bytes. Never
/// panics on adversarial or malformed input.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Vec<u8>, FrameError> {
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
    match read_exact_or_eof(reader, &mut prefix)? {
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
    let read_len = read_up_to(reader, &mut body)?;
    if read_len != declared_len {
        return Err(FrameError::Truncated {
            declared_len,
            read_len,
        });
    }
    Ok(body)
}

/// Write one length-prefixed frame. Refuses (rather than truncates) a body
/// over [`MAX_FRAME_BODY`].
pub fn write_frame<W: Write>(writer: &mut W, body: &[u8]) -> Result<(), FrameError> {
    if body.len() > MAX_FRAME_BODY {
        return Err(FrameError::Oversized {
            declared_len: body.len(),
            cap: MAX_FRAME_BODY,
        });
    }
    let len = body.len() as u32;
    writer
        .write_all(&len.to_le_bytes())
        .map_err(|e| FrameError::Io(e.kind()))?;
    writer
        .write_all(body)
        .map_err(|e| FrameError::Io(e.kind()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
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
        assert_eq!(read_frame(&mut cur).unwrap(), b"hello");
    }

    #[test]
    fn empty_body_round_trips() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"").unwrap();
        let mut cur = Cursor::new(buf);
        assert_eq!(read_frame(&mut cur).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn clean_eof_at_a_frame_boundary_is_reported_not_panicked() {
        let mut cur = Cursor::new(Vec::<u8>::new());
        assert_eq!(read_frame(&mut cur), Err(FrameError::Eof));
    }

    #[test]
    fn truncated_prefix_is_reported_not_panicked() {
        let mut cur = Cursor::new(vec![1u8, 2]);
        match read_frame(&mut cur) {
            Err(FrameError::Truncated { .. }) => {}
            other => panic!("expected Truncated, got {other:?}"),
        }
    }

    #[test]
    fn oversized_prefix_is_rejected_before_any_body_allocation() {
        let declared = (MAX_FRAME_BODY + 1) as u32;
        let wire = declared.to_le_bytes().to_vec();
        let mut cur = Cursor::new(wire);
        assert_eq!(
            read_frame(&mut cur),
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
        assert!(buf.is_empty());
    }

    #[test]
    fn a_batch_of_malformed_inputs_never_panics() {
        let cases: Vec<Vec<u8>> = vec![
            vec![],
            vec![0xFF],
            vec![0xFF, 0xFF, 0xFF, 0xFF],
            vec![0, 0, 0, 0],
            framed(b"{}"),
            {
                let mut v = framed(b"{}");
                v.truncate(v.len() - 1);
                v
            },
        ];
        for case in cases {
            let mut cur = Cursor::new(case);
            let _ = read_frame(&mut cur);
        }
    }
}
