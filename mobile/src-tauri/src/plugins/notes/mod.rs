// SPDX-License-Identifier: AGPL-3.0-only
//! `notes` plugin — host-side per-note CRUD + listing (mobile).
//!
//! Seven Tauri commands: `note_create`, `note_read`, `note_update`,
//! `note_write_batch_transactional`, `note_delete`, `note_list`,
//! `note_titles_batch`. Each command pattern-matches `Slot::Unlocked(_) => ...`
//! only; `Slot::Recovering` is rejected at compile time per
//! `recovery-flow.md` §4.1. The plugin holds no own state and borrows
//! `VaultRuntimeState` cross-plugin.
//!
//! The desktop-only search / snapshot / export / attachment-reconcile signals
//! are not carried over on mobile (search runs TS-side); the `.myn`
//! encrypt/write/read/update/delete cores are verbatim from desktop.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" in the main repo.

// The platform-agnostic CRUD command core (`commands`), the `NoteId` identifier
// (`note_id`), the title-extraction helpers (`title_extract`), and the error
// enums (`error`) live in `myne-core` (shared with the desktop client).
// Re-exported so existing `crate::plugins::notes::{commands,error,note_id,
// title_extract}::…` paths keep resolving. Mobile registers ONLY the seven CRUD
// commands — the desktop-only export / full-text-search / snapshot-flush
// commands are not carried over. The no-op `NoopHooks` installed in `lib.rs`
// satisfies the search-upsert / snapshot-capture hook seam.
//
// `commands` is the only symbol `init()` registers; `error` / `note_id` /
// `title_extract` are re-exported for path-compatibility with any consumer that
// referenced `crate::plugins::notes::{error,note_id,title_extract}` (mirrors the
// desktop re-export surface), hence the `unused_imports` allow.
#[allow(unused_imports)]
pub use myne_core::plugins::notes::{commands, error, note_id, title_extract};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `notes` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("notes")
        .invoke_handler(tauri::generate_handler![
            commands::note_create,
            commands::note_read,
            commands::note_update,
            commands::note_set_field,
            commands::note_write_batch_transactional,
            commands::note_delete,
            commands::note_list,
            commands::note_titles_batch,
        ])
        .build()
}
