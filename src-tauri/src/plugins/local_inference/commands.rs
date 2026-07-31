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

use super::cancel::{guarded_on_token, CancelToken};
use super::compute_priority::ComputePriority;
use super::engine::{ChatMessage, ChatRole, Engine};
use super::error::EngineError;
use super::hydrate::{folder_is_excluded, folder_of};
use super::model_store::{self, ModelRole, ModelStoreError};
use super::rag;
use super::retrieval::{self, ScoredChunk};
use super::state::LocalInferenceState;
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
#[tauri::command]
pub async fn infer(
    prompt: String,
    state: State<'_, LocalInferenceState>,
    priority: State<'_, ComputePriority>,
) -> Result<String, EngineError> {
    // A user asked for this. Register for the whole call so a background
    // auto-tag pass stands down rather than making the user queue behind it
    // (MYND-651 task 4) — held across the await, dropped on every return path.
    let _interactive = priority.interactive();
    infer_with_engine(state.engine(), prompt).await
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
    embed_with_engine(state.engine(), text).await
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
    cancel: State<'_, CancelToken>,
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
    .map_err(|_| EngineError::NotReady)?;
    if !prefs.transcription_enabled {
        return Err(EngineError::NotReady);
    }
    // Fresh cancel window (a prior Stop must not abort this run).
    cancel.reset();

    // Resolve the unlocked slot's key material + the active vault dir. This is
    // the only place with `.await` access to the slot map (mirror the
    // `attachment://` serve path).
    let keys = match vault_state.peek_unlocked_attachment_material().await {
        Some((items_key, items_key_id, root_key)) => ServeKeys {
            items_key,
            items_key_id,
            root_key,
        },
        None => return Err(EngineError::NotReady),
    };
    let active_id = vault_state.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root_io(&app, active_id)
        .map_err(|_| EngineError::TranscriptionFailed)?;

    let engine = engine_state.engine();
    let cancel_token: CancelToken = (*cancel).clone();
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

    Ok(transcript)
}

/// Read `vault.meta`'s `account_number_hash` (the AAD binding for the
/// attachment-text cache; § 9.3 offset 6). `None` on IO / parse failure. The
/// bytes are a vault-stable correlation tag — used, never logged (DENY-list).
fn read_account_number_hash(
    vault_dir: &Path,
) -> Option<[u8; protocol::VAULT_META_ACCOUNT_HASH_LEN]> {
    let bytes = std::fs::read(vault_dir.join("vault.meta")).ok()?;
    protocol::parse_vault_meta(&bytes)
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
    let engine = engine_state.engine();
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

/// A grounded Q&A answer crossing IPC (semantic-search-qa tasks 6 + 7): the
/// answer text plus the source chunks it was grounded on, for citation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AskResult {
    pub answer: String,
    pub sources: Vec<SearchHit>,
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
pub async fn ask<R: Runtime>(
    question: String,
    k: usize,
    app: AppHandle<R>,
    vault_state: State<'_, VaultRuntimeState>,
    engine_state: State<'_, LocalInferenceState>,
    vector_state: State<'_, LocalInferenceVectorState>,
    priority: State<'_, ComputePriority>,
) -> Result<AskResult, EngineError> {
    let question = Zeroizing::new(question);
    // User-initiated: covers BOTH model calls below (embed + generate), so a
    // background auto-tag pass cannot slip between them (MYND-651 task 4).
    let _interactive = priority.interactive();
    let engine = engine_state.engine();

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
            });
        }
        retrieval::top_k_matches(&query_vec, &store, k, |id| store.is_note_excluded(id))
    };
    if hits.is_empty() {
        // Nothing resident to ground on — no model call, empty answer.
        return Ok(AskResult {
            answer: String::new(),
            sources: Vec::new(),
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

    // 5. Generate off the async thread (blocking, no stream).
    let answer = {
        let engine = Arc::clone(&engine);
        tokio::task::spawn_blocking(move || engine.infer(prompt.as_str()))
            .await
            .map_err(|_| EngineError::InferenceFailed)??
    };

    Ok(AskResult {
        answer,
        sources: to_search_hits(sources),
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
    cancel_state: State<'_, CancelToken>,
    priority: State<'_, ComputePriority>,
) -> Result<AskResult, EngineError> {
    // First statement: bound the question plaintext to a Zeroizing wrapper.
    let question = Zeroizing::new(question);
    // User-initiated: registered for the whole turn, including the streamed
    // generation, which is the longest compute hold in the app (MYND-651 task 4).
    let _interactive = priority.interactive();
    let engine = engine_state.engine();
    let messages: Vec<ChatMessage> = history
        .into_iter()
        .map(ChatMessageDto::into_message)
        .collect();

    // Fresh generation → clear any prior Stop signal.
    let cancel = cancel_state.inner().clone();
    cancel.reset();

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
        let engine = Arc::clone(&engine);
        tokio::task::spawn_blocking(move || {
            let mut cb = guarded_on_token(&cancel, |t| {
                let _ = channel.send(t.to_string());
            });
            engine.chat_streaming(system.as_str(), &messages, &mut cb)
        })
        .await
        .map_err(|_| EngineError::InferenceFailed)??
    };

    Ok(AskResult {
        answer,
        sources: cite_sources,
    })
}

/// Signal the active streaming generation to stop (composer "Stop" — task 5).
/// Idempotent; a no-op when nothing is streaming. Sets the shared cancel flag
/// the running [`chat_stream`]'s guarded callback observes before its next send.
#[tauri::command]
pub async fn chat_stop(cancel_state: State<'_, CancelToken>) -> Result<(), EngineError> {
    cancel_state.cancel();
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

/// The host-side inputs to the auto-tag decision. Every field is read HERE, on
/// the Rust side — none of it is taken on the WebView's word, because a
/// compromised WebView is not trusted to stop calling (the same posture as
/// [`semantic_search`]'s opt-in check and [`transcribe`]'s `transcription_enabled`
/// re-read).
pub(crate) struct TagPolicy<'a> {
    /// `vault.prefs` `ai_enabled` — the AI beta opt-in (§9.5.2).
    pub ai_enabled: bool,
    /// `vault.prefs` `auto_tag_enabled` — the auto-tag switch (§9.5.2). Both
    /// must be on; `threat-model.md` §7 states this gate is re-read host-side
    /// before any model touch, and this is the code that makes it true.
    pub auto_tag_enabled: bool,
    /// The note's own `folder:` frontmatter value, resolved from the DECRYPTED
    /// note rather than from a caller-supplied string.
    pub folder: &'a str,
    /// `vault.prefs` `ai_excluded_folders`.
    pub excluded: &'a [String],
}

impl TagPolicy<'_> {
    /// Fail-closed by construction: the only path to [`TagGate::Allowed`] is
    /// both switches on AND the folder outside every excluded entry. A prefs
    /// blob that cannot be read decodes to defaults (§9.5.5) and both switches
    /// default OFF, so an unreadable blob refuses rather than runs — the
    /// opposite of transcription's deliberately fail-open switch, because
    /// auto-tag reads note bodies ambiently and the user never asked for it.
    pub(crate) fn decide(&self) -> TagGate {
        if !(self.ai_enabled && self.auto_tag_enabled) {
            return TagGate::OptedOut;
        }
        if folder_is_excluded(self.folder, self.excluded) {
            return TagGate::Excluded;
        }
        TagGate::Allowed
    }
}

/// Suggest tags for an open note on the bundled auto-tag task-model (MYND-651).
/// Blocking, one-shot, RAM-only: the reply is tag TEXT the frontend parses and
/// ranks; nothing is persisted and no note is modified here (accepting a tag is
/// the frontend's explicit `note_save`, SYNC-17).
///
/// Two host-side gates run before any model touch, neither of them trusting the
/// caller ([`TagPolicy::decide`]):
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
    // is still `TagPolicy::decide` below — this is an ordering optimisation, not
    // a second policy.
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

    let policy = TagPolicy {
        ai_enabled: prefs.ai_enabled,
        auto_tag_enabled: prefs.auto_tag_enabled,
        folder: &folder,
        excluded: &prefs.ai_excluded_folders,
    };
    suggest_tags_with_engine(
        engine_state.engine(),
        (*priority).clone(),
        policy.decide(),
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
    // Drop any model the engine already cached so the next infer/embed loads the
    // newly selected weights — otherwise the process keeps serving the old model
    // while the persisted index is labeled with the new identity (§9.17.2).
    engine_state.engine().invalidate_models();
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
pub(crate) async fn infer_with_engine(
    engine: Arc<dyn Engine>,
    prompt: String,
) -> Result<String, EngineError> {
    // First statement: bound the plaintext to a Zeroizing wrapper so every
    // early return (join failure, engine error) wipes the bytes.
    let prompt = Zeroizing::new(prompt);
    let joined = tokio::task::spawn_blocking(move || engine.infer(&prompt)).await;
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

    #[test]
    fn infer_command_core_round_trips_prompt_to_result() {
        let engine: Arc<dyn Engine> = Arc::new(StubEngine);
        let out = rt()
            .block_on(infer_with_engine(engine, "hello".to_string()))
            .expect("stub infer never fails");
        assert!(out.contains("hello"));
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

    fn policy<'a>(ai: bool, auto: bool, folder: &'a str, excluded: &'a [String]) -> TagPolicy<'a> {
        TagPolicy {
            ai_enabled: ai,
            auto_tag_enabled: auto,
            folder,
            excluded,
        }
    }

    #[test]
    fn the_auto_tag_gate_is_closed_unless_both_switches_are_on() {
        // Exhaustive over the two-key gate. The pairing is the point: a synced
        // `auto_tag_enabled: true` arriving on a device that never opted into AI
        // must still run nothing (the co-gate `ai_enabled` is device-local).
        let none: [String; 0] = [];
        assert_eq!(policy(false, false, "", &none).decide(), TagGate::OptedOut);
        assert_eq!(policy(true, false, "", &none).decide(), TagGate::OptedOut);
        assert_eq!(policy(false, true, "", &none).decide(), TagGate::OptedOut);
        assert_eq!(policy(true, true, "", &none).decide(), TagGate::Allowed);
    }

    #[test]
    fn an_ai_excluded_folder_is_refused_even_with_both_switches_on() {
        // SYNC-14 with no explicit-action carve-out (threat-model §7): auto-tag
        // is ambient, so an excluded note is never read by a model — not even
        // when the user is looking right at it.
        let excluded = vec!["Private/".to_string()];
        assert_eq!(
            policy(true, true, "Private/", &excluded).decide(),
            TagGate::Excluded
        );
        // Nested beneath an excluded folder is excluded too…
        assert_eq!(
            policy(true, true, "Private/Journal/", &excluded).decide(),
            TagGate::Excluded
        );
        // …and case/diacritic folding applies (the store's canonical matcher).
        assert_eq!(
            policy(true, true, "private/", &excluded).decide(),
            TagGate::Excluded
        );
        // A mere prefix sibling is NOT excluded.
        assert_eq!(
            policy(true, true, "PrivateStuff/", &excluded).decide(),
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
            policy(false, true, "", &excluded).decide(),
            tag_prompt(),
        ));
        assert_eq!(out, Err(EngineError::NotReady));

        // auto-tag off → NotReady.
        let out = rt().block_on(suggest_tags_with_engine(
            Arc::clone(&engine),
            pri.clone(),
            policy(true, false, "", &excluded).decide(),
            tag_prompt(),
        ));
        assert_eq!(out, Err(EngineError::NotReady));

        // Excluded folder → an empty reply, not an error, and still no model.
        let out = rt().block_on(suggest_tags_with_engine(
            engine,
            pri,
            policy(true, true, "Private/Journal/", &excluded).decide(),
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
                policy(true, true, "Work/", &none).decide(),
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
}
