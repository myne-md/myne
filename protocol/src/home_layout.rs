// SPDX-License-Identifier: AGPL-3.0-only

//! The home surface's card layout, as a `vault.prefs` member (myne-md/myne#1074).
//!
//! ── Why this is its own module ──────────────────────────────────────────────
//! The `vault.prefs` codec is hand-rolled and every member is a few lines inside
//! one 5000-line file. A card list is not a few lines: it is a nested array of
//! objects, which the codec handles through [`crate::saved_view`]'s parser and
//! `canonical_json`'s emitters. Putting the shape here keeps the prefs file's
//! canonical ORDER readable, and gives the shape a home where its own tests can
//! pin the byte contract without a whole prefs blob around it.
//!
//! ── The forward-compatibility contract ──────────────────────────────────────
//! **An unknown card `id` survives a load.** The parser has no registry of ids
//! and never will: it decodes what it is given, and the client decides which ids
//! it can render. That is deliberate — a card this build does not know is a card
//! a NEWER build wrote, and dropping it here would mean the arrangement silently
//! loses a row every time an older client saves.
//!
//! A card this build cannot REPRESENT (a `span` outside the allowed set, a
//! missing required member) is `Unrepresentable` rather than fatal, for the same
//! reason `OpaqueSavedView` exists: a row we cannot draw must not cost the user
//! every other row.
//!
//! ── Canonical member order ──────────────────────────────────────────────────
//! `id` < `kind` < `span`, alphabetical by byte, which is the codec's rule
//! everywhere (`protocol.md` § 9.5.2).

use alloc::string::String;
#[cfg(test)]
use alloc::string::ToString;
use alloc::vec::Vec;

use crate::canonical_json::{push_json_string, push_json_uint};
use crate::saved_view::{JsonParser, JsonValue};

/// The most cards one home surface may carry.
///
/// A bound rather than a preference: a compromised WebView could otherwise park
/// storage in the blob, and the 64 KiB envelope is the backstop rather than the
/// validation. Sixty-four cards is four times the densest arrangement the design
/// proposes, so no honest layout meets it.
pub const MAX_HOME_CARDS: usize = 64;

/// The longest card id this codec accepts. Card ids are the client's own
/// registry tokens (`recent-notes`, `todays-tasks`), the longest well under this.
pub const MAX_HOME_CARD_ID_LEN: usize = 64;

/// The longest card kind. A kind is a small closed vocabulary the client owns.
pub const MAX_HOME_CARD_KIND_LEN: usize = 32;

/// The widest a card may span, in columns. Two is what the design proposes; four
/// is the ceiling this codec accepts so a later two-to-four-column layout does
/// not need a format change.
pub const MAX_HOME_CARD_SPAN: u8 = 4;

/// One card in the home surface's arrangement.
///
/// **`kind` and `id` are both carried, and they are not redundant.** `id` is the
/// card's identity in the arrangement (so a future per-card setting can key on
/// it); `kind` is what to draw. Two cards of one kind are a legitimate
/// arrangement — a second "recent notes" scoped elsewhere — and a kind alone
/// could not tell them apart.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeCard {
    /// The card's identity in the arrangement.
    pub id: String,
    /// What to draw. A kind this build does not know renders as an inert row.
    pub kind: String,
    /// How many columns the card occupies, 1..=[`MAX_HOME_CARD_SPAN`].
    pub span: u8,
}

/// Why a card array could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeCardParseError {
    /// The bytes are not valid JSON.
    Malformed,
    /// Valid JSON, but the value is not an array.
    WrongType,
}

/// Parse a canonical `home_cards` array, returning the cards and the bytes
/// consumed so the embedding codec can advance its cursor past the value.
///
/// **A card this build cannot represent is skipped, not fatal.** The three
/// required members are validated per element; an element missing one, carrying
/// the wrong type, or naming a span outside `1..=MAX_HOME_CARD_SPAN` is dropped
/// and the rest are kept. The alternative — failing the whole blob — would make
/// one malformed row cost the user every preference in the vault.
pub fn parse_home_cards_array(bytes: &[u8]) -> Result<(Vec<HomeCard>, usize), HomeCardParseError> {
    let mut p = JsonParser::new(bytes);
    let elements = p.parse_top_level_array_spanned().map_err(|e| match e {
        crate::saved_view::SavedViewParseError::WrongType => HomeCardParseError::WrongType,
        _ => HomeCardParseError::Malformed,
    })?;
    let mut cards = Vec::with_capacity(elements.len());
    for (value, _, _) in &elements {
        if let Some(card) = card_from_json(value) {
            cards.push(card);
        }
    }
    Ok((cards, p.consumed()))
}

/// One element, or `None` when this build cannot represent it.
fn card_from_json(value: &JsonValue) -> Option<HomeCard> {
    let JsonValue::Object(members) = value else {
        return None;
    };
    let id = member_str(members, "id")?;
    let kind = member_str(members, "kind")?;
    let span = match member(members, "span") {
        Some(JsonValue::Int(n)) if (1..=i64::from(MAX_HOME_CARD_SPAN)).contains(n) => *n as u8,
        // A card with no span is one column: that is the default the writer
        // omits, so an absent member and a written `1` mean the same thing.
        None => 1,
        // A span outside the range, or a non-integer, is a row this build
        // cannot draw honestly. Skipping it is the same rule as a missing id.
        _ => return None,
    };
    if id.len() > MAX_HOME_CARD_ID_LEN || kind.len() > MAX_HOME_CARD_KIND_LEN {
        return None;
    }
    Some(HomeCard { id, kind, span })
}

fn member<'a>(members: &'a [(String, JsonValue)], key: &str) -> Option<&'a JsonValue> {
    members
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, value)| value)
}

fn member_str(members: &[(String, JsonValue)], key: &str) -> Option<String> {
    match member(members, key) {
        Some(JsonValue::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// Emit a canonical `home_cards` array.
///
/// Canonical means: members in byte order (`id` < `kind` < `span`), no
/// whitespace, and `span` omitted when it is `1` — the same omit-when-default
/// discipline every other member of the prefs codec follows, so a default
/// arrangement is byte-identical whether or not the writer ever touched a span.
pub fn push_home_cards(out: &mut Vec<u8>, cards: &[HomeCard]) {
    out.push(b'[');
    for (i, card) in cards.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend_from_slice(b"{\"id\":");
        push_json_string(out, &card.id);
        out.extend_from_slice(b",\"kind\":");
        push_json_string(out, &card.kind);
        if card.span > 1 {
            out.extend_from_slice(b",\"span\":");
            push_json_uint(out, u32::from(card.span));
        }
        out.push(b'}');
    }
    out.push(b']');
}

/// Whether an arrangement is one this codec would accept, for the WRITE path.
///
/// The reader is lenient by design (it skips what it cannot represent); the
/// writer is not, because a client that hands over an unrepresentable card has a
/// bug and silently writing a row that will vanish on the next load is worse
/// than refusing the write.
pub fn home_cards_are_writable(cards: &[HomeCard]) -> bool {
    cards.len() <= MAX_HOME_CARDS
        && cards.iter().all(|c| {
            !c.id.is_empty()
                && c.id.len() <= MAX_HOME_CARD_ID_LEN
                && !c.kind.is_empty()
                && c.kind.len() <= MAX_HOME_CARD_KIND_LEN
                && (1..=MAX_HOME_CARD_SPAN).contains(&c.span)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, kind: &str, span: u8) -> HomeCard {
        HomeCard {
            id: id.to_string(),
            kind: kind.to_string(),
            span,
        }
    }

    #[test]
    fn round_trips_in_canonical_order_and_omits_the_default_span() {
        let cards = alloc::vec![
            card("recent", "recent-notes", 1),
            card("tasks", "todays-tasks", 2)
        ];
        let mut out = Vec::new();
        push_home_cards(&mut out, &cards);
        assert_eq!(
            core::str::from_utf8(&out).unwrap(),
            r#"[{"id":"recent","kind":"recent-notes"},{"id":"tasks","kind":"todays-tasks","span":2}]"#
        );
        let (parsed, consumed) = parse_home_cards_array(&out).unwrap();
        assert_eq!(parsed, cards);
        assert_eq!(consumed, out.len());
    }

    #[test]
    fn keeps_a_card_id_this_build_does_not_know() {
        // The forward-compatibility contract: a NEWER build's card survives an
        // older one's load, because the parser has no registry to consult.
        let bytes = br#"[{"id":"future-card","kind":"future-kind"}]"#;
        let (parsed, _) = parse_home_cards_array(bytes).unwrap();
        assert_eq!(parsed, alloc::vec![card("future-card", "future-kind", 1)]);
    }

    #[test]
    fn skips_one_unrepresentable_card_and_keeps_the_rest() {
        // A span outside the accepted range costs that ROW, never the list: one
        // malformed card must not cost the user every other card.
        let bytes =
            br#"[{"id":"a","kind":"k","span":9},{"id":"b","kind":"k","span":2},{"kind":"k"}]"#;
        let (parsed, _) = parse_home_cards_array(bytes).unwrap();
        assert_eq!(parsed, alloc::vec![card("b", "k", 2)]);
    }

    #[test]
    fn rejects_a_non_array_and_damaged_bytes() {
        assert_eq!(
            parse_home_cards_array(br#"{"id":"a"}"#).unwrap_err(),
            HomeCardParseError::WrongType
        );
        assert_eq!(
            parse_home_cards_array(br#"[{"id":}"#).unwrap_err(),
            HomeCardParseError::Malformed
        );
    }

    #[test]
    fn the_write_path_refuses_what_the_reader_would_skip() {
        assert!(home_cards_are_writable(&[card("a", "k", 1)]));
        assert!(!home_cards_are_writable(&[card("a", "k", 0)]));
        assert!(!home_cards_are_writable(&[card(
            "a",
            "k",
            MAX_HOME_CARD_SPAN + 1
        )]));
        assert!(!home_cards_are_writable(&[card("", "k", 1)]));
        assert!(!home_cards_are_writable(&[card("a", "", 1)]));
        let too_many = alloc::vec![card("a", "k", 1); MAX_HOME_CARDS + 1];
        assert!(!home_cards_are_writable(&too_many));
    }
}
