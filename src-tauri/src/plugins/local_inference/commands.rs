//! `infer` / `embed` Tauri commands (local-ai epic, MYND-406, task 6).
//!
//! The `#[tauri::command]`s are thin wrappers that extract the shared engine
//! from state and delegate to the testable async cores
//! [`infer_with_engine`] / [`embed_with_engine`]. The cores hold the
//! Plaintext-IPC discipline in exactly one place:
//!   - the prompt/text is `Zeroizing`-wrapped on the first statement, so every
//!     early-return path zeroes the bytes (`src-tauri/CLAUDE.md` "Plaintext IPC
//!     across the WebView boundary");
//!   - the model call runs under `spawn_blocking` (CPU-bound; keeps the async
//!     command `Send`), the engine reached ONLY via the `Engine` trait;
//!   - nothing plaintext is logged — only the closed [`EngineError`] kind
//!     (DENY-list logging discipline), via [`local_inference_error_kind`].
//!
//! Blocking one-shot results only — no streaming channel (SYNC-7). The
//! commands are reached only when the `local-inference` feature is on and the
//! scoped `local-inference:default` capability (added at runtime in
//! [`super::init`]) authorizes them.
//!
//! Tests exercise the cores directly against the [`StubEngine`] over a manual
//! current-thread runtime — the codebase's "avoid the `tauri::test` harness"
//! discipline (TB9 Cargo.lock), mirroring `notes::…_with_dir`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
use zeroize::Zeroizing;

use myne_core::plugins::attachments::extract_types::{ExtractStatus, SourceFormat};
use myne_core::plugins::notes::commands::note_read_with_dir;
use myne_core::plugins::notes::note_id::NoteId;

use super::cancel::{guarded_on_token, CancelReach, CancelRegistry, CancelToken, RequestCancel};
use super::compute_priority::ComputePriority;
use super::endpoint_config;
use super::engine::{ChatMessage, ChatRole, Engine};
use super::error::EngineError;
use super::hydrate::{folder_is_excluded, folder_of};
use super::model_store::{self, ModelRole, ModelStoreError};
use super::rag;
use super::retrieval::{self, ScoredChunk};
use super::state::LocalInferenceState;
use super::state::RequestClass;
use super::vector_store::LocalInferenceVectorState;
use crate::plugins::attachments::scheme_core::{decode_attachment_plaintext, ServeKeys};
use crate::plugins::vault_unlock::state::VaultRuntimeState;

/// DENY-list-safe static label for structured logging (mirrors
/// `protocol_error_kind`): a new [`EngineError`] variant compile-fails
/// `EngineError::kind`, structurally catching drift.
pub fn local_inference_error_kind(e: &EngineError) -> &'static str {
    e.kind()
}

/// Minimum cosine score for a retrieved chunk to ground (and cite) a chat turn
/// (conversational-ai-chat). Below this the turn answers conversationally
/// without inventing note citations. Chosen from a real-vault measurement with a
/// **multilingual** embedding model, where cosines discriminate (relevant
/// ~0.5–0.8, weak/off-note ~0.2–0.35). An English-only model gives a flat
/// ~0.83–0.98 distribution where this cutoff is a no-op — the multilingual
/// model is the load-bearing fix; this threshold is the complementary gate.
const CHAT_RELEVANCE_THRESHOLD: f32 = 0.30;

/// One-shot completion. Blocking (no stream, SYNC-7).
///
/// `max_new_tokens` is the OPTIONAL per-caller generation ceiling (issue #193):
/// the passive inline ghost-text wants a few words, chat and `/devam` want the
/// engine's full budget, and all of them ride this one command. Omitted, the
/// engine's own budget applies — the byte-identical pre-#193 behaviour. Supplied,
/// the engine clamps it to that budget (the value comes from the WebView, TB6).
/// `infer`'s request class. A **constant in the command body**, never a field
/// read from the payload — see [`super::state::RequestClass`] for why that
/// distinction is the whole mechanism.
pub(super) const INFER_CLASS: RequestClass = RequestClass::UserInitiated;

/// `infer_ambient`'s request class. Ghost text appears because the user typed,
/// not because they asked for it.
pub(super) const INFER_AMBIENT_CLASS: RequestClass = RequestClass::Ambient;

#[tauri::command]
pub async fn infer(
    prompt: String,
    max_new_tokens: Option<usize>,
    state: State<'_, LocalInferenceState>,
    vault_state: State<'_, VaultRuntimeState>,
    cancel_state: State<'_, CancelRegistry>,
    priority: State<'_, ComputePriority>,
) -> Result<String, EngineError> {
    // A user asked for this. Register for the whole call so a background
    // auto-tag pass stands down rather than making the user queue behind it
    // (MYND-651 task 4) — held across the await, dropped on every return path.
    let _interactive = priority.interactive();
    // Refresh the authorization against the CURRENTLY unlocked vault
    // (myne-md/myne#437). This command carries note text to whatever backend is
    // selected and took no vault input at all, so it resolved from whatever the
    // cell last held — which, before the vault stamp, could be another vault's
    // provider. The stamp makes a stale cell unusable; refreshing here makes it
    // current, so the user's own configuration takes effect without waiting for
    // a capability report to happen to run.
    if vault_state.active_vault_id().await.is_none() {
        return Err(EngineError::VaultLocked);
    }
    state.refresh().await;
    // Registered for the duration (myne-md/myne#445). Not for a Stop button —
    // this surface has none, which is why the reach is `LockOnly` — but so the
    // vault-lock teardown can abort it: before this, `cancel_all` found nothing
    // to cancel while a provider request was in flight, so the request outlived
    // the vault it was answering about and kept billing.
    let cancel_guard = cancel_state.begin(CancelReach::LockOnly);
    infer_with_engine(
        state.engine_for(INFER_CLASS)?,
        prompt,
        max_new_tokens,
        cancel_guard.request_cancel(),
    )
    .await
}

/// One-shot completion for an **ambient** surface — today, inline ghost text.
///
/// Byte-identical to [`infer`] in contract (prompt in, text out, the same
/// `Zeroizing` wrap and `spawn_blocking` inside [`infer_with_engine`], the same
/// clamping of the WebView-supplied ceiling) and different in exactly one way:
/// its class is `Ambient`, so the seam refuses it a remote-class backend
/// (SYNC-14).
///
/// It exists as a separate command *because* the class has to be a host-side
/// fact. Ghost text used to ride `infer` alongside chat and rewrite, which left
/// the seam unable to tell them apart — and inferring the class from "there is
/// a small token ceiling in the payload" would be guessing from a caller-
/// supplied field, which is the shape this design rejects.
///
/// Named for the class rather than for ghost text: a second ambient generative
/// surface belongs here, not on a second command.
///
/// NOT registered as interactive compute — an ambient pass must never make a
/// user-initiated one queue behind it (the mirror of `suggest_tags`).
#[tauri::command]
pub async fn infer_ambient(
    prompt: String,
    max_new_tokens: Option<usize>,
    state: State<'_, LocalInferenceState>,
    cancel_state: State<'_, CancelRegistry>,
) -> Result<String, EngineError> {
    // `LockOnly`, like `infer` — ghost text has no Stop of its own, and the
    // seam bars it from a remote backend, but the loopback runtime it MAY reach
    // is a socket that must not survive the lock either.
    let cancel_guard = cancel_state.begin(CancelReach::LockOnly);
    infer_with_engine(
        state.engine_for(INFER_AMBIENT_CLASS)?,
        prompt,
        max_new_tokens,
        cancel_guard.request_cancel(),
    )
    .await
}

/// Per-feature answer in [`AiCapabilityReport`].
///
/// `cause` is a **closed `EngineError` kind** (`error.rs`), never a new
/// vocabulary — SYNC-5. The frontend already has a normalizer for that
/// taxonomy and a drift test holding it in step; a second, report-only set of
/// strings would be a second thing to keep in step and the first thing to rot.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FeatureStatus {
    pub available: bool,
    /// `None` when available. Otherwise `EngineError::kind()`.
    pub cause: Option<&'static str>,
}

impl FeatureStatus {
    fn ok() -> Self {
        Self {
            available: true,
            cause: None,
        }
    }
    fn blocked(cause: EngineError) -> Self {
        Self {
            available: false,
            cause: Some(cause.kind()),
        }
    }
}

/// What the AI surface can actually do right now, per feature.
///
/// **Per feature, not per model role**, because that is the question the UI
/// asks: the panel wants to know whether auto-tag works, not whether a file
/// exists. The two differ the moment a backend can be present-but-unreachable.
///
/// The in-tree precedent is quick-unlock — a static build-time capability
/// (`src/platform/capabilities.ts`'s `localAi`) paired with a runtime status
/// struct. `localAi` stays build-time by decision; it answers "can this
/// platform ever", and this answers "can it now".
///
/// **`compiled` is always `true` here**, and that is not a tautology worth
/// deleting: this whole plugin is behind the `local-inference` cargo feature,
/// so in a `--no-default-features` build the command does not exist and the
/// invoke is rejected. The frontend reads that rejection as `compiled: false`.
/// The field carries the positive case so the wrapper has one shape to parse
/// rather than a presence check plus a parse.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AiCapabilityReport {
    pub compiled: bool,
    pub backend_id: &'static str,
    pub backend_class: &'static str,
    pub generation: FeatureStatus,
    pub embedding: FeatureStatus,
    pub transcription: FeatureStatus,
    pub auto_tag: FeatureStatus,
}

/// Build the report from resolved values — no `AppHandle`, so it is testable.
pub(super) fn capability_report_from(
    state: &LocalInferenceState,
    generation_model: bool,
    embedding_model: bool,
    transcription_model: bool,
) -> AiCapabilityReport {
    // Generation and transcription are user-initiated; embedding and auto-tag
    // carry the SYNC-14/16 bars, so ask the seam rather than re-deriving them
    // here — a policy restated at a second site is a policy that will disagree.
    //
    // Each row asks the SAME engine its command will actually use
    // (myne-md/myne#438). The report used to take one unclassified engine for
    // every row, which is wrong in exactly the configuration the provider epic
    // added: the ambient/user-initiated split means the arm that answers
    // auto-tag is not the arm that answers generation.
    //
    // The three disk-resolved rows also ask the engine whether it carries its
    // own weights (`Engine::carries_own_models`). A model file is evidence that
    // a role can be served, not the definition of it: the E2E stub answers all
    // three from code with no file anywhere, and asking only the disk reported
    // `NoModel` for a build whose AI demonstrably works — which is what left
    // every AI scenario driving a surface stuck in its empty state. `auto_tag`
    // below is the row that already asked the engine, and the row that already
    // worked.
    let generation = match state.engine_for(RequestClass::UserInitiated) {
        Err(cause) => FeatureStatus::blocked(cause),
        // A locally side-loaded GGUF is required only by the in-process arm. A
        // remote provider or a loopback runtime BRINGS ITS OWN model, which is
        // the entire point of naming one — reporting `NoModel` there told a user
        // whose generation demonstrably works that the feature is unavailable.
        Ok(engine)
            if !generation_model
                && !engine.carries_own_models()
                && state.class_for(RequestClass::UserInitiated)
                    == Ok(super::state::BackendClass::InProcessLocal) =>
        {
            FeatureStatus::blocked(EngineError::NoModel)
        }
        Ok(_) => FeatureStatus::ok(),
    };
    let embedding = match state.embedding_engine() {
        Err(cause) => FeatureStatus::blocked(cause),
        Ok(engine) if !embedding_model && !engine.carries_own_models() => {
            FeatureStatus::blocked(EngineError::NoModel)
        }
        Ok(_) => FeatureStatus::ok(),
    };
    // Transcription reads the LOCAL door, because that is the door the
    // `transcribe` command itself uses: speech-to-text is a bundled local
    // model, and a named text-generation provider neither serves it nor should
    // make the report claim it is gone. A report that answers a different
    // question than the command is worse than no report.
    let transcription = match state.embedding_engine() {
        Err(cause) => FeatureStatus::blocked(cause),
        Ok(engine) if !transcription_model && !engine.carries_own_models() => {
            FeatureStatus::blocked(EngineError::NoModel)
        }
        Ok(_) => FeatureStatus::ok(),
    };
    let auto_tag = match state.engine_for(RequestClass::Ambient) {
        Err(cause) => FeatureStatus::blocked(cause),
        // THIS engine, not the active one. The gate already resolved the ambient
        // arm — asking a different engine whether it has a tag model is how the
        // report came to answer `false` for a build whose `suggest_tags` works.
        Ok(engine) if !engine.tag_model_available() => FeatureStatus::blocked(EngineError::NoModel),
        Ok(_) => FeatureStatus::ok(),
    };
    AiCapabilityReport {
        compiled: true,
        backend_id: state.active_id(),
        backend_class: state.active_class().as_str(),
        generation,
        embedding,
        transcription,
        auto_tag,
    }
}

/// The one capability report (SYNC-5). Host-side because the WebView CSP
/// cannot reach a loopback daemon — a browser-side probe would be answering a
/// question it structurally cannot answer.
#[tauri::command]
pub async fn ai_capability_report<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LocalInferenceState>,
) -> Result<AiCapabilityReport, EngineError> {
    // The report describes the selection as it is NOW, so it refreshes like
    // every other surface that can route remote — #191 task 1 reads this to
    // decide what the UI says is available.
    state.refresh().await;
    let base = crate::paths::app_data_dir(&app).unwrap_or_else(|_| std::path::PathBuf::from("."));
    let has = |role: ModelRole| {
        model_store::selected_model(&base, role)
            .ok()
            .flatten()
            .is_some()
    };
    let bundled_transcription = app
        .path()
        .resource_dir()
        .ok()
        .and_then(|rd| model_store::bundled_transcription_model(&rd));
    let transcription_model =
        model_store::effective_transcription_model(&base, bundled_transcription.as_deref())
            .ok()
            .flatten()
            .is_some();
    Ok(capability_report_from(
        &state,
        has(ModelRole::Generation),
        has(ModelRole::Embedding),
        transcription_model,
    ))
}

/// The models the **named remote provider** currently publishes (myne#415
/// task 17, SYNC-24).
///
/// This is the other half of "Myne ships no model default": the user picks from
/// a list, and the list has to come from somewhere. It comes from the provider,
/// at the moment the user opens the chooser — never from a constant in this
/// tree, which would rot and would re-create the pinned-tag problem SYNC-24
/// rejected.
///
/// **It is an egress, and it is gated exactly like a completion.** Same
/// [`authorize_remote`](super::provider_gate::authorize_remote): developer
/// mode, the AI beta, a selected provider, a stored key, and consent naming
/// that provider. All five, re-read here rather than trusted from the panel —
/// asking a provider "what models do you have" over an authenticated
/// connection tells that provider this account exists and is active, which is
/// exactly the kind of byte #414's invariant is about.
///
/// It fetches model **names**, never weights. `decisions.md` 2026-08-09 draws
/// the forbidden line at a provider's *pull or download* endpoint; a listing
/// call downloads nothing and the feature cannot exist without it.
///
/// `RequestClass::UserInitiated` by construction: nothing ambient opens a
/// settings panel.
#[tauri::command]
pub async fn list_provider_models<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<super::provider_registry::ProviderModel>, EngineError> {
    let active = state.active_vault_id().await;
    let vault_dir = myne_core::paths::active_vault_root_io(&app, active)
        .map_err(|_| EngineError::VaultLocked)?;
    let prefs = myne_core::plugins::prefs::commands::prefs_read_with_dir(
        &vault_dir,
        state.inner(),
        &myne_core::vault_io::StdVaultIo,
    )
    .await
    .map_err(|_| EngineError::VaultLocked)?;

    // The gate first, and the network only after it says yes. Written in this
    // order on purpose: an implementation that connected and then checked would
    // satisfy every assertion about the RESULT while still having sent a byte.
    list_models_gated(&prefs, prefs.developer_mode, |provider, key| {
        let transport = super::provider_transport::ProviderTransport::new(provider.host());
        transport.get_json(provider.models_path(), key)
    })
    .await
}

/// Testable core of [`list_provider_models`]: the gate, then the fetch, then
/// the parse — with the fetch injected.
///
/// The injection is the point. A test can then assert the thing that actually
/// matters and that no assertion about the RETURN VALUE can reach: when a
/// precondition is missing, the fetch is **never called**. An implementation
/// that connected first and checked afterwards would satisfy every
/// error-equality assertion while having already sent a byte, which is the
/// exact failure #414's invariant is written against.
pub(crate) async fn list_models_gated<F>(
    prefs: &protocol::PrefsView,
    developer_mode: bool,
    fetch: F,
) -> Result<Vec<super::provider_registry::ProviderModel>, EngineError>
where
    F: FnOnce(
            super::provider_registry::RemoteProvider,
            &str,
        ) -> Result<Vec<u8>, super::provider_transport::ProviderTransportError>
        + Send
        + 'static,
{
    let auth = super::provider_gate::authorize_remote(prefs, developer_mode)?;
    let provider = auth.provider();
    let key = auth.key().to_string();

    let raw = tokio::task::spawn_blocking(move || fetch(provider, &key))
        .await
        .map_err(|_| EngineError::InferenceFailed)?
        .map_err(super::provider_registry::engine_error_of)?;

    provider
        .parse_models_reply(&raw)
        .map_err(|_| EngineError::InferenceFailed)
}

/// Read the device-local AI endpoint, or `None` when none is configured.
///
/// Host-side because the WebView's CSP `connect-src` is
/// `'self' ipc: http://ipc.localhost attachment: http://attachment.localhost`,
/// mirrored and asserted in Rust — widening it is the motion that guard exists
/// to make expensive. A page-side probe would be answering a question it
/// structurally cannot answer.
///
/// **Named for the setting, not the medium.** `no_egress::permission_is_network`
/// refuses any permission string containing "network", "socket" or "fetch", as
/// an OR over the namespace check. That is the fail-safe direction and not worth
/// arguing with.
#[tauri::command]
pub async fn get_ai_endpoint<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<(String, String)>, endpoint_config::AiEndpointError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| endpoint_config::AiEndpointError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        })?;
    Ok(
        endpoint_config::read_endpoint(&endpoint_config::endpoint_path_in(&dir))?
            .map(|e| (e.url, e.model)),
    )
}

/// Validate and persist the device-local AI endpoint.
///
/// Refuses before writing, so the file can never hold a destination the reader
/// would reject. An empty string clears it, returning the arm to **unreachable**
/// rather than merely disabled.
#[tauri::command]
pub async fn set_ai_endpoint<R: Runtime>(
    url: String,
    model: String,
    app: AppHandle<R>,
) -> Result<Option<String>, endpoint_config::AiEndpointError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| endpoint_config::AiEndpointError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        })?;
    let path = endpoint_config::endpoint_path_in(&dir);
    if url.trim().is_empty() {
        endpoint_config::clear_endpoint(&path)?;
        return Ok(None);
    }
    endpoint_config::write_endpoint(&path, url.trim(), model.trim()).map(|e| Some(e.url))
}

/// Embedding vector for `text`.
///
/// Deliberately NOT registered as interactive compute: this command is the
/// primitive the background embed-walk drives, and a walk that counted as
/// user-initiated would starve auto-tag for the whole of a large re-index. The
/// user-initiated embeds are the ones inside [`semantic_search`] / [`ask`] /
/// [`chat_stream`], which register there.
#[tauri::command]
pub async fn embed(
    text: String,
    state: State<'_, LocalInferenceState>,
) -> Result<Vec<f32>, EngineError> {
    embed_with_engine(state.embedding_engine()?, text).await
}

/// Transcribe an audio attachment to text (voice-to-text, MYND-550; SYNC-V3/V5/V6).
///
/// Decrypts the `MYA1` blob in RAM (the `attachment://` serve seam's
/// [`decode_attachment_plaintext`]), decodes WAV → 16 kHz mono
/// ([`super::audio::wav_to_mono_16k`]), then runs the ASR engine under
/// `spawn_blocking`, streaming each newly-decoded segment over `on_segment` and
/// returning the full transcript. Host-side `transcription_enabled`-gated (a
/// compromised WebView is not trusted to stop calling — same posture as
/// [`semantic_search`], but a different switch: speech-to-text is a product
/// feature with a bundled model, not part of the AI beta opt-in (MYND-592)).
///
/// DENY-list logging only: the decrypted WAV, the derived PCM, and the transcript
/// are `Zeroizing`-wrapped and NEVER written to disk or logged. Cancellation
/// (UI "Stop" or vault-lock teardown) flows through the shared [`CancelToken`]'s
/// publish-guard, so no segment is emitted into a torn-down channel after a lock.
#[tauri::command]
pub async fn transcribe<R: Runtime>(
    attachment_id: String,
    on_segment: Channel<String>,
    app: AppHandle<R>,
    engine_state: State<'_, LocalInferenceState>,
    vault_state: State<'_, VaultRuntimeState>,
    cancel: State<'_, CancelRegistry>,
    priority: State<'_, ComputePriority>,
) -> Result<String, EngineError> {
    // User-initiated compute: a background auto-tag pass yields to this and
    // never makes it wait (MYND-651 task 4). Registered before the gate so the
    // whole call — prefs read, decrypt, decode, ASR — is covered.
    let _interactive = priority.interactive();
    // Host-side `transcription_enabled` gate — no engine call and no decrypt
    // when speech-to-text is off. A compromised WebView is not trusted to stop
    // calling, so this is re-read here rather than taken on the caller's word.
    //
    // MYND-592: this used to consult the AI vector store's `is_enabled()`, i.e.
    // the *embedding / semantic-search* opt-in, which transcription has nothing
    // to do with — it was simply hanging off the nearest available flag, so
    // turning off the AI beta silently killed speech-to-text.
    //
    // The persisted preference is the single source of truth, deliberately: a
    // resident copy would need a lifecycle hook to stay in step and could drift
    // from disk. One small AEAD-decrypt per transcription is free next to
    // running an ML model over an audio file. A prefs blob that cannot be read
    // decodes to defaults (spec § 9.5.5), and this field defaults ON — the same
    // fail-open posture the feature has by design; a locked slot still fails
    // closed, because `prefs_read_from_host` refuses without one.
    let prefs = crate::plugins::prefs::commands::prefs_read_from_host(
        &myne_core::host::tauri_host::TauriHost::new(app.clone()),
        vault_state.inner(),
        &myne_core::vault_io::StdVaultIo,
    )
    .await
    // `prefs_read_from_host` returns defaults on any prefs-blob failure; it only
    // errors on a locked slot (or a rare vault.meta IO failure). Transcribe
    // requires an unlocked vault anyway, so both surface as "unlock" (MYND-591).
    .map_err(|_| EngineError::VaultLocked)?;
    if !prefs.transcription_enabled {
        return Err(EngineError::FeatureOff);
    }
    // Fresh cancel window. Structural now rather than a reset: this request
    // takes its OWN token, so a prior Stop cannot reach it and a Stop on it
    // cannot reach a concurrent request. The guard deregisters on drop, so
    // every early return below also retires this request's entry.
    //
    // `StopAndLock`: transcription's Stop rides `chat_stop` (there is no second
    // stop command), so it is one of the two surfaces a composer Stop may reach
    // — which is exactly what it was before the reach became explicit (#445).
    let cancel_guard = cancel.begin(CancelReach::StopAndLock);

    // Resolve the unlocked slot's key material + the active vault dir. This is
    // the only place with `.await` access to the slot map (mirror the
    // `attachment://` serve path).
    let keys = match vault_state.peek_unlocked_attachment_material().await {
        Some((items_key, items_key_id, root_key)) => ServeKeys {
            items_key,
            items_key_id,
            root_key,
        },
        None => return Err(EngineError::VaultLocked),
    };
    let active_id = vault_state.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root_io(&app, active_id)
        .map_err(|_| EngineError::TranscriptionFailed)?;

    // Embedding path (SYNC-16): the strict accessor, which never hands back a
    // remote backend. This surface only embeds — there is no generation here to
    // split off (#415 task 18 split the two handles in `ask` and `chat_stream`,
    // where there was one).
    let engine = engine_state.embedding_engine()?;
    let cancel_token: CancelToken = cancel_guard.token().clone();
    // Kept for the out-of-band search refresh below (the closure consumes the id).
    let attachment_id_hex = attachment_id.clone();
    let app_for_cache = app.clone();

    // Heavy work off the async thread: decrypt → decode → resample → engine →
    // persist the transcript to the attachment's MYE1 cache.
    let transcript = tokio::task::spawn_blocking(move || -> Result<String, EngineError> {
        // Decrypt the MYA1 blob to WAV bytes in RAM (Zeroizing; wiped on drop).
        let wav = decode_attachment_plaintext(&vault_dir, &keys, &attachment_id)
            .map_err(|_| EngineError::TranscriptionFailed)?;
        // Decode + resample to 16 kHz mono; wrap the derived PCM too.
        let pcm = Zeroizing::new(
            super::audio::wav_to_mono_16k(&wav).map_err(|_| EngineError::TranscriptionFailed)?,
        );
        drop(wav);
        // Stream each decoded segment through the cancel publish-guard into the
        // IPC channel; the transcript text is never logged.
        let mut on = guarded_on_token(&cancel_token, |seg: &str| {
            let _ = on_segment.send(seg.to_string());
        });
        let transcript = engine.transcribe_streaming(&pcm, &mut on)?;
        // Task 2/3 (SYNC-V1/V6): seal the transcript into the attachment's MYE1
        // cache so it is searchable + re-insertable without re-transcribing. The
        // transcription model's SHA-256 (SYNC-V3) binds the cache-invalidation
        // identity into the INNER payload (never the AAD, § 9.17.2 mirror).
        // Best-effort — a cache-write miss must not discard the transcript the
        // user already has; the transcript is never logged (DENY-list).
        persist_transcript_cache(
            &vault_dir,
            &keys.root_key,
            &attachment_id,
            &transcript,
            &app_for_cache,
        );
        Ok(transcript)
    })
    .await
    .map_err(|_| EngineError::TranscriptionFailed)??;

    // Task 4: the MYE1 write is out-of-band (the note's `content_nonce` is
    // unchanged → the incremental reconcile would skip the note), so live-refresh
    // the embedding notes' `att:` search docs now — the transcript is findable
    // IN-SESSION, not only after a lock→unlock. Best-effort; never fails here.
    crate::plugins::notes::search_sync::refresh_attachment_docs_for(
        &app,
        &vault_state,
        &attachment_id_hex,
    )
    .await;
    // …and make it SURVIVE the session (myne#307). The refresh above is a live-
    // index patch; nothing else made it durable. An idle auto-lock before the
    // next 120 s flush zeroizes the index and skips persist, and the next unlock
    // cannot recover: hydrate skips the note (its nonce never changed) and the
    // OCR backlog skips the attachment (its MYE1 cache exists). One transcript
    // is one blob rewrite, and it happens once per transcription.
    crate::plugins::notes::search_sync::persist_search_index(&app, &vault_state).await;

    Ok(transcript)
}

/// Read `vault.meta`'s `account_number_hash` (the AAD binding for the
/// attachment-text cache; § 9.3 offset 6). `None` on IO / parse failure. The
/// bytes are a vault-stable correlation tag — used, never logged (DENY-list).
fn read_account_number_hash(
    vault_dir: &Path,
) -> Option<[u8; protocol::VAULT_META_ACCOUNT_HASH_LEN]> {
    let bytes = std::fs::read(vault_dir.join("vault.meta")).ok()?;
    // Either generation (myne-md/myne#433).
    protocol::parse_vault_meta_any(&bytes)
        .map(|m| m.account_number_hash)
        .ok()
}

/// Seal a produced transcript into the attachment's `MYE1` cache (voice-to-text
/// MYND-551, Task 2/3). Resolves the account-hash AAD binding, derives the
/// `AttachmentTextKey` KEK from the unlocked-slot `root_key`, binds the current
/// transcription model's SHA-256 into the inner payload (SYNC-V3), and writes via
/// `myne_core` `text_cache::write_transcript`. Sync (runs inside
/// `spawn_blocking`); best-effort — every miss (bad id, missing meta, IO) is
/// swallowed. DENY-list: no transcript / hash / path is logged.
fn persist_transcript_cache<R: Runtime>(
    vault_dir: &Path,
    root_key: &[u8; 32],
    attachment_id_hex: &str,
    transcript: &str,
    app: &AppHandle<R>,
) {
    let Some(attachment_id) =
        myne_core::plugins::attachments::commands::hex_decode_id(attachment_id_hex)
    else {
        return;
    };
    let Some(account_number_hash) = read_account_number_hash(vault_dir) else {
        return;
    };
    let model_hash = super::model_store::transcription_model_hash_for(app);
    let attachment_text_key =
        protocol::derive_subkey(root_key, protocol::SubkeyRole::AttachmentTextKey);
    let _ = myne_core::plugins::attachments::text_cache::write_transcript(
        vault_dir,
        &attachment_text_key,
        &account_number_hash,
        &attachment_id,
        transcript,
        model_hash,
    );
}

/// Read an already-transcribed attachment's cached transcript from its `MYE1`
/// cache (voice-to-text MYND-551, Task 5 — SYNC-V1) so the UI can show / re-insert
/// it WITHOUT re-running the engine. `Slot::Unlocked`-gated; returns the
/// transcript text, or `None` when no `Ok` audio transcript is cached (never
/// transcribed / silence / decode miss). No engine call and no `ai_enabled`
/// gate — this reads already-produced, already-searchable extracted text.
///
/// The backend NEVER writes the transcript into a note body; insertion is the
/// frontend's explicit `note_save`/`MY01` action (SYNC-17). DENY-list: the
/// transcript is plaintext (same class as a note body); returned to the WebView,
/// never logged.
#[tauri::command]
pub async fn read_transcript<R: Runtime>(
    attachment_id: String,
    app: AppHandle<R>,
    vault_state: State<'_, VaultRuntimeState>,
) -> Result<Option<String>, EngineError> {
    let Some(root_key) = vault_state.peek_unlocked_root_key_clone().await else {
        return Err(EngineError::NotReady);
    };
    let active_id = vault_state.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root_io(&app, active_id)
        .map_err(|_| EngineError::TranscriptionFailed)?;
    // Decrypt + decode the cache off the async thread (the KEK moves into the
    // closure and drops on exit).
    let transcript = tokio::task::spawn_blocking(move || -> Option<String> {
        read_cached_transcript(&vault_dir, &root_key, &attachment_id)
    })
    .await
    .map_err(|_| EngineError::TranscriptionFailed)?;
    Ok(transcript)
}

/// Read + decode the cached `Ok` AUDIO transcript for `attachment_id_hex`, or
/// `None` on any miss (bad id, missing meta, decode fail, or a non-audio /
/// non-`Ok` cache entry). Sync (runs in `spawn_blocking`); the transcript is
/// plaintext — never logged.
fn read_cached_transcript(
    vault_dir: &Path,
    root_key: &[u8; 32],
    attachment_id_hex: &str,
) -> Option<String> {
    let attachment_id =
        myne_core::plugins::attachments::commands::hex_decode_id(attachment_id_hex)?;
    let account_number_hash = read_account_number_hash(vault_dir)?;
    let attachment_text_key =
        protocol::derive_subkey(root_key, protocol::SubkeyRole::AttachmentTextKey);
    let extracted = myne_core::plugins::attachments::text_cache::read_extracted(
        vault_dir,
        &attachment_text_key,
        &account_number_hash,
        &attachment_id,
    )?;
    if extracted.status == ExtractStatus::Ok
        && extracted.source_format == SourceFormat::Audio
        && !extracted.text.is_empty()
    {
        Some(extracted.text)
    } else {
        None
    }
}

/// One ranked semantic-search hit crossing IPC (semantic-search-qa task 7). The
/// `{note_id, byte-range}` the UI resolves for display + navigation, plus the
/// cosine score. Content-free — no plaintext (DENY-list; `note_id` is a
/// correlation tag, but the UI already holds it).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchHit {
    /// Canonical `NoteId` display form.
    pub note_id: String,
    /// Chunk byte-range start into the note's decrypted markdown.
    pub byte_start: usize,
    /// Chunk byte-range end.
    pub byte_end: usize,
    /// Cosine similarity to the query in `[-1.0, 1.0]`.
    pub score: f32,
}

/// Map retrieval [`ScoredChunk`]s to IPC [`SearchHit`]s. Pure + testable.
fn to_search_hits(scored: Vec<ScoredChunk>) -> Vec<SearchHit> {
    scored
        .into_iter()
        .map(|s| SearchHit {
            note_id: s.key.note_id.to_string(),
            byte_start: s.key.start,
            byte_end: s.key.end,
            score: s.score,
        })
        .collect()
}

/// Semantic search over the resident chunk vectors (semantic-search-qa tasks
/// 5 + 7). Embeds the query once through the `Engine` seam off the async thread
/// (blocking, SYNC-7), then scans the `app.manage`d store. No streaming, no
/// network.
///
/// Two host-side policy gates run here so a compromised WebView cannot bypass
/// the user's controls (they are NOT trusted to stop calling): the store's
/// live `ai_enabled` opt-in short-circuits to no results when off, and the
/// query-time `ai_excluded_folders` filter is enforced from the store's own
/// per-note folder map (defense-in-depth — even a stale resident vector for a
/// now-excluded note can never surface; SYNC-14).
#[tauri::command]
pub async fn semantic_search(
    query: String,
    k: usize,
    engine_state: State<'_, LocalInferenceState>,
    vector_state: State<'_, LocalInferenceVectorState>,
    priority: State<'_, ComputePriority>,
) -> Result<Vec<SearchHit>, EngineError> {
    // First statement: bound the query plaintext to a Zeroizing wrapper.
    let query = Zeroizing::new(query);
    // The user typed a query — auto-tag yields to it (MYND-651 task 4).
    let _interactive = priority.interactive();
    // Embedding path (SYNC-16): the strict accessor, which never hands back a
    // remote backend. This surface only embeds — there is no generation here to
    // split off (#415 task 18 split the two handles in `ask` and `chat_stream`,
    // where there was one).
    let engine = engine_state.embedding_engine()?;
    // Embed off the async thread (CPU-bound); the wrapper zeroizes on drop.
    let query_vec = tokio::task::spawn_blocking(move || engine.embed(&query))
        .await
        .map_err(|_| EngineError::EmbeddingFailed)??;
    // Scan the resident store synchronously — no await, no model call, so the
    // std-Mutex guard never spans a suspension point.
    let hits = {
        let store = vector_state.lock();
        if !store.is_enabled() {
            return Ok(Vec::new());
        }
        retrieval::top_k_matches(&query_vec, &store, k, |id| store.is_note_excluded(id))
    };
    Ok(to_search_hits(hits))
}

/// Which backend is serving right now, as an answer records it
/// (myne-md/myne#440). Read at the moment the turn is built rather than by the
/// frontend afterwards — the selection is re-read per request, so a report
/// fetched after the answer can name a different backend than the one that
/// produced it.
fn served_by_of(state: &LocalInferenceState) -> ServedBy {
    let class = state.active_class();
    ServedBy {
        class: class.as_str(),
        name: state.served_by_name(class),
    }
}

/// A grounded Q&A answer crossing IPC (semantic-search-qa tasks 6 + 7): the
/// answer text plus the source chunks it was grounded on, for citation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AskResult {
    pub answer: String,
    pub sources: Vec<SearchHit>,
    /// **Which backend served THIS turn** (myne-md/myne#440).
    ///
    /// Reported by the request rather than read after it. The chat surface used
    /// to call `ai_capability_report()` once the answer was in and label the
    /// turn from the CURRENT selection — so a backend switch mid-session
    /// relabelled turns that a different backend had produced. Attribution of
    /// where a note's text went is a trust surface, not a caption; it has to
    /// come from the request that actually sent it.
    pub served_by: ServedBy,
}

/// The backend that produced one answer, as the turn records it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServedBy {
    /// The `BackendClass` wire form — `in_process_local` / `loopback_local` /
    /// `remote`.
    pub class: &'static str,
    /// The runtime or provider by name, when the class has one to give.
    ///
    /// `None` for the in-process arm, which is Myne itself and needs no name.
    /// Populated for BOTH the loopback and remote arms — the loopback one used
    /// to render as an empty string, because the frontend derived every name
    /// from the *remote provider's* wire value, which a loopback answer does not
    /// have. "Answered by" with nothing after it is worse than no indicator.
    pub name: Option<String>,
}

/// Resolve retrieved hits to their chunk texts from resident note bodies,
/// skipping any hit whose body is missing (note evicted) or whose byte-range is
/// stale (not a char boundary / out of range — the note changed since
/// embedding). Returns the resolved chunk texts (under `Zeroizing`) paired with
/// the sources that resolved, in retrieval order. Pure + testable.
fn resolve_hit_texts<'b>(
    hits: &[ScoredChunk],
    body_of: impl Fn(&NoteId) -> Option<&'b str>,
) -> (Vec<Zeroizing<String>>, Vec<ScoredChunk>) {
    let mut texts = Vec::new();
    let mut sources = Vec::new();
    for h in hits {
        let Some(body) = body_of(&h.key.note_id) else {
            continue;
        };
        let (s, e) = (h.key.start, h.key.end);
        if e <= body.len() && body.is_char_boundary(s) && body.is_char_boundary(e) {
            texts.push(Zeroizing::new(body[s..e].to_string()));
            sources.push(*h);
        }
    }
    (texts, sources)
}

/// Grounded Q&A over the resident vault (semantic-search-qa tasks 6 + 7). Embeds
/// the question, retrieves top-k chunks, reads each source note body via the
/// sanctioned `note_read` path, assembles a grounding context under `Zeroizing`,
/// and calls the blocking `Engine.infer`. Returns the answer + the source set
/// for citation. No streaming, no network; plaintext never hits disk/log here.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri State injections, not a design smell
pub async fn ask<R: Runtime>(
    question: String,
    k: usize,
    app: AppHandle<R>,
    vault_state: State<'_, VaultRuntimeState>,
    engine_state: State<'_, LocalInferenceState>,
    vector_state: State<'_, LocalInferenceVectorState>,
    cancel_state: State<'_, CancelRegistry>,
    priority: State<'_, ComputePriority>,
) -> Result<AskResult, EngineError> {
    let question = Zeroizing::new(question);
    // User-initiated: covers BOTH model calls below (embed + generate), so a
    // background auto-tag pass cannot slip between them (MYND-651 task 4).
    let _interactive = priority.interactive();
    // TWO handles (#415 task 18). Retrieval embeds on the LOCAL embedder —
    // SYNC-16, and mixing embedders is a retrieval-correctness bug before it is
    // a privacy one. The generation is user-initiated and MAY be the provider
    // the user named. Sharing one handle meant this surface could never reach a
    // provider no matter what the user configured, which was most of why the
    // remote arm was unreachable.
    engine_state.refresh().await;
    let engine = engine_state.embedding_engine()?;
    let generator = engine_state.engine_for(RequestClass::UserInitiated)?;

    // 1. Embed the question off the async thread.
    let query_vec = {
        let engine = Arc::clone(&engine);
        let q = question.clone();
        tokio::task::spawn_blocking(move || engine.embed(&q))
            .await
            .map_err(|_| EngineError::EmbeddingFailed)??
    };

    // 2. Retrieve top-k (sync scan; the std-Mutex guard never spans an await).
    //    Host-side opt-in + excluded-folder gates enforced here (see
    //    `semantic_search`), so a compromised WebView cannot ground an answer on
    //    a disabled feature or an excluded note (SYNC-14).
    let hits = {
        let store = vector_state.lock();
        if !store.is_enabled() {
            return Ok(AskResult {
                answer: String::new(),
                sources: Vec::new(),
                served_by: served_by_of(&engine_state),
            });
        }
        retrieval::top_k_matches(&query_vec, &store, k, |id| store.is_note_excluded(id))
    };
    if hits.is_empty() {
        // Nothing resident to ground on — no model call, empty answer.
        return Ok(AskResult {
            answer: String::new(),
            sources: Vec::new(),
            served_by: served_by_of(&engine_state),
        });
    }

    // 3. Read each unique source note body via the sanctioned decrypt path.
    let notes_dir = myne_core::paths::notes_dir_for(&app, vault_state.active_vault_id().await)
        .map_err(|_| EngineError::NotReady)?;
    let mut bodies: HashMap<NoteId, Zeroizing<String>> = HashMap::new();
    for h in &hits {
        if bodies.contains_key(&h.key.note_id) {
            continue;
        }
        if let Ok(body) = note_read_with_dir(
            notes_dir.clone(),
            vault_state.inner(),
            h.key.note_id.to_string(),
            &myne_core::vault_io::StdVaultIo,
            &myne_core::host::tauri_host::TauriHost::new(app.clone()),
        )
        .await
        {
            bodies.insert(h.key.note_id, Zeroizing::new(body));
        }
    }

    // 4. Resolve chunk texts (char-boundary-safe) + assemble the grounding
    //    prompt under Zeroizing.
    let (chunk_texts, sources) = resolve_hit_texts(&hits, |id| bodies.get(id).map(|b| b.as_str()));
    let prompt = rag::assemble_rag_prompt(&question, &chunk_texts);

    // 5. Generate off the async thread (blocking, no stream) — on the
    //    GENERATION handle, which may be the named provider. Registered so the
    //    vault-lock teardown can abort it (#445); `LockOnly` because the Q&A
    //    surface offers no Stop.
    let cancel_guard = cancel_state.begin(CancelReach::LockOnly);
    let answer = {
        let engine = Arc::clone(&generator);
        let cancel = cancel_guard.request_cancel();
        tokio::task::spawn_blocking(move || {
            engine.infer_cancellable(prompt.as_str(), None, cancel.as_fn())
        })
        .await
        .map_err(|_| EngineError::InferenceFailed)??
    };

    Ok(AskResult {
        answer,
        sources: to_search_hits(sources),
        served_by: served_by_of(&engine_state),
    })
}

/// A conversation message crossing IPC from the WebView (conversational-ai-chat
/// task 5). `content` is UNTRUSTED plaintext (may echo note content) — never
/// logged; the engine tokenizes it with the Special-Token-Injection defense
/// (task 2, `chat_streaming`).
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessageDto {
    pub role: String,
    pub content: String,
}

impl ChatMessageDto {
    /// Map to the engine `ChatMessage`. An unrecognized role is treated as
    /// `User` — role is a quality hint only (content is always untrusted-
    /// tokenized regardless), so a lenient default is safe.
    fn into_message(self) -> ChatMessage {
        let role = if self.role == "assistant" {
            ChatRole::Assistant
        } else {
            ChatRole::User
        };
        ChatMessage {
            role,
            content: self.content,
        }
    }
}

/// Streaming grounded chat over the resident vault (conversational-ai-chat task
/// 5). Embeds the question, retrieves top-k non-excluded chunks, reads their
/// source note bodies, frames a grounded multi-turn conversation, and streams
/// the assistant's answer token-by-token over `on_token` (a Tauri `Channel`).
/// Returns the full answer + the source set for citation when generation ends.
///
/// Cancellation: the shared [`CancelToken`] is `reset()` at the start; the
/// composer "Stop" command ([`chat_stop`]) and the vault-lock teardown both
/// `cancel()` it. The [`guarded_on_token`] publish-guard checks the flag BEFORE
/// each channel send, so a lock mid-generation never emits into a torn-down
/// transcript.
///
/// Local-only, no network. Plaintext (question, history, chunk texts, tokens)
/// never hits disk or log (DENY-list); the question is `Zeroizing`-wrapped. AI
/// off (store not enabled) → empty answer, no model call (mirrors [`ask`]).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri State/Channel injections, not a design smell
pub async fn chat_stream<R: Runtime>(
    question: String,
    history: Vec<ChatMessageDto>,
    k: usize,
    on_token: Channel<String>,
    app: AppHandle<R>,
    vault_state: State<'_, VaultRuntimeState>,
    engine_state: State<'_, LocalInferenceState>,
    vector_state: State<'_, LocalInferenceVectorState>,
    cancel_state: State<'_, CancelRegistry>,
    priority: State<'_, ComputePriority>,
) -> Result<AskResult, EngineError> {
    // First statement: bound the question plaintext to a Zeroizing wrapper.
    let question = Zeroizing::new(question);
    // User-initiated: registered for the whole turn, including the streamed
    // generation, which is the longest compute hold in the app (MYND-651 task 4).
    let _interactive = priority.interactive();
    // TWO handles (#415 task 18). Retrieval embeds on the LOCAL embedder —
    // SYNC-16, and mixing embedders is a retrieval-correctness bug before it is
    // a privacy one. The generation is user-initiated and MAY be the provider
    // the user named. Sharing one handle meant this surface could never reach a
    // provider no matter what the user configured, which was most of why the
    // remote arm was unreachable.
    engine_state.refresh().await;
    let engine = engine_state.embedding_engine()?;
    let generator = engine_state.engine_for(RequestClass::UserInitiated)?;
    let messages: Vec<ChatMessage> = history
        .into_iter()
        .map(ChatMessageDto::into_message)
        .collect();

    // Fresh generation → its own token (see the transcribe path above). No
    // reset: a new turn cannot inherit a stale flag it never shared.
    //
    // `StopAndLock`: the composer's Stop targets the newest turn with a Stop
    // button, and this is the only surface that has one.
    let cancel_guard = cancel_state.begin(CancelReach::StopAndLock);
    let cancel = cancel_guard.token().clone();
    let request_cancel = cancel_guard.request_cancel();

    // 1. Embed the question off the async thread.
    let query_vec = {
        let engine = Arc::clone(&engine);
        let q = question.clone();
        tokio::task::spawn_blocking(move || engine.embed(&q))
            .await
            .map_err(|_| EngineError::EmbeddingFailed)??
    };

    // 2. Retrieve top-k (sync scan; host-side opt-in + excluded-folder gates, so
    //    a compromised WebView cannot ground on a disabled feature / excluded
    //    note — SYNC-14). AI off → empty answer, no model call.
    let hits = {
        let store = vector_state.lock();
        if !store.is_enabled() {
            return Ok(AskResult {
                answer: String::new(),
                sources: Vec::new(),
                served_by: served_by_of(&engine_state),
            });
        }
        retrieval::top_k_matches(&query_vec, &store, k, |id| store.is_note_excluded(id))
    };
    // Relevance gate: drop weakly-matching chunks so chit-chat / off-note
    // questions don't ground on — or cite — irrelevant notes. Below the
    // threshold the turn answers conversationally (rag's empty-context branch).
    // Tunable; MiniLM cosine for a genuinely relevant chunk is well above this.
    let hits: Vec<ScoredChunk> = hits
        .into_iter()
        .filter(|h| h.score >= CHAT_RELEVANCE_THRESHOLD)
        .collect();

    // 3. Read each unique source note body via the sanctioned decrypt path.
    let notes_dir = myne_core::paths::notes_dir_for(&app, vault_state.active_vault_id().await)
        .map_err(|_| EngineError::NotReady)?;
    let mut bodies: HashMap<NoteId, Zeroizing<String>> = HashMap::new();
    for h in &hits {
        if bodies.contains_key(&h.key.note_id) {
            continue;
        }
        if let Ok(body) = note_read_with_dir(
            notes_dir.clone(),
            vault_state.inner(),
            h.key.note_id.to_string(),
            &myne_core::vault_io::StdVaultIo,
            &myne_core::host::tauri_host::TauriHost::new(app.clone()),
        )
        .await
        {
            bodies.insert(h.key.note_id, Zeroizing::new(body));
        }
    }

    // 4. Resolve chunk texts (char-boundary-safe) + frame the grounded chat.
    let (chunk_texts, sources) = resolve_hit_texts(&hits, |id| bodies.get(id).map(|b| b.as_str()));
    let grounded = rag::frame_grounded_chat(
        &messages,
        &question,
        &chunk_texts,
        &sources.iter().map(|s| s.key).collect::<Vec<_>>(),
        rag::ChatBudget::default(),
    );
    // The budget keeps a prefix of `sources` (same order) — take that many for
    // citation, preserving the cosine score `frame_grounded_chat` drops.
    let cite_sources = to_search_hits(sources.into_iter().take(grounded.sources.len()).collect());

    // 5. Stream the assistant answer off the async thread. The guarded callback
    //    forwards each token to the channel unless a Stop/lock cancelled first.
    let system = grounded.system;
    let messages = grounded.messages;
    let channel = on_token;
    let answer = {
        let engine = Arc::clone(&generator);
        tokio::task::spawn_blocking(move || {
            let mut cb = guarded_on_token(&cancel, |t| {
                let _ = channel.send(t.to_string());
            });
            // The publish-guard above stops a STREAMING engine at its emit seam.
            // A provider does not stream — it blocks on one request and calls
            // back once with the whole reply — so the predicate handed here is
            // the only thing that can abort it mid-flight (#445), and it reads
            // this turn's token rather than "is anything cancelled".
            engine.chat_streaming_cancellable(
                system.as_str(),
                &messages,
                &mut cb,
                request_cancel.as_fn(),
            )
        })
        .await
        .map_err(|_| EngineError::InferenceFailed)??
    };

    Ok(AskResult {
        answer,
        sources: cite_sources,
        served_by: served_by_of(&engine_state),
    })
}

/// Signal the active streaming generation to stop (composer "Stop" — task 5).
/// Idempotent; a no-op when nothing is streaming. Sets the shared cancel flag
/// the running [`chat_stream`]'s guarded callback observes before its next send.
#[tauri::command]
pub async fn chat_stop(cancel_state: State<'_, CancelRegistry>) -> Result<(), EngineError> {
    // The composer's single Stop means "the generation I am looking at", which
    // is the newest in flight while chat is the only streaming surface. The
    // registry can already cancel any request by id, so a second streaming
    // surface needs an id on the wire and no redesign here. A no-op when
    // nothing is running — Stop on an idle composer is not an error.
    cancel_state.cancel_newest();
    Ok(())
}

/// What the host decided about one auto-tag request (MYND-651 task 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TagGate {
    /// Both switches on and the note is not in an AI-excluded folder.
    Allowed,
    /// `ai_enabled` and/or `auto_tag_enabled` is off — the feature does not run.
    OptedOut,
    /// The note lives in (or under) an `ai_excluded_folders` entry (SYNC-14).
    Excluded,
}

/// The auto-tag decision. Every input is read HERE, on the Rust side — none of
/// it is taken on the WebView's word, because a compromised WebView is not
/// trusted to stop calling (the same posture as [`semantic_search`]'s opt-in
/// check and [`transcribe`]'s `transcription_enabled` re-read).
///
/// `ai_enabled` is the AI beta opt-in and `auto_tag_enabled` the auto-tag switch
/// (both `vault.prefs`, §9.5.2); `folder` is the note's own `folder:` value
/// resolved from the DECRYPTED note rather than from a caller-supplied string,
/// and `excluded` is `ai_excluded_folders`.
///
/// Fail-closed by construction: the only path to [`TagGate::Allowed`] is both
/// switches on AND the folder outside every excluded entry. A prefs blob that
/// cannot be read decodes to defaults (§9.5.5) and both switches default OFF, so
/// an unreadable blob refuses rather than runs — the opposite of transcription's
/// deliberately fail-open switch, because auto-tag reads note bodies ambiently
/// and the user never asked for it. `threat-model.md` §7 states this gate is
/// re-read host-side before any model touch, and this is the code that makes it
/// true.
pub(crate) fn tag_gate(
    ai_enabled: bool,
    auto_tag_enabled: bool,
    folder: &str,
    excluded: &[String],
) -> TagGate {
    if !(ai_enabled && auto_tag_enabled) {
        return TagGate::OptedOut;
    }
    if folder_is_excluded(folder, excluded) {
        return TagGate::Excluded;
    }
    TagGate::Allowed
}

/// Suggest tags for an open note on the bundled auto-tag task-model (MYND-651).
/// Blocking, one-shot, RAM-only: the reply is tag TEXT the frontend parses and
/// ranks; nothing is persisted and no note is modified here (accepting a tag is
/// the frontend's explicit `note_save`, SYNC-17).
///
/// Two host-side gates run before any model touch, neither of them trusting the
/// caller ([`tag_gate`]):
///   1. `ai_enabled` **and** `auto_tag_enabled`, re-read from `vault.prefs` —
///      off → `NotReady`, with no decrypt and no engine call;
///   2. the note's `ai_excluded_folders` membership, resolved from the note's
///      OWN decrypted frontmatter (a caller-supplied folder would let a
///      compromised WebView tag an excluded note by lying) — excluded → an empty
///      reply, again with no engine call (SYNC-14, no explicit-action carve-out).
///
/// **Lowest-priority compute (task 4).** The pass never starts while a
/// user-initiated infer/transcribe/search is pending, and yields the compute
/// lock within a token if one arrives mid-generation; both surface as
/// [`EngineError::Deferred`], which is "ask again later", not "no tags". Opening
/// a note is unaffected either way — note-open decrypts a `MY01` blob and never
/// contends for the compute lock at all.
///
/// DENY-list: `prompt` carries note content and is `Zeroizing`-wrapped on the
/// first statement; neither it, the note body read for the folder, nor the tag
/// reply is ever logged.
#[tauri::command]
pub async fn suggest_tags<R: Runtime>(
    note_id: String,
    prompt: String,
    app: AppHandle<R>,
    vault_state: State<'_, VaultRuntimeState>,
    engine_state: State<'_, LocalInferenceState>,
    priority: State<'_, ComputePriority>,
) -> Result<String, EngineError> {
    // First statement: bound the prompt plaintext (it embeds the note body) to a
    // Zeroizing wrapper, so every gate's early return wipes the bytes.
    let prompt = Zeroizing::new(prompt);

    let prefs = crate::plugins::prefs::commands::prefs_read_from_host(
        &myne_core::host::tauri_host::TauriHost::new(app.clone()),
        vault_state.inner(),
        &myne_core::vault_io::StdVaultIo,
    )
    .await
    .map_err(|_| EngineError::NotReady)?;
    // Cheap switch check first, so a vault with auto-tag off never pays a note
    // decrypt for a feature that is not going to run. The authoritative decision
    // is still `tag_gate` below — this is an ordering optimisation, not a second
    // policy.
    if !(prefs.ai_enabled && prefs.auto_tag_enabled) {
        return Err(EngineError::NotReady);
    }

    // Resolve the note's folder from the note ITSELF via the sanctioned decrypt
    // path. Unreadable (bad id, missing blob, locked slot) → refuse: a folder we
    // cannot verify is one we cannot clear for AI.
    let notes_dir = myne_core::paths::notes_dir_for(&app, vault_state.active_vault_id().await)
        .map_err(|_| EngineError::NotReady)?;
    let folder = {
        let body = Zeroizing::new(
            note_read_with_dir(
                notes_dir,
                vault_state.inner(),
                note_id,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::tauri_host::TauriHost::new(app.clone()),
            )
            .await
            .map_err(|_| EngineError::NotReady)?,
        );
        folder_of(&body)
    };

    suggest_tags_with_engine(
        // Ambient (SYNC-14): the tag pass fires on save, not on a user's ask.
        engine_state.engine_for(RequestClass::Ambient)?,
        (*priority).clone(),
        tag_gate(
            prefs.ai_enabled,
            prefs.auto_tag_enabled,
            &folder,
            &prefs.ai_excluded_folders,
        ),
        prompt,
    )
    .await
}

/// Testable core of [`suggest_tags`]: honour the gate, then run the tag pass
/// under the lowest-priority compute policy. It re-checks `gate` rather than
/// assuming its caller already acted on it, so a `TagGate` value can be threaded
/// around without a refused note ever reaching the model by omission.
pub(crate) async fn suggest_tags_with_engine(
    engine: Arc<dyn Engine>,
    priority: ComputePriority,
    gate: TagGate,
    prompt: Zeroizing<String>,
) -> Result<String, EngineError> {
    match gate {
        TagGate::OptedOut => return Err(EngineError::NotReady),
        // Not an error: there is simply nothing to suggest for a note the user
        // put outside AI's reach. No model call, no engine touch.
        TagGate::Excluded => return Ok(String::new()),
        TagGate::Allowed => {}
    }
    // Pre-flight: a user-initiated call is pending, so don't even spawn the
    // blocking pass. `Deferred` tells the caller to retry, distinctly from the
    // empty reply above — a caller must never cache "no tags" for a note that
    // was never actually looked at.
    if priority.interactive_pending() {
        return Err(EngineError::Deferred);
    }
    // Mid-flight: the probe breaks generation the moment a user call arrives.
    // `yielded` records that it fired, because the engine's partial output is
    // indistinguishable from a short-but-complete tag list.
    let yielded = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&yielded);
    let mut probe = priority.tag_yield_probe();
    let joined = tokio::task::spawn_blocking(move || {
        engine.infer_tags(&prompt, &mut || {
            let flow = probe();
            if flow.is_break() {
                flag.store(true, Ordering::SeqCst);
            }
            flow
        })
    })
    .await;
    let out = unwrap_join(joined, EngineError::InferenceFailed, "suggest_tags")?;
    if yielded.load(Ordering::SeqCst) {
        return Err(EngineError::Deferred);
    }
    Ok(out)
}

/// Whether this build ships an auto-tag model (MYND-651). Cheap, synchronous,
/// and deliberately UNGATED: the answer is a property of the binary, not of the
/// vault — no prefs read, no note decrypt, nothing an unlocked slot is needed
/// for. A locked or absent vault answers the same as an unlocked one.
///
/// The settings surface calls it so the auto-tag switch can say "this build has
/// no tag model" instead of persisting `true` against a host that will answer
/// [`EngineError::NotReady`] forever. The tag role is bundled-only by design
/// (`threat-model.md` §7: no override picker), so a `false` here is not
/// something the user can fix by side-loading — which is exactly why the UI has
/// to say it rather than leave the user guessing.
///
/// This is NOT the enforcement point for anything: [`suggest_tags`] re-reads
/// both prefs switches and the folder gate host-side regardless of what any
/// caller learned here.
#[tauri::command]
pub fn tag_model_available(engine_state: State<'_, LocalInferenceState>) -> bool {
    engine_state.engine_unclassified().tag_model_available()
}

/// Record a user-picked model path for `role` device-locally (ai-ux-surface
/// task 4 / SYNC-1). Rejects a path inside the vault tree; returns the accepted
/// (normalized) path. Records where the user's file lives — does not copy it.
/// The path is the user's own dialog choice (shown in the AI settings panel),
/// not a secret; still never logged (DENY-list — only the closed error kind).
#[tauri::command]
pub async fn set_model_path<R: Runtime>(
    role: String,
    path: String,
    app: AppHandle<R>,
    engine_state: State<'_, LocalInferenceState>,
) -> Result<String, ModelStoreError> {
    let role = ModelRole::parse(&role).ok_or(ModelStoreError::InvalidRole)?;
    let base = crate::paths::app_data_dir(&app).map_err(|_| ModelStoreError::Io {
        kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    // Recording a model hashes the whole file (`set_selected_model`) — a
    // multi-gigabyte GGUF, or a FIFO/device path, would block the async runtime
    // executor for seconds/forever if hashed inline. Run it off the runtime.
    let path_buf = std::path::PathBuf::from(path);
    let accepted = tokio::task::spawn_blocking(move || {
        model_store::set_selected_model(&base, role, &path_buf)
    })
    .await
    .map_err(|_| ModelStoreError::Io {
        kind: crate::io_failure_kind::IoFailureKind::Other,
    })??;
    // EVERY arm, not the active one (myne-md/myne#440). A model path is a fact
    // about the locally side-loaded weights, and with a provider active the
    // active arm is the remote one — whose `invalidate_models` is the trait
    // no-op, so the in-process arm kept serving the old model while the
    // persisted index carried the new identity (§9.17.2).
    engine_state.invalidate_all_models();
    Ok(accepted.to_string_lossy().into_owned())
}

/// Read back the device-local model path for `role`, or `null` if none is set.
#[tauri::command]
pub async fn get_model_path<R: Runtime>(
    role: String,
    app: AppHandle<R>,
) -> Result<Option<String>, ModelStoreError> {
    let role = ModelRole::parse(&role).ok_or(ModelStoreError::InvalidRole)?;
    let base = crate::paths::app_data_dir(&app).map_err(|_| ModelStoreError::Io {
        kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    // Transcription resolves override-else-bundled (voice-to-text, MYND-270): the
    // UI readiness signal (`useAiModelReady`) then reports "ready" — and shows the
    // active model path — whenever the bundled default is present, not only after
    // a user override. Other roles are override-only (no bundled default).
    let resolved = match role {
        ModelRole::Transcription => {
            let bundled = app
                .path()
                .resource_dir()
                .ok()
                .and_then(|rd| model_store::bundled_transcription_model(&rd));
            model_store::effective_transcription_model(&base, bundled.as_deref())?
        }
        _ => model_store::selected_model(&base, role)?,
    };
    Ok(resolved.map(|p| p.to_string_lossy().into_owned()))
}

/// Testable core of [`infer`]: `Zeroizing`-wrap → `spawn_blocking` → trait.
///
/// `None` takes the unbounded path — the same `Engine::infer` call the command
/// made before #193 — rather than passing a "default" ceiling this layer would
/// then own. The engine's budget stays the engine's business.
pub(crate) async fn infer_with_engine(
    engine: Arc<dyn Engine>,
    prompt: String,
    max_new_tokens: Option<usize>,
    cancel: RequestCancel,
) -> Result<String, EngineError> {
    // First statement: bound the plaintext to a Zeroizing wrapper so every
    // early return (join failure, engine error) wipes the bytes.
    let prompt = Zeroizing::new(prompt);
    // `RequestCancel` and not a bare `CancelledFn` (myne-md/myne#445): the only
    // way to obtain one is from a registered `CancelGuard`, so a prompt cannot
    // reach a backend without a token the vault-lock teardown can find.
    let joined = tokio::task::spawn_blocking(move || {
        engine.infer_cancellable(&prompt, max_new_tokens, cancel.as_fn())
    })
    .await;
    unwrap_join(joined, EngineError::InferenceFailed, "infer")
}

/// Testable core of [`embed`].
pub(crate) async fn embed_with_engine(
    engine: Arc<dyn Engine>,
    text: String,
) -> Result<Vec<f32>, EngineError> {
    let text = Zeroizing::new(text);
    let joined = tokio::task::spawn_blocking(move || engine.embed(&text)).await;
    unwrap_join(joined, EngineError::EmbeddingFailed, "embed")
}

/// Collapse a `spawn_blocking` join into the engine result, logging (DENY-safe)
/// on failure. A join error (panicked/cancelled blocking task) maps to
/// `on_join_err`.
fn unwrap_join<T>(
    joined: Result<Result<T, EngineError>, tokio::task::JoinError>,
    on_join_err: EngineError,
    stage: &'static str,
) -> Result<T, EngineError> {
    match joined {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => {
            tracing::warn!(stage, error_kind = local_inference_error_kind(&e));
            Err(e)
        }
        Err(_join) => {
            tracing::warn!(
                stage,
                event = "join_failed",
                error_kind = local_inference_error_kind(&on_join_err)
            );
            Err(on_join_err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::engine::{StubEngine, STUB_EMBED_DIM};
    use super::*;

    /// A manual current-thread runtime — `spawn_blocking` works on it, and this
    /// avoids adding tokio's `macros` feature just for `#[tokio::test]`.
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("current-thread runtime")
    }

    /// A `RequestCancel` for a test that is not exercising cancellation.
    ///
    /// It still comes from a real registered guard, because that is the point of
    /// the type — there is deliberately no way to fabricate one (#445). The
    /// registry is leaked so the guard can outlive this call; a test process is
    /// exactly where that is free.
    fn uncancelled() -> RequestCancel {
        let reg: &'static CancelRegistry = Box::leak(Box::new(CancelRegistry::default()));
        Box::leak(Box::new(reg.begin(CancelReach::LockOnly))).request_cancel()
    }

    #[test]
    fn infer_command_core_round_trips_prompt_to_result() {
        let engine: Arc<dyn Engine> = Arc::new(StubEngine);
        let out = rt()
            .block_on(infer_with_engine(
                engine,
                "hello".to_string(),
                None,
                uncancelled(),
            ))
            .expect("stub infer never fails");
        assert!(out.contains("hello"));
    }

    /// Records which trait method the core reached, and with what ceiling — the
    /// bound is invisible from the returned string otherwise, and a ceiling that
    /// silently never arrives is exactly the #193 bug wearing a fix's shape.
    struct RecordingEngine {
        seen: Arc<std::sync::Mutex<Option<Option<usize>>>>,
    }

    impl Engine for RecordingEngine {
        fn infer(&self, _prompt: &str) -> Result<String, EngineError> {
            *self.seen.lock().expect("seen") = Some(None);
            Ok(String::new())
        }
        fn infer_bounded(
            &self,
            _prompt: &str,
            max_new_tokens: usize,
        ) -> Result<String, EngineError> {
            *self.seen.lock().expect("seen") = Some(Some(max_new_tokens));
            Ok(String::new())
        }
        fn embed(&self, _text: &str) -> Result<Vec<f32>, EngineError> {
            unreachable!("infer routing only")
        }
    }

    #[test]
    fn infer_command_core_routes_a_ceiling_to_the_bounded_path() {
        let seen = Arc::new(std::sync::Mutex::new(None));
        let engine: Arc<dyn Engine> = Arc::new(RecordingEngine { seen: seen.clone() });
        rt().block_on(infer_with_engine(
            engine,
            "hi".to_string(),
            Some(24),
            uncancelled(),
        ))
        .expect("recording engine never fails");
        assert_eq!(*seen.lock().expect("seen"), Some(Some(24)));
    }

    #[test]
    fn infer_command_core_leaves_an_unbounded_call_on_the_plain_path() {
        // The pre-#193 path must stay byte-identical for chat / `/devam`.
        let seen = Arc::new(std::sync::Mutex::new(None));
        let engine: Arc<dyn Engine> = Arc::new(RecordingEngine { seen: seen.clone() });
        rt().block_on(infer_with_engine(
            engine,
            "hi".to_string(),
            None,
            uncancelled(),
        ))
        .expect("recording engine never fails");
        assert_eq!(*seen.lock().expect("seen"), Some(None));
    }

    #[test]
    fn embed_command_core_round_trips_text_to_vector() {
        let engine: Arc<dyn Engine> = Arc::new(StubEngine);
        let v = rt()
            .block_on(embed_with_engine(engine, "hello".to_string()))
            .expect("stub embed never fails");
        assert_eq!(v.len(), STUB_EMBED_DIM);
    }

    #[test]
    fn error_kind_helper_is_deny_safe() {
        assert_eq!(
            local_inference_error_kind(&EngineError::InferenceFailed),
            "inference_failed"
        );
        // The MYND-591 transcribe-cause split: each carries a distinct,
        // content-free tag (the wire uses the bare variant name; these tags are
        // logging-only, but must stay pairwise-distinct and DENY-safe).
        assert_eq!(
            local_inference_error_kind(&EngineError::FeatureOff),
            "feature_off"
        );
        assert_eq!(
            local_inference_error_kind(&EngineError::VaultLocked),
            "vault_locked"
        );
        assert_eq!(
            local_inference_error_kind(&EngineError::NoModel),
            "no_model"
        );
        assert_eq!(
            local_inference_error_kind(&EngineError::ModelLoadFailed),
            "model_load_failed"
        );
    }

    /// The WIRING, not the primitive (myne-md/myne#445, the #440 lesson).
    ///
    /// Every assertion in `cancel.rs` and the two engines would stay green if a
    /// command here went back to handing its engine the fleet-wide flag — that
    /// revert compiles, and nothing types it. Two things make it visible:
    ///
    ///  1. `RequestCancel` cannot be fabricated (only a `CancelGuard` mints
    ///     one), which is why no command can call the core without registering;
    ///  2. this sweep, which is what catches a command that registers a token
    ///     and then polls something else anyway.
    ///
    /// A source sweep rather than a behavioural test because these are
    /// `#[tauri::command]`s taking `State<'_, …>` — there is no app to drive
    /// them against without a Tauri runtime, and a test that drove a *copy* of
    /// the body would assert about the copy.
    #[test]
    fn no_command_hands_an_engine_the_fleet_wide_cancel_flag() {
        let src = include_str!("commands.rs");
        let production = &src[..src.find("#[cfg(test)]").expect("test module")];
        assert!(
            !production.contains("any_cancelled"),
            "a command reached for the fleet-wide flag: cancelling one request \
             would abort every other in flight"
        );
        // Every surface that carries a prompt to a backend registers, so the
        // vault-lock teardown has something to find. Counted rather than merely
        // present: a command that quietly stops registering is the regression,
        // and `contains` would not see it.
        assert_eq!(
            production.matches(".begin(CancelReach::").count(),
            5,
            "expected exactly five registered surfaces — infer, infer_ambient, \
             transcribe, ask, chat_stream. A new prompt-bearing command owes a \
             registration; a vanished one is a request the lock cannot abort"
        );
    }

    #[test]
    fn to_search_hits_maps_note_id_range_and_score() {
        use super::super::vector_store::ChunkKey;
        use myne_core::plugins::notes::note_id::NoteId;

        let note = NoteId::parse("01970e83-4f2f-7000-8000-000000000051").unwrap();
        let scored = vec![ScoredChunk {
            key: ChunkKey {
                note_id: note,
                start: 4,
                end: 20,
            },
            score: 0.87,
        }];
        let hits = to_search_hits(scored);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, note.to_string());
        assert_eq!(hits[0].byte_start, 4);
        assert_eq!(hits[0].byte_end, 20);
        assert!((hits[0].score - 0.87).abs() < 1e-6);
    }

    #[test]
    fn resolve_hit_texts_slices_skips_missing_and_stale_ranges() {
        use super::super::vector_store::ChunkKey;
        use myne_core::plugins::notes::note_id::NoteId;

        let a = NoteId::parse("01970e83-4f2f-7000-8000-000000000061").unwrap();
        let missing = NoteId::parse("01970e83-4f2f-7000-8000-000000000062").unwrap();
        let hits = vec![
            // valid slice of note a
            ScoredChunk {
                key: ChunkKey {
                    note_id: a,
                    start: 0,
                    end: 5,
                },
                score: 1.0,
            },
            // body missing → skipped
            ScoredChunk {
                key: ChunkKey {
                    note_id: missing,
                    start: 0,
                    end: 5,
                },
                score: 0.9,
            },
            // stale range (out of bounds) → skipped
            ScoredChunk {
                key: ChunkKey {
                    note_id: a,
                    start: 0,
                    end: 999,
                },
                score: 0.8,
            },
        ];
        let body = "Hello world";
        let (texts, sources) =
            resolve_hit_texts(&hits, |id| if *id == a { Some(body) } else { None });
        assert_eq!(texts.len(), 1);
        assert_eq!(texts[0].as_str(), "Hello");
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].key.note_id, a);
    }

    #[test]
    fn resolve_hit_texts_skips_non_char_boundary_range() {
        use super::super::vector_store::ChunkKey;
        use myne_core::plugins::notes::note_id::NoteId;

        let a = NoteId::parse("01970e83-4f2f-7000-8000-000000000063").unwrap();
        // "😀" is 4 bytes; a range ending at byte 1 is mid-codepoint → skip.
        let hits = vec![ScoredChunk {
            key: ChunkKey {
                note_id: a,
                start: 0,
                end: 1,
            },
            score: 1.0,
        }];
        let (texts, sources) = resolve_hit_texts(&hits, |_| Some("😀"));
        assert!(texts.is_empty(), "mid-codepoint range must be skipped");
        assert!(sources.is_empty());
    }

    /// The tag prompt used across the gate tests. Real prompts embed the note
    /// body; nothing here is content, so nothing here is a DENY-list concern.
    fn tag_prompt() -> Zeroizing<String> {
        Zeroizing::new("Suggest tags for: standup notes".to_string())
    }

    #[test]
    fn the_auto_tag_gate_is_closed_unless_both_switches_are_on() {
        // Exhaustive over the two-key gate. The pairing is the point: a synced
        // `auto_tag_enabled: true` arriving on a device that never opted into AI
        // must still run nothing (the co-gate `ai_enabled` is device-local).
        let none: [String; 0] = [];
        assert_eq!(tag_gate(false, false, "", &none), TagGate::OptedOut);
        assert_eq!(tag_gate(true, false, "", &none), TagGate::OptedOut);
        assert_eq!(tag_gate(false, true, "", &none), TagGate::OptedOut);
        assert_eq!(tag_gate(true, true, "", &none), TagGate::Allowed);
    }

    #[test]
    fn an_ai_excluded_folder_is_refused_even_with_both_switches_on() {
        // SYNC-14 with no explicit-action carve-out (threat-model §7): auto-tag
        // is ambient, so an excluded note is never read by a model — not even
        // when the user is looking right at it.
        let excluded = vec!["Private/".to_string()];
        assert_eq!(
            tag_gate(true, true, "Private/", &excluded),
            TagGate::Excluded
        );
        // Nested beneath an excluded folder is excluded too…
        assert_eq!(
            tag_gate(true, true, "Private/Journal/", &excluded),
            TagGate::Excluded
        );
        // …and case/diacritic folding applies (the store's canonical matcher).
        assert_eq!(
            tag_gate(true, true, "private/", &excluded),
            TagGate::Excluded
        );
        // A mere prefix sibling is NOT excluded.
        assert_eq!(
            tag_gate(true, true, "PrivateStuff/", &excluded),
            TagGate::Allowed
        );
    }

    #[test]
    fn a_refused_pass_never_reaches_the_engine() {
        // The gate has to short-circuit BEFORE any model call — an engine that
        // panics on use is how that becomes a test rather than a claim.
        struct PanicEngine;
        impl Engine for PanicEngine {
            fn infer(&self, _p: &str) -> Result<String, EngineError> {
                panic!("gated-off pass must not reach the engine");
            }
            fn embed(&self, _t: &str) -> Result<Vec<f32>, EngineError> {
                panic!("gated-off pass must not reach the engine");
            }
            fn infer_tags(
                &self,
                _p: &str,
                _c: &mut dyn FnMut() -> std::ops::ControlFlow<()>,
            ) -> Result<String, EngineError> {
                panic!("gated-off pass must not reach the engine");
            }
        }
        let engine: Arc<dyn Engine> = Arc::new(PanicEngine);
        let pri = ComputePriority::default();
        let excluded = vec!["Private/".to_string()];

        // AI off → NotReady.
        let out = rt().block_on(suggest_tags_with_engine(
            Arc::clone(&engine),
            pri.clone(),
            tag_gate(false, true, "", &excluded),
            tag_prompt(),
        ));
        assert_eq!(out, Err(EngineError::NotReady));

        // auto-tag off → NotReady.
        let out = rt().block_on(suggest_tags_with_engine(
            Arc::clone(&engine),
            pri.clone(),
            tag_gate(true, false, "", &excluded),
            tag_prompt(),
        ));
        assert_eq!(out, Err(EngineError::NotReady));

        // Excluded folder → an empty reply, not an error, and still no model.
        let out = rt().block_on(suggest_tags_with_engine(
            engine,
            pri,
            tag_gate(true, true, "Private/Journal/", &excluded),
            tag_prompt(),
        ));
        assert_eq!(out, Ok(String::new()));
    }

    #[test]
    fn an_allowed_pass_returns_the_tag_models_reply() {
        let engine: Arc<dyn Engine> = Arc::new(StubEngine);
        let none: [String; 0] = [];
        let out = rt()
            .block_on(suggest_tags_with_engine(
                engine,
                ComputePriority::default(),
                tag_gate(true, true, "Work/", &none),
                tag_prompt(),
            ))
            .expect("stub tag pass never fails");
        // The TAG model's reply, not the generation model's.
        assert_eq!(out, "stub-tag, meeting, notes");
    }

    #[test]
    fn a_pending_user_call_defers_the_pass_before_it_spawns() {
        // Half one of the lowest-priority policy. The engine panics on use, so
        // `Deferred` proves the pass stood down rather than raced.
        struct PanicEngine;
        impl Engine for PanicEngine {
            fn infer(&self, _p: &str) -> Result<String, EngineError> {
                panic!("a deferred pass must not reach the engine");
            }
            fn embed(&self, _t: &str) -> Result<Vec<f32>, EngineError> {
                panic!("a deferred pass must not reach the engine");
            }
            fn infer_tags(
                &self,
                _p: &str,
                _c: &mut dyn FnMut() -> std::ops::ControlFlow<()>,
            ) -> Result<String, EngineError> {
                panic!("a deferred pass must not reach the engine");
            }
        }
        let pri = ComputePriority::default();
        let engine: Arc<dyn Engine> = Arc::new(PanicEngine);
        // A user-initiated infer/transcribe/search is in flight.
        let user_call = pri.interactive();
        let out = rt().block_on(suggest_tags_with_engine(
            engine,
            pri.clone(),
            TagGate::Allowed,
            tag_prompt(),
        ));
        assert_eq!(out, Err(EngineError::Deferred));

        // Once the user's call finishes, the pass runs normally — deferral is a
        // "later", not a permanent refusal.
        drop(user_call);
        let engine: Arc<dyn Engine> = Arc::new(StubEngine);
        let out = rt().block_on(suggest_tags_with_engine(
            engine,
            pri,
            TagGate::Allowed,
            tag_prompt(),
        ));
        assert_eq!(out, Ok("stub-tag, meeting, notes".to_string()));
    }

    #[test]
    fn a_user_call_arriving_mid_pass_yields_the_compute_lock() {
        // Half two: the pass is already generating when a user asks for
        // something. It must break out — and its partial text must NOT be
        // returned as if it were a finished suggestion set.
        use super::super::compute_priority::InteractiveGuard;
        use std::ops::ControlFlow;
        use std::sync::atomic::AtomicUsize;
        use std::sync::Mutex;

        /// Emits "tokens" up to a chat-sized budget, and stages a user-initiated
        /// call at step 3 — deterministically, from inside the generation loop,
        /// so the race the real world would have is not the thing under test.
        /// Every subsequent probe must break.
        struct GreedyEngine {
            pri: ComputePriority,
            steps: Arc<AtomicUsize>,
            user_call: Mutex<Option<InteractiveGuard>>,
        }
        impl Engine for GreedyEngine {
            fn infer(&self, _p: &str) -> Result<String, EngineError> {
                unreachable!("tag pass only")
            }
            fn embed(&self, _t: &str) -> Result<Vec<f32>, EngineError> {
                unreachable!("tag pass only")
            }
            fn infer_tags(
                &self,
                _p: &str,
                should_continue: &mut dyn FnMut() -> ControlFlow<()>,
            ) -> Result<String, EngineError> {
                let mut out = String::new();
                for _ in 0..BUDGET {
                    if should_continue().is_break() {
                        return Ok(out);
                    }
                    let n = self.steps.fetch_add(1, Ordering::SeqCst) + 1;
                    out.push_str("tag,");
                    if n == 3 {
                        // A user asks for a summarize mid-pass.
                        *self.user_call.lock().unwrap() = Some(self.pri.interactive());
                    }
                }
                Ok(out)
            }
        }
        const BUDGET: usize = 10_000;

        let pri = ComputePriority::default();
        let steps = Arc::new(AtomicUsize::new(0));
        let engine: Arc<dyn Engine> = Arc::new(GreedyEngine {
            pri: pri.clone(),
            steps: Arc::clone(&steps),
            user_call: Mutex::new(None),
        });

        let out = rt().block_on(suggest_tags_with_engine(
            engine,
            pri,
            TagGate::Allowed,
            tag_prompt(),
        ));

        assert_eq!(
            out,
            Err(EngineError::Deferred),
            "a yielded pass reports Deferred, never its partial text"
        );
        assert_eq!(
            steps.load(Ordering::SeqCst),
            3,
            "the pass broke out on the next token, not after its full budget"
        );
    }

    #[test]
    fn deferred_is_a_distinct_deny_safe_error_kind() {
        // The frontend has to tell "ask again later" apart from "no tags", and
        // the kind label stays content-free (DENY-list).
        assert_eq!(
            local_inference_error_kind(&EngineError::Deferred),
            "deferred"
        );
        assert_ne!(EngineError::Deferred, EngineError::NotReady);
    }

    #[test]
    fn chat_message_dto_maps_roles_leniently() {
        let u = ChatMessageDto {
            role: "user".into(),
            content: "a".into(),
        }
        .into_message();
        assert_eq!(u.role, ChatRole::User);
        assert_eq!(u.content, "a");

        let a = ChatMessageDto {
            role: "assistant".into(),
            content: "b".into(),
        }
        .into_message();
        assert_eq!(a.role, ChatRole::Assistant);

        // Unknown role → User (lenient; content is untrusted-tokenized anyway).
        let s = ChatMessageDto {
            role: "system".into(),
            content: "c".into(),
        }
        .into_message();
        assert_eq!(s.role, ChatRole::User);
    }

    // ---- list_provider_models: the gate runs BEFORE the socket -------------

    use std::sync::atomic::AtomicUsize;

    /// A fully-configured, consented, keyed vault — the only state in which a
    /// listing may reach the provider.
    fn listing_ready() -> protocol::PrefsView {
        protocol::PrefsView {
            ai_enabled: true,
            developer_mode: true,
            ai_provider: Some("openrouter".into()),
            ai_provider_consent: Some("openrouter".into()),
            ai_provider_key: Some(zeroize::Zeroizing::new("sk-test".into())),
            ..protocol::PrefsView::default()
        }
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }

    /// Every unconfigured state refuses **with the completion path's own
    /// cause**, and — the part an error-equality assertion cannot reach — the
    /// fetch is never invoked. The counter is the assertion; the error is a
    /// bonus. Modelled on `provider_gate::default_off_proof`, in-process
    /// because no socket needs to exist for the question to be meaningful.
    #[test]
    fn a_listing_reaches_nothing_until_all_five_preconditions_hold() {
        let cases: Vec<(&str, protocol::PrefsView, EngineError)> = vec![
            (
                "developer mode off",
                protocol::PrefsView {
                    developer_mode: false,
                    ..listing_ready()
                },
                EngineError::FeatureOff,
            ),
            (
                "AI beta off",
                protocol::PrefsView {
                    ai_enabled: false,
                    ..listing_ready()
                },
                EngineError::FeatureOff,
            ),
            (
                "no provider selected",
                protocol::PrefsView {
                    ai_provider: None,
                    ..listing_ready()
                },
                EngineError::NotReady,
            ),
            (
                "consent for a DIFFERENT provider",
                protocol::PrefsView {
                    ai_provider_consent: Some("ollama-cloud".into()),
                    ..listing_ready()
                },
                EngineError::RemoteBarred,
            ),
            (
                "no key",
                protocol::PrefsView {
                    ai_provider_key: None,
                    ..listing_ready()
                },
                EngineError::NoCredential,
            ),
        ];

        let calls = Arc::new(AtomicUsize::new(0));
        for (what, prefs, expected) in &cases {
            let seen = Arc::clone(&calls);
            let got = block_on(list_models_gated(
                prefs,
                prefs.developer_mode,
                move |_, _| {
                    seen.fetch_add(1, Ordering::SeqCst);
                    Ok(Vec::new())
                },
            ))
            .err();
            assert_eq!(got, Some(*expected), "{what}");
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "an unconfigured listing must reach the provider ZERO times",
        );

        // The control arm. Without it the zero above is compatible with a
        // closure that could never be called at all — the same reason
        // `rustls_transport.rs`'s probe insists on one.
        let seen = Arc::clone(&calls);
        let models = block_on(list_models_gated(&listing_ready(), true, move |p, key| {
            seen.fetch_add(1, Ordering::SeqCst);
            assert_eq!(key, "sk-test", "the gate hands the stored credential over");
            assert_eq!(p.models_path(), "/api/v1/models");
            Ok(br#"{"data":[{"id":"meta-llama/llama-3.1-8b"},{"id":"qwen/qwen3-30b"}]}"#.to_vec())
        }))
        .expect("a configured listing succeeds");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["meta-llama/llama-3.1-8b", "qwen/qwen3-30b"]
        );
        // Neither entry published an `architecture`, so both arrive usable —
        // the fail-open direction, asserted here as well as in the codec's own
        // tests because this is the path the panel actually reads.
        assert!(models.iter().all(|m| m.text_capable));
    }

    /// A transport failure arrives as the taxonomy the panel already renders,
    /// not as a generic error — the chooser distinguishes "your key is wrong"
    /// from "the provider is down" using the same arms the chat surface does.
    #[test]
    fn a_listing_failure_maps_onto_the_shared_taxonomy() {
        use super::super::provider_transport::ProviderTransportError as T;
        for (transport_err, expected) in [
            (T::Unauthorized, EngineError::Unauthorized),
            (T::QuotaExhausted, EngineError::QuotaExhausted),
            (T::Unreachable, EngineError::Unreachable),
        ] {
            let got = block_on(list_models_gated(&listing_ready(), true, move |_, _| {
                Err(transport_err)
            }))
            .err();
            assert_eq!(got, Some(expected));
        }
    }

    /// A provider that answers with something unparseable is a failure, never
    /// an empty list: an empty chooser reads as "this provider has no models",
    /// which is a different and wrong thing to tell the user.
    #[test]
    fn an_unparseable_listing_is_a_failure_not_an_empty_list() {
        let got = block_on(list_models_gated(&listing_ready(), true, |_, _| {
            Ok(b"<html>not json</html>".to_vec())
        }));
        assert_eq!(got.err(), Some(EngineError::InferenceFailed));
    }
}
