// SPDX-License-Identifier: AGPL-3.0-only
//! The on-disk plaintext of a note a TOOL creates, with the fields the tool put
//! in the body lifted into real frontmatter.
//!
//! ## What this closes
//!
//! Both note-creating tools — `note_create` on the connection surface and the
//! agent's approved new note — composed `---\ntitle: …\nfolder: …\n---\n\n` and
//! appended the model's body verbatim. A model that wanted to create a calendar
//! event, or any note with properties, had no field in its tool schema for them,
//! so it did the natural thing and wrote the block it had seen in every note it
//! read: `---\nkind: event\nstart: …\n---\n\n…`. The result was a note with two
//! blocks, the second of which is BODY — the app renders it as text, and the
//! user reads `title: …` and `start: …` as literal lines of their note (reported
//! 2026-11-27 with a calendar event an agent had created).
//!
//! ## The rule
//!
//! A leading frontmatter block in the body is merged into the note's own
//! frontmatter, and the body keeps what came after it. Two keys are the
//! request's to decide and are dropped from the block:
//!
//! - `title:` because the tool call carries the title, and a note whose title
//!   line disagrees with the id it was created under is a note the sidebar and
//!   the file name dispute.
//! - `folder:` because **an agent may not decide which folder a note lives in**
//!   — [`super::super::agent::frontmatter`] states that invariant and enforces it
//!   on edits; honouring the key here would walk around it.
//!
//! Everything else is the model's own business, in its own order and its own
//! spelling: a lifted line is copied byte for byte, with the indented lines that
//! belong to it, so a block scalar or a list survives intact rather than being
//! re-rendered by a second YAML writer.
//!
//! ## Why here
//!
//! One function rather than two, because the two call sites are one sentence
//! apart in the product ("a tool created this note") and had already drifted
//! once: the connection writer quotes a folder scalar for its own reasons and
//! the agent writer quotes it differently. The composition is the same decision
//! either way, so it lives in one place and the callers keep only their quoting.

use crate::plugins::notes::title_extract::{body_after_frontmatter, extract_title_slices};

/// The keys the request owns, so a same-named line in the body is dropped.
const REQUEST_OWNED_KEYS: [&str; 7] = [
    "title", "folder", "trashed", "deleted", "archived", "template", "conflict",
];

/// Compose the plaintext of a newly created note.
///
/// `title_scalar` and `folder_scalar` are ALREADY quoted for the note's own
/// frontmatter by the caller (each call site has its own escaper, and quoting is
/// the part they legitimately differ on). An empty `folder_scalar` writes no
/// `folder:` line, which is how a note at the vault root is spelled.
pub fn compose_new_note(title_scalar: &str, folder_scalar: Option<&str>, body: &str) -> String {
    let (lifted, rest) = lift_leading_frontmatter(body);
    let mut plaintext = String::from("---\n");
    plaintext.push_str("title: ");
    plaintext.push_str(title_scalar);
    plaintext.push('\n');
    if let Some(folder) = folder_scalar.filter(|f| !f.trim().is_empty()) {
        plaintext.push_str("folder: ");
        plaintext.push_str(folder);
        plaintext.push('\n');
    }
    for line in &lifted {
        plaintext.push_str(line);
        plaintext.push('\n');
    }
    plaintext.push_str("---\n\n");
    plaintext.push_str(&rest);
    plaintext
}

/// Split a leading frontmatter block off `body` into the lines to lift and the
/// body that remains.
///
/// `body` without a frontmatter block is returned untouched, which is also what
/// an UNTERMINATED `---` opener resolves to: the dialect's own detector treats a
/// block with no closer as no block (§3.6), and a body that begins with a rule
/// is a body.
fn lift_leading_frontmatter(body: &str) -> (Vec<String>, String) {
    let Some(block) = extract_title_slices(body.as_bytes()).frontmatter_bytes else {
        return (Vec::new(), body.to_string());
    };
    let rest = std::str::from_utf8(body_after_frontmatter(body.as_bytes()))
        .map(str::to_string)
        .unwrap_or_else(|_| body.to_string());
    let block = String::from_utf8_lossy(block);
    (kept_fields(&block), rest)
}

/// Every top-level field in `block` except the request-owned keys, each with the
/// indented lines that belong to it.
fn kept_fields(block: &str) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    // Whether the line just read started a field that was dropped: its indented
    // continuation lines belong to it and go with it.
    let mut dropping = false;
    for line in block.lines() {
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented {
            if !dropping && !kept.is_empty() {
                kept.push(line.to_string());
            }
            continue;
        }
        let key = line.split(':').next().unwrap_or("").trim();
        if key.is_empty() {
            // A blank line does not start a new top-level key, so it never
            // changes which field we are dropping: keep reading the current
            // field across it. Inside a kept block scalar or list the blank
            // belongs to the value and is preserved; a separator between
            // fields is dropped.
            if !dropping && !kept.is_empty() {
                let last_indented = kept
                    .last()
                    .map(|l| l.starts_with(' ') || l.starts_with('\t'))
                    .unwrap_or(false);
                let last_blank = kept.last().map(|l| l.trim().is_empty()).unwrap_or(false);
                if last_indented || last_blank {
                    kept.push(line.to_string());
                }
            }
            continue;
        }
        dropping = REQUEST_OWNED_KEYS
            .iter()
            .any(|owned| owned.eq_ignore_ascii_case(key));
        if !dropping {
            kept.push(line.to_string());
        }
    }
    // A trailing blank line inside the block would land above the closing
    // delimiter, which the app's reader accepts but every hand-written note
    // omits.
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_with_no_block_is_written_under_the_composed_frontmatter() {
        assert_eq!(
            compose_new_note("Flights", None, "Two seats, one bag."),
            "---\ntitle: Flights\n---\n\nTwo seats, one bag."
        );
    }

    #[test]
    fn a_leading_block_becomes_real_fields() {
        // The reported shape: an event an agent wrote as a markdown block.
        let body = "---\nkind: event\nstart: 2026-12-19 12:00\n---\n\nTravel to SAW.";
        assert_eq!(
            compose_new_note("Istanbul to SAW", Some("Trip/"), body),
            "---\ntitle: Istanbul to SAW\nfolder: Trip/\nkind: event\nstart: 2026-12-19 12:00\n---\n\nTravel to SAW."
        );
    }

    #[test]
    fn the_request_owns_the_title_and_the_folder() {
        // Both are dropped however the body spells them: the folder is the one an
        // agent may not decide, and the title is the one the tool call carries.
        let body = "---\ntitle: Something else\nfolder: Elsewhere/\nkind: event\n---\n\nBody.";
        assert_eq!(
            compose_new_note("Real title", Some("Trip/"), body),
            "---\ntitle: Real title\nfolder: Trip/\nkind: event\n---\n\nBody."
        );
    }

    #[test]
    fn a_dropped_key_takes_its_indented_lines_with_it() {
        // A block scalar under a dropped key is that key's value, not a field of
        // its own.
        let body = "---\nfolder: >\n  Elsewhere/\nkind: event\n---\n\nBody.";
        assert_eq!(
            compose_new_note("T", None, body),
            "---\ntitle: T\nkind: event\n---\n\nBody."
        );
    }

    #[test]
    fn a_lifted_multi_line_value_survives_byte_for_byte() {
        let body = "---\nwindows:\n  - 08:00\n  - 17:00\nkind: event\n---\n\nBody.";
        assert_eq!(
            compose_new_note("T", None, body),
            "---\ntitle: T\nwindows:\n  - 08:00\n  - 17:00\nkind: event\n---\n\nBody."
        );
    }

    #[test]
    fn an_unterminated_opener_is_body() {
        // The dialect treats an opener with no closer as no block (§3.6), so it
        // stays in the body rather than being lifted or eaten.
        let body = "---\nkind: event\n\nNo closer here.";
        assert_eq!(
            compose_new_note("T", None, body),
            "---\ntitle: T\n---\n\n---\nkind: event\n\nNo closer here."
        );
    }

    #[test]
    fn a_body_that_is_only_a_block_leaves_an_empty_body() {
        assert_eq!(
            compose_new_note("T", None, "---\nkind: event\n---\n"),
            "---\ntitle: T\nkind: event\n---\n\n"
        );
    }

    #[test]
    fn an_empty_folder_writes_no_line() {
        assert_eq!(
            compose_new_note("T", Some("  "), "Body."),
            "---\ntitle: T\n---\n\nBody."
        );
    }

    #[test]
    fn hiding_markers_are_request_owned() {
        let body = "---\ntrashed: true\ndeleted: true\narchived: true\ntemplate: true\nconflict: true\nkind: event\n---\n\nBody.";
        assert_eq!(
            compose_new_note("T", None, body),
            "---\ntitle: T\nkind: event\n---\n\nBody."
        );
    }

    #[test]
    fn a_lifted_block_scalar_with_a_blank_line_survives() {
        let body = "---\nnotes: |\n  para one\n\n  para two\nkind: event\n---\n\nBody.";
        assert_eq!(
            compose_new_note("T", None, body),
            "---\ntitle: T\nnotes: |\n  para one\n\n  para two\nkind: event\n---\n\nBody."
        );
    }
}
