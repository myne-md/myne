// SPDX-License-Identifier: AGPL-3.0-only
//! Which local note edits are **not yet on the server** (phase3-web-client
//! task 23).
//!
//! # Why this is its own thing and not a field on `SyncRuntimeStatus`
//!
//! `SyncRuntimeStatus` answers "is this device syncing" — a property of the
//! device. This answers "is *this note* safe" — a property of each note, and the
//! two diverge in exactly the case that matters: a device sitting happily at
//! `Idle` with three notes the server has never seen, because the last cycle
//! failed hours ago, or because the tab has been offline, or because the device
//! is still `Pending` approval. A single green dot on the whole client is a
//! truthful summary of the connection and a false statement about the notes.
//!
//! On the web client that difference is not cosmetic. The local copy is an OPFS
//! cache the browser may evict without asking, and an edit that exists only
//! there is the one thing between the user and real loss — so it has to be
//! visible without being asked for (story 29).
//!
//! # The predicate is the push loop's, deliberately
//!
//! `orchestrator`'s push phase skips a note when
//! `state.blobs[hex(id)].content_nonce_hex == hex(local_nonce)`. That comparison
//! **is** the definition of "already on the server", so this module computes the
//! same one rather than inventing a second notion of dirtiness that could drift
//! from what actually gets pushed. Two consequences worth stating:
//!
//! * **It clears only on a server acknowledgement.** Nothing writes a
//!   `blobs` baseline except the push response handler — a local save cannot
//!   clear the marker, and neither can an optimistic UI.
//! * **It survives a reload for free.** Both inputs are on disk (the note's
//!   `MY01` header nonce and `sync-state.json`), so the answer is recomputed,
//!   never remembered. There is no in-RAM dirty flag to lose.
//!
//! It is also **decryption-free**: the note nonce is read from the `MY01` header
//! prefix, so listing unsynced notes costs a directory scan and a short prefix
//! read per note, not a vault-wide decrypt.

use super::state::SyncState;
use serde::Serialize;
use std::path::Path;

/// The unsynced-edit report surfaced to the UI.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct UnsyncedEdits {
    /// Canonical UUID strings of the notes whose current bytes the server has
    /// not acknowledged. Sorted, so a poll that changes nothing renders nothing.
    pub note_ids: Vec<String>,
    /// `false` when the answer is "this client makes no sync promise at all"
    /// (no endpoint configured), which is different from "everything is synced".
    /// The UI shows no marker either way; the flag exists so a caller cannot
    /// misread an empty list as an assurance.
    pub tracking: bool,
    /// A **credential change** this device made that the server has not
    /// acknowledged (phase3-web-client task 88).
    ///
    /// # Why it rides here rather than getting its own command
    ///
    /// It is the same question as a note's marker — "has the server seen what
    /// this device did?" — asked about the one write where the answer is not
    /// merely inconvenient. An unsynced note is a note the user can still read
    /// on this device and will still have after a sync. An unsynced *password
    /// change* is a divergence in what the account's credential IS: this browser
    /// now expects the new password and every other device still expects the
    /// old one, and clearing this browser's copy before the push lands loses the
    /// change with no way back. On desktop the recovery phrase is the backstop;
    /// on web there is none by settled decision.
    ///
    /// Sharing the report means it also shares the poll that already runs, the
    /// hook the UI already subscribes to, and — the property that matters — the
    /// fact that both answers are **recomputed from disk** rather than
    /// remembered. There is no in-RAM flag to lose across a reload.
    ///
    /// The source is the `vault.meta-dirty` marker, which `change_password`
    /// writes when its push does not land and only a successful meta-phase push
    /// clears. It is therefore an acknowledgement-cleared signal exactly like
    /// the note baselines, not a local guess.
    pub credential_pending: bool,
}

impl UnsyncedEdits {
    /// The no-promise answer: nothing tracked, nothing claimed.
    ///
    /// `credential_pending` is false here for the same reason `note_ids` is
    /// empty: with no endpoint configured there is no server to be behind. A
    /// stale `vault.meta-dirty` from a previous enrolment must not light a
    /// warning on a client that is not syncing at all — and `reset_local`
    /// already clears the marker when an enrolment ends, so a lingering one on
    /// an unconfigured client is rubble rather than a pending change.
    pub fn untracked() -> Self {
        Self {
            note_ids: Vec::new(),
            tracking: false,
            credential_pending: false,
        }
    }
}

/// Whether a note's on-disk bytes are ahead of the last server-acknowledged
/// revision. Split out from the scan so the rule is testable without a vault.
///
/// A note with **no baseline at all** is unsynced — it has never been pushed.
/// That is the case a "compare the two nonces" shortcut gets wrong by treating
/// absent as equal.
pub fn is_unsynced(state: &SyncState, note_id_hex: &str, local_nonce_hex: &str) -> bool {
    state
        .blobs
        .get(note_id_hex)
        .map(|b| b.content_nonce_hex.as_str())
        != Some(local_nonce_hex)
}

/// Scan `notes_dir` and report every note the server has not acknowledged.
///
/// `sync_state` is passed in rather than read here so the caller owns the
/// absent-vs-unreadable distinction `read_sync_state`'s docstring insists on.
pub async fn scan_unsynced(
    io: &dyn crate::vault_io::VaultIo,
    notes_dir: &Path,
    sync_state: &SyncState,
) -> Vec<String> {
    let mut ids = Vec::new();
    for (id_str, nonce) in crate::note_nonce::scan_on_disk_manifest_io(io, notes_dir).await {
        let Ok(uuid) = uuid::Uuid::parse_str(&id_str) else {
            continue;
        };
        // The blob-plane key for a note IS its uuid bytes in hex — the same key
        // the push loop uses. Deriving it here rather than reusing a helper
        // would be the drift this module exists to avoid, so it is spelled the
        // one way `orchestrator` spells it.
        let id_hex = super::to_hex(uuid.as_bytes());
        if is_unsynced(sync_state, &id_hex, &super::to_hex(&nonce)) {
            ids.push(id_str);
        }
    }
    ids.sort();
    ids
}

/// Read the unsynced-edit report for the active vault.
///
/// # The two "empty" answers are not the same, and the flag is why
///
/// **No endpoint configured** → [`UnsyncedEdits::untracked`]. A client that was
/// never asked to sync is not withholding anything, and lighting up every note
/// in a sync-less desktop vault would train the user to ignore the marker
/// before it ever meant something.
///
/// **Endpoint configured, no notes ahead of the baseline** → an empty list with
/// `tracking: true`. That one *is* an assurance.
///
/// # An unreadable `sync-state.json` reports everything as unsynced
///
/// Deliberately, and it is the only defensible direction: the marker's whole job
/// is to stop the user believing an edit is safe when it is not, so "I could not
/// find out" must resolve to "assume it is not". The opposite failure — a silent
/// all-clear derived from a state file that did not parse — is the bug this
/// feature exists to prevent. Note this is a READ-ONLY default; the
/// `unwrap_or_default()`-then-write shape `read_sync_state` warns about (which
/// destroys the cursor and every baseline) is not what happens here.
pub async fn read_unsynced(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<UnsyncedEdits, super::config::SyncConfigError> {
    let path = super::config::config_path_from_host(host, io).await?;
    let cfg = super::config::read_config(io, &path).await?;
    if cfg.endpoint_url.is_none() {
        return Ok(UnsyncedEdits::untracked());
    }
    let Ok(vault_root) =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
    else {
        // No active vault: nothing is open, so nothing is pending. Matches
        // `read_status`'s conservative answer for the same condition.
        return Ok(UnsyncedEdits::untracked());
    };
    let sync_state = super::state::read_sync_state(io, &vault_root)
        .await
        .unwrap_or_default();
    let notes_dir = vault_root.join("notes");
    Ok(UnsyncedEdits {
        note_ids: scan_unsynced(io, &notes_dir, &sync_state).await,
        tracking: true,
        credential_pending: credential_push_pending(io, &vault_root).await,
    })
}

/// Whether a credential change on this device is still waiting for the server.
///
/// # Why this is not `state::vault_meta_is_dirty`, which reads the same file
///
/// The two callers want **opposite** answers when the store cannot be consulted,
/// and both are right for their caller.
///
/// The sync engine resolves an unconsultable marker to *clean*, and its
/// docstring says why: a false "dirty" would push a local `vault.meta` the meta
/// phase has no reason to believe is newer, while a false "clean" only defers
/// the push one cycle — the marker is still on disk and the next read sees it.
/// For the engine, the cheap failure is to wait.
///
/// This is a **user-facing** signal, and there the cheap failure runs the other
/// way. A false "pending" shows a banner the next successful cycle clears. A
/// false "settled" tells the user their password change reached the server when
/// it may not have — and acting on that (clearing this browser's copy, or
/// simply believing the other devices have caught up) is how the change is
/// lost. So an error resolves to `true`.
///
/// Calling the engine's helper and inverting nothing would have been the silent
/// version of this decision, which is why it is a separate function rather than
/// a shared one with a comment.
async fn credential_push_pending(io: &dyn crate::vault_io::VaultIo, vault_root: &Path) -> bool {
    io.exists(&vault_root.join(super::state::VAULT_META_DIRTY_FILE))
        .await
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::state::BlobSyncState;
    use crate::test_support::ScopedTempDir;

    /// Same shape the sibling `corpus` tests use — a current-thread runtime per
    /// test rather than a `#[tokio::test]` attribute, which this crate does not
    /// carry as a dev-dependency.
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    const ID_A: &str = "0193e8d3123478900000000000000001";
    /// 24 bytes of content nonce, hex — the two revisions a note moves between.
    const NONCE_1: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const NONCE_2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn state_with(id_hex: &str, nonce_hex: &str) -> SyncState {
        let mut s = SyncState::default();
        s.blobs.insert(
            id_hex.to_string(),
            BlobSyncState {
                version: 7,
                content_nonce_hex: nonce_hex.to_string(),
                doc_heads_hex: Vec::new(),
            },
        );
        s
    }

    #[test]
    fn a_note_matching_its_baseline_is_synced() {
        let s = state_with(ID_A, NONCE_1);
        assert!(!is_unsynced(&s, ID_A, NONCE_1));
    }

    #[test]
    fn a_note_ahead_of_its_baseline_is_unsynced() {
        let s = state_with(ID_A, NONCE_1);
        assert!(is_unsynced(&s, ID_A, NONCE_2));
    }

    /// The case a naive nonce comparison gets wrong: a note that has never been
    /// pushed has no baseline to differ from, and "absent" must not read as
    /// "equal". This is every note on a device that just enrolled.
    #[test]
    fn a_note_with_no_baseline_at_all_is_unsynced() {
        assert!(is_unsynced(&SyncState::default(), ID_A, NONCE_1));
    }

    /// The property that makes the marker trustworthy: only the push
    /// acknowledgement clears it. Simulated at this layer by advancing the
    /// baseline — which is the ONLY thing the push response handler does — and
    /// confirming nothing else in the state has that effect.
    #[test]
    fn only_advancing_the_baseline_clears_the_marker() {
        let mut s = state_with(ID_A, NONCE_1);
        assert!(is_unsynced(&s, ID_A, NONCE_2));

        // Things that are NOT an acknowledgement of this note.
        s.cursor = 9_999;
        s.device_id_hex = Some("0".repeat(32));
        s.meta_baseline_hex = Some("f".repeat(64));
        s.blobs.insert(
            "ff".repeat(16),
            BlobSyncState {
                version: 3,
                content_nonce_hex: NONCE_2.to_string(),
                doc_heads_hex: Vec::new(),
            },
        );
        assert!(
            is_unsynced(&s, ID_A, NONCE_2),
            "a cursor advance, an identity, a meta baseline and ANOTHER note's \
             acknowledgement must all leave this note marked"
        );

        // The acknowledgement itself.
        s.blobs.insert(
            ID_A.to_string(),
            BlobSyncState {
                version: 8,
                content_nonce_hex: NONCE_2.to_string(),
                doc_heads_hex: Vec::new(),
            },
        );
        assert!(!is_unsynced(&s, ID_A, NONCE_2));
    }

    // ── the credential-pending signal (task 88) ─────────────────────────────

    /// Present marker → pending. The ordinary "the push did not land" case.
    #[test]
    fn a_credential_change_awaiting_the_server_reads_as_pending() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("cred-pending").unwrap();
            let io = crate::vault_io::StdVaultIo;
            super::super::state::mark_vault_meta_dirty(&io, tmp.path())
                .await
                .unwrap();
            assert!(credential_push_pending(&io, tmp.path()).await);
        });
    }

    /// Absent marker → settled, and the round trip through the clear the meta
    /// phase performs. Only a successful push removes it, so this is an
    /// acknowledgement-cleared signal rather than a local guess.
    #[test]
    fn no_marker_reads_as_acknowledged() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("cred-acked").unwrap();
            let io = crate::vault_io::StdVaultIo;
            assert!(!credential_push_pending(&io, tmp.path()).await);

            super::super::state::mark_vault_meta_dirty(&io, tmp.path())
                .await
                .unwrap();
            assert!(credential_push_pending(&io, tmp.path()).await);
            super::super::state::clear_vault_meta_dirty(&io, tmp.path())
                .await
                .unwrap();
            assert!(!credential_push_pending(&io, tmp.path()).await);
        });
    }

    /// The direction that distinguishes this from the engine's reader, pinned
    /// because it is one call in the source and the wrong one is silent.
    ///
    /// The engine resolves an unconsultable marker to *clean* (a false "dirty"
    /// would push a meta it has no reason to think is newer). This resolves it
    /// to *pending*, because a false "settled" tells the user their password
    /// change reached the server when it may not have — and that is the belief
    /// that loses the change.
    #[test]
    fn an_unreadable_store_reads_as_pending_not_settled() {
        /// Answers every call by delegating, except the one under test.
        struct BlindExists;
        #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
        #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
        impl crate::vault_io::VaultIo for BlindExists {
            async fn exists(&self, _p: &Path) -> crate::vault_io::IoResult<bool> {
                Err(crate::io_failure_kind::IoFailureKind::Other)
            }
            async fn read(&self, p: &Path) -> crate::vault_io::IoResult<Vec<u8>> {
                crate::vault_io::StdVaultIo.read(p).await
            }
            async fn read_prefix(
                &self,
                p: &Path,
                len: usize,
            ) -> crate::vault_io::IoResult<Vec<u8>> {
                crate::vault_io::StdVaultIo.read_prefix(p, len).await
            }
            async fn write(
                &self,
                p: &Path,
                b: &[u8],
                o: crate::vault_io::WriteOpts,
            ) -> crate::vault_io::IoResult<()> {
                crate::vault_io::StdVaultIo.write(p, b, o).await
            }
            async fn remove_file(&self, p: &Path) -> crate::vault_io::IoResult<()> {
                crate::vault_io::StdVaultIo.remove_file(p).await
            }
            async fn remove_dir_all(&self, p: &Path) -> crate::vault_io::IoResult<()> {
                crate::vault_io::StdVaultIo.remove_dir_all(p).await
            }
            async fn create_dir_all(&self, p: &Path) -> crate::vault_io::IoResult<()> {
                crate::vault_io::StdVaultIo.create_dir_all(p).await
            }
            async fn read_dir(
                &self,
                p: &Path,
            ) -> crate::vault_io::IoResult<Vec<crate::vault_io::DirEntry>> {
                crate::vault_io::StdVaultIo.read_dir(p).await
            }
            async fn is_dir(&self, p: &Path) -> crate::vault_io::IoResult<bool> {
                crate::vault_io::StdVaultIo.is_dir(p).await
            }
            async fn rename(&self, from: &Path, to: &Path) -> crate::vault_io::IoResult<()> {
                crate::vault_io::StdVaultIo.rename(from, to).await
            }
        }

        rt().block_on(async {
            let dir = Path::new("/nonexistent-credential-pending-probe");
            assert!(
                credential_push_pending(&BlindExists, dir).await,
                "a store that cannot answer must not be reported as an all-clear"
            );
            // The engine's reader, on the same failure, deliberately says the
            // opposite. Asserted here so the divergence is a recorded fact rather
            // than something a future reader takes for a bug in one of them.
            assert!(
                !super::super::state::vault_meta_is_dirty(&BlindExists, dir).await,
                "the engine's reader is expected to differ — see credential_push_pending's doc"
            );
        });
    }

    /// A client with no endpoint claims nothing, including about credentials.
    #[test]
    fn the_untracked_answer_claims_no_credential_state_either() {
        let u = UnsyncedEdits::untracked();
        assert!(!u.tracking);
        assert!(!u.credential_pending);
        assert!(u.note_ids.is_empty());
    }
}
