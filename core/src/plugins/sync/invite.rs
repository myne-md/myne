// SPDX-License-Identifier: AGPL-3.0-only
//! The vault invite core (B2B identity substrate, myne-md/myne#698
//! tasks 5-6): the inviter and acceptor command cores.
//!
//! Two seams matter here and only one is implemented this pass:
//!
//! - **The crypto half** is complete: `protocol::person_invite` mints and
//!   opens the envelope (wrap + double-signature + canonical JSON), and
//!   `protocol::person_key` carries the hybrid DH + hybrid signatures.
//! - **The wire route is Grill 4's** (B10: the roster/invite wire contract
//!   is a server-protocol design decision, not a client-side choice). This
//!   module therefore builds the invite and hands it to the caller; the
//!   transport route it rides lands with Grill 4. `FakeTransport`-driven
//!   tests pin the request shapes the wire layer must honor.
//!
//! # Randomness
//!
//! Both cores take caller-supplied CSPRNG bytes (the `_raw` convention);
//! the test vectors use seeded fixtures.

use protocol::person_invite::create_invite;
use protocol::person_key::{PersonKeyPair, PersonPublicHalf};
use std::string::String;

use crate::account::person_identity::hex_lower;

/// The whole-string prefix of the **out-of-band person identity code**
/// (myne-md/myne#711). This is the channel a vault owner uses to obtain the
/// invitee's public halves, which the invite frame must seal the group key to.
///
/// It is NOT a protocol byte boundary and NOT an AEAD/magic value: it never
/// reaches the sync server (the outer relay frame carries only the recipient
/// person id and the vault id), and it carries **public** material only. It is
/// written whole so a reader can grep it, per `discoverable-code.md`'s rule for
/// a named string.
///
/// Shape: `<prefix><person_id_hex>:<kem_ek_hex>:<ed_pk_hex>:<mldsa_vk_hex>`,
/// all lowercase hex, fixed-length per field, so parsing is unambiguous.
pub const PERSON_IDENTITY_CODE_PREFIX: &str = "MYNE-PERSON-1:";

/// A decoded person identity code: the addressable person id plus the public
/// halves the invite is sealed to. The fingerprint is derived from the halves,
/// so the SAS compare runs over the same bytes the code carried.
#[derive(Debug, Clone)]
pub struct PersonIdentityCode {
    /// The 16-byte `person_id_hash`, the relay's addressing key.
    pub person_id: [u8; 16],
    /// The person's public halves (KEM ek + Ed25519 pk + ML-DSA vk).
    pub public: PersonPublicHalf,
}

/// Encode a person identity code from the person id and public halves. The
/// member's identity home renders this for the owner to paste (or, on a phone,
/// scan once QR capacity allows; the paste path is the one that always works).
pub fn encode_person_identity_code(person_id: &[u8; 16], public: &PersonPublicHalf) -> String {
    let mut code = String::with_capacity(64 + 3 * 4096);
    code.push_str(PERSON_IDENTITY_CODE_PREFIX);
    code.push_str(&hex_lower(person_id));
    code.push(':');
    code.push_str(&hex_lower(public.kem_ek()));
    code.push(':');
    code.push_str(&hex_lower(public.ed_pk()));
    code.push(':');
    code.push_str(&hex_lower(public.mldsa_vk()));
    code
}

/// Decode a person identity code. Every field is a fixed length, so a
/// truncated, extra, or non-hex field is `BadFraming` rather than a partial
/// parse: a code the owner pasted wrong must fail before an invite is sealed.
pub fn decode_person_identity_code(code: &str) -> Result<PersonIdentityCode, InviteError> {
    let rest = code
        .strip_prefix(PERSON_IDENTITY_CODE_PREFIX)
        .ok_or(InviteError::BadFraming)?;
    let parts: Vec<&str> = rest.split(':').collect();
    if parts.len() != 4 {
        return Err(InviteError::BadFraming);
    }
    let person_id = super::devices::hex16(parts[0]).ok_or(InviteError::BadFraming)?;
    let public = PersonPublicHalf::from_parts_hex(parts[1], parts[2], parts[3])
        .map_err(|_| InviteError::BadFraming)?;
    Ok(PersonIdentityCode { person_id, public })
}

/// Invite-flow errors. Separate enum per command (the per-command
/// closed-enum discipline); no `String` field ever reaches the frontend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InviteError {
    /// The vault slot is not Unlocked (no `itemsKey` to wrap).
    VaultLocked,
    /// A signature half failed verification at accept time
    /// (non-distinguishing between the halves).
    SignatureVerify,
    /// The payload envelope failed AEAD verification (wrong owner key or
    /// tampered bytes, non-distinguishing, the §7.3 discipline).
    CannotDecrypt,
    /// The invite bytes failed strict framing (magic, version, lengths).
    BadFraming,
    /// The OS CSPRNG failed.
    Csprng,
}

/// The acceptor's core for an `NTV6` **group package** (myne-md/myne#711
/// task 12): verify the owner's double signature, confirm the package names
/// this member at this vault, and unwrap the group key.
///
/// The owner's public half is a **pinned** input, not taken from the package
/// (`protocol::person_invite`'s roster doc says the same): the member obtains it
/// out of band through the owner's person identity code and confirms the
/// fingerprint with the SAS compare, which is what stops a substituted owner key
/// from being trusted. Verification is therefore against `owner`, never against
/// a key the payload supplied.
pub fn accept_group_package(
    owner: &PersonPublicHalf,
    member: &PersonKeyPair,
    package: &protocol::person_invite::SignedGroupPackage,
    account_number_hash: &[u8; 16],
) -> Result<(zeroize::Zeroizing<[u8; 32]>, u64, String), InviteError> {
    let payload =
        protocol::person_invite::verify_group_package(owner, package).map_err(|e| match e {
            protocol::person_key::PersonKeyError::SignatureVerify => InviteError::SignatureVerify,
            protocol::person_key::PersonKeyError::AeadFailure => InviteError::CannotDecrypt,
            _ => InviteError::BadFraming,
        })?;
    let epoch = payload.group_key_epoch;
    let group_key = protocol::person_invite::open_group_package(
        owner,
        member,
        package,
        account_number_hash,
        epoch,
    )
    .map_err(|e| match e {
        protocol::person_key::PersonKeyError::SignatureVerify => InviteError::SignatureVerify,
        protocol::person_key::PersonKeyError::AeadFailure => InviteError::CannotDecrypt,
        _ => InviteError::BadFraming,
    })?;
    Ok((group_key, epoch, hex_lower(owner.fingerprint())))
}

/// The inviter core: build a signed invite for one prospective member.
///
/// `items_key` is the UNLOCKED vault's singleton `itemsKey` (the caller
/// holds it in the UnlockedVault slot); `member_public` is the invitee's
/// person public half fetched from their SCRAM account. The returned
/// bytes are the [`protocol::VaultInvite`] the sync plane relays.
#[allow(clippy::too_many_arguments)]
pub fn invite_create(
    owner: &PersonKeyPair,
    member_public: &PersonPublicHalf,
    items_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_label: &str,
    created_at_secs: u64,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<protocol::person_invite::VaultInvite, InviteError> {
    let invite = create_invite(
        owner,
        member_public,
        items_key,
        account_number_hash,
        vault_label,
        created_at_secs,
        rng,
    )
    .map_err(|_| InviteError::CannotDecrypt)?;
    // Liveness guard: the invite MUST name the member it was wrapped to.
    if invite.member_fingerprint_hex != hex_lower(member_public.fingerprint()) {
        return Err(InviteError::BadFraming);
    }
    Ok(invite)
}

/// Build a roster row for a person joining the vault, so the invite WRITES a
/// roster row instead of only minting a frame. Without this the roster
/// extension is never created: `sync_list_roster` answers empty forever and
/// `sync_remove_member` is unreachable.
///
/// The row carries the person's public halves (so any device can re-wrap a
/// rotated `itemsKey` without a round-trip) and the per-recipient wrap the
/// invite embedded. The vault label is used as the display name until the
/// accept side learns the member's chosen name; it is the only name available
/// at invite time. The caller passes the vault `role`: `member` for an
/// invited teammate, `owner` for the owner's own row.
pub fn invited_member_row(
    member_public: &PersonPublicHalf,
    wrapped_items_key_hex: String,
    vault_label: &str,
    joined_at_secs: u64,
    role: crate::plugins::sync::roster::RosterRole,
) -> crate::plugins::sync::roster::RosterMemberEntry {
    crate::plugins::sync::roster::RosterMemberEntry {
        fingerprint_hex: hex_lower(member_public.fingerprint()),
        display_name: vault_label.into(),
        wrapped_items_key_hex,
        member_kem_ek_hex: hex_lower(member_public.kem_ek()),
        member_ed_pk_hex: hex_lower(member_public.ed_pk()),
        member_mldsa_vk_hex: hex_lower(member_public.mldsa_vk()),
        version: 0, // assigned by `upsert_member`
        role,
        deleted: false,
        previous_fingerprint_hex: None,
        transition_hex: None,
        joined_at: joined_at_secs,
    }
}

/// True when an invite names its own inviter: the member public half belongs
/// to the held owner identity. The caller must refuse it, because the member
/// upsert would otherwise overwrite the owner row with a member row and
/// silently demote the owner. Pure fingerprint equality, so it is unit
/// testable without a vault.
pub fn is_self_invite(owner: &PersonKeyPair, member_public: &PersonPublicHalf) -> bool {
    member_public.fingerprint() == owner.fingerprint()
}

/// The acceptor's core: open the sealed frame with the member's own
/// keypair (proving receipt capability, not string equality), verify BOTH
/// signature halves over the sealed bytes, and check the named member.
/// [`protocol::person_invite::accept_invite`] performs the unwrap as
/// part of acceptance and fails closed on it.
pub fn invite_accept(
    member: &PersonKeyPair,
    invite: &protocol::person_invite::VaultInvite,
) -> Result<
    (
        protocol::person_invite::InvitePayload,
        zeroize::Zeroizing<[u8; 32]>,
    ),
    InviteError,
> {
    let (payload, items_key) =
        protocol::person_invite::accept_invite(member, invite).map_err(|e| match e {
            protocol::person_key::PersonKeyError::SignatureVerify => InviteError::SignatureVerify,
            protocol::person_key::PersonKeyError::AeadFailure => InviteError::CannotDecrypt,
            _ => InviteError::BadFraming,
        })?;
    // The invited member MUST be the one named in the payload.
    if payload.member_fingerprint_hex != hex_lower(member.fingerprint()) {
        return Err(InviteError::BadFraming);
    }
    Ok((payload, items_key))
}

/// Lowercase hex of a wrapped-key's pieces in the roster's fixed order
/// (`ed_ephemeral_pk || ml_kem_ct || nonce || wrapped_key`), the same encoding
/// `member_removal` writes into `wrapped_items_key_hex`.
/// (Encoding is [`crate::account::person_identity::hex_lower`]; this wrapper
/// only fixes the field order.)
pub fn wrapped_hex(w: &protocol::person_key::PersonWrappedKey) -> String {
    use protocol::person_key::{PERSON_CT_LEN, PERSON_ED25519_PK_LEN};
    let mut bytes =
        Vec::with_capacity(PERSON_ED25519_PK_LEN + PERSON_CT_LEN + 24 + w.wrapped_key.len());
    bytes.extend_from_slice(&w.ed_ephemeral_pk);
    bytes.extend_from_slice(&w.ml_kem_ct);
    bytes.extend_from_slice(&w.nonce);
    bytes.extend_from_slice(&w.wrapped_key);
    hex_lower(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use sha2::Sha256;

    fn fixture_seed(label: &[u8]) -> [u8; 32] {
        let digest = Sha256::digest(label);
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    fn fixture_kem_seed(label: &[u8]) -> [u8; 32] {
        fixture_seed(label)
    }

    fn fixture_kem(label: &[u8]) -> [u8; protocol::person_key::PERSON_DK_SEED_LEN] {
        let mut s = [0u8; protocol::person_key::PERSON_DK_SEED_LEN];
        s[..32].copy_from_slice(&fixture_seed(label));
        s[32..].copy_from_slice(&fixture_seed(label));
        s
    }

    fn owner_pair() -> PersonKeyPair {
        PersonKeyPair::generate_raw(
            &fixture_kem(b"owner-kem-dz"),
            &fixture_seed(b"owner-ed25519"),
            &fixture_seed(b"owner-mldsa"),
        )
    }

    fn member_pair() -> PersonKeyPair {
        PersonKeyPair::generate_raw(
            &fixture_kem(b"member-kem-dz"),
            &fixture_seed(b"member-ed25519"),
            &fixture_seed(b"member-mldsa"),
        )
    }

    fn outsider_pair() -> PersonKeyPair {
        PersonKeyPair::generate_raw(
            &fixture_kem(b"outsider-kem-dz"),
            &fixture_seed(b"outsider-ed25519"),
            &fixture_seed(b"outsider-mldsa"),
        )
    }

    const ACCT: [u8; 16] = [0x44; 16];

    /// A deterministic CSPRNG for tests.
    struct SeededRng(u64);

    impl rand_core::TryRng for SeededRng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            Ok(0)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            Ok(0)
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            let ctr = self.0.wrapping_add(1);
            self.0 = ctr;
            let digest = sha2::Sha256::digest(ctr.to_le_bytes());
            let n = dst.len();
            dst[..n].copy_from_slice(&digest[..n]);
            Ok(())
        }
    }

    impl rand_core::TryCryptoRng for SeededRng {}

    #[test]
    fn create_then_accept_round_trips_the_invite() {
        let owner = owner_pair();
        let member = member_pair();
        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");

        let invite = invite_create(
            &owner,
            &member.public_half(),
            &items_key,
            &ACCT,
            "Team Vault",
            1_760_000_000,
            &mut SeededRng(0),
        )
        .expect("create succeeds");

        let (payload, opened_key) = invite_accept(&member, &invite).expect("accept succeeds");
        assert_eq!(
            *opened_key, items_key,
            "acceptance unwraps the vault itemsKey"
        );
        assert_eq!(
            payload.member_fingerprint_hex,
            hex_lower(member.fingerprint())
        );
    }

    #[test]
    fn accept_rejects_the_wrong_person() {
        let owner = owner_pair();
        let member = member_pair();
        let outsider = outsider_pair();
        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");

        let invite = invite_create(
            &owner,
            &member.public_half(),
            &items_key,
            &ACCT,
            "Team Vault",
            1_760_000_000,
            &mut SeededRng(0),
        )
        .expect("create succeeds");

        // The outsider cannot OPEN the sealed frame: the payload is AEAD
        // sealed to the named member's hybrid envelope, so a stranger fails
        // at decryption rather than at a later identity check. The refusal
        // is non-distinguishing (tampering reads the same), which is the
        // §7.3 discipline.
        let result = invite_accept(&outsider, &invite);
        assert!(matches!(result, Err(InviteError::CannotDecrypt)));
    }

    #[test]
    fn tampered_invite_signature_fails_closed() {
        let owner = owner_pair();
        let member = member_pair();
        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");

        let mut invite = invite_create(
            &owner,
            &member.public_half(),
            &items_key,
            &ACCT,
            "Team Vault",
            1_760_000_000,
            &mut SeededRng(0),
        )
        .expect("create succeeds");
        // Flip one ML-DSA signature byte: verification fails.
        let mid = invite.signature.mldsa_sig.len() / 2;
        invite.signature.mldsa_sig[mid] ^= 0x01;

        let result = invite_accept(&member, &invite);
        assert!(matches!(result, Err(InviteError::SignatureVerify)));
    }
    #[test]
    fn create_via_from_parts_hex_then_accept() {
        // The PRODUCTION construction path: the inviter builds the member
        // half from carried hex (including the KEM ek), not from a live
        // keypair. A create through that path must accept.
        use protocol::person_key::PersonPublicHalf;
        let owner = owner_pair();
        let member = member_pair();
        let half = member.public_half();
        let rebuilt = PersonPublicHalf::from_parts_hex(
            &hex_of(half.kem_ek()),
            &hex_of(half.ed_pk()),
            &hex_of(half.mldsa_vk()),
        )
        .expect("rebuild from carried hex");
        assert_eq!(rebuilt.fingerprint(), member.fingerprint());

        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");
        let invite = invite_create(
            &owner,
            &rebuilt,
            &items_key,
            &ACCT,
            "Team Vault",
            1_760_000_000,
            &mut SeededRng(0),
        )
        .expect("create succeeds");
        let (payload, opened_key) = invite_accept(&member, &invite).expect("accept succeeds");
        assert_eq!(*opened_key, items_key);
        assert_eq!(
            payload.member_fingerprint_hex,
            hex_lower(member.fingerprint())
        );
    }

    fn hex_of(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut s = String::new();
        for b in bytes {
            s.push(HEX[(b >> 4) as usize] as char);
            s.push(HEX[(b & 0x0f) as usize] as char);
        }
        s
    }

    #[test]
    fn invited_member_row_takes_a_role_and_starts_unversioned() {
        use crate::plugins::sync::roster::RosterRole;
        let owner = owner_pair();
        let member = member_pair();
        let owner_row = invited_member_row(
            &owner.public_half(),
            "ab".repeat(64),
            "Team Vault",
            1_760_000_000,
            RosterRole::Owner,
        );
        assert_eq!(owner_row.role, RosterRole::Owner);
        assert_eq!(owner_row.version, 0, "upsert assigns the version");
        assert_eq!(owner_row.fingerprint_hex, hex_lower(owner.fingerprint()));
        let member_row = invited_member_row(
            &member.public_half(),
            "cd".repeat(64),
            "Team Vault",
            1_760_000_000,
            RosterRole::Member,
        );
        assert_eq!(member_row.role, RosterRole::Member);
        assert_eq!(member_row.version, 0);
    }

    #[test]
    fn self_invite_is_detected_by_fingerprint_equality() {
        let owner = owner_pair();
        let member = member_pair();
        let outsider = outsider_pair();
        // The same identity on both sides is a self-invite and must refuse.
        assert!(is_self_invite(&owner, &owner.public_half()));
        // Different identities proceed, including a stranger's: the check is
        // equality, not membership, so it cannot over-refuse.
        assert!(!is_self_invite(&owner, &member.public_half()));
        assert!(!is_self_invite(&owner, &outsider.public_half()));
    }

    #[test]
    fn person_identity_code_round_trips_and_keeps_the_fingerprint() {
        let member = member_pair();
        let person_id = [0x5Au8; 16];
        let code = encode_person_identity_code(&person_id, &member.public_half());

        let decoded = decode_person_identity_code(&code).expect("decodes");
        assert_eq!(decoded.person_id, person_id);
        // The SAS compare runs over the decoded halves, so the fingerprint the
        // owner is shown MUST equal the member's own.
        assert_eq!(decoded.public.fingerprint(), member.fingerprint());
    }

    #[test]
    fn accept_group_package_verifies_owner_and_opens_the_group_key() {
        let owner = owner_pair();
        let member = member_pair();
        let outsider = outsider_pair();
        let group_key: [u8; 32] = fixture_seed(b"vault-group-key");

        let package = protocol::person_invite::create_group_package(
            &owner,
            &member.public_half(),
            &group_key,
            &ACCT,
            7,
            &mut SeededRng(0),
        )
        .expect("package");

        // The member opens the group key; the owner fingerprint is returned for
        // the SAS compare.
        let (opened, epoch, owner_fp) =
            accept_group_package(&owner.public_half(), &member, &package, &ACCT).expect("accept");
        assert_eq!(*opened, group_key);
        assert_eq!(epoch, 7);
        assert_eq!(owner_fp, hex_lower(owner.fingerprint()));

        // A tampered signature is refused.
        let mut tampered = package.clone();
        let mid = tampered.signature.mldsa_sig.len() / 2;
        tampered.signature.mldsa_sig[mid] ^= 0x01;
        assert!(matches!(
            accept_group_package(&owner.public_half(), &member, &tampered, &ACCT),
            Err(InviteError::SignatureVerify)
        ));

        // A WRONG owner public (a substituted key the payload did not sign for)
        // is refused, which is the property the out-of-band owner code anchors.
        assert!(matches!(
            accept_group_package(&outsider.public_half(), &member, &package, &ACCT),
            Err(InviteError::SignatureVerify)
        ));

        // A package sealed to someone else does not open for this member.
        assert!(matches!(
            accept_group_package(&owner.public_half(), &outsider, &package, &ACCT),
            Err(InviteError::CannotDecrypt)
        ));
    }

    #[test]
    fn person_identity_code_rejects_a_wrong_or_mangled_code() {
        let member = member_pair();
        let person_id = [0x5Au8; 16];
        let code = encode_person_identity_code(&person_id, &member.public_half());

        // Missing prefix (a bare hex blob the owner might paste by mistake).
        assert!(matches!(
            decode_person_identity_code(&code[PERSON_IDENTITY_CODE_PREFIX.len()..]),
            Err(InviteError::BadFraming)
        ));
        // A truncated field (odd hex length / wrong key length).
        let mut mangled = code.clone();
        mangled.pop();
        assert!(matches!(
            decode_person_identity_code(&mangled),
            Err(InviteError::BadFraming)
        ));
        // An extra field.
        assert!(matches!(
            decode_person_identity_code(&format!("{code}:00")),
            Err(InviteError::BadFraming)
        ));
        // A person id of the wrong length.
        assert!(matches!(
            decode_person_identity_code(&format!("{PERSON_IDENTITY_CODE_PREFIX}abcd:0:0:0")),
            Err(InviteError::BadFraming)
        ));
    }
}
