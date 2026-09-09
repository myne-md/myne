// SPDX-License-Identifier: AGPL-3.0
//! The canonical form-C embed span scanner, host-free.
//!
//! Moved out of `myne-core`'s `plugins::attachments::reconcile` so the
//! export-naming vocabulary (which needs `AttEmbedSpan` + the span scanner)
//! can live in the `format/` crate without dragging the in-RAM
//! `AttachmentRefsState` graph along. Only the byte-surgery scanner is here;
//! the tolerant `extract_att_ids` tokenizer and the zeroize-on-lock graph stay
//! in `myne-core`.

/// One canonical form-C embed occurrence located by
/// [`extract_att_embed_spans`]: the byte span of the WHOLE embed
/// (`![[` … `]]`, half-open `start..end`) plus the attachment-id it
/// references (borrowed out of the body).
#[derive(Debug, PartialEq, Eq)]
pub struct AttEmbedSpan<'a> {
    /// Byte offset of the embed's leading `!`.
    pub start: usize,
    /// Byte offset one past the closing `]]`.
    pub end: usize,
    /// The 64-char lowercase-hex attachment-id (without `att:`).
    pub id: &'a str,
    /// The alias: everything between the `|` and the closing `]]`, or `""`
    /// when the embed carries none. This is NOT the filename. It may carry
    /// layout segments (`photo.png|w=300`, myne#409) and the filename itself
    /// may contain a `|` (`re|port.png`), so a consumer that needs either must
    /// split it rather than read it whole.
    pub alias: &'a str,
}

/// The canonical form-C id length: 64 lowercase-hex chars = the 32-byte
/// attachment-id (`protocol.md` §9.9).
pub const ATT_ID_HEX_LEN: usize = 64;

/// Locate every **canonical** form-C embed in `note_body`, in document
/// order, with exact byte spans — the scanner behind the export-side
/// embed rewrite (MYND-115 `note_export_attachments`, the §6 sanctioned
/// export transform).
///
/// Unlike the tolerant reconcile tokenizer, this scanner matches ONLY the
/// canonical emitted form — the byte-twin of the TS `extractAttachmentIds`
/// regex (`src/notes/attachmentRef.ts`):
/// `![[att:<64 lowercase hex>]]` or `![[att:<64 lowercase hex>|<alias
/// without ']'>]]`, no interior whitespace tolerance. Byte-surgery must
/// never fire on a near-miss: a malformed / non-canonical `![[att:…]]`
/// stays untouched in the exported copy (it cannot resolve against the
/// catalog anyway — catalog keys are exactly 64 lowercase hex).
pub fn extract_att_embed_spans(note_body: &str) -> Vec<AttEmbedSpan<'_>> {
    let bytes = note_body.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = find_subslice(&bytes[i..], b"![[att:") {
        let open = i + rel;
        match parse_canonical_embed_at(note_body, open) {
            Some(span) => {
                i = span.end;
                out.push(span);
            }
            // Not the canonical form — step past the `!` so an
            // overlapping later candidate is still scanned.
            None => i = open + 1,
        }
    }
    out
}

/// Parse the canonical embed starting at byte `open` (which the caller
/// guarantees begins with `![[att:`). Returns `None` on any deviation
/// from the canonical form.
fn parse_canonical_embed_at(note_body: &str, open: usize) -> Option<AttEmbedSpan<'_>> {
    let bytes = note_body.as_bytes();
    let id_start = open + b"![[att:".len();
    let id_end = id_start + ATT_ID_HEX_LEN;
    let id_bytes = bytes.get(id_start..id_end)?;
    if !id_bytes
        .iter()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    {
        return None;
    }
    let mut alias: &str = "";
    let end = match bytes.get(id_end)? {
        b']' => {
            if bytes.get(id_end + 1) != Some(&b']') {
                return None;
            }
            id_end + 2
        }
        b'|' => {
            // Alias runs to the FIRST `]`, which must open the `]]`
            // closer (TS twin: `(?:\|[^\]]*)?\]\]`).
            let alias_start = id_end + 1;
            let close_rel = bytes[alias_start..].iter().position(|b| *b == b']')?;
            let close = alias_start + close_rel;
            if bytes.get(close + 1) != Some(&b']') {
                return None;
            }
            alias = &note_body[alias_start..close];
            close + 2
        }
        _ => return None,
    };
    Some(AttEmbedSpan {
        start: open,
        end,
        id: &note_body[id_start..id_end],
        alias,
    })
}

/// Return the byte offset of the first occurrence of `needle` in
/// `haystack`, or `None`.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}
