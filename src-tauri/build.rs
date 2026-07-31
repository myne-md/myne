// Without `InlinedPlugin`, permissions under `permissions/vault-creation/`
// silently flatten into `__app-acl__` and the ACL resolver registers the
// `commands.allow` entries as bare names that never match the
// `plugin:vault-creation|<cmd>` form Tauri uses to authorize plugin
// invokes (tauri-utils `acl/resolved.rs::resolve_command`).
fn main() {
    let mut attributes = tauri_build::Attributes::new()
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
                "vault_storage_health",
                "vault_is_unlocked",
                "vault_slot_kind",
                // phase3-web-client task 30 adds `account_number_check` — a
                // LOCAL, network-free well-formedness check of an account
                // number (Crockford alphabet + length + the frozen Damm-32
                // check character). Registered on desktop too, even though the
                // screen that calls it is the web client's first-run identity
                // step: a command name that reaches an unregistered handler
                // fails at the ACL, and a shared `src/` tree can call it from
                // either client.
                "account_number_check",
            ]),
        )
        .plugin(
            "vault-recover",
            // Task 4 of `vault-recovery-from-phrase` ships
            // `recover_with_phrase`. Task 6 adds
            // `complete_recovery` (the A8f bundle). MYND-206 adds
            // `resolve_vault_by_account_number` (the optional
            // multi-vault recovery selector — header-only, no
            // decrypt). Adding a command here without a matching
            // `commands.allow` entry in
            // `permissions/vault-recover/default.toml` is a
            // security regression.
            tauri_build::InlinedPlugin::new().commands(&[
                "recover_with_phrase",
                "complete_recovery",
                "resolve_vault_by_account_number",
            ]),
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
            "vault-repair",
            // Task 3 of `vault-repair` (MYND-159) ships the read-only
            // `vault_residue_scan` command (orphan-artefact detection
            // for the Welcome banner). The destructive sweep command
            // lands in Task 4. Adding a command here without a matching
            // `commands.allow` entry in
            // `permissions/vault-repair/default.toml` is a security
            // regression.
            tauri_build::InlinedPlugin::new().commands(&["vault_residue_scan", "vault_repair"]),
        )
        .plugin(
            "quick-unlock",
            // MYND-329 task 6: PIN / biometric quick-unlock over the
            // auto-lock envelope. Ships the PIN setup/unlock/status/disable
            // commands (the biometric branch lands in task 7). Adding a
            // command here without a matching `commands.allow` entry in
            // `permissions/quick-unlock/default.toml` is a security
            // regression.
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
                "set_archived_folders",
                "set_device_name",
                "device_platform",
                "vault_set_label",
                "vault_set_icon",
                // MYND-613. NOTE: several shipped prefs setters
                // (`set_archive_disabled`, `set_show_note_timestamps`, …) are
                // registered in the handler list and in default.toml but are
                // MISSING from this mirror — pre-existing, not introduced here.
                "set_show_task_marker",
                "set_transcription_enabled",
                // MYND-651.
                "set_auto_tag_enabled",
                "set_reminders_enabled",
                "set_reminder_horizon_days",
                // developer-mode (MYND-593): named here too, though not
                // strictly required (the plugin's own InlinedPlugin
                // declaration above is what creates the `prefs:` ACL
                // namespace; a hand-written `[[permission]]` block in
                // permissions/prefs/default.toml is what actually wires this
                // one — see the `prefs_read` siblings above for the same
                // belt-and-suspenders pattern).
                "set_developer_mode",
            ]),
        )
        .plugin(
            "themes",
            // MYND-486: the vault-content custom-theme commands over the
            // encrypted `vault.themes` (`MYT1`) singleton — the replacement for
            // the retired device-local `app_config_dir/themes/` file commands.
            // The InlinedPlugin mirror is load-bearing per the `vault-creation`
            // note above (without it the `themes:` permissions flatten into
            // `__app-acl__` and never match the `plugin:themes|<cmd>` authorize
            // form); keep it lock-stepped with `permissions/themes/default.toml`.
            tauri_build::InlinedPlugin::new().commands(&[
                "themes_list",
                "themes_read",
                "themes_import",
                "themes_export",
                "themes_delete",
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
                "note_write_batch_transactional",
                "note_delete",
                "note_list",
                "note_titles_batch",
                "note_search",
                "note_snapshot_flush",
                "note_export_as_markdown",
                "note_export_attachments",
                "note_export_html",
                "note_export_html_attachments",
            ]),
        )
        .plugin(
            "snapshots",
            // MYND-96 (encrypted per-note snapshots) read/management
            // surface. The InlinedPlugin mirror is load-bearing per the
            // `vault-creation` note above; keep it lock-stepped with
            // `permissions/snapshots/default.toml`.
            tauri_build::InlinedPlugin::new().commands(&[
                "snapshot_list",
                "snapshot_preview",
                "snapshot_restore",
                "snapshot_prune",
            ]),
        )
        .plugin(
            "vault-indices",
            // MYND-31 (A11 — VaultIndices) ships `vault_indices_apply`
            // + `vault_indices_remove` (Task 1). Later tasks add the
            // query surface (`vault_indices_backlink_candidates`,
            // `vault_indices_forward`, `vault_indices_by_tag`,
            // `vault_indices_tag_tree`). Adding a command here without a
            // matching `commands.allow` entry in
            // `permissions/vault-indices/default.toml` is a security
            // regression (the InlinedPlugin mirror is load-bearing per
            // the `vault-creation` note above).
            tauri_build::InlinedPlugin::new().commands(&[
                "vault_indices_apply",
                "vault_indices_remove",
                "vault_indices_forward",
                "vault_indices_all_edges",
                "vault_indices_orphans",
                // MYND-612. NOTE: `vault_indices_block_anchors` (MYND-382) is
                // registered in the handler list and in default.toml but is
                // MISSING from this mirror — pre-existing, not introduced here.
                "vault_indices_tasks",
                "vault_indices_backlink_candidates",
                "vault_indices_by_tag",
                "vault_indices_tag_tree",
                "vault_indices_note_properties",
                "vault_indices_property_values",
                "vault_indices_property_keys",
                "vault_indices_persist",
                "vault_indices_hydrate",
            ]),
        )
        .plugin(
            "attachments",
            // MYND-169 (attachments-crypto-pipeline) ships
            // `attachment_import` (bytes/path import + dedup + 64 MiB
            // cap + allowlist + Slot::Unlocked gate), `catalog_list`
            // (library metadata read), and `attachment_delete`
            // (explicit blob + catalog-entry removal). The
            // `attachment://` URI scheme is NOT a command — it is
            // registered on the Builder in `lib.rs`. Adding a command
            // here without a matching `commands.allow` entry in
            // `permissions/attachments/default.toml` is a security
            // regression (the InlinedPlugin mirror is load-bearing per
            // the `vault-creation` note above).
            tauri_build::InlinedPlugin::new().commands(&[
                "attachment_import",
                "catalog_list",
                "attachment_delete",
                // MYND-259 (voice notes): native mic capture →
                // WAV → stored as an ordinary audio/wav attachment.
                "voice_record_start",
                "voice_record_stop",
                "voice_record_cancel",
            ]),
        )
        .plugin(
            "backup",
            // MYND-32 (vault backup export; restore joins with
            // MYND-218). `vault_export_backup` is the only path that
            // writes a `.myne-backup` container — the Rust core does
            // the IO; no `fs:` write scope is granted for backup files
            // (narrow-seam posture, the importer precedent). Lock-step
            // with `permissions/backup/default.toml`; adding a command
            // here without a matching `commands.allow` entry is a
            // security regression (the InlinedPlugin mirror is
            // load-bearing per the `vault-creation` note above).
            tauri_build::InlinedPlugin::new().commands(&[
                "vault_export_backup",
                "vault_restore_backup",
                "backup_default_filename",
                "backup_cancel",
                // MYND-351: device-local automatic-backup schedule config
                // (read/write the `vaults/backup-schedule.json` store) +
                // the scheduler's post-run result recorder (ledger append +
                // keep-last-N prune / failure stamp).
                "backup_schedule_read",
                "backup_schedule_write",
                "backup_schedule_record_result",
            ]),
        )
        .plugin(
            "export",
            // MYND-211 (whole-vault plaintext markdown tree export).
            // `vault_export_markdown` is the only path that writes the
            // exported tree — the Rust core does the IO; the WebView
            // only picks the destination via the dialog plugin (the
            // backup narrow-seam posture). Lock-step with
            // `permissions/export/default.toml`; adding a command here
            // without a matching `commands.allow` entry is a security
            // regression (the InlinedPlugin mirror is load-bearing per
            // the `vault-creation` note above).
            tauri_build::InlinedPlugin::new()
                .commands(&["vault_export_markdown", "vault_export_cancel"]),
        )
        .plugin(
            "secret-export",
            // Recovery-kit / account-number `.txt` save (vault-creation
            // PhraseStep/AccountStep). `save_secret_text` is the ONLY path that
            // writes a user-chosen secret file — the Rust core does the IO; the
            // WebView only picks the destination via the dialog plugin and the
            // command re-validates it (rejecting the app-data/vault tree). No
            // `fs:` write scope is granted (narrow-seam, TB6). Lock-step with
            // `permissions/secret-export/default.toml`; adding a command here
            // without a matching `commands.allow` entry is a security regression
            // (the InlinedPlugin mirror is load-bearing per the `vault-creation`
            // note above).
            tauri_build::InlinedPlugin::new().commands(&["save_secret_text"]),
        )
        .plugin(
            "importer",
            // MYND-53 (importer engine read-seam, SYNC-1). `import_read_dir`
            // + `import_read_file` are the ONLY external-dir read path — no
            // `fs:allow-read-text-file` / `read-dir` / read-scope is granted
            // to the WebView (least-privilege, TB6). Lock-step with
            // `permissions/importer/default.toml`; adding a command here
            // without a matching `commands.allow` entry is a security
            // regression (the InlinedPlugin mirror is load-bearing per the
            // `vault-creation` note above).
            tauri_build::InlinedPlugin::new().commands(&["import_read_dir", "import_read_file"]),
        )
        .plugin(
            "pdf-export",
            // MYND-255 task 4 (per-note PDF export). Two seats:
            // `pdf_export_render` is invoked by the MAIN window
            // (`pdf-export:default` in capabilities/default.json);
            // `pdf_export_payload` + `pdf_export_ready` are the
            // hidden render window's page-seat commands, granted
            // ONLY by capabilities/pdf-export.json (windows:
            // ["pdf-export"]). Adding a command here without a
            // matching `commands.allow` entry in
            // `permissions/pdf-export/default.toml` is a security
            // regression (the InlinedPlugin mirror is load-bearing
            // per the `vault-creation` note above).
            tauri_build::InlinedPlugin::new().commands(&[
                "pdf_export_render",
                "pdf_export_payload",
                "pdf_export_ready",
            ]),
        )
        .plugin(
            "workspace",
            // MYND-166: the `workspace_read` + `workspace_write` +
            // `workspace_stage` commands (encrypted vault.workspace
            // persistence; stage = in-RAM hold flushed on app quit). Same
            // InlinedPlugin discipline as the plugins above — each
            // command needs a matching `commands.allow` entry in
            // `permissions/workspace/default.toml` or the ACL resolver
            // never authorizes the `plugin:workspace|<cmd>` invoke.
            tauri_build::InlinedPlugin::new().commands(&[
                "workspace_read",
                "workspace_write",
                "workspace_stage",
            ]),
        )
        .plugin(
            "graph-layout",
            // The `graph_layout_read` + `graph_layout_write` commands
            // (encrypted vault.graph knowledge-graph layout cache, MYG1).
            // Same InlinedPlugin discipline as the plugins above — each
            // command needs a matching `commands.allow` entry in
            // `permissions/graph-layout/default.toml` or the ACL resolver
            // never authorizes the `plugin:graph-layout|<cmd>` invoke.
            tauri_build::InlinedPlugin::new()
                .commands(&["graph_layout_read", "graph_layout_write"]),
        )
        .plugin(
            "spell",
            // MYND-262/266: spell_check (read) + add_to_personal_dictionary /
            // ignore_word_in_vault (Slot::Unlocked-gated writers). InlinedPlugin
            // mirror load-bearing per the vault-creation note above; lock-step
            // with `permissions/spell/default.toml` or the ACL resolver never
            // authorizes the `plugin:spell|<cmd>` invoke.
            tauri_build::InlinedPlugin::new().commands(&[
                "spell_check",
                "spell_set_active_languages",
                "add_to_personal_dictionary",
                "ignore_word_in_vault",
            ]),
        )
        .plugin(
            "sync",
            // MYND-424 (Phase 2 client sync engine, SYNC-15). Task 3 ships
            // the device-local endpoint-config pair (SYNC-14):
            // `sync_get_endpoint` + `sync_set_endpoint`. Later tasks (and
            // MYND-425/426/427) add data-plane commands to this same plugin,
            // each gated on an authenticated session — deny-by-default. The
            // InlinedPlugin mirror is load-bearing per the `vault-creation`
            // note above; keep it lock-stepped with
            // `permissions/sync/default.toml` or the ACL resolver never
            // authorizes the `plugin:sync|<cmd>` invoke.
            tauri_build::InlinedPlugin::new().commands(&[
                "sync_get_endpoint",
                "sync_set_endpoint",
                "sync_status",
                "sync_unsynced_edits",
                "sync_materialisation_progress",
                "sync_now",
                "sync_list_devices",
                "sync_account_status",
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
                "sync_list_quarantine",
                "sync_read_quarantine",
                "sync_restore_quarantine",
                "sync_delete_quarantine",
                "sync_device_join_qr",
            ]),
        )
        .plugin(
            "clipper-pairing",
            // ext-foundation-handoff task 4 (TB10): the browser-extension
            // pairing dialog's NARROW WebView IPC surface — pairing_pending
            // (read the challenge), pairing_accept (mint a scoped revocable
            // token bound to the exact extension id), pairing_reject (clear
            // the session, no lingering auth). MYND-442 adds
            // clip_dispatch_complete (the WebView→Rust reply seam that
            // delivers a host↔relay clip dispatch's accepted/locked/error
            // outcome back to the blocked relay thread — registered here to
            // minimize ACL churn, same browser-extension surface). MYND-443
            // task 7 adds pairing_revoke (desktop-authoritative immediate
            // revoke + durable persist) and pairing_list_paired (read-only
            // Settings "Connected extensions" list). The stdio
            // native-messaging host is the SEPARATE, ACL-exempt ingress;
            // these are ordinary WebView→Rust IPC and TB6 governs them.
            // InlinedPlugin mirror load-bearing per the vault-creation note
            // above; keep it lock-stepped with
            // `permissions/clipper-pairing/default.toml` or the ACL resolver
            // never authorizes the `plugin:clipper-pairing|<cmd>` invoke.
            tauri_build::InlinedPlugin::new().commands(&[
                "pairing_pending",
                "pairing_accept",
                "pairing_reject",
                "pairing_revoke",
                "pairing_list_paired",
                "clipper_install_status",
                "clipper_install_set_enabled",
                "clip_dispatch_complete",
                "pairing_dispatch_complete",
            ]),
        )
        .plugin(
            "cli-bridge",
            // cli-thin-client task 12 (MYND-490): ONE read-only command behind
            // the Settings CLI-access block. It answers the two facts that are
            // deliberately not `vault.prefs` fields — how long ago the command
            // socket last served a request (RAM only; see
            // `cli_bridge::activity`) and whether `myne` is on the user's
            // `$PATH` at all, plus the shim dir for the one `export PATH=…`
            // line we decline to write into their shell profile
            // (`cli_bridge::path_shim` rule 3). No arguments, no vault access,
            // no writes. InlinedPlugin mirror load-bearing per the
            // vault-creation note above; keep it lock-stepped with
            // `permissions/cli-bridge/default.toml`.
            tauri_build::InlinedPlugin::new().commands(&["cli_access_state"]),
        );

    // local-ai (MYND-406): declare the `local-inference` plugin's ACL namespace
    // ONLY when the default-off `local-inference` feature is enabled — cargo
    // exposes it to build.rs as `CARGO_FEATURE_LOCAL_INFERENCE`. The permission
    // (`local-inference:infer`/`embed`) is then resolvable exactly when the
    // plugin is compiled and its runtime capability is added
    // (`plugins/local_inference/mod.rs`), so the default feature-OFF build has
    // no dangling `local-inference:default` reference. Lock-step the command
    // list with `permissions/local-inference/default.toml`.
    if std::env::var_os("CARGO_FEATURE_LOCAL_INFERENCE").is_some() {
        attributes = attributes.plugin(
            "local-inference",
            tauri_build::InlinedPlugin::new().commands(&[
                "infer",
                "embed",
                "semantic_search",
                "ask",
                "chat_stream",
                "chat_stop",
                "transcribe",
                "read_transcript",
                "set_model_path",
                "get_model_path",
            ]),
        );
    }

    tauri_build::try_build(attributes).unwrap();
}
