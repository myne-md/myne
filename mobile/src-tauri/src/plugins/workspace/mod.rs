//! `workspace` Tauri plugin (MYND-561, mobile).
//!
//! Owns `workspace_read` + `workspace_write` — the persistence side of the
//! `vault.workspace` container (`MYW1`, `protocol.md` § 9.7), sealed opaque under
//! `session_state_key = DeriveSubkey(root_key, SessionStateKey)`. Both
//! Slot::Unlocked-gated; both borrow the existing `VaultRuntimeState` singleton
//! (registered by `vault_unlock::init`) via `tauri::State<...>` — this plugin
//! holds NO plugin-private state.
//!
//! Mobile's descriptor is NOT desktop's pane tree: the phone has one note open at
//! a time, so what rides the container here is the sidebar folder-expand set
//! (`expandedFolders`). The container is shared and the frontend treats it as a
//! read-modify-write of a JSON object, preserving keys it did not author — see
//! `src/lib/workspace-persist.ts`.
//!
//! Desktop registers a third command (`workspace_stage`) that parks a descriptor
//! in RAM for the `ExitRequested` flush; mobile has no Cmd+Q equivalent (an OS
//! kill after backgrounding is the normal termination path), so it writes
//! directly at its own exit-analog seams instead. Deliberately not carried over.
//!
//! ## Capability ACL
//!
//! `workspace:default` bundles `allow-workspace-read` + `allow-workspace-write`,
//! main-window-only. Declared as an `InlinedPlugin` in `build.rs` with the
//! permission bodies in `permissions/workspace/default.toml` — without the
//! `InlinedPlugin` declaration the permissions flatten into `__app-acl__` and
//! never match the `plugin:workspace|<cmd>` authorize form.
//!
//! See: main repo `src-tauri/CLAUDE.md` "Secret-handling logging discipline".

// The command core and its error enums are `myne-core`'s (myne-md/myne#479).
//
// This module used to carry a 297-line local fork, and its own header named the
// exit condition: "If desktop is ever migrated to a shared core, this module is
// what gets deleted." Desktop migrated (`src-tauri/src/plugins/workspace/mod.rs`
// is `pub use myne_core::plugins::workspace::{commands, error};`), and the fork
// outlived its condition by long enough to fall behind in two ways that no
// compiler and no guard could see:
//
//   1. It parsed `vault.meta` with `protocol::parse_vault_meta`, the v0.1-only
//      reader, while the core uses `parse_vault_meta_any`. `parse_vault_meta`
//      hard-rejects the `NTV5` magic, so on a MIGRATED vault this client's
//      `workspace_read` and `workspace_write` both failed with
//      `InvalidVaultMeta`, the sidebar folder-expand set silently stopped
//      persisting, while every other mobile plugin, going through the core,
//      kept working. `scripts/check-version-routing.mjs` exists to catch exactly
//      that and its `ROOTS` did not include `mobile/src-tauri/src`, so it
//      reported "0 still debt" over a tree it never read.
//   2. It read through a flat `std::fs::read` rather than the core's
//      `singleton::open_newest_and_sweep`, so it had none of myne#301's
//      torn-write recovery.
//
// The swap fixes both by construction. What does NOT change is the command SET:
// the core exports a third `#[tauri::command]`, `workspace_stage`, for desktop's
// Cmd+Q RAM-staging, and this client registers two. `generate_handler!` is what
// registers, so a `pub use` widens nothing, but `build.rs` and
// `permissions/workspace/default.toml` stay two wide as well, deliberately, and
// must not be copied from desktop: granting a permission for a command that is
// not registered authorizes something that does not exist.
#[allow(unused_imports)]
pub use myne_core::plugins::workspace::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `workspace` plugin. Borrows `VaultRuntimeState` via
/// `tauri::State<...>`; holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("workspace")
        .invoke_handler(tauri::generate_handler![
            commands::workspace_read,
            commands::workspace_write,
        ])
        .build()
}
