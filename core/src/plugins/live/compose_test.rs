// SPDX-License-Identifier: AGPL-3.0-only
//! Tests for splice-list composition (myne-md/myne#849).

use super::apply_local::LocalSplice;
use super::compose::{apply_splices_to_text, compose_splices, merge_stale_save, rebase_splices};
use super::state::LiveSessionRegistry;

fn sp(from: usize, to: usize, insert: &str) -> LocalSplice {
    LocalSplice {
        from,
        to,
        insert: insert.into(),
    }
}

/// Apply a sorted, non-overlapping splice list to `doc`, offsets in UTF-16 code
/// units over `doc`. A forward walk, so two inserts at one point land in list
/// order, which is the order the editor's `ChangeSet` gives them.
fn apply_splices_to_str(doc: &str, splices: &[LocalSplice]) -> String {
    let units: Vec<u16> = doc.encode_utf16().collect();
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut cursor = 0usize;
    for s in splices {
        assert!(s.from >= cursor && s.to >= s.from && s.to <= units.len());
        out.extend_from_slice(&units[cursor..s.from]);
        out.extend(s.insert.encode_utf16());
        cursor = s.to;
    }
    out.extend_from_slice(&units[cursor..]);
    String::from_utf16(&out).expect("valid splices keep the text valid UTF-16")
}

/// Sequential application must equal applying the composition, and the
/// composition must be sorted, non-overlapping and maximally merged.
fn check(d0: &str, a: &[LocalSplice], b: &[LocalSplice]) -> Vec<LocalSplice> {
    let d1 = apply_splices_to_str(d0, a);
    let d2 = apply_splices_to_str(&d1, b);
    let c = compose_splices(a, b);
    assert_eq!(
        apply_splices_to_str(d0, &c),
        d2,
        "d0={d0:?} a={a:?} b={b:?} c={c:?}"
    );
    for w in c.windows(2) {
        assert!(
            w[1].from > w[0].to,
            "touching or overlapping output splices: {c:?}"
        );
    }
    for s in &c {
        assert!(s.from < s.to || !s.insert.is_empty(), "no-op splice: {c:?}");
    }
    c
}

#[test]
fn an_empty_second_list_is_the_identity() {
    let a = vec![sp(1, 2, "X"), sp(4, 4, "Y")];
    assert_eq!(compose_splices(&a, &[]), a);
}

#[test]
fn an_empty_first_list_returns_the_second() {
    let b = vec![sp(0, 1, ""), sp(3, 3, "Z")];
    assert_eq!(compose_splices(&[], &b), b);
}

#[test]
fn disjoint_edits_shift_into_d0_coordinates() {
    // a inserts 3 units at 0; b's offset 10 over D1 is offset 7 over D0.
    let c = check("abcdefghijkl", &[sp(0, 0, "xyz")], &[sp(10, 11, "Q")]);
    assert_eq!(c, vec![sp(0, 0, "xyz"), sp(7, 8, "Q")]);
}

#[test]
fn b_editing_inside_text_a_inserted() {
    // D1 = "ab" + "HELLO" + "cd"; b replaces "LL" inside the insert.
    let c = check("abcd", &[sp(2, 2, "HELLO")], &[sp(4, 6, "_")]);
    assert_eq!(c, vec![sp(2, 2, "HE_O")]);
}

#[test]
fn b_deleting_across_inserted_and_original_text() {
    // D0 "0123456789", a replaces 3..5 with "AB": D1 "012AB56789".
    // b deletes D1 2..7 ("2AB56"), mixing original and inserted units.
    let c = check("0123456789", &[sp(3, 5, "AB")], &[sp(2, 7, "")]);
    assert_eq!(c, vec![sp(2, 7, "")]);
}

#[test]
fn b_deleting_exactly_what_a_inserted_cancels_out() {
    let c = check("hello", &[sp(2, 2, "XYZ")], &[sp(2, 5, "")]);
    assert!(c.is_empty(), "{c:?}");
}

#[test]
fn abutting_ranges_merge_into_one_splice() {
    // a deletes 2..4; b inserts exactly at the D1 point where that deletion was.
    let c = check("abcdef", &[sp(2, 4, "")], &[sp(2, 2, "N")]);
    assert_eq!(c, vec![sp(2, 4, "N")]);
    // b deletes the D0 unit right after a's splice: one splice, not two.
    let c = check("abcdef", &[sp(1, 2, "X")], &[sp(2, 3, "")]);
    assert_eq!(c, vec![sp(1, 3, "X")]);
}

#[test]
fn an_edit_in_the_tail_needs_no_document_length() {
    // b's range lies far past a's last splice: the open tail carries it.
    let a = vec![sp(0, 1, "")];
    let b = vec![sp(1_000, 1_005, "t")];
    assert_eq!(
        compose_splices(&a, &b),
        vec![sp(0, 1, ""), sp(1_001, 1_006, "t")]
    );
}

#[test]
fn non_bmp_inserts_are_sliced_in_utf16_units() {
    // "😀" is two code units. D1 = "a" + "😀x😀" + "b"; b deletes the "x" at D1 3..4.
    let c = check("ab", &[sp(1, 1, "😀x😀")], &[sp(3, 4, "")]);
    assert_eq!(c, vec![sp(1, 1, "😀😀")]);
    // And a non-BMP char already in D0 shifts offsets by two: D1 is "😀Zb😀cd",
    // so D1 6..7 is the "c", which is D0 6..7 as well.
    let c = check("😀ab😀cd", &[sp(2, 3, "Z")], &[sp(6, 7, "é")]);
    assert_eq!(c, vec![sp(2, 3, "Z"), sp(6, 7, "é")]);
    // b deleting a whole non-BMP char a inserted, next to D0 text.
    let c = check("xy", &[sp(1, 1, "𝄞")], &[sp(1, 4, "")]);
    assert_eq!(c, vec![sp(1, 2, "")]);
}

/// A small deterministic PRNG, so the property test needs no new dependency.
struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

const ALPHABET: &[char] = &['a', 'b', 'c', '\n', ' ', 'é', '😀', '𝄞'];

fn random_text(rng: &mut XorShift, max: usize) -> String {
    let n = rng.below(max + 1);
    (0..n)
        .map(|_| ALPHABET[rng.below(ALPHABET.len())])
        .collect()
}

/// A random valid splice list over `doc`: sorted, non-overlapping, endpoints on
/// character boundaries (never inside a surrogate pair).
fn random_splices(rng: &mut XorShift, doc: &str) -> Vec<LocalSplice> {
    let mut bounds = vec![0usize];
    let mut u = 0usize;
    for c in doc.chars() {
        u += c.len_utf16();
        bounds.push(u);
    }
    let k = rng.below(5);
    let mut points: Vec<usize> = (0..2 * k)
        .map(|_| bounds[rng.below(bounds.len())])
        .collect();
    points.sort_unstable();
    points
        .chunks(2)
        .map(|p| LocalSplice {
            from: p[0],
            to: p[1],
            insert: random_text(rng, 4),
        })
        .collect()
}

#[test]
fn composition_equals_sequential_application() {
    let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
    for _ in 0..20_000 {
        let d0 = random_text(&mut rng, 16);
        let a = random_splices(&mut rng, &d0);
        let d1 = apply_splices_to_str(&d0, &a);
        let b = random_splices(&mut rng, &d1);
        check(&d0, &a, &b);
    }
}

/// The registry path the bug lived on: two merges queued before one drain must
/// both reach the pane, as one list over the pane's document.
#[test]
fn two_queued_merges_compose_rather_than_overwrite() {
    let reg = LiveSessionRegistry::new();
    let d0 = "first line\nsecond line\n";
    // A live peer change, then a durable pull, both before the pane drains.
    let a = vec![sp(5, 5, " PEER")];
    let d1 = apply_splices_to_str(d0, &a);
    let b = vec![sp(0, 0, "zero\n")];
    let d2 = apply_splices_to_str(&d1, &b);
    reg.set_pending_splices("n1", a);
    reg.set_pending_splices("n1", b);
    let drained = reg.take_pending_splices("n1");
    assert_eq!(
        apply_splices_to_str(d0, &drained),
        d2,
        "the first merge's text must survive the second: {drained:?}"
    );
    // An empty list is the identity and does not clear what is queued.
    reg.set_pending_splices("n2", vec![sp(0, 0, "x")]);
    reg.set_pending_splices("n2", Vec::new());
    assert_eq!(reg.take_pending_splices("n2"), vec![sp(0, 0, "x")]);
}

// ── rebase_splices / merge_stale_save (myne-md/myne#849) ─────────────────────

/// The shared helper and the test's own walk agree, so the rebase tests below
/// may use either.
#[test]
fn apply_splices_to_text_matches_the_test_walk() {
    let mut rng = XorShift(0x0123_4567_89AB_CDEF);
    for _ in 0..2_000 {
        let d = random_text(&mut rng, 16);
        let s = random_splices(&mut rng, &d);
        assert_eq!(apply_splices_to_text(&d, &s), apply_splices_to_str(&d, &s));
    }
}

/// Rebase `local` over `remote` (both over `base`) and apply it to the remote
/// result: the merge a stale save becomes.
fn rebase_merge(base: &str, local: &[LocalSplice], remote: &[LocalSplice]) -> String {
    let current = apply_splices_to_str(base, remote);
    apply_splices_to_text(&current, &rebase_splices(local, remote))
}

#[test]
fn a_local_insert_at_a_peers_insert_point_lands_after_it() {
    assert_eq!(
        rebase_merge("ab", &[sp(1, 1, "L")], &[sp(1, 1, "R")]),
        "aRLb"
    );
}

#[test]
fn a_local_deletion_over_a_peers_insert_keeps_the_insert() {
    // The client deletes "bcd"; meanwhile a peer typed "PEER" between c and d.
    assert_eq!(
        rebase_merge("abcde", &[sp(1, 4, "")], &[sp(3, 3, "PEER")]),
        "aPEERe"
    );
    // The replacement text rides on the first surviving piece.
    assert_eq!(
        rebase_merge("abcde", &[sp(1, 4, "X")], &[sp(3, 3, "PEER")]),
        "aXPEERe"
    );
}

#[test]
fn a_local_deletion_overlapping_a_peers_replacement_deletes_only_what_both_have() {
    // Base "0123456789". The peer replaced 4..7 with "AB"; the client deleted 2..6.
    // Base units 4 and 5 are already gone, so the client deletes only 2 and 3, and
    // the peer's "AB" survives.
    assert_eq!(
        rebase_merge("0123456789", &[sp(2, 6, "")], &[sp(4, 7, "AB")]),
        "01AB789"
    );
}

#[test]
fn a_local_edit_inside_a_peers_replacement_lands_after_it() {
    assert_eq!(
        rebase_merge("0123456789", &[sp(5, 5, "L")], &[sp(3, 7, "R")]),
        "012RL789"
    );
}

/// Property: when the two sides edit DISJOINT regions of the base (no shared or
/// touching range), the rebased merge is exactly both edits applied together.
#[test]
fn disjoint_local_and_remote_edits_both_survive_the_rebase() {
    let mut rng = XorShift(0xD1B5_4A32_D192_ED03);
    for _ in 0..20_000 {
        let base = random_text(&mut rng, 20);
        // A strictly separated list (each splice starts after the previous ends),
        // then split between the two sides at random.
        let mut all: Vec<LocalSplice> = Vec::new();
        for s in random_splices(&mut rng, &base) {
            if all.last().is_none_or(|p| s.from > p.to) {
                all.push(s);
            }
        }
        let (mut local, mut remote) = (Vec::new(), Vec::new());
        for s in &all {
            if rng.below(2) == 0 {
                local.push(s.clone());
            } else {
                remote.push(s.clone());
            }
        }
        let want = apply_splices_to_str(&base, &all);
        assert_eq!(
            rebase_merge(&base, &local, &remote),
            want,
            "base={base:?} local={local:?} remote={remote:?}"
        );
    }
}

/// Property over whole documents, through the line diff the command really uses:
/// the client edits some lines, a peer edits others, never two neighbouring lines
/// on different sides, and the merge carries both.
#[test]
fn a_stale_save_merges_disjoint_line_edits_from_both_sides() {
    let mut rng = XorShift(0x2545_F491_4F6C_DD1D);
    for round in 0..2_000 {
        let n = 3 + rng.below(10);
        let lines: Vec<String> = (0..n).map(|i| format!("line {i}\n")).collect();
        // 0 untouched, 1 local, 2 remote; a touched line's neighbours are untouched
        // or on the same side.
        let mut side = vec![0u8; n];
        for i in 0..n {
            let s = rng.below(3) as u8;
            let clash = |j: Option<usize>| j.is_some_and(|j| side[j] != 0 && side[j] != s);
            if s != 0 && !clash(i.checked_sub(1)) {
                side[i] = s;
            }
        }
        let edit = |rng: &mut XorShift, i: usize, who: &str| -> String {
            match rng.below(3) {
                0 => String::new(),
                1 => format!("{who} {round} {i}\n"),
                _ => format!("line {i}\n{who} added {round}\n"),
            }
        };
        let (mut base, mut local, mut remote, mut want) =
            (String::new(), String::new(), String::new(), String::new());
        for i in 0..n {
            base.push_str(&lines[i]);
            match side[i] {
                1 => {
                    let e = edit(&mut rng, i, "LOCAL");
                    local.push_str(&e);
                    remote.push_str(&lines[i]);
                    want.push_str(&e);
                }
                2 => {
                    let e = edit(&mut rng, i, "PEER");
                    local.push_str(&lines[i]);
                    remote.push_str(&e);
                    want.push_str(&e);
                }
                _ => {
                    local.push_str(&lines[i]);
                    remote.push_str(&lines[i]);
                    want.push_str(&lines[i]);
                }
            }
        }
        assert_eq!(
            merge_stale_save(&base, &local, &remote).expect("within budget"),
            want,
            "base={base:?} local={local:?} remote={remote:?}"
        );
    }
}

/// The finding itself: a whole-text save from a buffer that never saw a peer's
/// insert must not delete it.
#[test]
fn a_whole_text_save_from_a_stale_buffer_keeps_a_peers_insert() {
    let base = "# Title\n\nfirst.\n";
    let current = "# Title\n\nfirst.\npeer line.\n";
    let local = "# Title\n\nfirst, edited.\n";
    assert_eq!(
        merge_stale_save(base, local, current).expect("within budget"),
        "# Title\n\nfirst, edited.\npeer line.\n"
    );
    // The same at the same point: both appended a line, the client's lands after.
    assert_eq!(
        merge_stale_save(base, "# Title\n\nfirst.\nmine.\n", current).expect("within budget"),
        "# Title\n\nfirst.\npeer line.\nmine.\n"
    );
}

/// Both sides restamp `updated:`. The stamp is taken out of the diff, so the two
/// values never interleave, and the merge carries the later one.
#[test]
fn a_stale_save_carries_the_later_updated_stamp_and_never_an_interleave() {
    let base = "---\nupdated: 2026-08-11T09:00:00Z\n---\nbody\n";
    let current = "---\nupdated: 2026-08-11T11:00:00Z\n---\nbody\npeer\n";
    let local = "---\nupdated: 2026-08-11T10:00:00Z\n---\nmine body\n";
    assert_eq!(
        merge_stale_save(base, local, current).expect("within budget"),
        "---\nupdated: 2026-08-11T11:00:00Z\n---\nmine body\npeer\n"
    );
    let later_local = "---\nupdated: 2026-08-11T12:00:00Z\n---\nmine body\n";
    assert_eq!(
        merge_stale_save(base, later_local, current).expect("within budget"),
        "---\nupdated: 2026-08-11T12:00:00Z\n---\nmine body\npeer\n"
    );
}

#[test]
fn a_merge_too_large_to_diff_line_by_line_is_refused_rather_than_approximated() {
    // myne-md/myne#849 review round 5: past the LCS budget the diff is one range
    // over the whole changed window, and rebasing the client's edits over that
    // moves its inserts and drops its deletions. The merge answers None so the
    // command can answer BaseMismatch and the client keeps both.
    let lines = 2_100;
    let base: String = (0..lines).map(|i| format!("base line {i}\n")).collect();
    let current: String = (0..lines).map(|i| format!("peer line {i}\n")).collect();
    let local = format!("{base}mine\n");
    assert!(merge_stale_save(&base, &local, &current).is_none());
    // And a small one still merges.
    assert!(merge_stale_save("a\nb\n", "a\nb\nmine\n", "a\nB\n").is_some());
}
