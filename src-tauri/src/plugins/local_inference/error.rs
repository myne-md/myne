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
    // ---- backend-reachability causes (ai-provider-seam task 5) -----------
    // Filed into #188 by #189 so that slice adds a backend rather than a
    // backend plus a vocabulary. Nothing produces these yet — the in-process
    // engine cannot fail this way. Unit, content-free: a host, port, endpoint
    // or path in one of these would put it in every log line that records a
    // failure kind, which the DENY-list in this file's header forbids.
    /// The backend accepted the work but did not answer in time. Actionable:
    /// retry, or give it a longer deadline. Distinct from a failure inside the
    /// runtime — nothing is known to be wrong, only slow.
    #[error("local-inference backend timed out")]
    Timeout,
    /// Nothing is listening where the backend was expected. Actionable: start
    /// it, or correct which one is selected.
    #[error("local-inference backend unreachable")]
    Unreachable,
    /// The backend was reached and actively refused the connection — a
    /// different fact from silence, and usually a different fix (it is running
    /// but not accepting this caller).
    #[error("local-inference backend refused the connection")]
    Refused,
    /// The seam refused to hand this request a **remote-class** backend
    /// (`sync-ledger` SYNC-14 / SYNC-16). Two cases produce it: an *ambient*
    /// request — one that fires without the user asking — and **any** embedding
    /// request, unconditionally.
    ///
    /// NOT a failure of the backend: nothing was attempted. The request was
    /// routed nowhere because Myne's own code declines to route it there.
    #[error("this request may not use a remote backend")]
    RemoteBarred,
    // ---- provider-credential + quota causes (ai-remote-providers task 7) ---
    // The issue asks for "three distinct states, not one"; these are two of the
    // five, and the two the tree could not otherwise express. Unit and
    // content-free like every sibling: a provider's response body is
    // attacker-influenceable and must never be smuggled in as a detail string.
    /// **No credential is stored** for the named provider. Actionable: paste a
    /// key. Distinct from [`EngineError::Unauthorized`] on purpose — one means
    /// "there is nothing to send", the other means "what was sent was
    /// rejected", and collapsing them produces the message "check your API key"
    /// for a user who has never entered one.
    #[error("no credential is stored for the selected provider")]
    NoCredential,
    /// The provider **rejected** the credential (HTTP 401/403). Actionable:
    /// replace it — it is wrong, revoked, or for a different account.
    ///
    /// Deliberately not folded into `Refused`, which is a transport fact
    /// (nothing accepted the connection); this one means the request arrived,
    /// was understood, and was declined.
    #[error("the provider rejected the credential")]
    Unauthorized,
    /// The provider accepted the credential and declined the work on **cost**
    /// grounds — out of credit, over a rate limit, or past a spend cap
    /// (HTTP 402/429). Actionable in a way no other variant is: the fix is on
    /// the provider's side, not in Myne, and telling the user to "try again"
    /// would be wrong.
    #[error("the provider's quota or credit is exhausted")]
    QuotaExhausted,
    /// The provider accepted the credential, claimed success (**HTTP 200**), and
    /// declined the work under **its own policy** — an account guardrail, a
    /// workspace rule, a model the plan does not carry (myne-md/myne#466).
    ///
    /// Deliberately not [`EngineError::Refused`], which is a transport fact
    /// (something refused the connection); here the connection succeeded and the
    /// reply parsed. Deliberately not [`EngineError::QuotaExhausted`] either,
    /// which is the *cost* decline and arrives as a status code — this one
    /// arrives inside a 200 body and no status distinguishes it.
    ///
    /// Content-free like every sibling: the provider's error body is
    /// attacker-influenceable and is never read, only counted as present.
    #[error("the provider refused the request under its own policy")]
    PolicyRefused,
    /// The model answered with a **genuinely empty completion** — the reply had
    /// the content field and it held nothing. The one case where "try
    /// rephrasing" is the honest advice, which is why it may not be collapsed
    /// into [`EngineError::InferenceFailed`] with the two failures that are not
    /// the user's wording (a policy refusal, and a reply shape Myne does not
    /// model).
    #[error("the provider returned an empty completion")]
    EmptyCompletion,
    /// A **local** model path was recorded and the file it names is not on this
    /// device any more (myne-md/myne#466). Distinct from [`EngineError::NotReady`],
    /// which means nothing was ever chosen: here something *was* chosen, so the
    /// fix is to choose again rather than to choose for the first time.
    ///
    /// Nothing left the device on this path. The variant carries no path — a
    /// backend-resolved filesystem path may neither be logged nor cross IPC
    /// (see: src-tauri/CLAUDE.md "Secret-handling logging discipline").
    #[error("the recorded local model file is missing")]
    LocalModelMissing,
    /// A background pass stood down so user-initiated work could have the
    /// compute lock (auto-tag, MYND-651 task 4). NOT a failure: nothing is
    /// wrong, the caller may simply try again later. Distinct from an empty
    /// result so a caller cannot cache "no suggestions" for a note that was
    /// never actually looked at.
    ///
    /// **Optional outcome (ai-provider-seam task 11).** This variant exists
    /// only because *one* compute lock exists. A backend that serializes model
    /// work out of process has none and can never answer `Deferred` — so a
    /// caller must treat it as a possibility, never as a guarantee that a busy
    /// engine will say so. Which backends can produce it is declared, not
    /// guessed: `Backend::serializes_compute`.
    #[error("local-inference pass deferred to user-initiated work")]
    Deferred,
    /// Asking cannot run because **no on-device embedding model is selected**
    /// (myne-md/myne#545).
    ///
    /// Distinct from [`EngineError::NotReady`], and the distinction is the
    /// whole reason it exists. Ask is retrieval-grounded, retrieval is refused
    /// a remote provider unconditionally (SYNC-16), and the embedding model is
    /// not bundled — so "a provider is named and working" and "asking can run"
    /// are independent facts. Reporting `NotReady` here told a user who had
    /// already named a provider to name one, which is advice they cannot act
    /// on: the missing piece is a local search model, and no amount of provider
    /// configuration supplies it.
    ///
    /// Nothing left the device on this path, and the refusal fires before the
    /// question is embedded so that stays true.
    #[error("no on-device embedding model is selected")]
    NoEmbeddingModel,
    /// An embedding model IS selected and the vault's index is **not built
    /// yet** — the embed-on-unlock walk has not finished, or has not run.
    ///
    /// A state, not a failure, and separate from
    /// [`EngineError::NoEmbeddingModel`] because the user's next move is
    /// different: wait, rather than choose a model.
    #[error("the search index is not ready yet")]
    IndexNotReady,
    /// The provider rejected the request itself (**HTTP 400**), as distinct
    /// from rejecting the credential or the cost (myne-md/myne#547).
    ///
    /// Its own variant because the fix is on Myne's side rather than the
    /// user's: a 400 says the request Myne built is one this provider will not
    /// take. Collapsed into the generic failure it arrived as "the note could
    /// not be read", which blames the vault for something the request did.
    #[error("the provider rejected the request")]
    RequestRejected,
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
            EngineError::Timeout => "timeout",
            EngineError::Unreachable => "unreachable",
            EngineError::Refused => "refused",
            EngineError::RemoteBarred => "remote_barred",
            EngineError::NoCredential => "no_credential",
            EngineError::Unauthorized => "unauthorized",
            EngineError::QuotaExhausted => "quota_exhausted",
            EngineError::PolicyRefused => "policy_refused",
            EngineError::EmptyCompletion => "empty_completion",
            EngineError::LocalModelMissing => "local_model_missing",
            EngineError::Deferred => "deferred",
            EngineError::NoEmbeddingModel => "no_embedding_model",
            EngineError::IndexNotReady => "index_not_ready",
            EngineError::RequestRejected => "request_rejected",
        }
    }
}
