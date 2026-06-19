// SPDX-License-Identifier: AGPL-3.0-or-later
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
//!   §9.15): it stores the full wire-head TIP and re-verifies the head's own MAC
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
/// §9.15, §10.3).
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
    let mut off = 0usize;
    let p = VAULT_HEAD_DOMAIN_PREFIX.len();
    if &mac_input[off..off + p] != VAULT_HEAD_DOMAIN_PREFIX {
        return Err(VaultHeadError::DomainPrefixMismatch);
    }
    off += p;
    if mac_input[off] != VAULT_HEAD_PROTOCOL_VERSION {
        return Err(VaultHeadError::ProtocolVersionMismatch);
    }
    off += 1;
    let head_format_version = mac_input[off];
    if head_format_version != VAULT_HEAD_FORMAT_V1 {
        return Err(VaultHeadError::FormatUnsupported);
    }
    off += 1;

    let mut account_number_hash = [0u8; VAULT_HEAD_ACCOUNT_HASH_LEN];
    account_number_hash.copy_from_slice(&mac_input[off..off + VAULT_HEAD_ACCOUNT_HASH_LEN]);
    off += VAULT_HEAD_ACCOUNT_HASH_LEN;

    let mut manifest_hash = [0u8; VAULT_HEAD_MANIFEST_HASH_LEN];
    manifest_hash.copy_from_slice(&mac_input[off..off + VAULT_HEAD_MANIFEST_HASH_LEN]);
    off += VAULT_HEAD_MANIFEST_HASH_LEN;

    let mut seq_bytes = [0u8; 8];
    seq_bytes.copy_from_slice(&mac_input[off..off + 8]);
    let seq = u64::from_be_bytes(seq_bytes);
    off += 8;

    let parent_count = mac_input[off];
    off += 1;
    if parent_count > 2 {
        return Err(VaultHeadError::ParentCountInvalid);
    }
    let need_parents = parent_count as usize * HEAD_ID_LEN;
    if mac_input.len() < off + need_parents + 4 {
        return Err(VaultHeadError::RecordTooShort);
    }
    let mut prev_head_hash = Vec::with_capacity(parent_count as usize);
    for _ in 0..parent_count {
        let mut h = [0u8; HEAD_ID_LEN];
        h.copy_from_slice(&mac_input[off..off + HEAD_ID_LEN]);
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
    vvlen_bytes.copy_from_slice(&mac_input[off..off + 4]);
    let vv_len = u32::from_be_bytes(vvlen_bytes) as usize;
    off += 4;
    if mac_input.len() != off + vv_len {
        return Err(VaultHeadError::TrailingBytes);
    }
    if vv_len < 4 {
        return Err(VaultHeadError::VersionVectorLenInvalid);
    }
    let mut ec_bytes = [0u8; 4];
    ec_bytes.copy_from_slice(&mac_input[off..off + 4]);
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
        device_id.copy_from_slice(&mac_input[off..off + DEVICE_ID_LEN]);
        off += DEVICE_ID_LEN;
        let mut c = [0u8; 8];
        c.copy_from_slice(&mac_input[off..off + 8]);
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

// ---- MYH1 device-local baseline (`protocol.md` §9.15) ----------------------

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
/// bytes, then re-verify the embedded head's own MAC under `root_key` (§9.15).
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
}
