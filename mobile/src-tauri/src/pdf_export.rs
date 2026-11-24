// SPDX-License-Identifier: AGPL-3.0-only
//! Native note → PDF export (mobile). `window.print()` is a no-op in the mobile
//! WebView (WKWebView doesn't implement it without a native hook), so the old
//! "Export as PDF" action did nothing. The frontend emits [`EXPORT_PDF_EVENT`]
//! with the note title, its rendered HTML, and a destination `path`; the setup
//! hook (`lib.rs`) listens and, on the main thread, renders the HTML to a PDF
//! FILE at `path` and then presents the same native **share sheet** the other
//! export flows use (`share_file`) — so "Export as PDF" ends in Save to Files /
//! AirDrop / etc., NOT the iOS print dialog (MYND-475).
//!
//! ## iOS
//!
//! `UIPrintPageRenderer` + `UIMarkupTextPrintFormatter` lay the note HTML out to
//! an A4 page grid, drawn into a PDF file via the `UIGraphics*PDF*` context (no
//! print controller, no print/preview sheet). The finished file is handed to
//! [`crate::share_file::present_on_main_thread`] for the
//! `UIActivityViewController` share sheet.
//! Geometry crosses `msg_send!` + the C ABI via `objc2-core-foundation`'s
//! `CGRect` (correct `Encode`), otherwise this stays on the `objc2` +
//! raw-`msg_send!` idiom of `ios_chrome`/`screen_guard`.
//!
//! ## Android
//!
//! Unimplemented, and the missing piece is the RENDERER rather than the delivery:
//! Android's equivalent is `PrintManager` + `WebView.createPrintDocumentAdapter`
//! reached from the committed Kotlin, and until that exists there is no `.pdf` to
//! hand to the save picker (`share_file`'s Android half landed in myne-md/myne#505
//! and this flow gets it for free on the day a renderer exists). The frontend
//! surfaces the unsupported state, so this is a documented gap rather than a
//! silent one.
//!
//! ## Verification status
//!
//! The iOS body compiles against `aarch64-apple-ios-sim` but is device-verified
//! via `dev-notes/device-matrix.md` §8, not in this change. It follows the
//! `ios_chrome.rs` raw-`msg_send!` idiom and is defensively null-guarded (each
//! failed lookup early-returns to a no-op, never a panic).

/// Frontend → host event carrying a note to export. Payload: [`ExportPayload`].
pub const EXPORT_PDF_EVENT: &str = "export-note-pdf";

/// The note to render, as emitted by the frontend's "Export as PDF" action.
#[derive(serde::Deserialize)]
pub struct ExportPayload {
    /// Note title — used as the print job / suggested PDF file name.
    pub title: String,
    /// Self-contained HTML document (the rendered note body) to lay out.
    pub html: String,
    /// Absolute destination path for the rendered `.pdf` (under Documents, so it
    /// lands reachably even if the share sheet is cancelled — additive, like the
    /// other MYND-475 export flows).
    pub path: String,
}

/// Render `html` (titled `title`) to a PDF at `path`, then present the native
/// share sheet for it. Must run on the UI/main thread — the caller dispatches
/// via `run_on_main_thread`.
#[cfg(target_os = "ios")]
pub fn present(title: &str, html: &str, path: &str) {
    // SAFETY: main thread (see module docs); every ObjC lookup is null-guarded.
    let rendered = unsafe { ios::render_pdf(title, html, path) };
    if rendered {
        // Reuse the shared share-sheet bridge (also main-thread) for the result.
        crate::share_file::present_on_main_thread(path);
    }
}

/// Android: needs the Activity (see module docs). Documented no-op for now.
#[cfg(target_os = "android")]
pub fn present(_title: &str, _html: &str, _path: &str) {
    tracing::warn!(
        event = "pdf_export_unsupported",
        platform = "android",
        "Android print export not yet wired (there is no HTML-to-PDF renderer in \
         this app yet; the save picker that would carry the result is already \
         wired, see share_file.rs)"
    );
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn present(_title: &str, _html: &str, _path: &str) {}

#[cfg(target_os = "ios")]
mod ios {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    // A4 at 72 dpi (points) + a 24 pt margin. Matches the print-formatter's
    // legible defaults; the renderer insets content to `printableRect`.
    const A4_W: f64 = 595.28;
    const A4_H: f64 = 841.89;
    const MARGIN: f64 = 24.0;

    // UIKit PDF-context C functions. Resolved from the UIKit framework already
    // linked into the app bundle (project.yml lists UIKit.framework).
    #[link(name = "UIKit", kind = "framework")]
    extern "C" {
        fn UIGraphicsBeginPDFContextToFile(
            path: *mut AnyObject,
            bounds: CGRect,
            document_info: *mut AnyObject,
        ) -> bool;
        fn UIGraphicsBeginPDFPage();
        fn UIGraphicsGetPDFContextBounds() -> CGRect;
        fn UIGraphicsEndPDFContext();
    }

    /// Build an autoreleased `NSString` from a Rust `&str` via
    /// `+[NSString stringWithUTF8String:]`. Returns null on an interior-NUL string.
    unsafe fn ns_string(s: &str) -> *mut AnyObject {
        let Some(cls) = AnyClass::get(c"NSString") else {
            return core::ptr::null_mut();
        };
        let Ok(cstr) = std::ffi::CString::new(s) else {
            return core::ptr::null_mut();
        };
        msg_send![cls, stringWithUTF8String: cstr.as_ptr()]
    }

    /// Wrap a `CGRect` in an autoreleased `NSValue` for KVC assignment of the
    /// renderer's paper/printable rects (`+[NSValue valueWithCGRect:]`).
    unsafe fn ns_value_rect(rect: CGRect) -> *mut AnyObject {
        let Some(cls) = AnyClass::get(c"NSValue") else {
            return core::ptr::null_mut();
        };
        msg_send![cls, valueWithCGRect: rect]
    }

    /// Render `html` to a PDF file at `path` (A4, 24 pt margins). Returns true on
    /// success; false (no-op, nothing written) on any failed lookup — never panics.
    pub unsafe fn render_pdf(_title: &str, html: &str, path: &str) -> bool {
        let paper = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(A4_W, A4_H));
        let printable = CGRect::new(
            CGPoint::new(MARGIN, MARGIN),
            CGSize::new(A4_W - 2.0 * MARGIN, A4_H - 2.0 * MARGIN),
        );

        // Markup formatter for the note's HTML.
        let Some(fmt_cls) = AnyClass::get(c"UIMarkupTextPrintFormatter") else {
            return false;
        };
        let markup = ns_string(html);
        if markup.is_null() {
            return false;
        }
        let fmt_alloc: *mut AnyObject = msg_send![fmt_cls, alloc];
        let fmt: *mut AnyObject = msg_send![fmt_alloc, initWithMarkupText: markup];
        if fmt.is_null() {
            return false;
        }

        // Page renderer; attach the formatter starting at page 0.
        let Some(rend_cls) = AnyClass::get(c"UIPrintPageRenderer") else {
            return false;
        };
        let rend_alloc: *mut AnyObject = msg_send![rend_cls, alloc];
        let renderer: *mut AnyObject = msg_send![rend_alloc, init];
        if renderer.is_null() {
            return false;
        }
        let _: () = msg_send![renderer, addPrintFormatter: fmt, startingAtPageAtIndex: 0i64];

        // The renderer paginates from paperRect/printableRect (KVC-only props).
        let paper_val = ns_value_rect(paper);
        let printable_val = ns_value_rect(printable);
        let paper_key = ns_string("paperRect");
        let printable_key = ns_string("printableRect");
        if paper_val.is_null()
            || printable_val.is_null()
            || paper_key.is_null()
            || printable_key.is_null()
        {
            return false;
        }
        let _: () = msg_send![renderer, setValue: paper_val, forKey: paper_key];
        let _: () = msg_send![renderer, setValue: printable_val, forKey: printable_key];

        // Open the PDF file context, draw every page, close it.
        let ns_path = ns_string(path);
        if ns_path.is_null() {
            return false;
        }
        let null_info: *mut AnyObject = core::ptr::null_mut();
        if !UIGraphicsBeginPDFContextToFile(ns_path, paper, null_info) {
            return false;
        }
        let pages: i64 = msg_send![renderer, numberOfPages];
        for i in 0..pages {
            UIGraphicsBeginPDFPage();
            let bounds = UIGraphicsGetPDFContextBounds();
            let _: () = msg_send![renderer, drawPageAtIndex: i, inRect: bounds];
        }
        UIGraphicsEndPDFContext();
        true
    }
}
