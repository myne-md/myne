// SPDX-License-Identifier: AGPL-3.0

//! The host surface of the device-binding store: the session-facing cores, the
//! best-effort unlock hook, and their Tauri wrappers.
//!
//! Everything here is the GLUE the store deliberately avoids: resolve the active
//! vault root, read `vault.meta` once for the account hash and the group epoch,
//! require a shared (`NTV6`) vault, derive the group-tier KEK, take the session's
//! person identity as the signer and the device's enrolled id as the row key, and
//! hand all of that to [`super::store`]. The read-modify-write itself is tested
//! host-free in the store's own module, so this layer is thin by construction.
//!
//! Native-only, like the person account plane it borrows its session accessors from:
//! `person_identity_status` does not exist on `wasm32`, and this family is
//! desktop/mobile by decision (the web client has no member sharing at all).

use super::error::DeviceBindingError;
use super::store::{claim_self_in_dir, read_device_bindings_in_dir, write_mutex, ClaimOutcome};
use super::sync::{resolve_bindings_from_group_key, ResolvedBindings};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_io::VaultIo;
use protocol::DeviceBindingsMap;
use std::path::Path;

/// Resolve the family's keyspace from a live session and `vault.meta`.
///
/// A shared session holds the group key; a pre-B2B one holds only the owner root, and
/// this family is not for it (see [`DeviceBindingError::NotASharedVault`]). The key, the
/// account hash and the epoch are resolved by the ONE shared resolver
/// ([`super::sync::resolve_bindings_from_group_key`]) the sync engine calls too, so the
/// command layer and the sync phase can never derive two different keys.
pub async fn resolve_bindings(
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) -> Result<ResolvedBindings, DeviceBindingError> {
    let shared = state
        .peek_unlocked_shared_singleton_key()
        .await
        .ok_or(DeviceBindingError::SlotNotUnlocked)?;
    let group = shared
        .group_bytes()
        .ok_or(DeviceBindingError::NotASharedVault)?;
    resolve_bindings_from_group_key(io, &group, vault_dir).await
}

/// The session's own person identity as a signer.
///
/// [`DeviceBindingError::SlotNotUnlocked`] when no person is installed, because a row
/// with no person behind it cannot be signed and must not be written.
pub async fn session_person_id(
    state: &VaultRuntimeState,
) -> Result<(protocol::PersonKeyPair, [u8; 16]), DeviceBindingError> {
    let snapshot = state
        .person_identity_status()
        .await
        .ok_or(DeviceBindingError::SlotNotUnlocked)?;
    let pair = state
        .clone_person_identity()
        .await
        .ok_or(DeviceBindingError::SlotNotUnlocked)?;
    Ok((pair, snapshot.person_id))
}

/// This device's enrolled id, the key its binding row is written under.
///
/// From `sync-state.json`'s `device_id_hex`, through the ONE reader note authoring also
/// uses ([`crate::plugins::sync::state::read_device_actor`]), so the id a note is
/// authored under and the id a binding is claimed under are the same bytes by
/// construction rather than by two agreeing hex writers.
///
/// A never-enrolled vault has no id at all, which is [`DeviceBindingError::NoDeviceId`]
/// rather than a fresh draw: an id invented at claim time would bind a device the sync
/// plane has never heard of, and the row would be keyed by something nothing else in the
/// tree can name.
pub async fn session_device_id(
    io: &dyn VaultIo,
    vault_dir: &Path,
) -> Result<[u8; 16], DeviceBindingError> {
    crate::plugins::sync::state::read_device_actor(io, vault_dir)
        .await
        .ok_or(DeviceBindingError::NoDeviceId)
}

/// Testable core of the list command: the LIVE map, tombstones filtered out because a
/// tombstone is a merge input rather than a row a user sees.
///
/// **These rows are NOT signature-verified, so a caller MUST NOT render a row's claimed
/// person as the device's owner.** The map is group-sealed, and that seal is precisely what
/// makes it writable by every member; the map key is the DEVICE with the claimed person
/// inside the row, so the only thing that makes a claim mean anything is
/// `protocol::partition_verified_bindings` against the signed roster (§9.30.5), which this
/// function has no access to. The rendering path today is
/// `sync::identity_resolver::join_durable_attribution`, and it does partition. A caller
/// added here owes the same partition before it names anyone; a device-to-member settings
/// list is the surface that will, and it is the reason this command exists unwired.
pub async fn device_bindings_list_with_dir(
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) -> Result<DeviceBindingsMap, DeviceBindingError> {
    let resolved = resolve_bindings(io, state, vault_dir).await?;
    let map = read_device_bindings_in_dir(io, vault_dir, &resolved.borrow()).await?;
    Ok(protocol::live_device_bindings(&map))
}

/// Testable core of the claim: write this device's own row if it is absent or stale.
///
/// Returns the LIVE map, so a caller renders exactly what the list command would, plus
/// whether the call actually wrote, which is what makes the idempotence a claim a test
/// can assert rather than infer from a timestamp.
///
/// Takes BOTH gates, the same pair every writer of a group-sealed singleton owes
/// (`super::store::write_mutex` states the reasons): the family mutex against the sync
/// phase's own merge of this map, and the shared side of the singleton barrier against a
/// group rotation's epoch re-seal.
pub async fn claim_own_binding_with_dir(
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) -> Result<(DeviceBindingsMap, ClaimOutcome), DeviceBindingError> {
    let _guard = write_mutex().lock().await;
    let _quiesce = crate::singleton_quiesce::shared().await;
    let resolved = resolve_bindings(io, state, vault_dir).await?;
    let (person, _person_id) = session_person_id(state).await?;
    let device_id = session_device_id(io, vault_dir).await?;
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let (map, outcome) = claim_self_in_dir(
        io,
        vault_dir,
        &resolved.borrow(),
        &person,
        &device_id,
        &mut rng,
    )
    .await?;
    Ok((protocol::live_device_bindings(&map), outcome))
}

/// Claim this device's binding, best effort, from the unlock pipeline and from the
/// invite-accept tail.
///
/// **Why this is a core call rather than a `VaultLifecycleHooks` method.** The step is
/// host-independent, `NTV6`-only and needs no platform capability, while a fifth trait
/// method would owe four implementations plus a `check-lock-teardown` answer on each, for
/// a step whose whole content is "read the map, maybe write one row". The two hooks that
/// DO need the trait (attachment refs, the search index) need it because their bodies are
/// platform-specific. This one is not.
///
/// Best-effort by design: it logs and returns, because a device that failed to record its
/// binding must still be able to open its vault, and the next unlock retries. It is
/// deliberately silent about WHY it stood down in the ordinary cases (locked slot, NTV5
/// vault, no device id, no person session), because those are states the two callers
/// reach routinely and a warning per unlock would be noise rather than signal.
pub async fn claim_own_binding_best_effort(
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) {
    match claim_own_binding_with_dir(io, state, vault_dir).await {
        Ok((_map, _outcome)) => {}
        Err(DeviceBindingError::SlotNotUnlocked)
        | Err(DeviceBindingError::NotASharedVault)
        | Err(DeviceBindingError::NoDeviceId) => {}
        Err(error) => {
            tracing::warn!(
                event = "device_binding_claim_failed",
                error = %error,
                "the unlock-time device-binding claim did not complete; the next unlock retries"
            );
        }
    }
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
async fn active_vault_dir<R: tauri::Runtime>(
    host: &crate::host::tauri_host::TauriHost<R>,
    state: &VaultRuntimeState,
) -> Result<std::path::PathBuf, DeviceBindingError> {
    use crate::host::HostCtx;
    let base = host
        .app_data_dir()
        .map_err(|_| DeviceBindingError::SlotNotUnlocked)?;
    Ok(crate::paths::active_vault_root_from_base(
        &base,
        state.active_vault_id().await,
    ))
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn device_bindings_list<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<DeviceBindingsMap, DeviceBindingError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    let io = crate::vault_io::StdVaultIo;
    let dir = active_vault_dir(&host, state.inner()).await?;
    device_bindings_list_with_dir(&io, state.inner(), &dir).await
}

/// Register this device's own binding and answer the live map.
///
/// The write is the SAME operation the unlock pipeline performs, so a caller that wants
/// to force a re-claim (after an identity change, or after the user re-installed this
/// device's identity) does not need a second code path. It cannot write another device's
/// row: the row key is this device's own enrolled id and the signer is this session's own
/// person, both read from the session rather than from the caller's arguments.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn device_bindings_claim<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<DeviceBindingsMap, DeviceBindingError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    let io = crate::vault_io::StdVaultIo;
    let dir = active_vault_dir(&host, state.inner()).await?;
    let (map, _outcome) = claim_own_binding_with_dir(&io, state.inner(), &dir).await?;
    Ok(map)
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
    /// the failure look like a fixture problem. Copied from
    /// `member_names::commands`'s twin, because the obligation is the same one.
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
             and publish a `vault.device-bindings` blob no session can open, which the \
             next read collapses to the empty map over every member's real row"
        );

        drop(exclusive);
        handle.await.expect("writer task joins");
        assert!(
            done.load(Ordering::SeqCst),
            "{what} must proceed once the rotation has committed"
        );
    }

    /// The claim is the one writer this module owns, and it owes BOTH gates
    /// (`super::store::write_mutex` states the pair). The mutex is asserted by
    /// construction and by review: it is the first statement of the function, and a
    /// second writer in the same family taking a different one would still show up
    /// here as a claim that proceeds during a rotation.
    ///
    /// The sync phase's writer (`sync_device_bindings_phase`) takes the same pair and
    /// is not covered here: it needs a real vault, a transport and a sync state, and
    /// its gate is one line beside the mutex it already took, reviewed rather than
    /// driven. The unlock hook and the invite-accept tail both route through this very
    /// function, so they are covered by this test rather than by two of their own.
    #[test]
    fn the_claim_writer_holds_the_shared_singleton_barrier() {
        crate::test_support::block_on(async {
            let dir = || std::path::PathBuf::from("/nonexistent-base");

            let state = Arc::new(VaultRuntimeState::default());
            let d = dir();
            assert_holds_the_shared_side("claim_own_binding_with_dir", move || async move {
                let _ = super::claim_own_binding_with_dir(&StdVaultIo, &state, &d).await;
            })
            .await;

            // The best-effort hook is the SAME call, which is the property that keeps
            // the unlock path from being the one writer that forgot a gate.
            let state = Arc::new(VaultRuntimeState::default());
            let d = dir();
            assert_holds_the_shared_side("claim_own_binding_best_effort", move || async move {
                super::claim_own_binding_best_effort(&StdVaultIo, &state, &d).await;
            })
            .await;
        });
    }

    /// The READ command refuses a session it cannot read, rather than answering an empty map.
    ///
    /// `device_bindings_list` is deliberately UNWIRED today (see its own doc: the
    /// device-to-member settings list is the surface it exists for, and it owes
    /// `protocol::partition_verified_bindings` before it names anyone), so nothing in the
    /// tree would notice it breaking. This test is the whole of its coverage, and it is
    /// written against the failure that matters rather than against the happy path: an
    /// empty `DeviceBindingsMap` is INDISTINGUISHABLE from "no device is bound", so a
    /// reader that answered a locked or pre-B2B session with `Ok(default())` would render
    /// "no devices" over a vault whose rows it simply could not open. Every other read in
    /// this family is a label (`durable_attribution_in_dir` returns an empty index for the
    /// same absences, correctly, because a blank label is the right degradation there);
    /// this one feeds a list a user acts on, so it errs the other way.
    ///
    /// What it does NOT cover, stated rather than implied: the successful read. Reaching
    /// it needs a live `NTV6` session holding the group singleton, and the read half it
    /// would exercise (`read_device_bindings_in_dir` + `live_device_bindings`) is already
    /// driven host-free by `store`'s own tests over a real directory. What is unique to
    /// THIS layer is the three gates below, and each is asserted.
    #[test]
    fn the_list_command_refuses_a_session_it_cannot_read_rather_than_answering_empty() {
        crate::test_support::block_on(async {
            let state = VaultRuntimeState::default();
            let dir = std::path::PathBuf::from("/nonexistent-base");

            // Gate 1: no unlocked slot at all. A caller that got `Ok(empty)` here would
            // show an empty device list for a vault the user has open.
            assert!(
                matches!(
                    super::device_bindings_list_with_dir(&StdVaultIo, &state, &dir).await,
                    Err(super::DeviceBindingError::SlotNotUnlocked)
                ),
                "a locked session must be refused, never answered with an empty map"
            );

            // Gate 2: the command is unreachable from the session's own helpers either.
            // `session_person_id` and `session_device_id` are what make a row SIGNED and
            // KEYED; a list that answered past their absence would report rows the writer
            // half could not have produced.
            assert!(
                matches!(
                    super::session_person_id(&state).await,
                    Err(super::DeviceBindingError::SlotNotUnlocked)
                ),
                "no person session means no signer, which the list path must not paper over"
            );
            assert!(
                matches!(
                    super::session_device_id(&StdVaultIo, &dir).await,
                    Err(super::DeviceBindingError::NoDeviceId)
                ),
                "a never-enrolled vault has no device id, and the list must say so"
            );
        });
    }
}
