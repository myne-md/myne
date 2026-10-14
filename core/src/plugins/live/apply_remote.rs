// SPDX-License-Identifier: AGPL-3.0
//! Remote-change application (epic live-collab, `collab-editor-bridge` task 5).
//!
//! A received opaque Automerge change (the payload sealed by
//! `collab-awareness-crypto`, carried by `collab-client-transport`) is applied to
//! the session document, and the resulting body change is handed to the editor as
//! a **multi-range** splice list the editor dispatches as one CodeMirror
//! `ChangeSet`. Never through the controlled `value` + `diffDoc` mirror, which
//! collapses a multi-region change into one replacement spanning the user's own
//! text (`editor/src/doc-diff.ts` says a single-range diff has no correct
//! formulation for that case).
//!
//! # The diff is computed here, not from Automerge's op encoding
//!
//! The 2026-10-10 decision: the core derives the changed ranges by diffing the
//! body text BEFORE and AFTER applying the change, rather than translating
//! Automerge's internal op encoding into splices. That keeps the core/editor wire
//! independent of Automerge's change representation. The diff is line-anchored
//! (so disjoint edits become separate ranges) with a bounded LCS and a
//! single-range fallback for a pathological window (see [`diff_splices`]).
//!
//! # Self-echo
//!
//! Automerge dedupes changes by content hash, so re-applying this device's own
//! change is a no-op and the text is unchanged; [`apply_remote_change`] returns an
//! empty splice list in that case, and the editor's own `live === value` early
//! return is the second guard.

use automerge::{AutoCommit, Change, ReadDoc};

use crate::plugins::live::apply_local::LocalSplice;
use crate::plugins::notes::crdt::note_text_id;

/// A remote-change failure. Closed enum.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ApplyRemoteError {
    /// The change bytes did not parse as an Automerge change.
    #[error("remote change is malformed")]
    Malformed,
    /// The document is not a well-formed single-`Text` `NC05` document.
    #[error("live session document is malformed")]
    MalformedDoc,
}

/// The largest `(before_lines + 1) * (after_lines + 1)` LCS table this diff will
/// build. Beyond it the changed window is emitted as ONE range (correct, just not
/// minimal) rather than allocating an unbounded table.
const MAX_LCS_CELLS: usize = 4_000_000;

/// The line start byte offsets of `s`, plus a sentinel at `s.len()`.
fn line_offsets(s: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut start = 0;
    for line in s.split_inclusive('\n') {
        out.push(start);
        start += line.len();
    }
    out.push(s.len());
    out
}

/// The UTF-16 offset for a byte offset in `s` (a char-boundary offset).
fn byte_to_utf16(s: &str, byte: usize) -> usize {
    s[..byte].chars().map(char::len_utf16).sum()
}

/// The maximal runs of non-matching lines between `b` and `a`, as
/// `(b_start, b_end, a_start, a_end)` half-open line indices.
fn lcs_hunks(b: &[&str], a: &[&str]) -> Vec<(usize, usize, usize, usize)> {
    let (n, m) = (b.len(), a.len());
    if n == 0 && m == 0 {
        return Vec::new();
    }
    if (n + 1).saturating_mul(m + 1) > MAX_LCS_CELLS {
        return vec![(0, n, 0, m)];
    }
    // LCS length table, bottom-up.
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if b[i] == a[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    // Walk the matches, then invert to hunk runs.
    let mut hunks = Vec::new();
    let (mut bi, mut ai) = (0usize, 0usize);
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if b[i] == a[j] {
            if i > bi || j > ai {
                hunks.push((bi, i, ai, j));
            }
            i += 1;
            j += 1;
            bi = i;
            ai = j;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    if bi < n || ai < m {
        hunks.push((bi, n, ai, m));
    }
    hunks
}

/// The minimal-ish splice list that turns `before` into `after`, in UTF-16 code
/// units over `before`. Line-anchored so disjoint edits produce separate ranges;
/// common prefix/suffix lines are trimmed first.
pub fn diff_splices(before: &str, after: &str) -> Vec<LocalSplice> {
    if before == after {
        return Vec::new();
    }
    let b_lines: Vec<&str> = before.split_inclusive('\n').collect();
    let a_lines: Vec<&str> = after.split_inclusive('\n').collect();

    let mut p = 0;
    while p < b_lines.len() && p < a_lines.len() && b_lines[p] == a_lines[p] {
        p += 1;
    }
    let mut s = 0;
    while s < b_lines.len() - p
        && s < a_lines.len() - p
        && b_lines[b_lines.len() - 1 - s] == a_lines[a_lines.len() - 1 - s]
    {
        s += 1;
    }
    let b_mid = &b_lines[p..b_lines.len() - s];
    let a_mid = &a_lines[p..a_lines.len() - s];
    let b_offsets = line_offsets(before);

    lcs_hunks(b_mid, a_mid)
        .into_iter()
        .map(|(bs, be, as_, ae)| {
            let before_hunk: String = b_mid[bs..be].concat();
            let after_hunk: String = a_mid[as_..ae].concat();
            let (from_byte, to_byte, insert) =
                trim_hunk(b_offsets[p + bs], &before_hunk, &after_hunk);
            LocalSplice {
                from: byte_to_utf16(before, from_byte),
                to: byte_to_utf16(before, to_byte),
                insert,
            }
        })
        .collect()
}

/// Tighten a line-aligned hunk to the minimal char range: trim the common char
/// prefix and suffix of `before_hunk`/`after_hunk`, and return the (from, to)
/// byte range within the before text (offset by `before_hunk_start`) plus the
/// inserted text.
fn trim_hunk(
    before_hunk_start: usize,
    before_hunk: &str,
    after_hunk: &str,
) -> (usize, usize, String) {
    let bh: Vec<char> = before_hunk.chars().collect();
    let ah: Vec<char> = after_hunk.chars().collect();
    let mut cp = 0;
    while cp < bh.len() && cp < ah.len() && bh[cp] == ah[cp] {
        cp += 1;
    }
    let mut cs = 0;
    while cs < bh.len() - cp && cs < ah.len() - cp && bh[bh.len() - 1 - cs] == ah[ah.len() - 1 - cs]
    {
        cs += 1;
    }
    let byte_len = |chars: &[char]| chars.iter().map(|c| c.len_utf8()).sum::<usize>();
    let from_byte = before_hunk_start + byte_len(&bh[..cp]);
    let to_byte = before_hunk_start + byte_len(&bh[..bh.len() - cs]);
    let insert: String = ah[cp..ah.len() - cs].iter().collect();
    (from_byte, to_byte, insert)
}

/// Apply one opaque Automerge change to the session document and return the
/// body splices the editor must dispatch. Empty when the change is a no-op (this
/// device's own change echoed back) or the text did not move.
pub fn apply_remote_change(
    doc: &mut AutoCommit,
    change_bytes: &[u8],
) -> Result<Vec<LocalSplice>, ApplyRemoteError> {
    let text = note_text_id(doc).map_err(|_| ApplyRemoteError::MalformedDoc)?;
    let before = doc
        .text(&text)
        .map_err(|_| ApplyRemoteError::MalformedDoc)?;
    let change =
        Change::from_bytes(change_bytes.to_vec()).map_err(|_| ApplyRemoteError::Malformed)?;
    doc.apply_changes([change])
        .map_err(|_| ApplyRemoteError::Malformed)?;
    let after = doc
        .text(&text)
        .map_err(|_| ApplyRemoteError::MalformedDoc)?;
    if before == after {
        return Ok(Vec::new());
    }
    Ok(diff_splices(&before, &after))
}
