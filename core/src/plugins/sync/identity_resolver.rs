// SPDX-License-Identifier: AGPL-3.0-only
//! The client-side identity resolver (`collab-provenance` task 2; durable attribution,
//! `member-devices` task 4).
//!
//! Maps a raw Automerge actor id to a closed `{Device, Person, Unknown}` identity plus a
//! label. This is the ONE client-side place an id hash would be computed were one needed
//! (the authoritative head-author hash stays in Rust, `myne.head-author v1|`); the
//! resolver never crosses that to TypeScript.
//!
//! # One resolver, two surfaces
//!
//! A DURABLE revision (a saved snapshot) and a LIVE presence frame resolve through the
//! same function, in the same fixed order. Two callers with two orders is how the version
//! history and the participants list come to name one actor differently, so the order is
//! stated here and nowhere else:
//!
//! 1. [`ResolvedIdentity::Person`], when the vault holds a device-to-person binding for
//!    the actor's device AND the member that binding names has signed a display name;
//! 2. [`ResolvedIdentity::Device`] with `name: Some(..)`, the explicit `device_names`
//!    label, for a device no binding attributes: one with no binding at all, or one whose
//!    bound member has not signed a display name (the two are the same absence to a
//!    reader, which is why the order collapses them rather than erroring);
//! 3. `Device` with `name: None`, carrying the short `code`;
//! 4. [`ResolvedIdentity::Unknown`], for an actor no identity covers (an `MY01` snapshot,
//!    or a revision with no actor).
//!
//! # The label is a label, never evidence
//!
//! A revision's Automerge actor is not a signature: anyone who can edit the document sets
//! it, so an actor a binding maps to a person is an id the WRITER chose. The binding buys
//! legibility, not authenticity (`decisions/protocol/0660` states that limit and
//! `0669` does not lift it). No surface may render a resolved label as proof of who
//! authored a revision, and no copy may imply one.
//!
//! # Why the join happens here rather than in the WebView
//!
//! [`DurableAttribution`] joins three group-sealed stores, no two of which share a key,
//! and the WebView holds none of the three ids. `src/lib/memberNames.ts` states the same
//! for the names store alone ("nothing on this side can supply the caller's own person
//! id") and `src/notes/collab/participant.ts` for the presence path. The chain is spelt
//! out on the type, and it is the reason this module is not a two-line map lookup.
//!
//! Pure at the resolution step: the caller reads the vault's stores once and passes an
//! [`IdentityIndex`], so the arms are unit-testable and the caller controls the read cost.

use std::collections::BTreeMap;
use std::path::Path;

use protocol::aead::AEAD_KEY_LEN;
use protocol::DeviceBindingsMap;

/// A resolved identity, closed. Serialized across IPC; the UI renders the label.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind")]
pub enum ResolvedIdentity {
    /// A device. `name` is the explicit `device_names` value, or `None` for an
    /// unnamed device (the UI renders "Device <code>").
    Device { name: Option<String>, code: String },
    /// A person: the member a binding names (durable), or the person a session's signed
    /// assertion names (live presence). `name` is that member's own chosen display name.
    Person { name: String },
    /// The actor maps to no known identity (an old note's unmappable actor, an `MY01`
    /// snapshot, or a revision with no actor).
    Unknown,
}

/// The durable device-to-person attribution index: `device_id_hex -> the member's own
/// chosen display name`.
///
/// Built by [`join_durable_attribution`] from three stores, no two of which share a key,
/// which is why the join cannot happen in the frontend:
///
/// ```text
/// vault.device-bindings    device_id_hex          -> person_fingerprint_hex   (0669)
/// vault.meta (the roster)  person_fingerprint_hex -> person_id_hex
/// vault.member-names       person_id_hex          -> the member's chosen name (0666)
/// ```
///
/// Every hop is verified before it is used: the FIRST hop's rows are partitioned against
/// the public half of the person each row NAMES (`partition_verified_bindings`, §9.30.5),
/// the roster against the OWNER's public half (`verify_group_roster`), and each name row
/// against the public half of the person that row names (`partition_verified`), with all
/// three stores opened under the group tier, so a row nobody signed contributes no name.
/// What the index therefore asserts is "this device told this vault it acts for this
/// person, and that person signed this name", which is exactly as strong as the binding
/// and no stronger.
#[derive(Debug, Clone, Default)]
pub struct DurableAttribution {
    by_device: BTreeMap<String, String>,
}

impl DurableAttribution {
    /// No attribution at all: every actor falls back to its device label. The state of a
    /// single-user vault, of a shared vault whose devices have not claimed themselves, and
    /// of every read that failed.
    #[must_use]
    pub fn empty() -> Self {
        Self::default()
    }

    /// The member name bound to `device_hex`, when this vault holds one.
    #[must_use]
    pub fn name_for(&self, device_hex: &str) -> Option<&str> {
        self.by_device.get(device_hex).map(String::as_str)
    }

    /// How many devices carry a member name.
    #[must_use]
    pub fn len(&self) -> usize {
        self.by_device.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_device.is_empty()
    }

    /// Record one device's member name. The join is the only production caller.
    pub fn insert(&mut self, device_hex: String, name: String) {
        self.by_device.insert(device_hex, name);
    }
}

/// Everything one resolution consults: the vault's `device_names` map and the durable
/// attribution index joined from the group-sealed stores.
///
/// One type rather than two parameters, so a caller cannot hand the device names to one
/// surface and a durable index to another and believe it resolved both the same way.
#[derive(Debug, Clone, Default)]
pub struct IdentityIndex {
    /// `vault.prefs`' `device_names`: this vault's local label for a device id.
    pub device_names: BTreeMap<String, String>,
    /// The device-to-member index, empty when the vault holds no bindings.
    pub durable: DurableAttribution,
}

impl IdentityIndex {
    #[must_use]
    pub fn new(device_names: BTreeMap<String, String>, durable: DurableAttribution) -> Self {
        Self {
            device_names,
            durable,
        }
    }

    /// The device-labels-only index: what a caller with no group tier (a pre-B2B vault, or
    /// a read that failed) has, and what every test that is not about the binding wants.
    #[must_use]
    pub fn from_device_names(device_names: BTreeMap<String, String>) -> Self {
        Self {
            device_names,
            durable: DurableAttribution::empty(),
        }
    }
}

/// Parse a 32-hex actor id, or `None` for anything else. A malformed or absent actor
/// resolves to `Unknown` rather than erroring (a revision with an unmappable actor must
/// not fail the whole listing).
#[must_use]
pub fn actor_from_hex(hex: &str) -> Option<[u8; 16]> {
    // Lenient (`protocol::hex::decode_ci`): an actor id arrives from another
    // device's revision, so its case is not this client's to fix — and the
    // index is keyed by lowercase hex, so an upper-cased id must still find its
    // binding rather than silently losing it (R1.2).
    protocol::hex::decode_ci(hex)
}

/// Lowercase hex of a 16-byte actor id, the key form every map here is keyed by.
fn actor_hex(actor: &[u8; 16]) -> String {
    actor.iter().map(|b| format!("{b:02x}")).collect()
}

/// The short device code the device list shows for an unnamed device: the first six hex
/// chars of the device id, matching `DeviceManagementPanel`'s `slice(0, 6)`.
#[must_use]
pub fn device_code(actor: &[u8; 16]) -> String {
    actor_hex(actor)[..6].to_string()
}

/// Resolve an actor to the closest identity the vault can vouch for. `actor` is the
/// revision's or presence frame's Automerge actor; `None` (an `MY01` snapshot, or a
/// revision with no actor) resolves to [`ResolvedIdentity::Unknown`].
///
/// So does an all-zero actor: sixteen zero bytes is what a client with no device id
/// seals a presence frame with, and it names no device at all. Resolving it like any
/// other value produced `Device { code: "000000" }`, so a device with no identity saw
/// ITSELF in the participant roster as "Device 000000" (myne-md/myne#958). A device
/// code is only meaningful for an actor some device actually committed under.
///
/// The order is the module doc's, and this is the ONLY place it is applied.
#[must_use]
pub fn resolve_revision_author(index: &IdentityIndex, actor: Option<[u8; 16]>) -> ResolvedIdentity {
    let Some(a) = actor else {
        return ResolvedIdentity::Unknown;
    };
    if crate::plugins::sync::device_actor::actor_is_unset(&a) {
        return ResolvedIdentity::Unknown;
    }
    let code = device_code(&a);
    let hex = actor_hex(&a);
    if let Some(name) = index.durable.name_for(&hex) {
        return ResolvedIdentity::Person {
            name: name.to_owned(),
        };
    }
    match index.device_names.get(&hex) {
        Some(name) if !name.is_empty() => ResolvedIdentity::Device {
            name: Some(name.clone()),
            code,
        },
        _ => ResolvedIdentity::Device { name: None, code },
    }
}

// ── The durable attribution join (`member-devices` task 4) ────────────────────
//
// Lives in this UNGATED module for the same reason the command below does:
// `web/wasm/src/dispatch.rs` calls `resolve_identity_from_host` and the browser client
// reuses the shared sync engine. Every store the join reads is target-independent (a vault
// directory, `vault.meta` as bytes, the group key), so nothing here needs a session, a
// host or a platform capability.

/// Verify the roster against whichever candidate public half actually signs it, and hand
/// back that half for the names check that follows.
///
/// Both candidates are tried rather than one being picked from the session's authority,
/// because verification is the gate and neither candidate is trusted. An OWNER session
/// holds the owner's half as its own identity; a MEMBER session holds only the out-of-band
/// identity code pinned at invite accept (`owner_identity_code`), the two cases
/// `signed_head_ctx` and `sync_list_roster` resolve between them. Choosing by authority
/// would mean reading a native-only session accessor from this ungated module, and picking
/// the wrong half fails CLOSED to "no names at all" rather than to an error, so trying both
/// is both simpler and the arm that cannot silently lose a member's name. A candidate that
/// did not sign simply fails `verify_group_roster`.
async fn verified_roster(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    session_person: Option<&protocol::PersonKeyPair>,
    envelope: &protocol::person_invite::SignedGroupRoster,
    account: &[u8; 16],
) -> Option<(
    protocol::person_key::PersonPublicHalf,
    protocol::person_invite::GroupRosterPayload,
)> {
    let mut candidates = Vec::new();
    if let Some(pair) = session_person {
        candidates.push(pair.public_half());
    }
    if let Ok(sync_state) = crate::plugins::sync::state::read_sync_state(io, vault_dir).await {
        if let Some(code) = sync_state.owner_identity_code.as_deref() {
            if let Ok(decoded) = crate::plugins::sync::invite::decode_person_identity_code(code) {
                candidates.push(decoded.public);
            }
        }
    }
    // Device-signed rosters (`0731` stage 2) are resolved through the SAME candidate
    // loop: the attestation is a member's pinned owner device or a verified row, and
    // both are read where the roster is read rather than re-derived here, so this
    // attribution path accepts exactly what the verify path accepts.
    let mut devices: Vec<protocol::device_key::DevicePublicHalf> = Vec::new();
    if let Ok(sync_state) = crate::plugins::sync::state::read_sync_state(io, vault_dir).await {
        if let Some(attestation) = sync_state.owner_device.as_ref() {
            for candidate in &candidates {
                if attestation.verifies_against(candidate) {
                    if let Some(half) = attestation.device_public_half() {
                        devices.push(half);
                    }
                }
            }
        }
    }
    for candidate in candidates {
        if let Ok(roster) = protocol::person_invite::verify_group_roster(
            protocol::person_invite::RosterTrust {
                owner_person: &candidate,
                owner_devices: &devices,
            },
            envelope,
            account,
        ) {
            return Some((candidate, roster));
        }
    }
    None
}

/// The three stores a binding row is verified against, resolved once: the public half that
/// signed the roster, the roster itself, and `vault.member-names`.
///
/// The binding map is deliberately NOT here. It is the subject of both joins rather than a
/// verifier, and the two callers reach it differently: the durable index reads it itself
/// because it can exit before the roster is ever opened, and the device list is handed the
/// map the command layer already read.
struct AttributionVerifiers {
    owner_public: protocol::person_key::PersonPublicHalf,
    roster: protocol::person_invite::GroupRosterPayload,
    names: protocol::MemberNamesMap,
}

impl AttributionVerifiers {
    /// Each member's public half keyed by the FINGERPRINT a binding row names.
    ///
    /// A binding row's map key is the DEVICE and the claimed person lives INSIDE the row, so
    /// this is the lookup `partition_verified_bindings` needs. Without it a co-member could
    /// write `{any_device -> a_live_member's_fingerprint}` and have that device's revisions
    /// render under that member's name, which is the outcome the §9.30.4 MUST ("the claimed
    /// person of an unverified row MUST NOT be rendered as that device's person") and
    /// `decisions/protocol/0670` both exist to prevent.
    fn by_fingerprint(&self) -> BTreeMap<String, protocol::person_key::PersonPublicHalf> {
        self.roster
            .members
            .iter()
            .filter_map(|m| {
                let public = public_half_of(m)?;
                Some((m.fingerprint_hex.to_ascii_lowercase(), public))
            })
            .collect()
    }

    /// Each member's public half keyed by their PERSON ID, which is the key
    /// `vault.member-names` is written under. A roster row migrated from a pre-B2B
    /// membership roster carries no person id and so contributes nothing here.
    fn by_person_id(&self) -> BTreeMap<String, protocol::person_key::PersonPublicHalf> {
        self.roster
            .members
            .iter()
            .filter_map(|m| {
                let id = m.person_id_hex.as_deref()?;
                Some((id.to_ascii_lowercase(), public_half_of(m)?))
            })
            .collect()
    }

    /// The member whose fingerprint a row names, whatever that member's roster state.
    fn member_for_fingerprint(
        &self,
        fingerprint_hex: &str,
    ) -> Option<&protocol::person_invite::GroupRosterMember> {
        self.roster
            .members
            .iter()
            .find(|m| m.fingerprint_hex.eq_ignore_ascii_case(fingerprint_hex))
    }

    /// The names store's rows whose signature checks out, keyed by person id.
    ///
    /// `partition_verified` KEEPS a tombstone in its verified set (the owner-signature arm
    /// accepts one), so every consumer must drop a tombstone or an empty name explicitly: a
    /// cleared name must not become an attribution.
    fn verified_names(&self) -> BTreeMap<String, protocol::member_names_blob::MemberNameEntry> {
        let by_person_id = self.by_person_id();
        let (verified, _unverified) = protocol::partition_verified(
            &self.names,
            |id| by_person_id.get(&id.to_ascii_lowercase()).cloned(),
            Some(&self.owner_public),
        );
        verified
    }
}

/// A roster row's public half, or `None` when its three hex fields do not decode.
fn public_half_of(
    member: &protocol::person_invite::GroupRosterMember,
) -> Option<protocol::person_key::PersonPublicHalf> {
    protocol::person_key::PersonPublicHalf::from_parts_hex(
        &member.member_kem_ek_hex,
        &member.member_ed_pk_hex,
        &member.member_mldsa_vk_hex,
    )
    .ok()
}

/// Load the verifiers from the group key and an ALREADY-PARSED `vault.meta`.
///
/// Takes the parsed meta rather than re-reading the file, because two reads of `vault.meta`
/// can observe different bytes and the account hash, the epoch and the roster envelope have
/// to come from one. `None` when the roster cannot be established at all, which is the one
/// failure that makes verification impossible for every row.
///
/// A `vault.member-names` read that fails is NOT that failure: it yields an empty name map,
/// so rows still verify and every device shows its label rather than its member's name. That
/// is the same visible outcome the durable index had before this split, where the whole join
/// returned empty on that read.
async fn load_verifiers(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    session_person: Option<&protocol::PersonKeyPair>,
    group_key: &[u8; AEAD_KEY_LEN],
    b2b: &protocol::B2bVaultMeta,
) -> Option<AttributionVerifiers> {
    let account = b2b.base.account_number_hash;
    let epoch = b2b.group_key_epoch;
    let envelope = protocol::person_invite::open_group_roster(
        group_key,
        &account,
        epoch,
        &b2b.signed_roster_envelope,
    )?;
    let (owner_public, roster) =
        verified_roster(io, vault_dir, session_person, &envelope, &account).await?;
    let names_key = crate::plugins::member_names::names_key_for_group(group_key, account, epoch);
    let names =
        crate::plugins::member_names::read_member_names_in_dir(io, vault_dir, &names_key.borrow())
            .await
            .unwrap_or_default();
    Some(AttributionVerifiers {
        owner_public,
        roster,
        names,
    })
}

/// The LIVE rows whose signatures check out, plus the device ids that did not verify.
///
/// The tombstone filter runs on the VERIFIED set rather than on the file, so a device is
/// dropped because its removal was signed and not because an unauthenticated byte in the
/// blob said so. The unverified ids are RETURNED rather than dropped, so a caller can say
/// "this row is tampered" instead of rendering it as absent.
fn partition_live_bindings(
    map: &DeviceBindingsMap,
    verifiers: &AttributionVerifiers,
) -> (DeviceBindingsMap, Vec<String>) {
    let by_fingerprint = verifiers.by_fingerprint();
    let (verified, unverified) = protocol::partition_verified_bindings(
        map,
        |fingerprint| {
            by_fingerprint
                .get(&fingerprint.to_ascii_lowercase())
                .cloned()
        },
        Some(&verifiers.owner_public),
    );
    (protocol::live_device_bindings(&verified), unverified)
}

/// Join `vault.device-bindings` with the owner-signed group roster and
/// `vault.member-names`, producing the durable attribution index.
///
/// Best effort throughout, and the direction is deliberate on every failure: an index that
/// cannot be built is EMPTY rather than an error, so the surface falls back to the device
/// label. Nothing here writes, so an emptiness produced by a damaged store cannot be
/// persisted over real rows (the hazard the stores' own writes guard against); the visible
/// consequence is that a device shows its label rather than its member's name, which is
/// honest about what this device could establish.
///
/// **The early exit on an empty binding map is load-bearing for cost as well as for
/// correctness.** This runs on the live-presence path, once per unresolved peer, and the
/// map is empty for every vault that has never had a device claim itself: a single-user
/// vault has no group key at all, and a fresh shared vault has no rows (`0669`: the blob is
/// created by the first claim, and an absent file reads as the empty map). Those vaults pay
/// one `vault.meta` read and one store read and stop. Only a vault that really holds
/// bindings pays for the roster and the names store, which is exactly the vault that needs
/// them.
pub async fn join_durable_attribution(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    session_person: Option<&protocol::PersonKeyPair>,
    group_key: &[u8; AEAD_KEY_LEN],
) -> DurableAttribution {
    let Ok(meta_bytes) = io.read(&vault_dir.join("vault.meta")).await else {
        return DurableAttribution::empty();
    };
    // A pre-B2B (`NTV5`) vault has no group tier, so this family does not exist there and
    // there is nothing to join. BOTH tail generations do carry it: `NTV7` keeps the `NTV6`
    // tail byte for byte, and a member vault bootstrapped from an owner's person-born meta
    // is `NTV7`, so asking for the `NTV6` frame specifically dropped every device binding
    // on exactly the vaults sharing now produces (parse_b2b_tail_any).
    let Ok(b2b) = protocol::parse_b2b_tail_any(&meta_bytes) else {
        return DurableAttribution::empty();
    };
    let account = b2b.base.account_number_hash;
    let epoch = b2b.group_key_epoch;

    let bindings_key =
        crate::plugins::device_binding::bindings_key_for_group(group_key, account, epoch);
    let Ok(map) = crate::plugins::device_binding::read_device_bindings_in_dir(
        io,
        vault_dir,
        &bindings_key.borrow(),
    )
    .await
    else {
        return DurableAttribution::empty();
    };
    // A tombstone is a merge input, not a binding: a removed person's devices stop being
    // attributed, which is what the removal is for. A RETIRED device of a live member
    // writes no tombstone at all (`0669`), so this filter leaves its PAST revisions their
    // attribution, which is the property task 4's third criterion names.
    //
    // This is the CHEAP gate, and it is deliberately not the one that decides what the
    // join reads: no live row at all means there is nothing to attribute, however the rows
    // would verify. The rows the join actually consumes are partitioned against the signed
    // roster below, which needs the roster in hand and so cannot happen yet.
    if protocol::live_device_bindings(&map).is_empty() {
        return DurableAttribution::empty();
    }

    let Some(verifiers) = load_verifiers(io, vault_dir, session_person, group_key, &b2b).await
    else {
        return DurableAttribution::empty();
    };
    let (live, _unverified) = partition_live_bindings(&map, &verifiers);
    if live.is_empty() {
        return DurableAttribution::empty();
    }
    let verified_names = verifiers.verified_names();

    let mut durable = DurableAttribution::empty();
    for (device_hex, entry) in &live {
        let Some(member) = verifiers
            .member_for_fingerprint(&entry.person_fingerprint)
            .filter(|m| m.state == protocol::person_invite::GroupMemberState::Live)
        else {
            continue;
        };
        let Some(person_id) = member.person_id_hex.as_deref() else {
            // A row migrated from a pre-B2B membership roster has no person account, so no
            // name store can address it. The device label stands.
            continue;
        };
        let Some(name) = verified_names.get(&person_id.to_ascii_lowercase()) else {
            continue;
        };
        // The tombstone and empty arms the `MemberNameEntry` filter states: a cleared name
        // must not become an attribution. The `tombstone` half is the load-bearing one and
        // the one `an_owner_signed_removal_is_not_an_attribution` reaches. The `is_empty`
        // half is REDUNDANT while `member_names_blob::valid_entry` holds its rule (a live row
        // must carry a name, a tombstone must not), and is kept so this function's
        // correctness does not rest on a structural rule in another module that it cannot
        // see; a reviewer who prefers the shorter form can drop it without weakening anything
        // reachable today.
        if name.tombstone || name.name.is_empty() {
            continue;
        }
        durable.insert(device_hex.clone(), name.name.clone());
    }
    durable
}

/// One verified, live device row: the device, the person it is claimed by, and the labels a
/// surface renders it with (`member-devices` task 11).
///
/// **A row is a CLAIM, not an ownership.** `person_fingerprint_hex` is verified against the
/// roster, which means the named person signed this row and says nothing about who runs the
/// device: a member holding the group key can sign a row naming any device id, a co-member's
/// included, under their own fingerprint, and the writer-chosen `version` lets that row
/// outbid the real one (`protocol.md` §9.30.4, `decisions/protocol/0669`). A surface that
/// renders this row MUST therefore say "claimed by" rather than "belongs to".
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DeviceAttributionRow {
    /// The device, lowercase hex: the row's map key, and the value a device's own label
    /// (`vault.prefs` `device_names`) is keyed by.
    pub device_id_hex: String,
    /// The fingerprint the row names, lowercase hex. Verified.
    pub person_fingerprint_hex: String,
    /// The claiming member's addressable person id, when the roster carries one. Absent on a
    /// member migrated from a pre-B2B membership roster, who has no person account.
    pub person_id_hex: Option<String>,
    /// The member's own signed display name, when a LIVE member published one. A missing name
    /// is not a failure: the surface falls back to the device's label.
    pub member_name: Option<String>,
    /// True when this row's device is the device the caller is running on.
    pub is_this_device: bool,
}

/// What a device list is handed: the verified live rows, and the device ids whose rows did
/// not verify.
///
/// The two are separate fields rather than one list with a flag, because they are different
/// statements: a row is something a reader may be shown, and an unverified device id is
/// something a reader may only be TOLD ABOUT, never named after (`protocol.md` §9.30.4).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct DeviceAttributionView {
    pub rows: Vec<DeviceAttributionRow>,
    /// Device ids carried by the map whose rows did not verify, in map order. Reported rather
    /// than dropped, so a tampered row is distinguishable from an absent one.
    pub unverified_device_ids: Vec<String>,
}

impl DeviceAttributionView {
    /// Every device id the map carries, unverified: what a caller answers when it cannot
    /// verify anything. No row is named, and the ids are reported rather than hidden, which is
    /// the honest shape rather than an empty list that would read as "no devices".
    fn all_unverified(map: &DeviceBindingsMap) -> Self {
        Self {
            rows: Vec::new(),
            unverified_device_ids: map.keys().cloned().collect(),
        }
    }
}

/// Build the device list over an ALREADY-READ binding map, partitioning it against the roster
/// so no unverified row can reach a surface.
///
/// **Why this is a backend function rather than a rule the surface follows.** The map is
/// group-sealed, and that seal is exactly what makes it writable by every member, so a row's
/// claim is worth only what its signature says. The partition needs the roster, the owner's
/// public half and the names store, none of which a frontend holds, so a surface that
/// received the raw map could only choose between rendering it unverified and rendering
/// nothing. `join_durable_attribution` above made the same argument for the history and
/// presence surfaces; this is the third surface, and it is the one where a reader would most
/// naturally read a name as an authority over a machine.
///
/// Infallible by construction: `io` and the session are consulted for LABELS, and a failure to
/// establish the roster yields every device id unverified rather than an error. The command
/// layer keeps the errors that matter (a locked slot, an `NTV5` vault, an unreadable map), so
/// this function never has to decide between "no devices" and "could not read".
pub async fn device_attribution_view(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    session_person: Option<&protocol::PersonKeyPair>,
    group_key: &[u8; AEAD_KEY_LEN],
    b2b: &protocol::B2bVaultMeta,
    map: &DeviceBindingsMap,
    this_device: Option<&[u8; 16]>,
) -> DeviceAttributionView {
    let Some(verifiers) = load_verifiers(io, vault_dir, session_person, group_key, b2b).await
    else {
        return DeviceAttributionView::all_unverified(map);
    };
    let (live, unverified) = partition_live_bindings(map, &verifiers);
    let verified_names = verifiers.verified_names();
    let this_device_hex = this_device.map(crate::plugins::device_binding::device_id_hex);

    let mut rows = Vec::with_capacity(live.len());
    for (device_hex, entry) in &live {
        let member = verifiers.member_for_fingerprint(&entry.person_fingerprint);
        let person_id_hex = member
            .and_then(|m| m.person_id_hex.as_deref())
            .map(str::to_ascii_lowercase);
        // The name is joined only through a LIVE member, the same gate the durable index
        // applies: a tombstoned roster row must not name a device.
        let member_name = member
            .filter(|m| m.state == protocol::person_invite::GroupMemberState::Live)
            .and_then(|m| m.person_id_hex.as_deref())
            .and_then(|id| verified_names.get(&id.to_ascii_lowercase()))
            .filter(|name| !name.tombstone && !name.name.is_empty())
            .map(|name| name.name.clone());
        rows.push(DeviceAttributionRow {
            device_id_hex: device_hex.clone(),
            person_fingerprint_hex: entry.person_fingerprint.to_ascii_lowercase(),
            person_id_hex,
            member_name,
            is_this_device: this_device_hex.as_deref() == Some(device_hex.as_str()),
        });
    }
    DeviceAttributionView {
        rows,
        unverified_device_ids: unverified,
    }
}

/// [`join_durable_attribution`] against a live session: the group key comes from the
/// unlocked slot and the signer candidate from the session's person identity.
///
/// The group key is `None` on an owner-ROOT session, which is the pre-B2B shape; a shared
/// vault holds the GROUP singleton, so this returns an index there. Any of those absences
/// means "no bindings to read", never an error, because every caller is rendering a label.
pub async fn durable_attribution_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    vault_dir: &Path,
) -> DurableAttribution {
    let Some(shared) = state.peek_unlocked_shared_singleton_key().await else {
        return DurableAttribution::empty();
    };
    let Some(group_key) = shared.group_bytes() else {
        return DurableAttribution::empty();
    };
    let person = state.clone_person_identity().await;
    join_durable_attribution(io, vault_dir, person.as_ref(), &group_key).await
}

// ── The resolver command (`collab-provenance` task 2) ────────────────────────
//
// Lives HERE rather than in `sync/commands.rs` on purpose: that module is gated
// `#[cfg(all(feature = "tauri-ipc", not(wasm32)))]`, so a command on the browser path (the
// web dispatcher calls this) must sit in an ungated module.

/// A failure resolving an actor to an identity. Closed enum, no `String` field (the label
/// is DATA, not an error).
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ResolveIdentityError {
    /// The vault is not unlocked, so `vault.prefs` cannot be read.
    #[error("vault not unlocked")]
    VaultNotUnlocked,
    /// The actor hex is not 32 hex chars (nor the empty "no actor" form).
    #[error("invalid actor id")]
    InvalidActor,
    /// `vault.prefs` could not be read.
    #[error("preferences unavailable")]
    Prefs,
}

/// Parse an actor hex: `""` is the "no actor" (`MY01` / absent) case, otherwise exactly 32
/// hex chars.
fn parse_actor_hex(hex: &str) -> Result<Option<[u8; 16]>, ResolveIdentityError> {
    if hex.is_empty() {
        return Ok(None);
    }
    // Lenient, for the same reason as `actor_from_hex` (R1.2).
    protocol::hex::decode_ci::<16>(hex)
        .map(Some)
        .ok_or(ResolveIdentityError::InvalidActor)
}

/// Resolve an Automerge actor (hex) to a closed `{Device, Person, Unknown}` identity,
/// reading the vault's `device_names` AND the durable binding index. Both surfaces come
/// through here, so they cannot name the same actor differently. A missing actor resolves
/// to `Unknown`.
pub async fn resolve_identity_from_host(
    host: &dyn crate::host::HostCtx,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
    actor_hex: String,
) -> Result<ResolvedIdentity, ResolveIdentityError> {
    let vault_dir =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
            .map_err(|_| ResolveIdentityError::VaultNotUnlocked)?;
    let actor = parse_actor_hex(&actor_hex)?;
    let view = crate::plugins::prefs::commands::prefs_read_with_dir(&vault_dir, state, io)
        .await
        .map_err(|_| ResolveIdentityError::Prefs)?;
    let durable = durable_attribution_in_dir(io, state, &vault_dir).await;
    Ok(resolve_revision_author(
        &IdentityIndex::new(view.device_names, durable),
        actor,
    ))
}

/// Tauri wrapper for the identity resolver (desktop).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn resolve_identity<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
    actor_hex: String,
) -> Result<ResolvedIdentity, ResolveIdentityError> {
    resolve_identity_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        &crate::vault_io::StdVaultIo,
        actor_hex,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: [u8; 16] = [
        0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99,
    ];
    const A_HEX: &str = "aabbccddeeff00112233445566778899";
    const B_HEX: &str = "11111111111111111111111111111111";

    fn names(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    fn durable(pairs: &[(&str, &str)]) -> DurableAttribution {
        let mut out = DurableAttribution::empty();
        for (device, name) in pairs {
            out.insert((*device).to_string(), (*name).to_string());
        }
        out
    }

    // ── The four acceptance cases ──────────────────────────────────────────────

    /// Criterion 1: a device the vault holds a binding for resolves to the MEMBER's name,
    /// and the binding OUTRANKS the device's own label. The second half is the ordering
    /// claim (`0669`: the device label is the fallback, not the answer).
    #[test]
    fn bound_device_resolves_to_the_members_name_not_its_device_label() {
        let index = IdentityIndex::new(
            names(&[(A_HEX, "Ada's Laptop")]),
            durable(&[(A_HEX, "Ada")]),
        );
        assert_eq!(
            resolve_revision_author(&index, Some(A)),
            ResolvedIdentity::Person { name: "Ada".into() }
        );
    }

    /// Criterion 2a: a device no binding covers resolves to its device label.
    #[test]
    fn unbound_device_resolves_to_its_device_label() {
        let index = IdentityIndex::from_device_names(names(&[(A_HEX, "Ada's Laptop")]));
        assert_eq!(
            resolve_revision_author(&index, Some(A)),
            ResolvedIdentity::Device {
                name: Some("Ada's Laptop".into()),
                code: "aabbcc".into()
            }
        );
    }

    /// Criterion 2b: a device nobody named resolves to the short code. "Unbound" and
    /// "unnamed" are the same absence at different depths, which is why the order collapses
    /// them rather than erroring.
    #[test]
    fn unnamed_device_resolves_to_the_short_code() {
        let index = IdentityIndex::default();
        assert_eq!(
            resolve_revision_author(&index, Some(A)),
            ResolvedIdentity::Device {
                name: None,
                code: "aabbcc".into()
            }
        );
    }

    /// Criterion 2c: an actor no identity covers is `Unknown`, including the "no actor at
    /// all" form an `MY01` snapshot carries.
    #[test]
    fn an_unknown_actor_resolves_to_unknown() {
        let index = IdentityIndex::new(
            names(&[(A_HEX, "Ada's Laptop")]),
            durable(&[(A_HEX, "Ada")]),
        );
        assert_eq!(
            resolve_revision_author(&index, None),
            ResolvedIdentity::Unknown
        );
    }

    /// **An all-zero actor names no device, so it resolves to `Unknown` (myne-md/myne#958).**
    ///
    /// Sixteen zero bytes is the actor a client with no device id seals its presence with.
    /// Resolved like any other value it became `Device { name: None, code: "000000" }`, so
    /// the device that sealed it saw itself in the participant roster as "Device 000000",
    /// and every id-less device in the vault shared that one row because the roster keys
    /// participants by actor. The code is the first six hex characters, and `000000` is
    /// not a device code: it is the absence of one.
    ///
    /// The zero form is asserted at `resolve_revision_author`, which is the ONLY entry point
    /// here that takes an actor (`device_code` is its helper and has no other caller), so one
    /// assertion covers every caller: the revision attribution in `snapshots::commands`.
    #[test]
    fn an_all_zero_actor_names_no_device() {
        let index = IdentityIndex::new(
            names(&[(A_HEX, "Ada's Laptop")]),
            durable(&[(A_HEX, "Ada")]),
        );
        assert_eq!(
            resolve_revision_author(&index, Some([0u8; 16])),
            ResolvedIdentity::Unknown,
            "zero is the absence of a device code, not the code \"000000\""
        );
    }

    /// Criterion 3, the resolution half: an actor whose binding is ABSENT falls back to the
    /// device label. This is what an index produces for a device after its member is
    /// removed, because the join drops a tombstoned binding. The retired-device half is the
    /// opposite shape and is pinned at the join, since `0669` has a retirement write NO
    /// tombstone, so a retired device's past revisions keep the attribution rather than
    /// losing it.
    #[test]
    fn a_device_whose_binding_is_absent_resolves_to_its_device_label() {
        let index = IdentityIndex::new(
            names(&[(A_HEX, "Ada's Laptop")]),
            durable(&[(B_HEX, "Someone Else")]),
        );
        assert_eq!(
            resolve_revision_author(&index, Some(A)),
            ResolvedIdentity::Device {
                name: Some("Ada's Laptop".into()),
                code: "aabbcc".into()
            }
        );
    }

    /// An empty `device_names` value is the "unnamed" state, not a name that renders as
    /// nothing: the store writes it for a device whose label the user cleared.
    #[test]
    fn an_empty_device_label_resolves_to_the_short_code() {
        let index = IdentityIndex::from_device_names(names(&[(A_HEX, "")]));
        assert_eq!(
            resolve_revision_author(&index, Some(A)),
            ResolvedIdentity::Device {
                name: None,
                code: "aabbcc".into()
            }
        );
    }

    /// A bound device whose member has not signed a name yet is in the same position as an
    /// unbound one: the INDEX carries no entry for it, because the join skips a member with
    /// no verified name. That distinction is deliberately the join's, so the resolution step
    /// has one absence rather than two.
    #[test]
    fn a_bound_device_whose_member_has_no_name_falls_back_to_the_device_label() {
        let index = IdentityIndex::new(
            names(&[(A_HEX, "Ada's Laptop")]),
            DurableAttribution::empty(),
        );
        assert_eq!(
            resolve_revision_author(&index, Some(A)),
            ResolvedIdentity::Device {
                name: Some("Ada's Laptop".into()),
                code: "aabbcc".into()
            }
        );
    }

    /// The index is keyed by lowercase hex and `actor_hex` lower-cases, so an actor id that
    /// arrived upper-cased still finds its binding rather than silently losing it.
    #[test]
    fn an_uppercase_actor_hex_finds_the_same_binding() {
        let index = IdentityIndex::new(BTreeMap::new(), durable(&[(A_HEX, "Ada")]));
        let actor = actor_from_hex("AABBCCDDEEFF00112233445566778899").expect("32 hex chars");
        assert_eq!(
            resolve_revision_author(&index, Some(actor)),
            ResolvedIdentity::Person { name: "Ada".into() }
        );
    }

    #[test]
    fn the_device_code_is_the_first_six_hex_chars() {
        let actor = [
            0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert_eq!(device_code(&actor), "abcdef");
    }

    #[test]
    fn a_malformed_actor_hex_is_none_rather_than_a_parse_error() {
        assert_eq!(actor_from_hex(""), None);
        assert_eq!(actor_from_hex("aa"), None);
        assert_eq!(actor_from_hex("zzbbccddeeff00112233445566778899"), None);
        assert_eq!(actor_from_hex(A_HEX), Some(A));
    }
}

/// The three-hop join over real stores.
///
/// This is the half the pure tests cannot reach, and the half where the feature can be
/// silently wrong: a join that resolves nothing is indistinguishable, from the UI, from a
/// vault that holds no bindings, so every test here asserts a POSITIVE attribution and not
/// merely the absence of an error. The fixture is a real `NTV6` `vault.meta` (parsed,
/// signature-verified and AEAD-opened), a real `MYU5` binding written by the production
/// claimant, and a real `MYO5` name row, so a hop that is mistyped or a key derived for the
/// wrong role fails here rather than falling back quietly.
#[cfg(test)]
mod join_tests {
    use super::*;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use protocol::person_invite::{
        GroupKeyContinuity, GroupMemberState, GroupRosterMember, GroupRosterPayload,
        GroupRosterRole,
    };
    use rand_core::UnwrapErr;

    const ACCT: [u8; 16] = [0x33; 16];
    const GROUP: [u8; 32] = [0x41; 32];
    const ROOT: [u8; 32] = [0x51; 32];
    const ITEMS: [u8; 32] = [0x31; 32];
    const ITEMS_ID: [u8; 16] = [0x17; 16];
    const EPOCH: u64 = 1;
    /// The member's `person_id_hash`: the third hop's key.
    const PERSON_ID: [u8; 16] = [0x21; 16];
    /// The member's device: the first hop's key.
    const DEVICE: [u8; 16] = [0x77; 16];

    /// Who signs the `MYO5` row the fixture seeds, if anyone.
    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum NameRow {
        /// No row at all: the member has not chosen a name yet.
        Absent,
        /// Signed by the person the roster row names. The verified case.
        Member,
        /// An OWNER-signed REMOVAL: tombstoned, and (by the family's own rule) carrying no
        /// name. This is the row the join's `tombstone` half exists for: `partition_verified`
        /// accepts it through the owner-signature arm, so nothing but the flag separates it
        /// from a live name, and a join that did not check it would attribute a removed
        /// person's device to their old name.
        OwnerTombstone,
        /// Signed by someone else: a forged or mis-keyed row, which must not attribute.
        Impostor,
    }

    impl NameRow {
        /// Whether the row is signed by the member. The owner signs the other kinds.
        fn signed_by_member(self) -> bool {
            self == NameRow::Member
        }

        fn name(self) -> &'static str {
            match self {
                // `MemberNameEntry` is validated structurally on the way IN and out, so a
                // tombstone carrying a name would never reach the join to begin with.
                NameRow::OwnerTombstone => "",
                _ => "Ada",
            }
        }

        fn tombstone(self) -> bool {
            self == NameRow::OwnerTombstone
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn roster_row(
        pair: &protocol::PersonKeyPair,
        role: GroupRosterRole,
        wrapped: Option<String>,
    ) -> GroupRosterMember {
        let public = pair.public_half();
        GroupRosterMember {
            fingerprint_hex: hex(pair.fingerprint()),
            person_id_hex: None,
            display_name: if role == GroupRosterRole::Owner {
                "Owner".into()
            } else {
                "Member".into()
            },
            role,
            state: GroupMemberState::Live,
            wrapped_group_key_hex: wrapped,
            member_kem_ek_hex: hex(public.kem_ek()),
            member_ed_pk_hex: hex(public.ed_pk()),
            member_mldsa_vk_hex: hex(public.mldsa_vk()),
            previous_fingerprint_hex: None,
            continuity: GroupKeyContinuity::Current,
            transition_hex: None,
        }
    }

    /// A real `NTV6` vault at a temp root: `vault.meta`, a live `MYU5` binding for `DEVICE`
    /// to the member written by the production claimant, and the `MYO5` row `name_row`
    /// asks for.
    struct Fixture {
        dir: ScopedTempDir,
        owner: protocol::PersonKeyPair,
        member_pair: protocol::PersonKeyPair,
        member_fingerprint_hex: String,
    }

    impl Fixture {
        async fn build(name_row: NameRow) -> Self {
            let mut rng = UnwrapErr(crate::rng::OsRng);
            let owner = protocol::PersonKeyPair::generate_raw(&[1u8; 64], &[2u8; 32], &[3u8; 32]);
            let member = protocol::PersonKeyPair::generate_raw(&[4u8; 64], &[5u8; 32], &[6u8; 32]);
            let dir = ScopedTempDir::new("identity-join").expect("temp dir");
            let root = dir.path();

            // -- `vault.meta` (NTV6), built the way the migration seals one ----------
            let mut base = protocol::parse_vault_meta_v0_2(
                &protocol::encode_vault_meta_v0_2_raw(
                    &ROOT,
                    &ITEMS,
                    &ITEMS_ID,
                    "pw",
                    "abandon abandon abandon",
                    &ACCT,
                    &crate::test_support::FAST_TEST_KDF,
                    &[1u8; protocol::ARGON2_SALT_LEN],
                    &[2u8; protocol::ARGON2_SALT_LEN],
                    &[3u8; protocol::AEAD_NONCE_LEN],
                    &[4u8; protocol::AEAD_NONCE_LEN],
                    &[5u8; protocol::AEAD_NONCE_LEN],
                )
                .expect("encode NTV5"),
            )
            .expect("parse NTV5");
            let items_nonce = [6u8; protocol::AEAD_NONCE_LEN];
            let enc_items = protocol::aead_seal_ctx(
                &protocol::derive_group_subkey_v0_2(
                    &protocol::GroupKey::new(GROUP),
                    protocol::GroupRole::ItemsKeyWrap,
                ),
                &items_nonce,
                &ITEMS,
                &protocol::aad_vault_items_key_wrap_v0_2(&ITEMS_ID),
            )
            .expect("seal items");
            base.items_key_nonce = items_nonce;
            base.enc_items_key
                .copy_from_slice(&enc_items[..protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN]);

            let group_nonce = [7u8; protocol::AEAD_NONCE_LEN];
            let enc_group = protocol::aead_seal_ctx(
                &protocol::derive_owner_subkey_v0_2(
                    &protocol::OwnerKey::new(ROOT),
                    protocol::OwnerRole::GroupKeyWrap,
                ),
                &group_nonce,
                &GROUP,
                &protocol::aad_vault_group_key_wrap_v0_2(&ACCT, EPOCH),
            )
            .expect("seal group");

            // A real group package, so the member row's `wrapped_group_key_hex` is a
            // canonical value the roster codec accepts rather than filler.
            let package = protocol::person_invite::create_group_package(
                &owner,
                &member.public_half(),
                &GROUP,
                &ACCT,
                EPOCH,
                &mut rng,
            )
            .expect("package");
            let wrapped =
                protocol::person_invite::verify_group_package(&owner.public_half(), &package)
                    .expect("verify package")
                    .wrapped_group_key_hex;

            let mut member_row = roster_row(&member, GroupRosterRole::Member, Some(wrapped));
            member_row.person_id_hex = Some(hex(&PERSON_ID).to_ascii_uppercase());
            let roster = GroupRosterPayload {
                account_number_hash_hex: hex(&ACCT),
                group_key_epoch: EPOCH,
                owner_fingerprint_hex: hex(owner.fingerprint()),
                members: vec![member_row, roster_row(&owner, GroupRosterRole::Owner, None)],
            };
            let signed = protocol::person_invite::sign_group_roster(&owner, &roster, &mut rng)
                .expect("sign");
            let envelope = protocol::person_invite::seal_group_roster(
                &GROUP,
                &ACCT,
                EPOCH,
                &[0xE7; protocol::AEAD_NONCE_LEN],
                &signed,
            )
            .expect("seal roster");
            let meta = protocol::B2bVaultMeta {
                base,
                group_key_nonce: group_nonce,
                enc_group_key: enc_group.try_into().expect("64 B"),
                group_key_epoch: EPOCH,
                signed_roster_envelope: envelope,
            };
            std::fs::write(
                root.join("vault.meta"),
                protocol::serialize_vault_meta_ntv6(&meta).expect("serialize NTV6"),
            )
            .expect("write meta");

            // -- `vault.member-names` (MYO5), the third hop's store ------------------
            if name_row != NameRow::Absent {
                let names_key = protocol::derive_group_subkey_v0_2(
                    &protocol::GroupKey::new(GROUP),
                    protocol::GroupRole::MemberNamesKey,
                );
                // `Impostor` uses the owner, whose public half the roster carries on its
                // OWN row rather than on the member row this `person_id` belongs to.
                let signer = if name_row.signed_by_member() {
                    &member
                } else {
                    &owner
                };
                let row = protocol::sign_member_name(
                    signer,
                    &PERSON_ID,
                    1,
                    name_row.tombstone(),
                    name_row.name(),
                    &mut rng,
                )
                .expect("sign name");
                let mut map = protocol::MemberNamesMap::new();
                map.insert(hex(&PERSON_ID), row);
                let blob = protocol::encode_member_names_blob(&names_key, &ACCT, EPOCH, &map)
                    .expect("seal names");
                std::fs::write(
                    root.join(crate::plugins::member_names::MEMBER_NAMES_FILE),
                    blob,
                )
                .expect("write names");
            }

            // -- `vault.device-bindings` (MYU5), the first hop's store, written by the
            //    production claimant so the fixture cannot encode a second opinion about
            //    how a row is signed or keyed -----------------------------------------
            let io = StdVaultIo;
            let bindings_key =
                crate::plugins::device_binding::bindings_key_for_group(&GROUP, ACCT, EPOCH);
            crate::plugins::device_binding::claim_self_in_dir(
                &io,
                root,
                &bindings_key.borrow(),
                &member,
                &DEVICE,
                None,
                &mut rng,
            )
            .await
            .expect("claim self");

            let member_fingerprint_hex = hex(member.fingerprint());
            Self {
                dir,
                owner,
                member_pair: member,
                member_fingerprint_hex,
            }
        }

        /// Replace the binding store with a SINGLE row that names `DEVICE` as the member's
        /// but is signed by the OWNER, a co-member who holds the group key and can therefore
        /// seal anything into this map.
        ///
        /// This is the one fixture the production claimant cannot build, and the reason is
        /// the point: `claim_self_in_dir` only ever signs a row with the key of the person the
        /// row names, so a suite built entirely on it is structurally unable to fail on an
        /// unverified row. The attack needs no forgery of the member's key, only the group
        /// seal every member holds.
        async fn forge_binding_signed_by_the_owner(&self) {
            let mut rng = UnwrapErr(crate::rng::OsRng);
            let mut map = protocol::DeviceBindingsMap::new();
            map.insert(
                hex(&DEVICE),
                protocol::sign_device_binding(
                    &self.owner,
                    &DEVICE,
                    self.member_pair.fingerprint(),
                    1,
                    false,
                    &mut rng,
                )
                .expect("sign forged row"),
            );
            // Written through the PRODUCTION seal path, so the signer is the only thing this
            // fixture varies: no second opinion about how a row is keyed or sealed.
            let resolved =
                crate::plugins::device_binding::bindings_key_for_group(&GROUP, ACCT, EPOCH);
            crate::plugins::device_binding::write_device_bindings_in_dir(
                &StdVaultIo,
                self.dir.path(),
                &resolved.borrow(),
                &map,
            )
            .await
            .expect("write forged bindings");
        }
    }

    /// The feature, end to end: three verified hops turn a bound device into the member's
    /// chosen name, and the DEVICE label does not win over it.
    #[test]
    fn the_join_names_a_bound_device_across_three_verified_hops() {
        block_on(async {
            let f = Fixture::build(NameRow::Member).await;
            let io = StdVaultIo;
            let durable = join_durable_attribution(&io, f.dir.path(), Some(&f.owner), &GROUP).await;
            assert_eq!(
                durable.name_for(&hex(&DEVICE)),
                Some("Ada"),
                "device -> fingerprint -> person id -> signed name must produce a name"
            );
            assert_eq!(durable.len(), 1);

            // And through the ONE rule both surfaces share, with a device label present so
            // the ORDERING is exercised rather than merely the absence of a fallback.
            let mut names = BTreeMap::new();
            names.insert(hex(&DEVICE), "Member's Phone".to_string());
            assert_eq!(
                resolve_revision_author(&IdentityIndex::new(names, durable), Some(DEVICE)),
                ResolvedIdentity::Person { name: "Ada".into() }
            );
        });
    }

    /// The FIRST hop is verified, and this is the case that proves it. The binding map is
    /// group-sealed, so every member can write it; a co-member sealing
    /// `{DEVICE -> the member's fingerprint}` under their OWN key must therefore NOT render
    /// the member's name over that device. Without the partition the join reads the row's
    /// CLAIMED fingerprint, finds the live roster member carrying it, verifies that member's
    /// own signed NAME row, and prints their name over the attacker's revisions: the
    /// misattribution §9.30.4's MUST ("the claimed person of an unverified row MUST NOT be
    /// rendered as that device's person") and `0670` both exist to prevent.
    #[test]
    fn a_binding_row_the_named_person_did_not_sign_is_not_an_attribution() {
        block_on(async {
            let f = Fixture::build(NameRow::Member).await;
            let io = StdVaultIo;
            // The row is otherwise identical to the honest one: same device, same version,
            // same live tombstone state, and the same name store and roster behind it. Only
            // the SIGNER differs, which is exactly the half a fixture built on the production
            // claimant cannot vary.
            f.forge_binding_signed_by_the_owner().await;
            let durable = join_durable_attribution(&io, f.dir.path(), Some(&f.owner), &GROUP).await;
            assert_eq!(
                durable.name_for(&hex(&DEVICE)),
                None,
                "a row signed by a co-member must not name the member it claims"
            );
            assert_eq!(durable.len(), 0);
        });
    }

    /// A member session, which is the case the candidate loop exists for: no local owner
    /// identity, and the owner's public half held only as the out-of-band code pinned at
    /// invite accept. Picking the candidate from the session's authority would answer an
    /// empty index here, and every member would see device labels for a member who had named
    /// themselves.
    #[test]
    fn a_member_session_resolves_the_owner_half_from_the_pinned_identity_code() {
        block_on(async {
            let f = Fixture::build(NameRow::Member).await;
            let io = StdVaultIo;
            let code = crate::plugins::sync::invite::encode_person_identity_code(
                &[0x99; 16],
                &f.owner.public_half(),
            );
            let sync_state = crate::plugins::sync::state::SyncState {
                owner_identity_code: Some(code),
                ..Default::default()
            };
            crate::plugins::sync::state::write_sync_state(&io, f.dir.path(), &sync_state)
                .await
                .expect("write sync state");

            let durable = join_durable_attribution(&io, f.dir.path(), None, &GROUP).await;
            assert_eq!(durable.name_for(&hex(&DEVICE)), Some("Ada"));
        });
    }

    /// Removing a member tombstones their bindings, and the join drops a tombstoned row, so
    /// the device falls back to its label rather than keeping the name of a person who is no
    /// longer in the vault.
    ///
    /// The opposite direction, a RETIRED device whose member is still live, is the writer's
    /// property rather than the join's: `0669` (task 3) has a retirement write NO tombstone,
    /// so there is nothing here for the join to drop, which is exactly why a retired
    /// device's past revisions keep their attribution. The join's own contribution to that
    /// property is the `live_device_bindings` filter this test exercises from the other side.
    #[test]
    fn a_tombstoned_binding_drops_the_device_back_to_its_label() {
        block_on(async {
            let f = Fixture::build(NameRow::Member).await;
            let io = StdVaultIo;
            let bindings_key =
                crate::plugins::device_binding::bindings_key_for_group(&GROUP, ACCT, EPOCH);
            let mut rng = UnwrapErr(crate::rng::OsRng);
            let (_, tombstoned) = crate::plugins::device_binding::tombstone_member_devices_in_dir(
                &io,
                f.dir.path(),
                &bindings_key.borrow(),
                &f.owner,
                &f.member_fingerprint_hex,
                &mut rng,
            )
            .await
            .expect("tombstone");
            assert_eq!(tombstoned, 1, "the live binding must be tombstoned");

            let durable = join_durable_attribution(&io, f.dir.path(), Some(&f.owner), &GROUP).await;
            assert!(
                durable.is_empty(),
                "a tombstoned binding is a merge input, not an attribution"
            );
            let mut names = BTreeMap::new();
            names.insert(hex(&DEVICE), "Member's Phone".to_string());
            assert_eq!(
                resolve_revision_author(&IdentityIndex::new(names, durable), Some(DEVICE)),
                ResolvedIdentity::Device {
                    name: Some("Member's Phone".into()),
                    code: "777777".into()
                }
            );
        });
    }

    /// A name row the ROSTER's keys do not verify contributes nothing. The row here is signed
    /// by the owner while the roster row it is keyed for carries the member's halves, which is
    /// what a forged row looks like: the store opens (the group tier seals it), the row parses,
    /// and only the signature check stops it. Without this arm a join that skipped
    /// `partition_verified` entirely would pass every other test here.
    #[test]
    fn a_name_row_the_roster_does_not_verify_is_not_an_attribution() {
        block_on(async {
            let f = Fixture::build(NameRow::Impostor).await;
            let io = StdVaultIo;
            let durable = join_durable_attribution(&io, f.dir.path(), Some(&f.owner), &GROUP).await;
            assert!(
                durable.is_empty(),
                "a name signed by a person the roster row does not name is not an attribution"
            );
        });
    }

    /// A member who has not chosen a name yet is the same absence as a device with no binding:
    /// the index carries nothing, so the surface shows the device label. Distinct from the
    /// impostor case above, and the arm that a join which treated "roster row present" as
    /// "attributed" would get wrong.
    #[test]
    fn a_member_with_no_name_row_yields_no_attribution() {
        block_on(async {
            let f = Fixture::build(NameRow::Absent).await;
            let io = StdVaultIo;
            let durable = join_durable_attribution(&io, f.dir.path(), Some(&f.owner), &GROUP).await;
            assert!(durable.is_empty());
        });
    }

    /// The `tombstone` half of the join's name filter, and the half a fixture cannot reach by
    /// accident. An owner-signed REMOVAL passes `partition_verified` through the
    /// owner-signature arm, so at the join the row is VERIFIED and carries no name: only the
    /// flag distinguishes it from a live name, and a join that took any verified row as an
    /// attribution would name a person the owner had removed.
    #[test]
    fn an_owner_signed_removal_is_not_an_attribution() {
        block_on(async {
            let f = Fixture::build(NameRow::OwnerTombstone).await;
            let io = StdVaultIo;
            let durable = join_durable_attribution(&io, f.dir.path(), Some(&f.owner), &GROUP).await;
            assert!(
                durable.is_empty(),
                "a tombstoned row is a removal, whatever name it still carries"
            );
        });
    }

    /// A vault with no group tier is not an error and not a delay: `join_durable_attribution`
    /// answers an empty index, so the caller renders device labels.
    #[test]
    fn a_vault_without_a_parseable_meta_answers_an_empty_index() {
        block_on(async {
            let dir = ScopedTempDir::new("identity-join-none").expect("temp dir");
            let io = StdVaultIo;
            assert!(join_durable_attribution(&io, dir.path(), None, &GROUP)
                .await
                .is_empty());
        });
    }

    // ── The device list the settings surface renders (`member-devices` task 11) ────
    //
    // `device_attribution_view` is the JOIN's public shape rather than a second join: the
    // same verifiers, the same partition, over a map the command layer already read. These
    // tests drive it through the command's own resolution (one peek would be needed there;
    // here the group key and the temp root are the fixture's), so a hop mistyped in the
    // shared half fails here as well as above.

    /// Build the view exactly as `device_bindings_list_with_dir` does, minus the session
    /// accessors a unit test has no `VaultRuntimeState` for.
    async fn view_of(
        f: &Fixture,
        session: Option<&protocol::PersonKeyPair>,
        this_device: Option<&[u8; 16]>,
    ) -> DeviceAttributionView {
        let io = StdVaultIo;
        let (resolved, b2b) =
            crate::plugins::device_binding::resolve_bindings_and_meta_from_group_key(
                &io,
                &GROUP,
                f.dir.path(),
            )
            .await
            .expect("resolve the family keyspace and the roster envelope");
        let map = crate::plugins::device_binding::read_device_bindings_in_dir(
            &io,
            f.dir.path(),
            &resolved.borrow(),
        )
        .await
        .expect("read the binding map");
        device_attribution_view(&io, f.dir.path(), session, &GROUP, &b2b, &map, this_device).await
    }

    /// The feature end to end through the list's own shape: a verified row names its member,
    /// carries the roster's person id for the label join, and marks exactly the device the
    /// caller is running on.
    ///
    /// **This is the assertion that fails if the partition is removed from this path.**
    /// Deleting `partition_live_bindings` from `device_attribution_view` leaves this test
    /// green (the honest row verifies either way) and reddens
    /// `the_device_list_never_names_a_row_the_named_person_did_not_sign` below, which is why
    /// the pair exists rather than either alone.
    #[test]
    fn the_device_list_names_a_verified_row_and_marks_only_this_device() {
        block_on(async {
            let f = Fixture::build(NameRow::Member).await;
            let view = view_of(&f, Some(&f.owner), Some(&DEVICE)).await;
            assert_eq!(view.rows.len(), 1, "one bound device, one row");
            assert!(view.unverified_device_ids.is_empty());
            let row = &view.rows[0];
            assert_eq!(row.device_id_hex, hex(&DEVICE));
            assert_eq!(
                row.member_name.as_deref(),
                Some("Ada"),
                "the third hop's signed name is what the list renders"
            );
            assert_eq!(
                row.person_id_hex.as_deref(),
                Some(hex(&PERSON_ID).as_str()),
                "the row carries the roster's person id, lowercased, for the label join"
            );
            assert_eq!(row.person_fingerprint_hex, f.member_fingerprint_hex);
            assert!(
                row.is_this_device,
                "the device passed as this device must be marked, or the list cannot say \
                 which row is the reader's own"
            );

            // The mark is about the CALLER's device and not about the first row: another
            // device id, or none at all, leaves every row unmarked. Without this the flag
            // could be hardcoded true and every other assertion here would still pass.
            let other = view_of(&f, Some(&f.owner), Some(&[0x99; 16])).await;
            assert!(!other.rows[0].is_this_device);
            let none = view_of(&f, Some(&f.owner), None).await;
            assert!(!none.rows[0].is_this_device);
        });
    }

    /// The MUST this whole change exists for, asserted at the LIST's boundary rather than at
    /// the join's: a row a co-member sealed under their own key may be reported as an
    /// unverified device id and must never be named after the member it claims.
    ///
    /// The forged row is otherwise identical to the honest one, and the name store and roster
    /// behind it are the same, so the ONLY thing separating this from the test above is the
    /// signature. Injecting the defect means deleting `partition_live_bindings` from
    /// `device_attribution_view`: the row then reaches the surface carrying the member's name
    /// and this test fails on `rows.len()`, which is the misattribution `protocol.md` §9.30.4
    /// and `decisions/protocol/0670` both forbid.
    #[test]
    fn the_device_list_never_names_a_row_the_named_person_did_not_sign() {
        block_on(async {
            let f = Fixture::build(NameRow::Member).await;
            f.forge_binding_signed_by_the_owner().await;
            let view = view_of(&f, Some(&f.owner), Some(&DEVICE)).await;
            assert!(
                view.rows.is_empty(),
                "a row signed by a co-member must reach no row list, whatever it claims"
            );
            assert_eq!(
                view.unverified_device_ids,
                vec![hex(&DEVICE)],
                "and it must be REPORTED rather than dropped: a tampered row that renders as \
                 absent is indistinguishable from a device that was never bound"
            );
        });
    }

    /// The tombstones the list does NOT report as tampering. A member removal writes signed
    /// tombstones over that person's devices, and those rows VERIFY, so a view that treated
    /// every non-live row as unverified would tell the user their vault had been tampered
    /// with every time they removed somebody.
    #[test]
    fn the_device_list_drops_a_tombstoned_row_without_calling_it_unverified() {
        block_on(async {
            let f = Fixture::build(NameRow::Member).await;
            let io = StdVaultIo;
            let bindings_key =
                crate::plugins::device_binding::bindings_key_for_group(&GROUP, ACCT, EPOCH);
            let mut rng = UnwrapErr(crate::rng::OsRng);
            let (_, tombstoned) = crate::plugins::device_binding::tombstone_member_devices_in_dir(
                &io,
                f.dir.path(),
                &bindings_key.borrow(),
                &f.owner,
                &f.member_fingerprint_hex,
                &mut rng,
            )
            .await
            .expect("tombstone");
            assert_eq!(tombstoned, 1);

            let view = view_of(&f, Some(&f.owner), Some(&DEVICE)).await;
            assert!(
                view.rows.is_empty(),
                "a removal is not a device in the list"
            );
            assert!(
                view.unverified_device_ids.is_empty(),
                "a signed removal verifies, so it is not the tamper channel"
            );
        });
    }

    /// The degrade arm: a session that cannot establish the roster (here, a member's key
    /// naming a vault whose roster the OWNER signed, with no pinned identity code and no
    /// owner session) answers every device id UNVERIFIED rather than failing the command or
    /// answering an empty list.
    ///
    /// The direction matters and is not arbitrary: an error here would make the list
    /// unusable on a device that simply has not pinned the owner's code yet, and an EMPTY
    /// list would read as "no devices". Reporting the ids is the only shape that is both
    /// truthful and useful.
    #[test]
    fn the_device_list_reports_every_device_unverified_when_it_cannot_verify_the_roster() {
        block_on(async {
            let f = Fixture::build(NameRow::Member).await;
            let view = view_of(&f, Some(&f.member_pair), Some(&DEVICE)).await;
            assert!(view.rows.is_empty());
            assert_eq!(
                view.unverified_device_ids,
                vec![hex(&DEVICE)],
                "an unverifiable roster must not be reported as a tampered device either"
            );
            assert_ne!(
                view.unverified_device_ids.len(),
                0,
                "and the row must not vanish: an empty view here would be indistinguishable \
                 from a vault with no bindings"
            );
        });
    }
}
