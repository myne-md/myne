// SPDX-License-Identifier: AGPL-3.0
//! `infer` Tauri commands (local-ai epic, MYND-406, task 6).
//!
//! The `#[tauri::command]`s are thin wrappers that extract the shared engine
//! from state and delegate to the testable async cores
//! [`infer_with_engine`]. The cores hold the
//! Plaintext-IPC discipline in exactly one place:
//!   - the prompt/text is `Zeroizing`-wrapped on the first statement, so every
//!     early-return path zeroes the bytes (`src-tauri/AGENTS.md` "Plaintext IPC
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

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use zeroize::Zeroizing;

use myne_core::plugins::attachments::extract_types::{ExtractStatus, SourceFormat};
use myne_core::plugins::notes::commands::note_read_with_dir;

use super::cancel::{guarded_on_token, CancelReach, CancelRegistry, CancelToken, RequestCancel};
use super::compute_priority::ComputePriority;
use super::download::{self, DownloadCancels, ModelDownloadCommandError};
use super::endpoint_config;
use super::engine::Engine;
use super::error::EngineError;
use super::model_store::{self, ModelRole, ModelStoreError};
use super::state::LocalInferenceState;
use super::state::RequestClass;
use crate::plugins::attachments::scheme_core::{decode_attachment_plaintext, ServeKeys};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use myne_core::plugins::agent::frontmatter::folder_of;
use myne_core::plugins::prefs::folder_scope::folder_is_excluded;

/// DENY-list-safe static label for structured logging (mirrors
/// `protocol_error_kind`): a new [`EngineError`] variant compile-fails
/// `EngineError::kind`, structurally catching drift.
pub fn local_inference_error_kind(e: &EngineError) -> &'static str {
    e.kind()
}

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

/// One-shot completion over an ORDERED BATCH of prompts, with progress and a
/// user-reachable Stop (meeting-ai task 2).
///
/// The meeting AI pass is a map-reduce: it summarizes several transcript chunks
/// and then reduces their summaries into the output sections. [`infer`] is
/// lock-only cancellable, so a pass over a long meeting could not be stopped by
/// the user; this command registers `StopAndLock` (like [`transcribe`]) so the
/// existing `chat_stop` reaches it, and emits the completed-prompt count on
/// `on_progress` so the UI can show a progress signal. Prompts run in order,
/// each bounded by `max_new_tokens` exactly as [`infer`] is.
///
/// A stop between prompts, or a stop the engine observes mid-generation, ends
/// the batch and returns the prompts that DID complete; the caller decides
/// whether a short result is a cancellation. Nothing here writes a note, so a
/// stopped batch cannot lose data.
#[tauri::command]
pub async fn infer_batch(
    prompts: Vec<String>,
    max_new_tokens: Option<usize>,
    on_progress: Channel<u32>,
    state: State<'_, LocalInferenceState>,
    vault_state: State<'_, VaultRuntimeState>,
    cancel_state: State<'_, CancelRegistry>,
    priority: State<'_, ComputePriority>,
) -> Result<Vec<String>, EngineError> {
    // User-initiated compute: a background auto-tag pass yields to this, the
    // same registration `infer` makes.
    let _interactive = priority.interactive();
    // Same vault authorization refresh as `infer` (myne-md/myne#437): the batch
    // carries note text, so it resolves against the CURRENTLY unlocked vault.
    if vault_state.active_vault_id().await.is_none() {
        return Err(EngineError::VaultLocked);
    }
    state.refresh().await;
    // `StopAndLock`: a batch's Stop rides `chat_stop` (there is no second stop
    // command), so it is one of the surfaces a composer Stop may reach. The
    // vault-lock teardown also reaches it, which is what keeps a locked vault's
    // transcript from being summarized behind the lock.
    let cancel_guard = cancel_state.begin(CancelReach::StopAndLock);
    infer_batch_with_engine(
        state.engine_for(INFER_CLASS)?,
        prompts,
        max_new_tokens,
        cancel_guard.request_cancel(),
        |done, _total| {
            let _ = on_progress.send(done);
        },
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
    pub transcription: FeatureStatus,
    pub auto_tag: FeatureStatus,
}

/// Build the report from resolved values — no `AppHandle`, so it is testable.
pub(super) fn capability_report_from(
    state: &LocalInferenceState,
    generation_model: bool,
    transcription_model: bool,
) -> AiCapabilityReport {
    // Generation and transcription are user-initiated; auto-tag carries the
    // SYNC-14 bar, so ask the seam rather than re-deriving the policy
    // here — a policy restated at a second site is a policy that will disagree.
    //
    // Each row asks the SAME engine its command will actually use
    // (myne-md/myne#438). The report used to take one unclassified engine for
    // every row, which is wrong in exactly the configuration the provider epic
    // added: the ambient/user-initiated split means the arm that answers
    // auto-tag is not the arm that answers generation.
    //
    // The disk-resolved rows also ask the engine whether it carries its
    // own weights (`Engine::carries_own_models`). A model file is evidence that
    // a role can be served, not the definition of it: the E2E stub answers
    // both from code with no file anywhere, and asking only the disk reported
    // `NoModel` for a build whose AI demonstrably works — which is what left
    // every AI scenario driving a surface stuck in its empty state. `auto_tag`
    // below is the row that already asked the engine, and the row that already
    // worked.
    // **The local reading is computed FIRST, and its `ok()` wins** (myne-md/myne#867
    // review). `remote_refusal` answers "why is the named provider not the arm
    // that answers", which is NOT the question this row asks. `active()` falls
    // back to the LOCAL arm for every one of those causes, so a vault with a
    // working local engine and a half-configured provider serves generation
    // locally, while a report that took the refusal first said
    // `available: false` about a surface that still answers.
    //
    // The refusal is the better CAUSE only where the local arm cannot serve
    // either, and there it is strictly more useful: it names what the user can
    // act on (accept the consent, paste the key, choose a model) instead of the
    // local arm's own `NoModel`, which is not the reason they cannot send.
    let local_generation = match state.engine_for(RequestClass::UserInitiated) {
        Err(cause) => FeatureStatus::blocked(cause),
        // A locally side-loaded GGUF is required only by the in-process arm.
        // A remote provider or a loopback runtime BRINGS ITS OWN model,
        // which is the entire point of naming one. Reporting `NoModel`
        // there told a user whose generation demonstrably works that the
        // feature is unavailable.
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
    // A NAMED provider whose remote arm is not answering says WHY, in the one
    // case where the local arm cannot answer either (myne-md/myne#867). Without
    // this branch the four ways a named provider can be unusable (the beta off,
    // no key, no consent, no model chosen) all fell through to the local arm's
    // `NoModel`, and the chat header rendered every one of them as "No provider"
    // on a vault whose provider was named. The gate already computes the right
    // `EngineError`; `LocalInferenceState::remote_refusal` is what stopped
    // discarding it.
    let generation = if local_generation.available {
        local_generation
    } else {
        match state.remote_refusal() {
            Some(cause) => FeatureStatus::blocked(cause),
            None => local_generation,
        }
    };
    // Transcription reads the LOCAL door, because that is the door the
    // `transcribe` command itself uses: speech-to-text is a bundled local
    // model, and a named text-generation provider neither serves it nor should
    // make the report claim it is gone. A report that answers a different
    // question than the command is worse than no report.
    let transcription = match state.local_engine() {
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
/// [`authorize_remote`](super::provider_gate::authorize_remote): the AI beta, a
/// selected provider, a stored key, and consent naming that provider. All four,
/// re-read here rather than trusted from the panel, asking a provider "what
/// models do you have" over an authenticated connection tells that provider
/// this account exists and is active, which is exactly the kind of byte #414's
/// invariant is about. It was five until myne-md/myne#456 dropped
/// `developer_mode` from the gate; the count is stated here rather than left to
/// the reader precisely so it cannot drift from the gate again.
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
    super::provider_registry::list_models_gated(&prefs, |provider, key| {
        let transport = super::provider_transport::ProviderTransport::new(provider.host());
        transport.get_json(provider, key)
    })
    .await
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

/// Transcribe an audio attachment to text (voice-to-text, MYND-550; SYNC-V3/V5/V6).
///
/// Decrypts the `MYA1` blob in RAM (the `attachment://` serve seam's
/// [`decode_attachment_plaintext`]), decodes WAV → 16 kHz mono
/// ([`super::audio::wav_to_mono_16k`]), then runs the ASR engine under
/// `spawn_blocking`, streaming each newly-decoded segment over `on_segment` and
/// returning the full transcript. Host-side `transcription_enabled`-gated (a
/// compromised WebView is not trusted to stop calling — the same posture as
/// [`transcribe`]'s own switch: speech-to-text is a product
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
    // MYND-592: this used to consult the AI beta opt-in
    // (`ai_enabled`), which transcription has nothing
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
        Some((items_key, items_key_id, shared)) => ServeKeys {
            items_key,
            items_key_id,
            shared,
        },
        None => return Err(EngineError::VaultLocked),
    };
    let active_id = vault_state.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root_io(&app, active_id)
        .map_err(|_| EngineError::TranscriptionFailed)?;

    // Transcription is LOCAL only: the strict accessor never hands back a
    // remote backend, because the ASR model is bundled and a named
    // text-generation provider neither serves it nor should be asked to.
    let engine = engine_state.local_engine()?;
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
        // `?` through `From<AudioError>` (`error.rs`), which is exhaustive, so a
        // new decode failure stops the build there rather than collapsing into
        // `TranscriptionFailed` silently (myne#510).
        let pcm = Zeroizing::new(super::audio::wav_to_mono_16k(&wav)?);
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
            &keys.shared,
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
) -> Option<(
    protocol::MetaVersion,
    [u8; protocol::VAULT_META_ACCOUNT_HASH_LEN],
)> {
    let bytes = std::fs::read(vault_dir.join("vault.meta")).ok()?;
    let version = protocol::meta_version_of(&bytes).unwrap_or(protocol::MetaVersion::V0_1);
    // Either generation (myne-md/myne#433).
    protocol::parse_vault_meta_any(&bytes)
        .map(|m| (version, m.account_number_hash))
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
    shared: &crate::plugins::vault_unlock::state::SharedSingletonKey,
    attachment_id_hex: &str,
    transcript: &str,
    app: &AppHandle<R>,
) {
    let Some(attachment_id) =
        myne_core::plugins::attachments::commands::hex_decode_id(attachment_id_hex)
    else {
        return;
    };
    let Some((version, account_number_hash)) = read_account_number_hash(vault_dir) else {
        return;
    };
    let model_hash = super::model_store::transcription_model_hash_for(app);
    let attachment_text_key = shared.derive(version, protocol::SubkeyRole::AttachmentTextKey);
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
    let Some(shared) = vault_state.peek_unlocked_shared_singleton_key().await else {
        return Err(EngineError::NotReady);
    };
    let active_id = vault_state.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root_io(&app, active_id)
        .map_err(|_| EngineError::TranscriptionFailed)?;
    // Decrypt + decode the cache off the async thread (the KEK moves into the
    // closure and drops on exit).
    let transcript = tokio::task::spawn_blocking(move || -> Option<String> {
        read_cached_transcript(&vault_dir, &shared, &attachment_id)
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
    shared: &crate::plugins::vault_unlock::state::SharedSingletonKey,
    attachment_id_hex: &str,
) -> Option<String> {
    let attachment_id =
        myne_core::plugins::attachments::commands::hex_decode_id(attachment_id_hex)?;
    let (version, account_number_hash) = read_account_number_hash(vault_dir)?;
    let attachment_text_key = shared.derive(version, protocol::SubkeyRole::AttachmentTextKey);
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

/// Signal the active streaming generation to stop (transcription's "Stop").
/// Idempotent; a no-op when nothing is streaming. Sets the shared cancel flag
/// the running generation's guarded callback observes before its next send.
#[tauri::command]
pub async fn chat_stop(cancel_state: State<'_, CancelRegistry>) -> Result<(), EngineError> {
    // The single Stop means "the generation I am looking at", which is the
    // newest in flight. The registry can already cancel any request by id, so
    // a second streaming surface needs an id on the wire and no redesign
    // here. A no-op when nothing is running — Stop while idle is not an error.
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
/// trusted to stop calling (the same posture as [`transcribe`]'s opt-in
/// check).
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
    if folder_is_excluded(Some(folder), excluded) {
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
/// The settings surface calls it so the auto-tag switch can say "no tag model
/// installed yet" instead of persisting `true` against a host that will answer
/// [`EngineError::NotReady`] forever. Since myne-md/myne#805 the tag role is
/// selectable: the user can download it or side-load it, and this probe
/// re-resolves the stored override at call time, so a `false` here is something
/// the UI tells the user how to fix rather than a permanent state.
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

/// Remove a model for `role` (myne-md/myne#805). A downloaded bundle under the
/// app's `models/` directory is deleted; a side-loaded file elsewhere on disk is
/// only unregistered, never deleted. The engine's caches are invalidated so the
/// next call sees the absence rather than serving the removed weights.
#[tauri::command]
pub async fn remove_model<R: Runtime>(
    role: String,
    app: AppHandle<R>,
    engine_state: State<'_, LocalInferenceState>,
) -> Result<(), ModelStoreError> {
    let role = ModelRole::parse(&role).ok_or(ModelStoreError::InvalidRole)?;
    let base = crate::paths::app_data_dir(&app).map_err(|_| ModelStoreError::Io {
        kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    // Invalidate BEFORE deleting: a model may be memory-mapped
    // (`VarBuilder::from_mmaped_safetensors`), so on a platform that refuses to
    // delete a file that is still mapped the delete would fail and leave the
    // engine cached on the stale weights. Dropping the cache first releases the
    // mapping.
    engine_state.invalidate_all_models();
    // Deletion touches the filesystem; keep it off the async executor.
    tokio::task::spawn_blocking(move || model_store::remove_selected_model(&base, role))
        .await
        .map_err(|_| ModelStoreError::Io {
            kind: crate::io_failure_kind::IoFailureKind::Other,
        })??;
    Ok(())
}

/// Backend event name for on-demand model download progress
/// (myne-md/myne#814). Payload is [`ModelDownloadProgress`].
pub const MODEL_DOWNLOAD_PROGRESS_EVENT: &str = "local-inference://model-download-progress";

/// Progress payload: the caller-minted download id, the artefact id, and the
/// bytes written so far against the artefact's approximate total. Counts and
/// two already UI-facing ids only, so it is DENY-list clean.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadProgress {
    pub download_id: String,
    pub artifact: String,
    pub downloaded: u64,
    pub total: u64,
}

/// Download a model artefact on explicit user action, verifying every file
/// against the digest compiled into this binary before registering it
/// (myne-md/myne#805, `decisions/ai/0627`).
///
/// `artifact` is an id from the compiled-in table; `download_id` is minted by
/// the calling surface so [`cancel_model_download`] can target exactly this
/// fetch. The socket, TLS and Tor routing live in
/// `myne_core::inference::model_download`; this command owns the table lookup,
/// the staging directory and the register step. Blocking (network + hashing +
/// atomic rename), so it runs off the async runtime.
#[tauri::command]
pub async fn download_model<R: Runtime>(
    artifact: String,
    download_id: String,
    app: AppHandle<R>,
    cancels: State<'_, DownloadCancels>,
    engine_state: State<'_, LocalInferenceState>,
) -> Result<String, ModelDownloadCommandError> {
    let artifact =
        download::artifact_by_id(&artifact).ok_or(ModelDownloadCommandError::UnknownArtifact)?;
    let base = crate::paths::app_data_dir(&app).map_err(|_| {
        ModelDownloadCommandError::Store(ModelStoreError::Io {
            kind: crate::io_failure_kind::IoFailureKind::Other,
        })
    })?;
    let (token, guard) = cancels.begin(&download_id);
    let cancelled = download::cancelled_fn(&token);
    // A clone for the blocking task: the original stays borrowed by the guard.
    let staging_id = download_id.clone();
    // Progress to the WebView, throttled to one event per ~120 ms (plus the
    // first and the final frame) so a 450 MB fetch does not emit thousands of
    // IPC events. Best-effort: a failed emit only drops a frame.
    let progress: download::DownloadProgressFn = {
        let emitter = app.clone();
        // A clone, because `download_id` is still borrowed by `guard` for the
        // whole command and cannot be moved into this closure.
        let progress_download_id = download_id.clone();
        let artifact_id = artifact.id.to_string();
        let total = artifact.approx_total_bytes;
        let last = Arc::new(Mutex::new(None::<std::time::Instant>));
        Arc::new(move |downloaded: u64| {
            let now = std::time::Instant::now();
            {
                let mut last = last.lock().expect("download progress throttle poisoned");
                let at_end = downloaded >= total;
                let due = match *last {
                    None => true,
                    Some(t) => now.duration_since(t) >= std::time::Duration::from_millis(120),
                };
                if !at_end && !due {
                    return;
                }
                *last = Some(now);
            }
            let _ = emitter.emit(
                MODEL_DOWNLOAD_PROGRESS_EVENT,
                ModelDownloadProgress {
                    download_id: progress_download_id.clone(),
                    artifact: artifact_id.clone(),
                    downloaded,
                    total,
                },
            );
        })
    };
    // Drop the cached engine models BEFORE the install renames the previous
    // bundle aside: a memory-mapped model can make the OS refuse the
    // rename on some platforms, so release the mapping first, exactly as
    // `remove_model` does.
    engine_state.invalidate_all_models();
    // Keep a handle to the progress emitter and the approximate total so a
    // GUARANTEED final frame can be emitted after the fetch (myne-md/myne#826).
    // `download_and_install` reports the write count clamped to `total`, so an
    // overestimated `approx_total_bytes` means the count never reaches `total`,
    // `at_end` stays false, and the "final frame" the comment above promises can
    // be swallowed by the 120 ms throttle.
    let final_progress = progress.clone();
    let final_total = artifact.approx_total_bytes;
    let joined = tokio::task::spawn_blocking(move || {
        download::download_and_install(&base, artifact, &staging_id, &cancelled, &progress)
    })
    .await;
    drop(guard);
    let installed = joined.map_err(|_| {
        ModelDownloadCommandError::Store(ModelStoreError::Io {
            kind: crate::io_failure_kind::IoFailureKind::Other,
        })
    })??;
    // Force one last frame at 100% now that the fetch has completed, so the bar
    // never freezes below 100% while the invoke resolves.
    final_progress(final_total);
    // Invalidate again so a model that loaded between the pre-invalidate and the
    // rename is dropped too.
    engine_state.invalidate_all_models();
    Ok(installed.to_string_lossy().into_owned())
}

/// Cancel an in-flight [`download_model`] by the id its surface minted. Returns
/// `false` when no such download is in flight.
#[tauri::command]
pub fn cancel_model_download(download_id: String, cancels: State<'_, DownloadCancels>) -> bool {
    cancels.cancel(&download_id)
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

/// Testable core of [`infer_batch`]: run the prompts in order, checking the
/// shared cancel flag between them and handing it to each engine call, and
/// reporting the completed count after each. A cancelled batch returns the
/// prompts that completed rather than an error, so a user stop is distinguishable
/// from a failure; any other engine error propagates.
pub(crate) async fn infer_batch_with_engine(
    engine: Arc<dyn Engine>,
    prompts: Vec<String>,
    max_new_tokens: Option<usize>,
    cancel: RequestCancel,
    mut on_progress: impl FnMut(u32, u32),
) -> Result<Vec<String>, EngineError> {
    let total = prompts.len() as u32;
    // Wrap EVERY prompt before the loop, so the ones a stop leaves unprocessed
    // are zeroized when the iterator drops rather than merely deallocated. The
    // per-iteration wrap below covered only the in-flight prompt; the `break`
    // paths dropped the rest as ordinary `String`s.
    let prompts: Vec<Zeroizing<String>> = prompts.into_iter().map(Zeroizing::new).collect();
    let mut out = Vec::with_capacity(prompts.len());
    for (index, prompt) in prompts.into_iter().enumerate() {
        if cancel.as_fn()() {
            break;
        }
        let cancel_fn = cancel.as_fn().clone();
        let engine_for_call = Arc::clone(&engine);
        let joined = tokio::task::spawn_blocking(move || {
            engine_for_call.infer_cancellable(&prompt, max_new_tokens, &cancel_fn)
        })
        .await;
        match unwrap_join(joined, EngineError::InferenceFailed, "infer_batch") {
            Ok(text) => {
                out.push(text);
                on_progress(index as u32 + 1, total);
            }
            Err(e) => {
                // A stop the engine observed mid-generation is not a failure:
                // return what completed. Any other error is.
                if cancel.as_fn()() {
                    break;
                }
                return Err(e);
            }
        }
    }
    Ok(out)
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
    use super::super::engine::StubEngine;
    use super::*;

    /// The two states the one `NotReady` refusal used to cover
    /// (myne-md/myne#545), and the reason splitting them matters: each names a
    /// different next step, and the sentence the user got named neither.
    /// A 400 is the provider declining the REQUEST, and it must not arrive as
    /// the generic failure that `agent_error_of` then renders as a note that
    /// could not be read (myne-md/myne#547).
    #[test]
    fn a_bad_request_is_its_own_cause_rather_than_the_generic_exchange_failure() {
        use super::super::provider_registry::engine_error_of;
        use super::super::provider_transport::{status_cause, ProviderTransportError as T};

        assert_eq!(status_cause(400), T::RequestRejected);
        assert_eq!(
            engine_error_of(T::RequestRejected),
            EngineError::RequestRejected
        );
        // The three neighbours keep their own meanings, so the new arm cannot
        // have been added by widening one of them.
        assert_eq!(status_cause(401), T::Unauthorized);
        assert_eq!(status_cause(429), T::QuotaExhausted);
        assert_eq!(status_cause(500), T::Exchange);
        assert_ne!(
            EngineError::RequestRejected.kind(),
            EngineError::InferenceFailed.kind()
        );
    }

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
    fn infer_batch_runs_prompts_in_order_and_reports_progress() {
        let engine: Arc<dyn Engine> = Arc::new(StubEngine);
        let mut progress = Vec::new();
        let out = rt()
            .block_on(infer_batch_with_engine(
                engine,
                vec!["one".to_string(), "two".to_string(), "three".to_string()],
                None,
                uncancelled(),
                |done, total| progress.push((done, total)),
            ))
            .expect("stub never fails");
        assert_eq!(out.len(), 3);
        assert!(out[0].contains("one"));
        assert!(out[2].contains("three"));
        assert_eq!(progress, vec![(1, 3), (2, 3), (3, 3)]);
    }

    #[test]
    fn infer_batch_stops_when_the_token_is_already_cancelled() {
        let reg: &'static CancelRegistry = Box::leak(Box::new(CancelRegistry::default()));
        let guard = Box::leak(Box::new(reg.begin(CancelReach::LockOnly)));
        guard.token().cancel();
        let engine: Arc<dyn Engine> = Arc::new(StubEngine);
        let out = rt()
            .block_on(infer_batch_with_engine(
                engine,
                vec!["a".to_string(), "b".to_string()],
                None,
                guard.request_cancel(),
                |_, _| {},
            ))
            .expect("a stop is not an error");
        assert!(out.is_empty(), "an already-cancelled batch runs nothing");
    }

    /// Fails every call, to prove a real engine error is NOT swallowed as a
    /// cancellation.
    struct FailingEngine;

    impl Engine for FailingEngine {
        fn infer(&self, _prompt: &str) -> Result<String, EngineError> {
            Err(EngineError::NoModel)
        }
    }

    #[test]
    fn infer_batch_propagates_a_non_cancel_engine_error() {
        let engine: Arc<dyn Engine> = Arc::new(FailingEngine);
        let err = rt()
            .block_on(infer_batch_with_engine(
                engine,
                vec!["a".to_string()],
                None,
                uncancelled(),
                |_, _| {},
            ))
            .expect_err("NoModel must propagate rather than read as a stop");
        assert_eq!(err, EngineError::NoModel);
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
            4,
            "expected exactly four registered surfaces: infer, infer_ambient, \
             infer_batch, transcribe. A new prompt-bearing command owes a \
             registration; a vanished one is a request the lock cannot abort"
        );
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
}
