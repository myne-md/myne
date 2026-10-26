// SPDX-License-Identifier: AGPL-3.0
//! The stdio loop, factored out of `main` so its refusals are testable without
//! a subprocess.
//!
//! MCP's stdio transport is one JSON-RPC message per line, so this is a line
//! reader and a line writer and nothing else. Two rules shape it:
//!
//! - **stdout carries protocol messages only.** A stray `println!` is a
//!   malformed frame to every client, so there are none here and there must be
//!   none later. Diagnostics, if any are ever needed, go to stderr.
//! - **The frame cap is enforced before the line is allocated.** A peer that
//!   sends a gigabyte with no newline must not make this process hold it; the
//!   same discipline `cli/src/framing.rs` applies to its length prefix, here
//!   applied to the only length the transport gives us (the line).
//!
//! The loop ends on EOF, which is what a client closing the pipe means, and it
//! holds no state beyond one [`Server`].

use std::io::{BufRead, ErrorKind, Write};

use crate::protocol;
use crate::server::Server;
use crate::transport::Transport;

/// One frame's ceiling. A `tools/list` response is a few kilobytes and a
/// `tools/call` argument is a note's worth of text, so four mebibytes is far
/// above any legitimate request and far below anything worth buffering.
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Serve MCP on one stream pair until the peer closes its end.
///
/// `max_frame_bytes` is a parameter rather than the constant so the cap can be
/// proved with an eight-byte fixture instead of a four-mebibyte one; production
/// always passes [`MAX_FRAME_BYTES`].
pub fn serve(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    max_frame_bytes: usize,
) -> std::io::Result<()> {
    serve_with(reader, writer, max_frame_bytes, Transport::new())
}

/// [`serve`], with the door client supplied.
///
/// The seam exists so a test can drive a whole session (one reader, one writer,
/// one [`Server`]) against a fake door in a temp dir while every frame still
/// travels the real stdio path. Production always takes [`Transport::new`].
pub fn serve_with(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    max_frame_bytes: usize,
    transport: Transport,
) -> std::io::Result<()> {
    serve_session(
        reader,
        writer,
        max_frame_bytes,
        &mut Server::with_transport(transport),
    )
}

/// [`serve_with`] over an already-built [`Server`], so a test can pin the
/// session's own state (the declared connection name) instead of mutating the
/// process environment, which no test can do safely beside its siblings.
#[cfg(test)]
pub fn serve_with_server(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    max_frame_bytes: usize,
    server: &mut Server,
) -> std::io::Result<()> {
    serve_session(reader, writer, max_frame_bytes, server)
}

/// The loop itself: one line in, at most one line out, until EOF.
fn serve_session(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    max_frame_bytes: usize,
    server: &mut Server,
) -> std::io::Result<()> {
    let mut line = Vec::new();
    loop {
        line.clear();
        // `take` per line, so the cap bounds the allocation rather than
        // rejecting an oversized line after it has already been read. UFCS
        // rather than `reader.take(..)` on purpose: on a `&mut impl BufRead`
        // the method form resolves to the `Read` impl for the referent and
        // tries to move it, which does not compile.
        let mut limited = std::io::Read::take(&mut *reader, max_frame_bytes as u64 + 1);
        let read = match limited.read_until(b'\n', &mut line) {
            Ok(read) => read,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if read == 0 {
            return Ok(());
        }
        // The cap counts the frame's body, not its line terminator, so a frame
        // of exactly `max_frame_bytes` is legal. `take` above reads at most one
        // byte past the cap, which is exactly enough to tell the two apart
        // without ever holding an unbounded line.
        let body_len = line
            .strip_suffix(b"\n")
            .map_or(line.len(), |body| body.len());
        if body_len > max_frame_bytes {
            write_reply(
                writer,
                &protocol::error_response(
                    serde_json::Value::Null,
                    protocol::INVALID_REQUEST,
                    "Request exceeds the maximum frame size",
                ),
            )?;
            // The rest of an oversized line is still unread, so there is no
            // frame boundary left to trust. Ending the session is honest: the
            // client sees the refusal and a closed pipe rather than a stream
            // that silently drops half a message and resynchronises on
            // whatever follows.
            return Ok(());
        }

        let frame = match std::str::from_utf8(&line) {
            Ok(frame) => frame,
            Err(_) => {
                write_reply(
                    writer,
                    &protocol::error_response(
                        serde_json::Value::Null,
                        protocol::PARSE_ERROR,
                        "Parse error",
                    ),
                )?;
                continue;
            }
        };
        if frame.trim().is_empty() {
            continue;
        }

        if let Some(reply) = server.handle(frame) {
            write_reply(writer, &reply)?;
        }
    }
}

/// One reply, flushed. The flush is a protocol requirement rather than an
/// optimisation: a client is blocked waiting for this reply and will not send
/// the next frame until it arrives.
pub fn write_reply(writer: &mut impl Write, reply: &serde_json::Value) -> std::io::Result<()> {
    let body = serde_json::to_string(reply)
        .map_err(|_| std::io::Error::new(ErrorKind::InvalidData, "reply is not serialisable"))?;
    writer.write_all(body.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}
