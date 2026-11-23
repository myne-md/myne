// SPDX-License-Identifier: AGPL-3.0
//! The live vault behind an external MCP connection's reads, and the door's one
//! call entry point (external-mcp-connection, myne-md/myne#923).
//!
//! Two things live here, and the split is the same one
//! `plugins::agent::host_adapters` draws for the agent:
//!
//! - [`VaultNoteSource`] answers the three questions [`McpNoteSource`] asks —
//!   the index snapshot, one note's plaintext, a ranked search — over the SAME
//!   vault, so the scope check and the body read cannot disagree about which
//!   vault is open.
//! - [`door_call`] is the whole host side of one `mcp_call`: the lock check, the
//!   prefs read that holds the grant, and the folder set the grant resolves
//!   against. `src-tauri/src/cli_bridge/dispatch.rs`'s arm is a wrapper that
//!   resolves the three piece of Tauri managed state and calls this.
//!
//! ## Why this is not gated on `tauri-ipc`
//!
//! It takes `&dyn HostCtx` rather than an `AppHandle`, which is the one reason
//! its tests can drive a real vault, a real prefs blob and a real index with no
//! Tauri runtime: `AppNoteLister` builds a `TauriHost` and passes it here, and a
//! test builds a `TestHost`. A second implementation for tests would be a copy
//! that passes while the shipped path is wrong.
//!
//! Gated on `not(wasm32)` instead: the door is a desktop socket, the web client
//! has no sidecar to answer, and compiling a source that reads a `.myn` file into
//! the browser bundle would be dead code at best.
//!
//! ## The search index is the desktop's, and there is no second one
//!
//! [`VaultNoteSource::search`] ranks through `note_search_core`, the same
//! function `myne search` and the command palette answer from. No embedding
//! index, no scope-narrowed index: the index stays scope-BLIND and the clamp is
//! applied to its output by `super::tools`, which is the one place a hit becomes
//! a row (and the reason a future scope-aware index must not be introduced here
//! without deleting that clamp in the same change).
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — nothing in
//! this module logs at all. A note id, a folder path, a grant name and a body
//! are all on the DENY list, and the door's own reply is the only place any of
//! them is supposed to travel.

use std::collections::{BTreeMap, BTreeSet};

use async_trait::async_trait;

use crate::host::HostCtx;
use crate::plugins::agent::tools::SearchHit;
use crate::plugins::mcp::tools::ToolName;
use crate::plugins::notes::commands::note_read_from_host;
use crate::plugins::notes::error::NoteReadError;
use crate::plugins::notes::search_sync_core::note_search_core;
use crate::plugins::prefs::commands::prefs_read_from_host;
use crate::plugins::prefs::error::PrefsReadError;
use crate::plugins::vault_indices::calendar::CalendarRow;
use crate::plugins::vault_indices::state::NoteRecord;
use crate::plugins::vault_indices::VaultIndicesState;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use crate::search::SearchIndexState;
use crate::vault_io::VaultIo;

use super::error::McpToolError;
use super::tools::{
    call_tool, CallInputs, FileRow, McpCallOutcome, McpNoteSource, ViewRow, WireCall,
};

/// The running vault, as the four read tools see it.
///
/// Every field is a borrow: one of these is built per call, it owns nothing, and
/// the state it points at is the app's own managed state rather than a copy.
/// There is deliberately no cache — the index is already in RAM and a per-call
/// snapshot is what makes "in scope right now" true rather than "in scope when
/// the door opened".
pub struct VaultNoteSource<'a> {
    pub host: &'a dyn HostCtx,
    pub state: &'a VaultRuntimeState,
    /// The sidebar's index (`MYI1`, `plugins::vault_indices`). Holds each note's
    /// title, folder and liveness — everything the clamp needs and nothing that
    /// requires decrypting a body.
    pub indices: &'a VaultIndicesState,
    /// The desktop search index (`MYS1`). Scope-blind by design; see the module
    /// docs.
    pub search: &'a SearchIndexState,
    pub io: &'a dyn VaultIo,
}

impl VaultNoteSource<'_> {
    /// Whether the vault is unlocked right now.
    ///
    /// The three questions this source answers have three different natural
    /// failure shapes — `snapshot()` on a cleared index is an empty map, and
    /// `note_search_core` on a locked vault is an empty vector — so the check is
    /// made once, here, rather than left to each of them to remember. An empty
    /// index would otherwise read to a caller as "your vault has no notes",
    /// which is the one answer a locked vault must never give.
    async fn ensure_unlocked(&self) -> Result<(), McpToolError> {
        if matches!(self.state.slot_kind_active().await, SlotKind::Unlocked) {
            Ok(())
        } else {
            Err(McpToolError::VaultUnavailable)
        }
    }
}

/// The four reads that joined in myne-md/myne#1077, on the same vault the note
/// reads use.
///
/// **Every one of them is a call into a command core the app already has**, which
/// is the whole point: `attachment_list` reads the attachments catalog the
/// library reads, `attachment_read` reads the text cache the search index reads,
/// `calendar_read` asks the same bounded range the pane and the phone ask, and
/// `view_list` reads `vault.prefs`. A second implementation of any of them would
/// be a second answer to a question the app already answers, and the two would
/// disagree the first time one side changed.
#[async_trait]
impl McpNoteSource for VaultNoteSource<'_> {
    async fn records(&self) -> Result<BTreeMap<String, NoteRecord>, McpToolError> {
        self.ensure_unlocked().await?;
        Ok(self.indices.snapshot())
    }

    async fn read_body(&self, note_id: &str) -> Result<String, McpToolError> {
        match note_read_from_host(self.host, self.state, note_id.to_string(), self.io).await {
            Ok(body) => Ok(body),
            // The narrow race only: the door does not exist while the vault is
            // locked, so reaching this means the lock landed mid-call.
            Err(NoteReadError::VaultNotUnlocked) => Err(McpToolError::VaultUnavailable),
            // A malformed and an unknown id get the SAME answer, which is what
            // `note_read`'s contract asks for: the caller cannot tell a
            // mistyped id from a deleted note.
            Err(NoteReadError::NoteNotFound) | Err(NoteReadError::InvalidNoteId) => {
                Err(McpToolError::UnknownNote {
                    note_id: note_id.to_string(),
                })
            }
            Err(_) => Err(McpToolError::VaultUnavailable),
        }
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, McpToolError> {
        self.ensure_unlocked().await?;
        // De-duplicated by note id, highest rank kept. One note can own several
        // index documents — its own body plus one per embedded attachment whose
        // text has been extracted (`att:<attachment>:<note>`) — and
        // `note_search_core` decodes each of those to the SAME note id. Without
        // this, one note whose attachment matches would occupy several of the
        // caller's rows and `limit` would buy less than it says. The command
        // palette's `myne search` collapses them for the same reason.
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut hits = Vec::new();
        for hit in note_search_core(self.state, self.search, query).await {
            if !seen.insert(hit.note_id.clone()) {
                continue;
            }
            hits.push(SearchHit {
                note_id: hit.note_id,
                score: hit.score,
            });
            if hits.len() == limit {
                break;
            }
        }
        Ok(hits)
    }

    async fn files(&self) -> Result<Vec<FileRow>, McpToolError> {
        self.ensure_unlocked().await?;
        let rows = crate::plugins::attachments::commands::catalog_list_from_host(
            self.host, self.io, self.state,
        )
        .await
        .map_err(|_| McpToolError::VaultUnavailable)?;
        Ok(rows
            .into_iter()
            .map(|row| FileRow {
                attachment_id: row.id,
                // Empty is the vault root, and the clamp reads `None` that way;
                // `Some("")` would put an empty folder in front of a caller as if
                // it were a name.
                filename: (!row.filename.is_empty()).then_some(row.filename),
                folder: (!row.folder.is_empty()).then_some(row.folder),
            })
            .collect())
    }

    async fn file_text(&self, attachment_id: &str) -> Result<Option<String>, McpToolError> {
        self.ensure_unlocked().await?;
        crate::plugins::attachments::commands::extracted_text_from_host(
            self.host,
            self.io,
            self.state,
            attachment_id,
        )
        .await
        .map_err(|_| McpToolError::VaultUnavailable)
    }

    async fn calendar(&self, from: &str, to: &str) -> Result<Vec<CalendarRow>, McpToolError> {
        self.ensure_unlocked().await?;
        match crate::plugins::vault_indices::commands::vault_indices_calendar_range_from_host(
            self.state,
            self.indices,
            from.to_string(),
            to.to_string(),
            true,
        )
        .await
        {
            Ok(range) => Ok(range.rows),
            Err(
                crate::plugins::vault_indices::error::VaultIndicesError::CalendarWindowTooWide {
                    max_days,
                },
            ) => Err(McpToolError::CalendarWindowTooWide {
                max_days: u32::try_from(max_days).unwrap_or(u32::MAX),
            }),
            // Everything else is "this device cannot answer right now": a locked
            // vault, an unreadable meta, an index that is not there.
            Err(_) => Err(McpToolError::VaultUnavailable),
        }
    }

    async fn views(&self) -> Result<Vec<ViewRow>, McpToolError> {
        self.ensure_unlocked().await?;
        let prefs = prefs_read_from_host(self.host, self.state, self.io)
            .await
            .map_err(|_| McpToolError::VaultUnavailable)?;
        Ok(prefs
            .saved_views
            .into_iter()
            .map(|view| ViewRow {
                view_id: view.id,
                name: view.name,
                view_type: match view.view_type {
                    protocol::saved_view::ViewType::Table => "table",
                    protocol::saved_view::ViewType::Cards => "cards",
                    protocol::saved_view::ViewType::List => "list",
                    protocol::saved_view::ViewType::Board => "board",
                }
                .to_string(),
            })
            .collect())
    }
}

/// One `mcp_call`, from the door's managed state to the tool surface.
///
/// The order is the security-relevant part: the lock check and the prefs read
/// both happen before any note is touched, and the grant is read from `prefs`
/// on every call rather than cached, so revocation takes effect on the next call
/// without a restart (`usecase 32`).
///
/// `cli_enabled` is deliberately NOT re-read here. The socket's own existence is
/// the gate — it is created only while external access is on AND the vault is
/// unlocked, and torn down the instant either stops holding — so re-checking the
/// flag would be a second opinion about the same fact, and the one that can be
/// wrong during the one-tick window before teardown.
/// The app's own state, as one `mcp_call` needs it.
///
/// A struct rather than seven parameters: the door reads all of it and decides
/// nothing about any of it, and three of the seven were added one review at a time
/// (the registry with the write verbs, the io seam with the wasm build), which is
/// how a signature grows past what a caller can pass correctly.
pub struct DoorContext<'a> {
    pub host: &'a dyn HostCtx,
    pub state: &'a VaultRuntimeState,
    /// The sidebar's index (`MYI1`), for the note records every scope check reads.
    pub indices: &'a VaultIndicesState,
    /// The desktop search index (`MYS1`). Scope-blind by design.
    pub search: &'a SearchIndexState,
    pub hooks: &'a crate::hooks::Hooks,
    /// The live co-editing registry: a write refuses a note a session owns.
    pub registry: &'a crate::plugins::live::LiveSessionRegistry,
    pub io: &'a dyn VaultIo,
}

pub async fn door_call(app: DoorContext<'_>, call: WireCall<'_>) -> McpCallOutcome {
    let DoorContext {
        host,
        state,
        indices,
        search,
        hooks,
        registry,
        io,
    } = app;
    if !matches!(state.slot_kind_active().await, SlotKind::Unlocked) {
        return McpCallOutcome::VaultLocked;
    }
    let prefs = match prefs_read_from_host(host, state, io).await {
        Ok(prefs) => prefs,
        Err(PrefsReadError::SlotNotUnlocked) => return McpCallOutcome::VaultLocked,
        // Every other prefs failure is reported as `io` rather than as a scope
        // refusal: telling a caller to unlock a vault that IS unlocked, or to
        // widen a grant that may be fine, would send a human after the wrong
        // thing.
        Err(PrefsReadError::Io { .. }) | Err(PrefsReadError::InvalidVaultMeta) => {
            return McpCallOutcome::Io
        }
    };
    let granted = prefs.mcp_connections.contains_key(call.connection);
    let quiet = crate::plugins::mcp::scope::quiet_folders(&prefs);
    let source = VaultNoteSource {
        host,
        state,
        indices,
        search,
        io,
    };
    let writer = VaultNoteWriter {
        host,
        state,
        hooks,
        io,
        registry,
    };
    let outcome = call_tool(
        CallInputs {
            call,
            grants: &prefs.mcp_connections,
            deliberate_folders: &prefs.deliberate_folders,
            archived_folders: &prefs.archived_folders,
            quiet_folders: &quiet,
            writer: Some(&writer),
            // The process's one ledger: the lifetime a budget means is the app's,
            // so it survives a lock and an unlock and ends when the process does.
            budget: super::budget::process_ledger(),
            now_ms: host.monotonic_millis(),
        },
        &source,
    )
    .await;
    // **A queued proposal is written HERE, and the caller is told which of the two
    // answers it got.** `call_tool` decided the route; this is the only place with
    // the host and the prefs writer, so it is the only place a row can be stored.
    // The order is: store the row, then answer. A row that could not be stored (the
    // queue is full of OTHER connections' rows) is answered as the plain
    // out-of-scope refusal instead, because telling a client "queued for review"
    // about a decision nobody will ever be shown is the one lie this path must not
    // tell.
    let outcome = match outcome {
        McpCallOutcome::QueueProposal {
            verb,
            folder,
            summary,
        } => {
            let stored = crate::plugins::prefs::commands::enqueue_mcp_write_request_from_host(
                host,
                state,
                hooks,
                call.connection.trim().to_string(),
                folder.clone(),
                verb.to_string(),
                summary,
                io,
            )
            .await
            .unwrap_or(false);
            McpCallOutcome::Refused(if stored {
                McpToolError::WriteQueuedForReview { folder }
            } else {
                McpToolError::OutOfScopeFolder { folder }
            })
        }
        // **A call that named a folder the user left out becomes a READ request.**
        // The mirror of the write card, and the reason it exists: a plain refusal is
        // answered by a client retrying, and a client retrying is indistinguishable
        // from one probing. Accepting removes that one folder from the exclusion set
        // (mcp external access rework, myne-md/myne#1052).
        McpCallOutcome::Refused(McpToolError::OutOfScopeFolder { folder }) => {
            // A WRITE into a folder it may not read arrives here too, and it is not a
            // read request: a card asking to read the folder would not answer the
            // question the client asked, and the write it retries is still refused.
            // So the card is queued for a read verb only.
            //
            // The reason does NOT change when a row is stored, because the client's
            // next action is the same either way (tell the person). A failed store
            // costs the card and nothing else, so it is logged where it happens rather
            // than encoded as a second wire label for one situation.
            if !ToolName::from_wire(call.tool).is_some_and(ToolName::is_write)
                && crate::plugins::prefs::commands::enqueue_mcp_read_request_from_host(
                    host,
                    state,
                    hooks,
                    call.connection.trim().to_string(),
                    folder.clone(),
                    call.tool.to_string(),
                    io,
                )
                .await
                .is_err()
            {
                tracing::warn!(
                    target: "myne::mcp",
                    "read request not queued; the refusal stands"
                );
            }
            McpCallOutcome::Refused(McpToolError::OutOfScopeFolder { folder })
        }
        other => other,
    };
    // **The Settings row's "last used" is written here, and nowhere else.** The
    // approval records a name and a folder set; nothing else in the tree knows a
    // connection is alive, so a row that never moved would say "not used since
    // approval" about a client that is working right now. Every outcome counts
    // (the CLI door's activity stamp makes the same call for the same reason: a
    // refusal still means the client is there), and the write itself is throttled
    // inside the prefs command, so a search loop costs no vault writes.
    //
    // Best-effort by construction: the call is already answered, so a failed
    // stamp costs one stale row and must never turn a successful read into an
    // error the agent relays to a human.
    if granted {
        let _ = crate::plugins::prefs::commands::touch_mcp_connection_last_used_from_host(
            host,
            state,
            hooks,
            call.connection.to_string(),
            io,
        )
        .await;
    }
    outcome
}

/// The live vault as a WRITE surface: the restore point, the create and the
/// guarded overwrite the write verbs need (external-mcp-connection task 14).
///
/// Every method here is a call into the notes plugin's existing path, and none of
/// them is a second write path: [`crate::plugins::notes::commands::note_create_from_host`]
/// is the door the CLI's `new` uses, and
/// [`crate::plugins::notes::commands::note_update_from_host`] is the guarded save
/// the editor uses. What this adapter adds is only the mapping from those errors to
/// the closed reasons an external caller can act on, and the snapshot taken before
/// the first byte changes.
///
/// **The registry is a field rather than a lookup.** `HostCtx` deliberately has no
/// `app()` (`core/src/host.rs`), so the live-session registry cannot be reached
/// from a `&dyn HostCtx`; the door's Tauri wrapper resolves it from managed state
/// and hands it here, which is also what lets a test drive this against a real
/// registry instead of a stub.
pub struct VaultNoteWriter<'a> {
    pub host: &'a dyn HostCtx,
    pub state: &'a VaultRuntimeState,
    pub hooks: &'a crate::hooks::Hooks,
    pub io: &'a dyn VaultIo,
    pub registry: &'a crate::plugins::live::LiveSessionRegistry,
}

impl VaultNoteWriter<'_> {
    /// Refuse a value this verb cannot write faithfully.
    ///
    /// Delegated to the agent's own frontmatter scalar writer rather than
    /// reimplemented: the app reads these fields with js-yaml, and two notions of
    /// "needs quoting" is how a title that looks fine in the file reads back as a
    /// different string in the sidebar.
    fn scalar(value: &str) -> Result<String, McpToolError> {
        crate::plugins::agent::edit::yaml_folder_scalar(value)
            .map_err(|_| McpToolError::UnwritableTitle)
    }
}

#[async_trait]
impl super::intent::McpNoteWriter for VaultNoteWriter<'_> {
    async fn capture_restore_point(
        &self,
        note: &str,
    ) -> Result<super::intent::RestorePoint, McpToolError> {
        use crate::snapshot_store::{capture_snapshot_reporting_uuid, CaptureOutcome};
        let active = self.state.active_vault_id().await;
        let vault_root = crate::paths::active_vault_root_from_host(self.host, active)
            .map_err(|_| McpToolError::VaultUnavailable)?;
        let now_ms = self.host.now_unix_millis();
        let note_id = note.to_string();
        // One `spawn_blocking` for the read, the directory list, the blob write and
        // the prune scan, exactly as the agent adapter does it: this is file IO on
        // an executor thread otherwise.
        crate::task::run_blocking(move || {
            let path = vault_root.join("notes").join(format!("{note_id}.myn"));
            let blob = match std::fs::read(&path) {
                Ok(blob) => blob,
                // The note is gone. Reported as a distinct outcome rather than as a
                // failure, because a create has nothing to restore and a missing
                // note is not an IO error; the verbs decide what it means for them.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(super::intent::RestorePoint::NothingToRestore)
                }
                Err(_) => return Err(McpToolError::RestorePointFailed),
            };
            // `force = true`: an external agent's write may not be coalesced away by
            // the snapshot window. The interface tells the user an external write is
            // undoable, and a skipped capture would make that false.
            match capture_snapshot_reporting_uuid(&vault_root, &note_id, &blob, now_ms, true) {
                CaptureOutcome::Captured(uuid) => Ok(super::intent::RestorePoint::Captured(uuid)),
                // `Coalesced` cannot happen under `force`, so both arms are the same
                // refusal, and it is the refusal the whole contract exists for.
                CaptureOutcome::Coalesced | CaptureOutcome::Failed => {
                    Err(McpToolError::RestorePointFailed)
                }
            }
        })
        .await
        .map_err(|_| McpToolError::RestorePointFailed)?
    }

    async fn create_note(
        &self,
        folder: &str,
        title: &str,
        body: &str,
    ) -> Result<String, McpToolError> {
        let folder_scalar = Self::scalar(folder)?;
        let title_scalar = Self::scalar(title)?;
        // The ordinary frontmatter a hand-typed note carries, in the app's own key
        // order: no new on-disk shape, and nothing here that the notes plugin would
        // treat differently from a note the person created.
        let mut plaintext = String::from("---\n");
        plaintext.push_str(&format!("title: {title_scalar}\n"));
        if !folder.trim().is_empty() {
            plaintext.push_str(&format!("folder: {folder_scalar}\n"));
        }
        plaintext.push_str("---\n\n");
        plaintext.push_str(body);
        crate::plugins::notes::commands::note_create_from_host(
            self.host, self.state, self.hooks, plaintext, self.io,
        )
        .await
        .map_err(|error| {
            tracing::warn!(
                target: "myne_core::mcp",
                event = "mcp_create_refused",
                error_kind = crate::plugins::notes::commands::note_create_error_kind(&error)
            );
            McpToolError::VaultUnavailable
        })
    }

    async fn overwrite_note(
        &self,
        note: &str,
        plaintext: &str,
        expected_base_hash_hex: &str,
    ) -> Result<(), McpToolError> {
        use crate::plugins::notes::error::NoteUpdateError;
        match crate::plugins::notes::commands::note_update_from_host(
            self.host,
            self.state,
            self.hooks,
            note.to_string(),
            plaintext.to_string(),
            Some(expected_base_hash_hex.to_string()),
            self.io,
            self.registry,
        )
        .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                tracing::warn!(
                    target: "myne_core::mcp",
                    event = "mcp_write_refused",
                    error_kind = crate::plugins::notes::commands::note_update_error_kind(&error)
                );
                Err(match error {
                    // The read-then-write race, answered without new machinery: the
                    // anchor is the note's own bytes, so a note that moved on cannot
                    // be appended to from stale text.
                    NoteUpdateError::BaseMismatch => McpToolError::NoteChanged {
                        note_id: note.to_string(),
                    },
                    NoteUpdateError::LiveSessionOpen => McpToolError::NoteOpenInEditor {
                        note_id: note.to_string(),
                    },
                    NoteUpdateError::NoteNotFound | NoteUpdateError::InvalidNoteId => {
                        McpToolError::UnknownNote {
                            note_id: note.to_string(),
                        }
                    }
                    _ => McpToolError::VaultUnavailable,
                })
            }
        }
    }
}
