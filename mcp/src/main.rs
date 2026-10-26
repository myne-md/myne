// SPDX-License-Identifier: AGPL-3.0
#![forbid(unsafe_code)]
//! The `myne-mcp` process entry point: wire stdio to [`myne_mcp::serve`].
//!
//! Everything interesting — the revision sniff, the dispatcher, the frame cap —
//! lives in the library so it can be tested without a subprocess. What is left
//! here is the wiring that genuinely needs one.

use std::io::{BufReader, BufWriter};
use std::process::ExitCode;

fn main() -> ExitCode {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut writer = BufWriter::new(stdout.lock());

    match myne_mcp::serve(&mut reader, &mut writer, myne_mcp::MAX_FRAME_BYTES) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
