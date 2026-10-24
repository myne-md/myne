// SPDX-License-Identifier: AGPL-3.0
//! `notes` plugin — shared core.
//!
//! Owns the platform-agnostic per-note CRUD + listing commands
//! (`note_create`, `note_read`, `note_update`, `note_write_batch_transactional`,
//! `note_delete`, `note_list`, `note_titles_batch`) plus the `NoteId`
//! identifier, the title-extraction helpers, and the error enums. Each command
//! pattern-matches `Slot::Unlocked(_)` only; `Slot::Recovering` is rejected at
//! compile time per `recovery-flow.md` §4.1. The plugin holds no own state and
//! borrows `VaultRuntimeState` cross-plugin.
//!
//! The desktop-only index/sync/snapshot side-effects the CRUD commands trigger
//! (search upsert/remove, sync dirty-bump, pre-overwrite snapshot capture,
//! snapshot purge-on-delete, the attachment-text fold) attach through the
//! [`crate::hooks::VaultLifecycleHooks`] seam — no-op on mobile. The
//! desktop-only commands (note export, full-text search, snapshot flush,
//! attachment-reference scan) live in the desktop crate
//! (`src-tauri/src/plugins/notes/desktop_commands.rs`); the `tauri::Builder`
//! `init()` wiring stays in each client crate.
//!
//! See: ../../../AGENTS.md "Secret-handling logging discipline".

pub mod commands;
pub mod crdt;
pub mod daily_match;
pub mod decode;
pub mod drawing_text;
pub mod error;
#[cfg(not(target_arch = "wasm32"))]
pub mod export_mtime;
pub mod frontmatter_patch;
pub mod note_id;
pub mod search_sync_core;
pub mod title_extract;

pub use commands::NOTES_DELETED_EVENT;
pub use commands::SNAPSHOT_WRITE_FAILED_EVENT;
