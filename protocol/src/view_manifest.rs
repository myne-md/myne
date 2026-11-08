// SPDX-License-Identifier: AGPL-3.0

//! The view manifest (`.myneview`): one [`SavedView`] as a canonical JSON
//! object, read **strictly** because the bytes are a file somebody handed the
//! app (`view-manifests`; `myne-agents/docs/spec/protocol.md` §9.5.2).
//!
//! ## Two readers, two postures, and the split is the point
//!
//! [`crate::saved_view::parse_saved_views_array_with_opaque`] reads the
//! `saved_views` array out of the synced `vault.prefs` blob and is deliberately
//! **tolerant**: those bytes were written by a peer of the same major version,
//! so an unknown key is a newer client's content and is stepped over, and an
//! entry this build cannot represent is retained verbatim (§9.5.2, §9.5.5).
//!
//! This module reads the same shape from a FILE. An unknown key here is a
//! refusal that NAMES the key rather than a key quietly dropped. Tolerating it
//! would make "what you were shown is what you get" unenforceable: a manifest
//! carrying `template` would import as a view that does less than its author
//! believed, silently. Strictness is also what makes ADDING a key later safe,
//! because an older client refuses such a manifest with a reason a person can
//! act on instead of discarding half of it.
//!
//! The two postures must not be conflated in either direction. Strictness on
//! the stored blob would make one newer client's key unreadable to the whole
//! vault, and tolerance on a manifest would let a declaration evaporate on
//! import. `the_prefs_codec_stays_tolerant_where_the_manifest_reader_refuses`
//! holds both halves in one place, because either one alone reads as an
//! accident.
//!
//! ## What this module deliberately does NOT decide
//!
//! Whether a `write_fields` key exists as a property in THIS vault, and whether
//! the view is approved on THIS device. Both need the property index and the
//! prefs blob, neither of which a pure codec has. This module answers one
//! question ("is this file a manifest this build can represent, and does it
//! declare anything the host owns?") and the import command composes the rest.

use crate::saved_view::{
    as_object, find, parse_exactly_one, saved_view_from_json, SavedView, SavedViewParseError,
};
use alloc::string::String;
use serde::Serialize;
use thiserror::Error;

/// Frontmatter markers the HOST owns. A manifest may not declare any of them
/// writable, because a view that could write them could hide its own notes from
/// the vault.
///
/// Frozen, and it is a closed list rather than a rule about a prefix: the point
/// is that the app's own markers are known exhaustively here, so a new one is an
/// edit to this constant rather than a value somebody remembers to exclude at
/// the import site.
pub const RESERVED_WRITE_FIELDS: [&str; 3] = ["archived", "deleted", "trashed"];

/// Upper bound on a manifest's bytes.
///
/// The same 64 KiB plaintext cap the enclosing `vault.prefs` blob enforces
/// (§9.5.4), applied HERE so an oversized file is refused with a reason that
/// names the actual problem. Letting it through would surface later as the prefs
/// encoder's own failure, which cannot say why.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;

/// Every top-level key a manifest may carry: the canonical `SavedView` key set
/// of §9.5.2 and nothing else.
///
/// Kept as a literal so an unknown key can be REFUSED before the shared decode
/// sees it, and locked to the encoder by
/// `known_keys_equals_the_keys_the_encoder_emits`: that test parses a
/// fully-populated view's canonical bytes and compares the key set both ways, so
/// a field added to [`SavedView`] without a matching entry here fails a test
/// rather than silently becoming an unknown key that refuses every manifest.
pub const MANIFEST_KEYS: [&str; 14] = [
    "card_size",
    "columns",
    "filters",
    "group_by",
    "id",
    "image",
    "image_aspect_ratio",
    "lanes",
    "name",
    "sort",
    "template",
    "version",
    "view_type",
    "write_fields",
];

/// Closed failure surface of [`parse_view_manifest`].
///
/// `#[serde(tag = "kind", content = "detail")]` because this reaches the import
/// dialog, which renders the reason. Two variants carry a value and both are
/// deliberate: `UnknownKey` carries the offending key so the refusal can name it
/// (the requirement, not a convenience), and `ReservedWriteField` carries the
/// matched marker as a `&'static str` so it can only ever be one of
/// [`RESERVED_WRITE_FIELDS`], so the type makes it impossible for this variant to
/// echo arbitrary text out of a file.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
#[non_exhaustive]
pub enum ViewManifestError {
    /// A top-level key this format does not define, carried so the refusal can
    /// name it. This is the arm that makes a later additive key safe: an older
    /// client says which key it does not know rather than importing a manifest
    /// minus that key. `lanes` and `template` arrived through it, which is why
    /// both are in [`MANIFEST_KEYS`] and a fresh key is not.
    #[error("the manifest carries an unknown key")]
    UnknownKey(String),
    /// A `write_fields` entry naming a marker the host owns.
    #[error("the manifest declares a host-owned field as writable")]
    ReservedWriteField(&'static str),
    /// No `version` key. Required on this path only: a stored view without one
    /// still decodes, because §9.5.2's additive discipline applies to the blob.
    /// A FILE without one cannot be ordered against the definition this vault
    /// holds, so it is refused rather than guessed at.
    #[error("the manifest declares no version")]
    VersionRequired,
    /// Larger than [`MAX_MANIFEST_BYTES`].
    #[error("the manifest is larger than the prefs plaintext cap allows")]
    TooLarge,
    /// The bytes are not well-formed canonical JSON (bad structure, a forbidden
    /// float, trailing junk, or over-deep nesting).
    #[error("the manifest is not well-formed canonical JSON")]
    Malformed,
    /// A required field is absent.
    #[error("the manifest is missing a required field")]
    MissingField,
    /// A field is present at the wrong JSON type.
    #[error("a manifest field has the wrong JSON type")]
    WrongType,
    /// A value outside the closed allow-list: an unknown `view_type`, filter
    /// kind, comparison operator or sort direction.
    #[error("the manifest carries a value this build cannot represent")]
    Unrepresentable,
}

/// Read a `.myneview` manifest: exactly one canonical JSON object, every key in
/// [`MANIFEST_KEYS`], a `version` present, and no `write_fields` entry naming a
/// host-owned marker.
///
/// Reachable only from the import command. Nothing on the `vault.prefs` read or
/// write path calls it, deliberately: see this module's header.
pub fn parse_view_manifest(bytes: &[u8]) -> Result<SavedView, ViewManifestError> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(ViewManifestError::TooLarge);
    }
    let value = parse_exactly_one(bytes)?;
    let obj = as_object(&value)?;

    // Unknown keys FIRST, before the shared decode, so the refusal names the key
    // rather than reporting a generic shape error the author cannot act on.
    for (key, _) in obj {
        if !MANIFEST_KEYS.contains(&key.as_str()) {
            return Err(ViewManifestError::UnknownKey(key.clone()));
        }
    }

    let view = saved_view_from_json(&value)?;

    // `version` is required here and only here. Read from the object rather than
    // from `view.version` so the refusal can distinguish "absent" (this arm)
    // from "present at the wrong type" (already `WrongType` above).
    if find(obj, "version").is_none() {
        return Err(ViewManifestError::VersionRequired);
    }

    for field in &view.write_fields {
        if let Some(marker) = RESERVED_WRITE_FIELDS.iter().find(|m| *m == field) {
            return Err(ViewManifestError::ReservedWriteField(marker));
        }
    }

    Ok(view)
}

/// The shared decode maps its four arms onto this module's enum. Kept as an
/// `impl From` rather than an inline `map_err` so the two surfaces cannot drift
/// arm by arm at a call site.
impl From<SavedViewParseError> for ViewManifestError {
    fn from(e: SavedViewParseError) -> Self {
        match e {
            SavedViewParseError::Malformed => ViewManifestError::Malformed,
            SavedViewParseError::MissingField => ViewManifestError::MissingField,
            SavedViewParseError::WrongType => ViewManifestError::WrongType,
            SavedViewParseError::Unrepresentable => ViewManifestError::Unrepresentable,
        }
    }
}
/// A view is **approved** on this device when the version this device approved
/// equals the definition's current version.
///
/// One helper, because the whole "no version bump and no explicit clear step"
/// property rests on the comparison happening in exactly one place. A version
/// bump therefore revokes approval by construction: the stored approval names
/// the old number and nothing has to remember to clear it.
///
/// **A view with no version counts as approved**, and the reasoning is worth
/// stating because the opposite reading is also defensible. `version` is absent
/// only on a view authored before the field existed, and the import reader
/// refuses a manifest without one, so no ARRIVING definition can be
/// version-less: absence means "this vault authored this view before the
/// feature existed", and there is nobody to ask because nobody sent it. Reading
/// it as unapproved would put every pre-existing view behind a gate on the day
/// the feature ships. The fail-closed side is the import path, and it is closed
/// there by `VersionRequired` rather than by this comparison.
pub fn is_view_approved(
    approvals: &alloc::collections::BTreeMap<String, u64>,
    view: &SavedView,
) -> bool {
    match view.version {
        Some(version) => approvals.get(&view.id) == Some(&u64::from(version)),
        None => true,
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::saved_view::{
        canonical_encode_saved_view, canonical_encode_saved_views_with_opaque,
        parse_saved_views_array_with_opaque, FilterNode, SavedView, ViewType,
    };
    use alloc::collections::BTreeMap;
    use alloc::string::ToString;
    use alloc::vec;
    use alloc::vec::Vec;

    fn view() -> SavedView {
        SavedView {
            id: "v1".into(),
            name: "Books".into(),
            view_type: ViewType::Table,
            filters: FilterNode::All,
            sort: None,
            group_by: None,
            columns: vec!["author".into()],
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: Some(2),
            write_fields: vec!["rating".into()],
            lanes: Vec::new(),
            template: None,
        }
    }

    /// A view with every optional field populated, for the key-set lock.
    fn fully_populated() -> SavedView {
        SavedView {
            id: "v1".into(),
            name: "Books".into(),
            view_type: ViewType::Cards,
            filters: FilterNode::All,
            sort: Some(crate::saved_view::ViewSort {
                key: "finished".into(),
                direction: crate::saved_view::SortDirection::Desc,
            }),
            group_by: Some("status".into()),
            lanes: vec!["Backlog".into(), "Doing".into(), "Done".into()],
            columns: vec!["author".into()],
            card_size: Some(300),
            image: Some("cover".into()),
            image_aspect_ratio: Some("1.65".into()),
            version: Some(1),
            write_fields: vec!["rating".into()],
            template: Some("01J8Z".into()),
        }
    }

    // ---- the strict reader's four refusals ------------------------------

    #[test]
    fn unknown_top_level_key_is_refused_by_name() {
        let bad = br#"{"filters":{"kind":"all"},"id":"v1","name":"n","version":1,"view_type":"table","wip_limit":3}"#;
        assert_eq!(
            parse_view_manifest(bad),
            Err(ViewManifestError::UnknownKey("wip_limit".to_string()))
        );
    }

    #[test]
    fn reserved_write_field_is_refused_not_dropped() {
        for marker in RESERVED_WRITE_FIELDS {
            let json = alloc::format!(
                "{{\"filters\":{{\"kind\":\"all\"}},\"id\":\"v1\",\"name\":\"n\",\
                 \"version\":1,\"view_type\":\"table\",\"write_fields\":[\"{marker}\"]}}"
            );
            assert_eq!(
                parse_view_manifest(json.as_bytes()),
                Err(ViewManifestError::ReservedWriteField(marker)),
                "reserved marker {marker} must be refused, not stored"
            );
        }
        // A declaration that merely CONTAINS the marker text is fine: the rule is
        // an exact key, not a substring.
        let ok = br#"{"filters":{"kind":"all"},"id":"v1","name":"n","version":1,"view_type":"table","write_fields":["archived_at"]}"#;
        assert!(parse_view_manifest(ok).is_ok());
    }

    #[test]
    fn absent_version_is_refused_on_the_manifest_path() {
        let no_version = br#"{"filters":{"kind":"all"},"id":"v1","name":"n","view_type":"table"}"#;
        assert_eq!(
            parse_view_manifest(no_version),
            Err(ViewManifestError::VersionRequired)
        );
    }

    #[test]
    fn wrong_type_is_refused() {
        // `version` as a string, and `write_fields` as a string rather than an
        // array. Both are the shared decode's WrongType arm reaching here.
        let bad_version =
            br#"{"filters":{"kind":"all"},"id":"v1","name":"n","version":"2","view_type":"table"}"#;
        assert_eq!(
            parse_view_manifest(bad_version),
            Err(ViewManifestError::WrongType)
        );
        let bad_fields = br#"{"filters":{"kind":"all"},"id":"v1","name":"n","version":1,"view_type":"table","write_fields":"rating"}"#;
        assert_eq!(
            parse_view_manifest(bad_fields),
            Err(ViewManifestError::WrongType)
        );
    }

    #[test]
    fn oversized_manifest_is_refused_by_the_cap() {
        // One byte over the prefs plaintext cap. A real view never approaches it;
        // the arm exists so the refusal names the size rather than surfacing as
        // the prefs encoder's generic failure later.
        let mut bytes = vec![b' '; MAX_MANIFEST_BYTES + 1];
        bytes[MAX_MANIFEST_BYTES] = b' ';
        assert_eq!(
            parse_view_manifest(&bytes),
            Err(ViewManifestError::TooLarge)
        );
    }

    #[test]
    fn trailing_bytes_are_refused() {
        let mut bytes = canonical_encode_saved_view(&view());
        bytes.extend_from_slice(b"{}");
        assert_eq!(
            parse_view_manifest(&bytes),
            Err(ViewManifestError::Malformed)
        );
    }

    // ---- the two postures, held in one place ----------------------------

    #[test]
    fn the_prefs_codec_stays_tolerant_where_the_manifest_reader_refuses() {
        // ONE input, two readers, opposite outcomes on purpose. The stored blob
        // is a peer's bytes, so an unknown key and a missing version are both
        // stepped over; a FILE is somebody else's declaration, so both refuse.
        // Asserting only the strict half would let the tolerant half drift into
        // strictness (which would make one newer client's key fail a whole prefs
        // parse) and asserting only the tolerant half would let a manifest lose
        // its declaration silently.
        let stored = concat!(
            "[{\"filters\":{\"kind\":\"all\"},\"id\":\"v1\",\"name\":\"n\",",
            "\"wip_limit\":{\"x\":1},\"view_type\":\"table\"}]"
        )
        .as_bytes();
        let (views, opaque, _) =
            parse_saved_views_array_with_opaque(stored).expect("prefs codec tolerates both");
        assert_eq!(views.len(), 1);
        assert!(opaque.is_empty());
        assert_eq!(views[0].version, None);
        assert!(views[0].write_fields.is_empty());
        // …and the tolerant path DROPS the unknown key on re-encode, which is the
        // §9.5.2 forward-compat behaviour and not a second opinion about it.
        assert_eq!(
            canonical_encode_saved_views_with_opaque(&views, &opaque),
            b"[{\"filters\":{\"kind\":\"all\"},\"id\":\"v1\",\"name\":\"n\",\"view_type\":\"table\"}]"
        );

        let manifest = concat!(
            "{\"filters\":{\"kind\":\"all\"},\"id\":\"v1\",\"name\":\"n\",",
            "\"wip_limit\":{\"x\":1},\"view_type\":\"table\"}"
        )
        .as_bytes();
        assert_eq!(
            parse_view_manifest(manifest),
            Err(ViewManifestError::UnknownKey("wip_limit".to_string()))
        );
    }

    #[test]
    fn a_stored_view_without_a_version_still_decodes() {
        // The compatibility direction of `VersionRequired`: the requirement
        // belongs to the file, never to the blob, or every vault written before
        // this feature would fail to parse its own views.
        let stored = br#"[{"filters":{"kind":"all"},"id":"v1","name":"n","view_type":"table"}]"#;
        let (views, _, _) = parse_saved_views_array_with_opaque(stored).expect("decode");
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].version, None);
    }

    // ---- the key-set lock ----------------------------------------------

    #[test]
    fn known_keys_equals_the_keys_the_encoder_emits() {
        // Both directions, over the encoder's own output rather than a
        // hand-written list beside it: a field added to `SavedView` and not to
        // `MANIFEST_KEYS` would refuse every manifest carrying it, and a key in
        // `MANIFEST_KEYS` the encoder never emits is a name this format does not
        // have.
        let bytes = canonical_encode_saved_view(&fully_populated());
        let parsed = parse_exactly_one(&bytes).expect("own encoder output parses");
        let obj = as_object(&parsed).expect("object");
        let mut emitted: Vec<&str> = obj.iter().map(|(k, _)| k.as_str()).collect();
        emitted.sort_unstable();
        let mut declared: Vec<&str> = MANIFEST_KEYS.to_vec();
        declared.sort_unstable();
        assert_eq!(emitted, declared);

        // A fully-populated view is a manifest, and it round-trips.
        assert_eq!(parse_view_manifest(&bytes), Ok(fully_populated()));
    }

    #[test]
    fn round_trips_a_manifest_with_both_new_fields() {
        let v = view();
        let bytes = canonical_encode_saved_view(&v);
        assert_eq!(parse_view_manifest(&bytes), Ok(v));
    }

    #[test]
    fn a_manifest_carrying_the_board_keys_is_accepted_not_refused() {
        // The other half of the unknown-key rule: a key this format KNOWS is
        // imported rather than refused. Both board keys are additive, so a
        // definition written by this build must be readable by this build, and a
        // manifest carrying them must not fall into the `wip_limit` arm above.
        let v = SavedView {
            view_type: ViewType::Cards,
            group_by: Some("status".into()),
            lanes: vec!["Backlog".into(), "Doing".into(), "Done".into()],
            template: Some("01J8ZTEMPLATE".into()),
            write_fields: vec!["status".into()],
            ..fully_populated()
        };
        let bytes = canonical_encode_saved_view(&v);
        assert_eq!(parse_view_manifest(&bytes), Ok(v));
        // The declared order survives an export and a re-import, which is the
        // property the board depends on.
        assert_eq!(
            parse_view_manifest(&bytes).unwrap().lanes,
            vec![
                "Backlog".to_string(),
                "Doing".to_string(),
                "Done".to_string()
            ]
        );
    }

    #[test]
    fn both_fields_are_omitted_when_absent_so_a_pre_feature_view_is_unchanged() {
        // The byte-identity claim: a view that carries neither field encodes
        // exactly as it did before this format existed. `had_no_manifest_fields`
        // is the pre-feature shape, spelled out as a literal because the point is
        // the BYTES, not the struct.
        let expected =
            b"{\"filters\":{\"kind\":\"all\"},\"id\":\"v1\",\"name\":\"n\",\"view_type\":\"table\"}";
        let pre_feature = SavedView {
            id: "v1".into(),
            name: "n".into(),
            view_type: ViewType::Table,
            filters: FilterNode::All,
            sort: None,
            group_by: None,
            columns: Vec::new(),
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: None,
            write_fields: Vec::new(),
            lanes: Vec::new(),
            template: None,
        };
        assert_eq!(canonical_encode_saved_view(&pre_feature), expected);
        // …and the strict reader cannot accept it, which is the only difference
        // between the two paths for this shape.
        assert_eq!(
            parse_view_manifest(expected),
            Err(ViewManifestError::VersionRequired)
        );
    }

    #[test]
    fn write_fields_preserves_author_order_and_nfc_folds() {
        // Sequence semantics: order preserved verbatim (no sort, no dedup, the
        // `columns` discipline), each element NFC.
        let mut v = view();
        v.write_fields = vec!["zeta".into(), "e\u{0301}".into(), "alpha".into()];
        let bytes = canonical_encode_saved_view(&v);
        let decoded = parse_view_manifest(&bytes).expect("decode");
        assert_eq!(
            decoded.write_fields,
            vec![
                "zeta".to_string(),
                "\u{00e9}".to_string(),
                "alpha".to_string()
            ]
        );
    }

    // ---- the approval comparison ---------------------------------------

    #[test]
    fn approval_is_an_equality_against_the_current_version() {
        let v = SavedView {
            id: "v1".into(),
            version: Some(3),
            ..fully_populated()
        };
        let mut approvals = BTreeMap::new();
        assert!(
            !is_view_approved(&approvals, &v),
            "no entry is not approved"
        );
        approvals.insert("v1".to_string(), 3u64);
        assert!(is_view_approved(&approvals, &v));
        // A version bump revokes approval with no code touching the map: that is
        // the property, so it is asserted on the SAME map value.
        let bumped = SavedView {
            version: Some(4),
            ..v.clone()
        };
        assert!(!is_view_approved(&approvals, &bumped));
        // …and an older one is refused too: approval names one exact version.
        let older = SavedView {
            version: Some(2),
            ..v.clone()
        };
        assert!(!is_view_approved(&approvals, &older));
        // A different view id sharing the version is not approved.
        let other = SavedView {
            id: "v2".into(),
            ..v
        };
        assert!(!is_view_approved(&approvals, &other));
    }

    #[test]
    fn a_version_less_view_counts_as_approved() {
        // Pre-feature local views stay usable; `VersionRequired` is what keeps an
        // arriving definition from reaching this arm. See `is_view_approved`.
        let v = SavedView {
            version: None,
            ..fully_populated()
        };
        assert!(is_view_approved(&BTreeMap::new(), &v));
    }
}
