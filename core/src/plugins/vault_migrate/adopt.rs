// SPDX-License-Identifier: AGPL-3.0
//! Joining a generation someone else's migration produced (myne-md/myne#447).
//!
//! The §10.4.1 migration re-keys a vault on ONE device. Every peer then meets a
//! vault head it cannot open, asks the §5.6.1 question ("is the server's
//! `vault.meta` a newer generation?"), and locks. What it does next is this
//! module.
//!
//! # Why the peer does not simply adopt the server's meta
//!
//! Because `vault.meta` holds the only local copy of the wrapped `root_key`, and
//! overwriting it on a server's say-so is a data-availability hole: a server
//! that serves a fabricated `NTV5` blob makes the vault un-unlockable and
//! strands every local note. Not a confidentiality break — nobody can forge a
//! meta that opens under the user's password — but a loss on the one file that
//! must not be lost.
//!
//! The sync cycle therefore **stages** rather than replaces, and the unlock path
//! **promotes on proof**: the staged meta becomes `vault.meta` only once the
//! user's own credential has opened it. `sync-protocol.md` §5.6.1 already
//! carried the argument — *"a v0.2 meta opens only under credentials the user
//! holds"* — and this is that sentence made operational.
//!
//! # Why the staged copy is tried FIRST
//!
//! The load-bearing ordering, and the one that is easy to get backwards: the
//! peer's own `vault.meta` still opens under the same password, so a
//! try-the-staged-one-only-if-the-primary-fails design would never promote
//! anything. The peer would unlock happily into the previous generation, sync
//! would meet the same unopenable head, and it would lock again — which is
//! exactly the loop this module exists to end.

use std::path::{Path, PathBuf};

use crate::vault_io::{VaultIo, WriteOpts};

/// `<vault>/vault.meta.incoming` — a newer-generation `vault.meta` the sync
/// cycle fetched and staged, awaiting a credential that can open it.
///
/// Deliberately NOT `vault.meta.tmp`: that name belongs to `atomic_write`'s
/// in-flight temp and is recognised as a partial write by
/// `vault_artifacts_present`. A staged meta is a complete, durable file with a
/// different meaning.
pub(crate) const INCOMING_META_FILE: &str = "vault.meta.incoming";

pub(crate) fn incoming_meta_path(vault_root: &Path) -> PathBuf {
    vault_root.join(INCOMING_META_FILE)
}

/// Stage `bytes` for the next unlock to prove. Best-effort: failing to stage
/// leaves the peer exactly where it was (locked, on the old generation), which
/// is the honest outcome for a device that could not write to its own vault.
pub(crate) async fn stage_incoming_meta(io: &dyn VaultIo, vault_root: &Path, bytes: &[u8]) {
    let _ = io
        .write(&incoming_meta_path(vault_root), bytes, WriteOpts::default())
        .await;
}

/// The staged meta, or `None` when nothing is staged — the ordinary case on
/// every vault that has never had a peer migrate.
pub(crate) async fn read_incoming_meta(io: &dyn VaultIo, vault_root: &Path) -> Option<Vec<u8>> {
    io.read(&incoming_meta_path(vault_root)).await.ok()
}

/// Drop a staged meta that a credential did NOT open.
///
/// Left in place it would be re-tried — and re-paid for in Argon2id — on every
/// unlock for the life of the vault. A staged meta that this vault's own
/// credential cannot open is either a fabrication or a stale artefact of an
/// aborted migration; neither improves by being kept.
pub(crate) async fn discard_incoming_meta(io: &dyn VaultIo, vault_root: &Path) {
    let _ = io.remove_file(&incoming_meta_path(vault_root)).await;
}

/// Adopt the staged meta as this vault's own, having proved it opens.
///
/// # Order, and why this one
///
/// Stale artefacts first, then the meta, then the staging file — so that every
/// interruption lands somewhere recoverable:
///
///  - **after the drops, before the meta write** — caches gone, meta still the
///    old generation. The next unlock opens the old vault and rebuilds them; the
///    staged meta is still there, so the promotion simply happens later.
///  - **after the meta write, before the staging file goes** — meta adopted,
///    caches gone, staging file still present. The next unlock tries it first,
///    it opens (identical bytes), and promotion runs again idempotently.
///
/// The forbidden order is the reverse: writing the meta while the old-root
/// artefacts survive leaves `vault.prefs` / `vault.attachments` / `vault.themes`
/// undecryptable-but-present, which their readers answer as EMPTY — and an empty
/// local singleton is one push away from overwriting the migrating device's real
/// data.
pub(crate) async fn promote_incoming_meta(io: &dyn VaultIo, vault_root: &Path, bytes: &[u8]) {
    // **Only a promotion that REPLACES the root may drop anything** (myne-md/myne#911
    // review). Everything below exists because the v0.1 to v0.2 hop re-keys the
    // vault: an artefact sealed under the old root is unreadable bytes that their
    // readers answer as EMPTY, one push away from overwriting the re-sealing
    // device's data. The `NTV6` to `NTV7` promotion this feature stages changes the
    // CREDENTIAL side only; `root_key`, `items_key`, the group key and every KEK
    // are byte-identical, so dropping them destroys state that was still perfectly
    // readable, including two things that cannot be recovered: `vault.head-state`
    // (the sync-protocol §7 record "not reconstructible from the server, by
    // design", so the rollback defence silently falls back to a TOFU re-bootstrap)
    // and `vault.dictionary` ("NOT recoverable ... a word list emptied").
    let replaces_root = io
        .read(&vault_root.join("vault.meta"))
        .await
        .ok()
        .map(|current| {
            protocol::vault_meta_generation(&current) == protocol::VaultMetaGeneration::Legacy
        })
        .unwrap_or(false);

    if replaces_root {
        drop_artefacts_under_replaced_root(io, vault_root).await;
    }

    if io
        .write(&vault_root.join("vault.meta"), bytes, WriteOpts::default())
        .await
        .is_err()
    {
        // The meta did not land. Leave the staging file: the next unlock
        // re-attempts the whole promotion.
        return;
    }

    // The meta phase's baseline must name what is now on disk. Left stale it
    // reads "this device changed its meta", and the next cycle argues with the
    // server about a generation it just adopted.
    // Through the locked mutation, because a cycle may be holding its own copy of this
    // record while the promotion lands (myne-md/myne#964).
    //
    // On a root-replacing promotion the old generation's singleton baselines are keyed
    // by sync-ids derived from the OLD `root_key`, which this device no longer has and
    // cannot re-derive, so they cannot be removed by name here. They are inert: nothing
    // will ever look those keys up again.
    let baseline = Some(crate::plugins::sync::orchestrator::sha256_hex(bytes));
    let _ = crate::plugins::sync::state::update_sync_state(io, vault_root, |state| {
        state.meta_baseline_hex = baseline.clone();
        ((), crate::plugins::sync::state::Persist::Yes)
    })
    .await;

    discard_incoming_meta(io, vault_root).await;
}

/// Every artefact that only a REPLACED root makes unreadable. Split out so the
/// promotion path can skip it, and kept together so the reason stays in one place.
async fn drop_artefacts_under_replaced_root(io: &dyn VaultIo, vault_root: &Path) {
    // The synced singletons are dropped IN ADDITION to the shared roster. The
    // migrating device re-seals these (it holds both keys for one moment); a
    // peer never does, so for it they are unreadable bytes that come back from
    // the server under the new generation's sync-ids.
    super::drop_artefacts_sealed_under_replaced_root(
        io,
        vault_root,
        &[
            "vault.prefs",
            "vault.attachments",
            "vault.themes",
            "vault.chats",
            "vault.agent-memory",
            "vault.personality",
        ],
    )
    .await;

    // The roster drop takes `vault.quickunlock` and leaves the Keychain wrap key
    // that opens it. This peer never re-seals the old generation, so nothing else
    // would ever remove it (myne-md/myne#761, `agent-tooling/design-notes/security/0709`).
    // Called before the `vault.meta` write at the end of this function, so the
    // address is still readable.
    crate::plugins::quick_unlock::commands::invalidate_credential(vault_root);

    // `chats/` (`MYJ1` per-conversation files, myne-md/myne#675) is the
    // per-file twin of the catalog drop above: sealed under the old
    // `chats-key`, so the whole subtree goes with it. The files come back
    // from the server under the new generation (the conversation id is
    // generation-independent, so the roster re-resolves by id). This lives
    // HERE, on the peer-promotion path only: the migrating device re-seals
    // these files in place instead (it holds both keys for one moment), so
    // the shared drop helper must not touch the subtree.
    let _ = io.remove_dir_all(&vault_root.join("chats")).await;

    // `memories/` (`MYX1` per-entry files, myne-md/myne#697) is the per-file
    // twin of the catalog drop above: sealed under the old `AgentMemoryKey`,
    // so the whole subtree goes with it. Same recovery story as `chats/`
    // (files come back from the server under the new generation; entry ids
    // are generation-independent).
    let _ = io.remove_dir_all(&vault_root.join("memories")).await;

    // The personal dictionary (`MYD1`) is dropped with them and is NOT
    // recoverable: it is sealed under the old root and is not synced, and the
    // two roots are never in memory at once, so nothing can re-seal it. Recorded
    // in `decisions.md` rather than discovered by a user whose word list emptied.
    let _ = io.remove_file(&vault_root.join("vault.dictionary")).await;
}
