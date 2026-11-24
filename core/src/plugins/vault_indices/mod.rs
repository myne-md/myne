// SPDX-License-Identifier: AGPL-3.0-only
//! `vault_indices` plugin core (MYND-31 / A11 — VaultIndices).
//!
//! Owns the in-RAM wikilink graph + backlinks + tag index + typed-property
//! store for the open vault (`state`), its query/write/persist command surface
//! (`commands`), the `MYI1` encrypted-at-rest codec + Build-B reconcile-delta
//! (`persist`), and the IPC error enum (`error`). The MYI1 blob codec itself is
//! `protocol::vault_indices_blob` (shared, unchanged).
//!
//! Extracted from the desktop crate into `myne-core` (shared desktop↔mobile,
//! mobile parity for backlinks/graph/tags/properties). Like `notes` and
//! `quick_unlock`, `init()` is per-client: each host builds its own plugin with
//! the same 12 commands and registers `VaultIndicesState`; the lock-teardown
//! wipe (`zeroize_vault_indices`) is desktop-side (it rides the desktop
//! `hooks::VaultLifecycleHooks` seam — mobile installs `NoopHooks`).
//!
//! See: `src-tauri/AGENTS.md` "Secret-handling logging discipline".

pub mod calendar;
pub mod commands;
pub mod error;
pub mod persist;
pub mod state;

pub use state::VaultIndicesState;
