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

/// The most options one card may carry.
///
/// A bound rather than a preference, for the same reason `MAX_HOME_CARDS` is one:
/// options are free-form widget settings (`markdown` text, a view id, a folder),
/// so the blob is where a compromised WebView would park storage. Eight is what
/// the widest widget in the catalogue needs; the 64 KiB envelope stays the
/// backstop rather than the validation.
pub const MAX_HOME_CARD_OPTIONS: usize = 8;

/// The longest option key. Keys are the client's own tokens (`markdown`, `view`).
pub const MAX_HOME_CARD_OPTION_KEY_LEN: usize = 32;

/// The longest option value. A markdown/quote widget is the long one, and this is
/// roughly two screens of text: enough for a quote block, short of a note.
pub const MAX_HOME_CARD_OPTION_VALUE_LEN: usize = 1024;

/// The total option budget across every card on one home surface.
///
/// Per-card bounds do not bound the SUM: sixty-four cards times eight options
/// times a 1 KiB value is half a megabyte inside a 64 KiB envelope. This is the
/// number that makes the envelope the real backstop, and it is generous enough
/// that no honest arrangement is anywhere near it.
pub const MAX_HOME_OPTIONS_BYTES: usize = 8192;

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
    /// The widget's own settings, sorted by key. Empty for a card that has none,
    /// which is why the writer omits the member entirely.
    ///
    /// **`kind` decides what these mean, and the codec does not interpret them.**
    /// A `markdown` widget reads `markdown`; a `saved-view` widget reads `view`.
    /// Keeping the codec ignorant is what lets a new widget ship without a format
    /// change, and it is the same discipline `kind` itself follows: the client
    /// owns the vocabulary, the format owns only the shape.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<HomeCardOption>,
}

/// One per-card option: a key the renderer understands and its value.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeCardOption {
    pub key: String,
    pub value: String,
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
    let options = match member(members, "options") {
        None => Vec::new(),
        // A malformed options object costs the OPTIONS, never the card: the card
        // is still a card, and refusing it would turn a settings bug into a
        // missing row the user cannot get back.
        Some(JsonValue::Object(pairs)) => options_from_json(pairs),
        Some(_) => Vec::new(),
    };
    Some(HomeCard {
        id,
        kind,
        span,
        options,
    })
}

/// The accepted options of one card's `options` object.
///
/// Sorted by key so the parsed value equals the written one, and bounded per pair
/// and per card. An entry that breaks a bound is skipped rather than truncating
/// the value: a half-quote is worse than no quote.
fn options_from_json(pairs: &[(String, JsonValue)]) -> Vec<HomeCardOption> {
    let mut kept: Vec<HomeCardOption> = Vec::new();
    for (key, value) in pairs {
        if kept.len() == MAX_HOME_CARD_OPTIONS {
            break;
        }
        let JsonValue::Str(text) = value else {
            continue;
        };
        if key.is_empty()
            || key.len() > MAX_HOME_CARD_OPTION_KEY_LEN
            || text.len() > MAX_HOME_CARD_OPTION_VALUE_LEN
        {
            continue;
        }
        kept.push(HomeCardOption {
            key: key.clone(),
            value: text.clone(),
        });
    }
    kept.sort_by(|a, b| a.key.cmp(&b.key));
    kept
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
        // `options` sorts between `kind` and `span` (id < kind < options < span),
        // which is the same byte order every other object in the codec follows.
        if !card.options.is_empty() {
            // Sorted HERE rather than required of the caller: canonical output is
            // the writer's promise, and a caller that builds options from an
            // object has no meaningful order to offer.
            let mut ordered: Vec<&HomeCardOption> = card.options.iter().collect();
            ordered.sort_by(|a, b| a.key.cmp(&b.key));
            out.extend_from_slice(b",\"options\":{");
            for (i, option) in ordered.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                push_json_string(out, &option.key);
                out.push(b':');
                push_json_string(out, &option.value);
            }
            out.push(b'}');
        }
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
                && c.options.len() <= MAX_HOME_CARD_OPTIONS
                && c.options.iter().all(|o| {
                    !o.key.is_empty()
                        && o.key.len() <= MAX_HOME_CARD_OPTION_KEY_LEN
                        && o.value.len() <= MAX_HOME_CARD_OPTION_VALUE_LEN
                })
        })
        && home_options_bytes(cards) <= MAX_HOME_OPTIONS_BYTES
}

/// The bytes the surface's options occupy, the number [`MAX_HOME_OPTIONS_BYTES`]
/// bounds. Counted as key + value, which is what the envelope carries.
pub fn home_options_bytes(cards: &[HomeCard]) -> usize {
    cards
        .iter()
        .flat_map(|c| c.options.iter())
        .map(|o| o.key.len() + o.value.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, kind: &str, span: u8) -> HomeCard {
        HomeCard {
            id: id.to_string(),
            kind: kind.to_string(),
            span,
            options: Vec::new(),
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

    fn with_options(id: &str, kind: &str, pairs: &[(&str, &str)]) -> HomeCard {
        HomeCard {
            id: id.to_string(),
            kind: kind.to_string(),
            span: 1,
            options: pairs
                .iter()
                .map(|(k, v)| HomeCardOption {
                    key: k.to_string(),
                    value: v.to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn writes_options_between_kind_and_span_in_key_order() {
        let cards = alloc::vec![with_options(
            "quote",
            "markdown",
            &[("markdown", "Be water."), ("align", "center")]
        )];
        let mut out = Vec::new();
        push_home_cards(&mut out, &cards);
        // id < kind < options < span, and the option keys sort by byte.
        assert_eq!(
            core::str::from_utf8(&out).unwrap(),
            r#"[{"id":"quote","kind":"markdown","options":{"align":"center","markdown":"Be water."}}]"#
        );
    }

    #[test]
    fn round_trips_options_and_sorts_them_on_read() {
        // The writer sorts, and the reader sorts, so a blob written by an older
        // client in another order still parses to the value a save would produce.
        let bytes = br#"[{"id":"q","kind":"markdown","options":{"z":"1","a":"2"}}]"#;
        let (parsed, _) = parse_home_cards_array(bytes).unwrap();
        assert_eq!(
            parsed,
            alloc::vec![with_options("q", "markdown", &[("a", "2"), ("z", "1")])]
        );
        let mut out = Vec::new();
        push_home_cards(&mut out, &parsed);
        let (again, _) = parse_home_cards_array(&out).unwrap();
        assert_eq!(again, parsed);
    }

    #[test]
    fn a_malformed_options_member_costs_the_options_not_the_card() {
        // The card is still a card. Refusing it would turn a settings bug into a
        // row the user cannot get back.
        let bytes = br#"[{"id":"q","kind":"markdown","options":"not-an-object"}]"#;
        let (parsed, _) = parse_home_cards_array(bytes).unwrap();
        assert_eq!(parsed, alloc::vec![card("q", "markdown", 1)]);
    }

    #[test]
    fn skips_over_long_option_values_instead_of_truncating_them() {
        let long = "x".repeat(MAX_HOME_CARD_OPTION_VALUE_LEN + 1);
        let bytes = alloc::format!(
            r#"[{{"id":"q","kind":"markdown","options":{{"markdown":"{long}","align":"left"}}}}]"#
        );
        let (parsed, _) = parse_home_cards_array(bytes.as_bytes()).unwrap();
        // The half-quote is gone; the rest of the widget's settings survive.
        assert_eq!(
            parsed,
            alloc::vec![with_options("q", "markdown", &[("align", "left")])]
        );
    }

    #[test]
    fn refuses_to_write_more_option_bytes_than_the_surface_budget() {
        let big = "x".repeat(MAX_HOME_CARD_OPTION_VALUE_LEN);
        let cards: alloc::vec::Vec<HomeCard> = (0..MAX_HOME_CARDS)
            .map(|i| {
                with_options(
                    &alloc::format!("c{i}"),
                    "markdown",
                    &[("markdown", big.as_str()), ("b", big.as_str())],
                )
            })
            .collect();
        assert!(!home_cards_are_writable(&cards));
        // And the sum is what caught it: every single card is within its own bound.
        assert!(cards
            .iter()
            .all(|c| c.options.len() <= MAX_HOME_CARD_OPTIONS));
        assert!(home_options_bytes(&cards) > MAX_HOME_OPTIONS_BYTES);
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
