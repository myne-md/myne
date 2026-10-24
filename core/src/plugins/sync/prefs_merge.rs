// SPDX-License-Identifier: AGPL-3.0
//! Post-decrypt field/set merge of two `vault.prefs` views (MYND-478;
//! `sync-protocol.md` §10.2).
//!
//! Runs entirely in RAM on decrypted views (SYNC-3: plaintext never rests
//! outside the AEAD'd blob). The shared/device-local split lives HERE, not in
//! the on-disk format: [`merge_prefs`] takes remote values only for the fields
//! [`prefs_classification`](super::prefs_classification) marks shared, and the
//! local value always survives for a device-local field.
//!
//! LWW mechanics (§10.2): every shared LWW field races on its own
//! `field_clocks` entry (absent = 0 — every pre-MYND-478 blob); equal clocks
//! tie-break **byte-lexicographically toward the greater canonical value**
//! (the §11.4 catalog-`filename` precedent), so both replicas converge
//! independently. The generic `conflict.rs::merge_scalar_lww` tie-breaks
//! toward its first argument and is therefore NOT used here — its semantics
//! serve other call sites.
//!
//! The result is deterministic and **commutative on the shared subset**:
//! `merge(a, b)` and `merge(b, a)` agree on every shared field and on the
//! merged `field_clocks`; they differ exactly on the device-local fields,
//! where each side keeps its own.

use std::collections::BTreeMap;

use protocol::PrefsView;
use serde::Serialize;

use super::prefs_classification::{classify, PrefClass, SharedDiscipline, CLASSIFICATION};

/// Read a field's LWW clock (absent = 0, §10.2).
fn clock_of(view: &PrefsView, field: &str) -> u64 {
    view.field_clocks.get(field).copied().unwrap_or(0)
}

/// Winner of one shared LWW race (scalar, sequence-on-whole, or whole-value):
/// newer clock wins; equal clocks fall back to the byte-lexicographically
/// greater canonical (serde-JSON) encoding of the value, which is
/// deterministic and side-symmetric. Records the winning clock into `clocks`
/// (only when non-zero, so never-stamped fields keep the map empty and a
/// legacy blob re-encodes byte-identically).
fn lww_field<T: Serialize + Clone + PartialEq>(
    field: &str,
    local: &T,
    local_clock: u64,
    remote: &T,
    remote_clock: u64,
    clocks: &mut BTreeMap<String, u64>,
) -> T {
    lww_field_keyed(
        field,
        local,
        local_clock,
        remote,
        remote_clock,
        clocks,
        tiebreak_key,
    )
}

/// [`lww_field`] with a caller-supplied tiebreak-key function, for fields
/// whose serde encoding is NOT their §9.5.2 canonical encoding (`saved_views`:
/// serde emits struct-declaration key order, the canonical codec emits
/// lexicographic). §10.2 makes the tiebreak bytes normative — "the values'
/// canonical encodings" — so a divergence here would let an independent
/// implementation pick the opposite equal-clock winner and never converge.
#[allow(clippy::too_many_arguments)]
fn lww_field_keyed<T: Clone + PartialEq>(
    field: &str,
    local: &T,
    local_clock: u64,
    remote: &T,
    remote_clock: u64,
    clocks: &mut BTreeMap<String, u64>,
    key: impl Fn(&T) -> Vec<u8>,
) -> T {
    lww_field_keyed_with_winner(field, local, local_clock, remote, remote_clock, clocks, key).0
}

/// [`lww_field_keyed`] plus which side won (`true` = remote). A caller that
/// carries a value ALONGSIDE a field needs this rather than re-deriving the
/// decision: `saved_views`' opaque remainder is part of that field's encoding,
/// so it must follow the winner, and a second copy of the tiebreak rule is a
/// second thing that can drift from §10.2.
fn lww_field_keyed_with_winner<T: Clone + PartialEq>(
    field: &str,
    local: &T,
    local_clock: u64,
    remote: &T,
    remote_clock: u64,
    clocks: &mut BTreeMap<String, u64>,
    key: impl Fn(&T) -> Vec<u8>,
) -> (T, bool) {
    let remote_wins = match remote_clock.cmp(&local_clock) {
        core::cmp::Ordering::Greater => true,
        core::cmp::Ordering::Less => false,
        // Equal values need no tiebreak (either side wins identically) — skip
        // the serialization for the common neither-device-touched-it case.
        core::cmp::Ordering::Equal => remote != local && key(remote) > key(local),
    };
    let (winner, winning_clock) = if remote_wins {
        (remote, remote_clock)
    } else {
        (local, local_clock)
    };
    if winning_clock > 0 {
        clocks.insert(field.to_string(), winning_clock);
    }
    (winner.clone(), remote_wins)
}

/// The merge unit for the `saved_views` field: the rendered set plus the raw
/// entries this build could not represent (§9.5.2). The two halves are one
/// array on disk, so they race on ONE clock and tie-break on ONE canonical
/// encoding — see the call site.
#[derive(Clone, Copy, PartialEq)]
struct SavedViewsField<'a> {
    views: &'a [protocol::SavedView],
    opaque: &'a [protocol::OpaqueSavedView],
}

/// The equal-clock tiebreak key of a value: its serde-JSON encoding, except
/// that an unset value (`null`) sorts BELOW every present value (empty key).
/// Without the exception, JSON's `null` (`n` = 0x6E) would byte-compare above
/// every string (`"` = 0x22) — and two never-clocked legacy devices merging a
/// set label against an unset one would erase the label. §10.2: an absent/
/// null value sorts lowest.
fn tiebreak_key<T: Serialize>(value: &T) -> Vec<u8> {
    let bytes = serde_json::to_vec(value).expect("prefs field serializes");
    if bytes == b"null" {
        Vec::new()
    } else {
        bytes
    }
}

/// §10.2 per-key map merge: union of keys; a key present on both sides resolves
/// LWW on its own `<field>/<key>` clock (equal clocks → byte-lexicographically
/// greater canonical value). Winning per-key clocks are recorded under their
/// namespaced names. `local_map`/`remote_map` are passed explicitly (rather than
/// re-read off the view) so the one helper serves every per-key field;
/// `local`/`remote` are still needed to read the per-key clocks.
///
/// Generic over the value type so the SAME merge serves the string→string
/// decoration maps (`device_names`, `item_colors`, `folder_icons`) and the
/// string→sequence container map (`item_order`, MYND-596): the per-key value is
/// LWW-on-whole either way — a whole color string, or a whole per-container
/// child sequence. `V: Serialize` supplies the equal-clock tiebreak encoding
/// via [`lww_field`].
fn merge_per_key_map<V: Serialize + Clone + PartialEq>(
    field: &str,
    local: &PrefsView,
    remote: &PrefsView,
    local_map: &BTreeMap<String, V>,
    remote_map: &BTreeMap<String, V>,
    clocks: &mut BTreeMap<String, u64>,
) -> BTreeMap<String, V> {
    let mut out = BTreeMap::new();
    let keys: std::collections::BTreeSet<&String> =
        local_map.keys().chain(remote_map.keys()).collect();
    for key in keys {
        let clock_key = format!("{field}/{key}");
        match (local_map.get(key), remote_map.get(key)) {
            (Some(l), Some(r)) => {
                let merged = lww_field(
                    &clock_key,
                    l,
                    clock_of(local, &clock_key),
                    r,
                    clock_of(remote, &clock_key),
                    clocks,
                );
                out.insert(key.clone(), merged);
            }
            // Single-sided key (myne#296): the shared rule decides, and the two
            // arms differ only in which side is the present one.
            (Some(v), None) => {
                if single_sided_survives(&clock_key, local, remote, clocks) {
                    out.insert(key.clone(), v.clone());
                }
            }
            (None, Some(v)) => {
                if single_sided_survives(&clock_key, remote, local, clocks) {
                    out.insert(key.clone(), v.clone());
                }
            }
            (None, None) => unreachable!("key came from one of the two maps"),
        }
    }
    out
}

/// The merge discipline of one set-union field, read off the classification as a
/// unit so the two halves cannot be passed in the wrong order.
///
/// They were two adjacent `bool` parameters until clippy's `too_many_arguments`
/// forced the question, and the lint was right for a reason beyond arity: a
/// swapped pair typechecks, and one of the two swaps makes an egress control
/// fail open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SetDiscipline {
    /// Entry identity is the canonical folder key rather than the raw value.
    folded: bool,
    /// A removal may be inherited from a peer. False for the egress controls.
    removals_propagate: bool,
}

/// The discipline of a set-union field, read off the normative classification
/// table.
///
/// It is a function rather than an argument at the merge call site because the
/// STAMPER cannot have a call site: `stamp_changed_shared_fields` iterates
/// `CLASSIFICATION`, so a flag passed at the merge would be unreachable there
/// and the two would derive clock keys from two different expressions. The table
/// is the only place both consumers can read the same answer from.
///
/// Panics on a field merged as a set but not classified as one, which is the
/// half a type cannot catch: the classification and the merge line are written
/// independently, and a disagreement is invisible until a removal stops
/// converging on somebody's second device.
fn set_fold(field: &str) -> SetDiscipline {
    match classify(field) {
        Some(PrefClass::Shared(SharedDiscipline::SetUnion {
            folded,
            removals_propagate,
        })) => SetDiscipline {
            folded,
            removals_propagate,
        },
        _ => panic!(
            "{field} is merged as a set-union but not classified as one; \
             `prefs_classification::CLASSIFICATION` is the single source of that"
        ),
    }
}

/// §10.2 / myne#296: does a key held by exactly ONE side survive the merge?
///
/// The two readings of a single-sided key are "the other side never had it" and
/// "the other side deleted it", and only the clocks tell them apart: a removal
/// stamps `<field>/<key>` on the removing side, a side that never held the key
/// has no clock for it at all. A strictly-greater absent clock is therefore a
/// deletion and wins; anything else keeps the value, equal clocks included,
/// because an entry that survives one extra round can be deleted again while one
/// dropped by a clock collision cannot be recovered.
///
/// Either way the winning clock rides forward, which is the half that makes a
/// deletion CONVERGE rather than merely happen once: without it the peer still
/// holding the value pushes it back on the next round.
///
/// Shared by the per-key map merge and the set merge because it is one normative
/// rule, and the two shapes differ only in the branch where BOTH sides hold the
/// key (a map tiebreaks on the value, a set has no value to tiebreak on). Those
/// stay separate; this does not, so a future refinement to the removal rule
/// cannot be applied to one shape and forgotten on the other.
fn single_sided_survives(
    clock_key: &str,
    present: &PrefsView,
    absent: &PrefsView,
    clocks: &mut BTreeMap<String, u64>,
) -> bool {
    single_sided_clock_rule(
        clock_key,
        clock_of(present, clock_key),
        clock_of(absent, clock_key),
        clocks,
    )
}

/// The stamped-absence rule itself, over raw clocks rather than a `PrefsView`.
///
/// Split out so a SECOND family with the same shape can call the one rule
/// instead of re-deriving it: `vault.dictionary`'s per-word removal clocks
/// (`dictionary_payload::merge_personal_dictionaries`, myne-md/myne#640) are the
/// same single-sided decision over a `word -> clock` map, and a second copy of
/// this comparison is exactly how the two would drift. Everything above is the
/// prefs-shaped adapter; this is the normative rule.
pub(super) fn single_sided_clock_rule(
    clock_key: &str,
    present_clock: u64,
    absent_clock: u64,
    clocks: &mut BTreeMap<String, u64>,
) -> bool {
    if absent_clock > present_clock {
        clocks.insert(clock_key.to_string(), absent_clock);
        return false;
    }
    if present_clock > 0 {
        clocks.insert(clock_key.to_string(), present_clock);
    }
    true
}

/// The identity a set entry races on: the canonical folder key for the four
/// folder sets, the raw value for `spell_languages`. `folded` comes from the
/// classification table, so the merge below and the stamper above cannot pick
/// different keys for the same entry.
///
/// Goes through `crate::folder_key::canonical_folder` rather than the sync
/// module's own fold, and the difference is not cosmetic. A plain fold (NFC plus
/// lowercase) leaves `Projects` and `Projects/` as two identities for one
/// folder, so a removal stamped against one shape would miss the other, and
/// `markdown-dialect.md` §3.6.2 tolerates a missing trailing slash on reads
/// while the Obsidian importer preserves `folder:` verbatim. `canonical_folder`
/// adds the trailing slash and drops empty segments, which makes the identity
/// total over the shapes that can actually reach the set. It is also the module
/// whose own doc says a second copy of this rule is the failure it exists to
/// prevent.
fn set_entry_identity(folded: bool, raw: &str) -> String {
    if folded {
        crate::folder_key::canonical_folder(raw)
    } else {
        raw.to_string()
    }
}

/// Collapse one side's raw entries to `identity -> display form`, where the
/// display form is the byte-lexicographically smallest raw seen for that
/// identity. Unfolded fields are the degenerate case (identity == display).
fn set_by_identity(folded: bool, entries: &[String]) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    for raw in entries {
        out.entry(set_entry_identity(folded, raw))
            .and_modify(|w| {
                if raw < w {
                    *w = raw.clone();
                }
            })
            .or_insert_with(|| raw.clone());
    }
    out
}

/// §10.2 set-union merge **with per-entry removal clocks** (myne#613).
///
/// The union half is unchanged and still conflict-free: an entry either side
/// holds survives. What is new is that an entry present on ONE side only is no
/// longer automatically kept. It is kept unless the absent side's
/// `<field>/<entry>` clock is strictly greater than the present side's, which is
/// that side saying "I deleted this" rather than "I never had it".
///
/// The single-sided rule itself lives in `single_sided_survives`, shared with
/// `merge_per_key_map`. What stays here is the part that genuinely differs: a
/// map picks a winning VALUE when both sides hold the key, while a set has no
/// value to pick and only needs the lexicographic-min display form (MYND-562).
fn merge_set_with_removals(
    field: &str,
    discipline: SetDiscipline,
    local: &PrefsView,
    remote: &PrefsView,
    local_set: &[String],
    remote_set: &[String],
    clocks: &mut BTreeMap<String, u64>,
) -> Vec<String> {
    let SetDiscipline {
        folded,
        removals_propagate,
    } = discipline;
    let lm = set_by_identity(folded, local_set);
    let rm = set_by_identity(folded, remote_set);

    // A removal clock must outlive the entry it removed (myne#613 review).
    //
    // The id set below is built from the two SETS, so a clock whose entry is
    // gone from both sides is never visited, and `merge_prefs` starts `clocks`
    // empty and assigns the result wholesale: the tombstone is not merely
    // skipped, it is deleted. Measured over three rounds before this existed. A
    // deletes at 300 against B at 100 and the clock is kept; merging the two
    // converged views drops it; a third device that was offline for that
    // exchange still holds the entry at 100, meets a peer with no clock at all,
    // and wins. The deletion is undone by a clock three hundred units older.
    //
    // Retention is indefinite, decided 2026-08-29. A horizon was offered and
    // rejected on the ground that a device offline longer than the horizon is
    // exactly the case the clock exists for. The cost is stated in
    // `protocol.md` §9.5.4 beside the budget rather than left implied.
    if removals_propagate {
        let prefix = format!("{field}/");
        for (k, v) in local.field_clocks.iter().chain(remote.field_clocks.iter()) {
            if !k.starts_with(&prefix) {
                continue;
            }
            let carried = clocks.entry(k.clone()).or_insert(*v);
            *carried = (*carried).max(*v);
        }
    }

    let mut out: Vec<String> = Vec::new();
    let ids: std::collections::BTreeSet<&String> = lm.keys().chain(rm.keys()).collect();
    for id in ids {
        let clock_key = format!("{field}/{id}");
        match (lm.get(id), rm.get(id)) {
            // Held by both: no conflict about membership, only about which raw
            // casing to display. Carry the greater clock forward so a later
            // removal on either device has something to beat.
            (Some(l), Some(r)) => {
                // The carry-forward is gated on `removals_propagate` like every
                // other clock touch in this function. It was not, and the arm's
                // own comment two lines down claimed "a monotone set never
                // consults the clocks": a stray clock on an egress control (a
                // corrupted blob, or one written by an earlier build) would then
                // persist across every merge forever, on a field nothing reads
                // it for. Bounded in practice, because the stamper writes none
                // for those fields, which is why this is a tidy-up rather than a
                // live defect.
                if removals_propagate {
                    let c = clock_of(local, &clock_key).max(clock_of(remote, &clock_key));
                    if c > 0 {
                        clocks.insert(clock_key, c);
                    }
                }
                out.push(l.min(r).clone());
            }
            // Single-sided: the same shared rule as the per-key maps.
            // A monotone set never consults the clocks: a single-sided entry
            // always survives, which is the pure union this field had before
            // myne#613 and the only direction an egress control may fail in.
            (Some(v), None) if !removals_propagate => out.push(v.clone()),
            (None, Some(v)) if !removals_propagate => out.push(v.clone()),
            (Some(v), None) => {
                if single_sided_survives(&clock_key, local, remote, clocks) {
                    out.push(v.clone());
                }
            }
            (None, Some(v)) => {
                if single_sided_survives(&clock_key, remote, local, clocks) {
                    out.push(v.clone());
                }
            }
            (None, None) => unreachable!("identity came from one of the two sides"),
        }
    }
    out.sort();
    out
}

/// SHA-256 (lowercase hex) of the **shared subset** of a prefs view — every
/// shared field's serde-JSON value (in the classification table's stable
/// alphabetical order) plus the full `field_clocks` map. This is the push
/// gate's discriminator (`sync-protocol.md` §10.2.1): a purely device-local
/// edit re-encrypts the blob (new nonce) but leaves this hash unchanged, so
/// the sync phase generates no traffic for it.
pub fn shared_subset_hash(view: &PrefsView) -> String {
    use sha2::{Digest, Sha256};
    let v = serde_json::to_value(view).expect("prefs view serializes");
    let mut subset = serde_json::Map::new();
    for (name, class) in CLASSIFICATION {
        if matches!(class, PrefClass::Shared(_)) {
            subset.insert(
                (*name).to_string(),
                v.get(*name).cloned().unwrap_or(serde_json::Value::Null),
            );
        }
    }
    subset.insert(
        "field_clocks".to_string(),
        v.get("field_clocks")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    let bytes =
        serde_json::to_vec(&serde_json::Value::Object(subset)).expect("shared subset serializes");
    super::to_hex(&Sha256::digest(&bytes))
}

/// Stamp `now_ms` into `after.field_clocks` for every **shared** LWW field
/// whose value differs from `before` (MYND-478; `sync-protocol.md` §10.2
/// "stamped by the setter that last changed the field"). Driven by the
/// normative classification table so every current and future setter routed
/// through the central prefs write path stamps correctly with zero per-setter
/// code: device-local fields are never stamped, `device_names` stamps per
/// changed/added key under its namespaced `device_names/<key>` name, and
/// set-union fields stamp per ENTRY under `<field>/<entry>` for both additions
/// and removals (myne#613, superseding this comment's original "set-union fields
/// stay clockless"). Field values are compared via their serde-JSON encodings
/// (deterministic; field names match §9.5.2 keys).
pub fn stamp_changed_shared_fields(before: &PrefsView, after: &mut PrefsView, now_ms: u64) {
    let b = serde_json::to_value(before).expect("prefs view serializes");
    let a = serde_json::to_value(&*after).expect("prefs view serializes");
    let empty = serde_json::Map::new();
    for (name, class) in CLASSIFICATION {
        match class {
            PrefClass::Shared(SharedDiscipline::PerKeyMapMerge) => {
                let bm = b.get(*name).and_then(|v| v.as_object()).unwrap_or(&empty);
                let am = a.get(*name).and_then(|v| v.as_object()).unwrap_or(&empty);
                for (key, value) in am {
                    if bm.get(key) != Some(value) {
                        after.field_clocks.insert(format!("{name}/{key}"), now_ms);
                    }
                }
                // myne#296 — a REMOVED key is a change too, and it was the one
                // change this loop could not see: it iterated only the AFTER
                // map, so clearing a folder colour or resetting a folder icon
                // stamped nothing and therefore had nothing to win a race with,
                // even in principle. The peer's key survived the union in
                // `merge_per_key_map`, came back, and the removal was undone
                // within two rounds — with no concurrency needed, on every
                // removal, while a second device was enrolled.
                //
                // Stamping the absence is what makes "I deleted this" a claim
                // the merge can compare, rather than an absence indistinguishable
                // from "I never had it".
                for key in bm.keys() {
                    if !am.contains_key(key) {
                        after.field_clocks.insert(format!("{name}/{key}"), now_ms);
                    }
                }
            }
            // myne#613: the set analogue of the per-key map arm above, and it
            // stamps BOTH directions rather than only the removal.
            //
            // The removal stamp carries the myne#296 reasoning from the arm
            // above, one shape over.
            //
            // The ADD stamp is the half that is easy to leave out and breaks a
            // case nobody tries by hand. Once removals are stamped, a re-added
            // entry that carries no clock of its own loses to its own tombstone
            // forever: delete `Projects/` at t=200, file a note back into it at
            // t=300, and the folder is registered locally and dropped on every
            // merge. Stamping the add gives it something to win with.
            //
            // Keyed by the classification's own `folded` flag, so the clock key
            // here is byte-identical to the one `merge_set_with_removals`
            // computes. Two call sites deciding that independently is exactly
            // how a stamper and a merge stop agreeing.
            // Unchanged set: nothing to stamp, and worth short-circuiting rather
            // than proving it the long way. Without this, a write that touched
            // `theme` still folds every entry of all five sets on both sides,
            // which under myne#613 is the vault's whole folder list, twice, for
            // an empty symmetric difference. Same guard the scalar arm below
            // uses, and correct for the same reason: equal arrays give equal
            // identity sets.
            PrefClass::Shared(SharedDiscipline::SetUnion { .. })
                if a.get(*name) == b.get(*name) => {}

            // A monotone set stamps nothing at all. There is no removal to
            // record, and stamping an ADD would only grow `field_clocks` with
            // keys no merge ever reads.
            PrefClass::Shared(SharedDiscipline::SetUnion {
                removals_propagate: false,
                ..
            }) => {}
            PrefClass::Shared(SharedDiscipline::SetUnion { folded, .. }) => {
                let ids = |v: Option<&serde_json::Value>| -> std::collections::BTreeSet<String> {
                    v.and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|e| e.as_str())
                                .map(|s| set_entry_identity(*folded, s))
                                .collect()
                        })
                        .unwrap_or_default()
                };
                let before_ids = ids(b.get(*name));
                let after_ids = ids(a.get(*name));
                for id in before_ids.symmetric_difference(&after_ids) {
                    after.field_clocks.insert(format!("{name}/{id}"), now_ms);
                }
            }
            PrefClass::Shared(_) if a.get(*name) != b.get(*name) => {
                after.field_clocks.insert((*name).to_string(), now_ms);
            }
            _ => {}
        }
    }
}

/// Merge a remote `vault.prefs` view into the local one per the normative
/// §10.2 classification. See the module docs for semantics.
pub fn merge_prefs(local: &PrefsView, remote: &PrefsView) -> PrefsView {
    let mut clocks: BTreeMap<String, u64> = BTreeMap::new();

    // A tiny local macro keeps every shared-LWW line down to (name, accessor)
    // so the field name string can never drift from the accessed field.
    macro_rules! lww {
        ($name:literal, $field:ident) => {
            lww_field(
                $name,
                &local.$field,
                clock_of(local, $name),
                &remote.$field,
                clock_of(remote, $name),
                &mut clocks,
            )
        };
    }
    // Sibling macro for per-key map fields — one `$field` drives both the clock
    // namespace and the accessed map, so a name/map mismatch can't be typed
    // (the `lww!` footgun-guard, extended to `device_names` + the MYND-562
    // decoration maps).
    macro_rules! per_key {
        ($name:literal, $field:ident) => {
            merge_per_key_map(
                $name,
                local,
                remote,
                &local.$field,
                &remote.$field,
                &mut clocks,
            )
        };
    }
    // Sibling macro for the set-union fields (myne#613). Same footgun-guard as
    // `lww!` and `per_key!`: one `$field` drives both the clock namespace and
    // the accessed set, so a name/set mismatch cannot be typed. `set_fold` adds
    // the second half, and its own doc says why it is a function rather than an
    // argument here.
    macro_rules! set_union {
        ($name:literal, $field:ident) => {
            merge_set_with_removals(
                $name,
                set_fold($name),
                local,
                remote,
                &local.$field,
                &remote.$field,
                &mut clocks,
            )
        };
    }

    // Folder decorations are per-key map merges too (MYND-562): concurrent edits
    // to DIFFERENT folder keys both survive (whole-map LWW dropped one). Keys are
    // the folded folder identity (`folderKey`) + note UUIDs; note colors gain the
    // same per-key protection for free.
    let device_names = per_key!("device_names", device_names);
    let folder_icons = per_key!("folder_icons", folder_icons);
    let item_colors = per_key!("item_colors", item_colors);
    // item_order (MYND-596): each container path is a key; its child sequence
    // races on `item_order/<container>`, so a reorder in one folder never
    // clobbers another folder's order (whole-sequence LWW dropped one — the
    // exact loss MYND-562 fixed for the decoration maps above).
    let item_order = per_key!("item_order", item_order);
    // periodic_notes (myne#177): keys are `<period>.<setting>`, so a folder edit
    // on one device and a template edit on another, to the SAME period in the
    // same round, race on separate clocks and both survive. That is the whole
    // reason the field is a flat map rather than a map of nested objects: a
    // per-period value would have put both edits on one clock and dropped one.
    let periodic_notes = per_key!("periodic_notes", periodic_notes);
    // saved_views carries an opaque remainder alongside the rendered set: the
    // array entries this build could not represent (§9.5.2), kept so a re-write
    // does not delete a newer client's views. The two halves are ONE encoding
    // and therefore ONE merge unit — the remainder follows whichever side wins
    // the whole-value LWW, and the equal-clock tiebreak compares the full
    // canonical array. Pairing one side's rendered set with the other's raw
    // entries would emit an array neither device wrote; and tiebreaking on the
    // rendered set alone would leave two peers whose sets match but whose
    // remainders differ each keeping its own copy, re-pushing forever.
    let saved_views_field = lww_field_keyed_with_winner(
        "saved_views",
        &SavedViewsField {
            views: &local.saved_views,
            opaque: &local.opaque_saved_views,
        },
        clock_of(local, "saved_views"),
        &SavedViewsField {
            views: &remote.saved_views,
            opaque: &remote.opaque_saved_views,
        },
        clock_of(remote, "saved_views"),
        &mut clocks,
        |f| protocol::canonical_encode_saved_views_with_opaque(f.views, f.opaque),
    )
    .0;
    let saved_views = saved_views_field.views.to_vec();
    let opaque_saved_views = saved_views_field.opaque.to_vec();

    // The struct literal lists EVERY PrefsView field with no `..` — the same
    // compile-time drift lock as the classification conformance test: a new
    // prefs field fails compile here until it gets a merge line matching its
    // §10.2 classification row.
    PrefsView {
        // ---- shared: scalar-LWW -----------------------------------------
        // The remote-provider fields (myne#415, SYNC-15/SYNC-22). LWW rather
        // than a union because a credential cannot be merged — rotating on one
        // device must REPLACE, and revoking propagates as an LWW write of
        // `None`, which is what makes revocation reach the other devices.
        //
        // It was a TRIPLE until myne-md/myne#456. `ai_provider_consent` left for
        // the device-local group below, which is what closes SYNC-22: a device
        // now inherits the selection, the model and the key, and none of those
        // is permission to use them.
        ai_provider: lww!("ai_provider", ai_provider),
        // The one LWW field whose value is `Zeroizing`-wrapped (myne-md/myne#444),
        // so it takes the keyed form for the same reason `saved_views` does: the
        // tiebreak bytes are NORMATIVE (§10.2, "the values' canonical
        // encodings"), and the wrapper is this client's memory-hygiene choice,
        // not a change to what the value encodes as. Keyed on `Option<&str>`,
        // which serializes byte-identically to the `Option<String>` every other
        // implementation holds, so an independent client still picks the same
        // equal-clock winner and no copy of the key is made to ask.
        //
        // It is also the one field a peer can author that a lower-trust reader
        // turns into request framing: `inference::provider_gate::authorize_remote`
        // builds an `Authorization` header from this value, and a CR or an LF
        // inside a credential is the byte that ends an HTTP/1.1 header line.
        //
        // NOT shape-checked here, and the absence is the point. A validity
        // predicate on the LWW winner makes the merged value depend on a rule
        // this client holds and no peer does, and §10.2 makes the tie-break the
        // canonical encodings precisely "so both sides converge independently
        // with no coordination". It also made the `None` arm a fleet-wide write:
        // §10.2 reserves an LWW write of `None` for revocation, so a shape
        // refusal was revoking a credential no user revoked, and
        // `protocol.md` §9.5.2 makes the field `skip_serializing`, so there was
        // no way back but re-pasting a key the app cannot show.
        //
        // A credential carrying a CR or an LF is therefore refused where it is
        // USED, not where it is merged: `authorize_remote` returns
        // `NoCredential`, and `http::codec::build_http_request_ext` strips the
        // writer's interpolated fields behind it. Both have live tests. A
        // malformed value syncs, is refused on every request, and is replaced by
        // the next genuine edit, which is §10.2's own repair argument rather
        // than a new rule. So a malformed value DOES become a device's local
        // view, and the test beside this comment asserts exactly that; what it
        // never becomes is a header.
        //
        // An earlier version of this comment described a shape filter here that
        // was removed for the reasons above, and a reader who skims would have
        // found both statements on the same field. One field, one statement.
        ai_provider_key: lww_field_keyed(
            "ai_provider_key",
            &local.ai_provider_key,
            clock_of(local, "ai_provider_key"),
            &remote.ai_provider_key,
            clock_of(remote, "ai_provider_key"),
            &mut clocks,
            |v| tiebreak_key(&v.as_deref().map(|s| s.as_str())),
        ),
        ai_provider_model: lww!("ai_provider_model", ai_provider_model),
        archive_disabled: lww!("archive_disabled", archive_disabled),
        // ingest-image-compression: a content-fidelity switch with a
        // vault-wide irreversible effect, unlike the device-local compute-
        // budget siblings below (`attachment_ocr_enabled` et al.) — see
        // prefs_classification.rs's comment on this row.
        attachment_compression_enabled: lww!(
            "attachment_compression_enabled",
            attachment_compression_enabled
        ),
        // MYND-613 — Shared/ScalarLww, unlike its lexicographic neighbour
        // `show_note_timestamps`, which is DeviceLocal.
        // Device-local (MYND-618): whether a machine shows reminders, and how
        // far ahead it registers them, are properties of THAT machine — so the
        // local value wins outright rather than merging.
        reminders_enabled: local.reminders_enabled,
        reminder_horizon_days: local.reminder_horizon_days,
        // Device-local (myne#279): the right display zone is a property of where
        // THIS device is, and an IANA zone is a coarse geolocation datum that
        // `dialect/src/taskFields.ts` deliberately keeps out of note bytes.
        timezone: local.timezone.clone(),
        show_task_marker: lww!("show_task_marker", show_task_marker),
        // MYND-592: shared for the same reason as `show_task_marker` — wanting
        // speech-to-text is taste, not device capability.
        transcription_enabled: lww!("transcription_enabled", transcription_enabled),
        // MYND-651: shared for the same reason again — a bundled task-model, so
        // wanting automatic tag suggestions is taste. Its co-gate `ai_enabled`
        // stays device-local below, which is what keeps a synced `true` from
        // starting inference on a device that never opted into AI.
        auto_tag_enabled: lww!("auto_tag_enabled", auto_tag_enabled),
        // myne-md/myne#661: the folder-notes off-switch is shared for the
        // `show_task_marker` reason: honouring folder notes is a note-list
        // presentation preference (taste), not a device capability.
        folder_notes_enabled: lww!("folder_notes_enabled", folder_notes_enabled),
        // myne#279: how a date and a time are PRINTED is taste, so both merge
        // last-writer-wins alongside `daily_date_format`. `timezone` is the
        // exception and stays device-local below — see its comment there.
        date_format: lww!("date_format", date_format),
        time_format: lww!("time_format", time_format),
        daily_date_format: lww!("daily_date_format", daily_date_format),
        daily_folder: lww!("daily_folder", daily_folder),
        daily_template: lww!("daily_template", daily_template),
        icon: lww!("icon", icon),
        label: lww!("label", label),
        // meeting-ai: Shared/ScalarLww. The custom meeting-AI instruction is
        // vault content the user wants on every device, and last-writer-wins is
        // right for a single text value.
        meeting_ai_prompt: lww!("meeting_ai_prompt", meeting_ai_prompt),
        new_note_location: lww!("new_note_location", new_note_location),
        new_note_location_folder: lww!("new_note_location_folder", new_note_location_folder),
        // ---- shared: set-union with per-entry removal clocks (myne#613) ------
        // Was clockless until myne#613, which is what made a removal
        // unexpressible: the peer's copy came back within two rounds and every
        // folder delete undid itself on a multi-device vault. `set_union!` reads
        // the fold discipline off the classification table rather than repeating
        // it here, so folder sets (`personal/` ≡ `PERSONAL/`, MYND-562) and
        // case-sensitive language codes cannot drift apart from their rows.
        ai_excluded_folders: set_union!("ai_excluded_folders", ai_excluded_folders),
        archived_folders: set_union!("archived_folders", archived_folders),
        // myne-cli epic (MYND-490): a folder-path set, same discipline as
        // ai_excluded_folders/archived_folders/deliberate_folders — an exclusion
        // added on one device must never be lost in a merge with a device that
        // lacks it.
        cli_excluded_folders: set_union!("cli_excluded_folders", cli_excluded_folders),
        deliberate_folders: set_union!("deliberate_folders", deliberate_folders),
        spell_languages: set_union!("spell_languages", spell_languages),
        // ---- shared: sequence-LWW-on-whole -------------------------------
        favorites: lww!("favorites", favorites),
        view_order: lww!("view_order", view_order),
        // ---- shared: whole-value LWW -------------------------------------
        // (saved_views / color_groups need their codec's canonical encoder —
        // serde would emit struct-declaration key order.)
        // computed above so the winning side's opaque remainder can follow it.
        saved_views,
        opaque_saved_views,
        // color_groups (MYND-604): order IS rule precedence, so — unlike
        // saved_views — the tiebreak key must NOT re-sort; the canonical
        // encoder already preserves slice order verbatim, which is exactly
        // what `lww_field_keyed` needs (a deterministic byte key per value).
        color_groups: lww_field_keyed(
            "color_groups",
            &local.color_groups,
            clock_of(local, "color_groups"),
            &remote.color_groups,
            clock_of(remote, "color_groups"),
            &mut clocks,
            |v| protocol::canonical_encode_color_groups(v),
        ),
        // ---- shared: per-key map merge (MYND-478 device_names; MYND-562
        // folder decorations) — computed above so each borrows `clocks` once.
        device_names,
        folder_icons,
        item_colors,
        // item_order (MYND-596): per-container map merge, computed above so it
        // borrows `clocks` once — moved here from the sequence-LWW group.
        item_order,
        // periodic_notes (myne#177): per-setting map merge, same reason.
        periodic_notes,
        // ---- device-local: local wins, always -----------------------------
        active_workspace: local.active_workspace.clone(),
        // Device-local for the reason the classification table gives: a bound
        // on how much THIS machine sends to a provider. The local value always
        // survives the merge.
        chat_history_budget: local.chat_history_budget,
        ai_enabled: local.ai_enabled,
        // myne-md/myne#456: moved out of the scalar-LWW group above. Approving a
        // provider is a decision a person makes AT a device, not a fact about
        // the account, so it must not arrive by sync. The local value winning
        // "always" is exactly right here: a remote `Some("openrouter")` may not
        // overwrite a local `None`, because that would be the whole SYNC-22
        // defect wearing a merge rule's clothes.
        ai_provider_consent: local.ai_provider_consent.clone(),
        // MYND-441: device-local like `ai_enabled`, and for the same reason —
        // battery and thermal capacity differ per device, so turning OCR off on
        // a phone must not turn it off on the desktop.
        attachment_ocr_enabled: local.attachment_ocr_enabled,
        auto_lock_seconds: local.auto_lock_seconds,
        bar_items_order: local.bar_items_order.clone(),
        // myne-md/myne#699: the rail layout is a per-device chrome choice, like
        // bar_items_order above, so the local value always survives the merge.
        ribbon_items: local.ribbon_items.clone(),
        ribbon_visible: local.ribbon_visible,
        // myne-cli epic (MYND-490): a per-machine door + performance knob — the
        // local value always survives the merge, same discipline as ai_enabled.
        cli_enabled: local.cli_enabled,
        cli_rate_limit_disabled: local.cli_rate_limit_disabled,
        custom_theme: local.custom_theme.clone(),
        // developer-mode (MYND-593): device-local like `ai_enabled` — it gates
        // a device-local model-path override, so a synced flag would read "on"
        // on a device with no override behind it.
        developer_mode: local.developer_mode,
        editor_content_width: local.editor_content_width.clone(),
        editor_default_view_mode: local.editor_default_view_mode.clone(),
        editor_focus_dim_inactive: local.editor_focus_dim_inactive,
        editor_focus_typewriter: local.editor_focus_typewriter,
        editor_font_family: local.editor_font_family.clone(),
        editor_layout: local.editor_layout,
        editor_line_numbers: local.editor_line_numbers,
        editor_line_spacing: local.editor_line_spacing.clone(),
        editor_slash_hidden: local.editor_slash_hidden.clone(),
        editor_slash_order: local.editor_slash_order.clone(),
        editor_text_size: local.editor_text_size.clone(),
        editor_toolbar_hidden: local.editor_toolbar_hidden.clone(),
        editor_toolbar_order: local.editor_toolbar_order.clone(),
        // vim-keyboard-mode (MYND-313): device-local — the local value always
        // survives the merge, like every other editor preference.
        editor_vim_mode: local.editor_vim_mode,
        hidden_bar_items: local.hidden_bar_items.clone(),
        keymap: local.keymap.clone(),
        last_backup_at: local.last_backup_at,
        paired_extensions: local.paired_extensions.clone(),
        right_panel_active_tab: local.right_panel_active_tab.clone(),
        right_panel_hidden_tabs: local.right_panel_hidden_tabs.clone(),
        right_panel_tab_order: local.right_panel_tab_order.clone(),
        screen_capture_protection: local.screen_capture_protection,
        show_note_timestamps: local.show_note_timestamps,
        spell_enabled: local.spell_enabled,
        startup_open: local.startup_open.clone(),
        startup_open_note: local.startup_open_note.clone(),
        theme: local.theme,
        // ---- merge metadata ------------------------------------------------
        field_clocks: clocks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::prefs_classification::classify;
    use zeroize::Zeroizing;

    fn stamped(view: &mut PrefsView, field: &str, clock: u64) {
        view.field_clocks.insert(field.to_string(), clock);
    }

    /// Device-local fields reset to defaults so the commutativity assertion
    /// compares only what §10.2 promises converges (shared fields + merged
    /// clocks). Table-driven via a serde-Value overlay — the same mechanism
    /// the production hash/stamp paths use — so it never drifts from the
    /// classification.
    fn shared_projection(view: &PrefsView) -> PrefsView {
        let mut v = serde_json::to_value(view).expect("prefs view serializes");
        let d = serde_json::to_value(PrefsView::default()).expect("defaults serialize");
        for (name, class) in CLASSIFICATION {
            if *class == PrefClass::DeviceLocal {
                v[*name] = d[*name].clone();
            }
        }
        serde_json::from_value(v).expect("projected view deserializes")
    }

    #[test]
    fn newer_clock_wins_both_directions() {
        let mut a = PrefsView {
            label: Some("Phone".into()),
            ..PrefsView::default()
        };
        stamped(&mut a, "label", 200);
        let mut b = PrefsView {
            label: Some("Desktop".into()),
            ..PrefsView::default()
        };
        stamped(&mut b, "label", 100);

        let ab = merge_prefs(&a, &b);
        let ba = merge_prefs(&b, &a);
        assert_eq!(ab.label.as_deref(), Some("Phone"));
        assert_eq!(ba.label.as_deref(), Some("Phone"));
        assert_eq!(ab.field_clocks.get("label"), Some(&200));
        assert_eq!(ba.field_clocks.get("label"), Some(&200));
    }

    #[test]
    fn attachment_compression_enabled_is_shared_scalar_lww() {
        // ingest-image-compression: unlike attachment_ocr_enabled (device-local),
        // this toggle is shared — a vault-wide, irreversible content-fidelity
        // switch, so the newer clock wins in both directions like `label`.
        let mut a = PrefsView {
            attachment_compression_enabled: false,
            ..PrefsView::default()
        };
        stamped(&mut a, "attachment_compression_enabled", 200);
        let mut b = PrefsView {
            attachment_compression_enabled: true,
            ..PrefsView::default()
        };
        stamped(&mut b, "attachment_compression_enabled", 100);

        let ab = merge_prefs(&a, &b);
        let ba = merge_prefs(&b, &a);
        assert!(!ab.attachment_compression_enabled);
        assert!(!ba.attachment_compression_enabled);
        assert_eq!(
            ab.field_clocks.get("attachment_compression_enabled"),
            Some(&200)
        );
        assert_eq!(
            ba.field_clocks.get("attachment_compression_enabled"),
            Some(&200)
        );
    }

    #[test]
    fn equal_clocks_tie_break_lexicographically_greater() {
        let mut a = PrefsView {
            label: Some("Alpha".into()),
            ..PrefsView::default()
        };
        stamped(&mut a, "label", 500);
        let mut b = PrefsView {
            label: Some("Zulu".into()),
            ..PrefsView::default()
        };
        stamped(&mut b, "label", 500);

        // "Zulu" > "Alpha" byte-lexicographically — wins from either side.
        assert_eq!(merge_prefs(&a, &b).label.as_deref(), Some("Zulu"));
        assert_eq!(merge_prefs(&b, &a).label.as_deref(), Some("Zulu"));
    }

    #[test]
    fn absent_clock_counts_as_zero_migration_case() {
        // Legacy local (pre-MYND-478: real label, no clock) vs a remote that
        // renamed post-upgrade: the clocked write wins — and the reverse
        // direction agrees.
        let legacy = PrefsView {
            label: Some("Old Name".into()),
            ..PrefsView::default()
        };
        let mut upgraded = PrefsView {
            label: Some("New Name".into()),
            ..PrefsView::default()
        };
        stamped(&mut upgraded, "label", 1);

        assert_eq!(
            merge_prefs(&legacy, &upgraded).label.as_deref(),
            Some("New Name")
        );
        assert_eq!(
            merge_prefs(&upgraded, &legacy).label.as_deref(),
            Some("New Name")
        );
    }

    #[test]
    fn concurrent_edits_to_different_fields_both_survive() {
        // The reason per-field clocks exist (§10.2): an offline rename on one
        // device and a favorites edit on the other must both survive.
        let mut a = PrefsView {
            label: Some("Renamed Offline".into()),
            ..PrefsView::default()
        };
        stamped(&mut a, "label", 300);
        let mut b = PrefsView {
            favorites: vec!["note-1".into()],
            ..PrefsView::default()
        };
        stamped(&mut b, "favorites", 400);

        let merged = merge_prefs(&a, &b);
        assert_eq!(merged.label.as_deref(), Some("Renamed Offline"));
        assert_eq!(merged.favorites, vec!["note-1".to_string()]);
    }

    /// Renamed by myne#613, which made these fields carry per-entry removal
    /// clocks: the old name claimed clocklessness, which is now false, while the
    /// body asserts the UNION result, which is still true and still the point.
    /// A name that describes a rule the code no longer follows is worse than no
    #[test]
    fn set_union_fields_union_when_neither_side_claims_a_removal() {
        let a = PrefsView {
            ai_excluded_folders: vec!["Private/".into(), "Journal/".into()],
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            deliberate_folders: vec!["A/".into()],
            ..PrefsView::default()
        };
        let b = PrefsView {
            ai_excluded_folders: vec!["Private/".into(), "Work/".into()],
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            deliberate_folders: vec!["B/".into()],
            ..PrefsView::default()
        };

        let merged = merge_prefs(&a, &b);
        assert_eq!(
            merged.ai_excluded_folders,
            vec![
                "Journal/".to_string(),
                "Private/".to_string(),
                "Work/".to_string()
            ]
        );
        assert_eq!(
            merged.deliberate_folders,
            vec!["A/".to_string(), "B/".to_string()]
        );
        assert!(merged.field_clocks.is_empty());
    }

    /// myne-cli epic (MYND-490): an exclusion added on one device must never
    /// be lost in a merge with a device that never touched the list — the
    /// same fail-safe SetUnion discipline as `ai_excluded_folders`.
    #[test]
    fn cli_excluded_folders_union_survives_a_device_that_lacks_it() {
        let a = PrefsView {
            cli_excluded_folders: vec!["Journal/".into()],
            ..PrefsView::default()
        };
        let b = PrefsView::default(); // never touched the CLI exclusion list

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert_eq!(merged.cli_excluded_folders, vec!["Journal/".to_string()]);
        }
        assert!(merge_prefs(&a, &b).field_clocks.is_empty());
    }

    #[test]
    fn folder_path_sets_fold_case_variants() {
        // MYND-562: a folder present as "personal/" on one device and
        // "PERSONAL/" on the other collapses to one canonical entry through the
        // merge (lexicographic-min survives).
        let a = PrefsView {
            deliberate_folders: vec!["personal/".into()],
            ..PrefsView::default()
        };
        let b = PrefsView {
            deliberate_folders: vec!["PERSONAL/".into()],
            ..PrefsView::default()
        };
        assert_eq!(
            merge_prefs(&a, &b).deliberate_folders,
            vec!["PERSONAL/".to_string()]
        );

        // `spell_languages` is NOT a folder set — case is significant, both survive.
        let a2 = PrefsView {
            spell_languages: vec!["en".into()],
            ..PrefsView::default()
        };
        let b2 = PrefsView {
            spell_languages: vec!["EN".into()],
            ..PrefsView::default()
        };
        assert_eq!(
            merge_prefs(&a2, &b2).spell_languages,
            vec!["EN".to_string(), "en".to_string()]
        );
    }

    #[test]
    fn item_order_merges_per_container_independently() {
        // MYND-596: item_order is a per-container map, so two devices reordering
        // DIFFERENT containers between syncs BOTH survive (the old whole-sequence
        // LWW dropped one). A container edited on both sides resolves LWW on its
        // own `item_order/<container>` clock; a single-sided container is carried
        // over verbatim. This is the MYND-562 per-key-map guarantee applied to
        // the sidebar order.
        let mut a = PrefsView {
            item_order: BTreeMap::from([
                (String::new(), vec!["n1".into(), "n2".into()]),
                ("Projects/".into(), vec!["Projects/Alpha/".into()]),
                // Only local has an Archive/ ordering.
                ("Archive/".into(), vec!["Archive/2024/".into()]),
            ]),
            ..PrefsView::default()
        };
        stamped(&mut a, "item_order/", 10); // root: newer locally
        stamped(&mut a, "item_order/Projects/", 5); // Projects/: older locally
        stamped(&mut a, "item_order/Archive/", 7);

        let mut b = PrefsView {
            item_order: BTreeMap::from([
                (String::new(), vec!["nX".into(), "nY".into()]),
                (
                    "Projects/".into(),
                    vec!["Projects/Beta/".into(), "Projects/Alpha/".into()],
                ),
            ]),
            ..PrefsView::default()
        };
        stamped(&mut b, "item_order/", 8); // root: older on remote
        stamped(&mut b, "item_order/Projects/", 20); // Projects/: newer on remote

        let merged = merge_prefs(&a, &b);
        // Root container: local clock (10) > remote (8) → local order kept.
        assert_eq!(
            merged.item_order.get(""),
            Some(&vec!["n1".to_string(), "n2".to_string()])
        );
        // Projects/: remote clock (20) > local (5) → remote order kept, WITHOUT
        // clobbering the root reorder above.
        assert_eq!(
            merged.item_order.get("Projects/"),
            Some(&vec![
                "Projects/Beta/".to_string(),
                "Projects/Alpha/".to_string()
            ])
        );
        // Archive/ exists only on local → carried over verbatim.
        assert_eq!(
            merged.item_order.get("Archive/"),
            Some(&vec!["Archive/2024/".to_string()])
        );
    }

    #[test]
    fn stamping_item_order_clocks_each_changed_container() {
        // MYND-596: the central write path stamps item_order per-CONTAINER, so
        // the merge above can resolve each container independently. A changed
        // root and a changed "Archive/" get distinct `item_order/<container>`
        // clocks; an untouched "Projects/" gets none; and the bare field name is
        // NEVER stamped (that was the old whole-sequence LWW key).
        let before = PrefsView {
            item_order: BTreeMap::from([
                (String::new(), vec!["n1".into()]),
                ("Projects/".into(), vec!["Projects/A/".into()]),
                ("Archive/".into(), vec!["Archive/1/".into()]),
            ]),
            ..PrefsView::default()
        };
        let mut after = PrefsView {
            item_order: BTreeMap::from([
                (String::new(), vec!["n2".into(), "n1".into()]), // changed
                ("Projects/".into(), vec!["Projects/A/".into()]), // unchanged
                (
                    "Archive/".into(),
                    vec!["Archive/2/".into(), "Archive/1/".into()],
                ), // changed
            ]),
            ..PrefsView::default()
        };
        stamp_changed_shared_fields(&before, &mut after, 999);
        assert_eq!(after.field_clocks.get("item_order/"), Some(&999));
        assert_eq!(after.field_clocks.get("item_order/Archive/"), Some(&999));
        assert!(!after.field_clocks.contains_key("item_order/Projects/"));
        assert!(!after.field_clocks.contains_key("item_order"));
    }

    #[test]
    fn device_local_fields_survive_a_newer_remote() {
        let mut local = PrefsView {
            auto_lock_seconds: Some(30),
            ..PrefsView::default()
        };
        local.theme = None; // follow OS
        let mut remote = PrefsView {
            auto_lock_seconds: Some(600),
            ..PrefsView::default()
        };
        // Even a (bogus) remote clock on a device-local field changes nothing.
        stamped(&mut remote, "auto_lock_seconds", u64::MAX);

        let merged = merge_prefs(&local, &remote);
        assert_eq!(merged.auto_lock_seconds, Some(30));
        // And the bogus clock entry is NOT propagated into the merged map.
        assert!(!merged.field_clocks.contains_key("auto_lock_seconds"));
    }

    /// myne-md/myne#456: the consent does NOT travel and the key DOES, and the
    /// test asserts both in one merge because either half alone is satisfied by
    /// a defect.
    ///
    /// Assert only "consent does not arrive" and a change that made the whole AI
    /// cluster device-local passes, while silently breaking revocation: deleting
    /// a key on one device would stop reaching the others, so a compromised
    /// credential would keep working on every device the user did not visit.
    /// Assert only "the key arrives" and the SYNC-22 defect this closes is
    /// untouched. The pair is the property.
    ///
    /// The direction matters too. The remote carries a consent and the LOCAL
    /// side has none, which is exactly the newly-enrolled-device shape: an
    /// approval made on a laptop must not become an approval by this device.
    #[test]
    fn consent_does_not_travel_but_the_key_does() {
        assert_eq!(
            classify("ai_provider_consent"),
            Some(PrefClass::DeviceLocal)
        );

        // The newly-enrolled device: nothing approved here.
        let local = PrefsView {
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider: None,
            ..PrefsView::default()
        };
        // The laptop that configured everything, with a clock that would win.
        let mut remote = PrefsView {
            ai_provider: Some("openrouter".into()),
            ai_provider_consent: Some("openrouter".into()),
            ai_provider_key: Some(zeroize::Zeroizing::new("sk-remote".into())),
            ..PrefsView::default()
        };
        stamped(&mut remote, "ai_provider", u64::MAX);
        stamped(&mut remote, "ai_provider_consent", u64::MAX);
        stamped(&mut remote, "ai_provider_key", u64::MAX);

        let merged = merge_prefs(&local, &remote);

        assert_eq!(
            merged.ai_provider_consent, None,
            "an approval made on another device must not arrive by sync (SYNC-22)"
        );
        assert_eq!(
            merged.ai_provider.as_deref(),
            Some("openrouter"),
            "the SELECTION is an account fact and still travels"
        );
        assert_eq!(
            merged.ai_provider_key.as_deref().map(|k| k.as_str()),
            Some("sk-remote"),
            "the credential still travels, so rotating it on one device reaches the rest"
        );
        // A device-local field carries no clock into the merged map, which is
        // what stops a later merge from resurrecting it as a shared value.
        assert!(!merged.field_clocks.contains_key("ai_provider_consent"));

        // The other direction, because revocation is the case a one-way test
        // would miss: clearing the key on the remote must reach this device.
        let configured_local = PrefsView {
            ai_provider: Some("openrouter".into()),
            ai_provider_consent: Some("openrouter".into()),
            ai_provider_key: Some(zeroize::Zeroizing::new("sk-old".into())),
            ..PrefsView::default()
        };
        let mut revoked_remote = PrefsView {
            ai_provider: None,
            ai_provider_key: None,
            ..PrefsView::default()
        };
        stamped(&mut revoked_remote, "ai_provider", u64::MAX);
        stamped(&mut revoked_remote, "ai_provider_key", u64::MAX);

        let after_revoke = merge_prefs(&configured_local, &revoked_remote);
        assert_eq!(
            after_revoke.ai_provider_key, None,
            "a revoke must reach every device, which is why the key stays shared"
        );
        assert_eq!(
            after_revoke.ai_provider_consent.as_deref(),
            Some("openrouter"),
            "this device's own approval is untouched by a remote revoke; the gate \
             is an equality against the active provider, so with the provider \
             cleared it refuses anyway"
        );
    }

    /// MYND-651: `auto_tag_enabled` is Shared/ScalarLww, so the newer clock
    /// wins and the flag DOES cross devices — the deliberate contrast with its
    /// device-local co-gate `ai_enabled`, which does not. The pair is what makes
    /// the classification safe: a synced `true` cannot start inference on a
    /// device that never opted into AI.
    #[test]
    fn auto_tag_enabled_is_shared_lww_unlike_its_ai_enabled_co_gate() {
        assert_eq!(
            classify("auto_tag_enabled"),
            Some(PrefClass::Shared(SharedDiscipline::ScalarLww))
        );

        let local = PrefsView {
            auto_tag_enabled: false,
            ..PrefsView::default()
        };
        let mut remote = PrefsView {
            auto_tag_enabled: true,
            // The co-gate is set on the remote too, and must NOT come with it.
            ai_enabled: true,
            ..PrefsView::default()
        };
        stamped(&mut remote, "auto_tag_enabled", u64::MAX);
        stamped(&mut remote, "ai_enabled", u64::MAX);

        let merged = merge_prefs(&local, &remote);
        assert!(
            merged.auto_tag_enabled,
            "newer remote clock wins the scalar"
        );
        assert!(
            !merged.ai_enabled,
            "ai_enabled is device-local — local's off must survive"
        );
        assert!(!merged.field_clocks.contains_key("ai_enabled"));

        // And a newer LOCAL clock keeps the local value against a set remote.
        let mut local_off = PrefsView {
            auto_tag_enabled: false,
            ..PrefsView::default()
        };
        stamped(&mut local_off, "auto_tag_enabled", u64::MAX);
        let remote_on = PrefsView {
            auto_tag_enabled: true,
            ..PrefsView::default()
        };
        assert!(!merge_prefs(&local_off, &remote_on).auto_tag_enabled);
    }

    /// myne-cli epic (MYND-490): the CLI door is a per-machine decision, so it
    /// must NOT propagate across a merge — after merging local=false with a
    /// remote that has it on, the merged value stays local's (`false`), same
    /// as `ai_enabled`'s device-local discipline.
    #[test]
    fn cli_enabled_does_not_propagate_across_a_merge() {
        let local = PrefsView {
            cli_enabled: false,
            ..PrefsView::default()
        };
        let mut remote = PrefsView {
            cli_enabled: true,
            ..PrefsView::default()
        };
        // Even a (bogus) remote clock on a device-local field changes nothing.
        stamped(&mut remote, "cli_enabled", u64::MAX);

        let merged = merge_prefs(&local, &remote);
        assert!(!merged.cli_enabled);
        assert!(!merged.field_clocks.contains_key("cli_enabled"));

        // And the reverse: local=true survives a remote that has it off.
        let local_on = PrefsView {
            cli_enabled: true,
            ..PrefsView::default()
        };
        let remote_off = PrefsView {
            cli_enabled: false,
            ..PrefsView::default()
        };
        assert!(merge_prefs(&local_on, &remote_off).cli_enabled);
    }

    /// Same device-local discipline for the rate-limit toggle — a machine-local
    /// performance knob, not a shared preference.
    #[test]
    fn cli_rate_limit_disabled_does_not_propagate_across_a_merge() {
        let local = PrefsView {
            cli_rate_limit_disabled: None,
            ..PrefsView::default()
        };
        let remote = PrefsView {
            cli_rate_limit_disabled: Some(true),
            ..PrefsView::default()
        };
        assert_eq!(merge_prefs(&local, &remote).cli_rate_limit_disabled, None);
    }

    #[test]
    fn device_names_merge_per_key() {
        // Disjoint keys union; a shared key resolves on its own namespaced clock.
        let mut a = PrefsView::default();
        a.device_names.insert("aa11".into(), "Laptop".into());
        a.device_names.insert("cc33".into(), "Old Name".into());
        stamped(&mut a, "device_names/aa11", 100);
        stamped(&mut a, "device_names/cc33", 50);
        let mut b = PrefsView::default();
        b.device_names.insert("bb22".into(), "Phone".into());
        b.device_names.insert("cc33".into(), "New Name".into());
        stamped(&mut b, "device_names/bb22", 200);
        stamped(&mut b, "device_names/cc33", 60);

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert_eq!(merged.device_names.get("aa11").unwrap(), "Laptop");
            assert_eq!(merged.device_names.get("bb22").unwrap(), "Phone");
            assert_eq!(merged.device_names.get("cc33").unwrap(), "New Name");
            assert_eq!(merged.field_clocks.get("device_names/cc33"), Some(&60));
        }
    }

    #[test]
    fn decoration_maps_merge_per_key() {
        // MYND-562: `item_colors` / `folder_icons` are per-key map merges, not
        // whole-map LWW. Concurrent edits to DIFFERENT folder keys must both
        // survive (the lost-update the whole-map LWW dropped); the SAME key
        // resolves LWW on its own `<field>/<key>` clock; note-UUID color keys
        // ride the same path.
        let mut a = PrefsView::default();
        a.item_colors.insert("work/".into(), "#red".into());
        a.item_colors.insert("uuid-note".into(), "#a1a1a1".into());
        a.folder_icons.insert("work/".into(), "briefcase".into());
        stamped(&mut a, "item_colors/work/", 100);
        stamped(&mut a, "item_colors/uuid-note", 100);
        stamped(&mut a, "folder_icons/work/", 100);

        let mut b = PrefsView::default();
        b.item_colors.insert("personal/".into(), "#blue".into()); // different folder
        b.item_colors.insert("work/".into(), "#green".into()); // same folder, newer clock
        b.folder_icons.insert("personal/".into(), "leaf".into());
        stamped(&mut b, "item_colors/personal/", 200);
        stamped(&mut b, "item_colors/work/", 300);
        stamped(&mut b, "folder_icons/personal/", 200);

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            // Same key: newer clock (300 > 100) wins.
            assert_eq!(merged.item_colors.get("work/").unwrap(), "#green");
            // Different folders: BOTH survive (whole-map LWW would drop one).
            assert_eq!(merged.item_colors.get("personal/").unwrap(), "#blue");
            // Note-UUID color survives on its own key.
            assert_eq!(merged.item_colors.get("uuid-note").unwrap(), "#a1a1a1");
            assert_eq!(merged.folder_icons.get("work/").unwrap(), "briefcase");
            assert_eq!(merged.folder_icons.get("personal/").unwrap(), "leaf");
            assert_eq!(merged.field_clocks.get("item_colors/work/"), Some(&300));
        }
    }

    #[test]
    fn periodic_notes_merges_per_setting_not_per_period() {
        // myne#177. The flat `<period>.<setting>` key shape was chosen over a
        // map of nested objects for exactly this: two edits to the SAME period
        // in the same round, on different settings, must both survive. With a
        // per-period value they would have shared one clock and one would have
        // been dropped. Asserting the property rather than the shape, because
        // the shape is what a later refactor would change.
        let mut a = PrefsView::default();
        a.periodic_notes
            .insert("weekly.folder".into(), "Weekly/".into());
        a.periodic_notes
            .insert("monthly.format".into(), "YYYY-MM".into());
        stamped(&mut a, "periodic_notes/weekly.folder", 100);
        stamped(&mut a, "periodic_notes/monthly.format", 100);

        let mut b = PrefsView::default();
        // Same period, different setting: must not clobber a's folder.
        b.periodic_notes
            .insert("weekly.template".into(), "0190a000-tmpl".into());
        // Same key, newer clock: must win.
        b.periodic_notes
            .insert("monthly.format".into(), "YYYY/MM".into());
        stamped(&mut b, "periodic_notes/weekly.template", 200);
        stamped(&mut b, "periodic_notes/monthly.format", 300);

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert_eq!(
                merged.periodic_notes.get("weekly.folder").unwrap(),
                "Weekly/"
            );
            assert_eq!(
                merged.periodic_notes.get("weekly.template").unwrap(),
                "0190a000-tmpl"
            );
            assert_eq!(
                merged.periodic_notes.get("monthly.format").unwrap(),
                "YYYY/MM"
            );
            assert_eq!(
                merged.field_clocks.get("periodic_notes/monthly.format"),
                Some(&300)
            );
        }
    }

    // ── myne#296: a removal must be representable ───────────────────────────
    //
    // Before this, a per-key map merge was a pure key UNION with no way to say
    // "I deleted this". Clearing a folder colour or resetting a folder icon
    // stamped nothing (the stamper iterated only the after-map), so the peer's
    // copy survived the union, came back, and the removal was undone within two
    // rounds — with no concurrency needed, on every removal, while a second
    // device was enrolled. The map's own GC was defeated the same way: a colour
    // key pruned after its note was deleted, or dropped on a folder rename, came
    // straight back from the peer.

    #[test]
    fn a_removed_key_stays_removed() {
        // A had the colour and cleared it; B still holds it, stamped older.
        let mut a = PrefsView::default();
        stamped(&mut a, "item_colors/work/", 300); // the removal's stamp
        let mut b = PrefsView::default();
        b.item_colors.insert("work/".into(), "#red".into());
        stamped(&mut b, "item_colors/work/", 100);

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert!(
                !merged.item_colors.contains_key("work/"),
                "the removal wins over the peer's older value"
            );
            assert_eq!(
                merged.field_clocks.get("item_colors/work/"),
                Some(&300),
                "and carries its clock, so the peer drops it next round rather \
                 than pushing it back"
            );
        }
    }

    #[test]
    fn a_key_the_peer_never_had_still_unions_in() {
        // The other reading of a single-sided key, and the one the union got
        // right: B simply never held this folder's colour. No clock on B's side,
        // so nothing claims a deletion.
        let mut a = PrefsView::default();
        a.item_colors.insert("work/".into(), "#red".into());
        stamped(&mut a, "item_colors/work/", 100);
        let b = PrefsView::default();

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert_eq!(merged.item_colors.get("work/").unwrap(), "#red");
        }
    }

    #[test]
    fn a_re_add_after_a_removal_wins_on_the_newer_clock() {
        // A cleared it at T=100; B set a new colour at T=200. The value is newer
        // than the deletion, so it comes back.
        let mut a = PrefsView::default();
        stamped(&mut a, "item_colors/work/", 100);
        let mut b = PrefsView::default();
        b.item_colors.insert("work/".into(), "#blue".into());
        stamped(&mut b, "item_colors/work/", 200);

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert_eq!(merged.item_colors.get("work/").unwrap(), "#blue");
        }
    }

    #[test]
    fn an_equal_clock_keeps_the_value() {
        // The conservative tiebreak: a decoration that survives one extra round
        // is recoverable; a value dropped by a clock collision is not.
        let mut a = PrefsView::default();
        stamped(&mut a, "folder_icons/work/", 100);
        let mut b = PrefsView::default();
        b.folder_icons.insert("work/".into(), "briefcase".into());
        stamped(&mut b, "folder_icons/work/", 100);

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert_eq!(merged.folder_icons.get("work/").unwrap(), "briefcase");
        }
    }

    #[test]
    fn clearing_a_key_stamps_its_absence() {
        // The stamper's half: without this the merge above has nothing to
        // compare, because an absence with no clock is indistinguishable from
        // "this device never had the key".
        let mut before = PrefsView::default();
        before.item_colors.insert("work/".into(), "#red".into());
        before
            .folder_icons
            .insert("work/".into(), "briefcase".into());
        let mut after = PrefsView::default();

        stamp_changed_shared_fields(&before, &mut after, 777);

        assert_eq!(after.field_clocks.get("item_colors/work/"), Some(&777));
        assert_eq!(after.field_clocks.get("folder_icons/work/"), Some(&777));
    }

    /// The merge is a max under §10.2's total order and nothing else, so it
    /// adopts the clock winner whatever its bytes. This is the regression test
    /// for the shape filter that was here and was removed: it asserts the
    /// ABSENCE of a client-local rule, so re-adding one turns it red rather than
    /// quietly re-introducing a divergence no peer implements. A malformed
    /// credential is refused where it is used (`provider_gate::authorize_remote`)
    /// and stripped at the writer (`http::codec::build_http_request_ext`); both
    /// have their own live tests.
    #[test]
    fn the_merge_adopts_the_clock_winner_whatever_its_bytes() {
        let mut local = PrefsView {
            ai_provider_key: Some(Zeroizing::new("sk-good".into())),
            ..PrefsView::default()
        };
        stamped(&mut local, "ai_provider_key", 100);
        let mut remote = PrefsView {
            ai_provider_key: Some(Zeroizing::new("sk-bad\r\nX-Injected: 1".into())),
            ..PrefsView::default()
        };
        stamped(&mut remote, "ai_provider_key", 200);

        let ab = merge_prefs(&local, &remote);
        let ba = merge_prefs(&remote, &local);
        assert_eq!(
            ab.ai_provider_key.as_ref().map(|k| k.as_str()),
            ba.ai_provider_key.as_ref().map(|k| k.as_str()),
            "both orders must select the same value, or the pair never converges"
        );
        assert_eq!(
            ab.ai_provider_key.as_ref().map(|k| k.as_str()),
            Some("sk-bad\r\nX-Injected: 1"),
            "the newer clock wins on its bytes; the merge carries no validity rule"
        );
    }

    #[test]
    fn merge_is_commutative_on_the_shared_subset() {
        // A rich pair exercising every discipline at once.
        let mut a = PrefsView {
            label: Some("A-Label".into()),
            ..PrefsView::default()
        };
        stamped(&mut a, "label", 100);
        a.icon = Some("book".into());
        stamped(&mut a, "icon", 300);
        a.favorites = vec!["f1".into()];
        stamped(&mut a, "favorites", 10);
        a.ai_excluded_folders = vec!["P/".into()];
        a.device_names.insert("d1".into(), "One".into());
        stamped(&mut a, "device_names/d1", 5);
        a.theme = None;
        a.auto_lock_seconds = Some(30);

        let mut b = PrefsView {
            label: Some("B-Label".into()),
            ..PrefsView::default()
        };
        stamped(&mut b, "label", 200);
        b.icon = Some("leaf".into());
        stamped(&mut b, "icon", 300); // tie → lexicographic
        b.item_order = BTreeMap::from([(String::new(), vec!["n9".into()])]);
        stamped(&mut b, "item_order/", 40);
        b.ai_excluded_folders = vec!["Q/".into()];
        b.device_names.insert("d2".into(), "Two".into());
        stamped(&mut b, "device_names/d2", 7);
        b.auto_lock_seconds = Some(600);

        let ab = merge_prefs(&a, &b);
        let ba = merge_prefs(&b, &a);
        assert_eq!(shared_projection(&ab), shared_projection(&ba));
        // Each side kept its own device-local values.
        assert_eq!(ab.auto_lock_seconds, Some(30));
        assert_eq!(ba.auto_lock_seconds, Some(600));
    }

    #[test]
    fn merging_two_legacy_views_stays_clockless() {
        // Two pre-MYND-478 devices (no clocks anywhere): the merge must not
        // invent clock entries, so the merged view re-encodes without a
        // field_clocks key (byte-identity discipline).
        let a = PrefsView {
            label: Some("Alpha".into()),
            // myne#613: set entries are included deliberately. They are now the
            // field most able to bloat `field_clocks`, since the set grows with
            // the vault's folder count, so "a legacy blob gains no clocks" has to
            // hold for them specifically and not just for the scalars.
            deliberate_folders: vec!["Alpha/".into()],
            ..PrefsView::default()
        };
        let b = PrefsView {
            label: Some("Beta".into()),
            deliberate_folders: vec!["Beta/".into()],
            ..PrefsView::default()
        };

        let merged = merge_prefs(&a, &b);
        assert_eq!(merged.label.as_deref(), Some("Beta")); // lexicographic
        assert_eq!(
            merged.deliberate_folders,
            vec!["Alpha/".to_string(), "Beta/".to_string()],
            "both survive: neither side claims a removal"
        );
        assert!(merged.field_clocks.is_empty());
    }

    #[test]
    fn merge_respects_the_classification_table() {
        // Sentinel cross-check with prefs_classification: a field the table
        // calls shared takes the remote's newer value; one it calls
        // device-local never does.
        assert!(matches!(classify("label"), Some(PrefClass::Shared(_))));
        assert_eq!(classify("theme"), Some(PrefClass::DeviceLocal));

        let local = PrefsView::default();
        let mut remote = PrefsView {
            label: Some("Synced".into()),
            ..PrefsView::default()
        };
        stamped(&mut remote, "label", 1);
        remote.theme = Some(protocol::ThemeChoice::Dark);

        let merged = merge_prefs(&local, &remote);
        assert_eq!(merged.label.as_deref(), Some("Synced"));
        assert_eq!(merged.theme, None);
    }

    #[test]
    fn developer_mode_is_device_local_local_wins_both_sides() {
        // MYND-593: developer_mode gates a device-local model-path override,
        // so — like ai_enabled / attachment_ocr_enabled — the local value
        // must survive the merge regardless of which side is "on".
        assert_eq!(classify("developer_mode"), Some(PrefClass::DeviceLocal));

        let off = PrefsView::default();
        let on = PrefsView {
            developer_mode: true,
            ..PrefsView::default()
        };

        assert!(
            !merge_prefs(&off, &on).developer_mode,
            "local off must stay off"
        );
        assert!(
            merge_prefs(&on, &off).developer_mode,
            "local on must stay on"
        );
    }

    #[test]
    fn a_set_value_beats_unset_on_equal_clocks() {
        // §10.2: an absent/null value sorts LOWEST in the tiebreak — a legacy
        // device that named the vault must not lose the name to a legacy
        // device that never did (both clockless ⇒ tie).
        let named = PrefsView {
            label: Some("Kept".into()),
            ..PrefsView::default()
        };
        let unnamed = PrefsView::default();
        assert_eq!(merge_prefs(&named, &unnamed).label.as_deref(), Some("Kept"));
        assert_eq!(merge_prefs(&unnamed, &named).label.as_deref(), Some("Kept"));
    }

    #[test]
    fn shared_subset_hash_ignores_device_local_changes() {
        // The push gate's discriminator: a device-local edit (theme) leaves the
        // hash unchanged; a shared edit (label) changes it.
        let base = PrefsView::default();
        let themed = PrefsView {
            theme: Some(protocol::ThemeChoice::Dark),
            ..PrefsView::default()
        };
        let labeled = PrefsView {
            label: Some("New".into()),
            ..PrefsView::default()
        };
        assert_eq!(shared_subset_hash(&base), shared_subset_hash(&themed));
        assert_ne!(shared_subset_hash(&base), shared_subset_hash(&labeled));
    }

    #[test]
    fn saved_views_tie_breaks_on_the_canonical_encoding() {
        // §10.2 makes the equal-clock tiebreak bytes normative: "the values'
        // canonical encodings" (the §9.5.2 codec) — NOT an implementation's
        // native serializer output. saved_views is the one shared field where
        // the two differ (serde emits struct-declaration key order), so pin
        // that the winner is chosen by the canonical encoding, from either
        // side. The merge keys on the FULL array (rendered set + opaque
        // remainder); with no remainder that is byte-identical to
        // `canonical_encode_saved_views`, which is what this fixture asserts.
        use protocol::{FilterNode, SavedView, ViewType};
        let view = |id: &str, name: &str| SavedView {
            id: id.into(),
            name: name.into(),
            view_type: ViewType::List,
            filters: FilterNode::All,
            sort: None,
            group_by: None,
            columns: Vec::new(),
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: None,
            write_fields: Vec::new(),
        };
        let mut a = PrefsView {
            saved_views: vec![view("0190-a", "Books")],
            ..PrefsView::default()
        };
        stamped(&mut a, "saved_views", 500);
        let mut b = PrefsView {
            saved_views: vec![view("0190-b", "Articles")],
            ..PrefsView::default()
        };
        stamped(&mut b, "saved_views", 500);

        let expected = if protocol::canonical_encode_saved_views(&a.saved_views)
            > protocol::canonical_encode_saved_views(&b.saved_views)
        {
            a.saved_views.clone()
        } else {
            b.saved_views.clone()
        };
        assert_eq!(merge_prefs(&a, &b).saved_views, expected);
        assert_eq!(merge_prefs(&b, &a).saved_views, expected);
    }

    /// The opaque remainder of a `saved_views` array, produced by the real
    /// decoder so the fixture cannot hold a state the production path cannot.
    fn opaque_views(id: &str) -> Vec<protocol::OpaqueSavedView> {
        let raw = format!(
            "[{{\"filters\":{{\"kind\":\"all\"}},\"id\":\"{id}\",\"name\":\"Board\",\"view_type\":\"board\"}}]"
        );
        protocol::parse_saved_views_array_with_opaque(raw.as_bytes())
            .expect("fixture parses")
            .1
    }

    #[test]
    fn the_opaque_saved_views_carrier_follows_the_winning_side() {
        // The opaque remainder is part of the `saved_views` ENCODING, not a
        // preference beside it: the merged view must re-encode to exactly the
        // array the winning side held, or a sync round would delete a newer
        // client's views on every device that merged.
        let mut a = PrefsView {
            opaque_saved_views: opaque_views("0190-l"),
            ..PrefsView::default()
        };
        stamped(&mut a, "saved_views", 100);
        let mut b = PrefsView {
            opaque_saved_views: opaque_views("0190-r"),
            ..PrefsView::default()
        };
        stamped(&mut b, "saved_views", 200);

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert_eq!(merged.opaque_saved_views, b.opaque_saved_views);
            assert_eq!(
                protocol::canonical_encode_saved_views_with_opaque(
                    &merged.saved_views,
                    &merged.opaque_saved_views
                ),
                protocol::canonical_encode_saved_views_with_opaque(
                    &b.saved_views,
                    &b.opaque_saved_views
                ),
                "the merged field must re-encode to the winner's array, not a mixture"
            );
        }
    }

    #[test]
    fn the_opaque_carrier_tiebreak_is_side_symmetric() {
        // A tie on the clock AND on the rendered set, differing only in the
        // remainder, is the case a rendered-set-only tiebreak gets wrong: each
        // peer would keep its own array and re-push it. The full-array encoding
        // decides, so both argument orders agree.
        let mut a = PrefsView {
            opaque_saved_views: opaque_views("0190-a"),
            ..PrefsView::default()
        };
        stamped(&mut a, "saved_views", 500);
        let mut b = PrefsView {
            opaque_saved_views: opaque_views("0190-b"),
            ..PrefsView::default()
        };
        stamped(&mut b, "saved_views", 500);

        let ab = merge_prefs(&a, &b);
        let ba = merge_prefs(&b, &a);
        assert_eq!(ab.opaque_saved_views, ba.opaque_saved_views);
        // Stated explicitly: the greater full encoding wins ("0190-b").
        assert_eq!(ab.opaque_saved_views, b.opaque_saved_views);
    }

    #[test]
    fn color_groups_merge_is_commutative_and_tie_breaks_on_the_canonical_encoding() {
        // MYND-604: color_groups is classified whole-value LWW like
        // saved_views, and for the same reason the tiebreak must use the
        // canonical (order-preserving) encoding, not serde's — pin both
        // merge(a,b) == merge(b,a) AND the winner-by-canonical-bytes rule.
        use protocol::{ColorGroup, FilterNode};
        let rule = |id: &str, name: &str| ColorGroup {
            id: id.into(),
            name: name.into(),
            color: "moss".into(),
            enabled: true,
            filter: FilterNode::All,
        };
        let mut a = PrefsView {
            color_groups: vec![rule("g-a", "Work")],
            ..PrefsView::default()
        };
        stamped(&mut a, "color_groups", 500);
        let mut b = PrefsView {
            color_groups: vec![rule("g-b", "Rest")],
            ..PrefsView::default()
        };
        stamped(&mut b, "color_groups", 500);

        let expected = if protocol::canonical_encode_color_groups(&a.color_groups)
            > protocol::canonical_encode_color_groups(&b.color_groups)
        {
            a.color_groups.clone()
        } else {
            b.color_groups.clone()
        };
        assert_eq!(merge_prefs(&a, &b).color_groups, expected);
        assert_eq!(merge_prefs(&b, &a).color_groups, expected);
    }

    #[test]
    fn color_groups_newer_clock_wins_and_precedence_order_survives() {
        // A non-tie case: the newer side wins outright, and its rule ORDER
        // (precedence) survives verbatim — not re-sorted by id.
        use protocol::{ColorGroup, FilterNode};
        let rule = |id: &str| ColorGroup {
            id: id.into(),
            name: id.into(),
            color: "slate".into(),
            enabled: true,
            filter: FilterNode::All,
        };
        let mut older = PrefsView {
            color_groups: vec![rule("zzz"), rule("aaa")],
            ..PrefsView::default()
        };
        stamped(&mut older, "color_groups", 100);
        let mut newer = PrefsView {
            color_groups: vec![rule("bbb"), rule("ccc")],
            ..PrefsView::default()
        };
        stamped(&mut newer, "color_groups", 200);

        let merged = merge_prefs(&older, &newer);
        assert_eq!(
            merged
                .color_groups
                .iter()
                .map(|g| g.id.clone())
                .collect::<Vec<_>>(),
            vec!["bbb".to_string(), "ccc".to_string()]
        );
    }

    #[test]
    fn stamping_marks_changed_shared_lww_fields_only() {
        let before = PrefsView::default();
        let mut after = PrefsView {
            label: Some("Renamed".into()),            // shared LWW → stamps
            theme: Some(protocol::ThemeChoice::Dark), // device-local → no stamp
            // myne#613: set-union was clockless and is not any more. It stamps
            // PER ENTRY, under the folded identity, and still never under the
            // bare field name. The assertion below is unchanged and load-bearing,
            // because a bare-name stamp would make one folder's edit race the
            // whole set and drop concurrent additions on the other device.
            deliberate_folders: vec!["A/".into()],
            ..PrefsView::default()
        };
        stamp_changed_shared_fields(&before, &mut after, 12345);

        assert_eq!(after.field_clocks.get("label"), Some(&12345));
        assert!(!after.field_clocks.contains_key("theme"));
        assert!(!after.field_clocks.contains_key("deliberate_folders"));
        assert_eq!(
            after.field_clocks.get("deliberate_folders/a/"),
            Some(&12345)
        );
        assert_eq!(after.field_clocks.len(), 2);
    }

    #[test]
    fn stamping_skips_unchanged_fields_and_preserves_existing_clocks() {
        let mut before = PrefsView {
            label: Some("Same".into()),
            ..PrefsView::default()
        };
        stamped(&mut before, "label", 100);
        let mut after = before.clone();
        after.icon = Some("book".into()); // only icon changed

        stamp_changed_shared_fields(&before, &mut after, 999);
        assert_eq!(after.field_clocks.get("label"), Some(&100)); // untouched
        assert_eq!(after.field_clocks.get("icon"), Some(&999));
        assert_eq!(after.field_clocks.len(), 2);
    }

    #[test]
    fn stamping_device_names_is_per_key() {
        let mut before = PrefsView::default();
        before.device_names.insert("aa".into(), "Old".into());
        let mut after = before.clone();
        after.device_names.insert("aa".into(), "New".into()); // changed
        after.device_names.insert("bb".into(), "Added".into()); // added

        stamp_changed_shared_fields(&before, &mut after, 777);
        assert_eq!(after.field_clocks.get("device_names/aa"), Some(&777));
        assert_eq!(after.field_clocks.get("device_names/bb"), Some(&777));
        assert!(!after.field_clocks.contains_key("device_names"));
        assert_eq!(after.field_clocks.len(), 2);
    }

    // ── myne#613: a removal must be representable in a SET field too ────────
    //
    // The per-key maps got this in myne#296. The five set-union fields did not,
    // and `merge_set_union_folded` is a pure union with no clock and no
    // tombstone, so removing an entry could not be expressed: device A deletes,
    // device B still holds the entry, and the next union restores it within two
    // rounds, with no concurrency required. Under myne#613 every folder a note
    // lands in enters `deliberate_folders`, which turns that from a defect
    // affecting hand-made folders into one affecting every folder delete.
    //
    // Table-driven over all five fields rather than five copies, and driven off
    // the classification table itself, so a set field added later is covered by
    // construction instead of by somebody remembering to copy a test.

    /// Every `SetUnion` field, read off the normative classification rather than
    /// hand-listed. A new set field joins these tests by existing.
    fn set_union_fields() -> Vec<&'static str> {
        CLASSIFICATION
            .iter()
            .filter(|(_, c)| matches!(c, PrefClass::Shared(SharedDiscipline::SetUnion { .. })))
            .map(|(n, _)| *n)
            .collect()
    }

    fn put_set(view: &mut PrefsView, field: &str, values: &[&str]) {
        let v: Vec<String> = values.iter().map(|s| (*s).to_string()).collect();
        match field {
            "ai_excluded_folders" => view.ai_excluded_folders = v,
            "archived_folders" => view.archived_folders = v,
            "cli_excluded_folders" => view.cli_excluded_folders = v,
            "deliberate_folders" => view.deliberate_folders = v,
            "spell_languages" => view.spell_languages = v,
            other => panic!("not a set-union field: {other}"),
        }
    }

    fn read_set<'a>(view: &'a PrefsView, field: &str) -> &'a [String] {
        match field {
            "ai_excluded_folders" => &view.ai_excluded_folders,
            "archived_folders" => &view.archived_folders,
            "cli_excluded_folders" => &view.cli_excluded_folders,
            "deliberate_folders" => &view.deliberate_folders,
            "spell_languages" => &view.spell_languages,
            other => panic!("not a set-union field: {other}"),
        }
    }

    /// A member value legal for the field: the four folder sets take canonical
    /// trailing-slash paths, `spell_languages` takes language codes. A folder
    /// path would still pass the merge as a language code, but it would stop the
    /// folded-identity assertions below from meaning anything.
    fn member(field: &str, n: usize) -> String {
        if folds(field) {
            ["Alpha/", "Beta/", "Gamma/"][n].to_string()
        } else {
            ["en-US", "tr-TR", "de-DE"][n].to_string()
        }
    }

    /// The clock key the merge and the stamper must agree on: the folded
    /// identity for a folder set, the raw code for `spell_languages`.
    fn entry_clock_key(field: &str, value: &str) -> String {
        // The fold RULE is respelled here rather than calling
        // `set_entry_identity`, deliberately: a test that computes the key with
        // the same function the production code uses cannot catch that function
        // being wrong. Which fields fold is read off the classification instead
        // of hardcoded, because that is a roster and not a rule, and a second
        // unfolded set field would otherwise get folder-shaped members and a
        // folded assertion applied to it.
        if folds(field) {
            let segs: Vec<&str> = value.split('/').filter(|s| !s.is_empty()).collect();
            format!("{field}/{}/", segs.join("/").to_lowercase())
        } else {
            format!("{field}/{value}")
        }
    }

    /// Whether this set field folds its entries, taken from the normative
    /// classification rather than from a field-name literal.
    fn folds(field: &str) -> bool {
        match classify(field) {
            Some(PrefClass::Shared(SharedDiscipline::SetUnion { folded, .. })) => folded,
            other => panic!("{field} is not a set-union field: {other:?}"),
        }
    }

    /// Whether a removal on one device reaches the others. False for the two
    /// egress controls, whose union stays monotone.
    fn removals_propagate(field: &str) -> bool {
        match classify(field) {
            Some(PrefClass::Shared(SharedDiscipline::SetUnion {
                removals_propagate, ..
            })) => removals_propagate,
            other => panic!("{field} is not a set-union field: {other:?}"),
        }
    }

    #[test]
    fn a_removed_set_entry_stays_removed() {
        for field in set_union_fields() {
            if !removals_propagate(field) {
                continue; // monotone by design: own test below
            }
            let m0 = member(field, 0);
            // A removed it at 300 (so it holds the stamp and not the value);
            // B still holds it, stamped older.
            let mut a = PrefsView::default();
            stamped(&mut a, &entry_clock_key(field, &m0), 300);
            let mut b = PrefsView::default();
            put_set(&mut b, field, &[&m0]);
            stamped(&mut b, &entry_clock_key(field, &m0), 100);

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert!(
                    !read_set(&merged, field).contains(&m0),
                    "{field}: the removal must win over the peer's older value"
                );
                assert_eq!(
                    merged.field_clocks.get(&entry_clock_key(field, &m0)),
                    Some(&300),
                    "{field}: the removal must carry its clock, so the peer drops \
                     it next round rather than pushing it back"
                );
            }
        }
    }

    #[test]
    fn a_set_entry_the_peer_never_had_still_unions_in() {
        for field in set_union_fields() {
            let m0 = member(field, 0);
            // The other reading of a single-sided entry, and the one the plain
            // union already got right: B simply never held it. No clock on B's
            // side, so nothing claims a deletion.
            let mut a = PrefsView::default();
            put_set(&mut a, field, &[&m0]);
            stamped(&mut a, &entry_clock_key(field, &m0), 100);
            let b = PrefsView::default();

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert!(
                    read_set(&merged, field).contains(&m0),
                    "{field}: an entry the peer never held must survive"
                );
            }
        }
    }

    #[test]
    fn a_set_re_add_after_a_removal_wins_on_the_newer_clock() {
        for field in set_union_fields() {
            let m0 = member(field, 0);
            // A removed it at 100; B added it back at 200. The add is newer than
            // the deletion, so it comes back. Without stamping the ADD as well as
            // the removal this case is unreachable: the re-added value would
            // carry the pre-removal clock and lose to its own tombstone forever.
            let mut a = PrefsView::default();
            stamped(&mut a, &entry_clock_key(field, &m0), 100);
            let mut b = PrefsView::default();
            put_set(&mut b, field, &[&m0]);
            stamped(&mut b, &entry_clock_key(field, &m0), 200);

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert!(
                    read_set(&merged, field).contains(&m0),
                    "{field}: a re-add newer than the removal must come back"
                );
            }
        }
    }

    #[test]
    fn an_equal_clock_keeps_the_set_entry() {
        for field in set_union_fields() {
            let m0 = member(field, 0);
            // "Absent sorts lowest" is the tiebreak this module already uses for
            // the per-key maps, and it is the recoverable direction: an entry
            // that survives one extra round can be deleted again, one dropped by
            // a clock collision cannot be recovered.
            let mut a = PrefsView::default();
            stamped(&mut a, &entry_clock_key(field, &m0), 500);
            let mut b = PrefsView::default();
            put_set(&mut b, field, &[&m0]);
            stamped(&mut b, &entry_clock_key(field, &m0), 500);

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert!(
                    read_set(&merged, field).contains(&m0),
                    "{field}: equal clocks must keep the value"
                );
            }
        }
    }

    #[test]
    fn a_set_removal_does_not_take_its_siblings_with_it() {
        for field in set_union_fields() {
            if !removals_propagate(field) {
                continue; // monotone by design: own test below
            }
            let (m0, m1) = (member(field, 0), member(field, 1));
            // The failure the per-key maps were built to avoid, one field over:
            // a removal must be scoped to its own entry, never to the field.
            let mut a = PrefsView::default();
            put_set(&mut a, field, &[&m1]);
            stamped(&mut a, &entry_clock_key(field, &m0), 300);
            let mut b = PrefsView::default();
            put_set(&mut b, field, &[&m0, &m1]);
            stamped(&mut b, &entry_clock_key(field, &m0), 100);

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert!(!read_set(&merged, field).contains(&m0), "{field}: removed");
                assert!(
                    read_set(&merged, field).contains(&m1),
                    "{field}: the sibling entry must be untouched by the removal"
                );
            }
        }
    }

    #[test]
    fn a_folder_set_removal_is_keyed_by_folded_identity() {
        // The four folder sets fold `personal/` and `PERSONAL/` to one identity
        // (MYND-562), so a removal recorded on one casing must remove the other.
        // `spell_languages` is deliberately excluded and gets the opposite
        // assertion below: language codes are case-sensitive.
        for field in set_union_fields() {
            if !removals_propagate(field) {
                continue; // monotone by design: own test below
            }
            if !folds(field) {
                continue;
            }
            let mut a = PrefsView::default();
            stamped(&mut a, &entry_clock_key(field, "personal/"), 300);
            let mut b = PrefsView::default();
            put_set(&mut b, field, &["PERSONAL/"]);
            stamped(&mut b, &entry_clock_key(field, "PERSONAL/"), 100);

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert!(
                    read_set(&merged, field).is_empty(),
                    "{field}: a removal on one casing must remove the folded twin"
                );
            }
        }
    }

    #[test]
    fn a_removal_clock_outlives_the_entry_on_both_sides() {
        // The tombstone-GC defect, at the unit level. Both sides have already
        // dropped the entry and only the clock records that it was deleted. If
        // the merge does not carry that clock forward, the very next round with
        // a device that was offline resurrects the entry.
        for field in set_union_fields() {
            if !removals_propagate(field) {
                continue;
            }
            let m0 = member(field, 0);
            let key = entry_clock_key(field, &m0);

            // Two converged views: the entry is gone from both, the clock stands.
            let mut a = PrefsView::default();
            stamped(&mut a, &key, 300);
            let mut b = PrefsView::default();
            stamped(&mut b, &key, 300);

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert_eq!(
                    merged.field_clocks.get(&key),
                    Some(&300),
                    "{field}: a removal clock must survive both sides dropping \
                     the entry, or the deletion has nothing left to win with"
                );
            }
        }
    }

    #[test]
    fn a_third_device_cannot_resurrect_what_two_others_deleted() {
        // The property the test above exists to produce, played out. Round one
        // deletes; round two is the two converged devices meeting again; round
        // three is the peer that was offline for both, still holding the entry
        // under its original add clock. Before the carry-forward this returned
        // the entry, undone by a clock three hundred units older than the
        // removal.
        for field in set_union_fields() {
            if !removals_propagate(field) {
                continue;
            }
            let m0 = member(field, 0);
            let key = entry_clock_key(field, &m0);

            // Device A deleted it at 300; device B still held it at 100.
            let mut a = PrefsView::default();
            stamped(&mut a, &key, 300);
            let mut b = PrefsView::default();
            put_set(&mut b, field, &[&m0]);
            stamped(&mut b, &key, 100);

            let round1 = merge_prefs(&a, &b);
            assert!(!read_set(&round1, field).contains(&m0), "{field}: round 1");

            // A and B converge, then meet once more with nothing left to say.
            let round2 = merge_prefs(&round1, &round1);
            assert!(!read_set(&round2, field).contains(&m0), "{field}: round 2");

            // The offline third device rejoins, still holding it at 100.
            let mut c = PrefsView::default();
            put_set(&mut c, field, &[&m0]);
            stamped(&mut c, &key, 100);

            for merged in [merge_prefs(&round2, &c), merge_prefs(&c, &round2)] {
                assert!(
                    !read_set(&merged, field).contains(&m0),
                    "{field}: a device that was offline for the deletion must \
                     not bring the entry back"
                );
            }
        }
    }

    #[test]
    fn a_monotone_set_carries_no_clocks_forward_either() {
        // The exclusion sets stamp nothing, so there is nothing to carry, and
        // the carry-forward must not invent a reason to keep a stray key. A
        // legacy or server-supplied clock on a monotone field is the only way
        // one can exist, and it earns no place in the merged view.
        for field in set_union_fields() {
            if removals_propagate(field) {
                continue;
            }
            let m0 = member(field, 0);
            let mut a = PrefsView::default();
            stamped(&mut a, &entry_clock_key(field, &m0), 300);
            let b = PrefsView::default();

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert!(
                    !merged
                        .field_clocks
                        .contains_key(&entry_clock_key(field, &m0)),
                    "{field}: a monotone set keeps no per-entry clock"
                );
            }
        }

        // The BOTH-SIDES-HOLD arm, which the single-sided case above does not
        // reach. It carried the clock forward unconditionally until this pass,
        // so this test passed while proving less than its name asserts: a stray
        // clock on an egress control persisted across every merge forever.
        let mut both_a = PrefsView {
            ai_excluded_folders: vec!["Private/".to_string()],
            ..Default::default()
        };
        both_a.field_clocks.insert(
            "ai_excluded_folders/private/".to_string(),
            1_765_432_100_000,
        );
        let both_b = PrefsView {
            ai_excluded_folders: vec!["Private/".to_string()],
            ..Default::default()
        };
        let merged = merge_prefs(&both_a, &both_b);
        assert!(
            !merged
                .field_clocks
                .keys()
                .any(|k| k.starts_with("ai_excluded_folders/")),
            "a monotone set must carry no clock forward even when both sides \
             hold the entry, so a stray one cannot become permanent"
        );
    }

    #[test]
    fn a_cross_side_casing_pair_collapses_to_the_lexicographic_min_display_form() {
        // MYND-562, carried over from `conflict.rs`'s `merge_set_union_folded`
        // tests when myne#613 left that function with no production caller and
        // deleted it. These two assertions were the ONLY place in the tree that
        // covered the cross-side case, and the new removal tests do not: they
        // assert an empty result, which a merge that dropped the fold entirely
        // would also produce.
        //
        // "PERSONAL/" < "personal/" byte-wise, so the upper-case form is the
        // survivor. Distinct folders are untouched, and the result is the same
        // in both argument orders.
        for field in set_union_fields() {
            if !folds(field) {
                continue;
            }
            let mut a = PrefsView::default();
            put_set(&mut a, field, &["personal/", "Work/"]);
            let mut b = PrefsView::default();
            put_set(&mut b, field, &["PERSONAL/", "Ideas/"]);

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert_eq!(
                    read_set(&merged, field),
                    ["Ideas/", "PERSONAL/", "Work/"],
                    "{field}: one representative per folded identity, the \
                     byte-lexicographic minimum"
                );
            }
        }
    }

    #[test]
    fn nfc_folds_a_decomposed_and_a_precomposed_entry_into_one() {
        // The second assertion carried over from the deleted `conflict.rs`
        // tests. Decomposed "cafe" + U+0301 and precomposed "Café" are one
        // folder, and nothing else in this module would notice if the NFC pass
        // were dropped from the identity.
        for field in set_union_fields() {
            if !folds(field) {
                continue;
            }
            let mut a = PrefsView::default();
            put_set(&mut a, field, &["cafe\u{0301}/"]);
            let mut b = PrefsView::default();
            put_set(&mut b, field, &["Caf\u{00e9}/"]);

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert_eq!(
                    read_set(&merged, field).len(),
                    1,
                    "{field}: one survivor, not two spellings of one folder"
                );
            }
        }
    }

    #[test]
    fn a_folder_identity_ignores_a_missing_trailing_slash() {
        // Why the identity goes through `canonical_folder` rather than a plain
        // NFC-plus-lowercase fold: `markdown-dialect.md` §3.6.2 tolerates a
        // missing trailing slash on reads, and the Obsidian importer preserves
        // `folder:` verbatim, so both shapes can reach these sets. Under a
        // fold-only identity they are two clock keys for one folder and a
        // removal stamped against one silently misses the other.
        for field in set_union_fields() {
            if !folds(field) {
                continue;
            }
            let mut a = PrefsView::default();
            put_set(&mut a, field, &["Projects"]);
            let mut b = PrefsView::default();
            put_set(&mut b, field, &["Projects/"]);

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert_eq!(
                    read_set(&merged, field).len(),
                    1,
                    "{field}: with and without the trailing slash is one folder"
                );
            }
        }
    }

    #[test]
    fn an_egress_exclusion_survives_a_peer_claiming_it_was_removed() {
        // `ai_excluded_folders` and `cli_excluded_folders` are not preferences.
        // `threat-model.md` A17 rests its remote-provider mitigation on the
        // first, and the shipped UI promises both absolutely ("Notes in these
        // folders are never read or indexed by AI"; "Folders the terminal never
        // sees"). Their union is monotone SO THAT the merge can only fail
        // closed: an exclusion present on any device survives.
        //
        // The clock here is the strongest claim a peer can make (300 against a
        // present side that has none at all), and it still loses. Under the
        // removal discipline the other three fields carry, this same input drops
        // the entry, which is the fail-OPEN direction: note plaintext from a
        // folder the user excluded reaching a remote provider.
        //
        // The failure this guards against needs no attacker and no concurrency,
        // only a device whose wall clock runs fast, because a re-add from a
        // correctly-clocked device stamps the SMALLER clock and can never win.
        for field in set_union_fields() {
            if removals_propagate(field) {
                continue;
            }
            let m0 = member(field, 0);
            let mut a = PrefsView::default();
            put_set(&mut a, field, &[&m0]);
            let mut b = PrefsView::default();
            stamped(&mut b, &entry_clock_key(field, &m0), 300);

            for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
                assert!(
                    read_set(&merged, field).contains(&m0),
                    "{field}: an egress exclusion must survive a peer's removal \
                     claim, however new that claim's clock is"
                );
            }
        }
    }

    #[test]
    fn a_monotone_set_stamps_no_clock_at_all() {
        // No removal is expressible, so no clock is worth writing: stamping the
        // adds would grow `field_clocks` with keys nothing ever reads, on a blob
        // that is re-encrypted and re-pushed on every prefs write.
        for field in set_union_fields() {
            if removals_propagate(field) {
                continue;
            }
            let (m0, m1) = (member(field, 0), member(field, 1));
            let mut before = PrefsView::default();
            put_set(&mut before, field, &[&m0]);
            let mut after = PrefsView::default();
            put_set(&mut after, field, &[&m1]);

            stamp_changed_shared_fields(&before, &mut after, 777);

            assert!(
                after.field_clocks.is_empty(),
                "{field}: a monotone set stamps nothing"
            );
        }
    }

    #[test]
    fn the_two_egress_controls_are_the_monotone_ones() {
        // Pins WHICH fields are monotone, so the split cannot be widened or
        // narrowed without this test naming it. Reads the classification rather
        // than restating it, and compares both directions: a field that gains
        // removals, and one that loses them, both fail here.
        let monotone: Vec<&str> = set_union_fields()
            .into_iter()
            .filter(|f| !removals_propagate(f))
            .collect();
        assert_eq!(
            monotone,
            vec!["ai_excluded_folders", "cli_excluded_folders"],
            "only the egress controls are monotone; the organisational sets \
             carry removal clocks (myne#613)"
        );
    }

    #[test]
    fn spell_languages_removal_is_case_sensitive() {
        // The other direction of the rule above, asserted rather than assumed:
        // folding language codes would be a defect, so `de-DE` and `de-de` are
        // two entries and removing one must leave the other standing.
        let mut a = PrefsView {
            spell_languages: vec!["de-de".to_string()],
            ..PrefsView::default()
        };
        stamped(&mut a, "spell_languages/de-DE", 300);
        let mut b = PrefsView {
            spell_languages: vec!["de-DE".to_string(), "de-de".to_string()],
            ..PrefsView::default()
        };
        stamped(&mut b, "spell_languages/de-DE", 100);

        for merged in [merge_prefs(&a, &b), merge_prefs(&b, &a)] {
            assert_eq!(merged.spell_languages, vec!["de-de".to_string()]);
        }
    }

    #[test]
    fn stamping_a_set_field_is_per_entry_for_both_adds_and_removals() {
        for field in set_union_fields() {
            if !removals_propagate(field) {
                continue; // monotone: stamps nothing, own test above
            }
            let (m0, m1) = (member(field, 0), member(field, 1));
            let mut before = PrefsView::default();
            put_set(&mut before, field, &[&m0]);
            let mut after = PrefsView::default();
            put_set(&mut after, field, &[&m1]);

            stamp_changed_shared_fields(&before, &mut after, 777);

            assert_eq!(
                after.field_clocks.get(&entry_clock_key(field, &m1)),
                Some(&777),
                "{field}: an ADDED entry is stamped, without which a re-add could \
                 never beat its own tombstone"
            );
            assert_eq!(
                after.field_clocks.get(&entry_clock_key(field, &m0)),
                Some(&777),
                "{field}: a REMOVED entry is stamped, which is the claim the merge \
                 compares"
            );
            assert!(
                !after.field_clocks.contains_key(field),
                "{field}: the bare field name must never be stamped for a set"
            );
        }
    }

    #[test]
    fn an_unchanged_set_field_is_not_stamped() {
        for field in set_union_fields() {
            let m0 = member(field, 0);
            let mut before = PrefsView::default();
            put_set(&mut before, field, &[&m0]);
            let mut after = before.clone();

            stamp_changed_shared_fields(&before, &mut after, 777);

            assert!(
                after.field_clocks.is_empty(),
                "{field}: an untouched set must stamp nothing, or every unrelated \
                 prefs write would bloat field_clocks by the vault's folder count"
            );
        }
    }
}
