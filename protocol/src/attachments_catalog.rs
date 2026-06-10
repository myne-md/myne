// SPDX-License-Identifier: AGPL-3.0-or-later
//! `vault.attachments` 34-byte-header encrypted attachments-catalog
//! codec (`MYC1` magic) — see `docs/spec/protocol.md` § 9.10.
//!
//! `vault.attachments` is a vault-level singleton artifact carrying the
//! authoritative per-attachment metadata (the backing store for the
//! attachments library). It lives next to `vault.meta` at
//! `<vault-root>/vault.attachments` and is AEAD-encrypted under
//! `attachments_catalog_key = DeriveSubkey(root_key,
//! SubkeyRole::AttachmentsCatalogKey)`.
//!
//! The metadata held here must **survive note deletion** (filename,
//! content type, size, creation time) so the library can display an
//! attachment even when no note references it (§ 9.10). The
//! note→attachment reference graph is NOT stored here — it is derived
//! from note bodies at runtime.
//!
//! ## On-disk layout (spec § 9.10.1)
//!
//! Identical in shape to `vault.prefs` (§ 9.5.1) / `vault.search`
//! (§ 9.6) with `MYC1` magic:
//!
//! ```text
//! Offset  Size  Field             Notes
//! ------  ----  ----------------  --------------------------------------
//! 0       4     magic             ASCII "MYC1"
//! 4       1     protocol_version  0x01
//! 5       1     reserved          0x00 (MUST)
//! 6       24    catalog_nonce     XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len    big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext        AEAD ciphertext + 32-byte CTX tag
//! ```
//!
//! ## Inner plaintext (spec § 9.10.2)
//!
//! Canonical JSON (per the § 9.5.2 discipline) — a top-level object
//! mapping each lowercase-hex `attachment-id` to a metadata object:
//!
//! ```text
//! {"<id-hex>":{"content_type":"image/png","created_at":1700000000,"filename":"a.png","size":12345}}
//! ```
//!
//! Canonical encoding rules (mirroring `prefs.rs`, load-bearing for
//! cross-implementation byte-stability):
//!
//! - Object keys lexicographically sorted by NFC bytes (top-level
//!   attachment-id keys; per-entry keys are the fixed canonical order
//!   `content_type` < `created_at` < `filename` < `size`).
//! - No insignificant whitespace.
//! - Integers as bare decimals (no leading zeros, no trailing `.0`);
//!   floating-point FORBIDDEN at the type level (`u64` fields only).
//! - UTF-8 NFC for string fields (`content_type`, `filename`).
//! - Empty catalog is the canonical JSON object `{}`.
//!
//! ## Read semantics (spec § 9.10.4)
//!
//! [`read_or_empty`] collapses **any** failure (absent / truncated /
//! magic-mismatch / AEAD-fail / inner-parse-fail) to the empty catalog
//! `{}`, matching the § 9.5.5 / § 6.4 non-distinguishing-error
//! discipline. The lower-level [`decode_attachments_catalog`] reports
//! honest errors for observability; the caller applies fall-back at the
//! boundary, or uses [`read_or_empty`] directly.

use crate::aead::{
    aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN,
};
use crate::aead::{AAD_PREFIX_V0_1, PROTOCOL_VERSION_V0_1};
use crate::error::ProtocolError;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use getrandom::getrandom;
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0 — ASCII `"MYC1"` (Myne Catalog v1).
/// § 10.3 magic-byte registry.
pub const CATALOG_BLOB_MAGIC: [u8; 4] = *b"MYC1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const CATALOG_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `reserved` byte at offset 5 — MUST be `0x00`.
pub const CATALOG_BLOB_RESERVED: u8 = 0x00;

/// Length of the 16-byte `account_number_hash` bound into
/// `AAD_attachments_catalog` (§ 9.10.3 + § 9.3 offset 6).
pub const CATALOG_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Length of the outer envelope's fixed-offset header (offsets 0..34).
/// Magic (4) + protocol_version (1) + reserved (1) + catalog_nonce (24)
/// + ciphertext_len (4) = 34 bytes. Identical shape to `vault.prefs`.
pub const CATALOG_BLOB_HEADER_LEN: usize = 34;

/// Maximum inner-plaintext length, inclusive. § 9.10.4 leaves the
/// ceiling implementation-defined, sized to the vault's attachment
/// count (~64 bytes of metadata per attachment). We pin a generous 16
/// MiB bound — at ~120 bytes per entry that admits ~140k attachments,
/// far beyond any realistic v0.1 vault, while still bounding the
/// parser's pre-AEAD allocation footprint (DoS-allocation defense,
/// parallel to `prefs.rs`).
pub const MAX_CATALOG_PLAINTEXT_LEN: usize = 16 * 1024 * 1024;

/// One attachment's authoritative metadata (spec § 9.10.2). The four
/// fields are emitted in fixed canonical (lexicographic) order:
/// `content_type` < `created_at` < `filename` < `size`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentMeta {
    /// Import-time MIME of the file (a hint; the `attachment://` handler
    /// re-sniffs at serve time and is the authority). NFC string.
    pub content_type: String,
    /// Creation timestamp — UNIX seconds (integer; no floats).
    pub created_at: u64,
    /// Display filename (NFC). Free-form; duplicates across attachments
    /// are permitted (the id is the key).
    pub filename: String,
    /// File size in bytes (integer; no floats).
    pub size: u64,
}

/// In-memory representation of the v0.1 `vault.attachments` plaintext:
/// a map from lowercase-hex attachment-id → [`AttachmentMeta`]. A
/// `BTreeMap` keeps the top-level keys in lexicographic order by
/// construction, which is exactly the canonical-JSON key ordering the
/// spec mandates — so canonical bytes are independent of caller
/// insertion order (the byte-stability property).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttachmentsCatalog {
    /// attachment-id (lowercase hex) → metadata.
    pub entries: BTreeMap<String, AttachmentMeta>,
}

impl AttachmentsCatalog {
    /// An empty catalog — encodes to the canonical JSON object `{}`.
    pub fn empty() -> Self {
        Self::default()
    }
}

/// Closed-enum failure surface for `vault.attachments` encode / decode.
/// Mirrors `prefs::PrefsBlobError`. The single `CannotDecrypt` variant
/// for AEAD failure follows the § 6.4 non-distinguishing rule.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum CatalogBlobError {
    /// Input shorter than [`CATALOG_BLOB_HEADER_LEN`] bytes.
    #[error("vault.attachments blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYC1`.
    #[error("vault.attachments blob magic mismatch (expected MYC1)")]
    MagicMismatch,
    /// `protocol_version` byte at offset 4 is not `0x01`.
    #[error("vault.attachments blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `reserved` byte at offset 5 is not `0x00`.
    #[error("vault.attachments blob reserved byte must be 0x00")]
    ReservedByteNonZero,
    /// `ciphertext_len` exceeds [`MAX_CATALOG_PLAINTEXT_LEN`] + 32.
    #[error("vault.attachments ciphertext_len exceeds cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `CATALOG_BLOB_HEADER_LEN + ciphertext_len`.
    #[error("vault.attachments blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failure — wrong key, wrong AAD (cross-vault),
    /// tampered ciphertext, or tampered CTX tag. § 6.4 non-distinguishing.
    #[error("vault.attachments AEAD verification failed")]
    CannotDecrypt,
    /// AEAD succeeded but the inner plaintext did not parse as the
    /// expected canonical JSON shape.
    #[error("vault.attachments inner plaintext failed to parse as canonical JSON")]
    PlaintextParseFailed,
    /// OS CSPRNG (`getrandom`) is unavailable on the encode path.
    #[error("OS CSPRNG unavailable for catalog nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for CatalogBlobError {
    fn from(e: ProtocolError) -> Self {
        // Exhaustive match (no wildcard) is drift-detecting: a new
        // ProtocolError variant forces a compile-fail here. Today only
        // `aead_seal_ctx`/`aead_open_ctx` are reachable, producing
        // `AeadFailure`.
        match e {
            ProtocolError::AeadFailure => CatalogBlobError::CannotDecrypt,
            ProtocolError::InvalidPassword
            | ProtocolError::PasswordTooShort
            | ProtocolError::KdfFailure
            | ProtocolError::InvalidVaultMeta
            | ProtocolError::AccountNumberInvalid
            | ProtocolError::Csprng
            | ProtocolError::PlaintextTooLarge => CatalogBlobError::CannotDecrypt,
        }
    }
}

// ---- AAD construction (§9.10.3 / §5.2) ----------------------------------

/// Role string for `AAD_attachments_catalog` (§ 5.2): 19 ASCII bytes.
const ROLE_STR_ATTACHMENTS_CATALOG: &[u8] = b"attachments-catalog";

/// Build `AAD_attachments_catalog` (§ 5.2 + § 9.10.3). Mirrors
/// `aad_prefs_blob` with the role string `"attachments-catalog"`
/// (length-prefixed UTF-8: 2-byte BE length = 19 + 19 bytes) and the
/// 16-byte `account_number_hash` binding the catalog to its vault.
///
/// Layout (10 + 1 + 2 + 19 + 16 = 48 bytes):
///
/// ```text
/// "myne.v0.1|"                          10 bytes  (AAD prefix, § 5.2)
/// 0x01                                   1 byte   (protocol_version, § 9.3)
/// u16_be(19) || "attachments-catalog"   21 bytes  (length-prefixed role)
/// account_number_hash                   16 bytes  (vault identity, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity —
/// the catalog KEK derives directly from `root_key`, independent of the
/// `itemsKey` lineage (§ 9.10.3).
pub fn aad_attachments_catalog(
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_ATTACHMENTS_CATALOG.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    aad.extend_from_slice(&(ROLE_STR_ATTACHMENTS_CATALOG.len() as u16).to_be_bytes());
    aad.extend_from_slice(ROLE_STR_ATTACHMENTS_CATALOG);
    aad.extend_from_slice(account_number_hash);
    aad
}

// ---- canonical JSON encoder / decoder -----------------------------------
//
// Hand-rolled, mirroring `prefs.rs`'s discipline (no serde_json main
// dependency; canonical rules enforced by construction). The top-level
// map keys are attachment-id hex strings sorted lexicographically (the
// BTreeMap iteration order); each entry emits its four keys in the
// fixed canonical order content_type < created_at < filename < size.

/// Encode an [`AttachmentsCatalog`] to canonical JSON bytes (§ 9.10.2).
/// Empty catalog → `{}`.
fn canonical_json_encode(catalog: &AttachmentsCatalog) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + catalog.entries.len() * 96);
    out.push(b'{');
    for (i, (id, meta)) in catalog.entries.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        // Key: the attachment-id (lowercase hex). NFC is a no-op for
        // ASCII hex, but apply it for discipline parity.
        push_json_string(&mut out, &id.nfc().collect::<String>());
        out.extend_from_slice(b":{\"content_type\":");
        push_json_string(&mut out, &meta.content_type.nfc().collect::<String>());
        out.extend_from_slice(b",\"created_at\":");
        push_json_uint(&mut out, meta.created_at);
        out.extend_from_slice(b",\"filename\":");
        push_json_string(&mut out, &meta.filename.nfc().collect::<String>());
        out.extend_from_slice(b",\"size\":");
        push_json_uint(&mut out, meta.size);
        out.push(b'}');
    }
    out.push(b'}');
    out
}

/// Append `s` as a JSON string literal (with surrounding quotes),
/// escaping `"`, `\`, and C0 control chars per RFC 8259. `/` left
/// unescaped (canonical). Identical to `prefs.rs`'s helper.
fn push_json_string(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    for ch in s.chars() {
        match ch {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{08}' => out.extend_from_slice(b"\\b"),
            '\u{0c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => {
                let code = c as u32;
                out.extend_from_slice(b"\\u00");
                out.push(hex_nibble((code >> 4) as u8));
                out.push(hex_nibble((code & 0xF) as u8));
            }
            c => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

fn hex_nibble(n: u8) -> u8 {
    match n {
        0..=9 => b'0' + n,
        _ => b'a' + (n - 10),
    }
}

/// Append `n` as a canonical decimal integer (no leading zeros, no
/// trailing `.0` — § 9.5.2 / § 9.10.2). `n == 0` emits `"0"`.
fn push_json_uint(out: &mut Vec<u8>, n: u64) {
    let mut buf = [0u8; 20]; // u64::MAX is 20 digits.
    let mut i = buf.len();
    let mut v = n;
    loop {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    out.extend_from_slice(&buf[i..]);
}

/// Parse the v0.1 canonical-JSON `vault.attachments` plaintext into an
/// [`AttachmentsCatalog`].
///
/// A strict recursive-descent parser over the canonical shape: a
/// top-level object of `"<id>": { ... }` entries. Because the decoder
/// runs only AFTER AEAD verification, malformed input is self-inflicted
/// by the `attachments_catalog_key` holder and collapses to a parse
/// error (the caller falls back to empty). Forward-compat: unknown keys
/// inside an entry object are tolerated and ignored (additive optional
/// fields, § 9.10.2 / § 10.6).
fn canonical_json_decode(plaintext: &[u8]) -> Result<AttachmentsCatalog, CatalogBlobError> {
    let mut p = Parser {
        bytes: plaintext,
        pos: 0,
    };
    let catalog = p
        .parse_catalog()
        .ok_or(CatalogBlobError::PlaintextParseFailed)?;
    // Strict-trailing: nothing may follow the closing brace.
    if p.pos != plaintext.len() {
        return Err(CatalogBlobError::PlaintextParseFailed);
    }
    Ok(catalog)
}

/// Minimal byte-cursor parser for the canonical catalog JSON. No
/// whitespace tolerance — the input is canonical (no insignificant
/// whitespace), so any space is a malformation.
struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn eat(&mut self, b: u8) -> Option<()> {
        if self.peek() == Some(b) {
            self.pos += 1;
            Some(())
        } else {
            None
        }
    }

    /// Top-level: `{` (entry (`,` entry)*)? `}`.
    fn parse_catalog(&mut self) -> Option<AttachmentsCatalog> {
        self.eat(b'{')?;
        let mut entries: BTreeMap<String, AttachmentMeta> = BTreeMap::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Some(AttachmentsCatalog { entries });
        }
        loop {
            let (id, meta) = self.parse_entry()?;
            // Reject duplicate keys — canonical JSON has unique keys, and
            // a BTreeMap would silently overwrite (data-integrity bug on
            // tampered-but-AEAD-OK input).
            if entries.insert(id, meta).is_some() {
                return None;
            }
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Some(AttachmentsCatalog { entries });
                }
                _ => return None,
            }
        }
    }

    /// One entry: `"<id>"` `:` `{ "content_type":..., ... }`.
    fn parse_entry(&mut self) -> Option<(String, AttachmentMeta)> {
        let id = self.parse_string()?;
        self.eat(b':')?;
        let meta = self.parse_meta_object()?;
        Some((id, meta))
    }

    /// A metadata object. The canonical encoder emits exactly four keys
    /// in the order content_type < created_at < filename < size, but the
    /// parser accepts them tolerantly (any order, unknown keys ignored)
    /// to honor the forward-compat additive-field rule (§ 9.10.2). All
    /// four known fields are REQUIRED.
    fn parse_meta_object(&mut self) -> Option<AttachmentMeta> {
        self.eat(b'{')?;
        let mut content_type: Option<String> = None;
        let mut created_at: Option<u64> = None;
        let mut filename: Option<String> = None;
        let mut size: Option<u64> = None;

        if self.peek() == Some(b'}') {
            self.pos += 1;
            // Empty object cannot satisfy the required-fields contract.
            return None;
        }
        loop {
            let key = self.parse_string()?;
            self.eat(b':')?;
            match key.as_str() {
                "content_type" => content_type = Some(self.parse_string()?),
                "created_at" => created_at = Some(self.parse_uint()?),
                "filename" => filename = Some(self.parse_string()?),
                "size" => size = Some(self.parse_uint()?),
                // Unknown (future additive) field — skip its value.
                _ => self.skip_value()?,
            }
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                _ => return None,
            }
        }
        Some(AttachmentMeta {
            content_type: content_type?,
            created_at: created_at?,
            filename: filename?,
            size: size?,
        })
    }

    /// Parse a JSON string literal at the cursor. Returns the decoded
    /// `String`; advances the cursor past the closing `"`.
    fn parse_string(&mut self) -> Option<String> {
        self.eat(b'"')?;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let b = *self.bytes.get(self.pos)?;
            self.pos += 1;
            match b {
                b'"' => return String::from_utf8(buf).ok(),
                b'\\' => {
                    let e = *self.bytes.get(self.pos)?;
                    self.pos += 1;
                    match e {
                        b'"' => buf.push(b'"'),
                        b'\\' => buf.push(b'\\'),
                        b'/' => buf.push(b'/'),
                        b'b' => buf.push(0x08),
                        b'f' => buf.push(0x0c),
                        b'n' => buf.push(b'\n'),
                        b'r' => buf.push(b'\r'),
                        b't' => buf.push(b'\t'),
                        b'u' => {
                            let h = self.bytes.get(self.pos..self.pos + 4)?;
                            let cp = parse_hex4(h)?;
                            let ch = char::from_u32(cp)?;
                            let mut cb = [0u8; 4];
                            buf.extend_from_slice(ch.encode_utf8(&mut cb).as_bytes());
                            self.pos += 4;
                        }
                        _ => return None,
                    }
                }
                _ => buf.push(b),
            }
        }
    }

    /// Parse a canonical decimal integer (run of ASCII digits) into a
    /// `u64`. Consumes ONLY digit bytes — a fractional literal like
    /// `1.5` parses `1` and leaves `.` for the caller's terminator check
    /// to reject, enforcing the float ban (§ 9.10.2). Rejects an empty
    /// run, a leading-zero multi-digit number, and overflow.
    fn parse_uint(&mut self) -> Option<u64> {
        let start = self.pos;
        let mut val: u64 = 0;
        while let Some(b) = self.peek() {
            if !b.is_ascii_digit() {
                break;
            }
            val = val.checked_mul(10)?.checked_add((b - b'0') as u64)?;
            self.pos += 1;
        }
        let consumed = self.pos - start;
        if consumed == 0 {
            return None;
        }
        // Reject leading zeros on a multi-digit number (canonical form
        // has no leading zeros — `01` is non-canonical).
        if consumed > 1 && self.bytes[start] == b'0' {
            return None;
        }
        Some(val)
    }

    /// Skip a JSON value (for unknown forward-compat keys). Supports the
    /// value kinds that could appear in a future additive field: string,
    /// integer, `true`/`false`/`null`, and one level of nested
    /// object/array (recursively).
    fn skip_value(&mut self) -> Option<()> {
        match self.peek()? {
            b'"' => {
                self.parse_string()?;
                Some(())
            }
            b'{' => {
                self.pos += 1;
                if self.peek() == Some(b'}') {
                    self.pos += 1;
                    return Some(());
                }
                loop {
                    self.parse_string()?;
                    self.eat(b':')?;
                    self.skip_value()?;
                    match self.peek() {
                        Some(b',') => self.pos += 1,
                        Some(b'}') => {
                            self.pos += 1;
                            return Some(());
                        }
                        _ => return None,
                    }
                }
            }
            b'[' => {
                self.pos += 1;
                if self.peek() == Some(b']') {
                    self.pos += 1;
                    return Some(());
                }
                loop {
                    self.skip_value()?;
                    match self.peek() {
                        Some(b',') => self.pos += 1,
                        Some(b']') => {
                            self.pos += 1;
                            return Some(());
                        }
                        _ => return None,
                    }
                }
            }
            b't' => {
                self.bytes
                    .get(self.pos..self.pos + 4)
                    .filter(|s| *s == b"true")?;
                self.pos += 4;
                Some(())
            }
            b'f' => {
                self.bytes
                    .get(self.pos..self.pos + 5)
                    .filter(|s| *s == b"false")?;
                self.pos += 5;
                Some(())
            }
            b'n' => {
                self.bytes
                    .get(self.pos..self.pos + 4)
                    .filter(|s| *s == b"null")?;
                self.pos += 4;
                Some(())
            }
            b if b.is_ascii_digit() => {
                self.parse_uint()?;
                Some(())
            }
            _ => None,
        }
    }
}

/// Parse exactly 4 hex digits into a `u32` code point.
fn parse_hex4(h: &[u8]) -> Option<u32> {
    if h.len() != 4 {
        return None;
    }
    let mut v = 0u32;
    for &b in h {
        let d = match b {
            b'0'..=b'9' => (b - b'0') as u32,
            b'a'..=b'f' => (b - b'a' + 10) as u32,
            b'A'..=b'F' => (b - b'A' + 10) as u32,
            _ => return None,
        };
        v = v * 16 + d;
    }
    Some(v)
}

// ---- encode / decode primitives -----------------------------------------

/// Encode a `vault.attachments` blob with caller-supplied randomness
/// (`_raw` per the crate randomness-injection convention). Returns the
/// 34-byte header followed by `ciphertext || T'` (§ 9.10.1).
///
/// `_raw` callers source `catalog_nonce` from a CSPRNG-grade source —
/// nonce reuse under the same `attachments_catalog_key` is catastrophic.
/// Production callers SHOULD use [`encode_attachments_catalog`].
pub fn encode_attachments_catalog_raw(
    catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
    catalog: &AttachmentsCatalog,
    catalog_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, CatalogBlobError> {
    let plaintext = canonical_json_encode(catalog);

    if plaintext.len() > MAX_CATALOG_PLAINTEXT_LEN {
        return Err(CatalogBlobError::CiphertextLenOverflow);
    }

    let aad = aad_attachments_catalog(account_number_hash);
    let sealed = aead_seal_ctx(catalog_key, catalog_nonce, &plaintext, &aad)?;

    let ciphertext_len = sealed.len();
    debug_assert_eq!(ciphertext_len, plaintext.len() + CTX_COMMITMENT_TAG_LEN);

    let mut out = Vec::with_capacity(CATALOG_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&CATALOG_BLOB_MAGIC);
    out.push(CATALOG_BLOB_PROTOCOL_VERSION);
    out.push(CATALOG_BLOB_RESERVED);
    out.extend_from_slice(catalog_nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a `vault.attachments` blob, pulling the 24-byte nonce from the
/// OS CSPRNG. Production caller surface for § 9.10.
pub fn encode_attachments_catalog(
    catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
    catalog: &AttachmentsCatalog,
) -> Result<Vec<u8>, CatalogBlobError> {
    let mut catalog_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut catalog_nonce).map_err(|_| CatalogBlobError::RandomnessUnavailable)?;
    let result =
        encode_attachments_catalog_raw(catalog_key, account_number_hash, catalog, &catalog_nonce);
    catalog_nonce.zeroize();
    result
}

/// Decode a `vault.attachments` blob into an [`AttachmentsCatalog`].
/// Failure modes reported as distinct `CatalogBlobError` variants for
/// observability; the caller (or [`read_or_empty`]) collapses them to
/// the empty catalog per § 9.10.4.
pub fn decode_attachments_catalog(
    catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<AttachmentsCatalog, CatalogBlobError> {
    if blob.len() < CATALOG_BLOB_HEADER_LEN {
        return Err(CatalogBlobError::HeaderTooShort);
    }
    if blob[0..4] != CATALOG_BLOB_MAGIC {
        return Err(CatalogBlobError::MagicMismatch);
    }
    if blob[4] != CATALOG_BLOB_PROTOCOL_VERSION {
        return Err(CatalogBlobError::ProtocolVersionMismatch);
    }
    if blob[5] != CATALOG_BLOB_RESERVED {
        return Err(CatalogBlobError::ReservedByteNonZero);
    }

    let mut catalog_nonce = [0u8; AEAD_NONCE_LEN];
    catalog_nonce.copy_from_slice(&blob[6..30]);

    let ciphertext_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;

    if ciphertext_len > MAX_CATALOG_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(CatalogBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = CATALOG_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(CatalogBlobError::CiphertextTruncated);
    }

    let aad = aad_attachments_catalog(account_number_hash);
    let plaintext: Zeroizing<Vec<u8>> = aead_open_ctx(
        catalog_key,
        &catalog_nonce,
        &blob[CATALOG_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;

    canonical_json_decode(&plaintext)
}

/// Read-or-empty semantic (§ 9.10.4). Collapse **any** decode failure —
/// magic-mismatch, truncation, AEAD-fail, parse-fail, or an absent file
/// (modeled here as an empty/`None` blob) — to the empty catalog `{}`.
///
/// Pass `None` (or a slice via `Some`) for the on-disk bytes; the file
/// I/O happens in the Tauri layer, so this crate-level helper takes the
/// already-read bytes. A `None` models the absent-file case.
pub fn read_or_empty(
    catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
    blob: Option<&[u8]>,
) -> AttachmentsCatalog {
    match blob {
        Some(bytes) => decode_attachments_catalog(catalog_key, account_number_hash, bytes)
            .unwrap_or_else(|_| AttachmentsCatalog::empty()),
        None => AttachmentsCatalog::empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subkey::{derive_subkey, SubkeyRole};
    use alloc::string::ToString;

    fn fixed_root_key() -> [u8; 32] {
        [0x42; 32]
    }
    fn fixed_account_hash() -> [u8; CATALOG_BLOB_ACCOUNT_HASH_LEN] {
        [0x33; CATALOG_BLOB_ACCOUNT_HASH_LEN]
    }
    fn fixed_nonce() -> [u8; AEAD_NONCE_LEN] {
        [0x77; AEAD_NONCE_LEN]
    }
    fn catalog_key() -> Zeroizing<[u8; 32]> {
        derive_subkey(&fixed_root_key(), SubkeyRole::AttachmentsCatalogKey)
    }

    fn sample_catalog() -> AttachmentsCatalog {
        let mut entries = BTreeMap::new();
        entries.insert(
            "aa11".to_string(),
            AttachmentMeta {
                content_type: "image/png".to_string(),
                created_at: 1_700_000_000,
                filename: "photo.png".to_string(),
                size: 12345,
            },
        );
        entries.insert(
            "bb22".to_string(),
            AttachmentMeta {
                content_type: "application/pdf".to_string(),
                created_at: 1_700_000_500,
                filename: "doc.pdf".to_string(),
                size: 98765,
            },
        );
        AttachmentsCatalog { entries }
    }

    // ---- canonical JSON ----

    #[test]
    fn empty_catalog_encodes_to_empty_object() {
        let encoded = canonical_json_encode(&AttachmentsCatalog::empty());
        assert_eq!(encoded.as_slice(), b"{}");
    }

    #[test]
    fn canonical_json_has_no_whitespace_and_canonical_key_order() {
        let encoded = canonical_json_encode(&sample_catalog());
        assert!(!encoded.contains(&b' '));
        assert!(!encoded.contains(&b'\n'));
        // Per-entry key order: content_type < created_at < filename < size.
        let s = String::from_utf8(encoded).unwrap();
        let ct = s.find("content_type").unwrap();
        let ca = s.find("created_at").unwrap();
        let fnm = s.find("filename").unwrap();
        let sz = s.find("size").unwrap();
        assert!(ct < ca && ca < fnm && fnm < sz);
        // Top-level keys lexicographically sorted: aa11 before bb22.
        assert!(s.find("aa11").unwrap() < s.find("bb22").unwrap());
    }

    #[test]
    fn canonical_json_is_byte_stable_regardless_of_insertion_order() {
        // Spec § 9.10.2 byte-stability: the BTreeMap normalizes key
        // order, so two catalogs with the same logical content but
        // different insertion order produce identical bytes.
        let mut a = BTreeMap::new();
        a.insert(
            "ff".to_string(),
            AttachmentMeta {
                content_type: "t".to_string(),
                created_at: 1,
                filename: "f".to_string(),
                size: 2,
            },
        );
        a.insert(
            "00".to_string(),
            AttachmentMeta {
                content_type: "t".to_string(),
                created_at: 3,
                filename: "g".to_string(),
                size: 4,
            },
        );
        let mut b = BTreeMap::new();
        b.insert(
            "00".to_string(),
            AttachmentMeta {
                content_type: "t".to_string(),
                created_at: 3,
                filename: "g".to_string(),
                size: 4,
            },
        );
        b.insert(
            "ff".to_string(),
            AttachmentMeta {
                content_type: "t".to_string(),
                created_at: 1,
                filename: "f".to_string(),
                size: 2,
            },
        );
        assert_eq!(
            canonical_json_encode(&AttachmentsCatalog { entries: a }),
            canonical_json_encode(&AttachmentsCatalog { entries: b }),
        );
    }

    #[test]
    fn canonical_json_round_trips_through_decode() {
        let catalog = sample_catalog();
        let bytes = canonical_json_encode(&catalog);
        let decoded = canonical_json_decode(&bytes).expect("decode");
        assert_eq!(decoded, catalog);
    }

    #[test]
    fn decode_rejects_leading_zero_integer() {
        // Non-canonical integer (leading zero) must reject.
        let bad = br#"{"aa":{"content_type":"t","created_at":01,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_float() {
        let bad = br#"{"aa":{"content_type":"t","created_at":1,"filename":"f","size":2.5}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_tolerates_unknown_additive_field() {
        // Forward-compat (§ 9.10.2): an unknown key inside an entry is
        // skipped, not rejected.
        let fwd = br#"{"aa":{"content_type":"t","created_at":1,"filename":"f","future_flag":true,"size":2}}"#;
        let decoded = canonical_json_decode(fwd).expect("forward-compat decode");
        assert_eq!(decoded.entries.len(), 1);
        assert_eq!(decoded.entries["aa"].size, 2);
    }

    #[test]
    fn decode_rejects_missing_required_field() {
        let bad = br#"{"aa":{"content_type":"t","created_at":1,"filename":"f"}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_trailing_bytes() {
        let bad = br#"{}x"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    // ---- envelope round-trip ----

    #[test]
    fn encode_decode_round_trip() {
        let key = catalog_key();
        let catalog = sample_catalog();
        let blob =
            encode_attachments_catalog_raw(&key, &fixed_account_hash(), &catalog, &fixed_nonce())
                .expect("encode");
        assert_eq!(&blob[0..4], &CATALOG_BLOB_MAGIC);
        assert_eq!(blob[4], CATALOG_BLOB_PROTOCOL_VERSION);
        assert_eq!(blob[5], CATALOG_BLOB_RESERVED);
        let decoded =
            decode_attachments_catalog(&key, &fixed_account_hash(), &blob).expect("decode");
        assert_eq!(decoded, catalog);
    }

    #[test]
    fn encode_decode_round_trip_empty() {
        let key = catalog_key();
        let blob = encode_attachments_catalog_raw(
            &key,
            &fixed_account_hash(),
            &AttachmentsCatalog::empty(),
            &fixed_nonce(),
        )
        .expect("encode empty");
        let decoded =
            decode_attachments_catalog(&key, &fixed_account_hash(), &blob).expect("decode");
        assert_eq!(decoded, AttachmentsCatalog::empty());
    }

    // ---- cross-vault / tamper ----

    #[test]
    fn decode_fails_with_wrong_key() {
        let key = catalog_key();
        let blob = encode_attachments_catalog_raw(
            &key,
            &fixed_account_hash(),
            &sample_catalog(),
            &fixed_nonce(),
        )
        .expect("encode");
        let wrong = derive_subkey(&[0x99; 32], SubkeyRole::AttachmentsCatalogKey);
        assert_eq!(
            decode_attachments_catalog(&wrong, &fixed_account_hash(), &blob),
            Err(CatalogBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn decode_fails_cross_vault_account_hash() {
        let key = catalog_key();
        let blob = encode_attachments_catalog_raw(
            &key,
            &fixed_account_hash(),
            &sample_catalog(),
            &fixed_nonce(),
        )
        .expect("encode");
        let mut other_hash = fixed_account_hash();
        other_hash[0] ^= 0x01;
        assert_eq!(
            decode_attachments_catalog(&key, &other_hash, &blob),
            Err(CatalogBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn decode_fails_tampered_ciphertext() {
        let key = catalog_key();
        let mut blob = encode_attachments_catalog_raw(
            &key,
            &fixed_account_hash(),
            &sample_catalog(),
            &fixed_nonce(),
        )
        .expect("encode");
        let last = blob.len() - 40;
        blob[last] ^= 0x01;
        assert_eq!(
            decode_attachments_catalog(&key, &fixed_account_hash(), &blob),
            Err(CatalogBlobError::CannotDecrypt)
        );
    }

    // ---- read_or_empty (§9.10.4) ----

    #[test]
    fn read_or_empty_on_absent_file() {
        let key = catalog_key();
        assert_eq!(
            read_or_empty(&key, &fixed_account_hash(), None),
            AttachmentsCatalog::empty()
        );
    }

    #[test]
    fn read_or_empty_on_tampered_blob() {
        let key = catalog_key();
        let mut blob = encode_attachments_catalog_raw(
            &key,
            &fixed_account_hash(),
            &sample_catalog(),
            &fixed_nonce(),
        )
        .expect("encode");
        blob[CATALOG_BLOB_HEADER_LEN] ^= 0xFF;
        assert_eq!(
            read_or_empty(&key, &fixed_account_hash(), Some(&blob)),
            AttachmentsCatalog::empty()
        );
    }

    #[test]
    fn read_or_empty_on_magic_mismatch() {
        let key = catalog_key();
        assert_eq!(
            read_or_empty(
                &key,
                &fixed_account_hash(),
                Some(b"not a catalog blob at all")
            ),
            AttachmentsCatalog::empty()
        );
    }

    #[test]
    fn read_or_empty_round_trips_valid_blob() {
        let key = catalog_key();
        let catalog = sample_catalog();
        let blob =
            encode_attachments_catalog_raw(&key, &fixed_account_hash(), &catalog, &fixed_nonce())
                .expect("encode");
        assert_eq!(
            read_or_empty(&key, &fixed_account_hash(), Some(&blob)),
            catalog
        );
    }

    // ---- AAD pin ----

    #[test]
    fn aad_attachments_catalog_layout() {
        let aad = aad_attachments_catalog(&fixed_account_hash());
        // 10 + 1 + 2 + 19 + 16 = 48.
        assert_eq!(aad.len(), 48);
        assert_eq!(&aad[0..10], b"myne.v0.1|");
        assert_eq!(aad[10], 0x01);
        assert_eq!(&aad[11..13], &[0x00, 0x13]); // u16 BE 19
        assert_eq!(&aad[13..32], b"attachments-catalog");
        assert_eq!(&aad[32..48], &fixed_account_hash());
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits `myne-test-vectors/vectors/attachments-catalog/v0.1/cases.json`
    /// to `/tmp/myne_attachments_catalog_vectors.json`. `#[ignore]` — run
    /// with:
    /// `cargo test -p protocol --lib emit_attachments_catalog_vectors_for_paste -- --ignored`
    ///
    /// Cases (case_kind): `encrypt` (MYC1 byte output over canonical
    /// JSON, incl. empty `{}`), `decrypt_ok` (round-trip),
    /// `decrypt_aead_fail` (cross-vault + tamper, non-distinguishing),
    /// `aad_construction` (`aad_attachments_catalog` canonical bytes).
    #[test]
    #[ignore]
    fn emit_attachments_catalog_vectors_for_paste() {
        extern crate std;

        fn hex_lower(bytes: &[u8]) -> String {
            let mut s = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }

        let root_key: [u8; 32] = [0x42; 32];
        let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
        let account_hash: [u8; CATALOG_BLOB_ACCOUNT_HASH_LEN] =
            [0x33; CATALOG_BLOB_ACCOUNT_HASH_LEN];
        let other_account_hash: [u8; CATALOG_BLOB_ACCOUNT_HASH_LEN] =
            [0x34; CATALOG_BLOB_ACCOUNT_HASH_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];

        let empty = AttachmentsCatalog::empty();
        let populated = sample_catalog();

        let pt_empty = canonical_json_encode(&empty);
        let pt_populated = canonical_json_encode(&populated);

        let blob_empty =
            encode_attachments_catalog_raw(&catalog_key, &account_hash, &empty, &nonce)
                .expect("encode empty");
        let blob_populated =
            encode_attachments_catalog_raw(&catalog_key, &account_hash, &populated, &nonce)
                .expect("encode populated");

        // round-trip sanity
        let dec = decode_attachments_catalog(&catalog_key, &account_hash, &blob_populated)
            .expect("decode round-trip");
        assert_eq!(dec, populated);

        // tamper
        let mut blob_tamper = blob_populated.clone();
        let last = blob_tamper.len() - 1;
        blob_tamper[last] ^= 0xFF;

        let aad = aad_attachments_catalog(&account_hash);

        // Forward-compat tolerance case (§ 9.10.2): seal a plaintext carrying
        // an unknown additive per-entry field (`future_flag`, in sorted
        // position between `filename` and `size` — the cursor-based decoder
        // expects additive fields at their lexicographic position). The typed
        // encoder can only emit canonical v0.1 plaintexts, so assemble the
        // blob manually (assembly mirrors `encode_attachments_catalog_raw`).
        let nonce_tolerance: [u8; AEAD_NONCE_LEN] = [0x88; AEAD_NONCE_LEN];
        let pt_future: &[u8] = br#"{"aa11":{"content_type":"image/png","created_at":1700000000,"filename":"photo.png","future_flag":true,"size":12345}}"#;
        let sealed_future =
            aead_seal_ctx(&catalog_key, &nonce_tolerance, pt_future, &aad).expect("seal future");
        let mut blob_tolerance = Vec::with_capacity(CATALOG_BLOB_HEADER_LEN + sealed_future.len());
        blob_tolerance.extend_from_slice(&CATALOG_BLOB_MAGIC);
        blob_tolerance.push(CATALOG_BLOB_PROTOCOL_VERSION);
        blob_tolerance.push(CATALOG_BLOB_RESERVED);
        blob_tolerance.extend_from_slice(&nonce_tolerance);
        blob_tolerance.extend_from_slice(&(sealed_future.len() as u32).to_be_bytes());
        blob_tolerance.extend_from_slice(&sealed_future);
        // Self-validate: decode drops the unknown field and recovers the
        // known entry; the canonical re-encode of the decoded catalog is the
        // expected plaintext (NOT the sealed bytes).
        let dec_tolerance =
            decode_attachments_catalog(&catalog_key, &account_hash, &blob_tolerance)
                .expect("decode tolerance");
        assert_eq!(dec_tolerance.entries.len(), 1);
        assert_eq!(
            dec_tolerance.entries.get("aa11"),
            Some(&AttachmentMeta {
                content_type: "image/png".to_string(),
                created_at: 1_700_000_000,
                filename: "photo.png".to_string(),
                size: 12345,
            }),
        );
        let pt_tolerance_expected = canonical_json_encode(&dec_tolerance);

        let mut d = String::new();
        d.push_str("{\n");
        d.push_str("  \"schema\": \"attachments-catalog\",\n");
        d.push_str("  \"protocol_version\": \"v0.1\",\n");
        d.push_str("  \"spec_section\": \"protocol.md §9.10 + §5.2 + §3.4\",\n");
        d.push_str("  \"description\": \"Pins protocol::encode_attachments_catalog_raw + decode_attachments_catalog (MYC1) + aad_attachments_catalog. Inner plaintext is canonical JSON: object mapping lowercase-hex attachment-id -> {content_type,created_at,filename,size} with keys in lexicographic order; empty catalog = {}. KEK = DeriveSubkey(root,'attachments-catalog-key'). Reference impl: protocol/src/attachments_catalog.rs.\",\n");
        d.push_str("  \"cases\": [\n");

        // encrypt empty
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachments-catalog/v0.1/encrypt-empty\",\n");
        d.push_str("      \"description\": \"Empty catalog encodes inner plaintext {} then a MYC1 blob.\",\n");
        d.push_str("      \"case_kind\": \"encrypt\",\n");
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash)
        ));
        d.push_str(&alloc::format!(
            "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&pt_empty)
        ));
        d.push_str(&alloc::format!(
            "      \"input_catalog_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce)
        ));
        d.push_str(&alloc::format!(
            "      \"informational_catalog_key_hex\": \"{}\",\n",
            hex_lower(catalog_key.as_slice())
        ));
        d.push_str(&alloc::format!(
            "      \"expected_catalog_blob_hex\": \"{}\"\n",
            hex_lower(&blob_empty)
        ));
        d.push_str("    },\n");

        // encrypt populated
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachments-catalog/v0.1/encrypt-populated\",\n");
        d.push_str("      \"description\": \"Two-entry catalog; pins canonical-JSON key ordering (id keys sorted; per-entry content_type<created_at<filename<size) and full MYC1 byte output.\",\n");
        d.push_str("      \"case_kind\": \"encrypt\",\n");
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash)
        ));
        d.push_str(&alloc::format!(
            "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&pt_populated)
        ));
        d.push_str(&alloc::format!(
            "      \"input_catalog_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce)
        ));
        d.push_str(&alloc::format!(
            "      \"informational_catalog_key_hex\": \"{}\",\n",
            hex_lower(catalog_key.as_slice())
        ));
        d.push_str(&alloc::format!(
            "      \"expected_catalog_blob_hex\": \"{}\"\n",
            hex_lower(&blob_populated)
        ));
        d.push_str("    },\n");

        // decrypt_ok
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachments-catalog/v0.1/decrypt-ok\",\n");
        d.push_str("      \"description\": \"Decode the populated MYC1 blob back to canonical-JSON plaintext.\",\n");
        d.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        d.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_populated)
        ));
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash)
        ));
        d.push_str(&alloc::format!(
            "      \"expected_plaintext_canonical_utf8_hex\": \"{}\"\n",
            hex_lower(&pt_populated)
        ));
        d.push_str("    },\n");

        // decrypt_aead_fail (tamper)
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachments-catalog/v0.1/decrypt-fail-tamper\",\n");
        d.push_str("      \"description\": \"Tampered CTX tag byte → non-distinguishing AEAD failure; under read_or_empty semantics the caller falls back to {}.\",\n");
        d.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        d.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_tamper)
        ));
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash)
        ));
        d.push_str("      \"expected_kind\": \"aead_fail\"\n");
        d.push_str("    },\n");

        // decrypt_aead_fail (cross-vault account hash)
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachments-catalog/v0.1/decrypt-fail-cross-vault\",\n");
        d.push_str("      \"description\": \"Valid blob, wrong account_number_hash (cross-vault AAD bind) → non-distinguishing AEAD failure.\",\n");
        d.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        d.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_populated)
        ));
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&other_account_hash)
        ));
        d.push_str("      \"expected_kind\": \"aead_fail\"\n");
        d.push_str("    },\n");

        // aad_construction
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachments-catalog/v0.1/aad-construction\",\n");
        d.push_str("      \"description\": \"AAD_attachments_catalog canonical bytes: prefix || 0x01 || u16_be(19)||'attachments-catalog' || account_number_hash(16). 48 bytes total.\",\n");
        d.push_str("      \"case_kind\": \"aad_construction\",\n");
        d.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash)
        ));
        d.push_str(&alloc::format!(
            "      \"expected_aad_hex\": \"{}\"\n",
            hex_lower(&aad)
        ));
        d.push_str("    },\n");

        // decrypt_ok (forward-compat tolerance, § 9.10.2)
        d.push_str("    {\n");
        d.push_str(
            "      \"vector_id\": \"attachments-catalog/v0.1/decrypt-unknown-field-tolerated\",\n",
        );
        d.push_str("      \"description\": \"Forward-compat (§9.10.2): the sealed plaintext carries an unknown additive per-entry field (future_flag, in sorted position filename<future_flag<size); decoders must ignore it and recover the known fields. expected_plaintext_canonical_utf8_hex is the canonical re-encode of the decoded catalog (without the unknown field), NOT the sealed bytes; informational_sealed_plaintext_utf8_hex carries the sealed plaintext verbatim.\",\n");
        d.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        d.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_tolerance)
        ));
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash)
        ));
        d.push_str(&alloc::format!(
            "      \"informational_sealed_plaintext_utf8_hex\": \"{}\",\n",
            hex_lower(pt_future)
        ));
        d.push_str(&alloc::format!(
            "      \"expected_plaintext_canonical_utf8_hex\": \"{}\"\n",
            hex_lower(&pt_tolerance_expected)
        ));
        d.push_str("    }\n");

        d.push_str("  ]\n");
        d.push_str("}\n");

        std::fs::write("/tmp/myne_attachments_catalog_vectors.json", d.as_bytes())
            .expect("write attachments-catalog vectors dump");
    }
}
