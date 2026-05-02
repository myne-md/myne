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
            ),
    )
    .unwrap();
}
