// SPDX-License-Identifier: AGPL-3.0
//! The **device key**: the per-device signing pair that takes daily authority
//! away from the person key (`decisions/protocol/0731`, sharpened by `0733`).
//!
//! # What it signs, and what it deliberately cannot do
//!
//! A device key signs the records a device authors every session: the vault head
//! (at [`VAULT_HEAD_FORMAT_V3`](crate::vault_head::VAULT_HEAD_FORMAT_V3)), the
//! owner-signed group roster, the device's own binding row once that row carries
//! the device public halves, and the member display-name rows. It is a SIGNING
//! pair and nothing else — no KEM half, no wrapping — which is the property that
//! makes caching it in an OS keychain safe: **a device key unwraps nothing**, so
//! a stolen one costs attribution until its binding is revoked and costs no vault
//! a key. The person key stays sealed behind the recovery phrase for exactly that
//! reason: an `NTV7` vault seals every owned vault's `root_key` to it, so a
//! keychain-held PERSON key would open every vault without a password.
//!
//! # The signature is double, and the two halves are independent
//!
//! Ed25519 over the payload, ML-DSA-65 over the payload, both required to verify.
//! Not a composite: a composite construction is EUF-CMA only, while two
//! independent signatures over the same message preserve SUF-CMA against a break
//! in either half. The message-class prefix is the caller's job and rides inside
//! `message` (`"myne.head-signature v2|"` for a head), so one class cannot be
//! replayed as another.
//!
//! # Verification must not say which half failed
//!
//! [`DevicePublicHalf::verify`] answers one error for both halves, for the reason
//! [`crate::person_key::PersonPublicHalf::verify`] states: a distinguishing
//! answer is a downgrade oracle for the weaker half.

use alloc::vec::Vec;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::error::ProtocolError;
use crate::hex::encode_lower;

/// Ed25519 secret seed length (the seed, not the expanded key).
pub const DEVICE_ED25519_SEED_LEN: usize = 32;
/// Ed25519 public key length.
pub const DEVICE_ED25519_PK_LEN: usize = 32;
/// Ed25519 signature length.
pub const DEVICE_ED25519_SIG_LEN: usize = 64;
/// ML-DSA-65 secret seed length.
pub const DEVICE_MLDSA_SEED_LEN: usize = 32;
/// ML-DSA-65 verifying key length (FIPS 204, `MlDsa65`).
pub const DEVICE_MLDSA_VK_LEN: usize = 1952;
/// ML-DSA-65 signature length (FIPS 204, `MlDsa65`).
pub const DEVICE_MLDSA_SIG_LEN: usize = 3309;

/// Total length of the at-rest plaintext of a device key: both private seeds plus
/// the Ed25519 public key.
///
/// The ML-DSA verifying key is PUBLIC and re-derivable from its seed, so it is
/// not stored: a decoder re-derives it and the reconstruction is checked by
/// signing nothing and comparing the derived halves, the way the person key's
/// plaintext works. Storing the seed pair is what keeps this blob small enough to
/// live in a keychain item or inside a `MYQ1` envelope.
pub const DEVICE_KEY_PLAINTEXT_LEN: usize =
    DEVICE_ED25519_SEED_LEN + DEVICE_ED25519_PK_LEN + DEVICE_MLDSA_SEED_LEN;

/// A device signing keypair.
///
/// Construction goes through [`DeviceKeyPair::generate_raw`] (deterministic,
/// vectors and tests) or [`DeviceKeyPair::generate`] (CSPRNG convenience). Every
/// private byte is zeroized on drop, and no secret byte ever reaches `Debug`.
#[derive(Clone, ZeroizeOnDrop)]
pub struct DeviceKeyPair {
    #[zeroize(skip)]
    ed25519_pk: [u8; DEVICE_ED25519_PK_LEN],
    #[zeroize(skip)]
    mldsa_vk: [u8; DEVICE_MLDSA_VK_LEN],
    ed25519_seed: [u8; DEVICE_ED25519_SEED_LEN],
    mldsa_seed: [u8; DEVICE_MLDSA_SEED_LEN],
}

impl core::fmt::Debug for DeviceKeyPair {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // The PUBLIC half is the only identifying value this type prints. A seed
        // in a log line is a signing key in a log line.
        f.debug_struct("DeviceKeyPair")
            .field("ed_pk_hex", &encode_lower(&self.ed25519_pk))
            .finish_non_exhaustive()
    }
}

/// The two signatures over one message, as they travel on the wire.
///
/// Held as raw Vecs rather than fixed arrays because the ML-DSA half is 3.3 kB
/// and every caller already frames it into a `Vec`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceSigned {
    /// Ed25519 signature over the class-prefixed message.
    pub ed25519_sig: [u8; DEVICE_ED25519_SIG_LEN],
    /// ML-DSA-65 signature over the same message, encoded (FIPS 204).
    pub mldsa_sig: Vec<u8>,
}

impl DeviceSigned {
    /// Total wire length of the pair: `ed || mldsa`.
    #[must_use]
    pub fn wire_len() -> usize {
        DEVICE_ED25519_SIG_LEN + DEVICE_MLDSA_SIG_LEN
    }
}

/// The device's public half: what a peer needs to verify that device's
/// signatures, and what its [`device binding row`](crate::device_binding_blob)
/// carries so a head signed by this device can be resolved (`0733` decision 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DevicePublicHalf {
    ed25519_pk: [u8; DEVICE_ED25519_PK_LEN],
    mldsa_vk: [u8; DEVICE_MLDSA_VK_LEN],
}

impl DeviceKeyPair {
    /// Deterministic generation from caller-supplied seeds (the `_raw`
    /// convention used by vectors and tests).
    ///
    /// # `_raw` contract
    ///
    /// Both inputs MUST come from a CSPRNG-grade source; low-entropy input is a
    /// caller-owned, security-fatal contract violation.
    #[must_use]
    pub fn generate_raw(
        ed25519_seed: &[u8; DEVICE_ED25519_SEED_LEN],
        mldsa_seed: &[u8; DEVICE_MLDSA_SEED_LEN],
    ) -> Self {
        use ml_dsa::signature::Keypair as _;
        let ed_signing = ed25519_dalek::SigningKey::from_bytes(ed25519_seed);
        let ed25519_pk = ed_signing.verifying_key().to_bytes();
        let mldsa_signing = ml_dsa::SigningKey::<ml_dsa::MlDsa65>::from_seed(&(*mldsa_seed).into());
        let mldsa_vk: [u8; DEVICE_MLDSA_VK_LEN] = mldsa_signing.verifying_key().encode().into();
        Self {
            ed25519_pk,
            mldsa_vk,
            ed25519_seed: *ed25519_seed,
            mldsa_seed: *mldsa_seed,
        }
    }

    /// CSPRNG convenience: a fresh pair from the OS entropy source.
    pub fn generate() -> Result<Self, ProtocolError> {
        let mut ed = Zeroizing::new([0u8; DEVICE_ED25519_SEED_LEN]);
        let mut ml = Zeroizing::new([0u8; DEVICE_MLDSA_SEED_LEN]);
        getrandom::getrandom(ed.as_mut_slice()).map_err(|_| ProtocolError::Csprng)?;
        getrandom::getrandom(ml.as_mut_slice()).map_err(|_| ProtocolError::Csprng)?;
        Ok(Self::generate_raw(&ed, &ml))
    }

    /// Sign `message`, which the CALLER has already prefixed with its
    /// message-class string.
    ///
    /// The empty ML-DSA context is deliberate: the class separation lives in the
    /// message bytes, so a second context string would be a second thing to keep
    /// in step.
    pub fn sign(
        &self,
        message: &[u8],
        rng: &mut (impl rand_core::CryptoRng + ?Sized),
    ) -> Result<DeviceSigned, DeviceKeyError> {
        use ed25519_dalek::Signer as _;
        let ed_signing = ed25519_dalek::SigningKey::from_bytes(&self.ed25519_seed);
        let ed25519_sig = ed_signing.sign(message).to_bytes();
        let mldsa_signing =
            ml_dsa::SigningKey::<ml_dsa::MlDsa65>::from_seed(&self.mldsa_seed.into());
        let mldsa_sig = mldsa_signing
            .expanded_key()
            .sign_randomized(message, &[], rng)
            .map_err(|_| DeviceKeyError::Csprng)?;
        Ok(DeviceSigned {
            ed25519_sig,
            mldsa_sig: mldsa_sig.encode().into(),
        })
    }

    /// The public half a peer verifies against.
    #[must_use]
    pub fn public_half(&self) -> DevicePublicHalf {
        DevicePublicHalf {
            ed25519_pk: self.ed25519_pk,
            mldsa_vk: self.mldsa_vk,
        }
    }

    /// The at-rest plaintext: `ed_seed || ed_pk || mldsa_seed`, fixed offsets.
    ///
    /// This is what a keychain item holds (or what a `MYQ1` envelope seals under
    /// a PIN). The ML-DSA verifying key is re-derived by
    /// [`Self::from_plaintext_bytes`] rather than stored, so a corrupted seed
    /// cannot smuggle a mismatched public half past a reader.
    #[must_use]
    pub fn to_plaintext_bytes(&self) -> [u8; DEVICE_KEY_PLAINTEXT_LEN] {
        let mut out = [0u8; DEVICE_KEY_PLAINTEXT_LEN];
        let mut off = 0;
        out[off..off + DEVICE_ED25519_SEED_LEN].copy_from_slice(&self.ed25519_seed);
        off += DEVICE_ED25519_SEED_LEN;
        out[off..off + DEVICE_ED25519_PK_LEN].copy_from_slice(&self.ed25519_pk);
        off += DEVICE_ED25519_PK_LEN;
        out[off..off + DEVICE_MLDSA_SEED_LEN].copy_from_slice(&self.mldsa_seed);
        out
    }

    /// Rebuild from the at-rest plaintext, RE-DERIVING the public halves and
    /// refusing a record whose stored Ed25519 public key disagrees with its seed.
    ///
    /// Fail-closed rather than trusting the stored byte: the plaintext lives in a
    /// keychain item and in a PIN-sealed file, and a tampered one must be a
    /// refusal rather than a device that signs under somebody else's public half.
    pub fn from_plaintext_bytes(
        bytes: &[u8; DEVICE_KEY_PLAINTEXT_LEN],
    ) -> Result<Self, DeviceKeyError> {
        let mut off = 0;
        let mut ed_seed = [0u8; DEVICE_ED25519_SEED_LEN];
        ed_seed.copy_from_slice(&bytes[off..off + DEVICE_ED25519_SEED_LEN]);
        off += DEVICE_ED25519_SEED_LEN;
        let mut stored_pk = [0u8; DEVICE_ED25519_PK_LEN];
        stored_pk.copy_from_slice(&bytes[off..off + DEVICE_ED25519_PK_LEN]);
        off += DEVICE_ED25519_PK_LEN;
        let mut ml_seed = [0u8; DEVICE_MLDSA_SEED_LEN];
        ml_seed.copy_from_slice(&bytes[off..off + DEVICE_MLDSA_SEED_LEN]);

        let pair = Self::generate_raw(&ed_seed, &ml_seed);
        ed_seed.zeroize();
        ml_seed.zeroize();
        if pair.ed25519_pk != stored_pk {
            return Err(DeviceKeyError::PlaintextMismatch);
        }
        Ok(pair)
    }
}

impl DevicePublicHalf {
    /// Rebuild from the two public halves as raw bytes (what a binding row
    /// carries).
    #[must_use]
    pub fn from_parts(
        ed25519_pk: &[u8; DEVICE_ED25519_PK_LEN],
        mldsa_vk: &[u8; DEVICE_MLDSA_VK_LEN],
    ) -> Self {
        Self {
            ed25519_pk: *ed25519_pk,
            mldsa_vk: *mldsa_vk,
        }
    }

    /// Rebuild from the two lowercase-hex spellings a binding row carries.
    ///
    /// Uppercase is REFUSED rather than normalized: a row travels as one
    /// spelling between devices, and the strict predicate is the crate's
    /// ([`crate::hex::is_lower_hex`]).
    pub fn from_parts_hex(ed_pk_hex: &str, mldsa_vk_hex: &str) -> Result<Self, DeviceKeyError> {
        // The crate's ONE lowercase decoder, not a second nibble walk: a binding row
        // travels between devices as one spelling, and `decode_lower` is the strict
        // half of `protocol::hex` (uppercase refused rather than normalized).
        let ed = crate::hex::decode_lower::<DEVICE_ED25519_PK_LEN>(ed_pk_hex)
            .ok_or(DeviceKeyError::MalformedHex)?;
        let vk = crate::hex::decode_lower::<DEVICE_MLDSA_VK_LEN>(mldsa_vk_hex)
            .ok_or(DeviceKeyError::MalformedHex)?;
        Ok(Self::from_parts(&ed, &vk))
    }

    /// The Ed25519 public key.
    #[must_use]
    pub fn ed_pk(&self) -> &[u8; DEVICE_ED25519_PK_LEN] {
        &self.ed25519_pk
    }

    /// The ML-DSA-65 verifying key.
    #[must_use]
    pub fn mldsa_vk(&self) -> &[u8; DEVICE_MLDSA_VK_LEN] {
        &self.mldsa_vk
    }

    /// Lowercase hex of the Ed25519 public key.
    #[must_use]
    pub fn ed_pk_hex(&self) -> alloc::string::String {
        encode_lower(&self.ed25519_pk)
    }

    /// Lowercase hex of the ML-DSA-65 verifying key.
    #[must_use]
    pub fn mldsa_vk_hex(&self) -> alloc::string::String {
        encode_lower(&self.mldsa_vk)
    }

    /// Verify BOTH halves. One error for either failure, by design.
    pub fn verify(&self, message: &[u8], signed: &DeviceSigned) -> Result<(), DeviceKeyError> {
        use ed25519_dalek::Verifier as _;
        let ed_ok = ed25519_dalek::VerifyingKey::from_bytes(&self.ed25519_pk)
            .map_err(|_| DeviceKeyError::SignatureVerify)?
            .verify(
                message,
                &ed25519_dalek::Signature::from_bytes(&signed.ed25519_sig),
            )
            .is_ok();
        let vk = ml_dsa::VerifyingKey::<ml_dsa::MlDsa65>::decode(
            &<[_; DEVICE_MLDSA_VK_LEN]>::try_from(self.mldsa_vk.as_slice())
                .expect("vk size fixed by FIPS 204")
                .into(),
        );
        let ml_ok = vk.verify_with_context(
            message,
            &[],
            &ml_dsa::Signature::<ml_dsa::MlDsa65>::try_from(signed.mldsa_sig.as_slice())
                .map_err(|_| DeviceKeyError::SignatureVerify)?,
        );
        if ed_ok && ml_ok {
            Ok(())
        } else {
            Err(DeviceKeyError::SignatureVerify)
        }
    }
}

/// Device-key failures. Deliberately as narrow as the person key's: one
/// non-distinguishing signature error, one malformed-input error, one
/// CSPRNG error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DeviceKeyError {
    /// A signature (Ed25519 or ML-DSA-65) failed verification. Non-distinguishing
    /// between the halves BY DESIGN (a distinguishing answer is a downgrade
    /// oracle for the weaker half).
    #[error("device signature verification failed")]
    SignatureVerify,

    /// A hex public half was not lowercase, or was the wrong length.
    #[error("device key hex is malformed")]
    MalformedHex,

    /// The at-rest plaintext's stored Ed25519 public key disagrees with the seed
    /// beside it, so the record was corrupted or tampered with.
    #[error("device key plaintext mismatch")]
    PlaintextMismatch,

    /// The OS CSPRNG failed.
    #[error("csprng failure")]
    Csprng,
}

impl From<DeviceKeyError> for ProtocolError {
    fn from(_: DeviceKeyError) -> Self {
        // Collapsed at the boundary for the same reason the person-key error is:
        // the command surface may not tell a caller which half or which byte
        // failed.
        ProtocolError::AeadFailure
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rng(u64);
    impl rand_core::TryRng for Rng {
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
            // Repeat the digest to fill a long buffer (ML-DSA's randomized sign
            // wants more entropy than one digest holds).
            for chunk in dst.chunks_mut(digest.len()) {
                chunk.copy_from_slice(&digest[..chunk.len()]);
            }
            let _ = n;
            Ok(())
        }
    }
    impl rand_core::TryCryptoRng for Rng {}

    fn pair(seed: u8) -> DeviceKeyPair {
        DeviceKeyPair::generate_raw(&[seed; 32], &[seed ^ 0xff; 32])
    }

    #[test]
    fn both_halves_verify_and_a_tampered_one_does_not() {
        let p = pair(7);
        let message = b"myne.head-signature v2|device-id|canonical";
        let signed = p.sign(message, &mut Rng(1)).expect("sign");
        p.public_half().verify(message, &signed).expect("verify");

        // Ed25519 half flipped: refused.
        let mut bad = signed.clone();
        bad.ed25519_sig[0] ^= 1;
        assert_eq!(
            p.public_half().verify(message, &bad),
            Err(DeviceKeyError::SignatureVerify)
        );

        // ML-DSA half truncated: refused, and with the SAME error.
        let mut bad = signed.clone();
        bad.mldsa_sig.pop();
        assert_eq!(
            p.public_half().verify(message, &bad),
            Err(DeviceKeyError::SignatureVerify)
        );

        // A different message (the class prefix is inside it): refused.
        assert_eq!(
            p.public_half()
                .verify(b"myne.head-signature v1|device-id|canonical", &signed),
            Err(DeviceKeyError::SignatureVerify)
        );
    }

    #[test]
    fn another_devices_public_half_does_not_verify_this_devices_signature() {
        let a = pair(1);
        let b = pair(2);
        let message = b"class|payload";
        let signed = a.sign(message, &mut Rng(3)).expect("sign");
        assert_eq!(
            b.public_half().verify(message, &signed),
            Err(DeviceKeyError::SignatureVerify),
            "a signature must verify only against the half that made it"
        );
    }

    #[test]
    fn the_plaintext_round_trips_and_a_swapped_public_half_is_refused() {
        let p = pair(9);
        let bytes = p.to_plaintext_bytes();
        let back = DeviceKeyPair::from_plaintext_bytes(&bytes).expect("round trip");
        assert_eq!(back.public_half(), p.public_half());

        // Swap the stored Ed25519 public key for another device's without touching
        // the seed: the record must be refused rather than trusted.
        let mut tampered = bytes;
        let other = *pair(10).public_half().ed_pk();
        tampered[DEVICE_ED25519_SEED_LEN..DEVICE_ED25519_SEED_LEN + DEVICE_ED25519_PK_LEN]
            .copy_from_slice(&other);
        assert!(matches!(
            DeviceKeyPair::from_plaintext_bytes(&tampered),
            Err(DeviceKeyError::PlaintextMismatch)
        ));
    }

    #[test]
    fn hex_public_halves_round_trip_and_refuse_uppercase_or_wrong_length() {
        let p = pair(4);
        let half = p.public_half();
        let rebuilt = DevicePublicHalf::from_parts_hex(&half.ed_pk_hex(), &half.mldsa_vk_hex())
            .expect("hex round trip");
        assert_eq!(rebuilt, half);

        assert_eq!(
            DevicePublicHalf::from_parts_hex(
                &half.ed_pk_hex().to_uppercase(),
                &half.mldsa_vk_hex()
            ),
            Err(DeviceKeyError::MalformedHex),
            "uppercase is refused rather than normalized"
        );
        assert_eq!(
            DevicePublicHalf::from_parts_hex("00", &half.mldsa_vk_hex()),
            Err(DeviceKeyError::MalformedHex)
        );
    }

    #[test]
    fn debug_prints_no_secret_byte() {
        let p = pair(0xab);
        let rendered = alloc::format!("{p:?}");
        assert!(rendered.contains(&p.public_half().ed_pk_hex()));
        // The seed is 0xab repeated; its hex spelling must not appear.
        assert!(!rendered.contains(&"ab".repeat(32)));
    }
}
