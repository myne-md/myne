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
use super::sync::ResolvedBindings;
use crate::plugins::sync::identity_resolver::{device_attribution_view, DeviceAttributionView};
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
    super::sync::resolve_bindings_from_group_key(io, &group, vault_dir).await
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

/// Testable core of the list command: the vault's devices, each with the person its row is
/// CLAIMED by, partitioned against the signed roster before any name is attached.
///
/// **The partition happens HERE rather than in the caller, and that is the whole point of
/// the signature.** The map is group-sealed, and that seal is precisely what makes it
/// writable by every member; the map key is the DEVICE with the claimed person inside the
/// row, so the only thing that makes a claim mean anything is
/// `protocol::partition_verified_bindings` against the signed roster (§9.30.4). A caller
/// handed the raw map could only choose between rendering it unverified and rendering
/// nothing, which is why this command exists unwired until the device list needs it: the
/// frontend holds neither the roster, nor an owner public half, nor `vault.member-names`.
///
/// A row is a CLAIM and never an ownership (`protocol.md` §9.30.4): the signature binds the
/// row to the person who signed it and binds nothing to the device, so the surface renders
/// "claimed by" and a row that did not verify appears only as an id in
/// [`DeviceAttributionView::unverified_device_ids`], never named after a person.
///
/// Errors rather than degrading on every gate that makes the LIST itself unknowable (a
/// locked slot, a pre-B2B vault, an unreadable map), because an empty view is
/// indistinguishable from "no device is bound". The roster and the names store are the
/// opposite case: they are LABELS, so a failure to establish either leaves the rows
/// unverified rather than failing the command
/// ([`device_attribution_view`]'s own doc states the split).
pub async fn device_bindings_list_with_dir(
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) -> Result<DeviceAttributionView, DeviceBindingError> {
    // One peek and ONE `vault.meta` read for the key, the epoch and the roster envelope
    // together. The attribution partition verifies the roster against the public half that
    // signed it, so it needs the envelope the key's own read produced rather than a second
    // read of the file, which could observe different bytes
    // (`super::sync::resolve_bindings_and_meta_from_group_key` states the rule).
    let shared = state
        .peek_unlocked_shared_singleton_key()
        .await
        .ok_or(DeviceBindingError::SlotNotUnlocked)?;
    let group = shared
        .group_bytes()
        .ok_or(DeviceBindingError::NotASharedVault)?;
    let (resolved, b2b) =
        super::sync::resolve_bindings_and_meta_from_group_key(io, &group, vault_dir).await?;
    let map = read_device_bindings_in_dir(io, vault_dir, &resolved.borrow()).await?;
    // Both of these are LABELS rather than gates: a session with no installed person can
    // still verify the roster through the owner identity code pinned at invite accept, and a
    // never-enrolled device simply has no row to mark. Neither absence makes the list wrong,
    // so neither is an error here, unlike in the writer path where both are required.
    let session_person = state.clone_person_identity().await;
    let device_id = session_device_id(io, vault_dir).await.ok();
    Ok(device_attribution_view(
        io,
        vault_dir,
        session_person.as_ref(),
        &group,
        &b2b,
        &map,
        device_id.as_ref(),
    )
    .await)
}

/// Testable core of the claim: write this device's own row if it is absent or stale.
///
/// Returns the LIVE map as WRITTEN, plus whether the call actually wrote, which is what makes
/// the idempotence a claim a test can assert rather than infer from a timestamp. The map is
/// the writer's own bytes and is deliberately NOT signature-verified: a caller that renders
/// it owes [`device_bindings_list_with_dir`], which partitions it (§9.30.4). The two are one
/// round trip apart on purpose, because the unlock hook calls this on every unlock and the
/// attribution partition costs a roster read.
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
    // The device key, minted here because this is the ONE moment the person key is in
    // hand: the row's signature is the person's, so creating the key anywhere else would
    // need the phrase again. `load_or_create` is `Unsupported` on a platform with no
    // storage rung (`0733`'s rung 4), and `None` then keeps today's `v1` row.
    let device_public = match crate::plugins::sync::device_identity::load_or_create() {
        Ok(pair) => Some(pair.public_half()),
        // Rung 4: this platform has no place to keep one, so the row is written exactly
        // as it was before the device-key change. Expected, not a fault.
        Err(crate::plugins::sync::device_identity::DeviceKeyStoreError::Unsupported) => None,
        Err(err) => {
            // A keychain that refused is not a reason to refuse the BINDING (the row is
            // valid without the halves and the next unlock retries), but it IS a fault
            // rather than a platform fact, so it is logged as one and named.
            tracing::warn!(
                stage = "device_binding_claim",
                error = ?err,
                "device key could not be created; the binding is written without its halves"
            );
            None
        }
    };
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let (map, outcome) = claim_self_in_dir(
        io,
        vault_dir,
        &resolved.borrow(),
        &person,
        &device_id,
        device_public.as_ref(),
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
                // `?` rather than `%`: this enum's variants are unit-shaped or
                // carry a closed enum, so Debug is structurally bounded while
                // Display is a hand-written string a future variant could fill
                // with anything (myne-md/myne#860).
                error = ?error,
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
) -> Result<DeviceAttributionView, DeviceBindingError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    let io = crate::vault_io::StdVaultIo;
    let dir = active_vault_dir(&host, state.inner()).await?;
    device_bindings_list_with_dir(&io, state.inner(), &dir).await
}

/// Register this device's own binding and answer the live, verified device list.
///
/// The write is the SAME operation the unlock pipeline performs, so a caller that wants
/// to force a re-claim (after an identity change, or after the user re-installed this
/// device's identity) does not need a second code path. It cannot write another device's
/// row: the row key is this device's own enrolled id and the signer is this session's own
/// person, both read from the session rather than from the caller's arguments.
///
/// Answers the LIST's shape rather than the raw map, so both device commands hand the
/// frontend one type. The extra read is a user-initiated re-claim rather than the per-unlock
/// path, so the attribution partition is affordable here and the frontend never sees an
/// unverified row.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn device_bindings_claim<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
) -> Result<DeviceAttributionView, DeviceBindingError> {
    let host = crate::host::tauri_host::TauriHost::new(app);
    let io = crate::vault_io::StdVaultIo;
    let dir = active_vault_dir(&host, state.inner()).await?;
    let (_map, _outcome) = claim_own_binding_with_dir(&io, state.inner(), &dir).await?;
    device_bindings_list_with_dir(&io, state.inner(), &dir).await
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

    /// The READ command refuses a session it cannot read, rather than answering an empty list.
    ///
    /// `device_bindings_list` is the read half of the device list, whose whole reason for
    /// existing is that the attribution partition (§9.30.4) happens in Rust: the frontend holds
    /// neither the roster, nor an owner public half, nor `vault.member-names`. This test is
    /// written against the failure that matters rather than against the happy path: an empty
    /// `DeviceAttributionView` is INDISTINGUISHABLE from "no device is bound", so a reader that
    /// answered a locked or pre-B2B session with `Ok(default())` would render "no devices" over
    /// a vault whose rows it simply could not open. Every other read in this family is a label
    /// (`durable_attribution_in_dir` returns an empty index for the same absences, correctly,
    /// because a blank label is the right degradation there); this one feeds a list a user acts
    /// on, so it errs the other way.
    ///
    /// What it does NOT cover, stated rather than implied: the successful read. Reaching it
    /// needs a live `NTV6` session holding the group singleton, and the read half it would
    /// exercise (`read_device_bindings_in_dir` + the partition) is driven host-free by
    /// `store`'s own tests and by `sync::identity_resolver`'s. What is unique to THIS layer is
    /// the three gates below, and each is asserted.
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
                "a locked session must be refused, never answered with an empty list"
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
