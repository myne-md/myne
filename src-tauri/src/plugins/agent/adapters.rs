// SPDX-License-Identifier: AGPL-3.0
//! The desktop side of the agent seams.
//!
//! `myne-core`'s agent plugin is engine-free by design: it depends on narrow
//! traits and this module implements them out of the desktop's existing parts.
//! Nothing here holds policy. Scope, the excluded-folder clamp and the request
//! class all live in core, and an adapter that started making one of those
//! decisions would be the second place it lives.
//!
//! Two of these are doing something worth naming.
//!
//! [`EngineAdapter`] is where the role-structured request becomes the flat
//! prompt the existing `Engine` trait takes. That flattening is exactly where
//! the ChatML discipline has to be applied, so it applies `sanitize_chatml` to
//! every span core marked as note-derived and to none of the spans it marked
//! trusted. This is the **behavioural** half of the defence and not the
//! structural one: on a remote backend the far side tokenizes and Myne cannot
//! disable special-token parsing there (`decisions/ai/0461`, `threat-model.md`
//! §7). This module must not be described as more than that.
//!
//! [`RestoreAdapter`] forces the capture. An agent run's restore point may not
//! be coalesced away by the snapshot window, because the interface has told the
//! user the whole run can be undone.

use myne_core::host::tauri_host::TauriHost;
use myne_core::plugins::agent::apply::{ApplyReader, BatchWriter, RestorePointTaker};
use myne_core::plugins::agent::engine::{
    render_chatml, AgentCompletion, AgentEngine, AgentRequest, AgentRequestClass,
};
use myne_core::plugins::agent::error::AgentError;
use myne_core::plugins::agent::prompt::ProposedNote;
use myne_core::plugins::agent::tools::{NoteReader, ScopeSearcher, SearchHit};
use myne_core::plugins::notes::commands::{
    note_create_from_host, note_read_from_host, note_write_batch_transactional_from_host,
    NoteBatchUpdate,
};
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use myne_core::snapshot_store::{capture_snapshot_reporting_uuid, CaptureOutcome};
use myne_core::vault_io::StdVaultIo;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Runtime;

use crate::plugins::local_inference::chatml;
use crate::plugins::local_inference::error::EngineError;
use crate::plugins::local_inference::retrieval;
use crate::plugins::local_inference::state::{BackendClass, LocalInferenceState, RequestClass};
use crate::plugins::local_inference::vector_store::LocalInferenceVectorState;

/// Map core's two-variant class onto the host registry's.
///
/// A `match` rather than a `From` impl, so a variant added on either side is a
/// compile error here instead of a silent default.
pub(super) fn host_class(class: AgentRequestClass) -> RequestClass {
    match class {
        AgentRequestClass::UserInitiated => RequestClass::UserInitiated,
        AgentRequestClass::Ambient => RequestClass::Ambient,
    }
}

/// Reduce an `EngineError` to core's taxonomy.
///
/// Deliberately lossy and deliberately named: core's enum is what crosses IPC
/// for the agent surface, and widening it to mirror the engine's would give the
/// frontend two vocabularies for the same failure. `RemoteBarred` is the one
/// mapping worth reading twice: it reaches here only if something classed an
/// agent request ambient, which the loop's constant makes impossible, so it is
/// reported as the backend being unusable rather than as a transient fault.
pub(super) fn agent_error_of(e: EngineError) -> AgentError {
    match e {
        EngineError::RemoteBarred | EngineError::NoModel | EngineError::LocalModelMissing => {
            AgentError::EditFormatUnsupported
        }
        _ => AgentError::ReadFailed,
    }
}

/// Generation, through the existing described-backend registry.
pub struct EngineAdapter<'a> {
    pub state: &'a LocalInferenceState,
    pub cancel: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl AgentEngine for EngineAdapter<'_> {
    async fn complete(
        &self,
        class: AgentRequestClass,
        request: &AgentRequest,
    ) -> Result<AgentCompletion, AgentError> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(AgentError::Cancelled);
        }
        // The registry is what refuses a remote backend an ambient request. This
        // adapter does not re-implement that rule; it routes through the one
        // place the rule lives.
        let engine = self
            .state
            .engine_for(host_class(class))
            .map_err(agent_error_of)?;
        // Whether this request leaves the device, asked of the SAME resolver the
        // engine came from rather than of `active_class()`. The two differ: an
        // ambient request is barred onto the local arm while the active arm is
        // remote, so `active_class()` would report "remote" for a request that
        // went nowhere. `class_for` is the sibling of `engine_for` precisely so
        // this question has one answer (myne-md/myne#438).
        let offdevice = matches!(
            self.state.class_for(host_class(class)),
            Ok(BackendClass::Remote)
        );
        // The trusted/untrusted mapping lives in core, so mobile inherits it
        // rather than transcribing a prompt-injection mitigation. What is
        // supplied here is only this host's string filter.
        let prompt = render_chatml(request, &|s| chatml::sanitize_chatml(s));
        // Counted from the rendered prompt, which is the exact string handed to
        // the engine, so the figure describes what was transmitted rather than
        // what was assembled. Characters rather than bytes: the summary answers
        // "how much of my writing left the machine", and a byte count overstates
        // that for every non-ASCII vault.
        let chars_off_device = offdevice.then(|| prompt.chars().count());
        let cancel = Arc::clone(&self.cancel);
        let reply = tokio::task::spawn_blocking(move || engine.infer(&prompt))
            .await
            .map_err(|_| AgentError::ReadFailed)?;
        // Re-read the flag AFTER the model call. A cancel that lands mid
        // generation cannot interrupt a blocking `infer`, so the honest place to
        // notice it is here, before the reply is used for anything.
        if cancel.load(Ordering::SeqCst) {
            return Err(AgentError::Cancelled);
        }
        Ok(AgentCompletion {
            reply: reply.map_err(agent_error_of)?,
            chars_off_device,
        })
    }
}

/// Reading a note, for the read tool and for the apply.
pub struct NoteReadAdapter<'a, R: Runtime> {
    pub host: TauriHost<R>,
    pub state: &'a VaultRuntimeState,
}

impl<R: Runtime> NoteReadAdapter<'_, R> {
    async fn read(&self, note_id: &str) -> Result<String, AgentError> {
        note_read_from_host(&self.host, self.state, note_id.to_string(), &StdVaultIo)
            .await
            .map_err(|_| AgentError::ReadFailed)
    }
}

#[async_trait::async_trait]
impl<R: Runtime> NoteReader for NoteReadAdapter<'_, R> {
    async fn read_body(&self, note_id: &str) -> Result<String, AgentError> {
        self.read(note_id).await
    }
}

#[async_trait::async_trait]
impl<R: Runtime> ApplyReader for NoteReadAdapter<'_, R> {
    async fn current_body(&self, note_id: &str) -> Result<String, AgentError> {
        self.read(note_id).await
    }
}

/// Search, through the existing embedding index.
///
/// Scope filtering is NOT done here; core does it. What is done here is the
/// store's own `ai_excluded_folders` filter, a second and independent control on
/// a different axis, which stays exactly where it already was.
pub struct SearchAdapter<'a> {
    pub state: &'a LocalInferenceState,
    pub vectors: &'a LocalInferenceVectorState,
}

#[async_trait::async_trait]
impl ScopeSearcher for SearchAdapter<'_> {
    async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, AgentError> {
        // The strict embedding accessor, which never hands back a remote backend
        // (SYNC-16). The index stays on the device even when generation does not.
        let engine = self.state.embedding_engine().map_err(agent_error_of)?;
        let owned = zeroize::Zeroizing::new(query.to_string());
        let vector = tokio::task::spawn_blocking(move || engine.embed(&owned))
            .await
            .map_err(|_| AgentError::ReadFailed)?
            .map_err(agent_error_of)?;
        let hits = {
            let store = self.vectors.lock();
            if !store.is_enabled() {
                return Ok(Vec::new());
            }
            retrieval::top_k_matches(&vector, &store, limit, |id| store.is_note_excluded(id))
        };
        // Collapse chunk hits to one row per note, keeping the best score: the
        // agent reads whole notes, so N chunks of one note are one candidate.
        let mut best: BTreeMap<String, f32> = BTreeMap::new();
        for hit in hits {
            let note_id = hit.key.note_id.to_string();
            let entry = best.entry(note_id).or_insert(hit.score);
            if hit.score > *entry {
                *entry = hit.score;
            }
        }
        let mut out: Vec<SearchHit> = best
            .into_iter()
            .map(|(note_id, score)| SearchHit { note_id, score })
            .collect();
        out.sort_by(|a, b| b.score.total_cmp(&a.score));
        Ok(out)
    }
}

/// The run's restore point, over the real snapshot store.
pub struct RestoreAdapter<'a, R: Runtime> {
    pub host: TauriHost<R>,
    pub state: &'a VaultRuntimeState,
}

#[async_trait::async_trait]
impl<R: Runtime> RestorePointTaker for RestoreAdapter<'_, R> {
    async fn capture(
        &self,
        _run_id: &str,
        note_ids: &[String],
    ) -> Result<Vec<(String, String)>, AgentError> {
        use myne_core::host::HostCtx;
        let active = self.state.active_vault_id().await;
        let vault_root = myne_core::paths::active_vault_root_from_host(&self.host, active)
            .map_err(|_| AgentError::RestorePointFailed)?;
        let now_ms = self.host.now_unix_millis();
        let ids: Vec<String> = note_ids.to_vec();
        // One `spawn_blocking` for the whole loop. Every iteration reads a file,
        // lists a directory, writes a blob and runs a prune scan; running that on
        // an executor thread is what the two sibling adapters here already avoid.
        tokio::task::spawn_blocking(move || {
            let notes_dir = vault_root.join("notes");
            let mut captured = Vec::with_capacity(ids.len());
            for note_id in &ids {
                let path = notes_dir.join(format!("{note_id}.myn"));
                let blob = std::fs::read(&path).map_err(|_| AgentError::RestorePointFailed)?;
                // `force = true`: an agent run's restore point may not be
                // coalesced away by the snapshot window.
                match capture_snapshot_reporting_uuid(&vault_root, note_id, &blob, now_ms, true) {
                    CaptureOutcome::Captured(uuid) => captured.push((note_id.clone(), uuid)),
                    // `Coalesced` cannot happen under `force = true`; `Failed` is
                    // the case the whole contract exists for. Both refuse, because
                    // "no snapshot" and "an unexpected snapshot state" are equally
                    // bad reasons to write something the user cannot undo.
                    CaptureOutcome::Coalesced | CaptureOutcome::Failed => {
                        return Err(AgentError::RestorePointFailed);
                    }
                }
            }
            Ok(captured)
        })
        .await
        .map_err(|_| AgentError::RestorePointFailed)?
    }
}

/// The transactional multi-note write.
pub struct WriteAdapter<'a, R: Runtime> {
    pub host: TauriHost<R>,
    pub state: &'a VaultRuntimeState,
    pub hooks: myne_core::hooks::Hooks,
}

#[async_trait::async_trait]
impl<R: Runtime> BatchWriter for WriteAdapter<'_, R> {
    async fn create_note(&self, note: &ProposedNote) -> Result<String, AgentError> {
        // The body the model proposed, with its title and folder rendered as the
        // ordinary frontmatter a hand-typed note carries. No new format: a note
        // an agent created is byte-shaped like any other.
        let mut plaintext = String::from("---\n");
        plaintext.push_str(&format!("title: {}\n", note.title));
        if let Some(folder) = note.folder.as_deref().filter(|f| !f.is_empty()) {
            plaintext.push_str(&format!("folder: {folder}\n"));
        }
        plaintext.push_str("---\n\n");
        plaintext.push_str(&note.body);
        note_create_from_host(&self.host, self.state, &self.hooks, plaintext, &StdVaultIo)
            .await
            .map_err(|_| AgentError::WriteFailed)
    }

    async fn write_batch(&self, notes: Vec<(String, String)>) -> Result<(), AgentError> {
        let updates: Vec<NoteBatchUpdate> = notes
            .into_iter()
            .map(|(note_id, plaintext)| NoteBatchUpdate { note_id, plaintext })
            .collect();
        note_write_batch_transactional_from_host(
            &self.host,
            &StdVaultIo,
            self.state,
            &self.hooks,
            updates,
        )
        .await
        .map_err(|_| AgentError::WriteFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn class_mapping_is_exhaustive_by_construction() {
        assert_eq!(
            host_class(AgentRequestClass::UserInitiated),
            RequestClass::UserInitiated
        );
        assert_eq!(
            host_class(AgentRequestClass::Ambient),
            RequestClass::Ambient
        );
    }

    #[test]
    fn a_barred_remote_backend_reports_the_backend_as_unusable_not_as_a_read_fault() {
        assert!(matches!(
            agent_error_of(EngineError::RemoteBarred),
            AgentError::EditFormatUnsupported
        ));
    }
}
