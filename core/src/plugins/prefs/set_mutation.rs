// SPDX-License-Identifier: AGPL-3.0
//! Add/remove verbs for the `vault.prefs` set-union fields (myne-md/myne#613).
//!
//! Every set field used to be written by replacing the whole set with a snapshot
//! the UI had in hand. That was harmless while the merge was a clockless union:
//! a snapshot that predated a peer's addition simply lost that entry locally,
//! and the next merge restored it. myne#613 gave three of the five fields a
//! per-entry removal clock, and `stamp_changed_shared_fields` derives a removal
//! from `before \ after` on the stored view. With a whole-set replace, that diff
//! is between a possibly-stale snapshot and the disk, so a peer's addition the
//! snapshot never saw reads as an intentional deletion and is then removed on
//! every device: a lost update becomes a distributed delete.
//!
//! **The fix is at the write, not at the stamper.** Once the caller states what
//! it added and what it removed, and the core applies that to the CURRENT stored
//! set, the stamper's diff is between the disk before and the disk after. That
//! is exactly what the caller removed, so the inference becomes sound rather
//! than being replaced. Nothing in `prefs_merge` changes.
//!
//! The command NAMES are unchanged (`set_<field>`), which is a naming debt taken
//! deliberately: a rename would touch eleven files across two Tauri clients plus
//! three generated schema files and the web capability table, for zero
//! behavioural gain, and a missed row in the web table is a silently-unported
//! command rather than a build failure. The payload change is what fixes the
//! defect; the verb in the name is cosmetic and is recorded here rather than
//! paid for now.

use serde::{Deserialize, Serialize};

/// What a caller did to a set field: entries it added, entries it removed.
///
/// Both halves are ordinary values rather than a diff the core computes, which
/// is the whole point. A caller that means to change nothing sends two empty
/// lists, and a caller holding a stale view can no longer accidentally claim a
/// deletion it never made.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMutation {
    /// Entries to add. Already present entries are a no-op, not an error.
    #[serde(default)]
    pub add: Vec<String>,
    /// Entries to remove, matched by the field's own identity (see
    /// [`apply_set_mutation`]). An absent entry is a no-op, not an error.
    #[serde(default)]
    pub remove: Vec<String>,
    /// Entries to add ONLY where no removal of them is on record.
    ///
    /// For a REPAIR rather than a user act. The unlock back-fill registers the
    /// folders an old vault's notes prove exist, and it does that by reading
    /// LIVE notes, which is a state a peer's deletion has not reached yet:
    /// deletions of notes and of prefs travel separately, so device B can unlock
    /// holding notes that device A has already trashed, back-fill their folder,
    /// and hand it a clock NEWER than A's removal. The folder then comes back on
    /// every device, permanently, with nobody having asked for it. The back-fill
    /// module claimed running on the unlock path only bounded that. It does not:
    /// it narrows the window, and a newer clock wins whenever the window is hit.
    ///
    /// "On record" is `absent from the set AND carrying a `<field>/<id>` clock`.
    /// A clock alone does not mean removed, because the stamper stamps additions
    /// too; it is the pairing with absence that says the last thing that
    /// happened to this entry was it going away.
    ///
    /// A genuine user act still wins: at-fill uses [`Self::add`], so filing a
    /// note back into a deleted folder re-registers it and stamps a newer clock,
    /// which is the behaviour `stamp_changed_shared_fields`'s add arm exists for.
    #[serde(default)]
    pub add_unless_removed: Vec<String>,
    /// Subtrees to remove: every stored entry at or under one of these folded
    /// prefixes goes, whether or not the caller has ever seen it.
    ///
    /// This exists because [`Self::remove`] cannot express a folder deletion
    /// honestly. Deleting `Projects/` means deleting whatever is stored under
    /// it, and only the write knows what that is: the caller's list is a React
    /// view that four fire-and-forget at-fill writers can leave stale, so a
    /// delete issued inside that window under-removes and the folder returns
    /// empty at the next unlock, carrying a NEWER add clock than the removal, so
    /// it returns on every device. Re-reading prefs in the client narrows that
    /// window and does not close it, and it has to be written once per client
    /// per operation, which is four copies and the twin drift that comes with
    /// them.
    ///
    /// An entry that folds to the empty string is IGNORED rather than treated as
    /// the root, exactly as `folder_key::folder_matches_excluded` already does
    /// for the egress sets and for the same reason: the root would match the
    /// whole set, and an empty prefix here is far more likely to be an accident
    /// than an instruction. That is not hypothetical, it is myne#613's own
    /// review finding: the client-side predecessor used `startsWith("")` for a
    /// root no-op sentinel, and `String::starts_with("")` is true for every
    /// input, so the no-op case wiped the field.
    #[serde(default)]
    pub remove_prefix: Vec<String>,
    /// Subtrees to re-root: every stored entry at or under `from` is rewritten
    /// with `to` in place of that prefix.
    ///
    /// The rename counterpart of [`Self::remove_prefix`], and it is one verb
    /// rather than a remove plus an add for a reason the budget makes concrete:
    /// as two halves it can half-apply, removing the old paths, stamping each as
    /// an intentional deletion that propagates to every device, and then
    /// refusing the additions. That turns a rename into a synchronised delete.
    /// As one verb the re-root either happens or does not.
    #[serde(default)]
    pub rename_prefix: Vec<PrefixRename>,
}

/// One `from` to `to` subtree re-root for [`SetMutation::rename_prefix`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefixRename {
    /// The folded prefix to match. An entry folding to the empty string is
    /// ignored, per [`SetMutation::remove_prefix`].
    pub from: String,
    /// The replacement prefix, in the caller's display form. Stored entries keep
    /// their own tail verbatim; only the matched prefix is substituted.
    pub to: String,
}

impl SetMutation {
    /// The mutation that adds one entry and removes nothing.
    pub fn adding(entry: impl Into<String>) -> Self {
        Self {
            add: alloc_one(entry.into()),
            ..Self::default()
        }
    }

    /// The mutation that removes one entry and adds nothing.
    pub fn removing(entry: impl Into<String>) -> Self {
        Self {
            remove: alloc_one(entry.into()),
            ..Self::default()
        }
    }

    /// The mutation that adds every entry in `entries` and removes nothing.
    ///
    /// Note what this is NOT: it does not make the stored set equal `entries`.
    /// There is deliberately no "set it to exactly this" verb, because that verb
    /// is the defect. A caller holding a stale view would use it to erase a
    /// peer's entry it never saw, which is the whole reason this module exists.
    /// A caller that really wants the set to end up equal to a list has to say
    /// which entries it is removing.
    pub fn adding_all(entries: Vec<String>) -> Self {
        Self {
            add: entries,
            ..Self::default()
        }
    }

    /// The mutation that removes one whole subtree and nothing else.
    pub fn removing_prefix(prefix: impl Into<String>) -> Self {
        Self {
            remove_prefix: alloc_one(prefix.into()),
            ..Self::default()
        }
    }

    /// The mutation that re-roots one subtree and nothing else.
    pub fn renaming_prefix(from: impl Into<String>, to: impl Into<String>) -> Self {
        Self {
            rename_prefix: vec![PrefixRename {
                from: from.into(),
                to: to.into(),
            }],
            ..Self::default()
        }
    }

    /// The mutation that repairs a missing registration for every entry in
    /// `entries`, skipping any whose removal is on record.
    pub fn repairing_all(entries: Vec<String>) -> Self {
        Self {
            add_unless_removed: entries,
            ..Self::default()
        }
    }

    /// True when no half asks for anything, so the write can be skipped.
    pub fn is_empty(&self) -> bool {
        self.add.is_empty()
            && self.add_unless_removed.is_empty()
            && self.remove.is_empty()
            && self.remove_prefix.is_empty()
            && self.rename_prefix.is_empty()
    }
}

fn alloc_one(s: String) -> Vec<String> {
    vec![s]
}

/// The largest canonical plaintext a `vault.prefs` write may produce.
///
/// `MAX_PREFS_PLAINTEXT_LEN` is 64 KiB and an over-cap encode FAILS rather than
/// truncating, so a bound below it is the difference between "this folder is not
/// registered" and "no preference of any kind can be saved on this vault again".
/// 4 KiB of headroom, because the additions are admitted against a measured base
/// plus an ESTIMATED per-entry delta ([`entry_cost`]), and the estimate must not
/// be the thing standing between the user and a permanently unwritable blob.
///
/// **This bounds the BLOB, not one field**, which is the correction myne#613's
/// review forced. The first version reserved 32 KiB per set field, five fields
/// shared one 64 KiB cap, and "half the cap" was true only for a field
/// considered alone: two fields at their reserve filled the cap between them.
/// Worse, it measured one field's LIVE entries, so the `field_clocks` entries
/// that outlive the entries they belonged to were charged to nothing at all, and
/// folder churn could fill the blob while the budget still reported room.
///
/// **This bounds a LOCAL WRITE and nothing else**, which is the second
/// correction the review forced. The sentence that used to stand here said a
/// merged view arriving over budget was "re-bounded HERE, at the next local
/// write: additions are refused until the user's own deletions bring it back".
/// That was false twice over. This function only ever refuses ADDITIONS, so it
/// never shrinks anything; and the deletions that would shrink it could not
/// reach the peer, because an over-cap merged blob failed its encode and killed
/// the whole sync cycle before the push. The merge's bound is
/// [`shed_retained_clocks`], applied to the merge's RESULT.
///
/// The budget also charges each addition for the tombstone it will one day mint
/// ([`latent_clock_debt`]), which is what makes "a removal is never refused" a
/// property rather than a hope.
pub const PREFS_PLAINTEXT_BUDGET_BYTES: usize = protocol::MAX_PREFS_PLAINTEXT_LEN - 4096;

/// What one addition adds to the canonical plaintext: its own JSON member plus
/// the `field_clocks` member its per-entry clock needs, where the field has one.
///
/// Counted rather than estimated, because the estimate is what the budget is
/// FOR. `"Projects/Myne/",` is the path plus three (two quotes and a comma);
/// `"deliberate_folders/projects/myne/":1765432101000,` is the field name, a
/// slash, the folded path, two quotes, a colon, thirteen digits and a comma.
///
/// `clocked` is read from the field's classification rather than assumed: the
/// two monotone egress sets stamp no clock at all, so charging them one costs
/// `ai_excluded_folders` roughly five times its real weight and fires a refusal
/// on an egress control far earlier than the arithmetic claims.
fn entry_cost(field: &str, raw: &str, folded: bool, clocked: bool) -> usize {
    let member = protocol::canonical_set_entry_cost(raw);
    if !clocked {
        return member;
    }
    member + clock_member_cost(field, &set_identity(folded, raw))
}

/// Digits the stamper writes for a clock value.
///
/// `now_ms` since the Unix epoch is 13 decimal digits from 2001-09-09 until
/// 2286-11-20, so this is the width for every clock any shipping build can
/// produce. It is named rather than inlined because it is the one term in the
/// cost that is a claim about the FUTURE (the clock does not exist yet when the
/// budget charges for it), and a claim deserves somewhere to be read.
const CLOCK_VALUE_DIGITS: usize = 13;

/// The `field_clocks` key a set entry's clock is stored under.
///
/// One function, used by the cost arithmetic, by the latent-debt walk and by the
/// tombstone shedder, because a key computed two ways is a budget that charges
/// for one member and a merge that reads another. `stamp_changed_shared_fields`
/// composes the same `{field}/{id}` and that is the byte string this has to
/// match.
fn clock_key(field: &str, id: &str) -> String {
    let mut key = String::with_capacity(field.len() + 1 + id.len());
    key.push_str(field);
    key.push('/');
    key.push_str(id);
    key
}

/// What one `field_clocks` member costs in the canonical plaintext.
fn clock_member_cost(field: &str, id: &str) -> usize {
    protocol::canonical_clock_member_cost(&clock_key(field, id), CLOCK_VALUE_DIGITS)
}

/// A set entry's identity under the field's own folding rule.
fn set_identity(folded: bool, raw: &str) -> String {
    if folded {
        crate::folder_key::canonical_folder(raw)
    } else {
        raw.to_string()
    }
}

/// The clock members that live entries will mint WHEN THEY ARE REMOVED, and that
/// the blob does not carry yet.
///
/// This is the term that made "a removal is never refused" false. A removal does
/// not shrink the blob: it trades a live member for a permanent tombstone, and
/// on a folder set the tombstone is the larger of the two. `stamp_changed_shared_fields`
/// mints it AFTER the mutation closure has run, so measuring the plaintext
/// inside the closure measures a state that is never written, and the budget
/// then admits a blob the encoder refuses. The measured failure was 2,200
/// clockless entries at 46,257 bytes, comfortably inside a 61,440 budget, going
/// to 82,574 bytes and a failed encode on removing half of them, with the
/// refusal count reporting zero.
///
/// Charging the debt up front makes the guarantee provable rather than asserted:
/// while `canonical_plaintext_len(prefs) + latent_clock_debt(prefs)` is inside
/// the budget, any removal leaves the blob inside the budget too, because the
/// clock it mints was already counted and the member it drops is pure gain.
///
/// Walks every clocked set field rather than the one being written, for the same
/// reason the base is measured over the whole view: a removal on `archived_folders`
/// is paid for out of the same 64 KiB as one on `deliberate_folders`.
fn latent_clock_debt(prefs: &protocol::PrefsView) -> usize {
    use crate::plugins::sync::prefs_classification::{PrefClass, SharedDiscipline, CLASSIFICATION};
    let mut debt = 0usize;
    for (name, class) in CLASSIFICATION {
        let folded = match class {
            PrefClass::Shared(SharedDiscipline::SetUnion {
                folded,
                removals_propagate: true,
            }) => *folded,
            // A monotone set stamps no clock, so it owes no tombstone and has no
            // latent debt. Charging it one would refuse entries on an egress
            // control for a member that is never written.
            _ => continue,
        };
        for raw in set_field(prefs, name) {
            let key = clock_key(name, &set_identity(folded, raw));
            if !prefs.field_clocks.contains_key(&key) {
                debt += protocol::canonical_clock_member_cost(&key, CLOCK_VALUE_DIGITS);
            }
        }
    }
    debt
}

/// Order the additions so that, when the budget binds, what survives is the
/// vault's TOP-LEVEL structure rather than an arbitrary slice.
///
/// Shallowest first, then alphabetically. This is a requirement rather than a
/// nicety: the budget is reachable in ordinary use (a large Obsidian import
/// overflows it), and a surviving subset nobody can explain is worse than a
/// smaller one everybody can. Ties break on the raw string so the result is
/// deterministic across implementations.
fn budget_order(entries: &mut [String]) {
    entries.sort_by(|a, b| {
        let depth = |s: &str| s.chars().filter(|c| *c == '/').count();
        depth(a).cmp(&depth(b)).then_with(|| a.cmp(b))
    });
}

/// The `(folded, clocked)` pair for a set field, read from the ONE table that
/// decides it.
///
/// Taken from `prefs_classification::CLASSIFICATION` rather than from a caller
/// argument, and that is the fix rather than the style: the five call sites used
/// to pass `folded` as a hand-written literal, nothing compared those literals
/// against the table, and a swapped one typechecks. `folded=false` on a folder
/// set leaves `projects/` behind when the user removes `Projects/`, so the entry
/// returns on the next merge; `folded=true` on `spell_languages` deletes `de-de`
/// when the user removes `de-DE`. Both are silent. `set_fold()` on the merge side
/// was written for exactly this reason, in this same change, and the write side
/// is where the bytes the merge later reads are produced.
///
/// Panics on a field that is not a `SetUnion`, the same way `set_fold` does: a
/// caller reaching this with the wrong field name is a programming error, and
/// answering a default would apply some other field's identity rule.
fn set_rules(field: &str) -> (bool, bool) {
    use crate::plugins::sync::prefs_classification::{classify, PrefClass, SharedDiscipline};
    match classify(field) {
        Some(PrefClass::Shared(SharedDiscipline::SetUnion {
            folded,
            removals_propagate,
        })) => (folded, removals_propagate),
        other => panic!(
            "apply_set_mutation called for {field}, which classifies as {other:?} rather than a set-union field"
        ),
    }
}

/// Apply a mutation to one of `prefs`'s set fields, in place.
///
/// Takes the whole view rather than the one vector, because the budget it
/// enforces is a bound on the BLOB (see [`PREFS_PLAINTEXT_BUDGET_BYTES`]) and
/// one field's entries cannot see the other four set fields, the `field_clocks`
/// entries that outlive their entries, or anything a merge put there.
///
/// The identity is read from the field's own classification row, never from a
/// caller argument: see [`set_rules`].
///
/// Removals are applied before additions, so a mutation that removes and re-adds
/// the same entry in one call ends with the entry present. That order is the one
/// a caller means by "replace this entry", and the reverse would silently drop
/// it.
///
/// Returns how many additions were REFUSED for budget, which is zero in every
/// ordinary case and is what the import surface reports as a shortfall.
///
/// Removals are never refused, and that is now a property rather than an
/// assertion. The sentence that used to stand here said "shrinking the set
/// cannot overflow it", which is false: a removal trades a live member for a
/// PERMANENT `field_clocks` tombstone, and on a folder set the tombstone is the
/// larger of the two, so a removal GROWS the blob. Deleting 1,100 of 2,200
/// clockless entries took a 46,257-byte plaintext to 82,574 and a failed encode,
/// with this function reporting zero refusals, on exactly the vaults the budget
/// was added for and through the only remedy the budget-full notice offers.
///
/// What makes it true is [`latent_clock_debt`]: every live entry is charged for
/// the tombstone it will one day mint, so the room a removal needs was reserved
/// when the entry was admitted. See that function for the argument.
pub fn apply_set_mutation(
    prefs: &mut protocol::PrefsView,
    field: &str,
    mutation: &SetMutation,
) -> usize {
    let (folded, clocked) = set_rules(field);
    let identity = |raw: &str| -> String { set_identity(folded, raw) };

    // --- the removing half, all three verbs, before anything is measured ----

    if !mutation.remove.is_empty() {
        let gone: std::collections::BTreeSet<String> =
            mutation.remove.iter().map(|r| identity(r)).collect();
        set_field_mut(prefs, field).retain(|held| !gone.contains(&identity(held)));
    }

    // An entry that folds to empty is dropped rather than treated as the root.
    // See `SetMutation::remove_prefix`: the root matches everything, so the
    // no-op case would be the destructive one.
    let prefixes: Vec<String> = mutation
        .remove_prefix
        .iter()
        .map(|p| identity(p))
        .filter(|p| !p.is_empty())
        .collect();
    if !prefixes.is_empty() {
        set_field_mut(prefs, field).retain(|held| {
            let id = identity(held);
            !prefixes.iter().any(|p| id.starts_with(p.as_str()))
        });
    }

    // Re-rooting is a rewrite in place rather than a remove plus an add, so it
    // cannot half-apply under the budget and so an entry that keeps its
    // identity keeps its clock.
    let renames: Vec<(String, String)> = mutation
        .rename_prefix
        .iter()
        .map(|r| (identity(&r.from), r.to.clone()))
        .filter(|(from, _)| !from.is_empty())
        .collect();
    if !renames.is_empty() {
        for held in set_field_mut(prefs, field).iter_mut() {
            let id = set_identity(folded, held);
            let Some((from, to)) = renames
                .iter()
                .find(|(from, _)| id.starts_with(from.as_str()))
            else {
                continue;
            };
            // The tail is taken off the FOLDED identity, because that is what
            // the prefix matched. A folded field stores folded-equivalent
            // display forms, so re-rooting on the raw string would work only
            // while the two happened to agree in case and normalisation.
            let tail = &id[from.len()..];
            let mut next = to.clone();
            if !next.is_empty() && !next.ends_with('/') {
                next.push('/');
            }
            next.push_str(tail);
            *held = next;
        }
        set_field_mut(prefs, field).dedup_by(|a, b| identity(a) == identity(b));
    }

    // --- the base, measured once, and what the measurement has to include ---

    // Everything the old per-field estimate could not see is in the first term.
    // The second is the part the first cannot see: the tombstones the entries
    // now standing will mint when they are removed. Without it the budget is a
    // bound on additions only, and a DELETE can push the blob past the cap.
    let mut used = protocol::canonical_plaintext_len(prefs) + latent_clock_debt(prefs);

    // Fold every held identity once. The previous shape re-folded the whole
    // stored set for every candidate, and folding allocates (split, NFC,
    // lowercase, join), so a 5,000-folder import ran 1.56 s in release and
    // 16.8 s in debug INSIDE the prefs write mutex, which on the web client is
    // the Worker thread with no UI behind it. The importer and the unlock
    // back-fill are exactly the two callers whose input size is the vault's.
    let mut held: std::collections::BTreeSet<String> = set_field(prefs, field)
        .iter()
        .map(|h| identity(h))
        .collect();

    // The repair verb is filtered BEFORE the budget order, so a candidate a
    // tombstone rejects never competes for reserve with one that will land.
    let mut pending: Vec<String> = mutation.add.clone();
    for raw in &mutation.add_unless_removed {
        let id = identity(raw);
        let removed_on_record = !set_field(prefs, field).iter().any(|h| identity(h) == id)
            && prefs.field_clocks.contains_key(&clock_key(field, &id));
        if !removed_on_record {
            pending.push(raw.clone());
        }
    }
    budget_order(&mut pending);

    let mut refused = 0usize;
    for raw in pending {
        let id = identity(&raw);
        if held.contains(&id) {
            continue;
        }
        let cost = entry_cost(field, &raw, folded, clocked);
        if used + cost > PREFS_PLAINTEXT_BUDGET_BYTES {
            // Past the reserve this entry is simply not registered, and the
            // folder behaves as it did before myne#613: it exists while it holds
            // a note and stops existing when the last one leaves. The caller is
            // told how many, and tells the user (myne#613's notice surface).
            refused += 1;
            continue;
        }
        used += cost;
        held.insert(id);
        set_field_mut(prefs, field).push(raw);
    }
    refused
}

/// Shed retained tombstones until `prefs` encodes, and report how many went.
///
/// The budget in [`apply_set_mutation`] bounds what a LOCAL write produces. It
/// cannot bound what a MERGE produces, and a merge is where the cap is actually
/// reached: `merge_set_with_removals` unions both sides' entries and both sides'
/// indefinitely-retained clocks with no bound, deliberately, because a budget
/// applied during the merge makes refusal order-dependent and breaks
/// `merge(a,b) == merge(b,a)`, which that module's own tests assert. Two devices
/// each sitting just inside the local budget merge to roughly twice the cap: the
/// measured pair was 61,415 bytes each going to 122,756 together, and
/// `encode_prefs_blob` refusing.
///
/// What that cost before this function existed was not a lost preference. The
/// encode failure became `SyncCycleError::Io` and propagated out of
/// `sync_cycle_attempt` BEFORE the notes phase, so the whole sync cycle died,
/// every cycle, permanently, notes included, with no user-reachable remedy: the
/// local deletions that would shrink the blob could never reach the peer,
/// because the cycle aborted before the push.
///
/// So the bound moves to the one point both paths cross, just before the encode,
/// and it is applied to the merged view rather than during the merge, which is
/// what keeps commutativity: the input is the same set on both devices and the
/// shedding order is total, so both devices shed the same members and arrive at
/// the same bytes.
///
/// **Only tombstones are shed, never live members.** A tombstone is a record
/// about something that is already gone; losing the oldest ones can let an old
/// deletion come back from a peer that still holds the entry, which is the
/// failure this whole issue is about, in miniature and bounded. Losing a live
/// member is losing a folder the user has. Between a resurrected old deletion
/// and a permanently wedged sync, the first is not close.
///
/// Lowest clock first, then by key, because that is a total order over the union
/// and therefore identical on both devices, and because the oldest tombstone is
/// the one most likely to have been seen by every peer already.
pub fn shed_retained_clocks(prefs: &mut protocol::PrefsView) -> usize {
    let mut len = protocol::canonical_plaintext_len(prefs);
    if len <= protocol::MAX_PREFS_PLAINTEXT_LEN {
        return 0;
    }
    let live = live_set_clock_keys(prefs);
    let owners = clocked_set_field_prefixes();
    let mut sheddable: Vec<(u64, String)> = prefs
        .field_clocks
        .iter()
        .filter(|(key, _)| {
            // BOTH conditions, and the first is the one that is easy to leave
            // out: `field_clocks` also holds per-key map clocks
            // (`device_names/<id>`, the MYND-562 decoration maps) and bare field
            // clocks, and none of those is a set tombstone. A shape test alone
            // (`key.contains('/')`) would shed a device name's clock, which is
            // not this function's to judge and whose loss un-does a device
            // rename on the next merge.
            owners.iter().any(|p| key.starts_with(p.as_str())) && !live.contains(*key)
        })
        .map(|(key, value)| (*value, key.clone()))
        .collect();
    sheddable.sort();

    // Shed in BATCHES sized by arithmetic, re-measuring only to confirm.
    //
    // The first version re-encoded the whole blob after every single removal,
    // which is O(n) encodes of an O(n) blob. It was correct and it took over a
    // minute for one call in a debug test, on a path that runs on every merge
    // and inside the prefs write mutex, which on the web client is the Worker
    // with no UI behind it. That is the same defect this round's review found in
    // `apply_set_mutation`, one function over, so it gets the same answer:
    // compute the shortfall, take enough to cover it, then verify.
    //
    // The loop remains because the per-member cost is an ESTIMATE of the
    // encoder's output (`canonical_clock_member_cost` charges 13 digits for a
    // value that may be shorter, and the map's own separators shift), and this
    // function's whole job is to guarantee the encode. So the arithmetic picks
    // the batch and the measurement decides whether to stop: fast in the
    // ordinary case, still exact.
    let mut shed = 0usize;
    let mut next = 0usize;
    while len > protocol::MAX_PREFS_PLAINTEXT_LEN && next < sheddable.len() {
        let overshoot = len - protocol::MAX_PREFS_PLAINTEXT_LEN;
        let mut freed = 0usize;
        while next < sheddable.len() && freed <= overshoot {
            let (value, key) = &sheddable[next];
            freed += protocol::canonical_clock_member_cost(key, decimal_digits(*value));
            prefs.field_clocks.remove(key);
            shed += 1;
            next += 1;
        }
        len = protocol::canonical_plaintext_len(prefs);
    }
    shed
}

/// Decimal digits `value` encodes to, so the shedder charges what it is really
/// dropping rather than the 13-digit width the budget reserves for a clock that
/// does not exist yet.
fn decimal_digits(value: u64) -> usize {
    let mut n = 1;
    let mut v = value;
    while v >= 10 {
        v /= 10;
        n += 1;
    }
    n
}

/// Clock keys belonging to an entry that is still PRESENT in its set field.
///
/// The complement of what [`shed_retained_clocks`] may drop. A present entry's
/// clock is what lets its addition beat a peer's older tombstone, so shedding it
/// would make the entry lose to a deletion the user has already undone.
///
/// Restricted to set fields on purpose: `field_clocks` also holds per-key map
/// clocks (`device_names/<id>`, the decoration maps) and bare field clocks, and
/// none of those is this function's to judge. Its caller pairs it with
/// [`clocked_set_field_prefixes`] for that reason, so a per-key map clock is
/// never shed either: such a key is absent from `live` too, and only the field
/// name tells the two apart.
fn live_set_clock_keys(prefs: &protocol::PrefsView) -> std::collections::BTreeSet<String> {
    use crate::plugins::sync::prefs_classification::{PrefClass, SharedDiscipline, CLASSIFICATION};
    let mut live = std::collections::BTreeSet::new();
    for (name, class) in CLASSIFICATION {
        let folded = match class {
            PrefClass::Shared(SharedDiscipline::SetUnion {
                folded,
                removals_propagate: true,
            }) => *folded,
            _ => continue,
        };
        for raw in set_field(prefs, name) {
            live.insert(clock_key(name, &set_identity(folded, raw)));
        }
    }
    live
}

/// `"<field>/"` for every set field that carries removal clocks.
///
/// The one place that answers "does this `field_clocks` key belong to a set
/// tombstone", derived from `CLASSIFICATION` rather than listed, so a field that
/// gains or loses `removals_propagate` moves this with it.
fn clocked_set_field_prefixes() -> Vec<String> {
    use crate::plugins::sync::prefs_classification::{PrefClass, SharedDiscipline, CLASSIFICATION};
    CLASSIFICATION
        .iter()
        .filter_map(|(name, class)| match class {
            PrefClass::Shared(SharedDiscipline::SetUnion {
                removals_propagate: true,
                ..
            }) => Some(format!("{name}/")),
            _ => None,
        })
        .collect()
}

/// The set field `field` names.
///
/// See [`set_field_mut`] for why this is a match and what checks it.
fn set_field<'a>(prefs: &'a protocol::PrefsView, field: &str) -> &'a Vec<String> {
    match field {
        "deliberate_folders" => &prefs.deliberate_folders,
        "archived_folders" => &prefs.archived_folders,
        "ai_excluded_folders" => &prefs.ai_excluded_folders,
        "cli_excluded_folders" => &prefs.cli_excluded_folders,
        "spell_languages" => &prefs.spell_languages,
        other => panic!("{other} is not a set-union prefs field"),
    }
}

/// The set field `field` names, mutably.
///
/// A match rather than a derived lookup, and it is the one place the five names
/// map to their storage. Panics on anything else, for the same reason
/// [`set_rules`] does.
///
/// A match is a roster, and a roster compared against nothing is the failure
/// mode `AGENTS.md` names: [`set_rules`] reads membership off `CLASSIFICATION`,
/// so a field reclassified to `SetUnion` in that table (a one-line edit) would
/// be accepted there and panic here, at a user's write, having compiled and
/// passed clippy. `every_classified_set_field_is_accessible` walks the table and
/// calls both accessors, so that edit fails at `cargo test` instead.
fn set_field_mut<'a>(prefs: &'a mut protocol::PrefsView, field: &str) -> &'a mut Vec<String> {
    match field {
        "deliberate_folders" => &mut prefs.deliberate_folders,
        "archived_folders" => &mut prefs.archived_folders,
        "ai_excluded_folders" => &mut prefs.ai_excluded_folders,
        "cli_excluded_folders" => &mut prefs.cli_excluded_folders,
        "spell_languages" => &mut prefs.spell_languages,
        other => panic!("{other} is not a set-union prefs field"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    /// A view holding `entries` in `field` and nothing else.
    ///
    /// The budget is measured against the whole canonical plaintext now, so a
    /// test that handed over a bare `Vec` could not express what it is bounding.
    fn view(field: &str, entries: &[&str]) -> protocol::PrefsView {
        let mut p = protocol::PrefsView::default();
        *set_field_mut(&mut p, field) = v(entries);
        p
    }

    /// The field's entries after the mutation, for the assertions below.
    fn held(p: &mut protocol::PrefsView, field: &str) -> Vec<String> {
        set_field_mut(p, field).clone()
    }

    #[test]
    fn an_addition_that_is_already_present_is_a_no_op() {
        let mut prefs = view("deliberate_folders", &["Alpha/"]);
        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::adding("Alpha/"),
        );
        assert_eq!(held(&mut prefs, "deliberate_folders"), v(&["Alpha/"]));
    }

    #[test]
    fn a_removal_matches_by_folded_identity_on_a_folder_set() {
        // The user removed `Projects/`; the stored form is `projects/`. Raw
        // equality would leave it behind, and the folder would come back.
        let mut prefs = view("deliberate_folders", &["projects/", "Other/"]);
        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::removing("Projects/"),
        );
        assert_eq!(held(&mut prefs, "deliberate_folders"), v(&["Other/"]));
    }

    #[test]
    fn a_removal_matches_a_missing_trailing_slash() {
        // `markdown-dialect.md` §3.6.2 tolerates it on reads and the Obsidian
        // importer preserves `folder:` verbatim, so both shapes reach the set.
        let mut prefs = view("deliberate_folders", &["Projects/"]);
        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::removing("Projects"),
        );
        assert!(held(&mut prefs, "deliberate_folders").is_empty());
    }

    #[test]
    fn an_unfolded_set_removes_case_sensitively() {
        // The opposite direction, asserted rather than assumed: folding language
        // codes would delete `de-de` when the user removed `de-DE`.
        let mut prefs = view("spell_languages", &["de-DE", "de-de"]);
        apply_set_mutation(
            &mut prefs,
            "spell_languages",
            &SetMutation::removing("de-DE"),
        );
        assert_eq!(held(&mut prefs, "spell_languages"), v(&["de-de"]));
    }

    #[test]
    fn a_removal_of_something_absent_is_a_no_op() {
        let mut prefs = view("deliberate_folders", &["Alpha/"]);
        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::removing("Missing/"),
        );
        assert_eq!(held(&mut prefs, "deliberate_folders"), v(&["Alpha/"]));
    }

    #[test]
    fn remove_then_add_of_the_same_entry_leaves_it_present() {
        // "Replace this entry" is what a caller means by sending both halves for
        // one identity, and the reverse order would silently drop it.
        let mut prefs = view("deliberate_folders", &["projects/"]);
        let m = SetMutation {
            add: v(&["Projects/"]),
            add_unless_removed: Vec::new(),
            remove: v(&["projects/"]),
            remove_prefix: Vec::new(),
            rename_prefix: Vec::new(),
        };
        apply_set_mutation(&mut prefs, "deliberate_folders", &m);
        assert_eq!(held(&mut prefs, "deliberate_folders"), v(&["Projects/"]));
    }

    // ── the reserved byte budget (myne#613 task 4) ──────────────────────────

    /// A folder path of `n` characters, deep enough to be realistic.
    fn folder(i: usize) -> String {
        format!("Projects/Sub{i:04}/")
    }

    #[test]
    fn additions_stop_at_the_budget_and_report_how_many() {
        // The budget is reachable in ordinary use, so what happens AT it is
        // behaviour rather than an edge case: entries past it are simply not
        // registered, and the count comes back so the caller can say so.
        let mut prefs = protocol::PrefsView::default();
        let many: Vec<String> = (0..4000).map(folder).collect();
        let refused = apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::adding_all(many.clone()),
        );
        assert!(refused > 0, "4000 folders must not fit under the cap");
        assert_eq!(
            held(&mut prefs, "deliberate_folders").len() + refused,
            many.len(),
            "every entry is either registered or counted as refused, never lost \
             silently between the two"
        );
        // MEASURED, not summed from the estimate. Summing `entry_cost` over the
        // live set and comparing it to the constant is the estimate checking
        // itself, and it is what let the tombstones and the four other set
        // fields sit outside the bound.
        let used = protocol::canonical_plaintext_len(&prefs);
        assert!(
            used <= PREFS_PLAINTEXT_BUDGET_BYTES,
            "the registered set must fit the budget: {used} > {PREFS_PLAINTEXT_BUDGET_BYTES}"
        );
        // And the thing the budget exists for: the blob must still ENCODE.
        assert!(used <= protocol::MAX_PREFS_PLAINTEXT_LEN);
    }

    #[test]
    fn an_ordinary_vault_is_nowhere_near_the_budget() {
        // The other direction, so the bound cannot quietly become tight. Fifty
        // folders is a normal vault and must cost a small fraction of the cap;
        // if this starts failing, the per-entry cost grew and the decision
        // behind the budget needs revisiting rather than the test relaxing.
        let mut prefs = protocol::PrefsView::default();
        let refused = apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::adding_all((0..50).map(folder).collect()),
        );
        assert_eq!(refused, 0);
        let used = protocol::canonical_plaintext_len(&prefs);
        assert!(
            used < PREFS_PLAINTEXT_BUDGET_BYTES / 4,
            "50 folders should sit well under a quarter of the budget, used {used}"
        );
    }

    #[test]
    fn removal_tombstones_are_inside_the_budget() {
        // THE CRITICAL this budget was rewritten for. Removal clocks outlive the
        // entries they belonged to (retention is indefinite, decided
        // 2026-08-29), and the first version of this budget summed only LIVE
        // entries, so folder churn filled the 64 KiB cap while the budget still
        // reported room. Past the cap an encode FAILS, which means no preference
        // of any kind can be saved again and deleting folders makes it worse.
        let mut prefs = protocol::PrefsView::default();
        // A blob whose weight is almost entirely tombstones: no live entry, one
        // clock per folder that once existed.
        for i in 0..4000 {
            prefs.field_clocks.insert(
                format!("deliberate_folders/{}", folder(i)),
                1_765_432_100_000,
            );
        }
        let before = protocol::canonical_plaintext_len(&prefs);
        assert!(
            before > PREFS_PLAINTEXT_BUDGET_BYTES,
            "the fixture must actually exceed the budget on tombstones alone, \
             else this test cannot fail: {before}"
        );
        let refused = apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::adding("Brand/New/"),
        );
        // Pre-fix this was 0, because the live set was empty and the estimate
        // saw 32 KiB of room in a blob already past the cap.
        assert_eq!(
            refused, 1,
            "an addition to an over-budget blob must be refused"
        );
        assert!(held(&mut prefs, "deliberate_folders").is_empty());
    }

    #[test]
    fn a_removal_is_accepted_even_when_the_blob_is_over_budget() {
        // The counterpart, and the reason the budget may never gate a removal:
        // shrinking cannot overflow, and a bound that blocked a deletion would
        // trap the user in the exact state whose only remedy is deleting.
        let mut prefs = protocol::PrefsView::default();
        for i in 0..4000 {
            prefs.field_clocks.insert(
                format!("deliberate_folders/{}", folder(i)),
                1_765_432_100_000,
            );
        }
        prefs.deliberate_folders = v(&["Doomed/"]);
        let refused = apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::removing("Doomed/"),
        );
        assert_eq!(refused, 0);
        assert!(held(&mut prefs, "deliberate_folders").is_empty());
    }

    #[test]
    fn one_set_field_cannot_spend_another_field_s_room() {
        // The second half of the correction: the budget used to be granted PER
        // FIELD, so five set fields each got 32 KiB of a 64 KiB cap and two of
        // them at reserve filled the blob between them. The bound is on the blob
        // now, so a field that arrives second sees what the first one spent.
        let mut prefs = protocol::PrefsView::default();
        let first = apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::adding_all((0..4000).map(folder).collect()),
        );
        assert!(first > 0, "the fixture must fill the blob");
        // The clocks the stamper writes for those additions, added here because
        // this test calls the mutator twice with no write cycle between, and in
        // production a write cycle separates them.
        //
        // The earlier version of this comment said the stamper "runs inside the
        // same closure". It does not: `update_prefs_with_dir` calls it AFTER the
        // closure returns. That sentence is what made the fixture look faithful
        // while the budget was measuring a state the encoder never sees, which is
        // exactly how the uncharged-tombstone defect survived its own test. The
        // budget now charges the latent clock debt instead of trusting the
        // ordering, and this fixture is a convenience rather than a claim.
        for f in held(&mut prefs, "deliberate_folders") {
            prefs
                .field_clocks
                .insert(format!("deliberate_folders/{f}"), 1_765_432_100_000);
        }
        let second = apply_set_mutation(
            &mut prefs,
            "archived_folders",
            &SetMutation::adding_all((0..500).map(folder).collect()),
        );
        assert!(
            second > 0,
            "with the blob already at budget the second field must be refused; \
             pre-fix it got its own full 32 KiB regardless"
        );
        // The property that actually matters, and the one a per-field reserve
        // could not deliver: whatever the two fields did between them, the blob
        // still encodes.
        let used = protocol::canonical_plaintext_len(&prefs);
        assert!(
            used <= protocol::MAX_PREFS_PLAINTEXT_LEN,
            "two set fields must not fill the cap between them: {used}"
        );
    }

    #[test]
    fn what_survives_the_budget_is_the_shallowest_alphabetical_prefix() {
        // The requirement that makes the limit explainable. Without a stated
        // order the surviving subset is whatever the iteration produced, and a
        // user cannot be told why THESE folders are remembered.
        let mut prefs = protocol::PrefsView::default();
        let mut entries: Vec<String> = Vec::new();
        // One shallow folder, and enough deep ones to blow the budget.
        entries.push("Aaa/".to_string());
        entries.push("Zzz/".to_string());
        for i in 0..4000 {
            entries.push(format!("Deep/Nested/Level/{i:04}/"));
        }
        let refused = apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::adding_all(entries),
        );
        assert!(refused > 0);
        assert!(
            held(&mut prefs, "deliberate_folders").contains(&"Aaa/".to_string())
                && held(&mut prefs, "deliberate_folders").contains(&"Zzz/".to_string()),
            "both top-level folders must survive: they are shallowest, so they \
             are taken first however many deep ones were offered"
        );
        let kept = held(&mut prefs, "deliberate_folders");
        assert_eq!(kept[0], "Aaa/", "shallowest first, then alphabetical");
        assert_eq!(kept[1], "Zzz/");
    }

    #[test]
    fn a_removal_is_never_refused_for_budget() {
        // A budget that could block a deletion would trap a user whose only way
        // out of the budget is deleting.
        let mut prefs = protocol::PrefsView {
            deliberate_folders: (0..4000).map(folder).collect(),
            ..Default::default()
        };
        let target = prefs.deliberate_folders[7].clone();
        let refused = apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::removing(target.clone()),
        );
        assert_eq!(refused, 0);
        assert!(!held(&mut prefs, "deliberate_folders").contains(&target));
    }

    #[test]
    fn an_empty_mutation_changes_nothing() {
        // The property that makes this safe against a stale caller: a caller
        // that means to change nothing cannot accidentally claim a deletion.
        let mut prefs = view("deliberate_folders", &["Alpha/", "Beta/"]);
        apply_set_mutation(&mut prefs, "deliberate_folders", &SetMutation::default());
        assert_eq!(
            held(&mut prefs, "deliberate_folders"),
            v(&["Alpha/", "Beta/"])
        );
        assert!(SetMutation::default().is_empty());
    }

    /// The property the whole module exists for, stated as the stamper sees it.
    ///
    /// `stamp_changed_shared_fields` derives a removal from `before \ after` on
    /// the STORED view. That inference is what myne#613's review found to be
    /// unsound, and the fix was not to replace it but to make its input honest:
    /// once the mutation is applied to the current stored set, the diff is
    /// between the disk before and the disk after, so it is exactly what the
    /// caller removed.
    ///
    /// This test is the proof, and it is written as the two diffs rather than as
    /// a merge assertion, because the merge is not what was wrong.
    #[test]
    fn the_stored_diff_now_equals_what_the_caller_asked_to_remove() {
        // The disk holds an entry this caller has never seen (a peer's, landed
        // by a sync between the caller's view being seeded and committed).
        let before = v(&["Mine/", "PeerLanded/"]);

        // The caller adds one and removes one, and mentions nothing else.
        let mut prefs = view("deliberate_folders", &["Mine/", "PeerLanded/"]);
        let m = SetMutation {
            add: v(&["New/"]),
            add_unless_removed: Vec::new(),
            remove: v(&["Mine/"]),
            remove_prefix: Vec::new(),
            rename_prefix: Vec::new(),
        };
        apply_set_mutation(&mut prefs, "deliberate_folders", &m);
        let after = held(&mut prefs, "deliberate_folders");

        let vanished: Vec<&String> = before.iter().filter(|e| !after.contains(e)).collect();
        assert_eq!(
            vanished,
            vec![&"Mine/".to_string()],
            "the stamper's `before \\ after` must name exactly what the caller \
             removed, and never the peer's entry the caller could not see"
        );
        assert!(
            after.contains(&"PeerLanded/".to_string()),
            "the peer's entry survives a caller that never knew about it"
        );

        // The counterfactual, so this test cannot pass for the wrong reason:
        // under the old whole-set replace the caller would have written its own
        // view, and `before \ after` would have named the peer's entry too.
        let replaced = v(&["New/"]);
        let would_have_vanished: Vec<&String> =
            before.iter().filter(|e| !replaced.contains(e)).collect();
        assert!(
            would_have_vanished.contains(&&"PeerLanded/".to_string()),
            "the replace shape really did claim the peer's entry; if this stops \
             being true the test above is no longer measuring anything"
        );
    }

    #[test]
    fn a_stale_caller_cannot_remove_an_entry_it_never_saw() {
        // The defect this module exists for, at the unit level. The caller's
        // view predates `Peer/`, so its mutation does not mention it, and the
        // entry survives. Under a whole-set replace the same caller would have
        // written a set without `Peer/` and the stamper would have read that
        // absence as a deletion.
        let mut prefs = view("deliberate_folders", &["Mine/", "Peer/"]);
        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::adding("New/"),
        );
        assert!(held(&mut prefs, "deliberate_folders").contains(&"Peer/".to_string()));
        assert!(held(&mut prefs, "deliberate_folders").contains(&"New/".to_string()));
    }

    // ---- myne#613 review round 2 --------------------------------------------

    /// The roster `set_field_mut` is, compared against the table `set_rules`
    /// reads.
    ///
    /// Revert to watch it fail: delete the `"spell_languages"` arm from
    /// `set_field_mut`. The tree still compiles and clippy is still clean,
    /// because nothing else compares the two, and the panic would have arrived
    /// inside a user's prefs write.
    #[test]
    fn every_classified_set_field_is_accessible() {
        use crate::plugins::sync::prefs_classification::{
            PrefClass, SharedDiscipline, CLASSIFICATION,
        };
        let mut seen = 0usize;
        for (name, class) in CLASSIFICATION {
            if !matches!(class, PrefClass::Shared(SharedDiscipline::SetUnion { .. })) {
                continue;
            }
            let mut prefs = protocol::PrefsView::default();
            // Both accessors, because they are two matches and only one of them
            // is exercised by the rest of this module.
            set_field_mut(&mut prefs, name).push("Probe/".to_string());
            assert_eq!(set_field(&prefs, name).len(), 1, "{name}");
            // And the rules table, so a field that classifies as a set but has
            // no arm fails here rather than at a write.
            let _ = set_rules(name);
            seen += 1;
        }
        assert!(seen >= 5, "the classification lost set fields: {seen}");
    }

    /// A quote and a control character cost more than one byte each, and the
    /// budget has to charge what the encoder will write.
    ///
    /// Revert to watch it fail: put `raw.len() + 3` back in `entry_cost`.
    #[test]
    fn an_entry_is_charged_its_escaped_length() {
        let plain = entry_cost("deliberate_folders", "Work/", true, false);
        let quoted = entry_cost("deliberate_folders", "Wo\"rk/", true, false);
        assert_eq!(
            quoted,
            plain + 2,
            "a quote is one more char and one more escape byte"
        );
        let control = entry_cost("deliberate_folders", "Wo\u{1}rk/", true, false);
        assert_eq!(
            control,
            plain + 6,
            "a C0 control character encodes as six bytes (\\u00XX)"
        );
    }

    /// C2, the invariant half. After a write, the blob plus the tombstones its
    /// live entries WILL mint must still be inside the budget.
    ///
    /// That is the whole reason "a removal is never refused" is safe to promise.
    /// A removal does not shrink the blob: it trades a live member for a
    /// permanent clock, and on a folder set the clock is bigger. If the room for
    /// those clocks was not reserved when the entries were admitted, a delete
    /// can push the blob past the cap, which was the measured failure (2,200
    /// clockless entries at 46,257 bytes going to 82,574 on removing half, with
    /// `refused` reporting zero).
    ///
    /// Revert to watch it fail: drop `+ latent_clock_debt(prefs)` from the base
    /// in `apply_set_mutation`. The fill then admits roughly twice as many
    /// entries and this assertion names the shortfall.
    ///
    /// Two earlier versions of this test could not fail, and both are worth
    /// recording because the second looked much more convincing than the first.
    ///
    /// v1 built its fixture by filling THROUGH the fixed budget and then deleted
    /// half, so the over-cap state the defect needs was never constructed. v2
    /// asserted the invariant directly, but on a view that starts EMPTY, where
    /// `latent_clock_debt` is zero by definition, so the injected term was not
    /// consulted either. Only the injection said so, twice. The debt term does
    /// its work when entries are ALREADY standing without clocks, which is
    /// exactly a vault written by the previously shipped release, so that is
    /// what this builds.
    #[test]
    fn a_vault_already_deep_in_tombstone_debt_admits_nothing_new() {
        // Built DIRECTLY: 2,200 clockless entries is a set the current budget
        // would never have admitted, and is what an upgraded vault looks like.
        let mut prefs = protocol::PrefsView::default();
        for i in 0..2200 {
            prefs.deliberate_folders.push(folder(i));
        }
        let plain = protocol::canonical_plaintext_len(&prefs);
        assert!(
            plain < PREFS_PLAINTEXT_BUDGET_BYTES,
            "the fixture must look harmless by the old measure, which is the trap: {plain}"
        );
        assert!(
            plain + latent_clock_debt(&prefs) > PREFS_PLAINTEXT_BUDGET_BYTES,
            "the fixture must actually be in debt"
        );

        let refused = apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::adding("Newcomer/"),
        );

        assert_eq!(
            refused, 1,
            "the addition was admitted into an over-debt blob"
        );
        assert!(
            !prefs.deliberate_folders.iter().any(|f| f == "Newcomer/"),
            "the entry landed despite the refusal"
        );
    }

    /// C2, the rescue half. A vault that is ALREADY past the debt-inclusive
    /// budget cannot be saved by the budget, because it was never asked. It is
    /// what a vault written by the previously shipped release looks like, and a
    /// delete on it must still produce a blob the encoder accepts.
    ///
    /// Revert to watch it fail: make `shed_retained_clocks` return 0 without
    /// touching `prefs`. Deleting a folder is the one remedy the budget-full
    /// notice offers, so `PrefsEncodeFailed` here is a dead end.
    #[test]
    fn a_delete_on_a_legacy_over_budget_vault_still_encodes() {
        // Built DIRECTLY, not through `apply_set_mutation`, because the point is
        // a set the current budget would never have admitted.
        let mut prefs = protocol::PrefsView::default();
        for i in 0..2200 {
            prefs.deliberate_folders.push(folder(i));
        }
        assert!(
            protocol::canonical_plaintext_len(&prefs) < PREFS_PLAINTEXT_BUDGET_BYTES,
            "the fixture must look harmless before the delete, which is the trap"
        );

        let doomed: Vec<String> = prefs
            .deliberate_folders
            .iter()
            .take(1100)
            .cloned()
            .collect();
        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation {
                remove: doomed.clone(),
                ..SetMutation::default()
            },
        );
        // What `stamp_changed_shared_fields` does next, after the closure.
        for raw in &doomed {
            prefs.field_clocks.insert(
                clock_key(
                    "deliberate_folders",
                    &crate::folder_key::canonical_folder(raw),
                ),
                1_765_432_100_000,
            );
        }
        assert!(
            protocol::canonical_plaintext_len(&prefs) > protocol::MAX_PREFS_PLAINTEXT_LEN,
            "the fixture must reproduce the over-cap delete"
        );

        // The write path's last-resort guard, in the same order production runs
        // it: mutate, stamp, shed, encode.
        shed_retained_clocks(&mut prefs);
        let len = protocol::canonical_plaintext_len(&prefs);
        assert!(
            len <= protocol::MAX_PREFS_PLAINTEXT_LEN,
            "the delete produced an unencodable blob: {len} > {}",
            protocol::MAX_PREFS_PLAINTEXT_LEN
        );
        assert_eq!(
            prefs.deliberate_folders.len(),
            1100,
            "shedding took live entries, not just tombstones"
        );
    }

    /// The back-fill's repair verb must not undo a deletion somebody made.
    ///
    /// Revert to watch it fail: push `add_unless_removed` into `pending`
    /// unconditionally. The folder then comes back, carrying a clock newer than
    /// the removal that took it away, on every device.
    #[test]
    fn a_repair_does_not_resurrect_an_entry_whose_removal_is_on_record() {
        let mut prefs = protocol::PrefsView::default();
        prefs.deliberate_folders.push("Kept/".to_string());
        // `Gone/` is ABSENT and clocked: the last thing that happened to it was
        // a removal, here or on a peer whose removal a merge applied.
        prefs
            .field_clocks
            .insert(clock_key("deliberate_folders", "gone/"), 1_765_432_100_000);

        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::repairing_all(v(&["Gone/", "Fresh/"])),
        );

        let held_now = held(&mut prefs, "deliberate_folders");
        assert!(
            !held_now.iter().any(|f| f == "Gone/"),
            "the repair resurrected a deleted folder: {held_now:?}"
        );
        assert!(
            held_now.iter().any(|f| f == "Fresh/"),
            "a folder with no removal on record must still be repaired"
        );
    }

    /// A clock alone is not a tombstone, because the stamper stamps ADDS too.
    /// An entry that is PRESENT and clocked is live, and repairing it is a
    /// no-op rather than a refusal.
    #[test]
    fn a_present_clocked_entry_is_not_treated_as_removed() {
        let mut prefs = protocol::PrefsView::default();
        prefs.deliberate_folders.push("Live/".to_string());
        prefs
            .field_clocks
            .insert(clock_key("deliberate_folders", "live/"), 1_765_432_100_000);

        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::repairing_all(v(&["Live/"])),
        );
        assert_eq!(held(&mut prefs, "deliberate_folders"), v(&["Live/"]));
    }

    /// A genuine user act still beats a tombstone; only the REPAIR verb defers
    /// to one. Filing a note back into a deleted folder is at-fill, which uses
    /// `add`, and that is the behaviour the stamper's add arm exists for.
    #[test]
    fn a_user_add_still_beats_a_tombstone() {
        let mut prefs = protocol::PrefsView::default();
        prefs
            .field_clocks
            .insert(clock_key("deliberate_folders", "gone/"), 1_765_432_100_000);
        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::adding("Gone/"),
        );
        assert_eq!(held(&mut prefs, "deliberate_folders"), v(&["Gone/"]));
    }

    /// C1. Two devices each just inside the local budget merge to roughly twice
    /// the cap, and the merged view has to be brought back before it is encoded.
    ///
    /// Revert to watch it fail: make `shed_retained_clocks` return 0 without
    /// touching `prefs`.
    #[test]
    fn a_merged_over_cap_view_is_brought_back_under_the_cap() {
        let mut prefs = protocol::PrefsView::default();
        // Two disjoint device-sized sets, unioned the way a merge unions them,
        // each carrying its own retained clocks.
        for device in 0..2 {
            for i in 0..2000 {
                let f = format!("Device{device}/Sub{i:04}/");
                let id = crate::folder_key::canonical_folder(&f);
                prefs.field_clocks.insert(
                    clock_key("deliberate_folders", &id),
                    1_000_000_000_000 + i as u64,
                );
            }
        }
        assert!(
            protocol::canonical_plaintext_len(&prefs) > protocol::MAX_PREFS_PLAINTEXT_LEN,
            "the fixture must actually be over the cap"
        );

        let shed = shed_retained_clocks(&mut prefs);
        assert!(shed > 0, "nothing was shed");
        assert!(
            protocol::canonical_plaintext_len(&prefs) <= protocol::MAX_PREFS_PLAINTEXT_LEN,
            "still over the cap after shedding"
        );
    }

    /// Shedding may not depend on which device is asking, or the two peers
    /// diverge permanently and each keeps re-pushing its own answer.
    #[test]
    fn shedding_is_the_same_on_both_devices() {
        let build = |order: &[usize]| {
            let mut p = protocol::PrefsView::default();
            for i in order {
                let f = format!("Folder/Sub{i:05}/");
                let id = crate::folder_key::canonical_folder(&f);
                p.field_clocks.insert(
                    clock_key("deliberate_folders", &id),
                    1_000_000_000_000 + *i as u64,
                );
            }
            p
        };
        let forward: Vec<usize> = (0..4000).collect();
        let backward: Vec<usize> = (0..4000).rev().collect();
        let mut a = build(&forward);
        let mut b = build(&backward);
        shed_retained_clocks(&mut a);
        shed_retained_clocks(&mut b);
        assert_eq!(
            a.field_clocks, b.field_clocks,
            "two devices shed different clocks from the same union"
        );
    }

    /// Shedding drops tombstones. It may not drop the clock of an entry that is
    /// still present, which is what lets that entry beat a peer's older
    /// deletion, and it may not touch a per-key map clock at all.
    ///
    /// Revert to watch it fail: drop the `!live.contains(*key)` term, or the
    /// `owners` term, from the filter in `shed_retained_clocks`.
    #[test]
    fn shedding_spares_live_entries_and_other_clock_families() {
        let mut prefs = protocol::PrefsView::default();
        prefs.deliberate_folders.push("Kept/".to_string());
        prefs
            .field_clocks
            .insert(clock_key("deliberate_folders", "kept/"), 1);
        prefs
            .field_clocks
            .insert("device_names/3f9ac2d1aabbccdd".to_string(), 1);
        prefs.field_clocks.insert("label".to_string(), 1);
        // Enough tombstones to force the shedder to work.
        for i in 0..4000 {
            prefs.field_clocks.insert(
                clock_key("deliberate_folders", &format!("gone/sub{i:05}/")),
                2_000_000_000_000 + i as u64,
            );
        }
        assert!(protocol::canonical_plaintext_len(&prefs) > protocol::MAX_PREFS_PLAINTEXT_LEN);

        shed_retained_clocks(&mut prefs);

        assert!(
            prefs
                .field_clocks
                .contains_key(&clock_key("deliberate_folders", "kept/")),
            "a live entry's clock was shed"
        );
        assert!(
            prefs
                .field_clocks
                .contains_key("device_names/3f9ac2d1aabbccdd"),
            "a per-key map clock was shed"
        );
        assert!(
            prefs.field_clocks.contains_key("label"),
            "a bare field clock was shed"
        );
    }

    /// C3 and the root-wipe. `remove_prefix` removes what is STORED, including
    /// entries the caller has never seen, and an empty prefix removes nothing.
    ///
    /// Revert to watch the second half fail: drop the `.filter(|p| !p.is_empty())`
    /// in `apply_set_mutation`. `starts_with("")` is true for every input, so
    /// the no-op case becomes the destructive one, which is exactly the defect
    /// the client-side predecessor shipped.
    #[test]
    fn remove_prefix_takes_the_stored_subtree_and_an_empty_prefix_takes_nothing() {
        let mut prefs = view(
            "deliberate_folders",
            &["Projects/", "Projects/Deep/", "PROJECTS/Peer/", "Other/"],
        );
        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::removing_prefix("Projects/"),
        );
        assert_eq!(
            held(&mut prefs, "deliberate_folders"),
            v(&["Other/"]),
            "the subtree, including the entry only the disk knew about"
        );

        let mut untouched = view("deliberate_folders", &["Alpha/", "Beta/"]);
        apply_set_mutation(
            &mut untouched,
            "deliberate_folders",
            &SetMutation::removing_prefix(""),
        );
        assert_eq!(
            held(&mut untouched, "deliberate_folders"),
            v(&["Alpha/", "Beta/"]),
            "an empty prefix is a no-op, not a wipe"
        );
    }

    /// `rename_prefix` re-roots what is STORED, and it is one verb so it cannot
    /// half-apply.
    #[test]
    fn rename_prefix_re_roots_the_stored_subtree() {
        let mut prefs = view(
            "deliberate_folders",
            &["Old/", "Old/Deep/", "OLD/Peer/", "Other/"],
        );
        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::renaming_prefix("Old/", "New/"),
        );
        let mut got = held(&mut prefs, "deliberate_folders");
        got.sort();
        assert_eq!(got, v(&["New/", "New/deep/", "New/peer/", "Other/"]));
    }

    /// A rename at the budget must not lose the subtree. As a remove plus an add
    /// it would: the removals land, each stamps a propagating deletion, and the
    /// additions are refused, which turns a rename into a synchronised delete.
    ///
    /// Revert to watch it fail: express the rename as
    /// `SetMutation { remove: <old paths>, add: <new paths>, .. }`.
    #[test]
    fn a_rename_at_the_budget_does_not_become_a_delete() {
        let mut prefs = protocol::PrefsView::default();
        let refused = apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::adding_all((0..4000).map(folder).collect()),
        );
        assert!(refused > 0, "the fixture must fill the blob");
        let before = held(&mut prefs, "deliberate_folders").len();

        apply_set_mutation(
            &mut prefs,
            "deliberate_folders",
            &SetMutation::renaming_prefix("Projects/", "Archive/"),
        );

        let after = held(&mut prefs, "deliberate_folders");
        assert_eq!(after.len(), before, "the rename lost entries");
        assert!(
            after.iter().all(|f| f.starts_with("Archive/")),
            "some entries kept the old root"
        );
    }
}
