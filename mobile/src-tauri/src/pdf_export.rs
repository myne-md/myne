// SPDX-License-Identifier: AGPL-3.0
//! Native note → PDF export (mobile). `window.print()` is a no-op in the mobile
//! WebView (WKWebView doesn't implement it without a native hook), so the old
//! "Export as PDF" action did nothing. Instead the frontend emits
//! [`EXPORT_PDF_EVENT`] with the note title + its rendered HTML; the setup hook
//! (`lib.rs`) listens and presents the platform export UI on the main thread.
//!
//! ## iOS
//!
//! `UIPrintInteractionController` + `UIMarkupTextPrintFormatter` — the system
//! print/preview sheet. From it the user prints OR taps Share → **Save to Files**
//! to write a PDF wherever they choose (the native "ask where to save"). This is
//! deliberately the robust Apple-owned path rather than hand-rolling PDF bytes +
//! a `UIActivityViewController`: no `UIGraphics` C calls, no temp file, no manual
//! VC presentation — the controller presents itself. A follow-up can swap in a
//! pre-rendered-PDF share sheet if a one-tap "Save PDF" is wanted.
//!
//! ## Android
//!
//! `PrintManager` + `WebView.createPrintDocumentAdapter` is the equivalent, but
//! reaching the Activity from Rust needs `ndk-context` (absent from the mobile
//! lockfile — adding it breaks offline builds). Deferred, same constraint as
//! `screen_guard`. Documented no-op for now.
//!
//! ## Verification status
//!
//! The iOS body compiles against the `aarch64-apple-ios-sim` target but has NOT
//! been run on a device in this change. It follows the `ios_chrome.rs` raw-
//! `msg_send!` idiom and is defensively null-guarded (each failed lookup early-
//! returns to a no-op, never a panic).

/// Frontend → host event carrying a note to export. Payload: [`ExportPayload`].
pub const EXPORT_PDF_EVENT: &str = "export-note-pdf";

/// The note to render, as emitted by the frontend's "Export as PDF" action.
#[derive(serde::Deserialize)]
pub struct ExportPayload {
    /// Note title — used as the print job / suggested PDF file name.
    pub title: String,
    /// Self-contained HTML document (the rendered note body) to lay out.
    pub html: String,
}

/// Present the platform export UI for `html` (titled `title`). Must run on the
/// UI/main thread — the caller dispatches via `run_on_main_thread`.
#[cfg(target_os = "ios")]
pub fn present(title: &str, html: &str) {
    // SAFETY: main thread (see module docs); every ObjC lookup is null-guarded.
    unsafe { ios::present(title, html) }
}

/// Android: needs the Activity (see module docs). Documented no-op for now.
#[cfg(target_os = "android")]
pub fn present(_title: &str, _html: &str) {
    tracing::warn!(
        event = "pdf_export_unsupported",
        platform = "android",
        "Android print export not yet wired (needs ndk-context / a Kotlin plugin)"
    );
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn present(_title: &str, _html: &str) {}

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

    pub unsafe fn present(title: &str, html: &str) {
        let Some(pic_cls) = AnyClass::get(c"UIPrintInteractionController") else {
            return;
        };
        let controller: *mut AnyObject = msg_send![pic_cls, sharedPrintController];
        if controller.is_null() {
            return;
        }

        // Print info — carries the job name (the suggested PDF file name).
        if let Some(info_cls) = AnyClass::get(c"UIPrintInfo") {
            let info: *mut AnyObject = msg_send![info_cls, printInfo];
            if !info.is_null() {
                let job = ns_string(title);
                if !job.is_null() {
                    let _: () = msg_send![info, setJobName: job];
                }
                let _: () = msg_send![controller, setPrintInfo: info];
            }
        }

        // Markup formatter — lays out the note's HTML for print/PDF.
        let Some(fmt_cls) = AnyClass::get(c"UIMarkupTextPrintFormatter") else {
            return;
        };
        let markup = ns_string(html);
        if markup.is_null() {
            return;
        }
        let fmt_alloc: *mut AnyObject = msg_send![fmt_cls, alloc];
        let fmt: *mut AnyObject = msg_send![fmt_alloc, initWithMarkupText: markup];
        if fmt.is_null() {
            return;
        }
        let _: () = msg_send![controller, setPrintFormatter: fmt];

        // Present the system print/preview sheet (fullscreen on iPhone). A null
        // completion block is allowed. iPad would need a source rect/bar-button
        // anchor — a follow-up when an iPad layout ships.
        let null_block: *mut AnyObject = core::ptr::null_mut();
        let _: () = msg_send![controller, presentAnimated: true, completionHandler: null_block];
    }
}
