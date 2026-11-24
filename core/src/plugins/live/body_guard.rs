// SPDX-License-Identifier: AGPL-3.0-only
//! Body-span guard for live co-editing (docs/spec/markdown-dialect.md §3.6,
//! docs/spec/sync-protocol.md §11.1).
//!
//! The frontmatter block is part of the one Automerge `Text`
//! (docs/spec/protocol.md §10.7), but it is a **reserved region**: a live splice
//! may never touch it, and the managed keys (`title:`, `folder:`, `updated:`,
//! `deleted:`, `trashed:`, `archived:`, `template:`) are re-derived at durable
//! boundaries, never carried through a live frame. This clamps every splice
//! against the same line-1-anchored frontmatter range the editor's dialect locates
//! ([`@myne/dialect` `locateFrontmatter`]), so a mis-derived offset arriving over
//! the wire cannot corrupt the reserved region.
//!
//! The offsets a splice carries are UTF-16 code units over the whole note
//! (frontmatter included), so the boundary here is measured in UTF-16 units too:
//! the frontmatter block carries user text (a title with accents), and a byte
//! offset would drift by one for every non-ASCII scalar before the closer.

use super::apply_local::LocalSplice;

const OPENER: &str = "---\n";
const DELIMITER: &str = "---";

/// The byte length of the frontmatter block prefix (opener through the closing
/// `---\n`), or `0` when there is none. Also the durable-frontmatter surgery's
/// block extent (`frontmatter::set_updated`).
///
/// Line-1-anchored (§3.6): an opener with no matching closer is **not**
/// frontmatter, not a parse error, so the body starts from the first byte.
pub(crate) fn body_start_byte(markdown: &str) -> usize {
    if !markdown.starts_with(OPENER) {
        return 0;
    }
    let body_start = OPENER.len();
    let mut cursor = body_start;
    while cursor < markdown.len() {
        match markdown[cursor..].find('\n') {
            None => {
                // A final unterminated line: frontmatter only if it is the closer.
                return if &markdown[cursor..] == DELIMITER {
                    markdown.len()
                } else {
                    0
                };
            }
            Some(rel) => {
                let line_end = cursor + rel;
                if &markdown[cursor..line_end] == DELIMITER {
                    return line_end + 1;
                }
                cursor = line_end + 1;
            }
        }
    }
    0
}

/// The number of UTF-16 code units in the frontmatter block prefix, or `0` when
/// the document has no frontmatter. This is the boundary a splice is clamped
/// against (splice offsets are UTF-16 over the whole note).
#[must_use]
pub fn body_start_utf16(markdown: &str) -> usize {
    let bytes = body_start_byte(markdown);
    if bytes == 0 {
        return 0;
    }
    markdown[..bytes].chars().map(char::len_utf16).sum()
}

/// Clamp `splices` to the body span: a splice wholly inside the frontmatter block
/// is dropped (never a live edit); one that straddles the boundary is clamped to
/// start at the body start. Order is preserved and the disjointness invariant
/// (`from <= to`) survives the clamp, since `to > body_start >= from`.
///
/// The start (`from >= body`) decides "body-only", not the end: an **insertion
/// exactly at the body start** (`from == to == body`) is the first body character
/// and must be kept, so testing the END would silently drop it. The whole-document
/// case (`body == 0`, no frontmatter) keeps everything by the same test.
#[must_use]
pub fn clamp_to_body(markdown: &str, splices: &[LocalSplice]) -> Vec<LocalSplice> {
    let body = body_start_utf16(markdown);
    splices
        .iter()
        .filter_map(|s| {
            if s.from >= body {
                return Some(s.clone());
            }
            if s.to <= body {
                return None;
            }
            Some(LocalSplice {
                from: body,
                to: s.to,
                insert: s.insert.clone(),
            })
        })
        .collect()
}
