// SPDX-License-Identifier: AGPL-3.0
//! The vault membership **roster**: schema, codec, and merge (B2B identity
//! substrate, myne-md/myne#698 task 4).
//!
//! The B2B membership field's roster extension (NTV5 `reserved` byte `0x02`,
//! `protocol::MembershipRoster`) carries ONE AEAD envelope over this module's
//! canonical-JSON plaintext. This module owns three things:
//!
//! 1. **The schema**. a map from a member's identity fingerprint (the
//!    canonical SAS value, 32 bytes lowercase hex) to a [`RosterMemberEntry`]:
//!    the member's display name, the per-member wrapped `itemsKey`
//!    (`wrapped_items_key_hex`), the vault `role` (`owner`/`member`), the
//!    causal `version`, the `deleted` flag
//!    (a tombstone, remove-wins on merge), the `previous_keyset_fingerprint_hex`
//!    key-rotation visibility chain (B12), and the `joined_at` timestamp.
//! 2. **The codec**, canonical JSON for the map KEYS (a `BTreeMap` emits them
//!    in byte order), per-entry keys in declaration order, with no floats. The
//!    one free-text value (`display_name`) is emitted verbatim, NOT NFC-folded,
//!    so byte-identity is a property of a given writer's output, not of any two
//!    semantically equal rosters. Encode and strict parse round-trip
//!    byte-identically; any structural violation refuses.
//! 3. **The merge**, the attachments-catalog §11.4 pattern verbatim:
//!    per-member causal `version` join with a remove-wins tie (a tombstone
//!    outranks a live row at an equal `version`), keys unioned. Commutative,
//!    idempotent, associative by construction (myne-md/myne#405's property).
//!
//! The merge class flips here too: the roster is **shared** (it converges
//! across devices. a roster that only converged locally could not tell a
//! new device who has access), reversing 0580's device-local classification
//! for the EXTENSION while the single-account field stays device-local
//! (0580 unchanged).

use super::conflict::join_by_version;
use std::collections::BTreeMap;
use std::string::String;
use std::vec::Vec;

/// A member's vault role: the singleton `owner` (the `root_key` holder, the
/// only writer of this roster) or a plain `member`. The value rides inside
/// the owner-sealed roster, so only the owner can write it, and it is
/// administrative metadata: content write is flat and every member is an
/// authorized writer (myne-md/myne#714).
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Default,
    serde::Serialize,
    serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum RosterRole {
    Owner,
    #[default]
    Member,
}

/// True when the role is the `member` default the encoder omits, so a roster
/// written before the field existed keeps parsing as member by construction.
fn is_default_role(role: &RosterRole) -> bool {
    matches!(role, RosterRole::Member)
}

/// One member's row in the vault roster.
///
/// The identity key is the member's canonical fingerprint hex (64 lowercase
/// hex chars). the same value the invite-time SAS compares. so two
/// devices that never exchanged bytes agree on who is who by construction.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RosterMemberEntry {
    /// The member's person fingerprint (64-char lowercase hex of the 32
    /// canonical bytes). The map key, repeated inside the entry so the
    /// entry is self-contained for the sync plane.
    pub fingerprint_hex: String,
    /// Human-readable display name (the roster's only AS3-Sensitive free
    /// text; rides inside the AEAD envelope like every other field).
    pub display_name: String,
    /// The member's per-recipient wrap of the vault `itemsKey`
    /// (lowercase hex of the wrapped key bytes, sealed to this member's
    /// person public half). Rotation rewrites this field for every
    /// remaining member.
    pub wrapped_items_key_hex: String,
    /// The member's ML-KEM encapsulation key (1184 B, lowercase hex). Carried
    /// so ANY device holding the roster can re-wrap a rotated `itemsKey` to
    /// this member without a key round-trip. the operation member removal
    /// depends on. Public key material: envelope-enclosed but not secret.
    pub member_kem_ek_hex: String,
    /// The member's Ed25519 public key (32 B, lowercase hex). Same
    /// round-trip-free rationale as the KEM half (the classical DH half).
    pub member_ed_pk_hex: String,
    /// The member's ML-DSA verifying key (1952 B, lowercase hex). Same
    /// rationale (signature verification without a round-trip).
    pub member_mldsa_vk_hex: String,
    /// Causal version, the attachments-catalog clock (myne-md/myne#405):
    /// `max(versions this device observed) + 1` on any local mutation of
    /// this member's row.
    pub version: u64,
    /// The tombstone flag: `true` marks the member removed. Removal is a
    /// MARKED version, never an absence, a stale live copy must lose to
    /// it on merge (the resurrection guard).
    #[serde(default, skip_serializing_if = "core::ops::Not::not")]
    pub deleted: bool,
    /// The member's vault role. Administrative metadata inside the
    /// owner-sealed roster; it gates no decryption and no read. Absent on
    /// rosters written before the field existed, which parse as `member`.
    #[serde(default, skip_serializing_if = "is_default_role")]
    pub role: RosterRole,
    /// The PREVIOUS identity fingerprint this member row superseded, when
    /// a key rotation re-keyed the member (the `previousKeySet` chain,
    /// B12). Omitted when the member never rotated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_fingerprint_hex: Option<String>,
    /// Hex of a signed `myne.person-key-transition v1|` record proving the
    /// superseded key authorised the fingerprint change, when one exists.
    /// Present only for a cryptographic transition; an owner-confirmed relink
    /// leaves it absent. Omitted when the member never changed identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_hex: Option<String>,
    /// Unix epoch SECONDS of the join (or the rotation that re-rolled the
    /// row). A user-meaningful timestamp, so it lives inside the AEAD
    /// envelope per the project commitment.
    pub joined_at: u64,
}

fn tombstone_of(entry: &RosterMemberEntry) -> bool {
    entry.deleted
}

/// Total-order tie-break for two same-member rows at an equal `version`
/// (a true concurrent mutation pair). **Remove-wins**: a tombstone
/// outranks a live row (the resurrection guard's intent). Within a class
/// it compares every retained field so the order is total (`Equal` only
/// when the rows are byte-identical), which is what makes the merge
/// associative.
fn roster_tie_break(a: &RosterMemberEntry, b: &RosterMemberEntry) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (tombstone_of(a), tombstone_of(b)) {
        (true, false) => Ordering::Greater, // remove-wins
        (false, true) => Ordering::Less,
        _ => (
            &a.display_name,
            &a.wrapped_items_key_hex,
            &a.member_kem_ek_hex,
            &a.member_ed_pk_hex,
            &a.member_mldsa_vk_hex,
            a.joined_at,
            &a.previous_fingerprint_hex,
            &a.transition_hex,
            a.role,
        )
            .cmp(&(
                &b.display_name,
                &b.wrapped_items_key_hex,
                &b.member_kem_ek_hex,
                &b.member_ed_pk_hex,
                &b.member_mldsa_vk_hex,
                b.joined_at,
                &b.previous_fingerprint_hex,
                &b.transition_hex,
                b.role,
            )),
    }
}

/// The roster map: identity fingerprint hex → row.
pub type RosterMap = BTreeMap<String, RosterMemberEntry>;

/// Union-merge two rosters: the key set is the UNION (two owners inviting
/// different people at the same time both keep their invites, story 12),
/// and same-key rows join over the causal `version` with the remove-wins
/// tie (a removal carried as a marked row survives; a stale live copy that
/// never observed the delete carries a lower `version` and loses to it).
///
/// Commutative, idempotent and associative by construction: `join_by_version`
/// picks on one total order regardless of argument order, and the key union
/// is set-union.
pub fn merge_rosters(local: &RosterMap, remote: &RosterMap) -> RosterMap {
    let mut merged = RosterMap::new();
    let keys: Vec<String> = local
        .keys()
        .cloned()
        .chain(remote.keys().cloned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for key in keys {
        let entry = match (local.get(&key), remote.get(&key)) {
            (Some(l), None) => l.clone(),
            (None, Some(r)) => r.clone(),
            (Some(l), Some(r)) => join_by_version(l, r, |e| e.version, roster_tie_break),
            (None, None) => unreachable!("key came from the union"),
        };
        merged.insert(key, entry);
    }
    merged
}

/// Apply a member-removal rekey to a roster: the removed member's row
/// becomes a tombstone at version+1 (remove-wins on merge, every device
/// converges to the same tombstone), and every remaining member's row
/// advances (version+1) so the re-wrapped `itemsKey` reaches them.
///
/// The caller re-wraps each remaining member's key with
/// `protocol::person_rekey::wrap_items_key_to_member` and writes the hex
/// into the advanced rows; this function owns the bookkeeping.
pub fn apply_rekey(
    roster: &RosterMap,
    removed_fingerprint_hex: &str,
    new_wraps: &BTreeMap<String, String>,
) -> RosterMap {
    let mut out = RosterMap::new();
    for (key, entry) in roster {
        if key == removed_fingerprint_hex {
            // Tombstone the removed member at version+1 so a stale live
            // copy loses on merge (the resurrection guard).
            let mut tombstoned = entry.clone();
            tombstoned.deleted = true;
            tombstoned.version = entry.version + 1;
            out.insert(key.clone(), tombstoned);
        } else {
            let mut advanced = entry.clone();
            advanced.version = entry.version + 1;
            if let Some(new_wrap_hex) = new_wraps.get(key) {
                advanced.wrapped_items_key_hex = new_wrap_hex.clone();
            }
            out.insert(key.clone(), advanced);
        }
    }
    out
}

/// Insert or advance one member's row, the local-mutation entry point the
/// invite flow uses to create the roster's first row.
///
/// A brand-new member lands at `version = 1`; an existing live row advances by
/// one so the change outranks what peers hold. A tombstoned row is left alone
/// (an invite cannot resurrect a removed member without going through the
/// remove-wins tie), so the caller must surface that as a refusal rather than a
/// silent no-op.
pub fn upsert_member(roster: &RosterMap, entry: RosterMemberEntry) -> RosterMap {
    let mut out = roster.clone();
    let key = entry.fingerprint_hex.clone();
    let version = match roster.get(&key) {
        Some(existing) if !existing.deleted => existing.version + 1,
        Some(_) => return out, // tombstoned: never resurrect here
        None => 1,
    };
    let mut advanced = entry;
    advanced.version = version;
    out.insert(key, advanced);
    out
}

/// Insert the owner's own row exactly once, at the roster's first creation.
///
/// A later invite leaves any existing owner row (live or tombstoned)
/// untouched, even when the device-local person identity has changed and the
/// candidate therefore has a different fingerprint. The owner row is written
/// once and the member rows carry the churn. A brand-new owner lands at
/// `version = 1` via [`upsert_member`].
pub fn upsert_owner_once(roster: &RosterMap, owner: RosterMemberEntry) -> RosterMap {
    if roster.values().any(|entry| entry.role == RosterRole::Owner) {
        roster.clone()
    } else {
        upsert_member(roster, owner)
    }
}

/// Build the row for a member whose person identity changed, from their current
/// row: same member data, the NEW fingerprint as the key, and the superseded
/// fingerprint plus the signed transition record that proves the change
/// (`decisions/protocol/0604`). This is the writer `previous_fingerprint_hex`
/// and `transition_hex` were given; the caller re-signs the `NTV6` roster
/// afterwards.
pub fn transitioned_row(
    old: &RosterMemberEntry,
    new_fingerprint_hex: &str,
    transition_hex: &str,
) -> RosterMemberEntry {
    let mut row = old.clone();
    row.fingerprint_hex = new_fingerprint_hex.to_owned();
    row.previous_fingerprint_hex = Some(old.fingerprint_hex.clone());
    row.transition_hex = Some(transition_hex.to_owned());
    row.version = old.version + 1;
    row
}

/// The identity-continuity class a row implies for the signed roster:
/// `Changed` when a signed transition record is present (the superseded key
/// proved the change), `OwnerConfirmed` when only a previous fingerprint is
/// recorded (an owner relink with no proof), else `Current`.
pub fn continuity_of(entry: &RosterMemberEntry) -> protocol::person_invite::GroupKeyContinuity {
    use protocol::person_invite::GroupKeyContinuity;
    match (&entry.transition_hex, &entry.previous_fingerprint_hex) {
        (Some(_), Some(_)) => GroupKeyContinuity::Changed,
        (None, Some(_)) => GroupKeyContinuity::OwnerConfirmed,
        _ => GroupKeyContinuity::Current,
    }
}

/// Canonical-JSON serialization of the roster plaintext (the bytes
/// `protocol::seal_membership_roster_raw` seals).
///
/// Keys emit in the map's own (BTreeMap = lexicographic) order; per-entry
/// keys are emitted in the struct's declaration order with the two
/// omitempty fields dropped when empty, matching the `paired_extensions`
/// precedent (byte-stable round-trip, unknown-field tolerance on read).
pub fn encode_roster(roster: &RosterMap) -> Vec<u8> {
    serde_json::to_vec(roster).expect("canonical-JSON roster serialization is infallible")
}

/// Strict parse of the roster plaintext. Any structural problem (non-array,
/// wrong field type, over-length name) yields `None`; the caller maps the
/// refusal to its own error (the roster is AEAD-verified by the time this
/// runs, so a parse failure means MYNE's writer is broken, not an attack,
/// fail-closed rather than to a partial read).
pub fn parse_roster(bytes: &[u8]) -> Option<RosterMap> {
    let map: RosterMap = serde_json::from_slice(bytes).ok()?;
    for (key, entry) in &map {
        // The map key and the entry's own fingerprint MUST agree: removal
        // tombstones by MAP KEY while the UI renders the entry field, so a
        // roster whose two disagree would remove a different row than the one
        // displayed.
        if key != &entry.fingerprint_hex {
            return None;
        }
        if entry.fingerprint_hex.len() != 64 {
            return None;
        }
        if entry
            .fingerprint_hex
            .bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
        {
            return None;
        }
        // The three carried public halves are re-wrapped against during a
        // rotation, so their shape is validated here rather than failing later
        // inside `from_parts_hex` as an opaque `InvalidVaultMeta`.
        if entry.wrapped_items_key_hex.is_empty() {
            return None;
        }
        if !is_lower_hex_of(
            &entry.member_kem_ek_hex,
            protocol::person_key::PERSON_EK_LEN,
        ) {
            return None;
        }
        if !is_lower_hex_of(
            &entry.member_ed_pk_hex,
            protocol::person_key::PERSON_ED25519_PK_LEN,
        ) {
            return None;
        }
        if !is_lower_hex_of(
            &entry.member_mldsa_vk_hex,
            protocol::person_key::PERSON_MLDSA_VK_LEN,
        ) {
            return None;
        }
    }
    Some(map)
}

/// True when `s` is exactly `2 * byte_len` lowercase hex characters.
fn is_lower_hex_of(s: &str, byte_len: usize) -> bool {
    s.len() == byte_len * 2
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX_DIGITS: [char; 16] = [
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
    ];

    fn member(id: u8, version: u64, deleted: bool) -> (String, RosterMemberEntry) {
        let fp: String = core::iter::repeat_n(HEX_DIGITS[id as usize], 64).collect();
        (
            fp.clone(),
            RosterMemberEntry {
                fingerprint_hex: fp.clone(),
                display_name: if id == 1 { "Owner" } else { "Member" }.into(),
                wrapped_items_key_hex: "ab".repeat(32),
                member_kem_ek_hex: "cd".repeat(1184),
                member_ed_pk_hex: "ef".repeat(32),
                member_mldsa_vk_hex: "01".repeat(1952),
                version,
                role: RosterRole::Member,
                deleted,
                previous_fingerprint_hex: None,
                transition_hex: None,
                joined_at: 1_700_000_000 + id as u64,
            },
        )
    }

    #[test]
    fn concurrent_invites_from_two_owners_both_survive() {
        let local: RosterMap = {
            let mut m = BTreeMap::new();
            let (k, v) = member(1, 1, false);
            m.insert(k, v);
            m
        };
        let remote: RosterMap = {
            let mut m = BTreeMap::new();
            let (k, v) = member(2, 1, false);
            m.insert(k, v);
            m
        };
        let merged = merge_rosters(&local, &remote);
        assert_eq!(merged.len(), 2, "both invites survive a concurrent add");
        assert!(merged.contains_key(&member(1, 1, false).0));
        assert!(merged.contains_key(&member(2, 1, false).0));
    }

    #[test]
    fn removal_tombstone_beats_a_stale_live_copy() {
        let mut local: RosterMap = BTreeMap::new();
        // Local observed the removal: tombstone at version 3.
        let (k, v) = member(2, 3, true);
        local.insert(k, v);
        let mut remote: RosterMap = BTreeMap::new();
        // Remote's copy is a stale live row that never saw the delete.
        let (k, v) = member(2, 2, false);
        remote.insert(k, v);

        let merged = merge_rosters(&local, &remote);
        assert!(merged.get(&member(2, 0, false).0).expect("present").deleted);
    }

    #[test]
    fn equal_version_tie_is_remove_wins() {
        let mut local: RosterMap = BTreeMap::new();
        let (k, v) = member(1, 2, false);
        local.insert(k, v);
        let mut remote: RosterMap = BTreeMap::new();
        let (k, v) = member(1, 2, true);
        remote.insert(k, v);

        // Both argument orders agree: the tombstone wins the tie.
        let a = merge_rosters(&local, &remote);
        let b = merge_rosters(&remote, &local);
        assert!(a.get(&member(1, 0, false).0).expect("present").deleted);
        assert_eq!(a, b, "merge is commutative");
    }

    #[test]
    fn merge_is_idempotent() {
        let mut local: RosterMap = BTreeMap::new();
        let (k, v) = member(1, 1, false);
        local.insert(k, v);
        let merged = merge_rosters(&local, &local);
        assert_eq!(merged, local);
    }

    #[test]
    fn canonical_json_round_trips_byte_identically() {
        let mut roster: RosterMap = BTreeMap::new();
        let (k, v) = member(1, 1, false);
        roster.insert(k, v);
        let (k, v) = member(2, 4, true);
        roster.insert(k, v);

        let bytes = encode_roster(&roster);
        let parsed = parse_roster(&bytes).expect("canonical bytes parse");
        assert_eq!(encode_roster(&parsed), bytes);
    }

    #[test]
    fn parser_rejects_a_non_canonical_identity() {
        // An identity that is not 64 lowercase hex chars is refused.
        let mut roster: RosterMap = BTreeMap::new();
        let (k, mut v) = member(1, 1, false);
        v.fingerprint_hex = "ZZ".repeat(32);
        roster.insert(k, v);
        let bytes = encode_roster(&roster);
        assert!(parse_roster(&bytes).is_none());
    }
    #[test]
    fn apply_rekey_tombstones_removed_and_advances_remaining() {
        let mut roster: RosterMap = BTreeMap::new();
        let (k1, v1) = member(1, 1, false);
        let (k2, v2) = member(2, 1, false);
        roster.insert(k1.clone(), v1);
        roster.insert(k2.clone(), v2);

        let mut new_wraps: BTreeMap<String, String> = BTreeMap::new();
        new_wraps.insert(k1.clone(), "ff".repeat(32));

        let out = apply_rekey(&roster, &k2, &new_wraps);
        // Removed member: tombstone at version+1.
        assert!(out.get(&k2).expect("present").deleted);
        assert_eq!(out.get(&k2).expect("present").version, 2);
        // Remaining member: version advanced + wrap rewritten.
        let k1_out = out.get(&k1).expect("present");
        assert_eq!(k1_out.version, 2);
        assert_eq!(k1_out.wrapped_items_key_hex, "ff".repeat(32));
    }

    #[test]
    fn role_is_emitted_for_owner_omitted_for_member_and_absent_reads_member() {
        use super::RosterRole;
        // An owner row spells its role on the wire.
        let mut roster: RosterMap = BTreeMap::new();
        let (k, mut v) = member(1, 1, false);
        v.role = RosterRole::Owner;
        roster.insert(k.clone(), v);
        let bytes = encode_roster(&roster);
        let text = std::str::from_utf8(&bytes).expect("roster JSON is UTF-8");
        assert!(text.contains("\"role\":\"owner\""), "owner role is emitted");
        let parsed = parse_roster(&bytes).expect("owner role parses");
        assert_eq!(parsed.get(&k).expect("present").role, RosterRole::Owner);
        // A member row omits the default, so a pre-role blob reads as member.
        let mut plain: RosterMap = BTreeMap::new();
        let (k2, v2) = member(2, 1, false);
        plain.insert(k2.clone(), v2);
        let member_bytes = encode_roster(&plain);
        let member_text = std::str::from_utf8(&member_bytes).expect("UTF-8");
        assert!(
            !member_text.contains("role"),
            "default member role is omitted"
        );
        let reparsed = parse_roster(&member_bytes).expect("member parses");
        assert_eq!(reparsed.get(&k2).expect("present").role, RosterRole::Member);
    }

    #[test]
    fn unknown_role_is_refused() {
        let mut roster: RosterMap = BTreeMap::new();
        let (k, v) = member(1, 1, false);
        roster.insert(k, v);
        let roster_bytes = encode_roster(&roster);
        let text = std::str::from_utf8(&roster_bytes).expect("UTF-8");
        let injected = text.replacen("\"version\"", "\"role\":\"superadmin\",\"version\"", 1);
        assert!(parse_roster(injected.as_bytes()).is_none());
    }

    #[test]
    fn merge_tie_break_considers_role() {
        use super::RosterRole;
        // Same member, same version, differing only in role. The member
        // (Greater) wins the tie, and both argument orders agree.
        let fp = member(1, 1, false).0;
        let owner_entry = {
            let (_, mut v) = member(1, 1, false);
            v.role = RosterRole::Owner;
            v
        };
        let member_entry = {
            let (_, v) = member(1, 1, false);
            v
        };
        let mut local_a: RosterMap = BTreeMap::new();
        local_a.insert(fp.clone(), owner_entry);
        let mut remote_a: RosterMap = BTreeMap::new();
        remote_a.insert(fp.clone(), member_entry.clone());
        let merged_ab = merge_rosters(&local_a, &remote_a);
        assert_eq!(
            merged_ab.get(&fp).expect("present").role,
            RosterRole::Member
        );
        let merged_ba = merge_rosters(&remote_a, &local_a);
        assert_eq!(
            merged_ba.get(&fp).expect("present").role,
            RosterRole::Member
        );
        assert_eq!(merged_ab, merged_ba, "merge is commutative");
    }

    #[test]
    fn upsert_owner_once_inserts_at_version_one_when_absent() {
        use super::RosterRole;
        let empty: RosterMap = BTreeMap::new();
        let (_, mut owner) = member(1, 0, false);
        owner.role = RosterRole::Owner;
        let out = super::upsert_owner_once(&empty, owner);
        let row = out.get(&member(1, 0, false).0).expect("present");
        assert_eq!(row.version, 1);
        assert_eq!(row.role, RosterRole::Owner);
    }

    #[test]
    fn upsert_owner_once_leaves_an_existing_owner_row_untouched() {
        use super::RosterRole;
        // An owner row at version 5 must not advance or rewrite when a later
        // invite passes a fresh owner row.
        let (fp, mut existing) = member(1, 5, false);
        existing.role = RosterRole::Owner;
        existing.wrapped_items_key_hex = "aa".repeat(32);
        let mut roster: RosterMap = BTreeMap::new();
        roster.insert(fp.clone(), existing);
        let (_, mut fresh) = member(1, 0, false);
        fresh.role = RosterRole::Owner;
        fresh.wrapped_items_key_hex = "bb".repeat(32);
        let out = super::upsert_owner_once(&roster, fresh);
        let row = out.get(&fp).expect("present");
        assert_eq!(row.version, 5, "owner row version is not advanced");
        assert_eq!(
            row.wrapped_items_key_hex,
            "aa".repeat(32),
            "owner row wrap is not rewritten"
        );
    }

    #[test]
    fn upsert_owner_once_rejects_a_second_owner_with_a_different_identity() {
        use super::RosterRole;
        let (existing_fp, mut existing) = member(1, 5, false);
        existing.role = RosterRole::Owner;
        let mut roster: RosterMap = BTreeMap::new();
        roster.insert(existing_fp.clone(), existing);

        let (candidate_fp, mut candidate) = member(2, 0, false);
        candidate.role = RosterRole::Owner;
        let out = super::upsert_owner_once(&roster, candidate);

        assert_eq!(out, roster, "the existing singleton owner is preserved");
        assert!(out.contains_key(&existing_fp));
        assert!(!out.contains_key(&candidate_fp));
        assert_eq!(
            out.values()
                .filter(|entry| entry.role == RosterRole::Owner)
                .count(),
            1
        );
    }

    #[test]
    fn upsert_owner_once_promotes_a_legacy_same_identity_member() {
        use super::RosterRole;
        let (fp, member_row) = member(1, 2, false);
        let mut roster: RosterMap = BTreeMap::new();
        roster.insert(fp.clone(), member_row);

        let (_, mut owner) = member(1, 0, false);
        owner.role = RosterRole::Owner;
        let out = super::upsert_owner_once(&roster, owner);
        let row = out.get(&fp).expect("present");

        assert_eq!(row.role, RosterRole::Owner);
        assert_eq!(row.version, 3);
    }

    #[test]
    fn upsert_owner_once_does_not_resurrect_a_tombstoned_owner() {
        use super::RosterRole;
        let (fp, tomb) = member(1, 3, true);
        let mut roster: RosterMap = BTreeMap::new();
        roster.insert(fp.clone(), tomb);
        let (_, mut live) = member(1, 0, false);
        live.role = RosterRole::Owner;
        let out = super::upsert_owner_once(&roster, live);
        let row = out.get(&fp).expect("present");
        assert!(row.deleted, "tombstone is not resurrected");
        assert_eq!(row.version, 3);
    }

    #[test]
    fn transitioned_row_records_the_superseded_fingerprint_and_the_record() {
        let (old_fp, old) = member(2, 3, false);
        let new_fp = "ab".repeat(32);
        let row = super::transitioned_row(&old, &new_fp, "cdcd");
        assert_eq!(row.fingerprint_hex, new_fp);
        assert_eq!(
            row.previous_fingerprint_hex.as_deref(),
            Some(old_fp.as_str())
        );
        assert_eq!(row.transition_hex.as_deref(), Some("cdcd"));
        assert_eq!(row.version, 4, "the change advances the causal version");
    }

    #[test]
    fn continuity_of_reflects_transition_and_previous() {
        use protocol::person_invite::GroupKeyContinuity;
        let (_, mut row) = member(2, 1, false);
        assert_eq!(super::continuity_of(&row), GroupKeyContinuity::Current);
        row.previous_fingerprint_hex = Some("ab".repeat(32));
        assert_eq!(
            super::continuity_of(&row),
            GroupKeyContinuity::OwnerConfirmed
        );
        row.transition_hex = Some("cd".into());
        assert_eq!(super::continuity_of(&row), GroupKeyContinuity::Changed);
    }

    #[test]
    fn a_row_without_the_transition_field_parses_as_none() {
        // Back-compat: a roster written before `transition_hex` existed must
        // still parse, with the field absent rather than an error.
        let fp = "aa".repeat(32);
        let json = format!(
            r#"{{"{fp}":{{"fingerprint_hex":"{fp}","display_name":"M","wrapped_items_key_hex":"{}","member_kem_ek_hex":"{}","member_ed_pk_hex":"{}","member_mldsa_vk_hex":"{}","version":1,"joined_at":0}}}}"#,
            "bb".repeat(32),
            "cd".repeat(1184),
            "ef".repeat(32),
            "01".repeat(1952),
        );
        let roster = super::parse_roster(json.as_bytes()).expect("parses without the field");
        let row = roster.get(&fp).expect("row present");
        assert!(row.transition_hex.is_none());
        assert!(row.previous_fingerprint_hex.is_none());
    }
}
