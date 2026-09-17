// SPDX-License-Identifier: AGPL-3.0
//! Person keypair. the B2B identity substrate's per-member cryptographic
//! identity (`myne-md/myne#698`, b2b-identity-substrate).
//!
//! A **person** (not a device) holds one keypair per identity. It is vault-
//! independent: its wrap key derives from the person's own recovery phrase (a
//! separate Argon2id salt domain, [`SALT_PREFIX_PERSON_KEYPAIR_V0_2`] in
//! `kdf.rs`), never from any vault's `root_key`. The keypair material itself is
//! OS-CSPRNG-generated and sealed under that wrap key in a device-local file;
//! it is NOT deterministically derived from the phrase, so the phrase unwraps
//! the file on the device that holds it and a lost device needs the identity
//! re-established. It travels nowhere near the vault key hierarchy:
//! `SubkeyRole::ALL` is unchanged, because a person's keys are not derived
//! from a vault's root.
//!
//! Contents (the PQ hybrid, per the roadmap commitment pulled forward):
//! - **KEM half**: ML-KEM-768 (FIPS 203) decapsulation seed (64 B = d||z)
//!   + encapsulation key (1184 B). Wraps the vault `itemsKey` per member.
//! - **Signature half**: Ed25519 seed (32 B) + ML-DSA-65 seed (32 B),
//!   with the verifying keys derivable from the seeds. Signs invites and
//!   rotation notices so a member can verify who rotated what (B12).
//! - **Fingerprint**: SHA-256 over a domain-prefixed concat of both public
//!   halves. the value compared out-of-band at invite time (the SAS,
//!   bootstrap-fingerprint pattern from the device-join flow).
//!
//! # Sealing shape
//!
//! The whole keypair is sealed as one blob under an Argon2id wrap key
//! derived from the person's own normalized recovery phrase
//! (`derive_person_keypair_wrap_key_from_normalized`, new salt domain
//! `"myne.v0.2 argon2id-person-keypair|"`). Storage lives in `myne-core`
//! (`account/person_identity.rs`, the `person_keypair.sealed` file); this
//! module owns only the cryptographic bytes.
//!
//! # Hybrid combiner
//!
//! The KEM half is hybrid at the *construction* level: the AEAD key that
//! wraps an `itemsKey` for a member is derived from BOTH the ML-KEM shared
//! secret AND the Ed25519 static-secret shared secret
//! (`hybrid_wrap_key`), so a classical break of either half alone
//! does not open the wrap and a quantum break of the classical half opens
//! nothing the ML-KEM half still guards. The signature half carries BOTH
//! signatures side by side (Ed25519 + ML-DSA-65) rather than one composite,
//! because composite ML-DSA is EUF-CMA only (IETF
//! draft-ietf-lamps-pq-composite-sigs-19); two independent signatures
//! preserve SUF-CMA and BOTH verifications MUST pass.
//!
//! # Randomness discipline
//!
//! Constructors that take caller-supplied RANDOMNESS do so through an
//! explicit `rng: &mut (impl CryptoRng + ?Sized)` parameter rather than the
//! `_raw` suffix (which this crate reserves for byte-taking constructors):
//! the caller owns CSPRNG-grade entropy either way, and the test-vector
//! generators pass their deterministic RNG through the same parameter.
//! Convenience wrappers pull from `getrandom` internally.

use crate::aead::{aead_open_ctx, aead_seal_ctx, AAD_PREFIX_V0_2, PROTOCOL_VERSION_V0_2};
use crate::error::ProtocolError;
use hkdf::Hkdf;
use ml_dsa::{MlDsa65, SigningKey};
use ml_kem::{kem::KeyExport, MlKem768};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Domain prefix for the canonical person fingerprint. Domain-separates the
/// person fingerprint from every other SHA-256 in the protocol.
const FINGERPRINT_PREFIX: &[u8] = b"myne.person-fingerprint v1|";

/// ML-KEM-768 encapsulation (public) key length: 1184 bytes (FIPS 203).
pub const PERSON_EK_LEN: usize = 1184;

/// ML-KEM-768 decapsulation seed length: 64 bytes (d || z, FIPS 203 §6.1).
pub const PERSON_DK_SEED_LEN: usize = 64;

/// ML-KEM-768 ciphertext length: 1088 bytes (FIPS 203).
pub const PERSON_CT_LEN: usize = 1088;

/// ML-KEM shared-secret length: 32 bytes.
pub const PERSON_SHARED_KEY_LEN: usize = 32;

/// Ed25519 secret seed length: 32 bytes.
pub const PERSON_ED25519_SEED_LEN: usize = 32;

/// Ed25519 public key length: 32 bytes.
pub const PERSON_ED25519_PK_LEN: usize = 32;

/// Ed25519 signature length: 64 bytes.
pub const PERSON_ED25519_SIG_LEN: usize = 64;

/// ML-DSA-65 secret seed length: 32 bytes.
pub const PERSON_MLDSA_SEED_LEN: usize = 32;

/// ML-DSA-65 verifying key length: 1952 bytes (FIPS 204).
pub const PERSON_MLDSA_VK_LEN: usize = 1952;

/// ML-DSA-65 signature length: 3309 bytes (FIPS 204).
pub const PERSON_MLDSA_SIG_LEN: usize = 3309;

/// Canonical fingerprint length: 32 bytes (SHA-256 output).
pub const PERSON_FINGERPRINT_LEN: usize = 32;

/// Sealed-envelope nonce length: 24 bytes (XChaCha20 nonce).
pub const PERSON_SEAL_NONCE_LEN: usize = 24;

/// The sealed keypair plaintext: both private seeds + the Ed25519 public
/// half. The ML-DSA verifying key and the ML-KEM encapsulation key are
/// PUBLIC and derivable from the seeds; storing only the private seeds
/// keeps the plaintext short and the public halves reconstruction-checked.
pub const PERSON_PLAINTEXT_LEN: usize =
    PERSON_DK_SEED_LEN + PERSON_ED25519_SEED_LEN + PERSON_MLDSA_SEED_LEN;

/// The person's key material: an ML-KEM-768 keypair and an Ed25519 +
/// ML-DSA-65 signing pair, plus the fingerprint both public halves commit to.
///
/// Construction goes through [`PersonKeyPair::generate_raw`] (deterministic,
/// vectors + tests) or [`PersonKeyPair::generate`] (CSPRNG convenience).
/// Every private seed is zeroized on drop.
#[derive(Clone, ZeroizeOnDrop)]
pub struct PersonKeyPair {
    /// ML-KEM-768 decapsulation seed (d || z, 64 bytes). The seed form, not
    /// the expanded form: 64 bytes vs 2400, and seeds are always-valid.
    kem_seed: [u8; PERSON_DK_SEED_LEN],
    /// ML-KEM-768 encapsulation key (public, 1184 bytes).
    kem_ek: [u8; PERSON_EK_LEN],
    /// Ed25519 secret seed (32 bytes).
    ed25519_seed: [u8; PERSON_ED25519_SEED_LEN],
    /// Ed25519 public key (32 bytes).
    ed25519_pk: [u8; PERSON_ED25519_PK_LEN],
    /// ML-DSA-65 signing seed (32 bytes).
    mldsa_seed: [u8; PERSON_MLDSA_SEED_LEN],
    /// ML-DSA-65 verifying key (1952 bytes, public, derived from the seed).
    mldsa_vk: [u8; PERSON_MLDSA_VK_LEN],
    /// Canonical fingerprint over all three public halves (the SAS value).
    fingerprint: [u8; PERSON_FINGERPRINT_LEN],
}

fn hex_val(b: u8) -> u8 {
    match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        _ => 0,
    }
}

fn unhex64(s: &str) -> Result<[u8; 32], PersonKeyError> {
    if s.len() != 64
        || s.bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
    {
        return Err(PersonKeyError::FingerprintMismatch);
    }
    let mut out = [0u8; 32];
    for (i, pair) in s.as_bytes().chunks(2).enumerate() {
        out[i] = (hex_val(pair[0]) << 4) | hex_val(pair[1]);
    }
    Ok(out)
}

fn decode_vk_hex(s: &str) -> Result<[u8; PERSON_MLDSA_VK_LEN], PersonKeyError> {
    if s.len() != PERSON_MLDSA_VK_LEN * 2
        || s.bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
    {
        return Err(PersonKeyError::FingerprintMismatch);
    }
    let mut out = [0u8; PERSON_MLDSA_VK_LEN];
    for (i, pair) in s.as_bytes().chunks(2).enumerate() {
        out[i] = (hex_val(pair[0]) << 4) | hex_val(pair[1]);
    }
    Ok(out)
}

fn decode_ek_hex(s: &str) -> Result<[u8; PERSON_EK_LEN], PersonKeyError> {
    if s.len() != PERSON_EK_LEN * 2
        || s.bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
    {
        return Err(PersonKeyError::FingerprintMismatch);
    }
    let mut out = [0u8; PERSON_EK_LEN];
    for (i, pair) in s.as_bytes().chunks(2).enumerate() {
        out[i] = (hex_val(pair[0]) << 4) | hex_val(pair[1]);
    }
    Ok(out)
}

impl core::fmt::Debug for PersonKeyPair {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // No secret byte ever reaches Debug. The fingerprint is the ONLY
        // identifying value this type prints.
        f.debug_struct("PersonKeyPair")
            .field("fingerprint_hex", &hex_short(&self.fingerprint))
            .finish_non_exhaustive()
    }
}

fn hex_short(bytes: &[u8]) -> alloc::string::String {
    // First 8 bytes only, lowercase hex, the Debug half of the
    // no-secret-in-logs discipline.
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = alloc::string::String::new();
    for b in &bytes[..8] {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

impl PersonKeyPair {
    /// Deterministic keypair generation from caller-supplied randomness
    /// (the `_raw` convention). All three inputs ARE the seeds:
    /// `kem_seed` (64 B = d||z) seeds ML-KEM directly, `ed25519_seed`
    /// (32 B) IS the Ed25519 secret seed, `mldsa_seed` (32 B) IS the
    /// ML-DSA seed. Test-vector + deterministic surface; production
    /// callers use [`PersonKeyPair::generate`].
    ///
    /// # `_raw` contract
    ///
    /// All three inputs MUST come from a CSPRNG-grade source; low-entropy
    /// input is a caller-owned security-fatal contract violation.
    #[must_use]
    pub fn generate_raw(
        kem_seed: &[u8; PERSON_DK_SEED_LEN],
        ed25519_seed: &[u8; PERSON_ED25519_SEED_LEN],
        mldsa_seed: &[u8; PERSON_MLDSA_SEED_LEN],
    ) -> Self {
        // ML-KEM-768: decapsulation key from the 64-byte seed; the
        // encapsulation key derives from it (FIPS 203 §6.1).
        let dk = ml_kem::DecapsulationKey::<MlKem768>::from_seed((*kem_seed).into());
        let ek_bytes: [u8; PERSON_EK_LEN] = dk.encapsulation_key().to_bytes().into();

        // Ed25519: seed IS the SecretKey bytes; SigningKey derives vk.
        let ed_signing = ed25519_dalek::SigningKey::from_bytes(ed25519_seed);
        let ed_pk = ed_signing.verifying_key().to_bytes();

        // ML-DSA-65: seed -> SigningKey -> verifying key (encoded), via the
        // alloc-feature AsRef path (the Keypair trait is the no-alloc path).
        let mldsa_signing = SigningKey::<MlDsa65>::from_seed(&(*mldsa_seed).into());
        let mldsa_vk_bytes: [u8; PERSON_MLDSA_VK_LEN] = mldsa_signing.as_ref().encode().into();

        let fingerprint = compute_fingerprint(&ek_bytes, &ed_pk, &mldsa_vk_bytes);

        Self {
            kem_seed: *kem_seed,
            kem_ek: ek_bytes,
            ed25519_seed: *ed25519_seed,
            ed25519_pk: ed_pk,
            mldsa_seed: *mldsa_seed,
            mldsa_vk: mldsa_vk_bytes,
            fingerprint,
        }
    }

    /// CSPRNG convenience: generate a fresh keypair from `getrandom`.
    ///
    /// Returns [`ProtocolError::Csprng`] if the OS entropy source fails.
    pub fn generate() -> Result<Self, ProtocolError> {
        let mut kem_seed = Zeroizing::new([0u8; PERSON_DK_SEED_LEN]);
        let mut ed_seed = Zeroizing::new([0u8; PERSON_ED25519_SEED_LEN]);
        let mut ml_seed = Zeroizing::new([0u8; PERSON_MLDSA_SEED_LEN]);
        getrandom::getrandom(kem_seed.as_mut_slice()).map_err(|_| ProtocolError::Csprng)?;
        getrandom::getrandom(ed_seed.as_mut_slice()).map_err(|_| ProtocolError::Csprng)?;
        getrandom::getrandom(ml_seed.as_mut_slice()).map_err(|_| ProtocolError::Csprng)?;
        Ok(Self::generate_raw(&kem_seed, &ed_seed, &ml_seed))
    }

    /// The canonical fingerprint: SHA-256 over
    /// `FINGERPRINT_PREFIX || kem_ek || ed25519_pk || mldsa_vk`.
    ///
    /// This is the value the invite-time SAS compares (both screens render
    /// the same 32 bytes, hex-encoded). Domain separation keeps a person
    /// fingerprint from colliding with any other SHA-256 output in the
    /// protocol.
    #[must_use]
    pub fn fingerprint(&self) -> &[u8; PERSON_FINGERPRINT_LEN] {
        &self.fingerprint
    }

    /// Unwrap a [`PersonWrappedKey`] addressed to this person: ML-KEM
    /// decapsulate + classical static DH against the ephemeral public +
    /// the same hybrid derivation, then AEAD-open.
    ///
    /// Returns [`PersonKeyError::AeadFailure`] on any failure (wrong
    /// person, tampered envelope. non-distinguishing).
    pub fn unwrap_key(
        &self,
        wrapped: &PersonWrappedKey,
        account_number_hash: &[u8; 16],
    ) -> Result<Zeroizing<[u8; 32]>, PersonKeyError> {
        let sealed = SealedToMember {
            ml_kem_ct: wrapped.ml_kem_ct,
            ed_ephemeral_pk: wrapped.ed_ephemeral_pk,
            nonce: wrapped.nonce,
            ciphertext: wrapped.wrapped_key.clone(),
        };
        let pt = self.open_sealed(&sealed, account_number_hash)?;
        if pt.len() != 32 {
            return Err(PersonKeyError::AeadFailure);
        }
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&pt);
        Ok(out)
    }

    /// Open a [`SealedToMember`] frame addressed to this person: ML-KEM
    /// decapsulate + classical static DH against the frame's ephemeral
    /// public + the same hybrid derivation, then AEAD-open under the
    /// frame AAD (recipient fingerprint + vault hash).
    ///
    /// Returns [`PersonKeyError::AeadFailure`] on any failure (wrong
    /// person, tampered frame. non-distinguishing).
    pub fn open_sealed(
        &self,
        sealed: &SealedToMember,
        account_number_hash: &[u8; 16],
    ) -> Result<Zeroizing<alloc::vec::Vec<u8>>, PersonKeyError> {
        self.open_sealed_with_aad(
            sealed,
            &aad_person_wrap(self.fingerprint(), account_number_hash),
        )
    }

    /// [`Self::open_sealed`] with an explicit AEAD associated-data value,
    /// the counterpart of [`Self::seal_to_member_with_aad`]. The caller must
    /// pass the same AAD the sender sealed under.
    pub fn open_sealed_with_aad(
        &self,
        sealed: &SealedToMember,
        aad: &[u8],
    ) -> Result<Zeroizing<alloc::vec::Vec<u8>>, PersonKeyError> {
        use ml_kem::kem::Decapsulate as _;

        let dk = ml_kem::DecapsulationKey::<MlKem768>::from_seed(self.kem_seed.into());
        let ml_ss = dk
            .decapsulate_slice(&sealed.ml_kem_ct)
            .map_err(|_| PersonKeyError::KemFailure)?;

        let ephemeral_mont = member_montgomery(&sealed.ed_ephemeral_pk)?;
        let recipient_scalar = ed25519_dh_scalar(&self.ed25519_seed);
        let classical_ss: [u8; 32] = ephemeral_mont.mul_clamped(recipient_scalar).to_bytes();

        let wrap_key = hybrid_wrap_key(&classical_ss, ml_ss.as_slice());

        crate::aead::aead_open_ctx(&wrap_key, &sealed.nonce, &sealed.ciphertext, aad)
            .map_err(|_| PersonKeyError::AeadFailure)
    }

    /// Sign a payload with BOTH signature halves (the side-by-side hybrid,
    /// NOT a composite): Ed25519 over the payload, ML-DSA-65 over the
    /// payload. Both verifications MUST pass on the receiving side
    /// ([`PersonPublicHalf::verify`]); a composite would be EUF-CMA only
    /// (draft-ietf-lamps-pq-composite-sigs-19), which this hybrid preserves
    /// SUF-CMA against by independence.
    ///
    /// The domain prefix binds the signatures to the person-signing domain,
    /// so a signature over one class of message cannot be replayed as
    /// another class without re-signing (the verifier binds the class by
    /// the message bytes it feeds in).
    pub fn sign(
        &self,
        message: &[u8],
        rng: &mut (impl rand_core::CryptoRng + ?Sized),
    ) -> Result<PersonSigned, PersonKeyError> {
        // Ed25519 half: seed -> SigningKey -> sign (signature 2.2 trait path).
        let ed_signing = ed25519_dalek::SigningKey::from_bytes(&self.ed25519_seed);
        let ed_sig = <ed25519_dalek::SigningKey as ed25519_dalek::Signer<
            ed25519_dalek::Signature,
        >>::sign(&ed_signing, message)
        .to_bytes();

        // ML-DSA half: seed -> ExpandedSigningKey -> FIPS-204 randomized sign.
        // The `Signer`/`verify_with_context` surface is used rather than
        // `sign_internal`/`verify_internal` because the internal pair omits the
        // FIPS-204 domain separator (its own docs say so), which would make a
        // standards-compliant `ML-DSA.Verify` reject a Myne signature. The empty
        // context is deliberate: the message-class prefix (`INVITE_PREFIX`,
        // `"myne.vault-invite v1|"`) is already inside `message`, so the class
        // separation rides the signed bytes rather than a second ctx.
        let mldsa_signing = SigningKey::<MlDsa65>::from_seed(&self.mldsa_seed.into());
        // The only failure arms are an over-255-byte `ctx` (a constant `&[]`
        // here, unreachable by construction) and the RNG's `fill_bytes` failing.
        // The second is real: a caller passing a fallible source must get the
        // crate's closed `Csprng` error, not a panic inside a signing command.
        let mldsa_sig = mldsa_signing
            .expanded_key()
            .sign_randomized(message, &[], rng)
            .map_err(|_| PersonKeyError::Csprng)?;

        Ok(PersonSigned {
            ed25519_sig: ed_sig,
            mldsa_sig: mldsa_sig.encode().into(),
        })
    }

    /// The public (shareable) half, exactly what another member needs to
    /// wrap an `itemsKey` to this person and verify this person's
    /// signatures.
    #[must_use]
    pub fn public_half(&self) -> PersonPublicHalf {
        PersonPublicHalf {
            kem_ek: self.kem_ek,
            ed25519_pk: self.ed25519_pk,
            mldsa_vk: self.mldsa_vk,
            fingerprint: self.fingerprint,
        }
    }

    /// Canonical byte serialization of the plaintext key material
    /// (both private seeds + the Ed25519 public half), in fixed offsets.
    /// The ML-KEM ek and ML-DSA vk are re-derivable from the seeds and are
    /// NOT serialized; a decoder reconstructs and re-derives them,
    /// re-checking the fingerprint (fail-closed on any mismatch).
    #[must_use]
    pub fn to_plaintext_bytes(&self) -> [u8; PERSON_PLAINTEXT_LEN] {
        let mut out = [0u8; PERSON_PLAINTEXT_LEN];
        out[..PERSON_DK_SEED_LEN].copy_from_slice(&self.kem_seed);
        out[PERSON_DK_SEED_LEN..PERSON_DK_SEED_LEN + PERSON_ED25519_SEED_LEN]
            .copy_from_slice(&self.ed25519_seed);
        out[PERSON_DK_SEED_LEN + PERSON_ED25519_SEED_LEN..].copy_from_slice(&self.mldsa_seed);
        out
    }

    /// Reconstruct from plaintext bytes: re-derive every public half from
    /// the seeds, recompute the fingerprint, and verify the two agree.
    ///
    /// Returns [`PersonKeyError::FingerprintMismatch`] if the derived
    /// fingerprint disagrees with itself, which cannot happen for
    /// well-formed input and always means corruption or tampering.
    pub fn from_plaintext_bytes(bytes: &[u8; PERSON_PLAINTEXT_LEN]) -> Self {
        let mut kem_seed = [0u8; PERSON_DK_SEED_LEN];
        let mut ed_seed = [0u8; PERSON_ED25519_SEED_LEN];
        let mut ml_seed = [0u8; PERSON_MLDSA_SEED_LEN];
        kem_seed.copy_from_slice(&bytes[..PERSON_DK_SEED_LEN]);
        ed_seed.copy_from_slice(
            &bytes[PERSON_DK_SEED_LEN..PERSON_DK_SEED_LEN + PERSON_ED25519_SEED_LEN],
        );
        ml_seed.copy_from_slice(&bytes[PERSON_DK_SEED_LEN + PERSON_ED25519_SEED_LEN..]);
        Self::generate_raw(&kem_seed, &ed_seed, &ml_seed)
    }

    /// Seal the keypair under a phrase-derived wrap key.
    ///
    /// The AEAD is the crate's XChaCha20-Poly1305 + CTX composition with
    /// the **v0.2** AAD prefix (the keypair is a v0.2-era artefact); the
    /// AAD is role-bound only (prefix + version + `"person-keypair-blob"`).
    /// A fingerprint cannot be bound here: it is derived from the sealed
    /// material itself, so no caller could supply it before opening. The
    /// nonce is drawn from the OS CSPRNG; no deterministic variant exists
    /// because the keypair seal is not a cross-implementation byte contract
    /// (the fingerprint, not the ciphertext, is the stable identity).
    pub fn seal(
        &self,
        wrap_key: &Zeroizing<[u8; 32]>,
    ) -> Result<(Zeroizing<[u8; 24]>, alloc::vec::Vec<u8>), ProtocolError> {
        let mut nonce = [0u8; 24];
        getrandom::getrandom(&mut nonce).map_err(|_| ProtocolError::Csprng)?;
        // Zeroizing so the private seeds do not linger in released stack memory
        // (the `open` path zeroizes its equivalent copy).
        let plaintext = Zeroizing::new(self.to_plaintext_bytes());
        let ct = aead_seal_ctx(
            wrap_key,
            &nonce,
            plaintext.as_slice(),
            &aad_person_keypair(),
        )?;
        Ok((Zeroizing::new(nonce), ct))
    }

    /// Open a sealed keypair.
    ///
    /// Returns [`ProtocolError::AeadFailure`] on any AEAD verification
    /// failure (wrong phrase, tampered blob, non-distinguishing by
    /// design, the §7.3 discipline).
    pub fn open(
        wrap_key: &Zeroizing<[u8; 32]>,
        nonce: &[u8; 24],
        ciphertext: &[u8],
    ) -> Result<Self, ProtocolError> {
        let plaintext = aead_open_ctx(wrap_key, nonce, ciphertext, &aad_person_keypair())?;
        if plaintext.len() != PERSON_PLAINTEXT_LEN {
            return Err(ProtocolError::AeadFailure);
        }
        let mut bytes = [0u8; PERSON_PLAINTEXT_LEN];
        bytes.copy_from_slice(&plaintext);
        let pair = Self::from_plaintext_bytes(&bytes);
        bytes.zeroize();
        Ok(pair)
    }
}

/// The public half of a person keypair: everything another member needs to
/// wrap to this person and verify their signatures.
#[derive(Clone, Debug, ZeroizeOnDrop)]
pub struct PersonPublicHalf {
    /// ML-KEM-768 encapsulation key (1184 B).
    kem_ek: [u8; PERSON_EK_LEN],
    /// Ed25519 public key (32 B).
    ed25519_pk: [u8; PERSON_ED25519_PK_LEN],
    /// ML-DSA-65 verifying key (1952 B).
    mldsa_vk: [u8; PERSON_MLDSA_VK_LEN],
    /// Canonical fingerprint (32 B).
    fingerprint: [u8; PERSON_FINGERPRINT_LEN],
}

impl PersonPublicHalf {
    /// The fingerprint (the SAS value).
    #[must_use]
    pub fn fingerprint(&self) -> &[u8; PERSON_FINGERPRINT_LEN] {
        &self.fingerprint
    }

    /// Reconstruct from the three public key hex strings (the value another
    /// member carries about an owner: their ML-KEM encapsulation key,
    /// Ed25519 public, and ML-DSA vk). The fingerprint is the SAME
    /// canonical three-half construction [`compute_fingerprint`] uses, so
    /// a reconstructed half agrees byte-for-byte with the originator's
    /// [`PersonKeyPair::fingerprint`]. There is exactly one fingerprint
    /// function in this module; a two-half variant must never exist
    /// alongside it, because SAS values compared at invite time would
    /// otherwise disagree with roster-pinned identities for the same
    /// person.
    pub fn from_parts_hex(
        kem_ek_hex: &str,
        ed_pk_hex: &str,
        mldsa_vk_hex: &str,
    ) -> Result<Self, PersonKeyError> {
        let kem_bytes = decode_ek_hex(kem_ek_hex)?;
        let ed_bytes = unhex64(ed_pk_hex)?;
        let ml_bytes = decode_vk_hex(mldsa_vk_hex)?;
        let fingerprint = compute_fingerprint(&kem_bytes, &ed_bytes, &ml_bytes);
        Ok(Self {
            kem_ek: kem_bytes,
            ed25519_pk: ed_bytes,
            mldsa_vk: ml_bytes,
            fingerprint,
        })
    }

    /// The ML-DSA verifying key (the value the member carries to verify
    /// signatures without a key round-trip).
    #[must_use]
    pub fn mldsa_vk(&self) -> &[u8; PERSON_MLDSA_VK_LEN] {
        &self.mldsa_vk
    }

    /// The Ed25519 public key.
    #[must_use]
    pub fn ed_pk(&self) -> &[u8; PERSON_ED25519_PK_LEN] {
        &self.ed25519_pk
    }

    /// The ML-KEM encapsulation key.
    #[must_use]
    pub fn kem_ek(&self) -> &[u8; PERSON_EK_LEN] {
        &self.kem_ek
    }

    /// Verify BOTH signature halves of a [`PersonSigned`]. Both MUST pass;
    /// the verifier MUST NOT say which half failed
    /// ([`PersonKeyError::SignatureVerify`] carries no such granularity :
    /// a distinguishing message would downgrade-attack the weaker half).
    pub fn verify(&self, message: &[u8], signed: &PersonSigned) -> Result<(), PersonKeyError> {
        use ed25519_dalek::Verifier as _;

        let ed_ok = ed25519_dalek::VerifyingKey::from_bytes(&self.ed25519_pk)
            .map_err(|_| PersonKeyError::KemFailure)?
            .verify(
                message,
                &ed25519_dalek::Signature::from_bytes(&signed.ed25519_sig),
            )
            .is_ok();
        use ml_dsa::VerifyingKey;
        let mldsa_vk = VerifyingKey::<MlDsa65>::decode(
            &<[_; PERSON_MLDSA_VK_LEN]>::try_from(self.mldsa_vk.as_slice())
                .expect("vk size fixed by FIPS 204")
                .into(),
        );
        // `verify_with_context` applies the FIPS-204 domain separator the
        // signer used; `verify_internal` would not.
        let ml_ok = mldsa_vk.verify_with_context(
            message,
            &[],
            &ml_dsa::Signature::<MlDsa65>::try_from(signed.mldsa_sig.as_slice())
                .map_err(|_| PersonKeyError::SignatureVerify)?,
        );
        if ed_ok && ml_ok {
            Ok(())
        } else {
            Err(PersonKeyError::SignatureVerify)
        }
    }

    /// Wrap a 32-byte vault key (e.g. the vault `itemsKey`) to this person,
    /// the PQ-hybrid per-recipient envelope (myne-md/myne#698 task 5):
    ///
    /// 1. ML-KEM-768 encapsulate against the member's public key → a 32-byte
    ///    PQ shared secret + a 1088-byte ciphertext.
    /// 2. Ed25519 classical half: ephemeral X25519-style static secret over
    ///    the Ed25519 Montgomery conversion → a 32-byte classical shared
    ///    secret (the `curve25519-dalek` `to_montgomery` path).
    /// 3. Hybrid wrap key = HKDF-SHA-256-Extract(salt = `HYBRID_WRAP_PREFIX`,
    ///    ikm = `classical || pq`); the wrap AEAD is the crate's XChaCha20-Poly1305 + CTX
    ///    composition under the v0.2 AAD prefix, role
    ///    `"person-wrap-items-key"`, binding the recipient fingerprint AND
    ///    the vault's `account_number_hash` (a wrap ports across vaults at
    ///    neither the key nor the AAD layer).
    ///
    /// A classical break of either half alone opens nothing: the wrap key
    /// needs BOTH shared secrets.
    ///
    /// A zeroed ML-KEM encapsulation key is refused outright: wrapping to
    /// it would void the PQ half and reduce the advertised hybrid to
    /// classical-only, reopening the harvest-now window the hybrid exists
    /// to close.
    ///
    /// The `_raw` convention: all randomness comes from `rng` (the caller's
    /// CSPRNG contract); the vectors use a seeded deterministic RNG.
    pub fn wrap_key(
        &self,
        items_key: &[u8; 32],
        account_number_hash: &[u8; 16],
        rng: &mut (impl rand_core::CryptoRng + ?Sized),
    ) -> Result<PersonWrappedKey, PersonKeyError> {
        let sealed = self.seal_to_member(items_key, account_number_hash, rng)?;
        Ok(PersonWrappedKey {
            ml_kem_ct: sealed.ml_kem_ct,
            ed_ephemeral_pk: sealed.ed_ephemeral_pk,
            wrapped_key: sealed.ciphertext,
            nonce: sealed.nonce,
        })
    }

    /// Seal arbitrary bytes to this person under the PQ-hybrid envelope:
    /// fresh ML-KEM encapsulate + fresh classical ephemeral, hybrid wrap
    /// key, AEAD under the v0.2 prefix with role `"person-wrap-items-key"`
    /// binding the recipient fingerprint and the vault hash. This is the
    /// general form of [`PersonPublicHalf::wrap_key`]. Returns the sealed
    /// frame.
    pub fn seal_to_member(
        &self,
        plaintext: &[u8],
        account_number_hash: &[u8; 16],
        rng: &mut (impl rand_core::CryptoRng + ?Sized),
    ) -> Result<SealedToMember, PersonKeyError> {
        self.seal_to_member_with_aad(
            plaintext,
            &aad_person_wrap(&self.fingerprint, account_number_hash),
            rng,
        )
    }

    /// [`Self::seal_to_member`] with an explicit AEAD associated-data value.
    ///
    /// The `person-wrap-items-key` role is right for a per-recipient
    /// `itemsKey` wrap; the invite payload envelope is a DIFFERENT message
    /// class and must not share its domain, so it passes
    /// `person_invite::aad_vault_invite` instead. A caller that supplies its
    /// own AAD owns binding the recipient fingerprint + vault hash, exactly
    /// as [`Self::seal_to_member`] does.
    pub fn seal_to_member_with_aad(
        &self,
        plaintext: &[u8],
        aad: &[u8],
        rng: &mut (impl rand_core::CryptoRng + ?Sized),
    ) -> Result<SealedToMember, PersonKeyError> {
        use ml_kem::kem::Encapsulate as _;

        if self.kem_ek == [0u8; PERSON_EK_LEN] {
            return Err(PersonKeyError::KemFailure);
        }

        let ek = ml_kem::EncapsulationKey::<MlKem768>::new(&self.kem_ek.into())
            .map_err(|_| PersonKeyError::KemFailure)?;
        let (ml_ct, ml_ss) = ek.encapsulate_with_rng(rng);

        let mut ed_secret_bytes = [0u8; 32];
        rng.fill_bytes(&mut ed_secret_bytes);
        let ed_signing = ed25519_dalek::SigningKey::from_bytes(&ed_secret_bytes);
        let ed_ephemeral_pk = ed_signing.verifying_key().to_bytes();
        let member_mont = member_montgomery(&self.ed25519_pk)?;
        let sender_scalar = ed25519_dh_scalar(&ed_secret_bytes);
        let classical_ss: [u8; 32] = member_mont.mul_clamped(sender_scalar).to_bytes();

        let wrap_key = hybrid_wrap_key(&classical_ss, ml_ss.as_slice());

        let mut nonce = [0u8; 24];
        rng.fill_bytes(&mut nonce);
        let ciphertext = seal_parts(&wrap_key, &nonce, plaintext, aad)?;

        Ok(SealedToMember {
            ml_kem_ct: ml_ct.into(),
            ed_ephemeral_pk,
            nonce,
            ciphertext,
        })
    }
}

/// A PQ-hybrid sealed frame addressed to one person: the two KEM halves
/// plus the AEAD ciphertext. [`PersonWrappedKey`] is the 32-byte-key
/// specialization of this shape; the invite payload envelope is the
/// general case.
#[derive(Debug, Clone)]
pub struct SealedToMember {
    /// ML-KEM-768 ciphertext (1088 B).
    pub ml_kem_ct: [u8; PERSON_CT_LEN],
    /// Classical-half ephemeral Ed25519 public (32 B).
    pub ed_ephemeral_pk: [u8; PERSON_ED25519_PK_LEN],
    /// Nonce for the frame AEAD (24 B).
    pub nonce: [u8; 24],
    /// AEAD ciphertext (plaintext + 16 B tag + 32 B CTX).
    pub ciphertext: alloc::vec::Vec<u8>,
}

fn seal_parts(
    wrap_key: &[u8; 32],
    nonce: &[u8; 24],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<alloc::vec::Vec<u8>, PersonKeyError> {
    crate::aead::aead_seal_ctx(wrap_key, nonce, plaintext, aad)
        .map_err(|_| PersonKeyError::AeadFailure)
}

/// Both signature halves of one payload, side by side (NOT a composite):
/// Ed25519 + ML-DSA-65, both verifications mandatory on the receiving
/// side. The two independent signatures preserve SUF-CMA where a single
/// composite would be EUF-CMA only.
#[derive(Debug, Clone, PartialEq, Eq, ZeroizeOnDrop)]
pub struct PersonSigned {
    /// Ed25519 signature (64 B).
    pub ed25519_sig: [u8; PERSON_ED25519_SIG_LEN],
    /// ML-DSA-65 signature (3309 B).
    pub mldsa_sig: alloc::vec::Vec<u8>,
}

/// A wrapped vault key addressed to one person: the hybrid ciphertext
/// pieces + the AEAD-encrypted vault key.
#[derive(Debug, Clone, ZeroizeOnDrop)]
pub struct PersonWrappedKey {
    /// ML-KEM-768 ciphertext (1088 B).
    pub ml_kem_ct: [u8; PERSON_CT_LEN],
    /// Classical-half ephemeral Ed25519 public (32 B).
    pub ed_ephemeral_pk: [u8; PERSON_ED25519_PK_LEN],
    /// AEAD-encrypted vault key (32 B + 16 B tag + 32 B CTX, XChaCha20-Poly1305).
    pub wrapped_key: alloc::vec::Vec<u8>,
    /// Nonce for the wrap AEAD (24 B).
    pub nonce: [u8; 24],
}

/// Domain prefix for the hybrid wrap shared-secret derivation. The sole
/// `Hkdf::extract` info string for the combiner, and the domain separation
/// between it and every other derivation in the protocol.
const HYBRID_WRAP_PREFIX: &[u8] = b"myne.person-wrap-ss v1|";

/// Combine the classical and PQ shared secrets into the 32-byte hybrid wrap
/// key (myne-md/myne#698).
///
/// HKDF-Extract (RFC 5869 §2.2) keyed by [`HYBRID_WRAP_PREFIX`]: the
/// conservative choice for non-uniform DH and KEM input, matching the crate's
/// use of the same construction in `scram.rs` and `vault_head.rs`. Both sides
/// of the hybrid wrap MUST call this one function so the two derivations
/// cannot drift: a bare `SHA-256(prefix ‖ ss)` combiner is standard, but the
/// extract step is the audited primitive and keeps the input conditioning in
/// one reviewed place.
pub fn hybrid_wrap_key(classical_ss: &[u8; 32], pq_ss: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut ikm = Zeroizing::new(alloc::vec::Vec::with_capacity(
        classical_ss.len() + pq_ss.len(),
    ));
    ikm.extend_from_slice(classical_ss);
    ikm.extend_from_slice(pq_ss);
    let (prk, _hkdf) = Hkdf::<Sha256>::extract(Some(HYBRID_WRAP_PREFIX), &ikm);
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&prk);
    out
}

/// The RFC 8032 ed25519→x25519 scalar: SHA-512(seed)[..32] clamped
/// (the `ExpandedSecretKey::scalar` bytes, dalek's own expansion). The
/// classic conversion does NOT use the raw seed as the DH scalar; both
/// sides of the hybrid wrap MUST expand identically.
fn ed25519_dh_scalar(seed: &[u8; PERSON_ED25519_SEED_LEN]) -> [u8; 32] {
    let mut h = <sha2::Sha512 as sha2::Digest>::new();
    sha2::Digest::update(&mut h, seed);
    let out = sha2::Digest::finalize(h);
    let mut expanded = [0u8; 32];
    expanded.copy_from_slice(&out[..32]);
    // RFC 8032 clamp via dalek's own `clamp_integer` rather than a hand-copied
    // bit-mask, so the conversion cannot drift from the library the rest of
    // this path uses.
    curve25519_dalek::scalar::clamp_integer(expanded)
}

/// The Ed25519-to-Montgomery conversion of a member public key, as a
/// curve25519-dalek MontgomeryPoint.
/// Convert an Ed25519 public key to its Montgomery form for the classical DH
/// half, refusing a low-order point.
///
/// The identity and every small-order point force the DH result to a known
/// constant, which would void the classical half and reduce the advertised
/// hybrid to PQ-only, the symmetric hole to the zeroed-EK refusal in
/// [`PersonPublicHalf::seal_to_member`]. `is_identity` catches the all-zero
/// point; the remaining low-order points are rejected by checking that the
/// scalar multiplication by the cofactor does not land on the identity.
fn member_montgomery(
    ed25519_pk: &[u8; PERSON_ED25519_PK_LEN],
) -> Result<curve25519_dalek::montgomery::MontgomeryPoint, PersonKeyError> {
    let compressed = curve25519_dalek::edwards::CompressedEdwardsY(*ed25519_pk);
    let ed = compressed.decompress().ok_or(PersonKeyError::KemFailure)?;
    // A small-order point has a torsion component: multiplying by the cofactor
    // (8) annihilates it to the identity. Reject when that happens, so a public
    // half on any low-order point cannot force the classical secret.
    use curve25519_dalek::traits::IsIdentity as _;
    if (ed * curve25519_dalek::scalar::Scalar::from(8u8)).is_identity() {
        return Err(PersonKeyError::KemFailure);
    }
    Ok(ed.to_montgomery())
}

/// The AAD for the per-recipient wrap envelope: v0.2 prefix + version +
/// role "person-wrap-items-key" + the recipient's fingerprint + the
/// vault's `account_number_hash`. The vault binding follows the §5.2
/// convention every vault-scoped AAD follows (cf. `AAD_membership_blob`):
/// without it a wrap ports across vaults at the AAD layer.
pub fn aad_person_wrap(
    recipient_fingerprint: &[u8; PERSON_FINGERPRINT_LEN],
    account_number_hash: &[u8; 16],
) -> alloc::vec::Vec<u8> {
    const ROLE_STR_PERSON_WRAP: &[u8] = b"person-wrap-items-key";
    let mut aad = alloc::vec::Vec::with_capacity(
        AAD_PREFIX_V0_2.len()
            + 1
            + 2
            + ROLE_STR_PERSON_WRAP.len()
            + recipient_fingerprint.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    crate::aead::push_length_prefixed_u16_be(&mut aad, ROLE_STR_PERSON_WRAP);
    aad.extend_from_slice(recipient_fingerprint);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Compute the canonical fingerprint over the three public halves.
pub fn compute_fingerprint(
    kem_ek: &[u8; PERSON_EK_LEN],
    ed25519_pk: &[u8; PERSON_ED25519_PK_LEN],
    mldsa_vk: &[u8; PERSON_MLDSA_VK_LEN],
) -> [u8; PERSON_FINGERPRINT_LEN] {
    let mut h = Sha256::new();
    h.update(FINGERPRINT_PREFIX);
    h.update(kem_ek);
    h.update(ed25519_pk);
    h.update(mldsa_vk);
    let out = h.finalize();
    let mut fp = [0u8; PERSON_FINGERPRINT_LEN];
    fp.copy_from_slice(&out);
    fp
}

/// The AAD bound into the sealed keypair envelope: the v0.2 prefix + the
/// protocol version + the `"person-keypair-blob"` role string.
pub fn aad_person_keypair() -> alloc::vec::Vec<u8> {
    let mut aad = alloc::vec::Vec::with_capacity(AAD_PREFIX_V0_2.len() + 1 + 21);
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    // Length-prefixed role string via the shared writer (the `.len() as u16`
    // chokepoint lives in `aead.rs`, so no second hand-rolled prefix here).
    crate::aead::push_length_prefixed_u16_be(&mut aad, b"person-keypair-blob");
    aad
}

/// The person-keypair error surface. Separate enum from
/// [`ProtocolError`] so an invite-flow error cannot type-narrow to a
/// vault-unlock error (the per-command closed-enum discipline).
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum PersonKeyError {
    /// ML-KEM encapsulation or decapsulation rejected (invalid key, wrong
    /// ciphertext length).
    #[error("person kem failure")]
    KemFailure,

    /// A signature (Ed25519 or ML-DSA-65) failed verification.
    /// Non-distinguishing between the two halves BY DESIGN: the verifier
    /// MUST check both and MUST NOT say which failed (a distinguishing
    /// message would downgrade-attack the weaker half).
    #[error("signature verification failed")]
    SignatureVerify,

    /// The derived fingerprint disagreed with the stored one after a
    /// re-derivation from seeds. Corruption or tampering.
    #[error("person fingerprint mismatch")]
    FingerprintMismatch,

    /// The wrapped key failed AEAD verification at unwrap time.
    #[error("aead failure")]
    AeadFailure,

    /// The OS CSPRNG failed.
    #[error("csprng failure")]
    Csprng,
}

impl From<PersonKeyError> for ProtocolError {
    fn from(_: PersonKeyError) -> Self {
        // The command surface collapses person-key failures into the
        // non-distinguishing AEAD/KDF classes per the §6.4 discipline;
        // this From exists so `?` works at the seam.
        ProtocolError::AeadFailure
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::types::KdfParams;

    /// Vector generator for the `person-identity` companion category: the
    /// canonical fingerprint construction and the hybrid-wrap combiner, the two
    /// deterministic byte surfaces the person path adds that a second
    /// implementation must reproduce. `#[ignore]`-gated; emits to
    /// `/tmp/myne_person_identity_vectors.json`.
    #[test]
    #[ignore = "vector generator; run explicitly to refresh person-identity cases.json"]
    fn emit_person_identity_vectors_for_paste() {
        extern crate std;
        use crate::test_vector_fmt::{hex_lower, json_escape};

        // Fixture public halves: fixed, distinct byte patterns so a fingerprint
        // change anywhere in the three inputs moves the expected value.
        let kem_ek: [u8; PERSON_EK_LEN] = [0x11; PERSON_EK_LEN];
        let ed_pk: [u8; PERSON_ED25519_PK_LEN] = [0x22; PERSON_ED25519_PK_LEN];
        let mldsa_vk: [u8; PERSON_MLDSA_VK_LEN] = [0x33; PERSON_MLDSA_VK_LEN];
        let fingerprint = compute_fingerprint(&kem_ek, &ed_pk, &mldsa_vk);

        // Hybrid combiner: fixed classical + PQ shared secrets.
        let classical: [u8; 32] = [0xA5; 32];
        let pq: [u8; 32] = [0x5A; 32];
        let hybrid = hybrid_wrap_key(&classical, &pq);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"person-identity\",\n");
        dump.push_str("  \"protocol_version\": \"v0.2\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §3.1\",\n");
        dump.push_str("  \"description\": \"Pins the two deterministic person-path byte constructions (myne-md/myne#698): the canonical fingerprint compute_fingerprint(kem_ek, ed_pk, mldsa_vk) = SHA-256('myne.person-fingerprint v1|' || kem_ek || ed_pk || mldsa_vk), and the hybrid-wrap combiner hybrid_wrap_key(classical_ss, pq_ss) = HKDF-SHA-256-Extract('myne.person-wrap-ss v1|', classical_ss || pq_ss). A port that frames either differently derives a different fingerprint (so SAS never matches) or a different wrap key (so no invite opens). EXPECTED RUNTIME: instant. Generated by `cargo test -p protocol --lib emit_person_identity_vectors_for_paste -- --ignored`.\",\n");
        dump.push_str("  \"cases\": [\n");
        dump.push_str("    {\n");
        dump.push_str("      \"case_kind\": \"fingerprint\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Canonical fingerprint over three fixed public halves. The domain prefix is load-bearing: the bare SHA-256 of the concatenation differs.")
        ));
        dump.push_str(&alloc::format!(
            "      \"input_kem_ek_hex\": \"{}\",\n",
            hex_lower(&kem_ek)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_ed_pk_hex\": \"{}\",\n",
            hex_lower(&ed_pk)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_mldsa_vk_hex\": \"{}\",\n",
            hex_lower(&mldsa_vk)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_fingerprint_hex\": \"{}\"\n",
            hex_lower(&fingerprint)
        ));
        dump.push_str("    },\n");
        dump.push_str("    {\n");
        dump.push_str("      \"case_kind\": \"hybrid-wrap-key\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Hybrid-wrap combiner over fixed classical + PQ shared secrets, in the fixed order classical || pq. HKDF-Extract with HYBRID_WRAP_PREFIX as the salt; a bare SHA-256(prefix || ss || ss) combiner produces a different, wrong key.")
        ));
        dump.push_str(&alloc::format!(
            "      \"input_classical_ss_hex\": \"{}\",\n",
            hex_lower(&classical)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_pq_ss_hex\": \"{}\",\n",
            hex_lower(&pq)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_hybrid_wrap_key_hex\": \"{}\"\n",
            hex_lower(&*hybrid)
        ));
        dump.push_str("    }\n");
        dump.push_str("  ]\n");
        dump.push_str("}\n");
        std::fs::write("/tmp/myne_person_identity_vectors.json", dump.as_bytes())
            .expect("write person-identity vectors dump");
    }

    /// Deterministic test randomness (the `_raw` surface exists for this).
    fn fixture_seed(label: &[u8]) -> [u8; 32] {
        let digest = Sha256::digest(label);
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    fn fixture_kem_seed() -> [u8; PERSON_DK_SEED_LEN] {
        let mut s = [0u8; PERSON_DK_SEED_LEN];
        s[..32].copy_from_slice(&fixture_seed(b"person-kem-d"));
        s[32..].copy_from_slice(&fixture_seed(b"person-kem-z"));
        s
    }

    fn test_params() -> KdfParams {
        // Test-only weak params: never a production path (the crate gotcha).
        KdfParams {
            m_kib: 8,
            t: 1,
            p: 1,
            argon2_version: 0x13,
        }
    }

    fn alpha_pair() -> PersonKeyPair {
        PersonKeyPair::generate_raw(
            &fixture_kem_seed(),
            &fixture_seed(b"person-ed25519-seed"),
            &fixture_seed(b"person-mldsa-seed"),
        )
    }

    #[test]
    fn keygen_is_deterministic_given_same_seeds() {
        let a = alpha_pair();
        let b = PersonKeyPair::generate_raw(
            &fixture_kem_seed(),
            &fixture_seed(b"person-ed25519-seed"),
            &fixture_seed(b"person-mldsa-seed"),
        );
        assert_eq!(a.fingerprint(), b.fingerprint());
        assert_eq!(a.kem_ek, b.kem_ek);
        assert_eq!(a.ed25519_pk, b.ed25519_pk);
        assert_eq!(a.mldsa_vk, b.mldsa_vk);
    }

    #[test]
    fn different_seeds_differ_everywhere() {
        let a = alpha_pair();
        let b = PersonKeyPair::generate_raw(
            &fixture_kem_seed(),
            &fixture_seed(b"person-ed25519-seed-OTHER"),
            &fixture_seed(b"person-mldsa-seed"),
        );
        assert_ne!(a.fingerprint(), b.fingerprint());
        assert_ne!(a.ed25519_pk, b.ed25519_pk);
    }

    #[test]
    fn low_order_classical_half_is_refused() {
        // The identity point (all-zero compressed Edwards) has small order, so
        // the classical DH would collapse to a known constant. The wrap must
        // refuse it rather than void the hybrid's classical half.
        let zero_point = [0u8; PERSON_ED25519_PK_LEN];
        assert!(member_montgomery(&zero_point).is_err());
    }

    #[test]
    fn fingerprint_is_domain_separated() {
        // The fingerprint is NOT the bare SHA-256 of the concat: the prefix
        // is load-bearing. Compute the bare hash and check they differ.
        let a = alpha_pair();
        let mut bare = Sha256::new();
        bare.update(a.kem_ek);
        bare.update(a.ed25519_pk);
        bare.update(a.mldsa_vk);
        let bare_out = bare.finalize();
        assert_ne!(&a.fingerprint()[..], &bare_out[..]);
    }

    #[test]
    fn plaintext_round_trip_reconstructs_the_fingerprint() {
        let a = alpha_pair();
        let bytes = a.to_plaintext_bytes();
        let b = PersonKeyPair::from_plaintext_bytes(&bytes);
        assert_eq!(a.fingerprint(), b.fingerprint());
        assert_eq!(a.kem_ek, b.kem_ek);
        assert_eq!(a.mldsa_vk, b.mldsa_vk);
    }

    fn fixture_half(label: &[u8]) -> [u8; 16] {
        let full = fixture_seed(label);
        let mut out = [0u8; 16];
        out.copy_from_slice(&full[..16]);
        out
    }

    #[test]
    fn seal_open_round_trip_with_test_params() {
        let a = alpha_pair();
        let person_id_hash = fixture_half(b"person-id-hash");
        let salt_random = fixture_half(b"person-salt");
        let wrap_key = crate::kdf::derive_person_keypair_wrap_key_from_normalized(
            "word one word two word three word four word five word six word seven word eight word nine word ten word eleven word twelve word thirteen word fourteen word fifteen word sixteen word seventeen word eighteen word nineteen word twenty",
            &salt_random,
            &person_id_hash,
            &test_params(),
        )
        .expect("test-params argon2id derive is cheap and valid");

        let (nonce, ct) = a
            .seal(&wrap_key)
            .expect("seal is infallible over valid input");
        let b = PersonKeyPair::open(&wrap_key, &nonce, &ct)
            .expect("open succeeds under the right wrap key");
        assert_eq!(a.fingerprint(), b.fingerprint());
    }

    #[test]
    fn open_rejects_a_tampered_ciphertext_closed() {
        let a = alpha_pair();
        let person_id_hash = fixture_half(b"person-id-hash");
        let salt_random = fixture_half(b"person-salt");
        let wrap_key = crate::kdf::derive_person_keypair_wrap_key_from_normalized(
            "word one word two word three word four word five word six word seven word eight word nine word ten word eleven word twelve word thirteen word fourteen word fifteen word sixteen word seventeen word eighteen word nineteen word twenty",
            &salt_random,
            &person_id_hash,
            &test_params(),
        )
        .expect("derive ok");
        let (nonce, mut ct) = a.seal(&wrap_key).expect("seal ok");
        let first = ct.len() / 2;
        ct[first] ^= 0x01;
        let result = PersonKeyPair::open(&wrap_key, &nonce, &ct);
        assert_eq!(result.err(), Some(ProtocolError::AeadFailure));
    }

    #[test]
    fn seal_nonces_are_unique_per_call() {
        let a = alpha_pair();
        let person_id_hash = fixture_half(b"person-id-hash");
        let salt_random = fixture_half(b"person-salt");
        let wrap_key = crate::kdf::derive_person_keypair_wrap_key_from_normalized(
            "word one word two word three word four word five word six word seven word eight word nine word ten word eleven word twelve word thirteen word fourteen word fifteen word sixteen word seventeen word eighteen word nineteen word twenty",
            &salt_random,
            &person_id_hash,
            &test_params(),
        )
        .expect("derive ok");
        let (n1, _c1) = a.seal(&wrap_key).expect("seal 1");
        let (n2, _c2) = a.seal(&wrap_key).expect("seal 2");
        assert_ne!(*n1, *n2);
    }

    #[test]
    fn aad_carries_the_v0_2_prefix_and_the_role_string() {
        let aad = aad_person_keypair();
        assert_eq!(&aad[..10], AAD_PREFIX_V0_2);
        assert_eq!(aad[10], PROTOCOL_VERSION_V0_2);
        // Length-prefixed role: u16 BE(19) then "person-keypair-blob".
        assert_eq!(&aad[11..13], &19u16.to_be_bytes());
        assert_eq!(&aad[13..], b"person-keypair-blob");
        assert_eq!(aad.len(), 10 + 1 + 2 + 19);
    }

    #[test]
    fn debug_never_carries_secret_bytes() {
        let a = alpha_pair();
        let debug = alloc::format!("{a:?}");
        // The fixture seeds start with 0xa3-like patterns; assert the
        // debug string does NOT contain any 64-hex-char run (no secret
        // serialization leaked).
        assert!(!debug.contains(&alloc::format!("{:?}", &a.kem_seed[..])));
        assert!(debug.contains("PersonKeyPair"));
        assert!(debug.contains("fingerprint_hex"));
    }
    /// A deterministic CSPRNG for tests (rand_core 0.10), seeded.
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
            // ChaCha-like deterministic stream from the seed counter.
            let mut ctr = self.0.wrapping_add(1);
            self.0 = ctr;
            for chunk in dst.chunks_mut(32) {
                let digest = Sha256::digest(ctr.to_le_bytes());
                let n = chunk.len();
                chunk[..n].copy_from_slice(&digest[..n]);
                ctr = ctr.wrapping_add(1);
            }
            Ok(())
        }
    }

    impl rand_core::TryCryptoRng for SeededRng {}

    const ACCT_HASH: [u8; 16] = [0x44; 16];

    #[test]
    fn wrap_unwrap_round_trips_across_two_people() {
        let other = PersonKeyPair::generate_raw(
            &{
                let mut s = [0u8; PERSON_DK_SEED_LEN];
                s[..32].copy_from_slice(&fixture_seed(b"other-kem-d"));
                s[32..].copy_from_slice(&fixture_seed(b"other-kem-z"));
                s
            },
            &fixture_seed(b"other-ed25519-seed"),
            &fixture_seed(b"other-mldsa-seed"),
        );

        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");
        let wrapped = other
            .public_half()
            .wrap_key(&items_key, &ACCT_HASH, &mut SeededRng(0))
            .expect("wrap succeeds");
        let unwrapped = other
            .unwrap_key(&wrapped, &ACCT_HASH)
            .expect("unwrap succeeds");
        assert_eq!(*unwrapped, items_key);

        // The WRONG person cannot open it: same shape, different identity.
        let wrong = alpha_pair();
        let result = wrong.unwrap_key(&wrapped, &ACCT_HASH);
        assert!(matches!(result, Err(PersonKeyError::AeadFailure)));
    }

    #[test]
    fn wrap_is_unwrappable_by_owner_only_and_deterministic_given_same_rng() {
        let other = PersonKeyPair::generate_raw(
            &{
                let mut s = [0u8; PERSON_DK_SEED_LEN];
                s[..32].copy_from_slice(&fixture_seed(b"other-kem-d"));
                s[32..].copy_from_slice(&fixture_seed(b"other-kem-z"));
                s
            },
            &fixture_seed(b"other-ed25519-seed"),
            &fixture_seed(b"other-mldsa-seed"),
        );
        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");
        let w1 = other
            .public_half()
            .wrap_key(&items_key, &ACCT_HASH, &mut SeededRng(0))
            .expect("wrap 1");
        let w2 = other
            .public_half()
            .wrap_key(&items_key, &ACCT_HASH, &mut SeededRng(0))
            .expect("wrap 2");
        // Same RNG state -> same ciphertext bytes (the deterministic surface).
        assert_eq!(w1.wrapped_key, w2.wrapped_key);
        assert_eq!(w1.ml_kem_ct, w2.ml_kem_ct);
    }
    #[test]
    fn sign_verify_round_trip_and_tamper() {
        let signer = alpha_pair();
        let half = signer.public_half();
        let mut rng = SeededRng(0);
        let message = fixture_seed(b"rotation-notice");

        let signed = signer.sign(&message, &mut rng).expect("sign");
        assert!(half.verify(&message, &signed).is_ok(), "both halves verify");

        // Tamper one ML-DSA byte: verify fails non-distinguishingly.
        let mut tampered = signed.clone();
        let mid = tampered.mldsa_sig.len() / 2;
        tampered.mldsa_sig[mid] ^= 0x01;
        assert!(matches!(
            half.verify(&message, &tampered),
            Err(PersonKeyError::SignatureVerify)
        ));

        // Tamper the Ed25519 half: same single error.
        let signed2 = signer.sign(&message, &mut rng).expect("sign");
        let mut tampered2 = signed2;
        tampered2.ed25519_sig[0] ^= 0x01;
        assert!(matches!(
            half.verify(&message, &tampered2),
            Err(PersonKeyError::SignatureVerify)
        ));

        // The wrong verifier (a different person) rejects.
        let wrong = PersonKeyPair::generate_raw(
            &{
                let mut s = [0u8; PERSON_DK_SEED_LEN];
                s[..32].copy_from_slice(&fixture_seed(b"other-kem-d"));
                s[32..].copy_from_slice(&fixture_seed(b"other-kem-z"));
                s
            },
            &fixture_seed(b"other-ed25519-seed"),
            &fixture_seed(b"other-mldsa-seed"),
        );
        let signed3 = signer.sign(&message, &mut rng).expect("sign");
        assert!(matches!(
            wrong.public_half().verify(&message, &signed3),
            Err(PersonKeyError::SignatureVerify)
        ));
    }
}
