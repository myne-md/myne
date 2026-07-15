// SPDX-License-Identifier: AGPL-3.0
//! Native "share / save this file" bridge (mobile). The mobile WebView has no
//! Save-As dialog, so every export/download flow historically wrote silently to
//! the app's Documents directory with no way for the user to pick a destination
//! (MYND-475). The Rust write still happens (the file always lands in Documents,
//! reachable via the Files app — so this is purely ADDITIVE and never a
//! regression), and afterwards the frontend emits [`SHARE_FILE_EVENT`] with the
//! written path; the setup hook (`lib.rs`) listens and presents the platform
//! "ask where to save" UI on the main thread.
//!
//! ## iOS
//!
//! `UIActivityViewController` seeded with the file's `NSURL` — the system share
//! sheet, from which the user taps **Save to Files** (write the file wherever
//! they choose), AirDrop, Mail, etc. This mirrors `pdf_export.rs`'s native-sheet
//! approach (Apple-owned UI, presents over the WebView) and stays on `objc2`
//! alone — no new dependency, no hand-rolled file coordination. The sheet
//! appearing IS the non-silent feedback the issue requires; if the user cancels,
//! the file is still saved in Documents (the additive write above).
//!
//! ## Android
//!
//! The equivalent is an `ACTION_SEND` / Storage-Access-Framework
//! `ACTION_CREATE_DOCUMENT` intent, but reaching the Activity from Rust needs
//! `ndk-context` (absent from the mobile lockfile — adding it breaks offline
//! builds) or a Kotlin plugin. Deferred, same constraint as `pdf_export` and
//! `screen_guard`'s Android halves. Documented no-op for now: the file is still
//! written to Documents and the frontend toasts its location, so the flow is not
//! a silent no-op on Android either.
//!
//! ## Verification status
//!
//! The iOS body compiles against `aarch64-apple-ios-sim` but, like
//! `pdf_export.rs`, is device-verified via `docs/dev/device-matrix.md`, not in
//! this change. It follows the `ios_chrome.rs` / `pdf_export.rs` raw-`msg_send!`
//! idiom and is defensively null-guarded — every failed lookup early-returns to a
//! no-op, never a panic.

/// Frontend → host event carrying a written file to offer for saving/sharing.
/// Payload: [`SharePayload`].
pub const SHARE_FILE_EVENT: &str = "share-file";

/// The already-written file (or export folder) to present in the share sheet.
#[derive(serde::Deserialize)]
pub struct SharePayload {
    /// Absolute filesystem path of the file the backend just wrote.
    pub path: String,
}

/// Present the platform share/save UI for the file at `path`. Must run on the
/// UI/main thread — the caller dispatches via `run_on_main_thread`.
#[cfg(target_os = "ios")]
pub fn present(path: &str) {
    // SAFETY: main thread (see module docs); every ObjC lookup is null-guarded.
    unsafe { ios::present(path) }
}

/// Android: needs the Activity (see module docs). Documented no-op for now.
#[cfg(target_os = "android")]
pub fn present(_path: &str) {
    tracing::warn!(
        event = "share_file_unsupported",
        platform = "android",
        "Android share sheet not yet wired (needs ndk-context / a Kotlin plugin); \
         file remains in Documents"
    );
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn present(_path: &str) {}

#[cfg(target_os = "ios")]
mod ios {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    /// Build an autoreleased `NSString` from a Rust `&str` via
    /// `+[NSString stringWithUTF8String:]` (keeps this module on `objc2` alone —
    /// no `objc2-foundation` dep). Returns null on an interior-NUL string.
    unsafe fn ns_string(s: &str) -> *mut AnyObject {
        let Some(cls) = AnyClass::get(c"NSString") else {
            return core::ptr::null_mut();
        };
        let Ok(cstr) = std::ffi::CString::new(s) else {
            return core::ptr::null_mut();
        };
        msg_send![cls, stringWithUTF8String: cstr.as_ptr()]
    }

    /// The top-most presented view controller reachable from the key window's
    /// root — the correct presenter when the WebView already has a sheet up.
    /// Null when the app has no window/root VC yet.
    unsafe fn top_view_controller() -> *mut AnyObject {
        let Some(app_cls) = AnyClass::get(c"UIApplication") else {
            return core::ptr::null_mut();
        };
        let app: *mut AnyObject = msg_send![app_cls, sharedApplication];
        if app.is_null() {
            return core::ptr::null_mut();
        }
        // `keyWindow` is deprecated on iOS 13+ but still resolves the key window
        // for a single-window Tauri app; fall back to the first window if nil.
        let mut window: *mut AnyObject = msg_send![app, keyWindow];
        if window.is_null() {
            let windows: *mut AnyObject = msg_send![app, windows];
            if !windows.is_null() {
                window = msg_send![windows, firstObject];
            }
        }
        if window.is_null() {
            return core::ptr::null_mut();
        }
        let mut vc: *mut AnyObject = msg_send![window, rootViewController];
        if vc.is_null() {
            return core::ptr::null_mut();
        }
        // Walk to the top-most presented controller so we never try to present
        // over a VC that is already presenting (a UIKit no-op + warning).
        loop {
            let presented: *mut AnyObject = msg_send![vc, presentedViewController];
            if presented.is_null() {
                break;
            }
            vc = presented;
        }
        vc
    }

    pub unsafe fn present(path: &str) {
        let presenter = top_view_controller();
        if presenter.is_null() {
            return;
        }

        // NSURL fileURLWithPath: — the activity item.
        let Some(url_cls) = AnyClass::get(c"NSURL") else {
            return;
        };
        let ns_path = ns_string(path);
        if ns_path.is_null() {
            return;
        }
        let url: *mut AnyObject = msg_send![url_cls, fileURLWithPath: ns_path];
        if url.is_null() {
            return;
        }

        // NSArray with the single file URL as the activity item.
        let Some(arr_cls) = AnyClass::get(c"NSArray") else {
            return;
        };
        let items: *mut AnyObject = msg_send![arr_cls, arrayWithObject: url];
        if items.is_null() {
            return;
        }

        // [[UIActivityViewController alloc] initWithActivityItems:applicationActivities:nil]
        let Some(avc_cls) = AnyClass::get(c"UIActivityViewController") else {
            return;
        };
        let avc_alloc: *mut AnyObject = msg_send![avc_cls, alloc];
        let null_activities: *mut AnyObject = core::ptr::null_mut();
        let avc: *mut AnyObject =
            msg_send![avc_alloc, initWithActivityItems: items, applicationActivities: null_activities];
        if avc.is_null() {
            return;
        }

        // iPad requires a popover anchor or the present call throws. Anchor to
        // the presenter's own view (centered) when a popover controller exists;
        // on iPhone `popoverPresentationController` is nil and the sheet is modal.
        let popover: *mut AnyObject = msg_send![avc, popoverPresentationController];
        if !popover.is_null() {
            let source: *mut AnyObject = msg_send![presenter, view];
            if !source.is_null() {
                let _: () = msg_send![popover, setSourceView: source];
            }
        }

        // Present over the WebView. A null completion block is allowed (the sheet
        // dismisses itself); the additive Documents write already gave the user a
        // saved copy + toast, so no result channel is needed here.
        let null_block: *mut AnyObject = core::ptr::null_mut();
        let _: () = msg_send![presenter, presentViewController: avc, animated: true, completion: null_block];
    }
}
