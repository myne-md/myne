//! Voice-record Tauri commands (MYND-259): `voice_record_start` /
//! `voice_record_stop` / `voice_record_cancel`.
//!
//! All three are `Slot::Unlocked`-gated and main-window-scoped (the attachments
//! capability bundle). Audio is encrypted **in Rust** via the existing
//! `attachment_import` core — the raw PCM never crosses IPC into the WebView,
//! preserving the capture-side plaintext-residue protection that motivated
//! native (not MediaRecorder) capture.
//!
//! Seamless continuation: a recording longer than the per-clip cap is captured
//! as an ordered sequence of clips. The capture thread flushes each full clip
//! to the `consume_clips` task, which encrypts + imports it OFF the capture
//! thread and emits `VOICE_CLIP_EVENT` so the WebView inserts its embed. The
//! final (sub-cap) clip is returned by `stop`. See `decisions.md` voice-notes
//! entry + ../../AGENTS.md "Secret-handling logging discipline".

use std::sync::atomic::{AtomicI16, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use zeroize::Zeroizing;

use super::capture::{is_silent, SourceFactory};
use super::encoder::encode_wav;
use super::error::VoiceRecordError;
use super::state::{ActiveSession, Clip, VoiceRecordState};
use crate::plugins::attachments::commands::{
    attachment_import_with_dir, ImportSource, ImportedAttachment,
};
use crate::plugins::attachments::meeting::state::MeetingSessionState;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};

/// Tauri event carrying the live input level (`f32` in `[0, 1]`) to the meter.
pub const VOICE_LEVEL_EVENT: &str = "voice-record:level";

/// Tauri event carrying a finished continuation-clip's [`ImportedAttachment`]
/// so the WebView inserts its embed in order while recording continues.
pub const VOICE_CLIP_EVENT: &str = "voice-record:clip";
/// Emitted when a continuation clip fails to import (disk-full / transient IO),
/// so the recording UI can flag the gap instead of the clip vanishing silently.
pub const VOICE_CLIP_FAILED_EVENT: &str = "voice-record:clip-failed";

/// Which capture source this build uses — a COMPILE-time choice, mirroring the
/// `local-inference-stub` engine selection in `plugins::local_inference::init`.
///
/// This replaced `use_fixture_source()`, which read `MYNE_E2E_AUDIO_FIXTURE`
/// with no `cfg` gate at all (myne#389 item D). That switch was compiled into
/// the release binary, and `is_ok()` meant *any* value flipped it — including
/// the empty string — so anything able to set an environment variable on the
/// process could silently replace the microphone with a synthetic tone. There is
/// deliberately NO runtime switch now: a build that cannot ship has no need for
/// an escape hatch, and keeping both a knob and a feature would be two things to
/// hold in sync, which is how this drifts back.
#[cfg(feature = "voice-capture-stub")]
const CAPTURE_SOURCE: SourceFactory = SourceFactory::Fixture;
#[cfg(not(feature = "voice-capture-stub"))]
const CAPTURE_SOURCE: SourceFactory = SourceFactory::Cpal;

/// Arm a recording. Unlock-gated; fails if one is already running. Streams the
/// input level to `VOICE_LEVEL_EVENT` and spawns the continuation-clip consumer.
#[tauri::command]
pub async fn voice_record_start<R: Runtime>(
    app: AppHandle<R>,
    vault: State<'_, VaultRuntimeState>,
    voice: State<'_, VoiceRecordState>,
    meeting: State<'_, MeetingSessionState>,
) -> Result<(), VoiceRecordError> {
    if !matches!(vault.slot_kind_active().await, SlotKind::Unlocked) {
        return Err(VoiceRecordError::Locked);
    }
    let mut active = voice.active.lock().await;
    if active.is_some() {
        return Err(VoiceRecordError::AlreadyRecording);
    }
    // The capture exclusion is symmetric, and it was not: `meeting_session_start`
    // refuses while a voice recording runs, but `/record` during a meeting armed
    // a second capture over the same microphone and (on macOS) the tap's
    // aggregate device. Either order now refuses with `AlreadyRecording`.
    // Voice's own mutex is always taken before the meeting one, in both commands,
    // so the pair cannot deadlock.
    if meeting.active.lock().await.is_some() {
        return Err(VoiceRecordError::AlreadyRecording);
    }
    let factory = CAPTURE_SOURCE;

    // The capture thread pushes the input level (a non-secret scalar — no audio
    // content) to the WebView. Emit only when the quantized level changes — the
    // meter has a handful of discrete states, so the per-poll (100 Hz) rate
    // would otherwise be mostly identical floats (a flat/silent meter emits once).
    let emitter = app.clone();
    let last_q = Arc::new(AtomicI16::new(-1));
    // The voice-note flow has no system-audio half, so the second argument is
    // always `None` here. It exists because the meeting session shares this
    // capture path and watches that value for a denied tap.
    let level_sink: Box<dyn Fn(f32, Option<f32>) + Send> = Box::new(move |level, _tap| {
        let q = (level.clamp(0.0, 1.0) * 64.0).round() as i16;
        if last_q.swap(q, Ordering::Relaxed) != q {
            let _ = emitter.emit(VOICE_LEVEL_EVENT, level);
        }
    });

    // Continuation clips flow capture-thread → channel → consumer task (import
    // off-thread) → VOICE_CLIP_EVENT.
    let (clip_tx, clip_rx) = unbounded_channel::<Clip>();
    let clip_sink: Box<dyn Fn(Zeroizing<Vec<i16>>, u32) + Send> = Box::new(move |samples, rate| {
        let _ = clip_tx.send((samples, rate));
    });
    let consumer = tokio::spawn(consume_clips(app.clone(), clip_rx));

    *active = Some(ActiveSession::spawn(
        factory, level_sink, clip_sink, consumer,
    ));
    tracing::debug!(stage = "voice_record", event = "started");
    Ok(())
}

/// Finalize the active recording. Awaits every continuation clip's import, then
/// encrypts + stores the final (sub-cap) clip and returns its metadata. Returns
/// `None` when all audio already went out as continuation clips (the final clip
/// landed exactly on a cap boundary).
#[tauri::command]
pub async fn voice_record_stop<R: Runtime>(
    app: AppHandle<R>,
    voice: State<'_, VoiceRecordState>,
    filename: Option<String>,
) -> Result<Option<ImportedAttachment>, VoiceRecordError> {
    let session = voice
        .active
        .lock()
        .await
        .take()
        .ok_or(VoiceRecordError::NotRecording)?;

    // Finalize off the async runtime (joins the capture thread).
    let (captured_res, consumer) = tokio::task::spawn_blocking(move || session.finalize_capture())
        .await
        .map_err(|_| VoiceRecordError::Internal)?;
    let captured = captured_res?;
    // Wait for every continuation clip to import + emit before the final clip,
    // so the editor's embeds land in order.
    let clip_count = consumer.await.map_err(|_| VoiceRecordError::Internal)?;

    if captured.samples.is_empty() {
        if clip_count == 0 {
            return Err(VoiceRecordError::EmptyRecording);
        }
        // All audio was emitted as continuation clips (inserted via events).
        return Ok(None);
    }

    // Silence guard (story 20): a non-empty but silent recording with no real
    // continuation audio is discarded with an explanation, not stored as an
    // empty clip. (The user was already warned live by the flat meter.)
    if clip_count == 0 && is_silent(captured.samples.as_slice()) {
        return Err(VoiceRecordError::SilentRecording);
    }

    let name = filename.unwrap_or_else(|| "Voice note.wav".to_string());
    let sample_rate = captured.sample_rate;
    let imported = encode_and_import_clip(&app, captured.samples, sample_rate, name).await?;

    tracing::debug!(stage = "voice_record", event = "stored");
    Ok(Some(imported))
}

/// Discard the active recording's in-flight tail (stores nothing more). Already-
/// committed continuation clips remain — continuation is a checkpoint. Idempotent.
#[tauri::command]
pub async fn voice_record_cancel(
    voice: State<'_, VoiceRecordState>,
) -> Result<(), VoiceRecordError> {
    let session = voice.active.lock().await.take();
    if let Some(session) = session {
        let consumer = tokio::task::spawn_blocking(move || session.cancel_capture())
            .await
            .map_err(|_| VoiceRecordError::Internal)?;
        // Let any already-committed continuation clips finish importing.
        let _ = consumer.await;
        tracing::debug!(stage = "voice_record", event = "canceled");
    }
    Ok(())
}

/// Import every continuation clip handed off by the capture thread and emit its
/// [`ImportedAttachment`] on `VOICE_CLIP_EVENT`. Resolves with the imported-clip
/// count once the capture thread closes the channel.
async fn consume_clips<R: Runtime>(app: AppHandle<R>, mut rx: UnboundedReceiver<Clip>) -> usize {
    let mut count = 0usize;
    while let Some((samples, rate)) = rx.recv().await {
        match encode_and_import_clip(&app, samples, rate, "Voice note.wav".to_string()).await {
            Ok(imported) => {
                let _ = app.emit(VOICE_CLIP_EVENT, &imported);
                count += 1;
            }
            Err(_) => {
                // Surface the gap instead of dropping it silently: a continuation
                // clip that fails to import (disk-full / transient IO) would
                // otherwise leave an invisible hole in a long recording. Emit a
                // failure event the recording UI can react to; the count below
                // still reflects only the clips that actually landed.
                tracing::warn!(stage = "voice_record", "continuation clip import failed");
                let _ = app.emit(VOICE_CLIP_FAILED_EVENT, ());
            }
        }
    }
    count
}

/// Encode mono PCM `samples` to WAV and encrypt + store it as an `audio/wav`
/// attachment under `filename`. The single store path for BOTH the final clip
/// (`voice_record_stop`) and continuation clips (`consume_clips`) — a future
/// encoder swap (Opus) or metadata change touches exactly one place.
pub(crate) async fn encode_and_import_clip<R: Runtime>(
    app: &AppHandle<R>,
    samples: Zeroizing<Vec<i16>>,
    sample_rate: u32,
    filename: String,
) -> Result<ImportedAttachment, VoiceRecordError> {
    let wav = encode_wav(samples.as_slice(), sample_rate, 1);
    drop(samples);
    let vault = app.state::<VaultRuntimeState>();
    let dir = crate::paths::active_vault_root_io(app, vault.active_vault_id().await)
        .map_err(|_| VoiceRecordError::Internal)?;
    attachment_import_with_dir(
        &myne_core::vault_io::StdVaultIo,
        &myne_core::host::tauri_host::TauriHost::new(app.clone()),
        &dir,
        vault.inner(),
        ImportSource::Bytes {
            bytes: wav,
            filename: Some(filename),
        },
    )
    .await
    .map_err(VoiceRecordError::Import)
}
