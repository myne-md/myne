// SPDX-License-Identifier: AGPL-3.0
// Without `InlinedPlugin`, permissions under `permissions/<plugin>/`
// silently flatten into `__app-acl__` and the ACL resolver registers the
// `commands.allow` entries as bare names that never match the
// `plugin:<plugin>|<cmd>` form Tauri uses to authorize plugin invokes
// (tauri-utils `acl/resolved.rs::resolve_command`). Mirror of the desktop
// `src-tauri/build.rs`, covering the plugins registered on mobile: vault
// lifecycle + notes (CRUD/list) + prefs + quick-unlock (PIN everywhere, biometric
// on iOS) + vault-indices + snapshots + attachments (image OCR; no voice) +
// search + export + secret-export + PDF capture (`pdf_export`). Not carried over:
// voice capture, PDF/DOCX/text extraction on the attachment path, and clipper
// pairing.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            // Agentic note editing (myne-md/myne#456). Every one of the nine
            // reaches decrypted note plaintext and two of them WRITE, so the
            // capability that bundles them is main-window-only.
            .plugin(
                "agent",
                tauri_build::InlinedPlugin::new().commands(&[
                    "agent_start",
                    "agent_approve_scope",
                    "agent_preview_grant",
                    "agent_cancel",
                    "agent_apply",
                    "agent_undo",
                    "agent_last_run",
                    "agent_capability",
                    "agent_list_provider_models",
                ]),
            )
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
                    // myne-md/myne#476 adds `vault_active_id`, the AUTHORITATIVE
                    // "which vault is open" answer, read from the runtime slot
                    // map. Desktop has had it since #250, which removed the
                    // TS-side `resolveActiveVaultId()` for ordering a
                    // best-effort disk cache that only the password-unlock path
                    // ever stamped: after a quick-unlock or a recovery it named
                    // a DIFFERENT vault than the one actually open, and the
                    // danger-zone delete erased that one (#241). Mobile still
                    // carried the deleted function and could not call this
                    // command at all, because it was registered nowhere here.
                    "vault_active_id",
                    // myne-md/myne#911: the identity phrase as a vault credential.
                    // The sealed `NTV7` person wrap is opened by the person phrase,
                    // and the probe decides whether an unlock screen offers that
                    // door at all. Granted at
                    // `permissions/vault-unlock/default.toml` and registered in the
                    // plugin; this mirror was the missing third of the four steps.
                    "unlock_with_person_phrase",
                    "vault_is_person_wrapped",
                ]),
            )
            .plugin(
                "vault-recover",
                // Adding a command here without a matching
                // `commands.allow` entry in
                // `permissions/vault-recover/default.toml` is a security
                // regression.
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
                    // AI (myne-md/myne#456). Six: the device-local opt-in, the
                    // provider selection, its consent, its model, the key
                    // (write-only), and the has-key probe that exists so the
                    // key never has a getter.
                    "set_ai_enabled",
                    "set_ai_provider",
                    "set_ai_provider_consent",
                    "set_ai_provider_key",
                    "set_ai_provider_model",
                    "ai_provider_has_key",
                    "set_deliberate_folders",
                    "set_archived_folders",
                    // Periodic-notes settings (myne#177, wired to mobile by
                    // myne-md/myne#880): one weekly/monthly entry of the
                    // `periodic_notes` map. Shared core setter; same three-site
                    // lockstep as every other prefs command here.
                    "set_periodic_note_setting",
                    // Graph colour groups (myne-md/myne#880): a whole-list replace of
                    // the rule sequence. Shared core setter; same three-site lockstep.
                    "set_color_groups",
                    // AI excluded folders (myne-md/myne#880): the set the AI
                    // refusal path honours, mutated by verbs. Shared core setter.
                    "set_ai_excluded_folders",
                    // AI limits (myne-md/myne#880): the device-local chat-history
                    // budget and the shared meeting prompt. Shared core setters.
                    "set_chat_history_budget",
                    // Attachment image OCR (myne-md/myne#880): the device-local
                    // opt-out the mobile import path already reads.
                    "set_attachment_ocr_enabled",
                    "set_meeting_ai_prompt",
                    "set_device_name",
                    "device_platform",
                    "vault_set_label",
                    // vault-icons: the label's twin. Naming a command here is
                    // OPTIONAL (the autogenerated allow-/deny- pair is what a
                    // hand-written [[permission]] block supplies just as well —
                    // src-tauri/AGENTS.md "Capability ACL"), and most prefs
                    // commands appear nowhere in this list. Listed anyway so the
                    // pair does not read as half-wired; the fail-closed sites
                    // are the permission file and the generate_handler.
                    "vault_set_icon",
                    // MYND-619 task 8: the two device-local reminder fields the
                    // desktop feature defined. Consumed here, not redefined —
                    // the struct, codec, sync classification and core setters
                    // are already shared through `myne-core`; what mobile was
                    // missing was purely the three registration sites (this
                    // list, the permission file, the invoke_handler), and a
                    // command absent from any of them fails CLOSED at runtime.
                    "set_reminders_enabled",
                    "set_reminder_horizon_days",
                    // MYND-563: on-device transcription opt-out (default on).
                    // Shared core setter; registered here, in the prefs
                    // generate_handler, and permissions/prefs/default.toml — a
                    // command absent from any of the three fails CLOSED.
                    "set_transcription_enabled",
                    // Left ribbon (myne-md/myne#699): the rail's pinned command
                    // ids + visibility flag. Shared core setters; same
                    // three-site lockstep (this list, the permission file, the
                    // invoke_handler).
                    "set_ribbon_items",
                    "set_ribbon_visible",
                ]),
            )
            .plugin(
                "notes",
                tauri_build::InlinedPlugin::new().commands(&[
                    "note_create",
                    "note_read",
                    "note_update",
                    "note_set_field",
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
                // sealed pending captures drained into notes on unlock, plus the
                // watch meeting-capture lane (myne-md/myne#812): arrived audio
                // chunks sealed on the fly under the same device key into a
                // pending-meeting manifest. Adding a command here without a
                // matching entry in `permissions/captures/default.toml` is a
                // security bug.
                "captures",
                tauri_build::InlinedPlugin::new().commands(&[
                    "seal_staged",
                    "take_pending",
                    "ack",
                    // The watch meeting lane. Every lane command is declared (not just
                    // the seal) so the `InlinedPlugin` roster matches the
                    // `generate_handler!` registration and the ACL grant: a command
                    // reachable through two of the three and absent from this list
                    // is the drift `check-mobile-plugin-acl.mjs` exists to refuse.
                    "seal_meeting_chunk",
                    "seal_meeting_inbox",
                    "drain_pending_meetings",
                    "set_meeting_session_note",
                    "ack_meeting_session",
                ]),
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
                // same 16 commands the desktop registers. Adding a command here
                // without a matching entry in
                // `permissions/vault-indices/default.toml` is a security bug.
                // The count is a weak stand-in for the parity check
                // `plugins::agent` carries; it has been stale twice.
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
                    "vault_indices_property_values",
                    "vault_indices_property_keys",
                    "vault_indices_persist",
                    "vault_indices_hydrate",
                    "vault_indices_tasks",
                    // myne-md/myne#452: the `[[##` and `[[^^` whole-vault picker
                    // dumps. Both pickers already mount on mobile, so their
                    // absence here showed up as two pickers that opened empty.
                    "vault_indices_headings",
                    "vault_indices_block_anchors",
                ]),
            )
            .plugin(
                // MYS1 full-text search (frontend-fed): a NEW local mobile
                // plugin (not a `myne-core` re-export) driving the shared BM25
                // engine. Adding a command here without a matching entry in
                // `permissions/search/default.toml` is a security bug.
                "search",
                tauri_build::InlinedPlugin::new().commands(&[
                    "search_index_replace",
                    "search_index_apply",
                    "search_index_remove",
                    "note_search",
                ]),
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
                // Knowledge-graph layout cache (MYG1, §9.19): shared from
                // `myne-core`; the same two commands the desktop registers.
                // Adding a command here without a matching entry in
                // `permissions/graph-layout/default.toml` is a security bug.
                "graph-layout",
                tauri_build::InlinedPlugin::new()
                    .commands(&["graph_layout_read", "graph_layout_write"]),
            )
            .plugin(
                // AI conversations (MYM1 catalog + MYJ1 files, myne-md/myne#675):
                // shared from `myne-core`; the same six commands the desktop
                // registers. Adding a command here without a matching entry in
                // `permissions/chats/default.toml` is a security bug.
                "chats",
                tauri_build::InlinedPlugin::new().commands(&[
                    "chats_create",
                    "chats_append_turn",
                    "chats_read",
                    "chats_list",
                    "chats_rename",
                    "chats_delete",
                ]),
            )
            .plugin(
                // Agent memory (MYN1 catalog + MYX1 files + MYZ1 personality,
                // myne-md/myne#697): shared from `myne-core`; the same six
                // commands the desktop registers. Adding a command here
                // without a matching entry in
                // `permissions/memory/default.toml` is a security bug.
                "memory",
                tauri_build::InlinedPlugin::new().commands(&[
                    "memory_list",
                    "memory_read",
                    "memory_write",
                    "memory_delete",
                    "personality_read",
                    "personality_write",
                ]),
            )
            .plugin(
                // Sealed label store (MYL1, §9.22): the device-local
                // hide-vault-names option (myne-md/myne#411): shared from
                // `myne-core`; the same THREE commands the desktop registers, and
                // all three are needed. The probe (`vault_label_keychain_status`)
                // is the one that looks droppable and is the one mobile needs
                // most: `platform_keychain` has an Apple backend and returns
                // `UnavailableKeychain` elsewhere, so on Android the store holds
                // nothing today and the row's whole job there is to say so.
                // Adding a command here without a matching entry in
                // `permissions/vault-label/default.toml` is a security bug.
                "vault-label",
                tauri_build::InlinedPlugin::new().commands(&[
                    "hide_vault_names",
                    "set_hide_vault_names",
                    "vault_label_keychain_status",
                ]),
            )
            .plugin(
                // Account record (the account/vault split, myne-md/myne#684):
                // shared from `myne-core`; the same ONE read-only command the
                // desktop registers (move/split removed, myne-md/myne#937). On
                // iOS the keychain exists so grouping works; on Android
                // `platform_keychain` has no backend, so the store holds nothing
                // and vaults show standalone (never an error, never plaintext).
                // Adding a command here without a matching entry in
                // `permissions/account/default.toml` is a security bug.
                "account",
                tauri_build::InlinedPlugin::new().commands(&["account_list"]),
            )
            .plugin(
                // Custom themes (MYT1, §9.21): shared from `myne-core`, but ONE
                // command of desktop's five — mobile is a read-only consumer of
                // a store the desktop authors, and the other four must not be
                // added here (`plugins/themes/mod.rs` says why each is out).
                // Adding a command here without a matching entry in
                // `permissions/themes/default.toml` is a security bug.
                "themes",
                tauri_build::InlinedPlugin::new().commands(&["themes_list"]),
            )
            .plugin(
                // Workspace state (MYW1, §9.7): mobile-LOCAL plugin carrying the
                // sidebar folder-expand set (MYND-561). TWO commands — desktop's
                // third (`workspace_stage`, its Cmd+Q RAM-staging) has no mobile
                // analog and is deliberately not registered, so it must not
                // appear here either. Adding a command here without a matching
                // entry in `permissions/workspace/default.toml` is a security bug.
                "workspace",
                tauri_build::InlinedPlugin::new().commands(&["workspace_read", "workspace_write"]),
            )
            .plugin(
                // MYND-458: the mobile `sync` shim over `myne_core::plugins::sync`.
                // The SAME commands the desktop registers, deny-by-default.
                // (MYND-459 T12: `sync_head_fingerprint` added — the SY-05 SAS
                // eye-compare substrate, exposed on mobile to match desktop F3-T4.
                // MYND-427 follow-up: the recovered-notes quarantine quartet —
                // list/read/restore/delete — registered for parity; no mobile UI
                // surfaces it yet.)
                // This list, the `generate_handler!` in `plugins/sync/mod.rs`, and
                // `permissions/sync/default.toml` `commands.allow` MUST match
                // exactly, or the ACL resolver fails closed. Read those three for
                // the count: this comment said 21 long after the list had passed
                // fifty (myne-md/myne#849 review). Adding a
                // command here without a matching permission entry is a security
                // bug (SYNC-15). The lifecycle pair is mobile-only (desktop
                // never manages the SyncLifecycleSignal).
                "sync",
                tauri_build::InlinedPlugin::new().commands(&[
                    "sync_get_endpoint",
                    "sync_set_endpoint",
                    "sync_status",
                    "sync_now",
                    "sync_publish_vault",
                    "sync_published_state",
                    "sync_person_list_vaults",
                    "sync_person_register",
                    "sync_person_account_number",
                    "sync_person_join_device",
                    "sync_person_claim_device",
                    "sync_person_unlock",
                    "sync_person_setup",
                    "sync_person_status",
                    "sync_person_list_invites",
                    "sync_person_lock",
                    "sync_person_create_invite",
                    "sync_list_vault_invites",
                    // The recipient's refusal of an invitation
                    // (decisions/protocol/0732): a real server-side delete.
                    "sync_person_decline_invite",
                    "sync_person_accept_invite",
                    // member-devices task 7: a member's SECOND device joins the
                    // vault from the phrase alone. Takes no owner code from the
                    // user: the pinned owner half is read from the person's own
                    // sealed `MYY5` profile, where the accepting device put it.
                    "sync_member_join_vault",
                    "sync_member_vault_status",
                    "sync_person_set_member_password",
                    "sync_person_unlock_member_vault_with_password",
                    "sync_person_set_member_pin",
                    "sync_person_set_member_biometric",
                    "sync_person_unlock_member_vault_with_pin",
                    "sync_person_unlock_member_vault_with_biometric",
                    "sync_member_unlock_status",
                    "sync_person_clear_member_unlock",
                    "sync_list_roster",
                    "sync_remove_member",
                    "sync_list_devices",
                    "sync_account_status",
                    "sync_approve_device",
                    "sync_device_admission_start",
                    "sync_device_admission_confirm",
                    "sync_device_admission_preview",
                    "sync_device_admission_accept",
                    "sync_device_admission_cancel",
                    "sync_remove_device",
                    "sync_pending_conflicts",
                    "sync_take_conflict",
                    "sync_resolve_conflict",
                    "sync_mark_tombstone",
                    "sync_enroll",
                    "sync_join_account",
                    "sync_reset_local",
                    "sync_head_fingerprint",
                    // myne#462: the device-verification push hold. In-RAM flag
                    // only; holds CONTENT pushes while a SYNC-40 eye-compare is
                    // open so the head both screens read cannot move under them.
                    "sync_verify_hold_begin",
                    "sync_verify_hold_end",
                    "sync_list_quarantine",
                    "sync_read_quarantine",
                    "sync_restore_quarantine",
                    "sync_delete_quarantine",
                    "sync_lifecycle_suspend",
                    "sync_lifecycle_resume",
                    "sync_decode_join_qr",
                    // myne-md/myne#849 task 7: the identity resolver the presence
                    // labels ride on. A peer's `join`/`presence` frame carries an
                    // Automerge actor and no name the store may use
                    // (`awarenessUpsert` discards the wire's), so the roster and the
                    // caret label come from this command alone. Desktop has granted
                    // it since `collab-provenance` task 2; mobile registered neither
                    // the command nor the grant, so a peer's row rendered the
                    // degraded device form on this client with every gate green.
                    "resolve_identity",
                ]),
            )
            .plugin(
                // Live co-editing sessions (epic live-collab, `collab-editor-bridge`):
                // the six shared-core live-session commands the desktop registers.
                // `lib.rs` already managed the `LiveSessionRegistry` and spawned the
                // awareness supervisor; without this registration the plugin's
                // commands are unreachable from the mobile WebView and a peer's
                // presence reaches no surface. The `InlinedPlugin` mirror is
                // load-bearing: without it the `live:` permissions flatten into
                // `__app-acl__` and never match the `plugin:live|<cmd>` authorize
                // form. Keep lock-stepped with the `generate_handler!` in
                // `plugins/live/mod.rs` AND with `permissions/live/default.toml`.
                "live",
                tauri_build::InlinedPlugin::new().commands(&[
                    "live_session_open",
                    "live_session_patch_frontmatter",
                    "live_session_take_remote_splices",
                    "live_session_read",
                    "live_session_set_presence",
                    "live_session_close",
                ]),
            )
            .plugin(
                // The B2B member display-name commands over the encrypted
                // `vault.member-names` (`MYO5`) singleton, which is group-tier
                // sealed and `NTV6`-only (decisions/protocol/0666, myne-md/myne#851
                // task 15). Shared from `myne-core`; the same three commands the
                // desktop registers. The `InlinedPlugin` mirror is load-bearing:
                // without it the `member-names:` permissions flatten into
                // `__app-acl__` and never match the `plugin:member-names|<cmd>`
                // authorize form. Keep lock-stepped with the `generate_handler!` in
                // `plugins/member_names/mod.rs` AND with
                // `permissions/member-names/default.toml`. All three lists must
                // agree, and `scripts/check-mobile-plugin-acl.mjs` compares them.
                "member-names",
                tauri_build::InlinedPlugin::new().commands(&[
                    "member_names_list",
                    "member_names_set_mine",
                    "member_names_clear_mine",
                ]),
            )
            .plugin(
                // The B2B device-to-person binding commands over the encrypted
                // `vault.device-bindings` (`MYU5`) singleton, which is group-tier
                // sealed and `NTV6`-only (protocol.md §9.30, the `member-devices`
                // feature). Shared from `myne-core`; the same two commands the
                // desktop registers. The `InlinedPlugin` mirror is load-bearing:
                // without it the `device-binding:` permissions flatten into
                // `__app-acl__` and never match the `plugin:device-binding|<cmd>`
                // authorize form. Keep lock-stepped with the `generate_handler!` in
                // `plugins/device_binding/mod.rs` AND with
                // `permissions/device-binding/default.toml`. All three lists must
                // agree, and `scripts/check-mobile-plugin-acl.mjs` compares them.
                "device-binding",
                tauri_build::InlinedPlugin::new()
                    .commands(&["device_bindings_list", "device_bindings_claim"]),
            )
            .plugin(
                // On-device speech-to-text (MYND-563): creates the
                // `local-inference:` ACL namespace + auto-generates
                // `allow-transcribe` / `allow-read-transcript`. NOT feature-gated
                // in build.rs (unlike the desktop `CARGO_FEATURE_LOCAL_INFERENCE`
                // gate) — the runtime capability is added only when the
                // `local-inference` feature registers the plugin
                // (`local_inference/mod.rs`), so a feature-off build leaves an
                // unreferenced namespace, never a dangling grant. Lock-step this
                // list with the `generate_handler!` in that mod.
                "local-inference",
                tauri_build::InlinedPlugin::new().commands(&["transcribe", "read_transcript"]),
            )
            .plugin(
                // The one destination a plaintext export may name
                // (myne-md/myne#517). `export_path` resolves the export
                // directory, creates it, excludes it from the platform's
                // automatic cloud backup and sanitizes the filename, in one
                // call, so the WebView composes no destination of its own and
                // `core:path:default` could be dropped from
                // `capabilities/default.json`. Adding a command here without a
                // matching entry in `permissions/export-dir/default.toml` is a
                // security bug.
                "export-dir",
                tauri_build::InlinedPlugin::new().commands(&["export_path"]),
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
