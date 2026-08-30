//! `screen_capture` Tauri plugin: the device-local escape hatch from
//! screen-capture protection (myne-md/myne#482) and the WebView half of the
//! re-assert-on-show fix (myne-md/myne#483).
//!
//! Three commands, all reachable **pre-unlock** and all deliberately so. The
//! surface they govern is the pre-unlock set itself. The unlock screen, the
//! vault picker, the account number, the 24-word recovery-phrase ceremony and
//! the device-join QR. Every one of which is protected before any vault is
//! open, and every one of which a user on remote-control software or a screen
//! magnifier sees as a black rectangle on Windows.
//!
//! The native side lives in `crate::screen_capture`; the persisted file and its
//! two fail directions live in `myne_core::screen_capture_override`. This module
//! is only the door.
//!
//! ## Why its own plugin
//!
//! Not `prefs`: every command there is slot-gated and describes a field of the
//! per-vault `vault.prefs` blob, which is the exact thing this override exists
//! because it cannot be. Not `vault-label`: right lifetime, wrong subject. A
//! `screen-capture:` namespace answers the question a reviewer actually brings
//! to the ACL (what may the WebView do about screen capture) where a fourth
//! `vault-label:allow-…` identifier would not.
//!
//! ## Capability ACL
//!
//! `screen-capture:default` bundles `allow-screen-capture-override-get`,
//! `allow-screen-capture-override-set` and `allow-screen-capture-show-protected`,
//! main-window-only. None touches vault content; the only values that cross in
//! either direction are booleans, and `screen_capture_show_protected` takes and
//! returns nothing at all. The bundle is a NET NARROWING of the WebView's
//! authority: `core:window:allow-show` was dropped from
//! `capabilities/default.json` in the same change, because its one consumer
//! (`src/hooks/useRevealAfterIdleLock.ts`) now asks the host for a fixed
//! protect/show/protect/focus sequence instead of driving the window itself.
//!
//! See: src-tauri/CLAUDE.md "Secret-handling logging discipline".

pub mod commands;

// The four-registration-site parity check. Test-only, in its own file so the
// extraction of `generate_handler!` below reads a file it is not itself in.
#[cfg(test)]
mod acl_parity;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `screen_capture` plugin.
///
/// Manages nothing: `ScreenCaptureState` is `app.manage`d in `Builder::setup`,
/// beside the other thirteen pieces of state that hook manages, and next to the
/// `screen_capture::init` call that reads it.
///
/// An earlier version of this comment claimed the placement was FORCED, "because
/// `screen_capture::init` reads it before the plugin store is consulted". That is
/// backwards on the pinned Tauri: `Builder::build` runs every plugin's `setup`
/// closure at the end of `build()`, while the app's own `Builder::setup` closure
/// runs later, at the top of `App::run`. So a plugin `setup` would land the state
/// EARLIER, and there is one state map rather than a separate plugin store. The
/// placement is a choice, not a constraint, and saying otherwise would tell the
/// next reader a four-line signature change is impossible.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("screen-capture")
        .invoke_handler(tauri::generate_handler![
            commands::screen_capture_override_get,
            commands::screen_capture_override_set,
            commands::screen_capture_show_protected,
        ])
        .build()
}
