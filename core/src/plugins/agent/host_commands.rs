// SPDX-License-Identifier: AGPL-3.0
//! The host-generic half of the agent command surface (myne-md/myne#456).
//!
//! **Why this is here and the `#[tauri::command]` wrappers are not.** Both Tauri
//! clients drive an agent run through the same sequence: guard the slot, guard
//! the opt-in, resolve the grant, claim the session, drive the loop, write back.
//! They differ in exactly two places: which engine answers, and how a scope is
//! searched: so [`step`] takes those two as trait objects and everything else
//! moved here rather than being copied into the mobile tree. The alternative
//! was roughly eleven hundred lines of duplicated command bodies, which is the
//! shape `scripts/check-twin-drift.mjs` can only warn about.
//!
//! What stays per client is the thin `#[tauri::command]` layer: the `State<'_,
//! …>` list genuinely differs (desktop resolves a vector store, mobile does
//! not), and that layer is the one place a client's own wiring belongs. This is
//! the three-layer command shape `core/AGENTS.md` describes, applied to a plugin
//! that had not adopted it.
//!
//! **The guards are here rather than in the wrappers on purpose.**
//! `require_unlocked` and `require_ai_enabled` are the two host-side checks the
//! whole surface rests on, and a guard that each client re-implements is a guard
//! one client eventually implements differently. The per-command split of which
//! guards apply is documented on the desktop plugin's `mod.rs` and holds for
//! both clients, because both call these.
//!
//! Behind `tauri-ipc`, because everything on this path takes an `AppHandle`.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline".
#![cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]

use crate::host::tauri_host::TauriHost;
use crate::plugins::agent::edit::ProposedEdit;
use crate::plugins::agent::engine::{Content, Message};
use crate::plugins::agent::error::{AgentError, EditRejection};
use crate::plugins::agent::probe::ProbeThreshold;
use crate::plugins::agent::prompt::{Proposal, ProposedNote};
use crate::plugins::agent::run::AppliedSetting;
use crate::plugins::agent::run::{AgentRunState, AgentRunView};
use crate::plugins::agent::run_loop::{drive, LoopDeps, LoopEnd, LoopOutcome, RunProgress};
use crate::plugins::agent::scope::{ExclusionSource, ScopeSource};
use crate::plugins::prefs::commands::prefs_read_from_host;
use crate::plugins::vault_indices::state::NoteRecord;
use crate::plugins::vault_indices::VaultIndicesState;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use crate::vault_io::StdVaultIo;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime};
use zeroize::Zeroize;

use crate::plugins::agent::apply::{
    apply_approved, apply_settings_approved, ApplyOutcome, Approval, PrefWriter, RefusedEdit,
    RefusedSetting, SettingRejection,
};
use crate::plugins::agent::engine::AgentEngine;
use crate::plugins::agent::host_adapters::{NoteReadAdapter, RestoreAdapter, WriteAdapter};
use crate::plugins::agent::prompt::ProposedSetting;
use crate::plugins::agent::run::AppliedRun;
use crate::plugins::agent::setting::{PrefTarget, SettingIntent};
use crate::plugins::agent::tools::ScopeSearcher;
use crate::plugins::snapshots::commands::snapshot_restore_from_host;

/// The probe's pass bar, from the file that records it.
///
/// `include_str!` rather than a literal so there is exactly one place the
/// numbers live, and that place can carry the measurements that produced them.
/// The file currently declares itself unmeasured; see
/// `scripts/agent-probe-threshold.json`.
const PROBE_THRESHOLD_JSON: &str = include_str!("../../../../scripts/agent-probe-threshold.json");

#[derive(serde::Deserialize)]
struct RawThreshold {
    attempts: u8,
    required: u8,
    status: String,
    measurements: Vec<serde_json::Value>,
}

/// The bar a backend must clear, or a stated reason it could not be read.
///
/// **Returns `Result` rather than panicking, and the reason is where this is
/// called from.** [`agent_capability`] is a `#[tauri::command]`, so an
/// `.expect()` or a failed `assert_eq!` in here unwinds across the IPC
/// boundary. Tauri catches that and answers the caller with an opaque
/// serialization failure, which tells the user nothing and, on a panic that
/// happens while a lock is held, poisons it for the rest of the session. The
/// input is compiled in, so today it cannot fail; a panic reachable from IPC is
/// one edit away from being a runtime one, and this shape does not have that
/// edge. Found in review round five of myne-md/myne#531.
///
/// The strictness itself is not relaxed: [`tests::the_compiled_in_threshold_file_is_well_formed`]
/// asserts the real file parses AND that its two halves agree, so a malformed
/// or self-contradicting record is a failing `cargo test` on every platform
/// rather than a surprise at the first press of the button.
pub(crate) fn parse_probe_threshold(json: &str) -> Result<ProbeThreshold, String> {
    let raw: RawThreshold = serde_json::from_str(json)
        .map_err(|_| "agent-probe-threshold.json is malformed".to_string())?;
    // **The `status` field has to mean something, or it is decoration.** It
    // declared itself a blocking obligation and gated nothing: this function
    // read `attempts` and `required` and never looked at it, so flipping it to
    // `measured` with an empty `measurements` would have changed no behaviour
    // and no check.
    let measured = raw.status == "measured";
    let has_measurements = !raw.measurements.is_empty();
    if measured != has_measurements {
        return Err(format!(
            "agent-probe-threshold.json: status is {:?} but measurements has {} entries. \
             The two must agree: `measured` with no measurements is a claim nobody made, \
             and `unmeasured` with measurements is a record that has stopped describing itself.",
            raw.status,
            raw.measurements.len(),
        ));
    }
    Ok(ProbeThreshold {
        attempts: raw.attempts,
        required: raw.required,
        provisional: !measured,
    })
}

/// The threshold the probe runs against.
///
/// Falls back FAIL-CLOSED when the record cannot be read: a bar no backend
/// clears, marked provisional, so agent mode reports itself unavailable rather
/// than available on an unverified backend. The opposite default would let a
/// broken record switch the gate off.
pub fn probe_threshold() -> ProbeThreshold {
    parse_probe_threshold(PROBE_THRESHOLD_JSON).unwrap_or_else(|reason| {
        tracing::error!(event = "agent_probe_threshold_unreadable", %reason);
        ProbeThreshold {
            attempts: 1,
            required: u8::MAX,
            provisional: true,
        }
    })
}

/// Host-side session state for a run: what the user asked, the running
/// transcript, and what has been proposed so far.
#[derive(Default)]
struct Session {
    task: String,
    /// The user's interface language, as the WebView reported it at start.
    ///
    /// Held on the session rather than passed per step, because a run resumed
    /// after a scope approval goes through the same `step` and would otherwise
    /// lose the instruction halfway through: the model would answer the first
    /// half of a run in the user's language and the second half in English.
    /// `prompt::system_instructions` shape-checks it; nothing here trusts it.
    language: Option<String>,
    /// The visible chat history this run was seeded with, already budgeted.
    ///
    /// Held rather than re-derived per step for the reason `language` is: a run
    /// resumed after a scope approval goes through the same `step`, and losing
    /// the seed halfway through would leave the model answering the second half
    /// of a conversation it can no longer see the first half of.
    history: Vec<Message>,
    /// The egress controls the seed was built under, or `None` when the run
    /// was seeded with nothing.
    ///
    /// `step` re-reads the live prefs on every leg and drops `history` when
    /// these no longer match — an exclusion added mid-run, or a provider
    /// changed or cleared while the run waited on a scope approval, stops the
    /// seed without stopping the run (`docs/decisions/ai/0553`, myne-md/myne#648).
    /// A drop rather than a filter, because a turn carries text and no note
    /// provenance. The run's own transcript is deliberately untouched: those
    /// are this run's reads, and the tools clamp them against the live
    /// exclusion set on every call.
    seed_controls: Option<super::history::SeedControls>,
    /// The settings this client offered for this run (myne-md/myne#850).
    ///
    /// **Ids, not labels, and the host resolves them against its own table.**
    /// Held here rather than passed to every `step` for the reason `language`
    /// is: a run resumed after a scope approval re-enters the loop, and a leg
    /// that forgot the catalogue would silently stop being able to offer a
    /// setting halfway through a run.
    ///
    /// Empty is the ordinary state today: a client that has built no catalogue
    /// offers nothing, and every `set_setting` is refused rather than accepted
    /// into a proposal no surface could render.
    offered_settings: Vec<String>,
    /// Which notes this run has already read, across every leg.
    ///
    /// Held here rather than re-created per `step` for the reason the transcript
    /// is held: a run resumed after a scope approval re-enters the loop, and the
    /// transcript comes back with leg one's note bodies still in it. A fresh set
    /// would tell leg two it had read nothing, so the repeat-read pointer
    /// (myne-md/myne#619) would let a re-read through and push a second copy of
    /// a body already sitting above it, which then rides every remaining
    /// iteration up to the 24-iteration ceiling. A multi-leg run has the longest
    /// transcript there is, which is exactly where that costs most.
    read_ids: std::collections::BTreeSet<String>,
    transcript: Vec<Message>,
    proposal: Proposal,
    /// Whether a `step` is inside its model call for this run.
    ///
    /// `step` takes the transcript and the proposal with `mem::take` under a
    /// scoped lock, releases it for the length of a model call, then writes both
    /// back. Two concurrent calls on one run id therefore raced: the second
    /// found the transcript already taken and drove from an empty one, and
    /// whichever returned last overwrote the other's work, silently discarding a
    /// transcript and a proposal. Not reachable from the shipped single-dialog
    /// surface, and `agent_approve_scope` takes its `run_id` from the payload,
    /// so reachability is a property of the caller rather than of this code
    /// (myne-md/myne#531 review round six).
    in_flight: bool,
}

/// The table of live sessions. Cleared by the same lock teardown that clears
/// core's run table.
#[derive(Default)]
pub struct AgentSessionState {
    sessions: Mutex<BTreeMap<String, Session>>,
}

impl AgentSessionState {
    /// Which of the approved EDITS the host recorded the model proposing.
    ///
    /// **The other half of the rule its sibling below states about itself.**
    /// `read_approved_new_notes` resolves new notes by index into the host's own
    /// record, so "the caller cannot invent a note the model never proposed"
    /// holds for creates. The edits arrived as free `note_id`/`anchor`/
    /// `replacement` strings and were never compared to anything, so the same
    /// sentence was true of one half of the apply and false of the other
    /// (myne-md/myne#531 review round six).
    ///
    /// Returns the recognised edits and, separately, the positions of the ones
    /// that were not, so the caller can report them as refusals rather than drop
    /// them silently: a row the user pressed Apply on that quietly does nothing
    /// is the failure mode the whole review surface exists to avoid.
    ///
    /// Compared by VALUE, not by index. The screen may send any subset in any
    /// order, and an index-based contract would mean changing what the WebView
    /// sends, the store, the review screen and its E2E for a property this
    /// buys outright.
    ///
    /// A session that is gone recognises nothing, which fails closed: the run is
    /// over, and an apply against a record the host no longer holds is exactly
    /// the case this refuses.
    pub fn retain_proposed_edits(
        &self,
        run_id: &str,
        approved: &[ProposedEdit],
    ) -> (Vec<ProposedEdit>, Vec<usize>) {
        let table = self.sessions.lock().expect("agent session table poisoned");
        let proposed: &[ProposedEdit] = match table.get(run_id) {
            Some(session) => &session.proposal.edits,
            None => &[],
        };
        let mut kept = Vec::with_capacity(approved.len());
        let mut unknown = Vec::new();
        for (index, edit) in approved.iter().enumerate() {
            if proposed.contains(edit) {
                kept.push(edit.clone());
            } else {
                unknown.push(index);
            }
        }
        (kept, unknown)
    }

    /// The setting changes the user approved, resolved against the run's own
    /// record, keeping each one's position in the list the client sent.
    ///
    /// **The sibling of `retain_proposed_edits`, and its absence was a hole rather
    /// than an omission** (found by the 2026-10-13 review). Both lists on the
    /// settings path come from PAGE context: `agent_start` takes the offered ids
    /// and `agent_apply` takes the approved settings. Without this check a caller
    /// could name any of the twelve intent ids in its own start call and then write
    /// them, which made the offer whatever the caller said it was rather than a
    /// bound. That is what the detached-window arm of `docs/threat-model.md` §7's
    /// first bound had been describing, and why the bullet needed correcting.
    ///
    /// **Compared by value, like the edit half, and the ORIGINAL index rides
    /// along.** The screen sends a subset in its own order, and the refusal indices
    /// the review surface subtracts with address that list, so re-numbering here
    /// would silently mis-mark every row after a dropped one.
    ///
    /// A session that is gone recognises nothing, which fails closed in the same
    /// direction the edit half does: the run is over, and an apply against a record
    /// the host no longer holds is what this refuses.
    pub fn retain_proposed_settings(
        &self,
        run_id: &str,
        approved: &[ProposedSetting],
    ) -> (Vec<(usize, ProposedSetting)>, Vec<usize>) {
        let table = self.sessions.lock().expect("agent session table poisoned");
        let proposed: &[ProposedSetting] = match table.get(run_id) {
            Some(session) => &session.proposal.settings,
            None => &[],
        };
        let mut kept = Vec::with_capacity(approved.len());
        let mut unknown = Vec::new();
        for (index, setting) in approved.iter().enumerate() {
            if proposed.contains(setting) {
                kept.push((index, setting.clone()));
            } else {
                unknown.push(index);
            }
        }
        (kept, unknown)
    }

    /// The new notes the user approved, resolved against the run's own record.
    ///
    /// Two separate properties, and an earlier version conflated them. **Which
    /// notes exist** is host-side: the caller names indices into the proposal the
    /// host itself recorded, so it cannot invent a note the model never proposed.
    /// **Which of those to create** is the user's, expressed as that index list,
    /// because a create is a write and SYNC-17's restatement says no write
    /// happens without a per-note approval. Handing the whole recorded list to
    /// the apply satisfied the first and skipped the second.
    ///
    /// Out-of-range indices are dropped rather than erroring: they can only come
    /// from a stale screen, and refusing the whole apply over one is worse than
    /// applying the rest.
    ///
    /// **Reads without consuming.** The consuming version of this ran BEFORE
    /// `apply_approved`, which can still fail from three places (an out-of-scope
    /// run, a refused restore point, a failed batch write), and on any of them
    /// the notes were gone from the record and had never been created. The
    /// screen went on rendering them, so a retry sent the same indices, found a
    /// shorter list, and silently created nothing: a write the user approved
    /// that does not happen, reported only as the original failure. `apply.rs`
    /// took care not to let a failed create discard the outcome; this was the
    /// mirror hole one layer up.
    ///
    /// Consumption is now keyed off what was ACTUALLY created, by
    /// [`Self::consume_created_new_notes`], so the two cannot disagree.
    pub fn read_approved_new_notes(
        &self,
        run_id: &str,
        approved: &[usize],
    ) -> Vec<(usize, ProposedNote)> {
        let table = self.sessions.lock().expect("agent session table poisoned");
        let Some(session) = table.get(run_id) else {
            return Vec::new();
        };
        let mut wanted: Vec<usize> = approved.to_vec();
        wanted.sort_unstable();
        wanted.dedup();
        wanted
            .into_iter()
            .filter_map(|index| {
                session
                    .proposal
                    .new_notes
                    .get(index)
                    .map(|note| (index, note.clone()))
            })
            .collect()
    }

    /// Drop the notes an apply actually created, so a retry cannot create them
    /// twice and a FAILED apply leaves everything retryable.
    ///
    /// Takes the indices the apply reported as created rather than the ones it
    /// was asked to create, which is the whole point: those two lists differ
    /// exactly when something went wrong, and that is the case the previous
    /// design got backwards.
    pub fn consume_created_new_notes(&self, run_id: &str, created: &[usize]) {
        let mut table = self.sessions.lock().expect("agent session table poisoned");
        let Some(session) = table.get_mut(run_id) else {
            return;
        };
        let mut wanted: Vec<usize> = created.to_vec();
        wanted.sort_unstable();
        wanted.dedup();
        // Highest index first so each removal leaves the lower ones in place.
        for index in wanted.iter().rev() {
            if *index < session.proposal.new_notes.len() {
                let mut note = session.proposal.new_notes.remove(*index);
                // The body came out of the model and quotes note text; overwrite
                // rather than free, on the same rule as the teardown below.
                note.title.zeroize();
                note.body.zeroize();
                // And the folder, for the reason the teardown below already
                // states about itself: it is `Option<String>` rather than
                // `String`, so it is not the shape the eye checks for, and it
                // was missed here for exactly that reason a second time
                // (myne-md/myne#531 review round six). `ProposedNote` derives no
                // `ZeroizeOnDrop`, so nothing catches it if this line goes.
                if let Some(folder) = note.folder.as_mut() {
                    folder.zeroize();
                }
            }
        }
    }

    /// Wipe and drop every session. The vault-lock teardown path.
    ///
    /// **Overwrites before dropping**, which is the difference between this and
    /// a plain `clear()`. A transcript holds whole note bodies and a proposal
    /// holds the anchors copied out of them; dropping frees that memory without
    /// touching it, and `threat-model.md` §7 requires the AI path's RAM to be
    /// `Zeroizing`-scoped. The sibling teardown this rides alongside (the AI
    /// vector store) overwrites in place for the same reason.
    pub fn clear(&self) {
        let mut table = self.sessions.lock().expect("agent session table poisoned");
        for session in table.values_mut() {
            wipe_session(session);
        }
        table.clear();
    }

    /// Open a session for a run that has just started, evicting anything the
    /// run table dropped to make room for it.
    ///
    /// **One call rather than a prune plus an insert at each client**, because
    /// the ORDER is the load-bearing part and it is not obvious. `AgentRunState`
    /// caps at `MAX_LIVE_RUNS` and drops the oldest run to make room, so the
    /// prune has to happen AFTER the start: the only moment a run can be
    /// evicted: and it asks core what is still live rather than being told what
    /// went. Before myne-md/myne#531's review nothing removed an evicted run's
    /// session, so its task, its transcript of whole note bodies and its
    /// proposal of verbatim anchors stayed resident until the vault locked.
    ///
    /// A client that wrote these two steps itself would be a client that could
    /// get the order wrong, and the failure is silent: everything works, and
    /// note plaintext outlives the run that read it.
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &self,
        run_id: &str,
        task: String,
        live_ids: &BTreeSet<String>,
        language: Option<String>,
        history: Vec<Message>,
        seed_controls: Option<super::history::SeedControls>,
        offered_settings: Vec<String>,
    ) {
        self.prune_to(live_ids);
        self.sessions
            .lock()
            .expect("agent session table poisoned")
            .insert(
                run_id.to_string(),
                Session {
                    task,
                    language,
                    history,
                    seed_controls,
                    offered_settings,
                    ..Default::default()
                },
            );
    }

    /// Drop every session whose run the core table no longer holds, wiping it
    /// first.
    ///
    /// **The bound this table was missing.** `AgentRunState` caps at
    /// `MAX_LIVE_RUNS` and evicts the oldest, and nothing removed the evicted
    /// run's SESSION: after nine ordinary runs, run one's task string, its
    /// transcript of whole note bodies and its proposal of anchors copied
    /// verbatim out of them stayed resident and unreachable until the vault
    /// locked. The cap bounded a set of note ids and left the plaintext holder
    /// unbounded (myne-md/myne#531 review round six).
    ///
    /// It could not be fixed where the eviction is: that lives in `myne-core`
    /// and this table lives in the desktop crate, which is why core grew
    /// `live_ids()` and this prunes to it rather than being told what was
    /// dropped. Called at the start of a run, which is the only moment a run can
    /// be evicted.
    ///
    /// Wipes through the same `wipe_session` the lock teardown uses, so the two
    /// cannot report different notions of "gone".
    pub fn prune_to(&self, live: &std::collections::BTreeSet<String>) {
        let mut table = self.sessions.lock().expect("agent session table poisoned");
        let dead: Vec<String> = table
            .keys()
            .filter(|id| !live.contains(*id))
            .cloned()
            .collect();
        for id in dead {
            if let Some(mut session) = table.remove(&id) {
                wipe_session(&mut session);
            }
        }
    }

    /// How many sessions are live.
    ///
    /// Exists for the teardown assertion and nothing else: the test that proves
    /// a lock leaves no transcript behind has to read the state rather than a
    /// return value, because `clear` could report success while a session sat in
    /// the table. `allow(dead_code)` because production has no reason to count
    /// them, and removing them would remove the only way to check the claim.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.sessions
            .lock()
            .expect("agent session table poisoned")
            .len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Fold one leg's proposal into the run's accumulated one.
///
/// **A destructure rather than a field-by-field merge, and this function exists
/// because the merge was field-by-field** (myne-md/myne#850). It copied `edits`,
/// `new_notes` and `summary`, and `settings` was not among them, so every
/// setting a run proposed was dropped between the loop's own proposal and the
/// one the client receives. What that cost is worth stating, because nothing
/// anywhere reported it: a settings-only run arrived at the review screen as an
/// EMPTY proposal, that screen's gate is "the run stopped and has something to
/// show", so it never opened at all. Every gate upstream stayed green, no
/// refusal was raised (the host had accepted the change), and the loop's own
/// tests assert `outcome.proposal`, one layer BELOW this one, which is exactly
/// why they passed. It was found by asking the host, through the stub, what
/// request it had been given, and by then reading the one function between the
/// loop and the wire.
///
/// The `let Proposal { .. }` is the fix for the CLASS rather than the instance:
/// a field added to `Proposal` is now a compile error here rather than a silent
/// drop, which is the same lock the sync classification table uses.
fn accumulate_proposal(into: &mut Proposal, from: Proposal) {
    let Proposal {
        edits,
        new_notes,
        settings,
        summary,
    } = from;
    into.edits.extend(edits);
    into.new_notes.extend(new_notes);
    into.settings.extend(settings);
    // An empty summary leaves the earlier one in place: a leg that finished
    // without saying anything must not blank what a previous leg said.
    if !summary.is_empty() {
        into.summary = summary;
    }
}

/// Overwrite everything a session holds, before it is dropped.
///
/// **Overwrites before dropping**, which is the difference between this and a
/// plain `clear()`. A transcript holds whole note bodies and a proposal holds
/// the anchors copied out of them; dropping frees that memory without touching
/// it, and `threat-model.md` §7 requires the AI path's RAM to be
/// `Zeroizing`-scoped. One function rather than two copies, so the lock teardown
/// and the eviction prune cannot drift into different notions of total.
fn wipe_session(session: &mut Session) {
    session.task.zeroize();
    // Overwrite before dropping, and cover BOTH arms so the teardown
    // is total by construction rather than by whichever arm currently
    // holds the sensitive half. `UntrustedNote` wipes through
    // `Zeroizing` on drop; `Trusted` is a plain `String` with no such
    // drop, so a bare `.clear()` freed it untouched.
    //
    // What each arm holds today, since that is what a later reader
    // would use to decide whether this loop can go: the model's reply
    // is `Content::note` (`run_loop::drive`, tagged untrusted in this
    // same change because an anchor is note text copied verbatim), and
    // the `Trusted` spans are the host's own refusal prose. The point
    // is that the answer moves, and a teardown keyed to today's answer
    // is one tagging change away from being partial again.
    for message in &mut session.transcript {
        for span in &mut message.content {
            if let Content::Trusted(t) = span {
                t.zeroize();
            }
        }
    }
    session.transcript.clear();
    // **The whole proposal, destructured rather than enumerated.** This was
    // three hand-written lists until myne-md/myne#850, which is why it missed
    // `settings`: the `note.folder` arm below records that the same shape was
    // already caught once before, for the same reason, and the merge beside
    // `accumulate_proposal` dropped `settings` in the same change for the same
    // reason again. The destructure makes a new `Proposal` field a compile
    // error here instead of a silent omission from either half.
    let Proposal {
        edits,
        new_notes,
        settings,
        summary,
    } = &mut session.proposal;
    for edit in edits.iter_mut() {
        edit.anchor.zeroize();
        edit.replacement.zeroize();
    }
    for note in new_notes.iter_mut() {
        note.title.zeroize();
        note.body.zeroize();
        // The folder too. It is `Option<String>` rather than `String`,
        // which is the whole reason it was missed: the two lines above
        // are the shape the eye checks for. A proposed folder is a
        // vault-structure string the model produced from note content,
        // so it belongs with them.
        if let Some(folder) = note.folder.as_mut() {
            folder.zeroize();
        }
    }
    // A proposed setting is the same class of string: a folder name or a date
    // format the model wrote, held in the same proposal. Both its fields are
    // `Option<String>`, so both take the two lines the `folder` arm above
    // needs.
    for setting in settings.iter_mut() {
        if let Some(value) = setting.value.as_mut() {
            value.zeroize();
        }
        if let Some(folder) = setting.folder.as_mut() {
            folder.zeroize();
        }
    }
    summary.zeroize();
}

/// What a grant would resolve to. Every number here is the host's.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantPreview {
    /// How many notes the grant would add, already clamped.
    pub note_count: usize,
    /// How many the `ai_excluded_folders` clamp removed.
    pub excluded_count: usize,
    /// How many named ids the index does not know. Non-zero only for a note
    /// list; they fail closed and are dropped.
    pub unknown_count: usize,
    /// What the run's total scope would become. A union, not a sum.
    pub new_total: usize,
}

/// What a start or a resume produced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStepResult {
    /// The run.
    pub view: AgentRunView,
    /// Everything proposed so far.
    pub proposal: Proposal,
    /// Why the loop stopped.
    pub end: LoopEnd,
    /// How many model round-trips THIS STEP made.
    ///
    /// Per-step rather than per-run, like `chars_off_device` three lines down and
    /// for the same reason: `drive()` starts its counter at zero on every call,
    /// and the surface accumulates. The comment used to say "in total", which is
    /// a different contract than the value carries; nothing user-visible was
    /// wrong (`src/notes/agent/agentStore.ts` accumulates correctly), but a later
    /// reader hanging a cap or a warning off this field would have read it as a
    /// run total.
    pub iterations: usize,
    /// How many notes it has read in full.
    pub notes_read: usize,
    /// Characters that left the device for this step's requests, or `None` when
    /// none did.
    ///
    /// Per-step rather than per-run, because the surface accumulates it exactly
    /// as it accumulates `iterations` and `notes_read`. `None` and `Some(0)`
    /// stay distinguishable across IPC for the reason
    /// [`crate::plugins::agent::engine::AgentCompletion::chars_off_device`]
    /// gives.
    pub chars_off_device: Option<usize>,
    /// How many notes the `ai_excluded_folders` clamp removed from the grant
    /// that produced this step. Shown on the approval screen.
    pub excluded_count: usize,
    /// How many memory entries this step wrote (0 or 1). Feeds the turn-end
    /// marker the chat renders (myne-md/myne#697): a run that wrote memory
    /// says so on its turn.
    pub memory_updated: usize,
}

/// Refuse unless AI is switched on, read from the vault's own prefs.
///
/// The WebView hiding the tab is not a gate: `src-tauri/AGENTS.md` treats the
/// ACL surface as reachable by a compromised or dev-tools-driven page (TB6), and
/// every sibling generation surface re-reads this host-side before touching a
/// model. Without it, agent mode is the one AI surface whose opt-in lives only
/// in the page that the opt-in is supposed to constrain.
pub async fn require_ai_enabled<R: Runtime>(
    app: &AppHandle<R>,
    vault: &VaultRuntimeState,
) -> Result<(), AgentError> {
    let host = TauriHost::new(app.clone());
    let view = prefs_read_from_host(&host, vault, &StdVaultIo)
        .await
        .map_err(|_| AgentError::ReadFailed)?;
    if view.ai_enabled {
        Ok(())
    } else {
        Err(AgentError::AiDisabled)
    }
}

/// Refuse unless the vault is unlocked.
///
/// **Seven of the eight commands call this FIRST**, and the eighth is
/// `agent_cancel`. Borrowing `State<'_, VaultRuntimeState>` does not gate
/// anything, so without this the locked-vault refusal was an accident of which
/// helper ran first and reported the wrong cause.
///
/// `agent_cancel` deliberately does not call it: it touches only the run table,
/// and a run that survived into a locked vault is a bug the teardown covers,
/// not something to refuse here. (This doc said "the five commands" and named
/// `agent_status` as the second abstainer; that command was removed in review
/// round two and the count was never true: `mod.rs` has the roster. Found in
/// review round five of myne-md/myne#531.)
pub async fn require_unlocked(vault: &VaultRuntimeState) -> Result<(), AgentError> {
    match vault.slot_kind_active().await {
        SlotKind::Unlocked => Ok(()),
        _ => Err(AgentError::SlotNotUnlocked),
    }
}

/// A Tauri host's answer to core's scope questions.
///
/// One implementation for all three entry points. Core owns the ORDER (refuse a
/// root grant, read the exclusions, snapshot the index, resolve, refuse an empty
/// result); this only says where the two inputs come from. That split is what
/// lets the mobile port supply an implementation rather than re-derive a
/// sequence, and it is why a client cannot supply an index snapshot without also
/// supplying the exclusions.
pub struct HostScopeSource<'a, R: Runtime> {
    pub app: AppHandle<R>,
    pub vault: &'a VaultRuntimeState,
    pub indices: &'a VaultIndicesState,
}

#[async_trait::async_trait]
impl<R: Runtime> ScopeSource for HostScopeSource<'_, R> {
    async fn records(&self) -> Result<BTreeMap<String, NoteRecord>, AgentError> {
        Ok(self.indices.snapshot())
    }

    async fn excluded_folders(&self) -> Result<Vec<String>, AgentError> {
        read_excluded(&self.app, self.vault).await
    }
}

/// The `ai_excluded_folders` set, from `vault.prefs`, at this moment.
///
/// One reader for both seams. `ScopeSource` uses it when a grant is resolved and
/// `ExclusionSource` uses it on every read tool inside the loop, and a second copy
/// of this three-line body is how the two would eventually disagree about where
/// the set comes from.
pub async fn read_excluded<R: Runtime>(
    app: &AppHandle<R>,
    vault: &VaultRuntimeState,
) -> Result<Vec<String>, AgentError> {
    let host = TauriHost::new(app.clone());
    let view = prefs_read_from_host(&host, vault, &StdVaultIo)
        .await
        .map_err(|_| AgentError::ReadFailed)?;
    Ok(view.ai_excluded_folders)
}

/// The loop's half of the seam: the exclusion set and nothing else.
///
/// Deliberately NOT `HostScopeSource`, which also answers `records()`. The
/// loop must not re-read the index (`LoopDeps::records` says why), so it is handed
/// a source that cannot.
pub struct HostExclusions<'a, R: Runtime> {
    pub app: AppHandle<R>,
    pub vault: &'a VaultRuntimeState,
}

#[async_trait::async_trait]
impl<R: Runtime> ExclusionSource for HostExclusions<'_, R> {
    async fn excluded_now(&self) -> Result<Vec<String>, AgentError> {
        read_excluded(&self.app, self.vault).await
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn step<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    runs: Arc<AgentRunState>,
    sessions: &AgentSessionState,
    indices: &VaultIndicesState,
    vault: &VaultRuntimeState,
    // **The two seams a client supplies for itself** (myne-md/myne#456).
    //
    // Everything else on this path is identical between the Tauri clients, and
    // these two are not. The engine is built from each client's own inference
    // state, and the searcher genuinely differs: desktop queries an embedding
    // index, mobile has no vector store and answers from the full-text index
    // instead. Taken as trait objects rather than as concrete states, which is
    // what let this whole function move here rather than be copied.
    engine: &dyn AgentEngine,
    searcher: &dyn ScopeSearcher,
    // **The third seam a client supplies for itself** (myne-md/myne#697):
    // the run's memory store. `None` when the surface is unavailable (no
    // `ai_enabled` on this device): the verb then answers with a
    // model-readable refusal instead of failing the run. Taken as a trait
    // object like the engine and the searcher above.
    memory: Option<&dyn crate::plugins::agent::memory::MemoryStore>,
    _cancel: Arc<AtomicBool>,
    excluded_count: usize,
    on_progress: Channel<RunProgress>,
) -> Result<AgentStepResult, AgentError> {
    // Claimed under the SAME lock the take happens under, so there is no window
    // between deciding to proceed and emptying the session. Released in the
    // write-back below, on every exit from this function.
    let (
        task,
        language,
        mut history,
        mut read_ids,
        mut transcript,
        mut proposal,
        seed_controls,
        offered_settings,
    ) = {
        let mut table = sessions
            .sessions
            .lock()
            .expect("agent session table poisoned");
        let s = table.get_mut(&run_id).ok_or(AgentError::NoSuchRun)?;
        if s.in_flight {
            return Err(AgentError::StepAlreadyRunning);
        }
        s.in_flight = true;
        (
            s.task.clone(),
            s.language.clone(),
            s.history.clone(),
            std::mem::take(&mut s.read_ids),
            std::mem::take(&mut s.transcript),
            std::mem::take(&mut s.proposal),
            s.seed_controls.clone(),
            s.offered_settings.clone(),
        )
    };

    // **The resume-path half of the seed bound** (`docs/decisions/ai/0553`,
    // myne-md/myne#648). The seed was built under snapshotted egress controls;
    // a run paused for a scope approval is a user-length window in which the
    // exclusion set or the provider can move, so every leg re-reads the live
    // prefs and drops the seed on a mismatch. A drop, not a filter, and the
    // run continues unseeded rather than refusing: the gate already passed,
    // and only the seed's bounds are unverifiable, not the run's.
    let seed_dropped = match seed_controls {
        None => false,
        Some(stored) => {
            let live = prefs_read_from_host(&TauriHost::new(app.clone()), vault, &StdVaultIo).await;
            let survives = live.map(|view| stored.survives(&view)).unwrap_or(false);
            if !survives {
                history = Vec::new();
            }
            !survives
        }
    };

    let reader = NoteReadAdapter {
        host: TauriHost::new(app.clone()),
        state: vault,
    };
    let records = indices.snapshot();
    let exclusions = HostExclusions {
        app: app.clone(),
        vault,
    };
    // **The cost reaches the surface WHILE the run works** (myne-md/myne#456).
    //
    // `drive` returns only when the loop has stopped, which on a remote provider
    // is minutes, so everything this command returns is disclosure after the
    // fact. `docs/decisions/ai/0515` rests the remote arm's lack of a volume
    // bound on that disclosure, and a run that is cancelled, or that dies with
    // the foreground on a phone, which myne-md/myne#456 makes an ordinary case
    // rather than an exotic one, discloses nothing at all while having paid for
    // every round-trip it made.
    //
    // A `Channel` for the same reason `on_open` is one: an event would be
    // broadcast to every window and would need a run id to filter on, while a
    // channel is already addressed to the caller that opened it.
    //
    // The send result is DROPPED on purpose. A closed channel means the surface
    // that asked has gone, the vault locked, the user started a new
    // conversation: and a disclosure control that could stall or fail a run
    // would be taking the product down with it. The run is what matters; the
    // report is best-effort by design, and the final figures still arrive in
    // this command's return value.
    let report = move |p: RunProgress| {
        let _ = on_progress.send(p);
    };
    let deps = LoopDeps {
        // **The client's own catalogue, resolved by the loop against this
        // crate's intent table** (myne-md/myne#850). A client that has built
        // none sends an empty list, and every `set_setting` is refused rather
        // than accepted into a proposal no surface can render. `offered_ids`
        // maps each id through `setting::writable` before it can reach the
        // system message, so a client string is never rendered.
        offered_settings: &offered_settings,
        engine,
        reader: &reader,
        searcher,
        records: &records,
        exclusions: &exclusions,
        memory,
        language: language.as_deref(),
        history: &history,
        on_progress: &report,
    };

    // **Not `?`.** The transcript and the proposal were taken out of the session
    // above, so propagating here drops both while the run stays in the table.
    // The engine adapter returns `Cancelled` when the run's flag is set
    // before or after the model call, so pressing Stop during generation, which
    // is the long part of an iteration and therefore the usual moment, threw
    // away everything the run had proposed. The loop's OWN cancel checks
    // deliberately return `Ok(LoopEnd::Cancelled)` with the proposal intact, and
    // the surface has a `cancelled` status for exactly that: the two routes
    // disagreed and the reachable one was the lossy one. Any transient engine
    // error had the same effect on a paused-for-scope run, whose resume depends
    // on the transcript that vanished.
    let driven = drive(&runs, &run_id, &task, &mut transcript, &deps, &mut read_ids).await;
    let outcome: LoopOutcome = match driven {
        Ok(o) => o,
        Err(e) => {
            // Put back what was taken, so the next step or the review screen
            // still sees the work. Best-effort by construction: if the session
            // is gone the run is over and there is nothing to preserve.
            let mut table = sessions
                .sessions
                .lock()
                .expect("agent session table poisoned");
            if let Some(s) = table.get_mut(&run_id) {
                s.transcript = transcript;
                s.proposal = proposal;
                // A dropped seed stays dropped: later legs must not resurrect
                // what this leg's control comparison refused.
                if seed_dropped {
                    s.history = Vec::new();
                    s.seed_controls = None;
                }
                // **And the flag, on the FAILURE path too.** Releasing only on
                // success is how an in-flight marker turns one failed model call
                // into a permanently wedged run: the flag stays set, every later
                // step reports `StepAlreadyRunning`, and nothing clears it short
                // of a vault lock. Both exits from this function release it, and
                // there is no `?` between the claim and either of them.
                s.in_flight = false;
            }
            // The one place a step's failure is visible at all
            // (myne-md/myne#546). The surface renders "The agent could not
            // start", which names no cause, and until this line the host left
            // no trace of one either: a start that failed on a debug build with
            // logging on produced zero output. `kind()` rather than the error,
            // because two variants carry a note id.
            tracing::debug!(
                target: "myne::agent",
                event = "step_failed",
                error_kind = e.kind(),
            );
            return Err(e);
        }
    };

    // Accumulate across resumes: a run that paused for a scope approval and
    // resumed has one proposal, not two.
    accumulate_proposal(&mut proposal, outcome.proposal);

    {
        let mut table = sessions
            .sessions
            .lock()
            .expect("agent session table poisoned");
        if let Some(s) = table.get_mut(&run_id) {
            s.transcript = transcript;
            s.proposal = proposal.clone();
            s.in_flight = false;
            if seed_dropped {
                s.history = Vec::new();
                s.seed_controls = None;
            }
        }
    }

    // A cancel the loop has now observed is terminal, so the run and its session
    // go together. Not done in `agent_cancel`: that only sets the flag, and
    // removing the run there would race the in-flight loop into `NoSuchRun`
    // instead of the `Cancelled` end it is written to return. A `Finished` run
    // deliberately stays (the apply reads its frozen scope); see
    // `AgentRunState::end`.
    let cancelled = matches!(outcome.end, LoopEnd::Cancelled);
    let view = runs.view(&run_id)?;
    if cancelled {
        runs.end(&run_id);
        sessions
            .sessions
            .lock()
            .expect("agent session table poisoned")
            .remove(&run_id);
    }

    Ok(AgentStepResult {
        view,
        proposal,
        end: outcome.end,
        iterations: outcome.iterations,
        notes_read: outcome.notes_read,
        chars_off_device: outcome.chars_off_device,
        excluded_count,
        memory_updated: outcome.memory_writes,
    })
}

/// Writes a setting through the prefs plugin, and reads the value it replaced
/// (myne-md/myne#850).
///
/// **The read happens immediately before the write, in this one adapter, and
/// that ordering is the guarantee rather than an atomicity claim.** The comment
/// here used to say the pair "is as atomic as the prefs update path makes it",
/// which is not true and was worth correcting rather than keeping: the read takes
/// the prefs lock, releases it, and the write takes it again, with awaits either
/// side, so a concurrent writer in that window (a sync merge landing on
/// `vault.prefs`, the settings panel, another window) makes the recorded value
/// one the write did not replace. What that costs is bounded and stated: the undo
/// would then restore that value, which is the same last-writer-wins behaviour
/// every other prefs write has, and the alternative is worse. Closing the window
/// entirely means returning the old value from inside the mutation closure, the
/// `set_deliberate_folders` cell pattern, which needs each of the seven setters
/// to hand a value back rather than one dispatch over the target enum. That is
/// the follow-up this comment names and does not pretend to have taken.
///
/// It goes through the plugin's own setters rather than writing `vault.prefs`
/// directly, so the nonce bump every other `usePrefs` reader listens for comes
/// for free: skipping that is how the open editor keeps showing the old value
/// for the rest of the session.
struct PrefWriteAdapter<'a, R: Runtime> {
    app: AppHandle<R>,
    vault: &'a VaultRuntimeState,
    hooks: &'a crate::hooks::Hooks,
}

/// The value a target holds now, or `None` when it is unset.
fn read_target(view: &protocol::PrefsView, target: &PrefTarget) -> Option<String> {
    match target {
        PrefTarget::PeriodicNote { period, setting } => view
            .periodic_notes
            .get(&format!("{period}.{setting}"))
            .cloned(),
        PrefTarget::DailyFolder => view.daily_folder.clone(),
        PrefTarget::DailyTemplate => view.daily_template.clone(),
        PrefTarget::DailyDateFormat => view.daily_date_format.clone(),
        PrefTarget::DateFormat => view.date_format.clone(),
        PrefTarget::TimeFormat => view.time_format.clone(),
        PrefTarget::NewNoteLocation => view.new_note_location.clone(),
    }
}

/// The FOLDER a target holds now, for the one target that has two fields.
///
/// **Split from `read_target` rather than folded into a pair, because only one
/// arm has an answer.** `NewNoteLocation` is one setting over two pref fields (a
/// mode and the folder that mode uses), so an undo that restores its mode without
/// its folder writes a value the user never had; every other target takes no
/// folder at all, which is what makes `None` here mean "nothing to restore"
/// rather than "the read failed". The two sides are used together in
/// `write_setting` and in the undo, so a new two-field target has one place to
/// join them.
fn read_target_folder(view: &protocol::PrefsView, target: &PrefTarget) -> Option<String> {
    match target {
        PrefTarget::NewNoteLocation => view.new_note_location_folder.clone(),
        PrefTarget::PeriodicNote { .. }
        | PrefTarget::DailyFolder
        | PrefTarget::DailyTemplate
        | PrefTarget::DailyDateFormat
        | PrefTarget::DateFormat
        | PrefTarget::TimeFormat => None,
    }
}

/// Write one intent target through the prefs plugin (myne-md/myne#850).
///
/// **One dispatch for the apply and the undo.** The alternative is two matches
/// over the same enum, and the failure that produces is a target one path writes
/// and the other silently does not: the undo would report a setting put back
/// while the value never moved.
///
/// **Its match is EXHAUSTIVE over `PrefTarget`, and that is why the enum has one
/// variant per write OPERATION rather than per field name.** A new intent whose
/// target nobody implemented then fails to compile, instead of falling through a
/// string comparison to a runtime refusal that reads like a model error.
///
/// `folder` is the sub-step half of a `ModeWithFolder` setting. Every other
/// target ignores it, which is safe because `validate` has already refused a
/// folder that arrived for one of those.
async fn write_target<R: Runtime>(
    host: &TauriHost<R>,
    vault: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    target: &PrefTarget,
    value: Option<String>,
    folder: Option<String>,
) -> Result<(), AgentError> {
    let written = match target {
        PrefTarget::PeriodicNote { period, setting } => {
            crate::plugins::prefs::commands::set_periodic_note_setting_from_host(
                host,
                vault,
                hooks,
                (*period).to_string(),
                (*setting).to_string(),
                value,
                &StdVaultIo,
            )
            .await
        }
        PrefTarget::DailyFolder => match value {
            // **The two targets whose setter takes a REQUIRED value, so a
            // `None` is the undo of a setting that was unset before the run.**
            // It is expressed as a CLEAR through the prefs plugin's own clear
            // function (myne-md/myne#850) rather than refused: refusing it is
            // what made "set the daily folder for the first time" unrestorable,
            // which was the ordinary case for two of the twelve intents, and it
            // failed permanently because a failure re-records the same setting.
            // Storing an empty string instead is the alternative the whole clear
            // verb exists to avoid.
            None => {
                return crate::plugins::prefs::commands::clear_daily_folder_from_host(
                    host,
                    vault,
                    hooks,
                    &StdVaultIo,
                )
                .await
                .map_err(|_| AgentError::WriteFailed)
            }
            Some(v) => {
                crate::plugins::prefs::commands::set_daily_folder_from_host(
                    host,
                    vault,
                    hooks,
                    v,
                    &StdVaultIo,
                )
                .await
            }
        },
        PrefTarget::DailyTemplate => {
            crate::plugins::prefs::commands::set_daily_template_from_host(
                host,
                vault,
                hooks,
                value,
                &StdVaultIo,
            )
            .await
        }
        PrefTarget::DailyDateFormat => match value {
            None => {
                return crate::plugins::prefs::commands::clear_daily_date_format_from_host(
                    host,
                    vault,
                    hooks,
                    &StdVaultIo,
                )
                .await
                .map_err(|_| AgentError::WriteFailed)
            }
            Some(v) => {
                crate::plugins::prefs::commands::set_daily_date_format_from_host(
                    host,
                    vault,
                    hooks,
                    v,
                    &StdVaultIo,
                )
                .await
            }
        },
        PrefTarget::DateFormat => {
            crate::plugins::prefs::commands::set_date_format_from_host(
                host,
                vault,
                hooks,
                value,
                &StdVaultIo,
            )
            .await
        }
        PrefTarget::TimeFormat => {
            crate::plugins::prefs::commands::set_time_format_from_host(
                host,
                vault,
                hooks,
                value,
                &StdVaultIo,
            )
            .await
        }
        PrefTarget::NewNoteLocation => {
            // The mode and its folder go together, which is the whole reason
            // this target is one variant rather than two settings (MYND-462).
            crate::plugins::prefs::commands::set_new_note_location_from_host(
                host,
                vault,
                hooks,
                value,
                folder,
                &StdVaultIo,
            )
            .await
        }
    };
    written.map_err(|_| AgentError::WriteFailed)
}

#[async_trait::async_trait]
impl<R: Runtime> PrefWriter for PrefWriteAdapter<'_, R> {
    async fn write_setting(
        &self,
        intent: &SettingIntent,
        value: Option<&str>,
        folder: Option<&str>,
    ) -> Result<(Option<String>, Option<String>), AgentError> {
        let host = TauriHost::new(self.app.clone());
        // Read BEFORE the write, from the view the setter is about to rewrite, and
        // **refuse on a DEGRADED read** (2026-10-13 review). § 9.5.5 answers a
        // corrupt or undecodable `vault.prefs` with defaults, so the plain read
        // cannot tell "the user never set this" from "I could not read what they
        // set", and here the difference is a WRITE: `None` is recorded as the
        // previous value and the undo restores it by clearing the setting. A
        // degraded read refuses this one setting instead, leaving it retryable and
        // recording nothing. `Absent` is a real answer and proceeds, because a vault
        // that has never written prefs genuinely holds no value for this setting.
        let (view, origin) =
            crate::plugins::prefs::commands::prefs_read_from_host_reporting_origin(
                &host,
                self.vault,
                &StdVaultIo,
            )
            .await
            .map_err(|_| AgentError::WriteFailed)?;
        if origin == crate::plugins::prefs::commands::PrefsOrigin::Degraded {
            return Err(AgentError::WriteFailed);
        }
        let previous = read_target(&view, &intent.target);
        let previous_folder = read_target_folder(&view, &intent.target);
        write_target(
            &host,
            self.vault,
            self.hooks,
            &intent.target,
            value.map(str::to_string),
            folder.map(str::to_string),
        )
        .await?;
        Ok((previous, previous_folder))
    }

    /// The ensure step, through the prefs plugin's own named seam.
    ///
    /// **Not the setter's registration.** The setter's is the user-act route and
    /// wins over a removal; this one is a repair, and it reports `false` when the
    /// folder is on record as removed so the apply can refuse the setting rather
    /// than write one whose effect is missing (myne-md/myne#850 task 3).
    async fn ensure_folder(&self, folder: &str) -> Result<bool, AgentError> {
        crate::plugins::prefs::commands::ensure_deliberate_folder_from_host(
            &TauriHost::new(self.app.clone()),
            self.vault,
            self.hooks,
            folder.to_string(),
            &StdVaultIo,
        )
        .await
        .map_err(|_| AgentError::WriteFailed)
    }
}

/// Apply the edits the user approved, and record the run so it can be undone.
///
/// **Here rather than once per client, and the retype is what argued for it.**
/// Both clients had this body verbatim: the same `HostScopeSource`, the same
/// read-not-take of the approved new notes, the same three adapters, the same
/// `not_proposed` reporting loop, the same record guard. Nothing in it is
/// host-specific once the `State` handles have been unwrapped, and this is the
/// path that WRITES NOTE BODIES, so a second copy is a second place for a rule
/// about writing to drift.
///
/// The caller keeps the `#[tauri::command]` and the `State` list; everything
/// below the unwrapping is here.
#[allow(clippy::too_many_arguments)]
pub async fn apply_from_host<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    approved: Vec<ProposedEdit>,
    approved_new_notes: Vec<usize>,
    // The setting changes the user approved (myne-md/myne#850). **A selection,
    // like `approved_new_notes` and for the same reason**: a setting write is a
    // write, so it needs its own approval, and handing over the run's whole
    // recorded list is the defect the sibling parameter exists to prevent.
    approved_settings: Vec<ProposedSetting>,
    approval: Approval,
    runs: &Arc<AgentRunState>,
    sessions: &AgentSessionState,
    indices: &VaultIndicesState,
    vault: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
) -> Result<ApplyOutcome, AgentError> {
    require_unlocked(vault).await?;
    require_ai_enabled(&app, vault).await?;
    // Re-read at the WRITE rather than carried from the run that proposed these
    // edits. A user who excludes a folder while a proposal sits on the review
    // screen means it, and the newest answer is the one that should decide.
    let excluded = HostScopeSource {
        app: app.clone(),
        vault,
        indices,
    }
    .excluded_folders()
    .await?;
    // READ, not take: consumption happens after the apply, keyed off what it
    // actually created, so a failure leaves every approved note retryable.
    let new_notes = sessions.read_approved_new_notes(&run_id, &approved_new_notes);
    let (approved, not_proposed) = sessions.retain_proposed_edits(&run_id, &approved);
    let reader = NoteReadAdapter {
        host: TauriHost::new(app.clone()),
        state: vault,
    };
    let restore = RestoreAdapter {
        host: TauriHost::new(app.clone()),
        state: vault,
    };
    let writer = WriteAdapter {
        host: TauriHost::new(app.clone()),
        state: vault,
        hooks: hooks.clone(),
    };
    let mut outcome = apply_approved(
        runs, &run_id, &approved, &new_notes, &excluded, approval, &reader, &restore, &writer,
    )
    .await?;
    // Edits the host never recorded the model proposing are REPORTED rather than
    // dropped, so a surface that shows a refusal per row can show these too.
    for index in not_proposed {
        outcome.refused.push(RefusedEdit {
            note_id: String::new(),
            index,
            reason: EditRejection::NotProposed,
        });
    }
    // **Settings, through their own path** (myne-md/myne#850). A setting has no
    // note scope to check and no restore point to take, so it does not ride
    // `apply_approved`; what it does share is the run this stops, the approval
    // label, and the re-derivation of what may be written at the write itself.
    // **Resolved against the run's own record before anything is written**, which
    // is the check that turns "the client offered these" from an argument into a
    // bound (2026-10-13 review). The pairs keep their original positions, unlike
    // the edit half's, because the refusal index is what the review surface
    // subtracts with.
    let (indexed_settings, settings_not_proposed) =
        sessions.retain_proposed_settings(&run_id, &approved_settings);
    let prefs = PrefWriteAdapter {
        app: app.clone(),
        vault,
        hooks,
    };
    match apply_settings_approved(runs, &run_id, &indexed_settings, approval, &prefs).await {
        Ok(settings) => {
            // A `NeedsOwnAct` refusal is the bulk carve-out, reported like any
            // other refusal so the surface can say which row was refused and why
            // rather than skipping it silently.
            outcome.settings_changed = settings.applied;
            outcome.refused_settings = settings.refused;
        }
        // A failure here refuses every setting rather than failing the apply:
        // the edits are already placed, and returning `Err` would discard their
        // restore points, which is the failure mode `createFailed`'s comment
        // records.
        Err(err) => {
            let reason = match err {
                // The same rule the note path enforces, one module over: one
                // approval act covers one change.
                AgentError::IndividualApprovalNotSingle => SettingRejection::NeedsOwnAct,
                // A run the user stopped, or one the host no longer holds: nothing
                // was attempted, so this is not a write failure (myne-md/myne#850,
                // from review). Matching explicitly rather than falling through, so
                // the reason is chosen by meaning rather than by which arms happened
                // to be listed first.
                AgentError::Cancelled | AgentError::NoSuchRun => SettingRejection::RunStopped,
                _ => SettingRejection::WriteFailed,
            };
            outcome.refused_settings = indexed_settings
                .iter()
                .map(|(index, setting)| RefusedSetting {
                    intent_id: setting.intent_id.clone(),
                    index: *index,
                    reason,
                })
                .collect();
        }
    }
    // Settings the host never recorded the model proposing are REPORTED rather
    // than dropped, exactly as the edits above are: a row the user pressed Apply
    // on that quietly does nothing is the failure mode the review surface exists
    // to avoid.
    for index in settings_not_proposed {
        outcome.refused_settings.push(RefusedSetting {
            intent_id: approved_settings
                .get(index)
                .map(|s| s.intent_id.clone())
                .unwrap_or_default(),
            index,
            reason: SettingRejection::NotProposed,
        });
    }
    // Drop the ones that LANDED, and only those. On the `?` above nothing is
    // consumed, which is the point: the user can retry and the notes are still
    // there. A per-note `createFailed` refusal is retryable for the same reason.
    sessions.consume_created_new_notes(&run_id, &outcome.created_new_note_indices);
    // Record it under the run id, so undo survives the review screen closing.
    // Recorded only when something was actually written: an apply whose every
    // row was refused took no restore point and changed no setting, and offering
    // to undo it would be an offer to restore nothing.
    if !outcome.restore_points.is_empty()
        || !outcome.notes_created.is_empty()
        || !outcome.settings_changed.is_empty()
    {
        runs.record_applied(AppliedRun {
            run_id: run_id.clone(),
            restore_points: outcome.restore_points.clone(),
            notes_created: outcome.notes_created.len(),
            // The settings half of the undo record, with the value each replaced
            // so the undo can put it back.
            settings: outcome.settings_changed.clone(),
        });
    }
    Ok(outcome)
}

/// Put the notes an applied run wrote back the way they were.
///
/// **Here for a sharper reason than `apply_from_host` above.** The two clients'
/// copies had already DIVERGED: desktop puts the failed restore points back so
/// a partial failure can be retried, under a comment citing the review of
/// myne-md/myne#531, and the mobile retype simply did not have that branch. So
/// on that client a snapshot that would not restore consumed the record
/// permanently and the user could not try again. One copy, and the fix travels.
///
/// **No `ai_enabled` guard, and it WRITES**, so the omission is the one that
/// needs arguing: it writes to put notes BACK, and gating the single act that
/// reverses a run on an opt-in the user may have just switched off would leave
/// the applied edits standing with no way to take them back. The consent being
/// withdrawn is consent to run the model, not consent to keep what it wrote.
pub async fn undo_from_host<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    runs: &Arc<AgentRunState>,
    vault: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
) -> Result<AgentUndoResult, AgentError> {
    require_unlocked(vault).await?;
    let record = runs.take_applied(&run_id)?;
    let notes_created = record.notes_created;
    // Carried back into the retry record below, and restored by the settings loop
    // further down. **Held so that a partial note failure cannot discard the
    // settings half of the record.** This comment said the settings undo "is not
    // wired yet" until the 2026-10-13 review: a false wiring claim inside the
    // function that does the wiring is the one statement that makes "is anything
    // new wired to nothing?" unanswerable by reading.
    let record_settings = record.settings;
    // The REAL live-session registry (`SYNC-33`), read BEFORE the app handle moves
    // into the host: the undo writes notes back through `snapshot_restore`, which
    // refuses a note a live session owns. A throwaway registry would make that
    // refusal inert, and the notes an undo reverses were written by the same paths a
    // live session can own.
    let registry = {
        use tauri::Manager as _;
        app.try_state::<crate::plugins::live::LiveSessionRegistry>()
    };
    let registry: Option<&crate::plugins::live::LiveSessionRegistry> = registry.as_deref();
    let host = TauriHost::new(app.clone());
    let mut reverted = 0usize;
    let mut failed = Vec::new();
    for (note_id, snapshot_id) in record.restore_points {
        let snapshot_id_for_retry = snapshot_id.clone();
        match snapshot_restore_from_host(
            &host,
            vault,
            hooks,
            note_id.clone(),
            snapshot_id,
            &StdVaultIo,
            registry,
        )
        .await
        {
            Ok(()) => reverted += 1,
            Err(_) => failed.push((note_id, snapshot_id_for_retry)),
        }
    }
    // **The settings half of the undo** (myne-md/myne#850). Written back through
    // the same prefs setters the apply used, so there is one read-before-write
    // pairing rather than two.
    //
    // **Every value restored here comes from the record, never from a fresh
    // read.** Rebuilding one from live prefs is how the undo of
    // `files.new-note-location` wrote the agent's own new folder back, reported
    // the setting restored, and permanently replaced the folder the user had.
    // `AppliedSetting::previous_folder` carries what the run replaced.
    //
    // **Three shapes of a recorded previous value, listed because this comment
    // used to claim there was one and to say no special case was needed:**
    //   1. a value, with no folder: restored through `write_target` directly.
    //   2. an unset value on a target whose setter takes an `Option` (the
    //      periodic-notes entries, the new-note-location mode): restored as a
    //      clear, which is what `None` means on those.
    //   3. an unset value on `DailyFolder` or `DailyDateFormat`, whose setters
    //      take a required value: restored through the prefs plugin's own CLEAR
    //      functions, added with this fix, which is what made "the agent set the
    //      daily folder for the first time" undoable at all. Before them
    //      `write_target` refused the `None` and the setting failed for good,
    //      because a failure re-records it. The agent's clear VERB still refuses
    //      these two, which is a policy rather than a signature, and
    //      `PrefTarget::clearable`'s doc says so.
    let mut settings_reverted = 0usize;
    let mut settings_failed: Vec<String> = Vec::new();
    let mut failed_settings: Vec<AppliedSetting> = Vec::new();
    for setting in &record_settings {
        let Some(intent) = crate::plugins::agent::setting::intent(&setting.intent_id) else {
            settings_failed.push(setting.intent_id.clone());
            failed_settings.push(setting.clone());
            continue;
        };
        // **The folder to put back is the one the run REPLACED, and only where
        // the restored VALUE takes one.** `folder_named` is the same function the
        // apply uses, so the two cannot disagree about which value needs a
        // folder, and it is what keeps a restored `root` from being handed a
        // folder it does not use.
        let restore_folder = if matches!(intent.target, PrefTarget::NewNoteLocation) {
            crate::plugins::agent::setting::folder_named(
                intent,
                setting.previous.as_deref(),
                setting.previous_folder.as_deref(),
            )
            .map(str::to_string)
        } else {
            None
        };
        match write_target(
            &host,
            vault,
            hooks,
            &intent.target,
            setting.previous.clone(),
            restore_folder,
        )
        .await
        {
            Ok(()) => settings_reverted += 1,
            Err(_) => {
                settings_failed.push(setting.intent_id.clone());
                failed_settings.push(setting.clone());
            }
        }
    }

    // Every row this undo did not restore is reported by name, notes and settings
    // together: the user's question is "what is left", not which of two
    // mechanisms left it.
    let failed_ids: Vec<String> = failed
        .iter()
        .map(|(id, _)| id.clone())
        .chain(settings_failed.iter().cloned())
        .collect();

    // **Put the FAILED points back, so the undo can be retried.**
    // `take_applied` consumes deliberately: a second undo of the same record
    // would restore the same snapshots over whatever the user has written since,
    // which would look successful. That reasoning covers the notes that WERE
    // restored and not the ones that were not. Those were never touched, so a
    // retry cannot overwrite anything, and consuming the whole record made a
    // partial failure permanent. Found in the review of myne-md/myne#531.
    //
    // **Only the settings that FAILED are carried back, which is the same
    // property the note half has and this half did not** (myne-md/myne#850). The
    // first version re-recorded the whole consumed list, so a setting that WAS
    // restored got re-armed, and a retry after the user changed that preference
    // in the meantime wrote the pre-run value over it while reporting success.
    // The note half has always re-recorded only `failed`.
    //
    // `notes_created` is not carried back: those notes are still there, an undo
    // never reverted them, and re-reporting the count on a retry would say the
    // second attempt left them behind as if that were news.
    if !failed.is_empty() || !settings_failed.is_empty() {
        runs.record_applied(AppliedRun {
            run_id: run_id.clone(),
            restore_points: failed,
            notes_created: 0,
            settings: failed_settings,
        });
    }
    Ok(AgentUndoResult {
        reverted,
        failed: failed_ids,
        notes_created_not_reverted: notes_created,
        settings_reverted,
    })
}

/// What an undo did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUndoResult {
    /// How many notes were restored to their pre-apply text.
    pub reverted: usize,
    /// Notes whose snapshot would not restore. Named so the user can act.
    pub failed: Vec<String>,
    /// How many notes the run CREATED and this undo therefore left in place.
    pub notes_created_not_reverted: usize,
    /// How many settings were put back (myne-md/myne#850). Counted apart from
    /// `reverted`, which is about note text: a setting is restored by writing a
    /// preference, not by restoring a snapshot, and folding the two into one
    /// number would make "the run was undone" say more than it did.
    pub settings_reverted: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// `open` stores the language, the budgeted seed and its controls, rather
    /// than `Default` (myne-md/myne#648). The merge that replaced the
    /// prune-then-insert with `open()` kept the newer call and lost all three
    /// seeded fields, and the only signal was an unused-variables lint no CI
    /// step ran. This pins the storage so the wiring has something to read.
    #[test]
    fn open_stores_language_history_and_controls() {
        let state = AgentSessionState::default();
        let live = BTreeSet::new();
        let seed = vec![Message {
            role: crate::plugins::agent::engine::Role::User,
            content: vec![],
        }];
        let controls = super::super::history::SeedControls::from_view(&protocol::PrefsView {
            ai_excluded_folders: vec!["Secret/".to_string()],
            ai_provider: Some("openrouter".to_string()),
            ..Default::default()
        });
        state.open(
            "run-1",
            "do the thing".to_string(),
            &live,
            Some("tr".to_string()),
            seed,
            Some(controls.clone()),
            vec!["editor.weekly-notes-folder".to_string()],
        );
        let table = state.sessions.lock().expect("poisoned");
        let s = table.get("run-1").expect("session stored");
        assert_eq!(s.language.as_deref(), Some("tr"));
        assert_eq!(s.history.len(), 1);
        assert_eq!(s.seed_controls, Some(controls));
    }

    // ---- the run id reaches the surface before the loop runs -------------

    // ---- the compiled-in probe threshold --------------------------------

    /// The strictness that used to live in an `assert_eq!` inside
    /// `probe_threshold`, moved here so it fails a `cargo test` rather than an
    /// IPC call.
    #[test]
    fn the_compiled_in_threshold_file_is_well_formed() {
        let parsed = parse_probe_threshold(PROBE_THRESHOLD_JSON)
            .expect("agent-probe-threshold.json must parse and be self-consistent");
        assert!(
            parsed.required <= parsed.attempts,
            "a bar of {} out of {} attempts can never be cleared",
            parsed.required,
            parsed.attempts
        );
    }

    /// Both directions of the status/measurements agreement, injected. The
    /// check is worth nothing unless it has been seen to fire, and a check that
    /// is only ever run against a passing input has not been.
    #[test]
    fn a_record_that_disagrees_with_itself_is_refused_both_ways() {
        let claims_measured =
            r#"{"attempts":3,"required":2,"status":"measured","measurements":[]}"#;
        assert!(
            parse_probe_threshold(claims_measured).is_err(),
            "`measured` with no measurements is a claim nobody made"
        );
        let claims_unmeasured =
            r#"{"attempts":3,"required":2,"status":"unmeasured","measurements":[{"backend":"x"}]}"#;
        assert!(
            parse_probe_threshold(claims_unmeasured).is_err(),
            "`unmeasured` with measurements has stopped describing itself"
        );
        assert!(
            parse_probe_threshold("not json").is_err(),
            "a malformed record is refused rather than parsed into a default"
        );
    }

    /// The fallback direction: unreadable must mean UNAVAILABLE, not available.
    #[test]
    fn an_unreadable_record_falls_back_to_a_bar_no_backend_clears() {
        // Driving the fallback through the real function rather than asserting
        // the literal: what matters is what a caller receives when the parse
        // fails, and a test that restated the constant would pass against a
        // version that never used it.
        let fallback = parse_probe_threshold("not json").unwrap_or(ProbeThreshold {
            attempts: 1,
            required: u8::MAX,
            provisional: true,
        });
        assert!(
            fallback.required > fallback.attempts,
            "fail-closed: an unreadable threshold must be unclearable, not permissive"
        );
        assert!(fallback.provisional, "and it must not claim to be measured");
    }

    fn note(title: &str) -> ProposedNote {
        ProposedNote {
            title: title.into(),
            body: "body".into(),
            folder: None,
        }
    }

    fn session_with(notes: &[&str]) -> AgentSessionState {
        let st = AgentSessionState::default();
        let mut table = st.sessions.lock().unwrap();
        let mut s = Session::default();
        s.proposal.new_notes = notes.iter().map(|t| note(t)).collect();
        table.insert("r".to_string(), s);
        drop(table);
        st
    }

    fn remaining(st: &AgentSessionState) -> Vec<String> {
        st.sessions
            .lock()
            .unwrap()
            .get("r")
            .map(|s| {
                s.proposal
                    .new_notes
                    .iter()
                    .map(|n| n.title.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Reading the approved notes must not remove them.
    ///
    /// The consuming version ran BEFORE the apply, which can still fail, and on
    /// failure the notes were gone from the record and never created: the screen
    /// kept rendering them, a retry sent the same indices, found a shorter list,
    /// and silently created nothing.
    #[test]
    fn reading_approved_new_notes_leaves_the_record_intact_for_a_retry() {
        let st = session_with(&["A", "B", "C"]);
        let read = st.read_approved_new_notes("r", &[0, 2]);
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].0, 0);
        assert_eq!(read[1].0, 2);
        // The state, not the return value: a read that reported the right pair
        // while removing them would pass a return-value assertion.
        assert_eq!(remaining(&st), vec!["A", "B", "C"]);
    }

    /// And consuming drops exactly what landed, so a partial apply stays
    /// retryable for the rest.
    #[test]
    fn consuming_drops_only_the_notes_that_were_created() {
        let st = session_with(&["A", "B", "C"]);
        st.consume_created_new_notes("r", &[1]);
        assert_eq!(remaining(&st), vec!["A", "C"]);
    }

    #[test]
    fn consuming_nothing_is_what_a_failed_apply_does() {
        let st = session_with(&["A", "B"]);
        st.consume_created_new_notes("r", &[]);
        assert_eq!(remaining(&st), vec!["A", "B"]);
    }

    #[test]
    fn an_out_of_range_index_is_dropped_rather_than_erroring() {
        // Only a stale screen can send one, and refusing the whole apply over it
        // is worse than applying the rest.
        let st = session_with(&["A"]);
        assert_eq!(st.read_approved_new_notes("r", &[0, 9]).len(), 1);
        st.consume_created_new_notes("r", &[9]);
        assert_eq!(remaining(&st), vec!["A"]);
    }

    fn setting(intent_id: &str, value: Option<&str>) -> ProposedSetting {
        ProposedSetting {
            intent_id: intent_id.to_string(),
            value: value.map(str::to_string),
            folder: None,
        }
    }

    fn session_with_settings(settings: &[ProposedSetting]) -> AgentSessionState {
        let st = AgentSessionState::default();
        let mut table = st.sessions.lock().unwrap();
        let mut s = Session::default();
        s.proposal.settings = settings.to_vec();
        table.insert("r".to_string(), s);
        drop(table);
        st
    }

    /// **The bound that makes the offer a bound rather than a page-supplied
    /// argument.** `agent_start` takes the offered ids from the page and
    /// `agent_apply` takes the approved settings from it too, so without this
    /// check a caller could name any of the twelve intent ids in its own start
    /// call and then write them.
    ///
    /// Verified by injection: replacing the `proposed.contains(setting)`
    /// predicate with keep-everything leaves every other gate in the tree green,
    /// because the only reader needs an `AppHandle` and is exercised by the E2E
    /// happy path alone.
    #[test]
    fn retaining_approved_settings_keeps_only_what_the_run_proposed() {
        let st = session_with_settings(&[
            setting("editor.weekly-notes-folder", Some("J/Weekly")),
            setting("editor.daily-notes-date-format", Some("yyyy-MM-dd")),
        ]);
        let approved = vec![
            setting("editor.weekly-notes-folder", Some("J/Weekly")),
            setting("editor.daily-notes-date-format", Some("yyyy-MM-dd")),
            // Never proposed by this run, so it cannot be written even though
            // the id is a real, writable intent.
            setting("appearance.theme", Some("dark")),
        ];
        let (kept, unknown) = st.retain_proposed_settings("r", &approved);
        assert_eq!(kept.len(), 2);
        // The ORIGINAL indices ride along: the review surface subtracts its
        // refusals with them, so re-numbering here would mis-mark every row
        // after a dropped one.
        assert_eq!(kept[0].0, 0);
        assert_eq!(kept[1].0, 1);
        assert_eq!(unknown, vec![2]);
    }

    /// **Compared by VALUE, like the edit half.** The same id carrying a value
    /// the run never proposed is not the thing that was approved.
    #[test]
    fn a_setting_with_the_proposed_id_but_another_value_is_not_recognised() {
        let st = session_with_settings(&[setting("editor.weekly-notes-folder", Some("J/Weekly"))]);
        let (kept, unknown) = st.retain_proposed_settings(
            "r",
            &[setting("editor.weekly-notes-folder", Some("Other/"))],
        );
        assert!(kept.is_empty());
        assert_eq!(unknown, vec![0]);
    }

    /// A session that is gone recognises nothing, which fails closed in the same
    /// direction the edit half does: the run is over, and an apply against a
    /// record the host no longer holds is what this refuses.
    #[test]
    fn retaining_approved_settings_recognises_nothing_when_the_session_is_gone() {
        let st = AgentSessionState::default();
        let (kept, unknown) =
            st.retain_proposed_settings("gone", &[setting("editor.weekly-notes-folder", None)]);
        assert!(kept.is_empty());
        assert_eq!(unknown, vec![0]);
    }

    #[test]
    fn the_probe_threshold_parses_from_the_recorded_file() {
        let t = probe_threshold();
        assert!(t.attempts >= 1);
        assert!(t.required >= 1);
        assert!(
            t.required <= t.attempts,
            "a bar higher than the attempt count could never be met"
        );
    }

    #[test]
    fn the_recorded_threshold_file_says_whether_it_was_measured() {
        // The number is debt until someone runs the probe against real models.
        // Asserting the field exists is what keeps the honesty from being
        // quietly dropped in a later edit.
        let v: serde_json::Value = serde_json::from_str(PROBE_THRESHOLD_JSON).unwrap();
        assert!(v.get("status").is_some(), "the file states its own status");
        assert!(
            v.get("measurements").is_some(),
            "and carries the measurements, or an empty list saying there are none"
        );
    }

    #[test]
    fn sessions_clear_leaves_none_behind() {
        let s = AgentSessionState::default();
        s.sessions.lock().unwrap().insert(
            "r".into(),
            Session {
                task: "t".into(),
                ..Default::default()
            },
        );
        assert_eq!(s.len(), 1);
        s.clear();
        assert!(s.is_empty(), "no transcript survives a lock");
    }

    // ---- the session table's bound ---------------------------------------

    fn session_with_task(task: &str) -> Session {
        Session {
            task: task.into(),
            ..Default::default()
        }
    }

    /// The run table caps and evicts; this table did not, so an evicted run's
    /// plaintext stayed resident until the vault locked
    /// (myne-md/myne#531 review round six).
    #[test]
    fn a_session_whose_run_was_evicted_is_dropped() {
        let s = AgentSessionState::default();
        {
            let mut t = s.sessions.lock().unwrap();
            t.insert("evicted".into(), session_with_task("old"));
            t.insert("live".into(), session_with_task("current"));
        }
        assert_eq!(s.len(), 2);
        s.prune_to(&BTreeSet::from(["live".to_string()]));
        let table = s.sessions.lock().unwrap();
        assert_eq!(
            table.keys().cloned().collect::<Vec<_>>(),
            vec!["live".to_string()],
            "only the run core still holds keeps its session"
        );
    }

    /// The direction a prune is most likely to break: pruning must not remove a
    /// session whose run is live, which would take the transcript out from under
    /// a running step.
    #[test]
    fn a_live_run_keeps_its_session() {
        let s = AgentSessionState::default();
        s.sessions
            .lock()
            .unwrap()
            .insert("r".into(), session_with_task("t"));
        s.prune_to(&BTreeSet::from(["r".to_string(), "other".to_string()]));
        assert_eq!(s.len(), 1);
    }

    /// The prune drives the SAME wipe the lock teardown does, so the two cannot
    /// drift into different notions of "gone". Asserted through `wipe_session`
    /// directly, because a dropped session's memory cannot be read afterwards
    /// and a test that claimed to check it would be claiming more than its
    /// inputs can prove.
    ///
    /// **Emptiness rather than "every byte is zero", which is the assertion this
    /// test used to make and which is vacuously true.** `Zeroize for String`
    /// overwrites the buffer and then clears it, so `bytes()` sees an empty
    /// slice and `all(|b| b == 0)` passes on an empty iterator: the old
    /// assertion could not fail, whichever fields the wipe covered. Empty is
    /// what is actually observable from here, and it is what a reader cares
    /// about.
    #[test]
    fn the_prune_and_the_lock_teardown_wipe_through_one_function() {
        let mut session = Session {
            task: "secret task".into(),
            ..Default::default()
        };
        session.proposal.summary = "secret summary".into();
        wipe_session(&mut session);
        assert!(session.task.is_empty(), "task overwritten");
        assert!(session.proposal.summary.is_empty(), "summary overwritten");
    }

    /// **The teardown half of the miss `accumulate_proposal` records**
    /// (myne-md/myne#850). `settings` was absent from the list `wipe_session`
    /// overwrote, so a proposed folder name, date format or new-note location
    /// stayed resident until that allocation was reused. Both of a setting's
    /// text fields are `Option<String>`, which is the shape that slipped past
    /// the hand-written `note.title`/`note.body` pair twice: the `folder` arm
    /// above carries the same story from the first time.
    ///
    /// Fails against the enumerating version of the wipe, which is the point:
    /// the value and the folder survive it unemptied.
    #[test]
    fn a_wipe_empties_a_proposed_settings_value_and_folder() {
        let mut session = Session {
            task: "t".into(),
            ..Default::default()
        };
        session
            .proposal
            .settings
            .push(crate::plugins::agent::prompt::ProposedSetting {
                intent_id: "files.new-note-location".into(),
                value: Some("secret value".into()),
                folder: Some("secret folder".into()),
            });

        wipe_session(&mut session);

        let setting = &session.proposal.settings[0];
        assert!(
            setting.value.as_deref().unwrap_or_default().is_empty(),
            "the proposed value is overwritten"
        );
        assert!(
            setting.folder.as_deref().unwrap_or_default().is_empty(),
            "the proposed folder is overwritten"
        );
    }

    // ---- accumulating one run's proposal across legs ----------------------

    /// **The regression this function was extracted for** (myne-md/myne#850).
    ///
    /// The merge used to copy `edits`, `new_notes` and `summary` by hand, and
    /// `settings` was not among them. Every setting a run proposed was dropped
    /// between the loop's own proposal and the one the client receives, and
    /// what that cost is worth restating here: a settings-only run arrived as
    /// an EMPTY proposal, the review screen's gate is "the run stopped and has
    /// something to show", so the screen never opened at all, while the host
    /// had accepted the change, raised no refusal, and every gate in the tree
    /// stayed green.
    ///
    /// **This test sits at the merge rather than at the loop deliberately, and
    /// that is the whole lesson.** The loop's tests assert `outcome.proposal`,
    /// which is the value BEFORE this function runs, so they all passed while
    /// the feature did not work end to end. Asserting the layer that was wrong
    /// is the only test that could have caught it.
    #[test]
    fn an_accumulated_proposal_keeps_the_settings_its_leg_proposed() {
        let mut into = Proposal {
            edits: Vec::new(),
            new_notes: vec![note("first leg")],
            settings: Vec::new(),
            summary: "first".into(),
        };
        let from = Proposal {
            edits: Vec::new(),
            new_notes: Vec::new(),
            settings: vec![
                crate::plugins::agent::prompt::ProposedSetting {
                    intent_id: "editor.weekly-notes-folder".into(),
                    value: Some("Journals/Weekly".into()),
                    folder: None,
                },
                crate::plugins::agent::prompt::ProposedSetting {
                    intent_id: "files.new-note-location".into(),
                    value: Some("inbox".into()),
                    folder: Some("Notes".into()),
                },
            ],
            summary: "second".into(),
        };

        accumulate_proposal(&mut into, from);

        assert_eq!(
            into.settings.len(),
            2,
            "a leg's settings must reach the accumulated proposal"
        );
        assert_eq!(into.settings[0].intent_id, "editor.weekly-notes-folder");
        assert_eq!(into.settings[0].value.as_deref(), Some("Journals/Weekly"));
        assert_eq!(into.settings[1].intent_id, "files.new-note-location");
        assert_eq!(into.settings[1].folder.as_deref(), Some("Notes"));
        // The other fields still accumulate, which is what makes this a merge
        // rather than a replacement.
        assert_eq!(into.new_notes.len(), 1);
        assert_eq!(into.summary, "second");
    }

    /// A leg that finished without saying anything must not blank what an
    /// earlier leg said. The empty check lives on the summary alone: an empty
    /// EDIT list is a legitimate leg and clearing it would be right.
    #[test]
    fn an_empty_summary_leaves_the_earlier_one_in_place() {
        let mut into = Proposal {
            summary: "first".into(),
            ..Default::default()
        };
        accumulate_proposal(&mut into, Proposal::default());
        assert_eq!(into.summary, "first");
    }
}
