//! `notes` plugin — host-side per-note CRUD.
//!
//! v0.1 surface: `note_create` + `note_read` (MYND-26). Update/delete
//! land in MYND-27, list in MYND-28. Each command pattern-matches
//! `Slot::Unlocked(uv) => ...` only; `Slot::Recovering` is rejected at
//! compile time per `recovery-flow.md` §4.1. The plugin holds no own
//! state and borrows `VaultRuntimeState` cross-plugin (`vault_recover`
//! precedent).
//!
//! ## Anchors
//!
//! - `agent-tooling/features/note-create-and-read/rfc.md` — design.
//! - `agent-tooling/features/note-create-and-read/prd.md` — acceptance.
//! - `agent-tooling/sessions/grill/2026-05-07-mynd-26-note-tauri-commands.md`
//!   — eighteen design decisions across six grilling turns.
//!
//! Module layout (filled in across MYND-26 tasks):
//!
//! - `note_id` — host-side UUIDv7 newtype with strict parse (Task 4).
//! - `error` — `NoteCreateError` + `NoteReadError` closed enums (Task 5).
//! - `commands` — `note_create` + `note_read` Tauri commands (Tasks 8–9).
//! - `init()` — Builder + `invoke_handler!` registration (Task 7).

pub mod commands;
pub mod error;
pub mod note_id;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `notes` plugin.
///
/// Registers no own state — `VaultRuntimeState` is owned by
/// `vault_unlock::init` and borrowed cross-plugin via
/// `tauri::State<'_, VaultRuntimeState>` inside each command body
/// (vault_recover precedent; see `decisions.md` 2026-05-02 "Slot
/// state machine + auth_permits generalization").
///
/// The `invoke_handler!` is empty in this scaffold — both
/// `note_create` and `note_read` wire in at MYND-26 Tasks 8 / 9. The
/// plugin nevertheless registers under its own `notes:default`
/// capability ACL so the principle-of-least-privilege parity with
/// `vault-unlock:default` / `vault-creation:default` is preserved
/// from day one.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("notes")
        .invoke_handler(tauri::generate_handler![])
        .build()
}
