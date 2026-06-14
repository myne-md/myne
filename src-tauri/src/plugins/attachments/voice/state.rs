//! Active-recording session state for the voice-record commands (MYND-259).
//!
//! Only `Send` handles live in the Tauri-managed state — the cpal `Stream`
//! (which is `!Send` on macOS) stays entirely inside the capture thread. The
//! session is the channel + join-handle pair that controls that thread.

use std::sync::mpsc;
use std::thread::JoinHandle;
use tokio::sync::Mutex;
use tokio::task::JoinHandle as TaskJoinHandle;

use super::capture::{
    run_session, CapturedAudio, SessionResult, SourceFactory, StopKind, MAX_SAMPLES,
};
use super::error::VoiceRecordError;
use zeroize::Zeroizing;

/// A flushed continuation clip handed off to the consumer: mono PCM + rate.
pub(crate) type Clip = (Zeroizing<Vec<i16>>, u32);

/// Tauri-managed singleton holding at most one in-progress recording.
#[derive(Default)]
pub struct VoiceRecordState {
    pub(crate) active: Mutex<Option<ActiveSession>>,
}

/// Control handles for the dedicated capture thread + the clip consumer task.
pub(crate) struct ActiveSession {
    stop_tx: mpsc::Sender<StopKind>,
    result_rx: mpsc::Receiver<SessionResult>,
    handle: JoinHandle<()>,
    /// The clip-consumer task; resolves to the count of continuation clips it
    /// imported once the capture thread closes the clip channel.
    consumer: TaskJoinHandle<usize>,
}

impl ActiveSession {
    /// Spawn the capture thread. `level_sink` streams the input level; `clip_sink`
    /// hands off each full continuation clip at the cap; `consumer` is the task
    /// that imports those clips off the capture thread.
    pub(crate) fn spawn(
        factory: SourceFactory,
        level_sink: Box<dyn Fn(f32) + Send>,
        clip_sink: Box<dyn Fn(Zeroizing<Vec<i16>>, u32) + Send>,
        consumer: TaskJoinHandle<usize>,
    ) -> Self {
        let (stop_tx, stop_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let result = run_session(factory, &stop_rx, &*level_sink, &*clip_sink, MAX_SAMPLES);
            // Dropping the sinks here closes the clip channel → the consumer
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

    /// Signal finalize and join the capture thread, returning the final clip
    /// plus the consumer handle (awaited by the async caller so every
    /// continuation clip is imported before the final one). Blocking — call
    /// from `spawn_blocking`.
    pub(crate) fn finalize_capture(
        self,
    ) -> (
        Result<CapturedAudio, VoiceRecordError>,
        TaskJoinHandle<usize>,
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
    /// in-thread). Returns the consumer handle so the caller can await any
    /// already-committed continuation clips. Blocking — call from `spawn_blocking`.
    pub(crate) fn cancel_capture(self) -> TaskJoinHandle<usize> {
        let _ = self.stop_tx.send(StopKind::Cancel);
        let _ = self.handle.join();
        self.consumer
    }

    /// Best-effort, NON-blocking abort for lock/teardown: signal cancel and
    /// detach. The capture thread sees `Cancel` on its next poll (~10 ms),
    /// wipes its `Zeroizing` buffer, releases the mic stream, and exits; the
    /// consumer drains + exits when the clip channel closes. Dropping `self`
    /// here detaches both handles — teardown must not block.
    pub(crate) fn abort(self) {
        let _ = self.stop_tx.send(StopKind::Cancel);
    }
}
