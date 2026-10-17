// SPDX-License-Identifier: AGPL-3.0
//! Meeting-session Tauri commands (myne-md/myne#789):
//! `meeting_session_start` / `meeting_session_stop` / `meeting_session_cancel`.
//!
//! A meeting session is a capture session whose output is a NOTE rather than a
//! single voice note. It reuses the voice-note pipeline end to end: the same
//! `run_session` capture loop, the same per-clip `attachment_import`, the same
//! seamless continuation at the 64 MiB cap. What is new is only the source
//! (`SourceFactory::Meeting`, the microphone mixed with the system-audio tap
//! where the platform has one), the per-source silence warning, and a consumer
//! that COLLECTS clips in capture order so the frontend can write them into a
//! note.
//!
//! **Transcription is deliberately not here.** The existing `transcribe`
//! command is attachment-keyed and already reachable from the frontend, so the
//! session emits each clip as it lands and the frontend transcribes it. That
//! keeps the engine surface, the `Engine` trait and the `MYE1` cache untouched,
//! which is what the feature's PRD promises.
//!
//! All three commands are `Slot::Unlocked`-gated and main-window-scoped under
//! the attachments capability. Audio is encrypted in Rust through the existing
//! `attachment_import` core; raw PCM never crosses IPC.

use std::sync::atomic::{AtomicI16, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use zeroize::Zeroizing;

use super::state::{MeetingSession, MeetingSessionState};
use crate::plugins::attachments::commands::ImportedAttachment;
use crate::plugins::attachments::voice::capture::SourceFactory;
use crate::plugins::attachments::voice::commands::encode_and_import_clip;
use crate::plugins::attachments::voice::error::VoiceRecordError;
use crate::plugins::attachments::voice::silence::{SilenceWatch, DEFAULT_TAP_SILENCE_WINDOW};
use crate::plugins::attachments::voice::state::{Clip, VoiceRecordState};
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};

/// Live input level of the MIX, for the session bar's meter.
pub const MEETING_LEVEL_EVENT: &str = "meeting:level";
/// A finished clip's [`ImportedAttachment`], emitted in capture order so the
/// frontend can transcribe it as the meeting runs.
pub const MEETING_CLIP_EVENT: &str = "meeting:clip";
/// A clip that failed to import, so the UI can flag the gap rather than the
/// clip vanishing silently.
pub const MEETING_CLIP_FAILED_EVENT: &str = "meeting:clip-failed";
/// The system-audio side has been silent while the microphone side is live.
/// Fires at most once per run of silence.
pub const MEETING_TAP_SILENCE_EVENT: &str = "meeting:tap-silence";
/// Whether this session armed a system-audio source, emitted once at start.
/// The bar's platform notice must render only where it is TRUE: passing it
/// unconditionally told every macOS 14.2+ user that the other participants
/// would not be in the note while they were being captured, which is a false
/// statement about a recording of other people's speech.
pub const MEETING_SOURCE_EVENT: &str = "meeting:source";

/// What `meeting_session_stop` returns: every clip of the session in capture
/// order. The transcript is not here because the frontend already has it, from
/// transcribing each clip as it arrived.
#[derive(Debug, serde::Serialize)]
pub struct MeetingSessionResult {
    pub clips: Vec<ImportedAttachment>,
}

/// The capture source for a meeting: the microphone mixed with the
/// system-audio tap where this platform can supply one. The same compile-time
/// choice the voice flow makes, for the same reason: a runtime switch that
/// could replace a real device with a synthetic one is not a thing to ship.
/// The meeting source, unconditionally. `SourceFactory::Meeting` is what
/// resolves the stub-vs-real distinction, in `SourceFactory::build`; an earlier
/// version carried two identical cfg arms here, which read as a switch meant to
/// differ and did not.
const MEETING_SOURCE: SourceFactory = SourceFactory::Meeting;

/// Start a meeting session. Unlock-gated; refuses if a session or a voice
/// recording is already running. Streams the mixed level and the per-source
/// silence warning to the WebView, and spawns the collecting clip consumer.
#[tauri::command]
pub async fn meeting_session_start<R: Runtime>(
    app: AppHandle<R>,
    vault: State<'_, VaultRuntimeState>,
    meeting: State<'_, MeetingSessionState>,
    voice: State<'_, VoiceRecordState>,
) -> Result<(), VoiceRecordError> {
    if !matches!(vault.slot_kind_active().await, SlotKind::Unlocked) {
        return Err(VoiceRecordError::Locked);
    }
    // One capture at a time per process: two sessions would fight over the
    // microphone and, on macOS, over the tap's aggregate device.
    if voice.active.lock().await.is_some() {
        return Err(VoiceRecordError::AlreadyRecording);
    }
    let mut active = meeting.active.lock().await;
    if active.is_some() {
        return Err(VoiceRecordError::AlreadyRecording);
    }
    // Re-check the slot UNDER this lock. A `vault_lock` landing between the
    // check above and here would have its `abort_active_session` dropped by that
    // hook's `try_lock` (this start holds the mutex), so the session would be
    // published into a locked vault and capture would run behind it. This narrows
    // the window; the async retry in `abort_active_session` closes it.
    if !matches!(vault.slot_kind_active().await, SlotKind::Unlocked) {
        return Err(VoiceRecordError::Locked);
    }

    // The meter is quantized the same way the voice flow quantizes it: the
    // poll runs at ~100 Hz and the meter has a handful of discrete states, so
    // an unquantized emit would be mostly identical floats.
    let level_emitter = app.clone();
    let last_q = Arc::new(AtomicI16::new(-1));
    // The silence watch lives with the level sink because that is where the
    // per-source peaks arrive. It is a `std` mutex rather than a tokio one
    // because this closure runs on the capture thread, which has no async
    // context and must not block on one.
    let watch = Arc::new(StdMutex::new(SilenceWatch::new(DEFAULT_TAP_SILENCE_WINDOW)));
    let silence_emitter = app.clone();
    // The menubar indicator's clock. A `Duration` rather than an `Instant` so
    // the closure stays `Send` without carrying a start time across threads.
    let started = Instant::now();
    let tray_emitter = app.clone();
    let last_second = Arc::new(AtomicI16::new(-1));
    let level_sink: Box<dyn Fn(f32, Option<f32>) + Send> = Box::new(move |level, tap| {
        let q = (level.clamp(0.0, 1.0) * 64.0).round() as i16;
        if last_q.swap(q, Ordering::Relaxed) != q {
            let _ = level_emitter.emit(MEETING_LEVEL_EVENT, level);
        }
        // The tooltip tracks whole seconds, so it is updated once per second
        // rather than at the meter's rate.
        let secs = started.elapsed().as_secs().min(i16::MAX as u64) as i16;
        if last_second.swap(secs, Ordering::Relaxed) != secs {
            crate::tray::set_elapsed(&tray_emitter, started.elapsed());
        }
        if let Ok(mut w) = watch.lock() {
            if w.observe(Instant::now(), level, tap) {
                let _ = silence_emitter.emit(MEETING_TAP_SILENCE_EVENT, ());
            }
        }
    });

    let (clip_tx, clip_rx) = unbounded_channel::<Clip>();
    let clip_sink: Box<dyn Fn(Zeroizing<Vec<i16>>, u32) + Send> = Box::new(move |samples, rate| {
        let _ = clip_tx.send((samples, rate));
    });
    let consumer = tokio::spawn(consume_meeting_clips(app.clone(), clip_rx));

    *active = Some(MeetingSession::spawn(
        MEETING_SOURCE,
        level_sink,
        clip_sink,
        consumer,
    ));
    // The indicator goes up only once the session is actually running, so a
    // start that fails leaves nothing behind.
    crate::tray::show(&app);
    // Tell the UI what this session actually armed. `meeting_tap_source()` is
    // the same seam the mix is built from, so the answer cannot disagree with
    // what is being captured.
    let has_tap = crate::plugins::attachments::voice::capture::meeting_tap_available();
    let _ = app.emit(MEETING_SOURCE_EVENT, has_tap);
    tracing::debug!(stage = "meeting_session", event = "started");
    Ok(())
}

/// Finalize the active session. Awaits every continuation clip's import, then
/// imports the final (sub-cap) clip and returns the whole session's clips in
/// capture order.
#[tauri::command]
pub async fn meeting_session_stop<R: Runtime>(
    app: AppHandle<R>,
    meeting: State<'_, MeetingSessionState>,
) -> Result<MeetingSessionResult, VoiceRecordError> {
    let session = meeting
        .active
        .lock()
        .await
        .take()
        .ok_or(VoiceRecordError::NotRecording)?;
    crate::tray::hide(&app);

    // Finalize off the async runtime: this joins the capture thread.
    let (captured_res, consumer) = tokio::task::spawn_blocking(move || session.finalize_capture())
        .await
        .map_err(|_| VoiceRecordError::Internal)?;
    let captured = captured_res?;
    let mut clips = consumer.await.map_err(|_| VoiceRecordError::Internal)?;

    // The final clip is placed LAST, after every continuation clip, which is
    // the order the embeds must appear in the note.
    if !captured.samples.is_empty() {
        let imported = encode_and_import_clip(
            &app,
            captured.samples,
            captured.sample_rate,
            "Meeting.wav".to_string(),
        )
        .await?;
        // Emitted like every continuation clip, and this is load-bearing rather
        // than tidy: the frontend's only route into transcription is this
        // event, so a final clip that went unemitted meant a session shorter
        // than the clip cap (the common case) wrote a note with no transcript
        // at all, and a longer one silently lost its last segment's.
        let _ = app.emit(MEETING_CLIP_EVENT, &imported);
        clips.push(imported);
    }

    if clips.is_empty() {
        // Nothing was captured at all. Distinct from a session whose clips
        // failed to import: those emitted a failure event each.
        return Err(VoiceRecordError::EmptyRecording);
    }

    tracing::debug!(
        stage = "meeting_session",
        event = "stored",
        clips = clips.len()
    );
    Ok(MeetingSessionResult { clips })
}

/// Discard the active session's in-flight tail (stores nothing more). Already-
/// committed clips remain, matching `voice_record_cancel`: continuation is a
/// checkpoint, so a cancelled meeting still has whatever was fully captured.
/// Idempotent.
#[tauri::command]
pub async fn meeting_session_cancel<R: Runtime>(
    app: AppHandle<R>,
    meeting: State<'_, MeetingSessionState>,
) -> Result<(), VoiceRecordError> {
    crate::tray::hide(&app);
    let session = meeting.active.lock().await.take();
    if let Some(session) = session {
        let consumer = tokio::task::spawn_blocking(move || session.cancel_capture())
            .await
            .map_err(|_| VoiceRecordError::Internal)?;
        // Let already-committed clips finish importing before returning, so a
        // cancel followed immediately by a stop cannot race.
        let _ = consumer.await;
        tracing::debug!(stage = "meeting_session", event = "canceled");
    }
    Ok(())
}

/// Import every clip the capture thread hands off, in order, emitting each as
/// it lands. Resolves with the whole list once the capture thread closes the
/// channel.
async fn consume_meeting_clips<R: Runtime>(
    app: AppHandle<R>,
    mut rx: UnboundedReceiver<Clip>,
) -> Vec<ImportedAttachment> {
    let mut clips = Vec::new();
    while let Some((samples, rate)) = rx.recv().await {
        match encode_and_import_clip(&app, samples, rate, "Meeting.wav".to_string()).await {
            Ok(imported) => {
                let _ = app.emit(MEETING_CLIP_EVENT, &imported);
                clips.push(imported);
            }
            Err(_) => {
                // Surface the gap rather than dropping it: a meeting whose clip
                // silently vanished is a note that looks complete and is not.
                tracing::warn!(stage = "meeting_session", "clip import failed");
                let _ = app.emit(MEETING_CLIP_FAILED_EVENT, ());
            }
        }
    }
    clips
}

/// Best-effort abort of any in-progress session on lock / auto-lock /
/// vault-switch / vault-delete teardown, the twin of
/// [`crate::plugins::attachments::voice::abort_active_recording`]. Sync and
/// infallible: the capture thread releases the microphone and destroys the tap
/// without blocking the teardown path.
pub fn abort_active_session<R: Runtime>(app: &AppHandle<R>) {
    // The indicator must not outlive the session it reports on, and a vault
    // lock is the path that most needs that: the session is aborted silently,
    // so a leftover tray entry would be the only sign anything was running.
    crate::tray::hide(app);
    let Some(meeting) = app.try_state::<MeetingSessionState>() else {
        return;
    };
    // Fast path: the slot is free, so there is nothing in flight.
    if let Ok(mut guard) = meeting.active.try_lock() {
        if let Some(session) = guard.take() {
            session.abort();
        }
        return;
    }
    // The slot is held right now by a start between claiming it and publishing
    // the session. Silently dropping the abort here is exactly the race that
    // left capture running behind a locked vault (`meeting_session_start`'s own
    // re-check narrows it; this closes it). Retry on the async runtime, so the
    // teardown path itself still never blocks: by the time the start releases
    // the lock, its session is published and `take()` finds it.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(meeting) = app.try_state::<MeetingSessionState>() else {
            return;
        };
        // Bind the guard's result before matching so the temporary
        // `MutexGuard` drops at the end of this `let`, not after `meeting`.
        let taken = meeting.active.lock().await.take();
        if let Some(session) = taken {
            session.abort();
        }
    });
}
