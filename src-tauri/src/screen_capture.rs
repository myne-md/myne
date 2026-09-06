//! Screen-capture protection — startup default-ON + runtime override.
//!
//! The original two-function public API, per `decisions.md` 2026-05-27
//! entries ("Tauri `set_content_protected` abstraction over direct
//! FFI" + "Lock-on-default-ON" + "Vault preferences blob") and
//! MYND-160 grill Q5.3:
//!
//! - [`init`] — startup hook called from `tauri::Builder::setup`. Calls
//!   `set_content_protected(true)` before the window's first paint
//!   (the load-bearing `visible: false` → protect → `show()` chain),
//!   then shows the window. Failure of `set_content_protected` is
//!   best-effort + tracing::warn; failure of `show()` propagates.
//! - [`apply`] — runtime override called from `vault_unlock` (post-
//!   `items_key_unwrap`, with the user's persisted toggle), from
//!   `vault_lock` (post-zeroize, always `true` per the lock-on-default-
//!   ON discipline), and from the `set_screen_capture_protection`
//!   prefs IPC (with the new toggle value, after the disk write
//!   succeeds). Best-effort: never propagates, never panics. Window-
//!   not-found degrades to a single tracing::warn so a stale call
//!   after `tauri::AppHandle::cleanup_before_exit` does not blow up.
//!
//! Two more entry points landed with myne-md/myne#482 and #483:
//!
//! - [`reassert`]. Re-apply whatever was last requested, for a window
//!   that has just come back from hidden. See [`ScreenCaptureState`].
//! - [`show_protected`]. The one implementation of "bring the main
//!   window back", replacing the `unminimize` / `show` / `set_focus`
//!   block that was written out at three call sites and missing its
//!   protection step at all three.
//!
//! All of them bottom out in [`apply_inner`], which is `pub(crate)`
//! rather than private because the pdf-export plugin drives its own
//! hidden render window through it. The
//! `site: &'static str` parameter distinguishes the call sites
//! in tracing output (`"startup_init"` / `"runtime_apply"` /
//! `"lock_reset"` / `"pdf_export_window"`, and now
//! `"single_instance_show"` / `"macos_reopen"` / `"clipper_raise"` /
//! `"webview_reveal"`, and the detached-window pair
//! `"detached_window_create"` / `"detached_window_reveal"` of myne#680)
//! without expanding the public API. Semantic
//! intent travels in tracing labels rather than additional functions.
//! There is **no** `reset_to_default` function; lock-time callers use
//! `apply(app, true)` with the appropriate site label.
//!
//! ## The device-local override
//!
//! Every state the MAIN-WINDOW entry points apply ([`init`], [`apply`],
//! [`reassert`], [`show_protected`]) is `requested && !override`, where
//! the override is the device-local escape hatch of myne-md/myne#482
//! ([`myne_core::screen_capture_override`]) plus the
//! `--disable-screen-capture-protection` process flag. It exists because
//! the protection is always ON before unlock and the toggle that could
//! clear it is sealed inside `vault.prefs`, so a user on remote-control
//! software or a magnifier could see a black unlock screen with no path
//! to the control. It is **device-wide, not pre-unlock-only**: an
//! override that lapsed at unlock would put the black window straight
//! back in front of the person it exists for.
//!
//! The DETACHED-WINDOW entry points ([`apply_to`], [`raise_protected`],
//! myne-md/myne#680) honor the same override, through [`mirror_effective`]
//! rather than [`resolve`]: a detached note window MIRRORS the main window's
//! current requested state and never records a request of its own, so
//! `last_requested`'s sole writer stays [`apply`]. The value they apply is the
//! same `requested && !override` the main window is showing, so an opted-out
//! device leaves a pop-out unprotected exactly as it leaves the main window.
//!
//! [`apply_inner`] is deliberately outside that sentence, and the four
//! lines above say why it is `pub(crate)`: the pdf-export plugin drives
//! its own hidden render window through it with an unconditional `true`,
//! bypassing [`resolve`] and therefore the override. That window is never
//! user-visible, so always-on costs nothing there and a device-local
//! escape has no referent. Said out loud because a blanket "every state"
//! in a security module's header is the class of over-claim this
//! repository records against rosters and failure messages.
//!
//! ## Failure-mode asymmetry
//!
//! - `set_content_protected` `Err`: best-effort defense-in-depth per
//!   `threat-model.md` §1 A7 + §6 → warn-and-continue with a closed-
//!   enum kind tag.
//! - `window.show` `Err` (only in [`init`]): structural — the window is
//!   unusable, the app cannot proceed → propagate via `?`.
//! - Window lookup `None` (only in [`apply`]): runtime degradation
//!   (post-cleanup call, hypothetical multi-window edge) → warn and
//!   return; no propagation.
//!
//! ## Platform support
//!
//! Per tao 0.35.x (Tauri's underlying window crate). Note the split
//! between "the call is made" and "the call protects anything" — they
//! are the same on Windows and NOT the same on macOS:
//!
//! - **Windows 10 build 19041+**: real call, real effect. The window is
//!   excluded from every capture path DWM composes. Older Windows
//!   builds silently degrade to `WDA_MONITOR` (black box, not
//!   exclusion) because the tao Windows arm discards the
//!   `SetWindowDisplayAffinity` return BOOL.
//! - **macOS**: real call (`setSharingType(NSWindowSharingType::None)`),
//!   **no protection claimed**. Apple documents `NSWindowSharingNone` as
//!   "a legacy constant that macOS no longer uses" and says not to use
//!   it to hide content from capture; DTS states no public API exists
//!   for this. The call stays because it still has an effect on some
//!   paths and costs nothing, but nothing may be claimed for it — see
//!   `threat-model.md` §6 and `decisions.md` 2026-08-15, which
//!   supersedes the macOS clause of 2026-05-27. The constant is NOT
//!   formally deprecated, so nothing in the build will ever warn about
//!   this; the docs are the only mechanism.
//! - **iOS / Android / Linux**: compile-time no-op
//!   (`#[cfg(any(macos, windows))]` gate in tao). Tauri returns
//!   `Ok(())` on Linux regardless, so the Linux warn must be
//!   `#[cfg(target_os = "linux")]`-gated explicitly inside the Ok arm.
//!
//! ## Capability ACL
//!
//! [`init`], [`apply`] and [`reassert`] are Rust-internal entry points,
//! called from the host's setup hook, from other plugins, and from the
//! override-set command respectively. **[`show_protected`] is not**: it
//! is also reached from page context as
//! `plugin:screen-capture|screen_capture_show_protected`, gated by
//! `screen-capture:allow-screen-capture-show-protected`, because the
//! fourth re-show site is the WebView asking for its window back after
//! idle auto-lock (`src/hooks/useRevealAfterIdleLock.ts`). It takes no
//! argument and every value it applies is state the backend already
//! holds, so the strongest thing page context can do with it is re-show
//! the window in the state it was already meant to be in. That grant
//! REPLACED `core:window:allow-show`, whose only consumer this was.
//!
//! Two other IPCs govern this module's inputs and live elsewhere: the
//! per-vault `set_screen_capture_protection` in the prefs plugin
//! (`prefs:allow-set-screen-capture-protection`), and the device-local
//! override pair in `plugins::screen_capture`
//! (`screen-capture:allow-screen-capture-override-{get,set}`).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline". The
//! warn-on-failure path uses a closed-enum kind helper, never `?e`
//! Debug-formats the underlying `tauri::Error`.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

/// Everything every screen-capture decision on the main window is made from,
/// `app.manage`d once in `Builder::setup` before [`init`] runs.
///
/// ## Why the requested value is recorded rather than re-derived
///
/// myne-md/myne#483 is that protection is applied at the lock site and at no
/// re-show site, and the Windows affinity is reported to reset across a
/// hide/show cycle (tauri-apps/tauri#14189; Electron fixed the same thing in
/// electron/electron#45868). Closing it means re-applying after every `show()`,
/// which needs an answer to "what state should this window be in right now".
///
/// The issue proposed deriving it. `true` while the vault is locked, the
/// persisted preference once unlocked. That answer needs a `VaultRuntimeState`
/// read at each site, which is async behind an `RwLock` and would put a
/// `block_on` on the single-instance callback; and it is a *second* opinion
/// about a value [`apply`] already knows, so the two can disagree. Recording
/// what was last requested cannot disagree, because [`apply`] is the only
/// writer and every caller already routes through it.
///
/// ## Why the override is here rather than read per call
///
/// The device-local escape hatch (myne-md/myne#482) lives in a file
/// ([`myne_core::screen_capture_override`]) and reading a file is async. It is
/// read once at startup, and re-read only when the command that writes it says
/// so, so every `apply` on the hot path stays a synchronous atomic load.
///
/// ## Two override sources, and only one of them is writable
///
/// The persisted file and the `--disable-screen-capture-protection` process
/// flag are kept apart rather than OR-ed once at startup, because the UI has to
/// be able to say which one is in force. A flag-launched run whose Privacy row
/// offered to "turn protection back on" would write `disabled: false` to disk,
/// report success, and leave the window exactly as unprotected as before.
#[derive(Debug)]
pub struct ScreenCaptureState {
    /// The persisted half of the override, as `screen-capture.json` had it at
    /// startup and as the command rewrites it.
    file_disabled: AtomicBool,
    /// The process-flag half.
    ///
    /// Atomic and set-only, because argv reaches this process twice. Once at
    /// launch, and once more whenever a SECOND launch is folded back in by
    /// `tauri-plugin-single-instance`, which is the shape the recovery path
    /// actually takes: the app is already running and showing a black window,
    /// and the user reaches for the flag from a terminal. It only ever goes
    /// from `false` to `true` for the same reason it used to be a plain
    /// `bool`: an argv cannot be un-passed, and a later launch without the
    /// flag is a request to run normally, not a request to override the
    /// override.
    via_flag: AtomicBool,
    /// The last state a caller *asked* for, before the override is folded in.
    /// Seeded `true` so a [`reassert`] that somehow precedes the first [`apply`]
    /// asks for protection rather than for its absence.
    last_requested: AtomicBool,
}

impl ScreenCaptureState {
    /// Seed from the startup resolution: the device-local file, and separately
    /// whether this run was launched with the flag.
    pub fn new(file_disabled: bool, via_flag: bool) -> Self {
        Self {
            file_disabled: AtomicBool::new(file_disabled),
            via_flag: AtomicBool::new(via_flag),
            last_requested: AtomicBool::new(true),
        }
    }

    /// Whether this device refuses protection, from either source.
    pub fn override_disabled(&self) -> bool {
        self.via_flag() || self.file_disabled.load(Ordering::Relaxed)
    }

    /// Whether the persisted file asks for the override, ignoring the flag.
    /// This is what the Settings control reflects, so a flag-launched run does
    /// not show a switch the user never set.
    pub fn file_disabled(&self) -> bool {
        self.file_disabled.load(Ordering::Relaxed)
    }

    /// Whether this process has been handed
    /// `--disable-screen-capture-protection`, at launch or by a later one.
    pub fn via_flag(&self) -> bool {
        self.via_flag.load(Ordering::Relaxed)
    }

    /// Fold in a flag that arrived on a SECOND launch.
    ///
    /// Set-only: there is no clearing counterpart, because a later launch
    /// WITHOUT the flag is a request to run normally rather than a request to
    /// cancel an override the user asked for a moment ago. Quitting is how a
    /// flag is un-passed, which is what a new process means.
    pub fn note_flag_relaunch(&self) {
        self.via_flag.store(true, Ordering::Relaxed);
    }

    /// Point the persisted half at a new value. The caller re-applies; this
    /// only records, so the write to disk and the native call keep the ordering
    /// the prefs IPC already establishes (disk first, then native).
    pub fn set_file_disabled(&self, disabled: bool) {
        self.file_disabled.store(disabled, Ordering::Relaxed);
    }

    /// The last requested state, as [`reassert`] replays it.
    pub fn last_requested(&self) -> bool {
        self.last_requested.load(Ordering::Relaxed)
    }

    /// Record what was asked for and answer what may actually be applied.
    ///
    /// The override only ever *removes* protection (`requested && !override`),
    /// so a device that has opted out cannot be protected by a later `apply`,
    /// and a device that has not opted out is unaffected by this line.
    ///
    /// What is recorded is the **requested** value, not the resolved one. If it
    /// were the resolved one, an opted-out device would record `false` forever
    /// and clearing the override would then re-assert that `false`.
    fn record_and_resolve(&self, requested: bool) -> bool {
        self.last_requested.store(requested, Ordering::Relaxed);
        requested && !self.override_disabled()
    }
}

/// The argv flag that turns protection off for one run.
///
/// Signal shipped `--disable-screen-security` one day after the first
/// remote-desktop lockout report (7.56). This is the same escape hatch under a
/// name that says what it disables, and it exists *alongside* the persisted
/// override rather than instead of it: a person who cannot see the window at
/// first run has no terminal in front of them, and a person whose
/// `screen-capture.json` is unreadable has no working control (that file fails
/// towards protection, deliberately
/// ([`myne_core::screen_capture_override::protection_disabled_at_rest`]).
pub const DISABLE_FLAG: &str = "--disable-screen-capture-protection";

/// Whether `args` (the process argv, minus the program) carries [`DISABLE_FLAG`].
///
/// Takes the iterator rather than reading argv itself so the match can be
/// tested, and compares `OsStr` rather than `String`: `std::env::args()` panics
/// on non-UTF-8 argv, and `lib.rs` already carries a comment about not putting
/// that on the boot path.
pub fn flag_in<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let flag = std::ffi::OsStr::new(DISABLE_FLAG);
    args.into_iter().any(|a| a.as_ref() == flag)
}

/// Any `myne://` element in an argv.
///
/// Matched on the scheme prefix rather than parsed, deliberately: a parser that
/// rejected a malformed URL would answer "not a deep link" for exactly the
/// inputs worth refusing. Case-insensitive because a URL scheme is.
fn carries_deep_link<S: AsRef<std::ffi::OsStr>>(arg: &S) -> bool {
    // The SCHEME, not the scheme-plus-authority. `myne://` matches only the
    // authority form and steps around every other legal spelling of the same
    // URL: `myne:theme/install` and `myne:/x` are both valid URIs with this
    // scheme and neither starts with `myne://`, so an argv carrying one reached
    // the permissive `flag_in` (myne-md/myne#482, found by review).
    //
    // What that costs is bounded but real: the flag and the `myne://` ingress
    // arrive on the same vector, and `threat-model.md` §7 rates that ingress as
    // reachable by ANY website. Refusing on the scheme alone means a token that
    // both names this scheme and carries the flag is refused however it is
    // spelled, which is the property the function's own name claims.
    //
    // A bare `myne:` prefix is enough and is not over-broad: an argv token
    // starting with `myne:` is a URI with this scheme by construction, since a
    // scheme is everything before the first colon and cannot contain one.
    arg.as_ref()
        .to_string_lossy()
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("myne:")
}

/// The form of [`flag_in`] every OS-DELIVERED argv goes through, and the whole
/// difference is a refusal.
///
/// The `myne://` ingress and this flag arrive on the same vector, and
/// `threat-model.md` § 7 rates that ingress as reachable by **any website** and
/// as a nuisance-class capability, "not a data one". Whether a URL can become a
/// second argv token at all depends on the Windows `"%1"` registry quoting and
/// on browser escaping. That was not measured, and a rating resting on an
/// unmeasured assumption is the shape this refusal exists to remove: an argv
/// carrying a deep link cannot carry this flag under any quoting, so the
/// ingress's authority is unchanged **by construction** rather than by
/// argument.
///
/// **Both entry paths use it, and an earlier revision used it on only one.**
/// That revision reasoned that the cold start was safe because "no website can
/// start the process with an argv the user did not type", which `lib.rs`'s own
/// MYND-567 comment contradicts twelve lines from the call site: on Windows and
/// Linux the OS delivers a deep link by **spawning a process whose only argv is
/// the URL**, and when the app is closed that process is the FIRST one, so it
/// resolves through [`override_at_startup`]. Same unmeasured quoting question,
/// other path, and that path is the one that reaches the pre-unlock screen
/// carrying the account number. What the refusal costs is a launch that passes
/// a deep link and the flag at once, which is not a shape a terminal user
/// produces.
pub fn flag_in_delivered_argv<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let args: Vec<S> = args.into_iter().collect();
    if args.iter().any(carries_deep_link) {
        return false;
    }
    flag_in(args)
}

/// Resolve the device-local override at startup: the file AND the flag.
///
/// **Both, always, with no short-circuit.** An earlier version returned as soon
/// as the flag was found, leaving `file_disabled` reporting `false` over a file
/// that said `true`. And that value is not cosmetic, it is what the setter
/// writes back. The pre-unlock escape drove its action off the resolved state,
/// so on a flag-launched run the only offered action was "restore", and
/// confirming replaced the user's persisted `disabled: true` with `false`. The
/// next launch without the flag then resolved to `false` and put the black
/// window back in front of the account number and the recovery-phrase ceremony,
/// which is the exact lockout this whole feature exists to open. Reading both
/// makes the state describe the disk, and the defect unrepresentable rather than
/// merely fixed.
///
/// A path that cannot be resolved at all answers `false`, meaning protection
/// applied, which is the same posture `plugins::sync::tor::restore_at_startup` takes for
/// its own device-local config when `app_config_dir` is unreachable, and the
/// same direction a damaged file takes.
pub fn override_at_startup(app: &tauri::App) -> ScreenCaptureState {
    // The refusing form on this path too: when the app is CLOSED, a
    // `myne://` deep link starts the process, so this argv is OS-delivered
    // exactly like the relaunch one. See `flag_in_delivered_argv`.
    let via_flag = flag_in_delivered_argv(std::env::args_os().skip(1));
    let host = myne_core::host::tauri_host::TauriHost::new(app.handle().clone());
    let file_disabled = tauri::async_runtime::block_on(async {
        use myne_core::screen_capture_override as sco;
        match sco::screen_capture_override_path_from_host(&host, &myne_core::vault_io::StdVaultIo)
            .await
        {
            Ok(path) => sco::protection_disabled_at_rest(
                sco::read_screen_capture_override(&myne_core::vault_io::StdVaultIo, &path).await,
            ),
            Err(_) => false,
        }
    });
    tracing::info!(
        event = "screen_capture_override_resolved",
        file_disabled,
        via_flag,
    );
    ScreenCaptureState::new(file_disabled, via_flag)
}

/// Fold the managed state into a requested value.
///
/// A missing state resolves to the requested value unchanged, which is the
/// pre-#482 behaviour and the safe direction: protection stays on. It is still
/// warned about, because in a shipped build it can only mean the `app.manage`
/// in `Builder::setup` was moved after a call site.
fn resolve<R: tauri::Runtime, M: Manager<R>>(
    manager: &M,
    requested: bool,
    site: &'static str,
) -> bool {
    match manager.try_state::<ScreenCaptureState>() {
        Some(state) => state.record_and_resolve(requested),
        None => {
            tracing::warn!(
                event = "screen_capture_state_absent",
                site,
                "screen-capture state not managed; applying the requested value unresolved"
            );
            requested
        }
    }
}

/// Apply screen-capture protection to the main window, then show it.
///
/// `tauri.conf.json` declares `"visible": false` on the main window so
/// this function owns the only `show()` call — the load-bearing chain
/// is `visible: false` → `set_content_protected(true)` → `show()`, which
/// structurally guarantees the first frame is protected on Windows 10
/// build 19041+. The same chain runs on macOS, where the call is made
/// and no protection is claimed (see the module docs).
pub fn init(app: &tauri::App) -> Result<(), tauri::Error> {
    let window = app
        .get_webview_window("main")
        .expect("main webview window must exist per tauri.conf.json");

    // Belt-and-suspenders against future `tauri.conf.json` drift: if
    // `"visible": false` is silently removed from the main window
    // declaration, the window is already shown by the time this hook
    // runs and the first-frame-protected guarantee is broken. The
    // `debug_assert!` catches this in dev/test builds without changing
    // the release-build instruction stream. The `unwrap_or(false)`
    // default fails safe on a probe error (assume the expected
    // not-visible state) so an unrelated Tauri-IO blip in dev does
    // not panic spuriously.
    debug_assert!(
        !window.is_visible().unwrap_or(false),
        "main window must be declared `visible: false` in tauri.conf.json; \
         screen_capture::init owns the only `show()` call"
    );

    // `true` is what the app ASKS for at startup; the device-local override
    // (myne-md/myne#482) is the only thing that can turn that into `false`, and
    // it does so through the same resolver every other call site uses.
    let effective = resolve(app, true, "startup_init");
    apply_inner(&window, effective, "startup_init");

    // Both `set_content_protected` (inside `apply_inner`) and `show()`
    // dispatch via Tauri's event loop (winit/tao backend). FIFO
    // ordering means the protect message processes before the show
    // message — the first paint is protected on macOS + Windows ≥
    // build 19041. A reordering here would be a Tauri runtime bug,
    // not a current risk.
    window.show()?;
    Ok(())
}

/// Apply screen-capture protection to the main window at runtime.
///
/// Called from `vault_unlock` (with the user's persisted toggle after
/// `vault.prefs` decrypts), from `vault_lock` (always `true` — the
/// lock-on-default-ON discipline per `decisions.md` 2026-05-27), and
/// from the `set_screen_capture_protection` prefs IPC (with the new
/// toggle value, **after** the disk write succeeds — see the prefs
/// plugin's critical-ordering acceptance test).
///
/// Best-effort: never propagates, never panics. Window-not-found
/// (e.g., a stale call after `tauri::AppHandle::cleanup_before_exit`)
/// degrades to a single tracing::warn with `reason = "window_not_found"`
/// instead of propagating. The `set_content_protected` failure path
/// reuses [`apply_inner`]'s closed-enum kind helper.
///
/// The `enabled` parameter is the desired protection state — `true`
/// to apply protection, `false` to remove it. Per spec § 9.5 and the
/// `threat-model.md` § 6 pre-unlock-always-ON property, the only
/// caller that passes `false` is the prefs IPC at the user's explicit
/// request; `vault_unlock` and `vault_lock` always pass the persisted
/// preference and `true` respectively.
pub fn apply<R: tauri::Runtime>(app: &tauri::AppHandle<R>, enabled: bool, site: &'static str) {
    // RECORD FIRST, then look the window up. `ScreenCaptureState`'s whole
    // design rests on "`apply` is the only writer and every caller routes
    // through it", and looking up first broke that on the one path where the
    // lookup fails: a `vault_lock`'s `apply(app, true, "lock_reset")` returned
    // without recording, leaving `last_requested` holding the UNLOCKED vault's
    // preference, and the next `show_protected` then replayed that stale
    // `false` onto the unlock screen. Recording is pure and cannot fail, so
    // hoisting it costs nothing on the degraded path and closes the gap by
    // construction rather than by remembering.
    let effective = resolve(app, enabled, site);
    let Some(window) = main_window(app, site) else {
        return;
    };
    apply_inner(&window, effective, site);
    // myne#680: a runtime protection change reaches every live detached
    // (pop-out) note window too, so a Settings toggle or a device-override
    // change never leaves one window protected and another not. `resolve` above
    // recorded the new `last_requested`, so the fan-out mirrors the new state.
    // On lock this finds nothing (the pop-outs are destroyed first, #679), and
    // at unlock there are none yet.
    fan_out_to_detached(app, site);
}

/// Re-apply the current effective protection to every live detached (`note-*`)
/// window (myne#680). Called at the tail of [`apply`], so any runtime change to
/// the main window's protection propagates to the pop-outs by construction. Each
/// window mirrors the main window's state via [`apply_to`] (it never records a
/// new request). Absent registry (no detached-window plugin, or none open) is a
/// no-op.
fn fan_out_to_detached<R: tauri::Runtime>(app: &tauri::AppHandle<R>, site: &'static str) {
    let Some(registry) =
        app.try_state::<crate::plugins::detached_window::state::DetachedWindowRegistry>()
    else {
        return;
    };
    for label in registry.all_labels() {
        if let Some(window) = app.get_webview_window(&label) {
            apply_to(app, &window, site);
        }
    }
}

/// The effective protection a SECONDARY (detached note) window should currently
/// show: the main window's last requested state folded with the device-wide
/// override, recording nothing (myne#680, SYNC-5).
///
/// A detached window MIRRORS the main window rather than holding its own request,
/// so it must not move `last_requested` (whose sole writer stays [`apply`]). It
/// still honors the device-wide override, so an opted-out device leaves a pop-out
/// unprotected exactly as it leaves the main window, and a `--disable-screen-
/// capture-protection` run never hands the user a black pop-out. Unmanaged state
/// warns and protects, the same fail-towards-protection direction as [`resolve`].
fn mirror_effective<R: tauri::Runtime>(app: &tauri::AppHandle<R>, site: &'static str) -> bool {
    match app.try_state::<ScreenCaptureState>() {
        Some(state) => state.last_requested() && !state.override_disabled(),
        None => {
            tracing::warn!(
                event = "screen_capture_state_absent",
                site,
                "screen-capture state not managed; protecting the detached window"
            );
            true
        }
    }
}

/// Apply the mirrored protection to one already-shown detached window (myne#680).
///
/// The window-parameterized twin of the main-window [`apply`], for a surface that
/// is already visible and only needs its protection re-asserted (the fan-out
/// after a runtime toggle). Resolves through [`mirror_effective`] so the
/// device-wide override is honored and `last_requested` is never written.
pub fn apply_to<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    site: &'static str,
) {
    apply_inner(window, mirror_effective(app, site), site);
}

/// Bring a detached (pop-out) note window forward and keep it protected across
/// the trip, mirroring the main window's state (myne#680, SYNC-5).
///
/// The window-parameterized twin of [`show_protected`]: same `raise_sequence`
/// (protect -> unminimize -> show -> protect -> focus, the #483 both-sides-of-
/// show discipline for the Windows affinity that resets across a show), applied
/// to the PASSED window with the value [`mirror_effective`] resolves. The
/// single-instance reveal of an already-open note routes through this rather
/// than a hand-rolled `unminimize`/`set_focus`, which is what keeps the
/// protect/show/protect ordering a property of the code for detached windows too
/// (and keeps `the_reshow_sequence_is_not_hand_rolled_anywhere_else` green).
pub fn raise_protected<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    site: &'static str,
) {
    let effective = mirror_effective(app, site);
    raise_sequence(&TauriRaise { window, site }, effective);
}

/// The main window, or a warn and `None`.
///
/// Shared by [`apply`] and [`show_protected`] so the degradation is stated
/// once: a stale call after `tauri::AppHandle::cleanup_before_exit`, or the
/// hypothetical multi-window edge, warns and returns rather than propagating.
fn main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    site: &'static str,
) -> Option<tauri::WebviewWindow<R>> {
    let window = app.get_webview_window("main");
    if window.is_none() {
        tracing::warn!(
            event = "screen_capture_protection_failed",
            site,
            reason = "window_not_found",
        );
    }
    window
}

/// The state to replay, for the two callers that re-apply rather than set.
///
/// Shared by [`reassert`] and [`show_protected`] so the unmanaged-state case
/// cannot answer differently in the two: they used to, one warning and one
/// silently assuming `true`, which is how a missing `app.manage` would have
/// been reported on one re-show path and not the other.
fn replay_target<R: tauri::Runtime>(app: &tauri::AppHandle<R>, site: &'static str) -> bool {
    match app.try_state::<ScreenCaptureState>() {
        Some(state) => state.last_requested(),
        None => {
            tracing::warn!(
                event = "screen_capture_state_absent",
                site,
                "screen-capture state not managed; re-asserting protection"
            );
            true
        }
    }
}

/// Re-apply whatever protection state the app last asked for.
///
/// The other half of myne-md/myne#483: [`apply`] answers "the state changed",
/// this answers "the window came back and may have lost it". It replays
/// [`ScreenCaptureState::last_requested`] rather than deriving a fresh answer,
/// so it cannot disagree with what was actually applied. See that type's docs
/// for why deriving was rejected.
///
/// Best-effort in the same three ways [`apply`] is: no window, no managed state
/// and a failing native call each warn and return.
pub fn reassert<R: tauri::Runtime>(app: &tauri::AppHandle<R>, site: &'static str) {
    apply(app, replay_target(app, site), site);
}

/// Bring the main window back and keep it protected across the trip.
///
/// **The one implementation of "re-show the main window", for every client.**
/// Before myne-md/myne#483 the three-line `unminimize` / `show` / `set_focus`
/// block was written out at three call sites, and the fourth thing, re-applying
/// protection, was missing from all three. One function is what makes that
/// omission impossible to repeat rather than merely fixed three times.
///
/// **The fourth site goes through it too**, from page context, as
/// `plugin:screen-capture|screen_capture_show_protected`. An earlier revision
/// left the WebView holding its own `getCurrentWindow().show()` with a separate
/// re-assert after it, which is the same two-independent-calls shape the other
/// three had. The ordering held by a comment rather than by construction, at
/// the site the decision entry itself calls the worst of the four. Folding it
/// in also let `core:window:allow-show` be dropped from the capability set: the
/// page trades a raw window operation it could aim anywhere for one fixed
/// sequence it cannot parameterise.
///
/// See [`raise_sequence`] for why protection is applied on BOTH sides of the
/// `show()`.
pub fn show_protected<R: tauri::Runtime>(app: &tauri::AppHandle<R>, site: &'static str) {
    let Some(window) = main_window(app, site) else {
        return;
    };
    let effective = resolve(app, replay_target(app, site), site);
    raise_sequence(
        &TauriRaise {
            window: &window,
            site,
        },
        effective,
    );
}

/// The five steps of a re-show, in the order they have to happen.
///
/// **Protection is applied on both sides of the `show()`, deliberately.** The
/// two calls cover different failures and neither covers both:
///
/// * The **pre-show** call is [`init`]'s `visible: false` then protect then
///   `show()` discipline applied to a hidden window, and it is the one that
///   holds wherever the affinity survives a hide/show cycle.
/// * The **post-show** call is the one that holds where it does not.
///   tauri-apps/tauri#14189 reports `WDA_EXCLUDEFROMCAPTURE` resetting to
///   `WDA_NONE` across `hide()`/`show()` on Windows, and Electron shipped the
///   same fix for the same reason (electron/electron#45868). Applying only
///   before the show would be clobbered by the show itself.
///
/// `set_focus` goes last, as it did at all three original call sites: focus is
/// what draws the user's eye, so nothing that could still change what is on
/// screen may run after it.
fn raise_sequence<W: RaisableWindow>(window: &W, effective: bool) {
    window.protect(effective);
    window.unminimize();
    window.show();
    window.protect(effective);
    window.focus();
}

/// The four window operations [`raise_sequence`] performs, behind a trait so the
/// ORDER can be asserted without a running Tauri runtime.
///
/// Same shape and same motive as `auto_lock::LockTeardown`: the sequence is the
/// property worth testing, and a `WebviewWindow` cannot be constructed in a unit
/// test.
trait RaisableWindow {
    fn protect(&self, enabled: bool);
    fn unminimize(&self);
    fn show(&self);
    fn focus(&self);
}

/// The production [`RaisableWindow`], over a real Tauri window. Every call is
/// best-effort. A re-show that half-works still beats a window that stays
/// hidden, which is what `RunEvent::Reopen` exists to prevent.
struct TauriRaise<'a, R: tauri::Runtime> {
    window: &'a tauri::WebviewWindow<R>,
    /// Carried on the struct rather than threaded through every trait method:
    /// only `protect` uses it, and the recording double had to accept and
    /// ignore it at each call.
    site: &'static str,
}

impl<R: tauri::Runtime> RaisableWindow for TauriRaise<'_, R> {
    fn protect(&self, enabled: bool) {
        apply_inner(self.window, enabled, self.site);
    }
    fn unminimize(&self) {
        let _ = self.window.unminimize();
    }
    fn show(&self) {
        let _ = self.window.show();
    }
    fn focus(&self) {
        let _ = self.window.set_focus();
    }
}

/// Shared inner implementation called by [`init`] (with
/// `site = "startup_init"`), by [`apply`] (with `site = "runtime_apply"`
/// for prefs IPC, `site = "lock_reset"` when `vault_lock` re-applies
/// default-ON post-zeroize), and — `pub(crate)`, window-parameterized —
/// by the pdf-export plugin's hidden render window (with
/// `site = "pdf_export_window"`), so the Linux-unsupported warn and the
/// success-event telemetry stay consistent across every protected
/// surface.
///
/// The `site` parameter never crosses the user's view — it lives in
/// `tracing` event fields only — but is the single signal a support-
/// flow log reader uses to attribute a `screen_capture_protection_*`
/// event to its call path. Per the secret-handling logging discipline
/// (`src-tauri/CLAUDE.md`), `site` is a `&'static str` constant; the
/// caller cannot inject dynamic strings here.
pub(crate) fn apply_inner<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    enabled: bool,
    site: &'static str,
) {
    match window.set_content_protected(enabled) {
        Ok(()) => {
            #[cfg(target_os = "linux")]
            tracing::warn!(
                event = "screen_capture_protection_unsupported",
                platform = "linux",
                site,
                "Screen-capture protection unavailable on Linux v0.1 (no portable API)"
            );
            #[cfg(not(target_os = "linux"))]
            tracing::info!(
                event = "screen_capture_protection_applied",
                platform = std::env::consts::OS,
                site,
                enabled,
            );
        }
        Err(e) => tracing::warn!(
            event = "screen_capture_protection_failed",
            platform = std::env::consts::OS,
            site,
            error_kind = screen_capture_protection_error_kind(&e),
        ),
    }
}

/// Closed-enum mapping from `tauri::Error` to a static log tag.
///
/// `tauri::Error` is an open enum that transitively wraps `std::io::Error`
/// and `String` payloads; emitting it via `?e` / `%e` would risk kernel
/// path leakage per the DENY list in `src-tauri/CLAUDE.md`. The wildcard
/// arm collapses unrecognized variants to a single tag — if log readers
/// see `"other_tauri_error"` trending in user-shared logs, that signals
/// a new variant worth promoting to its own arm.
fn screen_capture_protection_error_kind(e: &tauri::Error) -> &'static str {
    match e {
        tauri::Error::Io(_) => "io_error",
        _ => "other_tauri_error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_variant_maps_to_io_error() {
        let e = tauri::Error::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "test"));
        assert_eq!(screen_capture_protection_error_kind(&e), "io_error");
    }

    #[test]
    fn asset_not_found_variant_maps_to_other() {
        let e = tauri::Error::AssetNotFound("test".to_string());
        assert_eq!(
            screen_capture_protection_error_kind(&e),
            "other_tauri_error"
        );
    }

    #[test]
    fn invalid_window_handle_variant_maps_to_other() {
        let e = tauri::Error::InvalidWindowHandle;
        assert_eq!(
            screen_capture_protection_error_kind(&e),
            "other_tauri_error"
        );
    }

    /// Recording [`RaisableWindow`], the same device `auto_lock`'s
    /// `LockTeardown` double is: the ORDER is the property, and a real
    /// `WebviewWindow` cannot be built in a unit test.
    #[derive(Default)]
    struct RecordingWindow {
        log: std::cell::RefCell<Vec<String>>,
    }

    impl RaisableWindow for RecordingWindow {
        fn protect(&self, enabled: bool) {
            self.log.borrow_mut().push(format!("protect({enabled})"));
        }
        fn unminimize(&self) {
            self.log.borrow_mut().push("unminimize".into());
        }
        fn show(&self) {
            self.log.borrow_mut().push("show".into());
        }
        fn focus(&self) {
            self.log.borrow_mut().push("focus".into());
        }
    }

    #[test]
    fn a_reshow_protects_on_both_sides_of_the_show_and_focuses_last() {
        let w = RecordingWindow::default();
        raise_sequence(&w, true);
        assert_eq!(
            w.log.into_inner(),
            vec![
                "protect(true)",
                "unminimize",
                "show",
                "protect(true)",
                "focus"
            ]
        );
    }

    #[test]
    fn a_reshow_on_an_opted_out_device_protects_nothing_and_still_shows() {
        // The override reaches the sequence as a resolved `false`. The window
        // must still come back. A device that opted out of protection did not
        // opt out of being able to see the unlock screen.
        let w = RecordingWindow::default();
        raise_sequence(&w, false);
        assert_eq!(
            w.log.into_inner(),
            vec![
                "protect(false)",
                "unminimize",
                "show",
                "protect(false)",
                "focus"
            ]
        );
    }

    #[test]
    fn the_override_can_only_remove_protection_never_add_it() {
        let on = ScreenCaptureState::new(false, false);
        assert!(on.record_and_resolve(true), "no override, asked on");
        assert!(!on.record_and_resolve(false), "no override, asked off");

        let off = ScreenCaptureState::new(true, false);
        assert!(!off.record_and_resolve(true), "override beats an asked-on");
        assert!(!off.record_and_resolve(false), "override, asked off");
    }

    #[test]
    fn the_recorded_request_is_what_was_asked_for_not_what_was_applied() {
        // The distinction is the whole point: on an opted-out device every
        // `apply` resolves to `false`, and if the recorded value followed the
        // RESOLVED one, turning the override back off would re-assert `false`
        // forever.
        let state = ScreenCaptureState::new(true, false);
        assert!(!state.record_and_resolve(true));
        assert!(state.last_requested());

        state.set_file_disabled(false);
        assert!(state.record_and_resolve(state.last_requested()));
    }

    #[test]
    fn a_fresh_state_asks_for_protection_before_anything_has_applied() {
        // `reassert` seeds from this. Seeding `false` would mean a re-show that
        // somehow beat the first `apply` re-showed an unprotected window.
        assert!(ScreenCaptureState::new(false, false).last_requested());
        assert!(ScreenCaptureState::new(true, false).last_requested());
    }

    #[test]
    fn a_detached_window_mirrors_the_main_state_without_recording() {
        // myne#680: the value `mirror_effective` resolves for a detached window is
        // `last_requested() && !override_disabled()` — the main window's current
        // requested state folded with the device-wide override. This asserts that
        // algebra AND that reading it never moves `last_requested` (a pop-out
        // mirrors the main window; opening one must not change what the main
        // window replays). `mirror_effective` itself needs a running app, so the
        // read-only property is asserted on the state it reads.
        let state = ScreenCaptureState::new(false, false);
        assert!(state.record_and_resolve(true), "main asked protection on");
        let mirrored = state.last_requested() && !state.override_disabled();
        assert!(mirrored, "no override, main on -> pop-out protected");
        assert!(
            state.last_requested(),
            "a mirror read must not move last_requested"
        );

        assert!(
            !state.record_and_resolve(false),
            "main turned protection off"
        );
        let mirrored_off = state.last_requested() && !state.override_disabled();
        assert!(!mirrored_off, "main off -> pop-out unprotected too");

        // An opted-out device leaves the pop-out unprotected even when the main
        // window asked for protection, and the override never moves last_requested.
        let opted_out = ScreenCaptureState::new(true, false);
        assert!(!opted_out.record_and_resolve(true));
        let mirrored_override = opted_out.last_requested() && !opted_out.override_disabled();
        assert!(
            !mirrored_override,
            "override removes protection from the pop-out too"
        );
        assert!(
            opted_out.last_requested(),
            "override does not touch last_requested"
        );
    }

    #[test]
    fn the_detached_mirror_reads_the_request_and_never_records_one() {
        // The invariant `apply` rests on ("the only writer of last_requested is
        // apply") extends to the detached entry points: they MIRROR, never set.
        // Read the source because the writing path needs a running app; what this
        // catches is someone swapping mirror_effective to `record_and_resolve`,
        // which would let opening a pop-out move what the main window replays.
        let src = include_str!("screen_capture.rs");
        let body = src
            .split_once("fn mirror_effective<R: tauri::Runtime>")
            .expect("mirror_effective must still be named that")
            .1
            .split_once("\n}\n")
            .expect("mirror_effective must have an end")
            .0;
        assert!(
            !body.contains("record_and_resolve") && !body.contains(".store("),
            "mirror_effective must READ last_requested + override, never record; a \
             detached window mirrors the main window and may not move last_requested"
        );
        assert!(
            body.contains("last_requested()") && body.contains("override_disabled()"),
            "mirror_effective must fold the device-wide override into last_requested"
        );
    }

    #[test]
    fn the_flag_overrides_and_the_command_cannot_clear_it() {
        // The failure this rules out: a flag-launched run whose Settings row
        // writes `disabled: false`, reports success, and leaves the window
        // exactly as unprotected as it was.
        let flagged = ScreenCaptureState::new(false, true);
        assert!(flagged.override_disabled());
        assert!(flagged.via_flag());
        assert!(!flagged.file_disabled(), "the file said nothing");

        flagged.set_file_disabled(false);
        assert!(
            flagged.override_disabled(),
            "clearing the file must not clear the flag"
        );
    }

    #[test]
    fn the_two_override_sources_are_reported_apart() {
        let from_file = ScreenCaptureState::new(true, false);
        assert!(from_file.override_disabled());
        assert!(from_file.file_disabled());
        assert!(!from_file.via_flag());
    }

    #[test]
    fn the_flag_is_matched_whole_and_only_as_itself() {
        assert!(flag_in([DISABLE_FLAG]));
        assert!(flag_in(["--other", DISABLE_FLAG, "x"]));
        assert!(!flag_in(["--disable-screen-capture"]), "prefix");
        assert!(
            !flag_in(["--disable-screen-capture-protection=1"]),
            "suffix"
        );
        assert!(!flag_in(["-disable-screen-capture-protection"]), "one dash");
        assert!(!flag_in(Vec::<&str>::new()));
    }

    #[test]
    fn apply_records_before_it_looks_the_window_up() {
        // `ScreenCaptureState`'s design rests on "`apply` is the only writer and
        // every caller routes through it". Looking the window up FIRST broke
        // that on the one path where the lookup fails: a `vault_lock`'s
        // `apply(app, true, "lock_reset")` returned without recording, leaving
        // `last_requested` holding the unlocked vault's preference, and the next
        // `show_protected` replayed that stale `false` onto the unlock screen.
        //
        // Asserted at the source because `apply` needs a running Tauri app.
        // What that buys is narrow and real: it catches the ordering being
        // swapped back, which is the way this regresses.
        let src = include_str!("screen_capture.rs");
        let body = src
            .split_once("pub fn apply<R: tauri::Runtime>")
            .expect("apply must still be named that")
            .1
            .split_once("\n}\n")
            .expect("apply must have an end")
            .0;

        let resolve_at = body.find("resolve(app,").expect("apply must resolve");
        let lookup_at = body
            .find("main_window(app,")
            .expect("apply must look the window up");
        assert!(
            resolve_at < lookup_at,
            "apply must record through `resolve` BEFORE the window lookup that \
             can early-return, or a failed lookup silently drops the request"
        );
    }

    #[test]
    fn a_relaunch_flag_is_folded_in_and_a_later_launch_cannot_clear_it() {
        // The recovery route the module doc names: the app is already running,
        // showing a black window, and the user reaches for a terminal. Emptying
        // `note_flag_relaunch`'s body used to change nothing any test or
        // scenario observed, which for the documented fallback of the
        // fail-towards-protection arm is the one place inertness costs most.
        let state = ScreenCaptureState::new(false, false);
        assert!(!state.override_disabled(), "starts protected");

        state.note_flag_relaunch();
        assert!(state.via_flag(), "the second launch's flag is folded in");
        assert!(state.override_disabled());
        assert!(!state.file_disabled(), "and it never touches the file half");

        // Set-only. A later launch WITHOUT the flag is a request to run
        // normally, not a request to cancel an override asked for a moment ago,
        // and quitting is how a flag is un-passed.
        state.note_flag_relaunch();
        assert!(state.via_flag(), "still set");
        state.set_file_disabled(false);
        assert!(
            state.override_disabled(),
            "clearing the FILE cannot clear a flag this run was given"
        );
    }

    #[test]
    fn the_relaunch_scan_skips_the_program_name_the_way_the_call_site_does() {
        // `tauri-plugin-single-instance` sends `std::env::args()`, argv[0]
        // included, and the call site is `args.iter().skip(1)`. Every other
        // case in this module passes a list with no program name, so the shape
        // that actually arrives was asserted nowhere.
        let real = ["/usr/bin/myne", DISABLE_FLAG];
        assert!(flag_in_delivered_argv(real.iter().skip(1)));

        // And the skip has to be a skip rather than decoration: a program path
        // that happens to end in the flag's text must not count as passing it.
        let impostor = [DISABLE_FLAG, "--other"];
        assert!(
            !flag_in_delivered_argv(impostor.iter().skip(1)),
            "argv[0] is the program name, never an argument"
        );
    }

    #[test]
    fn an_argv_carrying_a_deep_link_cannot_carry_the_flag_on_relaunch() {
        // The relaunch path is the one place this flag reaches a session that
        // may already be UNLOCKED, and the single-instance callback hands the
        // same vector to the `myne://` ingress, which `threat-model.md` § 7
        // rates as reachable by any website. Whether a URL can become a second
        // argv token at all depends on Windows registry quoting nobody here
        // measured, so the refusal makes the answer not matter.
        assert!(
            !flag_in_delivered_argv([DISABLE_FLAG, "myne://theme/install?x=1"]),
            "a deep link anywhere in the vector refuses the flag"
        );
        assert!(
            !flag_in_delivered_argv(["myne://x", DISABLE_FLAG]),
            "order does not matter"
        );
        assert!(
            !flag_in_delivered_argv([DISABLE_FLAG, "MYNE://X"]),
            "a URL scheme is case-insensitive"
        );
        assert!(
            !flag_in_delivered_argv([DISABLE_FLAG, "  myne://x"]),
            "leading whitespace does not smuggle one past"
        );
        // The two spellings the `myne://` prefix stepped around (myne#482,
        // found by review). Both are valid URIs with this scheme and neither
        // carries the authority form, so both reached the permissive path.
        // Widening the match to the SCHEME is what refuses them.
        assert!(
            !flag_in_delivered_argv([DISABLE_FLAG, "myne:theme/install"]),
            "a scheme-only URI is still a deep link"
        );
        assert!(
            !flag_in_delivered_argv([DISABLE_FLAG, "myne:/x"]),
            "a single-slash path form is still a deep link"
        );
        assert!(
            !flag_in_delivered_argv(["MYNE:THEME/INSTALL", DISABLE_FLAG]),
            "and the scheme-only form is case-insensitive and order-independent too"
        );

        // And the ordinary terminal case still works, or the flag would be
        // documented for a recovery it cannot perform.
        assert!(flag_in_delivered_argv([DISABLE_FLAG]));
        assert!(flag_in_delivered_argv(["--other", DISABLE_FLAG]));
        assert!(
            !flag_in_delivered_argv(["myne://x"]),
            "a deep link alone is not it"
        );
        assert!(!flag_in_delivered_argv(Vec::<&str>::new()));

        // A near-miss must NOT be treated as a deep link, or an unrelated
        // argument could switch the refusal on and silently disarm the flag.
        assert!(
            flag_in_delivered_argv([DISABLE_FLAG, "notmyne://x"]),
            "the scheme is matched at the start, not anywhere"
        );
    }

    #[test]
    fn a_non_utf8_argv_does_not_stop_the_flag_being_found() {
        // `std::env::args()` panics on non-UTF-8 argv, which is why this takes
        // `OsStr`. A deep link arriving as a second launch is one way such an
        // argument reaches the boot path.
        let bad = non_utf8_os_string();
        assert!(flag_in([bad.clone(), DISABLE_FLAG.into()]));
        assert!(!flag_in([bad]));
    }

    #[cfg(unix)]
    fn non_utf8_os_string() -> std::ffi::OsString {
        use std::os::unix::ffi::OsStringExt;
        std::ffi::OsString::from_vec(vec![0x66, 0x6f, 0x80, 0x6f])
    }

    #[cfg(windows)]
    fn non_utf8_os_string() -> std::ffi::OsString {
        use std::os::windows::ffi::OsStringExt;
        std::ffi::OsString::from_wide(&[0x66, 0x6f, 0xD800, 0x6f])
    }

    /// No fifth re-show site may hand-roll the sequence.
    ///
    /// This is the regression [`show_protected`] exists to make impossible, and
    /// nothing else can see it: the block compiles, the window comes back, and
    /// only the protection is missing. There is no runtime moment at which a
    /// hand-rolled block announces itself, so this reads the source.
    ///
    /// **It WALKS the tree rather than naming files, and matches the lookup
    /// plus `show()` rather than `.unminimize()`.** The first version did both
    /// the narrow things and its name claimed neither: a roster of the three
    /// files that happened to carry a copy could not see a fifth site added
    /// anywhere else, and `.unminimize()` is not in the shape that actually had
    /// to be folded in. The WebView's own block was
    /// `get_webview_window("main")` + `show()` + `set_focus()` with no
    /// `unminimize` at all, so the guard was blind to the exact site
    /// `show_protected`'s doc records as the worst of the four.
    ///
    /// Deleting the body of `show_protected` is the other half, and it surfaces
    /// as a `dead_code` warning on `raise_sequence` and `TauriRaise` under
    /// `-D warnings`, which `pre-push` and CI both run.
    #[test]
    fn the_reshow_sequence_is_not_hand_rolled_anywhere_else() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).expect("src-tauri/src must be readable") {
                let path = entry.expect("a readable entry").path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }

        // BOTH trees. `src-tauri/CLAUDE.md` "Where the code actually lives"
        // puts the plugin bodies in `core/` and names screen-capture apply as
        // one of the side effects a shared core reaches through
        // `VaultLifecycleHooks`, so a fifth re-show site added there would be
        // invisible to a guard whose name says "anywhere else".
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let roots = [manifest.join("src"), manifest.join("../core/src")];
        let mut files = Vec::new();
        for root in &roots {
            assert!(root.exists(), "{} must exist", root.display());
            walk(root, &mut files);
        }
        // Non-vacuity floor: a walk that found nothing would pass silently, and
        // this crate is far larger than this. The number is a floor rather than
        // an equality so ordinary growth does not redden it.
        assert!(
            files.len() > 200,
            "the walk found only {} file(s); it is not reading the tree",
            files.len()
        );

        for path in files {
            // This module IS the one implementation, so it is the one file
            // allowed to carry the sequence.
            if path.file_name().is_some_and(|n| n == "screen_capture.rs") {
                continue;
            }
            let src = std::fs::read_to_string(&path).expect("a readable file");
            let rel = path.strip_prefix(manifest).unwrap_or(&path).display();
            assert!(
                !(src.contains("get_webview_window(\"main\")") && src.contains(".show()")),
                "{rel} looks up the main window and shows it by hand; every \
                 re-show goes through `screen_capture::show_protected`, which \
                 is what keeps the protect/show/protect ordering a property of \
                 the code rather than a convention"
            );
            assert!(
                !src.contains(".unminimize()"),
                "{rel} raises a window by hand; same rule, other shape"
            );
        }
    }

    // Note: `apply_inner` requires a `WebviewWindow<R>` instance which
    // cannot be constructed without a running Tauri test harness. The
    // native side-effect path is integration-tested in MYND-160 Tasks
    // 10 (`vault_unlock` integration) + 11 (`vault_lock` integration),
    // where the `tauri::test::mock_app` harness wires a real window
    // and lets us observe the `set_content_protected` no-op + tracing
    // events end-to-end. The unit tests here cover only the closed-
    // enum mapping that is the load-bearing logging discipline.
}
