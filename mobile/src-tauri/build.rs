// Without `InlinedPlugin`, permissions under `permissions/<plugin>/`
// silently flatten into `__app-acl__` and the ACL resolver registers the
// `commands.allow` entries as bare names that never match the
// `plugin:<plugin>|<cmd>` form Tauri uses to authorize plugin invokes
// (tauri-utils `acl/resolved.rs::resolve_command`). Mirror of the desktop
// `src-tauri/build.rs`, trimmed to the Phase-1 vault + notes + prefs plugins
// that compile on mobile (notes trimmed to the CRUD + list surface — search /
// snapshot / export commands are desktop-only and not carried over).
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin(
                "vault-creation",
                tauri_build::InlinedPlugin::new().commands(&["begin", "commit", "cancel"]),
            )
            .plugin(
                "vault-unlock",
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
                tauri_build::InlinedPlugin::new().commands(&[
                    "recover_with_phrase",
                    "complete_recovery",
                    "resolve_vault_by_account_number",
                ]),
            )
            .plugin(
                "vault-delete",
                tauri_build::InlinedPlugin::new().commands(&["vault_delete"]),
            )
            .plugin(
                "vault-change-password",
                tauri_build::InlinedPlugin::new().commands(&["change_password"]),
            )
            .plugin(
                "prefs",
                tauri_build::InlinedPlugin::new().commands(&[
                    "prefs_read",
                    "set_screen_capture_protection",
                    "set_deliberate_folders",
                    "vault_set_label",
                ]),
            )
            .plugin(
                "notes",
                tauri_build::InlinedPlugin::new().commands(&[
                    "note_create",
                    "note_read",
                    "note_update",
                    "note_write_batch_transactional",
                    "note_delete",
                    "note_list",
                    "note_titles_batch",
                ]),
            ),
    )
    .unwrap();
}
