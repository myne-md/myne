// Without `InlinedPlugin`, permissions under `permissions/vault-creation/`
// silently flatten into `__app-acl__` and the ACL resolver registers the
// `commands.allow` entries as bare names that never match the
// `plugin:vault-creation|<cmd>` form Tauri uses to authorize plugin
// invokes (tauri-utils `acl/resolved.rs::resolve_command`).
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin(
                "vault-creation",
                tauri_build::InlinedPlugin::new().commands(&["begin", "commit", "cancel"]),
            )
            .plugin(
                "vault-unlock",
                // Task 2 of `vault-unlock-password` ships `unlock`;
                // Task 6 of that feature adds `lock` (the A8e bundle).
                // Task 1 of `app-state-machine` adds `vault_status`
                // (read-only `vault.meta` disk probe — Exists / Missing
                // / Corrupted) and `vault_is_unlocked` (read-only
                // boolean peek of the unlocked-vault slot for Editor
                // mount-guard reality-checks). Task 8 of
                // `vault-recovery-from-phrase` adds `vault_slot_kind`
                // (read-only three-state SlotKind probe — Empty /
                // Recovering / Unlocked — used by the recovery flow's
                // boot-time and post-WebView-reload routing). Adding a
                // command here without a matching `commands.allow`
                // entry in `permissions/vault-unlock/default.toml` is a
                // security regression.
                tauri_build::InlinedPlugin::new().commands(&[
                    "unlock",
                    "lock",
                    "vault_status",
                    "vault_is_unlocked",
                    "vault_slot_kind",
                ]),
            )
            .plugin(
                "vault-recover",
                // Task 4 of `vault-recovery-from-phrase` ships
                // `recover_with_phrase`. Task 6 adds
                // `complete_recovery` (the A8f bundle). Adding a
                // command here without a matching `commands.allow`
                // entry in `permissions/vault-recover/default.toml`
                // is a security regression.
                tauri_build::InlinedPlugin::new()
                    .commands(&["recover_with_phrase", "complete_recovery"]),
            )
            .plugin(
                "vault-delete",
                // Task 4 of `backend-vault-delete` (MYND-105) ships
                // the `vault_delete` command (scaffolding stub; the
                // Slot precondition matrix + recursive unlink +
                // partial-fail aggregation + Unix-only durability
                // body lands in Tasks 5-8). One-shot destruction of
                // the local vault. Adding a command here without a
                // matching `commands.allow` entry in
                // `permissions/vault-delete/default.toml` is a
                // security regression.
                tauri_build::InlinedPlugin::new().commands(&["vault_delete"]),
            )
            .plugin(
                "vault-change-password",
                // Task 7 of `vault-change-password` (MYND-22) ships
                // the `change_password` command (scaffolding stub;
                // pipeline body lands in Tasks 8–13). Standalone
                // change-password flow: user knows current password,
                // sets new password. Function name is
                // `change_password` (not `commit`) to avoid a
                // `#[tauri::command]` macro symbol collision with
                // `vault_creation::commands::commit`. Adding a
                // command here without a matching `commands.allow`
                // entry in
                // `permissions/vault-change-password/default.toml` is
                // a security regression.
                tauri_build::InlinedPlugin::new().commands(&["change_password"]),
            )
            .plugin(
                "prefs",
                // MYND-160 ships the `prefs_read` + `set_screen_capture_protection`
                // commands. Both are Slot::Unlocked-gated and consume
                // the existing `VaultRuntimeState` singleton (registered
                // by `vault-unlock::init`). v0.1 has a single per-field
                // setter; future v0.1.x revisions append more
                // (`set_theme`, `set_font_size`, etc.) each as its own
                // command with its own `commands.allow` entry. Adding
                // a command here without a matching `commands.allow`
                // entry in `permissions/prefs/default.toml` is a
                // security regression.
                tauri_build::InlinedPlugin::new().commands(&[
                    "prefs_read",
                    "set_screen_capture_protection",
                    "set_deliberate_folders",
                ]),
            )
            .plugin(
                "notes",
                // The `commands.allow` entries in
                // `permissions/notes/default.toml` declare all four —
                // this `InlinedPlugin` mirror is load-bearing per the
                // same security regression note pinned for
                // `vault-creation` above (without it, permissions
                // silently flatten into `__app-acl__` and the ACL
                // resolver registers them as bare names that never
                // match the `plugin:notes|<cmd>` form Tauri uses to
                // authorize plugin invokes).
                tauri_build::InlinedPlugin::new().commands(&[
                    "note_create",
                    "note_read",
                    "note_update",
                    "note_delete",
                    "note_list",
                    "note_search",
                ]),
            ),
    )
    .unwrap();
}
