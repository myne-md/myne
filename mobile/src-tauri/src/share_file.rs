// SPDX-License-Identifier: AGPL-3.0
//! Native "share / save this file" bridge (mobile). The mobile WebView has no
//! Save-As dialog, so every export/download flow historically wrote silently to
//! the app's Documents directory with no way for the user to pick a destination
//! (MYND-475). The Rust write still happens (the file always lands in Documents,
//! so this is purely ADDITIVE and never a regression), and afterwards the
//! frontend emits [`SHARE_FILE_EVENT`] with the written path; the setup hook
//! (`lib.rs`) listens and presents the platform "ask where to save" UI on the
//! main thread.
//!
//! **That Documents copy is not reachable on either platform**, and this header
//! used to say it was ("reachable via the Files app"). iOS declares no
//! `UIFileSharingEnabled`, so the directory is invisible in the Files app there;
//! Android exposes it to no file manager since Android 11 (API 30) closed
//! `Android/data`, while `minSdk` here is 24. The sheet below is therefore the
//! user's only route to an export on both platforms, which it was not before
//! myne-md/myne#505, when Android's arm was a documented no-op and the write WAS
//! the delivery. The directory is excluded from platform cloud backup on both
//! (myne-md/myne#491, `backup_exclude`).
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
//! A Storage-Access-Framework `ACTION_CREATE_DOCUMENT` picker, reached through
//! `tauri-plugin-save-file`'s committed Kotlin (myne-md/myne#505): the user picks
//! the destination and the bytes are written there. This is the platform's own
//! "where do you want this?" dialog, the Android analogue of "Save to Files", and
//! it is the only route the user has to the file. See the header.
//!
//! The picker saves ONE document, so an export that is a directory (the
//! whole-vault markdown tree) is zipped into the app cache first, handed over,
//! and the temporary archive is deleted. [`destination_hint`] decides which shape
//! applies, in one place, and it is the only part of this arm a test can reach
//! without an Android target.
//!
//! **How the Android arms are verified, because it is not by default.** CI's
//! `mobile-compile` step builds the Linux host only, so `#[cfg(target_os =
//! "android")]` is not compiled there. The check that does compile it needs the
//! SDK and the NDK and is run by hand:
//! `cargo clippy -p myne-mobile --target aarch64-linux-android --all-targets --
//! -D warnings`. Run it for any change inside this module or the Kotlin it
//! drives; a green CI run says nothing about either.
//!
//! The call must NOT run on the main thread. The command reaches the activity
//! through the Android main pipe and the answer comes back on that same loop, so
//! awaiting it there deadlocks (the `screen_guard` / `share-intent` note).
//! [`present`] therefore hands the work to a background task rather than wrapping
//! it in `run_on_main_thread` the way the iOS half is wrapped.
//!
//! A dismissed picker is not a failure and deletes nothing: the app's own copy is
//! the fallback for the recovery-phrase file, which is never re-displayable
//! (`recovery-flow.md` §2.4).
//!
//! ## Verification status
//!
//! The iOS body compiles against `aarch64-apple-ios-sim` but, like
//! `pdf_export.rs`, is device-verified via `docs/dev/device-matrix.md`, not in
//! this change. It follows the `ios_chrome.rs` / `pdf_export.rs` raw-`msg_send!`
//! idiom and is defensively null-guarded — every failed lookup early-returns to a
//! no-op, never a panic. The Android half is the same bar, one step further from
//! verifiable: its Kotlin compiles against the generated gradle project, and what
//! the picker actually DOES on a handset is row 8.8's, not this file's.

/// Frontend → host event carrying a written file to offer for saving/sharing.
/// Payload: [`SharePayload`].
pub const SHARE_FILE_EVENT: &str = "share-file";

/// The already-written file (or export folder) to present in the share sheet.
#[derive(serde::Deserialize)]
pub struct SharePayload {
    /// Absolute filesystem path of the file the backend just wrote.
    pub path: String,
}

/// Present the platform save/share UI for the export at `path`.
///
/// Platform-dispatched because the two halves have OPPOSITE threading contracts and
/// the caller should not have to know: iOS must be presented from the main thread,
/// Android's round trip must never start there (see the module docs).
///
/// **The path must be an export, and this is where that stops being an
/// assumption.** It arrives from the WebView in an event payload, and before
/// this change only iOS could act on it. `threat-model.md` TB3's exception names
/// exports, while `<app_config_dir>/person-auth.json` (the person token, which
/// authorizes every vault the account is bound to) and the vault's own
/// `vault.meta` sit one relative path away. A chooser handed either of those
/// would copy it to wherever the user points, while they believe they are saving
/// a note. So a path outside [`is_export_path`] is refused and logged, and the
/// refusal names no path.
pub fn present<R: tauri::Runtime>(app: &tauri::AppHandle<R>, path: String) {
    let Ok(export_dir) = crate::backup_exclude::ensure_export_dir(app) else {
        tracing::warn!(
            event = "share_file_no_export_dir",
            "the export directory could not be resolved; nothing was offered"
        );
        return;
    };
    if !is_export_path(&export_dir, std::path::Path::new(&path)) {
        tracing::warn!(
            event = "share_file_refused",
            "the offered path is not inside the export directory; nothing was offered"
        );
        return;
    }
    #[cfg(target_os = "ios")]
    {
        let _ = app.run_on_main_thread(move || present_on_main_thread(&path));
    }
    #[cfg(target_os = "android")]
    {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { android::save(app, path).await });
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (app, path);
    }
}

/// True when `path` is a DIRECT child of the export directory, after resolving
/// symlinks on both.
///
/// Direct child rather than "anywhere below" because that is the shape every
/// export has: `plugin:export-dir|export_path` refuses a name with a separator,
/// and the whole-vault markdown export is one such child directory. Resolving
/// both sides is what makes `..` and a symlink out of the directory useless;
/// either side failing to resolve is a refusal, not a pass.
fn is_export_path(dir: &std::path::Path, path: &std::path::Path) -> bool {
    let (Ok(dir), Ok(path)) = (dir.canonicalize(), path.canonicalize()) else {
        return false;
    };
    path.parent() == Some(dir.as_path())
}

/// Present the iOS activity sheet for the file at `path`. Must run on the
/// UI/main thread — the caller dispatches via `run_on_main_thread`.
///
/// iOS-only on purpose: it is the half `pdf_export` reuses after rendering, and
/// there is no non-iOS caller to give a no-op stub to.
#[cfg(target_os = "ios")]
pub fn present_on_main_thread(path: &str) {
    // SAFETY: main thread (see module docs); every ObjC lookup is null-guarded.
    unsafe { ios::present(path) }
}

/// What the Android picker needs to know about an export: its MIME type, a
/// suggested file name, and whether the Kotlin side must zip it first.
///
/// All three are decided HERE, in one place, because a directory is the
/// whole-vault markdown tree and a document picker saves one file. The `zips`
/// flag crosses the bridge rather than being re-derived in Kotlin from
/// `File(path).isDirectory`: two copies of that question can disagree, and the
/// disagreement is a document whose name and type promise one shape while its
/// bytes are the other.
///
/// Gated on `test` as well as `target_os = "android"` because the only non-test
/// caller is the Android picker: a host lib build has no caller, and `dead_code`
/// is an error under `clippy -D warnings`.
#[cfg(any(target_os = "android", test))]
fn destination_hint(path: &std::path::Path) -> (String, String, bool) {
    const MIME_ZIP: &str = "application/zip";
    const MIME_FALLBACK: &str = "application/octet-stream";

    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("myne-export")
        .to_string();
    if path.is_dir() {
        return (MIME_ZIP.to_string(), format!("{name}.zip"), true);
    }
    let mime = match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("txt") => "text/plain",
        Some("md") => "text/markdown",
        Some("pdf") => "application/pdf",
        Some("zip") => MIME_ZIP,
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        _ => MIME_FALLBACK,
    };
    (mime.to_string(), name, false)
}

/// Android: the Storage Access Framework picker, through the committed Kotlin in
/// `tauri-plugin-save-file`.
#[cfg(target_os = "android")]
mod android {
    use tauri::Manager;

    pub async fn save<R: tauri::Runtime>(app: tauri::AppHandle<R>, path: String) {
        let Some(bridge) = app
            .try_state::<tauri_plugin_save_file::SaveFile<R>>()
            .map(|s| s.inner().clone())
        else {
            // Registration happens in `setup` before any export can run, so this
            // is a wiring fault rather than a user-facing state.
            tracing::warn!(
                event = "share_file_unavailable",
                platform = "android",
                "save-file plugin is not registered; the export stays in Documents"
            );
            return;
        };
        let (mime, name, zips) = super::destination_hint(std::path::Path::new(&path));
        // Neither branch logs the path or the filename: this is a diagnostic line,
        // and an export name can be a note title.
        match bridge.save(path, mime, name, zips).await {
            Ok(outcome) if outcome.saved => {
                tracing::info!(
                    event = "share_file_saved",
                    "export written to the chosen document"
                )
            }
            Ok(outcome) if outcome.cancelled => tracing::info!(
                event = "share_file_cancelled",
                "picker dismissed; the app's own copy is unchanged"
            ),
            Ok(outcome) => tracing::warn!(
                event = "share_file_failed",
                reason = outcome.error.as_deref().unwrap_or("unspecified"),
                "the export could not be written to the chosen document"
            ),
            Err(_) => tracing::warn!(
                event = "share_file_failed",
                reason = "plugin-invoke",
                "the save picker could not be reached"
            ),
        }
    }
}

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
        let avc: *mut AnyObject = msg_send![avc_alloc, initWithActivityItems: items, applicationActivities: null_activities];
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

#[cfg(test)]
mod tests {
    use super::{destination_hint, is_export_path};
    use std::path::Path;

    /// The whole-vault markdown export is the one flow whose artefact is a
    /// DIRECTORY, and `ACTION_CREATE_DOCUMENT` saves exactly one document. The
    /// `zips` flag asserted here is what the Kotlin side obeys, so a wrong answer
    /// is a document whose suggested name and MIME type say `.zip` while its bytes
    /// are a bare file, or the reverse.
    #[test]
    fn an_export_directory_becomes_one_zip_document() {
        let dir = std::env::temp_dir().join(format!("myne-export-hint-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        let (mime, name, zips) = destination_hint(&dir);
        assert_eq!(mime, "application/zip");
        assert!(zips, "the Kotlin side zips only when this flag says so");
        assert_eq!(
            name,
            format!("{}.zip", dir.file_name().unwrap().to_str().unwrap())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_file_keeps_its_own_name_and_gets_a_mime_the_picker_understands() {
        assert_eq!(
            destination_hint(Path::new("/tmp/Myne Recovery Kit.txt")),
            (
                "text/plain".to_string(),
                "Myne Recovery Kit.txt".to_string(),
                false
            )
        );
        assert_eq!(
            destination_hint(Path::new("/tmp/note.PDF")).0,
            "application/pdf"
        );
        // An exported attachment can be any type at all (the library accepts
        // arbitrary files); the picker still saves it, it just cannot pre-select
        // an app for it.
        assert_eq!(
            destination_hint(Path::new("/tmp/contract.docx")).0,
            "application/octet-stream"
        );
    }

    /// `present` refuses to hand the chooser anything but an export. The path
    /// arrives from the WebView, and `person-auth.json` (the person token, which
    /// authorizes every vault the account is bound to) sits one relative path away
    /// from an export directory in the same app container.
    #[test]
    fn only_a_direct_child_of_the_export_directory_is_offered() {
        let root = std::env::temp_dir().join(format!("myne-export-root-{}", std::process::id()));
        let dir = root.join("Documents");
        std::fs::create_dir_all(dir.join("Myne Export 2026-11-07")).unwrap();
        std::fs::write(dir.join("myne-recovery-phrase.txt"), "w1").unwrap();
        std::fs::write(root.join("person-auth.json"), "{}").unwrap();

        assert!(is_export_path(&dir, &dir.join("myne-recovery-phrase.txt")));
        assert!(is_export_path(&dir, &dir.join("Myne Export 2026-11-07")));
        // Outside the directory, below it, and absent are all refused.
        assert!(!is_export_path(&dir, &root.join("person-auth.json")));
        assert!(!is_export_path(
            &dir,
            &dir.join("Myne Export 2026-11-07").join("nested-note.md")
        ));
        assert!(!is_export_path(&dir, &dir.join("missing.txt")));

        std::fs::remove_dir_all(&root).ok();
    }
}
