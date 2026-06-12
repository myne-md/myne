//! Per-OS native print-to-PDF arms (MYND-255 task 4).
//!
//! Tauri 2 / wry expose no print-to-PDF API (wry #707, tauri #12284 —
//! only a dialog-launching `print()`), so each desktop platform is
//! reached through the `with_webview` platform-handle escape hatch:
//!
//! - **macOS** — `WKWebView printOperationWithPrintInfo:` with an
//!   `NSPrintSaveJob` disposition (`NSPrintJobSavingURL` → temp file).
//!   Paginated, selectable text. `WKWebView createPDF` is deliberately
//!   NOT used — it produces a single unpaginated page (auto-grill
//!   brief). **Asynchronous via `runOperationModalForWindow:` + a
//!   delegate callback** — the synchronous `runOperation` DEADLOCKS for
//!   WKWebView (verified on the dev machine): WKPrintingView's
//!   pagination needs main-run-loop callbacks that `runOperation`
//!   itself blocks, so the operation wedges until the capture deadline.
//!   The modal-for-window form pumps the run loop and reports through
//!   `printOperationDidRun:success:contextInfo:` (both panels disabled
//!   — nothing is ever shown, the window stays hidden).
//! - **Linux** — `WebKitPrintOperation` with `GtkPrintSettings`
//!   print-to-file keys (`printer = "Print to File"`, `output-uri`,
//!   `output-file-format = pdf`). Asynchronous: completion arrives on
//!   the GTK main loop via the `finished` / `failed` signals.
//! - **Windows** — `ICoreWebView2_7::PrintToPdf` with the default
//!   print settings. Asynchronous via the completed handler.
//!   **Best-effort, compile-correct by API docs only** — this project
//!   has no Windows build/test lane; if the arm proves unviable the
//!   ratified fallback is `window.print()` on that platform.
//!
//! Every arm reduces native failures to the closed
//! [`CaptureFailureKind`] — NSError / GError / HRESULT payloads never
//! reach logs or IPC (DENY-list discipline; see `src-tauri/CLAUDE.md`).
//!
//! All platform crates here are **transitive→direct promotions** of
//! packages already pinned in `Cargo.lock` via tauri/wry (the
//! `windows-sys` precedent in `Cargo.toml`) — zero dependency-tree
//! expansion.
//!
//! Each arm has the signature
//! `start_print_to_pdf(webview, dest, on_done)`: it is invoked inside
//! the `with_webview` closure (main thread) and reports exactly once
//! through `on_done`, from the native completion callback. The
//! orchestrator in `commands.rs` enforces the capture deadline, so a
//! swallowed callback degrades to `CaptureFailureKind::Timeout`, never
//! a hang.

use std::path::Path;

use super::error::CaptureFailureKind;

/// Boxed one-shot completion used by the async arms (the macOS
/// delegate and the Linux/Windows signal closures can fire more than
/// once in pathological cases — the `Option::take` inside guarantees
/// exactly-once delivery).
type OnDone = Box<dyn FnOnce(Result<(), CaptureFailureKind>) + Send + 'static>;

// ---- macOS — NSPrintOperation save-to-PDF (async, modal-for-window) ----

#[cfg(target_os = "macos")]
pub(super) fn start_print_to_pdf(
    webview: &tauri::webview::PlatformWebview,
    dest: &Path,
    on_done: impl FnOnce(Result<(), CaptureFailureKind>) + Send + 'static,
) {
    macos_print::launch(webview, dest, Box::new(on_done));
}

#[cfg(target_os = "macos")]
mod macos_print {
    use std::cell::Cell;
    use std::ffi::c_void;
    use std::path::Path;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass};
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode,
    };
    use objc2_foundation::{NSCopying, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    use super::{CaptureFailureKind, OnDone};

    struct Ivars {
        /// One-shot completion; `Cell` so the delegate method can
        /// `take()` through `&self`.
        on_done: Cell<Option<OnDone>>,
        /// Self-retain (deliberate retain cycle): `NSPrintOperation`
        /// does NOT retain its didRun delegate, and a wedged operation
        /// can outlive both the capture deadline and the single-slot
        /// session (255-F1) — so the delegate keeps ITSELF alive until
        /// its own callback consumes this slot. A callback that never
        /// fires leaks exactly one tiny object per wedged operation
        /// (bounded, and strictly better than the use-after-free a
        /// premature release would risk). See the ownership-contract
        /// comment in [`launch`].
        self_retain: Cell<Option<Retained<PrintDelegate>>>,
    }

    define_class!(
        // SAFETY:
        // - NSObject has no subclassing requirements.
        // - `PrintDelegate` does not implement `Drop`.
        #[unsafe(super(NSObject))]
        #[name = "MynePdfExportPrintDelegate"]
        #[ivars = Ivars]
        struct PrintDelegate;

        impl PrintDelegate {
            /// The documented `runOperationModalForWindow:` completion
            /// callback: `printOperationDidRun:success:contextInfo:`.
            /// `_op` is deliberately a raw pointer (never dereferenced);
            /// the NSError lives on the operation and is deliberately
            /// unread — DENY-list discipline.
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn print_operation_did_run(
                &self,
                _op: *mut AnyObject,
                success: bool,
                _ctx: *mut c_void,
            ) {
                if let Some(f) = self.ivars().on_done.take() {
                    f(if success {
                        // Success claim is verified downstream
                        // (`finalize_capture_output` checks `%PDF` magic).
                        Ok(())
                    } else {
                        Err(CaptureFailureKind::NativePrintFailed)
                    });
                }
                // Consume the self-retain — the operation is done with
                // us, so the delegate may now die. Released via
                // AUTORELEASE, not drop: dropping what may be the last
                // strong reference would deallocate the object while
                // `&self` (a protected method argument) is still live —
                // UB. `autorelease_ptr` defers the release to the main
                // run loop's autorelease-pool drain, safely after this
                // AppKit-invoked frame has returned.
                if let Some(this) = self.ivars().self_retain.take() {
                    let _ = Retained::autorelease_ptr(this);
                }
            }
        }
    );

    impl PrintDelegate {
        fn new(on_done: OnDone) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars {
                on_done: Cell::new(Some(on_done)),
                self_retain: Cell::new(None),
            });
            // SAFETY: NSObject's plain `init`.
            unsafe { msg_send![super(this), init] }
        }
    }

    thread_local! {
        /// Secondary (belt-and-suspenders) guard only — the PRIMARY
        /// lifetime guarantee is the delegate's own `self_retain` cycle
        /// (255-F1): a wedged `NSPrintOperation` can outlive the
        /// capture deadline AND the single-slot session reset, so the
        /// "previous operation has long completed by the next capture"
        /// assumption this slot once relied on is NOT enforced by
        /// anything. With the self-retain in place, replacing this slot
        /// merely drops one of (at least) two strong references — slot
        /// reset can never deallocate a delegate a live operation might
        /// still message. Main-thread only (the `with_webview` closure).
        static LIVE_DELEGATE: Cell<Option<Retained<PrintDelegate>>> =
            const { Cell::new(None) };
    }

    pub(super) fn launch(webview: &tauri::webview::PlatformWebview, dest: &Path, on_done: OnDone) {
        let ptr = webview.inner() as *mut WKWebView;
        // SAFETY: inside the `with_webview` closure (main thread) tauri
        // guarantees `inner()` is the live WKWebView pointer.
        let Some(view) = (unsafe { ptr.as_ref() }) else {
            on_done(Err(CaptureFailureKind::NativePrintFailed));
            return;
        };
        // The hidden window hosting the webview — the modal-for-window
        // anchor. With both panels disabled nothing is ever presented;
        // the window stays invisible.
        let Some(window) = view.window() else {
            on_done(Err(CaptureFailureKind::NativePrintFailed));
            return;
        };

        // Mutate a COPY of the shared print info, never the global
        // singleton (other print paths — e.g. a future window.print() —
        // must not inherit the save-to-file disposition).
        let info = NSPrintInfo::sharedPrintInfo().copy();

        // SAFETY: reading AppKit extern statics (link-time constants).
        let save_job = unsafe { NSPrintSaveJob };
        let saving_url_key = unsafe { NSPrintJobSavingURL };

        info.setJobDisposition(save_job);
        // Automatic pagination — WebKit drives page breaks from the
        // document's print CSS (`@page` rules land with task 3).
        info.setHorizontalPagination(NSPrintingPaginationMode::Automatic);
        info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        // GEOMETRY CONTRACT (task 3 coordination): the native margins are
        // zeroed so the print CSS `@page { size; margin }` is the single
        // authority — CSS margins never compose with NSPrintInfo margins.
        // Paper size stays the system default (locale A4/Letter) until
        // task 3's locale mapping decides otherwise.
        info.setTopMargin(0.0);
        info.setBottomMargin(0.0);
        info.setLeftMargin(0.0);
        info.setRightMargin(0.0);

        let dest_ns = NSString::from_str(&dest.to_string_lossy());
        let url = NSURL::fileURLWithPath(&dest_ns);
        let url_obj: &AnyObject = &url;
        // SAFETY: `dictionary()` is the live attributes dictionary of our
        // private copy; key/value types match the documented
        // NSPrintJobSavingURL contract (NSURL value).
        unsafe {
            info.dictionary()
                .setObject_forKey(url_obj, ProtocolObject::from_ref(saving_url_key));
        }

        // SAFETY: `view` is a live WKWebView on the main thread.
        let op = unsafe { view.printOperationWithPrintInfo(&info) };
        op.setShowsPrintPanel(false);
        op.setShowsProgressPanel(false);

        let delegate = PrintDelegate::new(on_done);
        // OWNERSHIP CONTRACT (255-F1): `NSPrintOperation` holds the
        // delegate as a NON-retained raw pointer, and AppKit gives no
        // upper bound on when (or whether) the didRun callback fires —
        // a wedged pagination can outlive the 30 s capture deadline,
        // the session `reset()`, and the next export's `launch`. The
        // delegate therefore retains ITSELF (a deliberate retain cycle,
        // armed here BEFORE the operation can learn the pointer) and
        // breaks the cycle from inside its own callback — the one point
        // where "the operation is done messaging us" is guaranteed. A
        // never-firing callback leaks one delegate per wedged op
        // (bounded; strictly better than a use-after-free). No external
        // owner — LIVE_DELEGATE included — is load-bearing for safety.
        delegate.ivars().self_retain.set(Some(delegate.clone()));
        let delegate_obj: &AnyObject = &delegate;
        // SAFETY: `delegate` implements the selector with the documented
        // signature; contextInfo is unused (null). The async operation
        // pumps the main run loop (WKPrintingView pagination needs it —
        // the synchronous `runOperation` deadlocks instead) and calls
        // the delegate exactly once when the PDF is written; a swallowed
        // callback degrades to the orchestrator's capture deadline. The
        // delegate pointer stays valid for the operation's whole
        // lifetime via the self-retain armed above.
        unsafe {
            op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                Some(delegate_obj),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
        }
        // Secondary guard only (see LIVE_DELEGATE's doc): the self-
        // retain above is the safety anchor.
        LIVE_DELEGATE.with(|slot| slot.set(Some(delegate)));
    }

    /// What is (and is not) unit-testable here: the full capture arm
    /// needs a live `WKWebView`, an `NSWindow`, and a pumped main run
    /// loop driving a real `NSPrintOperation` — none of which `cargo
    /// test` can own (the manual dev smoke, `MYNE_PDF_SMOKE=… pnpm
    /// tauri dev`, exercises that path). The delegate's OWNERSHIP
    /// contract, however, is plain Objective-C object lifetime and IS
    /// testable: the tests below drive the didRun selector directly
    /// (exactly what AppKit would send) and pin (a) exactly-once
    /// completion delivery and (b) the 255-F1 self-retain cycle —
    /// alive while armed, deallocated once the callback consumes it.
    #[cfg(test)]
    mod tests {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        use objc2::rc::{autoreleasepool, Weak};

        // `super::*` re-surfaces the parent module's imports
        // (`msg_send`, `AnyObject`, `DefinedClass`, `Retained`, …).
        use super::*;

        /// Send the documented completion selector at the delegate —
        /// the byte-for-byte message AppKit's print operation sends.
        fn send_did_run(delegate: &PrintDelegate, success: bool) {
            // SAFETY: the selector is implemented by `define_class!`
            // above with this exact signature; the op pointer is
            // deliberately null (the method never dereferences it).
            let _: () = unsafe {
                msg_send![
                    delegate,
                    printOperationDidRun: std::ptr::null_mut::<AnyObject>(),
                    success: success,
                    contextInfo: std::ptr::null_mut::<std::ffi::c_void>(),
                ]
            };
        }

        #[test]
        fn callback_fires_exactly_once_and_consumes_the_self_retain() {
            let fired = Arc::new(AtomicU32::new(0));
            let fired_in_cb = Arc::clone(&fired);

            let weak: Weak<PrintDelegate> = autoreleasepool(|_| {
                let delegate = PrintDelegate::new(Box::new(move |res| {
                    assert!(res.is_ok(), "success=true must arrive as Ok");
                    fired_in_cb.fetch_add(1, Ordering::SeqCst);
                }));
                // Arm the self-retain exactly as `launch` does.
                delegate.ivars().self_retain.set(Some(delegate.clone()));
                let weak = Weak::from_retained(&delegate);

                send_did_run(&delegate, true);
                assert_eq!(fired.load(Ordering::SeqCst), 1);
                // The self-retain slot is consumed by the callback.
                assert!(delegate.ivars().self_retain.take().is_none());

                // Pathological double-fire: the `Option::take` makes
                // delivery exactly-once (success=false would surface
                // Err — the assert inside the closure never runs).
                send_did_run(&delegate, false);
                assert_eq!(fired.load(Ordering::SeqCst), 1);

                weak
                // `delegate` (the last non-autoreleased strong ref)
                // drops here; the autoreleased self-retain releases
                // when this pool drains.
            });

            assert!(
                weak.load().is_none(),
                "delegate must deallocate once its callback consumed the self-retain"
            );
        }

        #[test]
        fn self_retain_keeps_the_delegate_alive_until_the_callback() {
            let weak: Weak<PrintDelegate> = autoreleasepool(|_| {
                let delegate = PrintDelegate::new(Box::new(|_| {}));
                delegate.ivars().self_retain.set(Some(delegate.clone()));
                Weak::from_retained(&delegate)
                // ALL external strong refs drop here (the wedged-op
                // model: slot reset + LIVE_DELEGATE replacement) —
                // only the self-retain cycle remains.
            });
            let resurrected = weak
                .load()
                .expect("self-retained delegate must survive losing every external owner");
            // The (simulated) late callback now consumes the cycle…
            autoreleasepool(|_| {
                send_did_run(&resurrected, true);
                drop(resurrected);
            });
            // …and the delegate finally deallocates.
            assert!(weak.load().is_none());
        }
    }
}

// ---- Linux — WebKitPrintOperation print-to-file (async, GTK loop) ------

#[cfg(target_os = "linux")]
pub(super) fn start_print_to_pdf(
    webview: &tauri::webview::PlatformWebview,
    dest: &Path,
    on_done: impl FnOnce(Result<(), CaptureFailureKind>) + Send + 'static,
) {
    use std::sync::{Arc, Mutex};
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    let on_done: OnDone = Box::new(on_done);

    // file:// URI for the GtkPrintBackendFile output key. glib owns
    // the percent-encoding; a failure here is a path-shape problem.
    let uri = match gtk::glib::filename_to_uri(dest, None) {
        Ok(uri) => uri,
        Err(_) => {
            on_done(Err(CaptureFailureKind::NativePrintFailed));
            return;
        }
    };

    let settings = gtk::PrintSettings::new();
    // The documented silent print-to-file recipe (GtkPrintBackendFile):
    // route to the virtual file printer with a pdf output-uri. Key
    // names are the stable GTK_PRINT_SETTINGS_* string constants.
    settings.set_printer("Print to File");
    settings.set("output-file-format", Some("pdf"));
    settings.set("output-uri", Some(uri.as_str()));

    let op = PrintOperation::new(&webview.inner());
    op.set_print_settings(&settings);

    // `failed` fires before the terminal `finished` on error paths —
    // exactly-once delivery via the shared Option::take.
    let done = Arc::new(Mutex::new(Some(on_done)));
    let done_failed = Arc::clone(&done);
    op.connect_failed(move |_op, _err| {
        // _err (GError) deliberately unread — DENY-list discipline.
        if let Some(f) = done_failed.lock().unwrap_or_else(|e| e.into_inner()).take() {
            f(Err(CaptureFailureKind::NativePrintFailed));
        }
    });
    let done_finished = Arc::clone(&done);
    op.connect_finished(move |_op| {
        if let Some(f) = done_finished
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            f(Ok(()));
        }
    });

    // Silent print with the staged settings (no dialog). Completion
    // arrives on the GTK main loop via the signals above; the
    // orchestrator's deadline covers a swallowed signal.
    op.print();
}

// ---- Windows — ICoreWebView2_7::PrintToPdf (async, COM callback) -------
//
// BEST-EFFORT ARM: written against the webview2-com 0.38 / windows
// 0.61 API docs; this repo has no Windows build or test lane (CI is
// Linux, dev is macOS), so this arm is doc-correct but UNVERIFIED. If
// it proves unviable the ratified fallback is `window.print()` on
// Windows (PRD Implementation Decisions).

#[cfg(windows)]
pub(super) fn start_print_to_pdf(
    webview: &tauri::webview::PlatformWebview,
    dest: &Path,
    on_done: impl FnOnce(Result<(), CaptureFailureKind>) + Send + 'static,
) {
    use std::os::windows::ffi::OsStrExt;
    use std::sync::{Arc, Mutex};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PrintSettings, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::Interface;

    let on_done: OnDone = Box::new(on_done);

    let core = match unsafe { webview.controller().CoreWebView2() } {
        Ok(core) => core,
        Err(_) => {
            on_done(Err(CaptureFailureKind::Dispatch));
            return;
        }
    };
    // PrintToPdf arrived with ICoreWebView2_7 (WebView2 runtime
    // 1.0.992.28+); an older runtime fails the cast.
    let core7: ICoreWebView2_7 = match core.cast() {
        Ok(c) => c,
        Err(_) => {
            on_done(Err(CaptureFailureKind::Unsupported));
            return;
        }
    };

    let wide: Vec<u16> = dest
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // Exactly-once delivery shared between the COM completion handler
    // and the synchronous-failure path below.
    let done = Arc::new(Mutex::new(Some(on_done)));
    let done_handler = Arc::clone(&done);
    let handler = PrintToPdfCompletedHandler::create(Box::new(move |error_code, is_successful| {
        let ok = error_code.is_ok() && is_successful.as_bool();
        if let Some(f) = done_handler
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            f(if ok {
                Ok(())
            } else {
                Err(CaptureFailureKind::NativePrintFailed)
            });
        }
        Ok(())
    }));

    // SAFETY: COM call on the WebView2 UI thread (the `with_webview`
    // closure); `wide` outlives the call (PrintToPdf copies the path
    // synchronously per COM convention). `None` print settings =
    // engine defaults; print CSS owns geometry (task 3).
    let launched = unsafe {
        core7.PrintToPdf(
            windows::core::PCWSTR(wide.as_ptr()),
            None::<&ICoreWebView2PrintSettings>,
            &handler,
        )
    };
    if launched.is_err() {
        if let Some(f) = done.lock().unwrap_or_else(|e| e.into_inner()).take() {
            f(Err(CaptureFailureKind::NativePrintFailed));
        }
    }
}

// ---- Non-desktop fallback ------------------------------------------------

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub(super) fn start_print_to_pdf(
    _webview: &tauri::webview::PlatformWebview,
    _dest: &Path,
    on_done: impl FnOnce(Result<(), CaptureFailureKind>) + Send + 'static,
) {
    on_done(Err(CaptureFailureKind::Unsupported));
}
