// SPDX-License-Identifier: AGPL-3.0

//! The host surface of the member-names store: the session-facing cores and their
//! Tauri wrappers.
//!
//! Everything here is the GLUE the store deliberately avoids: resolve the active
//! vault root, read `vault.meta` once for the account hash and the group epoch,
//! require a shared (`NTV6`) vault, derive the group-tier KEK, take the session's
//! person identity as the signer, and hand all of that to
//! [`super::store`]. The read-modify-write itself is tested host-free in the store's
//! own module, so this layer is thin by construction.
//!
//! Native-only, like the person account plane it borrows its session accessors from:
//! `person_identity_status` does not exist on `wasm32`, and this family is
//! desktop/mobile by decision (the web client has no member sharing at all).

use super::error::MemberNamesError;
use super::store::{
    clear_my_name_in_dir, merge_pulled_blob_in_dir, read_member_names_in_dir, set_my_name_in_dir,
    write_mutex, MemberNamesWriter,
};
use super::sync::{resolve_names_from_group_key, ResolvedNames};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_io::VaultIo;
use protocol::MemberNamesMap;
use std::path::Path;

/// Resolve the family's keyspace from a live session and `vault.meta`.
///
/// A shared session holds the group key; a pre-B2B one holds only the owner root, and
/// this family is not for it (see [`MemberNamesError::NotASharedVault`]). The key, the
/// account hash and the epoch are resolved by the ONE shared resolver
/// ([`super::sync::resolve_names_from_group_key`]) the sync engine calls too, so the
/// command layer and the sync phase can never derive two different keys.
pub async fn resolve_names(
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) -> Result<ResolvedNames, MemberNamesError> {
    let shared = state
        .peek_unlocked_shared_singleton_key()
        .await
        .ok_or(MemberNamesError::SlotNotUnlocked)?;
    let group = shared
        .group_bytes()
        .ok_or(MemberNamesError::NotASharedVault)?;
    resolve_names_from_group_key(io, &group, vault_dir).await
}

/// The caller's person identity as a signer: the keypair that signs, and the
/// `person_id_hash` the row is keyed by. Both come from the session's person plane.
async fn writer_for<'a>(
    state: &'a VaultRuntimeState,
    pair: &'a protocol::PersonKeyPair,
    person_id: &'a [u8; 16],
) -> MemberNamesWriter<'a> {
    let _ = state;
    MemberNamesWriter {
        person: pair,
        person_id,
    }
}

/// The person id of the session's own identity, or [`MemberNamesError::SlotNotUnlocked`]
/// when no person is installed, so a caller cannot write a row it cannot key.
pub async fn session_person_id(
    state: &VaultRuntimeState,
) -> Result<(protocol::PersonKeyPair, [u8; 16]), MemberNamesError> {
    let snapshot = state
        .person_identity_status()
        .await
        .ok_or(MemberNamesError::SlotNotUnlocked)?;
    let pair = state
        .clone_person_identity()
        .await
        .ok_or(MemberNamesError::SlotNotUnlocked)?;
    Ok((pair, snapshot.person_id))
}

/// Testable core of the list command: the LIVE map, tombstones filtered out because a
/// tombstone is a merge input rather than a row a user sees.
pub async fn member_names_list_with_dir(
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) -> Result<MemberNamesMap, MemberNamesError> {
    let resolved = resolve_names(io, state, vault_dir).await?;
    let map = read_member_names_in_dir(io, vault_dir, &resolved.borrow()).await?;
    Ok(protocol::live_member_names(&map))
}

/// Testable core of the set command. Signs with the session's own person, which is the
/// only signer [`super::store::set_my_name_in_dir`] accepts for one's own row.
pub async fn member_names_set_mine_with_dir(
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
    name: &str,
) -> Result<MemberNamesMap, MemberNamesError> {
    // Serialized against the sync phase's own read-merge-write of this map
    // (`sync_member_names_phase`); without it a merge landing between this call's read
    // and its write silently discards the row it just signed.
    let _guard = write_mutex().lock().await;
    // And held off from a group rotation's re-seal for the whole read-modify-write,
    // which the mutex above does not do (`store::write_mutex` states the pair).
    let _quiesce = crate::singleton_quiesce::shared().await;
    let resolved = resolve_names(io, state, vault_dir).await?;
    let (pair, person_id) = session_person_id(state).await?;
    let writer = writer_for(state, &pair, &person_id).await;
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let map =
        set_my_name_in_dir(io, vault_dir, &resolved.borrow(), &writer, &mut rng, name).await?;
    Ok(protocol::live_member_names(&map))
}

/// Testable core of the clear command: a self-signed tombstone.
pub async fn member_names_clear_mine_with_dir(
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) -> Result<MemberNamesMap, MemberNamesError> {
    let _guard = write_mutex().lock().await;
    let _quiesce = crate::singleton_quiesce::shared().await;
    let resolved = resolve_names(io, state, vault_dir).await?;
    let (pair, person_id) = session_person_id(state).await?;
    let writer = writer_for(state, &pair, &person_id).await;
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let map = clear_my_name_in_dir(io, vault_dir, &resolved.borrow(), &writer, &mut rng).await?;
    Ok(protocol::live_member_names(&map))
}

/// Testable core of the pull path: merge a pulled copy into the local map.
pub async fn member_names_merge_pulled_with_dir(
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
    pulled: &[u8],
) -> Result<MemberNamesMap, MemberNamesError> {
    let _guard = write_mutex().lock().await;
    let _quiesce = crate::singleton_quiesce::shared().await;
    let resolved = resolve_names(io, state, vault_dir).await?;
    merge_pulled_blob_in_dir(io, vault_dir, &resolved.borrow(), pulled).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
async fn active_vault_dir<R: tauri::Runtime>(
    host: &crate::host::tauri_host::TauriHost<R>,
    state: &VaultRuntimeState,
) -> Result<std::path::PathBuf, MemberNamesError> {
    use crate::host::HostCtx;
    let base = host
        .app_data_dir()
        .map_err(|_| MemberNamesError::SlotNotUnlocked)?;
    Ok(crate::paths::active_vault_root_from_base(
        &base,
        state.active_vault_id().await,
    ))
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn member_names_list<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<MemberNamesMap, MemberNamesError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    let io = crate::vault_io::StdVaultIo;
    let dir = active_vault_dir(&host, state.inner()).await?;
    member_names_list_with_dir(&io, state.inner(), &dir).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn member_names_set_mine<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    name: String,
) -> Result<MemberNamesMap, MemberNamesError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    let io = crate::vault_io::StdVaultIo;
    let dir = active_vault_dir(&host, state.inner()).await?;
    member_names_set_mine_with_dir(&io, state.inner(), &dir, &name).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn member_names_clear_mine<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<MemberNamesMap, MemberNamesError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    let io = crate::vault_io::StdVaultIo;
    let dir = active_vault_dir(&host, state.inner()).await?;
    member_names_clear_mine_with_dir(&io, state.inner(), &dir).await
}

#[cfg(test)]
mod tests {
    use crate::plugins::vault_unlock::state::VaultRuntimeState;
    use crate::vault_io::StdVaultIo;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// Prove a writer holds the SHARED side of the singleton barrier, by BLOCKING.
    ///
    /// Blocking is the only observable a guard like this has: a writer that acquired it
    /// and one that never did produce the same result, just at different times. So the
    /// future is started while the barrier is held EXCLUSIVELY and must not finish.
    ///
    /// Nothing here needs a real vault, and that is deliberate rather than a shortcut: the
    /// gate is taken BEFORE the first host or IO call, so a writer that reached the vault at
    /// all would fail on the empty state and finish, which is what the assertion catches.
    /// A fixture with a live session would prove the same thing more slowly and would make
    /// the failure look like a fixture problem.
    async fn assert_holds_the_shared_side<F>(what: &str, make: impl FnOnce() -> F + Send + 'static)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let exclusive = crate::singleton_quiesce::exclusive().await;

        let done = Arc::new(AtomicBool::new(false));
        let flag = done.clone();
        let handle = tokio::spawn(async move {
            make().await;
            flag.store(true, Ordering::SeqCst);
        });

        // Yield so the spawned task reaches the lock and blocks, the shape
        // `singleton_quiesce`'s own test uses (a `try_read` probe races the scheduler).
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        assert!(
            !done.load(Ordering::SeqCst),
            "{what} completed while a group rotation held the singleton barrier \
             EXCLUSIVELY, so its read-modify-write can interleave with the epoch re-seal \
             and publish ciphertext no session can open"
        );

        drop(exclusive);
        handle.await.expect("writer task joins");
        assert!(
            done.load(Ordering::SeqCst),
            "{what} must proceed once the rotation has committed"
        );
    }

    /// Every writer of `vault.member-names` owes BOTH gates (`store::write_mutex` states
    /// the pair). The mutex is this family's own; the barrier is what holds a group
    /// rotation's re-seal off, and this family is the one shared singleton whose writer was
    /// added without it (myne-md/myne#851).
    ///
    /// The sync phase's writer (`sync_member_names_phase`) takes the same pair and is not
    /// covered here: it needs a real vault plus a sync state, and its guard is one line
    /// beside the mutex it already took, reviewed rather than driven.
    #[test]
    fn every_names_writer_holds_the_shared_singleton_barrier() {
        crate::test_support::block_on(async {
            let dir = || std::path::PathBuf::from("/nonexistent-base");

            let state = Arc::new(VaultRuntimeState::default());
            let d = dir();
            assert_holds_the_shared_side("member_names_set_mine_with_dir", move || async move {
                let _ =
                    super::member_names_set_mine_with_dir(&StdVaultIo, &state, &d, "name").await;
            })
            .await;

            let state = Arc::new(VaultRuntimeState::default());
            let d = dir();
            assert_holds_the_shared_side("member_names_clear_mine_with_dir", move || async move {
                let _ = super::member_names_clear_mine_with_dir(&StdVaultIo, &state, &d).await;
            })
            .await;

            let state = Arc::new(VaultRuntimeState::default());
            let d = dir();
            assert_holds_the_shared_side(
                "member_names_merge_pulled_with_dir",
                move || async move {
                    let _ = super::member_names_merge_pulled_with_dir(&StdVaultIo, &state, &d, &[])
                        .await;
                },
            )
            .await;
        });
    }
}
