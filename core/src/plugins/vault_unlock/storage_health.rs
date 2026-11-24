// SPDX-License-Identifier: AGPL-3.0-only
//! Did the local copy go away underneath a live session?
//! (phase3-web-client task 22)
//!
//! # The three answers, and why collapsing any two of them is wrong
//!
//! The boot probe ([`super::commands::vault_status_from_host`]) has two: a
//! readable `vault.meta` is `Exists`, an absent one is `Missing`, an unparseable
//! one is `Corrupted`. That is the right vocabulary **at boot**, where there is
//! no session to contradict. Mid-session it is not, because the same three
//! on-disk states mean different things once the slot is unlocked:
//!
//! * **`Missing` at boot** = first run. **`Missing` mid-session** = the storage
//!   the running session is reading from has been *taken away* — on a browser,
//!   an origin eviction under storage pressure. The user did not do it, nothing
//!   is corrupt, and telling them the vault is "missing" invites them to
//!   conclude they lost it.
//! * **`Corrupted`** on a desktop means a damaged file and the honest advice is
//!   to restore a backup. On a client whose local copy is a *cache of a
//!   server-held vault* it means the cache is unusable — and the remedy is to
//!   discard it and re-materialise, which is not the same instruction at all.
//!
//! Task 22's first acceptance criterion is literally "eviction detected, **not
//! misreported as corruption**", and this module is where that distinction is
//! made rather than assumed.
//!
//! # What this can and cannot know
//!
//! It cannot tell a first run from a post-eviction run **at boot**: eviction
//! removes the whole container, including anything that could have recorded that
//! it happened, so the two are byte-identically indistinguishable. Pretending
//! otherwise would need durable state outside the evicted store, which does not
//! exist. What it CAN do is catch eviction *while the session is still alive* —
//! keys in RAM, slot unlocked, container gone — which is the case that actually
//! matters, because that is the moment unsynced edits are lost and the only
//! moment the client still knows what they were.
//!
//! # Native clients get the same call and a different answer
//!
//! Nothing here is browser-specific. A desktop vault directory can also vanish
//! mid-session (an unmounted volume, a user deleting it, a sync-folder tool). The
//! *detection* is identical; what differs is the remedy, which is the caller's —
//! a browser re-materialises from the server, a desktop does not, and this module
//! deliberately reports the condition without naming a cure.

use crate::io_failure_kind::IoFailureKind;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use serde::Serialize;
use std::path::Path;

/// The health of the storage a live session is reading from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum StorageHealth {
    /// The container and a parseable `vault.meta` are both present. The ordinary
    /// answer, and the only one that is not news.
    Healthy,
    /// No session is unlocked, so there is nothing to contradict. Boot routing
    /// owns this case; asking mid-session questions of a locked client would
    /// turn an ordinary locked state into an alarm.
    NotUnlocked,
    /// The slot is unlocked and the container is **gone**. On a browser this is
    /// an origin eviction; on a native client, a vanished directory. Either way
    /// the running session holds the only copy of anything unsynced.
    Evicted,
    /// The container is there and `vault.meta` cannot be read as one.
    ///
    /// On a double-buffered store this means **neither** copy verified — the
    /// seam's read already falls back to the older buffer, so reaching here is
    /// not "the newest write was torn", it is "both are unusable". Task 18 stops
    /// at the fallback and says nothing about this case; naming it is what stops
    /// it being a dead end.
    Unopenable,
    /// The probe itself failed. Reported rather than folded into `Evicted`,
    /// because "I could not look" and "it is not there" call for opposite
    /// responses and a client that erases on the first would be destroying a
    /// vault over a transient read error.
    Unknown {
        /// Closed, DENY-list-safe reduction of the underlying failure.
        io_error_kind: IoFailureKind,
    },
}

/// Probe the active vault's storage against the live session.
///
/// Cheap by construction: one slot peek, one `exists`, and a read of a 345-byte
/// file. No key material is touched and nothing is written, so a caller may poll
/// it — which is how a browser notices an eviction that happens while the user is
/// mid-sentence rather than at the next reload.
pub async fn probe_storage_health(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
) -> StorageHealth {
    // An unlocked slot is the whole premise. Without one there is no session
    // whose reality can be contradicted, and every on-disk state is boot
    // routing's ordinary business.
    let Some(vault_id) = state.active_vault_id().await else {
        return StorageHealth::NotUnlocked;
    };
    if !matches!(state.slot_kind(vault_id).await, SlotKind::Unlocked) {
        return StorageHealth::NotUnlocked;
    }
    let Ok(root) = crate::paths::vault_root_for_id_from_host(host, vault_id) else {
        return StorageHealth::Unknown {
            io_error_kind: IoFailureKind::Other,
        };
    };
    probe_storage_health_at(io, &root).await
}

/// The path-taking core, so the three-way decision is testable without a host.
pub async fn probe_storage_health_at(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
) -> StorageHealth {
    let meta_path = vault_root.join("vault.meta");
    match io.read(&meta_path).await {
        Ok(bytes) => {
            if protocol::parse_vault_meta_any(&bytes).is_ok() {
                StorageHealth::Healthy
            } else {
                // Reached only when the seam's newest-intact fallback has already
                // been exhausted — on the browser's double-buffered store, both
                // copies. Deliberately NOT `Evicted`: something is there, and a
                // caller that erased it as if nothing were would be destroying
                // whatever else the container still holds.
                StorageHealth::Unopenable
            }
        }
        Err(IoFailureKind::NotFound) => {
            // The meta is gone. Two very different situations share that: the
            // whole container went (eviction) or just this file did. Ask, because
            // the second one is `Unopenable`'s neighbour, not eviction's — a
            // container that survived is a container whose other bytes are still
            // there to be salvaged or erased deliberately.
            match io.exists(vault_root).await {
                Ok(true) => StorageHealth::Unopenable,
                Ok(false) => StorageHealth::Evicted,
                Err(io_error_kind) => StorageHealth::Unknown { io_error_kind },
            }
        }
        Err(io_error_kind) => StorageHealth::Unknown { io_error_kind },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;
    use crate::vault_io::{StdVaultIo, VaultIo, WriteOpts};

    const IO: StdVaultIo = StdVaultIo;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn a_meta() -> Vec<u8> {
        use crate::plugins::vault_creation::commands::{
            build_and_serialize_vault_meta, build_session,
        };
        let session = build_session(
            crate::vault_id::VaultId::mint(),
            "CanaryPass-9-animals!",
            crate::test_support::FAST_TEST_KDF,
        )
        .expect("build_session");
        build_and_serialize_vault_meta(&session)
            .expect("serialize")
            .to_vec()
    }

    #[test]
    fn a_present_parseable_meta_is_healthy() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("sh-healthy").unwrap();
            IO.write(
                &tmp.path().join("vault.meta"),
                &a_meta(),
                WriteOpts::default(),
            )
            .await
            .unwrap();
            assert_eq!(
                probe_storage_health_at(&IO, tmp.path()).await,
                StorageHealth::Healthy
            );
        });
    }

    /// The criterion, stated as a test: a vanished CONTAINER is eviction, and
    /// eviction is not corruption. A client that reported `Unopenable` here would
    /// tell the user their vault is damaged, which invites them to go looking for
    /// a backup of something that is intact on the server.
    #[test]
    fn a_vanished_container_is_eviction_not_corruption() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("sh-evicted").unwrap();
            let gone = tmp.path().join("no-such-container");
            assert_eq!(
                probe_storage_health_at(&IO, &gone).await,
                StorageHealth::Evicted
            );
        });
    }

    /// The mirror case, and the reason `Evicted` asks about the container rather
    /// than inferring it from the meta alone: a container that survived is one
    /// whose remaining bytes are still there. Calling that eviction would invite
    /// a caller to erase a store it never looked at.
    #[test]
    fn a_surviving_container_with_no_meta_is_unopenable_not_evicted() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("sh-nometa").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            IO.write(
                &notes.join("keep.myn"),
                b"a note nobody has pushed",
                WriteOpts::default(),
            )
            .await
            .unwrap();
            assert_eq!(
                probe_storage_health_at(&IO, tmp.path()).await,
                StorageHealth::Unopenable
            );
        });
    }

    /// Task 18 stops at "a torn newest buffer falls back to the older one" and is
    /// silent about both failing. This is that case, and it must be a NAMED state
    /// rather than a dead end — it is the one task 95's fail-closed CTA routes on.
    #[test]
    fn a_meta_that_parses_as_nothing_is_unopenable() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("sh-unopenable").unwrap();
            IO.write(
                &tmp.path().join("vault.meta"),
                b"not a MYV1 blob at all",
                WriteOpts::default(),
            )
            .await
            .unwrap();
            assert_eq!(
                probe_storage_health_at(&IO, tmp.path()).await,
                StorageHealth::Unopenable
            );
        });
    }

    /// A locked client asks no mid-session questions. Without this the probe
    /// would report `Evicted` for every ordinary first run, turning boot routing's
    /// normal empty state into an alarm about data that never existed.
    #[test]
    fn a_client_with_no_unlocked_slot_reports_not_unlocked() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let host = crate::host::NoopHost;
            assert_eq!(
                probe_storage_health(&host, &IO, &state).await,
                StorageHealth::NotUnlocked
            );
        });
    }
}
