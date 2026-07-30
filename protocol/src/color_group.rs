// SPDX-License-Identifier: AGPL-3.0

//! `ColorGroup` — an ordered rule pairing a filter with a color, applied to
//! graph nodes at paint time (graph-connection-ux-polish, MYND-635 task 2).
//! See `docs/spec/protocol.md` § 9.5.2.
//!
//! A color group is **authored content** (a user-named rule over the same
//! `FilterNode` AST [`crate::saved_view::SavedView`] already persists),
//! carried inside the existing `vault.prefs` (`MYP1`) blob as a
//! `color_groups` field — no new magic, no new KEK role, no new load-bearing
//! crypto. The `filter` field reuses [`crate::saved_view::FilterNode`]
//! verbatim (the single canonical filter AST — never a second definition)
//! and this module reuses `saved_view`'s hand-rolled recursive JSON
//! scanner (`JsonParser`/`JsonValue`, made `pub(crate)` for this purpose)
//! rather than duplicating a second recursive parser for the shared
//! sub-tree.
//!
//! ## Order is the payload
//!
//! Unlike [`crate::saved_view::SavedView`] (whose array is encoded id-sorted
//! because *display* order lives in the separate `view_order` field), a
//! color group's array position IS its rule precedence — the first matching
//! rule wins (SYNC-6 grill). There is no separate order field, so
//! [`canonical_encode_color_groups`] preserves the caller's slice order
//! **verbatim** (sequence semantics, the `favorites` / `item_order`
//! discipline), never re-sorted by `id`.
//!
//! ## Canonical JSON (§ 9.5.2)
//!
//! Per-object keys are lexicographically sorted: `color` < `enabled` <
//! `filter` < `id` < `name`. All five fields are required (no optional
//! sub-fields) — a color group with nothing set is not a valid rule.

use crate::canonical_json::push_json_string as push_string;
use crate::saved_view::{
    as_bool, as_object, encode_filter_into, filter_from_json, nfc, req, req_string, FilterNode,
    JsonParser, JsonValue, SavedViewParseError,
};
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// One color-group rule: a stable id, a user-visible name, a color-palette
/// key (resolved against the design-token palette; this codec stores it
/// verbatim, the `saved_views` `image`-property precedent), an enable flag
/// (a disabled rule is retained but skipped at evaluation — SYNC-6 grill),
/// and the filter AST it matches against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColorGroup {
    /// Stable unique id (a UUIDv7 in practice; opaque to this codec).
    pub id: String,
    /// User-visible rule name.
    pub name: String,
    /// The color-palette key (e.g. a design-token name). Free string; this
    /// codec performs no palette validation — the UI offers only the
    /// task-4 fixed palette, never free-form entry.
    pub color: String,
    /// Whether the rule is evaluated. A disabled rule stays in the list
    /// (so re-enabling loses no authoring work) but contributes no match.
    pub enabled: bool,
    /// The filter AST (an `all` leaf matches every note). Reuses
    /// [`crate::saved_view::FilterNode`] — the single canonical filter AST.
    pub filter: FilterNode,
}

/// Closed failure surface for [`parse_color_groups_array`]. Mirrors
/// [`crate::saved_view::SavedViewParseError`] exactly (the bytes are decoded
/// only AFTER the surrounding `vault.prefs` AEAD verified, so a failure here
/// is structural, not adversarial — the caller collapses it to
/// fall-back-to-defaults, § 9.5.5).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum ColorGroupParseError {
    /// The bytes are not well-formed canonical JSON.
    #[error("color group JSON is malformed")]
    Malformed,
    /// A required field (`id` / `name` / `color` / `enabled` / `filter`, or a
    /// filter leaf's mandatory key) is absent.
    #[error("color group is missing a required field")]
    MissingField,
    /// A field is present but the wrong JSON type.
    #[error("color group field has the wrong JSON type")]
    WrongType,
    /// An unknown filter `kind` or comparison operator — the schema cannot
    /// represent it.
    #[error("color group carries an unrepresentable filter value")]
    Unrepresentable,
}

fn map_filter_err(e: SavedViewParseError) -> ColorGroupParseError {
    match e {
        SavedViewParseError::Malformed => ColorGroupParseError::Malformed,
        SavedViewParseError::MissingField => ColorGroupParseError::MissingField,
        SavedViewParseError::WrongType => ColorGroupParseError::WrongType,
        SavedViewParseError::Unrepresentable => ColorGroupParseError::Unrepresentable,
    }
}

// ---- canonical JSON encoder -------------------------------------------------

fn encode_color_group_into(out: &mut Vec<u8>, group: &ColorGroup) {
    // Canonical key order: color, enabled, filter, id, name. All required —
    // no `sep`/`first` dance (contrast SavedView, which has optional fields).
    out.push(b'{');
    out.extend_from_slice(b"\"color\":");
    push_string(out, &nfc(&group.color));
    out.extend_from_slice(b",\"enabled\":");
    out.extend_from_slice(if group.enabled { b"true" } else { b"false" });
    out.extend_from_slice(b",\"filter\":");
    encode_filter_into(out, &group.filter);
    out.extend_from_slice(b",\"id\":");
    push_string(out, &nfc(&group.id));
    out.extend_from_slice(b",\"name\":");
    push_string(out, &nfc(&group.name));
    out.push(b'}');
}

/// Encode a slice of [`ColorGroup`] to a canonical JSON ARRAY (`[…]`), the
/// form the `color_groups` field carries inside `vault.prefs`. Elements are
/// emitted in **slice order, verbatim** — order is rule precedence, not a
/// sortable identity (contrast [`crate::saved_view::canonical_encode_saved_views`],
/// which is id-sorted because its display order lives elsewhere). The caller
/// omits the field entirely when the slice is empty, so this never emits `[]`.
pub fn canonical_encode_color_groups(groups: &[ColorGroup]) -> Vec<u8> {
    let mut out = Vec::with_capacity(96 * groups.len().max(1));
    out.push(b'[');
    for (i, g) in groups.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        encode_color_group_into(&mut out, g);
    }
    out.push(b']');
    out
}

// ---- canonical JSON decoder -------------------------------------------------

fn color_group_from_json(v: &JsonValue) -> Result<ColorGroup, ColorGroupParseError> {
    let obj = as_object(v).map_err(map_filter_err)?;
    Ok(ColorGroup {
        id: req_string(obj, "id").map_err(map_filter_err)?,
        name: req_string(obj, "name").map_err(map_filter_err)?,
        color: req_string(obj, "color").map_err(map_filter_err)?,
        enabled: as_bool(req(obj, "enabled").map_err(map_filter_err)?).map_err(map_filter_err)?,
        filter: filter_from_json(req(obj, "filter").map_err(map_filter_err)?, 0)
            .map_err(map_filter_err)?,
    })
}

/// Parse a canonical JSON ARRAY of color groups starting at `bytes[0] ==
/// '['`, returning the decoded groups **in their on-disk (precedence) order**
/// plus the number of bytes consumed (so the embedding `vault.prefs` codec
/// can advance its cursor past the array). Reuses [`crate::saved_view`]'s
/// recursive `JsonParser` so brace/bracket balancing and string-escaping are
/// single-homed, not re-implemented here.
pub fn parse_color_groups_array(
    bytes: &[u8],
) -> Result<(Vec<ColorGroup>, usize), ColorGroupParseError> {
    let mut p = JsonParser::new(bytes);
    let v = p.parse_value().map_err(map_filter_err)?;
    let arr = match v {
        JsonValue::Array(a) => a,
        _ => return Err(ColorGroupParseError::WrongType),
    };
    let mut groups = Vec::with_capacity(arr.len());
    for e in &arr {
        groups.push(color_group_from_json(e)?);
    }
    Ok((groups, p.consumed()))
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use alloc::string::ToString;
    use alloc::vec;

    fn rule(id: &str, name: &str, color: &str, enabled: bool, filter: FilterNode) -> ColorGroup {
        ColorGroup {
            id: id.to_string(),
            name: name.to_string(),
            color: color.to_string(),
            enabled,
            filter,
        }
    }

    #[test]
    fn encode_orders_keys_canonically() {
        let g = rule(
            "0190-a",
            "Work",
            "moss",
            true,
            FilterNode::HasTag {
                tag: "work".to_string(),
            },
        );
        let bytes = canonical_encode_color_groups(&[g]);
        let json = core::str::from_utf8(&bytes).unwrap();
        assert_eq!(
            json,
            r#"[{"color":"moss","enabled":true,"filter":{"kind":"hasTag","tag":"work"},"id":"0190-a","name":"Work"}]"#
        );
    }

    #[test]
    fn encode_preserves_slice_order_not_id_sorted() {
        // Precedence order, not id order — "zzz" first must stay first.
        let a = rule("zzz", "Z", "moss", true, FilterNode::All);
        let b = rule("aaa", "A", "slate", true, FilterNode::All);
        let bytes = canonical_encode_color_groups(&[a.clone(), b.clone()]);
        let (decoded, _) = parse_color_groups_array(&bytes).unwrap();
        assert_eq!(decoded, vec![a, b]);
    }

    #[test]
    fn round_trips_disabled_rule_and_reports_consumed_len() {
        let g = rule("id1", "Disabled", "slate", false, FilterNode::All);
        let bytes = canonical_encode_color_groups(core::slice::from_ref(&g));
        let (decoded, consumed) = parse_color_groups_array(&bytes).unwrap();
        assert_eq!(decoded, vec![g]);
        assert_eq!(consumed, bytes.len());
    }

    #[test]
    fn missing_enabled_field_is_missing_field_error() {
        let bytes = br#"[{"color":"moss","filter":{"kind":"all"},"id":"i","name":"n"}]"#;
        assert_eq!(
            parse_color_groups_array(bytes),
            Err(ColorGroupParseError::MissingField)
        );
    }

    #[test]
    fn non_bool_enabled_field_is_wrong_type_error() {
        let bytes =
            br#"[{"color":"moss","enabled":"yes","filter":{"kind":"all"},"id":"i","name":"n"}]"#;
        assert_eq!(
            parse_color_groups_array(bytes),
            Err(ColorGroupParseError::WrongType)
        );
    }

    #[test]
    fn unrepresentable_filter_kind_rejects() {
        let bytes =
            br#"[{"color":"moss","enabled":true,"filter":{"kind":"formula"},"id":"i","name":"n"}]"#;
        assert_eq!(
            parse_color_groups_array(bytes),
            Err(ColorGroupParseError::Unrepresentable)
        );
    }

    #[test]
    fn empty_array_decodes_to_empty_vec() {
        let (decoded, consumed) = parse_color_groups_array(b"[]").unwrap();
        assert!(decoded.is_empty());
        assert_eq!(consumed, 2);
    }
}
