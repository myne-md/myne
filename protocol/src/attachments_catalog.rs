// SPDX-License-Identifier: AGPL-3.0
//! `vault.attachments` 34-byte-header encrypted attachments-catalog
//! codec (`MYC1` magic) — see `agent-tooling/docs/spec/protocol.md` § 9.10.
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
//!   `content_type` < `created_at` < `deleted_at` (optional) <
//!   `filename` < `size` < `updated_at` (optional) — the two optional
//!   Phase-2-sync fields, § 9.10.2 / MYND-468, are emitted only when
//!   present, so a catalog without them is byte-identical to a
//!   pre-sync encode).
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
    aad_singleton_blob_v0_2, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
use crate::aead::{AAD_PREFIX_V0_1, PROTOCOL_VERSION_V0_1};
use crate::error::ProtocolError;
use crate::types::MetaVersion;
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

/// Magic bytes for the migrated v0.2 attachments catalog — ASCII `"MYC5"`
/// (§10.3 registry). Same hand-rolled framing as `MYC1`; v0.2 differs only in
/// the magic + the v0.2 AAD prefix + the `derive_subkey_v0_2` KEK.
pub const CATALOG_BLOB_V0_2_MAGIC: [u8; 4] = *b"MYC5";

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

/// Where an attachment belongs (myne-md/myne#913).
///
/// **One field, two places a file can live.** The vault has one attachment
/// store and one catalog; this says which SURFACE a row belongs to, not where
/// its bytes are. A library attachment is the ordinary case: it is listed, it
/// can be embedded in any note, and the cleanup dialog can offer it. A chat
/// attachment was pasted into one conversation and is reachable only from
/// there: still encrypted, still in `vault.attachments`, still synced and
/// backed up, and deliberately absent from the library listing so a file the
/// user dropped into a question does not turn up beside the ones they curated.
///
/// **`Library` is the default and is never written.** The field is emitted only
/// for `Chat`, so every existing catalog, and every ordinary import, encodes
/// byte-identically to the pre-#913 shape. An older reader drops the unknown key
/// (§9.10.2's additive-field rule) and lists the file in its library, which is
/// the safe direction: the file is still theirs, still encrypted, and still
/// deletable, and a reader that cannot see the marker is a reader that never
/// created one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub enum AttachmentScope {
    /// The vault's attachment library: listed, and embeddable from any note.
    #[default]
    Library,
    /// Owned by one chat conversation. Stored and synced like any other
    /// attachment; not listed in the library.
    ///
    /// `Ord` is load-bearing rather than incidental: the catalog merge breaks an
    /// equal-`version` tie with a total order over retained fields, and a field
    /// left out of that order turns arrival order into the tie-breaker. `Chat`
    /// sorts ABOVE `Library` so two peers that disagree converge on the
    /// conversation's claim rather than losing a file's placement to whichever
    /// argument came first.
    Chat,
}

impl AttachmentScope {
    /// The canonical JSON token. `Library` has none on purpose: it is the
    /// absent value.
    pub const fn wire_token(self) -> Option<&'static str> {
        match self {
            Self::Library => None,
            Self::Chat => Some("chat"),
        }
    }
}

/// One attachment's authoritative metadata (spec § 9.10.2). Fields are
/// emitted in fixed canonical (lexicographic) order: `content_type` <
/// `created_at` < `deleted_at` (when present) < `filename` < `scope` (when
/// `chat`) < `size` < `updated_at` (when present) < `version` (when non-zero).
/// This comment listed `scope` LAST while the encoder emitted it between
/// `filename` and `size`, which is the slot §9.10.2 pins and the one a port
/// reads; the comment was a second, wrong answer to the only question the
/// ordering exists to settle. The `Option` fields plus `version` are the
/// additive Phase-2-sync fields (MYND-468 + myne-md/myne#405); all
/// absent/zero = pre-sync shape, byte-identical to the original four-field
/// encode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentMeta {
    /// Import-time MIME of the file (a hint; the `attachment://` handler
    /// re-sniffs at serve time and is the authority). NFC string.
    pub content_type: String,
    /// Creation timestamp — UNIX seconds (integer; no floats).
    pub created_at: u64,
    /// Deletion timestamp — UNIX seconds, **optional** (§ 9.10.2 /
    /// `sync-protocol.md` § 11.4). Presence turns the entry into an
    /// **attachment catalog tombstone**: the multi-device deletion
    /// marker. A tombstone's descriptive metadata is scrubbed at delete
    /// time (see [`AttachmentMeta::into_tombstone`]).
    pub deleted_at: Option<u64>,
    /// Display filename (NFC). Free-form; duplicates across attachments
    /// are permitted (the id is the key). Empty on a tombstone.
    pub filename: String,
    /// File size in bytes (integer; no floats). Zero on a tombstone.
    pub size: u64,
    /// Filename-LWW discriminator for the sync merge — UNIX seconds,
    /// **optional** (set on rename; absent means `created_at`;
    /// `sync-protocol.md` § 11.4 rule 4). Now only a tie-break under
    /// `version`. Single-device semantics ignore it.
    pub updated_at: Option<u64>,
    /// Causal merge counter — the **primary key** of the sync merge join
    /// (`sync-protocol.md` § 11.4, myne-md/myne#405). Bumped to
    /// `max(versions observed for this id) + 1` on any local mutation; the
    /// greater `version` wins a reconcile, and the wall-clock fields only
    /// break an equal-`version` tie. Absent on a legacy blob → 0; an additive
    /// field emitted only when non-zero, so a pre-#405 entry stays
    /// byte-identical. Declared last to keep canonical key order.
    pub version: u64,
    /// Where this attachment belongs (myne-md/myne#913). Declared last for the
    /// same reason `version` is, and emitted only for `Chat`, so a library entry
    /// stays byte-identical to the pre-#913 encode.
    pub scope: AttachmentScope,
}

impl AttachmentMeta {
    /// A live (non-tombstone) entry with no rename history — the
    /// pre-sync four-field shape. Encodes byte-identically to a
    /// pre-MYND-468 entry.
    pub fn live(content_type: String, created_at: u64, filename: String, size: u64) -> Self {
        Self {
            content_type,
            created_at,
            deleted_at: None,
            filename,
            size,
            updated_at: None,
            version: 0,
            scope: AttachmentScope::Library,
        }
    }

    /// The same entry, placed in a chat conversation instead of the library
    /// (myne-md/myne#913).
    pub fn in_chat(mut self) -> Self {
        self.scope = AttachmentScope::Chat;
        self
    }

    /// Whether this entry is an attachment catalog tombstone
    /// (`sync-protocol.md` § 11.4).
    pub fn is_tombstone(&self) -> bool {
        self.deleted_at.is_some()
    }

    /// Convert this entry into its deletion tombstone: `deleted_at` set,
    /// descriptive metadata **scrubbed** (`filename`/`content_type`
    /// emptied, `size` zeroed, `updated_at` dropped) so the synced
    /// catalog keeps nothing descriptive about a crypto-erased file
    /// (§ 9.10.2). `created_at` is retained (required field); `version` is
    /// bumped (`self.version + 1`) because a delete is a mutation — the
    /// tombstone must outrank the live entry it replaces so a peer's stale
    /// live copy loses the merge (`sync-protocol.md` § 11.4, myne-md/myne#405).
    pub fn into_tombstone(self, deleted_at: u64) -> Self {
        Self {
            content_type: String::new(),
            created_at: self.created_at,
            deleted_at: Some(deleted_at),
            filename: String::new(),
            size: 0,
            updated_at: None,
            version: self.version + 1,
            // Scrubbed with the rest: a tombstone describes nothing, and a
            // surviving `chat` marker would say a conversation still owns a file
            // that has been erased.
            scope: AttachmentScope::Library,
        }
    }
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
        if let Some(deleted_at) = meta.deleted_at {
            out.extend_from_slice(b",\"deleted_at\":");
            push_json_uint(&mut out, deleted_at);
        }
        out.extend_from_slice(b",\"filename\":");
        push_json_string(&mut out, &meta.filename.nfc().collect::<String>());
        // Between `filename` and `size`, which is where the canonical order puts
        // "scope"; emitted only for `chat`, so the library shape is unchanged.
        if let Some(token) = meta.scope.wire_token() {
            out.extend_from_slice(b",\"scope\":");
            push_json_string(&mut out, token);
        }
        out.extend_from_slice(b",\"size\":");
        push_json_uint(&mut out, meta.size);
        if let Some(updated_at) = meta.updated_at {
            out.extend_from_slice(b",\"updated_at\":");
            push_json_uint(&mut out, updated_at);
        }
        if meta.version != 0 {
            out.extend_from_slice(b",\"version\":");
            push_json_uint(&mut out, meta.version);
        }
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

    /// A metadata object. The canonical encoder emits the keys in the
    /// order content_type < created_at < deleted_at? < filename < size <
    /// updated_at?, but the parser accepts them tolerantly (any order,
    /// unknown keys ignored) to honor the forward-compat additive-field
    /// rule (§ 9.10.2). The four original fields are REQUIRED;
    /// `deleted_at` / `updated_at` are the optional Phase-2-sync fields
    /// (MYND-468).
    fn parse_meta_object(&mut self) -> Option<AttachmentMeta> {
        self.eat(b'{')?;
        let mut content_type: Option<String> = None;
        let mut created_at: Option<u64> = None;
        let mut deleted_at: Option<u64> = None;
        let mut filename: Option<String> = None;
        let mut size: Option<u64> = None;
        let mut updated_at: Option<u64> = None;
        let mut version: u64 = 0;
        let mut scope = AttachmentScope::Library;

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
                "deleted_at" => deleted_at = Some(self.parse_uint()?),
                "filename" => filename = Some(self.parse_string()?),
                "size" => size = Some(self.parse_uint()?),
                "updated_at" => updated_at = Some(self.parse_uint()?),
                "version" => version = self.parse_uint()?,
                // An unknown scope value is TOLERATED as `Library` rather than
                // failing the file: an additive field a later version invents
                // must not cost this reader the whole catalog. The cost is that
                // a future scope would list its rows in the library here, which
                // is the same trade §9.10.2's additive-field rule makes
                // everywhere else and the safe direction for a file the user
                // still owns.
                "scope" => {
                    // **Tolerance covers the VALUE, not only the strings this
                    // version knows** (myne-md/myne#913, review round three): a
                    // later version may spell the field as a number or an
                    // object, and §9.10.2 says a value this implementation does
                    // not know reads as the library rather than failing the
                    // catalog. Only a string can name a scope here, so anything
                    // else is skipped and the row stays in the library.
                    if self.peek() == Some(b'"') {
                        scope = if self.parse_string()? == "chat" {
                            AttachmentScope::Chat
                        } else {
                            AttachmentScope::Library
                        };
                    } else {
                        self.skip_value()?;
                    }
                }
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
            deleted_at,
            filename: filename?,
            size: size?,
            updated_at,
            version,
            scope,
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
    let version = if blob.get(0..4) == Some(CATALOG_BLOB_V0_2_MAGIC.as_slice()) {
        MetaVersion::V0_2
    } else if blob.get(0..4) == Some(CATALOG_BLOB_MAGIC.as_slice()) {
        MetaVersion::V0_1
    } else {
        if blob.len() < CATALOG_BLOB_HEADER_LEN {
            return Err(CatalogBlobError::HeaderTooShort);
        }
        return Err(CatalogBlobError::MagicMismatch);
    };
    decode_attachments_catalog_versioned(version, catalog_key, account_number_hash, blob)
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

/// Pick the (magic, AAD) pair for `version`: `MYC1` + [`aad_attachments_catalog`]
/// for v0.1, `MYC5` + the v0.2-prefixed AAD for v0.2. The `protocol_version`
/// header byte stays `0x01` in both.
fn catalog_family_for(
    version: MetaVersion,
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
) -> ([u8; 4], Vec<u8>) {
    match version {
        MetaVersion::V0_1 => (
            CATALOG_BLOB_MAGIC,
            aad_attachments_catalog(account_number_hash),
        ),
        MetaVersion::V0_2 => (
            CATALOG_BLOB_V0_2_MAGIC,
            aad_singleton_blob_v0_2(ROLE_STR_ATTACHMENTS_CATALOG, account_number_hash),
        ),
    }
}

/// Version-aware seal of the attachments catalog, pulling the nonce from the OS
/// CSPRNG. v0.1 writes `MYC1` + `aad_attachments_catalog`; v0.2 writes `MYC5` +
/// the v0.2 AAD. The `catalog_key` MUST be derived under the same generation.
pub fn encode_attachments_catalog_versioned(
    version: MetaVersion,
    catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
    catalog: &AttachmentsCatalog,
) -> Result<Vec<u8>, CatalogBlobError> {
    let (magic, aad) = catalog_family_for(version, account_number_hash);
    let plaintext = canonical_json_encode(catalog);
    if plaintext.len() > MAX_CATALOG_PLAINTEXT_LEN {
        return Err(CatalogBlobError::CiphertextLenOverflow);
    }

    let mut catalog_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut catalog_nonce).map_err(|_| CatalogBlobError::RandomnessUnavailable)?;
    let sealed = match aead_seal_ctx(catalog_key, &catalog_nonce, &plaintext, &aad) {
        Ok(s) => s,
        Err(e) => {
            catalog_nonce.zeroize();
            return Err(CatalogBlobError::from(e));
        }
    };
    let ciphertext_len = sealed.len();

    let mut out = Vec::with_capacity(CATALOG_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&magic);
    out.push(CATALOG_BLOB_PROTOCOL_VERSION);
    out.push(CATALOG_BLOB_RESERVED);
    out.extend_from_slice(&catalog_nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    catalog_nonce.zeroize();
    Ok(out)
}

/// Version-aware open of the attachments catalog — mirror of
/// [`encode_attachments_catalog_versioned`].
pub fn decode_attachments_catalog_versioned(
    version: MetaVersion,
    catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<AttachmentsCatalog, CatalogBlobError> {
    let (magic, aad) = catalog_family_for(version, account_number_hash);
    if blob.len() < CATALOG_BLOB_HEADER_LEN {
        return Err(CatalogBlobError::HeaderTooShort);
    }
    if blob[0..4] != magic {
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

    let plaintext: Zeroizing<Vec<u8>> = aead_open_ctx(
        catalog_key,
        &catalog_nonce,
        &blob[CATALOG_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;
    canonical_json_decode(&plaintext)
}

/// Version-aware [`read_or_empty`] — collapses any decode failure (or an absent
/// file) to the empty catalog, selecting the generation from `version`.
pub fn read_or_empty_versioned(
    version: MetaVersion,
    catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
    blob: Option<&[u8]>,
) -> AttachmentsCatalog {
    match blob {
        Some(bytes) => {
            decode_attachments_catalog_versioned(version, catalog_key, account_number_hash, bytes)
                .unwrap_or_else(|_| AttachmentsCatalog::empty())
        }
        None => AttachmentsCatalog::empty(),
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::subkey::{derive_subkey, SubkeyRole};
    use crate::test_vector_fmt::{hex_lower, json_escape};
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
            AttachmentMeta::live(
                "image/png".to_string(),
                1_700_000_000,
                "photo.png".to_string(),
                12345,
            ),
        );
        entries.insert(
            "bb22".to_string(),
            AttachmentMeta::live(
                "application/pdf".to_string(),
                1_700_000_500,
                "doc.pdf".to_string(),
                98765,
            ),
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
            AttachmentMeta::live("t".to_string(), 1, "f".to_string(), 2),
        );
        a.insert(
            "00".to_string(),
            AttachmentMeta::live("t".to_string(), 3, "g".to_string(), 4),
        );
        let mut b = BTreeMap::new();
        b.insert(
            "00".to_string(),
            AttachmentMeta::live("t".to_string(), 3, "g".to_string(), 4),
        );
        b.insert(
            "ff".to_string(),
            AttachmentMeta::live("t".to_string(), 1, "f".to_string(), 2),
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

    // ---- deleted_at / updated_at (MYND-468, §9.10.2) ----

    #[test]
    fn tombstone_entry_round_trips_with_canonical_order() {
        // A tombstone entry (deleted_at set, metadata scrubbed) plus a
        // live renamed entry (updated_at set) round-trip, and the encode
        // emits the optional keys at their lexicographic positions:
        // content_type < created_at < deleted_at < filename < size < updated_at
        // < version. The tombstone carries version 1 (into_tombstone bumps it).
        let mut entries = BTreeMap::new();
        entries.insert(
            "aa11".to_string(),
            AttachmentMeta::live("image/png".to_string(), 100, "photo.png".to_string(), 5)
                .into_tombstone(200),
        );
        entries.insert("bb22".to_string(), {
            let mut m = AttachmentMeta::live("t".to_string(), 300, "new-name.txt".to_string(), 7);
            m.updated_at = Some(400);
            m
        });
        let catalog = AttachmentsCatalog { entries };
        let bytes = canonical_json_encode(&catalog);
        let s = String::from_utf8(bytes.clone()).unwrap();
        assert!(s.contains(
            r#""aa11":{"content_type":"","created_at":100,"deleted_at":200,"filename":"","size":0,"version":1}"#
        ));
        assert!(s.contains(r#""bb22":{"content_type":"t","created_at":300,"filename":"new-name.txt","size":7,"updated_at":400}"#));
        let decoded = canonical_json_decode(&bytes).expect("decode tombstone");
        assert_eq!(decoded, catalog);
        assert!(decoded.entries["aa11"].is_tombstone());
        assert!(!decoded.entries["bb22"].is_tombstone());
    }

    #[test]
    fn live_entry_encodes_byte_identically_to_pre_sync_shape() {
        // Byte-stability guarantee (§9.10.2): an entry without the two
        // optional fields emits EXACTLY the original four-field JSON, so
        // the existing attachments-catalog vectors stay green unchanged.
        let mut entries = BTreeMap::new();
        entries.insert(
            "aa".to_string(),
            AttachmentMeta::live("t".to_string(), 1, "f".to_string(), 2),
        );
        let bytes = canonical_json_encode(&AttachmentsCatalog { entries });
        assert_eq!(
            bytes.as_slice(),
            br#"{"aa":{"content_type":"t","created_at":1,"filename":"f","size":2}}"#
        );
    }

    #[test]
    fn old_shape_decodes_with_absent_optional_fields() {
        // A pre-sync (four-field) plaintext decodes to None for both
        // optional fields — the additive-field discipline in action.
        let pt = br#"{"aa":{"content_type":"t","created_at":1,"filename":"f","size":2}}"#;
        let decoded = canonical_json_decode(pt).expect("decode old shape");
        assert_eq!(decoded.entries["aa"].deleted_at, None);
        assert_eq!(decoded.entries["aa"].updated_at, None);
        assert!(!decoded.entries["aa"].is_tombstone());
    }

    #[test]
    fn into_tombstone_scrubs_descriptive_metadata() {
        // §9.10.2: filename/content_type emptied, size zeroed, updated_at
        // dropped; created_at retained (required field). NOTE: `created_at` IS
        // used by the merge — both as the resurrection guard's live-side clock
        // and, since it survives this scrub and can differ across devices, as
        // part of the tombstone tie-break's total order.
        let mut live = AttachmentMeta::live(
            "application/pdf".to_string(),
            42,
            "secret.pdf".to_string(),
            999,
        );
        live.updated_at = Some(50);
        let tomb = live.into_tombstone(77);
        assert_eq!(tomb.content_type, "");
        assert_eq!(tomb.filename, "");
        assert_eq!(tomb.size, 0);
        assert_eq!(tomb.created_at, 42);
        assert_eq!(tomb.deleted_at, Some(77));
        assert_eq!(tomb.updated_at, None);
        assert!(tomb.is_tombstone());
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

    // ---- push_json_string escape branches (encode side) ----

    #[test]
    fn encode_escapes_all_json_special_chars_in_filename() {
        // Drive every push_json_string escape branch through a real encode:
        // quote, backslash, \b, \f, \n, \r, \t, and a generic control char
        // ( → ""). The decoder must reverse them exactly.
        let mut entries = BTreeMap::new();
        entries.insert(
            "cc33".to_string(),
            AttachmentMeta::live(
                "text/plain".to_string(),
                7,
                "q\"\\\u{08}\u{0c}\n\r\t\u{01}.txt".to_string(),
                1,
            ),
        );
        let catalog = AttachmentsCatalog { entries };
        let bytes = canonical_json_encode(&catalog);
        let s = String::from_utf8(bytes.clone()).unwrap();
        // The named escapes are emitted as two-char sequences.
        assert!(s.contains(r#"\""#));
        assert!(s.contains(r"\\"));
        assert!(s.contains(r"\b"));
        assert!(s.contains(r"\f"));
        assert!(s.contains(r"\n"));
        assert!(s.contains(r"\r"));
        assert!(s.contains(r"\t"));
        // The generic control char uses the \u00XX form with lowercase hex.
        assert!(s.contains("\\u0001"));
        // Round-trip: decode recovers the exact filename.
        let decoded = canonical_json_decode(&bytes).expect("decode escapes");
        assert_eq!(
            decoded.entries["cc33"].filename,
            "q\"\\\u{08}\u{0c}\n\r\t\u{01}.txt"
        );
    }

    #[test]
    fn encode_control_char_uses_lowercase_hex_nibble() {
        //  exercises hex_nibble's a..f arm (nibble 0xf → 'f').
        let mut entries = BTreeMap::new();
        entries.insert(
            "dd44".to_string(),
            AttachmentMeta::live("t".to_string(), 0, "\u{1f}".to_string(), 0),
        );
        let bytes = canonical_json_encode(&AttachmentsCatalog { entries });
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.contains("\\u001f"));
    }

    // ---- parse_string escape branches (decode side) ----

    #[test]
    fn decode_parses_every_string_escape() {
        // Hand-built canonical plaintext exercising each parse_string escape
        // arm: \" \\ \/ \b \f \n \r \t and A ('A'). `/` is decoded but
        // the canonical encoder never emits it escaped.
        let pt = br#"{"aa":{"content_type":"\"\\\/\b\f\n\r\tA","created_at":1,"filename":"f","size":2}}"#;
        let decoded = canonical_json_decode(pt).expect("decode all escapes");
        assert_eq!(
            decoded.entries["aa"].content_type,
            "\"\\/\u{08}\u{0c}\n\r\tA"
        );
    }

    #[test]
    fn decode_rejects_unknown_escape() {
        // `\x` is not a valid JSON escape — parse_string's catch-all rejects.
        let bad = br#"{"aa":{"content_type":"\x","created_at":1,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_truncated_unicode_escape() {
        // `\u00` has only 2 of the required 4 hex digits before the closing
        // quote — parse_hex4's slice access returns None.
        let bad = br#"{"aa":{"content_type":"\u00","created_at":1,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_non_hex_unicode_escape() {
        // `\uZZZZ` reaches parse_hex4 with non-hex digits → None.
        let bad = br#"{"aa":{"content_type":"\uZZZZ","created_at":1,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_surrogate_code_point() {
        // \ud800 is a lone high surrogate — char::from_u32 returns None, so
        // parse_string rejects (no UTF-16 surrogate-pair handling in v0.1).
        let bad = br#"{"aa":{"content_type":"\ud800","created_at":1,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_uppercase_hex_in_unicode_escape() {
        // parse_hex4 accepts A-F as well as a-f; é → 'é'.
        let pt = br#"{"aa":{"content_type":"\u00E9","created_at":1,"filename":"f","size":2}}"#;
        let decoded = canonical_json_decode(pt).expect("decode uppercase hex");
        assert_eq!(decoded.entries["aa"].content_type, "\u{00e9}");
    }

    #[test]
    fn decode_rejects_unterminated_string() {
        // Opening quote with no closing quote before EOF → parse_string's
        // `get(pos)?` returns None.
        let bad = br#"{"aa":{"content_type":"unterminated"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    // ---- parse_uint edge cases ----

    #[test]
    fn decode_rejects_empty_integer_run() {
        // A `created_at` whose value position has no digit at all (a string
        // where a uint is expected) → parse_uint consumes 0 bytes → None.
        let bad = br#"{"aa":{"content_type":"t","created_at":"x","filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_u64_overflow_integer() {
        // 21 nines overflows u64 (max is 20 digits) → checked_mul/add → None.
        let bad = br#"{"aa":{"content_type":"t","created_at":999999999999999999999,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_accepts_single_zero_integer() {
        // `0` is canonical (consumed==1, leading-zero guard only fires for
        // multi-digit). created_at:0 must round-trip.
        let pt = br#"{"aa":{"content_type":"t","created_at":0,"filename":"f","size":0}}"#;
        let decoded = canonical_json_decode(pt).expect("decode zero");
        assert_eq!(decoded.entries["aa"].created_at, 0);
        assert_eq!(decoded.entries["aa"].size, 0);
    }

    #[test]
    fn decode_accepts_u64_max_size() {
        // The 20-digit u64::MAX must parse without overflow.
        let pt = br#"{"aa":{"content_type":"t","created_at":1,"filename":"f","size":18446744073709551615}}"#;
        let decoded = canonical_json_decode(pt).expect("decode u64 max");
        assert_eq!(decoded.entries["aa"].size, u64::MAX);
    }

    // ---- skip_value branches (forward-compat unknown fields) ----

    #[test]
    fn decode_skips_unknown_string_field() {
        let pt =
            br#"{"aa":{"content_type":"t","created_at":1,"extra":"hi","filename":"f","size":2}}"#;
        let d = canonical_json_decode(pt).expect("skip string");
        assert_eq!(d.entries["aa"].size, 2);
    }

    #[test]
    fn decode_skips_unknown_integer_field() {
        let pt =
            br#"{"aa":{"content_type":"t","created_at":1,"extra":42,"filename":"f","size":2}}"#;
        let d = canonical_json_decode(pt).expect("skip int");
        assert_eq!(d.entries["aa"].size, 2);
    }

    #[test]
    fn decode_skips_unknown_bool_and_null_fields() {
        // true, false, and null all reach distinct skip_value arms.
        let pt = br#"{"aa":{"a":true,"b":false,"c":null,"content_type":"t","created_at":1,"filename":"f","size":2}}"#;
        let d = canonical_json_decode(pt).expect("skip bool/null");
        assert_eq!(d.entries["aa"].size, 2);
    }

    #[test]
    fn decode_skips_unknown_nested_object_field() {
        // A nested object (incl. the empty-object fast path inside it would
        // need its own case; here a one-key object) is skipped recursively.
        let pt = br#"{"aa":{"content_type":"t","created_at":1,"filename":"f","meta":{"k":"v"},"size":2}}"#;
        let d = canonical_json_decode(pt).expect("skip object");
        assert_eq!(d.entries["aa"].size, 2);
    }

    #[test]
    fn decode_skips_unknown_empty_object_field() {
        // The `{}` fast path in skip_value's object arm.
        let pt =
            br#"{"aa":{"content_type":"t","created_at":1,"extra":{},"filename":"f","size":2}}"#;
        let d = canonical_json_decode(pt).expect("skip empty object");
        assert_eq!(d.entries["aa"].size, 2);
    }

    #[test]
    fn decode_skips_unknown_array_field() {
        let pt = br#"{"aa":{"arr":[1,"two",true],"content_type":"t","created_at":1,"filename":"f","size":2}}"#;
        let d = canonical_json_decode(pt).expect("skip array");
        assert_eq!(d.entries["aa"].size, 2);
    }

    #[test]
    fn decode_skips_unknown_empty_array_field() {
        // The `[]` fast path in skip_value's array arm.
        let pt = br#"{"aa":{"arr":[],"content_type":"t","created_at":1,"filename":"f","size":2}}"#;
        let d = canonical_json_decode(pt).expect("skip empty array");
        assert_eq!(d.entries["aa"].size, 2);
    }

    #[test]
    fn decode_rejects_malformed_skip_value_literal() {
        // `truu` is not `true` — skip_value's `t` arm's exact-match filter
        // rejects, so the whole catalog fails to parse.
        let bad = br#"{"aa":{"x":truu,"content_type":"t","created_at":1,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_unknown_value_kind_in_skip() {
        // A value starting with `@` matches no skip_value arm → None.
        let bad = br#"{"aa":{"x":@,"content_type":"t","created_at":1,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_bad_array_terminator_in_skip() {
        // Unknown array field whose elements are not comma/bracket-separated.
        let bad =
            br#"{"aa":{"arr":[1 2],"content_type":"t","created_at":1,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_bad_object_terminator_in_skip() {
        // Unknown object field whose members are not comma/brace-separated.
        let bad = br#"{"aa":{"o":{"k":"v" "x":"y"},"content_type":"t","created_at":1,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    // ---- structural rejects in the catalog/entry/meta parsers ----

    #[test]
    fn decode_rejects_duplicate_top_level_key() {
        // Two entries with the same id — parse_catalog rejects (BTreeMap
        // would silently overwrite; data-integrity guard).
        let bad = br#"{"aa":{"content_type":"t","created_at":1,"filename":"f","size":2},"aa":{"content_type":"t","created_at":1,"filename":"f","size":3}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_bad_entry_separator() {
        // After a complete entry, neither `,` nor `}` follows.
        let bad = br#"{"aa":{"content_type":"t","created_at":1,"filename":"f","size":2}x}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_empty_meta_object() {
        // `{}` for a meta object cannot satisfy the required-fields contract.
        let bad = br#"{"aa":{}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_bad_meta_field_separator() {
        // Inside the meta object, a field is followed by neither `,` nor `}`.
        let bad = br#"{"aa":{"content_type":"t"x"created_at":1,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_missing_colon_after_entry_id() {
        // `parse_entry` expects `:` after the id string.
        let bad = br#"{"aa"{"content_type":"t","created_at":1,"filename":"f","size":2}}"#;
        assert!(canonical_json_decode(bad).is_err());
    }

    #[test]
    fn decode_rejects_empty_input() {
        // No opening brace at all.
        assert!(canonical_json_decode(b"").is_err());
    }

    // ---- ProtocolError → CatalogBlobError mapping ----

    #[test]
    fn non_aead_protocol_errors_map_to_cannot_decrypt() {
        // The From impl maps every non-AeadFailure ProtocolError variant to
        // CannotDecrypt (the catch-all arm, line 192). Spot-check a few.
        for e in [
            ProtocolError::InvalidPassword,
            ProtocolError::PasswordTooShort,
            ProtocolError::KdfFailure,
            ProtocolError::InvalidVaultMeta,
            ProtocolError::AccountNumberInvalid,
            ProtocolError::Csprng,
            ProtocolError::PlaintextTooLarge,
        ] {
            assert_eq!(CatalogBlobError::from(e), CatalogBlobError::CannotDecrypt);
        }
        // The AeadFailure arm also maps to CannotDecrypt (already exercised
        // indirectly, asserted here for completeness).
        assert_eq!(
            CatalogBlobError::from(ProtocolError::AeadFailure),
            CatalogBlobError::CannotDecrypt
        );
    }

    // ---- encode getrandom convenience wrapper + cap ----

    #[test]
    fn encode_convenience_wrapper_round_trips() {
        // encode_attachments_catalog pulls its own nonce from getrandom;
        // exercise that path (distinct from the _raw fixture-nonce path).
        let key = catalog_key();
        let catalog = sample_catalog();
        let blob = encode_attachments_catalog(&key, &fixed_account_hash(), &catalog)
            .expect("encode via getrandom");
        let decoded =
            decode_attachments_catalog(&key, &fixed_account_hash(), &blob).expect("decode");
        assert_eq!(decoded, catalog);
    }

    #[test]
    fn encode_two_calls_use_distinct_nonces() {
        // Two convenience encodes of the same catalog must differ (random
        // nonce), proving the getrandom path actually varies the nonce.
        let key = catalog_key();
        let catalog = sample_catalog();
        let a = encode_attachments_catalog(&key, &fixed_account_hash(), &catalog).unwrap();
        let b = encode_attachments_catalog(&key, &fixed_account_hash(), &catalog).unwrap();
        // Nonce lives at offset 6..30.
        assert_ne!(a[6..30], b[6..30]);
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
            Some(&AttachmentMeta::live(
                "image/png".to_string(),
                1_700_000_000,
                "photo.png".to_string(),
                12345,
            )),
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

    // ---- KAT vector APPEND generator: attachment scope -----------------

    /// Emits a JSON **array fragment** of 2 `scope` cases for
    /// `myne-test-vectors/vectors/attachments-catalog/v0.1/cases.json` at
    /// `/tmp/myne_attachments_catalog_scope_vectors.json` (myne-md/myne#913),
    /// spliced by hand into the existing `cases` array like the parse-fail
    /// fragment beside it. The whole-file emitter above is NOT re-run: it is
    /// byte-stable for `vector_id` immutability, and it predates the tombstone
    /// cases too.
    ///
    /// Run with:
    /// `cargo test -p protocol --lib emit_catalog_scope_vectors -- --ignored`
    ///
    /// The two directions the field has, and neither is covered before #913: a
    /// `chat` row ENCODES `"scope":"chat"` in its canonical slot (between
    /// `filename` and `size`), and a value from a later version DECODES as
    /// `library` rather than failing the catalog (§9.10.2).
    #[test]
    #[ignore]
    fn emit_catalog_scope_vectors() {
        extern crate std;

        let root_key: [u8; 32] = [0x42; 32];
        let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
        let account_hash: [u8; CATALOG_BLOB_ACCOUNT_HASH_LEN] =
            [0x33; CATALOG_BLOB_ACCOUNT_HASH_LEN];
        // 0x77 / 0x88 / 0x99 / 0xAA are taken in this family's nonce registry.
        let nonce_chat: [u8; AEAD_NONCE_LEN] = [0xBB; AEAD_NONCE_LEN];
        let nonce_future: [u8; AEAD_NONCE_LEN] = [0xCC; AEAD_NONCE_LEN];

        // (1) A chat-scoped entry: the slot, and the whole MYC1 output.
        let mut chat = AttachmentsCatalog::empty();
        chat.entries.insert(
            "cc33".to_string(),
            AttachmentMeta::live(
                "image/png".to_string(),
                1_700_000_000,
                "pasted.png".to_string(),
                12345,
            )
            .in_chat(),
        );
        let pt_chat = canonical_json_encode(&chat);
        let text = core::str::from_utf8(&pt_chat).expect("canonical JSON is UTF-8");
        // The SLOT is the contract, so it is asserted here rather than left to
        // the pinned bytes alone: a canonical order that moved it would still
        // round-trip through this implementation, and only a port reading the
        // vector would ever see the difference.
        assert!(
            text.contains(r#""filename":"pasted.png","scope":"chat","size":12345"#),
            "scope must sit between filename and size: {text}"
        );
        let blob_chat =
            encode_attachments_catalog_raw(&catalog_key, &account_hash, &chat, &nonce_chat)
                .expect("encode chat scope");

        // (2) A scope from a later version decodes as `library`, never as a
        // failed catalog. The typed encoder cannot emit one, so the envelope is
        // assembled by hand (assembly mirrors `encode_attachments_catalog_raw`).
        let pt_future: &[u8] = br#"{"dd44":{"content_type":"text/plain","created_at":1700000000,"filename":"note.txt","scope":"note","size":42}}"#;
        let aad = aad_attachments_catalog(&account_hash);
        let sealed =
            aead_seal_ctx(&catalog_key, &nonce_future, pt_future, &aad).expect("seal future");
        let mut blob_future = Vec::with_capacity(CATALOG_BLOB_HEADER_LEN + sealed.len());
        blob_future.extend_from_slice(&CATALOG_BLOB_MAGIC);
        blob_future.push(CATALOG_BLOB_PROTOCOL_VERSION);
        blob_future.push(CATALOG_BLOB_RESERVED);
        blob_future.extend_from_slice(&nonce_future);
        blob_future.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
        blob_future.extend_from_slice(&sealed);

        let decoded = decode_attachments_catalog(&catalog_key, &account_hash, &blob_future)
            .expect("an unknown scope must not fail the catalog");
        assert_eq!(
            decoded.entries["dd44"].scope,
            AttachmentScope::Library,
            "an unknown scope value decodes as library"
        );
        let pt_future_expected = canonical_json_encode(&decoded);
        assert!(
            !core::str::from_utf8(&pt_future_expected)
                .expect("utf8")
                .contains("scope"),
            "the canonical re-encode of a library row carries no scope key"
        );

        let mut d = String::new();
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachments-catalog/v0.1/encrypt-chat-scope\",\n");
        d.push_str("      \"description\": \"A chat-scoped entry pins the canonical slot of the optional `scope` field: \\\"scope\\\":\\\"chat\\\" between `filename` and `size` (myne-md/myne#913, §9.10.2). The file's bytes, KEK and envelope are a library attachment's; the field only says which surface lists the row. `library` is never emitted, so a library row is byte-identical to the pre-#913 shape (`encrypt-populated`).\",\n");
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
            hex_lower(&pt_chat)
        ));
        d.push_str(&alloc::format!(
            "      \"input_catalog_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce_chat)
        ));
        d.push_str(&alloc::format!(
            "      \"informational_catalog_key_hex\": \"{}\",\n",
            hex_lower(catalog_key.as_slice())
        ));
        d.push_str(&alloc::format!(
            "      \"expected_catalog_blob_hex\": \"{}\"\n",
            hex_lower(&blob_chat)
        ));
        d.push_str("    },\n");

        d.push_str("    {\n");
        d.push_str(
            "      \"vector_id\": \"attachments-catalog/v0.1/decrypt-unknown-scope-tolerated\",\n",
        );
        d.push_str("      \"description\": \"Forward-compat (§9.10.2): a sealed plaintext carrying a scope value this version does not know (`note`) MUST decode as `library` rather than fail the catalog, and a canonical re-encode drops the key. expected_plaintext_canonical_utf8_hex is that re-encode, NOT the sealed bytes; informational_sealed_plaintext_utf8_hex carries the sealed plaintext verbatim.\",\n");
        d.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        d.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_future)
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
            hex_lower(&pt_future_expected)
        ));
        d.push_str("    },\n");

        // (3) A non-string value decodes as the library too. §9.10.2's tolerance
        // is about a value this version does not know, and a later version could
        // spell the field as a number; `parse_string()?` would have failed the
        // whole catalog over it.
        let nonce_non_string: [u8; AEAD_NONCE_LEN] = [0xCE; AEAD_NONCE_LEN];
        let pt_non_string: &[u8] = br#"{"ee55":{"content_type":"text/plain","created_at":1700000000,"filename":"note.txt","scope":2,"size":42}}"#;
        let sealed_non_string = aead_seal_ctx(&catalog_key, &nonce_non_string, pt_non_string, &aad)
            .expect("seal non-string scope");
        let mut blob_non_string =
            Vec::with_capacity(CATALOG_BLOB_HEADER_LEN + sealed_non_string.len());
        blob_non_string.extend_from_slice(&CATALOG_BLOB_MAGIC);
        blob_non_string.push(CATALOG_BLOB_PROTOCOL_VERSION);
        blob_non_string.push(CATALOG_BLOB_RESERVED);
        blob_non_string.extend_from_slice(&nonce_non_string);
        blob_non_string.extend_from_slice(&(sealed_non_string.len() as u32).to_be_bytes());
        blob_non_string.extend_from_slice(&sealed_non_string);
        let decoded_non_string =
            decode_attachments_catalog(&catalog_key, &account_hash, &blob_non_string)
                .expect("a non-string scope must not fail the catalog");
        assert_eq!(
            decoded_non_string.entries["ee55"].scope,
            AttachmentScope::Library
        );
        let pt_non_string_expected = canonical_json_encode(&decoded_non_string);

        d.push_str("    {\n");
        d.push_str(
            "      \"vector_id\": \"attachments-catalog/v0.1/decrypt-non-string-scope-tolerated\",\n",
        );
        d.push_str(
            "      \"description\": \"Forward-compat (§9.10.2): the tolerance is stated for a scope VALUE this version does not know, not only for a string it does not know. A sealed non-string value MUST decode as `library` rather than fail the catalog (the first implementation used `parse_string()?`, which would have collapsed the WHOLE catalog to {}). expected_plaintext_canonical_utf8_hex is the re-encode without the key; informational_sealed_plaintext_utf8_hex carries the sealed bytes.\",\n",
        );
        d.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        d.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_non_string)
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
            hex_lower(pt_non_string)
        ));
        d.push_str(&alloc::format!(
            "      \"expected_plaintext_canonical_utf8_hex\": \"{}\"\n",
            hex_lower(&pt_non_string_expected)
        ));
        d.push_str("    }\n");

        std::fs::write(
            "/tmp/myne_attachments_catalog_scope_vectors.json",
            d.as_bytes(),
        )
        .expect("write scope fragment");
    }

    // ---- KAT vector APPEND generator: structural parse rejects --------

    /// Emits a JSON **array fragment** of 7 additional `parse_fail` cases
    /// for `myne-test-vectors/vectors/attachments-catalog/v0.1/cases.json`
    /// at `/tmp/myne_attachments_catalog_parse_fail_vectors.json`
    /// (MYND-227), spliced by hand into the existing `cases` array. The
    /// original `emit_attachments_catalog_vectors_for_paste` stays
    /// byte-stable and is NOT re-run (vector_id immutability).
    ///
    /// Run with:
    /// `cargo test -p protocol --lib emit_catalog_parse_fail_vectors -- --ignored`
    ///
    /// One case per distinguishable `CatalogBlobError` reject reachable
    /// from a decode-a-blob vector: the 6 pre-AEAD structural rejects
    /// (vault-search parity) + the post-AEAD `plaintext_parse_failed`
    /// (a validly-sealed blob whose inner plaintext is not a canonical
    /// JSON object — possible only with the real `catalog_key`, which
    /// every case therefore carries).
    #[test]
    #[ignore]
    fn emit_catalog_parse_fail_vectors() {
        extern crate std;

        // Same fixed inputs as emit_attachments_catalog_vectors_for_paste;
        // nonces 0x99 + 0xAA are the next free entries in this family's
        // nonce registry (0x77, 0x88 are taken).
        let root_key: [u8; 32] = [0x42; 32];
        let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
        let account_hash: [u8; CATALOG_BLOB_ACCOUNT_HASH_LEN] =
            [0x33; CATALOG_BLOB_ACCOUNT_HASH_LEN];
        let nonce_base: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];
        let nonce_bad_inner: [u8; AEAD_NONCE_LEN] = [0xAA; AEAD_NONCE_LEN];

        // Base blob for the structural tampers: the empty catalog under the
        // real key. Header bytes are not AAD-bound — a port that skips a
        // structural check decrypts the tampered blob successfully and
        // returns Ok, which the runner catches (hence real keys, not dummies).
        let base = encode_attachments_catalog_raw(
            &catalog_key,
            &account_hash,
            &AttachmentsCatalog::empty(),
            &nonce_base,
        )
        .expect("encode base");

        let header_short: Vec<u8> = CATALOG_BLOB_MAGIC.to_vec();
        let mut magic_tamper = base.clone();
        magic_tamper[0] = b'X';
        let mut version_tamper = base.clone();
        version_tamper[4] = 0x02;
        let mut reserved_tamper = base.clone();
        reserved_tamper[5] = 0x01;
        let mut len_overflow = base.clone();
        len_overflow[30..34].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());
        let mut truncated = base.clone();
        truncated.truncate(truncated.len() - 1);

        // plaintext_parse_failed: hand-assembled envelope (assembly mirrors
        // encode_attachments_catalog_raw) sealing bytes that are not a
        // canonical JSON object. AEAD passes; the catalog parse rejects.
        let bad_plaintext: &[u8] = b"not a canonical json object";
        let aad = aad_attachments_catalog(&account_hash);
        let sealed = aead_seal_ctx(&catalog_key, &nonce_bad_inner, bad_plaintext, &aad)
            .expect("seal bad inner");
        let mut bad_inner = Vec::with_capacity(CATALOG_BLOB_HEADER_LEN + sealed.len());
        bad_inner.extend_from_slice(&CATALOG_BLOB_MAGIC);
        bad_inner.push(CATALOG_BLOB_PROTOCOL_VERSION);
        bad_inner.push(CATALOG_BLOB_RESERVED);
        bad_inner.extend_from_slice(&nonce_bad_inner);
        bad_inner.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
        bad_inner.extend_from_slice(&sealed);

        let cases: [(&str, &str, &[u8], CatalogBlobError, &str); 7] = [
            (
                "parse-fail-header-too-short",
                "Only the 4-byte MYC1 magic — no room for the 34-byte header (magic + version + reserved + 24-byte nonce + 4-byte ciphertext_len). Rejected before any field read.",
                header_short.as_slice(),
                CatalogBlobError::HeaderTooShort,
                "blob is the 4 magic bytes only (4 < 34)",
            ),
            (
                "parse-fail-magic-mismatch",
                "First byte of the MYC1 magic corrupted to 'X'. Rejected at offset 0 before any decryption — a foreign file, different artifact type, or forward-incompatible MYC5 blob all fail here.",
                magic_tamper.as_slice(),
                CatalogBlobError::MagicMismatch,
                "byte 0 (magic[0]) 'M' → 'X'",
            ),
            (
                "parse-fail-protocol-version-mismatch",
                "protocol_version byte (offset 4) set to 0x02 instead of 0x01. A v0.1 decoder rejects an unknown protocol version before decrypting.",
                version_tamper.as_slice(),
                CatalogBlobError::ProtocolVersionMismatch,
                "byte 4 (protocol_version) 0x01 → 0x02",
            ),
            (
                "parse-fail-reserved-nonzero",
                "reserved byte (offset 5) set to 0x01 instead of 0x00. Reserved bytes are flag carriers for future v0.1.x revisions; non-zero is an unconditional parse rejection.",
                reserved_tamper.as_slice(),
                CatalogBlobError::ReservedByteNonZero,
                "byte 5 (reserved) 0x00 → 0x01",
            ),
            (
                "parse-fail-ciphertext-len-overflow",
                "ciphertext_len field (offset 30..34) set to 0xFFFFFFFF, far above MAX_CATALOG_PLAINTEXT_LEN + 32 (16 MiB + 32). The overflow guard rejects before any slice indexing — a port MUST bound-check ciphertext_len before allocating or indexing (§9.10 DoS-allocation defense).",
                len_overflow.as_slice(),
                CatalogBlobError::CiphertextLenOverflow,
                "bytes 30..34 (ciphertext_len) → 0xffffffff",
            ),
            (
                "parse-fail-ciphertext-truncated",
                "Valid header advertising ciphertext_len = N, but the blob is one byte shorter than header + N. Rejected before the AEAD stage.",
                truncated.as_slice(),
                CatalogBlobError::CiphertextTruncated,
                "final byte dropped (blob shorter than header + advertised ciphertext_len)",
            ),
            (
                "parse-fail-plaintext-parse-failed",
                "A structurally valid envelope sealed under the REAL catalog_key + AAD whose inner plaintext is 'not a canonical json object'. AEAD verification succeeds — the reject fires at the canonical-JSON parse stage, distinct from CannotDecrypt because the tag check already proved the bytes came from a catalog_key holder. Callers then fall back to the empty catalog per §9.10.4 — but the error surface itself is distinguishable and a port MUST NOT report its AEAD-failure error here.",
                bad_inner.as_slice(),
                CatalogBlobError::PlaintextParseFailed,
                "validly-sealed non-JSON inner plaintext (nonce 0xaa×24)",
            ),
        ];

        let expected_error_str = |e: &CatalogBlobError| -> &'static str {
            match e {
                CatalogBlobError::HeaderTooShort => "header_too_short",
                CatalogBlobError::MagicMismatch => "magic_mismatch",
                CatalogBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
                CatalogBlobError::ReservedByteNonZero => "reserved_byte_nonzero",
                CatalogBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
                CatalogBlobError::CiphertextTruncated => "ciphertext_truncated",
                CatalogBlobError::PlaintextParseFailed => "plaintext_parse_failed",
                other => panic!("unexpected expected-error variant {other:?}"),
            }
        };

        let mut dump = String::new();
        dump.push_str("[\n");
        for (i, (slug, description, blob, expected, tamper)) in cases.iter().enumerate() {
            assert_eq!(
                decode_attachments_catalog(&catalog_key, &account_hash, blob).as_ref(),
                Err(expected),
                "[{slug}] tampered blob must reject with {expected:?}"
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"attachments-catalog/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex_lower(blob)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                hex_lower(&root_key)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                hex_lower(&account_hash)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_error\": \"{}\",\n",
                expected_error_str(expected)
            ));
            dump.push_str(&alloc::format!(
                "      \"informational_tamper_description\": \"{}\"\n",
                json_escape(tamper)
            ));
            if i + 1 < cases.len() {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        }
        dump.push_str("]\n");

        std::fs::write(
            "/tmp/myne_attachments_catalog_parse_fail_vectors.json",
            dump.as_bytes(),
        )
        .expect("write attachments-catalog parse_fail vectors dump");
    }

    // ---- KAT vector APPEND generator: tombstone fields (MYND-468) -----

    /// Emits a JSON **array fragment** of 2 additional cases for
    /// `myne-test-vectors/vectors/attachments-catalog/v0.1/cases.json` at
    /// `/tmp/myne_attachments_catalog_tombstone_vectors.json`, spliced by
    /// hand into the existing `cases` array (append-only; the original
    /// generators stay byte-stable and are NOT re-run).
    ///
    /// Run with:
    /// `cargo test -p protocol --lib emit_catalog_tombstone_vectors -- --ignored`
    ///
    /// Pins the §9.10.2 optional Phase-2-sync fields: an attachment
    /// catalog tombstone entry (`deleted_at`, metadata scrubbed) beside a
    /// live renamed entry (`updated_at`), with the canonical emit order
    /// content_type < created_at < deleted_at < filename < size <
    /// updated_at. Nonce 0xBB is the next free entry in this family's
    /// nonce registry (0x77, 0x88, 0x99, 0xAA taken).
    #[test]
    #[ignore]
    fn emit_catalog_tombstone_vectors() {
        extern crate std;

        let root_key: [u8; 32] = [0x42; 32];
        let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
        let account_hash: [u8; CATALOG_BLOB_ACCOUNT_HASH_LEN] =
            [0x33; CATALOG_BLOB_ACCOUNT_HASH_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0xBB; AEAD_NONCE_LEN];

        let mut entries = BTreeMap::new();
        entries.insert(
            "aa11".to_string(),
            AttachmentMeta::live(
                "image/png".to_string(),
                1_700_000_000,
                "photo.png".to_string(),
                12345,
            )
            .into_tombstone(1_700_000_900),
        );
        entries.insert("bb22".to_string(), {
            let mut m = AttachmentMeta::live(
                "application/pdf".to_string(),
                1_700_000_500,
                "renamed.pdf".to_string(),
                98765,
            );
            m.updated_at = Some(1_700_000_800);
            m
        });
        let catalog = AttachmentsCatalog { entries };
        let pt = canonical_json_encode(&catalog);
        let blob = encode_attachments_catalog_raw(&catalog_key, &account_hash, &catalog, &nonce)
            .expect("encode tombstone catalog");

        // Self-validate the round-trip before emitting.
        let dec = decode_attachments_catalog(&catalog_key, &account_hash, &blob)
            .expect("decode tombstone catalog");
        assert_eq!(dec, catalog);
        assert!(dec.entries["aa11"].is_tombstone());
        assert_eq!(dec.entries["bb22"].updated_at, Some(1_700_000_800));

        let mut dump = String::new();
        dump.push_str("[\n");

        dump.push_str("    {\n");
        dump.push_str(
            "      \"vector_id\": \"attachments-catalog/v0.1/encrypt-tombstone-and-updated-at\",\n",
        );
        dump.push_str("      \"description\": \"MYND-468 (§9.10.2 + sync-protocol.md §11.4): a two-entry catalog whose first entry is an attachment catalog tombstone (deleted_at set; filename/content_type emptied, size zeroed — the delete-time metadata scrub) and whose second is a live renamed entry carrying updated_at (the filename-LWW discriminator). Pins the canonical per-entry key order content_type < created_at < deleted_at < filename < size < updated_at, with the two optional fields emitted only when present.\",\n");
        dump.push_str("      \"case_kind\": \"encrypt\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_key)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&pt)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_catalog_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce)
        ));
        dump.push_str(&alloc::format!(
            "      \"informational_catalog_key_hex\": \"{}\",\n",
            hex_lower(catalog_key.as_slice())
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_catalog_blob_hex\": \"{}\"\n",
            hex_lower(&blob)
        ));
        dump.push_str("    },\n");

        dump.push_str("    {\n");
        dump.push_str(
            "      \"vector_id\": \"attachments-catalog/v0.1/decrypt-ok-tombstone-and-updated-at\",\n",
        );
        dump.push_str("      \"description\": \"Decode the tombstone-carrying MYC1 blob back to its canonical plaintext: deleted_at and updated_at round-trip as first-class (no longer unknown) fields. A pre-sync reader would instead tolerate-and-drop them (§9.10.2 honesty note) — this case is the post-MYND-468 reader contract.\",\n");
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_key)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_canonical_utf8_hex\": \"{}\"\n",
            hex_lower(&pt)
        ));
        dump.push_str("    }\n");

        dump.push_str("]\n");

        std::fs::write(
            "/tmp/myne_attachments_catalog_tombstone_vectors.json",
            dump.as_bytes(),
        )
        .expect("write attachments-catalog tombstone vectors dump");
    }
    // ---- scope: chat vs library (myne-md/myne#913) ------------------------

    /// A library entry is byte-identical to the pre-#913 four-field encode.
    ///
    /// This is the property the additive-field rule exists for, and it is worth
    /// a test rather than a comment: the field is written only for `chat`, so a
    /// vault that never pastes a file into a conversation keeps emitting exactly
    /// the bytes it emitted before, and a reader from either side reads them.
    #[test]
    fn a_library_entry_emits_no_scope_key() {
        let mut catalog = AttachmentsCatalog::default();
        catalog.entries.insert(
            "aa11".to_string(),
            AttachmentMeta::live("text/plain".to_string(), 100, "a.txt".to_string(), 7),
        );
        let plaintext = canonical_json_encode(&catalog);
        let text = String::from_utf8(plaintext).expect("utf8");
        assert_eq!(
            text,
            r#"{"aa11":{"content_type":"text/plain","created_at":100,"filename":"a.txt","size":7}}"#
        );
        assert!(!text.contains("scope"));
    }

    /// A chat attachment carries the marker, at its canonical position.
    #[test]
    fn a_chat_entry_carries_its_scope_between_filename_and_size() {
        let mut catalog = AttachmentsCatalog::default();
        catalog.entries.insert(
            "bb22".to_string(),
            AttachmentMeta::live("text/plain".to_string(), 100, "a.txt".to_string(), 7).in_chat(),
        );
        let text = String::from_utf8(canonical_json_encode(&catalog)).expect("utf8");
        assert_eq!(
            text,
            r#"{"bb22":{"content_type":"text/plain","created_at":100,"filename":"a.txt","scope":"chat","size":7}}"#
        );
    }

    /// The parser reads the marker back, and tolerates one it does not know.
    #[test]
    fn the_parser_reads_a_known_scope_and_tolerates_an_unknown_one() {
        let parsed = canonical_json_decode(
            br#"{"aa":{"content_type":"t","created_at":1,"filename":"f","scope":"chat","size":2}}"#,
        )
        .expect("parses");
        assert_eq!(parsed.entries["aa"].scope, AttachmentScope::Chat);

        // A scope from a later version is Library here, not a failed file: an
        // additive field must never cost the reader the whole catalog.
        let future = canonical_json_decode(
            br#"{"aa":{"content_type":"t","created_at":1,"filename":"f","scope":"note","size":2}}"#,
        )
        .expect("parses");
        assert_eq!(future.entries["aa"].scope, AttachmentScope::Library);
    }

    /// Scrubbing a live entry into a tombstone drops the marker with the rest of
    /// the descriptive metadata.
    /// **A non-string scope decodes as the library instead of killing the
    /// catalog** (myne-md/myne#913, review round three). §9.10.2's tolerance is
    /// stated for a value this version does not know, and only a string can name
    /// a scope; the first implementation used `parse_string()?`, so a future
    /// `"scope":2` would have failed the parse and `read_or_empty` would have
    /// collapsed the WHOLE catalog to `{}`: every attachment gone from every
    /// listing over one word a later version invented.
    #[test]
    fn a_non_string_scope_decodes_as_the_library() {
        let root_key = fixed_root_key();
        let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
        let account_hash = [0x33; CATALOG_BLOB_ACCOUNT_HASH_LEN];
        let nonce = [0xCD; AEAD_NONCE_LEN];
        // Not a canonical value for the field on purpose: the point is a shape
        // this version has no rule for.
        let plaintext: &[u8] =
            br#"{"aa11":{"content_type":"t","created_at":1,"filename":"f","scope":2,"size":2}}"#;
        let aad = aad_attachments_catalog(&account_hash);
        let sealed = aead_seal_ctx(&catalog_key, &nonce, plaintext, &aad).expect("seal");
        let mut blob = Vec::with_capacity(CATALOG_BLOB_HEADER_LEN + sealed.len());
        blob.extend_from_slice(&CATALOG_BLOB_MAGIC);
        blob.push(CATALOG_BLOB_PROTOCOL_VERSION);
        blob.push(CATALOG_BLOB_RESERVED);
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
        blob.extend_from_slice(&sealed);

        let decoded = decode_attachments_catalog(&catalog_key, &account_hash, &blob)
            .expect("a non-string scope must not fail the catalog");
        assert_eq!(decoded.entries["aa11"].scope, AttachmentScope::Library);
    }

    #[test]
    fn a_tombstone_carries_no_scope() {
        let live = AttachmentMeta::live("t".to_string(), 1, "f".to_string(), 2).in_chat();
        let tomb = live.into_tombstone(9);
        assert_eq!(tomb.scope, AttachmentScope::Library);
        let mut catalog = AttachmentsCatalog::default();
        catalog.entries.insert("aa".to_string(), tomb);
        let text = String::from_utf8(canonical_json_encode(&catalog)).expect("utf8");
        assert!(!text.contains("scope"));
    }
}
