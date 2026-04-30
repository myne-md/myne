// Without `InlinedPlugin`, permissions under `permissions/vault-creation/`
// silently flatten into `__app-acl__` and the ACL resolver registers the
// `commands.allow` entries as bare names that never match the
// `plugin:vault-creation|<cmd>` form Tauri uses to authorize plugin
// invokes (tauri-utils `acl/resolved.rs::resolve_command`).
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "vault-creation",
            tauri_build::InlinedPlugin::new().commands(&["begin", "commit", "cancel"]),
        ),
    )
    .unwrap();
}
