// SPDX-License-Identifier: AGPL-3.0-only
//! Does this device hold the whole vault? (phase3-web-client task 89)
//!
//! # The destructive operation this exists to gate
//!
//! `attachment_clean_unused` computes "unused" by enumerating and decrypting
//! every `.myn` in the local `notes/` directory. That scan is already
//! fail-closed on a note it cannot READ — under-counting references leads to a
//! cryptographic erase — but it has no notion of a note that **is not on disk
//! yet**, and on the web client that is a designed, persistent state: task 39
//! makes the app usable mid-materialisation and lets an interrupted first sync
//! resume across sessions, and task 22 re-enters it after every eviction.
//!
//! A user who opens the attachment library during that window and runs
//! "Clean unused" gets a sweep computed over a fraction of the corpus. Every
//! attachment embedded only in a not-yet-pulled note is offered as unused, and
//! confirming performs the whole §11.4 client action: local crypto-erase,
//! catalog tombstone, manifest drop, and a tombstone-flagged blob record in the
//! next push. **The desktop then pulls that tombstone and erases its own copy,
//! and the server drops the body at horizon-GC.** The bytes exist nowhere else —
//! attachments are not in snapshots, and backup export does not exist on web.
//!
//! # Why the signal is the head's `manifest_hash` and not a counter
//!
//! Every alternative is an approximation. "No skipped downloads this cycle" is
//! about one cycle. "The cursor reached the end" says nothing about a record
//! that was deferred. A count of local notes has nothing to compare against.
//!
//! The vault head already commits `manifest_hash` over the content blobs the
//! account holds — notes ∪ live attachments (`sync-protocol.md` §4.2) — and the
//! head is MAC-verified under `vault-head-mac` before anything reads it. So
//! "my local manifest hashes to what the head says" is an EXACT statement of
//! "I hold every content blob the server knows about", verified rather than
//! inferred, and it costs one hash over data the cycle already assembled.
//!
//! # Why a device that never enrolled is not gated
//!
//! It has nothing missing. A local-only vault IS the whole corpus, so refusing
//! cleanup there would break a working desktop feature to protect against a
//! state it cannot enter. The gate therefore fires only for a device that has
//! an identity (it enrolled, so a server holds notes it may not have) and has
//! not yet proven completeness. A device that enrolled and never finished its
//! first sync is exactly the risky case, on any platform.

use serde::Serialize;
use std::path::Path;

/// What a caller may conclude about this device's local corpus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CorpusState {
    /// Not enrolled with any server — the local copy is the whole vault, so
    /// there is nothing to be missing.
    NotSynced,
    /// Enrolled, and the last cycle proved the local manifest matches the
    /// server head's.
    Complete,
    /// Enrolled and NOT proven complete: mid-materialisation, an interrupted
    /// first sync, a post-eviction re-sync, or simply a device whose last cycle
    /// left records behind.
    Incomplete,
}

impl CorpusState {
    /// Whether a whole-corpus destructive sweep may proceed.
    ///
    /// `NotSynced` passes deliberately (see the module note); only a device that
    /// enrolled and has not proven completeness is refused.
    pub fn permits_whole_corpus_sweep(self) -> bool {
        !matches!(self, CorpusState::Incomplete)
    }
}

/// Read the persisted corpus state for `vault_dir`.
///
/// **Fail-closed on an unreadable `sync-state.json`.** A device whose sync state
/// will not parse cannot prove it holds everything, and the operation being
/// gated is an irreversible cross-device erase. `read_sync_state` deliberately
/// distinguishes absent (never enrolled) from unreadable, and this is one of the
/// callers that needs the distinction: absent is `NotSynced`, unreadable is
/// `Incomplete`.
pub async fn corpus_state(io: &dyn crate::vault_io::VaultIo, vault_dir: &Path) -> CorpusState {
    match super::state::read_sync_state(io, vault_dir).await {
        Ok(s) if s.device_id_hex.is_none() => CorpusState::NotSynced,
        Ok(s) if s.corpus_complete => CorpusState::Complete,
        Ok(_) => CorpusState::Incomplete,
        Err(_) => CorpusState::Incomplete,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::state::SyncState;
    use crate::test_support::ScopedTempDir;
    use crate::vault_io::{StdVaultIo, VaultIo, WriteOpts};

    const IO: StdVaultIo = StdVaultIo;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    async fn seed(dir: &Path, s: &SyncState) {
        IO.write(
            &dir.join("sync-state.json"),
            &serde_json::to_vec(s).unwrap(),
            WriteOpts::default(),
        )
        .await
        .unwrap();
    }

    #[test]
    fn a_device_that_never_enrolled_is_not_gated() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("corpus-none").unwrap();
            // No sync-state.json at all — the local-only desktop case.
            assert_eq!(corpus_state(&IO, tmp.path()).await, CorpusState::NotSynced);
            assert!(corpus_state(&IO, tmp.path())
                .await
                .permits_whole_corpus_sweep());
        });
    }

    #[test]
    fn an_enrolled_device_that_never_finished_a_sync_is_gated() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("corpus-partial").unwrap();
            seed(
                tmp.path(),
                &SyncState {
                    device_id_hex: Some("aa".repeat(16)),
                    ..Default::default()
                },
            )
            .await;
            let state = corpus_state(&IO, tmp.path()).await;
            assert_eq!(state, CorpusState::Incomplete);
            assert!(!state.permits_whole_corpus_sweep());
        });
    }

    #[test]
    fn a_proven_complete_device_is_not_gated() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("corpus-complete").unwrap();
            seed(
                tmp.path(),
                &SyncState {
                    device_id_hex: Some("aa".repeat(16)),
                    corpus_complete: true,
                    ..Default::default()
                },
            )
            .await;
            assert_eq!(corpus_state(&IO, tmp.path()).await, CorpusState::Complete);
        });
    }

    /// The direction a wrong answer must fail in. An unreadable sync state means
    /// the device cannot PROVE it holds everything, and the gated operation is an
    /// irreversible erase that propagates to every other device.
    #[test]
    fn an_unreadable_sync_state_is_treated_as_incomplete() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("corpus-garbage").unwrap();
            IO.write(
                &tmp.path().join("sync-state.json"),
                b"{ this is not json",
                WriteOpts::default(),
            )
            .await
            .unwrap();
            assert_eq!(corpus_state(&IO, tmp.path()).await, CorpusState::Incomplete);
        });
    }

    /// Guards the enrolment check itself: a state file that somehow carries
    /// `corpus_complete` without an identity is not a complete corpus, it is a
    /// device that never enrolled — and the ORDER of the match arms is what makes
    /// that true. Swapping them would let a stray flag bypass the gate.
    #[test]
    fn completeness_without_an_identity_reads_as_never_enrolled() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("corpus-flag-only").unwrap();
            seed(
                tmp.path(),
                &SyncState {
                    corpus_complete: true,
                    ..Default::default()
                },
            )
            .await;
            assert_eq!(corpus_state(&IO, tmp.path()).await, CorpusState::NotSynced);
        });
    }
}
