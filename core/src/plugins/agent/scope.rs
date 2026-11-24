// SPDX-License-Identifier: AGPL-3.0-only
//! Scope grants and how they resolve.
//!
//! A grant is what the user approved. Resolving it turns that approval into a
//! **fixed set of note ids**, once, at approval time. Nothing re-evaluates it
//! afterwards, and that is the whole design rather than an implementation
//! detail: a grant whose contents can change after it was approved is a
//! permission the user did not give, and here the thing that changes is write
//! access. The agent can write the very tag or move the very note that would
//! widen its own scope, so a live predicate (a tag, a saved search) is not an
//! available grant shape at all.
//!
//! `ai_excluded_folders` (SYNC-14) is applied here, host-side, on every grant
//! and every grant shape. It removes notes from the grant; it never blocks the
//! surrounding grant, because a content control that becomes a blocker on
//! unrelated work pressures the user into removing it, which is the opposite of
//! what it is for. How many notes it removed is returned so the approval screen
//! can say so: dropping them silently would leave the user believing a result
//! covered a folder it did not.
//!
//! ## The working set is the sidebar's, not the index's
//!
//! The vault index is deliberately **trash-blind**: every accessor returns rows
//! for trashed, tombstoned, archived, template and conflict-copy notes, and the
//! exclusion lives wherever the rows are turned into a view. This module is one
//! such place, so it reads the SAME verdict the sidebar tree reads rather than
//! forming its own: `NoteRecord::live` is the producer's `isLiveNote` answer,
//! shipped through `vault_indices_apply`. A hidden note is absent from the
//! resolved set and from the count, and `list_scope` / `read_note` /
//! `search_scope` all read the frozen set, so it is absent from every read tool
//! as well. `conflict:` keeps its meaning by construction, `isLiveNote` already
//! excludes it.

use crate::folder_key::{canonical_excluded, canonical_folder};
use crate::plugins::vault_indices::state::NoteRecord;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// What the user approved.
///
/// **Three shapes, and still no predicate.** There is deliberately no `Tag(..)`
/// or `Search(..)`: a predicate is a permission whose contents change after it
/// was granted, and the agent can write the very tag that would widen its own
/// scope. `Vault` is not that. It is a fixed set resolved once, like the other
/// two, and it exists so that "everything" has an explicit spelling:
/// `is_root_grant` still refuses a FOLDER grant whose path canonises to the
/// root, because a folder that happens to be the root is a mistake rather than
/// a request for the whole vault, and the earlier design had nothing else to
/// offer a caller that genuinely meant the vault (myne-md/myne#848).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum ScopeGrant {
    /// An explicit list of note ids the user picked.
    Notes(Vec<String>),
    /// A folder, equal-or-nested. Resolved against the index at approval time.
    Folder(String),
    /// Every note in the vault, minus the `ai_excluded_folders` clamp and minus
    /// the notes outside the working set. The shape the composer's default
    /// resolves to when no folder is attached and no note is open.
    Vault,
}

/// A grant, resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedGrant {
    /// The note ids this grant contributes, already clamped.
    pub note_ids: BTreeSet<String>,
    /// How many notes the `ai_excluded_folders` clamp removed. Shown to the
    /// user on the approval screen; a count of zero is still worth reporting as
    /// zero rather than hidden, so the absence of a line never has to be read as
    /// "no exclusions" versus "we did not check".
    pub excluded_count: usize,
    /// How many ids the caller named that the index does not know. Only
    /// non-zero for a `Notes` grant. These are dropped, see the module note on
    /// failing closed.
    pub unknown_count: usize,
}

/// Resolve a grant against an index snapshot and the excluded-folder set.
///
/// `records` is a snapshot of the vault index (`note_id -> NoteRecord`), taken
/// by the caller. Passing it in rather than reaching for the state keeps this
/// function pure, which is what lets the freezing property be tested directly:
/// resolve, mutate the source, and assert the resolved set did not move.
///
/// **Unknown ids fail closed.** A note id the index does not carry has no known
/// folder, so the exclusion test cannot be applied to it. Keeping it would mean
/// granting write access to a note that could not be proven outside an excluded
/// folder, so it is dropped and counted.
pub fn resolve_grant(
    grant: &ScopeGrant,
    records: &BTreeMap<String, NoteRecord>,
    excluded_folders: &[String],
) -> ResolvedGrant {
    let excluded = canonical_excluded(excluded_folders);
    let mut note_ids = BTreeSet::new();
    let mut excluded_count = 0usize;
    let mut unknown_count = 0usize;

    // Takes the note's ALREADY-canonical folder key. The folder grant arm below
    // computes it to test the prefix, and handing the raw value to
    // `folder_matches_excluded` would canonicalize the same string a second
    // time for every note in the folder.
    let mut consider = |id: &str, folder_key: &str| {
        if excluded
            .iter()
            .any(|ex| !ex.is_empty() && folder_key.starts_with(ex.as_str()))
        {
            excluded_count += 1;
        } else {
            note_ids.insert(id.to_string());
        }
    };

    match grant {
        ScopeGrant::Notes(ids) => {
            for id in ids {
                match records.get(id) {
                    // myne-md/myne#848: a note the sidebar's working-set
                    // predicate excludes (trashed, tombstoned, archived,
                    // template, conflict copy) is not a note the user could
                    // have meant to grant. Fail closed and drop it, neither
                    // granted nor counted as unknown, because the index DOES
                    // know it; it is the working set it is absent from.
                    Some(record) if record.live => {
                        let key = canonical_folder(record.folder.as_deref().unwrap_or(""));
                        consider(id, &key);
                    }
                    Some(_) => {}
                    None => unknown_count += 1,
                }
            }
        }
        ScopeGrant::Folder(folder) => {
            let key = canonical_folder(folder);
            // An empty key is the vault root. `is_root_grant` is the caller's
            // gate for that; reaching here with one would silently grant
            // everything, so resolve it to nothing instead of to the vault.
            if key.is_empty() {
                return ResolvedGrant {
                    note_ids,
                    excluded_count,
                    unknown_count,
                };
            }
            live_records_in(records, Some(&key), &mut consider);
        }
        // The whole vault, spelled deliberately (myne-md/myne#848): the same
        // walk with no prefix to match.
        ScopeGrant::Vault => live_records_in(records, None, &mut consider),
    }

    ResolvedGrant {
        note_ids,
        excluded_count,
        unknown_count,
    }
}

/// Walk every LIVE record, optionally inside one folder, and hand each to
/// `consider`.
///
/// **One walk for the folder and the vault arms** (myne-md/myne#848). They were
/// two identical loops differing in one `starts_with` test, which is the shape
/// where the next filter lands in one of them: the working-set gate especially,
/// which is the only place the run's scope can stop disagreeing with the sidebar
/// the user is looking at, and the index is deliberately trash-blind, so it
/// cannot be applied anywhere else.
///
/// `prefix` is the canonical folder key, or `None` for the whole vault.
fn live_records_in(
    records: &BTreeMap<String, NoteRecord>,
    prefix: Option<&str>,
    consider: &mut impl FnMut(&str, &str),
) {
    for (id, record) in records {
        if !record.live {
            continue;
        }
        let note_folder = canonical_folder(record.folder.as_deref().unwrap_or(""));
        if prefix.is_none_or(|key| note_folder.starts_with(key)) {
            consider(id, &note_folder);
        }
    }
}

/// Whether a grant names the vault root, which a caller must refuse before
/// resolving. Separated from [`resolve_grant`] so the refusal is a named error
/// at the command boundary rather than an empty result the UI has to interpret.
///
/// **[`ScopeGrant::Vault`] is not one of these.** This predicate is about a
/// FOLDER path that canonises to the root, a typed path that slipped through as
/// `/` or `""`, where the caller meant one folder and would have got the vault.
/// A `Vault` grant is the caller saying the vault, and refusing it would leave
/// "everything" inexpressible (myne-md/myne#848).
pub fn is_root_grant(grant: &ScopeGrant) -> bool {
    match grant {
        ScopeGrant::Folder(f) => canonical_folder(f).is_empty(),
        ScopeGrant::Notes(ids) => ids.is_empty(),
        ScopeGrant::Vault => false,
    }
}

/// Where a scope resolution gets its inputs.
///
/// A seam rather than two parameters, because the point is that a caller cannot
/// supply *one* of them. A host that passed an index snapshot and an empty
/// excluded list would compile and produce an unclamped scope; a host that
/// implements this trait answers both questions from the same place it answers
/// them everywhere else.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait ScopeSource: Send + Sync {
    /// A snapshot of the vault index.
    async fn records(
        &self,
    ) -> Result<BTreeMap<String, NoteRecord>, crate::plugins::agent::error::AgentError>;
    /// The `ai_excluded_folders` set, read at this moment.
    async fn excluded_folders(
        &self,
    ) -> Result<Vec<String>, crate::plugins::agent::error::AgentError>;
}

/// The `ai_excluded_folders` set, asked for again, by the READ path.
///
/// **Narrower than [`ScopeSource`] on purpose.** That trait answers two questions
/// and the loop must only ask one of them: `LoopDeps::records` is documented as an
/// index snapshot that is never re-read mid-loop, because a list tool answering
/// differently between two iterations would make a run's view of its scope drift
/// from the frozen set. Handing the loop a `ScopeSource` would put `records()`
/// within reach of exactly the code that must not call it.
///
/// The exclusion set is the opposite: it MUST be re-read, because SYNC-14 carries
/// no in-flight carve-out. `apply.rs` re-reads it at the write boundary for that
/// reason and says so; before myne-md/myne#529's review the read half did not,
/// so a folder the user excluded while a run was executing kept being read and,
/// on the remote arm, kept being sent off device.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait ExclusionSource: Send + Sync {
    /// The set as it is at this moment, not as it was when the run started.
    async fn excluded_now(&self) -> Result<Vec<String>, crate::plugins::agent::error::AgentError>;
}

/// The folders this vault HAS, canonically, as the write side compares them.
///
/// **The set exists because a folder in Myne is not a directory.** It is the
/// `folder:` value of at least one note, or a deliberate (empty) folder the user
/// created; there is nothing on disk to ask. So "does this folder exist" is a
/// question only the host can answer, from the same two sources the sidebar
/// renders: the index's records and `deliberate_folders`.
///
/// The root is always a member: moving a note OUT of every folder is a real
/// destination, and the composer's move-to-root has no other spelling.
pub fn known_folders<'a>(
    record_folders: impl Iterator<Item = Option<&'a str>>,
    deliberate: &[String],
) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    out.insert(String::new());
    for folder in record_folders.flatten() {
        out.insert(canonical_folder(folder));
    }
    for folder in deliberate {
        out.insert(canonical_folder(folder));
    }
    out
}

/// Start a run from a grant, resolving and clamping it here.
///
/// The one entry point for beginning a run. `AgentRunState::start` takes an
/// already-resolved id set and is deliberately not the thing a client calls:
/// this function is where the grant becomes a set, and it is the only place the
/// order (refuse a root grant, read the exclusions, snapshot the index, resolve,
/// refuse an empty result) is written down.
pub async fn start_run(
    runs: &crate::plugins::agent::run::AgentRunState,
    run_id: String,
    grant: &ScopeGrant,
    source: &dyn ScopeSource,
) -> Result<
    (ResolvedGrant, std::sync::Arc<std::sync::atomic::AtomicBool>),
    crate::plugins::agent::error::AgentError,
> {
    use crate::plugins::agent::error::AgentError;
    if is_root_grant(grant) {
        return Err(AgentError::RootGrant);
    }
    let excluded = source.excluded_folders().await?;
    let records = source.records().await?;
    let resolved = resolve_grant(grant, &records, &excluded);
    if resolved.note_ids.is_empty() {
        return Err(AgentError::EmptyGrant);
    }
    let cancel = runs.start(run_id, resolved.note_ids.clone());
    Ok((resolved, cancel))
}

/// Approve an expansion, resolving and clamping it here.
///
/// The exclusions are read at THIS moment rather than carried from the run's
/// start: a user who excludes a folder mid-run means it, and the newest answer
/// is the one that should decide what the grant contains.
pub async fn expand_run(
    runs: &crate::plugins::agent::run::AgentRunState,
    run_id: &str,
    grant: &ScopeGrant,
    origin: crate::plugins::agent::run::GrantOrigin,
    source: &dyn ScopeSource,
) -> Result<ResolvedGrant, crate::plugins::agent::error::AgentError> {
    use crate::plugins::agent::error::AgentError;
    if is_root_grant(grant) {
        return Err(AgentError::RootGrant);
    }
    let excluded = source.excluded_folders().await?;
    let records = source.records().await?;
    let resolved = resolve_grant(grant, &records, &excluded);
    runs.expand(run_id, resolved.note_ids.clone(), origin)?;
    Ok(resolved)
}

/// What a grant would resolve to, without committing it.
///
/// Runs the SAME resolution the commit runs, so an approval screen can state the
/// host's numbers rather than the caller's arithmetic. The resulting total is a
/// UNION with the run's current scope, not a sum: re-granting notes a run already
/// holds does not double its total.
pub async fn preview_grant(
    runs: &crate::plugins::agent::run::AgentRunState,
    run_id: Option<&str>,
    grant: &ScopeGrant,
    source: &dyn ScopeSource,
) -> Result<(ResolvedGrant, usize), crate::plugins::agent::error::AgentError> {
    use crate::plugins::agent::error::AgentError;
    if is_root_grant(grant) {
        return Err(AgentError::RootGrant);
    }
    let excluded = source.excluded_folders().await?;
    let records = source.records().await?;
    let resolved = resolve_grant(grant, &records, &excluded);
    let new_total = match run_id {
        Some(id) => {
            let mut set = runs.scope(id)?;
            set.extend(resolved.note_ids.iter().cloned());
            set.len()
        }
        None => resolved.note_ids.len(),
    };
    Ok((resolved, new_total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::agent::error::AgentError;
    use crate::plugins::agent::run::{AgentRunState, GrantOrigin};
    use crate::test_support::block_on;

    fn record(folder: Option<&str>) -> NoteRecord {
        NoteRecord {
            title: Some("t".into()),
            folder: folder.map(|f| f.to_string()),
            ..Default::default()
        }
    }

    fn index(pairs: &[(&str, Option<&str>)]) -> BTreeMap<String, NoteRecord> {
        pairs
            .iter()
            .map(|(id, folder)| (id.to_string(), record(*folder)))
            .collect()
    }

    #[test]
    fn a_folder_grant_covers_the_folder_and_its_subtree() {
        let idx = index(&[
            ("a", Some("Projects")),
            ("b", Some("Projects/Deep")),
            ("c", Some("Other")),
            ("d", None),
        ]);
        let r = resolve_grant(&ScopeGrant::Folder("Projects".into()), &idx, &[]);
        assert_eq!(
            r.note_ids,
            ["a", "b"].iter().map(|s| s.to_string()).collect()
        );
    }

    #[test]
    fn a_sibling_folder_is_not_covered() {
        let idx = index(&[("a", Some("ProjectsArchive"))]);
        let r = resolve_grant(&ScopeGrant::Folder("Projects".into()), &idx, &[]);
        assert!(r.note_ids.is_empty());
    }

    // The freezing property, asserted directly rather than inferred from the
    // absence of a re-resolve call: resolve, then move the source underneath.
    #[test]
    fn a_resolved_grant_does_not_follow_the_index() {
        let mut idx = index(&[("a", Some("Projects"))]);
        let r = resolve_grant(&ScopeGrant::Folder("Projects".into()), &idx, &[]);
        idx.insert("b".into(), record(Some("Projects")));
        assert_eq!(r.note_ids, ["a"].iter().map(|s| s.to_string()).collect());
    }

    #[test]
    fn excluded_notes_are_removed_and_counted_both_directions() {
        let idx = index(&[
            ("a", Some("Projects")),
            ("b", Some("Projects/Private")),
            ("c", Some("Projects/Private/Deeper")),
        ]);
        let r = resolve_grant(
            &ScopeGrant::Folder("Projects".into()),
            &idx,
            &["Projects/Private".into()],
        );
        // Removed from the set...
        assert_eq!(r.note_ids, ["a"].iter().map(|s| s.to_string()).collect());
        // ...and the reported count equals what was actually removed.
        assert_eq!(r.excluded_count, 2);
        assert_eq!(r.excluded_count, 3 - r.note_ids.len());
    }

    #[test]
    fn the_exclusion_does_not_block_the_surrounding_grant() {
        let idx = index(&[("a", Some("Projects")), ("b", Some("Projects/Private"))]);
        let r = resolve_grant(
            &ScopeGrant::Folder("Projects".into()),
            &idx,
            &["Projects/Private".into()],
        );
        assert!(
            !r.note_ids.is_empty(),
            "the rest of the folder still resolves"
        );
    }

    #[test]
    fn a_note_grant_is_clamped_too() {
        let idx = index(&[("a", Some("Private")), ("b", Some("Public"))]);
        let r = resolve_grant(
            &ScopeGrant::Notes(vec!["a".into(), "b".into()]),
            &idx,
            &["Private".into()],
        );
        assert_eq!(r.note_ids, ["b"].iter().map(|s| s.to_string()).collect());
        assert_eq!(r.excluded_count, 1);
    }

    #[test]
    fn an_unknown_note_id_fails_closed() {
        let idx = index(&[("a", Some("Public"))]);
        let r = resolve_grant(
            &ScopeGrant::Notes(vec!["a".into(), "ghost".into()]),
            &idx,
            &[],
        );
        assert_eq!(r.note_ids, ["a"].iter().map(|s| s.to_string()).collect());
        assert_eq!(r.unknown_count, 1);
    }

    #[test]
    fn a_root_grant_is_recognised_and_resolves_to_nothing() {
        assert!(is_root_grant(&ScopeGrant::Folder("".into())));
        assert!(is_root_grant(&ScopeGrant::Folder("/".into())));
        assert!(is_root_grant(&ScopeGrant::Notes(vec![])));
        let idx = index(&[("a", Some("Projects"))]);
        let r = resolve_grant(&ScopeGrant::Folder("/".into()), &idx, &[]);
        assert!(r.note_ids.is_empty());
    }

    // ── the vault grant (myne-md/myne#848) ──────────────────────────────────
    //
    // The composer's default. It is NOT a root FOLDER grant, and the pair of
    // assertions below is the whole distinction: a typed `""` path is still
    // refused, and the explicit vault shape is not.

    #[test]
    fn a_vault_grant_spells_the_whole_vault_without_being_a_root_grant() {
        assert!(!is_root_grant(&ScopeGrant::Vault));
    }

    #[test]
    fn a_vault_grant_is_the_live_notes_minus_the_clamp() {
        let idx: BTreeMap<String, NoteRecord> = [
            ("in-folder", record(Some("Projects"))),
            ("at-root", record(None)),
            ("hidden", hidden(Some("Projects"))),
            ("excluded", record(Some("Private"))),
        ]
        .into_iter()
        .map(|(id, r)| (id.to_string(), r))
        .collect();

        let r = resolve_grant(&ScopeGrant::Vault, &idx, &["Private".into()]);
        assert_eq!(
            r.note_ids,
            ["at-root", "in-folder"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            "every live note, the hidden one apart, the excluded one clamped out"
        );
        assert_eq!(r.excluded_count, 1);
        assert_eq!(r.unknown_count, 0);
    }

    #[test]
    fn a_vault_grant_the_clamp_emptied_is_refused() {
        let runs = AgentRunState::default();
        let mut records = index(&[]);
        records.insert("a".into(), record(Some("Private")));
        let src = HiddenSource {
            records,
            excluded: vec!["Private".into()],
        };
        let err = block_on(start_run(&runs, "r".into(), &ScopeGrant::Vault, &src)).unwrap_err();
        assert!(matches!(err, AgentError::EmptyGrant));
        assert!(runs.is_empty());
    }

    // ── the entry points, and the ORDER they encode ─────────────────────────
    //
    // These functions exist so a client cannot assemble the sequence itself, and
    // the sequence is the thing worth testing: refuse a root grant, read the
    // exclusions, snapshot the index, resolve, refuse an empty result. A host
    // that got the order wrong (resolved before reading prefs, say) would
    // compile and produce an unclamped scope.

    struct Source {
        records: BTreeMap<String, NoteRecord>,
        excluded: Vec<String>,
        /// Which questions were asked, in order.
        asked: std::sync::Mutex<Vec<&'static str>>,
    }

    impl Source {
        fn new(pairs: &[(&str, Option<&str>)], excluded: &[&str]) -> Self {
            Self {
                records: index(pairs),
                excluded: excluded.iter().map(|s| s.to_string()).collect(),
                asked: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl ScopeSource for Source {
        async fn records(&self) -> Result<BTreeMap<String, NoteRecord>, AgentError> {
            self.asked.lock().unwrap().push("records");
            Ok(self.records.clone())
        }
        async fn excluded_folders(&self) -> Result<Vec<String>, AgentError> {
            self.asked.lock().unwrap().push("excluded");
            Ok(self.excluded.clone())
        }
    }

    #[test]
    fn start_run_resolves_clamps_and_hands_back_the_runs_own_flag() {
        let runs = AgentRunState::default();
        let src = Source::new(
            &[("a", Some("Projects")), ("b", Some("Projects/Private"))],
            &["Projects/Private"],
        );
        let (resolved, cancel) = block_on(start_run(
            &runs,
            "r".into(),
            &ScopeGrant::Folder("Projects".into()),
            &src,
        ))
        .unwrap();
        assert_eq!(resolved.note_ids.len(), 1);
        assert_eq!(resolved.excluded_count, 1);
        assert_eq!(runs.view("r").unwrap().scope_total, 1);
        runs.cancel("r");
        assert!(
            cancel.load(std::sync::atomic::Ordering::SeqCst),
            "the flag handed back is the run's own"
        );
    }

    #[test]
    fn start_run_refuses_a_root_grant_before_it_reads_anything() {
        let runs = AgentRunState::default();
        let src = Source::new(&[("a", Some("Projects"))], &[]);
        let err = block_on(start_run(
            &runs,
            "r".into(),
            &ScopeGrant::Folder("/".into()),
            &src,
        ))
        .unwrap_err();
        assert!(matches!(err, AgentError::RootGrant));
        assert!(
            src.asked.lock().unwrap().is_empty(),
            "a refused grant reads neither prefs nor the index"
        );
    }

    #[test]
    fn start_run_refuses_a_grant_the_clamp_emptied() {
        let runs = AgentRunState::default();
        let src = Source::new(&[("a", Some("Private"))], &["Private"]);
        let err = block_on(start_run(
            &runs,
            "r".into(),
            &ScopeGrant::Folder("Private".into()),
            &src,
        ))
        .unwrap_err();
        assert!(matches!(err, AgentError::EmptyGrant));
        assert!(runs.is_empty(), "no run is created for an empty grant");
        // The refusal reads the CURRENT exclusions and the index first, then
        // refuses: a clamp decided on stale prefs, or a refusal issued before
        // the read, would both compile. Nothing is sent and no tool runs
        // anywhere on this path (`start_run` has no such call), so the order
        // plus the absent run is the whole "refused before anything is sent"
        // property (myne-md/myne#675).
        assert_eq!(*src.asked.lock().unwrap(), vec!["excluded", "records"]);
    }

    #[test]
    fn expand_run_unions_and_clamps_with_the_newest_exclusions() {
        let runs = AgentRunState::default();
        let src = Source::new(&[("a", Some("Projects"))], &[]);
        block_on(start_run(
            &runs,
            "r".into(),
            &ScopeGrant::Folder("Projects".into()),
            &src,
        ))
        .unwrap();
        // The user excludes Archive while the run is in flight.
        let src2 = Source::new(
            &[("a", Some("Projects")), ("z", Some("Archive"))],
            &["Archive"],
        );
        let resolved = block_on(expand_run(
            &runs,
            "r",
            &ScopeGrant::Folder("Archive".into()),
            GrantOrigin::Model,
            &src2,
        ))
        .unwrap();
        assert!(resolved.note_ids.is_empty());
        assert_eq!(resolved.excluded_count, 1);
        assert_eq!(runs.view("r").unwrap().scope_total, 1, "scope did not grow");
    }

    #[test]
    fn preview_totals_by_union_not_by_sum() {
        let runs = AgentRunState::default();
        let src = Source::new(&[("a", Some("Projects")), ("b", Some("Projects"))], &[]);
        block_on(start_run(
            &runs,
            "r".into(),
            &ScopeGrant::Folder("Projects".into()),
            &src,
        ))
        .unwrap();
        // Previewing the SAME folder must not double the total.
        let (resolved, total) = block_on(preview_grant(
            &runs,
            Some("r"),
            &ScopeGrant::Folder("Projects".into()),
            &src,
        ))
        .unwrap();
        assert_eq!(resolved.note_ids.len(), 2);
        assert_eq!(total, 2, "union, not sum");
    }

    #[test]
    fn preview_commits_nothing() {
        let runs = AgentRunState::default();
        let src = Source::new(&[("a", Some("Projects"))], &[]);
        block_on(start_run(
            &runs,
            "r".into(),
            &ScopeGrant::Notes(vec!["a".into()]),
            &src,
        ))
        .unwrap();
        let before = runs.view("r").unwrap();
        block_on(preview_grant(
            &runs,
            Some("r"),
            &ScopeGrant::Folder("Projects".into()),
            &src,
        ))
        .unwrap();
        assert_eq!(runs.view("r").unwrap(), before, "a preview changes nothing");
    }

    #[test]
    fn folder_matching_is_case_and_diacritic_insensitive_on_both_sides() {
        let idx = index(&[("a", Some("Özel/Alt"))]);
        let r = resolve_grant(&ScopeGrant::Folder("özel".into()), &idx, &[]);
        assert_eq!(r.note_ids, ["a"].iter().map(|s| s.to_string()).collect());
    }

    // ── the working set is the sidebar's ────────────────────────────────────
    //
    // myne-md/myne#848. The index is trash-blind by design (see the module
    // header), so `resolve_grant` is where a hidden note has to leave the run's
    // scope. Injecting the defect this guards against is deleting the two
    // `record.live` checks in `resolve_grant`: the first test below then reports
    // all four notes, and the count goes from the sidebar's 1 to 4.

    /// A note the producer classified as out of the working set.
    fn hidden(folder: Option<&str>) -> NoteRecord {
        NoteRecord {
            live: false,
            ..record(folder)
        }
    }

    #[test]
    fn trashed_deleted_and_template_notes_leave_the_working_set_and_the_count() {
        let idx: BTreeMap<String, NoteRecord> = [
            ("live", record(Some("Projects"))),
            ("trashed", hidden(Some("Projects"))),
            ("deleted", hidden(Some("Projects"))),
            ("template", hidden(Some("Projects"))),
            ("archived", hidden(Some("Projects"))),
            ("conflict", hidden(Some("Projects"))),
        ]
        .into_iter()
        .map(|(id, r)| (id.to_string(), r))
        .collect();

        let r = resolve_grant(&ScopeGrant::Folder("Projects".into()), &idx, &[]);
        assert_eq!(
            r.note_ids,
            ["live"].iter().map(|s| s.to_string()).collect(),
            "only the live note is in the scope"
        );
        assert_eq!(
            r.note_ids.len(),
            1,
            "the count the user sees is the number of notes the sidebar shows"
        );
        // Hidden notes are not the excluded-folder clamp's business: keeping the
        // two counts apart is what lets the approval screen say "3 excluded by
        // your folder setting" without also claiming these six.
        assert_eq!(r.excluded_count, 0);
        assert_eq!(r.unknown_count, 0);
    }

    #[test]
    fn a_note_grant_cannot_reach_a_hidden_note() {
        let idx: BTreeMap<String, NoteRecord> = [
            ("live", record(Some("Public"))),
            ("trashed", hidden(Some("Public"))),
        ]
        .into_iter()
        .map(|(id, r)| (id.to_string(), r))
        .collect();

        let r = resolve_grant(
            &ScopeGrant::Notes(vec!["live".into(), "trashed".into()]),
            &idx,
            &[],
        );
        assert_eq!(r.note_ids, ["live"].iter().map(|s| s.to_string()).collect());
        // Dropped, not reported as unknown: the index knows the note, the
        // working set does not carry it.
        assert_eq!(r.unknown_count, 0);
    }

    #[test]
    fn a_grant_of_only_hidden_notes_resolves_to_nothing_so_start_run_refuses_it() {
        let runs = AgentRunState::default();
        let mut records = index(&[]);
        records.insert("trashed".into(), hidden(Some("Projects")));
        let src = HiddenSource {
            records,
            excluded: Vec::new(),
        };
        let err = block_on(start_run(
            &runs,
            "r".into(),
            &ScopeGrant::Folder("Projects".into()),
            &src,
        ))
        .unwrap_err();
        assert!(matches!(err, AgentError::EmptyGrant));
        assert!(runs.is_empty());
    }

    /// A source whose records are all the test cares about: the working-set
    /// gate is in `resolve_grant`, so this exists only to drive `start_run`
    /// through a real trait impl rather than a hand-built map.
    struct HiddenSource {
        records: BTreeMap<String, NoteRecord>,
        excluded: Vec<String>,
    }

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl ScopeSource for HiddenSource {
        async fn records(&self) -> Result<BTreeMap<String, NoteRecord>, AgentError> {
            Ok(self.records.clone())
        }
        async fn excluded_folders(&self) -> Result<Vec<String>, AgentError> {
            Ok(self.excluded.clone())
        }
    }

    /// The reverse direction, and it is the one that makes the tests above
    /// meaningful rather than lucky: `live: true` must still resolve. A filter
    /// that dropped every record would pass every assertion above and empty
    /// every run in the product.
    #[test]
    fn a_live_note_still_resolves() {
        let idx = index(&[("a", Some("Projects"))]);
        assert!(idx["a"].live, "a default record is live");
        let r = resolve_grant(&ScopeGrant::Folder("Projects".into()), &idx, &[]);
        assert_eq!(r.note_ids, ["a"].iter().map(|s| s.to_string()).collect());
    }
}
