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
                // Task 6 adds `lock` (the A8e bundle). Adding a
                // command here without a matching `commands.allow`
                // entry in `permissions/vault-unlock/default.toml`
                // is a security regression.
                tauri_build::InlinedPlugin::new().commands(&["unlock", "lock"]),
            ),
    )
    .unwrap();
}
