// SPDX-License-Identifier: AGPL-3.0

//! B2B device-to-person bindings: the `MYU5` vault singleton codec
//! (`docs/spec/protocol.md` §9.30; the `member-devices` feature).
//!
//! One blob per shared vault holding a versioned, optionally tombstoned map of
//! `device_id -> { person_fingerprint, version, tombstone }`. The blob is sealed
//! under the GROUP tier, so every member reads every binding and only members read
//! any: `device_binding_key = derive_group_subkey_v0_2(group_key,
//! GroupRole::DeviceBindingKey)`, with the 8-byte `group_key_epoch` bound into the
//! AAD in the `aad_group_roster_blob` order, so a post-rotation blob from a retired
//! epoch fails AEAD verification rather than being read under a key that no longer
//! applies.
//!
//! **This family is `NTV6`-only.** A pre-B2B `NTV5` vault has no `group_key`, so a
//! member-writable, member-readable binding map cannot exist there. It has no
//! `MY?1` form and no `SubkeyRole` counterpart, exactly like the member display-name
//! map it sits beside (`member_names_blob.rs`, §9.29): its one registered role is a
//! [`GroupRole`](crate::subkey::GroupRole), not a root-tier one. A pre-B2B reader
//! MUST reject the file rather than guess a root-tier KEK for it, and a client MUST
//! NOT write one into an `NTV5` vault.
//!
//! ## What the binding is worth, stated plainly
//!
//! The map is group-sealed, so any member can WRITE it: sealing under the group key
//! is what makes every member read every binding, and it is also what stops the seal
//! from being an authority over who bound what. Each row therefore carries a hybrid
//! Ed25519 + ML-DSA-65 signature under the `"myne.device-binding v1|"` class, over the
//! device id and the person the row CLAIMS, verified on read against that person's
//! public half from the roster.
//!
//! **What that is worth.** `docs/decisions/protocol/0660` records that a revision's
//! actor is NOT a signature: anyone who can edit the document can set it. The
//! signature here protects the BINDING RECORD, not the authorship of a note, and the
//! surfaces that render a name from a binding must not imply otherwise. What it buys
//! is that a device cannot be bound to a co-member by anyone but that co-member, so
//! the label a reader sees is the one the named person chose to publish.
//!
//! ## On-disk layout
//!
//! ```text
//! Offset  Size  Field              Notes
//! ------  ----  -----------------  -----------------------------------------
//! 0       4     magic              ASCII "MYU5"
//! 4       1     protocol_version   0x01 (the shared singleton-family byte; the
//!                                  generation domain-separates on magic + AAD
//!                                  prefix + KEK, not on this byte)
//! 5       1     format_version     0x01 = the canonical-JSON map below
//! 6       24    nonce              XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len     big-endian u32, plaintext_len + 32
//! 34      M     ciphertext         AEAD ciphertext + 32-byte CTX tag
//! ```
//!
//! Total = `34 + M`, subject to §10.3.1 strict-trailing: the shared envelope
//! checks it, and this module adds nothing past the ciphertext.
//!
//! ## The inner map, and why the codec owns it
//!
//! The plaintext is a canonical-JSON object whose keys are `device_id` in lowercase
//! hex and whose values are [`DeviceBindingEntry`]. Canonical means the parser
//! re-serializes and requires BYTE EQUALITY with its input, the discipline the
//! owner-signed group roster and the member display-name map already use, so two
//! implementations agree on which byte strings are blobs of this family.
//!
//! The codec owns the map rather than leaving it opaque because the MERGE is
//! cross-implementation: two devices claiming themselves at the same time must
//! converge on the same map on every client, so the tie-break is a contract rather
//! than a client detail. See [`merge_device_bindings`] and [`beats`].
//!
//! A tombstone is KEPT in the blob rather than deleted: dropping it would let a
//! stale copy re-introduce the binding on the next merge. The live view filters
//! tombstones out, exactly as the roster view filters its deleted rows.
//!
//! ## Fall-back-to-empty
//!
//! Like its siblings this module emits honest errors for each failure mode, and
//! [`decode_device_bindings_or_empty`] collapses all of them to the empty map for a
//! caller to whom "no blob", "truncated", "AEAD failure" and "unsupported format"
//! all mean the same thing. The per-error surface is kept as well, because a tampered
//! blob and an absent one must be distinguishable to the code that decides whether to
//! re-upload, and [`decode_device_binding_blob`] is the reader that answers that.
//!
//! **The empty map is a read-only answer.** A caller holding
//! [`decode_device_bindings_or_empty`] cannot tell "no device has claimed itself yet"
//! from "the blob is damaged", so putting one on the read half of a read-modify-write
//! means a damaged blob is replaced by a map carrying only this session's own row.
//! Every other device's binding is dropped, and the dropped rows carry no tombstone,
//! so no later merge can notice: the write succeeds and the map looks authoritatively
//! correct ever after.

use crate::aead::{aad_device_binding_blob, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::blob_envelope::{decode_blob_envelope, encode_blob_envelope, EnvelopeError};
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Magic bytes at offset 0: ASCII `"MYU5"`. Reserved in the same `MY?5` allocation
/// that minted `MYO5` for the member display-name map, from a letter pool that held
/// exactly two letters at that point.
pub const DEVICE_BINDING_BLOB_MAGIC: [u8; 4] = *b"MYU5";

/// AAD role string bound into the seal (§5.2). Distinct from every sibling role so a
/// device-binding blob can never be opened as another family.
pub const DEVICE_BINDING_BLOB_AAD_ROLE: &[u8] = b"device-binding-blob";

/// `format_version` byte at offset 5: the canonical-JSON map schema below. A future
/// revision of the inner schema bumps this so an older decoder rejects cleanly
/// instead of half-parsing.
pub const DEVICE_BINDING_BLOB_FORMAT_V1: u8 = 0x01;

/// The registered message-class prefix every row's signature covers. A signature
/// class, minted whole, so a device-binding signature can never be replayed as a
/// member-name signature, a roster, an invite, a transition or an awareness
/// assertion, nor the reverse.
pub const DEVICE_BINDING_PREFIX: &[u8] = b"myne.device-binding v1|";

/// Signature bytes one row carries: the Ed25519 half then the ML-DSA-65 half.
pub const DEVICE_BINDING_SIGNATURE_LEN: usize =
    crate::person_key::PERSON_ED25519_SIG_LEN + crate::person_key::PERSON_MLDSA_SIG_LEN;

/// The same, hex-encoded (lowercase), which is how the row's JSON carries it.
pub const DEVICE_BINDING_SIGNATURE_HEX_LEN: usize = DEVICE_BINDING_SIGNATURE_LEN * 2;

/// Fixed header length: magic 4 + protocol version 1 + format version 1 + nonce 24
/// + ciphertext length 4.
pub const DEVICE_BINDING_BLOB_HEADER_LEN: usize = 34;

/// Cap on the inner plaintext (the whole map). 4 MiB, the same cap as
/// `vault.member-names` / `vault.themes` / `vault.dictionary`, and sized here by
/// arithmetic rather than by feel: one row is a fingerprint (64 hex chars) plus a
/// hybrid signature hex-encoded at `(64 + 3309) * 2 = 6746` characters, so a row is
/// roughly 6.9 KiB and the cap holds around 600 rows before it binds. It turns a
/// hostile `ciphertext_len` into a clean error rather than an absurd allocation.
pub const MAX_DEVICE_BINDINGS_PLAINTEXT_LEN: usize = 4 * 1024 * 1024;

/// Length of a `device_id` in lowercase hex (`DEVICE_ID_LEN` is 16 raw bytes).
const DEVICE_ID_HEX_LEN: usize = 32;

/// Length of a `person_fingerprint` in lowercase hex (`PERSON_FINGERPRINT_LEN` is 32
/// raw bytes).
const PERSON_FINGERPRINT_HEX_LEN: usize = crate::person_key::PERSON_FINGERPRINT_LEN * 2;

/// One row in the binding map: which person this device belongs to, as of which
/// version, and whether the binding has been removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceBindingEntry {
    /// The fingerprint of the person this device claims to belong to, lowercase hex.
    /// Never empty: a tombstone keeps it, because a tombstone names the binding whose
    /// removal it records (and because the merge refuses a same-version tie between
    /// two DIFFERENT people, which it can only detect while both are present).
    pub person_fingerprint: String,
    /// The row's monotonic version. Two copies where the same device moved resolve by
    /// this, so it is a wall-clock-free counter rather than a timestamp: a clock skew
    /// between devices must not decide which binding wins. A re-bind is a strictly
    /// higher version.
    pub version: u64,
    /// A tombstone removes the binding and WINS at equal version, so a concurrent
    /// re-claim cannot resurrect a device whose person was removed from the vault.
    pub tombstone: bool,
    /// Hybrid Ed25519 + ML-DSA-65 signature over
    /// `"myne.device-binding v1|" || device_id || person_fingerprint || version ||
    /// tombstone`, lowercase hex, produced by the person this row CLAIMS (or, for a
    /// removal, by the vault owner). See [`sign_device_binding`].
    pub signature_hex: String,
}

/// The canonical map: `device_id (lowercase hex) -> row`.
pub type DeviceBindingsMap = BTreeMap<String, DeviceBindingEntry>;

/// Failure modes of the `MYU5` codec. The first nine mirror the shared envelope's
/// surface (a distinguishable variant per structural failure, then the single
/// non-distinguishing decrypt error); the rest are this family's own.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum DeviceBindingBlobError {
    /// Input shorter than [`DEVICE_BINDING_BLOB_HEADER_LEN`].
    #[error("vault.device-bindings blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYU5`.
    #[error("vault.device-bindings blob magic mismatch (expected MYU5)")]
    MagicMismatch,
    /// The `protocol_version` byte is not `0x01`.
    #[error("vault.device-bindings blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// The `format_version` byte is not one this client understands.
    #[error("vault.device-bindings blob format_version unsupported")]
    DeviceBindingFormatUnsupported,
    /// The declared `ciphertext_len` exceeds the map cap.
    #[error("vault.device-bindings blob ciphertext_len overflows the cap")]
    CiphertextLenOverflow,
    /// The declared `ciphertext_len` runs past the end of the input.
    #[error("vault.device-bindings blob ciphertext truncated")]
    CiphertextTruncated,
    /// The AEAD seal did not open. Non-distinguishing by design (§6.4): a wrong key,
    /// a tampered byte and a stale epoch are one answer.
    #[error("vault.device-bindings blob could not be decrypted")]
    CannotDecrypt,
    /// Randomness unavailable while sealing.
    #[error("vault.device-bindings blob randomness unavailable")]
    RandomnessUnavailable,
    /// The plaintext is not a well-formed map (bad JSON, a key that is not a
    /// `device_id`, a fingerprint or signature of the wrong shape).
    #[error("vault.device-bindings map is malformed")]
    MapMalformed,
    /// The plaintext parses but is not the canonical encoding of what it parsed to,
    /// so two implementations would disagree on its bytes.
    #[error("vault.device-bindings map is not canonical")]
    MapNotCanonical,
    /// The `group_key_epoch` bound into the AAD is zero, which no writer produces.
    #[error("vault.device-bindings blob epoch is zero")]
    EpochZero,
    /// The row could not be signed, which means the signer refused (an over-long ctx
    /// or a failing RNG); nothing was written.
    #[error("vault.device-bindings row could not be signed")]
    SignatureUnavailable,
    /// A merge would put one device under two DIFFERENT people at the SAME version.
    /// There is no arm left to separate the pair, and choosing one side would let the
    /// two copies re-push at each other forever, so the merge refuses outright rather
    /// than resolving by argument order.
    #[error("vault.device-bindings map binds one device to two people at the same version")]
    ConflictingBinding,
}

impl From<EnvelopeError> for DeviceBindingBlobError {
    fn from(e: EnvelopeError) -> Self {
        match e {
            EnvelopeError::HeaderTooShort => Self::HeaderTooShort,
            EnvelopeError::MagicMismatch => Self::MagicMismatch,
            EnvelopeError::ProtocolVersionMismatch => Self::ProtocolVersionMismatch,
            EnvelopeError::FormatUnsupported => Self::DeviceBindingFormatUnsupported,
            EnvelopeError::CiphertextLenOverflow => Self::CiphertextLenOverflow,
            EnvelopeError::CiphertextTruncated => Self::CiphertextTruncated,
            EnvelopeError::CannotDecrypt => Self::CannotDecrypt,
            EnvelopeError::PlaintextTooLarge => Self::CiphertextLenOverflow,
            EnvelopeError::RandomnessUnavailable => Self::RandomnessUnavailable,
        }
    }
}

fn is_device_id_hex(s: &str) -> bool {
    s.len() == DEVICE_ID_HEX_LEN && is_lower_hex(s)
}

fn is_fingerprint_hex(s: &str) -> bool {
    s.len() == PERSON_FINGERPRINT_HEX_LEN && is_lower_hex(s)
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn device_id_from_hex(s: &str) -> Option<[u8; 16]> {
    let bytes = hex_bytes(s, 16)?;
    let mut out = [0u8; 16];
    out.copy_from_slice(&bytes);
    Some(out)
}

fn fingerprint_from_hex(s: &str) -> Option<[u8; crate::person_key::PERSON_FINGERPRINT_LEN]> {
    let bytes = hex_bytes(s, crate::person_key::PERSON_FINGERPRINT_LEN)?;
    let mut out = [0u8; crate::person_key::PERSON_FINGERPRINT_LEN];
    out.copy_from_slice(&bytes);
    Some(out)
}

/// Decode exactly `byte_len` bytes of lowercase hex, or `None`.
fn hex_bytes(s: &str, byte_len: usize) -> Option<Vec<u8>> {
    if s.len() != byte_len * 2 || !is_lower_hex(s) {
        return None;
    }
    let raw = s.as_bytes();
    let mut out = Vec::with_capacity(byte_len);
    for pair in raw.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)? as u8;
        let lo = (pair[1] as char).to_digit(16)? as u8;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

/// Lowercase hex, the rendering every id and signature in this family uses.
fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn is_hex_len(s: &str, byte_len: usize) -> bool {
    s.len() == byte_len * 2 && is_lower_hex(s)
}

/// Validate one row against the family's rules.
fn valid_entry(entry: &DeviceBindingEntry) -> bool {
    // Every row, tombstone included, carries a fingerprint and a structurally
    // well-formed signature. This layer is STRUCTURAL: whether the signature is the
    // RIGHT one is [`verify_device_binding`]'s question, and whether the fingerprint
    // is a real member's is the roster's.
    is_fingerprint_hex(&entry.person_fingerprint)
        && is_hex_len(&entry.signature_hex, DEVICE_BINDING_SIGNATURE_LEN)
}

/// The canonical bytes of a map: `serde_json` over a `BTreeMap` (keys in byte order)
/// with the struct's fields in declaration order.
pub fn encode_device_bindings_map(
    map: &DeviceBindingsMap,
) -> Result<Vec<u8>, DeviceBindingBlobError> {
    for (id, entry) in map {
        if !is_device_id_hex(id) || !valid_entry(entry) {
            return Err(DeviceBindingBlobError::MapMalformed);
        }
    }
    serde_json::to_vec(map).map_err(|_| DeviceBindingBlobError::MapMalformed)
}

/// Parse a map and require BYTE EQUALITY with its canonical re-encoding, so a
/// non-canonical but well-formed input is refused rather than silently accepted.
pub fn parse_device_bindings_map(
    bytes: &[u8],
) -> Result<DeviceBindingsMap, DeviceBindingBlobError> {
    let map: DeviceBindingsMap =
        serde_json::from_slice(bytes).map_err(|_| DeviceBindingBlobError::MapMalformed)?;
    for (id, entry) in &map {
        if !is_device_id_hex(id) || !valid_entry(entry) {
            return Err(DeviceBindingBlobError::MapMalformed);
        }
    }
    if serde_json::to_vec(&map)
        .map_err(|_| DeviceBindingBlobError::MapMalformed)?
        .as_slice()
        != bytes
    {
        return Err(DeviceBindingBlobError::MapNotCanonical);
    }
    Ok(map)
}

/// Whether `a` beats `b` for the same `device_id`: the higher version wins, and at
/// EQUAL version a tombstone beats a live entry so a removal is not resurrected by a
/// concurrent re-claim.
///
/// The last two arms order two rows that agree on version AND on the tombstone flag,
/// which the merge only reaches once it has established that they also agree on the
/// person (a same-version pair of DIFFERENT people is refused before this is
/// consulted, see [`merge_device_bindings`]). They are still load-bearing rather than
/// decoration: a re-bind and a removal can each be re-signed, so two rows may agree on
/// every semantic field and differ only in their signature bytes.
///
/// `person_fingerprint` then `signature_hex`, both compared as BYTES. Rust's `String`
/// ordering is byte-wise, and a port must keep it byte-wise rather than reach for a
/// locale collation, or the two sides would pick different winners for the same pair.
/// With these arms the relation is a total order on distinct rows, which is what makes
/// the merge commutative and idempotent rather than merely stable.
///
/// It does NOT make the merge associative, and the reason is worth keeping beside the
/// claim rather than leaving a port to discover it: [`merge_device_bindings`] refuses a
/// same-version pair of different people by short-circuiting the WHOLE map, so a
/// three-map set containing that pair can land on `Err` in one nesting and `Ok` in
/// another. Commutativity and idempotence survive that refusal; associativity does not.
fn beats(a: &DeviceBindingEntry, b: &DeviceBindingEntry) -> bool {
    if a.version != b.version {
        return a.version > b.version;
    }
    if a.tombstone != b.tombstone {
        return a.tombstone;
    }
    if a.person_fingerprint != b.person_fingerprint {
        return a.person_fingerprint > b.person_fingerprint;
    }
    a.signature_hex > b.signature_hex
}

/// Merge two copies of the map entry by entry. Newest version wins per device, and at
/// equal version a tombstone beats a live entry; a device that only one side carries
/// is taken as-is. The result does not depend on argument order, so two devices that
/// merged in opposite orders hold the same map and stop re-sending it.
///
/// **One pair has no winner, and this refuses it rather than inventing one.** Two
/// copies that carry the SAME `device_id` bound to two DIFFERENT people at the SAME
/// version are an unresolvable tie: every remaining field is either equal (the
/// version) or the thing under dispute (the person), so picking a side would make
/// `merge(a, b)` and `merge(b, a)` disagree, each peer would keep its own row and
/// re-push it every cycle, and the device would sit under two members forever with no
/// convergence. [`DeviceBindingBlobError::ConflictingBinding`] names it instead, and
/// the caller decides (a fresh claim at a strictly higher version is the repair).
///
/// The refusal is symmetric, so it does not itself break order independence: a pair
/// either merges to the same map both ways or fails both ways.
///
/// **It is not associative, and that limit is stated here rather than left for a port to
/// find.** Because the refusal short-circuits the entire map instead of the one key it
/// concerns, a three-map SET containing a conflicting pair can resolve to `Err` under one
/// nesting and `Ok` under another: with `a = {D -> (P1, v1)}`, `b = {D -> (P2, v1)}` and
/// `c = {D -> (P2, v2)}`, `merge(merge(a, b), c)` is `Err` while `merge(a, merge(b, c))` is
/// `Ok({D -> (P2, v2)})`. Commutativity and idempotence hold; associativity does not, so a
/// peer that composes in a different order than another can hold `Ok` where this one
/// refuses. The convergence that buys is the caller's: the sync phase mutates nothing on
/// `Err` and records no baseline, so the NEXT cycle retries, and the conflict clears once
/// any peer writes a strictly higher version for that device (a re-claim does).
pub fn merge_device_bindings(
    a: &DeviceBindingsMap,
    b: &DeviceBindingsMap,
) -> Result<DeviceBindingsMap, DeviceBindingBlobError> {
    let mut out = a.clone();
    for (device, incoming) in b {
        match out.get(device) {
            None => {
                out.insert(device.clone(), incoming.clone());
            }
            Some(current) => {
                if incoming.version == current.version
                    && incoming.person_fingerprint != current.person_fingerprint
                {
                    return Err(DeviceBindingBlobError::ConflictingBinding);
                }
                if beats(incoming, current) {
                    out.insert(device.clone(), incoming.clone());
                }
            }
        }
    }
    Ok(out)
}

/// The live view: rows without tombstones, which is what a device list renders.
pub fn live_device_bindings(map: &DeviceBindingsMap) -> DeviceBindingsMap {
    map.iter()
        .filter(|(_, entry)| !entry.tombstone)
        .map(|(id, entry)| (id.clone(), entry.clone()))
        .collect()
}

/// Seal a device-binding map. `device_binding_key` MUST be
/// `derive_group_subkey_v0_2(group_key, GroupRole::DeviceBindingKey)`, and `epoch` the
/// group epoch that key belongs to; both are bound into the AAD.
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source: nonce reuse under the
/// same key is catastrophic per the XChaCha20-Poly1305 contract. Production callers
/// SHOULD use [`encode_device_binding_blob`].
pub fn encode_device_binding_blob_raw(
    device_binding_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    map: &DeviceBindingsMap,
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, DeviceBindingBlobError> {
    if group_key_epoch == 0 {
        return Err(DeviceBindingBlobError::EpochZero);
    }
    let plaintext = encode_device_bindings_map(map)?;
    let aad = aad_device_binding_blob(account_number_hash, group_key_epoch);
    crate::blob_envelope::encode_blob_envelope_raw(
        device_binding_key,
        &DEVICE_BINDING_BLOB_MAGIC,
        DEVICE_BINDING_BLOB_FORMAT_V1,
        &aad,
        MAX_DEVICE_BINDINGS_PLAINTEXT_LEN,
        &plaintext,
        nonce,
    )
    .map_err(DeviceBindingBlobError::from)
}

/// [`encode_device_binding_blob_raw`] pulling the 24-byte nonce from the OS CSPRNG.
pub fn encode_device_binding_blob(
    device_binding_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    map: &DeviceBindingsMap,
) -> Result<Vec<u8>, DeviceBindingBlobError> {
    if group_key_epoch == 0 {
        return Err(DeviceBindingBlobError::EpochZero);
    }
    let plaintext = encode_device_bindings_map(map)?;
    let aad = aad_device_binding_blob(account_number_hash, group_key_epoch);
    encode_blob_envelope(
        device_binding_key,
        &DEVICE_BINDING_BLOB_MAGIC,
        DEVICE_BINDING_BLOB_FORMAT_V1,
        &aad,
        MAX_DEVICE_BINDINGS_PLAINTEXT_LEN,
        &plaintext,
    )
    .map_err(DeviceBindingBlobError::from)
}

/// Open a device-binding blob into its map. Every structural check runs before any
/// decryption (magic at its offset, `protocol_version`, `format_version`, then the
/// length bounds), and the map's canonical form is checked after the AEAD opens.
pub fn decode_device_binding_blob(
    device_binding_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    blob: &[u8],
) -> Result<DeviceBindingsMap, DeviceBindingBlobError> {
    if group_key_epoch == 0 {
        return Err(DeviceBindingBlobError::EpochZero);
    }
    let aad = aad_device_binding_blob(account_number_hash, group_key_epoch);
    let plaintext = decode_blob_envelope(
        device_binding_key,
        &DEVICE_BINDING_BLOB_MAGIC,
        DEVICE_BINDING_BLOB_FORMAT_V1,
        &aad,
        MAX_DEVICE_BINDINGS_PLAINTEXT_LEN,
        blob,
    )
    .map_err(DeviceBindingBlobError::from)?;
    parse_device_bindings_map(&plaintext)
}

/// [`decode_device_binding_blob`] collapsed to the empty map, for a caller to whom
/// "no blob", "truncated", "AEAD failure" and "unsupported format" all mean the same
/// thing: no device has claimed itself yet.
///
/// **Read-only.** See the module header's "Fall-back-to-empty": a reader that cannot
/// tell "no bindings yet" from "the blob is damaged" turns a damaged blob into a
/// silent lost update, because the map it writes back carries only the rows this
/// session knows and the rows it drops carry no tombstone for a later merge to
/// notice. It exists so the family offers the same fall-back-to-empty reader as its
/// siblings (`prefs.rs::read_or_empty`, `member_names_blob.rs::decode_member_names_or_empty`),
/// not so a writer can sit on it.
pub fn decode_device_bindings_or_empty(
    device_binding_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    blob: &[u8],
) -> DeviceBindingsMap {
    decode_device_binding_blob(
        device_binding_key,
        account_number_hash,
        group_key_epoch,
        blob,
    )
    .unwrap_or_default()
}

/// The bytes one row's signature covers: the class prefix, then the device, then the
/// person the row CLAIMS, then the row's own fields at FIXED widths. Fixed widths
/// rather than canonical JSON, so the signed message has exactly one encoding and
/// there is no ambiguity about where a field ends.
///
/// Public because it is the message CLASS, not an internal detail: it is the one
/// assembly a port has to reproduce byte-for-byte to interoperate, and the family's
/// vectors pin it directly against their `signed_bytes` cases. The signature BYTES are
/// deliberately not pinned anywhere, ML-DSA-65's half is randomized, so a pinned
/// signature would only be reproducible by a port that also reproduced our RNG
/// stream, which is exactly why the message has to be checkable on its own.
pub fn device_binding_signed_bytes(
    device_id: &[u8; 16],
    person_fingerprint: &[u8; crate::person_key::PERSON_FINGERPRINT_LEN],
    version: u64,
    tombstone: bool,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(DEVICE_BINDING_PREFIX.len() + 16 + 32 + 8 + 1);
    msg.extend_from_slice(DEVICE_BINDING_PREFIX);
    msg.extend_from_slice(device_id);
    msg.extend_from_slice(person_fingerprint);
    msg.extend_from_slice(&version.to_be_bytes());
    msg.push(u8::from(tombstone));
    msg
}

/// Build one row, signed by `person`. This is the only sanctioned way to produce a row
/// [`verify_device_binding`] accepts: the signature covers the device, the claimed
/// person, the version AND the tombstone flag, so no third party can alter a row's
/// version or tombstone, and the claimed person must be the signer
/// ([`verify_device_binding`] requires the claimed fingerprint to equal the verifying
/// key's own).
///
/// **What the signature does NOT bind is the device.** Nothing ties `device_id` to
/// `person`, so a member holding the group key can seal a row naming ANY device id
/// under their OWN fingerprint and have it verify. They cannot claim a co-member, whose
/// key they do not hold, but they can claim a co-member's DEVICE as their own. The merge
/// orders competing rows by `version`, which is a writer-chosen counter, so outbidding
/// the real row is possible. A reader must therefore read a verified row as "this person
/// CLAIMS this device", never as "this device belongs to this person". Making the device
/// the author of its own row (the device countersigning, or signing the row directly)
/// would close that, and it is a protocol change rather than a codec change, so the
/// limitation is stated here rather than papered over.
///
/// `person_fingerprint` is passed EXPLICITLY rather than read from `person`, for the
/// same reason `sign_member_name` takes the person id explicitly: a live claim passes
/// the signer's own [`PersonKeyPair::fingerprint`](crate::person_key::PersonKeyPair::fingerprint),
/// while the vault owner's removal tombstone passes the REMOVED member's fingerprint
/// (that person is gone and cannot sign it). Both are checked by different readers:
/// [`verify_device_binding`] for a row's own person and
/// [`verify_device_binding_removal`] for an owner-signed tombstone.
pub fn sign_device_binding(
    person: &crate::person_key::PersonKeyPair,
    device_id: &[u8; 16],
    person_fingerprint: &[u8; crate::person_key::PERSON_FINGERPRINT_LEN],
    version: u64,
    tombstone: bool,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<DeviceBindingEntry, DeviceBindingBlobError> {
    let msg = device_binding_signed_bytes(device_id, person_fingerprint, version, tombstone);
    let signed = person
        .sign(&msg, rng)
        .map_err(|_| DeviceBindingBlobError::SignatureUnavailable)?;
    let mut bytes = Vec::with_capacity(DEVICE_BINDING_SIGNATURE_LEN);
    bytes.extend_from_slice(&signed.ed25519_sig);
    bytes.extend_from_slice(&signed.mldsa_sig);
    Ok(DeviceBindingEntry {
        person_fingerprint: hex_lower(person_fingerprint),
        version,
        tombstone,
        signature_hex: hex_lower(&bytes),
    })
}

/// Split a row's hex signature back into its two halves. `None` for anything that is
/// not exactly [`DEVICE_BINDING_SIGNATURE_HEX_LEN`] lowercase hex chars.
fn signature_from_hex(s: &str) -> Option<crate::person_key::PersonSigned> {
    let bytes = hex_bytes(s, DEVICE_BINDING_SIGNATURE_LEN)?;
    let mut ed25519_sig = [0u8; crate::person_key::PERSON_ED25519_SIG_LEN];
    ed25519_sig.copy_from_slice(&bytes[..crate::person_key::PERSON_ED25519_SIG_LEN]);
    Some(crate::person_key::PersonSigned {
        ed25519_sig,
        mldsa_sig: bytes[crate::person_key::PERSON_ED25519_SIG_LEN..].to_vec(),
    })
}

/// Whether this row was signed by the person it CLAIMS. `public` is that person's
/// public half from the roster.
///
/// Two things are checked, and the second is not decoration here the way it is in
/// `verify_member_name`. There the map's KEY is the person id and the caller resolves
/// the public half from it, so a co-member's signature is refused by the key it was
/// looked up under. Here the key is the DEVICE, the claimed person lives inside the
/// row, and the fingerprint is the only thing tying the two together, so the
/// claimed fingerprint must ALSO equal `public`'s own
/// [`fingerprint`](crate::person_key::PersonPublicHalf::fingerprint). Without that
/// check a member could sign a message carrying a co-member's fingerprint and have it
/// verify against their OWN key, which is the whole failure this family exists to
/// prevent. `false` for a row that claims one person and was signed by another, for an
/// altered device id, fingerprint, version or tombstone, and for a malformed
/// signature.
pub fn verify_device_binding(
    public: &crate::person_key::PersonPublicHalf,
    device_id: &[u8; 16],
    entry: &DeviceBindingEntry,
) -> bool {
    let Some(claimed) = fingerprint_from_hex(&entry.person_fingerprint) else {
        return false;
    };
    if public.fingerprint() != &claimed {
        return false;
    }
    let Some(signed) = signature_from_hex(&entry.signature_hex) else {
        return false;
    };
    let msg = device_binding_signed_bytes(device_id, &claimed, entry.version, entry.tombstone);
    public.verify(&msg, &signed).is_ok()
}

/// Whether this row is a REMOVAL the vault owner signed, which is how a member's
/// devices stop being bound when the owner removes them from the vault. Refuses a live
/// row, so an owner signature can never be used to write a binding.
///
/// The claimed fingerprint is NOT compared against the owner's own here, and that is
/// the point: the row names the REMOVED person, so the fingerprint inside the message
/// is theirs and the key that verifies is the owner's. Exactly as
/// `verify_member_removal` accepts an owner signature over a member's row.
pub fn verify_device_binding_removal(
    owner: &crate::person_key::PersonPublicHalf,
    device_id: &[u8; 16],
    entry: &DeviceBindingEntry,
) -> bool {
    if !entry.tombstone {
        return false;
    }
    let Some(claimed) = fingerprint_from_hex(&entry.person_fingerprint) else {
        return false;
    };
    let Some(signed) = signature_from_hex(&entry.signature_hex) else {
        return false;
    };
    let msg = device_binding_signed_bytes(device_id, &claimed, entry.version, entry.tombstone);
    owner.verify(&msg, &signed).is_ok()
}

/// Split a map into the rows whose signature checks out and the device ids that do
/// not, accepting the owner's public half for a tombstone. The unverified ids are
/// RETURNED rather than dropped, so a caller can surface a tampered row as unverified
/// instead of silently treating it as absent.
///
/// `lookup` resolves a row's CLAIMED person fingerprint hex to that person's public
/// half (the roster is where they come from). Unlike `partition_verified`, which is
/// keyed on the map's own person id, the key here is the fingerprint inside the row,
/// because the map key is the device: a row is only ever accepted against the public
/// half of the person it names, and a row naming a fingerprint no roster carries
/// resolves to `None` and lands in the unverified list.
pub fn partition_verified_bindings(
    map: &DeviceBindingsMap,
    mut lookup: impl FnMut(&str) -> Option<crate::person_key::PersonPublicHalf>,
    owner: Option<&crate::person_key::PersonPublicHalf>,
) -> (DeviceBindingsMap, Vec<String>) {
    let mut verified = DeviceBindingsMap::new();
    let mut unverified = Vec::new();
    for (device, entry) in map {
        let Some(device_id) = device_id_from_hex(device) else {
            unverified.push(device.clone());
            continue;
        };
        let person_ok = lookup(&entry.person_fingerprint)
            .is_some_and(|public| verify_device_binding(&public, &device_id, entry));
        let owner_ok = entry.tombstone
            && owner.is_some_and(|o| verify_device_binding_removal(o, &device_id, entry));
        if person_ok || owner_ok {
            verified.insert(device.clone(), entry.clone());
        } else {
            unverified.push(device.clone());
        }
    }
    (verified, unverified)
}

/// The `_raw` seal path is `crate::blob_envelope::encode_blob_envelope_raw` at its one
/// call site above; nothing is kept here.
#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;
    use alloc::string::ToString;
    use alloc::vec;

    const KEY: [u8; AEAD_KEY_LEN] = [0x11; AEAD_KEY_LEN];
    const ACCT: [u8; 16] = [0x22; 16];
    const EPOCH: u64 = 7;

    /// A valid 32-char lowercase-hex device id, distinct per `byte`.
    fn id(byte: u8) -> String {
        let nibble = b"0123456789abcdef"[(byte % 16) as usize] as char;
        core::iter::repeat_n(nibble, DEVICE_ID_HEX_LEN).collect()
    }

    /// A valid 64-char lowercase-hex fingerprint, distinct per `byte`.
    fn fp(byte: u8) -> String {
        let nibble = b"0123456789abcdef"[(byte % 16) as usize] as char;
        core::iter::repeat_n(nibble, PERSON_FINGERPRINT_HEX_LEN).collect()
    }

    /// A structurally well-formed signature placeholder, for tests that do not
    /// exercise verification. The codec is structural; whether a signature is the
    /// RIGHT one is `verify_device_binding`'s question.
    fn placeholder_signature() -> String {
        core::iter::repeat_n('a', DEVICE_BINDING_SIGNATURE_HEX_LEN).collect()
    }

    /// A row whose signature bytes are uniform and caller-chosen, so a test can put two
    /// rows on every semantic field at once and leave the comparator nothing but the
    /// bytes to separate them by.
    fn entry_signed(
        person_fingerprint: &str,
        version: u64,
        tombstone: bool,
        signature_byte: char,
    ) -> DeviceBindingEntry {
        DeviceBindingEntry {
            person_fingerprint: person_fingerprint.to_string(),
            version,
            tombstone,
            signature_hex: core::iter::repeat_n(signature_byte, DEVICE_BINDING_SIGNATURE_HEX_LEN)
                .collect(),
        }
    }

    fn entry(person_fingerprint: &str, version: u64, tombstone: bool) -> DeviceBindingEntry {
        DeviceBindingEntry {
            person_fingerprint: person_fingerprint.to_string(),
            version,
            tombstone,
            signature_hex: placeholder_signature(),
        }
    }

    fn device_id(byte: u8) -> [u8; 16] {
        [byte; 16]
    }

    fn fingerprint(byte: u8) -> [u8; crate::person_key::PERSON_FINGERPRINT_LEN] {
        [byte; crate::person_key::PERSON_FINGERPRINT_LEN]
    }

    fn pair(label: &[u8]) -> crate::person_key::PersonKeyPair {
        use sha2::Digest as _;
        let seed = |l: &[u8]| {
            let d = sha2::Sha256::digest(l);
            let mut out = [0u8; 32];
            out.copy_from_slice(&d);
            out
        };
        let mut kem = [0u8; crate::person_key::PERSON_DK_SEED_LEN];
        kem[..32].copy_from_slice(&seed(label));
        kem[32..].copy_from_slice(&seed(label));
        crate::person_key::PersonKeyPair::generate_raw(&kem, &seed(label), &seed(label))
    }

    struct SeededRng(u64);

    impl rand_core::TryRng for SeededRng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            self.0 = self.0.wrapping_add(1);
            Ok(self.0 as u32)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            self.0 = self.0.wrapping_add(1);
            Ok(self.0)
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            use sha2::Digest as _;
            let mut off = 0;
            while off < dst.len() {
                self.0 = self.0.wrapping_add(1);
                let digest = sha2::Sha256::digest(self.0.to_le_bytes());
                let n = core::cmp::min(32, dst.len() - off);
                dst[off..off + n].copy_from_slice(&digest[..n]);
                off += n;
            }
            Ok(())
        }
    }

    impl rand_core::TryCryptoRng for SeededRng {}

    /// A real row: the map key is the device id and the row claims the signer's OWN
    /// fingerprint, which is the only shape `verify_device_binding` accepts.
    fn signed_binding(
        person: &crate::person_key::PersonKeyPair,
        device_byte: u8,
        version: u64,
        tombstone: bool,
    ) -> (String, DeviceBindingEntry) {
        let mut rng = SeededRng(0);
        let row = sign_device_binding(
            person,
            &device_id(device_byte),
            person.fingerprint(),
            version,
            tombstone,
            &mut rng,
        )
        .expect("sign");
        (hex_lower(&device_id(device_byte)), row)
    }

    #[test]
    fn round_trips_a_map_including_a_tombstone_and_a_rebind() {
        let mut map = DeviceBindingsMap::new();
        // One live row, one tombstone, and a re-bound device at a higher version.
        map.insert(id(1), entry(&fp(1), 1, false));
        map.insert(id(2), entry(&fp(1), 3, true));
        map.insert(id(3), entry(&fp(2), 5, false));
        map.insert(id(3), entry(&fp(4), 6, false));
        let blob = encode_device_binding_blob(&KEY, &ACCT, EPOCH, &map).expect("seal");
        assert_eq!(&blob[0..4], &DEVICE_BINDING_BLOB_MAGIC);
        let back = decode_device_binding_blob(&KEY, &ACCT, EPOCH, &blob).expect("open");
        assert_eq!(back, map);
        assert_eq!(back.get(&id(3)).unwrap().person_fingerprint, fp(4));
        assert_eq!(live_device_bindings(&back).len(), 2);
    }

    #[test]
    fn a_rebound_device_resolves_by_version_regardless_of_order() {
        let mut a = DeviceBindingsMap::new();
        a.insert(id(1), entry(&fp(1), 1, false));
        let mut b = DeviceBindingsMap::new();
        b.insert(id(1), entry(&fp(2), 2, false));
        let ab = merge_device_bindings(&a, &b).expect("merge");
        let ba = merge_device_bindings(&b, &a).expect("merge");
        assert_eq!(ab, ba);
        assert_eq!(ab.get(&id(1)).unwrap().person_fingerprint, fp(2));
    }

    #[test]
    fn a_tombstone_beats_a_live_entry_at_equal_version() {
        let mut live = DeviceBindingsMap::new();
        live.insert(id(1), entry(&fp(1), 4, false));
        let mut dead = DeviceBindingsMap::new();
        dead.insert(id(1), entry(&fp(1), 4, true));
        assert!(
            merge_device_bindings(&live, &dead)
                .unwrap()
                .get(&id(1))
                .unwrap()
                .tombstone
        );
        assert!(
            merge_device_bindings(&dead, &live)
                .unwrap()
                .get(&id(1))
                .unwrap()
                .tombstone
        );
    }

    #[test]
    fn a_device_bound_to_two_people_at_one_version_is_refused() {
        // The one pair `beats` has no arm left to separate, because the only fields
        // the two rows disagree on are the person (the thing under dispute) and the
        // signature over it. Choosing a side would make the two merge orders disagree,
        // so the merge refuses outright rather than resolving by argument order.
        let mut a = DeviceBindingsMap::new();
        a.insert(id(1), entry(&fp(1), 4, false));
        let mut b = DeviceBindingsMap::new();
        b.insert(id(1), entry(&fp(2), 4, false));

        assert_eq!(
            merge_device_bindings(&a, &b),
            Err(DeviceBindingBlobError::ConflictingBinding)
        );
        assert_eq!(
            merge_device_bindings(&b, &a),
            Err(DeviceBindingBlobError::ConflictingBinding),
            "the refusal must not depend on argument order either"
        );
        // A tombstone at the same version does NOT rescue it: the device is still
        // claimed by two different people, and the tombstone arm only separates two
        // rows that agree on the person.
        let mut dead = DeviceBindingsMap::new();
        dead.insert(id(1), entry(&fp(2), 4, true));
        assert_eq!(
            merge_device_bindings(&a, &dead),
            Err(DeviceBindingBlobError::ConflictingBinding)
        );
        // The repair is a strictly higher version, which the merge resolves.
        let mut rebound = DeviceBindingsMap::new();
        rebound.insert(id(1), entry(&fp(2), 5, false));
        assert_eq!(
            merge_device_bindings(&a, &rebound)
                .unwrap()
                .get(&id(1))
                .unwrap()
                .person_fingerprint,
            fp(2)
        );
    }

    #[test]
    fn merge_is_idempotent() {
        let mut map = DeviceBindingsMap::new();
        map.insert(id(1), entry(&fp(1), 2, false));
        assert_eq!(merge_device_bindings(&map, &map), Ok(map));
    }

    #[test]
    fn a_tied_row_is_separated_by_its_own_bytes_in_either_order() {
        // The arm `beats` reaches only once version, tombstone and person have ALL tied:
        // two rows for one device agreeing on every semantic field and differing only in
        // their signature bytes. That state is reachable rather than hypothetical, because
        // a claim and a removal can each be re-signed, so two rows may carry the same
        // version, the same tombstone flag and the same person and still differ byte-wise.
        //
        // `protocol/AGENTS.md` requires any merge claiming commutativity or idempotence to
        // carry a fixture that ties on every field the comparator reads before it reaches
        // the bytes, assert it in BOTH argument orders, and state the winner explicitly.
        // This is that case, and the sibling `merge_member_names` carries the same one
        // after shipping the absence of it as a permanent push livelock.
        let mut a = DeviceBindingsMap::new();
        a.insert(id(1), entry_signed(&fp(1), 4, false, 'a'));
        let mut b = DeviceBindingsMap::new();
        b.insert(id(1), entry_signed(&fp(1), 4, false, 'b'));

        let ab = merge_device_bindings(&a, &b).expect("merge");
        let ba = merge_device_bindings(&b, &a).expect("merge");
        assert_eq!(ab, ba, "the tie must not depend on argument order");
        assert_eq!(
            ab.get(&id(1)).unwrap().signature_hex.as_str(),
            entry_signed(&fp(1), 4, false, 'b').signature_hex.as_str(),
            "the higher signature bytes win, compared byte-wise rather than by a locale \
             collation"
        );

        // And the winner is a fixed point: merging the result with itself changes nothing,
        // which is the idempotence half of the same claim.
        let again = merge_device_bindings(&ab, &ab).expect("merge");
        assert_eq!(again, ab);
    }

    #[test]
    fn two_devices_claiming_concurrently_both_survive() {
        let mut a = DeviceBindingsMap::new();
        a.insert(id(1), entry(&fp(1), 1, false));
        let mut b = DeviceBindingsMap::new();
        b.insert(id(2), entry(&fp(2), 1, false));
        let ab = merge_device_bindings(&a, &b).unwrap();
        let ba = merge_device_bindings(&b, &a).unwrap();
        assert_eq!(ab, ba);
        assert_eq!(ab.len(), 2);
    }

    #[test]
    fn an_empty_map_round_trips() {
        let blob =
            encode_device_binding_blob(&KEY, &ACCT, EPOCH, &DeviceBindingsMap::new()).unwrap();
        assert!(decode_device_binding_blob(&KEY, &ACCT, EPOCH, &blob)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn an_absent_blob_collapses_to_the_empty_map() {
        assert!(decode_device_bindings_or_empty(&KEY, &ACCT, EPOCH, &[]).is_empty());
        assert!(decode_device_bindings_or_empty(&KEY, &ACCT, EPOCH, b"MYU5").is_empty());
    }

    #[test]
    fn a_damaged_blob_is_empty_from_the_helper_and_an_error_from_the_codec() {
        // The one distinction the fall-back-to-empty helper destroys, and the reason the
        // module header forbids it on the read half of a read-modify-write: a reader on
        // that helper cannot tell a damaged blob from a vault nobody has claimed, so it
        // writes back a map carrying only its own row. Real keys and real framing with ONE
        // flipped ciphertext byte, so the failure is the AEAD tag and nothing structural:
        // a header-invalid fixture would be rejected before decryption and would prove
        // nothing about the distinction.
        let mut map = DeviceBindingsMap::new();
        map.insert(id(1), entry(&fp(1), 1, false));
        let good =
            encode_device_binding_blob(&KEY, &ACCT, EPOCH, &map).expect("seal a one-row map");
        let mut damaged = good.clone();
        let last = damaged.len() - 1;
        damaged[last] ^= 0x01;

        assert_eq!(
            decode_device_binding_blob(&KEY, &ACCT, EPOCH, &damaged),
            Err(DeviceBindingBlobError::CannotDecrypt),
            "the honest reader must name the failure"
        );
        assert!(
            decode_device_bindings_or_empty(&KEY, &ACCT, EPOCH, &damaged).is_empty(),
            "and the fall-back reader must be the one that cannot, which is why a writer \
             may not sit on it"
        );
        // The fixture is only a fixture if the untouched bytes DO open, or the assertion
        // above would hold for a blob that was never valid.
        assert!(decode_device_binding_blob(&KEY, &ACCT, EPOCH, &good).is_ok());
    }

    #[test]
    fn a_wrong_epoch_fails_the_aead() {
        let mut map = DeviceBindingsMap::new();
        map.insert(id(1), entry(&fp(1), 1, false));
        let blob = encode_device_binding_blob(&KEY, &ACCT, EPOCH, &map).unwrap();
        assert_eq!(
            decode_device_binding_blob(&KEY, &ACCT, EPOCH + 1, &blob),
            Err(DeviceBindingBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn a_zero_epoch_is_refused_on_both_paths() {
        assert_eq!(
            encode_device_binding_blob(&KEY, &ACCT, 0, &DeviceBindingsMap::new()),
            Err(DeviceBindingBlobError::EpochZero)
        );
        assert_eq!(
            decode_device_binding_blob(&KEY, &ACCT, 0, &[0u8; 40]),
            Err(DeviceBindingBlobError::EpochZero)
        );
    }

    #[test]
    fn a_foreign_magic_and_a_bad_version_are_named() {
        let blob =
            encode_device_binding_blob(&KEY, &ACCT, EPOCH, &DeviceBindingsMap::new()).unwrap();
        let mut foreign = blob.clone();
        foreign[0..4].copy_from_slice(b"MYO5");
        assert_eq!(
            decode_device_binding_blob(&KEY, &ACCT, EPOCH, &foreign),
            Err(DeviceBindingBlobError::MagicMismatch)
        );
        let mut bad_version = blob.clone();
        bad_version[4] = 0x09;
        assert_eq!(
            decode_device_binding_blob(&KEY, &ACCT, EPOCH, &bad_version),
            Err(DeviceBindingBlobError::ProtocolVersionMismatch)
        );
        let mut bad_format = blob.clone();
        bad_format[5] = 0x09;
        assert_eq!(
            decode_device_binding_blob(&KEY, &ACCT, EPOCH, &bad_format),
            Err(DeviceBindingBlobError::DeviceBindingFormatUnsupported)
        );
    }

    #[test]
    fn strict_trailing_holds() {
        let blob =
            encode_device_binding_blob(&KEY, &ACCT, EPOCH, &DeviceBindingsMap::new()).unwrap();
        let ct_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;
        assert_eq!(blob.len(), DEVICE_BINDING_BLOB_HEADER_LEN + ct_len);
        let mut short = blob.clone();
        short.truncate(blob.len() - 1);
        assert_eq!(
            decode_device_binding_blob(&KEY, &ACCT, EPOCH, &short),
            Err(DeviceBindingBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn a_malformed_map_is_named_and_a_non_canonical_one_is_too() {
        assert_eq!(
            parse_device_bindings_map(b"not json"),
            Err(DeviceBindingBlobError::MapMalformed)
        );
        // A well-formed map whose keys are not device ids.
        assert_eq!(
            parse_device_bindings_map(
                br#"{"nope":{"person_fingerprint":"aa","version":1,"tombstone":false,"signature_hex":"aa"}}"#
            ),
            Err(DeviceBindingBlobError::MapMalformed)
        );
        // A row whose fingerprint is not 64 lowercase hex chars.
        let short_fp = format!(
            r#"{{"{}":{{"person_fingerprint":"aa","version":1,"tombstone":false,"signature_hex":"{}"}}}}"#,
            id(1),
            placeholder_signature()
        );
        assert_eq!(
            parse_device_bindings_map(short_fp.as_bytes()),
            Err(DeviceBindingBlobError::MapMalformed)
        );
        // A signature that is not the right shape, refused at the writer too.
        let mut short_sig = DeviceBindingsMap::new();
        let mut row = entry(&fp(1), 1, false);
        row.signature_hex = "aa".to_string();
        short_sig.insert(id(1), row);
        assert_eq!(
            encode_device_bindings_map(&short_sig),
            Err(DeviceBindingBlobError::MapMalformed)
        );
        // Well formed, every field present and correctly shaped, but NOT the canonical
        // byte encoding: the fields are written out of declaration order, so the
        // re-serialization differs and the parse is refused by name.
        let non_canonical = format!(
            r#"{{"{}":{{"version":1,"tombstone":false,"person_fingerprint":"{}","signature_hex":"{}"}}}}"#,
            id(1),
            fp(1),
            placeholder_signature()
        );
        assert_eq!(
            parse_device_bindings_map(non_canonical.as_bytes()),
            Err(DeviceBindingBlobError::MapNotCanonical)
        );
    }

    #[test]
    fn the_signature_class_prefix_is_one_whole_literal() {
        // The prefix is minted whole rather than assembled from parts, and the message
        // is prefix || device_id (16 raw) || fingerprint (32 raw) || version (8 BE) ||
        // tombstone (1). Pinned here as well as by the family's `signed_bytes` vectors,
        // because a change to either is a major-version event.
        assert_eq!(DEVICE_BINDING_PREFIX, b"myne.device-binding v1|");
        let p = DEVICE_BINDING_PREFIX.len();
        let msg = device_binding_signed_bytes(
            &device_id(0xab),
            &fingerprint(0xcd),
            0x0102_0304_0506_0708,
            true,
        );
        assert_eq!(msg.len(), p + 16 + 32 + 8 + 1);
        assert_eq!(&msg[..p], b"myne.device-binding v1|");
        assert_eq!(&msg[p..p + 16], &[0xabu8; 16]);
        assert_eq!(&msg[p + 16..p + 48], &[0xcdu8; 32]);
        assert_eq!(
            &msg[p + 48..p + 56],
            &0x0102_0304_0506_0708u64.to_be_bytes()
        );
        assert_eq!(msg[p + 56], 1);
        // The same row, live, differs in exactly the one tombstone byte.
        let live = device_binding_signed_bytes(
            &device_id(0xab),
            &fingerprint(0xcd),
            0x0102_0304_0506_0708,
            false,
        );
        assert_eq!(live[..p + 56], msg[..p + 56]);
        assert_eq!(live[p + 56], 0);
    }

    #[test]
    fn a_row_signed_by_its_own_person_verifies_and_survives_the_codec() {
        let ann = pair(b"ann");
        let (id, row) = signed_binding(&ann, 0x11, 3, false);
        assert!(verify_device_binding(
            &ann.public_half(),
            &device_id(0x11),
            &row
        ));
        let mut map = DeviceBindingsMap::new();
        map.insert(id, row);
        let blob = encode_device_binding_blob(&KEY, &ACCT, EPOCH, &map).expect("seal");
        let back = decode_device_binding_blob(&KEY, &ACCT, EPOCH, &blob).expect("open");
        let round_tripped = back.get(&hex_lower(&device_id(0x11))).expect("row");
        assert!(verify_device_binding(
            &ann.public_half(),
            &device_id(0x11),
            round_tripped
        ));
    }

    #[test]
    fn an_entry_claiming_one_person_but_signed_by_another_is_refused() {
        let ann = pair(b"ann");
        let bob = pair(b"bob");
        let mut rng = SeededRng(0);
        // Bob signs a row that CLAIMS Ann's fingerprint.
        let row = sign_device_binding(
            &bob,
            &device_id(0x11),
            ann.fingerprint(),
            1,
            false,
            &mut rng,
        )
        .expect("sign");
        assert!(
            !verify_device_binding(&ann.public_half(), &device_id(0x11), &row),
            "Ann's key did not sign it"
        );
        // And it does not verify as Bob's either, which is STRICTER than
        // `verify_member_name`: there the map key is the person, so a row looked up
        // under Ann can only ever be checked against Ann. Here the person lives inside
        // the row, so the claimed fingerprint is checked against the verifying key too,
        // which is what refuses this row instead of quietly filing it under Bob.
        assert!(
            !verify_device_binding(&bob.public_half(), &device_id(0x11), &row),
            "a row may only ever be accepted as the person it claims"
        );
    }

    #[test]
    fn a_mutated_device_id_or_fingerprint_over_a_valid_signature_is_refused() {
        let ann = pair(b"ann");
        let (_, row) = signed_binding(&ann, 0x11, 1, false);
        assert!(verify_device_binding(
            &ann.public_half(),
            &device_id(0x11),
            &row
        ));
        // The device id is inside the signed message, so pointing the row at another
        // device is refused even though the signature is untouched.
        assert!(!verify_device_binding(
            &ann.public_half(),
            &device_id(0x12),
            &row
        ));
        // The claimed fingerprint is inside the signed message AND checked against the
        // verifying key, so rewriting it is refused twice over.
        let mut refiled = row.clone();
        refiled.person_fingerprint = hex_lower(&fingerprint(0x99));
        assert!(!verify_device_binding(
            &ann.public_half(),
            &device_id(0x11),
            &refiled
        ));
    }

    #[test]
    fn an_altered_version_or_tombstone_is_refused() {
        let ann = pair(b"ann");
        let (_, row) = signed_binding(&ann, 0x11, 3, false);
        let mut bumped = row.clone();
        bumped.version = 99;
        assert!(!verify_device_binding(
            &ann.public_half(),
            &device_id(0x11),
            &bumped
        ));
        let mut killed = row.clone();
        killed.tombstone = true;
        assert!(!verify_device_binding(
            &ann.public_half(),
            &device_id(0x11),
            &killed
        ));
    }

    #[test]
    fn the_owner_may_sign_a_removal_but_never_a_live_row() {
        let ann = pair(b"ann");
        let owner = pair(b"owner");
        let mut rng = SeededRng(0);
        // The owner removes Ann's device: the row names ANN's fingerprint and the
        // signature is the OWNER's.
        let removal = sign_device_binding(
            &owner,
            &device_id(0x11),
            ann.fingerprint(),
            5,
            true,
            &mut rng,
        )
        .expect("sign");
        assert!(verify_device_binding_removal(
            &owner.public_half(),
            &device_id(0x11),
            &removal
        ));
        assert!(
            !verify_device_binding(&ann.public_half(), &device_id(0x11), &removal),
            "the owner's key is not Ann's, so a removal never reads as Ann's own claim"
        );
        // A live row the owner signed: the removal reader refuses anything that is not
        // a tombstone BEFORE it looks at the signature, so the owner cannot use the
        // removal path as a binding-writing path.
        let live = sign_device_binding(
            &owner,
            &device_id(0x11),
            ann.fingerprint(),
            5,
            false,
            &mut rng,
        )
        .expect("sign");
        assert!(!verify_device_binding_removal(
            &owner.public_half(),
            &device_id(0x11),
            &live
        ));
        assert!(!verify_device_binding(
            &ann.public_half(),
            &device_id(0x11),
            &live
        ));
    }

    #[test]
    fn partition_names_the_unverified_ids_rather_than_dropping_them() {
        let ann = pair(b"ann");
        let bob = pair(b"bob");
        let (ann_dev, ann_row) = signed_binding(&ann, 0x11, 1, false);
        let (_, mut forged) = signed_binding(&bob, 0x22, 1, false);
        forged.person_fingerprint = hex_lower(ann.fingerprint());
        let bob_dev = hex_lower(&device_id(0x22));
        let mut map = DeviceBindingsMap::new();
        map.insert(ann_dev.clone(), ann_row);
        map.insert(bob_dev.clone(), forged);
        let ann_fp = hex_lower(ann.fingerprint());
        let bob_fp = hex_lower(bob.fingerprint());
        let (verified, unverified) = partition_verified_bindings(
            &map,
            |fingerprint| {
                if fingerprint == ann_fp {
                    Some(ann.public_half())
                } else if fingerprint == bob_fp {
                    Some(bob.public_half())
                } else {
                    None
                }
            },
            None,
        );
        assert_eq!(verified.len(), 1);
        assert!(verified.contains_key(&ann_dev));
        assert_eq!(unverified, vec![bob_dev]);
    }

    #[test]
    fn a_device_whose_claimed_person_is_not_in_the_roster_is_unverified() {
        // "an actor that cannot be mapped" and "a device with no binding" are different
        // states, and this is the first: the row is well formed and signed, but no
        // member carries the fingerprint it names, so the lookup resolves to `None` and
        // the device is reported unverified rather than silently passed.
        let ghost = pair(b"ghost");
        let (device, row) = signed_binding(&ghost, 0x33, 1, false);
        let mut map = DeviceBindingsMap::new();
        map.insert(device.clone(), row);
        let (verified, unverified) = partition_verified_bindings(&map, |_| None, None);
        assert!(verified.is_empty());
        assert_eq!(unverified, vec![device]);
    }

    /// Emits `myne-test-vectors/vectors/device-binding/…` to stdout. `#[ignore]`; run
    /// with:
    /// `cargo test -p protocol --lib emit_device_binding_vectors_for_paste -- --ignored --nocapture`
    ///
    /// The family is `NTV6`-only (no v0.1 form, no `SubkeyRole` counterpart), so this
    /// is a v0.2 category, its schema is the device-binding schema, and the companion
    /// side of this generator is task 9's.
    ///
    /// Eight case kinds, and each one is a different question: `encrypt` (the envelope
    /// over a canonical map, plus the tombstone and the re-bind), `decrypt_fail` (the
    /// single non-distinguishing AEAD answer, reached four ways, plus the epoch-zero
    /// guard), `parse_fail` (one case per DISTINGUISHABLE structural variant, so a port
    /// that collapses them fails by name), `encode_fail` (the writer refuses rather than
    /// truncates), `merge` (the per-device tie-break AND the refusal, which is the one
    /// arm no other family has), `signed_bytes` (the exact bytes one row's hybrid
    /// signature covers), `verify` (who may sign what, and the refusals), and
    /// `group_subkey` (the family's one GROUP-tier derivation).
    #[test]
    #[ignore]
    fn emit_device_binding_vectors_for_paste() {
        extern crate std;
        use crate::aead::aad_device_binding_blob;
        use crate::blob_envelope::encode_blob_envelope_raw;
        use crate::subkey::{derive_group_subkey_v0_2, GroupKey, GroupRole};
        use crate::test_vector_fmt::{hex_lower, json_escape};
        use alloc::format;
        use alloc::string::String;

        let key: [u8; AEAD_KEY_LEN] = [0x11; AEAD_KEY_LEN];
        let other_key: [u8; AEAD_KEY_LEN] = [0x99; AEAD_KEY_LEN];
        let acct: [u8; 16] = [0x22; 16];
        let other_account: [u8; 16] = [0x2a; 16];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x33; AEAD_NONCE_LEN];
        let epoch: u64 = 7;
        let group_key: [u8; 32] = [0x44; 32];

        // Two members and the vault owner. The row's map key is the lowercase hex of
        // the DEVICE id, and the person is the fingerprint inside the row, so a row is
        // never keyed by the person it names.
        let member_a = pair(b"myne device-binding vector member A");
        let member_b = pair(b"myne device-binding vector member B");
        let owner = pair(b"myne device-binding vector owner");
        let dev_a = device_id(0x0b);
        let dev_b = device_id(0x0c);
        let dev_c = device_id(0x0d);

        // The canonical map JSON, which is also the plaintext: keys ascending and no
        // whitespace, exactly what `serde_json` emits over a `BTreeMap`.
        fn map_json(map: &DeviceBindingsMap) -> String {
            let mut s = String::from("{");
            for (i, (id, e)) in map.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                s.push_str(&format!(
                    "\"{id}\":{{\"person_fingerprint\":\"{}\",\"version\":{},\"tombstone\":{},\"signature_hex\":\"{}\"}}",
                    e.person_fingerprint,
                    e.version,
                    e.tombstone,
                    e.signature_hex,
                ));
            }
            s.push('}');
            s
        }

        // Map an error to the pinned snake_case name. The `match` is exhaustive on
        // purpose: a new variant cannot ship without deciding its wire name here, which
        // is what keeps `expected_error` and the enum in lockstep.
        fn err_name(e: &DeviceBindingBlobError) -> &'static str {
            match e {
                DeviceBindingBlobError::HeaderTooShort => "header_too_short",
                DeviceBindingBlobError::MagicMismatch => "magic_mismatch",
                DeviceBindingBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
                DeviceBindingBlobError::DeviceBindingFormatUnsupported => "format_unsupported",
                DeviceBindingBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
                DeviceBindingBlobError::CiphertextTruncated => "ciphertext_truncated",
                DeviceBindingBlobError::CannotDecrypt => "cannot_decrypt",
                DeviceBindingBlobError::RandomnessUnavailable => "randomness_unavailable",
                // Named after the SIBLINGS' word for this failure rather than after the
                // Rust variant: `plaintext_parse_failed` is what `vault-prefs` and
                // `member-names` already call "the plaintext did not parse", and an
                // independent implementation maps one failure to one name.
                DeviceBindingBlobError::MapMalformed => "plaintext_parse_failed",
                DeviceBindingBlobError::MapNotCanonical => "not_canonical",
                DeviceBindingBlobError::EpochZero => "epoch_zero",
                DeviceBindingBlobError::SignatureUnavailable => "signature_unavailable",
                // The one name no sibling has, because no sibling refuses a merge.
                DeviceBindingBlobError::ConflictingBinding => "conflicting_binding",
            }
        }

        // Seal `map` under the family AAD and assert the header the format fixes.
        let seal = |map: &DeviceBindingsMap| -> Vec<u8> {
            let blob = encode_device_binding_blob_raw(&key, &acct, epoch, map, &nonce)
                .expect("seal device-binding map");
            assert_eq!(&blob[..4], b"MYU5", "family magic");
            assert_eq!(blob[4], 0x01, "envelope protocol_version");
            assert_eq!(
                blob[5], DEVICE_BINDING_BLOB_FORMAT_V1,
                "family format version"
            );
            assert_eq!(&blob[6..30], &nonce[..], "nonce at its fixed offset");
            let declared = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;
            assert_eq!(
                blob.len(),
                DEVICE_BINDING_BLOB_HEADER_LEN + declared,
                "the 4-byte big-endian length at offset 30 counts the ciphertext with its tag"
            );
            blob
        };

        // Seal arbitrary plaintext, for the two cases whose failure is decided AFTER
        // the AEAD opens (the map is not a map / is not canonical).
        let seal_plaintext = |pt: &[u8]| -> Vec<u8> {
            encode_blob_envelope_raw(
                &key,
                &DEVICE_BINDING_BLOB_MAGIC,
                DEVICE_BINDING_BLOB_FORMAT_V1,
                &aad_device_binding_blob(&acct, epoch),
                MAX_DEVICE_BINDINGS_PLAINTEXT_LEN,
                pt,
                &nonce,
            )
            .expect("seal raw plaintext")
        };

        // ---- the maps the codec cases are built from -------------------------
        let mut two_row = DeviceBindingsMap::new();
        two_row.insert(hex_lower(&dev_a), entry(&fp(0x0e), 1, false));
        two_row.insert(hex_lower(&dev_b), entry(&fp(0x0e), 4, true));
        let empty: DeviceBindingsMap = DeviceBindingsMap::new();

        // One map carrying a REAL signature, so the codec is pinned against a row
        // `verify_device_binding` accepts rather than only against placeholders.
        let (a_key, live_row) = signed_binding(&member_a, 0x0b, 3, false);
        let mut real_map = DeviceBindingsMap::new();
        real_map.insert(a_key.clone(), live_row.clone());

        // ---- the signing identities the verify cases resolve -----------------
        let a_pub = member_a.public_half();
        let b_pub = member_b.public_half();
        let owner_pub = owner.public_half();
        let signer_json = |public: &crate::person_key::PersonPublicHalf| -> String {
            format!(
                "      \"input_signer_kem_ek_hex\": \"{}\",\n      \"input_signer_ed_pk_hex\": \"{}\",\n      \"input_signer_mldsa_vk_hex\": \"{}\",\n",
                hex_lower(public.kem_ek()),
                hex_lower(public.ed_pk()),
                hex_lower(public.mldsa_vk()),
            )
        };
        let entry_json = |e: &DeviceBindingEntry| -> String {
            format!(
                "      \"input_entry\": {{ \"person_fingerprint\": \"{}\", \"version\": {}, \"tombstone\": {}, \"signature_hex\": \"{}\" }},\n",
                e.person_fingerprint,
                e.version,
                e.tombstone,
                e.signature_hex,
            )
        };
        let bytes_hex =
            |id: &[u8; 16], fingerprint: &[u8; 32], version: u64, tombstone: bool| -> String {
                hex_lower(&device_binding_signed_bytes(
                    id,
                    fingerprint,
                    version,
                    tombstone,
                ))
            };

        // A member removing their OWN device: the row claims the signer.
        let self_tombstone = sign_device_binding(
            &member_b,
            &dev_b,
            member_b.fingerprint(),
            5,
            true,
            &mut SeededRng(0x2b),
        )
        .expect("sign self tombstone");
        // The OWNER removing member B's device: the row still claims B, the signer does
        // not.
        let owner_tombstone = sign_device_binding(
            &owner,
            &dev_b,
            member_b.fingerprint(),
            6,
            true,
            &mut SeededRng(0x2c),
        )
        .expect("sign owner tombstone");
        assert_ne!(
            self_tombstone.signature_hex, owner_tombstone.signature_hex,
            "the two tombstones must differ, or the owner case proves nothing"
        );

        // ---- emit ------------------------------------------------------------
        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"device-binding\",\n");
        dump.push_str("  \"protocol_version\": \"v0.2\",\n");
        dump.push_str(
            "  \"spec_section\": \"protocol.md \\u00a79.30 + \\u00a73.4 + \\u00a75.2\",\n",
        );
        dump.push_str("  \"description\": \"Pins the vault.device-bindings singleton (MYU5) for an independent implementation: the AEAD envelope over a canonical device-to-person map, the decode-failure surface one variant at a time, the per-device merge with its refusal, the exact bytes one row's hybrid signature covers, the verification rules (who may sign a binding, who may sign a removal, and the refusals), and the GROUP-tier subkey derivation the family is keyed by. The family is NTV6-only: no v0.1 form exists, there is no SubkeyRole counterpart, and a pre-B2B reader must reject it. Every input_map is written in its CANONICAL byte order (keys ascending, no whitespace), so the plaintext sealed into expected_blob_hex is exactly the JSON as written. Cases generated by `cargo test -p protocol --lib emit_device_binding_vectors_for_paste -- --ignored --nocapture` (in protocol/src/device_binding_blob.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        let case = |dump: &mut String,
                    slug: &str,
                    kind: &str,
                    description: &str,
                    body: &str,
                    trailing: bool| {
            dump.push_str("    {\n");
            dump.push_str(&format!(
                "      \"vector_id\": \"device-binding/v0.2/{slug}\",\n"
            ));
            dump.push_str(&format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str(&format!("      \"case_kind\": \"{kind}\",\n"));
            dump.push_str(body);
            dump.push_str(if trailing { "    },\n" } else { "    }\n" });
        };

        // ===== encrypt ========================================================
        for (slug, desc, map) in [
            (
                "encrypt-live-row-and-tombstone",
                "A two-row map sealed under the family AAD: one live row and one tombstone. The tombstone KEEPS its person_fingerprint, unlike the member-names family whose tombstone carries no name, because a tombstone here has to name the binding it removes (and because the merge refuses a same-version tie between two DIFFERENT people, which it can only detect while both fingerprints are present). The signatures are structurally valid placeholders, because this case pins the CODEC, and whether a signature is the right one is verify-*'s question.",
                &two_row,
            ),
            (
                "encrypt-empty-map",
                "The empty map: `{}`, two bytes of plaintext. This is the form a vault stores before any device has claimed itself, and it must be distinguishable from an ABSENT blob (which decode_device_bindings_or_empty also collapses to the empty map).",
                &empty,
            ),
            (
                "encrypt-row-with-a-real-signature",
                "The same shape as encrypt-live-row-and-tombstone with the row carrying a REAL hybrid Ed25519 + ML-DSA-65 signature from the person the row claims, so the codec is pinned against bytes verify_device_binding accepts rather than only against placeholders. The runner decodes this blob and verifies the row it comes back with.",
                &real_map,
            ),
        ]
        .into_iter()
        {
            let blob = seal(map);
            let mj = map_json(map);
            let canonical = String::from_utf8(encode_device_bindings_map(map).expect("canonical"))
                .expect("canonical map bytes are UTF-8");
            assert_eq!(
                mj, canonical,
                "[{slug}] the emitted input_map must BE the canonical plaintext: keys \
                 ascending, no whitespace, fields in declaration order"
            );
            let body = format!(
                "      \"input_device_binding_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_group_key_epoch\": {},\n      \"input_nonce_hex\": \"{}\",\n      \"input_map\": {},\n      \"expected_blob_hex\": \"{}\",\n      \"informational_header_len\": {},\n      \"informational_nonce_offset\": 6,\n      \"expected_magic_ascii\": \"MYU5\",\n      \"expected_protocol_version_byte_hex\": \"01\",\n      \"expected_format_version_byte_hex\": \"01\"\n",
                hex_lower(&key),
                hex_lower(&acct),
                epoch,
                hex_lower(&nonce),
                mj,
                hex_lower(&blob),
                DEVICE_BINDING_BLOB_HEADER_LEN,
            );
            case(&mut dump, slug, "encrypt", desc, &body, true);
        }

        // ===== decrypt_fail ===================================================
        // One case per way of reaching the single non-distinguishing answer, plus the
        // epoch guard, which is checked before the AEAD is even attempted.
        let good = seal(&empty);
        let mut tampered = good.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        let mut wrong_magic = good.clone();
        wrong_magic[0] = b'X';
        let mut wrong_version = good.clone();
        wrong_version[4] = 0x02;
        let mut wrong_format = good.clone();
        wrong_format[5] = 0x7f;
        let mut len_overflow = good[..DEVICE_BINDING_BLOB_HEADER_LEN].to_vec();
        len_overflow[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
        let mut truncated = good[..DEVICE_BINDING_BLOB_HEADER_LEN].to_vec();
        truncated[30..34].copy_from_slice(&1000u32.to_be_bytes());
        // A well-formed map that is not what the canonical encoder would emit: the same
        // bytes with one incidental space. It is what a writer whose serialiser is not
        // compact (or not key-sorted) would produce, and two implementations that
        // accepted it would disagree on the blob's bytes.
        let non_canonical = {
            let canonical = encode_device_bindings_map(&two_row).expect("canonical");
            let mut spaced = canonical.clone();
            let colon = spaced.iter().position(|b| *b == b':').expect("a row field");
            spaced.insert(colon + 1, b' ');
            spaced
        };
        assert_ne!(
            non_canonical,
            encode_device_bindings_map(&two_row).expect("canonical")
        );

        let decode_case = |dump: &mut String,
                           slug: &str,
                           kind: &str,
                           description: &str,
                           blob: &[u8],
                           reader_key: &[u8; AEAD_KEY_LEN],
                           reader_account: &[u8; 16],
                           reader_epoch: u64,
                           expected: &str,
                           trailing: bool| {
            // The pinned name is asserted HERE, at generation, so a mislabelled case is
            // impossible: the vector cannot ship claiming an error the code does not
            // raise for that input.
            let got = decode_device_binding_blob(reader_key, reader_account, reader_epoch, blob)
                .expect_err(&format!("[{slug}] expected {expected}"));
            assert_eq!(
                err_name(&got),
                expected,
                "[{slug}] the case's own input does not raise the error it pins"
            );
            let body = format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_device_binding_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_group_key_epoch\": {},\n      \"expected_error\": \"{}\"\n",
                hex_lower(blob),
                hex_lower(reader_key),
                hex_lower(reader_account),
                reader_epoch,
                expected,
            );
            case(dump, slug, kind, description, &body, trailing);
        };

        decode_case(
            &mut dump,
            "decrypt-fail-tampered-tag",
            "decrypt_fail",
            "The correct key, account and epoch, one bit flipped in the last ciphertext byte. The tag fails. A writer that produced a different ciphertext must not be distinguishable from an attacker here.",
            &tampered,
            &key,
            &acct,
            epoch,
            "cannot_decrypt",
            true,
        );
        decode_case(
            &mut dump,
            "decrypt-fail-cross-vault",
            "decrypt_fail",
            "The same blob read under a DIFFERENT vault's account_number_hash, which is the label the AAD binds. A binding map copied from one vault into another does not open, so a member cannot graft a device roster between vaults.",
            &good,
            &key,
            &other_account,
            epoch,
            "cannot_decrypt",
            true,
        );
        decode_case(
            &mut dump,
            "decrypt-fail-stale-epoch",
            "decrypt_fail",
            "The same blob read at the NEXT group epoch, the read a member who was rotated out would attempt: they still hold the old group key, so the failure has to come from the epoch in the AAD rather than from key possession. This is why group_key_epoch is a REQUIRED argument of the AAD builder rather than an optional one.",
            &good,
            &key,
            &acct,
            epoch + 1,
            "cannot_decrypt",
            true,
        );
        decode_case(
            &mut dump,
            "decrypt-fail-wrong-key",
            "decrypt_fail",
            "The same blob, the same AAD, a different device-binding key. Reached from the key side rather than the AAD side, so a reader that checked only the AAD would pass this case and fail the two above.",
            &good,
            &other_key,
            &acct,
            epoch,
            "cannot_decrypt",
            true,
        );
        decode_case(
            &mut dump,
            "decrypt-fail-epoch-zero",
            "decrypt_fail",
            "The epoch-zero guard, which runs BEFORE any decryption: `group_key_epoch == 0` is refused outright because no writer produces it. Paired with encode-fail-epoch-zero, which is the same guard on the write side.",
            &good,
            &key,
            &acct,
            0,
            "epoch_zero",
            true,
        );

        // ===== parse_fail =====================================================
        decode_case(
            &mut dump,
            "parse-fail-header-too-short",
            "parse_fail",
            "One byte short of a whole header: the 4-byte magic, the two version bytes, the 24-byte nonce and the 4-byte length are 34 bytes, and 33 cannot be read. The structural checks run in order and this is the first.",
            &good[..DEVICE_BINDING_BLOB_HEADER_LEN - 1],
            &key,
            &acct,
            epoch,
            "header_too_short",
            true,
        );
        decode_case(
            &mut dump,
            "parse-fail-magic-mismatch",
            "parse_fail",
            "Byte 0 of a real blob replaced: the magic is MYU5 and nothing else. It is checked at its offset BEFORE the length field is trusted, so a foreign blob cannot steer a reader into a large allocation.",
            &wrong_magic,
            &key,
            &acct,
            epoch,
            "magic_mismatch",
            true,
        );
        decode_case(
            &mut dump,
            "parse-fail-protocol-version",
            "parse_fail",
            "The envelope protocol_version byte set to 0x02, the NEXT major's value inside a MYU5-shaped blob. The byte is a const, not a range, so a later generation filed here is refused rather than partially understood.",
            &wrong_version,
            &key,
            &acct,
            epoch,
            "protocol_version_mismatch",
            true,
        );
        decode_case(
            &mut dump,
            "parse-fail-format-unsupported",
            "parse_fail",
            "The family's own format_version byte set to a value no client writes. The protocol_version and the format_version are SEPARATE bytes for this reason: the major generation and the family's layout revision move independently.",
            &wrong_format,
            &key,
            &acct,
            epoch,
            "format_unsupported",
            true,
        );
        decode_case(
            &mut dump,
            "parse-fail-ciphertext-len-overflow",
            "parse_fail",
            "The 4-byte big-endian length at offset 30 declaring 0xFFFFFFFF, far past the family's 4 MiB plaintext cap. Bounded before it is used to slice, so a 34-byte input cannot make a reader attempt a 4 GiB read.",
            &len_overflow,
            &key,
            &acct,
            epoch,
            "ciphertext_len_overflow",
            true,
        );
        decode_case(
            &mut dump,
            "parse-fail-ciphertext-truncated",
            "parse_fail",
            "A length that is legal but runs past the end of the input: 1000 bytes declared, none present. A truncation is a damaged file, an overflow is a malformed header, and a caller that re-uploads wants to tell them apart.",
            &truncated,
            &key,
            &acct,
            epoch,
            "ciphertext_truncated",
            true,
        );
        decode_case(
            &mut dump,
            "parse-fail-map-malformed",
            "parse_fail",
            "A blob that opens correctly and whose plaintext is not a well-formed map: the key is not a 32-character lowercase-hex device_id. The AEAD is not at fault, which is exactly why this is a separate variant from cannot_decrypt: the bytes were authentic and the CONTENT is wrong.",
            &seal_plaintext(
                b"{\"not-a-device-id\":{\"person_fingerprint\":\"aa\",\"version\":1,\"tombstone\":false,\"signature_hex\":\"aa\"}}",
            ),
            &key,
            &acct,
            epoch,
            "plaintext_parse_failed",
            true,
        );
        decode_case(
            &mut dump,
            "parse-fail-map-not-canonical",
            "parse_fail",
            "A blob whose plaintext parses to a valid map but is not the canonical ENCODING of it: the same bytes with one incidental space after a colon. It is refused rather than accepted-and-normalised, because two implementations that disagreed about whitespace would produce different blob bytes for the same map, and the sync layer compares blobs.",
            &seal_plaintext(&non_canonical),
            &key,
            &acct,
            epoch,
            "not_canonical",
            true,
        );

        // ===== encode_fail ====================================================
        let encode_case = |dump: &mut String,
                           slug: &str,
                           description: &str,
                           map: &DeviceBindingsMap,
                           writer_epoch: u64,
                           expected: &str,
                           trailing: bool| {
            let got = encode_device_binding_blob_raw(&key, &acct, writer_epoch, map, &nonce)
                .expect_err(&format!("[{slug}] expected {expected}"));
            assert_eq!(err_name(&got), expected, "[{slug}] mislabelled error");
            let body = format!(
                "      \"input_device_binding_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_group_key_epoch\": {},\n      \"input_nonce_hex\": \"{}\",\n      \"input_map\": {},\n      \"expected_error\": \"{}\"\n",
                hex_lower(&key),
                hex_lower(&acct),
                writer_epoch,
                hex_lower(&nonce),
                map_json(map),
                expected,
            );
            case(dump, slug, "encode_fail", description, &body, trailing);
        };

        let mut bad_fingerprint = DeviceBindingsMap::new();
        let mut row = entry(&fp(0x0e), 1, false);
        row.person_fingerprint = "aa".to_string();
        bad_fingerprint.insert(hex_lower(&dev_c), row);
        encode_case(
            &mut dump,
            "encode-fail-fingerprint-wrong-shape",
            "A row whose person_fingerprint is not 64 lowercase hex characters. The writer REFUSES rather than truncating or padding: a truncated fingerprint names a person who does not exist, and a padded one would silently bind the device to whatever real member the padded bytes happened to reach.",
            &bad_fingerprint,
            epoch,
            "plaintext_parse_failed",
            true,
        );
        encode_case(
            &mut dump,
            "encode-fail-epoch-zero",
            "The write-side epoch-zero guard. The AAD builder would happily produce 54 bytes for epoch 0, so the refusal has to live in the writer; without it a binding could be sealed at an epoch no rotation ever produced, and its reader would have no epoch to name. The guard runs before the map is touched, so the empty map is the subject.",
            &empty,
            0,
            "epoch_zero",
            true,
        );

        // ===== merge ==========================================================
        // The merge is a cross-implementation contract, so its two arms are pinned: the
        // version arm, which every sibling has, and the refusal, which no sibling has.
        let merge_case = |dump: &mut String,
                          slug: &str,
                          description: &str,
                          a: &DeviceBindingsMap,
                          b: &DeviceBindingsMap,
                          trailing: bool| {
            match merge_device_bindings(a, b) {
                Ok(merged) => {
                    // Order independence is asserted at generation, not asserted in prose.
                    assert_eq!(
                        merged,
                        merge_device_bindings(b, a).expect("the reverse order must also merge"),
                        "[{slug}] the merge must not depend on argument order"
                    );
                    let body = format!(
                        "      \"input_map_a\": {},\n      \"input_map_b\": {},\n      \"expected_merged_map\": {}\n",
                        map_json(a),
                        map_json(b),
                        map_json(&merged),
                    );
                    case(dump, slug, "merge", description, &body, trailing);
                }
                Err(e) => {
                    assert_eq!(
                        err_name(&e),
                        "conflicting_binding",
                        "[{slug}] only the refusal arm may fail"
                    );
                    assert_eq!(
                        merge_device_bindings(b, a).err().as_ref().map(err_name),
                        Some("conflicting_binding"),
                        "[{slug}] the refusal must not depend on argument order either"
                    );
                    let body = format!(
                        "      \"input_map_a\": {},\n      \"input_map_b\": {},\n      \"expected_error\": \"conflicting_binding\"\n",
                        map_json(a),
                        map_json(b),
                    );
                    case(dump, slug, "merge", description, &body, trailing);
                }
            }
        };

        // The same device, moved from one person to another at a HIGHER version: the
        // version arm resolves it, and neither order may disagree.
        let mut moved_a = DeviceBindingsMap::new();
        moved_a.insert(hex_lower(&dev_a), entry(&fp(0x0e), 3, false));
        let mut moved_b = DeviceBindingsMap::new();
        moved_b.insert(hex_lower(&dev_a), entry(&fp(0x0f), 4, false));
        merge_case(
            &mut dump,
            "merge-rebind-resolves-by-version",
            "The same device bound to two different people at DIFFERENT versions: the higher version wins, which is what makes a re-bind just another write. Merged in either order the same map comes back, so two peers that saw the two claims in opposite orders converge instead of re-pushing at each other.",
            &moved_a,
            &moved_b,
            true,
        );
        // The same device, two different people, one version: refused.
        let mut tie_a = DeviceBindingsMap::new();
        tie_a.insert(hex_lower(&dev_a), entry(&fp(0x0e), 3, false));
        let mut tie_b = DeviceBindingsMap::new();
        tie_b.insert(hex_lower(&dev_a), entry(&fp(0x0f), 3, false));
        merge_case(
            &mut dump,
            "merge-same-version-two-people-refused",
            "The ONE pair with no winner: the same device bound to two DIFFERENT people at the SAME version. Every remaining field is either equal (the version) or the thing under dispute (the person), so resolving it would make merge(a, b) and merge(b, a) disagree, each peer would keep its own row and re-push it every cycle, and the device would sit under two members forever. The merge REFUSES rather than inventing a winner; a fresh claim at a strictly higher version is the repair. This is the family's one case_kind a sibling family does not have.",
            &tie_a,
            &tie_b,
            true,
        );
        // A tombstone against a live row at the same version, same person: the tombstone
        // arm decides it, and it decides it the same way in either order.
        let mut live_same = DeviceBindingsMap::new();
        live_same.insert(hex_lower(&dev_b), entry(&fp(0x0e), 4, false));
        let mut dead_same = DeviceBindingsMap::new();
        dead_same.insert(hex_lower(&dev_b), entry(&fp(0x0e), 4, true));
        merge_case(
            &mut dump,
            "merge-tombstone-beats-live-at-equal-version",
            "A tombstone against a live entry for the same device and the same person at the same version. The tombstone wins in either order, so a device whose person was removed from the vault cannot be resurrected by a concurrent re-claim. Paired with the refusal case above, which is the pair this arm deliberately does NOT cover: two DIFFERENT people is not a removal.",
            &live_same,
            &dead_same,
            true,
        );

        // ===== signed_bytes ===================================================
        let bytes_case = |dump: &mut String,
                          slug: &str,
                          description: &str,
                          id: &[u8; 16],
                          fingerprint: &[u8; 32],
                          version: u64,
                          tombstone: bool,
                          trailing: bool| {
            let body = format!(
                "      \"input_device_id_hex\": \"{}\",\n      \"input_person_fingerprint_hex\": \"{}\",\n      \"input_version\": {},\n      \"input_tombstone\": {},\n      \"expected_prefix_ascii\": \"myne.device-binding v1|\",\n      \"informational_message_len_bytes\": {},\n      \"expected_message_hex\": \"{}\"\n",
                hex_lower(id),
                hex_lower(fingerprint),
                version,
                tombstone,
                DEVICE_BINDING_PREFIX.len() + 16 + 32 + 8 + 1,
                bytes_hex(id, fingerprint, version, tombstone),
            );
            case(dump, slug, "signed_bytes", description, &body, trailing);
        };

        bytes_case(
            &mut dump,
            "signed-bytes-live-row",
            "The exact bytes one row's hybrid signature covers: the class prefix, then the DEVICE id as 16 raw bytes, then the CLAIMED person fingerprint as 32 raw bytes (not their hex), then the version as 8 big-endian bytes, then one tombstone byte. Fixed widths rather than canonical JSON, so there is exactly one encoding and no ambiguity about where a field ends. The prefix is the load-bearing identifier: changing it moves every row's signature into a different class.",
            &dev_a,
            &fingerprint(0x0e),
            3,
            false,
            true,
        );
        bytes_case(
            &mut dump,
            "signed-bytes-tombstone",
            "A removal's message: identical framing and the tombstone byte 1. Unlike the member-names family, whose tombstone's message drops the name entirely, the fingerprint is STILL present, because a removal here records which binding it removes. The message is 80 bytes and a port that omitted the fingerprint for a tombstone would produce a different one.",
            &dev_b,
            &fingerprint(0x0e),
            9,
            true,
            true,
        );
        bytes_case(
            &mut dump,
            "signed-bytes-rebind-at-higher-version",
            "The same device and person at a higher version: the version is inside the signed message, so a co-member cannot bump a signed row to win the merge against a genuine later re-bind. Re-writing a binding means re-signing it.",
            &dev_c,
            &fingerprint(0x0f),
            10,
            false,
            true,
        );

        // ===== verify =========================================================
        let verify_case = |dump: &mut String,
                           slug: &str,
                           description: &str,
                           verifier: &str,
                           id: &[u8; 16],
                           row: &DeviceBindingEntry,
                           public: &crate::person_key::PersonPublicHalf,
                           expected: bool,
                           trailing: bool| {
            // Assert the outcome here, so the pin and the code cannot disagree.
            let got = if verifier == "owner" {
                verify_device_binding_removal(public, id, row)
            } else {
                verify_device_binding(public, id, row)
            };
            assert_eq!(got, expected, "[{slug}] mislabelled verification outcome");
            // The three public-half parts the case publishes must REBUILD the very key
            // that just produced `got`. Without this, a hand-edited or mis-wired signer
            // field would pin a case whose expected outcome no longer describes the key
            // beside it.
            let rebuilt = crate::person_key::PersonPublicHalf::from_parts_hex(
                &hex_lower(public.kem_ek()),
                &hex_lower(public.ed_pk()),
                &hex_lower(public.mldsa_vk()),
            )
            .expect("the emitted public-half parts must round-trip");
            assert_eq!(
                (
                    rebuilt.kem_ek(),
                    rebuilt.ed_pk(),
                    rebuilt.mldsa_vk(),
                    rebuilt.fingerprint()
                ),
                (
                    public.kem_ek(),
                    public.ed_pk(),
                    public.mldsa_vk(),
                    public.fingerprint()
                ),
                "[{slug}] the published public half must be the verifying key"
            );
            let signed = device_binding_signed_bytes(
                id,
                &fingerprint_from_hex(&row.person_fingerprint).expect("row fingerprint"),
                row.version,
                row.tombstone,
            );
            let body = format!(
                "      \"verifier\": \"{verifier}\",\n      \"input_device_id_hex\": \"{}\",\n{}{}      \"informational_signed_bytes_hex\": \"{}\",\n      \"expected_verified\": {}\n",
                hex_lower(id),
                entry_json(row),
                signer_json(public),
                hex_lower(&signed),
                expected,
            );
            case(dump, slug, "verify", description, &body, trailing);
        };

        verify_case(
            &mut dump,
            "verify-own-signer",
            "The accepting case: a live row signed by the person the row claims, checked against that person's public half from the roster. Everything below is a refusal of the same shape.",
            "person",
            &dev_a,
            &live_row,
            &a_pub,
            true,
            true,
        );
        verify_case(
            &mut dump,
            "verify-wrong-signer-refused",
            "The same valid signature and the same claiming row, checked against B's public half. Refused, and refused for a reason the member-names family reaches a different way: there the map key is the person, so a row is only ever looked up under its own author. Here the person lives INSIDE the row, so the claimed fingerprint is compared against the verifying key's own fingerprint as well as being inside the signed message. Without that second check a member could sign a message carrying a co-member's fingerprint and have it verify against their own key, which is the exact impersonation this family exists to prevent.",
            "person",
            &dev_a,
            &live_row,
            &b_pub,
            false,
            true,
        );
        verify_case(
            &mut dump,
            "verify-device-id-is-bound",
            "The same valid signature and the same claimant, checked against a DIFFERENT device id, so the id inside the signed message is what refuses it, not the key. Without this binding a member could capture one signed row and have it appear for any device in the vault.",
            "person",
            &dev_c,
            &live_row,
            &a_pub,
            false,
            true,
        );
        let mut bumped = live_row.clone();
        bumped.version = live_row.version + 1;
        verify_case(
            &mut dump,
            "verify-altered-version-refused",
            "The version incremented after signing. The version IS the counter that decides which binding wins a merge, so an unauthenticated version is an attacker choosing who a device belongs to.",
            "person",
            &dev_a,
            &bumped,
            &a_pub,
            false,
            true,
        );
        let mut refiled = live_row.clone();
        refiled.person_fingerprint = hex_lower(&fingerprint(0x0f));
        verify_case(
            &mut dump,
            "verify-altered-fingerprint-refused",
            "The claimed person rewritten after signing, signature untouched. This is the case that matters most: the fingerprint is what the whole family exists to carry, and a co-member who could rewrite it could file another member's device under themselves.",
            "person",
            &dev_a,
            &refiled,
            &a_pub,
            false,
            true,
        );
        let mut flipped = live_row.clone();
        flipped.tombstone = true;
        verify_case(
            &mut dump,
            "verify-altered-tombstone-refused",
            "The tombstone flag flipped after signing. Without this an attacker could resurrect a removed device by turning a tombstone back into a live row, or remove one by the reverse, which is the merge's tombstone arm being decided by whoever can write the blob rather than by the person.",
            "person",
            &dev_a,
            &flipped,
            &a_pub,
            false,
            true,
        );
        verify_case(
            &mut dump,
            "verify-owner-signed-tombstone",
            "The vault OWNER removing member B's device: the row claims B's fingerprint and the signature is the owner's. Accepted by the removal check, which is how a device stops being bound when the owner removes its person from the vault. The claimed fingerprint is deliberately NOT compared against the owner's own here, which is what lets an owner sign over a member's row.",
            "owner",
            &dev_b,
            &owner_tombstone,
            &owner_pub,
            true,
            true,
        );
        verify_case(
            &mut dump,
            "verify-owner-signature-is-not-a-claim",
            "The SAME owner-signed tombstone checked against the public half of the member the row claims (B). Refused: the owner's key is not B's, so a removal never reads as B's own claim. This is why partition_verified_bindings takes the owner's public half as a SEPARATE argument and reaches for it only on a tombstone.",
            "person",
            &dev_b,
            &owner_tombstone,
            &b_pub,
            false,
            true,
        );
        verify_case(
            &mut dump,
            "verify-owner-live-row-refused",
            "An owner signature over a LIVE row (the tombstone flag cleared). verify_device_binding_removal refuses anything that is not a tombstone before it looks at the signature, so an owner can never use the removal path as a binding-writing path. Paired with the case above so both halves of the split are pinned.",
            "owner",
            &dev_b,
            &live_row,
            &owner_pub,
            false,
            true,
        );

        // ===== group_subkey ===================================================
        // The family's one role is GROUP-tier: derived from the group key, not from the
        // root key. There is no SubkeyRole counterpart, which is why it is pinned here
        // rather than in hkdf-sha256: that category's runner and its schema are both
        // keyed on derive_subkey_v0_2(root_key, …).
        let subkey_case = |dump: &mut String,
                           slug: &str,
                           description: &str,
                           role: GroupRole,
                           role_str: &str,
                           trailing: bool| {
            let derived = derive_group_subkey_v0_2(&GroupKey::new(group_key), role);
            assert_ne!(
                &derived[..],
                &group_key[..],
                "[{slug}] a derived subkey must not be the group key itself"
            );
            let body = format!(
                "      \"input_group_key_hex\": \"{}\",\n      \"input_role\": \"{}\",\n      \"expected_subkey_hex\": \"{}\"\n",
                hex_lower(&group_key),
                role_str,
                hex_lower(&derived[..]),
            );
            case(dump, slug, "group_subkey", description, &body, trailing);
        };
        subkey_case(
            &mut dump,
            "group-subkey-device-binding-key",
            "GroupRole::DeviceBindingKey ('device-binding-key'): the KEK the MYU5 envelope is sealed under, derived from the group key rather than the root key. The HKDF context prefix is the v0.2 one, so the same role under a later major is a different key. A pre-B2B vault has no group key and therefore no binding map at all, which is why there is no root-tier counterpart role.",
            GroupRole::DeviceBindingKey,
            "device-binding-key",
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");
        std::println!("{dump}");
    }
}
