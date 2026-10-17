// SPDX-License-Identifier: AGPL-3.0
//! Per-note `.myn` blob encoder/decoder (`MY01` magic) per
//! `docs/spec/protocol.md` § 6 (per-note encryption flow) and § 9.2
//! (per-note blob binary format).
//!
//! The third level of Myne's note-key wrapping (`spec/protocol.md`
//! § 3.3): the singleton `itemsKey` is held in `vault.meta`; each note
//! holds a random per-note `item_key` wrapped under `itemsKey`; that
//! `item_key` encrypts the note's Markdown plaintext. This module
//! produces and consumes the on-disk byte sequence that carries those
//! two AEAD operations side by side.
//!
//! ## Module surface (stages of the codec land in successive tasks)
//!
//! | Layer                      | Function                          | Source of randomness |
//! |----------------------------|-----------------------------------|----------------------|
//! | Deterministic primitive    | [`encode_new_note_blob_raw`]      | caller (`_raw`)      |
//! | Deterministic primitive    | `encode_update_blob_raw` (Task 8) | caller (`_raw`)      |
//! | Convenience wrapper        | `encode_new_note` (Task 7)        | `getrandom`          |
//! | Convenience wrapper        | `encode_update` (Task 8)          | `getrandom`          |
//! | Decoder                    | `decode_note` + `_with_cause`     | n/a                  |
//!
//! `_raw` functions trade footgun for byte-level determinism: the
//! `myne-test-vectors/` companion repo and crate-internal tampering
//! tests both depend on the deterministic surface. Production callers
//! SHOULD use the non-`_raw` wrappers. See `protocol/AGENTS.md`'s
//! `_raw` suffix convention paragraph for the project-wide footgun
//! marker.
//!
//! ## §9.2 byte layout (recap)
//!
//! ```text
//! Offset  Size       Field                Notes
//! ------  ---------  -------------------  -----------------------------------------
//! 0       4          magic                ASCII "MY01"
//! 4       1          protocol_version     0x01
//! 5       1          reserved             0x00 (non-zero rejects parse)
//! 6       16         items_key_id         UUIDv7 of singleton v0.1 itemsKey
//! 22      24         item_key_nonce       192-bit random nonce, item_key wrap
//! 46      2          enc_item_key_len     0x0040 = 64 (constant in v0.1)
//! 48      64         enc_item_key         32 B ct + 32 B CTX commitment
//! 112     24         content_nonce        192-bit random nonce, plaintext encrypt
//! 136     4          ciphertext_len       M = plaintext_len + 32 (BE)
//! 140     M          ciphertext           plaintext + 32 B CTX commitment
//! ```
//!
//! `note_uuid` is **not** in the blob — it is the `.myn` filename per
//! § 9.1 and feeds AAD construction at decrypt time. Cross-note rename
//! (filename swap) breaks both AADs (§ 6.5).

use crate::aead::{aad_note_content_encrypt, aad_note_item_key_wrap, aead_open_ctx, aead_seal_ctx};
use crate::aead::{AEAD_KEY_LEN, AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN};
use crate::error::ProtocolError;
use crate::MAX_PLAINTEXT_LEN;
use alloc::vec::Vec;
use serde::Serialize;
use thiserror::Error;
use zeroize::Zeroizing;

// ---- §9.2 byte-layout constants -----------------------------------------

/// `.myn` magic bytes per `protocol.md` § 9.2 offset 0. ASCII `"MY01"`.
pub const MAGIC: &[u8; 4] = b"MY01";

/// Protocol version byte per `protocol.md` § 9.2 offset 4. `0x01` for v0.1.
pub const PROTOCOL_VERSION: u8 = 0x01;

/// Reserved byte per `protocol.md` § 9.2 offset 5. MUST be `0x00`;
/// non-zero rejects parse (§ 6.4 step 1).
pub const RESERVED_BYTE: u8 = 0x00;

/// Length of the `items_key_id` field per `protocol.md` § 9.2 (UUIDv7,
/// 16 bytes).
pub const ITEMS_KEY_ID_LEN: usize = 16;

/// Length of the `note_uuid` (the `.myn` filename per `protocol.md`
/// § 9.1, also bound into both AAD constructions per § 5.2).
pub const NOTE_UUID_LEN: usize = 16;

/// On-disk length of `enc_item_key` per `protocol.md` § 9.2 offsets
/// 48..112: `AEAD_KEY_LEN` (32) + `CTX_COMMITMENT_TAG_LEN` (32) = 64.
/// The `enc_item_key_len` field at offset 46 is bound to this constant
/// in v0.1; § 6.4 step 1 rejects any other value at parse time.
pub const ENC_ITEM_KEY_WRAPPED_LEN: usize = AEAD_KEY_LEN + CTX_COMMITMENT_TAG_LEN;

/// Total length of the prefix that the §6.3 update path leaves
/// byte-identical across revisions of a note: bytes 0..112 (magic +
/// version + reserved + items_key_id + item_key_nonce +
/// enc_item_key_len + enc_item_key). Captured into the
/// [`DecryptedNote`] handle's private slab at decode time.
pub const HEADER_PREFIX_LEN: usize = OFFSET_ENC_ITEM_KEY + ENC_ITEM_KEY_WRAPPED_LEN;

/// Offset of `protocol_version` byte in the blob (§ 9.2).
pub const OFFSET_PROTOCOL_VERSION: usize = 4;

/// Offset of `reserved` byte (§ 9.2). MUST be `0x00`.
pub const OFFSET_RESERVED: usize = 5;

/// Offset of `items_key_id` (16 bytes) (§ 9.2).
pub const OFFSET_ITEMS_KEY_ID: usize = 6;

/// Offset of `item_key_nonce` (24 bytes) (§ 9.2).
pub const OFFSET_ITEM_KEY_NONCE: usize = 22;

/// Offset of `enc_item_key_len` (2 bytes BE, value `0x0040` in v0.1) (§ 9.2).
pub const OFFSET_ENC_ITEM_KEY_LEN: usize = 46;

/// Offset of `enc_item_key` (64 bytes: 32 ct + 32 CTX tag) (§ 9.2).
pub const OFFSET_ENC_ITEM_KEY: usize = 48;

/// Offset of `content_nonce` (24 bytes) (§ 9.2).
pub const OFFSET_CONTENT_NONCE: usize = HEADER_PREFIX_LEN;

/// Offset of `ciphertext_len` (4 bytes BE) (§ 9.2).
pub const OFFSET_CIPHERTEXT_LEN: usize = OFFSET_CONTENT_NONCE + AEAD_NONCE_LEN;

/// Offset of the AEAD-encrypted note ciphertext (§ 9.2).
pub const OFFSET_CIPHERTEXT: usize = OFFSET_CIPHERTEXT_LEN + 4;

// ---- DecryptedNote handle -----------------------------------------------

/// Output of a successful note decryption. Carries the unwrapped
/// `item_key`, the decrypted plaintext, and — load-bearing for the
/// § 6.3 update path — the original 112-byte header slab so the
/// caller can rewrite only the tail of an existing blob (Task 8's
/// `encode_update_blob_raw`).
///
/// The `header_prefix` slab is **private** by design. § 6.3's
/// "bytes 0..47+N byte-identical to the previous blob" invariant is
/// satisfied by literal byte-copy on update — the encoder never
/// reconstructs the prefix from fields. Accessors below expose
/// individual fields by slicing into the slab; mutation is impossible.
///
/// `note_uuid` is held separately because § 9.1 specifies it lives in
/// the `.myn` filename, not in the blob bytes. The AAD construction at
/// decrypt time consumes the caller-supplied `note_uuid`; the slab
/// has no copy.
///
/// Both `item_key` (32 B) and `plaintext` (Markdown bytes) are wrapped
/// in [`Zeroizing`] so Drop wipes them. The slab itself and
/// `note_uuid` are non-secret.
pub struct DecryptedNote {
    header_prefix: [u8; HEADER_PREFIX_LEN],
    note_uuid: [u8; NOTE_UUID_LEN],
    item_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    plaintext: Zeroizing<Vec<u8>>,
}

impl DecryptedNote {
    /// Constructor for crate-internal decode/test paths only. The
    /// public construction path is [`decode_note`]. Holding the
    /// constructor `pub(crate)` ensures that any `DecryptedNote`
    /// instance reaching production code passed through
    /// `decode_note`'s AEAD verification — the §6.5 AAD-binding
    /// guarantees ride on this discipline.
    pub(crate) fn new(
        header_prefix: [u8; HEADER_PREFIX_LEN],
        note_uuid: [u8; NOTE_UUID_LEN],
        item_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
        plaintext: Zeroizing<Vec<u8>>,
    ) -> Self {
        Self {
            header_prefix,
            note_uuid,
            item_key,
            plaintext,
        }
    }

    /// The 16-byte UUIDv7 of the singleton v0.1 `itemsKey` under which
    /// this note's `item_key` is wrapped. Slice of the source blob's
    /// bytes 6..22 per § 9.2.
    pub fn items_key_id(&self) -> &[u8; ITEMS_KEY_ID_LEN] {
        slice_into_array(&self.header_prefix, OFFSET_ITEMS_KEY_ID)
    }

    /// The 24-byte AEAD nonce used to wrap this note's `item_key`
    /// under `itemsKey`. Slice of bytes 22..46 per § 9.2.
    pub fn item_key_nonce(&self) -> &[u8; AEAD_NONCE_LEN] {
        slice_into_array(&self.header_prefix, OFFSET_ITEM_KEY_NONCE)
    }

    /// The 64-byte AEAD-wrapped `item_key` (32 B ct + 32 B CTX tag).
    /// Slice of bytes 48..112 per § 9.2. § 6.3 keeps this byte-region
    /// byte-identical across note revisions — the persistent `item_key`
    /// is never re-wrapped, even on password rotation.
    pub fn enc_item_key(&self) -> &[u8; ENC_ITEM_KEY_WRAPPED_LEN] {
        slice_into_array(&self.header_prefix, OFFSET_ENC_ITEM_KEY)
    }

    /// The note's UUIDv7 (§ 9.1: same as the `.myn` filename).
    /// Carried separately because § 9.2 does not place it in the blob
    /// bytes — it travels via the filesystem path and is fed into both
    /// AADs at decrypt time.
    pub fn note_uuid(&self) -> &[u8; NOTE_UUID_LEN] {
        &self.note_uuid
    }

    /// The decrypted Markdown plaintext. Backed by `Zeroizing<Vec<u8>>`
    /// — Drop wipes the bytes when the handle is dropped or consumed.
    pub fn plaintext(&self) -> &[u8] {
        self.plaintext.as_slice()
    }

    /// The original 112-byte header slab (`magic || version ||
    /// reserved || items_key_id || item_key_nonce || enc_item_key_len
    /// || enc_item_key`). Crate-internal: the §6.3 update path
    /// ([`encode_update_blob_raw`]) splices this byte-literal into the
    /// new blob to satisfy the byte-identical invariant; not part of
    /// the public API.
    pub(crate) fn header_prefix(&self) -> &[u8; HEADER_PREFIX_LEN] {
        &self.header_prefix
    }

    /// The unwrapped 32-byte `item_key`. Crate-internal:
    /// [`encode_update_blob_raw`] reuses this key under a fresh
    /// `content_nonce` per § 6.3.
    pub(crate) fn item_key(&self) -> &[u8; AEAD_KEY_LEN] {
        &self.item_key
    }
}

/// Redacted [`Debug`] impl. Required by `Result::expect_err` and
/// similar APIs that need `Debug` on the `Ok` type, but the default
/// derive would print the `item_key` and `plaintext` fields verbatim
/// — a secret-leak channel through `tracing::debug!`, panic
/// messages, or test-failure output. This impl emits only non-secret
/// metadata: the note UUID, the plaintext length, and a fixed
/// redaction marker for the slab and the key.
impl core::fmt::Debug for DecryptedNote {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("DecryptedNote")
            .field("note_uuid", &self.note_uuid)
            .field("header_prefix", &"<112 B redacted>")
            .field("item_key", &"<Zeroizing<[u8; 32]> redacted>")
            .field("plaintext_len", &self.plaintext.len())
            .finish()
    }
}

/// Slice a `LEN`-byte fixed-size sub-array out of a larger fixed slab
/// at `offset`. The compile-time array length lets accessor methods
/// return `&[u8; N]` without runtime checks. Panics in debug builds
/// if the offset would overflow the slab — covered by the offset
/// constants being `pub const` and audited against the §9.2 layout.
fn slice_into_array<const LEN: usize>(slab: &[u8; HEADER_PREFIX_LEN], offset: usize) -> &[u8; LEN] {
    debug_assert!(offset + LEN <= HEADER_PREFIX_LEN);
    let region: &[u8] = &slab[offset..offset + LEN];
    region
        .try_into()
        .expect("offset + LEN fits in HEADER_PREFIX_LEN by construction")
}

// ---- Encoder (deterministic primitive) ----------------------------------

/// Encode a fresh `.myn` blob from caller-supplied randomness per
/// `protocol.md` § 6.2. Deterministic: identical inputs produce
/// identical output bytes. Used by `myne-test-vectors/` for D6 and by
/// crate-internal tampering tests.
///
/// **`_raw` contract (caller-supplied randomness).** The caller MUST:
/// 1. Source `item_key`, `item_key_nonce`, and `content_nonce` from a
///    CSPRNG-grade source. Low-entropy or attacker-influenced bytes
///    are a security-fatal contract violation owned by the caller.
/// 2. Never reuse `item_key_nonce` or `content_nonce` across distinct
///    encryptions under the same key. Nonce reuse is catastrophic and
///    is the caller's contract — `aead_seal_ctx` cannot detect it
///    cross-call. See `protocol/AGENTS.md` "Nonce reuse is
///    catastrophic" gotcha.
///
/// Production callers SHOULD use Task 7's `encode_new_note`
/// convenience wrapper, which sources all three values from
/// `getrandom`. The `_raw` surface exists for vector verification
/// (D6) and crate-internal deterministic tampering tests.
///
/// **Layout.** Output is exactly the §9.2 byte sequence. With
/// `plaintext.len() = N`, total output length is
/// `HEADER_PREFIX_LEN + AEAD_NONCE_LEN + 4 + N + CTX_COMMITMENT_TAG_LEN`
/// = `140 + N + 32`.
///
/// **Errors.** Returns [`ProtocolError::PlaintextTooLarge`] if
/// `plaintext.len() > MAX_PLAINTEXT_LEN` (16 MiB cap, see
/// `decisions.md` 2026-05-06). Returns [`ProtocolError::AeadFailure`]
/// only on AAD overflow inside the AEAD primitive — practically
/// unreachable for v0.1 AADs (43 / 58 bytes).
pub fn encode_new_note_blob_raw(
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
    note_uuid: &[u8; NOTE_UUID_LEN],
    item_key: &[u8; AEAD_KEY_LEN],
    item_key_nonce: &[u8; AEAD_NONCE_LEN],
    content_nonce: &[u8; AEAD_NONCE_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(ProtocolError::PlaintextTooLarge);
    }

    // (1) Wrap item_key under itemsKey with §5.2's AAD_wrap_item_key.
    let aad_wrap = aad_note_item_key_wrap(items_key_id, note_uuid);
    let enc_item_key = aead_seal_ctx(items_key, item_key_nonce, item_key, &aad_wrap)?;
    debug_assert_eq!(enc_item_key.len(), ENC_ITEM_KEY_WRAPPED_LEN);

    // (2) Encrypt plaintext under item_key with §5.2's AAD_encrypt_content.
    let aad_content = aad_note_content_encrypt(items_key_id, note_uuid);
    let ciphertext = aead_seal_ctx(item_key, content_nonce, plaintext, &aad_content)?;
    debug_assert_eq!(ciphertext.len(), plaintext.len() + CTX_COMMITMENT_TAG_LEN);

    // (3) Assemble the §9.2 byte sequence.
    let total_len = OFFSET_CIPHERTEXT + ciphertext.len();
    let mut blob = Vec::with_capacity(total_len);
    blob.extend_from_slice(MAGIC);
    blob.push(PROTOCOL_VERSION);
    blob.push(RESERVED_BYTE);
    blob.extend_from_slice(items_key_id);
    blob.extend_from_slice(item_key_nonce);
    blob.extend_from_slice(&(ENC_ITEM_KEY_WRAPPED_LEN as u16).to_be_bytes());
    blob.extend_from_slice(&enc_item_key);
    blob.extend_from_slice(content_nonce);
    let ciphertext_len_u32 =
        u32::try_from(ciphertext.len()).map_err(|_| ProtocolError::PlaintextTooLarge)?;
    blob.extend_from_slice(&ciphertext_len_u32.to_be_bytes());
    blob.extend_from_slice(&ciphertext);

    debug_assert_eq!(blob.len(), total_len);
    Ok(blob)
}

/// Rewrite a `.myn` blob's content under the existing `item_key` per
/// `protocol.md` § 6.3. Deterministic: identical (handle, content_nonce,
/// new_plaintext) inputs produce identical output bytes — used by
/// `myne-test-vectors/` (D6) and crate-internal tampering tests.
///
/// **§6.3 byte-identical invariant.** Bytes 0..47+N — the 112-byte
/// `HEADER_PREFIX_LEN` region containing the magic, version, reserved,
/// `items_key_id`, `item_key_nonce`, `enc_item_key_len`, and
/// `enc_item_key` fields — are byte-identical to the source blob the
/// handle was decoded from. This is satisfied **by construction**: the
/// encoder splices `handle.header_prefix()` verbatim, never
/// reconstructing from fields. The persistent `item_key` (and its
/// wrap) survives password rotation; only `content_nonce`,
/// `ciphertext_len`, and `ciphertext` change. See `decisions.md`
/// 2026-05-05 entry "`item_key` persistence across note revisions".
///
/// **Borrow vs. consume.** This `_raw` form **borrows** the handle so
/// D6 vector tests can permute `content_nonce` over the same handle
/// without re-decoding. Production callers consume the handle via
/// [`encode_update`] — typestate enforcement of "one decode, one
/// update". See `decisions.md` 2026-05-06 `_raw` convention.
///
/// **`_raw` contract (caller-supplied randomness).** The caller MUST:
/// 1. Source `content_nonce` from a CSPRNG-grade source.
/// 2. Never reuse `content_nonce` across distinct content encryptions
///    under the same `item_key`. Nonce reuse under a fixed key is
///    catastrophic; production callers SHOULD use [`encode_update`]
///    which sources `content_nonce` from `getrandom`.
///
/// **Errors.** Returns [`ProtocolError::PlaintextTooLarge`] if
/// `new_plaintext.len() > MAX_PLAINTEXT_LEN`.
pub fn encode_update_blob_raw(
    handle: &DecryptedNote,
    content_nonce: &[u8; AEAD_NONCE_LEN],
    new_plaintext: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    if new_plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(ProtocolError::PlaintextTooLarge);
    }

    // Reconstruct the §5.2 AAD from the handle's items_key_id (slice
    // of the slab) and note_uuid (separately carried — §9.1).
    // content_type is hardcoded inside `aad_note_content_encrypt`.
    let aad_content = aad_note_content_encrypt(handle.items_key_id(), handle.note_uuid());

    // AEAD-encrypt under the handle's item_key with the caller-supplied
    // content_nonce. The resulting ciphertext is `len + 32` bytes
    // (plaintext bytes + CTX commitment tag).
    let ciphertext = aead_seal_ctx(
        handle.item_key(),
        content_nonce,
        new_plaintext,
        &aad_content,
    )?;
    debug_assert_eq!(
        ciphertext.len(),
        new_plaintext.len() + CTX_COMMITMENT_TAG_LEN
    );

    // Splice header_prefix verbatim, then append the (re-randomized)
    // tail. Total: 112 + 24 + 4 + (M = new_plaintext.len() + 32).
    let total_len = OFFSET_CIPHERTEXT + ciphertext.len();
    let mut blob = Vec::with_capacity(total_len);
    blob.extend_from_slice(handle.header_prefix());
    blob.extend_from_slice(content_nonce);
    let ciphertext_len_u32 =
        u32::try_from(ciphertext.len()).map_err(|_| ProtocolError::PlaintextTooLarge)?;
    blob.extend_from_slice(&ciphertext_len_u32.to_be_bytes());
    blob.extend_from_slice(&ciphertext);

    debug_assert_eq!(blob.len(), total_len);
    Ok(blob)
}

// ---- Convenience wrapper (production caller surface) -------------------

/// Encode a fresh `.myn` blob, sourcing all randomness internally
/// from `getrandom::getrandom`. Production callers (the future Tauri
/// note-CRUD plugin, MYND `A9a`) consume this surface; D6 vector
/// generation and crate-internal tampering tests use the deterministic
/// `_raw` sibling [`encode_new_note_blob_raw`].
///
/// Pulls a 32-byte `item_key`, a 24-byte `item_key_nonce`, and a
/// 24-byte `content_nonce` from the OS CSPRNG, then forwards to
/// [`encode_new_note_blob_raw`]. The `item_key` is held in
/// `Zeroizing` and dropped at function exit; the wrapped form
/// (`enc_item_key`) is what reaches the on-disk blob.
///
/// **Errors:** [`ProtocolError::Csprng`] if `getrandom` fails (treated
/// as fatal per the existing crate convention; cf. `phrase.rs` and
/// `account_number.rs`); [`ProtocolError::PlaintextTooLarge`] if
/// `plaintext.len() > MAX_PLAINTEXT_LEN`.
pub fn encode_new_note(
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
    note_uuid: &[u8; NOTE_UUID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    let mut item_key = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    getrandom::getrandom(item_key.as_mut_slice()).map_err(|_| ProtocolError::Csprng)?;

    let mut item_key_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut item_key_nonce).map_err(|_| ProtocolError::Csprng)?;

    let mut content_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut content_nonce).map_err(|_| ProtocolError::Csprng)?;

    encode_new_note_blob_raw(
        items_key,
        items_key_id,
        note_uuid,
        &item_key,
        &item_key_nonce,
        &content_nonce,
        plaintext,
    )
}

/// Rewrite a note's content under the existing `item_key`, sourcing
/// `content_nonce` from `getrandom::getrandom`. Production caller
/// surface for `protocol.md` § 6.3 (note update).
///
/// **Consumes the handle.** The type signature enforces "one decode,
/// one update" structurally — once `encode_update` returns, the
/// handle's `Drop` fires and `item_key` + `plaintext` zeroize. A
/// caller that wants to update again must re-decode the new blob;
/// reusing a stale handle is impossible by construction. D6 / vector
/// generation calls the borrowing `_raw` sibling
/// [`encode_update_blob_raw`] when nonce-permutation is needed.
///
/// **Errors:** [`ProtocolError::Csprng`] if `getrandom` fails;
/// [`ProtocolError::PlaintextTooLarge`] if
/// `new_plaintext.len() > MAX_PLAINTEXT_LEN`.
pub fn encode_update(
    handle: DecryptedNote,
    new_plaintext: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    let mut content_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut content_nonce).map_err(|_| ProtocolError::Csprng)?;
    encode_update_blob_raw(&handle, &content_nonce, new_plaintext)
    // `handle` drops here — Zeroizing fires on item_key + plaintext.
}

// ---- Decoder ------------------------------------------------------------

/// Public failure surface for [`decode_note`]. **Single variant by
/// design** per `protocol.md` § 6.4 final paragraph: *"the client MUST
/// NOT distinguish failure causes to the user beyond 'this note
/// cannot be decrypted under the current vault'"*. Internal cause
/// distinguishability lives in `DecryptCause` (`pub(crate)`) and
/// emits via `tracing::debug!(stage = ?cause)` for ops debugging
/// without crossing the IPC boundary. This is the same boundary-policy
/// shape pinned by `decisions.md` 2026-05-02 vault-unlock-error-discipline.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum DecryptError {
    /// The blob cannot be decrypted under the supplied (`itemsKey`,
    /// `items_key_id`, `note_uuid`). The caller MUST NOT distinguish
    /// the failure cause to the user beyond this single message.
    #[error("note cannot be decrypted under the current vault")]
    CannotDecrypt,
}

/// Internal disambiguation of decode-failure paths. Exposed
/// `pub(crate)` so the tampering-test matrix in this module
/// (Tasks 9 + 10) can verify which defense fired per mutation case.
/// **Never crosses the IPC boundary** — the public [`decode_note`]
/// collapses every variant to [`DecryptError::CannotDecrypt`] before
/// returning. See `decisions.md` 2026-05-06 entry "`_raw` suffix
/// convention" + 2026-05-02 vault-unlock-error-discipline for the
/// project-wide structural-vs-boundary lens.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DecryptCause {
    /// `protocol.md` § 6.4 step 1 — header parse rejects (wrong magic,
    /// wrong version, non-zero reserved, wrong `enc_item_key_len`,
    /// truncated header), plus the §9.2 cap on `ciphertext_len`
    /// (> MAX_PLAINTEXT_LEN + 32 → reject before allocation), plus
    /// the §10.1 strict-trailing rule (declared `ciphertext_len` must
    /// match the remaining bytes — no trailing covert-channel surface).
    Parse,
    /// `protocol.md` § 6.4 step 2 — blob's `items_key_id` does not
    /// match the singleton `items_key_id` the caller supplied (which
    /// the host reads from `vault.meta`). v0.1 has exactly one
    /// `itemsKey` per vault; a mismatch is either a foreign blob or
    /// vault-meta corruption.
    ItemsKeyIdMismatch,
    /// `protocol.md` § 6.4 step 3 — AEAD-unwrap of `enc_item_key`
    /// failed the CTX commitment check. Means either the blob was
    /// tampered (any byte feeding the canonical encoding:
    /// `enc_item_key`, `item_key_nonce`, `items_key_id` in AAD,
    /// `note_uuid` in AAD, version/prefix bytes) or `itemsKey` is
    /// wrong (cross-vault).
    OuterAead,
    /// `protocol.md` § 6.4 step 4 — content decryption failed the CTX
    /// commitment check given a successful outer unwrap. Narrows to
    /// corruption of `content_nonce`, `ciphertext`, the trailing CTX
    /// tag, or `content_type` mismatch (impossible in v0.1's
    /// hardcoded path).
    InnerAead,
}

/// Decrypt a `.myn` blob into a [`DecryptedNote`] handle. Single-error
/// public surface per `protocol.md` § 6.4 — failures collapse to
/// [`DecryptError::CannotDecrypt`] regardless of cause.
///
/// `note_uuid` is the `.myn` filename per § 9.1; the caller (typically
/// the Tauri note-CRUD plugin) extracts it from the path before
/// calling. `items_key_id` is the singleton id read from `vault.meta`
/// at unlock time — the §6.4 step-2 check rejects blobs whose embedded
/// `items_key_id` does not match.
///
/// On success, the returned handle holds the unwrapped 32-byte
/// `item_key`, the decrypted Markdown plaintext, and the original
/// 112-byte header slab. Both `item_key` and `plaintext` are
/// [`Zeroizing`]-wrapped: Drop wipes them when the handle is dropped
/// or consumed by Task 8's `encode_update`. The §6.3 byte-identical
/// invariant is satisfied true-by-construction because the slab is
/// retained verbatim.
///
/// **Failure paths emit `tracing::debug!(stage = ?cause)`** for ops
/// debugging — the cause never crosses the IPC boundary as a
/// distinguisher. `decisions.md` 2026-05-02 vault-unlock-error-discipline
/// established this pattern; see also `decisions.md` 2026-05-06
/// `_raw` convention entry.
pub fn decode_note(
    blob: &[u8],
    note_uuid: &[u8; NOTE_UUID_LEN],
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
) -> Result<DecryptedNote, DecryptError> {
    decode_note_with_cause(blob, note_uuid, items_key, items_key_id).map_err(|cause| {
        tracing::debug!(stage = ?cause, "decode_note failed");
        DecryptError::CannotDecrypt
    })
}

/// Crate-internal decode entry point that returns the distinguishable
/// [`DecryptCause`]. The tampering-test matrix in this module
/// (Tasks 9 + 10) asserts against specific causes; the public
/// [`decode_note`] is the single-variant collapse for IPC surface.
///
/// Implements `protocol.md` § 6.4 in order: parse-level checks (step 1)
/// → singleton items_key_id check (step 2) → outer AEAD unwrap of
/// `item_key` (step 3) → inner AEAD decrypt of `ciphertext` (step 4).
pub(crate) fn decode_note_with_cause(
    blob: &[u8],
    note_uuid: &[u8; NOTE_UUID_LEN],
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
) -> Result<DecryptedNote, DecryptCause> {
    // ---- Step 1: parse-level checks (§ 6.4 step 1 + cap + trailing) ----

    // Truncated header — can't even read the fixed-position fields.
    if blob.len() < OFFSET_CIPHERTEXT {
        return Err(DecryptCause::Parse);
    }

    // Magic.
    if &blob[0..MAGIC.len()] != MAGIC {
        return Err(DecryptCause::Parse);
    }
    // Protocol version.
    if blob[OFFSET_PROTOCOL_VERSION] != PROTOCOL_VERSION {
        return Err(DecryptCause::Parse);
    }
    // Reserved byte (MUST be 0x00).
    if blob[OFFSET_RESERVED] != RESERVED_BYTE {
        return Err(DecryptCause::Parse);
    }
    // enc_item_key_len (MUST be the constant 64 in v0.1).
    let enc_item_key_len_bytes: [u8; 2] = blob[OFFSET_ENC_ITEM_KEY_LEN..OFFSET_ENC_ITEM_KEY]
        .try_into()
        .expect("2-byte slice fits a [u8; 2] by construction");
    let enc_item_key_len = u16::from_be_bytes(enc_item_key_len_bytes) as usize;
    if enc_item_key_len != ENC_ITEM_KEY_WRAPPED_LEN {
        return Err(DecryptCause::Parse);
    }

    // ciphertext_len (4-byte BE).
    let ciphertext_len_bytes: [u8; 4] = blob[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
        .try_into()
        .expect("4-byte slice fits a [u8; 4] by construction");
    let ciphertext_len = u32::from_be_bytes(ciphertext_len_bytes) as usize;

    // ciphertext_len < 32: no room for the trailing CTX commitment tag.
    if ciphertext_len < CTX_COMMITMENT_TAG_LEN {
        return Err(DecryptCause::Parse);
    }
    // ciphertext_len > MAX + 32: §9.2 cap. Reject BEFORE allocation —
    // CTX commitment check is post-allocation by construction.
    if ciphertext_len > MAX_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(DecryptCause::Parse);
    }
    // Strict-trailing (§ 10.1 forward-incompatibility): blob length
    // MUST equal the declared layout. Anything shorter is a truncated
    // ciphertext; anything longer is trailing bytes that v0.1 refuses
    // to silently accept (covert-channel defense).
    let expected_total = OFFSET_CIPHERTEXT + ciphertext_len;
    if blob.len() != expected_total {
        return Err(DecryptCause::Parse);
    }

    // ---- Step 2: items_key_id mismatch (§ 6.4 step 2) ----

    let blob_items_key_id_slice = &blob[OFFSET_ITEMS_KEY_ID..OFFSET_ITEM_KEY_NONCE];
    if blob_items_key_id_slice != items_key_id.as_slice() {
        return Err(DecryptCause::ItemsKeyIdMismatch);
    }

    // ---- Step 3: outer AEAD — unwrap item_key under itemsKey ----

    let item_key_nonce: [u8; AEAD_NONCE_LEN] = blob[OFFSET_ITEM_KEY_NONCE..OFFSET_ENC_ITEM_KEY_LEN]
        .try_into()
        .expect("24-byte slice fits AEAD_NONCE_LEN by construction");
    let enc_item_key_bytes = &blob[OFFSET_ENC_ITEM_KEY..OFFSET_CONTENT_NONCE];
    let aad_wrap = aad_note_item_key_wrap(items_key_id, note_uuid);
    let item_key_zeroizing =
        aead_open_ctx(items_key, &item_key_nonce, enc_item_key_bytes, &aad_wrap)
            .map_err(|_| DecryptCause::OuterAead)?;

    // The unwrap yields exactly AEAD_KEY_LEN bytes (item_key is a
    // 32-byte key by construction; § 9.2 enc_item_key_len = 64 = 32 ct
    // + 32 CTX tag; CTX tag is stripped inside aead_open_ctx). Anything
    // else is a crate-internal invariant violation, not a tampering
    // case — but defensively map to OuterAead rather than panic.
    if item_key_zeroizing.len() != AEAD_KEY_LEN {
        return Err(DecryptCause::OuterAead);
    }
    let mut item_key = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    item_key.copy_from_slice(&item_key_zeroizing);

    // ---- Step 4: inner AEAD — decrypt ciphertext under item_key ----

    let content_nonce: [u8; AEAD_NONCE_LEN] = blob[OFFSET_CONTENT_NONCE..OFFSET_CIPHERTEXT_LEN]
        .try_into()
        .expect("24-byte slice fits AEAD_NONCE_LEN by construction");
    let ciphertext_bytes = &blob[OFFSET_CIPHERTEXT..];
    let aad_content = aad_note_content_encrypt(items_key_id, note_uuid);
    let plaintext = aead_open_ctx(&item_key, &content_nonce, ciphertext_bytes, &aad_content)
        .map_err(|_| DecryptCause::InnerAead)?;

    // ---- Construct DecryptedNote ----

    let mut header_prefix = [0u8; HEADER_PREFIX_LEN];
    header_prefix.copy_from_slice(&blob[..HEADER_PREFIX_LEN]);

    Ok(DecryptedNote::new(
        header_prefix,
        *note_uuid,
        item_key,
        plaintext,
    ))
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::test_vector_fmt::{hex_lower, json_escape};
    use alloc::vec;

    // Shared test fixtures. Patterns chosen so cross-parameter
    // confusion (e.g., swapping `items_key` and `item_key`) produces
    // visibly different bytes in golden assertions.
    const TEST_ITEMS_KEY: [u8; AEAD_KEY_LEN] = [0xAA; 32];
    const TEST_ITEMS_KEY_ID: [u8; ITEMS_KEY_ID_LEN] = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
        0xFF,
    ];
    const TEST_NOTE_UUID: [u8; NOTE_UUID_LEN] = [
        0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
        0x00,
    ];
    const TEST_ITEM_KEY: [u8; AEAD_KEY_LEN] = [0xCC; 32];
    const TEST_ITEM_KEY_NONCE: [u8; AEAD_NONCE_LEN] = [0x10; 24];
    const TEST_CONTENT_NONCE: [u8; AEAD_NONCE_LEN] = [0x20; 24];
    const TEST_PLAINTEXT: &[u8] = b"# Hello\nThis is a test note.\n";

    fn encode_with_test_fixture(plaintext: &[u8]) -> Vec<u8> {
        encode_new_note_blob_raw(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            &TEST_ITEM_KEY,
            &TEST_ITEM_KEY_NONCE,
            &TEST_CONTENT_NONCE,
            plaintext,
        )
        .expect("test fixture encodes cleanly")
    }

    // ---- Spec §9.2 layout constants pin -------------------------------

    #[test]
    fn header_prefix_len_matches_spec_9_2_offsets() {
        // Prefix runs from offset 0 (magic) through offset 47 + 64 =
        // 111 inclusive — i.e., the §6.3 byte-identical region. 112 is
        // the first byte AFTER the prefix (the start of content_nonce).
        assert_eq!(HEADER_PREFIX_LEN, 112);
        assert_eq!(OFFSET_CONTENT_NONCE, HEADER_PREFIX_LEN);
    }

    #[test]
    fn enc_item_key_wrapped_len_is_sixty_four() {
        // §9.2 pins enc_item_key_len = 64 (32 B ct + 32 B CTX tag).
        // The constant survives via the (AEAD_KEY_LEN + CTX_TAG_LEN)
        // composition; this test ensures the underlying primitives
        // never drift.
        assert_eq!(ENC_ITEM_KEY_WRAPPED_LEN, 64);
        assert_eq!(AEAD_KEY_LEN + CTX_COMMITMENT_TAG_LEN, 64);
    }

    #[test]
    fn offsets_cover_the_full_fixed_prefix_without_gaps() {
        // Walk §9.2 offsets sequentially: each field starts where the
        // previous ended. A gap or overlap here would silently corrupt
        // the encoder's byte layout.
        assert_eq!(OFFSET_PROTOCOL_VERSION, MAGIC.len()); // 4
        assert_eq!(OFFSET_RESERVED, OFFSET_PROTOCOL_VERSION + 1); // 5
        assert_eq!(OFFSET_ITEMS_KEY_ID, OFFSET_RESERVED + 1); // 6
        assert_eq!(
            OFFSET_ITEM_KEY_NONCE,
            OFFSET_ITEMS_KEY_ID + ITEMS_KEY_ID_LEN
        ); // 22
        assert_eq!(
            OFFSET_ENC_ITEM_KEY_LEN,
            OFFSET_ITEM_KEY_NONCE + AEAD_NONCE_LEN
        ); // 46
        assert_eq!(OFFSET_ENC_ITEM_KEY, OFFSET_ENC_ITEM_KEY_LEN + 2); // 48
        assert_eq!(
            OFFSET_CONTENT_NONCE,
            OFFSET_ENC_ITEM_KEY + ENC_ITEM_KEY_WRAPPED_LEN
        ); // 112
        assert_eq!(OFFSET_CIPHERTEXT_LEN, OFFSET_CONTENT_NONCE + AEAD_NONCE_LEN); // 136
        assert_eq!(OFFSET_CIPHERTEXT, OFFSET_CIPHERTEXT_LEN + 4); // 140
    }

    // ---- DecryptedNote accessor slicing -------------------------------

    fn make_test_decrypted_note() -> DecryptedNote {
        // Hand-built header_prefix containing the test fixture's
        // items_key_id at offset 6 and item_key_nonce at offset 22, so
        // accessors can be verified against known-good slices.
        let mut header_prefix = [0u8; HEADER_PREFIX_LEN];
        header_prefix[0..4].copy_from_slice(MAGIC);
        header_prefix[OFFSET_PROTOCOL_VERSION] = PROTOCOL_VERSION;
        header_prefix[OFFSET_RESERVED] = RESERVED_BYTE;
        header_prefix[OFFSET_ITEMS_KEY_ID..OFFSET_ITEM_KEY_NONCE]
            .copy_from_slice(&TEST_ITEMS_KEY_ID);
        header_prefix[OFFSET_ITEM_KEY_NONCE..OFFSET_ENC_ITEM_KEY_LEN]
            .copy_from_slice(&TEST_ITEM_KEY_NONCE);
        header_prefix[OFFSET_ENC_ITEM_KEY_LEN..OFFSET_ENC_ITEM_KEY]
            .copy_from_slice(&(ENC_ITEM_KEY_WRAPPED_LEN as u16).to_be_bytes());
        // Mark the enc_item_key region with a recognizable byte
        // (0xEE) so the accessor's slice can be asserted against a
        // known constant.
        header_prefix[OFFSET_ENC_ITEM_KEY..HEADER_PREFIX_LEN].fill(0xEE);

        DecryptedNote::new(
            header_prefix,
            TEST_NOTE_UUID,
            Zeroizing::new(TEST_ITEM_KEY),
            Zeroizing::new(b"plaintext bytes".to_vec()),
        )
    }

    #[test]
    fn accessor_items_key_id_returns_slab_bytes_6_through_21() {
        let handle = make_test_decrypted_note();
        assert_eq!(handle.items_key_id(), &TEST_ITEMS_KEY_ID);
    }

    #[test]
    fn accessor_item_key_nonce_returns_slab_bytes_22_through_45() {
        let handle = make_test_decrypted_note();
        assert_eq!(handle.item_key_nonce(), &TEST_ITEM_KEY_NONCE);
    }

    #[test]
    fn accessor_enc_item_key_returns_slab_bytes_48_through_111() {
        let handle = make_test_decrypted_note();
        assert_eq!(handle.enc_item_key(), &[0xEE; ENC_ITEM_KEY_WRAPPED_LEN]);
    }

    #[test]
    fn accessor_note_uuid_returns_separately_carried_uuid() {
        // §9.1: note_uuid is the .myn filename, not in the blob bytes.
        let handle = make_test_decrypted_note();
        assert_eq!(handle.note_uuid(), &TEST_NOTE_UUID);
    }

    #[test]
    fn accessor_plaintext_returns_unwrapped_zeroizing_bytes() {
        let handle = make_test_decrypted_note();
        assert_eq!(handle.plaintext(), b"plaintext bytes");
    }

    #[test]
    fn accessor_header_prefix_returns_full_one_twelve_byte_slab() {
        // Task 8's update path splices header_prefix() byte-literal
        // into the new blob to satisfy §6.3's byte-identical
        // invariant. This test pins the slab equality contract
        // between the constructor input and the accessor output.
        let handle = make_test_decrypted_note();
        let prefix = handle.header_prefix();
        assert_eq!(prefix.len(), HEADER_PREFIX_LEN);
        assert_eq!(&prefix[0..4], MAGIC);
        assert_eq!(prefix[OFFSET_PROTOCOL_VERSION], PROTOCOL_VERSION);
        assert_eq!(prefix[OFFSET_RESERVED], RESERVED_BYTE);
        assert_eq!(
            &prefix[OFFSET_ITEMS_KEY_ID..OFFSET_ITEM_KEY_NONCE],
            &TEST_ITEMS_KEY_ID,
        );
        assert_eq!(
            &prefix[OFFSET_ITEM_KEY_NONCE..OFFSET_ENC_ITEM_KEY_LEN],
            &TEST_ITEM_KEY_NONCE,
        );
    }

    #[test]
    fn accessor_item_key_returns_unwrapped_thirty_two_byte_key() {
        // Task 8 reuses item_key() under a fresh content_nonce per
        // §6.3. Pin that the constructor input survives intact through
        // Zeroizing wrapping and accessor exit.
        let handle = make_test_decrypted_note();
        assert_eq!(handle.item_key(), &TEST_ITEM_KEY);
    }

    #[test]
    fn debug_redacts_item_key_and_plaintext_bytes() {
        // Catastrophic regression guard mirroring `phrase.rs`'s
        // `debug_redacts_phrase_contents`. `format!("{:?}", DecryptedNote)`
        // must never include item_key bytes or plaintext bytes — the
        // default `derive(Debug)` would print both, opening a secret
        // leak through `tracing::debug!`, panic messages, `expect_err`
        // output, or any future `dbg!()` debugging.
        let handle = make_test_decrypted_note();
        let debug = alloc::format!("{handle:?}");
        assert!(
            debug.contains("redacted"),
            "Debug output missing redaction marker: {debug:?}",
        );
        // `make_test_decrypted_note` wraps the literal "plaintext bytes"
        // — must not appear verbatim in the debug output.
        assert!(
            !debug.contains("plaintext bytes"),
            "Debug leaked plaintext payload: {debug:?}",
        );
        // TEST_ITEM_KEY is [0xCC; 32]; the default-derive Debug would
        // emit `204` (decimal of 0xCC) repeated. Three consecutive
        // `204`s would appear ONLY if the impl regressed.
        assert!(
            !debug.contains("204, 204, 204"),
            "Debug leaked item_key bytes: {debug:?}",
        );
    }

    // ---- Encoder boundary check ---------------------------------------

    #[test]
    fn encode_new_note_blob_raw_rejects_oversized_plaintext() {
        // Cap at MAX_PLAINTEXT_LEN; one byte over → PlaintextTooLarge.
        // Allocated only at test time; not part of any production path.
        let plaintext = vec![0u8; MAX_PLAINTEXT_LEN + 1];
        let err = encode_new_note_blob_raw(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            &TEST_ITEM_KEY,
            &TEST_ITEM_KEY_NONCE,
            &TEST_CONTENT_NONCE,
            &plaintext,
        )
        .expect_err("oversized plaintext must be rejected");
        assert_eq!(err, ProtocolError::PlaintextTooLarge);
    }

    #[test]
    fn encode_new_note_blob_raw_accepts_plaintext_at_cap() {
        // Boundary at the cap itself — still below or equal to limit.
        // Memory cost: 16 MiB allocation, acceptable for unit tests.
        let plaintext = vec![0u8; MAX_PLAINTEXT_LEN];
        let blob = encode_new_note_blob_raw(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            &TEST_ITEM_KEY,
            &TEST_ITEM_KEY_NONCE,
            &TEST_CONTENT_NONCE,
            &plaintext,
        )
        .expect("plaintext at cap must encode cleanly");
        // Total layout: 140 (header through ciphertext_len) + N
        // (plaintext) + 32 (CTX tag).
        assert_eq!(
            blob.len(),
            OFFSET_CIPHERTEXT + MAX_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN
        );
    }

    // ---- §9.2 byte-layout structural assertions -----------------------
    //
    // The encoder produces ciphertext bytes that depend on the
    // RustCrypto AEAD primitives — those bytes are validated
    // separately by `aead.rs`'s seal/open round-trip tests. Here we
    // assert the §9.2 framing around them: every fixed-position
    // field at the right offset, right length, and right value.

    #[test]
    fn encode_emits_magic_at_offset_zero() {
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        assert_eq!(&blob[0..4], MAGIC);
    }

    #[test]
    fn encode_emits_protocol_version_at_offset_four() {
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        assert_eq!(blob[OFFSET_PROTOCOL_VERSION], PROTOCOL_VERSION);
    }

    #[test]
    fn encode_emits_zero_reserved_byte_at_offset_five() {
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        assert_eq!(blob[OFFSET_RESERVED], RESERVED_BYTE);
    }

    #[test]
    fn encode_emits_items_key_id_at_offset_six() {
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        assert_eq!(
            &blob[OFFSET_ITEMS_KEY_ID..OFFSET_ITEM_KEY_NONCE],
            &TEST_ITEMS_KEY_ID,
        );
    }

    #[test]
    fn encode_emits_item_key_nonce_at_offset_twenty_two() {
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        assert_eq!(
            &blob[OFFSET_ITEM_KEY_NONCE..OFFSET_ENC_ITEM_KEY_LEN],
            &TEST_ITEM_KEY_NONCE,
        );
    }

    #[test]
    fn encode_emits_enc_item_key_len_as_u16_be_sixty_four() {
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        assert_eq!(
            &blob[OFFSET_ENC_ITEM_KEY_LEN..OFFSET_ENC_ITEM_KEY],
            &[0x00, 0x40], // u16 BE 64
        );
    }

    #[test]
    fn encode_emits_content_nonce_at_offset_one_twelve() {
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        assert_eq!(
            &blob[OFFSET_CONTENT_NONCE..OFFSET_CIPHERTEXT_LEN],
            &TEST_CONTENT_NONCE,
        );
    }

    #[test]
    fn encode_emits_ciphertext_len_as_u32_be_plaintext_plus_thirty_two() {
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        let expected = (TEST_PLAINTEXT.len() as u32 + CTX_COMMITMENT_TAG_LEN as u32).to_be_bytes();
        assert_eq!(&blob[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT], &expected,);
    }

    #[test]
    fn encode_emits_ciphertext_region_of_exact_length() {
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        let ciphertext_region = &blob[OFFSET_CIPHERTEXT..];
        assert_eq!(
            ciphertext_region.len(),
            TEST_PLAINTEXT.len() + CTX_COMMITMENT_TAG_LEN,
        );
    }

    #[test]
    fn encode_total_blob_length_matches_spec_formula() {
        // Total = HEADER_PREFIX_LEN (112) + content_nonce (24) +
        // ciphertext_len-field (4) + plaintext + CTX_TAG (32)
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        assert_eq!(
            blob.len(),
            OFFSET_CIPHERTEXT + TEST_PLAINTEXT.len() + CTX_COMMITMENT_TAG_LEN,
        );
    }

    // ---- G01: encoder full-byte golden pin ----------------------------

    /// G01 encoder golden — full-byte regression pin against a
    /// captured-and-verified output for the test fixture inputs above.
    /// Bytes 0..48 are deterministic from the §9.2 layout (magic +
    /// version + reserved + items_key_id + item_key_nonce +
    /// enc_item_key_len). Bytes 48..112 (`enc_item_key`) and 140..200
    /// (`ciphertext`) are AEAD output under the test fixture's keys
    /// and nonces — captured once from a known-good run of this
    /// encoder against `aead_seal_ctx`. Any encoder framing change OR
    /// AEAD primitive drift breaks this test, which is the entire
    /// point of cross-version regression coverage.
    ///
    /// `myne-test-vectors/` (D6) will pin a parallel byte sequence in
    /// the companion repo for cross-implementation verification; this
    /// test catches regressions inside the crate before the
    /// cross-repo loop runs.
    #[test]
    fn g01_encoder_full_byte_golden() {
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        // Total length: 140 (header + content_nonce + ciphertext_len)
        // + plaintext_len + 32 (CTX tag).
        assert_eq!(
            blob.len(),
            OFFSET_CIPHERTEXT + TEST_PLAINTEXT.len() + CTX_COMMITMENT_TAG_LEN,
        );
        // Header (deterministic from §9.2 layout):
        assert_eq!(&blob[0..4], MAGIC);
        assert_eq!(blob[4], PROTOCOL_VERSION);
        assert_eq!(blob[5], RESERVED_BYTE);
        assert_eq!(&blob[6..22], &TEST_ITEMS_KEY_ID);
        assert_eq!(&blob[22..46], &TEST_ITEM_KEY_NONCE);
        assert_eq!(&blob[46..48], &[0x00, 0x40]);
        // enc_item_key (offset 48..112) and ciphertext (offset 140..)
        // are AEAD output. Pin via sha256 of the full blob — drifts
        // detected without committing 200 bytes of magic numbers, and
        // the round-trip test in Task 6 will independently verify the
        // bytes are correct (decode round-trips back to TEST_PLAINTEXT).
        //
        // Hash captured once from a verified run; any encoder or AEAD
        // primitive drift moves this digest.
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&blob);
        let actual_hex = hex_encode(digest.as_slice());
        assert_eq!(
            actual_hex.as_str(),
            G01_BLOB_SHA256_HEX,
            "G01 golden digest drift — encoder framing or AEAD primitive changed",
        );
    }

    /// Captured SHA-256 of the G01 blob. Updated when a deliberate
    /// encoder/AEAD change lands; otherwise drift here is a regression.
    const G01_BLOB_SHA256_HEX: &str =
        "5189e8b794c08e87ab8d1a107bbf6a1392d5b92beb70a60526862aa2560957e6";

    fn hex_encode(bytes: &[u8]) -> alloc::string::String {
        use alloc::string::String;
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push(hex_nibble(b >> 4));
            s.push(hex_nibble(b & 0x0F));
        }
        s
    }

    fn hex_nibble(n: u8) -> char {
        match n {
            0..=9 => (b'0' + n) as char,
            10..=15 => (b'a' + (n - 10)) as char,
            _ => unreachable!(),
        }
    }

    // ---- R01 / R03: round-trip happy paths ----------------------------

    fn decode_with_test_fixture(blob: &[u8]) -> DecryptedNote {
        decode_note(blob, &TEST_NOTE_UUID, &TEST_ITEMS_KEY, &TEST_ITEMS_KEY_ID)
            .expect("test fixture decodes cleanly")
    }

    #[test]
    fn r01_round_trip_recovers_plaintext_and_identifiers() {
        // encode → decode → plaintext + ids equal.
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        let handle = decode_with_test_fixture(&blob);
        assert_eq!(handle.plaintext(), TEST_PLAINTEXT);
        assert_eq!(handle.items_key_id(), &TEST_ITEMS_KEY_ID);
        assert_eq!(handle.note_uuid(), &TEST_NOTE_UUID);
    }

    #[test]
    fn r01_round_trip_recovers_header_prefix_byte_byte() {
        // §6.3 invariant prep: header_prefix returned by the handle is
        // byte-identical to the source blob's bytes 0..112. Task 8's
        // update path will splice this back into the new blob; that
        // round-trip starts here.
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        let handle = decode_with_test_fixture(&blob);
        assert_eq!(handle.header_prefix(), &blob[..HEADER_PREFIX_LEN]);
    }

    #[test]
    fn r01_round_trip_recovers_item_key_through_zeroizing_wrap() {
        // The unwrapped item_key reaches the handle through aead_open_ctx
        // (Zeroizing<Vec<u8>>) and is copied into a Zeroizing<[u8; 32]>
        // by the decoder. Pin that the value survives the conversion
        // and matches the encoder's input.
        let blob = encode_with_test_fixture(TEST_PLAINTEXT);
        let handle = decode_with_test_fixture(&blob);
        assert_eq!(handle.item_key(), &TEST_ITEM_KEY);
    }

    #[test]
    fn r03_round_trip_with_empty_plaintext() {
        // Smallest valid note: empty Markdown body. ciphertext_len = 32
        // (just the CTX tag, no plaintext bytes). Total blob length =
        // OFFSET_CIPHERTEXT + 32 = 172.
        let blob = encode_with_test_fixture(b"");
        assert_eq!(blob.len(), OFFSET_CIPHERTEXT + CTX_COMMITMENT_TAG_LEN);
        let handle = decode_with_test_fixture(&blob);
        assert_eq!(handle.plaintext(), b"");
    }

    // ---- Public-surface single-variant collapse ----------------------

    #[test]
    fn decode_note_collapses_every_cause_to_cannot_decrypt() {
        // §6.4 final paragraph normative discipline: the public
        // surface emits a single error variant regardless of which
        // internal defense fired. Tampering tests in Tasks 9 + 10
        // assert against the distinguishable `decode_note_with_cause`;
        // here we just smoke-test that the public collapse holds.
        let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
        // Flip the magic byte → would yield Parse internally.
        blob[0] = b'X';
        let err = decode_note(&blob, &TEST_NOTE_UUID, &TEST_ITEMS_KEY, &TEST_ITEMS_KEY_ID)
            .expect_err("magic flip must reject");
        assert_eq!(err, DecryptError::CannotDecrypt);
    }

    #[test]
    fn decode_note_with_cause_distinguishes_parse_from_aead() {
        // Smoke-test that the pub(crate) cause API exposes the
        // distinguishable variants — the tampering matrix in Tasks 9
        // + 10 will exercise each cause exhaustively.
        let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
        blob[0] = b'X'; // magic flip → Parse
        let cause =
            decode_note_with_cause(&blob, &TEST_NOTE_UUID, &TEST_ITEMS_KEY, &TEST_ITEMS_KEY_ID)
                .expect_err("magic flip must reject");
        assert_eq!(cause, DecryptCause::Parse);
    }

    #[test]
    fn decrypt_error_serializes_with_kind_tag() {
        // Mirrors `ProtocolError`'s serde-tagged shape so the future
        // Tauri note-CRUD plugin (A9a) can match on `kind` from the
        // TS side without bespoke handling.
        let json = serde_json::to_string(&DecryptError::CannotDecrypt)
            .expect("DecryptError must serialize cleanly");
        assert_eq!(json, r#"{"kind":"CannotDecrypt"}"#);
    }

    // ---- Task 7: encode_new_note convenience wrapper -----------------

    #[test]
    fn encode_new_note_round_trips_through_decode_note() {
        // Production caller surface: encode_new_note pulls randomness
        // from getrandom internally; the resulting blob still decodes
        // cleanly under the same (items_key, items_key_id, note_uuid).
        let blob = encode_new_note(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            TEST_PLAINTEXT,
        )
        .expect("encode_new_note succeeds with the OS CSPRNG available");
        let handle = decode_with_test_fixture(&blob);
        assert_eq!(handle.plaintext(), TEST_PLAINTEXT);
        assert_eq!(handle.items_key_id(), &TEST_ITEMS_KEY_ID);
        assert_eq!(handle.note_uuid(), &TEST_NOTE_UUID);
    }

    #[test]
    fn encode_new_note_two_calls_with_identical_inputs_produce_different_blobs() {
        // Nonce-randomness check: two consecutive calls with byte-equal
        // inputs MUST produce byte-different blobs because both
        // item_key_nonce and content_nonce (and item_key itself) are
        // fresh from `getrandom`. Collision probability is negligible
        // at 32-byte item_key + 24-byte nonce widths from a CSPRNG;
        // the test is weakly probabilistic but informative — a buggy
        // wrapper that accidentally reused state would fail
        // deterministically here.
        let blob_a = encode_new_note(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            TEST_PLAINTEXT,
        )
        .expect("first call succeeds");
        let blob_b = encode_new_note(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            TEST_PLAINTEXT,
        )
        .expect("second call succeeds");
        assert_ne!(
            blob_a, blob_b,
            "two independent calls must yield different blobs"
        );
        // The byte-divergence MUST land beyond the deterministic
        // header bytes (magic + version + reserved + items_key_id are
        // identical across calls). Bytes 0..6 are call-invariant.
        assert_eq!(
            &blob_a[..OFFSET_ITEMS_KEY_ID],
            &blob_b[..OFFSET_ITEMS_KEY_ID]
        );
        assert_eq!(
            &blob_a[OFFSET_ITEMS_KEY_ID..OFFSET_ITEM_KEY_NONCE],
            &blob_b[OFFSET_ITEMS_KEY_ID..OFFSET_ITEM_KEY_NONCE],
        );
    }

    #[test]
    fn encode_new_note_rejects_oversized_plaintext_through_blob_raw_boundary() {
        // The convenience wrapper inherits the cap rejection from
        // `encode_new_note_blob_raw`. Call with cap+1 bytes; expect
        // PlaintextTooLarge. Allocation is test-time only.
        let plaintext = vec![0u8; MAX_PLAINTEXT_LEN + 1];
        let err = encode_new_note(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            &plaintext,
        )
        .expect_err("oversized plaintext must propagate through the wrapper");
        assert_eq!(err, ProtocolError::PlaintextTooLarge);
    }

    // ---- Task 8: update path -----------------------------------------

    /// Distinct content nonce for update tests so the rev1 → rev2
    /// transition is observable in the byte diff (rev1 used
    /// `TEST_CONTENT_NONCE = [0x20; 24]`).
    const TEST_CONTENT_NONCE_REV2: [u8; AEAD_NONCE_LEN] = [0x30; 24];
    const TEST_CONTENT_NONCE_REV3: [u8; AEAD_NONCE_LEN] = [0x40; 24];

    #[test]
    fn r02_round_trip_update_preserves_header_prefix_byte_byte() {
        // §6.3 invariant: bytes 0..47+N (HEADER_PREFIX_LEN = 112) are
        // byte-identical between rev1 and rev2. Encoder splices
        // `handle.header_prefix()` verbatim — never reconstructs.
        let blob_v1 = encode_with_test_fixture(TEST_PLAINTEXT);
        let handle = decode_with_test_fixture(&blob_v1);
        let blob_v2 = encode_update_blob_raw(&handle, &TEST_CONTENT_NONCE_REV2, b"updated body")
            .expect("update encodes cleanly");

        assert_eq!(
            &blob_v2[..HEADER_PREFIX_LEN],
            &blob_v1[..HEADER_PREFIX_LEN],
            "§6.3 byte-identical invariant must hold across rev1 → rev2",
        );
        // Tail differs: content_nonce, ciphertext_len, ciphertext.
        assert_ne!(
            &blob_v2[OFFSET_CONTENT_NONCE..OFFSET_CIPHERTEXT_LEN],
            &blob_v1[OFFSET_CONTENT_NONCE..OFFSET_CIPHERTEXT_LEN],
            "content_nonce must change across revisions",
        );
    }

    #[test]
    fn r02_round_trip_update_decodes_to_new_plaintext_under_same_keys() {
        // The updated blob decodes cleanly under the same
        // (items_key, items_key_id, note_uuid) — the wrap-key path is
        // unchanged because enc_item_key is byte-identical, so
        // decoding rev2 recovers the same item_key (and then decrypts
        // the new content under it).
        let blob_v1 = encode_with_test_fixture(TEST_PLAINTEXT);
        let handle_v1 = decode_with_test_fixture(&blob_v1);
        let blob_v2 = encode_update_blob_raw(&handle_v1, &TEST_CONTENT_NONCE_REV2, b"updated body")
            .expect("update encodes cleanly");
        let handle_v2 = decode_with_test_fixture(&blob_v2);

        assert_eq!(handle_v2.plaintext(), b"updated body");
        assert_eq!(handle_v2.items_key_id(), &TEST_ITEMS_KEY_ID);
        assert_eq!(handle_v2.note_uuid(), &TEST_NOTE_UUID);
        // The reused item_key is the same 32 bytes across revisions.
        assert_eq!(handle_v2.item_key(), handle_v1.item_key());
    }

    #[test]
    fn r05_three_revision_chain_preserves_prefix_invariant_at_each_step() {
        // Three-revision chain v1 → v2 → v3. The §6.3 prefix invariant
        // holds at every step against v1's prefix — `item_key` and
        // `enc_item_key` are persistent for the note's lifetime.
        let blob_v1 = encode_with_test_fixture(TEST_PLAINTEXT);
        let handle_v1 = decode_with_test_fixture(&blob_v1);
        let blob_v2 =
            encode_update_blob_raw(&handle_v1, &TEST_CONTENT_NONCE_REV2, b"second revision")
                .expect("v2 update");
        let handle_v2 = decode_with_test_fixture(&blob_v2);
        let blob_v3 =
            encode_update_blob_raw(&handle_v2, &TEST_CONTENT_NONCE_REV3, b"third revision")
                .expect("v3 update");

        assert_eq!(&blob_v2[..HEADER_PREFIX_LEN], &blob_v1[..HEADER_PREFIX_LEN]);
        assert_eq!(&blob_v3[..HEADER_PREFIX_LEN], &blob_v1[..HEADER_PREFIX_LEN]);

        // Each revision decodes to its expected plaintext.
        let handle_v3 = decode_with_test_fixture(&blob_v3);
        assert_eq!(handle_v3.plaintext(), b"third revision");
    }

    #[test]
    fn encode_update_blob_raw_rejects_oversized_plaintext() {
        let blob_v1 = encode_with_test_fixture(TEST_PLAINTEXT);
        let handle = decode_with_test_fixture(&blob_v1);
        let oversized = vec![0u8; MAX_PLAINTEXT_LEN + 1];
        let err = encode_update_blob_raw(&handle, &TEST_CONTENT_NONCE_REV2, &oversized)
            .expect_err("oversized update plaintext must reject");
        assert_eq!(err, ProtocolError::PlaintextTooLarge);
    }

    #[test]
    fn encode_update_consumes_handle_and_round_trips() {
        // Production caller surface — consumes handle (typestate "one
        // decode, one update"). Pulls content_nonce from getrandom
        // internally; round-trips through decode_note with the new
        // plaintext.
        let blob_v1 = encode_with_test_fixture(TEST_PLAINTEXT);
        let handle = decode_with_test_fixture(&blob_v1);
        let blob_v2 = encode_update(handle, b"updated via convenience wrapper")
            .expect("encode_update succeeds with the OS CSPRNG available");
        // After encode_update, the handle is consumed — the type
        // system structurally prevents reuse. (No second-use test
        // here because that would be a compile error, not a runtime
        // assertion.)
        assert_eq!(&blob_v2[..HEADER_PREFIX_LEN], &blob_v1[..HEADER_PREFIX_LEN]);
        let handle_v2 = decode_with_test_fixture(&blob_v2);
        assert_eq!(handle_v2.plaintext(), b"updated via convenience wrapper");
    }

    #[test]
    fn encode_update_two_calls_with_same_handle_clone_produce_different_blobs() {
        // Borrowing `_raw` form lets D6 vector tests permute
        // content_nonce over the same handle. Convenience `encode_update`
        // consumes — so to test "two consecutive updates produce
        // different content_nonces", we use the borrowing form
        // explicitly. Verifies that the encoder doesn't accidentally
        // pin content_nonce to handle state.
        let blob_v1 = encode_with_test_fixture(TEST_PLAINTEXT);
        let handle = decode_with_test_fixture(&blob_v1);
        let blob_a = encode_update_blob_raw(&handle, &TEST_CONTENT_NONCE_REV2, b"body").expect("a");
        let blob_b = encode_update_blob_raw(&handle, &TEST_CONTENT_NONCE_REV3, b"body").expect("b");
        // Different content_nonce → different ciphertext (deterministic
        // re-emission would reuse the same nonce; this test catches a
        // hypothetical bug where the encoder ignored the parameter).
        assert_ne!(blob_a, blob_b);
        assert_eq!(&blob_a[..HEADER_PREFIX_LEN], &blob_b[..HEADER_PREFIX_LEN]);
    }

    // ---- Task 11: edge cases (R04 + R06 + R07) ------------------------

    #[test]
    fn r04_round_trip_with_one_mib_plaintext() {
        // Realistic-mass exercise of the AEAD path. Use a deterministic
        // non-zero pattern (`i & 0xFF` byte sequence) so the test
        // catches a hypothetical encoder bug that special-cases
        // zero-filled buffers — e.g., a future optimization that
        // skipped XChaCha20 keystream XOR for all-zero plaintext.
        let plaintext: Vec<u8> = (0..(1024usize * 1024)).map(|i| (i & 0xFF) as u8).collect();
        let blob = encode_new_note(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            &plaintext,
        )
        .expect("1 MiB encode succeeds");
        let handle = decode_with_test_fixture(&blob);
        assert_eq!(handle.plaintext(), plaintext.as_slice());
    }

    #[test]
    fn r06_encode_new_note_blob_raw_is_deterministic_under_identical_inputs() {
        // D6 contract: cross-repo byte-level vector verification
        // depends on `encode_new_note_blob_raw` producing identical
        // output for identical inputs across runs and across
        // implementations. A future encoder refactor that introduces
        // any nondeterminism (e.g., padding, hash randomization, time
        // injection) would silently break the cross-repo replay loop;
        // this test catches it crate-internally before D6's CI
        // round-trip runs.
        let blob_a = encode_new_note_blob_raw(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            &TEST_ITEM_KEY,
            &TEST_ITEM_KEY_NONCE,
            &TEST_CONTENT_NONCE,
            TEST_PLAINTEXT,
        )
        .expect("first call");
        let blob_b = encode_new_note_blob_raw(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            &TEST_ITEM_KEY,
            &TEST_ITEM_KEY_NONCE,
            &TEST_CONTENT_NONCE,
            TEST_PLAINTEXT,
        )
        .expect("second call");
        assert_eq!(
            blob_a, blob_b,
            "identical _raw inputs must produce byte-identical output (D6 contract)",
        );
    }

    #[test]
    fn r07a_encode_new_note_convenience_accepts_plaintext_at_cap() {
        // Cap symmetry: convenience surface accepts MAX_PLAINTEXT_LEN
        // bytes. The `_raw` variant is covered by
        // `encode_new_note_blob_raw_accepts_plaintext_at_cap`.
        let plaintext = vec![0u8; MAX_PLAINTEXT_LEN];
        let blob = encode_new_note(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_NOTE_UUID,
            &plaintext,
        )
        .expect("convenience new at cap");
        assert_eq!(
            blob.len(),
            OFFSET_CIPHERTEXT + MAX_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN,
        );
    }

    #[test]
    fn r07a_encode_update_blob_raw_accepts_plaintext_at_cap() {
        // Cap symmetry across the update path: `_raw` form accepts
        // MAX bytes.
        let blob_v1 = encode_with_test_fixture(b"original short body");
        let handle = decode_with_test_fixture(&blob_v1);
        let plaintext = vec![0u8; MAX_PLAINTEXT_LEN];
        let blob_v2 = encode_update_blob_raw(&handle, &TEST_CONTENT_NONCE_REV2, &plaintext)
            .expect("_raw update at cap");
        assert_eq!(
            blob_v2.len(),
            OFFSET_CIPHERTEXT + MAX_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN,
        );
    }

    #[test]
    fn r07a_encode_update_convenience_accepts_plaintext_at_cap() {
        // Cap symmetry: convenience update consumes the handle and
        // accepts MAX bytes.
        let blob_v1 = encode_with_test_fixture(b"original short body");
        let handle = decode_with_test_fixture(&blob_v1);
        let plaintext = vec![0u8; MAX_PLAINTEXT_LEN];
        let blob_v2 = encode_update(handle, &plaintext).expect("convenience update at cap");
        assert_eq!(
            blob_v2.len(),
            OFFSET_CIPHERTEXT + MAX_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN,
        );
    }

    #[test]
    fn r07b_encode_update_convenience_rejects_plaintext_above_cap() {
        // Cap symmetry: the convenience consume-form of update also
        // rejects MAX+1 bytes. The `_raw` form is covered by
        // `encode_update_blob_raw_rejects_oversized_plaintext`; the
        // new-note paths are covered by Task 5/7 boundary tests. This
        // test completes the four-encoder-entry-point cap-symmetry
        // coverage.
        let blob_v1 = encode_with_test_fixture(b"original short body");
        let handle = decode_with_test_fixture(&blob_v1);
        let plaintext = vec![0u8; MAX_PLAINTEXT_LEN + 1];
        let err = encode_update(handle, &plaintext)
            .expect_err("convenience update must reject MAX+1 plaintext");
        assert_eq!(err, ProtocolError::PlaintextTooLarge);
    }

    // ---- Task 9 + 10: tampering matrix --------------------------------
    //
    // Tests organized per the PRD's `tampering::{parse,
    // items_key_id_mismatch, outer_aead, inner_aead}` module groupings.
    // Each test mutates a fresh fixture blob at one position (or
    // permutes a parameter) and asserts the specific `DecryptCause`
    // that fired. Distinguishability of the public surface is covered
    // by `decode_note_collapses_every_cause_to_cannot_decrypt`; here
    // the tests run against `decode_note_with_cause` so a defense-path
    // regression cannot pass undetected as "something rejected".

    mod tampering {
        use super::*;

        mod parse {
            use super::*;

            /// Helper: assert that a tampered blob rejects with
            /// `DecryptCause::Parse` and *only* `Parse`. A different
            /// cause means a different defense fired — most likely a
            /// regression in step ordering or a rule moved.
            fn assert_parse(blob: &[u8]) {
                let cause = decode_note_with_cause(
                    blob,
                    &TEST_NOTE_UUID,
                    &TEST_ITEMS_KEY,
                    &TEST_ITEMS_KEY_ID,
                )
                .expect_err("tampered blob must reject");
                assert_eq!(cause, DecryptCause::Parse, "expected Parse, got {cause:?}");
            }

            #[test]
            fn p01_magic_byte_flip_rejects_parse() {
                // §6.4 step 1: magic != "MY01" → Parse.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[0] = b'X';
                assert_parse(&blob);
            }

            #[test]
            fn p02_protocol_version_byte_flip_rejects_parse() {
                // §6.4 step 1: protocol_version != 0x01 → Parse.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[OFFSET_PROTOCOL_VERSION] = 0x02;
                assert_parse(&blob);
            }

            #[test]
            fn p03_reserved_byte_non_zero_rejects_parse() {
                // §6.4 step 1: reserved != 0x00 → Parse. Future v0.1.x
                // revisions could reuse this byte for flags, but
                // until then any non-zero is an immediate reject —
                // forward-incompatibility (§10.1).
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[OFFSET_RESERVED] = 0x01;
                assert_parse(&blob);
            }

            #[test]
            fn p04_enc_item_key_len_off_by_one_rejects_parse() {
                // §6.4 step 1: enc_item_key_len != 64 → Parse. v0.1
                // pins the constant; a future field-rewriter that
                // produced 0x0041 would be silently un-decryptable
                // under any v0.1 client.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                // 0x0040 → 0x0041 (low byte +1).
                blob[OFFSET_ENC_ITEM_KEY_LEN + 1] = 0x41;
                assert_parse(&blob);
            }

            #[test]
            fn p05_enc_item_key_len_zero_rejects_parse() {
                // §6.4 step 1 corner case: enc_item_key_len = 0 (both
                // bytes cleared) — the decoder must reject before
                // attempting to read a zero-length AEAD blob.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[OFFSET_ENC_ITEM_KEY_LEN] = 0x00;
                blob[OFFSET_ENC_ITEM_KEY_LEN + 1] = 0x00;
                assert_parse(&blob);
            }

            #[test]
            fn p06_truncated_header_rejects_parse() {
                // §6.4 step 1 implicit: blob too short to read the
                // fixed-position fields. Truncate before
                // OFFSET_CIPHERTEXT (140) — the decoder's first check
                // is the length guard, otherwise indexing would panic.
                let blob_full = encode_with_test_fixture(TEST_PLAINTEXT);
                let truncated = &blob_full[..100];
                assert_parse(truncated);
            }

            #[test]
            fn p07_ciphertext_len_below_ctx_tag_rejects_parse() {
                // §6.4 step 1 extension: ciphertext_len < 32 leaves
                // no room for the trailing CTX commitment tag (any
                // valid ciphertext is at least 32 bytes — empty
                // plaintext + 32-byte tag).
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
                    .copy_from_slice(&31u32.to_be_bytes());
                assert_parse(&blob);
            }

            #[test]
            fn p08_advertised_ciphertext_len_exceeds_remaining_bytes_rejects_parse() {
                // §6.4 step 1 length-equality: declared ciphertext_len
                // must match the remaining bytes. Setting the field
                // higher than the actual ciphertext region (without
                // extending the blob) → Parse.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                // Actual = 29 + 32 = 61. Set to 100 (within cap, but
                // exceeds remaining).
                blob[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
                    .copy_from_slice(&100u32.to_be_bytes());
                assert_parse(&blob);
            }

            #[test]
            fn p09_trailing_bytes_after_declared_ciphertext_len_rejects_parse() {
                // §10.1 strict-trailing: blob.len() != expected_total
                // → Parse. v0.1 has no extension points; trailing
                // bytes would expose a covert-channel surface for
                // next-major metadata to ride inside a v0.1 blob. Reject.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob.push(0xAB); // append one trailing byte
                assert_parse(&blob);
            }

            #[test]
            fn p10_ciphertext_len_above_cap_rejects_parse_before_allocation() {
                // §9.2 cap: ciphertext_len > MAX_PLAINTEXT_LEN + 32 →
                // Parse. The cap fires BEFORE the length-equality
                // check (step ordering in `decode_note_with_cause`),
                // so the decoder rejects without attempting any
                // allocation that scales with the advertised length.
                // Hostile-blob OOM/DoS defense.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                let oversized = (MAX_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN + 1) as u32;
                blob[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
                    .copy_from_slice(&oversized.to_be_bytes());
                assert_parse(&blob);
            }
        }

        mod items_key_id_mismatch {
            use super::*;

            /// `decode_note_with_cause` step 2 (§6.4): the embedded
            /// `items_key_id` must equal the caller's parameter (which
            /// the host reads from `vault.meta`). v0.1 has exactly one
            /// `itemsKey` per vault; a mismatch is either a foreign
            /// blob or vault-meta corruption.
            fn assert_mismatch(blob: &[u8], param_items_key_id: &[u8; ITEMS_KEY_ID_LEN]) {
                let cause = decode_note_with_cause(
                    blob,
                    &TEST_NOTE_UUID,
                    &TEST_ITEMS_KEY,
                    param_items_key_id,
                )
                .expect_err("mismatch must reject");
                assert_eq!(
                    cause,
                    DecryptCause::ItemsKeyIdMismatch,
                    "expected ItemsKeyIdMismatch, got {cause:?}",
                );
            }

            #[test]
            fn i01_blob_items_key_id_flipped_param_unchanged_rejects_mismatch() {
                // §6.4 step 2: blob carries id_evil, vault.meta still
                // says id_orig. Foreign-blob scenario.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[OFFSET_ITEMS_KEY_ID] ^= 0xFF; // flip a byte in the slab field
                assert_mismatch(&blob, &TEST_ITEMS_KEY_ID);
            }

            #[test]
            fn i02_param_items_key_id_flipped_blob_unchanged_rejects_mismatch() {
                // §6.4 step 2 symmetric: blob carries id_orig, host
                // passes id_evil (e.g., wrong vault.meta loaded).
                let blob = encode_with_test_fixture(TEST_PLAINTEXT);
                let mut evil_id = TEST_ITEMS_KEY_ID;
                evil_id[0] ^= 0xFF;
                assert_mismatch(&blob, &evil_id);
            }
        }

        mod outer_aead {
            use super::*;

            /// `decode_note_with_cause` step 3 (§6.4): the AEAD-unwrap
            /// of `enc_item_key` failed the CTX commitment check.
            fn assert_outer(
                blob: &[u8],
                note_uuid: &[u8; NOTE_UUID_LEN],
                items_key: &[u8; AEAD_KEY_LEN],
                items_key_id: &[u8; ITEMS_KEY_ID_LEN],
            ) {
                let cause = decode_note_with_cause(blob, note_uuid, items_key, items_key_id)
                    .expect_err("outer-AEAD tampering must reject");
                assert_eq!(
                    cause,
                    DecryptCause::OuterAead,
                    "expected OuterAead, got {cause:?}",
                );
            }

            #[test]
            fn o01_item_key_nonce_byte_flip_rejects_outer_aead() {
                // Tampering with item_key_nonce → CTX recomputation
                // diverges → OuterAead.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[OFFSET_ITEM_KEY_NONCE + 10] ^= 0xFF;
                assert_outer(&blob, &TEST_NOTE_UUID, &TEST_ITEMS_KEY, &TEST_ITEMS_KEY_ID);
            }

            #[test]
            fn o02_enc_item_key_body_byte_flip_rejects_outer_aead() {
                // Flip a byte in the 32-byte ciphertext region of
                // enc_item_key (offsets 48..80 from blob start).
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[OFFSET_ENC_ITEM_KEY + 5] ^= 0xFF;
                assert_outer(&blob, &TEST_NOTE_UUID, &TEST_ITEMS_KEY, &TEST_ITEMS_KEY_ID);
            }

            #[test]
            fn o03_enc_item_key_tag_region_byte_flip_rejects_outer_aead() {
                // enc_item_key = 32 B ct + 32 B CTX tag. Tag region is
                // offsets 80..112 from blob start (= OFFSET_ENC_ITEM_KEY
                // + 32 .. OFFSET_ENC_ITEM_KEY + 64). Flip in the tag
                // region directly hits the commitment.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[OFFSET_ENC_ITEM_KEY + AEAD_KEY_LEN + 15] ^= 0xFF;
                assert_outer(&blob, &TEST_NOTE_UUID, &TEST_ITEMS_KEY, &TEST_ITEMS_KEY_ID);
            }

            #[test]
            fn o04_cross_vault_wrong_items_key_rejects_outer_aead() {
                // §6.5 itemsKey-identity protection: blob from vault A
                // decoded with vault B's itemsKey (contrived
                // items_key_id collision via fixed test value).
                // Step 2 passes (id matches by test contrivance); step
                // 3 fails because the actual key differs.
                let blob = encode_with_test_fixture(TEST_PLAINTEXT);
                let foreign_items_key: [u8; AEAD_KEY_LEN] = [0x55; 32];
                assert_outer(
                    &blob,
                    &TEST_NOTE_UUID,
                    &foreign_items_key,
                    &TEST_ITEMS_KEY_ID,
                );
            }

            #[test]
            fn o05_cross_note_wrong_note_uuid_rejects_outer_aead() {
                // §6.5 note-identity protection: a `.myn` file renamed
                // to a different UUID without re-encrypting fails
                // verification — note_uuid is bound into AAD_wrap_item_key.
                let blob = encode_with_test_fixture(TEST_PLAINTEXT);
                let mut wrong_uuid = TEST_NOTE_UUID;
                wrong_uuid[0] ^= 0xFF;
                assert_outer(&blob, &wrong_uuid, &TEST_ITEMS_KEY, &TEST_ITEMS_KEY_ID);
            }

            #[test]
            fn o06_consistent_items_key_id_flip_rejects_outer_aead() {
                // §6.5 items_key_id binding survives consistent flip:
                // even when blob.items_key_id and the param are mutated
                // to the SAME new value (so step 2 passes), the AEAD
                // tag was bound to the original items_key_id at encrypt
                // time. AAD reconstruction with id_evil therefore
                // diverges from what the tag commits to → OuterAead.
                //
                // This is the test that PROVES the AAD binding —
                // without it, an attacker who controls both the blob
                // and the host's vault.meta could rebrand items_key_id
                // and the encoder/decoder pair would miss it. The CTX
                // commitment catches it.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                let mut evil_id = TEST_ITEMS_KEY_ID;
                evil_id[0] ^= 0xFF;
                evil_id[1] ^= 0xFF;
                blob[OFFSET_ITEMS_KEY_ID..OFFSET_ITEM_KEY_NONCE].copy_from_slice(&evil_id);
                assert_outer(&blob, &TEST_NOTE_UUID, &TEST_ITEMS_KEY, &evil_id);
            }
        }

        mod inner_aead {
            use super::*;

            /// `decode_note_with_cause` step 4 (§6.4): the inner
            /// content AEAD failed the CTX commitment check given a
            /// successful outer unwrap.
            fn assert_inner(blob: &[u8]) {
                let cause = decode_note_with_cause(
                    blob,
                    &TEST_NOTE_UUID,
                    &TEST_ITEMS_KEY,
                    &TEST_ITEMS_KEY_ID,
                )
                .expect_err("inner-AEAD tampering must reject");
                assert_eq!(
                    cause,
                    DecryptCause::InnerAead,
                    "expected InnerAead, got {cause:?}",
                );
            }

            #[test]
            fn n01_content_nonce_byte_flip_rejects_inner_aead() {
                // After a successful outer unwrap the decoder runs
                // step 4 with the recovered item_key. Tampered
                // content_nonce → CTX commitment check fails →
                // InnerAead.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[OFFSET_CONTENT_NONCE + 10] ^= 0xFF;
                assert_inner(&blob);
            }

            #[test]
            fn n02_ciphertext_body_byte_flip_rejects_inner_aead() {
                // Flip in the plaintext-bytes region of the ciphertext
                // (before the trailing CTX tag).
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                blob[OFFSET_CIPHERTEXT + 5] ^= 0xFF;
                assert_inner(&blob);
            }

            #[test]
            fn n03_ciphertext_tag_region_byte_flip_rejects_inner_aead() {
                // The trailing 32 bytes of the ciphertext region are
                // the CTX commitment tag. Flip 15 bytes from the end —
                // well within the tag region for any plaintext length.
                let mut blob = encode_with_test_fixture(TEST_PLAINTEXT);
                let last = blob.len();
                blob[last - 15] ^= 0xFF;
                assert_inner(&blob);
            }
        }
    }

    // ---- KAT vector regenerator (companion repo) ---------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/myn-blob/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_myn_blob_vectors.json`.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act.
    /// Run with:
    /// `cargo test -p protocol --lib emit_myn_blob_vectors_for_paste -- --ignored`
    ///
    /// 5 cases pin (per MYND-71 / D6):
    /// - 3 `encrypt` × {10-byte / 1-KB / 100-KB plaintext} — pin the
    ///   `MY01` byte output across realistic size ranges.
    /// - 1 `decrypt_ok` (1-KB plaintext round-trip) — proves the
    ///   decoder recovers the canonical plaintext bytes.
    /// - 1 `decrypt_aead_fail` — single-byte tamper inside the
    ///   ciphertext region; surfaces as `DecryptError::CannotDecrypt`
    ///   non-distinguishing per spec §6.4.
    ///
    /// Note: content_type is HARDCODED to `text/markdown` in
    /// `aad_note_content_encrypt`; there is no v0.1 parameter to vary,
    /// so the tasks.md "content-type framing variation" case is N/A
    /// and was replaced by the 5th decrypt-side case.
    ///
    /// Output file is ~250 KB due to the 100-KB plaintext vector's
    /// ~200-KB inlined hex string — git-friendly, `jq`-readable.
    #[test]
    #[ignore]
    fn emit_myn_blob_vectors_for_paste() {
        extern crate std;

        // Distinct byte patterns per field — easy visual cross-check.
        let items_key: [u8; AEAD_KEY_LEN] = [0xAA; AEAD_KEY_LEN];
        let items_key_id: [u8; ITEMS_KEY_ID_LEN] = [0xBB; ITEMS_KEY_ID_LEN];
        let note_uuid: [u8; NOTE_UUID_LEN] = [0xCC; NOTE_UUID_LEN];
        let item_key: [u8; AEAD_KEY_LEN] = [0xDD; AEAD_KEY_LEN];
        let item_key_nonce: [u8; AEAD_NONCE_LEN] = [0xEE; AEAD_NONCE_LEN];
        let content_nonce: [u8; AEAD_NONCE_LEN] = [0xFF; AEAD_NONCE_LEN];

        // Deterministic plaintexts.
        let plaintext_10b: alloc::vec::Vec<u8> = (*b"Hello,Myne").to_vec();
        let plaintext_1kb: alloc::vec::Vec<u8> = (0..1024u32).map(|i| (i % 256) as u8).collect();
        let plaintext_100kb: alloc::vec::Vec<u8> =
            (0..102400u32).map(|i| (i % 256) as u8).collect();

        let blob_10b = encode_new_note_blob_raw(
            &items_key,
            &items_key_id,
            &note_uuid,
            &item_key,
            &item_key_nonce,
            &content_nonce,
            &plaintext_10b,
        )
        .expect("encode 10B");
        let blob_1kb = encode_new_note_blob_raw(
            &items_key,
            &items_key_id,
            &note_uuid,
            &item_key,
            &item_key_nonce,
            &content_nonce,
            &plaintext_1kb,
        )
        .expect("encode 1KB");
        let blob_100kb = encode_new_note_blob_raw(
            &items_key,
            &items_key_id,
            &note_uuid,
            &item_key,
            &item_key_nonce,
            &content_nonce,
            &plaintext_100kb,
        )
        .expect("encode 100KB");

        // Round-trip sanity on the 1KB blob — guards against a future
        // encode/decode pair drift.
        let decoded = decode_note(&blob_1kb, &note_uuid, &items_key, &items_key_id)
            .expect("decode 1KB round-trip");
        assert_eq!(decoded.plaintext(), plaintext_1kb.as_slice());

        // Tampered blob: flip one byte inside the ciphertext region of
        // the 10B blob. OFFSET_CIPHERTEXT = HEADER_PREFIX_LEN + 24 + 4.
        let mut blob_tampered = blob_10b.clone();
        blob_tampered[OFFSET_CIPHERTEXT] ^= 0xFF;
        assert!(
            decode_note(&blob_tampered, &note_uuid, &items_key, &items_key_id).is_err(),
            "tampered blob must reject"
        );

        // ---- §6.3 update-path fixtures (encode_update_blob_raw) ----------
        // A 2-KB source blob for the shrink case (2 KB → 10 B). The 10-B
        // and 1-KB sources reuse blob_10b / blob_1kb above.
        let plaintext_2kb_src: alloc::vec::Vec<u8> =
            (0..2048u32).map(|i| (i % 256) as u8).collect();
        let blob_2kb = encode_new_note_blob_raw(
            &items_key,
            &items_key_id,
            &note_uuid,
            &item_key,
            &item_key_nonce,
            &content_nonce,
            &plaintext_2kb_src,
        )
        .expect("encode 2KB source");

        // Fresh content nonces for the update path — distinct from the
        // 0xFF create-time content_nonce so the re-randomization is visible
        // in the diff. enc_item_key / item_key_nonce / header are spliced
        // verbatim (§3.3); only content_nonce + ciphertext move.
        let update_nonce_same: [u8; AEAD_NONCE_LEN] = [0x11; AEAD_NONCE_LEN];
        let update_nonce_grow: [u8; AEAD_NONCE_LEN] = [0x12; AEAD_NONCE_LEN];
        let update_nonce_shrink: [u8; AEAD_NONCE_LEN] = [0x13; AEAD_NONCE_LEN];

        let update_plaintext_1kb: alloc::vec::Vec<u8> =
            (0..1024u32).map(|i| ((i * 3 + 1) % 256) as u8).collect();
        let update_plaintext_2kb: alloc::vec::Vec<u8> =
            (0..2048u32).map(|i| (i % 256) as u8).collect();
        let update_plaintext_10b: alloc::vec::Vec<u8> = (*b"Shrunk!Myn").to_vec();

        // Decode each source, then re-encode its content via the §6.3
        // update path. decode_note yields the DecryptedNote handle that
        // encode_update_blob_raw splices.
        let handle_same = decode_note(&blob_1kb, &note_uuid, &items_key, &items_key_id)
            .expect("decode 1KB source for update");
        let updated_same =
            encode_update_blob_raw(&handle_same, &update_nonce_same, &update_plaintext_1kb)
                .expect("update 1KB→1KB");

        let handle_grow = decode_note(&blob_10b, &note_uuid, &items_key, &items_key_id)
            .expect("decode 10B source for update");
        let updated_grow =
            encode_update_blob_raw(&handle_grow, &update_nonce_grow, &update_plaintext_2kb)
                .expect("update 10B→2KB");

        let handle_shrink = decode_note(&blob_2kb, &note_uuid, &items_key, &items_key_id)
            .expect("decode 2KB source for update");
        let updated_shrink =
            encode_update_blob_raw(&handle_shrink, &update_nonce_shrink, &update_plaintext_10b)
                .expect("update 2KB→10B");

        // Invariant the vectors pin: header_prefix (first 112 bytes:
        // magic||version||reserved||items_key_id||item_key_nonce||
        // enc_item_key_len||enc_item_key) is byte-identical across an
        // update — only content_nonce + ciphertext change (§3.3).
        assert_eq!(
            &updated_same[..HEADER_PREFIX_LEN],
            &blob_1kb[..HEADER_PREFIX_LEN],
            "update must splice header_prefix verbatim"
        );
        assert_eq!(
            &updated_grow[..HEADER_PREFIX_LEN],
            &blob_10b[..HEADER_PREFIX_LEN]
        );
        assert_eq!(
            &updated_shrink[..HEADER_PREFIX_LEN],
            &blob_2kb[..HEADER_PREFIX_LEN]
        );

        // Round-trip an updated blob to confirm it decodes to the new
        // plaintext (feeds the decrypt-ok-after-update case).
        let decoded_updated = decode_note(&updated_same, &note_uuid, &items_key, &items_key_id)
            .expect("decode updated 1KB blob");
        assert_eq!(decoded_updated.plaintext(), update_plaintext_1kb.as_slice());

        let items_key_hex = hex_lower(&items_key);
        let items_key_id_hex = hex_lower(&items_key_id);
        let note_uuid_hex = hex_lower(&note_uuid);
        let item_key_hex = hex_lower(&item_key);
        let item_key_nonce_hex = hex_lower(&item_key_nonce);
        let content_nonce_hex = hex_lower(&content_nonce);
        let update_nonce_same_hex = hex_lower(&update_nonce_same);
        let update_nonce_grow_hex = hex_lower(&update_nonce_grow);
        let update_nonce_shrink_hex = hex_lower(&update_nonce_shrink);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"myn-blob\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.2 + §6.3 + §6.4 + §6.5\",\n");
        dump.push_str("  \"description\": \"Pins protocol::encode_new_note_blob_raw + protocol::encode_update_blob_raw + protocol::decode_note byte mapping for the MY01 per-note blob format across realistic plaintext sizes (10 B / 1 KB / 100 KB), the §6.3 note-update path (header_prefix spliced verbatim; only content_nonce + ciphertext change), and the non-distinguishing AEAD-stage rejection surface. content_type is HARDCODED to 'text/markdown' in aad_note_content_encrypt — no v0.1 parameter to vary. Cases generated by `cargo test -p protocol --lib emit_myn_blob_vectors_for_paste -- --ignored` (in protocol/src/blob.rs). The 100-KB plaintext case is inlined as a ~200-KB hex string; cases.json total ≈ 250 KB — git-friendly, `jq`-readable.\",\n");
        dump.push_str("  \"cases\": [\n");

        // Helper closure for emitting an encrypt case.
        let emit_encrypt = |dump: &mut alloc::string::String,
                            slug: &str,
                            description: &str,
                            plaintext: &[u8],
                            blob: &[u8]| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"myn-blob/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"encrypt\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_items_key_hex\": \"{}\",\n",
                items_key_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_items_key_id_hex\": \"{}\",\n",
                items_key_id_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_note_uuid_hex\": \"{}\",\n",
                note_uuid_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_item_key_hex\": \"{}\",\n",
                item_key_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_item_key_nonce_hex\": \"{}\",\n",
                item_key_nonce_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_content_nonce_hex\": \"{}\",\n",
                content_nonce_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_plaintext_hex\": \"{}\",\n",
                hex_lower(plaintext)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_myn_blob_hex\": \"{}\"\n",
                hex_lower(blob)
            ));
        };

        // Helper closure for emitting a §6.3 update case. Inputs carry the
        // source blob + decode context; a port decodes it, re-encodes the
        // content under the new content_nonce, and compares byte-equal.
        let emit_update = |dump: &mut alloc::string::String,
                           slug: &str,
                           description: &str,
                           source_blob: &[u8],
                           new_content_nonce_hex: &str,
                           new_plaintext: &[u8],
                           expected_blob: &[u8]| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"myn-blob/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"encrypt_update\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_source_blob_hex\": \"{}\",\n",
                hex_lower(source_blob)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_note_uuid_hex\": \"{}\",\n",
                note_uuid_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_items_key_hex\": \"{}\",\n",
                items_key_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_items_key_id_hex\": \"{}\",\n",
                items_key_id_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_new_content_nonce_hex\": \"{}\",\n",
                new_content_nonce_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_new_plaintext_hex\": \"{}\",\n",
                hex_lower(new_plaintext)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_myn_blob_hex\": \"{}\",\n",
                hex_lower(expected_blob)
            ));
            dump.push_str("      \"informational_header_prefix_preserved\": true\n");
        };

        emit_encrypt(
            &mut dump,
            "encrypt-10-byte",
            "Encode a 10-byte plaintext `Hello,Myne` (ASCII). Smallest representative case — exercises the encoder's framing without significant ciphertext volume. Expected blob length = 76 (header_prefix + content_nonce + ciphertext_len) + 10 (plaintext) + 32 (CTX tag) = 118 bytes.",
            &plaintext_10b,
            &blob_10b,
        );
        dump.push_str("    },\n");

        emit_encrypt(
            &mut dump,
            "encrypt-1kb",
            "Encode a 1024-byte plaintext where byte i = (i mod 256). Mid-size case — proves the encoder handles a full XChaCha20 keystream block plus tail. Expected blob length = 76 + 1024 + 32 = 1132 bytes.",
            &plaintext_1kb,
            &blob_1kb,
        );
        dump.push_str("    },\n");

        emit_encrypt(
            &mut dump,
            "encrypt-100kb",
            "Encode a 102400-byte plaintext where byte i = (i mod 256). Near-realistic note size; proves the encoder remains correct at scale without the MAX_PLAINTEXT_LEN cap firing (cap is 16 MiB). Expected blob length = 76 + 102400 + 32 = 102508 bytes. The inlined hex string is ~205 KB — the largest single field in any landed cases.json.",
            &plaintext_100kb,
            &blob_100kb,
        );
        dump.push_str("    },\n");

        // decrypt_ok case (1KB round-trip)
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"myn-blob/v0.1/decrypt-ok-1kb\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the 1-KB blob from case 2 back to the same plaintext under the matching items_key + items_key_id + note_uuid. Proves the decoder's structural parse + outer-AEAD unwrap of item_key + inner-AEAD decrypt of ciphertext all reconstruct the canonical plaintext bytes.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_1kb)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            note_uuid_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            items_key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            items_key_id_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_hex\": \"{}\"\n",
            hex_lower(&plaintext_1kb)
        ));
        dump.push_str("    },\n");

        // decrypt_aead_fail case (tampered ciphertext)
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"myn-blob/v0.1/decrypt-tampered-ciphertext\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Take the 10-byte blob from case 1 and flip one byte at OFFSET_CIPHERTEXT (the first byte of the encrypted content region) via XOR 0xFF. Decoder MUST surface DecryptError::CannotDecrypt — the CTX commitment construction (SHA-256 over key||nonce||AAD-len||AAD||Poly1305-tag) catches the modification: the recomputed Poly1305 tag changes, the recomputed CTX commitment changes, the constant-time comparison fails. Ports MUST NOT distinguish 'tampered ciphertext' from 'wrong key' or 'wrong AAD'; all collapse to the single non-distinguishing variant per spec §6.4.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_tampered)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            note_uuid_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            items_key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            items_key_id_hex
        ));
        dump.push_str("      \"expected_kind\": \"aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"informational_tamper_description\": \"{}\"\n",
            json_escape(&alloc::format!(
                "byte {} (OFFSET_CIPHERTEXT, first byte of encrypted content) flipped via XOR 0xFF",
                OFFSET_CIPHERTEXT
            ))
        ));
        dump.push_str("    },\n");

        // ---- §6.3 update-path cases -------------------------------------
        emit_update(
            &mut dump,
            "update-1kb-from-1kb",
            "Update the 1-KB blob from case 2 (decode_note → encode_update_blob_raw) with 1024 fresh bytes (byte i = (i*3+1) mod 256) under a new content_nonce (0x11×24). Same plaintext size, so total length is unchanged (1132 bytes). The 112-byte header_prefix — magic, version, reserved, items_key_id, item_key_nonce, enc_item_key_len, enc_item_key — MUST be byte-identical to the source blob's; only content_nonce + ciphertext change. This is the §3.3 invariant that lets password rotation leave every .myn file untouched.",
            &blob_1kb,
            &update_nonce_same_hex,
            &update_plaintext_1kb,
            &updated_same,
        );
        dump.push_str("    },\n");

        emit_update(
            &mut dump,
            "update-grow-10b-to-2kb",
            "Update the 10-byte blob from case 1 (decode_note → encode_update_blob_raw) with 2048 bytes (byte i = i mod 256) under a new content_nonce (0x12×24). Plaintext grows 10 B → 2 KB, so ciphertext_len at offset [136..140] (BE-u32) and total length both grow while header_prefix [0..112] stays byte-identical. Proves the update encoder tracks a growing payload without disturbing the spliced header.",
            &blob_10b,
            &update_nonce_grow_hex,
            &update_plaintext_2kb,
            &updated_grow,
        );
        dump.push_str("    },\n");

        emit_update(
            &mut dump,
            "update-shrink-2kb-to-10b",
            "Update a 2-KB source blob (decode_note → encode_update_blob_raw) with the 10-byte plaintext `Shrunk!Myn` under a new content_nonce (0x13×24). Plaintext shrinks 2 KB → 10 B, so ciphertext_len at [136..140] and total length both shrink while header_prefix [0..112] stays byte-identical. Proves the update encoder tracks a shrinking payload — the mirror of the grow case.",
            &blob_2kb,
            &update_nonce_shrink_hex,
            &update_plaintext_10b,
            &updated_shrink,
        );
        dump.push_str("    },\n");

        // decrypt_ok after update (round-trip the updated 1KB blob)
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"myn-blob/v0.1/decrypt-ok-after-update-1kb\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the updated 1-KB blob produced by `update-1kb-from-1kb` back to its NEW plaintext (byte i = (i*3+1) mod 256). Proves the §6.3 update path produces a structurally valid, decodable MY01 blob: the spliced header_prefix still unwraps item_key under itemsKey, and the re-encrypted content decrypts under the same item_key with the new content_nonce.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&updated_same)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            note_uuid_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            items_key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            items_key_id_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_hex\": \"{}\"\n",
            hex_lower(&update_plaintext_1kb)
        ));
        dump.push_str("    }\n");

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_myn_blob_vectors.json", dump.as_bytes())
            .expect("write myn-blob vectors dump");
    }

    // ---- KAT vector APPEND generator: structural parse rejects --------

    /// Emits a JSON **array fragment** of 9 additional cases for
    /// `myne-test-vectors/vectors/myn-blob/v0.1/cases.json` at
    /// `/tmp/myne_myn_blob_parse_fail_vectors.json` (MYND-227), spliced by
    /// hand into the existing `cases` array. The original
    /// `emit_myn_blob_vectors_for_paste` stays byte-stable and is NOT
    /// re-run (vector_id immutability).
    ///
    /// Run with:
    /// `cargo test -p protocol --lib emit_myn_blob_parse_fail_vectors -- --ignored`
    ///
    /// 8 `parse_fail` cases — one per named structural check in
    /// `decode_note_with_cause` (§9.2 layout + §10.1 strict-trailing) —
    /// plus 1 `decrypt_aead_fail` items_key_id-mismatch case (§6.4 step 2,
    /// rides the existing schema branch). All nine collapse to the single
    /// non-distinguishing `DecryptError::CannotDecrypt`; ports MUST reject
    /// and MUST NOT reveal which rule fired (the internal `DecryptCause`
    /// is observability-only and never crosses IPC).
    ///
    /// The cases deliberately carry the REAL `items_key` (not a dummy):
    /// the header bytes are not bound into either AAD, so a port that
    /// skips a structural check decrypts the tampered blob successfully
    /// and returns Ok — which the runner catches. With a dummy key the
    /// same buggy port would return its AEAD error and pass silently.
    #[test]
    #[ignore]
    fn emit_myn_blob_parse_fail_vectors() {
        extern crate std;

        // Identical fixture to emit_myn_blob_vectors_for_paste; the base
        // blob equals the landed encrypt-1kb expected blob (NOT the 100-KB
        // case — keeps the appended hex ~2 KB per case).
        let items_key: [u8; AEAD_KEY_LEN] = [0xAA; AEAD_KEY_LEN];
        let items_key_id: [u8; ITEMS_KEY_ID_LEN] = [0xBB; ITEMS_KEY_ID_LEN];
        let note_uuid: [u8; NOTE_UUID_LEN] = [0xCC; NOTE_UUID_LEN];
        let item_key: [u8; AEAD_KEY_LEN] = [0xDD; AEAD_KEY_LEN];
        let item_key_nonce: [u8; AEAD_NONCE_LEN] = [0xEE; AEAD_NONCE_LEN];
        let content_nonce: [u8; AEAD_NONCE_LEN] = [0xFF; AEAD_NONCE_LEN];
        let plaintext_1kb: alloc::vec::Vec<u8> = (0..1024u32).map(|i| (i % 256) as u8).collect();

        let base = encode_new_note_blob_raw(
            &items_key,
            &items_key_id,
            &note_uuid,
            &item_key,
            &item_key_nonce,
            &content_nonce,
            &plaintext_1kb,
        )
        .expect("encode base");
        decode_note(&base, &note_uuid, &items_key, &items_key_id)
            .expect("base fixture must decode");

        let header_short: alloc::vec::Vec<u8> = MAGIC.to_vec();
        let mut magic_tamper = base.clone();
        magic_tamper[0] = b'X';
        let mut version_tamper = base.clone();
        version_tamper[OFFSET_PROTOCOL_VERSION] = 0x02;
        let mut reserved_tamper = base.clone();
        reserved_tamper[OFFSET_RESERVED] = 0x01;
        let mut key_len_tamper = base.clone();
        key_len_tamper[OFFSET_ENC_ITEM_KEY_LEN..OFFSET_ENC_ITEM_KEY]
            .copy_from_slice(&65u16.to_be_bytes());
        let mut len_below_tag = base.clone();
        len_below_tag[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
            .copy_from_slice(&31u32.to_be_bytes());
        let mut len_overflow = base.clone();
        len_overflow[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
            .copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());
        let mut trailing = base.clone();
        trailing.push(0x00);

        struct PfCase<'a> {
            slug: &'a str,
            description: &'a str,
            blob: &'a [u8],
            tamper: &'a str,
        }
        let parse_fails = [
            PfCase {
                slug: "parse-fail-header-too-short",
                description: "Only the 4-byte MY01 magic — shorter than the 140-byte fixed prefix (header + content_nonce + ciphertext_len). Rejected before any field read. Like every structural reject in this category it collapses to the single non-distinguishing CannotDecrypt; the per-case naming here documents WHICH check a conforming implementation must perform, not a distinguishable error surface.",
                blob: header_short.as_slice(),
                tamper: "blob is the 4 magic bytes only (4 < 140)",
            },
            PfCase {
                slug: "parse-fail-magic-mismatch",
                description: "First byte of the MY01 magic corrupted to 'X'. A foreign file, a different artifact type, or a forward-incompatible NT05 blob all fail here, before any decryption.",
                blob: magic_tamper.as_slice(),
                tamper: "byte 0 (magic[0]) 'M' → 'X'",
            },
            PfCase {
                slug: "parse-fail-protocol-version-mismatch",
                description: "protocol_version byte (offset 4) set to 0x02 instead of 0x01. A v0.1 decoder rejects an unknown protocol version before decrypting — cross-major reads happen only via explicit migration.",
                blob: version_tamper.as_slice(),
                tamper: "byte 4 (protocol_version) 0x01 → 0x02",
            },
            PfCase {
                slug: "parse-fail-reserved-nonzero",
                description: "reserved byte (offset 5) set to 0x01 instead of 0x00. Reserved bytes are flag carriers for future v0.1.x revisions; a v0.1.0 client cannot honor unknown flags so non-zero is an unconditional reject.",
                blob: reserved_tamper.as_slice(),
                tamper: "byte 5 (reserved) 0x00 → 0x01",
            },
            PfCase {
                slug: "parse-fail-enc-item-key-len",
                description: "enc_item_key_len field (offset 46..48) set to 65 instead of 64 (= 32-byte wrapped item_key + 32-byte CTX tag). v0.1 admits exactly one wrapped-key length; any other value is structural corruption.",
                blob: key_len_tamper.as_slice(),
                tamper: "bytes 46..48 (enc_item_key_len) 64 → 65",
            },
            PfCase {
                slug: "parse-fail-ciphertext-len-below-tag",
                description: "ciphertext_len field (offset 136..140) set to 31 — below the 32-byte CTX commitment tag, so the advertised ciphertext cannot even contain a tag. Rejected at the parse layer.",
                blob: len_below_tag.as_slice(),
                tamper: "bytes 136..140 (ciphertext_len) → 31 (< 32-byte CTX tag)",
            },
            PfCase {
                slug: "parse-fail-ciphertext-len-overflow",
                description: "ciphertext_len field (offset 136..140) set to 0xFFFFFFFF, far above MAX_PLAINTEXT_LEN + 32 (16 MiB + 32). A port MUST bound-check ciphertext_len before allocating or indexing — the cap is the DoS-allocation defense (§9.2).",
                blob: len_overflow.as_slice(),
                tamper: "bytes 136..140 (ciphertext_len) → 0xffffffff",
            },
            PfCase {
                slug: "parse-fail-trailing-byte",
                description: "One 0x00 byte appended after a fully valid blob. §10.1 strict-trailing: blob length MUST equal the declared layout exactly. The sharpest case in the family — a port that tolerantly ignores trailing bytes decodes this blob successfully and returns Ok, which the runner catches (the AEAD tags still verify; only the length discipline rejects it).",
                blob: trailing.as_slice(),
                tamper: "one 0x00 byte appended (blob length = declared layout + 1)",
            },
        ];

        let mut dump = alloc::string::String::new();
        dump.push_str("[\n");
        for case in &parse_fails {
            assert!(
                matches!(
                    decode_note(case.blob, &note_uuid, &items_key, &items_key_id),
                    Err(DecryptError::CannotDecrypt)
                ),
                "[{}] tampered blob must reject with CannotDecrypt",
                case.slug
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"myn-blob/v0.1/{}\",\n",
                case.slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(case.description)
            ));
            dump.push_str("      \"case_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex_lower(case.blob)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_note_uuid_hex\": \"{}\",\n",
                hex_lower(&note_uuid)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_items_key_hex\": \"{}\",\n",
                hex_lower(&items_key)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_items_key_id_hex\": \"{}\",\n",
                hex_lower(&items_key_id)
            ));
            dump.push_str("      \"expected_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"informational_tamper_description\": \"{}\"\n",
                json_escape(case.tamper)
            ));
            dump.push_str("    },\n");
        }

        // decrypt_aead_fail: intact blob, mismatched caller items_key_id
        // (§6.4 step 2 — the embedded id 0xBB×16 ≠ supplied 0xBD×16).
        let other_items_key_id: [u8; ITEMS_KEY_ID_LEN] = [0xBD; ITEMS_KEY_ID_LEN];
        assert!(
            matches!(
                decode_note(&base, &note_uuid, &items_key, &other_items_key_id),
                Err(DecryptError::CannotDecrypt)
            ),
            "items_key_id mismatch must reject with CannotDecrypt"
        );
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"myn-blob/v0.1/decrypt-items-key-id-mismatch\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape(
                "A fully intact 1-KB blob decoded with a MISMATCHED caller items_key_id (0xbd×16; the blob embeds 0xbb×16). §6.4 step 2: the decoder compares the embedded items_key_id against the caller's active one before any AEAD work and rejects with the same non-distinguishing CannotDecrypt. Pins that a port performs the comparison at all — skipping it would proceed to the outer unwrap and (with the right items_key, as here) decode successfully."
            )
        ));
        dump.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&base)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&items_key)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&other_items_key_id)
        ));
        dump.push_str("      \"expected_kind\": \"aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"informational_tamper_description\": \"{}\"\n",
            json_escape(
                "intact blob; caller items_key_id 0xbb×16 → 0xbd×16 (embedded id unchanged)"
            )
        ));
        dump.push_str("    }\n");

        dump.push_str("]\n");

        std::fs::write(
            "/tmp/myne_myn_blob_parse_fail_vectors.json",
            dump.as_bytes(),
        )
        .expect("write myn-blob parse_fail vectors dump");
    }
}
