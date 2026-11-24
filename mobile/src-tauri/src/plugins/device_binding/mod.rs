// SPDX-License-Identifier: AGPL-3.0-only
//! `device-binding` plugin: mobile shim over the shared
//! [`myne_core::plugins::device_binding`] store.
//!
//! The B2B device-to-person binding store (`vault.device-bindings`, magic `MYU5`;
//! protocol.md §9.30, the `member-devices` feature). The codec, group-tier key
//! resolution, sync classification, row signatures and the two command cores live in
//! `myne-core`, shared with desktop. This crate keeps only the per-client wiring:
//! [`init()`] + `generate_handler!` + the `device-binding:default` capability entry.
//! Same split the `member_names` / `sync` / `notes` / `prefs` shims use, so the phone
//! has no second implementation of the store to audit.
//!
//! ## Why mobile needs it at all
//!
//! A member's SECOND device is the case this family exists for, and the phone is the
//! device a person is most likely to add one on. That flow reads the pinned owner
//! identity code out of the per-`(person, vault)` record, verifies the group package
//! against it, and installs the member vault. What makes the new device legible to its
//! peers is the binding ROW, and the row is written core-side by
//! `commands::claim_own_binding_best_effort`, called from the B2B accept tail and from
//! the unlock hook (the paragraph below names both sites); the member roster resolves a
//! device through `sync::identity_resolver::join_durable_attribution`. So the STORE is
//! the second-device flow's substrate on the phone as much as on the desktop. The IPC
//! command this shim registers is the read a device-to-member settings surface will call.
//!
//! ## Capability ACL
//!
//! `device-binding:default` bundles ONE command, `device_bindings_list`
//! (`Slot::Unlocked`-gated), exactly the desktop bundle: a read of the
//! signature-verified view, never the raw map.
//!
//! **The write command that used to sit beside it is gone** (myne-md/myne#976).
//! `device_bindings_claim` was a write setter whose only reachable use was the desktop
//! `MEMBER DEVICES` panel's button, and the one state it repaired (a `ConflictingBinding`
//! this device is party to) is repaired by the sync cycle's own boundary now, without a
//! human. A grant no reachable state needs is the shape this ACL should not carry, and
//! that button never rendered on the phone in the first place. Nothing here writes a
//! tombstone either: an owner's removal tombstone is written inside
//! `sync::member_removal::rotate_group_from_host`, which is not reachable over IPC at
//! all.
//!
//! **The remaining command has no mobile caller, and that is on purpose.**
//! `scripts/check-ipc-binding-callers.mjs` refuses a binding with no production caller,
//! and the second-device flow reaches the store from `myne-core` instead: the row is
//! written by `claim_own_binding_best_effort`, called from the B2B accept path
//! (`sync::person_account.rs`, which bypasses the unlock pipeline and would otherwise
//! leave a freshly accepted device unbound until its second unlock) and from the unlock
//! hook (`vault_unlock::commands`). Both sites are core-side and
//! `#[cfg(not(target_arch = "wasm32"))]`, so both run on the phone. It stays registered
//! and granted so a later surface needs no Rust change to use it, NOT because one
//! reaches it today, which is the posture `member_names`' shim documents for its own
//! two.
//!
//! See: mobile/AGENTS.md, and the main repo's `src-tauri/AGENTS.md`
//! "Capability ACL" / "Plugin pattern".

// The command core lives in `myne-core` (shared with desktop). Re-exported so
// `crate::plugins::device_binding::commands::…` paths resolve; the `init()` wiring is
// client-side, like `sync` / `themes` / `prefs`.
pub use myne_core::plugins::device_binding::commands;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `device-binding` plugin.
///
/// Binds the device-binding commands over the encrypted `vault.device-bindings` blob.
/// Holds NO plugin-private state: every command borrows the `VaultRuntimeState`
/// singleton (registered by `vault_unlock::init`, shared with desktop) and resolves the
/// active vault dir per call. The plugin name in the ACL namespace is `device-binding`.
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

    /// Acceptance criterion 3 of the mobile second-device task, and it is not "the line
    /// is present in a JSON file".
    ///
    /// Three things have to hold for the command to actually be reachable over IPC, and
    /// each of them fails silently on its own: the capability must grant the family, the
    /// `default` bundle must resolve to a permission that EXISTS in this build's
    /// generated manifest (a `default_permission` naming an undefined permission resolves
    /// to an EMPTY set rather than erroring, so every command in the plugin is refused at
    /// runtime with no build failure), and the commands the bundle allows must be exactly
    /// the commands `generate_handler!` registers. The manifest is read from `OUT_DIR`,
    /// which is what `build.rs`'s `InlinedPlugin` emits, rather than from the gitignored
    /// `gen/schemas` copy: a clean clone has nothing there, and the
    /// `--no-default-features` build would leave a copy describing a different build.
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
