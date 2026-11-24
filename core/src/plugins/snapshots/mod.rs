// SPDX-License-Identifier: AGPL-3.0-only
//! `snapshots` plugin core (MYND-96, SYNC-9) — the read/management surface for
//! encrypted per-note version history: `snapshot_list`, `snapshot_preview`,
//! `snapshot_restore`, `snapshot_prune`.
//!
//! Snapshot logic deliberately spans two plugins: the **creation hook** +
//! prune-on-create + purge-on-delete live in the `notes` plugin (the
//! `note_update` / `note_delete` seam, where the pre-overwrite content is in
//! hand); this plugin owns only the read/management commands. It holds no
//! plugin-private state and borrows `VaultRuntimeState` cross-plugin (the
//! `vault_recover` / `notes` precedent), plus `Hooks` on restore for the
//! index/AI side-effects.
//!
//! Restore captures the pre-restore undo point through the
//! `hooks::VaultLifecycleHooks::capture_snapshot` seam (force=true) and reuses
//! `notes::commands::note_update_with_dir` (overwrite) rather than duplicating
//! the write path; the creation hook is coalesced so there is no double
//! snapshot (SYNC-5). A snapshot is a byte-verbatim copy of the note's `.myn`
//! blob (magic `MY01`) — there is no snapshot-specific codec or magic. The
//! on-disk storage layer (`snapshot_store`) and pure retention policy
//! (`snapshot_policy`) live at the crate root (`myne_core::snapshot_store` /
//! `myne_core::snapshot_policy`).
//!
//! Extracted from the desktop crate into `myne-core` (shared desktop↔mobile).
//! Like `notes` and `vault_indices`, `init()` is per-client: each host builds
//! its own plugin registering the same 4 commands. The write-path creation hook
//! (`capture_snapshot`) + purge (`purge_note_snapshots`) ride the desktop
//! `hooks::VaultLifecycleHooks` seam — mobile installs `NoopHooks`, so mobile
//! never auto-creates snapshots yet (a documented follow-up).
//!
//! See: `src-tauri/AGENTS.md` "Secret-handling logging discipline".

pub mod commands;
pub mod error;
