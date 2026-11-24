// SPDX-License-Identifier: AGPL-3.0-only
//! The durable frontmatter entry point for a live session (`collab-editor-bridge`
//! task 7).
//!
//! `updated:` is a **MAX-OBSERVED** value (task 7 decision 2026-10-10): the
//! session records the maximum of every `updated:` stamp it has observed, its own
//! device clock and any peer's, and the durable boundary writes that maximum. Two
//! devices therefore converge to the same stamp, and no character interleave can
//! fabricate a value neither wrote (the `0471` failure the body-only live policy
//! prevents on the live path). A per-commit device stamp is rejected (two devices
//! interleave to a plausible-but-wrong value); a stamp-on-close is rejected (a crash
//! leaves a stale stamp).
//!
//! The comparison is lexicographic over RFC 3339 UTC stamps: the format is
//! fixed-width and UTC-only ([`fm_updated_value_strict`] refuses anything else), so
//! lexicographic order is chronological order. This module holds the rule; the
//! splice that writes the winning value into the managed region runs in the durable
//! writer (`SYNC-33`), not on the live path (`SYNC-14`).

use crate::plugins::notes::daily_match::fm_updated_value_strict;
use crate::plugins::notes::title_extract::extract_title_slices;

/// The `updated:` value `markdown` carries, value-strict, or `None`. A free-text
/// `updated:` (not an RFC 3339 stamp) is not a value here.
#[must_use]
pub fn observed_updated(markdown: &str) -> Option<String> {
    let fm = extract_title_slices(markdown.as_bytes()).frontmatter_bytes?;
    fm_updated_value_strict(fm)
}

/// The later of two observed `updated:` stamps, or whichever is present.
#[must_use]
pub fn max_updated(a: Option<&str>, b: Option<&str>) -> Option<String> {
    match (a, b) {
        (Some(x), Some(y)) => Some(if x >= y { x } else { y }.to_string()),
        (Some(x), None) => Some(x.to_string()),
        (None, Some(y)) => Some(y.to_string()),
        (None, None) => None,
    }
}

/// Fold a stream of observed `updated:` stamps into `current`, returning the
/// running maximum. Absent values are ignored, so a peer that carries no stamp
/// cannot lower the maximum.
#[must_use]
pub fn fold_max_updated<'a>(
    current: Option<&str>,
    observed: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    observed
        .into_iter()
        .fold(current.map(str::to_string), |acc, v| {
            max_updated(acc.as_deref(), Some(v))
        })
}

/// Rewrite the managed `updated:` key in `markdown`'s frontmatter to `value`,
/// preserving every other byte, and return the result. The durable boundary calls
/// this with the running maximum so both devices write the same stamp (task 7).
///
/// Line-based and value-strict: only a line whose key is exactly `updated` (the
/// same shape the dialect's `patchUpdatedField` writes) is replaced; a note with no
/// frontmatter is returned unchanged, and its caller's own stamp then stands.
#[must_use]
pub fn set_updated(markdown: &str, value: &str) -> String {
    let block_end = super::body_guard::body_start_byte(markdown);
    if block_end == 0 {
        return markdown.to_string();
    }
    let (block, rest) = markdown.split_at(block_end);
    // The block ends with the closing `---\n`; split it off so a missing field can
    // be inserted just before it.
    let Some(close_pos) = block.rfind("---\n") else {
        return markdown.to_string();
    };
    let (fields, closer) = block.split_at(close_pos);

    let mut out = String::with_capacity(markdown.len() + value.len() + 12);
    let mut replaced = false;
    for line in fields.split_inclusive('\n') {
        if !replaced && is_updated_line(line) {
            out.push_str("updated: ");
            out.push_str(value);
            out.push('\n');
            replaced = true;
        } else {
            out.push_str(line);
        }
    }
    if !replaced {
        out.push_str("updated: ");
        out.push_str(value);
        out.push('\n');
    }
    out.push_str(closer);
    out.push_str(rest);
    out
}

/// Whether `line` is the managed `updated` key (leading indent and a space before
/// the colon allowed, exactly as the other frontmatter key readers accept).
fn is_updated_line(line: &str) -> bool {
    line.trim_start()
        .strip_prefix("updated")
        .is_some_and(|after| after.trim_start().starts_with(':'))
}
