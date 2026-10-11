// SPDX-License-Identifier: AGPL-3.0
//! The live co-editing session core (epic live-collab, `collab-editor-bridge`).
//!
//! This is the Rust-core side of the collaborative editor bridge: the
//! authoritative per-note Automerge document (a [`session::LiveSession`]), the
//! per-device [`state::LiveSessionRegistry`] keyed by `(vault_id, note_id)`
//! (`SYNC-34`), and the teardown that drops a session on every vault-leaving hook.
//!
//! # Scope, so a reader does not look for what is elsewhere
//!
//! The session owns the document and the single-writer persistence (`SYNC-33`).
//! The CodeMirror transaction → splice translation, remote-change application and
//! the body-only frontmatter clamp are later tasks of the same sub-feature
//! (`collab-editor-bridge` 4-6); the awareness frame codec is
//! `collab-awareness-crypto`; the transport is `collab-client-transport`. Nothing
//! here opens a socket, reaches `std::fs` directly (all IO goes through
//! [`crate::vault_io::VaultIo`]), or derives a room key.

pub mod apply_local;
pub mod apply_remote;
pub mod awareness;
pub mod body_guard;
pub mod commands;
pub mod frontmatter;
pub mod session;
pub mod state;

#[cfg(test)]
mod apply_local_test;
#[cfg(test)]
mod apply_remote_test;
#[cfg(test)]
mod awareness_test;
#[cfg(test)]
mod body_guard_test;
#[cfg(test)]
mod drawing_test;
#[cfg(test)]
mod frontmatter_test;
#[cfg(test)]
mod session_test;

pub use commands::LiveSessionCommandError;
pub use session::{LiveSession, LiveSessionError, LiveSessionKey};
pub use state::LiveSessionRegistry;
