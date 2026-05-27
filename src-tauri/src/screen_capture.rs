//! Screen-capture protection setup at app startup.
//!
//! Calls `WebviewWindow::set_content_protected(true)` before the window
//! becomes visible, then shows the window. Two failure modes with
//! different policies:
//!
//! - `set_content_protected` `Err`: best-effort defense-in-depth per
//!   `threat-model.md` §1 A7 + §6 → warn-and-continue (closed-enum kind
//!   tag).
//! - `window.show` `Err`: structural (window unusable) → propagate.
//!
//! Platform support per tao 0.34.x (Tauri's underlying window crate):
//! macOS + Windows = real call (`NSWindowSharingNone` / `WDA_EXCLUDEFROMCAPTURE`
//! on Windows 10 build 19041+; older Windows silently no-ops because the
//! tao Windows arm discards the `SetWindowDisplayAffinity` return BOOL).
//! iOS / Android / Linux = compile-time no-op (`#[cfg(any(macos, windows))]`
//! gate in tao). The Linux warn must be `#[cfg(target_os = "linux")]`-gated
//! explicitly because Tauri returns `Ok(())` on Linux regardless.
//!
//! Capability ACL: no IPC command exposed in v0.1 (per MYND-55 + MYND-78
//! scope-reduce; user-controlled toggle deferred to MYND-160). No entry
//! in `src-tauri/capabilities/default.json` is required.
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
/// structurally guarantees the first frame is protected on macOS and
/// Windows 10 build 19041+.
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

    match window.set_content_protected(true) {
        Ok(()) => {
            #[cfg(target_os = "linux")]
            tracing::warn!(
                event = "screen_capture_protection_unsupported",
                platform = "linux",
                "Screen-capture protection unavailable on Linux v0.1 (no portable API)"
            );
            #[cfg(not(target_os = "linux"))]
            tracing::info!(
                event = "screen_capture_protection_applied",
                platform = std::env::consts::OS,
            );
        }
        Err(e) => tracing::warn!(
            event = "screen_capture_protection_failed",
            platform = std::env::consts::OS,
            error_kind = screen_capture_protection_error_kind(&e),
        ),
    }

    // Both `set_content_protected` and `show()` dispatch via Tauri's
    // event loop (winit/tao backend). FIFO ordering means the protect
    // message processes before the show message — the first paint is
    // protected on macOS + Windows ≥ build 19041. A reordering here
    // would be a Tauri runtime bug, not a current risk.
    window.show()?;
    Ok(())
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
}
