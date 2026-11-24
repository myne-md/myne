// SPDX-License-Identifier: AGPL-3.0-only
//! `graph_layout` plugin core — persistence of the knowledge-graph view's
//! laid-out node positions (the `vault.graph` rebuildable cache, `MYG1`,
//! `protocol.md` § 9.19): `graph_layout_read` + `graph_layout_write`.
//!
//! Both Slot::Unlocked-gated; both borrow the existing `VaultRuntimeState`
//! singleton (registered by `vault_unlock::init`) via `tauri::State<...>` —
//! this plugin holds NO plugin-private state. The payload is the client's
//! serialized position map + a staleness marker, sealed opaque under
//! `graph_layout_key = DeriveSubkey(root_key, GraphLayoutKey)` into
//! `vault.graph`.
//!
//! Class 3 rebuildable cache — never synced, never backed up. A device that
//! lacks it (or finds it stale vs the current index) re-runs the force layout;
//! this plugin exposes the primitives and each client's frontend decides
//! cadence (write after a fresh layout / a node drag; read on graph mount).
//! No `VaultLifecycleHooks` seam: the commands have no platform side-effect,
//! and being never-synced they must NOT bump the local sync change counter.
//!
//! Extracted from the desktop crate into `myne-core` (shared desktop↔mobile,
//! the `snapshots`/`vault_indices` precedent). Like every shared plugin core,
//! `init()` is per-client: each host builds its own plugin registering the
//! same 2 commands under its own `graph-layout:default` capability grant.
//!
//! See: `src-tauri/AGENTS.md` "Secret-handling logging discipline".

pub mod commands;
pub mod error;
