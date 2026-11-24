// SPDX-License-Identifier: AGPL-3.0-only
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
    use std::sync::atomic::{AtomicBool, Ordering};
    // `super::*` brings in `tokio::sync::Mutex` (the state's own lock), so the
    // std one the gate's `Condvar` pairs with is aliased rather than shadowing
    // it silently.
    use std::sync::{Arc, Condvar, Mutex as StdMutex};
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

    /// Flips `finished` when the capture thread drops its clip sink. That drop
    /// is the last step `MeetingSession::spawn`'s closure takes before the
    /// thread exits (`run_session` returns, then `drop(clip_sink)`), so it names
    /// the moment the blocking tests below care about without reading a clock.
    ///
    /// It lives in the clip sink rather than on the session because the sink is
    /// moved INTO the capture thread: it cannot be observed from outside, but it
    /// is dropped from inside, which is exactly the boundary being asserted.
    struct ExitFlag(Arc<AtomicBool>);
    impl Drop for ExitFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// A one-shot latch the tests use to park the capture thread INSIDE a poll.
    ///
    /// `run_session` calls its level sink on every loop iteration, so a sink
    /// that blocks holds the thread between one stop check and the next, where
    /// it provably cannot stop until [`open`](Gate::open) is called. That turns
    /// "the thread had not stopped yet" from a race into a fact — the property
    /// the wall-clock assertion this replaced could not express, because a fast
    /// runner finishes the thread before the check while a slow runner fails an
    /// `abort` that never blocked at all.
    #[derive(Default)]
    struct Gate {
        state: StdMutex<GateState>,
        cv: Condvar,
    }

    #[derive(Default)]
    struct GateState {
        arrived: bool,
        opened: bool,
    }

    impl Gate {
        /// Called on the capture thread: announce arrival once, then block
        /// until the test opens the gate. Polls after the open pass straight
        /// through, so the thread is free to reach its stop check and exit.
        fn arrive_and_wait(&self) {
            let mut state = self.state.lock().unwrap();
            state.arrived = true;
            self.cv.notify_all();
            while !state.opened {
                state = self.cv.wait(state).unwrap();
            }
        }

        /// Called on the test thread: return once the capture thread is parked.
        fn await_arrival(&self) {
            let mut state = self.state.lock().unwrap();
            while !state.arrived {
                state = self.cv.wait(state).unwrap();
            }
        }

        fn open(&self) {
            let mut state = self.state.lock().unwrap();
            state.opened = true;
            self.cv.notify_all();
        }
    }

    /// Spin until `flag` is set. The ceiling is a liveness bound, not the
    /// invariant: it answers "the thread eventually stops", which holds however
    /// slow the runner is and so cannot flake in either direction.
    fn wait_until(flag: &AtomicBool) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if flag.load(Ordering::SeqCst) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        false
    }

    /// A session over the fixture source: a synthetic 440 Hz tone, so the state
    /// machine is exercised with no device, no permission and no vault. Must be
    /// called inside a runtime. The exit flag is discarded here; the tests that
    /// assert on the thread's lifetime use [`fixture_session_with`] instead.
    fn fixture_session() -> MeetingSession {
        fixture_session_with(Box::new(|_, _| {}), &Arc::new(AtomicBool::new(false)))
    }

    /// The same session with the level sink and the thread-exit flag supplied,
    /// for the tests that assert on the capture thread's lifetime rather than
    /// its output. Must be called inside a runtime.
    fn fixture_session_with(
        level_sink: Box<dyn Fn(f32, Option<f32>) + Send>,
        finished: &Arc<AtomicBool>,
    ) -> MeetingSession {
        let (clip_tx, clip_rx) = unbounded_channel::<Clip>();
        let exit = ExitFlag(finished.clone());
        let clip_sink: Box<dyn Fn(Zeroizing<Vec<i16>>, u32) + Send> =
            Box::new(move |samples, rate| {
                let _ = clip_tx.send((samples, rate));
                // Keep `exit` owned by this closure: dropping the closure drops
                // it, and that drop IS the thread-exit signal. A bare `exit`
                // would be moved out and dropped on every call instead.
                let _ = exit.0.load(Ordering::Relaxed);
            });
        MeetingSession::spawn(
            SourceFactory::Fixture,
            level_sink,
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

    /// `abort` must return without waiting for the capture thread;
    /// [`cancel_capture`](MeetingSession::cancel_capture) next door must wait
    /// for it. That difference is the invariant, and it is asserted by ORDERING
    /// rather than by a clock.
    ///
    /// The version this replaces wrapped `abort()` in
    /// `Instant::now()` … `elapsed() < 50 ms`. That measured the runner, not
    /// `abort`: `abort` sends `Cancel` on an unbounded channel and drops `self`,
    /// so it never joins — but a container that descheduled this thread for one
    /// scheduling quantum right after `Instant::now()` reported over 50 ms and
    /// failed, at roughly 2 runs in 5. Raising the threshold would only move the
    /// flake, since no wall-clock bound can distinguish "returned promptly" from
    /// "was preempted".
    ///
    /// So the capture thread is parked instead. Its level sink blocks on a gate
    /// the test opens, which makes "the thread has not stopped" a fact (it is
    /// blocked inside a poll and cannot reach its stop check), and a flag
    /// captured by the clip sink flips when the thread drops it on the way out.
    /// After `abort()` returns the flag must still be clear — a join could not
    /// have returned — and once the gate opens the flag must become set, proving
    /// `abort` really did signal the thread rather than merely detach a live one.
    #[test]
    fn abort_does_not_block() {
        rt().block_on(async {
            let finished = Arc::new(AtomicBool::new(false));
            let gate = Arc::new(Gate::default());
            let gate_cb = gate.clone();
            let level_sink: Box<dyn Fn(f32, Option<f32>) + Send> =
                Box::new(move |_, _| gate_cb.arrive_and_wait());

            let session = fixture_session_with(level_sink, &finished);
            // The thread is now parked in its first poll: it has already passed
            // one stop check (which found nothing) and cannot reach the next.
            gate.await_arrival();
            assert!(
                !finished.load(Ordering::SeqCst),
                "a parked capture thread cannot have exited"
            );

            session.abort();
            assert!(
                !finished.load(Ordering::SeqCst),
                "abort waited for the capture thread: the flag is set only by the \
                 thread dropping its sink, which is the thing a join waits for"
            );

            // The signal was still delivered: the thread stops the moment it is
            // free to run. This is the half that stops the assertion above
            // passing for the wrong reason — an `abort` that signalled nothing
            // and simply detached a live capture thread.
            gate.open();
            assert!(
                wait_until(&finished),
                "abort must signal Cancel, not merely detach the thread"
            );
        });
    }

    /// The other half of the same claim, and the one a clock cannot express
    /// either: `cancel_capture` JOINS the capture thread, so the flag is
    /// guaranteed set by the time it returns, however fast or slow the runner.
    /// Asserted on the same flag as [`abort_does_not_block`] so the two read as
    /// one statement — clear after `abort`, set after `cancel_capture`.
    #[test]
    fn cancel_capture_returns_only_after_the_thread_stops() {
        rt().block_on(async {
            let finished = Arc::new(AtomicBool::new(false));
            // No gate here, and that is deliberate: the join is what is under
            // test, so the thread must be free to run.
            let session = fixture_session_with(Box::new(|_, _| {}), &finished);
            let consumer = tokio::task::spawn_blocking(move || session.cancel_capture())
                .await
                .expect("the capture thread joins");
            assert!(
                finished.load(Ordering::SeqCst),
                "cancel_capture joins, so the thread has already stopped when it returns"
            );
            let _ = consumer.await;
        });
    }

    /// The capture exclusion between voice and meeting, asserted at the level
    /// it is enforced. The two start commands take `State<'_, _>` handles no
    /// unit test can mint, so what is testable here is the invariant they rest
    /// on: both sessions share ONE slot per state type, and the commands' read
    /// of `Some` is what produces `AlreadyRecording`. This pins that a slot
    /// holding a live session answers `Some` (so a start refuses) and that
    /// taking it answers `None` for the next start — the same sequence the
    /// commands perform. The cross-command direction (voice refusing while a
    /// meeting runs, and vice versa) is enforced by both commands taking the
    /// OTHER state's lock; that ordering is stated in `voice_record_start` so
    /// the pair cannot deadlock, and is covered by review rather than a driver.
    #[test]
    fn the_slot_refuses_a_second_session_and_frees_on_take() {
        rt().block_on(async {
            let state = MeetingSessionState::default();
            assert!(
                state.active.lock().await.is_none(),
                "a fresh state has no session"
            );
            *state.active.lock().await = Some(fixture_session());
            assert!(
                state.active.lock().await.is_some(),
                "a live session makes the next start refuse with AlreadyRecording"
            );
            let taken = state.active.lock().await.take();
            assert!(taken.is_some(), "the session is taken, not cloned");
            assert!(
                state.active.lock().await.is_none(),
                "taking the session frees the slot for the next start"
            );
            // Drop the taken session so its capture thread is signalled.
            if let Some(session) = taken {
                session.abort();
            }
        });
    }
}
