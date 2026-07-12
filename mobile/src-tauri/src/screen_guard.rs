// SPDX-License-Identifier: AGPL-3.0
//! Mobile screen-capture protection — the native side-effect the shared
//! `myne-core` `apply_screen_capture` lifecycle hook drives (called from
//! `vault_unlock` with the persisted toggle, from `vault_lock` always-ON, and
//! from the `set_screen_capture_protection` prefs IPC). Desktop routes the same
//! hook to `set_content_protected`; that Tauri/tao call is a **compile-time
//! no-op on iOS + Android** (the tao content-protection path is `#[cfg(any(
//! macos, windows))]`-gated), so mobile needs a real platform implementation —
//! this module.
//!
//! `apply` MUST run on the UI/main thread (UIKit + Android `Window.setFlags`
//! both require it). The hook (`hooks::MobileHooks::apply_screen_capture`) runs
//! in the async command context, so it dispatches here via Tauri's
//! `AppHandle::run_on_main_thread`.
//!
//! ## iOS
//!
//! iOS has **no public API to block a single manual screenshot** — this is the
//! documented threat-model limit (`threat-model.md` §6, best-effort defense-in-
//! depth). The technique used here is the widely-deployed "secure text field"
//! trick: a `UITextField` with `secureTextEntry = YES` owns a capture-excluded
//! backing layer; splicing the app window's layer under it makes the window
//! content render **blank in screenshots and screen recordings / mirroring**
//! while `secureTextEntry` is on. Toggling `secureTextEntry` enables/disables
//! protection after the one-time layer splice.
//!
//! ## Android
//!
//! `WindowManager.LayoutParams.FLAG_SECURE` is the correct primitive (blocks
//! screenshots, recording, and the app-switcher preview) but reaching the
//! Activity from Rust needs `ndk-context`, which is NOT in the mobile lockfile.
//! Adding it would force a network/lockfile update and break offline builds, so
//! the Android path is a documented TODO (see `myne-mobile/CLAUDE.md`) pending a
//! Kotlin Tauri plugin or the `ndk-context` dependency. Until then it no-ops.
//!
//! ## Verification status
//!
//! The `#[cfg(target_os = "ios")]` body is NOT compiled by a host `cargo check`
//! and has NOT been built/run on a device in this change — it follows the
//! `ios_chrome.rs` raw-`msg_send!` idiom and is defensively null-guarded (every
//! failed lookup early-returns to a no-op, never a panic), but the layer splice
//! is the piece to validate first on a real device.

/// Apply (or remove) screen-capture protection to the app's main window.
///
/// **TEMPORARILY DISABLED (no-op).** The secure-`UITextField` layer splice in
/// [`ios::apply`] reparents the *root* `UIWindow`'s layer; run automatically on
/// the main thread right after unlock (this hook fires post-unlock), that view-
/// hierarchy surgery crashed the app on-device. ObjC-level faults there cannot
/// be caught by Rust, so it must NOT run automatically until it is developed
/// with a device in the loop. The implementation is retained below for that
/// follow-up. Until then iOS gets no screen-capture protection (same as before
/// this change — a missing feature, not a crash).
#[cfg(target_os = "ios")]
pub fn apply(_enabled: bool) {}

/// Android: FLAG_SECURE is the right primitive but reaching the Activity from
/// Rust needs `ndk-context` (absent from the lockfile). Documented no-op for now.
#[cfg(target_os = "android")]
pub fn apply(enabled: bool) {
    tracing::warn!(
        event = "screen_capture_protection_unsupported",
        platform = "android",
        enabled,
        "Android FLAG_SECURE not yet wired (needs ndk-context / a Kotlin plugin)"
    );
}

/// Every other target (desktop dev host): no screen surface to protect here.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn apply(_enabled: bool) {}

#[cfg(target_os = "ios")]
#[allow(dead_code)] // retained for the device-in-the-loop follow-up (see `apply`)
mod ios {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::sync::Mutex;

    // The secure `UITextField` whose capture-excluded layer hosts the app
    // window's layer. Spliced once (first `apply(true)`); afterwards we only
    // toggle `secureTextEntry`. Stored as `usize` (a raw ObjC pointer) because a
    // `*mut AnyObject` is not `Sync`; access is confined to the main thread by
    // the `run_on_main_thread` dispatch, so the bare pointer is sound. `new`
    // gives us a +1-retained object we intentionally never release (process-
    // lifetime), so the stored pointer stays valid.
    static FIELD: Mutex<usize> = Mutex::new(0);

    /// Resolve the active `UIWindow`. Prefers the (deprecated but still
    /// functional for a single-window app) `keyWindow`, falling back to the
    /// first element of `windows`. Returns null if none is available yet.
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

    pub unsafe fn apply(enabled: bool) {
        let window = key_window();
        if window.is_null() {
            return;
        }

        let mut guard = match FIELD.lock() {
            Ok(g) => g,
            Err(_) => return,
        };

        if *guard == 0 {
            // Nothing spliced yet and protection is being turned OFF — no-op.
            // Never reparent the window layer just to immediately disable it (a
            // vault with protection off must not pay any rendering side-effect).
            if !enabled {
                return;
            }
            // One-time splice: create the secure field, add it to the window,
            // then reparent the window's layer under the field's capture-
            // excluded backing layer (the canonical iOS screenshot-block trick).
            let Some(tf_cls) = AnyClass::get(c"UITextField") else {
                return;
            };
            let field: *mut AnyObject = msg_send![tf_cls, new];
            if field.is_null() {
                return;
            }
            let _: () = msg_send![field, setUserInteractionEnabled: false];
            let _: () = msg_send![window, addSubview: field];

            let win_layer: *mut AnyObject = msg_send![window, layer];
            let field_layer: *mut AnyObject = msg_send![field, layer];
            if win_layer.is_null() || field_layer.is_null() {
                return;
            }
            // window.layer.superlayer?.addSublayer(field.layer)
            let super_layer: *mut AnyObject = msg_send![win_layer, superlayer];
            if !super_layer.is_null() {
                let _: () = msg_send![super_layer, addSublayer: field_layer];
            }
            // field.layer.sublayers.last?.addSublayer(window.layer)
            let subs: *mut AnyObject = msg_send![field_layer, sublayers];
            if !subs.is_null() {
                let count: usize = msg_send![subs, count];
                if count > 0 {
                    let last: *mut AnyObject = msg_send![subs, objectAtIndex: count - 1];
                    if !last.is_null() {
                        let _: () = msg_send![last, addSublayer: win_layer];
                    }
                }
            }
            *guard = field as usize;
        }

        let field = *guard as *mut AnyObject;
        if !field.is_null() {
            let _: () = msg_send![field, setSecureTextEntry: enabled];
        }
    }
}
