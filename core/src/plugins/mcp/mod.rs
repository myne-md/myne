// SPDX-License-Identifier: AGPL-3.0
//! Host-side policy for an external MCP connection (external-mcp-connection,
//! myne-md/myne#923).
//!
//! The `myne-mcp` sidecar speaks MCP over stdio and forwards every `tools/call`
//! to the app over the existing local door. This module is the half that decides
//! what the answer may contain: resolving a declared connection name to its
//! frozen read scope ([`scope`]), the four read tools, each clamped to that
//! scope ([`tools`]), and the live-vault plumbing behind them ([`host_adapters`]).
//!
//! **One door, two front-ends.** The authority stays behind the same door the
//! `myne` CLI uses, so scope resolution, the rate limiter, the status marker and
//! the lifecycle are single-implementation. Nothing here opens a socket, holds a
//! key or reads a file: the vault arrives through [`tools::McpNoteSource`], which
//! the client supplies.
//!
//! **The scope is never taken from the caller.** It is resolved from the stored
//! grant ([`protocol::PrefsView::mcp_connections`], `DeviceLocal`) by name, so a
//! client can neither widen its own scope nor name a folder it was not granted.
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
//! The five write verbs the compiled catalog offers (`note_create`,
//! `note_append`, `note_set_field`, `note_move`, `note_edit`) are tasks 13 to 16
//! of the same feature. Until they land, [`tools::ToolName::from_wire`] answers
//! `None` for each of them and the door reports version skew. Recording that
//! here rather than letting a reader infer it: a verb the catalog advertises and
//! the host refuses looks identical to a scope bug from the client's side.

pub mod error;
pub mod scope;
pub mod tools;
/// What Settings shows: the connection list and the approval preview, both
/// resolved host-side so the counts on screen are the resolver's rather than a
/// second opinion about the scope.
pub mod view;

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
mod scope_test;
#[cfg(test)]
mod tools_test;
#[cfg(test)]
mod view_test;

#[cfg(all(test, not(target_arch = "wasm32")))]
mod host_adapters_test;
