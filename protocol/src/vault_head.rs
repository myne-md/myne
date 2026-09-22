// SPDX-License-Identifier: AGPL-3.0
//! Vault head — Phase 2 fork-consistency primitive (`docs/spec/sync-protocol.md` §3–§5).
//!
//! The vault head is a small, server-relayed, per-push record that lets the
//! devices of a single user detect a malicious server's attempts to **roll
//! back**, **withhold**, or **fork** their vault, even though the server can
//! never read or forge their content. It is authenticated by HMAC-SHA-256 under
//! a `root_key`-derived key and chains to its predecessor(s), forming a git-like
//! hash-DAG.
//!
//! This module implements:
//! - the canonical `head_mac_input` encoding (§3.2) and the version-vector inner
//!   encoding (§3.3, gap G1: `entry_count` then entries sorted by `device_id`);
//! - `compute_vault_head_mac` — HMAC-SHA-256 over the canonical input, keyed by
//!   `DeriveSubkey(root_key, "vault-head-mac")` (§3.1). HMAC is realized via
//!   `Hkdf::<Sha256>::extract` (RFC 5869 §2.2), the same construction as
//!   `compute_attachment_id` (`attachment_blob.rs`); no `hmac` crate, no new
//!   dependency;
//! - `head_id = SHA-256(head_mac_input || head_mac)` (§3.4, gap G3 — the chain
//!   binds the MAC, not just the content); `prev_head_hash[]` are parent
//!   `head_id`s, byte-sorted on encode for a 2-parent merge (gap G2);
//! - `open_vault_head` — parse + constant-time MAC verify + structural
//!   well-formedness (§5.2);
//! - `vv_dominance` — the §5.3 three-case rollback test (extension / rollback /
//!   incomparable) plus the §6 bootstrap-TOFU case (empty baseline);
//! - the device-local `MYH1` `vault.head-state` baseline codec (`protocol.md`
//!   §9.16): it stores the full wire-head TIP and re-verifies the head's own MAC
//!   under the same `vault-head-mac` key (no second context, no AEAD — the head
//!   carries only server-visible metadata).
//!
//! **HMAC, not a signature** (§2): single-user → all devices share `root_key` →
//! a symmetric MAC suffices and stays in the closed RustCrypto primitive set.
//!
//! **`author_device_id` note (§4.1 reconciliation):** the committed §3.2 byte
//! layout carries **no** explicit `author_device_id` field — the authoring
//! device is the version-vector component equal to `max(parents) + 1`, derived
//! during verification when the parents are on hand (§5.4 lazy merge-verify).
//! §4.1's "explicit author for simplicity" wording is realized here as
//! implicit-from-VV; the byte layout (which the golden vectors pin) is
//! authoritative.

use alloc::vec::Vec;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::subkey::{derive_subkey, SubkeyRole};

/// AAD-style domain prefix bound into every `head_mac_input` (§3.2 / §5.2).
/// 10 ASCII bytes including the trailing pipe; load-bearing — drift silently
/// invalidates every head.
pub const VAULT_HEAD_DOMAIN_PREFIX: &[u8] = b"myne.v0.1|";
/// Protocol version byte bound into `head_mac_input` (§3.2).
pub const VAULT_HEAD_PROTOCOL_VERSION: u8 = 0x01;
/// The v0.1 head wire-format version (§3.6 forward hook).
pub const VAULT_HEAD_FORMAT_V1: u8 = 0x01;

/// The signed head format (`decisions/protocol/0603`): the head is
/// signature-authenticated by the author's person keypair instead of HMAC'd
/// under `root_key`, because a B2B member holds no `root_key`. Wire-only, so no
/// on-disk magic moves; `protocol.md` §10's reserved-expansion ban does not
/// apply to a sync-wire record.
pub const VAULT_HEAD_FORMAT_V2: u8 = 0x02;

/// The vault-scoped pseudonymous author id length (`myne.head-author v1|`).
pub const HEAD_AUTHOR_ID_LEN: usize = 16;

/// Signature-class prefix for a signed head. Changing it invalidates every head
/// signature verification.
const HEAD_SIGNATURE_PREFIX: &[u8] = b"myne.head-signature v1|";

/// Hash domain for the vault-scoped pseudonymous author id. Distinct from the
/// person fingerprint so the id cannot be linked across vaults.
const HEAD_AUTHOR_ID_PREFIX: &[u8] = b"myne.head-author v1|";

/// Length of `account_number_hash` bound into the head (§3.2).
pub const VAULT_HEAD_ACCOUNT_HASH_LEN: usize = 16;
/// Length of the manifest hash committed by the head (`SHA-256`, §4.2).
pub const VAULT_HEAD_MANIFEST_HASH_LEN: usize = 32;
/// Length of a version-vector actor `device_id` (§4.1).
pub const DEVICE_ID_LEN: usize = 16;
/// Length of a `prev_head_hash` / `head_id` (`SHA-256`, §3.4).
pub const HEAD_ID_LEN: usize = 32;
/// Length of the head MAC (full HMAC-SHA-256 tag, no truncation, §3.2).
pub const HEAD_MAC_LEN: usize = 32;

/// Magic for the device-local `vault.head-state` baseline blob (`protocol.md`
/// §9.16, §10.3).
pub const VAULT_HEAD_STATE_MAGIC: [u8; 4] = *b"MYH1";

/// One version-vector entry: a device and its authored-head counter (§4.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VvEntry {
    /// Client-generated 16-byte VV-actor identifier (distinct from the secret
    /// per-device token, §4.1).
    pub device_id: [u8; DEVICE_ID_LEN],
    /// Authored-head count for this device (monotone, push-granularity).
    pub counter: u64,
}

/// The result of the §5.3 on-pull VV-dominance comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dominance {
    /// Candidate ≥ baseline componentwise with ≥1 strictly greater → accept.
    Extension,
    /// Some candidate component is below the baseline → reject (rollback).
    Rollback,
    /// Incomparable (some greater, some less) → concurrent; author a merge head.
    Incomparable,
    /// Empty baseline → trust-on-first-use bootstrap (§6), not a dominance result.
    BootstrapTofu,
}

/// A decoded vault head (the fields the MAC commits, §3.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultHead {
    /// `head_format_version` (§3.6); v0.1 = [`VAULT_HEAD_FORMAT_V1`].
    pub head_format_version: u8,
    /// Vault binding (§3.2).
    pub account_number_hash: [u8; VAULT_HEAD_ACCOUNT_HASH_LEN],
    /// Flat `SHA-256` of the canonical `uuid → content_nonce` manifest (§4.2).
    pub manifest_hash: [u8; VAULT_HEAD_MANIFEST_HASH_LEN],
    /// Auxiliary Lamport scalar (`max(parent_seq)+1`); VV is the authority (§4.1 Pin 4).
    pub seq: u64,
    /// Parent `head_id`s: 0 (genesis) / 1 (linear) / 2 (merge). Byte-sorted on
    /// encode (gap G2).
    pub prev_head_hash: Vec<[u8; HEAD_ID_LEN]>,
    /// Per-device version vector (§4.1). Unordered here; canonically sorted by
    /// `device_id` on encode (gap G1).
    pub version_vector: Vec<VvEntry>,
}

/// A sealed head: the wire record (`head_mac_input || head_mac`) plus its id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedHead {
    /// `head_mac_input || head_mac` — the bytes a device persists / relays.
    pub record: Vec<u8>,
    /// `head_id = SHA-256(record)` (§3.4).
    pub head_id: [u8; HEAD_ID_LEN],
}

/// Errors from encoding, MAC verification, or parsing a vault head / baseline.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum VaultHeadError {
    /// `parent_count` outside `{0, 1, 2}`.
    #[error("vault head parent_count must be 0, 1, or 2")]
    ParentCountInvalid,
    /// Two merge parents not in ascending byte order (gap G2 canonical form).
    #[error("vault head prev_head_hash entries are not canonically byte-sorted")]
    PrevHeadHashNotSorted,
    /// Version-vector device_ids not strictly ascending (sorted, no duplicate).
    #[error("vault head version_vector is not sorted by device_id or has a duplicate")]
    VersionVectorNotCanonical,
    /// Version vector is empty (every head has at least the author component).
    #[error("vault head version_vector must be non-empty")]
    VersionVectorEmpty,
    /// Record too short to hold the fixed header / declared fields.
    #[error("vault head record is too short to parse")]
    RecordTooShort,
    /// Trailing bytes after a complete record (strict parse).
    #[error("vault head record has unexpected trailing bytes")]
    TrailingBytes,
    /// Domain prefix mismatch (expected `"myne.v0.1|"`).
    #[error("vault head domain prefix mismatch")]
    DomainPrefixMismatch,
    /// `protocol_version` byte mismatch (expected `0x01`).
    #[error("vault head protocol_version mismatch")]
    ProtocolVersionMismatch,
    /// `head_format_version` not supported by this client.
    #[error("vault head head_format_version unsupported")]
    FormatUnsupported,
    /// Declared `vv_len` inconsistent with the entry count.
    #[error("vault head vv_len inconsistent with entry_count")]
    VersionVectorLenInvalid,
    /// HMAC verification failed (not authored under this `root_key`).
    #[error("vault head MAC verification failed")]
    MacMismatch,
    /// Signed-head signature verification failed (neither half, or wrong key).
    #[error("vault head signature verification failed")]
    SignatureMismatch,
    /// Signed-head author id matches no known roster public half.
    #[error("vault head author id matches no known roster public half")]
    AuthorUnknown,
    /// `MYH1` baseline magic mismatch.
    #[error("vault.head-state magic mismatch (expected MYH1)")]
    StateMagicMismatch,
}

impl VaultHead {
    /// `parent_count` as the 1-byte field encoded into `head_mac_input`.
    fn parent_count(&self) -> Result<u8, VaultHeadError> {
        match self.prev_head_hash.len() {
            0 => Ok(0),
            1 => Ok(1),
            2 => Ok(2),
            _ => Err(VaultHeadError::ParentCountInvalid),
        }
    }

    /// Encode the canonical `head_mac_input` bytes (§3.2 + §3.3). Sorts the
    /// merge parents (G2) and the version vector (G1) into canonical order; the
    /// caller may pass either unsorted.
    pub fn encode_mac_input(&self) -> Result<Vec<u8>, VaultHeadError> {
        let parent_count = self.parent_count()?;
        if self.version_vector.is_empty() {
            return Err(VaultHeadError::VersionVectorEmpty);
        }

        // G2: parents byte-sorted ascending.
        let mut parents = self.prev_head_hash.clone();
        parents.sort_unstable();

        // G1: VV sorted by device_id; reject a duplicate device_id.
        let mut vv = self.version_vector.clone();
        vv.sort_unstable_by_key(|a| a.device_id);
        for w in vv.windows(2) {
            if w[0].device_id == w[1].device_id {
                return Err(VaultHeadError::VersionVectorNotCanonical);
            }
        }

        let vv_canonical = encode_version_vector(&vv);

        let mut buf = Vec::with_capacity(
            VAULT_HEAD_DOMAIN_PREFIX.len()
                + 1
                + 1
                + VAULT_HEAD_ACCOUNT_HASH_LEN
                + VAULT_HEAD_MANIFEST_HASH_LEN
                + 8
                + 1
                + (parent_count as usize) * HEAD_ID_LEN
                + 4
                + vv_canonical.len(),
        );
        buf.extend_from_slice(VAULT_HEAD_DOMAIN_PREFIX);
        buf.push(VAULT_HEAD_PROTOCOL_VERSION);
        buf.push(self.head_format_version);
        buf.extend_from_slice(&self.account_number_hash);
        buf.extend_from_slice(&self.manifest_hash);
        buf.extend_from_slice(&self.seq.to_be_bytes());
        buf.push(parent_count);
        for p in &parents {
            buf.extend_from_slice(p);
        }
        buf.extend_from_slice(&(vv_canonical.len() as u32).to_be_bytes());
        buf.extend_from_slice(&vv_canonical);
        Ok(buf)
    }

    /// Seal the head: compute the MAC over the canonical input, append it to
    /// form the wire record, and compute the `head_id`.
    pub fn seal(&self, root_key: &[u8; 32]) -> Result<SealedHead, VaultHeadError> {
        let mac_input = self.encode_mac_input()?;
        let mac = compute_vault_head_mac(root_key, &mac_input);
        let mut record = mac_input;
        record.extend_from_slice(&mac);
        let head_id = compute_head_id(&record);
        Ok(SealedHead { record, head_id })
    }
}

/// Canonical version-vector encoding (§3.3, gap G1): `entry_count` (u32 BE) then,
/// for each entry **already sorted by `device_id`**, `device_id (16) || counter
/// (u64 BE)`. Caller guarantees the sort + uniqueness.
fn encode_version_vector(sorted: &[VvEntry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + sorted.len() * (DEVICE_ID_LEN + 8));
    out.extend_from_slice(&(sorted.len() as u32).to_be_bytes());
    for e in sorted {
        out.extend_from_slice(&e.device_id);
        out.extend_from_slice(&e.counter.to_be_bytes());
    }
    out
}

/// HMAC-SHA-256 over `head_mac_input`, keyed by
/// `DeriveSubkey(root_key, "vault-head-mac")` (§3.1). Realized via
/// `Hkdf::<Sha256>::extract` (RFC 5869 §2.2 ⇒ HMAC-SHA-256), the same shape as
/// `compute_attachment_id`.
pub fn compute_vault_head_mac(root_key: &[u8; 32], head_mac_input: &[u8]) -> [u8; HEAD_MAC_LEN] {
    let mac_key = derive_subkey(root_key, SubkeyRole::VaultHeadMac);
    let (prk, _hkdf) = Hkdf::<Sha256>::extract(Some(mac_key.as_slice()), head_mac_input);
    let mut mac = [0u8; HEAD_MAC_LEN];
    mac.copy_from_slice(&prk);
    mac
}

/// `head_id = SHA-256(record)` where `record = head_mac_input || head_mac`
/// (§3.4, gap G3 — binds the MAC, not just the content).
pub fn compute_head_id(record: &[u8]) -> [u8; HEAD_ID_LEN] {
    let mut h = Sha256::new();
    h.update(record);
    let out = h.finalize();
    let mut id = [0u8; HEAD_ID_LEN];
    id.copy_from_slice(&out);
    id
}

/// Domain prefix for the bootstrap / fork-audit fingerprint digest (§6.3). The
/// SAS is a function of a *domain-separated* hash of `head_id`, not the raw
/// `head_id` — load-bearing (drift changes every displayed fingerprint).
pub const VAULT_HEAD_FINGERPRINT_DOMAIN: &[u8] = b"myne.v0.1 vault-head-fingerprint";

/// Number of Crockford-base32 characters in the SAS fingerprint (40 bits ⇒ 8
/// chars). Displayed grouped `XXXX-XXXX` (a 9-char string incl. the dash).
pub const HEAD_FINGERPRINT_CHARS: usize = 8;

/// The deterministic `head_id → SAS-fingerprint` substrate (SYNC-17, §6.3): a
/// short, eye-comparable code both devices show at the enrollment approval gate
/// (MYND-425, v1) and the general fork-audit UI reuses (MYND-427, v1.x). It is
/// **~SAS-magnitude** (40 bits, not the full 32-byte `head_id`) and **cross-impl
/// byte-identical** — a golden vector pins it (PRIMITIVE-LEVEL review required).
///
/// Encoding: `digest = SHA-256(VAULT_HEAD_FINGERPRINT_DOMAIN || head_id)`; the
/// first 40 bits of `digest` are emitted as 8 Crockford-base32 chars (the same
/// alphabet as `account-number.md` §4, excluding I/L/O/U), grouped `XXXX-XXXX`.
pub fn head_fingerprint(head_id: &[u8; HEAD_ID_LEN]) -> alloc::string::String {
    use alloc::string::String;

    // Crockford base32 alphabet (frozen; mirrors account_number::CROCKFORD).
    const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    let mut h = Sha256::new();
    h.update(VAULT_HEAD_FINGERPRINT_DOMAIN);
    h.update(head_id);
    let digest = h.finalize();

    // First 5 bytes = 40 bits, big-endian, split into 8 × 5-bit groups.
    let mut acc: u64 = 0;
    for &b in &digest[..5] {
        acc = (acc << 8) | b as u64;
    }
    let mut s = String::with_capacity(HEAD_FINGERPRINT_CHARS + 1);
    for i in 0..HEAD_FINGERPRINT_CHARS {
        if i == 4 {
            s.push('-');
        }
        let shift = 5 * (HEAD_FINGERPRINT_CHARS - 1 - i);
        let idx = ((acc >> shift) & 0x1f) as usize;
        s.push(CROCKFORD[idx] as char);
    }
    s
}

/// Parse a wire record (`head_mac_input || head_mac`), verify the MAC in
/// constant time, and check structural well-formedness (§5.2). Returns the
/// decoded [`VaultHead`] on success.
pub fn open_vault_head(root_key: &[u8; 32], record: &[u8]) -> Result<VaultHead, VaultHeadError> {
    // Fixed minimum: prefix + 2 version bytes + account_hash + manifest_hash +
    // seq + parent_count + vv_len + (empty vv has entry_count) + mac.
    let fixed_min = VAULT_HEAD_DOMAIN_PREFIX.len()
        + 1
        + 1
        + VAULT_HEAD_ACCOUNT_HASH_LEN
        + VAULT_HEAD_MANIFEST_HASH_LEN
        + 8
        + 1
        + 4
        + HEAD_MAC_LEN;
    if record.len() < fixed_min {
        return Err(VaultHeadError::RecordTooShort);
    }
    if record.len() < HEAD_MAC_LEN {
        return Err(VaultHeadError::RecordTooShort);
    }
    let (mac_input, mac) = record.split_at(record.len() - HEAD_MAC_LEN);

    // Verify MAC first (constant-time) — a forged record is rejected before any
    // structural trust is placed in its bytes.
    let expected = compute_vault_head_mac(root_key, mac_input);
    if mac.ct_eq(&expected).unwrap_u8() != 1 {
        return Err(VaultHeadError::MacMismatch);
    }

    // Now decode the (authenticated) input.
    parse_head_canonical(mac_input, VAULT_HEAD_FORMAT_V1)
}

/// Decode a canonical head input (exactly the bytes [`VaultHead::encode_mac_input`]
/// produces), requiring `expected_format` in the format byte. Shared by the
/// HMAC head (after its MAC verifies) and the signed `0x02` head (after its
/// signature verifies), so the two formats cannot drift in how they read the
/// fields the head commits.
fn parse_head_canonical(input: &[u8], expected_format: u8) -> Result<VaultHead, VaultHeadError> {
    let mut off = 0usize;
    let p = VAULT_HEAD_DOMAIN_PREFIX.len();
    if &input[off..off + p] != VAULT_HEAD_DOMAIN_PREFIX {
        return Err(VaultHeadError::DomainPrefixMismatch);
    }
    off += p;
    if input[off] != VAULT_HEAD_PROTOCOL_VERSION {
        return Err(VaultHeadError::ProtocolVersionMismatch);
    }
    off += 1;
    let head_format_version = input[off];
    if head_format_version != expected_format {
        return Err(VaultHeadError::FormatUnsupported);
    }
    off += 1;

    let mut account_number_hash = [0u8; VAULT_HEAD_ACCOUNT_HASH_LEN];
    account_number_hash.copy_from_slice(&input[off..off + VAULT_HEAD_ACCOUNT_HASH_LEN]);
    off += VAULT_HEAD_ACCOUNT_HASH_LEN;

    let mut manifest_hash = [0u8; VAULT_HEAD_MANIFEST_HASH_LEN];
    manifest_hash.copy_from_slice(&input[off..off + VAULT_HEAD_MANIFEST_HASH_LEN]);
    off += VAULT_HEAD_MANIFEST_HASH_LEN;

    let mut seq_bytes = [0u8; 8];
    seq_bytes.copy_from_slice(&input[off..off + 8]);
    let seq = u64::from_be_bytes(seq_bytes);
    off += 8;

    let parent_count = input[off];
    off += 1;
    if parent_count > 2 {
        return Err(VaultHeadError::ParentCountInvalid);
    }
    let need_parents = parent_count as usize * HEAD_ID_LEN;
    if input.len() < off + need_parents + 4 {
        return Err(VaultHeadError::RecordTooShort);
    }
    let mut prev_head_hash = Vec::with_capacity(parent_count as usize);
    for _ in 0..parent_count {
        let mut h = [0u8; HEAD_ID_LEN];
        h.copy_from_slice(&input[off..off + HEAD_ID_LEN]);
        prev_head_hash.push(h);
        off += HEAD_ID_LEN;
    }
    // G2: canonical ascending byte order.
    for w in prev_head_hash.windows(2) {
        if w[0] >= w[1] {
            return Err(VaultHeadError::PrevHeadHashNotSorted);
        }
    }

    let mut vvlen_bytes = [0u8; 4];
    vvlen_bytes.copy_from_slice(&input[off..off + 4]);
    let vv_len = u32::from_be_bytes(vvlen_bytes) as usize;
    off += 4;
    if input.len() != off + vv_len {
        return Err(VaultHeadError::TrailingBytes);
    }
    if vv_len < 4 {
        return Err(VaultHeadError::VersionVectorLenInvalid);
    }
    let mut ec_bytes = [0u8; 4];
    ec_bytes.copy_from_slice(&input[off..off + 4]);
    let entry_count = u32::from_be_bytes(ec_bytes) as usize;
    off += 4;
    let entry_size = DEVICE_ID_LEN + 8;
    if vv_len != 4 + entry_count * entry_size {
        return Err(VaultHeadError::VersionVectorLenInvalid);
    }
    if entry_count == 0 {
        return Err(VaultHeadError::VersionVectorEmpty);
    }
    let mut version_vector = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        let mut device_id = [0u8; DEVICE_ID_LEN];
        device_id.copy_from_slice(&input[off..off + DEVICE_ID_LEN]);
        off += DEVICE_ID_LEN;
        let mut c = [0u8; 8];
        c.copy_from_slice(&input[off..off + 8]);
        off += 8;
        version_vector.push(VvEntry {
            device_id,
            counter: u64::from_be_bytes(c),
        });
    }
    // G1: strictly ascending device_id (sorted, no duplicate).
    for w in version_vector.windows(2) {
        if w[0].device_id >= w[1].device_id {
            return Err(VaultHeadError::VersionVectorNotCanonical);
        }
    }

    Ok(VaultHead {
        head_format_version,
        account_number_hash,
        manifest_hash,
        seq,
        prev_head_hash,
        version_vector,
    })
}

/// The exact bytes a signed head's double signature covers:
/// `HEAD_SIGNATURE_PREFIX || author_id || canonical_head_input`. The author id
/// is authenticated by being inside the signed message.
fn head_signature_message(author_id: &[u8; HEAD_AUTHOR_ID_LEN], canonical: &[u8]) -> Vec<u8> {
    let mut m =
        Vec::with_capacity(HEAD_SIGNATURE_PREFIX.len() + HEAD_AUTHOR_ID_LEN + canonical.len());
    m.extend_from_slice(HEAD_SIGNATURE_PREFIX);
    m.extend_from_slice(author_id);
    m.extend_from_slice(canonical);
    m
}

/// The vault-scoped pseudonymous author id: `SHA-256("myne.head-author v1|" ||
/// kem_ek || ed_pk || mldsa_vk || account_number_hash)[:16]`. It binds the
/// person and the vault, so the same person shows a different id in each vault
/// and the server cannot link them.
#[must_use]
pub fn head_author_id(
    public: &crate::person_key::PersonPublicHalf,
    account_number_hash: &[u8; VAULT_HEAD_ACCOUNT_HASH_LEN],
) -> [u8; HEAD_AUTHOR_ID_LEN] {
    let mut h = Sha256::new();
    h.update(HEAD_AUTHOR_ID_PREFIX);
    h.update(public.kem_ek());
    h.update(public.ed_pk());
    h.update(public.mldsa_vk());
    h.update(account_number_hash);
    let digest = h.finalize();
    let mut out = [0u8; HEAD_AUTHOR_ID_LEN];
    out.copy_from_slice(&digest[..HEAD_AUTHOR_ID_LEN]);
    out
}

/// Author a signed (`0x02`) head: build the canonical input (the `VaultHead`
/// must carry [`VAULT_HEAD_FORMAT_V2`]), double-sign `HEAD_SIGNATURE_PREFIX ||
/// author_id || canonical` with the person keypair, and frame the record as
/// `ed25519_sig || mldsa_sig || author_id || canonical`. `head_id` is
/// `SHA-256(record)` as for the HMAC head.
pub fn sign_vault_head(
    head: &VaultHead,
    author_id: &[u8; HEAD_AUTHOR_ID_LEN],
    person: &crate::person_key::PersonKeyPair,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<SealedHead, VaultHeadError> {
    if head.head_format_version != VAULT_HEAD_FORMAT_V2 {
        return Err(VaultHeadError::FormatUnsupported);
    }
    let canonical = head.encode_mac_input()?;
    let message = head_signature_message(author_id, &canonical);
    let signature = person
        .sign(&message, rng)
        .map_err(|_| VaultHeadError::SignatureMismatch)?;
    let sig_len =
        crate::person_key::PERSON_ED25519_SIG_LEN + crate::person_key::PERSON_MLDSA_SIG_LEN;
    let mut record = Vec::with_capacity(sig_len + HEAD_AUTHOR_ID_LEN + canonical.len());
    record.extend_from_slice(&signature.ed25519_sig);
    record.extend_from_slice(&signature.mldsa_sig);
    record.extend_from_slice(author_id);
    record.extend_from_slice(&canonical);
    let head_id = compute_head_id(&record);
    Ok(SealedHead { record, head_id })
}

/// Verify a signed (`0x02`) head peer-side against the candidate roster public
/// halves: resolve the signer by recomputing each candidate's author id, check
/// BOTH signature halves, then parse the canonical input. Returns the head and
/// the resolved author id.
pub fn open_signed_vault_head(
    record: &[u8],
    roster_publics: &[crate::person_key::PersonPublicHalf],
    account_number_hash: &[u8; VAULT_HEAD_ACCOUNT_HASH_LEN],
) -> Result<(VaultHead, [u8; HEAD_AUTHOR_ID_LEN]), VaultHeadError> {
    let sig_len =
        crate::person_key::PERSON_ED25519_SIG_LEN + crate::person_key::PERSON_MLDSA_SIG_LEN;
    if record.len() < sig_len + HEAD_AUTHOR_ID_LEN + 2 {
        return Err(VaultHeadError::RecordTooShort);
    }
    let mut ed25519_sig = [0u8; crate::person_key::PERSON_ED25519_SIG_LEN];
    ed25519_sig.copy_from_slice(&record[..crate::person_key::PERSON_ED25519_SIG_LEN]);
    let mldsa_sig = record[crate::person_key::PERSON_ED25519_SIG_LEN..sig_len].to_vec();
    let mut author_id = [0u8; HEAD_AUTHOR_ID_LEN];
    author_id.copy_from_slice(&record[sig_len..sig_len + HEAD_AUTHOR_ID_LEN]);
    let canonical = &record[sig_len + HEAD_AUTHOR_ID_LEN..];

    let signer = roster_publics
        .iter()
        .find(|p| head_author_id(p, account_number_hash) == author_id)
        .ok_or(VaultHeadError::AuthorUnknown)?;
    let message = head_signature_message(&author_id, canonical);
    signer
        .verify(
            &message,
            &crate::person_key::PersonSigned {
                ed25519_sig,
                mldsa_sig,
            },
        )
        .map_err(|_| VaultHeadError::SignatureMismatch)?;

    let head = parse_head_canonical(canonical, VAULT_HEAD_FORMAT_V2)?;
    Ok((head, author_id))
}

/// Look up a device's counter in a version vector (absent ⇒ 0).
fn vv_get(vv: &[VvEntry], device_id: &[u8; DEVICE_ID_LEN]) -> u64 {
    vv.iter()
        .find(|e| &e.device_id == device_id)
        .map(|e| e.counter)
        .unwrap_or(0)
}

/// The §5.3 on-pull VV-dominance test: compare a `candidate` head's version
/// vector to the device's `baseline` (last-seen) version vector. An empty
/// baseline is the §6 trust-on-first-use bootstrap.
pub fn vv_dominance(baseline: &[VvEntry], candidate: &[VvEntry]) -> Dominance {
    if baseline.is_empty() {
        return Dominance::BootstrapTofu;
    }
    let mut any_greater = false;
    let mut any_less = false;
    // Union of device_ids across both vectors (absent component = 0).
    for e in baseline.iter().chain(candidate.iter()) {
        let b = vv_get(baseline, &e.device_id);
        let c = vv_get(candidate, &e.device_id);
        if c > b {
            any_greater = true;
        } else if c < b {
            any_less = true;
        }
    }
    // Standard version-vector ordering (§5.3): a decrease with no increase is a
    // rollback (candidate strictly behind); a mix of increases and decreases is
    // concurrent (incomparable → author a merge); no decrease is an extension
    // (candidate ≥ baseline, equal VVs included as a no-op extension).
    match (any_greater, any_less) {
        (_, false) => Dominance::Extension,
        (true, true) => Dominance::Incomparable,
        (false, true) => Dominance::Rollback,
    }
}

// ---- MYH1 device-local baseline (`protocol.md` §9.16) ----------------------

/// Encode the device-local `MYH1` `vault.head-state` baseline: magic + protocol
/// version + `head_format_version` + the full wire-head `record`
/// (`head_mac_input || head_mac`). Not AEAD-encrypted — the bytes are exactly
/// the head the server already relays; integrity is the head's own MAC,
/// re-verified on load.
pub fn encode_head_state(sealed: &SealedHead, head_format_version: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 1 + 1 + sealed.record.len());
    out.extend_from_slice(&VAULT_HEAD_STATE_MAGIC);
    out.push(VAULT_HEAD_PROTOCOL_VERSION);
    out.push(head_format_version);
    out.extend_from_slice(&sealed.record);
    out
}

/// Decode + verify a device-local `MYH1` baseline: check the magic / version
/// bytes, then re-verify the embedded head's own MAC under `root_key` (§9.16).
pub fn decode_head_state(root_key: &[u8; 32], blob: &[u8]) -> Result<VaultHead, VaultHeadError> {
    let header = 4 + 1 + 1;
    if blob.len() < header {
        return Err(VaultHeadError::RecordTooShort);
    }
    if blob[0..4] != VAULT_HEAD_STATE_MAGIC {
        return Err(VaultHeadError::StateMagicMismatch);
    }
    if blob[4] != VAULT_HEAD_PROTOCOL_VERSION {
        return Err(VaultHeadError::ProtocolVersionMismatch);
    }
    if blob[5] != VAULT_HEAD_FORMAT_V1 {
        return Err(VaultHeadError::FormatUnsupported);
    }
    open_vault_head(root_key, &blob[header..])
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use alloc::vec;

    fn dev(b: u8) -> [u8; DEVICE_ID_LEN] {
        [b; DEVICE_ID_LEN]
    }

    fn sample_head() -> VaultHead {
        VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V1,
            account_number_hash: [0x11; VAULT_HEAD_ACCOUNT_HASH_LEN],
            manifest_hash: [0x22; VAULT_HEAD_MANIFEST_HASH_LEN],
            seq: 1,
            prev_head_hash: vec![],
            version_vector: vec![VvEntry {
                device_id: dev(0xAA),
                counter: 1,
            }],
        }
    }

    #[test]
    fn fingerprint_is_deterministic_and_well_formed() {
        let id = [0x42u8; HEAD_ID_LEN];
        let fp = head_fingerprint(&id);
        assert_eq!(
            fp,
            head_fingerprint(&id),
            "fingerprint must be deterministic"
        );
        // Format: XXXX-XXXX (9 chars, dash at index 4, Crockford alphabet).
        assert_eq!(fp.len(), HEAD_FINGERPRINT_CHARS + 1);
        assert_eq!(fp.as_bytes()[4], b'-');
        const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        for (i, c) in fp.bytes().enumerate() {
            if i == 4 {
                continue;
            }
            assert!(
                CROCKFORD.contains(&c),
                "char {c:?} not in Crockford alphabet"
            );
        }
    }

    #[test]
    fn fingerprint_differs_for_different_heads_and_is_not_raw_head_id() {
        let a = head_fingerprint(&[0x01u8; HEAD_ID_LEN]);
        let b = head_fingerprint(&[0x02u8; HEAD_ID_LEN]);
        assert_ne!(a, b, "distinct head_ids should give distinct fingerprints");
        // Domain separation: the fingerprint is NOT a prefix of the raw head_id hex.
        let raw_prefix = "01010101";
        assert_ne!(a.replace('-', ""), raw_prefix);
    }

    #[test]
    fn domain_prefix_is_load_bearing_constant() {
        assert_eq!(VAULT_HEAD_DOMAIN_PREFIX, b"myne.v0.1|");
        assert_eq!(VAULT_HEAD_DOMAIN_PREFIX.len(), 10);
    }

    #[test]
    fn genesis_roundtrips() {
        let root = [0x42; 32];
        let h = sample_head();
        let sealed = h.seal(&root).unwrap();
        let decoded = open_vault_head(&root, &sealed.record).unwrap();
        assert_eq!(decoded, h);
        // head_id is SHA-256 of the full record.
        assert_eq!(sealed.head_id, compute_head_id(&sealed.record));
    }

    #[test]
    fn merge_parents_are_byte_sorted_on_encode() {
        let root = [0x7; 32];
        let mut h = sample_head();
        // Two parents supplied OUT of order; encode must sort them.
        h.prev_head_hash = vec![[0xFF; HEAD_ID_LEN], [0x00; HEAD_ID_LEN]];
        h.version_vector = vec![
            VvEntry {
                device_id: dev(0xBB),
                counter: 2,
            },
            VvEntry {
                device_id: dev(0xAA),
                counter: 3,
            },
        ];
        let sealed = h.seal(&root).unwrap();
        let decoded = open_vault_head(&root, &sealed.record).unwrap();
        assert_eq!(decoded.prev_head_hash[0], [0x00; HEAD_ID_LEN]);
        assert_eq!(decoded.prev_head_hash[1], [0xFF; HEAD_ID_LEN]);
        // VV came back sorted by device_id (0xAA before 0xBB).
        assert_eq!(decoded.version_vector[0].device_id, dev(0xAA));
    }

    #[test]
    fn tampered_mac_is_rejected() {
        let root = [0x9; 32];
        let mut sealed = sample_head().seal(&root).unwrap();
        let last = sealed.record.len() - 1;
        sealed.record[last] ^= 0x01;
        assert_eq!(
            open_vault_head(&root, &sealed.record),
            Err(VaultHeadError::MacMismatch)
        );
    }

    #[test]
    fn wrong_root_key_is_rejected() {
        let sealed = sample_head().seal(&[0x1; 32]).unwrap();
        assert_eq!(
            open_vault_head(&[0x2; 32], &sealed.record),
            Err(VaultHeadError::MacMismatch)
        );
    }

    #[test]
    fn dominance_three_cases_plus_bootstrap() {
        let base = vec![
            VvEntry {
                device_id: dev(1),
                counter: 2,
            },
            VvEntry {
                device_id: dev(2),
                counter: 2,
            },
        ];
        // extension: both ≥, one strictly greater.
        let ext = vec![
            VvEntry {
                device_id: dev(1),
                counter: 3,
            },
            VvEntry {
                device_id: dev(2),
                counter: 2,
            },
        ];
        assert_eq!(vv_dominance(&base, &ext), Dominance::Extension);
        // rollback: a component decreased.
        let rb = vec![
            VvEntry {
                device_id: dev(1),
                counter: 1,
            },
            VvEntry {
                device_id: dev(2),
                counter: 2,
            },
        ];
        assert_eq!(vv_dominance(&base, &rb), Dominance::Rollback);
        // incomparable: one up, one down.
        let inc = vec![
            VvEntry {
                device_id: dev(1),
                counter: 3,
            },
            VvEntry {
                device_id: dev(2),
                counter: 1,
            },
        ];
        assert_eq!(vv_dominance(&base, &inc), Dominance::Incomparable);
        // bootstrap: empty baseline.
        assert_eq!(vv_dominance(&[], &ext), Dominance::BootstrapTofu);
    }

    #[test]
    fn head_state_roundtrips_and_rejects_bad_magic() {
        let root = [0x55; 32];
        let sealed = sample_head().seal(&root).unwrap();
        let blob = encode_head_state(&sealed, VAULT_HEAD_FORMAT_V1);
        let decoded = decode_head_state(&root, &blob).unwrap();
        assert_eq!(decoded, sample_head());
        let mut bad = blob.clone();
        bad[0] ^= 0xFF;
        assert_eq!(
            decode_head_state(&root, &bad),
            Err(VaultHeadError::StateMagicMismatch)
        );
    }

    // ---- Golden-vector regenerator (companion repo) -----------------------

    /// Emits `myne-test-vectors/vectors/vault-head/v0.1/cases.json` to
    /// `/tmp/myne_vault_head_vectors.json`, ready to copy verbatim (MYND-418).
    ///
    /// `#[ignore]` — regenerating vectors is a deliberate act. Run with:
    /// `cargo test -p protocol --lib emit_vault_head_vectors_for_paste -- --ignored`
    ///
    /// Cases (self-asserting at mint): 4 `encode` (genesis / linear / merge —
    /// parents + VV supplied UNSORTED to pin the G2/G1 canonical sort / a
    /// tombstone-bearing manifest) + 4 `verify` (the §5.3 outcomes
    /// extension / rollback / incomparable_merge / bootstrap_tofu — whose
    /// genesis→linear→merge VV progression is the "CAS version transition"
    /// the ticket asks for).
    #[test]
    #[ignore]
    fn emit_vault_head_vectors_for_paste() {
        extern crate std;
        use alloc::string::String;

        fn hex(bytes: &[u8]) -> String {
            let mut s = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }
        fn vv_json(entries: &[VvEntry]) -> String {
            let mut s = String::from("[");
            for (i, e) in entries.iter().enumerate() {
                if i > 0 {
                    s.push_str(", ");
                }
                s.push_str(&alloc::format!(
                    "{{ \"input_device_id_hex\": \"{}\", \"counter\": {} }}",
                    hex(&e.device_id),
                    e.counter
                ));
            }
            s.push(']');
            s
        }
        fn arr_hex(items: &[[u8; HEAD_ID_LEN]]) -> String {
            let mut s = String::from("[");
            for (i, it) in items.iter().enumerate() {
                if i > 0 {
                    s.push_str(", ");
                }
                s.push_str(&alloc::format!("\"{}\"", hex(it)));
            }
            s.push(']');
            s
        }

        let root = [0x42u8; 32];
        let account = [0x33u8; 16];
        let dev_a = [0xA1u8; DEVICE_ID_LEN];
        let dev_b = [0xB2u8; DEVICE_ID_LEN];
        let parent1 = [0x11u8; HEAD_ID_LEN];
        let parent2 = [0x22u8; HEAD_ID_LEN];
        // Tombstone-bearing manifest: SHA-256 over a canonical uuid→content_nonce
        // map that includes a `deleted`-version entry (represented as the head's
        // committed manifest_hash; the head commits the hash, not the map).
        let manifest_tomb = compute_head_id(b"manifest{note-A:cn1, note-B:cn-deleted}");

        // --- encode cases ---
        struct Enc {
            slug: &'static str,
            desc: &'static str,
            manifest: [u8; 32],
            seq: u64,
            parents: Vec<[u8; HEAD_ID_LEN]>,
            vv: Vec<VvEntry>,
            author: [u8; DEVICE_ID_LEN],
        }
        let encs = vec![
            Enc {
                slug: "encode-genesis",
                desc: "Genesis head: parent_count=0, VV={A:1}, seq=1. The first head a device authors at first sync; author A's component is 1.",
                manifest: [0x55u8; 32],
                seq: 1,
                parents: vec![],
                vv: vec![VvEntry { device_id: dev_a, counter: 1 }],
                author: dev_a,
            },
            Enc {
                slug: "encode-linear",
                desc: "Linear extension: parent_count=1, VV={A:2}, seq=2. Author A advances its own component 1→2 over a single parent.",
                manifest: [0x66u8; 32],
                seq: 2,
                parents: vec![parent1],
                vv: vec![VvEntry { device_id: dev_a, counter: 2 }],
                author: dev_a,
            },
            Enc {
                slug: "encode-merge-unsorted-inputs",
                desc: "Two-parent merge. Parents supplied UNSORTED ([parent2, parent1]) to pin the G2 lexicographic byte-sort, and the VV supplied UNSORTED ({B:2}, {A:3}) to pin the G1 device_id sort. Author A: componentwise-max(parents)+1. expected_head_mac_input_hex reflects the canonical (sorted) order.",
                manifest: [0x77u8; 32],
                seq: 4,
                parents: vec![parent2, parent1],
                vv: vec![
                    VvEntry { device_id: dev_b, counter: 2 },
                    VvEntry { device_id: dev_a, counter: 3 },
                ],
                author: dev_a,
            },
            Enc {
                slug: "encode-tombstone-manifest",
                desc: "Linear head whose manifest_hash commits a manifest containing a `deleted`-version content_nonce (a tombstone record, sync-protocol.md §4.2/§11). The head commits SHA-256(manifest), so a tombstone is just a manifest_hash input here.",
                manifest: manifest_tomb,
                seq: 3,
                parents: vec![parent1],
                vv: vec![VvEntry { device_id: dev_a, counter: 2 }],
                author: dev_a,
            },
        ];

        // --- verify cases ---
        struct Ver {
            slug: &'static str,
            desc: &'static str,
            baseline: Vec<VvEntry>,
            candidate: Vec<VvEntry>,
            decision: &'static str,
        }
        let base = vec![
            VvEntry {
                device_id: dev_a,
                counter: 2,
            },
            VvEntry {
                device_id: dev_b,
                counter: 2,
            },
        ];
        let vers = vec![
            Ver {
                slug: "verify-extension",
                desc: "Candidate ≥ baseline componentwise (A:2→3, B:2) → extension (accept).",
                baseline: base.clone(),
                candidate: vec![
                    VvEntry { device_id: dev_a, counter: 3 },
                    VvEntry { device_id: dev_b, counter: 2 },
                ],
                decision: "extension",
            },
            Ver {
                slug: "verify-rollback",
                desc: "Candidate strictly behind (A:2→1, B:2, none increased) → rollback (reject).",
                baseline: base.clone(),
                candidate: vec![
                    VvEntry { device_id: dev_a, counter: 1 },
                    VvEntry { device_id: dev_b, counter: 2 },
                ],
                decision: "rollback",
            },
            Ver {
                slug: "verify-incomparable-merge",
                desc: "Candidate incomparable (A:2→3 up, B:2→1 down) → concurrent; the device authors a merge head.",
                baseline: base.clone(),
                candidate: vec![
                    VvEntry { device_id: dev_a, counter: 3 },
                    VvEntry { device_id: dev_b, counter: 1 },
                ],
                decision: "incomparable_merge",
            },
            Ver {
                slug: "verify-bootstrap-tofu",
                desc: "Empty baseline (fresh/reset device) → trust-on-first-use bootstrap (§6), not a dominance result.",
                baseline: vec![],
                candidate: base.clone(),
                decision: "bootstrap_tofu",
            },
        ];

        let mut out = String::new();
        out.push_str("{\n");
        out.push_str("  \"schema\": \"vault-head\",\n");
        out.push_str("  \"protocol_version\": \"v0.1\",\n");
        out.push_str("  \"spec_section\": \"sync-protocol.md §3-§5 + protocol.md §3.4\",\n");
        out.push_str("  \"description\": \"Pins the protocol::vault_head encoding (head_mac_input, head_mac, head_id; G1 version-vector sort, G2 lexicographic merge-parent sort) and the §5.3 VV-dominance decision, for Rust↔Go bit-identical validation. Vectors generated by `cargo test -p protocol --lib emit_vault_head_vectors_for_paste -- --ignored`.\",\n");
        out.push_str("  \"cases\": [\n");

        let total = encs.len() + vers.len();
        let mut n = 0usize;

        for e in &encs {
            let head = VaultHead {
                head_format_version: VAULT_HEAD_FORMAT_V1,
                account_number_hash: account,
                manifest_hash: e.manifest,
                seq: e.seq,
                prev_head_hash: e.parents.clone(),
                version_vector: e.vv.clone(),
            };
            let sealed = head.seal(&root).expect("seal");
            let mac_input = head.encode_mac_input().expect("encode");
            let mac = &sealed.record[sealed.record.len() - HEAD_MAC_LEN..];
            let mac_key = derive_subkey(&root, SubkeyRole::VaultHeadMac);

            out.push_str("    {\n");
            out.push_str(&alloc::format!(
                "      \"vector_id\": \"vault-head/v0.1/{}\",\n",
                e.slug
            ));
            out.push_str(&alloc::format!("      \"description\": \"{}\",\n", e.desc));
            out.push_str("      \"case_kind\": \"encode\",\n");
            out.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                hex(&root)
            ));
            out.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                hex(&account)
            ));
            out.push_str("      \"input_head_format_version\": 1,\n");
            out.push_str(&alloc::format!(
                "      \"input_manifest_hash_hex\": \"{}\",\n",
                hex(&e.manifest)
            ));
            out.push_str(&alloc::format!("      \"input_seq\": {},\n", e.seq));
            out.push_str(&alloc::format!(
                "      \"input_parent_count\": {},\n",
                e.parents.len()
            ));
            out.push_str(&alloc::format!(
                "      \"input_prev_head_hash_hex\": {},\n",
                arr_hex(&e.parents)
            ));
            out.push_str(&alloc::format!(
                "      \"input_version_vector\": {},\n",
                vv_json(&e.vv)
            ));
            out.push_str(&alloc::format!(
                "      \"input_author_device_id_hex\": \"{}\",\n",
                hex(&e.author)
            ));
            out.push_str(&alloc::format!(
                "      \"informational_head_mac_key_hex\": \"{}\",\n",
                hex(mac_key.as_slice())
            ));
            out.push_str(&alloc::format!(
                "      \"expected_head_mac_input_hex\": \"{}\",\n",
                hex(&mac_input)
            ));
            out.push_str(&alloc::format!(
                "      \"expected_head_mac_hex\": \"{}\",\n",
                hex(mac)
            ));
            out.push_str(&alloc::format!(
                "      \"expected_head_id_hex\": \"{}\"\n",
                hex(&sealed.head_id)
            ));
            n += 1;
            out.push_str(if n < total { "    },\n" } else { "    }\n" });
        }

        for v in &vers {
            out.push_str("    {\n");
            out.push_str(&alloc::format!(
                "      \"vector_id\": \"vault-head/v0.1/{}\",\n",
                v.slug
            ));
            out.push_str(&alloc::format!("      \"description\": \"{}\",\n", v.desc));
            out.push_str("      \"case_kind\": \"verify\",\n");
            out.push_str(&alloc::format!(
                "      \"input_baseline_version_vector\": {},\n",
                vv_json(&v.baseline)
            ));
            out.push_str(&alloc::format!(
                "      \"input_candidate_version_vector\": {},\n",
                vv_json(&v.candidate)
            ));
            out.push_str(&alloc::format!(
                "      \"expected_decision\": \"{}\"\n",
                v.decision
            ));
            n += 1;
            out.push_str(if n < total { "    },\n" } else { "    }\n" });
        }

        out.push_str("  ]\n");
        out.push_str("}\n");

        std::fs::write("/tmp/myne_vault_head_vectors.json", out.as_bytes())
            .expect("write vault-head vectors dump");
    }

    /// Emits `myne-test-vectors/vectors/vault-head-state/v0.1/cases.json` to
    /// `/tmp/myne_vault_head_state_vectors.json`, ready to copy verbatim.
    ///
    /// `#[ignore]` — regenerating vectors is a deliberate act. Run with:
    /// `cargo test -p protocol --lib emit_head_state_vectors_for_paste -- --ignored`
    ///
    /// Pins the **`MYH1` device-local baseline envelope** (`protocol.md` §9.16),
    /// which is a different surface from the sibling `vault-head` family: that
    /// one pins the magic-less **sync-wire** head (`head_mac_input`, `head_mac`,
    /// `head_id`, VV dominance, `sync-protocol.md` §3–§5), while this one pins
    /// the 6-byte header a device wraps around that record before writing it to
    /// disk. `MYH1` is the one §10.3 blob family that is **not AEAD-encrypted**
    /// — integrity is the head's own MAC, re-verified on load — so there is no
    /// `decrypt_aead_fail` shape here; the MAC surface gets its own `mac_fail`
    /// case_kind instead.
    ///
    /// 9 cases: 3 `encode` (genesis / linear / merge — the same head shapes the
    /// wire family pins, now wrapped in the baseline header) + 1 `decode_ok` +
    /// 1 `mac_fail` (tampered `head_mac`) + 4 `parse_fail` (one per
    /// distinguishable pre-MAC reject of `decode_head_state`:
    /// `state_magic_mismatch`, `protocol_version_mismatch`, `format_unsupported`,
    /// `record_too_short`).
    #[test]
    #[ignore]
    fn emit_head_state_vectors_for_paste() {
        extern crate std;
        use alloc::string::String;

        fn hex(bytes: &[u8]) -> String {
            let mut s = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }
        fn vv_json(entries: &[VvEntry]) -> String {
            let mut s = String::from("[");
            for (i, e) in entries.iter().enumerate() {
                if i > 0 {
                    s.push_str(", ");
                }
                s.push_str(&alloc::format!(
                    "{{ \"input_device_id_hex\": \"{}\", \"counter\": {} }}",
                    hex(&e.device_id),
                    e.counter
                ));
            }
            s.push(']');
            s
        }
        fn arr_hex(items: &[[u8; HEAD_ID_LEN]]) -> String {
            let mut s = String::from("[");
            for (i, it) in items.iter().enumerate() {
                if i > 0 {
                    s.push_str(", ");
                }
                s.push_str(&alloc::format!("\"{}\"", hex(it)));
            }
            s.push(']');
            s
        }

        // Same fixture bytes as the wire `vault-head` family, so a reviewer can
        // line the two files up field by field and see exactly what the MYH1
        // header adds.
        let root = [0x42u8; 32];
        let account = [0x33u8; 16];
        let dev_a = [0xA1u8; DEVICE_ID_LEN];
        let dev_b = [0xB2u8; DEVICE_ID_LEN];
        let parent1 = [0x11u8; HEAD_ID_LEN];
        let parent2 = [0x22u8; HEAD_ID_LEN];

        struct Enc {
            slug: &'static str,
            desc: &'static str,
            manifest: [u8; 32],
            seq: u64,
            parents: Vec<[u8; HEAD_ID_LEN]>,
            vv: Vec<VvEntry>,
        }
        let encs = vec![
            Enc {
                slug: "encode-genesis",
                desc: "Genesis head wrapped as an MYH1 baseline: parent_count=0, VV={A:1}, seq=1. Pins the 6-byte header (MYH1 || 0x01 || 0x01) prepended to the sealed wire record — the smallest baseline a device can persist.",
                manifest: [0x55u8; 32],
                seq: 1,
                parents: vec![],
                vv: vec![VvEntry { device_id: dev_a, counter: 1 }],
            },
            Enc {
                slug: "encode-linear",
                desc: "Linear successor wrapped as an MYH1 baseline: one parent, VV={A:2,B:1}, seq=2. Pins that the baseline header is a pure prefix — the trailing bytes are the wire record verbatim, including the G1 device_id-sorted version vector.",
                manifest: [0x66u8; 32],
                seq: 2,
                parents: vec![parent1],
                vv: vec![
                    VvEntry { device_id: dev_b, counter: 1 },
                    VvEntry { device_id: dev_a, counter: 2 },
                ],
            },
            Enc {
                slug: "encode-merge",
                desc: "Merge head wrapped as an MYH1 baseline: two parents supplied UNSORTED (parent2 before parent1), VV={A:3,B:2}, seq=3. Pins that the G2 lexicographic merge-parent sort still applies underneath the baseline header — the envelope never re-orders or re-canonicalizes the record it wraps.",
                manifest: [0x77u8; 32],
                seq: 3,
                parents: vec![parent2, parent1],
                vv: vec![
                    VvEntry { device_id: dev_b, counter: 2 },
                    VvEntry { device_id: dev_a, counter: 3 },
                ],
            },
        ];

        // The blob every decode-side case starts from (the genesis baseline).
        let genesis_head = VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V1,
            account_number_hash: account,
            manifest_hash: [0x55u8; 32],
            seq: 1,
            prev_head_hash: vec![],
            version_vector: vec![VvEntry {
                device_id: dev_a,
                counter: 1,
            }],
        };
        let genesis_sealed = genesis_head.seal(&root).expect("seal");
        let genesis_blob = encode_head_state(&genesis_sealed, VAULT_HEAD_FORMAT_V1);

        // Self-assert at mint: the fixtures below must actually produce the
        // rejects they claim, so a broken generator cannot ship a vector that
        // pins the wrong error.
        let mut mac_tampered = genesis_blob.clone();
        let last = mac_tampered.len() - 1;
        mac_tampered[last] ^= 0x01;
        assert_eq!(
            decode_head_state(&root, &mac_tampered),
            Err(VaultHeadError::MacMismatch)
        );

        let mut bad_magic = genesis_blob.clone();
        bad_magic[0] ^= 0xFF;
        assert_eq!(
            decode_head_state(&root, &bad_magic),
            Err(VaultHeadError::StateMagicMismatch)
        );

        let mut bad_version = genesis_blob.clone();
        bad_version[4] = 0x02;
        assert_eq!(
            decode_head_state(&root, &bad_version),
            Err(VaultHeadError::ProtocolVersionMismatch)
        );

        let mut bad_format = genesis_blob.clone();
        bad_format[5] = 0x02;
        assert_eq!(
            decode_head_state(&root, &bad_format),
            Err(VaultHeadError::FormatUnsupported)
        );

        // Five bytes: shorter than the 6-byte header, so the length guard fires
        // before the magic comparison ever reads blob[0..4].
        let too_short = genesis_blob[..5].to_vec();
        assert_eq!(
            decode_head_state(&root, &too_short),
            Err(VaultHeadError::RecordTooShort)
        );

        struct Fail {
            slug: &'static str,
            desc: &'static str,
            kind: &'static str,
            blob: Vec<u8>,
            expected_error: &'static str,
        }
        let fails = vec![
            Fail {
                slug: "mac-fail-tampered-head-mac",
                desc: "Final byte of the trailing head_mac flipped. The baseline is NOT AEAD-encrypted, so the reject comes from the head's own HMAC-SHA-256 verification under DeriveSubkey(root_key, 'vault-head-mac') — a distinguishable MacMismatch, not a non-distinguishing AEAD failure. This is the load-bearing property of the MYH1 family: integrity without confidentiality, because the record is bytes the server already relays.",
                kind: "mac_fail",
                blob: mac_tampered.clone(),
                expected_error: "mac_mismatch",
            },
            Fail {
                slug: "parse-fail-state-magic-mismatch",
                desc: "First magic byte flipped ('MYH1' -> 0xB2 'YH1'). Rejected before any MAC computation — the §10.3 magic-byte-before-verify discipline applied to the one non-AEAD family.",
                kind: "parse_fail",
                blob: bad_magic.clone(),
                expected_error: "state_magic_mismatch",
            },
            Fail {
                slug: "parse-fail-protocol-version-mismatch",
                desc: "protocol_version byte at offset 4 set to 0x02. v0.1 and a later major version are forward-incompatible by design: a decoder MUST reject rather than attempt a best-effort parse.",
                kind: "parse_fail",
                blob: bad_version.clone(),
                expected_error: "protocol_version_mismatch",
            },
            Fail {
                slug: "parse-fail-format-unsupported",
                desc: "head_format_version byte at offset 5 set to 0x02. The load-bearing forward hook: a future head format bumps this so a v0.1-only client rejects cleanly and re-bootstraps its baseline from the server rather than mis-parsing a newer record.",
                kind: "parse_fail",
                blob: bad_format.clone(),
                expected_error: "format_unsupported",
            },
            Fail {
                slug: "parse-fail-record-too-short",
                desc: "Five bytes — one short of the 6-byte header. The length guard MUST fire before the magic comparison, so a port that indexes blob[0..4] first panics here instead of returning an error.",
                kind: "parse_fail",
                blob: too_short.clone(),
                expected_error: "record_too_short",
            },
        ];

        let mut out = String::new();
        out.push_str("{\n");
        out.push_str("  \"schema\": \"vault-head-state\",\n");
        out.push_str("  \"protocol_version\": \"v0.1\",\n");
        out.push_str("  \"spec_section\": \"protocol.md §9.16 + §3.4 + sync-protocol.md §3\",\n");
        out.push_str("  \"description\": \"Pins protocol::encode_head_state + protocol::decode_head_state — the MYH1 vault.head-state device-local sync baseline (§9.16). The envelope is magic (MYH1) || protocol_version (0x01) || head_format_version (0x01) || the sealed wire record (head_mac_input || head_mac) that the sibling vault-head family pins in isolation. UNIQUE among the §10.3 blob families: NOT AEAD-encrypted — the bytes are exactly the head the server already relays, and integrity is the head's own HMAC-SHA-256 under DeriveSubkey(root_key, SubkeyRole::VaultHeadMac), re-verified on load. So there is no decrypt_aead_fail shape: the MAC surface is its own distinguishable mac_fail case_kind, and the structural rejects stay under parse_fail. 9 cases: 3 encode (genesis / linear / merge) + 1 decode_ok + 1 mac_fail + 4 parse_fail. Cases generated by `cargo test -p protocol --lib emit_head_state_vectors_for_paste -- --ignored` (in protocol/src/vault_head.rs).\",\n");
        out.push_str("  \"cases\": [\n");

        let total = encs.len() + 1 + fails.len();
        let mut n = 0usize;

        for e in &encs {
            let head = VaultHead {
                head_format_version: VAULT_HEAD_FORMAT_V1,
                account_number_hash: account,
                manifest_hash: e.manifest,
                seq: e.seq,
                prev_head_hash: e.parents.clone(),
                version_vector: e.vv.clone(),
            };
            let sealed = head.seal(&root).expect("seal");
            let blob = encode_head_state(&sealed, VAULT_HEAD_FORMAT_V1);
            let mac_key = derive_subkey(&root, SubkeyRole::VaultHeadMac);

            out.push_str("    {\n");
            out.push_str(&alloc::format!(
                "      \"vector_id\": \"vault-head-state/v0.1/{}\",\n",
                e.slug
            ));
            out.push_str(&alloc::format!("      \"description\": \"{}\",\n", e.desc));
            out.push_str("      \"case_kind\": \"encode\",\n");
            out.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                hex(&root)
            ));
            out.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                hex(&account)
            ));
            out.push_str("      \"input_head_format_version\": 1,\n");
            out.push_str(&alloc::format!(
                "      \"input_manifest_hash_hex\": \"{}\",\n",
                hex(&e.manifest)
            ));
            out.push_str(&alloc::format!("      \"input_seq\": {},\n", e.seq));
            out.push_str(&alloc::format!(
                "      \"input_parent_count\": {},\n",
                e.parents.len()
            ));
            out.push_str(&alloc::format!(
                "      \"input_prev_head_hash_hex\": {},\n",
                arr_hex(&e.parents)
            ));
            out.push_str(&alloc::format!(
                "      \"input_version_vector\": {},\n",
                vv_json(&e.vv)
            ));
            out.push_str(&alloc::format!(
                "      \"informational_head_mac_key_hex\": \"{}\",\n",
                hex(&*mac_key)
            ));
            out.push_str(&alloc::format!(
                "      \"informational_head_id_hex\": \"{}\",\n",
                hex(&sealed.head_id)
            ));
            out.push_str(&alloc::format!(
                "      \"expected_head_state_blob_hex\": \"{}\"\n",
                hex(&blob)
            ));
            n += 1;
            out.push_str(if n < total { "    },\n" } else { "    }\n" });
        }

        // decode_ok — the genesis baseline round-trips back to the same head.
        out.push_str("    {\n");
        out.push_str("      \"vector_id\": \"vault-head-state/v0.1/decode-ok-genesis\",\n");
        out.push_str("      \"description\": \"Round-trip of the genesis baseline: strip the 6-byte header, re-verify the head_mac under DeriveSubkey(root_key, 'vault-head-mac'), and recover every field. A port that recovers the fields but skips MAC verification passes this case and fails mac-fail-tampered-head-mac — the pair is what makes verification non-optional.\",\n");
        out.push_str("      \"case_kind\": \"decode_ok\",\n");
        out.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex(&genesis_blob)
        ));
        out.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex(&root)
        ));
        out.push_str("      \"expected_head_format_version\": 1,\n");
        out.push_str(&alloc::format!(
            "      \"expected_account_number_hash_hex\": \"{}\",\n",
            hex(&account)
        ));
        out.push_str(&alloc::format!(
            "      \"expected_manifest_hash_hex\": \"{}\",\n",
            hex(&genesis_head.manifest_hash)
        ));
        out.push_str(&alloc::format!(
            "      \"expected_seq\": {},\n",
            genesis_head.seq
        ));
        out.push_str(&alloc::format!(
            "      \"expected_prev_head_hash_hex\": {},\n",
            arr_hex(&genesis_head.prev_head_hash)
        ));
        out.push_str(&alloc::format!(
            "      \"expected_version_vector\": {},\n",
            vv_json(&genesis_head.version_vector)
        ));
        out.push_str(&alloc::format!(
            "      \"informational_head_id_hex\": \"{}\"\n",
            hex(&genesis_sealed.head_id)
        ));
        n += 1;
        out.push_str(if n < total { "    },\n" } else { "    }\n" });

        for f in &fails {
            out.push_str("    {\n");
            out.push_str(&alloc::format!(
                "      \"vector_id\": \"vault-head-state/v0.1/{}\",\n",
                f.slug
            ));
            out.push_str(&alloc::format!("      \"description\": \"{}\",\n", f.desc));
            out.push_str(&alloc::format!("      \"case_kind\": \"{}\",\n", f.kind));
            out.push_str(&alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex(&f.blob)
            ));
            out.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                hex(&root)
            ));
            out.push_str(&alloc::format!(
                "      \"expected_error\": \"{}\"\n",
                f.expected_error
            ));
            n += 1;
            out.push_str(if n < total { "    },\n" } else { "    }\n" });
        }

        out.push_str("  ]\n");
        out.push_str("}\n");

        std::fs::write("/tmp/myne_vault_head_state_vectors.json", out.as_bytes())
            .expect("write vault-head-state vectors dump");
    }

    /// A minimal deterministic RNG for the signed-head test.
    struct TestRng(u64);
    impl rand_core::TryRng for TestRng {
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
    impl rand_core::TryCryptoRng for TestRng {}

    #[test]
    fn signed_head_round_trips_and_rejects_a_wrong_signer() {
        use crate::person_key::PersonKeyPair;
        let author = PersonKeyPair::generate_raw(&[1u8; 64], &[2u8; 32], &[3u8; 32]);
        let other = PersonKeyPair::generate_raw(&[4u8; 64], &[5u8; 32], &[6u8; 32]);
        let mut account = [0u8; VAULT_HEAD_ACCOUNT_HASH_LEN];
        account[0] = 7;
        let author_id = head_author_id(&author.public_half(), &account);
        let head = VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V2,
            account_number_hash: account,
            manifest_hash: [9u8; 32],
            seq: 1,
            prev_head_hash: vec![],
            version_vector: vec![VvEntry {
                device_id: [1u8; DEVICE_ID_LEN],
                counter: 1,
            }],
        };
        let mut rng = TestRng(0);
        let sealed = sign_vault_head(&head, &author_id, &author, &mut rng).expect("sign");
        assert_eq!(sealed.head_id, compute_head_id(&sealed.record));

        let (opened, resolved) =
            open_signed_vault_head(&sealed.record, &[author.public_half()], &account)
                .expect("open");
        assert_eq!(resolved, author_id);
        assert_eq!(opened, head);

        // A roster without the author cannot resolve the signer.
        assert!(matches!(
            open_signed_vault_head(&sealed.record, &[other.public_half()], &account),
            Err(VaultHeadError::AuthorUnknown)
        ));

        // A different vault id changes the author id, so the same signature does
        // not resolve: no cross-vault author linkage.
        let mut other_vault = account;
        other_vault[0] ^= 1;
        assert!(matches!(
            open_signed_vault_head(&sealed.record, &[author.public_half()], &other_vault),
            Err(VaultHeadError::AuthorUnknown)
        ));

        // Tampering the canonical bytes breaks the signature.
        let mut tampered = sealed.record.clone();
        let n = tampered.len();
        tampered[n - 1] ^= 1;
        assert!(matches!(
            open_signed_vault_head(&tampered, &[author.public_half()], &account),
            Err(VaultHeadError::SignatureMismatch)
        ));

        // Cross-class replay: the same signature under another class prefix
        // (the roster class) does not verify, because the prefix is inside the
        // signed bytes.
        let sig_len =
            crate::person_key::PERSON_ED25519_SIG_LEN + crate::person_key::PERSON_MLDSA_SIG_LEN;
        let mut ed25519_sig = [0u8; crate::person_key::PERSON_ED25519_SIG_LEN];
        ed25519_sig.copy_from_slice(&sealed.record[..crate::person_key::PERSON_ED25519_SIG_LEN]);
        let mldsa_sig = sealed.record[crate::person_key::PERSON_ED25519_SIG_LEN..sig_len].to_vec();
        let canonical = &sealed.record[sig_len + HEAD_AUTHOR_ID_LEN..];
        let mut wrong_class = Vec::new();
        wrong_class.extend_from_slice(crate::person_invite::GROUP_ROSTER_PREFIX);
        wrong_class.extend_from_slice(&author_id);
        wrong_class.extend_from_slice(canonical);
        assert!(author
            .public_half()
            .verify(
                &wrong_class,
                &crate::person_key::PersonSigned {
                    ed25519_sig,
                    mldsa_sig,
                },
            )
            .is_err());
    }
}
