// SPDX-License-Identifier: AGPL-3.0
//! Host-side policy for an external MCP connection (external-mcp-connection,
//! myne-md/myne#923).
//!
//! The `myne-mcp` sidecar speaks MCP over stdio and forwards every `tools/call`
//! to the app over the existing local door. This module is the half that decides
//! what the answer may contain: resolving a declared connection name to its
//! frozen read scope ([`scope`]), and the four read tools, each clamped to that
//! scope ([`tools`]).
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
//! ## What is not here yet
//!
//! No Tauri command and no door arm. The door's `mcp_call` request variant and
//! the `McpNoteSource` implementation over the live vault are the desktop's
//! wiring of this policy; until they land, this module is exercised by its own
//! tests and by whichever host arm arrives next. Recording that here rather than
//! letting a reader infer it: a module nothing calls looks identical to one
//! everything calls, and only one of those is a defect.

pub mod error;
pub mod scope;
pub mod tools;

#[cfg(test)]
mod scope_test;
#[cfg(test)]
mod tools_test;
