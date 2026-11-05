// SPDX-License-Identifier: AGPL-3.0
//! **Who may sign this vault right now**, answered once (myne-md/myne#983).
//!
//! # The question, and why it has one home
//!
//! Authoring anything for a B2B vault needs a key that peers can resolve: the held
//! person keypair (`0x02` heads, roster signatures), or a DEVICE key at rest plus a
//! VERIFIED `vault.device-bindings` row that publishes that key's public halves
//! (`0x03` heads, `decisions/protocol/0731` + `0733`).
//!
//! That pair was resolved in three places, each with its own device-id read and its
//! own halves comparison: `cycle::signed_head_ctx`, `roster_trust::own_device_signing_pair`
//! and `device_binding::store::claim_self_in_dir`. Each failed closed into `None` for
//! several different reasons, so the cycle could not say which half was missing, the UI
//! gave one sentence to five causes, and a binding row that published a key nobody could
//! load stayed on disk and in the sync path for every unlock afterwards. The observed
//! failure is a `format_version 0x02` row naming this device while the key store held no
//! such key, sync refusing every cycle with "unlock your identity to sync".
//!
//! # What this module is careful about
//!
//! **An absent key and an unreadable key are different facts.** Absent is rung 4 of the
//! storage ladder: the ordinary state on a platform with no store, and on a device that
//! has never minted one. Unreadable is a fault: a store that refused, an item that would
//! not decode. Collapsing the second into the first is how a broken keychain signs with
//! the phrase for ever with one trace line as the only clue.
//!
//! **A row that publishes halves for this device while nothing loads is its own state.**
//! It is the orphan this module exists for, and it is reachable without a key at rest,
//! so the binding store is read even when `load()` returns nothing.
//!
//! **Verification is not optional.** The map is group-sealed, so any member can write a
//! row. An unverified row would let a member holding the group key point a binding at a
//! key they control and sign heads as that person's device, so a row counts only through
//! [`protocol::partition_verified_bindings`] against the signed roster.

use protocol::device_key::{DeviceKeyPair, DevicePublicHalf};
use protocol::person_key::PersonPublicHalf;
use protocol::vault_head::DeviceHeadSigner;

use crate::vault_io::VaultIo;

/// Why this device cannot sign, when it cannot.
///
/// Exhaustive on purpose: the cycle's failure class, the log line and the sentence the
/// user reads are all derived from this, so a new cause is a compile error at every
/// consumer rather than a sixth silent `None`.
///
/// `Serialize` gives the vault doctor's report its wire token (myne-md/myne#1003), and
/// `serde(rename_all = "snake_case")` makes that token the SAME string [`Self::as_str`]
/// returns. `a_serialized_cause_is_the_logged_token` pins the two together, because two
/// spellings of one vocabulary is how a log line and a bug report come to disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityMissing {
    /// The head context itself could not be built: unreadable `vault.meta`, no group key
    /// in the unlocked slot, or a roster that does not verify. Nothing about the user's
    /// credentials is the cause, so the UI must not ask them for any.
    NoHeadContext,
    /// No person session in this process AND no usable device key. Opening the identity
    /// is the fix, which is why this is the one cause that gets its own class.
    NoPersonSession,
    /// No durable device id, so no row can name this device at all. Opening the identity
    /// does not help: the claim stands down on the same condition.
    NoDeviceId,
    /// No key at rest. Rung 4 of the ladder: the ordinary state on a platform with no
    /// store, on first run, and after an erase. NOT a fault.
    NoKeyAtRest,
    /// The store refused, or the item would not decode. A FAULT, and the one cause that
    /// may need a platform fix rather than a user action.
    KeyUnreadable,
    /// A key at rest, and no binding row for this device.
    NoBindingRow,
    /// A row for this device that publishes DIFFERENT halves than the key at rest. One of
    /// the two is stale, and only a person-signed claim can tell them apart.
    RowNamesDifferentKey,
    /// A row naming this device and these halves that does not verify against the signed
    /// roster.
    RowUnverified,
    /// A row publishes halves for this device and nothing loads from the store. The
    /// orphan: the vault believes this device can sign and it cannot.
    KeyMissingWhileBound,
}

impl AuthorityMissing {
    /// Whether opening the person identity would fix this cause.
    ///
    /// True only where a person-signed claim can rewrite the state: a missing session, a
    /// missing row, a stale row, an unverified row, an orphan. The claim mints, signs and
    /// writes a fresh row, so every one of those heals.
    ///
    /// False for the causes a claim cannot touch: no device id to key a row by, no head
    /// context, a store that refuses to hold a key at all. Asking a user to type twenty
    /// four words for one of those is the defect this module was written for.
    #[must_use]
    pub fn identity_unlock_would_fix(self) -> bool {
        matches!(
            self,
            AuthorityMissing::NoPersonSession
                | AuthorityMissing::NoKeyAtRest
                | AuthorityMissing::NoBindingRow
                | AuthorityMissing::RowNamesDifferentKey
                | AuthorityMissing::RowUnverified
                | AuthorityMissing::KeyMissingWhileBound
        )
    }

    /// A short stable token for the diagnostic log and the diagnostics line. Never user
    /// facing copy, which lives in the catalogs.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            AuthorityMissing::NoHeadContext => "no_head_context",
            AuthorityMissing::NoPersonSession => "no_person_session",
            AuthorityMissing::NoDeviceId => "no_device_id",
            AuthorityMissing::NoKeyAtRest => "no_key_at_rest",
            AuthorityMissing::KeyUnreadable => "key_unreadable",
            AuthorityMissing::NoBindingRow => "no_binding_row",
            AuthorityMissing::RowNamesDifferentKey => "row_names_different_key",
            AuthorityMissing::RowUnverified => "row_unverified",
            AuthorityMissing::KeyMissingWhileBound => "key_missing_while_bound",
        }
    }
}

/// What the storage ladder answered about a key at rest.
///
/// Three states, told apart at the ONE place that can tell them apart.
#[derive(Debug)]
pub enum KeyAtRest {
    /// A key is stored and decodes. Boxed for the same reason
    /// [`DeviceResolution::Bound`] is: this enum is moved per cycle.
    Present(Box<DeviceKeyPair>),
    /// Rung 4: no store on this platform, or a store with no item. The ordinary state.
    Absent,
    /// The store refused or the item would not decode. A fault, logged by [`load_key`].
    Unreadable,
}

impl KeyAtRest {
    /// The public half, when a key is present.
    #[must_use]
    pub fn public_half(&self) -> Option<DevicePublicHalf> {
        match self {
            KeyAtRest::Present(key) => Some(key.public_half()),
            KeyAtRest::Absent | KeyAtRest::Unreadable => None,
        }
    }
}

/// Read the key at rest, with the ladder's three outcomes.
///
/// `Unsupported` is [`KeyAtRest::Absent`]: it is a platform fact, not a fault. Anything
/// else is [`KeyAtRest::Unreadable`], and the warning names the caller's `site` so a
/// broken store is attributable rather than a mystery shared by four call sites.
pub fn load_key(site: &'static str) -> KeyAtRest {
    classify_key_load(crate::plugins::sync::device_identity::load(), site)
}

/// The ladder's mapping, split from the read so the four outcomes are testable without a
/// real key store: `cargo test` runs in one process with a process-global slot, and a test
/// that had to reach a store could only assert one of them.
///
/// The asymmetry is the point. `Unsupported` is a platform fact and stays silent; every
/// other refusal is a fault and says so, because a store that returns nothing while it
/// holds a key is the state this module exists to name.
#[must_use]
fn classify_key_load(
    load: Result<Option<DeviceKeyPair>, crate::plugins::sync::device_identity::DeviceKeyStoreError>,
    site: &'static str,
) -> KeyAtRest {
    use crate::plugins::sync::device_identity::DeviceKeyStoreError;
    match load {
        Ok(Some(key)) => KeyAtRest::Present(Box::new(key)),
        Ok(None) => KeyAtRest::Absent,
        Err(DeviceKeyStoreError::Unsupported) => KeyAtRest::Absent,
        Err(err) => {
            tracing::warn!(
                stage = "sync_authority",
                event = "device_key_unreadable",
                site,
                reason = ?err,
                "a device key exists on this platform but could not be read; this device \
                 signs with the person key until it can"
            );
            KeyAtRest::Unreadable
        }
    }
}

/// A key read that is PROVEN to be at rest, rather than merely loadable.
///
/// The unit of proof is the type, not a comment, because the difference is the whole defect
/// (myne-md/myne#1027): `load_key` answers from the session slot first, so a key that exists
/// only in this process reads as `Present`, and a claim that trusted that answer published a
/// `v2` binding row for a key no store held. The device then could not author a head, every
/// cycle ran pull-only, and the UI said "Synced".
///
/// Two things follow from the private field:
///   * the only way to obtain one is [`load_proven_at_rest`], which reads the store and nothing
///     else, so a caller cannot pass a `load_key` result off as at-rest;
///   * a test cannot mint one by hand, so a fixture cannot take the shortcut that hid this for
///     two releases (the creation-claim test literally installed a session key and called it
///     "a key at rest").
///
/// It is deliberately NOT what the resolution uses: "may this device sign right now" is a
/// different question, and a rung-3 PIN unlock answers it from RAM for the length of one
/// process.
pub struct KeyAtRestProof(KeyAtRest);

impl KeyAtRestProof {
    /// The ladder's answer about the store.
    #[must_use]
    pub fn at_rest(&self) -> &KeyAtRest {
        &self.0
    }

    /// A proof for TESTS ONLY, so the read-back's three negative arms can be asserted without
    /// a keychain.
    ///
    /// The production property is unchanged: `cfg(test)` code cannot ship, so no non-test
    /// caller can name an at-rest answer it did not read. What it deliberately does NOT do is
    /// let a test pretend a SESSION key is at rest. That mistake is `for_test(KeyAtRest::
    /// Present(..))` and it is visible at the call site, which is the opposite of the fixture
    /// myne-md/myne#1027 removed (a `load_or_create` call that quietly answered from RAM).
    #[cfg(test)]
    #[must_use]
    pub fn for_test(key: KeyAtRest) -> Self {
        Self(key)
    }
}

/// Read the key at rest and prove it, logging the result either way.
///
/// The log line is half the point (myne-md/myne#1027): a `Present` that no later read can
/// reproduce is the state that cost a day of forensics, and "absent" used to be silent by
/// design, which made a device with a store and no key indistinguishable from a dead one.
/// Only the binding claim calls this today, never the per-cycle resolution, so the
/// line stays rare enough to be worth reading.
#[must_use = "the proof is the answer"]
pub fn load_proven_at_rest(site: &'static str) -> KeyAtRestProof {
    let key = classify_key_load(crate::plugins::sync::device_identity::load_at_rest(), site);
    // Bounded tokens only: `check-tracing-discipline.mjs` R1/R2 read this line.
    let result = match key {
        KeyAtRest::Present(_) => "present",
        KeyAtRest::Absent => "absent",
        KeyAtRest::Unreadable => "unreadable",
    };
    tracing::info!(
        stage = "sync_authority",
        event = "device_key_at_rest",
        site,
        result,
        "the device key store was read"
    );
    KeyAtRestProof(key)
}

/// Whether a row CLAIMS that its device holds a key: live, and carrying public halves.
///
/// The `0x01` generation publishes no halves and so claims nothing about a key at rest; a `0x02`
/// row does, and it is the only kind that can be orphaned. One spelling, used by the resolution
/// and by the unlock-time detection, so the two cannot disagree about what an orphan is.
#[must_use]
pub fn row_publishes_halves(entry: &protocol::DeviceBindingEntry) -> bool {
    // Both halves or neither: `protocol::device_public_half_from_entry` requires both and
    // `binding_message_for_entry` refuses a half-present row, so a row carrying one half can
    // never verify anything and must not be read as "publishes a key".
    !entry.tombstone && entry.device_ed_pk.is_some() && entry.device_mldsa_vk.is_some()
}

/// Whether a published public half IS this key's.
///
/// The one spelling of "the row publishes the key we hold", used by the head path (a binding
/// row) and by the roster path (an attestation). Two spellings of it is how a device came to
/// hold a key at rest while a row published a different one (myne-md/myne#983).
#[must_use]
pub fn publishes_key(published: Option<DevicePublicHalf>, key: &DeviceKeyPair) -> bool {
    published == Some(key.public_half())
}

/// Whether a verified row names this device AND publishes this key.
///
/// Both clauses are load-bearing and they fail differently, which is why they are one
/// predicate: a row for another device would let this device sign under an id peers resolve
/// to somebody else, and a row for this device that publishes a different key would make
/// peers verify a signer that never signed anything.
#[must_use]
fn is_bound_signer(
    signers: &[DeviceHeadSigner],
    device_id: [u8; 16],
    public: &DevicePublicHalf,
) -> bool {
    signers
        .iter()
        .any(|s| s.device_id == device_id && &s.public == public)
}

/// What this device may sign a `0x03` head with, or the cause it may not.
///
/// No `Debug`: `DeviceHeadSigner` does not implement it, and a context carrying key material
/// should not be printable in full. The cause is what logs, through `AuthorityMissing`.
pub enum DeviceResolution {
    /// A key at rest, a verified row for THIS device, and the row publishes this key.
    ///
    /// Boxed because the pair costs an allocation per cycle and the enum is moved around a
    /// hot path; the alternative clippy offers (shrinking the variant) would mean not
    /// carrying the key, which is the thing the caller needs.
    Bound(Box<BoundDevice>),
    /// Not bound, for the named cause.
    /// A device that cannot AUTHOR still has to be able to READ. The verifier set travels
    /// with the decision for that reason: a peer's `0x03` head is checked against the
    /// vault's verified rows, not against this device's own binding
    /// (`decisions/protocol/0774` rule 1, "every reader accepts both").
    Unbound {
        cause: AuthorityMissing,
        signers: Vec<DeviceHeadSigner>,
    },
}

/// The bound half of [`DeviceResolution`].
pub struct BoundDevice {
    /// The 16-byte id this device authors under, from `sync::device_actor`.
    pub device_id: [u8; 16],
    /// The key at rest, whose public half the verified row publishes.
    pub key: DeviceKeyPair,
    /// The verified device halves a `0x03` head may be verified against.
    pub signers: Vec<DeviceHeadSigner>,
}

/// Resolve the device half of the authority.
///
/// `roster_publics` is the roster's live members, already verified: a binding row counts
/// only when the person it NAMES signed it, and that person has to be in the roster.
///
/// The store is read even when no key is at rest, because
/// [`AuthorityMissing::KeyMissingWhileBound`] is defined by a row that exists without one.
#[allow(clippy::too_many_arguments)] // eight read-only inputs from one caller; a struct would rename them
pub async fn resolve_device(
    io: &dyn VaultIo,
    vault_dir: &std::path::Path,
    account_number_hash: [u8; 16],
    group_key_epoch: u64,
    group_key: &[u8; 32],
    roster_publics: &[PersonPublicHalf],
    device_id: Option<[u8; 16]>,
    key: &KeyAtRest,
) -> DeviceResolution {
    let bindings_key = crate::plugins::device_binding::bindings_key_for_group(
        group_key,
        account_number_hash,
        group_key_epoch,
    );
    let map = match crate::plugins::device_binding::read_device_bindings_in_dir(
        io,
        vault_dir,
        &bindings_key.borrow(),
    )
    .await
    {
        Ok(map) => map,
        Err(err) => {
            // An unreadable store and "no device is bound" have the same effect and are
            // different facts. The row this device needs may be IN there, so the cause is
            // named rather than read as absent: a corrupt store silently becoming "no
            // signer" is how a binding problem hides for a release.
            tracing::warn!(
                stage = "sync_authority",
                event = "binding_store_unreadable",
                error = ?err,
                "device-binding store unreadable; no device signer is resolvable"
            );
            return DeviceResolution::Unbound {
                cause: AuthorityMissing::NoHeadContext,
                signers: Vec::new(),
            };
        }
    };

    let signers = verified_signers(&map, roster_publics);
    let unbound =
        |cause: AuthorityMissing, signers: &[DeviceHeadSigner]| DeviceResolution::Unbound {
            cause,
            signers: signers.to_vec(),
        };

    let Some(device_id) = device_id else {
        return unbound(AuthorityMissing::NoDeviceId, &signers);
    };
    let id_hex = crate::plugins::device_binding::device_id_hex(&device_id);
    let row = map.get(&id_hex);

    let key = match key {
        KeyAtRest::Present(key) => key.as_ref().clone(),
        KeyAtRest::Unreadable => return unbound(AuthorityMissing::KeyUnreadable, &signers),
        KeyAtRest::Absent => {
            // The orphan: a row that publishes halves for this device while nothing loads.
            // A row with no halves (a `0x01` row) says nothing about a key and is just an
            // unbound device.
            let claims_a_key = row.is_some_and(row_publishes_halves);
            return unbound(
                if claims_a_key {
                    AuthorityMissing::KeyMissingWhileBound
                } else {
                    AuthorityMissing::NoKeyAtRest
                },
                &signers,
            );
        }
    };

    let Some(row) = row else {
        return unbound(AuthorityMissing::NoBindingRow, &signers);
    };
    if row.tombstone {
        return unbound(AuthorityMissing::NoBindingRow, &signers);
    }
    // The row must publish the key we hold. Either could be the stale one, and a head
    // signed under a row that names a different key is one peers cannot verify.
    let public = key.public_half();
    if !publishes_key(protocol::device_public_half_from_entry(row), &key) {
        return unbound(AuthorityMissing::RowNamesDifferentKey, &signers);
    }
    if !is_bound_signer(&signers, device_id, &public) {
        return unbound(AuthorityMissing::RowUnverified, &signers);
    }
    DeviceResolution::Bound(Box::new(BoundDevice {
        device_id,
        key,
        signers,
    }))
}

/// The device public halves a `0x03` head may be verified against: the LIVE, VERIFIED
/// rows of `vault.device-bindings`, resolved through the signed roster.
///
/// Split out because the roster verification in `cycle` needs its own half before the
/// device resolution can run: a roster signed by a device key must be verifiable BY that
/// device, which is a chicken and egg this split resolves without a second policy.
#[must_use]
fn verified_signers(
    map: &protocol::DeviceBindingsMap,
    roster_publics: &[PersonPublicHalf],
) -> Vec<DeviceHeadSigner> {
    let (verified, _unverified) = protocol::partition_verified_bindings(
        map,
        |fingerprint_hex| {
            roster_publics
                .iter()
                .find(|p| protocol::hex::encode_lower(p.fingerprint()) == fingerprint_hex)
                .cloned()
        },
        None,
    );
    verified
        .iter()
        .filter(|(_, entry)| !entry.tombstone)
        .filter_map(|(device_hex, entry)| {
            Some(DeviceHeadSigner {
                device_id: crate::plugins::sync::devices::hex16(device_hex)?,
                public: protocol::device_public_half_from_entry(entry)?,
            })
        })
        .collect()
}

/// Whether this device's binding row claims a key that is not at rest: the ORPHAN.
///
/// Separate from [`resolve_device`] because the unlock pipeline asks it where no roster is in
/// hand yet, and it must not need one: the question is only "does a row here promise a key this
/// machine cannot produce", which is answerable from the store and the ladder.
///
/// `false` on every error, deliberately: an unreadable store is reported by the resolution, and
/// the unlock path must not turn a transient read failure into a warning the user is told to act
/// on.
pub async fn bound_without_key(
    io: &dyn VaultIo,
    vault_dir: &std::path::Path,
    account_number_hash: [u8; 16],
    group_key_epoch: u64,
    group_key: &[u8; 32],
    device_id: [u8; 16],
) -> bool {
    // Present means there is nothing to repair. Unreadable is NOT the same fact as absent (the
    // module header keeps that distinction everywhere else), so it is not the vault's state to
    // report as an orphan: `classify_key_load` has already warned about the store itself.
    if matches!(
        load_key("orphan_check"),
        KeyAtRest::Present(_) | KeyAtRest::Unreadable
    ) {
        return false;
    }
    let bindings_key = crate::plugins::device_binding::bindings_key_for_group(
        group_key,
        account_number_hash,
        group_key_epoch,
    );
    let Ok(map) = crate::plugins::device_binding::read_device_bindings_in_dir(
        io,
        vault_dir,
        &bindings_key.borrow(),
    )
    .await
    else {
        return false;
    };
    let id_hex = crate::plugins::device_binding::device_id_hex(&device_id);
    map.get(&id_hex).is_some_and(row_publishes_halves)
}

/// The cause to report when a B2B vault's cycle cannot author a head.
///
/// One place decides, so the failure class, the log and the UI sentence cannot disagree.
/// `context_built` is false when the head context itself could not be assembled, which
/// outranks every credential question: the user cannot fix an unreadable roster.
#[must_use]
pub fn missing_for_cycle(
    context_built: bool,
    person_held: bool,
    device: &DeviceResolution,
) -> AuthorityMissing {
    if !context_built {
        return AuthorityMissing::NoHeadContext;
    }
    if person_held {
        // The identity is held, so the fault is in the device half or in the ctx. Report
        // the device cause when there is one; otherwise the context is what failed.
        match device {
            DeviceResolution::Bound(_) => AuthorityMissing::NoHeadContext,
            DeviceResolution::Unbound { cause, .. } => *cause,
        }
    } else {
        match device {
            // Authoring worked through the device key, so this is not a missing-authority
            // state at all; the caller should not be asking.
            DeviceResolution::Bound(_) => AuthorityMissing::NoPersonSession,
            DeviceResolution::Unbound { cause, .. } => *cause,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn missing(cause: AuthorityMissing) -> DeviceResolution {
        DeviceResolution::Unbound {
            cause,
            signers: Vec::new(),
        }
    }

    /// **Reading is not authoring.** An unbound device still carries the vault's verified
    /// device signers, so a peer's `0x03` head resolves. The defect this pins down dropped
    /// that set on the unbound path, which made `accepts_format` advertise `0x03` while
    /// every verification answered `AuthorUnknown` on every device with no key at rest
    /// (browser, Linux without a Secret Service, a member's second device).
    #[test]
    fn an_unbound_decision_still_carries_the_verifiers_it_cannot_use_itself() {
        let signer = DeviceHeadSigner {
            device_id: [0x11; 16],
            public: protocol::device_key::DeviceKeyPair::generate_raw(&[0x21; 32], &[0x22; 32])
                .public_half(),
        };
        let decision = DeviceResolution::Unbound {
            cause: AuthorityMissing::NoKeyAtRest,
            signers: vec![signer],
        };
        match &decision {
            DeviceResolution::Unbound { signers, .. } => {
                assert_eq!(signers.len(), 1, "the vault's verifiers travel with it");
                assert_eq!(signers[0].device_id, signer.device_id);
            }
            DeviceResolution::Bound(_) => panic!("fixture must not resolve to a bound device"),
        }
        // And it still cannot author: the cycle refuses on the cause, and only a `Bound`
        // decision carries a key.
        assert!(matches!(decision, DeviceResolution::Unbound { .. }));
    }

    /// Every cause a claim can heal says so, and every cause it cannot says so. This is
    /// the table the UI's "one button that fixes it" rests on, so it is asserted rather
    /// than left to the reader.
    #[test]
    fn identity_unlock_fixes_only_what_a_claim_can_touch() {
        for cause in [
            AuthorityMissing::NoPersonSession,
            AuthorityMissing::NoBindingRow,
            AuthorityMissing::RowNamesDifferentKey,
            AuthorityMissing::RowUnverified,
            AuthorityMissing::KeyMissingWhileBound,
            AuthorityMissing::NoKeyAtRest,
        ] {
            assert!(
                cause.identity_unlock_would_fix(),
                "{cause:?} heals on a claim and must be offered as an action"
            );
        }
        for cause in [
            AuthorityMissing::NoHeadContext,
            AuthorityMissing::NoDeviceId,
            AuthorityMissing::KeyUnreadable,
        ] {
            assert!(
                !cause.identity_unlock_would_fix(),
                "{cause:?} does not heal on a claim, so asking for the phrase would be a lie"
            );
        }
    }

    /// A context that could not be built outranks every credential question: the fix is
    /// not something to ask of the user.
    #[test]
    fn a_missing_context_is_never_reported_as_a_credential_problem() {
        assert_eq!(
            missing_for_cycle(false, false, &missing(AuthorityMissing::NoKeyAtRest)),
            AuthorityMissing::NoHeadContext
        );
        assert_eq!(
            missing_for_cycle(false, true, &missing(AuthorityMissing::NoBindingRow)),
            AuthorityMissing::NoHeadContext
        );
    }

    /// A held identity with no device key reports the device cause, not "open the
    /// identity": the identity is already open, so that sentence would be false.
    #[test]
    fn a_held_identity_reports_the_device_cause() {
        assert_eq!(
            missing_for_cycle(true, true, &missing(AuthorityMissing::NoKeyAtRest)),
            AuthorityMissing::NoKeyAtRest
        );
    }

    /// The one classification the cycle's guard is allowed to turn into "open your
    /// identity": nothing held, and a cause a claim heals.
    #[test]
    fn only_a_claim_fixable_cause_with_no_identity_is_offered_as_an_unlock() {
        let offered = missing_for_cycle(
            true,
            false,
            &missing(AuthorityMissing::KeyMissingWhileBound),
        );
        assert!(offered.identity_unlock_would_fix());

        let not_offered = missing_for_cycle(true, false, &missing(AuthorityMissing::NoDeviceId));
        assert!(!not_offered.identity_unlock_would_fix());
    }

    /// The key store's four outcomes, told apart. `Unsupported` is a platform fact and is
    /// absent; a refusal or a corrupt item is a fault and is named. Collapsing the second
    /// into the first is how a broken store signed with the phrase for ever with one trace
    /// line as the only clue (moved here from `cycle`, myne-md/myne#983).
    #[test]
    fn the_key_store_ladder_tells_absence_from_fault() {
        use crate::plugins::sync::device_identity::DeviceKeyStoreError;

        assert!(matches!(
            classify_key_load(Ok(None), "test"),
            KeyAtRest::Absent
        ));
        assert!(
            matches!(
                classify_key_load(Err(DeviceKeyStoreError::Unsupported), "test"),
                KeyAtRest::Absent
            ),
            "rung 4 is the ordinary state on a platform with no store, not a failure"
        );
        assert!(
            matches!(
                classify_key_load(Err(DeviceKeyStoreError::Backend), "test"),
                KeyAtRest::Unreadable
            ),
            "a refused store still falls back to the phrase path, but it is a FAULT and says so"
        );
        assert!(
            matches!(
                classify_key_load(Err(DeviceKeyStoreError::Corrupt), "test"),
                KeyAtRest::Unreadable
            ),
            "a corrupt item is re-created on the next claim, not signed with"
        );

        let pair = DeviceKeyPair::generate_raw(&[0x41; 32], &[0x42; 32]);
        let expected = pair.public_half();
        let got = classify_key_load(Ok(Some(pair)), "test");
        assert_eq!(
            got.public_half(),
            Some(expected),
            "a key at rest is the signer"
        );
    }

    /// A `0x03` head needs BOTH halves: this device's id on the row, and this key's public
    /// half on it. Each clause is pinned separately because each fails toward a head peers
    /// cannot verify (moved here from `cycle`, myne-md/myne#983).
    #[test]
    fn a_device_signed_head_needs_a_row_naming_both_this_device_and_this_key() {
        let key = DeviceKeyPair::generate_raw(&[0x41; 32], &[0x42; 32]);
        let other_key = DeviceKeyPair::generate_raw(&[0x51; 32], &[0x52; 32]);
        let device_id = [0x33u8; 16];
        let row =
            |device_id: [u8; 16], public: DevicePublicHalf| DeviceHeadSigner { device_id, public };

        assert!(
            !is_bound_signer(&[], device_id, &key.public_half()),
            "a key with no verified row signs `0x02`, not a head nobody can resolve"
        );
        assert!(
            is_bound_signer(
                &[row(device_id, key.public_half())],
                device_id,
                &key.public_half()
            ),
            "this device, this key: the one case that may author a `0x03` head"
        );
        assert!(
            !is_bound_signer(
                &[row(device_id, other_key.public_half())],
                device_id,
                &key.public_half()
            ),
            "a row for this device naming ANOTHER key would have peers verify a signer that \
             never signed"
        );
        assert!(
            !is_bound_signer(
                &[row([0x99; 16], key.public_half())],
                device_id,
                &key.public_half()
            ),
            "a row for another device publishing this key is not this device's binding"
        );
    }

    /// A `0x01` row claims nothing about a key at rest, so it can never be an orphan. Getting
    /// this wrong is how a single-user vault would warn about a key it never promised.
    #[test]
    fn only_a_row_that_publishes_halves_can_be_orphaned() {
        let mut entry = protocol::DeviceBindingEntry {
            person_fingerprint: "ab".repeat(32),
            version: 1,
            tombstone: false,
            device_ed_pk: None,
            device_mldsa_vk: None,
            signature_hex: String::new(),
        };
        assert!(!row_publishes_halves(&entry), "a v1 row claims no key");

        // One half is not a key: `device_public_half_from_entry` requires both and
        // `binding_message_for_entry` refuses a half-present row, so such a row verifies
        // nothing and must not be read as a promise this device has to keep.
        entry.device_ed_pk = Some("ab".repeat(32));
        assert!(
            !row_publishes_halves(&entry),
            "one half is a malformed row, not a published key"
        );

        entry.device_mldsa_vk = Some("cd".repeat(32));
        assert!(row_publishes_halves(&entry), "a v2 row claims a key");

        entry.tombstone = true;
        assert!(
            !row_publishes_halves(&entry),
            "a tombstone claims nothing, whatever halves it left behind"
        );
    }

    /// The report's wire token and the diagnostic log's token are ONE vocabulary. A
    /// renamed variant would otherwise land a `serde` name in a bug report and a
    /// different `as_str` name in the log that is supposed to explain it.
    #[test]
    fn a_serialized_cause_is_the_logged_token() {
        for cause in [
            AuthorityMissing::NoHeadContext,
            AuthorityMissing::NoPersonSession,
            AuthorityMissing::NoDeviceId,
            AuthorityMissing::NoKeyAtRest,
            AuthorityMissing::KeyUnreadable,
            AuthorityMissing::NoBindingRow,
            AuthorityMissing::RowNamesDifferentKey,
            AuthorityMissing::RowUnverified,
            AuthorityMissing::KeyMissingWhileBound,
        ] {
            assert_eq!(
                serde_json::to_string(&cause).unwrap(),
                format!("\"{}\"", cause.as_str()),
                "{cause:?}"
            );
        }
    }
}
