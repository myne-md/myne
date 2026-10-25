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
use crate::plugins::notes::commands::note_read_from_host;
use crate::plugins::notes::error::NoteReadError;
use crate::plugins::notes::search_sync_core::note_search_core;
use crate::plugins::prefs::commands::prefs_read_from_host;
use crate::plugins::prefs::error::PrefsReadError;
use crate::plugins::vault_indices::state::NoteRecord;
use crate::plugins::vault_indices::VaultIndicesState;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use crate::search::SearchIndexState;
use crate::vault_io::VaultIo;

use super::error::McpToolError;
use super::tools::{call_tool, CallInputs, McpCallOutcome, McpNoteSource, WireCall};

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
pub async fn door_call(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    indices: &VaultIndicesState,
    search: &SearchIndexState,
    hooks: &crate::hooks::Hooks,
    io: &dyn VaultIo,
    call: WireCall<'_>,
) -> McpCallOutcome {
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
    let source = VaultNoteSource {
        host,
        state,
        indices,
        search,
        io,
    };
    let outcome = call_tool(
        CallInputs {
            call,
            grants: &prefs.mcp_connections,
            deliberate_folders: &prefs.deliberate_folders,
            archived_folders: &prefs.archived_folders,
        },
        &source,
    )
    .await;
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
