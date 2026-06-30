//! `NoteId` — host-side UUIDv7 wrapper for note identifiers.
//!
//! Backend always generates `NoteId` via [`NoteId::new_v7`] inside
//! `note_create` (Task 8) and returns the canonical lowercase-hyphenated
//! 36-char form to the UI; the UI never produces a `NoteId` value (per
//! `decisions.md` 2026-05-07 "Note UUIDv7 backend-gen; UI never names
//! the destination"). [`NoteId::parse`] is the only re-entry point —
//! it validates UI-supplied input inside `note_read` (Task 9) before
//! the string ever reaches a path component.
//!
//! ## Strict parse contract
//!
//! [`NoteId::parse`] enforces five invariants in order:
//!
//! 1. exactly 36 chars → [`InvalidNoteIdCause::WrongLength`]
//! 2. every byte is lowercase ASCII letter, ASCII digit, or hyphen →
//!    [`InvalidNoteIdCause::InvalidChar`] (uppercase + special chars +
//!    non-ASCII rejected here)
//! 3. hyphens at fixed positions 8, 13, 18, 23 →
//!    [`InvalidNoteIdCause::WrongHyphenPosition`]
//! 4. [`uuid::Uuid::parse_str`] succeeds →
//!    [`InvalidNoteIdCause::ParseFailed`] (catches lowercase letters
//!    `g–z` that pass step 2 but are not hex)
//! 5. `uuid.get_version_num() == 7` →
//!    [`InvalidNoteIdCause::WrongVersion`] (rejects v4 and other
//!    versions)
//!
//! The strict contract delivers three structural defenses:
//!
//! - **Path-traversal:** UI strings can only become path components
//!   after `parse` succeeds; canonical lowercase-hyphenated form is
//!   the only shape that ever joins `notes_dir`.
//! - **Filesystem case-sensitivity:** APFS (case-insensitive default)
//!   vs ext4 / btrfs (case-sensitive) inconsistency is structurally
//!   impossible — `aBC...` rejects with `InvalidChar` before any path
//!   join.
//! - **Backend-gen v7-only contract:** UI cannot inject a v4 (or any
//!   non-v7) UUID and have it routed to a real file — `WrongVersion`
//!   double-pins the 2026-05-07 backend-gen discipline.
//!
//! ## Tracing boundary
//!
//! Each rejection branch returns a distinct [`InvalidNoteIdCause`] so
//! ops debugging can disambiguate via
//! `tracing::debug!(stage = ?cause)`. The cause is `pub(crate)` and
//! never crosses the IPC boundary; the consuming Tauri command (Tasks
//! 8 / 9) collapses all five to the public `InvalidNoteId` variant of
//! `NoteCreateError` / `NoteReadError`. This mirrors the unlock-error
//! discipline pinned by `decisions.md` 2026-05-02.

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

/// Host-side per-note identifier — UUIDv7 wrapper.
///
/// Construct via [`NoteId::new_v7`] (server-side generation, the only
/// production path) or [`NoteId::parse`] (validating UI-supplied
/// input). Never construct directly from a `Uuid` outside this module —
/// the type's purpose is to gate every `Uuid` that flows into a path
/// component or AAD field through the strict-parse contract above.
///
/// `Display` emits the canonical lowercase-hyphenated 36-char form (the
/// shape `parse` accepts) so `format!("{note_id}.myn")` produces a
/// filename ready for the `notes/` directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NoteId(Uuid);

impl NoteId {
    /// Generate a fresh UUIDv7 NoteId. The only production constructor —
    /// called by `note_create` (Task 8) to mint the destination
    /// identifier server-side.
    pub fn new_v7() -> Self {
        NoteId(Uuid::now_v7())
    }

    /// Strict parse — see the module-level docs for the five rejection
    /// branches and the structural defenses they deliver.
    ///
    /// Used by `note_read` (Task 9) to validate UI-supplied note-id
    /// strings before any path concatenation.
    pub fn parse(s: &str) -> Result<Self, InvalidNoteIdCause> {
        if s.len() != 36 {
            return Err(InvalidNoteIdCause::WrongLength);
        }
        // Charset filter: lowercase letter, digit, or hyphen. Catches
        // uppercase, special chars, non-ASCII. Lowercase letters `g-z`
        // pass this filter and are caught by the `Uuid::parse_str` step
        // below (`ParseFailed`).
        if !s
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(InvalidNoteIdCause::InvalidChar);
        }
        // Hyphen positions are fixed by the canonical UUID format.
        for &i in &[8usize, 13, 18, 23] {
            if s.as_bytes()[i] != b'-' {
                return Err(InvalidNoteIdCause::WrongHyphenPosition);
            }
        }
        let uuid = Uuid::parse_str(s).map_err(|_| InvalidNoteIdCause::ParseFailed)?;
        if uuid.get_version_num() != 7 {
            return Err(InvalidNoteIdCause::WrongVersion);
        }
        Ok(NoteId(uuid))
    }

    /// Borrow the underlying [`Uuid`]. Use this when interfacing with
    /// `protocol::encode_new_note` / `decode_note` (which take a 16-byte
    /// note_uuid) via `as_uuid().as_bytes()`.
    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl core::fmt::Display for NoteId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // Hyphenated lowercase 36-char form — the shape `parse` accepts.
        // Round-trip safe by construction.
        write!(f, "{}", self.0.hyphenated())
    }
}

impl Serialize for NoteId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0.hyphenated())
    }
}

impl<'de> Deserialize<'de> for NoteId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::parse(&s).map_err(|cause| {
            // Deserialize errors are crate-internal (not IPC user-
            // facing); embedding the cause is diagnostic-only and does
            // NOT widen the public boundary surface.
            de::Error::custom(format!("invalid NoteId: {cause:?}"))
        })
    }
}

/// Internal — emitted as a `tracing` stage tag, never crosses IPC.
///
/// Each variant pinpoints which `NoteId::parse` rejection branch fired.
/// Consuming Tauri commands (Tasks 8 / 9) collapse all five to a single
/// public `InvalidNoteId` variant per the boundary policy in
/// `decisions.md` 2026-05-07.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidNoteIdCause {
    WrongLength,
    InvalidChar,
    WrongHyphenPosition,
    ParseFailed,
    WrongVersion,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- new_v7 + Display + as_uuid ------------------------------------

    #[test]
    fn new_v7_produces_v7_uuid() {
        let id = NoteId::new_v7();
        assert_eq!(id.as_uuid().get_version_num(), 7);
    }

    #[test]
    fn new_v7_round_trips_through_display_and_parse() {
        let id = NoteId::new_v7();
        let s = format!("{id}");
        assert_eq!(s.len(), 36);
        let parsed = NoteId::parse(&s).expect("Display output must round-trip through parse");
        assert_eq!(parsed, id);
    }

    #[test]
    fn display_emits_canonical_lowercase_hyphenated_form() {
        // Hand-crafted v7-shaped UUID with all hex letters in the
        // alphabetic range so case-sensitivity is observable.
        let s = "01970e83-4f2f-7abc-8def-000000000000";
        let id = NoteId::parse(s).unwrap();
        assert_eq!(format!("{id}"), s);
    }

    // ---- parse_canonical_form_succeeds ---------------------------------

    #[test]
    fn parse_accepts_canonical_v7_uuid() {
        let s = "01970e83-4f2f-7000-8000-000000000000";
        let id = NoteId::parse(s).expect("canonical v7 form must parse");
        assert_eq!(id.as_uuid().get_version_num(), 7);
    }

    // ---- WrongLength ---------------------------------------------------

    #[test]
    fn parse_rejects_wrong_length_too_short() {
        assert_eq!(
            NoteId::parse("01970e83-4f2f-7000-8000-00000000000").unwrap_err(),
            InvalidNoteIdCause::WrongLength,
        );
    }

    #[test]
    fn parse_rejects_wrong_length_too_long() {
        assert_eq!(
            NoteId::parse("01970e83-4f2f-7000-8000-0000000000000").unwrap_err(),
            InvalidNoteIdCause::WrongLength,
        );
    }

    #[test]
    fn parse_rejects_wrong_length_empty() {
        assert_eq!(
            NoteId::parse("").unwrap_err(),
            InvalidNoteIdCause::WrongLength,
        );
    }

    // ---- InvalidChar ---------------------------------------------------

    #[test]
    fn parse_rejects_uppercase_canonical_form_as_invalid_char() {
        // Filesystem case-sensitivity defense — APFS/ext4 inconsistency
        // structurally prevented at the parser.
        assert_eq!(
            NoteId::parse("01970E83-4F2F-7000-8000-000000000000").unwrap_err(),
            InvalidNoteIdCause::InvalidChar,
        );
    }

    #[test]
    fn parse_rejects_special_char_as_invalid_char() {
        // Length 36, hyphens at right positions, but `!` at position 0.
        let s = "!1970e83-4f2f-7000-8000-000000000000";
        assert_eq!(s.len(), 36);
        assert_eq!(
            NoteId::parse(s).unwrap_err(),
            InvalidNoteIdCause::InvalidChar,
        );
    }

    // ---- WrongHyphenPosition -------------------------------------------

    #[test]
    fn parse_rejects_hyphen_at_wrong_position() {
        // Length 36, all chars are lowercase-hex-or-hyphen, but the
        // hyphen at position 8 has been moved to position 7 (and
        // position 8 holds a digit).
        let s = "0197e83-44f2f-7000-8000-000000000000";
        assert_eq!(s.len(), 36);
        assert_eq!(
            NoteId::parse(s).unwrap_err(),
            InvalidNoteIdCause::WrongHyphenPosition,
        );
    }

    #[test]
    fn parse_rejects_missing_hyphen_at_position_23() {
        // Position 23 should be a hyphen; replace with a digit.
        let s = "01970e83-4f2f-7000-8000a000000000000";
        assert_eq!(s.len(), 36);
        assert_eq!(
            NoteId::parse(s).unwrap_err(),
            InvalidNoteIdCause::WrongHyphenPosition,
        );
    }

    // ---- ParseFailed ---------------------------------------------------

    #[test]
    fn parse_returns_parse_failed_for_non_hex_lowercase_letters() {
        // `g` at position 14: passes the `is_ascii_lowercase` filter,
        // hyphens at canonical positions, but `g` is not hex →
        // `Uuid::parse_str` rejects → `ParseFailed`.
        let s = "01970e83-4f2f-g000-8000-000000000000";
        assert_eq!(s.len(), 36);
        assert_eq!(
            NoteId::parse(s).unwrap_err(),
            InvalidNoteIdCause::ParseFailed,
        );
    }

    // ---- WrongVersion --------------------------------------------------

    #[test]
    fn parse_rejects_v4_uuid_as_wrong_version() {
        // Standard v4 UUID — version nibble = 4 at position 14.
        let s = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(s.len(), 36);
        let id = uuid::Uuid::parse_str(s).unwrap();
        assert_eq!(id.get_version_num(), 4, "fixture is genuinely a v4 UUID");

        assert_eq!(
            NoteId::parse(s).unwrap_err(),
            InvalidNoteIdCause::WrongVersion,
        );
    }

    #[test]
    fn parse_rejects_nil_uuid_as_wrong_version() {
        // The Nil UUID is technically version 0 → not v7.
        let s = "00000000-0000-0000-0000-000000000000";
        assert_eq!(
            NoteId::parse(s).unwrap_err(),
            InvalidNoteIdCause::WrongVersion,
        );
    }

    // ---- ordering: WrongLength fires before InvalidChar ----------------
    //
    // Length is the first invariant; a 35-char uppercase string fails
    // with WrongLength, not InvalidChar. This pins the order so a future
    // refactor that drops the length pre-check would be caught here.

    #[test]
    fn parse_wrong_length_fires_before_invalid_char() {
        let s = "01970E83-4F2F-7000-8000-00000000000"; // length 35, also uppercase
        assert_eq!(s.len(), 35);
        assert_eq!(
            NoteId::parse(s).unwrap_err(),
            InvalidNoteIdCause::WrongLength,
        );
    }

    // ---- Serialize / Deserialize round-trip ----------------------------

    #[test]
    fn serialize_emits_canonical_lowercase_hyphenated_string() {
        let id = NoteId::parse("01970e83-4f2f-7000-8000-000000000000").unwrap();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"01970e83-4f2f-7000-8000-000000000000\"");
    }

    #[test]
    fn deserialize_round_trips_canonical_form() {
        let id = NoteId::new_v7();
        let json = serde_json::to_string(&id).unwrap();
        let parsed: NoteId = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, id);
    }

    #[test]
    fn deserialize_rejects_uppercase() {
        let json = "\"01970E83-4F2F-7000-8000-000000000000\"";
        let result: Result<NoteId, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "Deserialize must reject uppercase form (mirror of NoteId::parse strictness)"
        );
    }

    #[test]
    fn deserialize_rejects_v4_uuid() {
        let json = "\"550e8400-e29b-41d4-a716-446655440000\"";
        let result: Result<NoteId, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "Deserialize must reject v4 UUID (version-7 contract)"
        );
    }

    // ---- InvalidNoteIdCause Debug formatting ---------------------------
    //
    // The cause enum's Debug output is the tracing stage tag value;
    // pinning it here means a future Debug-impl change (e.g., switching
    // to a derived format that adds prefixes) is caught at test time
    // before it leaks into ops dashboards.

    #[test]
    fn invalid_note_id_cause_debug_emits_bare_variant_name() {
        assert_eq!(
            format!("{:?}", InvalidNoteIdCause::WrongLength),
            "WrongLength"
        );
        assert_eq!(
            format!("{:?}", InvalidNoteIdCause::InvalidChar),
            "InvalidChar"
        );
        assert_eq!(
            format!("{:?}", InvalidNoteIdCause::WrongHyphenPosition),
            "WrongHyphenPosition"
        );
        assert_eq!(
            format!("{:?}", InvalidNoteIdCause::ParseFailed),
            "ParseFailed"
        );
        assert_eq!(
            format!("{:?}", InvalidNoteIdCause::WrongVersion),
            "WrongVersion"
        );
    }

    /// ADVERSARIAL (filesystem path-injection): `NoteId::parse` is the
    /// WebView->host (TB6) gate for the string that becomes the on-disk
    /// `notes/<id>.myn` filename. Every traversal / separator / escape
    /// attempt must be rejected so a hostile or buggy frontend can never
    /// steer a read/write outside the `notes/` directory.
    #[test]
    fn adversarial_path_injection_note_ids_all_rejected() {
        let attacks = [
            "../../../../etc/passwd",
            "/etc/passwd",
            "..\\..\\windows\\system32\\config",
            "0000000000007000800000000000002e/..", // embedded traversal
            "0000/0000-7000-8000-000000000000",    // slash at a hyphen slot
            "0000000000007000.8000.000000000000.", // dots
            "%2e%2e%2f%2e%2e%2fetc%2fpasswd",      // url-encoded traversal
            "0000000000007000800000000000000\0",   // null byte
            "AABBCCDD-0000-7000-8000-000000000000", // uppercase hex
            "",                                    // empty
            "....................................", // 36 dots: right length, bad charset
            "/../../../../../../../../../tmp/x.myn",
        ];
        for a in attacks {
            assert!(
                NoteId::parse(a).is_err(),
                "PATH INJECTION: hostile note_id {a:?} was accepted by the TB6 gate"
            );
        }
    }

    /// A parsed `NoteId` always renders as a canonical 36-char hyphenated
    /// hex UUID — so the derived `{uuid}.myn` filename can never carry a
    /// path separator or traversal sequence, whatever the input was.
    #[test]
    fn adversarial_parsed_note_id_filename_is_separator_free() {
        for _ in 0..1000 {
            let id = NoteId::new_v7();
            let rendered = id.as_uuid().to_string();
            assert_eq!(rendered.len(), 36, "uuid render must be 36 chars");
            assert!(
                rendered.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'),
                "non-path-safe char in rendered uuid: {rendered}"
            );
            assert!(
                !rendered.contains('/') && !rendered.contains('\\') && !rendered.contains(".."),
                "path separator/traversal in rendered uuid: {rendered}"
            );
        }
    }
}
