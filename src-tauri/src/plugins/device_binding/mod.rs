// SPDX-License-Identifier: AGPL-3.0
//! `device-binding` Tauri plugin: desktop wiring of the shared `myne-core`
//! device-to-person binding store (`vault.device-bindings`, `MYU5`; protocol.md
//! §9.30, the `member-devices` feature).
//!
//! A thin shim, exactly like the `member-names` and `themes` shims: the command cores
//! and their error enum live in `myne-core` (shared with mobile), and this crate keeps
//! only the `tauri::Builder` `init()` / `generate_handler!` registration plus the
//! capability ACL. The `commands` module is re-exported so any
//! `crate::plugins::device_binding::commands::…` path resolves.
//!
//! ## Capability ACL
//!
//! `device-binding:default` bundles ONE command, `device_bindings_list`
//! (`Slot::Unlocked`-gated), and it is a read: it answers the signature-verified view
//! rather than the raw map, so nothing reachable over IPC can render an unverified row
//! beside a member's name.
//!
//! **The write has no command, deliberately** (myne-md/myne#976). `device_bindings_claim`
//! existed for the `MEMBER DEVICES` panel's button, and the only state it repaired (a
//! `ConflictingBinding` this device is party to) is now repaired by the sync cycle's own
//! boundary without a human in the loop (`core/src/plugins/sync/cycle.rs`). A grant here
//! would therefore be an affordance with no reachable state behind it, which is the shape
//! this plugin's ACL should not carry.
//!
//! Nothing in the bundle writes a tombstone: an owner's removal tombstone is written
//! inside `sync::member_removal::rotate_group_from_host`, which is not reachable over IPC
//! at all.
//!
//! **The one TypeScript binding is `listDeviceBindings`**, whose caller is the member
//! roster: it shows how many devices each member has claimed here and says once when a
//! claim did not verify. The list stays registered and granted for any later device
//! surface, which is the posture `member_names`' shim documents for `member_names_list`.
//!
//! See: src-tauri/AGENTS.md "Capability ACL", "Plugin pattern".

// The command core lives in `myne-core` (shared with mobile). Re-exported so existing
// `crate::plugins::device_binding::commands::…` paths keep resolving; the `init()` wiring
// stays desktop-side (like notes / prefs / themes).
pub use myne_core::plugins::device_binding::commands;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `device-binding` plugin.
///
/// Binds the device-binding commands over the encrypted `vault.device-bindings` blob.
/// Holds NO plugin-private state: every command borrows the `VaultRuntimeState`
/// singleton (registered by `vault_unlock::init`) via `tauri::State<...>` and resolves
/// the active vault dir per call. The plugin name in the ACL namespace is
/// `device-binding`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("device-binding")
        .invoke_handler(tauri::generate_handler![commands::device_bindings_list])
        .build()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    const PLUGIN: &str = "device-binding";

    /// Every `commands::<name>` this shim hands to `generate_handler!`, read from this
    /// file's own source so a command added to the handler is in the set by
    /// construction rather than by a hand-kept list beside it.
    fn registered_commands() -> BTreeSet<String> {
        let src = include_str!("mod.rs");
        let start = src.find("generate_handler![").expect("the handler block");
        let body = &src[start..];
        let end = body.find(']').expect("the handler block ends");
        body[..end]
            .split("commands::")
            .skip(1)
            .filter_map(|chunk| {
                let name: String = chunk
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                (!name.is_empty()).then_some(name)
            })
            .collect()
    }

    /// The commands the `default` permission bundle resolves to, following one level of
    /// `permission_sets` the way `tauri-utils`' ACL resolver does, so a bundle that
    /// names a set instead of the leaf permissions is measured the same way.
    fn bundle_commands(plugin: &serde_json::Value) -> BTreeSet<String> {
        let mut ids: Vec<String> = plugin["default_permission"]["permissions"]
            .as_array()
            .expect("the default bundle names its permissions")
            .iter()
            .map(|v| v.as_str().expect("a permission id is a string").to_string())
            .collect();
        let mut seen: BTreeSet<String> = ids.iter().cloned().collect();
        let sets = plugin["permission_sets"].as_object();
        let perms = plugin["permissions"].as_object();
        let mut out: BTreeSet<String> = BTreeSet::new();
        let mut index = 0;
        while index < ids.len() {
            let id = ids[index].clone();
            index += 1;
            if let Some(set) = sets.and_then(|s| s.get(&id)) {
                if let Some(list) = set["permissions"].as_array() {
                    for member in list {
                        let member = member.as_str().expect("a permission id").to_string();
                        if seen.insert(member.clone()) {
                            ids.push(member);
                        }
                    }
                }
                continue;
            }
            let entry = perms.and_then(|p| p.get(&id)).unwrap_or_else(|| {
                panic!("`{id}` is granted but the manifest defines no such permission")
            });
            for cmd in entry["commands"]["allow"]
                .as_array()
                .expect("an allow permission names its commands")
            {
                out.insert(cmd.as_str().expect("a command name").to_string());
            }
        }
        out
    }

    /// Acceptance criterion 6, and it is not "the line is present in a JSON file".
    ///
    /// Three things have to hold for the command to actually be reachable over IPC, and
    /// each of them fails silently on its own: the capability must grant the family, the
    /// `default` bundle must resolve to a permission that EXISTS in this build's
    /// generated manifest (a `default_permission` naming an undefined permission resolves
    /// to an EMPTY set rather than erroring, so every command in the plugin is refused at
    /// runtime with no build failure), and the commands the bundle allows must be exactly
    /// the commands `generate_handler!` registers. The manifest is read from `OUT_DIR`,
    /// which is what `build.rs`'s `InlinedPlugin` emits, rather than from the gitignored
    /// `gen/schemas` copy: a clean clone has nothing there, and the `--no-default-features`
    /// build would leave a copy describing a different build.
    #[test]
    fn the_binding_commands_are_granted_and_resolve_in_this_build() {
        let manifest_path = std::path::PathBuf::from(env!("OUT_DIR")).join("acl-manifests.json");
        let manifest_text = std::fs::read_to_string(&manifest_path).expect(
            "read acl-manifests.json from OUT_DIR: generated by tauri_build in build.rs, so an \
             absence here means the build script did not run, not that the ACL is clean",
        );
        let manifests: serde_json::Value =
            serde_json::from_str(&manifest_text).expect("parse acl-manifests.json");

        let plugin = manifests.get(PLUGIN).unwrap_or_else(|| {
            panic!(
                "the generated ACL manifest carries no `{PLUGIN}` plugin: build.rs's \
                 InlinedPlugin declaration is what puts it there, and without it every \
                 `{PLUGIN}:…` capability entry resolves to nothing"
            )
        });
        let allowed = bundle_commands(plugin);

        let registered = registered_commands();
        assert!(
            !registered.is_empty(),
            "the source scan found no `commands::` token in `generate_handler!`, so this \
             test is measuring nothing"
        );
        assert_eq!(
            allowed, registered,
            "the `{PLUGIN}:default` bundle and `generate_handler!` disagree. A command the \
             handler registers but no permission allows is reachable by nothing; a \
             permission allowing a command the handler never registers is a grant over \
             nothing"
        );

        // And the capability actually grants the family to the main window.
        let cap: serde_json::Value =
            serde_json::from_str(include_str!("../../../capabilities/default.json"))
                .expect("parse the main capability");
        let granted: Vec<String> = cap["permissions"]
            .as_array()
            .expect("the capability lists permissions")
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| v["identifier"].as_str().unwrap_or_default().to_string())
            })
            .collect();
        assert!(
            granted.iter().any(|p| p == &format!("{PLUGIN}:default")),
            "capabilities/default.json does not grant `{PLUGIN}:default`, so the command is \
             registered in the handler and refused at the IPC boundary"
        );
    }
}
