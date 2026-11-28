// SPDX-License-Identifier: AGPL-3.0-only
//! Host-side policy for an external MCP connection (external-mcp-connection,
//! myne-md/myne#923).
//!
//! The `myne-mcp` sidecar speaks MCP over stdio and forwards every `tools/call`
//! to the app over the existing local door. This module is the half that decides
//! what the answer may contain: resolving a declared connection name to its
//! read scope ([`scope`]), the four read tools, each clamped to that scope
//! ([`tools`]), and the live-vault plumbing behind them ([`host_adapters`]).
//!
//! The read scope is a DENY list: everything in the vault except the folders the
//! user left out on the approval screen. A folder created afterwards is therefore
//! inside the approval, which is the property the allow-list model this replaced
//! did not have.
//!
//! **One door, two front-ends.** The authority stays behind the same door the
//! `myne` CLI uses, so scope resolution, the rate limiter, the status marker and
//! the lifecycle are single-implementation. Nothing here opens a socket, holds a
//! key or reads a file: the vault arrives through [`tools::McpNoteSource`], which
//! the client supplies.
//!
//! **The scope is never taken from the caller.** It is resolved from the stored
//! grant ([`protocol::PrefsView::mcp_connections`], `DeviceLocal`) by name, so a
//! client can neither widen its own scope nor name a folder the user left out.
//! The write grant is a separate, narrower set (a later slice) and is not
//! readable from here at all.
//!
//! ## How a call arrives
//!
//! `myne-mcp` writes `{"cmd":"mcp_call","tool":…,"arguments":…,"connection":…}`
//! over the CLI door's 0600 Unix socket; `src-tauri/src/cli_bridge/dispatch.rs`
//! owns that wire variant and its reply envelope, and its `NoteLister::mcp_call`
//! arm is a ten-line wrapper over [`host_adapters::door_call`], which is where
//! the prefs read, the index snapshot and the folder set live. There is no
//! second socket, no listener and no path around the door's rate limiter: a
//! refused call is counted before this module is ever reached.
//!
//! ## What is not here yet
//!
//! Nothing. The surface is the thirteen verbs the catalog advertises, and
//! `note_set_field` is one of them: it carries a `view_id`, because the host's
//! field write is VIEW-scoped (the field must be declared writable by a view
//! approved on this device, and a marker is refused), so the view is where the
//! authority comes from rather than something this surface invents. It was
//! advertised here for a while with no dispatch arm, which is what
//! `mcp/src/surface_test.rs` now makes impossible; this paragraph stays so a
//! reader can tell a deliberate absence from a forgotten verb.
//!
//! The write half is an ALLOW list where the read half beside it is a DENY list
//! ([`write_scope`]), an empty write grant means "nowhere" where an empty exclusion
//! list means "everything", and every change takes a restore point first
//! ([`intent`]). A write into a readable folder the user did not name for writing
//! is queued as a proposal ([`queue`]) rather than refused, because a refusal is
//! answered by a client retrying.

/// The anchored edit and the move, over the agent path's own `place` and
/// `move_note`. What is new here is only the write-grant check, the restore point
/// and the closed reasons: a second anchored-edit implementation is where the
/// exactly-once rule and the frontmatter clamps would quietly diverge.
pub mod anchor;
/// How many notes one connection may take out per window, held in process state
/// (mcp external access rework, myne-md/myne#1052). The unit is notes rather than
/// calls, because one search is one call and fifty notes.
pub mod budget;
pub mod error;
/// The write verbs, as host-validated intents with a restore point taken before
/// every change. The read tools clamp and answer; these decide, queue or refuse,
/// and never write without the pre-write bytes having been kept first.
pub mod intent;
/// What a connection may write, resolved from the same grant through the
/// opposite model: an allow list of named folders, where the read scope beside it
/// is a deny list. Kept a separate type on purpose, because a scope carrying both
/// halves is the place a caller eventually hands the wrong one to a verb.
pub mod queue;
pub mod scope;
pub mod tools;
/// What Settings shows: the connection list and the approval preview, both
/// resolved host-side so the counts on screen are the resolver's rather than a
/// second opinion about the scope.
pub mod view;
pub mod write_scope;

/// The live-vault source and the door's call pipeline. Not part of the wasm
/// build: the door is a desktop surface, and the web client has no sidecar to
/// answer.
#[cfg(not(target_arch = "wasm32"))]
pub mod host_adapters;

/// The Settings surface's two reads. Desktop only for the same reason as
/// [`host_adapters`], one level up: the section that calls them is rendered only
/// where the capability exists, and the browser has no MCP surface to describe.
#[cfg(not(target_arch = "wasm32"))]
pub mod commands;

#[cfg(test)]
mod anchor_test;
#[cfg(test)]
mod budget_test;
#[cfg(test)]
mod intent_test;
#[cfg(test)]
mod scope_test;
#[cfg(test)]
mod tools_test;
#[cfg(test)]
mod view_test;
#[cfg(test)]
mod write_scope_test;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod host_adapters_test;
