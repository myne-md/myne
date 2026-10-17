// SPDX-License-Identifier: AGPL-3.0
//! Voice notes — native mic capture submodule of `attachments` (MYND-259).
//!
//! Voice notes are ordinary attachments: a recording is captured natively (no
//! WebView MediaRecorder), encoded to WAV (`encoder`), and stored through the
//! existing `attachment_import` core as an `audio/wav` `MYA1` blob — no new
//! on-disk format. The capture pipeline is a chain of swappable stages
//! (`capture::AudioSource` → `encoder::Encoder` → import) so the record flow is
//! testable with a fixture source on a headless runner.
//!
//! The three IPC commands (`voice_record_start`/`stop`/`cancel`) are registered
//! by the parent `attachments` plugin and gated under `attachments:default`.

pub mod capture;
pub mod commands;
pub mod encoder;
pub mod error;
pub mod mix;
pub mod silence;
pub mod state;
/// The macOS system-audio capture source. Declared only on macOS because every
/// symbol in it is a CoreAudio or CoreFoundation one; other platforms answer
/// "no tap" through `capture.rs::meeting_tap_source` instead of carrying a
/// module that cannot compile.
#[cfg(target_os = "macos")]
pub mod tap;

pub use state::VoiceRecordState;

use tauri::{AppHandle, Manager, Runtime};

/// Best-effort abort of any in-progress recording on lock / auto-lock /
/// vault-delete teardown — the twin of [`super::zeroize_attachment_refs`].
/// Sync + infallible: if a recording is active it is canceled (the capture
/// thread releases the mic + wipes its `Zeroizing` buffer) WITHOUT blocking the
/// teardown path. A missing managed state, a momentarily-held lock, or no
/// active recording is a silent no-op — the next unlock starts fresh. Wired
/// into every slot-drop site so the mic never outlives the unlocked session.
pub fn abort_active_recording<R: Runtime>(app: &AppHandle<R>) {
    let Some(voice) = app.try_state::<VoiceRecordState>() else {
        return;
    };
    if let Ok(mut guard) = voice.active.try_lock() {
        if let Some(session) = guard.take() {
            session.abort();
        }
        return;
    }
    // Same race as `abort_active_session`: the slot can be held by a start that
    // has claimed it but not yet published the session, and `try_lock` failing
    // must not mean the mic survives the lock. Retry on the async runtime so the
    // teardown path stays non-blocking.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(voice) = app.try_state::<VoiceRecordState>() else {
            return;
        };
        // Bind the guard's result before matching so the temporary
        // `MutexGuard` drops at the end of this `let`, not after `voice`.
        let taken = voice.active.lock().await.take();
        if let Some(session) = taken {
            session.abort();
        }
    });
}
