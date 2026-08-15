//! Screen-capture protection — startup default-ON + runtime override.
//!
//! Two-function public API per `decisions.md` 2026-05-27 entries
//! ("Tauri `set_content_protected` abstraction over direct FFI" +
//! "Lock-on-default-ON" + "Vault preferences blob") and MYND-160 grill
//! Q5.3:
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
//! Both call sites share the private [`apply_inner`] helper. The
//! `site: &'static str` parameter distinguishes the three call sites
//! in tracing output (`"startup_init"` / `"runtime_apply"` /
//! `"lock_reset"`) without expanding the public API — semantic intent
//! travels in tracing labels rather than additional functions. There
//! is **no** `reset_to_default` function; lock-time callers use
//! `apply(app, true)` with the appropriate site label.
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
//! No IPC command is exposed from this module — both `init` and `apply`
//! are Rust-internal entry points called from the host's setup hook
//! and other plugins respectively. The `set_screen_capture_protection`
//! IPC lives in the prefs plugin (Task 9) and is gated by its own
//! `prefs:allow-set-screen-capture-protection` permission entry.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline" — the
//! warn-on-failure path uses a closed-enum kind helper, never `?e`
//! Debug-formats the underlying `tauri::Error`.

use tauri::Manager;

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

    apply_inner(&window, true, "startup_init");

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
    let Some(window) = app.get_webview_window("main") else {
        tracing::warn!(
            event = "screen_capture_protection_failed",
            site,
            reason = "window_not_found",
        );
        return;
    };
    apply_inner(&window, enabled, site);
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

    // Note: `apply_inner` requires a `WebviewWindow<R>` instance which
    // cannot be constructed without a running Tauri test harness. The
    // native side-effect path is integration-tested in MYND-160 Tasks
    // 10 (`vault_unlock` integration) + 11 (`vault_lock` integration),
    // where the `tauri::test::mock_app` harness wires a real window
    // and lets us observe the `set_content_protected` no-op + tracing
    // events end-to-end. The unit tests here cover only the closed-
    // enum mapping that is the load-bearing logging discipline.
}
