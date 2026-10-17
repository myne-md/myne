// SPDX-License-Identifier: AGPL-3.0
//! Meeting-session menubar indicator (myne-md/myne#789).
//!
//! During a meeting the user is in another application for the whole session,
//! so the in-app recording bar is not where the running state needs to live.
//! This is the one surface that is visible while Myne is not focused, and it
//! carries the session's elapsed time and a way to stop it.
//!
//! **No capability grant, and that is the security-relevant half.** The tray is
//! built and driven entirely here, in Rust, and a Tauri capability gates IPC
//! that the WEBVIEW may invoke. `TrayIconBuilder` and `remove_tray_by_id` are
//! host-side calls that consult no ACL, so this module needs no grant and
//! adding one would be a pure widening: `core:tray:default` resolves to all
//! twelve `core:tray` commands, including `new` and `set_menu`, which is the
//! same page-context-installs-its-own-chrome surface myne#384 refused when it
//! dropped the sub-default. An earlier revision of this module added the grant
//! and described it as "narrow"; it was not, and the review caught it.
//!
//! The only page-side surface here is the `meeting:tray-stop` EVENT, which
//! rides the already-granted `core:event` namespace.

use std::time::Duration;

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Runtime};

/// The tray's id, so `tray_by_id` finds the one this module owns rather than
/// assuming there is only ever one.
pub const TRAY_ID: &str = "meeting-session";

/// Emitted when the user clicks the indicator. The frontend owns the stop
/// because the session's note write is a frontend operation: a host-side stop
/// would leave the transcript unwritten.
pub const TRAY_STOP_EVENT: &str = "meeting:tray-stop";

/// Show the indicator. Idempotent, and it also RE-SHOWS an indicator a previous
/// session hid (the tray outlives the session, see [`hide`]): a second start on
/// a long-lived process must not be left with an invisible indicator because the
/// first session took it down.
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        // Already built by an earlier session. Make it visible again rather than
        // building a second one, which cannot stack anyway (same id).
        let _ = tray.set_visible(true);
        return;
    }
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Meeting session running")
        .on_tray_icon_event(|tray, event| {
            // Left click on RELEASE, not press: a press handler fires on the
            // way down and a drag off the icon would still stop the session.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = tray.app_handle().emit(TRAY_STOP_EVENT, ());
            }
        });
    // The app icon rather than a dedicated asset: a session indicator is not
    // worth a second icon pipeline, and a missing icon would leave an invisible
    // tray entry that looks like a broken session.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    if builder.build(app).is_err() {
        // A platform that refuses a tray (a headless session, a Linux desktop
        // with no status-notifier host) must not fail the meeting: the bar is
        // still there, and losing the indicator is a smaller loss than losing
        // the recording.
        tracing::warn!(stage = "meeting_tray", "tray creation failed");
    }
}

/// Update the tooltip with the session's elapsed time. Called from the level
/// sink, which is already quantized, so this does not add a timer.
pub fn set_elapsed<R: Runtime>(app: &AppHandle<R>, elapsed: Duration) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("Meeting session · {}", clock(elapsed))));
    }
}

/// Hide the indicator. Idempotent, and a no-op when none was ever created, so
/// the stop and cancel paths can both call it unconditionally.
///
/// **Hide, never remove, and the difference is not cosmetic.**
/// `remove_tray_by_id` terminates the application on macOS in Tauri 2.12.1: with
/// the meeting tray as the process's only `TrayIcon`, taking it down tears down
/// the NSStatusItem that the window/run-loop lifecycle is holding, the
/// `RunEvent::ExitRequested` handler runs, and the process exits with
/// `SIGTERM`-equivalent status 143. Both `meeting_session_stop` and
/// `meeting_session_cancel` call this on their first line, so BOTH the Stop
/// button and the menubar click closed the app instead of ending the session.
/// Verified by isolation rather than inferred: with `remove_tray_by_id` short
/// circuited, Stop and Cancel both behave and the app stays up; no panic, no
/// WebKit crash report and no macOS crash report is produced either way, because
/// nothing crashes — the run loop simply ends.
///
/// `set_visible(false)` reaches the same user-visible state (no icon) without
/// touching that lifetime, so the indicator costs one hidden NSStatusItem per
/// process rather than a session-ending bug. The tooltip update in
/// [`set_elapsed`] stays correct for the same reason: it finds the tray by id
/// whether or not it is visible.
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(false);
    }
}

/// `M:SS` past an hour, `H:MM:SS` beyond it, matching the recording bar's own
/// clock so the two do not disagree about what a session has been running for.
fn clock(elapsed: Duration) -> String {
    let total = elapsed.as_secs();
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::clock;
    use std::time::Duration;

    #[test]
    fn the_clock_matches_the_recording_bars_shape() {
        assert_eq!(clock(Duration::from_secs(0)), "0:00");
        assert_eq!(clock(Duration::from_secs(9)), "0:09");
        assert_eq!(clock(Duration::from_secs(59)), "0:59");
        assert_eq!(clock(Duration::from_secs(60)), "1:00");
        assert_eq!(clock(Duration::from_secs(599)), "9:59");
        assert_eq!(clock(Duration::from_secs(3600)), "1:00:00");
        assert_eq!(clock(Duration::from_secs(3661)), "1:01:01");
    }
}
