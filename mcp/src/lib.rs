// SPDX-License-Identifier: AGPL-3.0-only
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
//! It speaks MCP over stdio, selects the revision the client's first frame
//! implies, and answers discovery (`tools/list` and `server/discover`) from a
//! compiled-in schema. A `tools/call` is forwarded to the app over the existing
//! local door, and answered here only when there is no door to ask: the vault is
//! locked, external access is off, or the app is not running. Each of those
//! returns a structured tool error naming the state plus one actionable
//! sentence, and the client's session survives all three.
//!
//! What this binary still does NOT do is the part that needs a vault: resolve a
//! connection's read scope against the store of folders the user left out, clamp
//! a read to it, take a snapshot before a write or refuse a write outside its
//! grant. Those live host-side, behind the same
//! door the CLI uses, so one implementation is the authority for both
//! front-ends. That ordering is also what lets a client be configured and
//! discover the surface while the vault is locked, before anything can read it.
//!
//! Three properties are structural rather than incidental:
//!
//! - **Nothing listens.** stdio to the client, and the app's existing 0600 Unix
//!   domain socket to the door. No port, no token, no pairing ceremony, no
//!   second lifecycle. The AI egress ratchet does not scan this crate, and that
//!   omission is a decision with a binding constraint attached to it, stated in
//!   full at [`transport`].
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

pub mod dispatch;
pub mod errors;
pub mod protocol;
pub mod serve;
pub mod server;
pub mod status;
pub mod tool_list;
pub mod tools;
pub mod transport;

/// The stdio loop and its frame cap, re-exported at the crate root so `main`
/// reads as wiring rather than as a module path. The module and the function
/// share a name deliberately: there is one loop, and it is the thing the module
/// is about.
pub use serve::{serve, MAX_FRAME_BYTES};

#[cfg(test)]
mod dispatch_test;
#[cfg(test)]
mod protocol_test;
#[cfg(test)]
mod serve_test;
#[cfg(test)]
mod surface_test;
#[cfg(test)]
mod tools_test;
#[cfg(test)]
mod transport_test;
