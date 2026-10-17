// SPDX-License-Identifier: AGPL-3.0

//! B2B member display names: the `MYO5` vault singleton codec (`docs/spec/protocol.md`
//! §9.29, `decisions/protocol/0666`).
//!
//! One blob per shared vault holding a versioned, optionally tombstoned map of
//! `person_id_hash -> { name, version, tombstone }`. The blob is sealed under the
//! GROUP tier, so every member reads every name and only members read any:
//! `member_names_key = derive_group_subkey_v0_2(group_key, GroupRole::MemberNamesKey)`,
//! with the 8-byte `group_key_epoch` bound into the AAD in the
//! `aad_group_roster_blob` order, so a post-rotation blob from a retired epoch
//! fails AEAD verification rather than being read under a key that no longer
//! applies.
//!
//! **This family is `NTV6`-only.** A pre-B2B `NTV5` vault has no `group_key`: a
//! legacy member holds the `itemsKey`, and every shared singleton in that
//! generation is derived from the owner's `root_key`, so a member-writable,
//! member-readable name blob cannot exist there. It arrives with the existing
//! owner-approved B2B migration, which seeds it empty. That is why there is no
//! `MY?1` form and no `SubkeyRole` counterpart, and why the `MYO5` row of the
//! §10.3 table is marked B2B-only like `NTV6` and `MYY5`.
//!
//! ## On-disk layout
//!
//! ```text
//! Offset  Size  Field              Notes
//! ------  ----  -----------------  -----------------------------------------
//! 0       4     magic              ASCII "MYO5"
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
//! The plaintext is a canonical-JSON object whose keys are `person_id_hash` in
//! lowercase hex and whose values are [`MemberNameEntry`]. Canonical means the
//! parser re-serializes and requires BYTE EQUALITY with its input, the
//! discipline the owner-signed group roster already uses: a map that is well
//! formed but not canonical is refused, so two implementations agree on which
//! byte strings are blobs of this family.
//!
//! The codec owns the map rather than leaving it opaque (as `vault.themes` does)
//! because the MERGE is cross-implementation: two members renaming at the same
//! time must converge on the same winner on every client, so the tie-break is a
//! contract rather than a client detail. It opens with the roster's two arms: the
//! higher `version` wins, and at EQUAL version a tombstone beats a live entry, so
//! "removed" cannot be resurrected by a concurrent rename. It then goes one arm
//! further than the roster does, comparing `name` and then `signature_hex` as
//! bytes, because a roster addresses ONE member per key while a name map has one
//! person renaming from two offline devices at the same version. See `beats` for
//! why those arms are load-bearing rather than decoration.
//!
//! A tombstone is KEPT in the blob rather than deleted: dropping it would let a
//! stale copy re-introduce the name on the next merge. The live view filters
//! tombstones out, exactly as the roster view filters its deleted rows.
//!
//! ## Each row is signed by the person it names
//!
//! The map is group-sealed, so any member can WRITE it: sealing under the group key
//! is what makes every member read every name, and it is also what stops the seal
//! from being an authority over who wrote what. Each row therefore carries a hybrid
//! Ed25519 + ML-DSA-65 signature under the `"myne.member-name v1|"` class, over the
//! person the row NAMES together with the row's own fields at fixed widths. It is
//! verified on read against that person's public half (which the roster already
//! carries), so a member cannot name another member's row as theirs, and cannot
//! alter a name, a version or a tombstone either.
//!
//! **What that is worth, stated plainly.** `docs/decisions/protocol/0660` records
//! that a revision's actor is NOT a signature: anyone who can edit the document can
//! set it. The signature here protects the NAME RECORD, not the authorship of a
//! note, and the surfaces that render a name must not imply otherwise. What it buys
//! is that a name is its owner's, not merely whoever wrote the blob last.
//!
//! A row may also be removed by the vault OWNER, because that is how a member's row
//! goes away when the owner removes them from the vault. Both authorities are
//! accepted, and only those two: [`verify_member_name`] for a row's own person and
//! [`verify_member_removal`] for an owner-signed tombstone.
//!
//! ## Fall-back-to-empty
//!
//! Like its siblings this module emits honest errors for each failure mode, and
//! [`decode_member_names_or_empty`] collapses all of them to the empty map for a
//! caller to whom "no blob", "truncated", "AEAD failure" and "unsupported format"
//! all mean the same thing. The per-error surface is kept as well, because a tampered
//! blob and an absent one must be distinguishable to the code that decides whether to
//! re-upload, and [`decode_member_names_blob`] is the reader that answers that.
//!
//! **The empty map is a read-only answer, and the reader that breaks that costs a silent
//! lost update rather than an error.** A caller holding `decode_member_names_or_empty`
//! cannot tell "nobody has named themselves yet" from "the blob is damaged", so putting
//! one on the read half of a read-modify-write means a damaged blob is replaced by a map
//! carrying only this session's own row. Every other member's name is dropped, and the
//! dropped rows carry no tombstone, so no later merge can notice: the write succeeds and
//! the map looks authoritatively correct ever after. `store.rs` is the one place in this
//! project that reads this family in order to write it, and it calls
//! [`decode_member_names_blob`] and maps the error; the helper below has no production
//! caller at all.

use crate::aead::{aad_member_names_blob, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::blob_envelope::{decode_blob_envelope, encode_blob_envelope, EnvelopeError};
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Magic bytes at offset 0: ASCII `"MYO5"`. The `MY?5` letter pool was exactly two
/// letters deep (`O` and `U`) at the time of allocation; `MYU5` was allocated in the
/// same breath for the device-to-person binding family of the sister feature, which
/// now ships (`protocol.md` §9.30).
pub const MEMBER_NAMES_BLOB_MAGIC: [u8; 4] = *b"MYO5";

/// AAD role string bound into the seal (§5.2). Distinct from every sibling role
/// so a member-names blob can never be opened as another family.
pub const MEMBER_NAMES_BLOB_AAD_ROLE: &[u8] = b"member-names-blob";

/// `format_version` byte at offset 5: the canonical-JSON map schema below.
/// A future revision of the inner schema bumps this so an older decoder rejects
/// cleanly instead of half-parsing.
pub const MEMBER_NAMES_BLOB_FORMAT_V1: u8 = 0x01;

/// The registered message-class prefix every row's signature covers
/// (`protocol/src/member_names_blob.rs`; `decisions/protocol/0666`). A signature
/// class, minted whole, so a name signature can never be replayed as a roster,
/// invite, transition or awareness assertion, nor the reverse.
pub const MEMBER_NAME_PREFIX: &[u8] = b"myne.member-name v1|";

/// Signature bytes one row carries: the Ed25519 half then the ML-DSA-65 half.
pub const MEMBER_NAME_SIGNATURE_LEN: usize =
    crate::person_key::PERSON_ED25519_SIG_LEN + crate::person_key::PERSON_MLDSA_SIG_LEN;

/// The same, hex-encoded (lowercase), which is how the row's JSON carries it.
pub const MEMBER_NAME_SIGNATURE_HEX_LEN: usize = MEMBER_NAME_SIGNATURE_LEN * 2;

/// Fixed header length: magic 4 + protocol version 1 + format version 1 + nonce 24
/// + ciphertext length 4.
pub const MEMBER_NAMES_BLOB_HEADER_LEN: usize = 34;

/// Cap on one display name, in UTF-8 bytes. A name is a label, not a document; the
/// cap is the entry's own bound, and the whole-map cap below is the blob's.
pub const MAX_MEMBER_NAME_LEN: usize = 64;

/// Cap on the inner plaintext (the whole map). 4 MiB, the same cap as
/// `vault.themes` / `vault.dictionary`, and sized here by arithmetic rather than by
/// feel: one row is a name (up to [`MAX_MEMBER_NAME_LEN`]) plus a hybrid signature
/// hex-encoded at `(64 + 3309) * 2 = 6746` characters, so a row is roughly 6.8 KiB and
/// the cap holds around 600 members before it binds. It turns a hostile
/// `ciphertext_len` into a clean error rather than an absurd allocation.
pub const MAX_MEMBER_NAMES_PLAINTEXT_LEN: usize = 4 * 1024 * 1024;

/// Length of a `person_id_hash` in lowercase hex.
const PERSON_ID_HEX_LEN: usize = 32;

/// One member's row in the name map.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberNameEntry {
    /// The member's chosen display name. Never empty for a live entry.
    pub name: String,
    /// The row's monotonic version. Two members renaming at once resolve by this,
    /// so it is a wall-clock-free counter rather than a timestamp: a clock skew
    /// between devices must not decide whose rename wins.
    pub version: u64,
    /// A tombstone removes the name and WINS at equal version, so a concurrent
    /// rename cannot resurrect a member who was removed.
    pub tombstone: bool,
    /// Hybrid Ed25519 + ML-DSA-65 signature over
    /// `"myne.member-name v1|" || person_id || version || tombstone || name`,
    /// lowercase hex, produced by the person this row NAMES. Verified on read
    /// against that person's public half; an owner-signed tombstone is accepted
    /// instead for a removal. See [`sign_member_name`].
    pub signature_hex: String,
}

/// The canonical map: `person_id_hash (lowercase hex) -> row`.
pub type MemberNamesMap = BTreeMap<String, MemberNameEntry>;

/// Failure modes of the `MYO5` codec. The first nine mirror the shared envelope's
/// surface (a distinguishable variant per structural failure, then the single
/// non-distinguishing decrypt error); the last three are this family's own.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum MemberNamesBlobError {
    /// Input shorter than [`MEMBER_NAMES_BLOB_HEADER_LEN`].
    #[error("vault.member-names blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYO5`.
    #[error("vault.member-names blob magic mismatch (expected MYO5)")]
    MagicMismatch,
    /// The `protocol_version` byte is not `0x01`.
    #[error("vault.member-names blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// The `format_version` byte is not one this client understands.
    #[error("vault.member-names blob format_version unsupported")]
    MemberNamesFormatUnsupported,
    /// The declared `ciphertext_len` exceeds the map cap.
    #[error("vault.member-names blob ciphertext_len overflows the cap")]
    CiphertextLenOverflow,
    /// The declared `ciphertext_len` runs past the end of the input.
    #[error("vault.member-names blob ciphertext truncated")]
    CiphertextTruncated,
    /// The AEAD seal did not open. Non-distinguishing by design (§6.4): a wrong
    /// key, a tampered byte and a stale epoch are one answer.
    #[error("vault.member-names blob could not be decrypted")]
    CannotDecrypt,
    /// Randomness unavailable while sealing.
    #[error("vault.member-names blob randomness unavailable")]
    RandomnessUnavailable,
    /// The plaintext is not a well-formed map (bad JSON, a key that is not a
    /// `person_id_hash`, an empty name, a name over the cap).
    #[error("vault.member-names map is malformed")]
    MapMalformed,
    /// The plaintext parses but is not the canonical encoding of what it parsed
    /// to, so two implementations would disagree on its bytes.
    #[error("vault.member-names map is not canonical")]
    MapNotCanonical,
    /// The `group_key_epoch` bound into the AAD is zero, which no writer produces.
    #[error("vault.member-names blob epoch is zero")]
    EpochZero,
    /// The row could not be signed, which means the signer refused (an over-long ctx
    /// or a failing RNG); nothing was written.
    #[error("vault.member-names row could not be signed")]
    SignatureUnavailable,
}

impl From<EnvelopeError> for MemberNamesBlobError {
    fn from(e: EnvelopeError) -> Self {
        match e {
            EnvelopeError::HeaderTooShort => Self::HeaderTooShort,
            EnvelopeError::MagicMismatch => Self::MagicMismatch,
            EnvelopeError::ProtocolVersionMismatch => Self::ProtocolVersionMismatch,
            EnvelopeError::FormatUnsupported => Self::MemberNamesFormatUnsupported,
            EnvelopeError::CiphertextLenOverflow => Self::CiphertextLenOverflow,
            EnvelopeError::CiphertextTruncated => Self::CiphertextTruncated,
            EnvelopeError::CannotDecrypt => Self::CannotDecrypt,
            EnvelopeError::PlaintextTooLarge => Self::CiphertextLenOverflow,
            EnvelopeError::RandomnessUnavailable => Self::RandomnessUnavailable,
        }
    }
}

fn is_person_id_hex(s: &str) -> bool {
    s.len() == PERSON_ID_HEX_LEN && crate::hex::is_lower_hex(s)
}

fn person_id_from_hex(s: &str) -> Option<[u8; 16]> {
    if !is_person_id_hex(s) {
        return None;
    }
    let raw = s.as_bytes();
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        let hi = (raw[i * 2] as char).to_digit(16)? as u8;
        let lo = (raw[i * 2 + 1] as char).to_digit(16)? as u8;
        *byte = (hi << 4) | lo;
    }
    Some(out)
}

fn is_hex_len(s: &str, byte_len: usize) -> bool {
    s.len() == byte_len * 2 && crate::hex::is_lower_hex(s)
}

/// Validate one row against the family's rules.
fn valid_entry(entry: &MemberNameEntry) -> bool {
    // A tombstone carries no name; a live row must carry one within the cap. BOTH
    // must carry a structurally well-formed signature: this layer is structural, and
    // whether that signature is the RIGHT one is [`verify_member_name`]'s question.
    let name_ok = if entry.tombstone {
        entry.name.is_empty()
    } else {
        !entry.name.is_empty() && entry.name.len() <= MAX_MEMBER_NAME_LEN
    };
    name_ok && is_hex_len(&entry.signature_hex, MEMBER_NAME_SIGNATURE_LEN)
}

/// The canonical bytes of a map: `serde_json` over a `BTreeMap` (keys in byte
/// order) with the struct's fields in declaration order.
pub fn encode_member_names_map(map: &MemberNamesMap) -> Result<Vec<u8>, MemberNamesBlobError> {
    for (id, entry) in map {
        if !is_person_id_hex(id) || !valid_entry(entry) {
            return Err(MemberNamesBlobError::MapMalformed);
        }
    }
    serde_json::to_vec(map).map_err(|_| MemberNamesBlobError::MapMalformed)
}

/// Parse a map and require BYTE EQUALITY with its canonical re-encoding, so a
/// non-canonical but well-formed input is refused rather than silently accepted.
pub fn parse_member_names_map(bytes: &[u8]) -> Result<MemberNamesMap, MemberNamesBlobError> {
    let map: MemberNamesMap =
        serde_json::from_slice(bytes).map_err(|_| MemberNamesBlobError::MapMalformed)?;
    for (id, entry) in &map {
        if !is_person_id_hex(id) || !valid_entry(entry) {
            return Err(MemberNamesBlobError::MapMalformed);
        }
    }
    if serde_json::to_vec(&map)
        .map_err(|_| MemberNamesBlobError::MapMalformed)?
        .as_slice()
        != bytes
    {
        return Err(MemberNamesBlobError::MapNotCanonical);
    }
    Ok(map)
}

/// Whether `a` beats `b` for the same `person_id_hash`: the higher version wins,
/// and at EQUAL version a tombstone beats a live entry so a removal is not
/// resurrected by a concurrent rename.
///
/// The last two arms order two DISTINCT rows that agree on version AND on the
/// tombstone flag, which is reachable rather than theoretical: one person
/// renaming from two devices while offline reaches the same version with two
/// different names. Without them the function fell through to `false` both ways
/// and the merge kept the INCUMBENT, so `merge(a, b)` and `merge(b, a)` could
/// disagree on the row they returned, and two peers would each hold their own
/// and re-push it every cycle instead of converging.
///
/// `name` then `signature_hex`, both compared as BYTES. Rust's `String` ordering
/// is byte-wise, and a port must keep it byte-wise rather than reach for a locale
/// collation, or the two sides would pick different winners for the same pair.
/// With these arms the relation is a total order on distinct rows, which is what
/// makes the merge commutative, associative and idempotent rather than merely
/// stable. The signature arm is not decoration: two tombstones at equal version
/// whose `name` is empty are separated by nothing else.
fn beats(a: &MemberNameEntry, b: &MemberNameEntry) -> bool {
    if a.version != b.version {
        return a.version > b.version;
    }
    if a.tombstone != b.tombstone {
        return a.tombstone;
    }
    if a.name != b.name {
        return a.name > b.name;
    }
    a.signature_hex > b.signature_hex
}

/// Merge two copies of the map entry by entry. Commutative, associative and
/// idempotent (`beats` is a total order on distinct rows), so two devices that
/// merged in opposite orders hold the same map and stop re-sending it.
pub fn merge_member_names(a: &MemberNamesMap, b: &MemberNamesMap) -> MemberNamesMap {
    let mut out = a.clone();
    for (id, incoming) in b {
        match out.get(id) {
            None => {
                out.insert(id.clone(), incoming.clone());
            }
            Some(current) => {
                if beats(incoming, current) {
                    out.insert(id.clone(), incoming.clone());
                }
            }
        }
    }
    out
}

/// The live view: rows without tombstones, which is what a member list renders.
pub fn live_member_names(map: &MemberNamesMap) -> MemberNamesMap {
    map.iter()
        .filter(|(_, entry)| !entry.tombstone)
        .map(|(id, entry)| (id.clone(), entry.clone()))
        .collect()
}

/// Seal a member-names map. `member_names_key` MUST be
/// `derive_group_subkey_v0_2(group_key, GroupRole::MemberNamesKey)`, and `epoch`
/// the group epoch that key belongs to; both are bound into the AAD.
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source: nonce reuse under the
/// same key is catastrophic per the XChaCha20-Poly1305 contract. Production callers
/// SHOULD use [`encode_member_names_blob`].
pub fn encode_member_names_blob_raw(
    member_names_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    map: &MemberNamesMap,
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, MemberNamesBlobError> {
    if group_key_epoch == 0 {
        return Err(MemberNamesBlobError::EpochZero);
    }
    let plaintext = encode_member_names_map(map)?;
    let aad = aad_member_names_blob(account_number_hash, group_key_epoch);
    crate::blob_envelope::encode_blob_envelope_raw(
        member_names_key,
        &MEMBER_NAMES_BLOB_MAGIC,
        MEMBER_NAMES_BLOB_FORMAT_V1,
        &aad,
        MAX_MEMBER_NAMES_PLAINTEXT_LEN,
        &plaintext,
        nonce,
    )
    .map_err(MemberNamesBlobError::from)
}

/// [`encode_member_names_blob_raw`] pulling the 24-byte nonce from the OS CSPRNG.
pub fn encode_member_names_blob(
    member_names_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    map: &MemberNamesMap,
) -> Result<Vec<u8>, MemberNamesBlobError> {
    if group_key_epoch == 0 {
        return Err(MemberNamesBlobError::EpochZero);
    }
    let plaintext = encode_member_names_map(map)?;
    let aad = aad_member_names_blob(account_number_hash, group_key_epoch);
    encode_blob_envelope(
        member_names_key,
        &MEMBER_NAMES_BLOB_MAGIC,
        MEMBER_NAMES_BLOB_FORMAT_V1,
        &aad,
        MAX_MEMBER_NAMES_PLAINTEXT_LEN,
        &plaintext,
    )
    .map_err(MemberNamesBlobError::from)
}

/// Open a member-names blob into its map. Every structural check runs before any
/// decryption (magic at its offset, `protocol_version`, `format_version`, then the
/// length bounds), and the map's canonical form is checked after the AEAD opens.
pub fn decode_member_names_blob(
    member_names_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    blob: &[u8],
) -> Result<MemberNamesMap, MemberNamesBlobError> {
    if group_key_epoch == 0 {
        return Err(MemberNamesBlobError::EpochZero);
    }
    let aad = aad_member_names_blob(account_number_hash, group_key_epoch);
    let plaintext = decode_blob_envelope(
        member_names_key,
        &MEMBER_NAMES_BLOB_MAGIC,
        MEMBER_NAMES_BLOB_FORMAT_V1,
        &aad,
        MAX_MEMBER_NAMES_PLAINTEXT_LEN,
        blob,
    )
    .map_err(MemberNamesBlobError::from)?;
    parse_member_names_map(&plaintext)
}

/// [`decode_member_names_blob`] collapsed to the empty map, for a caller to whom
/// "no blob", "truncated", "AEAD failure" and "unsupported format" all mean the same
/// thing: this vault has no names yet.
///
/// **Read-only, and nothing in this project calls it.** Every reader of
/// `vault.member-names` (`core/src/plugins/member_names/store.rs` and `sync.rs`, plus
/// `sync/orchestrator.rs` and `sync/member_removal.rs`) calls
/// [`decode_member_names_blob`] and handles the error; this helper's only callers are
/// the tests below. It is kept rather than deleted for two reasons that are worth
/// stating rather than inferring: the family convention is that each blob module
/// offers the fall-back-to-empty reader beside the honest one
/// (`prefs.rs::read_or_empty` and its siblings), and this file's own emitter names it
/// in a published vector case description (`encrypt-empty-map`), which is a
/// companion-repo artefact this side cannot regenerate on its own.
///
/// It must not go on the read half of a read-modify-write. See the module header's
/// "Fall-back-to-empty": a reader that cannot tell "no names yet" from "the blob is
/// damaged" turns a damaged blob into a silent lost update, because the map it writes
/// back carries only the rows this session knows and the rows it drops carry no
/// tombstone for a later merge to notice.
pub fn decode_member_names_or_empty(
    member_names_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    blob: &[u8],
) -> MemberNamesMap {
    decode_member_names_blob(member_names_key, account_number_hash, group_key_epoch, blob)
        .unwrap_or_default()
}

/// The bytes one row's signature covers: the class prefix, then the person the row
/// NAMES, then the row's own fields at FIXED widths. Fixed widths rather than
/// canonical JSON, so the signed message has exactly one encoding and there is no
/// ambiguity about where a field ends.
///
/// Public because it is the message CLASS, not an internal detail: it is the one
/// assembly a port has to reproduce byte-for-byte to interoperate, and
/// `protocol/tests/vectors.rs` pins it directly against the companion's
/// `signed_bytes` cases. The signature BYTES are deliberately not pinned anywhere,
/// ML-DSA-65's half is randomized, so a pinned signature would only be reproducible
/// by a port that also reproduced our RNG stream, which is exactly why the message
/// has to be checkable on its own.
pub fn member_name_signed_bytes(
    person_id: &[u8; 16],
    version: u64,
    tombstone: bool,
    name: &str,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(MEMBER_NAME_PREFIX.len() + 16 + 8 + 1 + name.len());
    msg.extend_from_slice(MEMBER_NAME_PREFIX);
    msg.extend_from_slice(person_id);
    msg.extend_from_slice(&version.to_be_bytes());
    msg.push(u8::from(tombstone));
    msg.extend_from_slice(name.as_bytes());
    msg
}

/// Build one row, signed by the person it names. This is the only sanctioned way to
/// produce a row [`verify_member_name`] accepts: the signature covers the name, the
/// version AND the tombstone flag, so a co-member cannot alter any of them, and it
/// covers the person the row names, so nobody can claim another member's row.
pub fn sign_member_name(
    person: &crate::person_key::PersonKeyPair,
    person_id: &[u8; 16],
    version: u64,
    tombstone: bool,
    name: &str,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<MemberNameEntry, MemberNamesBlobError> {
    let msg = member_name_signed_bytes(person_id, version, tombstone, name);
    let signed = person
        .sign(&msg, rng)
        .map_err(|_| MemberNamesBlobError::SignatureUnavailable)?;
    let mut bytes = Vec::with_capacity(MEMBER_NAME_SIGNATURE_LEN);
    bytes.extend_from_slice(&signed.ed25519_sig);
    bytes.extend_from_slice(&signed.mldsa_sig);
    Ok(MemberNameEntry {
        name: String::from(name),
        version,
        tombstone,
        signature_hex: crate::hex::encode_lower(&bytes),
    })
}

/// Split a row's hex signature back into its two halves. `None` for anything that
/// is not exactly [`MEMBER_NAME_SIGNATURE_HEX_LEN`] lowercase hex chars.
fn signature_from_hex(s: &str) -> Option<crate::person_key::PersonSigned> {
    if !is_hex_len(s, MEMBER_NAME_SIGNATURE_LEN) {
        return None;
    }
    let raw = s.as_bytes();
    let mut bytes = Vec::with_capacity(MEMBER_NAME_SIGNATURE_LEN);
    for pair in raw.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)? as u8;
        let lo = (pair[1] as char).to_digit(16)? as u8;
        bytes.push((hi << 4) | lo);
    }
    let mut ed25519_sig = [0u8; crate::person_key::PERSON_ED25519_SIG_LEN];
    ed25519_sig.copy_from_slice(&bytes[..crate::person_key::PERSON_ED25519_SIG_LEN]);
    Some(crate::person_key::PersonSigned {
        ed25519_sig,
        mldsa_sig: bytes[crate::person_key::PERSON_ED25519_SIG_LEN..].to_vec(),
    })
}

/// Whether this row was signed by the person it NAMES. `public` is that person's
/// public half from the roster. `false` for a row that claims one person and was
/// signed by another, for a row whose name, version or tombstone was altered after
/// signing, and for a malformed signature.
pub fn verify_member_name(
    public: &crate::person_key::PersonPublicHalf,
    person_id: &[u8; 16],
    entry: &MemberNameEntry,
) -> bool {
    let Some(signed) = signature_from_hex(&entry.signature_hex) else {
        return false;
    };
    let msg = member_name_signed_bytes(person_id, entry.version, entry.tombstone, &entry.name);
    public.verify(&msg, &signed).is_ok()
}

/// Whether this row is a REMOVAL the vault owner signed, which is how a member's row
/// goes away when the owner removes them from the vault. Refuses a live row, so an
/// owner signature can never be used to write a name.
pub fn verify_member_removal(
    owner: &crate::person_key::PersonPublicHalf,
    person_id: &[u8; 16],
    entry: &MemberNameEntry,
) -> bool {
    if !entry.tombstone {
        return false;
    }
    let Some(signed) = signature_from_hex(&entry.signature_hex) else {
        return false;
    };
    let msg = member_name_signed_bytes(person_id, entry.version, entry.tombstone, &entry.name);
    owner.verify(&msg, &signed).is_ok()
}

/// Split a map into the rows whose signature checks out and the ids that do not,
/// accepting the owner's public half for a tombstone. The unverified ids are
/// RETURNED rather than dropped, so a caller can surface a tampered row as
/// unverified instead of silently treating it as absent. `lookup` resolves a row's
/// person id hex to that person's public half (the roster is where they come from).
pub fn partition_verified(
    map: &MemberNamesMap,
    mut lookup: impl FnMut(&str) -> Option<crate::person_key::PersonPublicHalf>,
    owner: Option<&crate::person_key::PersonPublicHalf>,
) -> (MemberNamesMap, Vec<String>) {
    let mut verified = MemberNamesMap::new();
    let mut unverified = Vec::new();
    for (id, entry) in map {
        let Some(person_id) = person_id_from_hex(id) else {
            unverified.push(id.clone());
            continue;
        };
        let person_ok =
            lookup(id).is_some_and(|public| verify_member_name(&public, &person_id, entry));
        let owner_ok =
            entry.tombstone && owner.is_some_and(|o| verify_member_removal(o, &person_id, entry));
        if person_ok || owner_ok {
            verified.insert(id.clone(), entry.clone());
        } else {
            unverified.push(id.clone());
        }
    }
    (verified, unverified)
}

/// The `_raw` seal path is `crate::blob_envelope::encode_blob_envelope_raw` at its
/// one call site above; nothing is kept here.
#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;
    use alloc::string::ToString;
    use alloc::vec;

    const KEY: [u8; AEAD_KEY_LEN] = [0x11; AEAD_KEY_LEN];
    const ACCT: [u8; 16] = [0x22; 16];
    const EPOCH: u64 = 7;

    /// A valid 32-char lowercase-hex person id, distinct per `byte`.
    fn id(byte: u8) -> String {
        let nibble = b"0123456789abcdef"[(byte % 16) as usize] as char;
        core::iter::repeat_n(nibble, PERSON_ID_HEX_LEN).collect()
    }

    /// A structurally well-formed signature placeholder, for tests that do not
    /// exercise verification. The codec is structural; whether a signature is the
    /// RIGHT one is `verify_member_name`'s question.
    fn placeholder_signature() -> String {
        core::iter::repeat_n('a', MEMBER_NAME_SIGNATURE_HEX_LEN).collect()
    }

    fn entry(name: &str, version: u64, tombstone: bool) -> MemberNameEntry {
        MemberNameEntry {
            name: name.to_string(),
            version,
            tombstone,
            signature_hex: placeholder_signature(),
        }
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

    /// A real person id whose hex is the map key, so a signed row can be verified.
    fn person_id(byte: u8) -> [u8; 16] {
        [byte; 16]
    }

    fn signed_row(
        person: &crate::person_key::PersonKeyPair,
        byte: u8,
        name: &str,
        version: u64,
    ) -> (String, MemberNameEntry) {
        let mut rng = SeededRng(0);
        let id = crate::hex::encode_lower(&person_id(byte));
        let row = sign_member_name(person, &person_id(byte), version, false, name, &mut rng)
            .expect("sign");
        (id, row)
    }

    #[test]
    fn round_trips_a_map_including_a_tombstone() {
        let mut map = MemberNamesMap::new();
        map.insert(id(1), entry("Ada", 1, false));
        map.insert(id(2), entry("", 3, true));
        let blob = encode_member_names_blob(&KEY, &ACCT, EPOCH, &map).expect("seal");
        assert_eq!(&blob[0..4], &MEMBER_NAMES_BLOB_MAGIC);
        let back = decode_member_names_blob(&KEY, &ACCT, EPOCH, &blob).expect("open");
        assert_eq!(back, map);
        assert_eq!(live_member_names(&back).len(), 1);
    }

    #[test]
    fn merge_prefers_the_higher_version_regardless_of_order() {
        let mut a = MemberNamesMap::new();
        a.insert(id(1), entry("Old", 1, false));
        let mut b = MemberNamesMap::new();
        b.insert(id(1), entry("New", 2, false));
        assert_eq!(merge_member_names(&a, &b), merge_member_names(&b, &a));
        assert_eq!(merge_member_names(&a, &b).get(&id(1)).unwrap().name, "New");
    }

    #[test]
    fn a_tombstone_beats_a_live_entry_at_equal_version() {
        let mut live = MemberNamesMap::new();
        live.insert(id(1), entry("Ada", 4, false));
        let mut dead = MemberNamesMap::new();
        dead.insert(id(1), entry("", 4, true));
        assert!(
            merge_member_names(&live, &dead)
                .get(&id(1))
                .unwrap()
                .tombstone
        );
        assert!(
            merge_member_names(&dead, &live)
                .get(&id(1))
                .unwrap()
                .tombstone
        );
    }

    #[test]
    fn an_equal_version_equal_tombstone_tie_resolves_the_same_way_in_either_order() {
        // The one case the version and the tombstone arms cannot separate, and the
        // case the two tests around this one both MISS. The tombstone test separates
        // on the FLAG, and `two_members_renaming_concurrently_converge` gives its two
        // renames DIFFERENT person ids, so it merges two disjoint keys and no tie is
        // ever constructed. One person renaming to two names from two offline devices
        // at the same version does construct it, and before `beats` grew its name and
        // signature arms the merge kept whichever row was the INCUMBENT: the two
        // orders disagreed, and each peer re-pushed its own row forever.
        let mut a = MemberNamesMap::new();
        a.insert(id(1), entry("Ada", 4, false));
        let mut b = MemberNamesMap::new();
        b.insert(id(1), entry("Alicia", 4, false));

        let ab = merge_member_names(&a, &b);
        let ba = merge_member_names(&b, &a);
        assert_eq!(ab, ba, "the tie must not depend on argument order");
        // A DEFINED winner, not merely an agreed one, and byte-wise on the name:
        // `Ada` < `Alicia` because `d` < `l`, so a port using a locale collation
        // would land on the other row.
        assert_eq!(ab.get(&id(1)).unwrap().name, "Alicia");
        // Idempotent and associative across the tie, which is the property the sync
        // loop depends on: merging the merged result with either input is a no-op.
        assert_eq!(merge_member_names(&ab, &ab), ab);
        assert_eq!(merge_member_names(&ab, &b), ab);
        assert_eq!(merge_member_names(&a, &ab), ab);
    }

    #[test]
    fn two_tombstones_at_equal_version_are_separated_by_their_signature() {
        // The signature arm on its own, because the name arm cannot reach it here: a
        // tombstone carries no name, so two tombstones at the same version agree on
        // every field but the signature. Reachable because a removal may be signed by
        // the person it names OR by the vault owner, and the two produce different
        // signature bytes over the same row.
        let row = |sig: char| MemberNameEntry {
            name: String::new(),
            version: 7,
            tombstone: true,
            signature_hex: core::iter::repeat_n(sig, MEMBER_NAME_SIGNATURE_HEX_LEN).collect(),
        };
        let mut a = MemberNamesMap::new();
        a.insert(id(1), row('a'));
        let mut b = MemberNamesMap::new();
        b.insert(id(1), row('b'));

        let ab = merge_member_names(&a, &b);
        assert_eq!(ab, merge_member_names(&b, &a));
        // `b` > `a`, so the higher signature wins in either order.
        assert_eq!(
            ab.get(&id(1)).unwrap().signature_hex,
            row('b').signature_hex
        );
    }

    #[test]
    fn merge_is_idempotent() {
        let mut map = MemberNamesMap::new();
        map.insert(id(1), entry("Ada", 2, false));
        assert_eq!(merge_member_names(&map, &map), map);
    }

    #[test]
    fn an_empty_map_round_trips() {
        let blob = encode_member_names_blob(&KEY, &ACCT, EPOCH, &MemberNamesMap::new()).unwrap();
        assert!(decode_member_names_blob(&KEY, &ACCT, EPOCH, &blob)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn an_absent_blob_collapses_to_the_empty_map() {
        assert!(decode_member_names_or_empty(&KEY, &ACCT, EPOCH, &[]).is_empty());
        assert!(decode_member_names_or_empty(&KEY, &ACCT, EPOCH, b"MYO5").is_empty());
    }

    #[test]
    fn a_damaged_blob_is_empty_from_the_helper_and_an_error_from_the_codec() {
        // The one distinction the fall-back-to-empty helper destroys, and the reason the
        // module header forbids it on the read half of a read-modify-write: a reader on
        // that helper cannot tell a damaged blob from a vault nobody has named, so it
        // writes back a map carrying only its own row. Real keys and real framing with ONE
        // flipped ciphertext byte, so the failure is the AEAD tag and nothing structural:
        // a header-invalid fixture would be rejected before decryption and would prove
        // nothing about the distinction.
        let mut map = MemberNamesMap::new();
        map.insert(id(1), entry("Ada", 1, false));
        let good = encode_member_names_blob(&KEY, &ACCT, EPOCH, &map).expect("seal a one-row map");
        let mut damaged = good.clone();
        let last = damaged.len() - 1;
        damaged[last] ^= 0x01;

        assert_eq!(
            decode_member_names_blob(&KEY, &ACCT, EPOCH, &damaged),
            Err(MemberNamesBlobError::CannotDecrypt),
            "the honest reader must name the failure"
        );
        assert!(
            decode_member_names_or_empty(&KEY, &ACCT, EPOCH, &damaged).is_empty(),
            "and the fall-back reader must be the one that cannot, which is why a writer \
             may not sit on it"
        );
        // The fixture is only a fixture if the untouched bytes DO open, or the assertion
        // above would hold for a blob that was never valid.
        assert!(decode_member_names_blob(&KEY, &ACCT, EPOCH, &good).is_ok());
    }

    #[test]
    fn a_wrong_epoch_fails_the_aead() {
        let mut map = MemberNamesMap::new();
        map.insert(id(1), entry("Ada", 1, false));
        let blob = encode_member_names_blob(&KEY, &ACCT, EPOCH, &map).unwrap();
        assert_eq!(
            decode_member_names_blob(&KEY, &ACCT, EPOCH + 1, &blob),
            Err(MemberNamesBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn a_zero_epoch_is_refused_on_both_paths() {
        assert_eq!(
            encode_member_names_blob(&KEY, &ACCT, 0, &MemberNamesMap::new()),
            Err(MemberNamesBlobError::EpochZero)
        );
        assert_eq!(
            decode_member_names_blob(&KEY, &ACCT, 0, &[0u8; 40]),
            Err(MemberNamesBlobError::EpochZero)
        );
    }

    #[test]
    fn a_foreign_magic_and_a_bad_version_are_named() {
        let blob = encode_member_names_blob(&KEY, &ACCT, EPOCH, &MemberNamesMap::new()).unwrap();
        let mut foreign = blob.clone();
        foreign[0..4].copy_from_slice(b"MYT5");
        assert_eq!(
            decode_member_names_blob(&KEY, &ACCT, EPOCH, &foreign),
            Err(MemberNamesBlobError::MagicMismatch)
        );
        let mut bad_version = blob.clone();
        bad_version[4] = 0x09;
        assert_eq!(
            decode_member_names_blob(&KEY, &ACCT, EPOCH, &bad_version),
            Err(MemberNamesBlobError::ProtocolVersionMismatch)
        );
        let mut bad_format = blob.clone();
        bad_format[5] = 0x09;
        assert_eq!(
            decode_member_names_blob(&KEY, &ACCT, EPOCH, &bad_format),
            Err(MemberNamesBlobError::MemberNamesFormatUnsupported)
        );
    }

    #[test]
    fn strict_trailing_holds() {
        let blob = encode_member_names_blob(&KEY, &ACCT, EPOCH, &MemberNamesMap::new()).unwrap();
        let mut padded = blob.clone();
        padded.push(0);
        // The shared envelope refuses a truncated input; a blob with a byte past
        // its declared ciphertext is not accepted as this family either, because
        // the parser is handed the whole slice.
        let ct_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;
        assert_eq!(blob.len(), MEMBER_NAMES_BLOB_HEADER_LEN + ct_len);
        let mut short = blob.clone();
        short.truncate(blob.len() - 1);
        assert_eq!(
            decode_member_names_blob(&KEY, &ACCT, EPOCH, &short),
            Err(MemberNamesBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn a_malformed_map_is_named_and_a_non_canonical_one_is_too() {
        assert_eq!(
            parse_member_names_map(b"not json"),
            Err(MemberNamesBlobError::MapMalformed)
        );
        // A well-formed map whose keys are not person ids.
        assert_eq!(
            parse_member_names_map(
                br#"{"nope":{"name":"Ada","version":1,"tombstone":false,"signature_hex":"aa"}}"#
            ),
            Err(MemberNamesBlobError::MapMalformed)
        );
        // A live entry with no name.
        let blank = format!(
            r#"{{"{}":{{"name":"","version":1,"tombstone":false,"signature_hex":"{}"}}}}"#,
            crate::hex::encode_lower(&person_id(0x11)),
            placeholder_signature()
        );
        assert_eq!(
            parse_member_names_map(blank.as_bytes()),
            Err(MemberNamesBlobError::MapMalformed)
        );
        // A name over the cap.
        let long = "x".repeat(MAX_MEMBER_NAME_LEN + 1);
        let over = format!(
            r#"{{"{}":{{"name":"{}","version":1,"tombstone":false,"signature_hex":"{}"}}}}"#,
            crate::hex::encode_lower(&person_id(0x11)),
            long,
            placeholder_signature()
        );
        assert_eq!(
            parse_member_names_map(over.as_bytes()),
            Err(MemberNamesBlobError::MapMalformed)
        );
        // A signature that is not the right shape, refused at the writer.
        let mut short_sig = MemberNamesMap::new();
        let mut row = entry("Ada", 1, false);
        row.signature_hex = "aa".to_string();
        short_sig.insert(crate::hex::encode_lower(&person_id(0x11)), row);
        assert_eq!(
            encode_member_names_map(&short_sig),
            Err(MemberNamesBlobError::MapMalformed)
        );
        // Well formed, every field present and correctly shaped, but NOT the
        // canonical byte encoding: the fields are written out of declaration order,
        // so the re-serialization differs and the parse is refused by name.
        let non_canonical = format!(
            r#"{{"{}":{{"version":1,"tombstone":false,"name":"Ada","signature_hex":"{}"}}}}"#,
            crate::hex::encode_lower(&person_id(0x11)),
            placeholder_signature()
        );
        assert_eq!(
            parse_member_names_map(non_canonical.as_bytes()),
            Err(MemberNamesBlobError::MapNotCanonical)
        );
    }

    #[test]
    fn two_members_may_choose_the_same_name() {
        // Story 19: nothing keys on the name, so a duplicate is not a collision and
        // both rows survive a merge.
        let mut a = MemberNamesMap::new();
        a.insert(id(1), entry("Ada", 1, false));
        let mut b = MemberNamesMap::new();
        b.insert(id(2), entry("Ada", 1, false));
        let merged = merge_member_names(&a, &b);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged.values().filter(|e| e.name == "Ada").count(), 2);
    }

    #[test]
    fn two_members_renaming_concurrently_converge() {
        // Device A renames person 1 while device B renames person 2; both copies
        // must survive a merge in either order.
        let mut a = MemberNamesMap::new();
        a.insert(id(1), entry("Ada", 5, false));
        let mut b = MemberNamesMap::new();
        b.insert(id(2), entry("Grace", 5, false));
        let ab = merge_member_names(&a, &b);
        let ba = merge_member_names(&b, &a);
        assert_eq!(ab, ba);
        assert_eq!(ab.len(), 2);
    }

    #[test]
    fn a_row_signed_by_its_own_person_verifies_and_survives_the_codec() {
        let ann = pair(b"ann");
        let (id, row) = signed_row(&ann, 0x11, "Ada", 3);
        assert!(verify_member_name(
            &ann.public_half(),
            &person_id(0x11),
            &row
        ));
        let mut map = MemberNamesMap::new();
        map.insert(id, row);
        let blob = encode_member_names_blob(&KEY, &ACCT, EPOCH, &map).expect("seal");
        let back = decode_member_names_blob(&KEY, &ACCT, EPOCH, &blob).expect("open");
        let round_tripped = back
            .get(&crate::hex::encode_lower(&person_id(0x11)))
            .expect("row");
        assert!(verify_member_name(
            &ann.public_half(),
            &person_id(0x11),
            round_tripped
        ));
    }

    #[test]
    fn a_row_naming_one_person_but_signed_by_another_is_refused() {
        let ann = pair(b"ann");
        let bob = pair(b"bob");
        let mut rng = SeededRng(0);
        // Bob signs a row that NAMES Ann's person id.
        let row =
            sign_member_name(&bob, &person_id(0x11), 1, false, "Ada", &mut rng).expect("sign");
        assert!(!verify_member_name(
            &ann.public_half(),
            &person_id(0x11),
            &row
        ));
        assert!(
            verify_member_name(&bob.public_half(), &person_id(0x11), &row),
            "the signature is Bob's, so it verifies only against Bob, never as Ann's row"
        );
    }

    #[test]
    fn an_altered_name_version_or_tombstone_is_refused() {
        let ann = pair(b"ann");
        let (_, row) = signed_row(&ann, 0x11, "Ada", 3);
        let mut renamed = row.clone();
        renamed.name = "Mallory".to_string();
        assert!(!verify_member_name(
            &ann.public_half(),
            &person_id(0x11),
            &renamed
        ));
        let mut bumped = row.clone();
        bumped.version = 99;
        assert!(!verify_member_name(
            &ann.public_half(),
            &person_id(0x11),
            &bumped
        ));
        let mut killed = row.clone();
        killed.tombstone = true;
        assert!(!verify_member_name(
            &ann.public_half(),
            &person_id(0x11),
            &killed
        ));
    }

    #[test]
    fn the_owner_may_sign_a_removal_but_never_a_name() {
        let ann = pair(b"ann");
        let owner = pair(b"owner");
        let mut rng = SeededRng(0);
        let removal =
            sign_member_name(&owner, &person_id(0x11), 5, true, "", &mut rng).expect("sign");
        assert!(verify_member_removal(
            &owner.public_half(),
            &person_id(0x11),
            &removal
        ));
        assert!(!verify_member_name(
            &ann.public_half(),
            &person_id(0x11),
            &removal
        ));
        let live =
            sign_member_name(&owner, &person_id(0x11), 5, false, "Ada", &mut rng).expect("sign");
        assert!(!verify_member_removal(
            &owner.public_half(),
            &person_id(0x11),
            &live
        ));
        assert!(!verify_member_name(
            &ann.public_half(),
            &person_id(0x11),
            &live
        ));
    }

    #[test]
    fn partition_names_the_unverified_ids_rather_than_dropping_them() {
        let ann = pair(b"ann");
        let bob = pair(b"bob");
        let (ann_id, ann_row) = signed_row(&ann, 0x11, "Ada", 1);
        let (_, mut forged) = signed_row(&bob, 0x22, "Bob", 1);
        forged.name = "Not Bob".to_string();
        let bob_id = crate::hex::encode_lower(&person_id(0x22));
        let mut map = MemberNamesMap::new();
        map.insert(ann_id.clone(), ann_row);
        map.insert(bob_id.clone(), forged);
        let (verified, unverified) = partition_verified(
            &map,
            |id| {
                if id == ann_id {
                    Some(ann.public_half())
                } else {
                    Some(bob.public_half())
                }
            },
            None,
        );
        assert_eq!(verified.len(), 1);
        assert!(verified.contains_key(&ann_id));
        assert_eq!(unverified, vec![bob_id]);
    }

    #[test]
    fn a_malformed_signature_hex_is_refused_by_the_codec() {
        let mut map = MemberNamesMap::new();
        let mut row = entry("Ada", 1, false);
        row.signature_hex = "not hex".to_string();
        map.insert(crate::hex::encode_lower(&person_id(0x11)), row);
        assert_eq!(
            encode_member_names_map(&map),
            Err(MemberNamesBlobError::MapMalformed)
        );
    }

    /// Emits `myne-test-vectors/vectors/member-names/v0.2/cases.json` to stdout.
    /// `#[ignore]`; run with:
    /// `cargo test -p protocol --lib emit_member_names_vectors_for_paste -- --ignored --nocapture`
    ///
    /// The family is `NTV6`-only (no v0.1 form, no `SubkeyRole` counterpart), so
    /// this is a v0.2 category and its schema is `schema/v0.2/member-names.json`.
    ///
    /// Seven case kinds, and each one is a different question:
    /// `encrypt` (the envelope over a canonical map, plus the two cap boundaries),
    /// `decrypt_fail` (the single non-distinguishing AEAD answer, reached three
    /// different ways, plus the epoch-zero guard), `parse_fail` (one case per
    /// DISTINGUISHABLE structural variant, so a port that collapses them fails by
    /// name), `encode_fail` (the writer refuses rather than truncates),
    /// `signed_bytes` (the exact bytes one row's hybrid signature covers),
    /// `verify` (who may sign what, and the refusals), `group_subkey` (the family's
    /// two GROUP-tier derivations).
    ///
    /// Every `input_map` is emitted in the CANONICAL byte order, keys ascending,
    /// no whitespace, so the plaintext sealed into `expected_blob_hex` is exactly
    /// the JSON as written. The generator asserts that rather than asserting it in
    /// prose, because a port reads `input_map` and must be able to reproduce the
    /// plaintext from it without guessing at a serialiser.
    #[test]
    #[ignore]
    fn emit_member_names_vectors_for_paste() {
        extern crate std;
        use crate::aead::aad_member_names_blob;
        use crate::blob_envelope::encode_blob_envelope_raw;
        use crate::subkey::{derive_group_subkey_v0_2, GroupKey, GroupRole};
        use crate::test_vector_fmt::json_escape;
        use alloc::format;
        use alloc::string::String;

        let key: [u8; AEAD_KEY_LEN] = [0x11; AEAD_KEY_LEN];
        let other_key: [u8; AEAD_KEY_LEN] = [0x99; AEAD_KEY_LEN];
        let acct: [u8; 16] = [0x22; 16];
        let other_account: [u8; 16] = [0x2a; 16];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x33; AEAD_NONCE_LEN];
        let epoch: u64 = 7;
        let group_key: [u8; 32] = [0x44; 32];

        // Three signing identities: two members and the vault owner. The row's map
        // key is the lowercase hex of the person id it NAMES, so a row is always
        // findable and its key is never a free-form label.
        let member_a = pair(b"myne member-names vector member A");
        let member_b = pair(b"myne member-names vector member B");
        let owner = pair(b"myne member-names vector owner");
        let a_id = person_id(0x0b);
        let b_id = person_id(0x0c);
        let c_id = person_id(0x0d);

        // The canonical map JSON, which is also the plaintext: keys ascending and
        // no whitespace, exactly what `serde_json` emits over a `BTreeMap`.
        fn map_json(map: &MemberNamesMap) -> String {
            let mut s = String::from("{");
            for (i, (id, e)) in map.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                s.push_str(&format!(
                    "\"{id}\":{{\"name\":\"{}\",\"version\":{},\"tombstone\":{},\"signature_hex\":\"{}\"}}",
                    json_escape(&e.name),
                    e.version,
                    e.tombstone,
                    e.signature_hex,
                ));
            }
            s.push('}');
            s
        }

        // Map an error to the pinned snake_case name. The `match` is exhaustive on
        // purpose: a new variant cannot ship without deciding its wire name here,
        // which is what keeps `expected_error` and the enum in lockstep.
        fn err_name(e: &MemberNamesBlobError) -> &'static str {
            match e {
                MemberNamesBlobError::HeaderTooShort => "header_too_short",
                MemberNamesBlobError::MagicMismatch => "magic_mismatch",
                MemberNamesBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
                MemberNamesBlobError::MemberNamesFormatUnsupported => "format_unsupported",
                MemberNamesBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
                MemberNamesBlobError::CiphertextTruncated => "ciphertext_truncated",
                MemberNamesBlobError::CannotDecrypt => "cannot_decrypt",
                MemberNamesBlobError::RandomnessUnavailable => "randomness_unavailable",
                // Named after the SIBLINGS' word for this failure rather than after the
                // Rust variant: `plaintext_parse_failed` is what `vault-prefs` and
                // `attachments-catalog` already call "the plaintext did not parse", and
                // an independent implementation maps one failure to one name.
                MemberNamesBlobError::MapMalformed => "plaintext_parse_failed",
                MemberNamesBlobError::MapNotCanonical => "not_canonical",
                MemberNamesBlobError::EpochZero => "epoch_zero",
                MemberNamesBlobError::SignatureUnavailable => "signature_unavailable",
            }
        }

        // Seal `map` under the family AAD and assert the header the format fixes.
        let seal = |map: &MemberNamesMap| -> Vec<u8> {
            let blob = encode_member_names_blob_raw(&key, &acct, epoch, map, &nonce)
                .expect("seal member-names map");
            assert_eq!(&blob[..4], b"MYO5", "family magic");
            assert_eq!(blob[4], 0x01, "envelope protocol_version");
            assert_eq!(
                blob[5], MEMBER_NAMES_BLOB_FORMAT_V1,
                "family format version"
            );
            assert_eq!(&blob[6..30], &nonce[..], "nonce at its fixed offset");
            let declared = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;
            assert_eq!(
                blob.len(),
                MEMBER_NAMES_BLOB_HEADER_LEN + declared,
                "the 4-byte big-endian length at offset 30 counts the ciphertext with its tag"
            );
            blob
        };

        // Seal arbitrary plaintext, for the two cases whose failure is decided
        // AFTER the AEAD opens (the map is not a map / is not canonical).
        let seal_plaintext = |pt: &[u8]| -> Vec<u8> {
            encode_blob_envelope_raw(
                &key,
                &MEMBER_NAMES_BLOB_MAGIC,
                MEMBER_NAMES_BLOB_FORMAT_V1,
                &aad_member_names_blob(&acct, epoch),
                MAX_MEMBER_NAMES_PLAINTEXT_LEN,
                pt,
                &nonce,
            )
            .expect("seal raw plaintext")
        };

        // ---- the maps the codec cases are built from -------------------------
        let mut two_row = MemberNamesMap::new();
        two_row.insert(
            crate::hex::encode_lower(&person_id(0x0b)),
            entry("Ada Lovelace", 1, false),
        );
        two_row.insert(
            crate::hex::encode_lower(&person_id(0x0d)),
            entry("", 4, true),
        );
        let empty: MemberNamesMap = MemberNamesMap::new();
        let cap_name: String = core::iter::repeat_n('x', MAX_MEMBER_NAME_LEN).collect();
        let over_cap_name: String = core::iter::repeat_n('x', MAX_MEMBER_NAME_LEN + 1).collect();
        // 32 two-byte characters: 64 BYTES, the cap, from 32 chars. The cap counts
        // bytes (`entry.name.len()`), and this pair is what says so.
        let multibyte_cap: String =
            core::iter::repeat_n('\u{e9}', MAX_MEMBER_NAME_LEN / 2).collect();
        assert_eq!(multibyte_cap.len(), MAX_MEMBER_NAME_LEN);
        assert_eq!(multibyte_cap.chars().count(), MAX_MEMBER_NAME_LEN / 2);

        let mut cap_map = MemberNamesMap::new();
        cap_map.insert(
            crate::hex::encode_lower(&person_id(0x0b)),
            entry(&cap_name, 1, false),
        );
        let mut multibyte_map = MemberNamesMap::new();
        multibyte_map.insert(
            crate::hex::encode_lower(&person_id(0x0b)),
            entry(&multibyte_cap, 1, false),
        );

        // One map carrying a REAL signature, so the codec is pinned against a row
        // `verify_member_name` accepts rather than only against placeholders.
        let (a_key, live_row) = signed_row(&member_a, 0x0b, "Ada Lovelace", 3);
        let mut real_map = MemberNamesMap::new();
        real_map.insert(a_key.clone(), live_row.clone());

        // ---- the signing identities the verify cases resolve -----------------
        let a_pub = member_a.public_half();
        let b_pub = member_b.public_half();
        let owner_pub = owner.public_half();
        // All THREE parts of the public half, so a port can build the real
        // `PersonPublicHalf` rather than a two-of-three stand-in: `verify` needs
        // only the ed25519 and ML-DSA halves, but the KEM encapsulation key is
        // what makes the struct the one the roster carries, and a fixture that
        // omitted it would push a port into inventing a placeholder for a field
        // the real code path fills from the roster.
        let signer_json = |public: &crate::person_key::PersonPublicHalf| -> String {
            format!(
                "      \"input_signer_kem_ek_hex\": \"{}\",\n      \"input_signer_ed_pk_hex\": \"{}\",\n      \"input_signer_mldsa_vk_hex\": \"{}\",\n",
                crate::hex::encode_lower(public.kem_ek()),
                crate::hex::encode_lower(public.ed_pk()),
                crate::hex::encode_lower(public.mldsa_vk()),
            )
        };
        let entry_json = |e: &MemberNameEntry| -> String {
            format!(
                "      \"input_entry\": {{ \"name\": \"{}\", \"version\": {}, \"tombstone\": {}, \"signature_hex\": \"{}\" }},\n",
                json_escape(&e.name),
                e.version,
                e.tombstone,
                e.signature_hex,
            )
        };
        let bytes_hex = |id: &[u8; 16], version: u64, tombstone: bool, name: &str| -> String {
            crate::hex::encode_lower(&member_name_signed_bytes(id, version, tombstone, name))
        };

        // A member removing their OWN name: the row names the signer.
        let self_tombstone = sign_member_name(&member_b, &b_id, 5, true, "", &mut SeededRng(0x2b))
            .expect("sign self tombstone");
        // The OWNER removing member B: the row still names B, the signer does not.
        let owner_tombstone = sign_member_name(&owner, &b_id, 6, true, "", &mut SeededRng(0x2c))
            .expect("sign owner tombstone");
        assert_ne!(
            self_tombstone.signature_hex, owner_tombstone.signature_hex,
            "the two tombstones must differ, or the owner case proves nothing"
        );

        // ---- emit ------------------------------------------------------------
        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"member-names\",\n");
        dump.push_str("  \"protocol_version\": \"v0.2\",\n");
        dump.push_str(
            "  \"spec_section\": \"protocol.md \\u00a79.29 + \\u00a73.4 + \\u00a75.2\",\n",
        );
        dump.push_str("  \"description\": \"Pins the vault.member-names singleton (MYO5, decisions/protocol/0666) for an independent implementation: the AEAD envelope over a canonical name map, the decode-failure surface one variant at a time, the exact bytes one row's hybrid signature covers, the verification rules (who may sign a name, who may sign a removal, and the refusals), and the two GROUP-tier subkey derivations the family is keyed by. The family is NTV6-only: no v0.1 form exists, there is no SubkeyRole counterpart for either role, and a pre-B2B reader must reject it. Every input_map is written in its CANONICAL byte order (keys ascending, no whitespace), so the plaintext sealed into expected_blob_hex is exactly the JSON as written. Cases generated by `cargo test -p protocol --lib emit_member_names_vectors_for_paste -- --ignored --nocapture` (in protocol/src/member_names_blob.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        let case = |dump: &mut String,
                    slug: &str,
                    kind: &str,
                    description: &str,
                    body: &str,
                    trailing: bool| {
            dump.push_str("    {\n");
            dump.push_str(&format!(
                "      \"vector_id\": \"member-names/v0.2/{slug}\",\n"
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
                "A two-row map sealed under the family AAD: one live row and one tombstone, whose name is empty because a tombstone carries none. The signatures are structurally valid placeholders, because this case pins the CODEC, and whether a signature is the right one is verify-*'s question, not this one's.",
                &two_row,
            ),
            (
                "encrypt-empty-map",
                "The empty map: `{}`, two bytes of plaintext. This is the form a vault that has never had a display name stores, and it must be distinguishable from an ABSENT blob (which decode_member_names_or_empty also collapses to the empty map).",
                &empty,
            ),
            (
                "encrypt-name-at-the-cap",
                "A live row whose name is exactly MAX_MEMBER_NAME_LEN (64) bytes. The cap is inclusive: at it the writer accepts, one byte over it refuses (encode-fail-over-cap-name).",
                &cap_map,
            ),
            (
                "encrypt-multibyte-name-at-the-cap",
                "The same cap reached with 32 two-byte characters: 64 BYTES from 32 chars. The bound is on bytes, not on chars, and this pair is what says so: a port that counts code points accepts a 100-byte name.",
                &multibyte_map,
            ),
            (
                "encrypt-row-with-a-real-signature",
                "The same shape as encrypt-live-row-and-tombstone with one row carrying a REAL hybrid Ed25519 + ML-DSA-65 signature from the person the row names, so the codec is pinned against bytes verify_member_name accepts rather than only against placeholders. The runner decodes this blob and verifies the row it comes back with.",
                &real_map,
            ),
        ]
        .into_iter()
        {
            let blob = seal(map);
            let mj = map_json(map);
            let canonical = String::from_utf8(encode_member_names_map(map).expect("canonical"))
                .expect("canonical map bytes are UTF-8");
            assert_eq!(
                mj, canonical,
                "[{slug}] the emitted input_map must BE the canonical plaintext: keys \
                 ascending, no whitespace, fields in declaration order"
            );
            let body = format!(
                "      \"input_member_names_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_group_key_epoch\": {},\n      \"input_nonce_hex\": \"{}\",\n      \"input_map\": {},\n      \"expected_blob_hex\": \"{}\",\n      \"informational_header_len\": {},\n      \"informational_nonce_offset\": 6,\n      \"expected_magic_ascii\": \"MYO5\",\n      \"expected_protocol_version_byte_hex\": \"01\",\n      \"expected_format_version_byte_hex\": \"01\"\n",
                crate::hex::encode_lower(&key),
                crate::hex::encode_lower(&acct),
                epoch,
                crate::hex::encode_lower(&nonce),
                mj,
                crate::hex::encode_lower(&blob),
                MEMBER_NAMES_BLOB_HEADER_LEN,
            );
            case(&mut dump, slug, "encrypt", desc, &body, true);
        }

        // ===== decrypt_fail ===================================================
        // One case per way of reaching the single non-distinguishing answer, plus
        // the epoch guard, which is checked before the AEAD is even attempted.
        //
        // The subject is the EMPTY map's blob on purpose. Every row carries a 3.3 KB
        // hybrid signature, so a one-row blob is ~14 KB of hex, and a key/AAD/tag
        // failure is decided entirely by the header and the tag: nothing about the
        // content is under test here, and pinning a bigger subject would only make
        // the file bigger.
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
        let mut len_overflow = good[..MEMBER_NAMES_BLOB_HEADER_LEN].to_vec();
        len_overflow[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
        let mut truncated = good[..MEMBER_NAMES_BLOB_HEADER_LEN].to_vec();
        truncated[30..34].copy_from_slice(&1000u32.to_be_bytes());
        // A well-formed map that is not what the canonical encoder would emit: the
        // same bytes with one incidental space. It is what a writer whose
        // serialiser is not compact (or not key-sorted) would produce, and two
        // implementations that accepted it would disagree on the blob's bytes.
        let non_canonical = {
            let canonical = encode_member_names_map(&two_row).expect("canonical");
            let mut spaced = canonical.clone();
            let brace = spaced.iter().position(|b| *b == b':').expect("a row field");
            spaced.insert(brace + 1, b' ');
            spaced
        };
        assert_ne!(
            non_canonical,
            encode_member_names_map(&two_row).expect("canonical")
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
            // The pinned name is asserted HERE, at generation, so a mislabelled case
            // is impossible: the vector cannot ship claiming an error the code does
            // not raise for that input.
            let got = decode_member_names_blob(reader_key, reader_account, reader_epoch, blob)
                .expect_err(&format!("[{slug}] expected {expected}"));
            assert_eq!(
                err_name(&got),
                expected,
                "[{slug}] the case's own input does not raise the error it pins"
            );
            let body = format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_member_names_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_group_key_epoch\": {},\n      \"expected_error\": \"{}\"\n",
                crate::hex::encode_lower(blob),
                crate::hex::encode_lower(reader_key),
                crate::hex::encode_lower(reader_account),
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
            "The same blob read under a DIFFERENT vault's account_number_hash, which is the label the AAD binds. This is the cross-vault case: a name blob copied from one vault into another does not open, so a member cannot graft a roster between vaults. Same single answer as a tamper: the AEAD does not say which input was wrong.",
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
            "The same blob, the same AAD, a different member-names key. Reached from the key side rather than the AAD side, so a reader that checked only the AAD would pass this case and fail the two above.",
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
            "The epoch-zero guard, which runs BEFORE any decryption: `group_key_epoch == 0` is refused outright because no writer produces it, so a reader cannot be talked into deriving an AAD for a rotation that never happened. Paired with encode-fail-epoch-zero, which is the same guard on the write side.",
            &good,
            &key,
            &acct,
            0,
            "epoch_zero",
            true,
        );

        // ===== parse_fail =====================================================
        // Every structural failure the envelope can name, one case each. Nine
        // variants exist in the error enum; the three whose failure is decided after
        // the AEAD opens (plaintext_parse_failed, not_canonical) or before it for a
        // different reason (epoch_zero above) sit in their own cases below/above.
        decode_case(
            &mut dump,
            "parse-fail-header-too-short",
            "parse_fail",
            "One byte short of a whole header: the 4-byte magic, the two version bytes, the 24-byte nonce and the 4-byte length are 34 bytes, and 33 cannot be read. The structural checks run in order and this is the first.",
            &good[..MEMBER_NAMES_BLOB_HEADER_LEN - 1],
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
            "Byte 0 of a real blob replaced: the magic is MYO5 and nothing else. It is checked at its offset BEFORE the length field is trusted, so a foreign blob cannot steer a reader into a large allocation.",
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
            "The envelope protocol_version byte set to 0x02, the NEXT major's value inside a MYO5-shaped blob. This is the §10.5 anti-downgrade pin from the other side: the byte is a const, not a range, so a later generation filed here is refused rather than partially understood.",
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
            "The family's own format_version byte set to a value no client writes. The protocol_version and the format_version are SEPARATE bytes for this reason: the major generation and the family's layout revision move independently, so a family can add a field without a new major.",
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
            "A length that is legal but runs past the end of the input: 1000 bytes declared, none present. The distinction from the case above is the only reason the two are separate variants: a truncation is a damaged file, an overflow is a malformed header, and a caller that re-uploads wants to tell them apart.",
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
            "A blob that opens correctly and whose plaintext is not a well-formed map: the key is not a 32-character lowercase-hex person_id_hash. The AEAD is not at fault, which is exactly why this is a separate variant from cannot_decrypt: the bytes were authentic and the CONTENT is wrong.",
            &seal_plaintext(b"{\"not-a-person-id\":{\"name\":\"Ada\",\"version\":1,\"tombstone\":false,\"signature_hex\":\"aa\"}}"),
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
            "A blob whose plaintext parses to a valid map but is not the canonical ENCODING of it: the same bytes with one incidental space after a colon. It is refused rather than accepted-and-normalised, because two implementations that disagreed about whitespace would produce different blob bytes for the same map, and the sync layer compares blobs. A writer must emit the map with ascending keys and no whitespace.",
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
                           map: &MemberNamesMap,
                           writer_key: &[u8; AEAD_KEY_LEN],
                           writer_epoch: u64,
                           expected: &str,
                           trailing: bool| {
            let got = encode_member_names_blob_raw(writer_key, &acct, writer_epoch, map, &nonce)
                .expect_err(&format!("[{slug}] expected {expected}"));
            assert_eq!(err_name(&got), expected, "[{slug}] mislabelled error");
            let body = format!(
                "      \"input_member_names_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_group_key_epoch\": {},\n      \"input_nonce_hex\": \"{}\",\n      \"input_map\": {},\n      \"expected_error\": \"{}\"\n",
                crate::hex::encode_lower(writer_key),
                crate::hex::encode_lower(&acct),
                writer_epoch,
                crate::hex::encode_lower(&nonce),
                map_json(map),
                expected,
            );
            case(dump, slug, "encode_fail", description, &body, trailing);
        };

        let mut over_cap_map = MemberNamesMap::new();
        over_cap_map.insert(
            crate::hex::encode_lower(&person_id(0x0b)),
            entry(&over_cap_name, 1, false),
        );
        encode_case(
            &mut dump,
            "encode-fail-over-cap-name",
            "One byte past the cap: 65 bytes where 64 is the bound. The writer REFUSES rather than truncating, which matters because a truncated name is a silent change to what a member is called everywhere it is displayed. Paired with encrypt-name-at-the-cap.",
            &over_cap_map,
            &key,
            epoch,
            "plaintext_parse_failed",
            true,
        );
        let mut named_tombstone = MemberNamesMap::new();
        named_tombstone.insert(
            crate::hex::encode_lower(&person_id(0x0b)),
            entry("Ada Lovelace", 4, true),
        );
        encode_case(
            &mut dump,
            "encode-fail-tombstone-with-a-name",
            "A tombstone carrying a name: the two are mutually exclusive, because a tombstone that kept its name would leave the name readable in a row whose whole purpose is that it is gone. Refused at the map validator, so the codec cannot be used to write one.",
            &named_tombstone,
            &key,
            epoch,
            "plaintext_parse_failed",
            true,
        );
        encode_case(
            &mut dump,
            "encode-fail-epoch-zero",
            "The write-side epoch-zero guard. The AAD builder would happily produce 54 bytes for epoch 0, so the refusal has to live in the writer; without it a name blob could be sealed at an epoch no rotation ever produced, and its reader would have no epoch to name. The guard runs before the map is touched, so the empty map is the subject.",
            &empty,
            &key,
            0,
            "epoch_zero",
            true,
        );

        // ===== signed_bytes ===================================================
        let bytes_case = |dump: &mut String,
                          slug: &str,
                          description: &str,
                          id: &[u8; 16],
                          version: u64,
                          tombstone: bool,
                          name: &str,
                          trailing: bool| {
            let body = format!(
                "      \"input_person_id_hex\": \"{}\",\n      \"input_version\": {},\n      \"input_tombstone\": {},\n      \"input_name_utf8\": \"{}\",\n      \"informational_name_len_bytes\": {},\n      \"expected_prefix_ascii\": \"myne.member-name v1|\",\n      \"expected_message_hex\": \"{}\"\n",
                crate::hex::encode_lower(id),
                version,
                tombstone,
                json_escape(name),
                name.len(),
                bytes_hex(id, version, tombstone, name),
            );
            case(dump, slug, "signed_bytes", description, &body, trailing);
        };

        bytes_case(
            &mut dump,
            "signed-bytes-live-row",
            "The exact bytes one row's hybrid signature covers: the class prefix, then the person the row NAMES as 16 raw bytes (not its hex), then the version as 8 big-endian bytes, then one tombstone byte, then the name's UTF-8 bytes run to the end of the message. Fixed widths rather than canonical JSON, so there is exactly one encoding and no ambiguity about where a field ends. The prefix is the load-bearing identifier: changing it moves every row's signature into a different class.",
            &a_id,
            3,
            false,
            "Ada Lovelace",
            true,
        );
        bytes_case(
            &mut dump,
            "signed-bytes-tombstone-empty-name",
            "A tombstone's message: identical framing, the tombstone byte 1, and the name contributing ZERO bytes because a tombstone carries none. The prefix is 20 bytes and the fixed part after it is 25 (16 person id + 8 version + 1 tombstone), so the whole message is 45 bytes, and a port that appended a NUL or a length would produce a different one.",
            &b_id,
            9,
            true,
            "",
            true,
        );
        bytes_case(
            &mut dump,
            "signed-bytes-name-at-the-cap",
            "A name at the cap: 64 bytes, and therefore a 109-byte message (20-byte prefix + 25 fixed + 64). There is no terminator and no padding, so the length comes from the name and a port must not add one.",
            &c_id,
            1,
            false,
            &cap_name,
            true,
        );

        // ===== verify =========================================================
        let verify_case = |dump: &mut String,
                           slug: &str,
                           description: &str,
                           verifier: &str,
                           id: &[u8; 16],
                           row: &MemberNameEntry,
                           public: &crate::person_key::PersonPublicHalf,
                           expected: bool,
                           trailing: bool| {
            // Assert the outcome here, so the pin and the code cannot disagree.
            let got = if verifier == "owner" {
                verify_member_removal(public, id, row)
            } else {
                verify_member_name(public, id, row)
            };
            assert_eq!(got, expected, "[{slug}] mislabelled verification outcome");
            // The three public-half parts the case publishes must REBUILD the very
            // key that just produced `got`. Without this, a hand-edited or
            // mis-wired signer field would pin a case whose expected outcome no
            // longer describes the key beside it, and the runner, which builds
            // the public half FROM these fields, would agree with the wrong
            // answer instead of failing.
            let rebuilt = crate::person_key::PersonPublicHalf::from_parts_hex(
                &crate::hex::encode_lower(public.kem_ek()),
                &crate::hex::encode_lower(public.ed_pk()),
                &crate::hex::encode_lower(public.mldsa_vk()),
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
            let signed = member_name_signed_bytes(id, row.version, row.tombstone, &row.name);
            let body = format!(
                "      \"verifier\": \"{verifier}\",\n      \"input_person_id_hex\": \"{}\",\n{}{}      \"informational_signed_bytes_hex\": \"{}\",\n      \"expected_verified\": {}\n",
                crate::hex::encode_lower(id),
                entry_json(row),
                signer_json(public),
                crate::hex::encode_lower(&signed),
                expected,
            );
            case(dump, slug, "verify", description, &body, trailing);
        };

        verify_case(
            &mut dump,
            "verify-own-signer",
            "The accepting case: a live row signed by the person the row names, checked against that person's public half from the roster. Everything below is a refusal of the same shape.",
            "person",
            &a_id,
            &live_row,
            &a_pub,
            true,
            true,
        );
        verify_case(
            &mut dump,
            "verify-wrong-signer-refused",
            "A signature that is VALID (it verifies against its real signer) but presented as another member's row: the row names person A and was signed by A, and it is checked against B's public half. Refused. This is the case a reader that skipped verification would pass, and the reason a row is only ever accepted against the public half of the person its own KEY names.",
            "person",
            &a_id,
            &live_row,
            &b_pub,
            false,
            true,
        );
        verify_case(
            &mut dump,
            "verify-rows-person-id-is-bound",
            "The same valid signature and the same signer public half, but checked against a DIFFERENT person id, so the id inside the signed message is what refuses it, not the key. Without this binding a member could sign once and have the row appear under any co-member's name.",
            "person",
            &c_id,
            &live_row,
            &a_pub,
            false,
            true,
        );
        let mut altered = live_row.clone();
        altered.version = live_row.version + 1;
        verify_case(
            &mut dump,
            "verify-altered-version-refused",
            "The version incremented after signing. The version IS a monotonic counter that decides concurrent renames, so an unauthenticated version is an attacker choosing whose name wins.",
            "person",
            &a_id,
            &altered,
            &a_pub,
            false,
            true,
        );
        let mut renamed = live_row.clone();
        renamed.name = String::from("Grace Hopper");
        verify_case(
            &mut dump,
            "verify-altered-name-refused",
            "The name replaced after signing, signature untouched. This is the case that matters most: a name is the only thing this family exists to carry, and a co-member who could rewrite it could impersonate.",
            "person",
            &a_id,
            &renamed,
            &a_pub,
            false,
            true,
        );
        let mut flipped = live_row.clone();
        flipped.tombstone = true;
        verify_case(
            &mut dump,
            "verify-altered-tombstone-refused",
            "The tombstone flag flipped after signing, name left in place. Without this an attacker could resurrect a removed member by turning a tombstone back into a live row, or remove one by the reverse.",
            "person",
            &a_id,
            &flipped,
            &a_pub,
            false,
            true,
        );
        verify_case(
            &mut dump,
            "verify-owner-signed-tombstone",
            "The vault OWNER removing member B: the row names B, and the signature is the owner's. Accepted by the removal check, which is how a member's row goes away when the owner removes them from the vault. A member's own tombstone is the other legitimate path (verify-own-signer's shape with the flag set).",
            "owner",
            &b_id,
            &owner_tombstone,
            &owner_pub,
            true,
            true,
        );
        verify_case(
            &mut dump,
            "verify-owner-signature-is-not-a-member-name",
            "The SAME owner-signed tombstone checked against the public half of the member the row NAMES (B). Refused: the owner's key is not B's, so a row the owner signed never reads as B's own name row. This is why partition_verified takes the owner's public half as a SEPARATE argument and reaches for it only on a tombstone, rather than treating every row as self-signed.",
            "person",
            &b_id,
            &owner_tombstone,
            &b_pub,
            false,
            true,
        );
        verify_case(
            &mut dump,
            "verify-owner-live-row-refused",
            "An owner signature over a LIVE row (the tombstone flag cleared). verify_member_removal refuses anything that is not a tombstone before it looks at the signature, so an owner can never use the removal path as a name-writing path. Paired with the case above so both halves of the split are pinned.",
            "owner",
            &b_id,
            &live_row,
            &owner_pub,
            false,
            true,
        );

        // ===== group_subkey ===================================================
        // The family's two roles are GROUP-tier: derived from the group key, not
        // from the root key. There is no SubkeyRole counterpart for either, which is
        // why they are pinned here rather than in hkdf-sha256: that category's
        // runner and its schema are both keyed on derive_subkey_v0_2(root_key, …).
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
                crate::hex::encode_lower(&group_key),
                role_str,
                crate::hex::encode_lower(&derived[..]),
            );
            case(dump, slug, "group_subkey", description, &body, trailing);
        };
        subkey_case(
            &mut dump,
            "group-subkey-member-names-key",
            "GroupRole::MemberNamesKey ('member-names-key'): the KEK the MYO5 envelope is sealed under, derived from the group key rather than the root key. The HKDF context prefix is the v0.2 one, so the same role under a later major is a different key.",
            GroupRole::MemberNamesKey,
            "member-names-key",
            true,
        );
        subkey_case(
            &mut dump,
            "group-subkey-member-names-sync-id",
            "GroupRole::MemberNamesSyncId ('member-names-sync-id'): the deterministic sync blob-id for the singleton. It is a SUBKEY rather than a filename so the id is epoch-scoped and does not leak a vault-independent constant to the server. Distinct from the AAD role 'member-names-blob': a KEK role and an AAD role share no namespace.",
            GroupRole::MemberNamesSyncId,
            "member-names-sync-id",
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");
        std::println!("{dump}");
    }
}
