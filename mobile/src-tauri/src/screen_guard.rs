// SPDX-License-Identifier: AGPL-3.0
//! Mobile screen-capture protection — the native side-effect the shared
//! `myne-core` `apply_screen_capture` lifecycle hook drives (called from
//! `vault_unlock` with the persisted toggle, from `vault_lock`/unlock-fail
//! always-ON, and from the `set_screen_capture_protection` prefs IPC). Desktop
//! routes the same hook to `set_content_protected`; that Tauri/tao call is a
//! **compile-time no-op on iOS + Android** (the tao content-protection path is
//! `#[cfg(any(macos, windows))]`-gated), so mobile owns a real platform
//! implementation here. Tracing mirrors the desktop `screen_capture.rs` events
//! (`screen_capture_protection_applied` / `_failed`) and site labels
//! (`"startup_init"` / `"runtime_apply"` / `"lock_reset"`). MYND-469.
//!
//! ## Threading (load-bearing, both directions)
//!
//! - **iOS**: UIKit requires the main thread — [`apply`] dispatches via
//!   `run_on_main_thread`.
//! - **Android**: the bridge (`tauri_plugin_screen_guard::set_secure`) is a
//!   blocking JNI round-trip **serviced by the Android main thread** —
//!   `run_mobile_plugin` posts through the main pipe and parks on `recv`, and
//!   the Kotlin side hops to the UI thread itself. Calling it FROM the main
//!   thread deadlocks, so the Android arm runs directly on the caller's
//!   thread. All three hook call sites are `async` commands (tokio workers),
//!   never the main thread.
//!
//! ## iOS — secure-field layer splice
//!
//! iOS has **no public API to block a single manual screenshot** — this is the
//! documented threat-model limit (`threat-model.md` §6, best-effort defense-in-
//! depth; the app-switcher snapshot is likewise not contractually covered). The
//! technique is the widely-deployed "secure text field" trick: a `UITextField`
//! with `secureTextEntry = YES` owns a capture-excluded backing layer; splicing
//! the app window's layer under it makes window content render blank in
//! screenshots / recordings / mirroring while `secureTextEntry` is on.
//!
//! **Crash history**: the first cut of this splice, run right after unlock,
//! crashed on-device (myne-mobile `b904b58` disabled it). ScreenProtectorKit —
//! the widely-deployed equivalent — has since deprecated the identical
//! technique "due to crashes on some devices". Three mitigations apply now:
//!
//! 1. **Startup timing** — the one-time splice runs from [`init`] in the app
//!    `.setup()` (tauri runs setup inside the Ready dispatch, on the main
//!    thread, after the config window exists), i.e. before the first
//!    CoreAnimation commit of real content — the timing every deployed
//!    implementation uses (`didFinishLaunching`), not mid-session.
//! 2. **Exception guard** — every ObjC call runs inside
//!    `objc2::exception::catch`, so a UIKit `NSException` degrades to a traced
//!    no-op. Honest limit: a CoreAnimation *abort* (assertion → `abort()`)
//!    during a later render commit is NOT catchable; startup timing is the
//!    real mitigation and the device checklist (`docs/dev/device-matrix.md`
//!    §7) is the gate. If the soak row fails, revert [`ios::apply`]'s call in
//!    [`apply`] to a no-op (one line) — do not ship a crashing guard.
//! 3. **iOS-17 sublayer branch** — the secure container is
//!    `sublayers.first` below iOS 17 and `sublayers.last` from iOS 17 on
//!    (ScreenProtectorKit 1.3.1's version branch; the pre-`b904b58` code used
//!    `.last` unconditionally).
//!
//! After the one-time splice, [`apply`] only toggles `secureTextEntry` — the
//! cheap, safe path. The splice also runs lazily on the first `apply(true)` if
//! startup found no window (scene-config drift fallback).
//!
//! ## Android — FLAG_SECURE
//!
//! `WindowManager.LayoutParams.FLAG_SECURE` is the authoritative OS primitive
//! (blocks screenshots, recording, and the recents preview). It is reached
//! through the in-repo `tauri-plugin-screen-guard` Kotlin bridge — committed
//! code under `src-tauri/tauri-plugin-screen-guard/android/`, NOT the
//! gitignored `gen/android` tree. The Kotlin `load()` also applies FLAG_SECURE
//! at plugin-registration time, so pre-unlock always-ON holds from the first
//! frame without any Rust hook. (This replaces the rejected `ndk-context`
//! route: raw JNI from Rust cannot reach `runOnUiThread`, and the crate was
//! never in the lockfile.)

use tauri::{AppHandle, Runtime};

/// One-time startup protection (iOS). Performs the secure-field layer splice
/// with `secureTextEntry = true` — the pre-unlock always-ON invariant
/// (`threat-model.md` §6) from before the WebView's first painted frame; the
/// unlock flow then applies the user's persisted preference through the hook.
/// Call from the app `.setup()`. Android needs no startup call: the Kotlin
/// `load()` owns it.
#[cfg(target_os = "ios")]
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.run_on_main_thread(|| ios::apply(true, "startup_init"));
}

/// Frontend event fired when the user takes a screenshot WHILE screen-capture
/// protection is engaged (MYND-476). The OS-level protection already blacked out
/// the captured image (and text can't be drawn into that OS-owned frame), so the
/// only honest remedy is an in-app notice — the WebView shows a short banner.
/// iOS-only for now: it is emitted solely from the `#[cfg(target_os = "ios")]`
/// `init_screenshot_detection` below (Android's screenshot-taken callback is a
/// documented follow-up), so gate the constant to iOS too — otherwise the
/// non-iOS build treats it as dead code (`-D warnings`).
#[cfg(target_os = "ios")]
pub const SCREENSHOT_EVENT: &str = "screen-capture-blocked";

/// Observe `userDidTakeScreenshotNotification` and, when protection is engaged,
/// emit [`SCREENSHOT_EVENT`] so the WebView can explain the black screenshot.
/// Call once from the app `.setup()`. iOS-only — Android has no equivalent
/// screenshot-taken callback below API 34, and its FLAG_SECURE already blocks
/// the capture; a Kotlin `ScreenCaptureCallback` is a documented follow-up.
#[cfg(target_os = "ios")]
pub fn init_screenshot_detection<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Emitter;
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        ios::observe_screenshots(move || {
            let _ = handle.emit(SCREENSHOT_EVENT, ());
        });
    });
}

#[cfg(not(target_os = "ios"))]
pub fn init_screenshot_detection<R: Runtime>(_app: &AppHandle<R>) {}

/// Apply (or remove) screen-capture protection on the app's main window.
/// `site` is the tracing tag (`"startup_init"` / `"runtime_apply"` /
/// `"lock_reset"`) — the same labels desktop `screen_capture.rs` emits.
pub fn apply<R: Runtime>(app: &AppHandle<R>, enabled: bool, site: &'static str) {
    #[cfg(target_os = "ios")]
    {
        // Best-effort dispatch: an error (event loop gone mid-teardown) is
        // swallowed, matching desktop's warn-and-drop.
        let _ = app.run_on_main_thread(move || ios::apply(enabled, site));
    }

    #[cfg(target_os = "android")]
    android::apply(app, enabled, site);

    // Desktop dev host: no mobile screen surface to protect.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (app, enabled, site);
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    /// The last-applied protection state (pre-unlock is always-ON, so `true` is
    /// the honest default). The screenshot observer (MYND-476) reads this so the
    /// "capture blocked" notice only fires when protection was actually engaged —
    /// a protection-OFF vault takes a normal screenshot and gets no notice.
    static ENABLED: AtomicBool = AtomicBool::new(true);

    /// Whether screen-capture protection is currently engaged.
    pub fn is_protected() -> bool {
        ENABLED.load(Ordering::Relaxed)
    }

    /// Register a process-lifetime observer for the OS "user took a screenshot"
    /// notification (MYND-476). Fires `on_shot` ONLY while protection is engaged
    /// (a protection-OFF vault takes a normal screenshot and warrants no notice).
    /// The notification posts on the main thread, so `on_shot` runs there; the
    /// block is process-lifetime (`mem::forget`) like the secure-field splice.
    pub fn observe_screenshots(on_shot: impl Fn() + 'static) {
        unsafe {
            let Some(nc_cls) = AnyClass::get(c"NSNotificationCenter") else {
                return;
            };
            let center: *mut AnyObject = msg_send![nc_cls, defaultCenter];
            if center.is_null() {
                return;
            }
            // The notification-name constant's value IS this string.
            let Some(str_cls) = AnyClass::get(c"NSString") else {
                return;
            };
            let Ok(cstr) = std::ffi::CString::new("UIApplicationUserDidTakeScreenshotNotification")
            else {
                return;
            };
            let name: *mut AnyObject = msg_send![str_cls, stringWithUTF8String: cstr.as_ptr()];
            if name.is_null() {
                return;
            }
            let block = block2::RcBlock::new(move |_note: *mut AnyObject| {
                if is_protected() {
                    on_shot();
                }
            });
            let null: *mut AnyObject = core::ptr::null_mut();
            let _observer: *mut AnyObject = msg_send![
                center,
                addObserverForName: name,
                object: null,
                queue: null,
                usingBlock: &*block
            ];
            core::mem::forget(block);
        }
    }

    /// The spliced secure `UITextField`, stored as a raw pointer (`usize`
    /// because `*mut AnyObject` is not `Sync`). Access is confined to the main
    /// thread by the `run_on_main_thread` dispatch; the `Mutex` only provides
    /// `Sync` for the static. `new` returns +1-retained and we never release
    /// (process-lifetime), so the pointer stays valid. The guard is NEVER held
    /// across ObjC calls — a foreign (NSException) unwind must not cross a
    /// live `MutexGuard`.
    static FIELD: Mutex<usize> = Mutex::new(0);

    /// What one guarded application attempt did — every degradation traces.
    enum Outcome {
        Applied,
        /// No key window yet (startup raced ahead of window creation); the
        /// lazy splice on the next `apply(true)` is the fallback.
        WindowNotFound,
        /// A class/layer lookup came back null before any hierarchy mutation
        /// (the splice bails whole — never half-applied).
        LayerNotReady,
        /// Protection is OFF and nothing was ever spliced: by design a vault
        /// with protection off pays zero rendering side-effect.
        SkippedNoSplice,
    }

    pub fn apply(enabled: bool, site: &'static str) {
        ENABLED.store(enabled, Ordering::Relaxed);
        // `objc2/exception` is already enabled for Apple targets through wry's
        // feature unification — declaring it in Cargo.toml added no crates.
        let outcome = objc2::exception::catch(|| unsafe { apply_unguarded(enabled) });
        match outcome {
            Ok(Outcome::Applied) => tracing::info!(
                event = "screen_capture_protection_applied",
                platform = "ios",
                site,
                enabled
            ),
            Ok(Outcome::WindowNotFound) => tracing::warn!(
                event = "screen_capture_protection_failed",
                platform = "ios",
                site,
                reason = "window_not_found"
            ),
            Ok(Outcome::LayerNotReady) => tracing::warn!(
                event = "screen_capture_protection_failed",
                platform = "ios",
                site,
                reason = "layer_not_ready"
            ),
            Ok(Outcome::SkippedNoSplice) => {}
            // DENY-list discipline: the NSException reason is arbitrary UIKit
            // text — never formatted into the log.
            Err(_) => tracing::warn!(
                event = "screen_capture_protection_failed",
                platform = "ios",
                site,
                reason = "objc_exception"
            ),
        }
    }

    /// Resolve the active `UIWindow`. Prefers the (deprecated but functional
    /// for a single-window app) `keyWindow`, falling back to `windows[0]`.
    unsafe fn key_window() -> *mut AnyObject {
        let Some(app_cls) = AnyClass::get(c"UIApplication") else {
            return core::ptr::null_mut();
        };
        let app: *mut AnyObject = msg_send![app_cls, sharedApplication];
        if app.is_null() {
            return core::ptr::null_mut();
        }
        let win: *mut AnyObject = msg_send![app, keyWindow];
        if !win.is_null() {
            return win;
        }
        let windows: *mut AnyObject = msg_send![app, windows];
        if windows.is_null() {
            return core::ptr::null_mut();
        }
        let count: usize = msg_send![windows, count];
        if count == 0 {
            return core::ptr::null_mut();
        }
        msg_send![windows, objectAtIndex: 0usize]
    }

    /// `UIDevice.currentDevice.systemVersion` is an NSString like "17.5.1";
    /// `integerValue` parses the leading integer. 0 on any null → legacy path.
    unsafe fn os_major_version() -> isize {
        let Some(cls) = AnyClass::get(c"UIDevice") else {
            return 0;
        };
        let dev: *mut AnyObject = msg_send![cls, currentDevice];
        if dev.is_null() {
            return 0;
        }
        let ver: *mut AnyObject = msg_send![dev, systemVersion];
        if ver.is_null() {
            return 0;
        }
        msg_send![ver, integerValue]
    }

    unsafe fn apply_unguarded(enabled: bool) -> Outcome {
        // Copy-then-drop: the lock is released before any ObjC call (see the
        // FIELD doc). Main-thread confinement makes the copy race-free.
        let spliced = FIELD.lock().map(|g| *g).unwrap_or(0);

        let field = if spliced != 0 {
            spliced as *mut AnyObject
        } else {
            // Nothing spliced yet and protection is turning OFF — no-op.
            if !enabled {
                return Outcome::SkippedNoSplice;
            }
            let window = key_window();
            if window.is_null() {
                return Outcome::WindowNotFound;
            }
            // One-time splice. Resolve every participant and bail BEFORE any
            // hierarchy mutation — never leave a half-spliced window.
            let Some(tf_cls) = AnyClass::get(c"UITextField") else {
                return Outcome::LayerNotReady;
            };
            let field: *mut AnyObject = msg_send![tf_cls, new];
            if field.is_null() {
                return Outcome::LayerNotReady;
            }
            let _: () = msg_send![field, setUserInteractionEnabled: false];
            // ScreenProtectorKit's iOS-16 crash workaround: pin the secure
            // field's style (UIUserInterfaceStyleLight = 1) so a dark-mode
            // restyle of secure-entry internals can't fire mid-toggle.
            let _: () = msg_send![field, setOverrideUserInterfaceStyle: 1isize];

            let win_layer: *mut AnyObject = msg_send![window, layer];
            if win_layer.is_null() {
                return Outcome::LayerNotReady;
            }
            let super_layer: *mut AnyObject = msg_send![win_layer, superlayer];
            if super_layer.is_null() {
                // Window layer not attached yet — reparenting now would blank
                // the screen. Retry on the next apply(true).
                return Outcome::LayerNotReady;
            }
            // The secure canvas sublayer exists once the field is in a window.
            let _: () = msg_send![window, addSubview: field];
            let field_layer: *mut AnyObject = msg_send![field, layer];
            let subs: *mut AnyObject = if field_layer.is_null() {
                core::ptr::null_mut()
            } else {
                msg_send![field_layer, sublayers]
            };
            let count: usize = if subs.is_null() {
                0
            } else {
                msg_send![subs, count]
            };
            if count == 0 {
                let _: () = msg_send![field, removeFromSuperview];
                return Outcome::LayerNotReady;
            }
            // The capture-excluded container: sublayers.first below iOS 17,
            // sublayers.last from iOS 17 on (ScreenProtectorKit 1.3.1).
            let idx = if os_major_version() >= 17 {
                count - 1
            } else {
                0
            };
            let host: *mut AnyObject = msg_send![subs, objectAtIndex: idx];
            if host.is_null() {
                let _: () = msg_send![field, removeFromSuperview];
                return Outcome::LayerNotReady;
            }
            // window.layer.superlayer.addSublayer(field.layer), then reparent
            // the window's layer under the secure container.
            let _: () = msg_send![super_layer, addSublayer: field_layer];
            let _: () = msg_send![host, addSublayer: win_layer];

            if let Ok(mut g) = FIELD.lock() {
                *g = field as usize;
            }
            field
        };

        let _: () = msg_send![field, setSecureTextEntry: enabled];
        Outcome::Applied
    }
}

#[cfg(target_os = "android")]
mod android {
    use tauri::plugin::mobile::PluginInvokeError;
    use tauri::{AppHandle, Manager, Runtime};
    use tauri_plugin_screen_guard::ScreenGuard;

    /// Blocking JNI hop serviced BY the main thread — the caller must never be
    /// the main thread (module doc). Hook call sites are async commands.
    pub fn apply<R: Runtime>(app: &AppHandle<R>, enabled: bool, site: &'static str) {
        let Some(guard) = app.try_state::<ScreenGuard<R>>() else {
            tracing::warn!(
                event = "screen_capture_protection_failed",
                platform = "android",
                site,
                reason = "plugin_not_registered"
            );
            return;
        };
        match guard.set_secure(enabled) {
            Ok(()) => tracing::info!(
                event = "screen_capture_protection_applied",
                platform = "android",
                site,
                enabled
            ),
            Err(e) => tracing::warn!(
                event = "screen_capture_protection_failed",
                platform = "android",
                site,
                reason = error_kind(&e)
            ),
        }
    }

    /// Closed-enum mapping — `PluginInvokeError`'s Display can embed arbitrary
    /// Kotlin exception / serde text (DENY-list logging discipline).
    fn error_kind(e: &PluginInvokeError) -> &'static str {
        match e {
            PluginInvokeError::UnreachableWebview => "unreachable_webview",
            PluginInvokeError::Jni(_) => "jni_error",
            PluginInvokeError::InvokeRejected(_) => "invoke_rejected",
            PluginInvokeError::CannotDeserializeResponse(_) => "deserialize_response",
            PluginInvokeError::CannotSerializePayload(_) => "serialize_payload",
        }
    }
}
