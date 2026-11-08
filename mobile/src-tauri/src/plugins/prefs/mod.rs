// SPDX-License-Identifier: AGPL-3.0
//! `prefs` Tauri plugin (MYND-160 Task 9).
//!
//! Owns the `prefs_read` + `set_screen_capture_protection` IPC
//! commands. Both Slot::Unlocked-gated; both consume the existing
//! `VaultRuntimeState` singleton (registered by `vault_unlock::init`)
//! via `tauri::State<...>` — this plugin holds NO plugin-private
//! state. The per-plugin write mutex lives inside `commands.rs` as a
//! `OnceLock<Mutex<()>>`, scoped to write-side serialization only.
//!
//! Sibling to `vault_unlock`, `vault_recover`, `vault_change_password`,
//! `vault_delete`, and `notes`. The plugin name in the ACL namespace
//! is `prefs` (hyphenless — single word, no need for kebab-case).
//!
//! ## Design history
//!
//! - PRD: `agent-tooling/features/vault-prefs-blob/prd.md`
//! - Grilling: `agent-tooling/sessions/grill/2026-05-27-mynd-160-encrypted-prefs-blob.md`
//!   Q1 (subkey source), Q3 (storage layer + fall-back-to-defaults),
//!   Q4 (file format + AAD), Q5 (runtime control flow), Q6 (loose ends)
//! - Tasks: `agent-tooling/features/vault-prefs-blob/tasks.md`
//! - decisions.md: 2026-05-27 entries — "Vault preferences blob
//!   (vault.prefs): root_key-derived prefs_key, MYP1 magic, JSON
//!   inner, account_number_hash AAD" + "Lock-on-default-ON" +
//!   "Forward commitment: prefs:write capability stays
//!   main-window-only"
//!
//! ## Critical ordering
//!
//! `set_screen_capture_protection` MUST commit the disk write
//! BEFORE invoking the `screen_capture::apply` native side-effect.
//! Reversed ordering would let a disk-write failure silently leave
//! the native state desynchronized from the persisted preference.
//! See grill Q5.2 — story 16.
//!
//! ## Capability ACL
//!
//! `prefs:default` bundles both `allow-prefs-read` +
//! `allow-set-screen-capture-protection`. Main-window-only invariant:
//! v0.2 multi-window sub-windows MAY receive `allow-prefs-read` but
//! MUST NOT receive `allow-set-screen-capture-protection` (or any
//! future `allow-set-*`) per `decisions.md` 2026-05-27 "Forward
//! commitment: prefs:write capability stays main-window-only".
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

// The `prefs` command core (`vault.prefs` read + every per-field setter) and
// its `error` enum live in `myne-core` (shared with the desktop client).
// Re-exported so existing `crate::plugins::prefs::{commands,error}::…` paths
// keep resolving; the no-op `NoopHooks` installed in `lib.rs` satisfies the
// screen-capture / auto-lock-clamp hook seam. The `init()` wiring stays
// mobile-side.
pub use myne_core::plugins::prefs::{commands, error};

// Re-exports for cross-plugin consumers (e.g., vault_unlock's
// `apply_persisted_prefs` post-pipeline hook). Kept for path-compatibility with
// the desktop re-export surface even though the consuming code now lives in
// `myne-core`, hence the `unused_imports` allow.
#[allow(unused_imports)]
pub use error::PrefsReadError;
#[allow(unused_imports)]
pub use protocol::PrefsView;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `prefs` plugin.
///
/// Binds the IPC commands declared in [`commands`]. Does NOT
/// register `VaultRuntimeState` — the unlock plugin owns the
/// runtime-state singleton; prefs borrows via `Tauri::State<...>`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("prefs")
        .invoke_handler(tauri::generate_handler![
            commands::prefs_read,
            commands::set_screen_capture_protection,
            // ingest-image-compression: shared (sync-protocol.md §10.2) toggle
            // for whether an imported image is downscaled/re-encoded on ingest.
            // Body lives in the SHARED myne-core prefs core (desktop already
            // registers it); this plugin only wires the ACL. Must stay in
            // lockstep with permissions/prefs/default.toml or the ACL resolver
            // fails closed — same fail-closed discipline as MYND-548 below.
            commands::set_attachment_compression_enabled,
            commands::set_deliberate_folders,
            commands::set_archived_folders,
            commands::set_auto_lock_timeout,
            commands::set_item_order,
            commands::set_hidden_bar_items,
            commands::set_bar_items_order,
            // Left ribbon (myne-md/myne#699). Shared `myne-core` bodies; mobile
            // only registers them so a synced `ribbon_items` / `ribbon_visible`
            // the desktop wrote is writable here too. Each needs a matching
            // `allow-` entry in permissions/prefs/default.toml or the ACL
            // resolver fails closed.
            commands::set_ribbon_items,
            commands::set_ribbon_visible,
            commands::set_favorites,
            commands::set_editor_layout,
            commands::set_theme,
            commands::set_custom_theme,
            commands::set_daily_date_format,
            commands::set_daily_folder,
            commands::set_daily_template,
            // Periodic-notes settings (myne#177, wired to mobile by
            // myne-md/myne#880). One weekly/monthly entry of the `periodic_notes`
            // map. Body is the SHARED `myne-core` prefs core; mobile only
            // registers it, and it does so because the panel that writes it
            // landed in the same change (mobile/src/components/
            // PeriodicNotesBlock.tsx). Same three-site lockstep as every other
            // prefs setter: this list, permissions/prefs/default.toml and
            // build.rs's inlined command list, or the ACL resolver fails closed.
            commands::set_periodic_note_setting,
            commands::set_calendar_setting,
            // Graph colour groups (myne-md/myne#727), writable on mobile since
            // myne-md/myne#880. A WHOLE-LIST replace, because rule order is
            // precedence. Body is the SHARED `myne-core` prefs core; mobile only
            // registers it. Same three-site lockstep as every other prefs setter.
            commands::set_color_groups,
            // AI excluded folders (local-ai epic MYND-408), writable on mobile
            // since myne-md/myne#880. An EGRESS CONTROL: the set the refusal
            // path honours, so §10.2 keeps its union monotone and a removal is
            // never inherited from a peer. Body is the SHARED `myne-core` prefs
            // core; mobile only registers it. Same three-site lockstep.
            commands::set_ai_excluded_folders,
            // AI limits (myne-md/myne#880). `set_chat_history_budget` is
            // DEVICE-LOCAL (a per-machine off-device volume bound, clamped
            // host-side); `set_meeting_ai_prompt` is SHARED / scalar LWW, and it
            // matters most here because the phone is where meeting capture
            // happens. Bodies are the SHARED `myne-core` prefs core; mobile only
            // registers them. Same three-site lockstep.
            commands::set_chat_history_budget,
            // Attachment image OCR (MYND-441), switchable on mobile since
            // myne-md/myne#880. DEVICE-LOCAL: OCR runs in-process here, so the
            // device paying the compute cost owns the switch. Body is the SHARED
            // `myne-core` prefs core; mobile only registers it. Same three-site
            // lockstep.
            commands::set_attachment_ocr_enabled,
            commands::set_meeting_ai_prompt,
            // Display date & time (myne#279, wired to mobile by
            // myne-md/myne#609). Bodies live in the SHARED myne-core prefs core
            // and the desktop has registered all three since myne#279; mobile
            // read the resulting values through the shared task panel while
            // registering none of the setters and carrying none of the fields,
            // so a synced `date_format` arrived on the phone and was
            // disregarded. Each needs a matching `allow-` entry in
            // permissions/prefs/default.toml or the ACL resolver fails closed.
            commands::set_date_format,
            commands::set_time_format,
            commands::set_timezone,
            commands::set_new_note_location,
            commands::set_startup_open,
            commands::set_editor_text_size,
            commands::set_editor_line_numbers,
            commands::set_archive_disabled,
            commands::set_editor_line_spacing,
            commands::set_editor_content_width,
            commands::set_editor_font_family,
            commands::set_active_workspace,
            commands::set_editor_default_view_mode,
            commands::set_editor_focus_dim_inactive,
            commands::set_editor_focus_typewriter,
            commands::set_item_colors,
            commands::set_folder_icons,
            // MYND-548 device naming. Each needs a matching `allow-` entry in
            // permissions/prefs/default.toml AND a name in build.rs's inlined
            // command list — the desktop build.rs calls a mismatch here a
            // security regression, and the same holds on this side.
            commands::set_device_name,
            commands::device_platform,
            commands::vault_set_label,
            // vault-icons: the label's twin — the switcher's decorative glyph
            // name. Shared `myne-core` body; mobile only registers it. Same
            // three-site lockstep as every other prefs setter.
            commands::vault_set_icon,
            // AI (myne-md/myne#456). Six commands, and the sixth is the
            // interesting one: `ai_provider_has_key` is a READ that answers a
            // boolean, and it exists precisely so the key itself never needs a
            // getter. The host marks that field serde-skip, so it does not
            // reach page context on an ordinary `prefs_read` either.
            commands::set_ai_enabled,
            commands::set_ai_provider,
            commands::set_ai_provider_consent,
            commands::set_ai_provider_key,
            commands::set_ai_provider_model,
            commands::ai_provider_has_key,
            commands::set_spell_enabled,
            commands::set_spell_languages,
            commands::set_show_note_timestamps,
            commands::set_keymap_binding,
            commands::upsert_saved_view,
            commands::delete_saved_view,
            commands::set_view_order,
            commands::set_right_panel_active_tab,
            commands::set_right_panel_hidden_tabs,
            commands::set_right_panel_tab_order,
            // MYND-555: editor format-bar customization. Bodies are the SHARED
            // `myne-core` prefs core desktop already uses — mobile only registers
            // them. Device-local fields (`sync-protocol.md` §10.2.1), so a phone
            // layout never propagates to a desktop. Must stay in lockstep with
            // `permissions/prefs/default.toml` or the ACL resolver fails closed.
            commands::set_editor_toolbar_order,
            commands::set_editor_toolbar_hidden,
            commands::set_reminders_enabled,
            commands::set_reminder_horizon_days,
            // MYND-563: opt-out toggle for on-device transcription (default ON).
            // Body is the SHARED `myne-core` prefs core; mobile only registers
            // it. Must stay in lockstep with `permissions/prefs/default.toml` +
            // build.rs or the ACL resolver fails closed.
            commands::set_transcription_enabled,
        ])
        .build()
}

#[cfg(test)]
mod acl_registration_guard {
    /// **An ACL entry does not wire a command, and nothing checks that it
    /// does** (`src-tauri/AGENTS.md`). A prefs command with its
    /// `[[permission]]` block, its `[default]` bundle listing and a frontend
    /// caller, but missing from `generate_handler!`, compiles, passes clippy,
    /// renders its UI and is **dead at runtime**: the invoke rejects.
    ///
    /// The MOBILE twin of `src-tauri/src/plugins/prefs/mod.rs`'s guard of the
    /// same name, mirrored here by myne-md/myne#609. Until then only the desktop
    /// side had it, while `docs/dev/twin-inventory.md` recorded in its own words
    /// that the two capability grants were "NOT measured, and deliberately not
    /// claimed", while this file's own comments assert the lockstep obligation
    /// three times without anything checking it. It reads all three sources out
    /// of the files and compares them **both directions**, because a
    /// one-directional check would pass while a registered-but-unpermitted
    /// command sat there fail-closed.
    ///
    /// Note what it deliberately does NOT require: presence in `build.rs`. A
    /// hand-written `[[permission]]` block supplies what the autogenerated
    /// `allow-<cmd>` pair would, so a `build.rs` cross-check would fail on
    /// correct code.
    #[test]
    fn every_permitted_prefs_command_is_registered_and_vice_versa() {
        let toml = include_str!("../../../permissions/prefs/default.toml");
        let shim = include_str!("mod.rs");

        // 1. The `[default]` bundle: which identifiers are actually granted.
        //    An identifier with a `[[permission]]` block but no bundle listing
        //    is refused at runtime: fail-closed, and invisible from the block.
        let bundle_start = toml
            .find("permissions = [")
            .expect("the [default] bundle must list its permissions");
        let bundle_end = bundle_start
            + toml[bundle_start..]
                .find(']')
                .expect("unterminated permissions list");
        let mut granted: Vec<String> = toml[bundle_start..bundle_end]
            .split('"')
            .filter_map(|t| t.strip_prefix("allow-"))
            .map(|t| t.replace('-', "_"))
            .collect();
        granted.sort();
        granted.dedup();

        // 2. Every `commands.allow = [...]`, which is what each block permits.
        let mut permitted: Vec<String> = toml
            .lines()
            .filter_map(|l| l.trim().strip_prefix("commands.allow = ["))
            .flat_map(|rest| {
                rest.split('"')
                    .filter(|t| {
                        !t.is_empty() && t.chars().all(|c| c.is_ascii_lowercase() || c == '_')
                    })
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .collect();
        permitted.sort();
        permitted.dedup();

        // 3. `generate_handler!`, the only thing that actually wires a command.
        let gh_start = shim
            .find("generate_handler![")
            .expect("the prefs plugin must register a handler list");
        let gh_end = gh_start
            + shim[gh_start..]
                .find(']')
                .expect("unterminated generate_handler!");
        let mut registered: Vec<String> = shim[gh_start..gh_end]
            .lines()
            .filter_map(|l| l.trim().strip_prefix("commands::"))
            .map(|l| l.trim_end_matches(',').trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        registered.sort();
        registered.dedup();

        // Self-guard: if any extraction silently returned nothing, the
        // comparisons below would pass vacuously, the exact failure this
        // whole family of checks keeps producing.
        assert!(
            granted.len() >= 40 && permitted.len() >= 40 && registered.len() >= 40,
            "extraction returned too little to be real: granted={}, permitted={}, registered={}",
            granted.len(),
            permitted.len(),
            registered.len()
        );

        // The bundle and the blocks must describe the same set.
        assert_eq!(
            granted, permitted,
            "the [default] bundle and the [[permission]] blocks disagree; \
             an identifier in one and not the other is refused at runtime"
        );
        // BOTH directions against registration.
        for cmd in &permitted {
            assert!(
                registered.contains(cmd),
                "mobile prefs command {cmd:?} is permitted but NOT in generate_handler!: \
                 it compiles, renders its UI, and its invoke rejects at runtime"
            );
        }
        for cmd in &registered {
            assert!(
                permitted.contains(cmd),
                "mobile prefs command {cmd:?} is registered but has no permission: \
                 the ACL is fail-closed, so every call is refused"
            );
        }
    }
}
