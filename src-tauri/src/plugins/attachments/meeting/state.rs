//! Active meeting-session state (myne-md/myne#789).
//!
//! Deliberately the same shape as the voice-record session next door: only
//! `Send` handles live in Tauri-managed state, and the capture thread (which
//! owns the `!Send` device streams) is controlled through a stop channel plus a
//! result channel. The difference is the consumer: a meeting's continuation
//! clips are COLLECTED in capture order rather than only emitted, because the
//! session ends by writing them into a note.

use std::sync::mpsc;
use std::thread::JoinHandle;
use tokio::sync::Mutex;
use tokio::task::JoinHandle as TaskJoinHandle;

use crate::plugins::attachments::commands::ImportedAttachment;
use crate::plugins::attachments::voice::capture::{
    run_session, CapturedAudio, SessionResult, SourceFactory, StopKind, MAX_SAMPLES,
};
use crate::plugins::attachments::voice::error::VoiceRecordError;
use zeroize::Zeroizing;

/// Tauri-managed singleton holding at most one in-progress meeting session.
#[derive(Default)]
pub struct MeetingSessionState {
    pub(crate) active: Mutex<Option<MeetingSession>>,
}

/// Control handles for the dedicated capture thread + the clip consumer task.
pub(crate) struct MeetingSession {
    stop_tx: mpsc::Sender<StopKind>,
    result_rx: mpsc::Receiver<SessionResult>,
    handle: JoinHandle<()>,
    /// The clip-consumer task; resolves to every continuation clip it imported,
    /// in capture order, once the capture thread closes the clip channel.
    consumer: TaskJoinHandle<Vec<ImportedAttachment>>,
}

impl MeetingSession {
    pub(crate) fn spawn(
        factory: SourceFactory,
        level_sink: Box<dyn Fn(f32, Option<f32>) + Send>,
        clip_sink: Box<dyn Fn(Zeroizing<Vec<i16>>, u32) + Send>,
        consumer: TaskJoinHandle<Vec<ImportedAttachment>>,
    ) -> Self {
        let (stop_tx, stop_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let result = run_session(factory, &stop_rx, &*level_sink, &*clip_sink, MAX_SAMPLES);
            // Dropping the sinks here closes the clip channel, so the consumer
            // drains its backlog and resolves.
            drop(clip_sink);
            let _ = result_tx.send(result);
        });
        Self {
            stop_tx,
            result_rx,
            handle,
            consumer,
        }
    }

    /// Signal finalize and join the capture thread. Returns the final
    /// (sub-cap) clip plus the consumer handle, which the async caller awaits so
    /// every continuation clip is imported before the final one is placed.
    /// Blocking: call from `spawn_blocking`.
    pub(crate) fn finalize_capture(
        self,
    ) -> (
        Result<CapturedAudio, VoiceRecordError>,
        TaskJoinHandle<Vec<ImportedAttachment>>,
    ) {
        let _ = self.stop_tx.send(StopKind::Finalize);
        let _ = self.handle.join();
        let result = match self.result_rx.recv() {
            Ok(SessionResult::Captured(audio)) => Ok(audio),
            Ok(SessionResult::Canceled) => Err(VoiceRecordError::Internal),
            Ok(SessionResult::Error(e)) => Err(e.into()),
            Err(_) => Err(VoiceRecordError::Internal),
        };
        (result, self.consumer)
    }

    /// Signal cancel and join the capture thread (the in-flight tail is wiped
    /// in-thread). Already-committed clips remain, matching the voice flow:
    /// continuation is a checkpoint, and a cancelled meeting still has whatever
    /// was fully captured. Blocking: call from `spawn_blocking`.
    pub(crate) fn cancel_capture(self) -> TaskJoinHandle<Vec<ImportedAttachment>> {
        let _ = self.stop_tx.send(StopKind::Cancel);
        let _ = self.handle.join();
        self.consumer
    }

    /// Best-effort, NON-blocking abort for lock / auto-lock / vault-switch /
    /// vault-delete teardown. The capture thread sees `Cancel` on its next poll
    /// (~10 ms), wipes its `Zeroizing` buffer, releases the microphone and the
    /// tap, and exits. Dropping `self` detaches both handles: teardown must not
    /// block, and a tap that outlived the unlocked session is exactly what this
    /// prevents.
    pub(crate) fn abort(self) {
        let _ = self.stop_tx.send(StopKind::Cancel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::attachments::voice::capture::SourceFactory;
    use crate::plugins::attachments::voice::state::Clip;
    use std::time::Duration;
    use tokio::sync::mpsc::unbounded_channel;

    /// `tokio`'s `macros` feature is not enabled in this crate, so
    /// `#[tokio::test]` is unavailable and the runtime is built by hand.
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("a test runtime")
    }

    /// A consumer that drains the clip channel and resolves, standing in for
    /// the real one (which imports each clip, and so needs an app handle and a
    /// vault). Must be called inside a runtime.
    fn counting_consumer(
        mut rx: tokio::sync::mpsc::UnboundedReceiver<Clip>,
    ) -> TaskJoinHandle<Vec<ImportedAttachment>> {
        tokio::spawn(async move {
            while rx.recv().await.is_some() {}
            Vec::new()
        })
    }

    /// A session over the fixture source: a synthetic 440 Hz tone, so the state
    /// machine is exercised with no device, no permission and no vault. Must be
    /// called inside a runtime.
    fn fixture_session() -> MeetingSession {
        let (clip_tx, clip_rx) = unbounded_channel::<Clip>();
        let clip_sink: Box<dyn Fn(Zeroizing<Vec<i16>>, u32) + Send> =
            Box::new(move |samples, rate| {
                let _ = clip_tx.send((samples, rate));
            });
        MeetingSession::spawn(
            SourceFactory::Fixture,
            Box::new(|_, _| {}),
            clip_sink,
            counting_consumer(clip_rx),
        )
    }

    #[test]
    fn finalize_returns_the_captured_audio() {
        rt().block_on(async {
            let session = fixture_session();
            // Let a few polls accumulate so there is something to capture.
            std::thread::sleep(Duration::from_millis(60));
            let (result, consumer) =
                tokio::task::spawn_blocking(move || session.finalize_capture())
                    .await
                    .expect("the capture thread joins");
            let audio = result.expect("a finalize returns the tail clip");
            assert!(
                !audio.samples.is_empty(),
                "a session that ran for 60 ms captured nothing"
            );
            assert_eq!(audio.sample_rate, 48_000, "the fixture source is 48 kHz");
            // The consumer resolves once the capture thread closes the channel.
            let clips = consumer.await.expect("the consumer task joins");
            assert!(clips.is_empty(), "a 60 ms session crosses no clip boundary");
        });
    }

    /// The tail-discarding half, asserted where it is actually decided.
    ///
    /// The previous version of this test asserted `clips.is_empty()` against a
    /// stub consumer that returns an empty `Vec` unconditionally, so it could
    /// not fail: injecting `StopKind::Finalize` into `cancel_capture` (cancel
    /// behaves like stop, and the tail is silently kept) left it green. This
    /// drives `run_session` itself, which is where `Cancel` turns into
    /// `SessionResult::Canceled` and the `Zeroizing` buffer is dropped.
    #[test]
    fn cancel_reports_a_canceled_session_rather_than_a_captured_one() {
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<StopKind>();
        stop_tx
            .send(StopKind::Cancel)
            .expect("the receiver is live");
        let result = run_session(
            SourceFactory::Fixture,
            &stop_rx,
            &|_, _| {},
            &|_, _| {},
            MAX_SAMPLES,
        );
        assert!(
            matches!(result, SessionResult::Canceled),
            "a Cancel signal must discard the tail, not finalize it"
        );
    }

    #[test]
    fn finalize_reports_a_captured_session() {
        // The other direction, so the assertion above cannot pass for the wrong
        // reason: the same fixture with a Finalize signal DOES capture.
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<StopKind>();
        stop_tx
            .send(StopKind::Finalize)
            .expect("the receiver is live");
        let result = run_session(
            SourceFactory::Fixture,
            &stop_rx,
            &|_, _| {},
            &|_, _| {},
            MAX_SAMPLES,
        );
        assert!(matches!(result, SessionResult::Captured(_)));
    }

    #[test]
    fn cancel_discards_the_in_flight_tail() {
        rt().block_on(async {
            let session = fixture_session();
            std::thread::sleep(Duration::from_millis(60));
            let consumer = tokio::task::spawn_blocking(move || session.cancel_capture())
                .await
                .expect("the capture thread joins");
            // Cancel hands back no audio at all: the tail is wiped in-thread,
            // and the only handle the caller gets is the consumer's.
            let clips = consumer.await.expect("the consumer task joins");
            assert!(clips.is_empty());
        });
    }

    #[test]
    fn a_second_stop_has_no_session_to_stop() {
        // The commands `take()` the session out of the mutex before doing
        // anything, so a second stop or cancel finds `None` and answers
        // `NotRecording` rather than operating on a dead session. The shape
        // that makes that true is `finalize_capture` consuming `self`, which
        // this test exercises by consuming it and asserting the state is empty
        // afterwards.
        rt().block_on(async {
            let state = MeetingSessionState::default();
            *state.active.lock().await = Some(fixture_session());
            let taken = state.active.lock().await.take();
            assert!(taken.is_some());
            let (result, _consumer) = tokio::task::spawn_blocking(move || {
                taken.expect("just asserted").finalize_capture()
            })
            .await
            .expect("the capture thread joins");
            assert!(result.is_ok());
            assert!(
                state.active.lock().await.is_none(),
                "a stopped session leaves the slot empty, so a second stop is NotRecording"
            );
        });
    }

    #[test]
    fn abort_does_not_block() {
        rt().block_on(async {
            let session = fixture_session();
            std::thread::sleep(Duration::from_millis(30));
            // The teardown path is sync and must not wait for the capture
            // thread: it signals cancel and detaches. If it blocked, a vault
            // lock would hang, which is the failure this shape prevents.
            let started = std::time::Instant::now();
            session.abort();
            assert!(
                started.elapsed() < Duration::from_millis(50),
                "abort must not wait for the capture thread"
            );
        });
    }
}
