// SPDX-License-Identifier: AGPL-3.0
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

/// Build the roster row for a just-invited member, so the invite WRITES the
/// first roster row instead of only minting a frame. Without this the roster
/// extension is never created: `sync_list_roster` answers empty forever and
/// `sync_remove_member` is unreachable.
///
/// The row carries the member's public halves (so any device can re-wrap a
/// rotated `itemsKey` without a round-trip) and the per-recipient wrap the
/// invite embedded. The vault label is used as the display name until the
/// accept side learns the member's chosen name; it is the only name available
/// at invite time.
pub fn invited_member_row(
    member_public: &PersonPublicHalf,
    wrapped_items_key_hex: String,
    vault_label: &str,
    joined_at_secs: u64,
) -> crate::plugins::sync::roster::RosterMemberEntry {
    crate::plugins::sync::roster::RosterMemberEntry {
        fingerprint_hex: hex_lower(member_public.fingerprint()),
        display_name: vault_label.into(),
        wrapped_items_key_hex,
        member_kem_ek_hex: hex_lower(member_public.kem_ek()),
        member_ed_pk_hex: hex_lower(member_public.ed_pk()),
        member_mldsa_vk_hex: hex_lower(member_public.mldsa_vk()),
        version: 0, // assigned by `upsert_member`
        deleted: false,
        previous_fingerprint_hex: None,
        joined_at: joined_at_secs,
    }
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

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::new();
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
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
}
