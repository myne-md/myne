// SPDX-License-Identifier: AGPL-3.0
//! The desktop agent plugin's IPC surface.
//!
//! Eight `#[tauri::command]` wrappers and nothing else. Since myne-md/myne#456
//! the host-generic half, the session table, the guards, the scope source, the
//! result types and `step` itself, lives in
//! [`myne_core::plugins::agent::host_commands`], because both Tauri clients ran
//! the identical sequence and differed in exactly two places: which engine
//! answers, and how a scope is searched. Those two arrive as trait objects.
//!
//! **What is left here is the wiring that genuinely differs**, and it is the
//! `State<'_, …>` list: this client resolves a `LocalInferenceState` and a
//! `LocalInferenceVectorState` to build its engine and its embedding-backed
//! searcher, and mobile resolves neither. That is the three-layer command shape
//! `core/CLAUDE.md` describes, applied to a plugin that had not adopted it.
//!
//! Which guards apply per command is documented on `mod.rs` and is unchanged by
//! the move: they are the same functions, called from core now.
//!
//! See: src-tauri/CLAUDE.md "Secret-handling logging discipline".

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use myne_core::plugins::agent::apply::{ApplyOutcome, Approval};
use myne_core::plugins::agent::edit::ProposedEdit;
use myne_core::plugins::agent::error::AgentError;
use myne_core::plugins::agent::host_commands::{
    apply_from_host, probe_threshold, require_ai_enabled, require_unlocked, step, undo_from_host,
    AgentSessionState, AgentStepResult, AgentUndoResult, GrantPreview, HostScopeSource,
};
use myne_core::plugins::agent::probe::{run_probe, ProbeProgress, ProbeVerdict};
use myne_core::plugins::agent::run::{AgentRunState, AgentRunView, AppliedRun, GrantOrigin};
use myne_core::plugins::agent::run_loop::RunProgress;
use myne_core::plugins::agent::scope::{expand_run, preview_grant, start_run, ScopeGrant};
use myne_core::plugins::vault_indices::state::VaultIndicesState;
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};

use crate::plugins::agent::adapters::{EngineAdapter, SearchAdapter};
use crate::plugins::local_inference::state::LocalInferenceState;
use crate::plugins::local_inference::vector_store::LocalInferenceVectorState;
use myne_core::host::tauri_host::TauriHost;
use myne_core::plugins::agent::history::{
    history_budget, seed_messages, HistoryTurn, SeedControls,
};
use myne_core::plugins::prefs::commands::prefs_read_from_host;
use myne_core::vault_io::StdVaultIo;

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_start<R: Runtime>(
    app: AppHandle<R>,
    task: String,
    grant: ScopeGrant,
    // The visible conversation and the interface language, both read at run
    // start (myne-md/myne#648 restored the wiring the 2026-08-16 merge
    // dropped: these parsed and were ignored, so every run answered in English
    // about a conversation it could not see). `language` shapes the system
    // instruction; `history` is budgeted and seeded below, marked untrusted.
    language: Option<String>,
    history: Vec<HistoryTurn>,
    on_open: Channel<AgentRunView>,
    // The run's cost as it accrues (myne-md/myne#456). A second channel rather
    // than a variant on `on_open`, because the two say different things at
    // different times: `on_open` fires once and makes the run addressable,
    // while this fires per model round-trip and is the disclosure control
    // `design-notes/ai/0515` rests on.
    on_progress: Channel<RunProgress>,
    runs: State<'_, Arc<AgentRunState>>,
    sessions: State<'_, AgentSessionState>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
    ai: State<'_, LocalInferenceState>,
    vectors: State<'_, LocalInferenceVectorState>,
) -> Result<AgentStepResult, AgentError> {
    require_unlocked(&vault).await?;
    require_ai_enabled(&app, &vault).await?;
    // **Re-read the gate, do not trust the cell.** `require_ai_enabled` reads
    // `ai_enabled` from disk, and that is the ONLY part of the gate that was
    // genuinely read at request time: the consent, the key and the model come
    // from `LocalInferenceState`'s cached snapshot, which some other surface
    // filled whenever it last happened to. `provider_gate.rs`'s module doc says
    // the gate is "host-side, and re-read at request time", and three mobile
    // comments say the refresh is done "exactly as desktop does". It was not:
    // `.refresh()` appeared only in `local_inference/commands.rs` and
    // `invalidate()` only on the lock path.
    //
    // That matters more since myne-md/myne#456, which removed `developer_mode`
    // from this gate and names the device-local consent as the compensating
    // control. A control read from a cache cannot carry that weight.
    //
    // A refresh here rather than an invalidate inside the consent and key
    // setters, which is the cheaper shape and the wrong one: `ai_provider_key`
    // still SYNCS, so a key that arrives from another device passes through no
    // setter on this one and would leave the cell stale exactly where a
    // revocation matters most.
    ai.refresh().await;
    let source = HostScopeSource {
        app: app.clone(),
        vault: vault.inner(),
        indices: indices.inner(),
    };
    // **v7, not v4, and the eviction depends on it.** `AgentRunState::start`
    // bounds the table by dropping `BTreeMap`'s first key, which it documents as
    // the oldest run. That is only true for a time-ordered id: under v4 the
    // first key is the lexically smallest RANDOM id, so at the cap the eviction
    // cancelled an arbitrary run and the one the user was reviewing could go
    // while an older idle one survived. Found in the review of myne-md/myne#531.
    //
    // A v7 carries a millisecond timestamp, and this one does not leave the
    // device: the run id is RAM-only, never persisted, and never reaches the
    // model (nothing in `prompt.rs` or `engine.rs` reads it), so it does not
    // widen what crosses TB13.
    let run_id = myne_core::plugins::agent::run::new_run_id();
    let (resolved, cancel) = start_run(&runs, run_id.clone(), &grant, &source).await?;
    // Seed the run with the visible conversation, under the user's budget and
    // the snapshotted egress controls (myne-md/myne#648). The budget is read
    // here, at run start, from the same prefs read and clamped again on the
    // way in; `step` re-reads the live prefs on every leg and drops the seed
    // when the controls no longer match, so a scope approval waited out while
    // the exclusion set or the provider moved resumes unseeded rather than
    // re-sending a conversation the user just withdrew.
    let prefs = prefs_read_from_host(&TauriHost::new(app.clone()), vault.inner(), &StdVaultIo)
        .await
        .map_err(|_| AgentError::ReadFailed)?;
    let seed = seed_messages(&history, history_budget(&prefs));
    let seed_controls = if seed.is_empty() {
        None
    } else {
        Some(SeedControls::from_view(&prefs))
    };
    // Prune-then-insert, in that order, and the order is why this is one call
    // rather than two here: see `AgentSessionState::open`.
    sessions.open(
        &run_id,
        task,
        &runs.live_ids(),
        language,
        seed,
        seed_controls,
    );
    // **Before the loop, not after it.** This command returns once the loop has
    // stopped, which on a remote provider is minutes, and until myne-md/myne#544
    // that return was the only thing that ever handed the surface a run id. So
    // for the whole first leg the run was `running` with no id: no status, no
    // running scope total, and no Stop, on a run that is at that moment sending
    // note text to a provider. `AgentProgress`'s own module note says the scope
    // total "is shown continuously"; this is what makes that true.
    //
    // A channel rather than a second command, because the id has to arrive
    // DURING this call, and rather than an event, because a channel is an
    // ordinary parameter: no new command, no capability ACL change, and the
    // same shape `chat_stream` already uses for its tokens.
    //
    // A send that fails is ignored on purpose: a closed channel means the
    // surface let go of this run, and the run is unaffected either way.
    if let Ok(view) = runs.view(&run_id) {
        let _ = on_open.send(view);
    }

    // **Wall-clock, measured HERE rather than inside the loop**
    // (myne-md/myne#568). `core/` compiles for `wasm32-unknown-unknown`, where
    // `Instant::now()` compiles and then panics (`core/src/host.rs`), so timing
    // the loop itself would mean threading a clock through `LoopDeps`. This
    // crate is desktop-only and this is the whole user-visible call, which is
    // the figure that was missing: a session sat at "Working" for minutes with
    // no way to tell whether the time was the provider's or ours. It was the
    // provider's, and now that is readable rather than inferred.
    let started = std::time::Instant::now();
    let outcome = step(
        app,
        run_id,
        Arc::clone(&runs),
        &sessions,
        &indices,
        &vault,
        // The two seams this client supplies for itself: its own engine, and
        // an embedding-backed searcher. Mobile builds different ones and calls
        // the same `step`.
        &EngineAdapter {
            state: ai.inner(),
            cancel: Arc::clone(&cancel),
        },
        &SearchAdapter {
            state: ai.inner(),
            vectors: vectors.inner(),
        },
        cancel,
        resolved.excluded_count,
        on_progress,
    )
    .await;
    tracing::debug!(
        target: "myne::agent",
        event = "agent_start_returned",
        elapsed_ms = started.elapsed().as_millis() as u64,
        // A boolean, not the error: `step_failed` one frame in already logs the
        // `kind`, and repeating it here would be a second place to keep the DENY
        // list true.
        ok = outcome.is_ok(),
    );
    outcome
}

/// Approve a scope expansion and resume the run.
///
/// The origin is `Model` because this command exists to answer a request the
/// model made. A user widening the scope themselves goes through `agent_start`
/// with a wider grant, which is `User`. Neither is read from the payload.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_approve_scope<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    grant: ScopeGrant,
    // The approved leg reports its cost too. Without this the figures would
    // freeze the moment a run asked to widen its scope, which is exactly the
    // point at which a user most wants to see them moving.
    on_progress: Channel<RunProgress>,
    runs: State<'_, Arc<AgentRunState>>,
    sessions: State<'_, AgentSessionState>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
    ai: State<'_, LocalInferenceState>,
    vectors: State<'_, LocalInferenceVectorState>,
) -> Result<AgentStepResult, AgentError> {
    require_unlocked(&vault).await?;
    require_ai_enabled(&app, &vault).await?;
    // Same reason as `agent_start`: the gate is read here, not remembered.
    ai.refresh().await;
    let source = HostScopeSource {
        app: app.clone(),
        vault: vault.inner(),
        indices: indices.inner(),
    };
    let resolved = expand_run(&runs, &run_id, &grant, GrantOrigin::Model, &source).await?;
    // The run's OWN flag, not a fresh one seeded from its current value: a copy
    // is a flag nothing else writes to, and Stop and the lock teardown would
    // both be inert for this leg.
    let cancel = runs.cancel_flag(&run_id)?;
    step(
        app,
        run_id,
        Arc::clone(&runs),
        &sessions,
        &indices,
        &vault,
        // The two seams this client supplies for itself: its own engine, and
        // an embedding-backed searcher. Mobile builds different ones and calls
        // the same `step`.
        &EngineAdapter {
            state: ai.inner(),
            cancel: Arc::clone(&cancel),
        },
        &SearchAdapter {
            state: ai.inner(),
            vectors: vectors.inner(),
        },
        cancel,
        resolved.excluded_count,
        on_progress,
    )
    .await
}

/// What a grant would resolve to, without committing it.
///
/// The approval screen is the gate, and a gate that states numbers the host will
/// not honour is not one. This runs the SAME `resolve_grant` the commit runs,
/// against the same index snapshot and the same `ai_excluded_folders`, so the
/// count, the removed count and the resulting total are the host's answers
/// rather than the WebView's arithmetic.
///
/// It is a preview, not a reservation: the set is resolved again when the grant
/// is actually approved. The two can differ if the vault changes in between, and
/// that is correct: the frozen set is the one taken at approval, not at preview.
#[tauri::command]
pub async fn agent_preview_grant<R: Runtime>(
    app: AppHandle<R>,
    run_id: Option<String>,
    grant: ScopeGrant,
    runs: State<'_, Arc<AgentRunState>>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
) -> Result<GrantPreview, AgentError> {
    require_unlocked(&vault).await?;
    // The opt-in, re-read host-side like every sibling that reaches the vault.
    // `mod.rs` and `decisions/ai/0515` both said this command did; it did not,
    // which made two documents wrong about a TB6 surface rather than merely
    // leaving a gap. Cheaper to make the claim true than to record an exception
    // nobody wanted.
    require_ai_enabled(&app, &vault).await?;
    let source = HostScopeSource {
        app: app.clone(),
        vault: vault.inner(),
        indices: indices.inner(),
    };
    let (resolved, new_total) = preview_grant(&runs, run_id.as_deref(), &grant, &source).await?;
    Ok(GrantPreview {
        note_count: resolved.note_ids.len(),
        excluded_count: resolved.excluded_count,
        unknown_count: resolved.unknown_count,
        new_total,
    })
}

/// Cancel a run.
#[tauri::command]
pub async fn agent_cancel(
    run_id: String,
    runs: State<'_, Arc<AgentRunState>>,
) -> Result<bool, AgentError> {
    Ok(runs.cancel(&run_id))
}

/// Apply the edits the user approved on the review screen.
///
/// `approval` says HOW the user approved: one edit on its own, or a batch in one
/// action. It is the only policy input this command takes, and it is a fact
/// about the click rather than about the edits, which is why the host cannot
/// derive it and has to be told. Everything it implies is then enforced
/// host-side: a `Bulk` batch cannot trash a note, and the refusal is reported
/// like any other rather than failing the batch.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_apply<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    approved: Vec<ProposedEdit>,
    approved_new_notes: Vec<usize>,
    approval: Approval,
    runs: State<'_, Arc<AgentRunState>>,
    sessions: State<'_, AgentSessionState>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
    hooks: State<'_, myne_core::hooks::Hooks>,
) -> Result<ApplyOutcome, AgentError> {
    apply_from_host(
        app,
        run_id,
        approved,
        approved_new_notes,
        approval,
        runs.inner(),
        sessions.inner(),
        indices.inner(),
        vault.inner(),
        hooks.inner(),
    )
    .await
}

/// The run the user could still undo, if there is one.
///
/// Exists so the affordance can be offered somewhere other than the screen that
/// applied it. Returns identifiers only, never note text.
#[tauri::command]
pub async fn agent_last_run(
    runs: State<'_, Arc<AgentRunState>>,
    vault: State<'_, VaultRuntimeState>,
) -> Result<Option<AppliedRun>, AgentError> {
    require_unlocked(&vault).await?;
    Ok(runs.last_applied())
}

/// Revert a whole agent run, as one action.
///
/// **Takes the run id, and looks the record up host-side.** The earlier shape
/// took the `(note_id, snapshot_id)` list from the caller, which had two costs:
/// the run id was decorative, since nothing was stored under it, and the record
/// lived only in the review screen, so closing that screen made a documented
/// guarantee stop being true. Now the apply stores it under the run and this
/// command consumes it, so a second undo of the same run reports
/// [`AgentError::NoSuchRun`] instead of restoring the same snapshots over
/// whatever the user has written since.
///
/// One command rather than N snapshot restores from the frontend, because "the
/// whole run reverts as one action" is the property the restore point exists
/// for, and a loop in the WebView is a property that holds only while nobody
/// interrupts it.
///
/// **Notes the run CREATED are not reverted here**, and the result says how many
/// were left. A create has no snapshot to restore to; undoing one means trashing
/// it, which is a different act with a different confirmation. Reporting the
/// count is what keeps "the run was undone" from meaning more than it did.
///
/// Partial failure is reported rather than rolled back: a snapshot that will not
/// restore is not fixed by refusing to restore the others.
#[tauri::command]
pub async fn agent_undo<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    runs: State<'_, Arc<AgentRunState>>,
    vault: State<'_, VaultRuntimeState>,
    hooks: State<'_, myne_core::hooks::Hooks>,
) -> Result<AgentUndoResult, AgentError> {
    undo_from_host(app, run_id, runs.inner(), vault.inner(), hooks.inner()).await
}

/// Whether agent mode can run on the configured backend, and why not.
#[tauri::command]
pub async fn agent_capability<R: Runtime>(
    app: AppHandle<R>,
    // **The wait, reported while it is a wait** (myne-md/myne#575). This command
    // returns once, when everything is done, which was measured at 40 seconds;
    // until then the surface showed one unchanging label and read as a hang. A
    // `Channel` rather than an event, for the reason `agent_start`'s `on_open`
    // gives: it is an ordinary parameter, so there is no new command and no ACL
    // change.
    on_attempt: Channel<ProbeProgress>,
    ai: State<'_, LocalInferenceState>,
    vault: State<'_, VaultRuntimeState>,
) -> Result<ProbeVerdict, AgentError> {
    require_unlocked(&vault).await?;
    require_ai_enabled(&app, &vault).await?;
    // Same reason as `agent_start`: the gate is read here, not remembered.
    ai.refresh().await;
    let engine = EngineAdapter {
        state: ai.inner(),
        cancel: Arc::new(AtomicBool::new(false)),
    };
    // **What the probe COSTS, which nothing said** (myne-md/myne#568). It issues
    // `threshold.attempts` requests to the configured provider; on a remote one
    // that was measured at 8 seconds, spent before the user's first message is
    // sent, and the surface shows only "Checking the model".
    //
    // There is deliberately no `cached` field to go with it. The verdict is now
    // remembered for the session in `agentStore`, and when it is remembered this
    // command is not called at all — so the ABSENCE of this line is the cache. A
    // flag that could only ever read `false` would be a claim the code cannot
    // make.
    let started = std::time::Instant::now();
    // A failed send is ignored, exactly as `agent_start`'s is: a closed channel
    // means the surface let go, and the probe is unaffected either way.
    let sink = move |p: ProbeProgress| {
        let _ = on_attempt.send(p);
    };
    let verdict = run_probe(&engine, probe_threshold(), &sink).await;
    tracing::debug!(
        target: "myne::agent",
        event = "probe_returned",
        elapsed_ms = started.elapsed().as_millis() as u64,
        // Counts and a boolean. `ProbeVerdict::attempts` carries a `detail`
        // string per failed attempt, which is model output, so it is not logged
        // here.
        passed = verdict.as_ref().map(|v| v.passed).unwrap_or(false),
        passes = verdict.as_ref().map(|v| v.passes).unwrap_or(0),
        // What was actually ASKED. Since the early exit this is the number the
        // elapsed time above is explained by, and it differs from the threshold
        // whenever the verdict settled early.
        asked = verdict.as_ref().map(|v| v.attempts.len()).unwrap_or(0),
    );
    verdict
}

#[cfg(test)]
mod tests {
    /// `agent_start` sends the run's view BEFORE it drives the loop.
    ///
    /// The ordering is the entire fix (myne-md/myne#544): this command returns
    /// when the loop has stopped, so a send placed after `step(...)` would be
    /// indistinguishable from the return value it already had, and the first
    /// leg would stay a `running` run with no id, no scope total and no Stop.
    ///
    /// Read off the source, which is unusual and is the honest option here: the
    /// command needs an `AppHandle`, a `Channel` and five `State`s, none of
    /// which a unit test can build, so the alternative is not a better test but
    /// no test. Both anchors are asserted to exist first, so a rename fails by
    /// name rather than passing on a string this can no longer find.
    #[test]
    fn the_run_view_is_sent_before_the_loop_is_driven() {
        let src = include_str!("commands.rs");
        let start = src
            .find("pub async fn agent_start<R: Runtime>")
            .expect("agent_start is still named that");
        let body = &src[start..];
        let send = body
            .find("on_open.send(view)")
            .expect("agent_start still sends the view through the open channel");
        // `= step(`, not `    step(`: the call is bound to a local now, so that
        // its wall-clock can be logged after it returns (myne-md/myne#568), and
        // the indent-anchored needle stopped matching. Keyed on the binding
        // rather than on the bare name because `AgentStepResult` and the doc
        // comments above contain "step" too, and a needle that matches prose
        // would let the call itself move above the send while this test still
        // passed.
        let drive = body
            .find("= step(")
            .expect("agent_start still drives a step");
        assert!(
            send < drive,
            "the view must be sent before the loop is driven, or the first leg \
             has no id again and nothing can cancel it"
        );
    }

    /// Every command that consults the provider gate re-reads it first.
    ///
    /// `provider_gate.rs` says the gate is "host-side, and re-read at request
    /// time", and until myne-md/myne#456's review that was true of `ai_enabled`
    /// alone: the consent, the key and the model came from a cached snapshot
    /// filled by whichever surface last touched it. The compensating control for
    /// dropping `developer_mode` from the gate cannot be a cached one.
    ///
    /// Driven at the source, like `cli_bridge::socket`'s accept-loop test:
    /// asserting this behaviourally would mean standing up a real `AppHandle`
    /// and a vault. The three names are spelled out rather than derived, so a
    /// FOURTH gate-consulting command does not join silently; it fails review
    /// instead, which is where that decision belongs.
    #[test]
    fn every_gate_consulting_command_refreshes_the_snapshot_first() {
        let src = include_str!("commands.rs");
        for name in [
            "pub async fn agent_start",
            "pub async fn agent_approve_scope",
            "pub async fn agent_capability",
        ] {
            let at = src
                .find(name)
                .unwrap_or_else(|| panic!("{name} must exist"));
            let end = src[at..]
                .find("\n}\n")
                .map(|i| at + i)
                .unwrap_or_else(|| panic!("{name} must have a body"));
            let body = &src[at..end];
            let gate = body
                .find("require_ai_enabled")
                .unwrap_or_else(|| panic!("{name} must consult the gate"));
            let refresh = body.find("ai.refresh().await").unwrap_or_else(|| {
                panic!("{name} no longer refreshes the snapshot before the gate")
            });
            assert!(
                refresh > gate,
                "{name} refreshes before it checks ai_enabled, which reads the disk anyway; \
                 the refresh belongs after it so a refused request costs no prefs read"
            );
        }
    }
}
