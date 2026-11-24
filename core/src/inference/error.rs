// SPDX-License-Identifier: AGPL-3.0-only
//! Closed error taxonomy for the local-inference engine (local-ai epic,
//! MYND-406).
//!
//! DENY-list clean per `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline": every variant is a bounded, content-free kind. Callers log
//! [`EngineError::kind`] and never any inner data (there is none).

use serde::Serialize;

/// Failure modes of an [`super::engine::Engine`] call.
///
/// `Serialize` so a `#[tauri::command]` can return the kind across IPC without
/// leaking content. Every variant below is a distinct USER-FACING next step or a
/// distinct product rule; where two look alike, the doc says what separates them,
/// because collapsing them produces advice that cannot work.
// Variants are constructed by the real Candle/sidecar and remote engines; the
// stub never fails, so they are forward-declared to keep the `Result` surface
// stable.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
pub enum EngineError {
    /// No engine initialised / no model. Retained for the GENERATION load path
    /// and any non-transcription caller; transcribe splits into the four
    /// causes below.
    #[error("local-inference engine not ready")]
    NotReady,
    // ---- transcribe-path cause split (MYND-591) --------------------------
    // Unit variants serialize to the bare variant names, which the frontend's
    // `normalizeTranscribeError` maps to its snake_case kinds.
    /// Speech-to-text is switched OFF. Actionable: turn it on in Settings.
    #[error("transcription feature is off")]
    FeatureOff,
    /// No unlocked vault, so the audio (and the prefs blob) cannot be opened.
    /// Actionable: unlock.
    #[error("vault is locked")]
    VaultLocked,
    /// Neither a user override nor the bundled default model is present — a
    /// broken install, since one ships by default (MYND-270).
    #[error("no transcription model available")]
    NoModel,
    /// A model is present but will not load: its path marker is unreadable, or a
    /// required sibling (`config.json` / `tokenizer.json`) is missing.
    #[error("transcription model failed to load")]
    ModelLoadFailed,
    /// `infer` failed inside the model runtime.
    #[error("local-inference inference failed")]
    InferenceFailed,
    /// `transcribe` failed inside the model runtime (MYND-550). Content-free:
    /// the transcript never appears here.
    #[error("local-inference transcription failed")]
    TranscriptionFailed,
    /// The audio exceeds what the decoder will materialize
    /// (`audio::MAX_PCM_SAMPLES`, myne#510; mobile twin myne#485).
    ///
    /// Distinct from [`EngineError::TranscriptionFailed`] because the two want
    /// opposite things: a failure is worth retrying, this is refused every time,
    /// so "please try again" would be advice that cannot work. A real user
    /// reaches it — a telephony-rate import of about 35 minutes sits under the
    /// §9.9 attachment cap and still projects past the ceiling. Carries no
    /// duration, size or file name.
    #[error("audio too long to transcribe")]
    AudioTooLong,
    // ---- backend-reachability causes (ai-provider-seam task 5) -----------
    // Nothing produces these yet: the in-process engine cannot fail this way.
    // Unit and content-free — a host, port, endpoint or path here would land in
    // every log line that records a failure kind.
    /// The backend accepted the work and did not answer in time. Actionable:
    /// retry or extend the deadline. Distinct from a runtime failure — nothing
    /// is known to be wrong, only slow.
    #[error("local-inference backend timed out")]
    Timeout,
    /// Nothing is listening where the backend was expected. Actionable: start
    /// it, or correct which one is selected.
    #[error("local-inference backend unreachable")]
    Unreachable,
    /// The backend was reached and refused the connection — a different fact
    /// from silence, and usually a different fix (running, but not for this
    /// caller).
    #[error("local-inference backend refused the connection")]
    Refused,
    /// The seam declined to route an **ambient** request — one that fires
    /// without the user asking — to a remote-class backend (`sync-ledger`
    /// SYNC-14/SYNC-16).
    ///
    /// Not a backend failure: nothing was attempted. Myne's own code declined.
    #[error("this request may not use a remote backend")]
    RemoteBarred,
    /// **No consent recorded on THIS DEVICE** for the selected provider.
    /// Actionable: accept the consent screen, once, here.
    ///
    /// Split from [`EngineError::RemoteBarred`] by myne-md/myne#456 because one
    /// variant carried two meanings: that one is a rule about a request CLASS,
    /// this one a permission not yet given. Collapsed, someone who had never
    /// seen the consent screen was told their request could never use a
    /// provider — false, and silent about the act that would fix it. Distinct
    /// from [`EngineError::NoCredential`] for the same reason: nothing to send
    /// versus not having agreed to send it.
    #[error("no consent recorded on this device for the selected provider")]
    ConsentMissing,
    // ---- provider-credential + quota causes (ai-remote-providers task 7) ---
    // Unit and content-free like every sibling: a provider's response body is
    // attacker-influenceable and is never read, only counted as present.
    /// **No credential is stored** for the named provider. Actionable: paste a
    /// key.
    ///
    /// Distinct from [`EngineError::Unauthorized`] on purpose — "there is
    /// nothing to send" versus "what was sent was rejected". Collapsed, a user
    /// who never entered a key is told to check it.
    #[error("no credential is stored for the selected provider")]
    NoCredential,
    /// The provider **rejected** the credential (401/403). Actionable: replace
    /// it — wrong, revoked, or for another account. Not `Refused`, which is
    /// transport: here the request arrived, was understood and was declined.
    #[error("the provider rejected the credential")]
    Unauthorized,
    /// The credential was accepted and the work declined on **cost** grounds —
    /// out of credit, rate-limited, past a spend cap (402/429). The one variant
    /// whose fix is on the provider's side, so "try again" would be wrong.
    #[error("the provider's quota or credit is exhausted")]
    QuotaExhausted,
    /// The credential was accepted, the reply was **200**, and the work was
    /// declined under the provider's **own policy** (myne-md/myne#466).
    ///
    /// Not [`EngineError::Refused`] (transport) and not
    /// [`EngineError::QuotaExhausted`] (cost, and it arrives as a status code):
    /// this one arrives inside a 200 body and no status distinguishes it.
    #[error("the provider refused the request under its own policy")]
    PolicyRefused,
    /// The model answered with a **genuinely empty completion**. The one case
    /// where "try rephrasing" is honest advice, which is why it is not folded
    /// into [`EngineError::InferenceFailed`] with the two that are not about the
    /// user's wording: a policy refusal and a reply shape Myne does not model.
    #[error("the provider returned an empty completion")]
    EmptyCompletion,
    /// A **local** model path was recorded and the file is gone
    /// (myne-md/myne#466). Distinct from [`EngineError::NotReady`]: something
    /// *was* chosen, so the fix is to choose again rather than for the first
    /// time. Carries no path — a backend-resolved filesystem path may neither be
    /// logged nor cross IPC.
    #[error("the recorded local model file is missing")]
    LocalModelMissing,
    /// A background pass stood down so user-initiated work could take the
    /// compute lock (MYND-651). NOT a failure, and distinct from an empty result
    /// so a caller cannot cache "no suggestions" for a note nobody looked at.
    ///
    /// **Optional outcome:** it exists only because *one* compute lock exists. A
    /// backend that serializes model work out of process can never answer it, so
    /// a caller treats it as possible, never guaranteed. Which backends can
    /// produce it is declared by `Backend::serializes_compute`.
    #[error("local-inference pass deferred to user-initiated work")]
    Deferred,
    /// The provider rejected the **request itself** (400), as distinct from the
    /// credential or the cost (myne-md/myne#547). Its own variant because the
    /// fix is on Myne's side: collapsed into the generic failure it arrived as
    /// "the note could not be read", which blames the vault for what the request
    /// did.
    #[error("the provider rejected the request")]
    RequestRejected,
}

impl EngineError {
    /// Bounded, content-free tag for structured logging (DENY-list safe).
    // Consumed by command DENY-list logging; forward-declared here.
    #[allow(dead_code)]
    pub fn kind(&self) -> &'static str {
        match self {
            EngineError::NotReady => "not_ready",
            EngineError::FeatureOff => "feature_off",
            EngineError::VaultLocked => "vault_locked",
            EngineError::NoModel => "no_model",
            EngineError::ModelLoadFailed => "model_load_failed",
            EngineError::InferenceFailed => "inference_failed",
            EngineError::TranscriptionFailed => "transcription_failed",
            EngineError::AudioTooLong => "audio_too_long",
            EngineError::Timeout => "timeout",
            EngineError::Unreachable => "unreachable",
            EngineError::Refused => "refused",
            EngineError::RemoteBarred => "remote_barred",
            EngineError::ConsentMissing => "consent_missing",
            EngineError::NoCredential => "no_credential",
            EngineError::Unauthorized => "unauthorized",
            EngineError::QuotaExhausted => "quota_exhausted",
            EngineError::PolicyRefused => "policy_refused",
            EngineError::EmptyCompletion => "empty_completion",
            EngineError::LocalModelMissing => "local_model_missing",
            EngineError::Deferred => "deferred",
            EngineError::RequestRejected => "request_rejected",
        }
    }
}
