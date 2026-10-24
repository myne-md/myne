// SPDX-License-Identifier: AGPL-3.0
#![forbid(unsafe_code)]
//! `myne-mcp` — the MCP front-end to a Myne vault (external-mcp-connection
//! task 1; myne-md/myne#923).
//!
//! The binary is a Tauri `externalBin` sidecar, shipped inside the desktop
//! bundle beside `myne` and `myne-tor`, and put on PATH by the same launcher
//! the CLI uses (`src-tauri/src/cli_bridge/path_shim.rs`). A client's config
//! line is therefore `{"command": "myne-mcp"}`, with no path for the user to
//! discover.
//!
//! ## What this slice is, and what it is not
//!
//! It is the protocol half: speak MCP over stdio, select the revision the
//! client's first frame implies, and answer `tools/list` from a compiled-in
//! schema. It deliberately reaches no vault. The tool *calls* land in later
//! tasks, over the existing local door, and until they do a `tools/call` is
//! answered as an unknown method rather than with an invented failure shape.
//! That ordering is the point of the slice: a client can be configured and can
//! discover the surface while the vault is locked, before anything can read it.
//!
//! Three properties are structural rather than incidental:
//!
//! - **Nothing listens.** stdio to the client, and (from a later task) the
//!   existing 0600 Unix domain socket to the app. No port, no token, no
//!   pairing ceremony, no second lifecycle. `ai-no-network-check.sh` check 4
//!   flags `TcpListener::bind` and stays green because there is none to flag.
//! - **The tool list is compiled in.** [`tools::catalog`] is a constant
//!   expression over string literals, never derived from vault content or from
//!   anything a client sent. The tool-poisoning class depends on descriptions
//!   being data a note could influence; here a note cannot reach them at all,
//!   and `tools_test.rs` holds that with a scan for non-vault capabilities.
//! - **No key, no plaintext, no password prompt.** This process never opens the
//!   vault. It is a protocol adapter; the authority stays in the app.
//!
//! ## Two revisions, one surface
//!
//! [`protocol::revision_for_first_frame`] is the whole branch: an `initialize`
//! request as the first frame selects the older stateful revision, anything
//! else selects the current stateless one. Myne uses no server-initiated
//! feature, no subscriptions and no progress, so the two revisions converge
//! immediately after the handshake and share one dispatcher. A later revision
//! that this surface does use is a revisit, not an extension of the branch.

pub mod protocol;
pub mod serve;
pub mod server;
pub mod tools;

/// The stdio loop and its frame cap, re-exported at the crate root so `main`
/// reads as wiring rather than as a module path. The module and the function
/// share a name deliberately: there is one loop, and it is the thing the module
/// is about.
pub use serve::{serve, MAX_FRAME_BYTES};

#[cfg(test)]
mod protocol_test;
#[cfg(test)]
mod serve_test;
#[cfg(test)]
mod tools_test;
