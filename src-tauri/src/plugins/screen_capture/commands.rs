// SPDX-License-Identifier: AGPL-3.0
//! The three `screen-capture` plugin commands (myne-md/myne#482, #483).
//!
//! Desktop-only, and reachable **pre-unlock**. Which is the whole point of two
//! of them. See `mod.rs` for why this plugin exists at all.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline". Nothing here
//! takes or returns anything but booleans, and the only error that crosses is
//! the closed `ScreenCaptureOverrideError` (an `IoFailureKind` tag or `Parse`,
//! never a path).

use myne_core::host::tauri_host::TauriHost;
use myne_core::screen_capture_override::{
    screen_capture_override_path_from_host, write_screen_capture_override, ScreenCaptureOverride,
    ScreenCaptureOverrideError,
};
use myne_core::vault_io::StdVaultIo;
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::screen_capture::ScreenCaptureState;

/// What the override is doing on this device, right now.
///
/// Three booleans rather than one, because the three answer different questions
/// and a single one would make the Settings row lie in a case that is easy to
/// reach. `disabled` is what the persisted file asks for and is what the control
/// reflects; `via_flag` is whether this *run* was launched with
/// `--disable-screen-capture-protection`; `effective` is what the window is
/// actually doing. On a flag-launched run the first is `false` and the last is
/// `true`, and a UI that only had `disabled` would show an off switch beside an
/// unprotected window.
///
/// `effective` is exactly `disabled || via_flag`, so it is the derivable one and
/// it is carried anyway. That OR is the rule this whole view exists to get
/// right, and two clients re-deriving it is how one of them comes to report
/// "protection is back on" over a window that is still capturable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ScreenCaptureOverrideView {
    /// The persisted override, as `screen-capture.json` has it.
    pub disabled: bool,
    /// Whether this run carries the process flag. Not persisted, not clearable.
    pub via_flag: bool,
    /// Whether protection is suppressed at all, from either source.
    pub effective: bool,
}

impl ScreenCaptureOverrideView {
    fn of(state: &ScreenCaptureState) -> Self {
        Self {
            disabled: state.file_disabled(),
            via_flag: state.via_flag(),
            effective: state.override_disabled(),
        }
    }
}

/// Read the device-local override. No vault access; reachable pre-unlock, which
/// is the only place it matters.
///
/// Answers from the managed state rather than re-reading the file, deliberately,
/// and for the reason `sync_get_tor_routing` gives about its own: the state is
/// what the window is obeying. A fresh disk read could disagree with it. The
/// file could have been edited under the running process. And reporting the
/// file would show the user a switch that does not describe their screen.
///
/// The `Result` is kept for signature symmetry with the setter and is never
/// `Err`: three atomic loads cannot fail. Said out loud rather than left for a
/// reader to notice, because an unreachable error arm is a contract the TS
/// mirror has to carry forever and no test can exercise.
#[tauri::command]
pub async fn screen_capture_override_get(
    state: State<'_, ScreenCaptureState>,
) -> Result<ScreenCaptureOverrideView, ScreenCaptureOverrideError> {
    Ok(ScreenCaptureOverrideView::of(state.inner()))
}

/// Persist the device-local override, then make the window match it.
///
/// **Disk first, then the native call**, the same ordering
/// `set_screen_capture_protection` established for the `vault.prefs` toggle: a
/// failed write leaves the machine and the machine's record of it agreeing. The
/// direction that ordering protects is the important one. A user who turned
/// protection off because they cannot see the window must not have it come back
/// at the next launch because the write silently failed.
///
/// Writing `disabled: false` on a flag-launched run is allowed and does what it
/// says: it records the intent for the next launch. It does **not** clear the
/// flag, and the returned view says so through `via_flag` + `effective`.
#[tauri::command]
pub async fn screen_capture_override_set<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ScreenCaptureState>,
    disabled: bool,
) -> Result<ScreenCaptureOverrideView, ScreenCaptureOverrideError> {
    let host = TauriHost::new(app.clone());
    let path = screen_capture_override_path_from_host(&host, &StdVaultIo).await?;
    write_screen_capture_override(&StdVaultIo, &path, ScreenCaptureOverride { disabled }).await?;

    state.set_file_disabled(disabled);
    tracing::info!(
        event = "screen_capture_override_written",
        disabled,
        via_flag = state.via_flag(),
    );

    // Re-assert rather than apply a fresh value: the state already knows what
    // the app last asked for, and the override is now folded into it.
    crate::screen_capture::reassert(&app, "runtime_apply");
    Ok(ScreenCaptureOverrideView::of(state.inner()))
}

/// Re-show the main window, protected, on behalf of the WebView.
///
/// The fourth re-show site of myne-md/myne#483. Idle auto-lock's teardown hides
/// the window natively and re-applies protection *while it is hidden*, which is
/// precisely the hide/show cycle the Windows affinity is reported not to survive
/// (tauri-apps/tauri#14189). `useRevealAfterIdleLock` is what asks for the
/// window back, so without a re-apply on this path the unlock screen, which
/// carries the account number, comes back unprotected for the rest of the
/// session.
///
/// **It performs the whole sequence rather than only the re-apply**, which is
/// the difference between an invariant and a convention. The first version left
/// the page holding `getCurrentWindow().show()` and called a separate
/// `screen_capture_reassert` after it: two independent calls whose ordering was
/// held by a comment, at the exact site that shape had already failed at three
/// times. Here `show_protected` owns both, so no caller can get the order wrong.
///
/// **This is an ACL trade, not a narrowing, and the earlier wording here said
/// narrowing.** `core:window:allow-show` was granted for that one call and is
/// now gone, so the page loses the one window mutator it had; `core:window:default`
/// is 28 read-only grants, so `unminimize` and `set_focus` were never among
/// them and this command adds both. It takes nothing and returns nothing, and
/// every value it applies is state the backend already holds, so what the page
/// gains it cannot aim: the strongest thing it can do is re-show a window in the
/// state it was already meant to be in, plus un-minimise it and take focus.
/// `threat-model.md` § 6 rates that pair.
#[tauri::command]
pub async fn screen_capture_show_protected<R: Runtime>(app: AppHandle<R>) {
    crate::screen_capture::show_protected(&app, "webview_reveal");
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::screen_capture_override::{
        read_screen_capture_override, SCREEN_CAPTURE_FILE_NAME,
    };
    use myne_core::test_support::{block_on, ScopedTempDir};

    /// The setter must re-assert, and nothing else could tell you.
    ///
    /// This is the one call that makes the escape work **in the session the
    /// user took it in**. Delete it and every observable the rest of the suite
    /// checks still reads correct: the disk says `disabled: true`, the getter
    /// answers `effective: true`, the dialog closes reporting success, and on
    /// Windows, the only platform where any of this matters, the window stays
    /// black until the user quits and relaunches.
    ///
    /// Asserted at the SOURCE rather than through a double, and the limit is
    /// stated rather than hidden: `reassert` reaches `resolve` and
    /// `get_webview_window`, both of which need a running Tauri app, so a
    /// behavioural test here would need a runtime this crate's unit suite does
    /// not stand up. The same shape as
    /// `screen_capture::tests::the_reshow_sequence_is_not_hand_rolled_anywhere_else`,
    /// and it catches the failure that actually happens, which is the line
    /// going away in a refactor rather than `reassert` itself misbehaving.
    #[test]
    fn the_setter_re_asserts_after_it_writes() {
        let src = include_str!("commands.rs");
        let body = src
            .split_once("pub async fn screen_capture_override_set")
            .expect("the setter must still be named that")
            .1;
        let body = body
            .split_once("\n}\n")
            .expect("the setter must have an end")
            .0;

        assert!(
            body.contains("screen_capture::reassert("),
            "screen_capture_override_set must re-assert after the write, or the \
             window keeps the pre-write state for the rest of the session"
        );
        // Ordering, not just presence: re-asserting BEFORE the state is updated
        // would replay the old value and leave the same black window.
        let write_at = body
            .find("state.set_file_disabled(")
            .expect("the setter must still update the state");
        let reassert_at = body
            .find("screen_capture::reassert(")
            .expect("checked above");
        assert!(
            write_at < reassert_at,
            "the state update must precede the re-assert, or the re-assert \
             replays the value the write just replaced"
        );
    }

    #[test]
    fn the_view_reports_the_file_and_the_flag_apart() {
        let from_file = ScreenCaptureState::new(true, false);
        assert_eq!(
            ScreenCaptureOverrideView::of(&from_file),
            ScreenCaptureOverrideView {
                disabled: true,
                via_flag: false,
                effective: true,
            }
        );

        // The case a single boolean would get wrong: nothing is persisted, and
        // the window is unprotected anyway.
        let from_flag = ScreenCaptureState::new(false, true);
        assert_eq!(
            ScreenCaptureOverrideView::of(&from_flag),
            ScreenCaptureOverrideView {
                disabled: false,
                via_flag: true,
                effective: true,
            }
        );
    }

    #[test]
    fn clearing_the_file_on_a_flag_launched_run_still_reports_unprotected() {
        let state = ScreenCaptureState::new(true, true);
        state.set_file_disabled(false);
        let view = ScreenCaptureOverrideView::of(&state);
        assert!(!view.disabled, "the file was cleared");
        assert!(view.effective, "and the window is still unprotected");
    }

    /// The write half of `screen_capture_override_set`, without a Tauri runtime.
    /// The command adds only the path resolution and the native call on top of
    /// this; what is worth pinning is that the bytes land where the startup
    /// resolution will look for them.
    #[test]
    fn what_the_setter_writes_is_what_the_startup_resolution_reads() {
        let dir = ScopedTempDir::new("screen-capture-override-cmd").expect("scratch");
        let path = dir.path().join(SCREEN_CAPTURE_FILE_NAME);

        block_on(write_screen_capture_override(
            &StdVaultIo,
            &path,
            ScreenCaptureOverride { disabled: true },
        ))
        .expect("write");

        let round_tripped = myne_core::screen_capture_override::protection_disabled_at_rest(
            block_on(read_screen_capture_override(&StdVaultIo, &path)),
        );
        assert!(round_tripped);
    }
}
