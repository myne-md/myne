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
    /// Generic "engine not initialised / no model" — retained for the
    /// GENERATION and EMBEDDING load paths (`load_gen` / `load_embed`) and any
    /// non-transcription trait caller. The transcribe path (MYND-591) no
    /// longer produces this: it splits into the four cause variants below so a
    /// failure renders the truthful reason instead of a hardcoded "no model".
    #[error("local-inference engine not ready")]
    NotReady,
    // ---- transcribe-path cause split (MYND-591) --------------------------
    // Unit variants → serialize to the bare strings "FeatureOff" /
    // "VaultLocked" / "NoModel" / "ModelLoadFailed" (no serde attrs), which the
    // frontend `normalizeTranscribeError` maps to its snake_case kinds. Still
    // content-free — the DENY-list discipline in this file's header holds.
    /// Speech-to-text is switched OFF (`transcription_enabled == false`).
    /// Actionable: turn it on in Settings → Transcription.
    #[error("transcription feature is off")]
    FeatureOff,
    /// No unlocked vault / no key material to decrypt the audio (or to read
    /// the prefs blob, which needs an unlocked slot). Actionable: unlock.
    #[error("vault is locked")]
    VaultLocked,
    /// Neither a user override nor the bundled default transcription model is
    /// present — a broken install, since a model ships by default (MYND-270).
    #[error("no transcription model available")]
    NoModel,
    /// A transcription model is present but could not be loaded: its path
    /// marker is unreadable, or a required sibling (`config.json` /
    /// `tokenizer.json`) is missing or unreadable.
    #[error("transcription model failed to load")]
    ModelLoadFailed,
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
}

impl EngineError {
    /// Bounded, content-free tag for structured logging (DENY-list safe).
    // Consumed by command DENY-list logging in task 6; forward-declared here.
    #[allow(dead_code)]
    pub fn kind(&self) -> &'static str {
        match self {
            EngineError::NotReady => "not_ready",
            EngineError::FeatureOff => "feature_off",
            EngineError::VaultLocked => "vault_locked",
            EngineError::NoModel => "no_model",
            EngineError::ModelLoadFailed => "model_load_failed",
            EngineError::InferenceFailed => "inference_failed",
            EngineError::EmbeddingFailed => "embedding_failed",
            EngineError::TranscriptionFailed => "transcription_failed",
        }
    }
}
