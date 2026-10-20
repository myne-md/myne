// SPDX-License-Identifier: AGPL-3.0
//! Splice-list composition (epic live-collab, myne-md/myne#849).
//!
//! The registry queues the body splices a merge moved into an open session until
//! the pane drains them (`collab-editor-bridge` task 7). Two merges can land
//! before one drain: a live peer change and a durable pull, or two peer changes
//! in a burst. The first list maps the pane's document `D0` to `D1`, the second
//! maps `D1` to `D2`. Overwriting the first with the second loses the first
//! merge's text from the pane, and the pane's next whole-markdown save then
//! DELETES that peer text from the note. So the queue composes instead, and
//! [`compose_splices`] is the composition.
//!
//! # The shape it keeps
//!
//! The result is ONE list in `D0` coordinates, sorted and non-overlapping, so the
//! pane can still dispatch it as one CodeMirror `ChangeSet` against `D0`. Splices
//! that touch are merged, so two output splices are always separated by at least
//! one retained `D0` code unit.
//!
//! # The tail it never needs to know
//!
//! Neither list carries `D0`'s length, so the document is modelled as the
//! segments before and between `a`'s splices plus an OPEN tail that runs from
//! the last splice's end to wherever `D0` ends. Every offset `b` names past the
//! last known segment lands in that tail, and the tail stays open in the result.
//!
//! Offsets are UTF-16 code units, the editor's unit, so inserted strings are
//! sliced as UTF-16 rather than as bytes or scalars: a `b` offset inside text `a`
//! inserted counts a non-BMP character as two units.

use crate::plugins::live::apply_local::LocalSplice;

/// One run of a document described relative to `D0`.
#[derive(Debug, Clone)]
enum Seg {
    /// `D0`'s code units `[start, end)`, or `[start, ..)` (the open tail) when
    /// `end` is `None`.
    Keep { start: usize, end: Option<usize> },
    /// Text that is not in `D0`, as UTF-16 code units.
    Ins(Vec<u16>),
}

impl Seg {
    /// The run's length in code units, `None` for the open tail.
    fn len(&self) -> Option<usize> {
        match self {
            Seg::Keep { start, end } => end.map(|e| e - start),
            Seg::Ins(u) => Some(u.len()),
        }
    }
}

/// Sort a splice list by `from` and clamp it into a well-formed one (no inverted
/// range, no overlap). Producers already emit that shape; this keeps a malformed
/// list from corrupting the walk rather than trusting it.
fn normalized(list: &[LocalSplice]) -> Vec<LocalSplice> {
    let mut out: Vec<LocalSplice> = list.to_vec();
    out.sort_by_key(|s| s.from);
    let mut floor = 0usize;
    for s in &mut out {
        s.from = s.from.max(floor);
        s.to = s.to.max(s.from);
        floor = s.to;
    }
    out
}

/// `D1` as segments over `D0`: what `a` keeps, what it inserts, and the open tail.
fn segments_after(a: &[LocalSplice]) -> Vec<Seg> {
    let mut segs = Vec::with_capacity(a.len() * 2 + 1);
    let mut cursor = 0usize;
    for s in a {
        segs.push(Seg::Keep {
            start: cursor,
            end: Some(s.from),
        });
        segs.push(Seg::Ins(s.insert.encode_utf16().collect()));
        cursor = s.to;
    }
    segs.push(Seg::Keep {
        start: cursor,
        end: None,
    });
    segs
}

/// The part of `segs` covering the code units `[lo, hi)` of the document they
/// describe, `hi == None` meaning to the end.
fn slice(segs: &[Seg], lo: usize, hi: Option<usize>, out: &mut Vec<Seg>) {
    let mut pos = 0usize;
    for seg in segs {
        let seg_end = seg.len().map(|l| pos + l);
        // Intersect [pos, seg_end) with [lo, hi).
        let x = pos.max(lo);
        let y = match (seg_end, hi) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        if y.is_none_or(|y| x < y) {
            match seg {
                Seg::Keep { start, .. } => out.push(Seg::Keep {
                    start: start + (x - pos),
                    end: y.map(|y| start + (y - pos)),
                }),
                Seg::Ins(u) => {
                    // An Ins run always has a length, so `y` is bounded here.
                    let y = y.unwrap_or(pos + u.len());
                    out.push(Seg::Ins(u[x - pos..y - pos].to_vec()));
                }
            }
        }
        match seg_end {
            Some(e) => pos = e,
            None => break,
        }
        if hi.is_some_and(|h| pos >= h) {
            break;
        }
    }
}

/// Compose two splice lists: `a` maps `D0` to `D1` (offsets over `D0`), `b` maps
/// `D1` to `D2` (offsets over `D1`). Returns one list mapping `D0` to `D2`, in
/// `D0` coordinates, sorted, non-overlapping, with touching splices merged.
///
/// Applying the result to `D0` yields exactly what applying `a` then `b` does,
/// which `compose_test::composition_equals_sequential_application` checks over
/// random documents and random lists.
#[must_use]
pub fn compose_splices(a: &[LocalSplice], b: &[LocalSplice]) -> Vec<LocalSplice> {
    let d1 = segments_after(&normalized(a));
    let b = normalized(b);

    // D2 as segments over D0: D1 with every `b` range replaced by its insert.
    let mut d2: Vec<Seg> = Vec::new();
    let mut cursor = 0usize;
    for s in &b {
        slice(&d1, cursor, Some(s.from), &mut d2);
        d2.push(Seg::Ins(s.insert.encode_utf16().collect()));
        cursor = s.to;
    }
    slice(&d1, cursor, None, &mut d2);

    // Read the splices back off D2: every D0 run that is not kept is deleted, and
    // the inserted text pending since the last kept run lands in the same splice.
    let mut out = Vec::new();
    let mut d0_pos = 0usize;
    let mut pending: Vec<u16> = Vec::new();
    let mut emit = |from: usize, to: usize, pending: &mut Vec<u16>| {
        if from < to || !pending.is_empty() {
            out.push(LocalSplice {
                from,
                to,
                insert: String::from_utf16_lossy(pending),
            });
            pending.clear();
        }
    };
    for seg in d2 {
        match seg {
            Seg::Ins(u) => pending.extend_from_slice(&u),
            Seg::Keep { start, end } => {
                // An empty kept run separates nothing, so it must not split a
                // deletion from the insert beside it.
                if end.is_some_and(|e| e <= start) {
                    continue;
                }
                emit(d0_pos, start, &mut pending);
                match end {
                    Some(e) => d0_pos = e,
                    // The open tail is always the last segment.
                    None => break,
                }
            }
        }
    }
    out
}

/// Rebase a client's edits over what landed in the session since the client
/// last saw it (myne-md/myne#849). `local` and `remote` are both over the same
/// base `B`: `local` maps `B` to the client's buffer, `remote` maps `B` to the
/// session's current text `C`. Returns `local` moved into `C`'s coordinates, so
/// applying the result to `C` keeps every remote edit and adds the client's.
///
/// The placement rules, in the order a reader needs them:
///
/// - A local splice that touches a remote one at the same position puts its
///   insert AFTER the remote insert, so a stale buffer typing at the point a peer
///   typed never lands inside the peer's text.
/// - A local deletion deletes only the base characters that BOTH sides still
///   have. A base character the remote side already deleted is gone, and the
///   remote side's inserted text is never deleted by a local edit, so a peer's
///   insert survives a stale save that overlaps it. When the surviving
///   characters are split by remote text, the deletion becomes several splices;
///   the local insert rides on the first.
/// - A local edit inside a range the remote side replaced lands after the remote
///   replacement.
///
/// The result is sorted and non-overlapping over `C`, as [`apply_splices_to_text`]
/// expects. Offsets are UTF-16 code units like every other list here.
#[must_use]
pub fn rebase_splices(local: &[LocalSplice], remote: &[LocalSplice]) -> Vec<LocalSplice> {
    let local = normalized(local);
    let remote = normalized(remote);
    let remote_len = |r: &LocalSplice| r.insert.encode_utf16().count();
    // Where a base position lands in `C` when it must sit AFTER any remote text
    // at that point: past every remote splice that starts at or before it, and at
    // the end of a remote replacement that covers it.
    let map_after = |p: usize| -> usize {
        let mut shift: isize = 0;
        for r in &remote {
            if p < r.from {
                break;
            }
            if p < r.to {
                // Inside a range the remote side replaced.
                return (r.from as isize + shift) as usize + remote_len(r);
            }
            shift += remote_len(r) as isize - (r.to - r.from) as isize;
        }
        (p as isize + shift) as usize
    };
    let mut out = Vec::new();
    for l in &local {
        // The base characters the local splice deletes, minus every remote
        // deletion, cut at every remote point inside so no piece spans remote text.
        let mut pieces: Vec<(usize, usize)> = Vec::new();
        let mut lo = l.from;
        for r in &remote {
            if lo >= l.to {
                break;
            }
            // Wholly before the piece, or a remote insert exactly at its start,
            // which `map_after` already places the piece after.
            if r.to <= lo {
                continue;
            }
            if r.from >= l.to {
                break;
            }
            if r.from > lo {
                pieces.push((lo, r.from));
            }
            lo = lo.max(r.to);
        }
        if lo < l.to {
            pieces.push((lo, l.to));
        }
        match pieces.split_first() {
            None => {
                if !l.insert.is_empty() {
                    let at = map_after(l.from);
                    out.push(LocalSplice {
                        from: at,
                        to: at,
                        insert: l.insert.clone(),
                    });
                }
            }
            Some((&(a, b), rest)) => {
                let at = map_after(a);
                out.push(LocalSplice {
                    from: at,
                    to: at + (b - a),
                    insert: l.insert.clone(),
                });
                for &(a, b) in rest {
                    let at = map_after(a);
                    out.push(LocalSplice {
                        from: at,
                        to: at + (b - a),
                        insert: String::new(),
                    });
                }
            }
        }
    }
    out
}

/// Apply a sorted, non-overlapping splice list to `doc`, offsets in UTF-16 code
/// units over `doc`. Two inserts at one point land in list order. A splice past
/// the end, or overlapping the one before it, is clamped rather than trusted, so
/// a malformed list degrades instead of panicking.
#[must_use]
pub fn apply_splices_to_text(doc: &str, splices: &[LocalSplice]) -> String {
    let units: Vec<u16> = doc.encode_utf16().collect();
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut cursor = 0usize;
    for s in splices {
        let from = s.from.clamp(cursor, units.len());
        let to = s.to.clamp(from, units.len());
        out.extend_from_slice(&units[cursor..from]);
        out.extend(s.insert.encode_utf16());
        cursor = to;
    }
    out.extend_from_slice(&units[cursor..]);
    String::from_utf16_lossy(&out)
}

/// The text a stale whole-markdown save must become so it adds the client's
/// edits to the session WITHOUT deleting what landed there since (myne-md/myne#849).
/// `base` is the text the client's buffer was derived from, `local` the client's
/// buffer, `current` the session's text now. The client's edits (`base` to
/// `local`) are rebased over the session's (`base` to `current`) with
/// [`rebase_splices`] and applied to `current`.
///
/// The managed `updated:` stamp is taken out of the diff first: the client's save
/// restamps it and a peer's change restamps it too, so both sides would edit the
/// same characters, and an interleave of the two stamps is a value neither wrote.
/// Both `base` and `local` carry `current`'s stamp for the diff, and the merged text
/// then carries the later of the client's and the session's stamps, the same
/// MAX-OBSERVED rule [`super::frontmatter`] holds the durable writer to.
///
/// `None` when either diff is too large to compute line by line (myne-md/myne#849
/// review round 5). The diff then degrades to one range over the whole changed
/// window, and rebasing over that moves the client's inserts to its end and drops
/// its deletions inside it, so the caller answers `BaseMismatch` instead and the
/// client's keep-both path saves its text as a copy.
#[must_use]
pub fn merge_stale_save(base: &str, local: &str, current: &str) -> Option<String> {
    use super::frontmatter::{max_updated, observed_updated, set_updated};
    let current_stamp = observed_updated(current);
    let (base_n, local_n) = match current_stamp.as_deref() {
        Some(v) if observed_updated(base).is_some() || observed_updated(local).is_some() => {
            (set_updated(base, v), set_updated(local, v))
        }
        _ => (base.to_string(), local.to_string()),
    };
    use crate::plugins::live::apply_remote::diff_within_budget;
    if !diff_within_budget(&base_n, &local_n) || !diff_within_budget(&base_n, current) {
        return None;
    }
    let ours = crate::plugins::live::apply_remote::diff_splices(&base_n, &local_n);
    let theirs = crate::plugins::live::apply_remote::diff_splices(&base_n, current);
    let merged = apply_splices_to_text(current, &rebase_splices(&ours, &theirs));
    Some(
        match max_updated(
            observed_updated(local).as_deref(),
            observed_updated(&merged).as_deref(),
        ) {
            Some(v) if observed_updated(local).is_some() => set_updated(&merged, &v),
            _ => merged,
        },
    )
}
