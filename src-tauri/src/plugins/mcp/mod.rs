// SPDX-License-Identifier: AGPL-3.0-only
//! `mcp` Tauri plugin: the Settings surface of external MCP access
//! (external-mcp-connection, myne-md/myne#923).
//!
//! A thin shim in the shape `member-names` and `themes` take: the two command
//! bodies and the error enum live in `myne-core::plugins::mcp::commands`, and
//! this crate keeps the `tauri::Builder` `init()` / `generate_handler!`
//! registration plus the capability ACL.
//!
//! ## Why a plugin of its own rather than two more `prefs` commands
//!
//! The reads answer a question no single plugin owns: what may a named
//! connection read, resolved from the stored grant (a `vault.prefs` field), the
//! vault index, and the folder derivation the sidebar itself uses. The WRITERS
//! stay where they are (`plugin:prefs|set_mcp_connection_grant` and
//! `plugin:prefs|revoke_mcp_connection`), because they are pure prefs setters and
//! the nonce discipline belongs on that surface. The namespace here is therefore
//! read-only, and the ACL below grants exactly two reads.
//!
//! ## Desktop only, and absent rather than disabled elsewhere
//!
//! `myne-mcp` is a desktop `externalBin` sidecar, so the section that describes it
//! exists on no other client (`capabilities` marks `externalMcp` absent on web and
//! mobile). The web dispatcher classifies this whole plugin `Unsupported`, which is
//! the backend half of the same statement: the UI omits the section, and a command
//! arriving by any other path is refused rather than answered.
//!
//! See: src-tauri/AGENTS.md "Capability ACL", "Plugin pattern".

pub use myne_core::plugins::mcp::commands;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `mcp` plugin.
///
/// Holds no plugin-private state: both commands borrow the `VaultRuntimeState`
/// and `VaultIndicesState` singletons through `tauri::State` and resolve the
/// active vault per call, the same way the door does.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("mcp")
        .invoke_handler(tauri::generate_handler![
            commands::mcp_external_access,
            commands::mcp_grant_preview,
        ])
        .build()
}
