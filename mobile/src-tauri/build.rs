// Without `InlinedPlugin`, permissions under `permissions/<plugin>/`
// silently flatten into `__app-acl__` and the ACL resolver registers the
// `commands.allow` entries as bare names that never match the
// `plugin:<plugin>|<cmd>` form Tauri uses to authorize plugin invokes
// (tauri-utils `acl/resolved.rs::resolve_command`). Mirror of the desktop
// `src-tauri/build.rs`, covering the plugins registered on mobile: vault
// lifecycle + notes (CRUD/list) + prefs + quick-unlock (PIN only) + vault-indices
// + snapshots + attachments (no voice) + search + export + secret-export. The
// still-desktop-only surfaces (biometric quick-unlock, attachment text
// extraction / voice, native PDF capture) are not carried over.
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
                "vault-repair",
                tauri_build::InlinedPlugin::new().commands(&["vault_residue_scan", "vault_repair"]),
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
                    "set_archived_folders",
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
            )
            .plugin(
                // PIN + Apple biometric (iOS Face ID / Touch ID; the biometric
                // pair returns HardwareUnavailable on Android until a Keystore
                // provider lands). Adding a command here without a matching
                // entry in `permissions/quick-unlock/default.toml` is a
                // security bug.
                "quick-unlock",
                tauri_build::InlinedPlugin::new().commands(&[
                    "quick_unlock_setup_pin",
                    "quick_unlock_with_pin",
                    "quick_unlock_setup_biometric",
                    "quick_unlock_with_biometric",
                    "quick_unlock_status",
                    "quick_unlock_disable",
                ]),
            )
            .plugin(
                // Apple Watch voice-capture queue (MYK1, §9.18): device-key
                // sealed pending captures drained into notes on unlock. Adding a
                // command here without a matching entry in
                // `permissions/captures/default.toml` is a security bug.
                "captures",
                tauri_build::InlinedPlugin::new().commands(&["seal_staged", "take_pending", "ack"]),
            )
            .plugin(
                // Share-import staging queue (MYF1, §9.20): device-key sealed
                // files shared via the OS share sheet, drained into the
                // attachment library on unlock. Adding a command here without a
                // matching entry in `permissions/share-import/default.toml` is a
                // security bug.
                "share-import",
                tauri_build::InlinedPlugin::new().commands(&[
                    "seal_share",
                    "drain_pending_shares",
                    "share_ack",
                ]),
            )
            .plugin(
                // MYND-31 (A11 — VaultIndices): shared from `myne-core`; the
                // same 12 commands the desktop registers. Adding a command here
                // without a matching entry in
                // `permissions/vault-indices/default.toml` is a security bug.
                "vault-indices",
                tauri_build::InlinedPlugin::new().commands(&[
                    "vault_indices_apply",
                    "vault_indices_remove",
                    "vault_indices_forward",
                    "vault_indices_all_edges",
                    "vault_indices_orphans",
                    "vault_indices_backlink_candidates",
                    "vault_indices_by_tag",
                    "vault_indices_tag_tree",
                    "vault_indices_note_properties",
                    "vault_indices_property_values",
                    "vault_indices_persist",
                    "vault_indices_hydrate",
                ]),
            )
            .plugin(
                // MYS1 full-text search (frontend-fed): a NEW local mobile
                // plugin (not a `myne-core` re-export) driving the shared BM25
                // engine. Adding a command here without a matching entry in
                // `permissions/search/default.toml` is a security bug.
                "search",
                tauri_build::InlinedPlugin::new()
                    .commands(&["search_index_replace", "note_search"]),
            )
            .plugin(
                // MYND-96 (SYNC-9): shared from `myne-core`; the same 4 commands
                // the desktop registers. Adding a command here without a matching
                // entry in `permissions/snapshots/default.toml` is a security bug.
                "snapshots",
                tauri_build::InlinedPlugin::new().commands(&[
                    "snapshot_list",
                    "snapshot_preview",
                    "snapshot_restore",
                    "snapshot_prune",
                ]),
            )
            .plugin(
                // MYND-169 (attachments): shared from `myne-core`. Mobile
                // registers the CRUD subset that works without a native mic or
                // the desktop text extractor — NO `voice_record_*`. Adding a
                // command here without a matching entry in
                // `permissions/attachments/default.toml` is a security bug.
                "attachments",
                tauri_build::InlinedPlugin::new().commands(&[
                    "attachment_import",
                    "catalog_list",
                    "attachment_delete",
                    "attachment_rename",
                    "attachment_export",
                    "attachment_unused_list",
                    "attachment_clean_unused",
                    "attachment_refs_apply",
                    "attachment_refs_remove",
                    "attachment_refs_referencing",
                ]),
            )
            .plugin(
                // MYND-211 (whole-vault plaintext markdown tree export): shared
                // from `myne-core`; the same two commands the desktop registers.
                // Adding a command here without a matching entry in
                // `permissions/export/default.toml` is a security bug.
                "export",
                tauri_build::InlinedPlugin::new()
                    .commands(&["vault_export_markdown", "vault_export_cancel"]),
            )
            .plugin(
                // Recovery-kit / account-number `.txt` save: shared from
                // `myne-core`; the same single `save_secret_text` command the
                // desktop registers. Adding a command here without a matching
                // entry in `permissions/secret-export/default.toml` is a
                // security bug.
                "secret-export",
                tauri_build::InlinedPlugin::new().commands(&["save_secret_text"]),
            )
            .plugin(
                // MYND-458: the mobile `sync` shim over `myne_core::plugins::sync`
                // — the SAME 15 commands the desktop registers, deny-by-default.
                // (MYND-459 T12: `sync_head_fingerprint` added — the SY-05 SAS
                // eye-compare substrate, exposed on mobile to match desktop F3-T4.)
                // This list, the `generate_handler!` in `plugins/sync/mod.rs`, and
                // `permissions/sync/default.toml` `commands.allow` MUST match
                // exactly (all 17) or the ACL resolver fails closed. Adding a
                // command here without a matching permission entry is a security
                // bug (SYNC-15). The lifecycle pair is mobile-only (desktop
                // never manages the SyncLifecycleSignal).
                "sync",
                tauri_build::InlinedPlugin::new().commands(&[
                    "sync_get_endpoint",
                    "sync_set_endpoint",
                    "sync_status",
                    "sync_now",
                    "sync_list_devices",
                    "sync_approve_device",
                    "sync_remove_device",
                    "sync_pending_conflicts",
                    "sync_take_conflict",
                    "sync_resolve_conflict",
                    "sync_mark_tombstone",
                    "sync_enroll",
                    "sync_join_account",
                    "sync_reset_local",
                    "sync_head_fingerprint",
                    "sync_lifecycle_suspend",
                    "sync_lifecycle_resume",
                ]),
            ),
    )
    .unwrap();

    // Android manifest partial — the committed, regeneration-surviving mirror of
    // `Info.ios.plist` (gen/android is gitignored and re-init clobbers it; this
    // block is re-applied idempotently on every `tauri android dev/build`, and
    // no-ops on desktop/iOS where TAURI_ANDROID_PROJECT_PATH is unset).
    //
    // BOTH permissions are required for voice notes: wry's
    // `RustWebChromeClient.onPermissionRequest` batch-requests RECORD_AUDIO +
    // MODIFY_AUDIO_SETTINGS for a getUserMedia audio capture, and an undeclared
    // normal-level permission comes back denied from the launcher and fails the
    // whole batch — silently breaking mic capture.
    tauri_utils::build::update_android_manifest(
        "MYNE MICROPHONE (voice notes)",
        "manifest",
        r#"<uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />"#
            .to_string(),
    )
    .expect("failed to update AndroidManifest.xml");

    // Static app shortcuts ("New note" / "New voice note" on launcher-icon
    // long-press — the android-widgets/ surface set). The <meta-data> must sit
    // ON MainActivity, which the library module's manifest cannot reach, so it
    // is injected here (same pattern as the mic block; "activity" targets the
    // manifest's single <activity>). `@xml/myne_shortcuts` lives in the
    // committed android-widgets/ module: after a fresh `tauri android init`,
    // building WITHOUT re-running scripts/android-postinit.sh fails on this
    // missing resource — deliberately fail-closed so the widget wiring cannot
    // be silently dropped (android-widgets/README.md).
    tauri_utils::build::update_android_manifest(
        "MYNE SHORTCUTS (android-widgets)",
        "activity",
        r#"<meta-data android:name="android.app.shortcuts" android:resource="@xml/myne_shortcuts" />"#
            .to_string(),
    )
    .expect("failed to update AndroidManifest.xml");

    // Share-import (SF3, §9.20): register Myne as an OS share target. The
    // ACTION_SEND / ACTION_SEND_MULTIPLE intent-filters go ON MainActivity
    // (singleTask) so a share to a live process is delivered to onNewIntent and
    // a cold-launch share foregrounds the app — the in-repo Kotlin plugin
    // (SF3 native, pending) reads the content:// stream and calls
    // `share-import:seal_share`. Scope is `image/*` + `application/*` and
    // explicitly NOT `text/*` (SYNC-16): Myne never surfaces in a share sheet it
    // cannot act on, and EXTRA_TEXT is out of scope. NO <uses-permission> — the
    // sender grants a transient FLAG_GRANT_READ_URI_PERMISSION on the URI.
    tauri_utils::build::update_android_manifest(
        "MYNE SHARE TARGET (share-import, §9.20)",
        "activity",
        r#"<intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/*" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="image/*" />
                <data android:mimeType="application/*" />
            </intent-filter>"#
            .to_string(),
    )
    .expect("failed to update AndroidManifest.xml");
}
