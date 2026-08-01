//! Vault-unlock Tauri plugin.
//!
//! Owns the singleton `UnlockedVault` slot and the `unlock` + `lock`
//! commands. Secret material (`root_key`, `items_key`) lives in
//! [`state::VaultRuntimeState`] and never crosses the IPC boundary —
//! see grilling session
//! `agent-tooling/sessions/grill/2026-05-02-vault-unlock-password.md`
//! Q1 (single-slot RwLock + Semaphore design) and the feature PRD
//! at `agent-tooling/features/vault-unlock-password/prd.md`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

// `state` (VaultRuntimeState), `error`, and the `commands` core (unlock / lock /
// status probes) moved to `myne-core` (shared with the mobile client). Inline
// desktop-only side-effects (search/spell/attachments/pdf/workspace teardown,
// screen-capture, clipper hydration) attach through the
// `hooks::VaultLifecycleHooks` seam. `state` + `commands` are re-exported so
// existing `crate::plugins::vault_unlock::{state,commands}::…` paths keep
// resolving; `error` is consumed only inside `myne-core` (no desktop call site),
// so it is not re-exported here. The `init()` wiring stays desktop-side.
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
            commands::lock,
            commands::vault_status,
            commands::vault_storage_health,
            commands::vault_list,
            commands::vault_is_unlocked,
            commands::vault_slot_kind,
            commands::report_user_activity,
            commands::account_number_check,
        ])
        .setup(|app, _api| {
            app.manage(state::VaultRuntimeState::default());
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod desktop_tests {
    //! Desktop-side tests for behavior that depends on desktop-only state
    //! types (`SearchIndexState`, `VaultIndicesState`, `AttachmentRefsState`)
    //! which do not live in `myne-core`. The `unlock`/`lock` command cores and
    //! their `is_vault_switch` *decision* tests moved to `myne-core`; this is
    //! the switch-teardown *wipe-mechanism* assertion, which can only run where
    //! the concrete global-index state types exist. Relocated here during the
    //! `myne-core` extraction (mirrors the `prefs` clamp-test relocation), NOT
    //! dropped — it is the guard against cross-vault plaintext-derived-index
    //! bleed (A7 / AS3-AS5) on a vault switch.

    /// On a vault switch, the teardown must wipe EVERY global plaintext-derived
    /// index so vault A's terms / wikilinks / attachment-correlation-tags cannot
    /// bleed into the next vault's about-to-hydrate indices. This pins the
    /// `clear()` mechanism the `hooks.zeroize_*` teardown calls drive (the
    /// production teardown ordering itself is asserted in the `myne-core`
    /// `lock`/`unlock` command tests).
    #[test]
    fn switch_teardown_wipes_every_global_derived_index() {
        use crate::plugins::attachments::AttachmentRefsState;
        use crate::plugins::vault_indices::state::NoteRecord;
        use crate::plugins::vault_indices::VaultIndicesState;
        use crate::search::SearchIndexState;

        // Simulate vault A having hydrated all three global indices.
        let search = SearchIndexState::default();
        search.upsert("note-a", "Alpha Title", "alpha body text");
        assert!(
            !search.query("alpha").is_empty(),
            "precondition: vault A search index populated"
        );

        let indices = VaultIndicesState::default();
        indices.apply(
            "note-a",
            NoteRecord {
                title: Some("Alpha Title".to_string()),
                folder: None,
                title_key: None,
                edges: Vec::new(),
                tags: Vec::new(),
                properties: Vec::new(),
                block_anchors: Vec::new(),
                tasks: Vec::new(),
                headings: Vec::new(),
            },
        );
        assert_eq!(
            indices.note_count(),
            1,
            "precondition: vault A VaultIndices populated"
        );

        let refs = AttachmentRefsState::default();
        refs.apply("note-a", ["att-a".to_string()]);
        assert_eq!(
            refs.note_count(),
            1,
            "precondition: vault A attachment-ref graph populated"
        );

        // The switch teardown wipes each global index (the same `clear()` the
        // `zeroize_*` wrappers call). After it, NONE of vault A's data
        // survives into the next vault's about-to-hydrate indices.
        search.clear();
        indices.clear();
        refs.clear();

        assert!(
            search.query("alpha").is_empty(),
            "search index must be wiped on switch (no vault-A term bleed)"
        );
        assert_eq!(
            indices.note_count(),
            0,
            "VaultIndices must be wiped on switch (no vault-A wikilink bleed)"
        );
        assert_eq!(
            refs.note_count(),
            0,
            "attachment-ref graph must be wiped on switch (no vault-A correlation-tag bleed)"
        );
    }
}
