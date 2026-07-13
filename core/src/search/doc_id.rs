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

const ATTACHMENT_PREFIX: &str = "att:";

/// Build the search doc id for one (attachment, embedding-note) pair.
pub fn make_attachment_doc_id(attachment_id: &str, note_id: &str) -> String {
    format!("{ATTACHMENT_PREFIX}{attachment_id}:{note_id}")
}

/// Decode a search doc id back to its kind. Anything not carrying the `att:`
/// prefix (or with an empty id half) is a plain note-body doc.
pub fn parse_search_doc_id(id: &str) -> SearchDocId<'_> {
    if let Some(rest) = id.strip_prefix(ATTACHMENT_PREFIX) {
        if let Some((attachment_id, note_id)) = rest.split_once(':') {
            if !attachment_id.is_empty() && !note_id.is_empty() {
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

    #[test]
    fn attachment_doc_id_round_trips() {
        let id = make_attachment_doc_id("abc123def", "note-uuid-9");
        assert_eq!(id, "att:abc123def:note-uuid-9");
        assert_eq!(
            parse_search_doc_id(&id),
            SearchDocId::Attachment {
                attachment_id: "abc123def",
                note_id: "note-uuid-9",
            }
        );
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
