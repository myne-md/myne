// SPDX-License-Identifier: AGPL-3.0
//! The Tauri-host adapters an agent run needs: reading a note, taking its
//! restore point, and writing the approved batch (myne-md/myne#456).
//!
//! **Shared rather than per-client, and the split from `SearchAdapter` is the
//! interesting part.** These three are written entirely against things both
//! Tauri clients already have, `TauriHost`, `VaultRuntimeState`, the notes
//! command cores, the snapshot store, `StdVaultIo`: so a second copy would
//! have differed only in which crate it sat in. Searching a scope is the one
//! that genuinely differs: desktop queries an embedding index, and mobile has
//! no vector store to query, so each client implements
//! [`crate::plugins::agent::tools::ScopeSearcher`] for itself.
//!
//! **The restore point is the reason two of these exist at all.**
//! `apply.rs` takes the restore point BEFORE it writes and refuses to write
//! when it cannot: an interface that has told the user a whole run can be
//! undone must not then write a change it cannot undo. `RestoreAdapter` forces
//! the capture (`force = true`) so the snapshot window cannot coalesce an agent
//! run's restore point away, and it refuses on `Coalesced` as well as on
//! `Failed`, because "no snapshot" and "an unexpected snapshot state" are
//! equally bad reasons to write something irreversible.
//!
//! Behind `tauri-ipc`, because `TauriHost` is: a consumer that wants core
//! without Tauri has no `AppHandle` to build one from.
//!
//! See: src-tauri/CLAUDE.md "Secret-handling logging discipline".
#![cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]

use crate::host::tauri_host::TauriHost;
use crate::plugins::agent::apply::{ApplyReader, BatchWriter, RestorePointTaker};
use crate::plugins::agent::error::AgentError;
use crate::plugins::agent::prompt::ProposedNote;
use crate::plugins::agent::tools::NoteReader;
use crate::plugins::notes::commands::{
    note_create_from_host, note_read_from_host, note_write_batch_transactional_from_host,
    NoteBatchUpdate,
};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::snapshot_store::{capture_snapshot_reporting_uuid, CaptureOutcome};
use crate::vault_io::StdVaultIo;
use tauri::Runtime;

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
        use crate::host::HostCtx;
        let active = self.state.active_vault_id().await;
        let vault_root = crate::paths::active_vault_root_from_host(&self.host, active)
            .map_err(|_| AgentError::RestorePointFailed)?;
        let now_ms = self.host.now_unix_millis();
        let ids: Vec<String> = note_ids.to_vec();
        // One `spawn_blocking` for the whole loop. Every iteration reads a file,
        // lists a directory, writes a blob and runs a prune scan; running that on
        // an executor thread is what the two sibling adapters here already avoid.
        crate::task::run_blocking(move || {
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
    pub hooks: crate::hooks::Hooks,
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
