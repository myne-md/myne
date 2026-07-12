// Myne mobile — Tauri 2 host. Phase-1 vault + notes + prefs backend that
// consumes the shared `myne-core` crate (the single source of truth for the
// vault / notes / prefs plugin cores, extracted from the desktop crate) and the
// audited `protocol/` crate directly (no port). The still-desktop-only
// subsystems (clipper, auto-lock, backup, importer, themes, workspace, spell,
// AI-embeddings) are not carried over — the core command cores trigger those
// side-effects through the `myne_core::hooks::VaultLifecycleHooks` seam, into
// which mobile installs `hooks::MobileHooks` (no-op for every desktop-only
// side-effect; screen-capture protection is LIVE through that seam — see
// `screen_guard`, MYND-469). The
// `sync` plugin (MYND-458) IS registered here — a thin shim over
// `myne_core::plugins::sync` (all 14 commands, one deny-by-default
// `sync:default` capability, SYNC-15); its `bump_local_change` hook stays a
// no-op until the SyncLocalChange wiring lands (MYND-458 task 4). The
// snapshots subsystem lives in `myne-core`, so `MobileHooks` wires its two
// snapshot hooks to the real snapshot store — a note overwrite/delete on
// mobile captures/purges `.myn` snapshots just like desktop. `vault-indices`
// (MYI1) IS shared from `myne-core` and registered here (its lock-teardown
// wipe is a desktop-only hooks side-effect).
//
// See the main repo's `src-tauri/CLAUDE.md` "Secret-handling logging
// discipline" and `protocol/CLAUDE.md` for the rules these modules follow.

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

mod hooks;
#[cfg(target_os = "ios")]
mod ios_chrome;
mod pdf_export;
mod plugins;
mod screen_guard;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{Listener, Manager};

    // Install the log sink so the app's `tracing::*!` events reach stdout —
    // without this nothing is printed (the shared cores + `screen_guard` emit
    // `tracing` but no subscriber was wired; desktop `lib.rs` parity). On iOS
    // stdout lands in the `tauri ios dev` terminal; on Android it surfaces via
    // `adb logcat -s RustStdoutStderr` (`docs/dev/device-matrix.md` §6.1).
    // Honors the secret-handling logging discipline — bounded variant names /
    // stage tags only, never key material.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    tauri::Builder::default()
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
        .plugin(plugins::vault_indices::init())
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
        // MYND-458: the mobile `sync` shim over `myne_core::plugins::sync` — the
        // same 14 commands the desktop registers, gated by a single
        // deny-by-default `sync:default` capability (SYNC-15). Command bodies are
        // the shared-core compiled code; this crate adds only the wrapper +
        // capability entry. The scheduler/loop stays out (MYND-460).
        .plugin(plugins::sync::init())
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
            // The /sync/poke SSE listener (MYND-423 client half): while the app
            // is foregrounded + unlocked, a push on another device becomes a
            // pull here within seconds — baseline behaviour per the amended
            // sync-protocol §8.3 (no user toggle; polling stays the fallback).
            // The supervisor tears the stream down on suspend (via the
            // SyncLifecycleSignal above) and on lock, and parks on a revoked
            // token. Mirrors the desktop wiring.
            app.manage(myne_core::plugins::sync::poke_listener::SsePokeSignal::default());
            myne_core::plugins::sync::poke_listener::spawn_poke_supervisor(app.handle().clone());
            // MYND-31: app-level live in-RAM VaultIndices state (wikilink graph
            // + backlinks + tag index + typed properties), rebuilt on unlock by
            // the TS-orchestrated sweep. Mirrors the desktop `app.manage(...)`
            // wiring; the lock-teardown wipe is a desktop-only hooks side-effect
            // (mobile installs NoopHooks), so nothing tears it down here.
            app.manage(plugins::vault_indices::VaultIndicesState::default());
            // MYS1: app-level live in-RAM full-text search index (BM25). Fed by
            // the WebView via `search_index_replace` (the mobile client already
            // holds every note's plaintext, so it pushes the corpus down — no
            // Rust-side decryption/hydrate). Mirrors the desktop `app.manage(...)`
            // wiring; the lock-teardown wipe is a desktop-only hooks side-effect
            // (mobile installs NoopHooks), so nothing tears it down here — the
            // frontend re-pushes the corpus on the next unlock.
            app.manage(myne_core::search::SearchIndexState::default());
            // MYND-169: app-level live in-RAM attachment reference graph
            // (note → attachment-ids), rebuilt on unlock by the TS-orchestrated
            // note sweep. Mirrors the desktop `app.manage(...)` wiring; the
            // lock-teardown wipe is a desktop-only hooks side-effect (mobile
            // installs NoopHooks), so nothing tears it down here.
            app.manage(plugins::attachments::AttachmentRefsState::default());
            // Kill the native WKWebView keyboard "form assistant" bar (the
            // ‹ › ⌄ Done strip UIKit draws above the keyboard) — no web-side fix
            // exists for it. See `ios_chrome`. iOS-only; no-op elsewhere.
            #[cfg(target_os = "ios")]
            ios_chrome::suppress_keyboard_accessory_bar();

            // MYND-469: one-time secure-field layer splice, protection ON —
            // the pre-unlock always-ON invariant from before the first painted
            // frame. Setup runs inside the Ready dispatch AFTER the config
            // window exists, the startup point every deployed implementation
            // of this technique uses (the post-unlock variant crashed
            // on-device — see `screen_guard.rs`). Android needs no call here:
            // the Kotlin plugin's `load()` applies FLAG_SECURE itself.
            #[cfg(target_os = "ios")]
            screen_guard::init(app.handle());

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
                        pdf_export::present(&payload.title, &payload.html)
                    });
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
