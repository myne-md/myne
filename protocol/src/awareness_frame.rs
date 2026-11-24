// SPDX-License-Identifier: AGPL-3.0-only
//! Magic-less, wire-only **awareness frame** for live collaboration
//! (`protocol.md` §5.1/§5.2/§5.3; SYNC-1/SYNC-2/SYNC-9; epic `live-collab`).
//!
//! An awareness frame is the unit of the ephemeral live plane carried over the
//! `/sync/awareness` relay. It is **not** a §10.3 blob family and carries **no
//! magic**: it is sync-wire-only and never at rest, like the wire vault head.
//! The cleartext header is exactly `room_id (16) || nonce (24) || version (1)`;
//! everything else (cursor, selection, presence, the identity label, and an
//! opaque Automerge change delta) rides inside the CTX-committed ciphertext.
//!
//! The seal is XChaCha20-Poly1305 + CTX ([`aead_seal_ctx`]) under the room key
//! (`SubkeyRole::AwarenessKey`, group-derived for an `NTV6` vault). The AAD
//! ([`aad_awareness_frame`]) binds the vault, and, for `NTV6`, the group-key
//! epoch, so a post-rotation frame from a retired epoch fails closed.
//!
//! Randomness: [`seal_awareness_frame`] pulls its nonce from `getrandom`;
//! [`seal_awareness_frame_raw`] takes it as a parameter (the `_raw` suffix
//! convention) for the `myne-test-vectors` companion.

use alloc::string::String;
use alloc::vec::Vec;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use hkdf::Hkdf;
use sha2::Sha256;

use crate::aead::{
    aad_awareness_frame, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
};
use crate::canonical_json::{push_json_string, push_json_uint, push_json_uint64};
use crate::person_key::{
    PersonKeyError, PersonKeyPair, PersonPublicHalf, PersonSigned, PERSON_FINGERPRINT_LEN,
};
use crate::subkey::{
    derive_group_subkey_v0_2, derive_subkey_v0_2, GroupKey, GroupRole, SubkeyRole,
};

/// Wire-format version byte of the cleartext awareness-frame header. The first
/// generation of THIS format, distinct from the v0.2 AAD `protocol_version`
/// (`0x02`) inside the seal. A wire-only identifier; changing it is a
/// major-version event.
pub const AWARENESS_FRAME_VERSION: u8 = 0x01;

/// Length of the per-note awareness room id (the routing key sent to the relay).
pub const AWARENESS_ROOM_ID_LEN: usize = 16;

/// Cleartext header length: `room_id (16) || nonce (24) || version (1)`.
pub const AWARENESS_HEADER_LEN: usize = AWARENESS_ROOM_ID_LEN + AEAD_NONCE_LEN + 1;

/// Failure of an awareness-frame operation. `CannotDecrypt` is the single
/// non-distinguishing outcome for every AEAD/room/version/epoch failure; the
/// caller MUST NOT distinguish them at the boundary (spec §6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AwarenessFrameError {
    /// The frame did not open: wrong room key, wrong room id, stale epoch,
    /// tampered bytes, or a malformed envelope.
    #[error("awareness frame did not decrypt")]
    CannotDecrypt,
    /// A decrypted payload was not a valid canonical-JSON awareness payload.
    #[error("malformed awareness frame")]
    Malformed,
    /// The CSPRNG was unavailable while drawing a nonce.
    #[error("csprng unavailable")]
    Csprng,
}

/// Derive the per-note **awareness room id** from the owner `root_key`, the
/// first 16 bytes of `HMAC-SHA-256(derive_subkey_v0_2(root, AwarenessRoomId),
/// note_uuid)` (the `attachments-id-hmac` archetype). Per-note and
/// note-unlinkable: the relay can route on it but cannot invert it to a note id.
pub fn awareness_room_id(root_key: &[u8; 32], note_uuid: &[u8; 16]) -> [u8; AWARENESS_ROOM_ID_LEN] {
    let room_id_key = derive_subkey_v0_2(root_key, SubkeyRole::AwarenessRoomId);
    room_id_from_secret(&room_id_key, note_uuid)
}

/// The group-tier [`awareness_room_id`]: a member derives the same room id from
/// the shared `group_key`, so owner and member address one room.
pub fn awareness_room_id_group(
    group_key: &GroupKey,
    note_uuid: &[u8; 16],
) -> [u8; AWARENESS_ROOM_ID_LEN] {
    let room_id_key = derive_group_subkey_v0_2(group_key, GroupRole::AwarenessRoomId);
    room_id_from_secret(&room_id_key, note_uuid)
}

fn room_id_from_secret(
    room_id_key: &[u8; 32],
    note_uuid: &[u8; 16],
) -> [u8; AWARENESS_ROOM_ID_LEN] {
    // HKDF-Extract == HMAC-SHA-256(key, ikm); the crate routes every HMAC
    // through `Hkdf::extract` (the `scram` / `attachments-id-hmac` pattern).
    let (prk, _hkdf) = Hkdf::<Sha256>::extract(Some(&room_id_key[..]), note_uuid);
    let mut out = [0u8; AWARENESS_ROOM_ID_LEN];
    out.copy_from_slice(&prk[..AWARENESS_ROOM_ID_LEN]);
    out
}

/// Registered message-class prefix for a per-session presence assertion,
/// minted whole (never assembled at a use site), following the
/// `myne.head-signature v1|` convention. Changing it moves every assertion into
/// a different signature class, so a head signature can never verify as one.
pub const PRESENCE_ASSERTION_PREFIX: &[u8] = b"myne.awareness-presence v1|";

/// A per-session assertion binding an Automerge device actor id to a person id
/// (the person fingerprint), double-signed with the person keypair (SYNC-11).
/// Signed ONCE at room join and re-announced on a `join` frame; subsequent
/// awareness frames carry only the cheap actor id and are validated against it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceAssertion {
    pub actor_id: [u8; 16],
    pub person_id: [u8; PERSON_FINGERPRINT_LEN],
    pub signed: PersonSigned,
}

impl PresenceAssertion {
    /// The exact bytes the signature covers:
    /// `PRESENCE_ASSERTION_PREFIX || actor_id (16) || person_id (32)`.
    #[must_use]
    pub fn message_bytes(&self) -> Vec<u8> {
        presence_message(&self.actor_id, &self.person_id)
    }
}

fn presence_message(actor_id: &[u8; 16], person_id: &[u8; PERSON_FINGERPRINT_LEN]) -> Vec<u8> {
    let mut out = Vec::with_capacity(PRESENCE_ASSERTION_PREFIX.len() + 16 + PERSON_FINGERPRINT_LEN);
    out.extend_from_slice(PRESENCE_ASSERTION_PREFIX);
    out.extend_from_slice(actor_id);
    out.extend_from_slice(person_id);
    out
}

/// The verdict of verifying a presence assertion. `Unverified` is NOT an error:
/// the frame stays readable and the caller degrades to an unattributed label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceVerdict {
    Verified,
    Unverified,
}

/// Sign a per-session presence assertion binding `actor_id` to the keypair's
/// fingerprint (its person id). Reuses [`PersonKeyPair::sign`]; adds no primitive.
pub fn sign_presence_assertion(
    keypair: &PersonKeyPair,
    actor_id: &[u8; 16],
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<PresenceAssertion, PersonKeyError> {
    let person_id = *keypair.fingerprint();
    let signed = keypair.sign(&presence_message(actor_id, &person_id), rng)?;
    Ok(PresenceAssertion {
        actor_id: *actor_id,
        person_id,
        signed,
    })
}

/// Verify a presence assertion against a candidate public half. Both signature
/// halves must pass AND the asserted person id must equal the candidate's
/// fingerprint. Any failure yields [`PresenceVerdict::Unverified`], NEVER an
/// error, so attribution can degrade without refusing the frame.
#[must_use]
pub fn verify_presence_assertion(
    public_half: &PersonPublicHalf,
    assertion: &PresenceAssertion,
) -> PresenceVerdict {
    if &assertion.person_id != public_half.fingerprint() {
        return PresenceVerdict::Unverified;
    }
    match public_half.verify(&assertion.message_bytes(), &assertion.signed) {
        Ok(()) => PresenceVerdict::Verified,
        Err(_) => PresenceVerdict::Unverified,
    }
}

/// The kind of awareness frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameType {
    /// A peer joined (or rejoined) a room. Triggers peers to re-announce.
    Join,
    /// A routine presence/typing/cursor update.
    Presence,
}

impl FrameType {
    fn as_str(self) -> &'static str {
        match self {
            FrameType::Join => "join",
            FrameType::Presence => "presence",
        }
    }
}

/// The decrypted inner payload of an awareness frame. `ts` lives only here,
/// inside the seal; the cleartext header carries no timestamp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwarenessPayload {
    pub frame_type: FrameType,
    pub note_id: [u8; 16],
    pub actor_id: [u8; 16],
    pub seq: u64,
    /// Absolute character offset (Unicode scalar index) of the caret, if any.
    pub cursor: Option<u32>,
    /// Selection as `(anchor, head)` character offsets, if any.
    pub selection: Option<(u32, u32)>,
    /// Human label (device or person name); travels only inside the seal.
    pub label: Option<String>,
    /// Opaque Automerge change bytes for a live content delta, if any.
    pub change: Option<Vec<u8>>,
    /// Optional timestamp (unix millis); never outside the seal.
    pub ts: Option<u64>,
}

/// Encode the payload as canonical JSON, keys in lexicographic order:
/// `actor_id, change, cursor, frame_type, label, note_id, selection, seq, ts`.
/// Binary fields are base64 (STANDARD); optional fields are omitted when absent.
pub fn encode_payload_canonical(p: &AwarenessPayload) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(b'{');
    let mut first = true;
    let mut field = |out: &mut Vec<u8>, key: &str| {
        if !first {
            out.push(b',');
        }
        first = false;
        push_json_string(out, key);
        out.push(b':');
    };

    field(&mut out, "actor_id");
    push_json_string(&mut out, &B64.encode(p.actor_id));
    if let Some(change) = &p.change {
        field(&mut out, "change");
        push_json_string(&mut out, &B64.encode(change));
    }
    if let Some(cursor) = p.cursor {
        field(&mut out, "cursor");
        push_json_uint(&mut out, cursor);
    }
    field(&mut out, "frame_type");
    push_json_string(&mut out, p.frame_type.as_str());
    if let Some(label) = &p.label {
        field(&mut out, "label");
        push_json_string(&mut out, label);
    }
    field(&mut out, "note_id");
    push_json_string(&mut out, &B64.encode(p.note_id));
    if let Some((anchor, head)) = p.selection {
        field(&mut out, "selection");
        out.push(b'[');
        push_json_uint(&mut out, anchor);
        out.push(b',');
        push_json_uint(&mut out, head);
        out.push(b']');
    }
    field(&mut out, "seq");
    push_json_uint64(&mut out, p.seq);
    if let Some(ts) = p.ts {
        field(&mut out, "ts");
        push_json_uint64(&mut out, ts);
    }
    out.push(b'}');
    out
}

/// Decode a canonical-JSON awareness payload. Enforces the closed field set,
/// the canonical key order and no duplicate keys; any deviation is `Malformed`.
pub fn decode_payload_canonical(bytes: &[u8]) -> Result<AwarenessPayload, AwarenessFrameError> {
    let mut p = Parser { bytes, pos: 0 };
    p.expect(b'{')?;

    let mut frame_type: Option<FrameType> = None;
    let mut note_id: Option<[u8; 16]> = None;
    let mut actor_id: Option<[u8; 16]> = None;
    let mut seq: Option<u64> = None;
    let mut cursor: Option<u32> = None;
    let mut selection: Option<(u32, u32)> = None;
    let mut label: Option<String> = None;
    let mut change: Option<Vec<u8>> = None;
    let mut ts: Option<u64> = None;

    // Canonical key order is enforced as a strictly increasing key index, so an
    // absent OPTIONAL key is fine while a key out of order, unknown, or
    // duplicated is malformed.
    let mut last_index: Option<usize> = None;
    loop {
        if p.peek() == Some(b'}') {
            p.pos += 1;
            break;
        }
        let key = p.parse_string()?;
        p.expect(b':')?;
        let idx = match key.as_str() {
            "actor_id" => 0,
            "change" => 1,
            "cursor" => 2,
            "frame_type" => 3,
            "label" => 4,
            "note_id" => 5,
            "selection" => 6,
            "seq" => 7,
            "ts" => 8,
            _ => return Err(AwarenessFrameError::Malformed),
        };
        if let Some(last) = last_index {
            if idx <= last {
                return Err(AwarenessFrameError::Malformed);
            }
        }
        last_index = Some(idx);
        match key.as_str() {
            "actor_id" => actor_id = Some(p.parse_b64_16()?),
            "change" => change = Some(p.parse_b64_vec()?),
            "cursor" => cursor = Some(p.parse_u32()?),
            "frame_type" => {
                frame_type = Some(match p.parse_string()?.as_str() {
                    "join" => FrameType::Join,
                    "presence" => FrameType::Presence,
                    _ => return Err(AwarenessFrameError::Malformed),
                })
            }
            "label" => label = Some(p.parse_string()?),
            "note_id" => note_id = Some(p.parse_b64_16()?),
            "selection" => {
                p.expect(b'[')?;
                let anchor = p.parse_u32()?;
                p.expect(b',')?;
                let head = p.parse_u32()?;
                p.expect(b']')?;
                selection = Some((anchor, head));
            }
            "seq" => seq = Some(p.parse_u64()?),
            "ts" => ts = Some(p.parse_u64()?),
            _ => return Err(AwarenessFrameError::Malformed),
        }
        match p.peek() {
            Some(b',') => p.pos += 1,
            Some(b'}') => {
                p.pos += 1;
                break;
            }
            _ => return Err(AwarenessFrameError::Malformed),
        }
    }

    if p.pos != bytes.len() {
        return Err(AwarenessFrameError::Malformed);
    }

    Ok(AwarenessPayload {
        frame_type: frame_type.ok_or(AwarenessFrameError::Malformed)?,
        note_id: note_id.ok_or(AwarenessFrameError::Malformed)?,
        actor_id: actor_id.ok_or(AwarenessFrameError::Malformed)?,
        seq: seq.ok_or(AwarenessFrameError::Malformed)?,
        cursor,
        selection,
        label,
        change,
        ts,
    })
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn expect(&mut self, b: u8) -> Result<(), AwarenessFrameError> {
        if self.peek() == Some(b) {
            self.pos += 1;
            Ok(())
        } else {
            Err(AwarenessFrameError::Malformed)
        }
    }

    fn parse_string(&mut self) -> Result<String, AwarenessFrameError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let c = self.peek().ok_or(AwarenessFrameError::Malformed)?;
            self.pos += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let esc = self.peek().ok_or(AwarenessFrameError::Malformed)?;
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let code = self.parse_hex4()?;
                            let ch = char::from_u32(code).ok_or(AwarenessFrameError::Malformed)?;
                            out.push(ch);
                        }
                        _ => return Err(AwarenessFrameError::Malformed),
                    }
                }
                c if c < 0x20 => return Err(AwarenessFrameError::Malformed),
                c if c < 0x80 => out.push(c as char),
                _ => {
                    // Multi-byte UTF-8: collect continuation bytes.
                    self.pos -= 1;
                    let rest = &self.bytes[self.pos..];
                    let s =
                        core::str::from_utf8(rest).map_err(|_| AwarenessFrameError::Malformed)?;
                    let ch = s.chars().next().ok_or(AwarenessFrameError::Malformed)?;
                    out.push(ch);
                    self.pos += ch.len_utf8();
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u32, AwarenessFrameError> {
        let mut v = 0u32;
        for _ in 0..4 {
            let c = self.peek().ok_or(AwarenessFrameError::Malformed)?;
            self.pos += 1;
            let d = match c {
                b'0'..=b'9' => (c - b'0') as u32,
                b'a'..=b'f' => (c - b'a' + 10) as u32,
                b'A'..=b'F' => (c - b'A' + 10) as u32,
                _ => return Err(AwarenessFrameError::Malformed),
            };
            v = (v << 4) | d;
        }
        Ok(v)
    }

    fn parse_u64(&mut self) -> Result<u64, AwarenessFrameError> {
        let start = self.pos;
        let mut v = 0u64;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                v = v
                    .checked_mul(10)
                    .and_then(|v| v.checked_add((c - b'0') as u64))
                    .ok_or(AwarenessFrameError::Malformed)?;
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == start {
            return Err(AwarenessFrameError::Malformed);
        }
        Ok(v)
    }

    fn parse_u32(&mut self) -> Result<u32, AwarenessFrameError> {
        let v = self.parse_u64()?;
        u32::try_from(v).map_err(|_| AwarenessFrameError::Malformed)
    }

    fn parse_b64_16(&mut self) -> Result<[u8; 16], AwarenessFrameError> {
        let s = self.parse_string()?;
        let raw = B64
            .decode(s.as_bytes())
            .map_err(|_| AwarenessFrameError::Malformed)?;
        raw.as_slice()
            .try_into()
            .map_err(|_| AwarenessFrameError::Malformed)
    }

    fn parse_b64_vec(&mut self) -> Result<Vec<u8>, AwarenessFrameError> {
        let s = self.parse_string()?;
        B64.decode(s.as_bytes())
            .map_err(|_| AwarenessFrameError::Malformed)
    }
}

/// Seal a frame with a caller-supplied nonce (the `_raw` convention): the
/// cleartext header `room_id || nonce || version`, then the CTX ciphertext.
pub fn seal_awareness_frame_raw(
    room_key: &[u8; AEAD_KEY_LEN],
    room_id: &[u8; AWARENESS_ROOM_ID_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
    account_number_hash: &[u8; 16],
    epoch: Option<u64>,
    payload: &AwarenessPayload,
) -> Result<Vec<u8>, AwarenessFrameError> {
    let plaintext = encode_payload_canonical(payload);
    let aad = aad_awareness_frame(account_number_hash, epoch);
    let sealed = aead_seal_ctx(room_key, nonce, &plaintext, &aad)
        .map_err(|_| AwarenessFrameError::CannotDecrypt)?;
    let mut out = Vec::with_capacity(AWARENESS_HEADER_LEN + sealed.len());
    out.extend_from_slice(room_id);
    out.extend_from_slice(nonce);
    out.push(AWARENESS_FRAME_VERSION);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Seal a frame, drawing a fresh 24-byte nonce from `getrandom`.
pub fn seal_awareness_frame(
    room_key: &[u8; AEAD_KEY_LEN],
    room_id: &[u8; AWARENESS_ROOM_ID_LEN],
    account_number_hash: &[u8; 16],
    epoch: Option<u64>,
    payload: &AwarenessPayload,
) -> Result<Vec<u8>, AwarenessFrameError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| AwarenessFrameError::Csprng)?;
    seal_awareness_frame_raw(
        room_key,
        room_id,
        &nonce,
        account_number_hash,
        epoch,
        payload,
    )
}

/// Open an awareness frame. Every failure (wrong key, wrong room, wrong
/// version, stale epoch, tampered bytes, malformed payload) surfaces as one
/// non-distinguishing [`AwarenessFrameError`].
pub fn open_awareness_frame(
    room_key: &[u8; AEAD_KEY_LEN],
    room_id: &[u8; AWARENESS_ROOM_ID_LEN],
    account_number_hash: &[u8; 16],
    epoch: Option<u64>,
    bytes: &[u8],
) -> Result<AwarenessPayload, AwarenessFrameError> {
    if bytes.len() < AWARENESS_HEADER_LEN {
        return Err(AwarenessFrameError::CannotDecrypt);
    }
    let (header, sealed) = bytes.split_at(AWARENESS_HEADER_LEN);
    let frame_room_id = &header[..AWARENESS_ROOM_ID_LEN];
    let nonce = &header[AWARENESS_ROOM_ID_LEN..AWARENESS_ROOM_ID_LEN + AEAD_NONCE_LEN];
    let version = header[AWARENESS_HEADER_LEN - 1];
    if version != AWARENESS_FRAME_VERSION || frame_room_id != room_id.as_slice() {
        return Err(AwarenessFrameError::CannotDecrypt);
    }
    let nonce_arr: &[u8; AEAD_NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| AwarenessFrameError::CannotDecrypt)?;
    let aad = aad_awareness_frame(account_number_hash, epoch);
    let plaintext = aead_open_ctx(room_key, nonce_arr, sealed, &aad)
        .map_err(|_| AwarenessFrameError::CannotDecrypt)?;
    decode_payload_canonical(&plaintext).map_err(|_| AwarenessFrameError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn payload() -> AwarenessPayload {
        AwarenessPayload {
            frame_type: FrameType::Presence,
            note_id: [0x11; 16],
            actor_id: [0x22; 16],
            seq: 7,
            cursor: Some(42),
            selection: Some((10, 20)),
            label: Some("Laptop".into()),
            change: Some(vec![0xDE, 0xAD, 0xBE, 0xEF]),
            ts: Some(1_700_000_000_000),
        }
    }

    #[test]
    fn aad_matches_the_v0_2_singleton_shape_and_appends_epoch() {
        use crate::aead::{aad_awareness_frame, aad_singleton_blob_v0_2};
        let hash = [0x55u8; 16];
        // The NTV5 (no epoch) form is exactly the generic v0.2 singleton shape
        // with role "awareness-frame".
        let base = aad_singleton_blob_v0_2(b"awareness-frame", &hash);
        assert_eq!(aad_awareness_frame(&hash, None), base);
        // The NTV6 form appends the 8-byte big-endian epoch after the account hash.
        let mut with_epoch = base.clone();
        with_epoch.extend_from_slice(&7u64.to_be_bytes());
        assert_eq!(aad_awareness_frame(&hash, Some(7)), with_epoch);
    }

    #[test]
    fn payload_round_trips_canonical_json() {
        let p = payload();
        let bytes = encode_payload_canonical(&p);
        let back = decode_payload_canonical(&bytes).expect("decode");
        assert_eq!(p, back);
    }

    #[test]
    fn payload_omits_absent_optionals() {
        let p = AwarenessPayload {
            frame_type: FrameType::Join,
            note_id: [0x01; 16],
            actor_id: [0x02; 16],
            seq: 1,
            cursor: None,
            selection: None,
            label: None,
            change: None,
            ts: None,
        };
        let bytes = encode_payload_canonical(&p);
        let s = core::str::from_utf8(&bytes).expect("utf8");
        assert!(!s.contains("cursor"));
        assert!(!s.contains("selection"));
        assert!(!s.contains("change"));
        assert!(!s.contains("ts"));
        assert_eq!(decode_payload_canonical(&bytes).expect("decode"), p);
    }

    #[test]
    fn non_canonical_key_order_is_malformed() {
        // A payload with keys swapped (seq before frame_type) is malformed.
        let bad = br#"{"seq":1,"frame_type":"join"}"#;
        assert_eq!(
            decode_payload_canonical(bad),
            Err(AwarenessFrameError::Malformed)
        );
    }

    #[test]
    fn seal_open_round_trips_and_header_is_only_room_nonce_version() {
        let room_key = [0x33u8; 32];
        let room_id = [0x44u8; 16];
        let hash = [0x55u8; 16];
        let bytes =
            seal_awareness_frame(&room_key, &room_id, &hash, None, &payload()).expect("seal");
        // Cleartext header: room_id || nonce || version, no magic.
        assert_eq!(&bytes[..16], &room_id);
        assert_eq!(bytes[AWARENESS_HEADER_LEN - 1], AWARENESS_FRAME_VERSION);
        assert!(!bytes.starts_with(b"MY"));
        let back = open_awareness_frame(&room_key, &room_id, &hash, None, &bytes).expect("open");
        assert_eq!(back, payload());
    }

    #[test]
    fn two_seals_of_the_same_plaintext_differ() {
        let room_key = [0x33u8; 32];
        let room_id = [0x44u8; 16];
        let hash = [0x55u8; 16];
        let a = seal_awareness_frame(&room_key, &room_id, &hash, None, &payload()).expect("a");
        let b = seal_awareness_frame(&room_key, &room_id, &hash, None, &payload()).expect("b");
        assert_ne!(a, b, "fresh nonce per seal");
    }

    #[test]
    fn wrong_room_wrong_epoch_wrong_vault_and_tamper_all_fail_non_distinguishing() {
        let room_key = [0x33u8; 32];
        let room_id = [0x44u8; 16];
        let hash = [0x55u8; 16];
        let bytes =
            seal_awareness_frame(&room_key, &room_id, &hash, Some(3), &payload()).expect("seal");

        // Wrong room id.
        assert_eq!(
            open_awareness_frame(&room_key, &[0x99; 16], &hash, Some(3), &bytes),
            Err(AwarenessFrameError::CannotDecrypt)
        );
        // Wrong (stale) epoch.
        assert_eq!(
            open_awareness_frame(&room_key, &room_id, &hash, Some(2), &bytes),
            Err(AwarenessFrameError::CannotDecrypt)
        );
        // Wrong vault.
        assert_eq!(
            open_awareness_frame(&room_key, &room_id, &[0x99; 16], Some(3), &bytes),
            Err(AwarenessFrameError::CannotDecrypt)
        );
        // Wrong room key.
        assert_eq!(
            open_awareness_frame(&[0x99; 32], &room_id, &hash, Some(3), &bytes),
            Err(AwarenessFrameError::CannotDecrypt)
        );
        // Tampered tag.
        let mut tampered = bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        assert_eq!(
            open_awareness_frame(&room_key, &room_id, &hash, Some(3), &tampered),
            Err(AwarenessFrameError::CannotDecrypt)
        );
    }

    #[test]
    fn room_id_is_per_note_and_note_unlinkable() {
        let root = [0x5Au8; 32];
        let a = awareness_room_id(&root, &[0x01; 16]);
        let b = awareness_room_id(&root, &[0x02; 16]);
        assert_ne!(a, b, "different notes derive different rooms");
        // Same inputs derive the same room (deterministic across the fleet).
        assert_eq!(a, awareness_room_id(&root, &[0x01; 16]));
        // The owner tier derives from `root_key` and the group tier from
        // `group_key`; in production those are independent random keys, so the
        // two rooms differ. (Under identical key bytes the derivation is
        // identical, since the two tiers share one role string.)
        let group = awareness_room_id_group(&GroupKey::new([0x7Cu8; 32]), &[0x01; 16]);
        assert_ne!(a, group);
    }

    /// Emit the `awareness-frame/v0.2` vectors for paste into the companion repo.
    /// Run: `cargo test -p protocol --lib emit_awareness_frame_vectors_for_paste -- --ignored`
    #[test]
    #[ignore]
    #[allow(clippy::type_complexity)]
    fn emit_awareness_frame_vectors_for_paste() {
        extern crate std;
        use crate::test_vector_fmt::hex_lower;

        let room_key = [0x33u8; 32];
        let room_id = [0x44u8; 16];
        let account_hash = [0x55u8; 16];
        let nonce = [0x66u8; 24];

        let payload_of = |ft: FrameType| AwarenessPayload {
            frame_type: ft,
            note_id: [0x11; 16],
            actor_id: [0x22; 16],
            seq: 7,
            cursor: Some(42),
            selection: Some((10, 20)),
            label: Some(String::from("Laptop")),
            change: Some(vec![0xDE, 0xAD, 0xBE, 0xEF]),
            ts: Some(1_700_000_000_000),
        };

        let payload_json = |p: &AwarenessPayload| {
            let mut s = String::new();
            s.push_str(&alloc::format!(
                "{{ \"frame_type\": \"{}\", \"note_id_hex\": \"{}\", \"actor_id_hex\": \"{}\", \"seq\": {}, ",
                p.frame_type.as_str(),
                hex_lower(&p.note_id),
                hex_lower(&p.actor_id),
                p.seq
            ));
            if let Some(c) = p.cursor {
                s.push_str(&alloc::format!("\"cursor\": {c}, "));
            }
            if let Some((a, b)) = p.selection {
                s.push_str(&alloc::format!("\"selection\": [{a}, {b}], "));
            }
            if let Some(l) = &p.label {
                s.push_str(&alloc::format!("\"label\": \"{}\", ", l));
            }
            if let Some(ch) = &p.change {
                s.push_str(&alloc::format!("\"change_hex\": \"{}\", ", hex_lower(ch)));
            }
            if let Some(t) = p.ts {
                s.push_str(&alloc::format!("\"ts\": {t}, "));
            }
            s.pop();
            s.pop();
            s.push_str(" }");
            s
        };

        // (slug, description, frame_type, epoch, open_room_id, open_epoch, tamper, expect_ok)
        let cases: [(
            &str,
            &str,
            FrameType,
            Option<u64>,
            [u8; 16],
            Option<u64>,
            bool,
            bool,
        ); 5] = [
            (
                "presence-ntv5",
                "A `presence` frame on an NTV5 vault (no epoch slot): cleartext header room_id||nonce||version, then the CTX seal over the canonical-JSON payload. Seals with a fixed nonce and OPENS with the same inputs. Pins the full frame bytes and the payload round-trip.",
                FrameType::Presence,
                None,
                [0x44; 16],
                None,
                false,
                true,
            ),
            (
                "join-ntv6-epoch",
                "A `join` frame on an NTV6 vault: the AAD carries the group_key_epoch after the account hash, so the seal differs from the NTV5 form. Opens with the same epoch.",
                FrameType::Join,
                Some(3),
                [0x44; 16],
                Some(3),
                false,
                true,
            ),
            (
                "open-wrong-room",
                "The NTV5 presence frame opened with a DIFFERENT room id. The cleartext room id does not match, so the frame fails closed as one non-distinguishing CannotDecrypt.",
                FrameType::Presence,
                None,
                [0x99; 16],
                None,
                false,
                false,
            ),
            (
                "open-stale-epoch",
                "The NTV6 join frame opened with a RETIRED epoch. The AAD no longer matches, so a post-rotation frame fails closed.",
                FrameType::Join,
                Some(3),
                [0x44; 16],
                Some(2),
                false,
                false,
            ),
            (
                "open-tampered-tag",
                "The NTV5 presence frame with the last CTX-tag byte flipped. AEAD verification fails closed as the same non-distinguishing error.",
                FrameType::Presence,
                None,
                [0x44; 16],
                None,
                true,
                false,
            ),
        ];

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"awareness-frame\",\n");
        dump.push_str("  \"protocol_version\": \"v0.2\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §5.2 + §10.7 + §3.4 (live-collab)\",\n");
        dump.push_str("  \"description\": \"Pins the magic-less, sync-wire-only awareness frame (live-collab, decisions/sync/0655). A frame is a cleartext header room_id(16)||nonce(24)||version(1=0x01), then an XChaCha20-Poly1305+CTX seal over a canonical-JSON payload, with AAD aad_awareness_frame (role 'awareness-frame' | account_number_hash | optional 8-byte big-endian group_key_epoch for NTV6). Cases cover seal and open, a join and a presence frame, the NTV5 and NTV6 AAD forms, and the wrong-room / stale-epoch / tampered-tag negatives (each one non-distinguishing CannotDecrypt). The signed presence assertion's message-class prefix 'myne.awareness-presence v1|' is pinned by the assertion_message cases; the full sign/verify is pinned by the person-keypair category. Generated by `cargo test -p protocol --lib emit_awareness_frame_vectors_for_paste -- --ignored` (in protocol/src/awareness_frame.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        let mut first = true;
        for (slug, desc, ft, epoch, open_room, open_epoch, tamper, expect_ok) in cases.iter() {
            let p = payload_of(*ft);
            let frame =
                seal_awareness_frame_raw(&room_key, &room_id, &nonce, &account_hash, *epoch, &p)
                    .expect("seal");
            // Self-assert at mint: the open outcome must match the case's claim.
            let mut to_open = frame.clone();
            if *tamper {
                let last = to_open.len() - 1;
                to_open[last] ^= 0x01;
            }
            let opened =
                open_awareness_frame(&room_key, open_room, &account_hash, *open_epoch, &to_open);
            assert_eq!(
                opened.is_ok(),
                *expect_ok,
                "awareness-frame generator: {slug} open outcome disagrees with its claim"
            );

            if !first {
                dump.push_str("    },\n");
            }
            first = false;
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"awareness-frame/v0.2/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                crate::test_vector_fmt::json_escape(desc)
            ));
            dump.push_str("      \"kind\": \"frame\",\n");
            dump.push_str(&alloc::format!(
                "      \"room_key_hex\": \"{}\",\n",
                hex_lower(&room_key)
            ));
            dump.push_str(&alloc::format!(
                "      \"room_id_hex\": \"{}\",\n",
                hex_lower(&room_id)
            ));
            dump.push_str(&alloc::format!(
                "      \"nonce_hex\": \"{}\",\n",
                hex_lower(&nonce)
            ));
            dump.push_str(&alloc::format!(
                "      \"account_number_hash_hex\": \"{}\",\n",
                hex_lower(&account_hash)
            ));
            if let Some(e) = epoch {
                dump.push_str(&alloc::format!("      \"group_key_epoch\": {e},\n"));
            }
            dump.push_str(&alloc::format!(
                "      \"payload\": {},\n",
                payload_json(&p)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_frame_hex\": \"{}\",\n",
                hex_lower(&frame)
            ));
            dump.push_str(&alloc::format!(
                "      \"open_room_id_hex\": \"{}\",\n",
                hex_lower(open_room)
            ));
            if let Some(e) = open_epoch {
                dump.push_str(&alloc::format!("      \"open_group_key_epoch\": {e},\n"));
            }
            dump.push_str(&alloc::format!("      \"tamper_last_byte\": {},\n", tamper));
            dump.push_str(&alloc::format!("      \"expect_open_ok\": {}\n", expect_ok));
        }

        // Assertion message-class cases: pin the load-bearing prefix bytes and the
        // exact message assembly (prefix || actor || person). Cross-class
        // separation is the property that a head signature cannot verify here.
        let actor = [0x22u8; 16];
        let person = [0x77u8; 32];
        let msg = presence_message(&actor, &person);
        dump.push_str("    },\n    {\n");
        dump.push_str(
            "      \"vector_id\": \"awareness-frame/v0.2/assertion-message-class\",\n      \"description\": \"The presence-assertion message bytes: the registered class prefix 'myne.awareness-presence v1|' || actor_id(16) || person_id(32). A verifier recomputes exactly these bytes; because the class prefix is inside the signed message, a head signature over the head class can never verify as an assertion, or the reverse (cross-class replay). The full sign/verify is pinned by the person-keypair category.\",\n      \"kind\": \"assertion_message\",\n",
        );
        dump.push_str(&alloc::format!(
            "      \"actor_id_hex\": \"{}\",\n",
            hex_lower(&actor)
        ));
        dump.push_str(&alloc::format!(
            "      \"person_id_hex\": \"{}\",\n",
            hex_lower(&person)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_message_hex\": \"{}\"\n",
            hex_lower(&msg)
        ));

        dump.push_str("    }\n");
        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_awareness_frame_vectors.json", dump.as_bytes())
            .expect("write awareness-frame vectors dump");
    }

    /// A tiny deterministic RNG for the signing tests (rand_core 0.10).
    struct TestRng(u8);
    impl rand_core::TryRng for TestRng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            self.0 = self.0.wrapping_add(1);
            Ok(u32::from(self.0))
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            self.0 = self.0.wrapping_add(1);
            Ok(u64::from(self.0))
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            for b in dst.iter_mut() {
                self.0 = self.0.wrapping_add(1);
                *b = self.0;
            }
            Ok(())
        }
    }
    impl rand_core::TryCryptoRng for TestRng {}

    #[test]
    fn presence_assertion_signs_and_verifies_both_halves() {
        let signer = PersonKeyPair::generate().expect("keypair");
        let half = signer.public_half();
        let actor = [0x11u8; 16];
        let assertion = sign_presence_assertion(&signer, &actor, &mut TestRng(0)).expect("sign");
        assert_eq!(assertion.actor_id, actor);
        assert_eq!(&assertion.person_id, half.fingerprint());
        assert_eq!(
            verify_presence_assertion(&half, &assertion),
            PresenceVerdict::Verified
        );
    }

    #[test]
    fn presence_assertion_rejects_tamper_and_wrong_person() {
        let signer = PersonKeyPair::generate().expect("keypair");
        let half = signer.public_half();
        let actor = [0x11u8; 16];

        // Tampered actor id: both halves no longer verify.
        let mut tampered = sign_presence_assertion(&signer, &actor, &mut TestRng(0)).expect("sign");
        tampered.actor_id[0] ^= 0x01;
        assert_eq!(
            verify_presence_assertion(&half, &tampered),
            PresenceVerdict::Unverified
        );

        // A different person's public half cannot verify it.
        let assertion = sign_presence_assertion(&signer, &actor, &mut TestRng(1)).expect("sign");
        let other = PersonKeyPair::generate().expect("other");
        assert_eq!(
            verify_presence_assertion(&other.public_half(), &assertion),
            PresenceVerdict::Unverified
        );
    }

    #[test]
    fn a_head_signature_never_verifies_as_a_presence_assertion() {
        // The class prefix is inside the signed bytes, so a signature over a
        // head-format message (same key, same actor/person) fails as an assertion.
        let signer = PersonKeyPair::generate().expect("keypair");
        let half = signer.public_half();
        let actor = [0x11u8; 16];
        let person_id = *half.fingerprint();
        let mut head_msg = Vec::new();
        head_msg.extend_from_slice(b"myne.head-signature v1|");
        head_msg.extend_from_slice(&actor);
        head_msg.extend_from_slice(&person_id);
        let signed = signer.sign(&head_msg, &mut TestRng(0)).expect("sign head");
        let assertion = PresenceAssertion {
            actor_id: actor,
            person_id,
            signed,
        };
        assert_eq!(
            verify_presence_assertion(&half, &assertion),
            PresenceVerdict::Unverified
        );
    }

    #[test]
    fn a_frame_stays_readable_when_its_assertion_is_unverified() {
        // Frame opening and assertion verification are decoupled by construction:
        // the frame opens and carries the actor id, so the caller degrades to an
        // unattributed label rather than refusing the frame.
        let room_key = [0x33u8; 32];
        let room_id = [0x44u8; 16];
        let hash = [0x55u8; 16];
        let frame =
            seal_awareness_frame(&room_key, &room_id, &hash, None, &payload()).expect("seal");
        let opened = open_awareness_frame(&room_key, &room_id, &hash, None, &frame).expect("open");
        assert_eq!(opened.actor_id, [0x22; 16]);

        let signer = PersonKeyPair::generate().expect("keypair");
        let assertion =
            sign_presence_assertion(&signer, &opened.actor_id, &mut TestRng(0)).expect("sign");
        let stranger = PersonKeyPair::generate().expect("stranger");
        assert_eq!(
            verify_presence_assertion(&stranger.public_half(), &assertion),
            PresenceVerdict::Unverified
        );
    }
}
