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
use super::store::{
    claim_self_in_dir, read_device_bindings_in_dir, reclaim_self_in_dir, write_mutex, ClaimOutcome,
};
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
/// From [`crate::plugins::sync::device_actor::durable_device_id`], the ONE reader note
/// authoring and the head signer also use, so the id a note is authored under and the id
/// a binding is claimed under are the same bytes by construction rather than by two
/// agreeing hex writers. That reader consults the vault's enrolment record AND the person
/// credential (myne-md/myne#958): a person-born vault has no enrolment id at all, and
/// reading only that record is what left this claim standing down on `NoDeviceId` for
/// ever on such a vault.
///
/// A never-enrolled vault has no id at all, which is [`DeviceBindingError::NoDeviceId`]
/// rather than a fresh draw: an id invented at claim time would bind a device the sync
/// plane has never heard of, and the row would be keyed by something nothing else in the
/// tree can name.
pub async fn session_device_id(
    // The person credential lives under the app's CONFIG dir, which is not derivable
    // from the vault path (`paths` deliberately keeps app_data and app_config separate),
    // so the reader is handed the host rather than a guessed path.
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    vault_dir: &Path,
) -> Result<[u8; 16], DeviceBindingError> {
    crate::plugins::sync::device_actor::durable_device_id(host, io, vault_dir)
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
    host: &dyn crate::host::HostCtx,
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
    let device_id = session_device_id(host, io, vault_dir).await.ok();
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
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) -> Result<(DeviceBindingsMap, ClaimOutcome), DeviceBindingError> {
    write_own_binding_with_dir(host, io, state, vault_dir, false).await
}

/// The sync cycle's own repair for a binding conflict (myne-md/myne#976).
///
/// Everything `claim_own_binding_with_dir` does, except that the row is re-written at a
/// strictly higher version even when it looks current, because "looks current" is exactly
/// what a conflicting pair looks like from this side. Two gates are unchanged, and the
/// caller is the cycle boundary rather than a UI: the state it repairs has one reachable
/// cause and nobody is watching for it, which is why the manual `Claim this device` button
/// was the wrong home for it.
///
/// Returns the outcome rather than the map: the caller has nothing to render, and the only
/// decision it makes is whether to say so in the log.
pub async fn reclaim_own_binding_with_dir(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) -> Result<ClaimOutcome, DeviceBindingError> {
    let (_map, outcome) = write_own_binding_with_dir(host, io, state, vault_dir, true).await?;
    Ok(outcome)
}

#[allow(clippy::too_many_arguments)]
async fn write_own_binding_with_dir(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
    bump: bool,
) -> Result<(DeviceBindingsMap, ClaimOutcome), DeviceBindingError> {
    let _guard = write_mutex().lock().await;
    let _quiesce = crate::singleton_quiesce::shared().await;
    let resolved = resolve_bindings(io, state, vault_dir).await?;
    let (person, _person_id) = session_person_id(state).await?;
    let device_id = session_device_id(host, io, vault_dir).await?;
    write_own_binding_row(
        io,
        vault_dir,
        &resolved,
        &person,
        &device_id,
        mint_and_confirm_at_rest(),
        bump,
    )
    .await
}

/// The row-writing half, with every input already resolved.
///
/// Split out for the creation-time claim (myne-md/myne#1001), which has the person key in
/// hand but no unlocked slot to resolve from: it owns the resolution and hands the RESULT
/// here, so the one rule that decides whether a row may publish halves (`0774` rule 4) is
/// still written once and cannot drift between the two callers.
///
/// Takes BOTH gates at its call sites (`write_mutex` and the shared side of the singleton
/// barrier), because it is the write and its callers are the two entry points.
///
/// The device key is minted HERE because this is the moment the person key is in hand: the
/// row's signature is the person's, so creating the key anywhere else would need the phrase
/// again. `load_or_create` is `Unsupported` on a platform with no storage rung (`0733`'s
/// rung 4), and the row is then left exactly as it was.
async fn write_own_binding_row(
    io: &dyn VaultIo,
    vault_dir: &Path,
    resolved: &super::sync::ResolvedBindings,
    person: &protocol::PersonKeyPair,
    device_id: &[u8; 16],
    minted: Result<ConfirmedHalves, crate::plugins::sync::device_identity::DeviceKeyStoreError>,
    bump: bool,
) -> Result<(DeviceBindingsMap, ClaimOutcome), DeviceBindingError> {
    let halves = match minted {
        Ok(confirmed) => confirmed,
        // Rung 4 and every fault. None of them is evidence that this device has no key: a
        // platform with no store never had one, and a store that refused may still hold it.
        // `None` used to mean "write a v1 row", which was harmless until `None` started
        // repairing an orphan, at which point it became a DEMOTION of a synced and
        // person-signed row that `beats` (version-first) then wins the merge with
        // (myne-md/myne#983 review, D8).
        Err(err) => {
            tracing::warn!(
                stage = "device_binding_claim",
                error = ?err,
                "device key could not be created; the binding is left untouched"
            );
            ConfirmedHalves::Unknown
        }
    };
    let device_public = match halves {
        ConfirmedHalves::Publish(public) => Some(*public),
        // No verified key, so nothing about the row may change: not its halves, not its
        // version. See `confirm_read_back` for why withdrawing was tried and reverted.
        ConfirmedHalves::Absent => None,
        ConfirmedHalves::Unknown => {
            let map = read_device_bindings_in_dir(io, vault_dir, &resolved.borrow()).await?;
            return Ok((map, ClaimOutcome::Deferred));
        }
    };
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let (map, outcome) = if bump {
        reclaim_self_in_dir(
            io,
            vault_dir,
            &resolved.borrow(),
            person,
            device_id,
            device_public.as_ref(),
            &mut rng,
        )
        .await?
    } else {
        claim_self_in_dir(
            io,
            vault_dir,
            &resolved.borrow(),
            person,
            device_id,
            device_public.as_ref(),
            &mut rng,
        )
        .await?
    };
    Ok((protocol::live_device_bindings(&map), outcome))
}

/// Mint the device key and prove it can be read back, or answer `None`.
///
/// **This is the half that was missing** (myne-md/myne#983). The row is a claim about a key
/// at rest, so it may publish only halves that the store RETURNS: a `format_version 0x02`
/// row naming this device while the store held nothing is exactly the state that made sync
/// refuse every cycle under "unlock your identity to sync", and it survived every lock,
/// relaunch and rebuild because nothing ever compared the two.
///
/// Three outcomes, and none of them is an error that blocks a claim. `Publish` is the STORE
/// returning the key just written. `Unknown` is everything else (rung 4 of the ladder, a store
/// that refused the write, a store that cannot return what it accepted), and its meaning is the
/// same in all three: state nothing about where a key lives, and ask again on the next unlock.
/// The `Result` stays for the caller's shape; no arm of this function produces `Err`, because a
/// claim that cannot confirm a key still owes the vault its row.
///
/// The read-back is `load_proven_at_rest`, which is the point (myne-md/myne#1027). It used to
/// be `load_key`, and that reader answers from the session slot first: a key that existed only
/// in memory satisfied it, the row was written, and the halves it published belonged to no
/// store. `KeyAtRestProof` is what makes that mistake unrepresentable now.
/// What a store fault means for the row: two answers, and they differ in whether a row is
/// written.
///
/// Split out because it is the one decision in this file that a test cannot reach through the
/// real store: the store is process-global and a refusing one is not something a fixture can
/// install. Reverting `Absent` to `Unknown` here restores the state the comment below used to
/// describe falsely, and `a_store_fault_still_leaves_a_repairable_row` names it.
fn on_store_fault(
    err: &crate::plugins::sync::device_identity::DeviceKeyStoreError,
) -> ConfirmedHalves {
    use crate::plugins::sync::device_identity::DeviceKeyStoreError as E;
    match err {
        // Rung 4 is a platform fact, not a fault: the row is written exactly as it was
        // before the device-key change, and that is not this branch's business.
        E::Unsupported => ConfirmedHalves::Unknown,
        _ => ConfirmedHalves::Absent,
    }
}

fn mint_and_confirm_at_rest(
) -> Result<ConfirmedHalves, crate::plugins::sync::device_identity::DeviceKeyStoreError> {
    let pair = match crate::plugins::sync::device_identity::load_or_create() {
        Ok(pair) => pair,
        // Rung 4 is a platform fact: the row is written exactly as it was before the
        // device-key change, and that is not a fault.
        Err(crate::plugins::sync::device_identity::DeviceKeyStoreError::Unsupported) => {
            return Ok(ConfirmedHalves::Unknown)
        }
        // A store that REFUSED the write cannot say where a key lives, so nothing is
        // published: the row is written with no halves rather than not written at all, because
        // an absent row is the one state no later claim can see to repair. Logged rather than
        // swallowed (myne-md/myne#1027).
        Err(err) => {
            tracing::warn!(
                stage = "device_binding_claim",
                event = "device_key_write_failed",
                reason = ?err,
                "the device key could not be written; the row will publish no halves"
            );
            return Ok(on_store_fault(&err));
        }
    };
    Ok(confirm_read_back(
        pair.public_half(),
        &crate::plugins::sync::authority::load_proven_at_rest("device_binding_claim"),
    ))
}

/// The read-back's decision, split from the store so all four outcomes are testable.
///
/// It takes a [`KeyAtRestProof`](crate::plugins::sync::authority::KeyAtRestProof) rather than a
/// bare `KeyAtRest` so that "the store answered" is a property of the type: the only way to
/// obtain one is a store-only read. A caller cannot hand it a value that came from the session
/// slot, and a test cannot mint one (myne-md/myne#1027).
///
/// A store that reports a successful write and cannot return the item is the failure this
/// whole slice exists for, and it is logged at `ERROR` because nothing else in the tree will
/// notice: the row it would have published is a promise no peer can resolve.
fn confirm_read_back(
    written: protocol::device_key::DevicePublicHalf,
    proof: &crate::plugins::sync::authority::KeyAtRestProof,
) -> ConfirmedHalves {
    use crate::plugins::sync::authority::KeyAtRest;
    match proof.at_rest() {
        KeyAtRest::Present(key) if key.public_half() == written => {
            ConfirmedHalves::Publish(Box::new(written))
        }
        KeyAtRest::Present(_) => {
            tracing::error!(
                stage = "device_binding_claim",
                event = "device_key_read_back_mismatch",
                "the device key store returned a DIFFERENT key than the one just written; the \
                 binding is left untouched, because neither half can be shown to be the one at \
                 rest"
            );
            ConfirmedHalves::Unknown
        }
        KeyAtRest::Absent => {
            tracing::error!(
                stage = "device_binding_claim",
                event = "device_key_read_back_missing",
                "the device key was written and cannot be read back; the binding is left \
                 untouched. This is the state that makes sync demand the identity phrase after \
                 every lock (myne-md/myne#983), and it is reported as AuthorityMissing rather \
                 than repaired by a write here"
            );
            ConfirmedHalves::Unknown
        }
        // A store that REFUSED is not a store that is empty, and this distinction decides
        // whether the row is rewritten. Withdrawing the halves here would let one transient
        // keychain refusal rewrite a synced, person-signed row and strip a public key the
        // device still holds, so a peer that is itself bound could no longer resolve a
        // `0x03` head this device already pushed (myne-md/myne#983 review, D3 and D4). The
        // row is left exactly as it is and the next unlock asks again.
        KeyAtRest::Unreadable => {
            tracing::warn!(
                stage = "device_binding_claim",
                event = "claim_deferred",
                reason = "key_store_unreadable",
                "the device key store refused the read-back; the binding is left untouched, because a \
                 refusal is not an absence"
            );
            ConfirmedHalves::Unknown
        }
    }
}

/// What the read-back after a device-key write authorises.
///
/// Two answers. There used to be a third, `Withdraw`, which rewrote a synced row one version
/// up with its halves removed. It is gone because a row's halves are also the verification
/// material for the `0x03` head that device already pushed: withdrawing them left the device
/// unable to verify its own current head, and therefore unable to author the person-signed
/// head that would replace it (myne-md/myne#983 review, D8).
#[derive(Debug, PartialEq, Eq)]
enum ConfirmedHalves {
    /// The store returns the key that was just written: publish these halves.
    Publish(Box<protocol::device_key::DevicePublicHalf>),
    /// No verified key: leave the row exactly as it is and retry on the next unlock.
    Unknown,
    /// A store that REFUSED to write the key: write the row publishing NO halves.
    ///
    /// Not the same as `Unknown`. "Leave the row alone" is right when a row already exists
    /// and its halves might still be the ones at rest; on a device with no row at all it is
    /// the one outcome no later claim can see to repair, so the device stays in
    /// `NoBindingRow` for ever. A halves-less row is what every pre-device-key path wrote and
    /// it claims nothing about where a key lives, so this keeps the device repairable without
    /// publishing anything false (myne-md/myne#1027).
    Absent,
}

/// Claim this device's binding, best effort, from the unlock pipeline and from the
/// invite-accept tail.
///
/// **Why this is a core call rather than a `VaultLifecycleHooks` method.** The step needs
/// no platform capability: it takes the host only to resolve ONE path (`app_config_dir`,
/// where the person credential lives, myne-md/myne#958) and everything else it reads is a
/// vault file or the session. A fifth trait method would owe four implementations plus a
/// `check-lock-teardown` answer on each, for a step whose whole content is "read the map,
/// maybe write one row". The two hooks that DO need the trait (attachment refs, the search
/// index) need it because their bodies are platform-specific. This one is not.
///
/// Best-effort by design: it logs and returns, because a device that failed to record its
/// binding must still be able to open its vault, and the next unlock retries. It is
/// deliberately silent about WHY it stood down in the ordinary cases (locked slot, NTV5
/// vault, no device id, no person session), because those are states the two callers
/// reach routinely and a warning per unlock would be noise rather than signal.
pub async fn claim_own_binding_best_effort(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    vault_dir: &Path,
) {
    let attempted = claim_own_binding_with_dir(host, io, state, vault_dir)
        .await
        .map(|(_map, outcome)| outcome);
    log_claim_outcome(attempted, ClaimSite::Unlock);
}

/// Claim this device's binding at VAULT CREATION, best effort (myne-md/myne#1001).
///
/// The third caller of the row writer, and the only one that cannot read a session: a
/// vault is not open while it is being created, so there is no slot to resolve the group
/// tier or the person from. The creation ceremony holds both in hand instead: the group
/// key it just wrapped into `vault.meta`, and the owner's person keypair, which is what
/// signs the row.
///
/// **Why the ceremony has to be a claim site at all.** This is the last moment the person
/// key is available, and it is the only one that does not depend on the user typing the
/// phrase: an `NTV7`/`NTV8` vault's unlock can never install a person session
/// (`person_vault_carrier::carrier_applies` excludes those generations, and `0774` records
/// that exclusion as DO NOT ROUTE). A new vault therefore reached its first lock with no
/// binding row and no device key, and sync answered "unlock your identity" until the
/// phrase was typed once more.
///
/// Same gates and the same row writer as the slot path: only the input resolution differs,
/// so `0774` rule 4 (a row publishes only halves the store returns) holds here by
/// construction rather than by a second implementation agreeing with itself.
pub async fn claim_own_binding_from_creation_best_effort(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    vault_dir: &Path,
    group_key: &[u8; protocol::AEAD_KEY_LEN],
    person: &protocol::PersonKeyPair,
) {
    log_claim_outcome(
        claim_own_binding_from_creation(host, io, vault_dir, group_key, person).await,
        ClaimSite::Creation,
    );
}

/// [`claim_own_binding_from_creation_best_effort`]'s outcome, for the tests that assert on
/// what the claim DID rather than on the line it wrote.
async fn claim_own_binding_from_creation(
    host: &dyn crate::host::HostCtx,
    io: &dyn VaultIo,
    vault_dir: &Path,
    group_key: &[u8; protocol::AEAD_KEY_LEN],
    person: &protocol::PersonKeyPair,
) -> Result<ClaimOutcome, DeviceBindingError> {
    let _guard = write_mutex().lock().await;
    let _quiesce = crate::singleton_quiesce::shared().await;
    // The group key is already the resolved credential, so this reads `vault.meta` for the
    // account hash and the epoch only, which is the same reader the sync engine and the command
    // layer use, which is what keeps the three from deriving two different keys.
    let resolved = super::sync::resolve_bindings_from_group_key(io, group_key, vault_dir).await?;
    // A person-born vault has no vault SCRAM account, so nothing has written this vault's
    // `device_id_hex`: the id comes from the person credential, which is the id the cycle
    // will resolve later too (`device_actor::durable_device_id` reads both).
    let device_id = session_device_id(host, io, vault_dir).await?;
    let (_map, outcome) = write_own_binding_row(
        io,
        vault_dir,
        &resolved,
        person,
        &device_id,
        mint_and_confirm_at_rest(),
        false,
    )
    .await?;
    Ok(outcome)
}

/// Which entry point ran a claim.
///
/// Carried as a field on every line the claim writes, because the three sites promise
/// different RETRIES and the line is the whole forensic trail for this defect class
/// (myne-md/myne#983). A shared sentence naming one of them would be wrong at the other two.
#[derive(Clone, Copy)]
enum ClaimSite {
    /// `commit`'s tail, where the owner's person key is in hand and no vault is open.
    Creation,
    /// The unlock pipeline, the invite-accept tail and the person-registration tail.
    Unlock,
}

impl ClaimSite {
    fn as_str(self) -> &'static str {
        match self {
            Self::Creation => "creation",
            Self::Unlock => "unlock",
        }
    }
}

/// The one log line a claim writes, whichever site it ran from.
///
/// One function rather than a match at each caller, because the whole point of the line is
/// that "stood down" and "wrote a row" are distinguishable from the outside: two copies
/// would drift on the first variant added and the drift would be invisible, which is the
/// defect class this line exists to end (myne-md/myne#983).
fn log_claim_outcome(attempted: Result<ClaimOutcome, DeviceBindingError>, site: ClaimSite) {
    match attempted {
        // One line per claim naming what it DID (myne-md/myne#983). Before this, a claim
        // that stood down and a claim that wrote a row were indistinguishable from the
        // outside, which is why an orphaned binding took a week of forensics to find.
        Ok(outcome) => tracing::info!(
            stage = "device_binding_claim",
            event = "claim_completed",
            site = site.as_str(),
            outcome = match outcome {
                ClaimOutcome::AlreadyCurrent => "already_current",
                ClaimOutcome::Written => "written",
                // The row was NOT settled: the key store refused. Saying "in place" here
                // would report the opposite of the state on the one line that exists to
                // end this defect class' forensics.
                ClaimOutcome::Deferred => "deferred",
            },
            "this device's binding claim finished"
        ),
        // The ordinary stand-down states, named rather than silent for the same reason: each
        // one is a different answer to "why does sync not work".
        Err(DeviceBindingError::SlotNotUnlocked) => tracing::info!(
            stage = "device_binding_claim",
            event = "claim_stood_down",
            site = site.as_str(),
            reason = "no_person_session",
            "no person session is held, so this device cannot claim its binding"
        ),
        Err(DeviceBindingError::NotASharedVault) => tracing::info!(
            stage = "device_binding_claim",
            event = "claim_stood_down",
            site = site.as_str(),
            reason = "not_a_shared_vault",
            "this vault carries no binding store"
        ),
        Err(DeviceBindingError::NoDeviceId) => tracing::info!(
            stage = "device_binding_claim",
            event = "claim_stood_down",
            site = site.as_str(),
            reason = "no_device_id",
            "this device has no durable id, so no row can name it"
        ),
        Err(error) => {
            tracing::warn!(
                event = "device_binding_claim_failed",
                // `?` rather than `%`: this enum's variants are unit-shaped or
                // carry a closed enum, so Debug is structurally bounded while
                // Display is a hand-written string a future variant could fill
                // with anything (myne-md/myne#860).
                site = site.as_str(),
                error = ?error,
                // Deliberately not "the next unlock retries": at the CREATION site no later
                // unlock can retry a claim, because an `NTV7`/`NTV8` vault's unlock can never
                // install a person session. What retries is the next CLAIM: an unlock that
                // holds an identity, the invite-accept tail, or the moment this device gets a
                // durable id. Naming the wrong one sends the next reader to a path that will
                // keep standing down.
                "the device-binding claim did not complete; a later claim for this device retries it"
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
    device_bindings_list_with_dir(&host, &io, state.inner(), &dir).await
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
                let _ = super::claim_own_binding_with_dir(
                    &crate::host::NoopHost,
                    &StdVaultIo,
                    &state,
                    &d,
                )
                .await;
            })
            .await;

            // The best-effort hook is the SAME call, which is the property that keeps
            // the unlock path from being the one writer that forgot a gate.
            let state = Arc::new(VaultRuntimeState::default());
            let d = dir();
            assert_holds_the_shared_side("claim_own_binding_best_effort", move || async move {
                super::claim_own_binding_best_effort(
                    &crate::host::NoopHost,
                    &StdVaultIo,
                    &state,
                    &d,
                )
                .await;
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
                    super::device_bindings_list_with_dir(
                        &crate::host::NoopHost,
                        &StdVaultIo,
                        &state,
                        &dir
                    )
                    .await,
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
                    super::session_device_id(&crate::host::NoopHost, &StdVaultIo, &dir).await,
                    Err(super::DeviceBindingError::NoDeviceId)
                ),
                "a never-enrolled vault has no device id, and the list must say so"
            );
        });
    }

    /// A store that refuses the write still leaves a REPAIRABLE row.
    ///
    /// The regression this holds: the fault arm answered `Unknown`, which the row writer turns
    /// into "leave the row exactly as it is". On a device that has no row yet that is a dead
    /// end, because nothing later ever sees the device to claim it again, and the comment
    /// beside the arm claimed the opposite in words. `Absent` writes the row with no halves,
    /// which publishes nothing false and keeps the device visible to the next claim.
    #[test]
    fn a_store_fault_still_leaves_a_repairable_row() {
        use crate::plugins::sync::device_identity::DeviceKeyStoreError as E;

        assert_eq!(
            super::on_store_fault(&E::Unsupported),
            super::ConfirmedHalves::Unknown,
            "a platform with no rung-3 store is a fact, not a fault: the row takes the same \
             shape it took before the device-key change"
        );
        assert_eq!(
            super::on_store_fault(&E::Backend),
            super::ConfirmedHalves::Absent,
            "a store that refused the write must still leave a row, or the device can never be \
             claimed again"
        );
    }

    /// The read-back, in all four states. The ones that matter are the states that were
    /// impossible before this slice: a store that reports success and returns nothing, one
    /// that returns a DIFFERENT key, and one that refuses to answer at all.
    ///
    /// `for_test` is how the three negative arms are reached without a keychain. It is
    /// `cfg(test)`, so the production rule still holds: only `load_proven_at_rest` can make a
    /// proof, and only a proof can publish halves (myne-md/myne#1027).
    #[test]
    fn a_row_publishes_only_halves_the_store_returns() {
        use crate::plugins::sync::authority::KeyAtRest as K;
        use crate::plugins::sync::authority::KeyAtRestProof as P;

        let key = protocol::device_key::DeviceKeyPair::generate_raw(&[0x31; 32], &[0x32; 32]);
        let other = protocol::device_key::DeviceKeyPair::generate_raw(&[0x41; 32], &[0x42; 32]);

        assert_eq!(
            super::confirm_read_back(
                key.public_half(),
                &P::for_test(K::Present(Box::new(key.clone())))
            ),
            super::ConfirmedHalves::Publish(Box::new(key.public_half())),
            "the one case that may publish halves"
        );
        assert_eq!(
            super::confirm_read_back(key.public_half(), &P::for_test(K::Present(Box::new(other)))),
            super::ConfirmedHalves::Unknown,
            "a different key at rest leaves the row alone: neither half can be shown to be \
             the one at rest, and a rewrite would strip the material that verifies this \
             device's signed heads"
        );
        assert_eq!(
            super::confirm_read_back(key.public_half(), &P::for_test(K::Absent)),
            super::ConfirmedHalves::Unknown,
            "a store that cannot return the item it just accepted leaves the row alone"
        );
        // Absence and refusal reach the same non-write, and the CODE differs rather than the
        // outcome: an absent store logs `device_key_read_back_missing` at `ERROR` (a promise no
        // peer can resolve) while a refusal logs `claim_deferred` at `WARN` (a store that would
        // not answer this time). Both leave the row untouched.
        assert_eq!(
            super::confirm_read_back(key.public_half(), &P::for_test(K::Unreadable)),
            super::ConfirmedHalves::Unknown,
            "a fault leaves the row alone rather than demoting it"
        );
    }

    /// The row writer both claim sites share (myne-md/myne#1001): a confirmed key writes the
    /// row, and an unconfirmed one writes NOTHING and leaves the row it found untouched.
    ///
    /// Driven with explicit halves rather than through a key store, because the store is
    /// process-global and the rule under test (`0774` rule 4) is about the ANSWER rather than
    /// about where it came from. `person_born_meta_frame` supplies a real B2B tail, so the
    /// keyspace resolves exactly as it does on a vault created under an identity, which is
    /// the caller this test exists for, since the creation path has no unlocked slot to read.
    #[test]
    fn the_creation_claim_writes_a_row_only_for_a_confirmed_key() {
        crate::test_support::block_on(async {
            let dir = crate::test_support::ScopedTempDir::new("claim-row").expect("tempdir");
            std::fs::write(
                dir.path().join("vault.meta"),
                crate::test_support::person_born_meta_frame(0x42),
            )
            .expect("seed vault.meta");
            let io = StdVaultIo;
            let person = protocol::PersonKeyPair::generate_raw(&[1u8; 64], &[2u8; 32], &[3u8; 32]);
            let device_id = [0x5Au8; 16];
            let device_key =
                protocol::device_key::DeviceKeyPair::generate_raw(&[0x61; 32], &[0x62; 32]);
            let resolved =
                super::super::sync::resolve_bindings_from_group_key(&io, &[0x11u8; 32], dir.path())
                    .await
                    .expect("a B2B tail resolves the binding keyspace");
            let key_hex = crate::account::person_identity::hex_lower(&device_id);

            let (_map, outcome) = super::write_own_binding_row(
                &io,
                dir.path(),
                &resolved,
                &person,
                &device_id,
                Ok(super::ConfirmedHalves::Publish(Box::new(
                    device_key.public_half(),
                ))),
                false,
            )
            .await
            .expect("the claim runs");
            assert_eq!(outcome, super::ClaimOutcome::Written);

            let map = super::read_device_bindings_in_dir(&io, dir.path(), &resolved.borrow())
                .await
                .expect("read the store");
            let row = map.get(&key_hex).expect("the row names this device");
            assert!(
                row.device_ed_pk.is_some() && row.device_mldsa_vk.is_some(),
                "a confirmed key publishes its halves"
            );
            assert_eq!(
                row.person_fingerprint,
                crate::account::person_identity::hex_lower(person.public_half().fingerprint()),
                "the row is signed by the person this call was handed"
            );
            let version = row.version;

            // The state this defect class was made of: no verified key at rest means no
            // write at all: not a demotion, not a version bump (`0774` rule 4).
            let (_map, outcome) = super::write_own_binding_row(
                &io,
                dir.path(),
                &resolved,
                &person,
                &device_id,
                Ok(super::ConfirmedHalves::Unknown),
                false,
            )
            .await
            .expect("the claim runs");
            assert_eq!(outcome, super::ClaimOutcome::Deferred);

            let map = super::read_device_bindings_in_dir(&io, dir.path(), &resolved.borrow())
                .await
                .expect("read the store");
            let row = map
                .get(&key_hex)
                .expect("the row survives an unconfirmed key");
            assert_eq!(
                row.version, version,
                "an unconfirmed key must not bump the version"
            );
            assert!(
                row.device_ed_pk.is_some(),
                "an unconfirmed key must not withdraw halves the row already published"
            );
        });
    }
}
