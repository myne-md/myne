// SPDX-License-Identifier: AGPL-3.0-only
//! Vault-unlock Tauri plugin.
//!
//! Owns the singleton `UnlockedVault` slot and the `unlock` + `lock`
//! commands. Secret material (`root_key`, `items_key`) lives in
//! [`state::VaultRuntimeState`] and never crosses the IPC boundary —
//! see grilling session
//! `private-companion/sessions/grill/2026-05-02-vault-unlock-password.md`
//! Q1 (single-slot RwLock + Semaphore design) and the feature PRD
//! at `private-companion/features/vault-unlock-password/prd.md`.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

// `state` (VaultRuntimeState), `error`, and the `commands` core (unlock / lock /
// status probes) live in `myne-core` (shared with the desktop client). Mobile
// has no desktop-only side-effects to attach — the no-op `NoopHooks` installed
// in `lib.rs` satisfies the `State<'_, Hooks>` the core commands take.
// `state` + `commands` are re-exported so existing
// `crate::plugins::vault_unlock::{state,commands}::…` paths keep resolving. The
// `init()` wiring (including registering `VaultRuntimeState`) stays mobile-side.
pub use myne_core::plugins::vault_unlock::{commands, state};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Construct the `vault-unlock` plugin.
///
/// Registers [`state::VaultRuntimeState`] in the Tauri-managed state
/// map and binds the IPC commands declared in [`commands`].
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-unlock")
        .invoke_handler(tauri::generate_handler![
            commands::unlock,
            // The `NTV7` generation's second credential (myne-md/myne#911 task 10).
            // Registered here too so the shared `src/` unlock surface can offer it
            // once this client has the person plane (task 12); a vault of any other
            // generation refuses it.
            commands::unlock_with_person_phrase,
            commands::lock,
            commands::vault_status,
            commands::vault_list,
            commands::vault_is_unlocked,
            // The person-wrapped generation's one-bit discriminator (myne-md/myne#911
            // task 10), registered alongside the credential it describes.
            commands::vault_is_person_wrapped,
            commands::vault_slot_kind,
            // myne-md/myne#476: the AUTHORITATIVE active-vault id, from the
            // runtime slot map. Registered here so this client can stop
            // deriving it from `registry.json` ordering, which is what #250
            // deleted from desktop for naming the wrong vault after a
            // quick-unlock or a recovery, the root cause of #241, the
            // danger-zone delete erasing a vault the user was not looking at.
            commands::vault_active_id,
            commands::report_user_activity,
        ])
        .setup(|app, _api| {
            app.manage(state::VaultRuntimeState::default());
            Ok(())
        })
        .build()
}
