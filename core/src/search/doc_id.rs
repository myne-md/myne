// SPDX-License-Identifier: AGPL-3.0
//! Search doc-id scheme (MYND-448a): the index holds two doc KINDS — a note's
//! body (id = the note_id) and an attachment's extracted text as its OWN doc
//! linking back to the note it is embedded in. A structured, unambiguous id lets
//! `query()` return attachment hits distinctly (provenance is inherent) and lets
//! the UI open the embedding note + scroll to the attachment's embed on click.
//!
//! Attachment doc id: `att:<attachment_id_hex>:<note_id>`. The `att:` prefix is
//! unambiguous — a note_id is a UUID (starts with a hex digit, never `att:`), and
//! an attachment_id is 64 lowercase hex (never contains `:`), so the FIRST `:`
//! after the prefix cleanly splits the two ids. Decoding is tolerant: anything
//! that isn't a well-formed attachment id is treated as a plain note-body doc.
//!
//! **That shape is checked rather than described.** It used to be neither: the
//! decoder split on the first `:` and asked only that both halves be non-empty,
//! so `make_attachment_doc_id(note_id, attachment_id)` with its two `&str`
//! arguments transposed round-tripped as a well-formed `Attachment` with the
//! halves reversed, silently, and the paragraph above claimed a property the
//! code did not hold. A UUID carries hyphens and is not 64 hex, so enforcing
//! the documented shape is what makes a transposed call fall back to `Note`
//! instead of decoding into a lie.

/// The kind + ids a search doc id decodes to.
#[derive(Debug, PartialEq, Eq)]
pub enum SearchDocId<'a> {
    /// A note body — the id IS the note_id.
    Note { note_id: &'a str },
    /// An attachment's extracted text, linked to the note it is embedded in.
    Attachment {
        attachment_id: &'a str,
        note_id: &'a str,
    },
}

use crate::plugins::attachments::reconcile::ATT_ID_HEX_LEN;

const ATTACHMENT_PREFIX: &str = "att:";

/// True for the canonical form-C attachment id: exactly
/// [`ATT_ID_HEX_LEN`] lowercase hex characters, which is the catalog-key
/// shape. The length is imported rather than re-typed here; two spellings of
/// one invariant is the drift this function exists to catch.
fn is_attachment_id(s: &str) -> bool {
    s.len() == ATT_ID_HEX_LEN
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Build the search doc id for one (attachment, embedding-note) pair.
pub fn make_attachment_doc_id(attachment_id: &str, note_id: &str) -> String {
    format!("{ATTACHMENT_PREFIX}{attachment_id}:{note_id}")
}

/// Decode a search doc id back to its kind. Anything not carrying the `att:`
/// prefix (or with an empty id half) is a plain note-body doc.
pub fn parse_search_doc_id(id: &str) -> SearchDocId<'_> {
    if let Some(rest) = id.strip_prefix(ATTACHMENT_PREFIX) {
        if let Some((attachment_id, note_id)) = rest.split_once(':') {
            if is_attachment_id(attachment_id) && !note_id.is_empty() {
                return SearchDocId::Attachment {
                    attachment_id,
                    note_id,
                };
            }
        }
    }
    SearchDocId::Note { note_id: id }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_note_id_decodes_as_note() {
        let id = "0192abcd-1234-7890-abcd-ef0123456789";
        assert_eq!(parse_search_doc_id(id), SearchDocId::Note { note_id: id });
    }

    /// A catalog-shaped attachment id: 64 lowercase hex, which is what
    /// `hex_encode` produces and what the catalog stores.
    fn att_id() -> String {
        "ab".repeat(32)
    }

    #[test]
    fn attachment_doc_id_round_trips() {
        let att = att_id();
        let id = make_attachment_doc_id(&att, "note-uuid-9");
        assert_eq!(id, format!("att:{att}:note-uuid-9"));
        assert_eq!(
            parse_search_doc_id(&id),
            SearchDocId::Attachment {
                attachment_id: &att,
                note_id: "note-uuid-9",
            }
        );
    }

    #[test]
    fn transposed_arguments_do_not_round_trip() {
        // `make_attachment_doc_id` takes two `&str`, so swapping them compiles.
        // Before the shape check this produced a well-formed `Attachment` with
        // the halves reversed, and nothing anywhere said so.
        let att = att_id();
        let note = "0192abcd-1234-7890-abcd-ef0123456789";
        let swapped = make_attachment_doc_id(note, &att);
        match parse_search_doc_id(&swapped) {
            SearchDocId::Note { .. } => {}
            SearchDocId::Attachment { .. } => {
                panic!("a transposed id decoded as an attachment: {swapped}")
            }
        }
    }

    #[test]
    fn an_attachment_half_of_the_wrong_shape_is_not_an_attachment() {
        for bad in [
            "abc123def",                            // too short
            &"ab".repeat(33),                       // too long
            &format!("{}Z", "ab".repeat(31) + "a"), // not hex
            &"AB".repeat(32),                       // uppercase
        ] {
            let id = format!("att:{bad}:note-uuid-9");
            assert!(
                matches!(parse_search_doc_id(&id), SearchDocId::Note { .. }),
                "expected a note fallback for {id}"
            );
        }
    }

    #[test]
    fn malformed_attachment_id_falls_back_to_note() {
        // No second `:` → not a valid attachment id → treated as a note id.
        assert_eq!(
            parse_search_doc_id("att:onlyone"),
            SearchDocId::Note {
                note_id: "att:onlyone"
            }
        );
        // Empty halves → note.
        assert_eq!(
            parse_search_doc_id("att::"),
            SearchDocId::Note { note_id: "att::" }
        );
    }

    #[test]
    fn note_id_starting_with_hex_is_never_mistaken_for_attachment() {
        // Real note_ids are UUIDs — they never carry the `att:` prefix.
        let id = "a7b3-not-an-attachment";
        assert_eq!(parse_search_doc_id(id), SearchDocId::Note { note_id: id });
    }
}
