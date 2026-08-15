//! Closed error taxonomy for the local-inference engine (local-ai epic,
//! MYND-406, task 1).
//!
//! DENY-list clean per `src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline": every variant is a bounded, content-free kind — a prompt, a
//! note body, or an embedding vector never appears in an error value or its
//! `Display`. Callers log [`EngineError::kind`] (a `&'static str`), never any
//! inner data (there is none).

use serde::Serialize;

/// Failure modes of an [`super::engine::Engine`] call.
///
/// The stub engine (task 1) never fails; these variants exist so the trait's
/// `Result` surface is stable before the real Candle / sidecar engine (tasks
/// 3–5) lands. `Serialize` so a future `#[tauri::command]` (task 6) can return
/// the kind across IPC without leaking content.
// Variants are constructed by the real Candle/sidecar engine (tasks 3–5); the
// task-1 stub never fails, so they are forward-declared here to keep the
// trait's `Result` surface stable.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
pub enum EngineError {
    /// No model is loaded / the engine is not initialised (real engine, tasks
    /// 3–5). The stub is always ready, so it never returns this.
    #[error("local-inference engine not ready")]
    NotReady,
    /// `infer` failed inside the model runtime.
    #[error("local-inference inference failed")]
    InferenceFailed,
    /// `embed` failed inside the model runtime.
    #[error("local-inference embedding failed")]
    EmbeddingFailed,
    /// `transcribe` failed inside the model runtime (voice-to-text, MYND-550).
    /// Content-free like its siblings — the decoded transcript never appears in
    /// an error value or its `Display`.
    #[error("local-inference transcription failed")]
    TranscriptionFailed,
    /// The audio is longer than the decoder will materialize
    /// (`audio::MAX_PCM_SAMPLES`, myne#485).
    ///
    /// Distinct from [`EngineError::TranscriptionFailed`] because the two want
    /// opposite things from the user. A failure is worth retrying; this is not,
    /// and the same clip will be refused every time, so a UI that renders both
    /// as "please try again" is giving advice that cannot work. Content-free
    /// like its siblings: it carries no duration, no size and no file name.
    #[error("audio too long to transcribe")]
    AudioTooLong,
}

impl EngineError {
    /// Bounded, content-free tag for structured logging (DENY-list safe).
    // Consumed by command DENY-list logging in task 6; forward-declared here.
    #[allow(dead_code)]
    pub fn kind(&self) -> &'static str {
        match self {
            EngineError::NotReady => "not_ready",
            EngineError::InferenceFailed => "inference_failed",
            EngineError::EmbeddingFailed => "embedding_failed",
            EngineError::TranscriptionFailed => "transcription_failed",
            EngineError::AudioTooLong => "audio_too_long",
        }
    }
}
