// SPDX-License-Identifier: AGPL-3.0

//! Canonical `PairedExtension` record + its `vault.prefs`-embedded array codec
//! — the on-disk projection of the browser-clipper pairing-token registry
//! (`ext-foundation-handoff` task 7, MYND-443). See `docs/spec/protocol.md`
//! § 9.5 and `design-notes.md` 2026-06-20 "Browser-clipper pairing-token
//! persistence: encrypted prefs-family blob".
//!
//! A paired extension record is **declarative state** (an issued or revoked
//! pairing token bound to one exact extension ID), persisted inside the
//! existing `vault.prefs` (`MYP1`) blob as a `paired_extensions` field — no
//! new magic, no new KEK role, no new load-bearing crypto (the `saved_views`
//! precedent, SYNC-6). This module defines the in-memory record + its
//! canonical-JSON codec; the host-side [`crate::clipper::token::TokenRegistry`]
//! (in `src-tauri`) maps to/from a slice of these records, and the
//! `PrefsView::paired_extensions` field carries the array. The protocol crate
//! deliberately holds only the three persisted scalars — the token's structural
//! scope ceiling (`create-clip` + `is-unlocked-status`) is fixed by
//! construction host-side and never stored, so the on-disk form can never imply
//! a wider grant.
//!
//! ## Canonical JSON (§ 9.5.2)
//!
//! The on-disk encoding is hand-rolled canonical JSON — object keys
//! lexicographically sorted, no insignificant whitespace, NFC strings, booleans
//! as bare `true`/`false`, no floats. Each record is the flat object
//! `{"extension_id":…,"revoked":…,"token_value":…}` (keys in lexicographic
//! order); the array is sorted by `(extension_id, token_value)` so the encoding
//! is byte-stable regardless of insertion order. Schema evolution within v0.1 is
//! additive optional fields; an unknown future key is ignored on decode
//! (forward-compat), never a parse failure. Same dual-surface discipline as
//! [`crate::saved_view`] and [`crate::prefs::PrefsView`] — the serde derives
//! drive the IPC (Tauri) path, this hand-rolled codec drives the byte-stable
//! disk path.

use crate::canonical_json::push_json_string as push_string;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

/// One persisted pairing-token record: the exact extension ID, the token's
/// opaque bearer value, and its revocation flag.
///
/// Append-only history: a revoked record keeps its row (the host's
/// `TokenRegistry` flips `revoked` rather than deleting), so a re-pair appends a
/// fresh non-revoked record while the old revoked one stays dead. The token's
/// scope ceiling is NOT stored — it is structurally fixed host-side, so a
/// resurrected (replayed) record can never widen the grant
/// (`threat-model.md` § 7 local-prefs-replay).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairedExtension {
    /// The exact extension ID the token is bound to. A token presented for any
    /// other ID is invalid (binding mismatch, checked host-side).
    pub extension_id: String,
    /// The opaque bearer value (hex of 32 CSPRNG bytes). Vault-stable
    /// correlation tag — never logged.
    ///
    /// `#[serde(skip_serializing)]`: the bearer secret must never cross the
    /// WebView IPC boundary. `PrefsView` derives `Serialize` and `prefs_read`
    /// returns it to the WebView, so without this skip every `prefs_read` would
    /// hand the full live token registry to JS (a credential-confinement break —
    /// a WebView compromise could replay the bearer value to the 0600 relay and
    /// mint clips, bypassing the pairing dialog). The hand-rolled canonical-JSON
    /// disk codec (`encode_record_into`) writes `token_value` explicitly and the
    /// hand-rolled decoder reads it, so on-disk persistence is unaffected; the
    /// Settings UI gets `extension_id` + `paired_at` via the dedicated
    /// `pairing_list_paired` command, never through `prefs_read`. Skip applies to
    /// serialization only — `Deserialize` still reads the key when present.
    #[serde(skip_serializing)]
    pub token_value: String,
    /// Whether this record has been revoked. A revoked record never validates.
    pub revoked: bool,
    /// Unix seconds when this pairing was issued (the in-app Accept time), or
    /// `None` for records persisted before this field existed. A user-meaningful
    /// timestamp, so it lives INSIDE the encrypted blob (`AGENTS.md` commitment).
    /// **Additive optional field** (§ 9.5.2): omitted from the canonical JSON
    /// when `None`, so pre-feature records stay byte-identical, and an old
    /// decoder ignoring the new key still validates the token (forward-compat).
    pub paired_at: Option<u64>,
}

/// Closed failure surface for the `paired_extensions` array decode. The bytes
/// are decoded only AFTER the surrounding `vault.prefs` AEAD verified, so a
/// failure here is structural (the `prefs_key` holder wrote malformed JSON),
/// not adversarial — the caller collapses it to fall-back-to-defaults (an empty
/// registry → the extension must re-pair, § 9.5.5).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum PairedExtensionParseError {
    /// The bytes are not well-formed canonical JSON (bad structure, a forbidden
    /// float, trailing junk, or over-deep nesting).
    #[error("paired-extension JSON is malformed")]
    Malformed,
    /// A required field (`extension_id` / `token_value` / `revoked`) is absent.
    #[error("paired-extension record is missing a required field")]
    MissingField,
    /// A field is present but the wrong JSON type.
    #[error("paired-extension field has the wrong JSON type")]
    WrongType,
}

// ---- canonical JSON encoder -------------------------------------------------

fn nfc(s: &str) -> String {
    s.nfc().collect::<String>()
}

/// Append the decimal digits of `n` (no allocation, no float). Canonical-JSON
/// integers carry no sign for a `u64` and no leading zero (except `0` itself).
fn push_u64(out: &mut Vec<u8>, n: u64) {
    if n == 0 {
        out.push(b'0');
        return;
    }
    let mut buf = [0u8; 20]; // u64::MAX is 20 digits
    let mut i = buf.len();
    let mut v = n;
    while v > 0 {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
    }
    out.extend_from_slice(&buf[i..]);
}

fn encode_record_into(out: &mut Vec<u8>, rec: &PairedExtension) {
    // Canonical key order: extension_id < paired_at < revoked < token_value.
    // `paired_at` is emitted ONLY when present (additive optional), so a record
    // without it is byte-identical to the pre-feature encoding.
    out.extend_from_slice(b"{\"extension_id\":");
    push_string(out, &nfc(&rec.extension_id));
    if let Some(at) = rec.paired_at {
        out.extend_from_slice(b",\"paired_at\":");
        push_u64(out, at);
    }
    out.extend_from_slice(b",\"revoked\":");
    out.extend_from_slice(if rec.revoked { b"true" } else { b"false" });
    out.extend_from_slice(b",\"token_value\":");
    push_string(out, &nfc(&rec.token_value));
    out.push(b'}');
}

/// Encode a slice of [`PairedExtension`] to a canonical JSON ARRAY (`[…]`), the
/// form the `paired_extensions` field carries inside `vault.prefs`. Records are
/// emitted sorted by `(extension_id, token_value)` so the encoding is byte-stable
/// regardless of caller order (the issue history's ordering is not the payload —
/// the host's `validate` keys on the three scalars, not on row position). The
/// caller omits the field entirely when the slice is empty, so this never emits
/// `[]`.
pub fn canonical_encode_paired_extensions(records: &[PairedExtension]) -> Vec<u8> {
    let mut refs: Vec<&PairedExtension> = records.iter().collect();
    refs.sort_by(|a, b| {
        a.extension_id
            .cmp(&b.extension_id)
            .then_with(|| a.token_value.cmp(&b.token_value))
    });
    let mut out = Vec::with_capacity(96 * refs.len().max(1));
    out.push(b'[');
    for (i, r) in refs.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        encode_record_into(&mut out, r);
    }
    out.push(b']');
    out
}

// ---- canonical JSON decoder -------------------------------------------------

/// Maximum JSON nesting depth accepted on decode. The input is
/// AEAD-authenticated and bounded by the 64 KiB `MYP1` cap; a depth guard is
/// cheap defense-in-depth against a pathologically-nested blob. A
/// `paired_extensions` array is exactly two levels deep (array → record object),
/// so this is generous.
const MAX_JSON_DEPTH: usize = 8;

/// Parse a canonical JSON ARRAY of paired-extension records starting at
/// `bytes[0] == '['`, returning the decoded records + the number of bytes
/// consumed (so the embedding `vault.prefs` codec can advance its cursor past
/// the array). Unknown record keys are ignored (forward-compat); a record
/// missing a required field, or a non-array top level, rejects.
pub fn parse_paired_extensions_array(
    bytes: &[u8],
) -> Result<(Vec<PairedExtension>, usize), PairedExtensionParseError> {
    let mut p = JsonParser::new(bytes);
    let v = p.parse_value()?;
    let arr = match v {
        JsonValue::Array(a) => a,
        _ => return Err(PairedExtensionParseError::WrongType),
    };
    let mut records = Vec::with_capacity(arr.len());
    for e in &arr {
        records.push(record_from_json(e)?);
    }
    Ok((records, p.i))
}

/// A minimal, dependency-free JSON value tree — only what the `PairedExtension`
/// schema needs (the same posture as [`crate::saved_view`]'s parser, kept
/// independent so the two codecs cannot silently diverge).
enum JsonValue {
    Bool(bool),
    Int(u64),
    Str(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
    Null,
}

struct JsonParser<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
}

impl<'a> JsonParser<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, i: 0, depth: 0 }
    }

    fn skip_ws(&mut self) {
        while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn parse_value(&mut self) -> Result<JsonValue, PairedExtensionParseError> {
        self.skip_ws();
        match self.b.get(self.i) {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => Ok(JsonValue::Str(self.parse_string()?)),
            Some(b't') | Some(b'f') => self.parse_bool(),
            Some(b'n') => self.parse_null(),
            Some(b'-') | Some(b'0'..=b'9') => self.parse_number(),
            _ => Err(PairedExtensionParseError::Malformed),
        }
    }

    fn enter(&mut self) -> Result<(), PairedExtensionParseError> {
        self.depth += 1;
        if self.depth > MAX_JSON_DEPTH {
            return Err(PairedExtensionParseError::Malformed);
        }
        Ok(())
    }

    fn parse_object(&mut self) -> Result<JsonValue, PairedExtensionParseError> {
        self.enter()?;
        self.i += 1; // consume '{'
        let mut out: Vec<(String, JsonValue)> = Vec::new();
        self.skip_ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            self.depth -= 1;
            return Ok(JsonValue::Object(out));
        }
        loop {
            self.skip_ws();
            if self.b.get(self.i) != Some(&b'"') {
                return Err(PairedExtensionParseError::Malformed);
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.b.get(self.i) != Some(&b':') {
                return Err(PairedExtensionParseError::Malformed);
            }
            self.i += 1;
            let val = self.parse_value()?;
            out.push((key, val));
            self.skip_ws();
            match self.b.get(self.i) {
                Some(&b',') => self.i += 1,
                Some(&b'}') => {
                    self.i += 1;
                    break;
                }
                _ => return Err(PairedExtensionParseError::Malformed),
            }
        }
        self.depth -= 1;
        Ok(JsonValue::Object(out))
    }

    fn parse_array(&mut self) -> Result<JsonValue, PairedExtensionParseError> {
        self.enter()?;
        self.i += 1; // consume '['
        let mut out: Vec<JsonValue> = Vec::new();
        self.skip_ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            self.depth -= 1;
            return Ok(JsonValue::Array(out));
        }
        loop {
            let val = self.parse_value()?;
            out.push(val);
            self.skip_ws();
            match self.b.get(self.i) {
                Some(&b',') => self.i += 1,
                Some(&b']') => {
                    self.i += 1;
                    break;
                }
                _ => return Err(PairedExtensionParseError::Malformed),
            }
        }
        self.depth -= 1;
        Ok(JsonValue::Array(out))
    }

    fn parse_string(&mut self) -> Result<String, PairedExtensionParseError> {
        self.i += 1; // consume opening '"'
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let c = *self
                .b
                .get(self.i)
                .ok_or(PairedExtensionParseError::Malformed)?;
            self.i += 1;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = *self
                        .b
                        .get(self.i)
                        .ok_or(PairedExtensionParseError::Malformed)?;
                    self.i += 1;
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
                            let cp = self.parse_hex4()?;
                            let ch = char::from_u32(cp as u32)
                                .ok_or(PairedExtensionParseError::Malformed)?;
                            let mut tmp = [0u8; 4];
                            buf.extend_from_slice(ch.encode_utf8(&mut tmp).as_bytes());
                        }
                        _ => return Err(PairedExtensionParseError::Malformed),
                    }
                }
                _ => buf.push(c),
            }
        }
        String::from_utf8(buf).map_err(|_| PairedExtensionParseError::Malformed)
    }

    fn parse_hex4(&mut self) -> Result<u16, PairedExtensionParseError> {
        let mut v: u16 = 0;
        for _ in 0..4 {
            let c = *self
                .b
                .get(self.i)
                .ok_or(PairedExtensionParseError::Malformed)?;
            self.i += 1;
            let d = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => return Err(PairedExtensionParseError::Malformed),
            };
            v = v * 16 + d as u16;
        }
        Ok(v)
    }

    fn parse_number(&mut self) -> Result<JsonValue, PairedExtensionParseError> {
        // A leading `-` is parsed-past for forward-compat (an unknown future
        // field could be negative) but its sign is not retained — the only
        // consumed int field (`paired_at`) is an unsigned Unix timestamp.
        if self.b.get(self.i) == Some(&b'-') {
            self.i += 1;
        }
        let digit_start = self.i;
        let mut val: u64 = 0;
        while let Some(&c) = self.b.get(self.i) {
            if !c.is_ascii_digit() {
                break;
            }
            val = val
                .checked_mul(10)
                .and_then(|v| v.checked_add((c - b'0') as u64))
                .ok_or(PairedExtensionParseError::Malformed)?;
            self.i += 1;
        }
        if self.i == digit_start {
            return Err(PairedExtensionParseError::Malformed);
        }
        // Float ban (§ 9.5.2): a fractional / exponent marker rejects.
        if matches!(self.b.get(self.i), Some(b'.') | Some(b'e') | Some(b'E')) {
            return Err(PairedExtensionParseError::Malformed);
        }
        Ok(JsonValue::Int(val))
    }

    fn parse_bool(&mut self) -> Result<JsonValue, PairedExtensionParseError> {
        if self.b[self.i..].starts_with(b"true") {
            self.i += 4;
            Ok(JsonValue::Bool(true))
        } else if self.b[self.i..].starts_with(b"false") {
            self.i += 5;
            Ok(JsonValue::Bool(false))
        } else {
            Err(PairedExtensionParseError::Malformed)
        }
    }

    fn parse_null(&mut self) -> Result<JsonValue, PairedExtensionParseError> {
        if self.b[self.i..].starts_with(b"null") {
            self.i += 4;
            Ok(JsonValue::Null)
        } else {
            Err(PairedExtensionParseError::Malformed)
        }
    }
}

fn find<'a>(obj: &'a [(String, JsonValue)], key: &str) -> Option<&'a JsonValue> {
    obj.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn as_object(v: &JsonValue) -> Result<&[(String, JsonValue)], PairedExtensionParseError> {
    match v {
        JsonValue::Object(o) => Ok(o),
        _ => Err(PairedExtensionParseError::WrongType),
    }
}

fn req_string(obj: &[(String, JsonValue)], key: &str) -> Result<String, PairedExtensionParseError> {
    match find(obj, key) {
        Some(JsonValue::Str(s)) => Ok(s.to_string()),
        Some(_) => Err(PairedExtensionParseError::WrongType),
        None => Err(PairedExtensionParseError::MissingField),
    }
}

fn req_bool(obj: &[(String, JsonValue)], key: &str) -> Result<bool, PairedExtensionParseError> {
    match find(obj, key) {
        Some(JsonValue::Bool(b)) => Ok(*b),
        Some(_) => Err(PairedExtensionParseError::WrongType),
        None => Err(PairedExtensionParseError::MissingField),
    }
}

/// An OPTIONAL `u64` field: `None` when absent (additive forward-compat),
/// `WrongType` when present but not an integer.
fn opt_u64(
    obj: &[(String, JsonValue)],
    key: &str,
) -> Result<Option<u64>, PairedExtensionParseError> {
    match find(obj, key) {
        Some(JsonValue::Int(n)) => Ok(Some(*n)),
        Some(_) => Err(PairedExtensionParseError::WrongType),
        None => Ok(None),
    }
}

fn record_from_json(v: &JsonValue) -> Result<PairedExtension, PairedExtensionParseError> {
    let obj = as_object(v)?;
    Ok(PairedExtension {
        extension_id: req_string(obj, "extension_id")?,
        token_value: req_string(obj, "token_value")?,
        revoked: req_bool(obj, "revoked")?,
        paired_at: opt_u64(obj, "paired_at")?,
    })
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::test_vector_fmt::{hex_lower, json_escape};
    use alloc::vec;

    fn rec(ext: &str, tok: &str, revoked: bool) -> PairedExtension {
        PairedExtension {
            extension_id: ext.into(),
            token_value: tok.into(),
            revoked,
            paired_at: None,
        }
    }

    fn rec_at(ext: &str, tok: &str, revoked: bool, at: u64) -> PairedExtension {
        PairedExtension {
            extension_id: ext.into(),
            token_value: tok.into(),
            revoked,
            paired_at: Some(at),
        }
    }

    #[test]
    fn canonical_bytes_are_stable() {
        let bytes = canonical_encode_paired_extensions(&[rec("ext-a", "deadbeef", false)]);
        let expected =
            "[{\"extension_id\":\"ext-a\",\"revoked\":false,\"token_value\":\"deadbeef\"}]";
        assert_eq!(core::str::from_utf8(&bytes).unwrap(), expected);
    }

    #[test]
    fn absent_paired_at_is_omitted_byte_identical_and_decodes_none() {
        // A `None` paired_at emits NO key — byte-identical to the pre-feature
        // form — and round-trips back to `None` (forward/backward compat).
        let bytes = canonical_encode_paired_extensions(&[rec("ext-a", "aa", false)]);
        assert!(!core::str::from_utf8(&bytes).unwrap().contains("paired_at"));
        let (decoded, _) = parse_paired_extensions_array(&bytes).unwrap();
        assert_eq!(decoded[0].paired_at, None);
    }

    #[test]
    fn paired_at_emits_in_canonical_position_and_round_trips() {
        // Key order is extension_id < paired_at < revoked < token_value.
        let bytes = canonical_encode_paired_extensions(&[rec_at(
            "ext-a",
            "deadbeef",
            false,
            1_700_000_000,
        )]);
        let expected = "[{\"extension_id\":\"ext-a\",\"paired_at\":1700000000,\"revoked\":false,\"token_value\":\"deadbeef\"}]";
        assert_eq!(core::str::from_utf8(&bytes).unwrap(), expected);
        let (decoded, consumed) = parse_paired_extensions_array(&bytes).unwrap();
        assert_eq!(consumed, bytes.len());
        assert_eq!(decoded[0].paired_at, Some(1_700_000_000));
    }

    #[test]
    fn paired_at_zero_emits_a_bare_zero() {
        let bytes = canonical_encode_paired_extensions(&[rec_at("a", "b", false, 0)]);
        assert!(core::str::from_utf8(&bytes)
            .unwrap()
            .contains("\"paired_at\":0,"));
        let (decoded, _) = parse_paired_extensions_array(&bytes).unwrap();
        assert_eq!(decoded[0].paired_at, Some(0));
    }

    #[test]
    fn paired_at_wrong_type_rejects() {
        let bad = b"[{\"extension_id\":\"x\",\"paired_at\":\"nope\",\"revoked\":false,\"token_value\":\"y\"}]";
        assert_eq!(
            parse_paired_extensions_array(bad),
            Err(PairedExtensionParseError::WrongType)
        );
    }

    #[test]
    fn no_insignificant_whitespace() {
        let bytes = canonical_encode_paired_extensions(&[rec("a", "b", true)]);
        assert!(!bytes.windows(2).any(|w| w == b", "));
        assert!(!bytes.windows(2).any(|w| w == b": "));
    }

    #[test]
    fn round_trips_records() {
        let records = vec![
            rec("ext-a", "aa11", false),
            rec("ext-b", "bb22", true),
            rec("ext-a", "cc33", false),
        ];
        let bytes = canonical_encode_paired_extensions(&records);
        let (decoded, consumed) = parse_paired_extensions_array(&bytes).unwrap();
        assert_eq!(consumed, bytes.len());
        // The decoded set equals the input set (order is canonicalized on
        // encode, so compare as a sorted multiset by re-encoding).
        let re = canonical_encode_paired_extensions(&decoded);
        assert_eq!(re, bytes);
        assert_eq!(decoded.len(), 3);
    }

    #[test]
    fn array_is_sorted_by_ext_then_token() {
        let forward =
            canonical_encode_paired_extensions(&[rec("b", "1", false), rec("a", "2", false)]);
        let shuffled =
            canonical_encode_paired_extensions(&[rec("a", "2", false), rec("b", "1", false)]);
        assert_eq!(forward, shuffled);
        let s = core::str::from_utf8(&forward).unwrap();
        assert!(
            s.find("\"extension_id\":\"a\"").unwrap() < s.find("\"extension_id\":\"b\"").unwrap()
        );
    }

    #[test]
    fn same_ext_sorts_by_token_value() {
        let forward =
            canonical_encode_paired_extensions(&[rec("a", "zz", false), rec("a", "aa", false)]);
        let s = core::str::from_utf8(&forward).unwrap();
        assert!(
            s.find("\"token_value\":\"aa\"").unwrap() < s.find("\"token_value\":\"zz\"").unwrap()
        );
    }

    #[test]
    fn parse_rejects_non_array_top_level() {
        let bad = b"{\"extension_id\":\"x\",\"revoked\":false,\"token_value\":\"y\"}";
        assert_eq!(
            parse_paired_extensions_array(bad),
            Err(PairedExtensionParseError::WrongType)
        );
    }

    #[test]
    fn parse_rejects_missing_required_field() {
        let bad = b"[{\"extension_id\":\"x\",\"revoked\":false}]"; // no token_value
        assert_eq!(
            parse_paired_extensions_array(bad),
            Err(PairedExtensionParseError::MissingField)
        );
    }

    #[test]
    fn parse_rejects_wrong_type_revoked() {
        let bad = b"[{\"extension_id\":\"x\",\"revoked\":\"nope\",\"token_value\":\"y\"}]";
        assert_eq!(
            parse_paired_extensions_array(bad),
            Err(PairedExtensionParseError::WrongType)
        );
    }

    #[test]
    fn parse_tolerates_unknown_future_key() {
        let pt = b"[{\"extension_id\":\"x\",\"future\":42,\"revoked\":true,\"token_value\":\"y\"}]";
        let (decoded, _) = parse_paired_extensions_array(pt).unwrap();
        assert_eq!(decoded.len(), 1);
        assert!(decoded[0].revoked);
        assert_eq!(decoded[0].extension_id, "x");
    }

    #[test]
    fn parse_consumes_only_the_array_when_trailing_present() {
        let bytes = canonical_encode_paired_extensions(&[rec("a", "b", false)]);
        let mut with_trailing = bytes.clone();
        with_trailing.extend_from_slice(b",\"screen_capture_protection\":true");
        let (decoded, consumed) = parse_paired_extensions_array(&with_trailing).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(consumed, bytes.len());
    }

    #[test]
    fn parse_rejects_float_in_unknown_field() {
        let bad = b"[{\"extension_id\":\"x\",\"n\":1.5,\"revoked\":false,\"token_value\":\"y\"}]";
        assert_eq!(
            parse_paired_extensions_array(bad),
            Err(PairedExtensionParseError::Malformed)
        );
    }

    #[test]
    fn nfc_normalizes_strings_on_encode() {
        // decomposed "é" (U+0065 U+0301) normalizes to composed U+00E9.
        let bytes = canonical_encode_paired_extensions(&[rec("e\u{0301}", "t", false)]);
        let (decoded, _) = parse_paired_extensions_array(&bytes).unwrap();
        assert_eq!(decoded[0].extension_id, "\u{00e9}");
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Maps a [`PairedExtensionParseError`] variant to its stable vector string.
    /// The runner in `protocol/tests/vectors.rs` carries the same map.
    fn vector_error_str(e: &PairedExtensionParseError) -> &'static str {
        match e {
            PairedExtensionParseError::Malformed => "malformed",
            PairedExtensionParseError::MissingField => "missing_field",
            PairedExtensionParseError::WrongType => "wrong_type",
            // No catch-all: `#[non_exhaustive]` does not apply within the
            // defining crate, so this stays exhaustive — a new variant breaks
            // the build here as the reminder to extend schema + runner map.
        }
    }

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/paired-extension/v0.1/cases.json` to
    /// `/tmp/myne_paired_extension_vectors.json`, ready to copy verbatim.
    ///
    /// `#[ignore]`. Run with:
    /// `cargo test -p protocol --lib emit_paired_extension_vectors_for_paste -- --ignored`
    ///
    /// Pins `parse_paired_extensions_array` — the prefs-embedding decoder for
    /// the `paired_extensions` field (browser-clipper pairing registry, §9.5.2).
    /// `parse_ok` cases pin the decoded record-set as its canonical re-encoding
    /// (note the encoder writes `token_value` explicitly despite its serde-skip)
    /// plus the `consumed` byte count; `parse_fail` cases pin the closed error
    /// surface (malformed / missing_field / wrong_type).
    #[test]
    #[ignore]
    fn emit_paired_extension_vectors_for_paste() {
        extern crate std;

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"paired-extension\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.5.2 (paired_extensions canonical JSON inside vault.prefs)\",\n");
        dump.push_str("  \"description\": \"Pins protocol::paired_extension::parse_paired_extensions_array — the canonical-JSON decoder for the paired_extensions array embedded in vault.prefs (browser-clipper pairing registry, MYND-329 family). parse_ok cases pin the decoded record-set as its canonical re-encoding (NFC folding + lexicographic key order + (extension_id, token_value)-sort; the additive optional paired_at is emitted only when present) plus the exact consumed byte count; parse_fail cases pin the closed error surface (malformed / missing_field / wrong_type). The bearer token_value is serde-skipped on the IPC boundary but written explicitly by the on-disk codec, so it round-trips here. Cases generated by `cargo test -p protocol --lib emit_paired_extension_vectors_for_paste -- --ignored`.\",\n");
        dump.push_str("  \"cases\": [\n");

        let emit_ok = |dump: &mut String, slug: &str, desc: &str, input: &[u8], trailing: bool| {
            let (records, consumed) = parse_paired_extensions_array(input)
                .unwrap_or_else(|e| panic!("[{slug}] parse_ok input did not parse: {e:?}"));
            let canonical = canonical_encode_paired_extensions(&records);
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"paired-extension/v0.1/{slug}\",\n"
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(desc)
            ));
            dump.push_str("      \"case_kind\": \"parse_ok\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_bytes_utf8_hex\": \"{}\",\n",
                hex_lower(input)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_consumed_len\": {consumed},\n"
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_canonical_utf8_hex\": \"{}\"\n",
                hex_lower(&canonical)
            ));
            dump.push_str(if trailing { "    },\n" } else { "    }\n" });
        };
        let emit_fail = |dump: &mut String,
                         slug: &str,
                         desc: &str,
                         input: &[u8],
                         want: PairedExtensionParseError,
                         trailing: bool| {
            let got = parse_paired_extensions_array(input)
                .expect_err(&alloc::format!("[{slug}] parse_fail input parsed Ok"));
            assert_eq!(
                got, want,
                "[{slug}] parse_fail variant disagrees with hand-written expectation"
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"paired-extension/v0.1/{slug}\",\n"
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(desc)
            ));
            dump.push_str("      \"case_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_bytes_utf8_hex\": \"{}\",\n",
                hex_lower(input)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_error\": \"{}\"\n",
                vector_error_str(&want)
            ));
            dump.push_str(if trailing { "    },\n" } else { "    }\n" });
        };

        // ---- parse_ok --------------------------------------------------
        emit_ok(&mut dump, "roundtrip-with-paired-at", "A record with the additive optional paired_at set round-trips canonically (key order extension_id < paired_at < revoked < token_value).", &canonical_encode_paired_extensions(&[rec_at("clipper@myne.md", "deadbeef", false, 1717000000)]), true);

        emit_ok(&mut dump, "roundtrip-no-paired-at", "A pre-feature record without paired_at is byte-identical to the legacy encoding (the field is omitted entirely).", &canonical_encode_paired_extensions(&[rec("ext-a", "aa", false)]), true);

        emit_ok(&mut dump, "multi-sorted", "Two records are emitted sorted by (extension_id, token_value) regardless of caller order.", &canonical_encode_paired_extensions(&[rec("b", "1", false), rec("a", "2", false)]), true);

        emit_ok(
            &mut dump,
            "revoked-true",
            "A revoked record round-trips with revoked:true.",
            &canonical_encode_paired_extensions(&[rec("a", "b", true)]),
            true,
        );

        emit_ok(
            &mut dump,
            "empty-array",
            "The empty array decodes to zero records and consumes exactly two bytes.",
            b"[]",
            true,
        );

        emit_ok(&mut dump, "nfc-fold-extension-id", "An extension_id carrying an NFD combining sequence folds to NFC in the canonical projection.", b"[{\"extension_id\":\"e\xcc\x81\",\"revoked\":false,\"token_value\":\"t\"}]", true);

        emit_ok(&mut dump, "unknown-field-tolerated", "An unknown future key on a record is ignored (forward-compat) and dropped from the canonical projection.", b"[{\"extension_id\":\"a\",\"future\":42,\"revoked\":false,\"token_value\":\"b\"}]", true);

        let mut trailing = canonical_encode_paired_extensions(&[rec("a", "b", false)]);
        trailing.extend_from_slice(b",\"x\"");
        emit_ok(&mut dump, "consumes-only-the-array-trailing", "Trailing bytes after the array are left for the caller: consumed reports only the array length.", &trailing, true);

        // ---- parse_fail ------------------------------------------------
        emit_fail(
            &mut dump,
            "non-array-top-level",
            "A top-level object where an array is required is rejected as wrong_type.",
            b"{\"extension_id\":\"a\",\"revoked\":false,\"token_value\":\"b\"}",
            PairedExtensionParseError::WrongType,
            true,
        );

        emit_fail(
            &mut dump,
            "missing-required-revoked",
            "A record missing the required revoked field is missing_field.",
            b"[{\"extension_id\":\"a\",\"token_value\":\"b\"}]",
            PairedExtensionParseError::MissingField,
            true,
        );

        emit_fail(
            &mut dump,
            "wrong-type-revoked",
            "revoked present as a string rather than a bool is wrong_type.",
            b"[{\"extension_id\":\"a\",\"revoked\":\"no\",\"token_value\":\"b\"}]",
            PairedExtensionParseError::WrongType,
            true,
        );

        emit_fail(
            &mut dump,
            "exponent-float-banned",
            "paired_at in exponent notation trips the canonical-JSON float ban — malformed.",
            b"[{\"extension_id\":\"a\",\"paired_at\":1e3,\"revoked\":false,\"token_value\":\"b\"}]",
            PairedExtensionParseError::Malformed,
            false,
        );

        dump.push_str("  ]\n}\n");

        std::fs::write("/tmp/myne_paired_extension_vectors.json", dump.as_bytes())
            .expect("write paired-extension vectors dump");
        std::eprintln!("[ok] wrote /tmp/myne_paired_extension_vectors.json");
    }
}
