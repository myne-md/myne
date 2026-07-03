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
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

use myne_core::plugins::notes::commands::note_read_with_dir;
use myne_core::plugins::notes::note_id::NoteId;

use super::engine::Engine;
use super::error::EngineError;
use super::model_store::{self, ModelRole, ModelStoreError};
use super::rag;
use super::retrieval::{self, ScoredChunk};
use super::state::LocalInferenceState;
use super::vector_store::LocalInferenceVectorState;
use crate::plugins::vault_unlock::state::VaultRuntimeState;

/// DENY-list-safe static label for structured logging (mirrors
/// `protocol_error_kind`): a new [`EngineError`] variant compile-fails
/// `EngineError::kind`, structurally catching drift.
pub fn local_inference_error_kind(e: &EngineError) -> &'static str {
    e.kind()
}

/// One-shot completion. Blocking (no stream, SYNC-7).
#[tauri::command]
pub async fn infer(
    prompt: String,
    state: State<'_, LocalInferenceState>,
) -> Result<String, EngineError> {
    infer_with_engine(state.engine(), prompt).await
}

/// Embedding vector for `text`.
#[tauri::command]
pub async fn embed(
    text: String,
    state: State<'_, LocalInferenceState>,
) -> Result<Vec<f32>, EngineError> {
    embed_with_engine(state.engine(), text).await
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
) -> Result<Vec<SearchHit>, EngineError> {
    // First statement: bound the query plaintext to a Zeroizing wrapper.
    let query = Zeroizing::new(query);
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
) -> Result<AskResult, EngineError> {
    let question = Zeroizing::new(question);
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
    Ok(model_store::selected_model(&base, role)?.map(|p| p.to_string_lossy().into_owned()))
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
}
