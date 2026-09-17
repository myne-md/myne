// SPDX-License-Identifier: AGPL-3.0
//! The vault invite envelope (B2B identity substrate, myne-md/myne#698
//! tasks 5-6).
//!
//! An invite is ONE message a vault owner sends to a prospective member:
//! the vault's `itemsKey` wrapped to that member's person public half
//! ([`crate::person_key::PersonWrappedKey`]), plus the owner's identity
//! fingerprint and the owner's double signature (Ed25519 + ML-DSA-65,
//! side by side) over the canonical-JSON payload. The recipient verifies
//! BOTH halves, runs the SAS compare on the embedded fingerprints, and
//! unwraps.
//!
//! The envelope is wire-framed with a length-prefixed canonical-JSON body;
//! the crypto lives in [`crate::person_key`].
//!
//! # Randomness
//!
//! Every constructor that takes caller-supplied randomness carries the
//! crate's `_raw` suffix; convenience wrappers pull from `getrandom`.

use crate::aead::{AAD_PREFIX_V0_2, PROTOCOL_VERSION_V0_2};
use crate::person_key::{PersonSigned, PERSON_CT_LEN, PERSON_ED25519_PK_LEN};
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

/// Domain prefix for the invite signature class. A rotation notice signs a
/// DIFFERENT class (its own prefix), so a signature over one class cannot
/// be replayed as another.
pub const INVITE_PREFIX: &[u8] = b"myne.vault-invite v1|";

/// The AAD bound into the invite payload envelope: v0.2 prefix + version +
/// role `"vault-invite-blob"`.
///
/// DISTINCT from `person_key::aad_person_wrap` on purpose: the payload
/// envelope is a different message class from a per-recipient `itemsKey`
/// wrap, so reusing that AAD would collapse two classes into one domain.
/// The role is sync-wire-only (no §10.3 family), so it binds nothing else:
/// the vault binding the member needs arrives on the inner
/// `wrapped_items_key_hex`, whose own AAD carries `account_number_hash`.
pub fn aad_vault_invite() -> Vec<u8> {
    const ROLE_STR_VAULT_INVITE: &[u8] = b"vault-invite-blob";
    let mut aad = Vec::with_capacity(AAD_PREFIX_V0_2.len() + 1 + 2 + ROLE_STR_VAULT_INVITE.len());
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    crate::aead::push_length_prefixed_u16_be(&mut aad, ROLE_STR_VAULT_INVITE);
    aad
}

/// The signed invite payload (the canonical-JSON inner plaintext).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvitePayload {
    /// The vault owner's person fingerprint (64-char lowercase hex).
    pub owner_fingerprint_hex: String,
    /// The invited member's person fingerprint (64-char lowercase hex) :
    /// the SAS value both screens render at accept time.
    pub member_fingerprint_hex: String,
    /// The vault `itemsKey` wrapped to the member: lowercase hex of the
    /// wrapped-key pieces concatenated in fixed order
    /// (ed_ephemeral_pk || ml_kem_ct || nonce || wrapped_key).
    pub wrapped_items_key_hex: String,
    /// The vault's human-readable name (AS3-Sensitive, envelope-enclosed).
    pub vault_label: String,
    /// Unix epoch SECONDS the invite was created (user-meaningful,
    /// envelope-enclosed). TTL checks live host-side.
    pub created_at: u64,
}

/// The complete signed invite: the sealed payload frame + the owner's
/// public material so the member verifies without a key round-trip.
///
/// Every byte the member must trust arrives either AEAD-sealed to the
/// member (the payload frame) or signature-bound (the carried owner
/// halves, the fingerprints, the vault hash). Nothing the member acts on
/// is signed-plaintext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultInvite {
    /// Sealed payload ciphertext: the canonical payload JSON AEAD-sealed
    /// to the member under the PQ-hybrid envelope (plaintext + 16 B tag
    /// + 32 B CTX).
    pub enc_payload: Vec<u8>,
    /// Nonce for the payload-frame AEAD.
    pub nonce: [u8; 24],
    /// ML-KEM ciphertext of the payload frame's fresh envelope (1088 B).
    pub env_ml_kem_ct: [u8; crate::person_key::PERSON_CT_LEN],
    /// Classical-half ephemeral public of the payload frame (32 B).
    pub env_ed_ephemeral_pk: [u8; crate::person_key::PERSON_ED25519_PK_LEN],
    /// The vault's `account_number_hash` (16 B, lowercase hex). Carried in
    /// the clear: a non-member has no other way to learn it, and it is not
    /// a secret (the sync server already keys accounts by its hash). It is
    /// not part of the outer signature; tampering it fails the inner
    /// per-recipient `itemsKey` unwrap, whose AAD binds it, so proof of
    /// receipt is what authenticates this field.
    pub account_number_hash_hex: String,
    /// The owner's ML-KEM encapsulation key (1184 B, lowercase hex),
    /// carried so the member reconstructs the full three-half public
    /// material and checks it against the claimed fingerprint.
    pub owner_kem_ek_hex: String,
    /// The owner's ML-DSA verifying key (1952 B, lowercase hex), carried so
    /// the member verifies without a key round-trip.
    pub owner_mldsa_vk_hex: String,
    /// The owner's Ed25519 public key (32 B, lowercase hex).
    pub owner_ed25519_pk_hex: String,
    /// The owner's fingerprint (the SAS compare value).
    pub owner_fingerprint_hex: String,
    /// The member's fingerprint (the SAS compare value).
    pub member_fingerprint_hex: String,
    /// The owner's double signature over `INVITE_PREFIX || env_ml_kem_ct
    /// || env_ed_ephemeral_pk || nonce || enc_payload`.
    pub signature: PersonSigned,
}

/// Canonical-JSON serialization of the invite payload.
pub fn encode_invite_payload(payload: &InvitePayload) -> Vec<u8> {
    serde_json::to_vec(payload).expect("canonical-JSON invite serialization is infallible")
}

/// The relay wire form of a whole [`VaultInvite`]: the byte fields hex-encoded
/// into a canonical-JSON object, so the owner can hand the frame to a member
/// over any transport (the roster route is Grill 4's `myne-md/myne#698`).
///
/// Reversible by [`vault_invite_from_wire`], which is what the accept side will
/// consume. The signature's two halves ride hex-encoded too, so the frame is a
/// single self-contained string.
pub fn vault_invite_to_wire(invite: &VaultInvite) -> String {
    let sig = &invite.signature;
    let obj = serde_json::json!({
        "enc_payload_hex": hex_lower(&invite.enc_payload),
        "nonce_hex": hex_lower(&invite.nonce),
        "env_ml_kem_ct_hex": hex_lower(&invite.env_ml_kem_ct),
        "env_ed_ephemeral_pk_hex": hex_lower(&invite.env_ed_ephemeral_pk),
        "account_number_hash_hex": invite.account_number_hash_hex,
        "owner_kem_ek_hex": invite.owner_kem_ek_hex,
        "owner_mldsa_vk_hex": invite.owner_mldsa_vk_hex,
        "owner_ed25519_pk_hex": invite.owner_ed25519_pk_hex,
        "owner_fingerprint_hex": invite.owner_fingerprint_hex,
        "member_fingerprint_hex": invite.member_fingerprint_hex,
        "signature_ed25519_hex": hex_lower(&sig.ed25519_sig),
        "signature_mldsa_hex": hex_lower(&sig.mldsa_sig),
    });
    serde_json::to_string(&obj).expect("canonical-JSON invite wire serialization is infallible")
}

/// Parse the wire form produced by [`vault_invite_to_wire`]. Any structural
/// problem (missing field, wrong length, uppercase hex) yields `None`.
pub fn vault_invite_from_wire(s: &str) -> Option<VaultInvite> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    let get = |k: &str| -> Option<&str> { v.get(k)?.as_str() };
    let dec = |k: &str| -> Option<Vec<u8>> { hex_decode_lower(get(k)?) };
    let nonce: [u8; 24] = dec("nonce_hex")?.try_into().ok()?;
    let env_ml_kem_ct: [u8; PERSON_CT_LEN] = dec("env_ml_kem_ct_hex")?.try_into().ok()?;
    let env_ed_ephemeral_pk: [u8; PERSON_ED25519_PK_LEN] =
        dec("env_ed_ephemeral_pk_hex")?.try_into().ok()?;
    let ed25519_sig: [u8; crate::person_key::PERSON_ED25519_SIG_LEN] =
        dec("signature_ed25519_hex")?.try_into().ok()?;
    Some(VaultInvite {
        enc_payload: dec("enc_payload_hex")?,
        nonce,
        env_ml_kem_ct,
        env_ed_ephemeral_pk,
        account_number_hash_hex: get("account_number_hash_hex")?.into(),
        owner_kem_ek_hex: get("owner_kem_ek_hex")?.into(),
        owner_mldsa_vk_hex: get("owner_mldsa_vk_hex")?.into(),
        owner_ed25519_pk_hex: get("owner_ed25519_pk_hex")?.into(),
        owner_fingerprint_hex: get("owner_fingerprint_hex")?.into(),
        member_fingerprint_hex: get("member_fingerprint_hex")?.into(),
        signature: PersonSigned {
            ed25519_sig,
            mldsa_sig: dec("signature_mldsa_hex")?,
        },
    })
}

/// Lowercase hex, no separator.
fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// Decode lowercase hex only (uppercase is rejected, matching the crate-wide
/// discipline).
fn hex_decode_lower(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let val = |b: u8| -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in s.as_bytes().chunks(2) {
        out.push((val(pair[0])? << 4) | val(pair[1])?);
    }
    Some(out)
}

/// Strict parse of the invite payload. Any structural violation (wrong
/// field type, uppercase or wrong-length fingerprint) yields `None`.
pub fn parse_invite_payload(bytes: &[u8]) -> Option<InvitePayload> {
    let payload: InvitePayload = serde_json::from_slice(bytes).ok()?;
    for fp in [
        &payload.owner_fingerprint_hex,
        &payload.member_fingerprint_hex,
    ] {
        if fp.len() != 64
            || fp
                .bytes()
                .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
        {
            return None;
        }
    }
    Some(payload)
}

/// Mint a signed invite: the owner wraps the vault `itemsKey` to the
/// member (the [`crate::person_key::PersonWrappedKey`] pieces, hex
/// concatenated in fixed order), seals the canonical payload to the
/// member under a fresh PQ-hybrid envelope, and double-signs the sealed
/// frame with the message-class prefix.
#[allow(clippy::too_many_arguments)]
pub fn create_invite(
    owner: &crate::person_key::PersonKeyPair,
    member_public: &crate::person_key::PersonPublicHalf,
    items_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_label: &str,
    created_at_secs: u64,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<VaultInvite, crate::person_key::PersonKeyError> {
    let wrapped = member_public.wrap_key(items_key, account_number_hash, rng)?;
    let mut pieces =
        Vec::with_capacity(PERSON_ED25519_PK_LEN + PERSON_CT_LEN + 24 + wrapped.wrapped_key.len());
    pieces.extend_from_slice(&wrapped.ed_ephemeral_pk);
    pieces.extend_from_slice(&wrapped.ml_kem_ct);
    pieces.extend_from_slice(&wrapped.nonce);
    pieces.extend_from_slice(&wrapped.wrapped_key);
    let wrapped_hex = hex_of(&pieces);

    let payload = InvitePayload {
        owner_fingerprint_hex: hex_of(owner.fingerprint()),
        member_fingerprint_hex: hex_of(member_public.fingerprint()),
        wrapped_items_key_hex: wrapped_hex,
        vault_label: vault_label.into(),
        created_at: created_at_secs,
    };
    let payload_bytes = encode_invite_payload(&payload);
    let sealed = member_public.seal_to_member_with_aad(&payload_bytes, &aad_vault_invite(), rng)?;

    // The double signature covers the sealed frame with the message-class
    // prefix: a signature over one class can never verify as another.
    let mut signed_bytes = Vec::with_capacity(
        INVITE_PREFIX.len()
            + sealed.ml_kem_ct.len()
            + sealed.ed_ephemeral_pk.len()
            + sealed.nonce.len()
            + sealed.ciphertext.len(),
    );
    signed_bytes.extend_from_slice(INVITE_PREFIX);
    signed_bytes.extend_from_slice(&sealed.ml_kem_ct);
    signed_bytes.extend_from_slice(&sealed.ed_ephemeral_pk);
    signed_bytes.extend_from_slice(&sealed.nonce);
    signed_bytes.extend_from_slice(&sealed.ciphertext);
    let signature = owner
        .sign(&signed_bytes, rng)
        .map_err(|_| crate::person_key::PersonKeyError::Csprng)?;

    let owner_half = owner.public_half();
    Ok(VaultInvite {
        enc_payload: sealed.ciphertext,
        nonce: sealed.nonce,
        env_ml_kem_ct: sealed.ml_kem_ct,
        env_ed_ephemeral_pk: sealed.ed_ephemeral_pk,
        account_number_hash_hex: hex_of(account_number_hash),
        owner_kem_ek_hex: hex_of(owner_half.kem_ek()),
        owner_mldsa_vk_hex: hex_of(owner_half.mldsa_vk()),
        owner_ed25519_pk_hex: hex_of(owner_half.ed_pk()),
        owner_fingerprint_hex: hex_of(owner.fingerprint()),
        member_fingerprint_hex: hex_of(member_public.fingerprint()),
        signature,
    })
}

/// Open an invite as the invited member: open the sealed frame, verify
/// BOTH signature halves over the sealed bytes, check the carried owner
/// material against the claimed fingerprint, decode the payload, and
/// unwrap the per-recipient `itemsKey` as proof of receipt.
///
/// Returns the payload and the unwrapped vault `itemsKey`. Every failure
/// mode collapses to [`crate::person_key::PersonKeyError::SignatureVerify`]
/// (identity/signature path) or `AeadFailure` (envelope/wrap path): the
/// wrong member cannot distinguish tampering from a foreign invite.
pub fn accept_invite(
    member: &crate::person_key::PersonKeyPair,
    invite: &VaultInvite,
) -> Result<(InvitePayload, zeroize::Zeroizing<[u8; 32]>), crate::person_key::PersonKeyError> {
    use crate::person_key::PersonKeyError;

    let account_number_hash: [u8; 16] = unhex_16(&invite.account_number_hash_hex)?;

    // Reconstruct the owner's full three-half public material and check it
    // against the claimed fingerprint BEFORE trusting any byte of it: a
    // substituted owner key beside a mismatched claim fails here, not at
    // the signature.
    let owner_half = crate::person_key::PersonPublicHalf::from_parts_hex(
        &invite.owner_kem_ek_hex,
        &invite.owner_ed25519_pk_hex,
        &invite.owner_mldsa_vk_hex,
    )?;
    if hex_of(owner_half.fingerprint()) != invite.owner_fingerprint_hex {
        return Err(PersonKeyError::SignatureVerify);
    }

    // Open the sealed frame with the member's own keypair.
    let sealed = crate::person_key::SealedToMember {
        ml_kem_ct: invite.env_ml_kem_ct,
        ed_ephemeral_pk: invite.env_ed_ephemeral_pk,
        nonce: invite.nonce,
        ciphertext: invite.enc_payload.clone(),
    };
    let _ = &sealed;
    let plaintext = member.open_sealed_with_aad(&sealed, &aad_vault_invite())?;

    // Verify both signature halves over the sealed frame with the class
    // prefix, exactly as minted.
    let mut signed_bytes = Vec::with_capacity(
        INVITE_PREFIX.len()
            + invite.env_ml_kem_ct.len()
            + invite.env_ed_ephemeral_pk.len()
            + invite.nonce.len()
            + invite.enc_payload.len(),
    );
    signed_bytes.extend_from_slice(INVITE_PREFIX);
    signed_bytes.extend_from_slice(&invite.env_ml_kem_ct);
    signed_bytes.extend_from_slice(&invite.env_ed_ephemeral_pk);
    signed_bytes.extend_from_slice(&invite.nonce);
    signed_bytes.extend_from_slice(&invite.enc_payload);
    owner_half.verify(&signed_bytes, &invite.signature)?;

    let payload = parse_invite_payload(&plaintext).ok_or(PersonKeyError::AeadFailure)?;
    if payload.member_fingerprint_hex != hex_of(member.fingerprint()) {
        return Err(PersonKeyError::FingerprintMismatch);
    }
    if payload.owner_fingerprint_hex != invite.owner_fingerprint_hex {
        return Err(PersonKeyError::SignatureVerify);
    }

    // Proof of receipt: unwrap the per-recipient itemsKey with the
    // member's own keypair. A member holding the right hex string but the
    // wrong keypair is indistinguishable from a stranger here, by design.
    let wrapped = decode_wrapped_hex(&payload.wrapped_items_key_hex)?;
    let items_key = member.unwrap_key(&wrapped, &account_number_hash)?;
    Ok((payload, items_key))
}

fn unhex_16(s: &str) -> Result<[u8; 16], crate::person_key::PersonKeyError> {
    use crate::person_key::PersonKeyError;
    if s.len() != 32
        || s.bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
    {
        return Err(PersonKeyError::FingerprintMismatch);
    }
    fn val(b: u8) -> u8 {
        match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            _ => 0,
        }
    }
    let mut out = [0u8; 16];
    for (i, pair) in s.as_bytes().chunks(2).enumerate() {
        out[i] = (val(pair[0]) << 4) | val(pair[1]);
    }
    Ok(out)
}

fn decode_wrapped_hex(
    s: &str,
) -> Result<crate::person_key::PersonWrappedKey, crate::person_key::PersonKeyError> {
    use crate::person_key::{PersonKeyError, PERSON_CT_LEN, PERSON_ED25519_PK_LEN};
    fn val(b: u8) -> u8 {
        match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            _ => 0,
        }
    }
    if !s.len().is_multiple_of(2)
        || s.bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
    {
        return Err(PersonKeyError::AeadFailure);
    }
    let bytes: Vec<u8> = s
        .as_bytes()
        .chunks(2)
        .map(|pair| (val(pair[0]) << 4) | val(pair[1]))
        .collect();
    if bytes.len() < PERSON_ED25519_PK_LEN + PERSON_CT_LEN + 24 + 48 {
        return Err(PersonKeyError::AeadFailure);
    }
    let mut ed_ephemeral_pk = [0u8; PERSON_ED25519_PK_LEN];
    let mut ml_kem_ct = [0u8; PERSON_CT_LEN];
    let mut nonce = [0u8; 24];
    ed_ephemeral_pk.copy_from_slice(&bytes[..PERSON_ED25519_PK_LEN]);
    ml_kem_ct.copy_from_slice(&bytes[PERSON_ED25519_PK_LEN..PERSON_ED25519_PK_LEN + PERSON_CT_LEN]);
    nonce.copy_from_slice(
        &bytes[PERSON_ED25519_PK_LEN + PERSON_CT_LEN..PERSON_ED25519_PK_LEN + PERSON_CT_LEN + 24],
    );
    let wrapped_key = bytes[PERSON_ED25519_PK_LEN + PERSON_CT_LEN + 24..].to_vec();
    Ok(crate::person_key::PersonWrappedKey {
        ml_kem_ct,
        ed_ephemeral_pk,
        wrapped_key,
        nonce,
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::person_key::PersonKeyPair;

    const ACCT: [u8; 16] = [0x44; 16];

    fn fixture_seed(label: &[u8]) -> [u8; 32] {
        use sha2::Digest as _;
        let digest = sha2::Sha256::digest(label);
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    fn fixture_kem(label: &[u8]) -> [u8; crate::person_key::PERSON_DK_SEED_LEN] {
        let mut s = [0u8; crate::person_key::PERSON_DK_SEED_LEN];
        s[..32].copy_from_slice(&fixture_seed(label));
        s[32..].copy_from_slice(&fixture_seed(label));
        s
    }

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
            use sha2::Digest as _;
            let ctr = self.0.wrapping_add(1);
            self.0 = ctr;
            let digest = sha2::Sha256::digest(ctr.to_le_bytes());
            let n = dst.len();
            dst[..n].copy_from_slice(&digest[..n]);
            Ok(())
        }
    }

    impl rand_core::TryCryptoRng for SeededRng {}

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

    #[test]
    fn create_then_accept_recovers_payload_and_items_key() {
        let owner = owner_pair();
        let member = member_pair();
        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");
        let invite = create_invite(
            &owner,
            &member.public_half(),
            &items_key,
            &ACCT,
            "Team Vault",
            1_760_000_000,
            &mut SeededRng(0),
        )
        .expect("create succeeds");
        let (payload, opened) = accept_invite(&member, &invite).expect("accept succeeds");
        assert_eq!(*opened, items_key);
        assert_eq!(payload.vault_label, "Team Vault");
        assert_eq!(payload.member_fingerprint_hex, hex_of(member.fingerprint()));
        assert_eq!(payload.owner_fingerprint_hex, hex_of(owner.fingerprint()));
    }

    #[test]
    fn invite_wire_round_trips_and_still_accepts() {
        // The relay form (`vault_invite_to_wire`) is what the invitee will
        // receive; parsing it back must give a frame the member can still open,
        // so the wire codec cannot drop or reorder a byte the accept path needs.
        let owner = owner_pair();
        let member = member_pair();
        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");
        let invite = create_invite(
            &owner,
            &member.public_half(),
            &items_key,
            &ACCT,
            "Team Vault",
            1_760_000_000,
            &mut SeededRng(0),
        )
        .expect("create succeeds");
        let wire = vault_invite_to_wire(&invite);
        let parsed = vault_invite_from_wire(&wire).expect("wire parses");
        assert_eq!(parsed, invite, "wire round-trip is byte-exact");
        let (_payload, opened) = accept_invite(&member, &parsed).expect("accept after wire");
        assert_eq!(*opened, items_key);
        // Rejections: uppercase hex and a missing field both fail closed.
        let mut value: serde_json::Value = serde_json::from_str(&wire).unwrap();
        value["nonce_hex"] = serde_json::Value::String("AB".repeat(24));
        assert!(vault_invite_from_wire(&alloc::format!("{value}")).is_none());
        assert!(vault_invite_from_wire("{not json").is_none());
    }

    #[test]
    fn accept_rejects_a_replayed_class_prefix() {
        // A signature minted for the invite class must not verify if the
        // verifier expects a different class: flip one prefix byte in the
        // signed bytes by tampering the sealed frame instead, which must
        // fail the signature (bind-then-sign covers the frame).
        let owner = owner_pair();
        let member = member_pair();
        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");
        let mut invite = create_invite(
            &owner,
            &member.public_half(),
            &items_key,
            &ACCT,
            "Team Vault",
            1_760_000_000,
            &mut SeededRng(0),
        )
        .expect("create succeeds");
        invite.enc_payload[0] ^= 0x01;
        assert!(accept_invite(&member, &invite).is_err());
    }

    #[test]
    fn invite_payload_round_trips() {
        let payload = InvitePayload {
            owner_fingerprint_hex: "ab".repeat(32),
            member_fingerprint_hex: "cd".repeat(32),
            wrapped_items_key_hex: "ef".repeat(64),
            vault_label: "Team Vault".into(),
            created_at: 1_760_000_000,
        };
        let bytes = encode_invite_payload(&payload);
        let parsed = parse_invite_payload(&bytes).expect("canonical bytes parse");
        assert_eq!(encode_invite_payload(&parsed), bytes);
    }

    #[test]
    fn hex_of_lowercases_and_pads() {
        assert_eq!(hex_of(&[0x0a, 0xff]), "0aff");
    }

    #[test]
    fn parser_rejects_uppercase_and_wrong_length_fingerprints() {
        let mut payload = InvitePayload {
            owner_fingerprint_hex: "AB".repeat(32),
            member_fingerprint_hex: "cd".repeat(32),
            wrapped_items_key_hex: "ef".repeat(64),
            vault_label: "V".into(),
            created_at: 0,
        };
        let bytes = encode_invite_payload(&payload);
        assert!(parse_invite_payload(&bytes).is_none());
        payload.owner_fingerprint_hex = "ab".repeat(31);
        let bytes2 = encode_invite_payload(&payload);
        assert!(parse_invite_payload(&bytes2).is_none());
    }
}
