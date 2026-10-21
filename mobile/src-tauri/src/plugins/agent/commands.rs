// SPDX-License-Identifier: AGPL-3.0
//! The mobile agent plugin's IPC surface (myne-md/myne#456).
//!
//! Nine `#[tauri::command]` wrappers and nothing else. The host-generic half:
//! the session table, the guards, the scope source, the result types and `step`
//! itself, lives in [`myne_core::plugins::agent::host_commands`], shared with
//! desktop, because both clients drive a run through the identical sequence.
//!
//! **What differs, and it is only this:** the `State<'_, …>` list, and the two
//! seams `step` takes as trait objects. Desktop resolves a `LocalInferenceState`
//! carrying a Candle engine and a `LocalInferenceVectorState` to search; this
//! client resolves an [`AgentInferenceState`] whose registry has no local model
//! at all, and searches the full-text index instead.
//!
//! **A run on a phone is always a remote run**, which is not a limitation this
//! file works around but the decision it implements: on-device inference is out
//! of scope on mobile, so the registry's local arm is
//! [`myne_core::inference::state::NoLocalEngine`] and it answers `NoModel`. An
//! ambient request is therefore refused rather than being quietly routed
//! off-device, which is what the registry's ambient-versus-remote rule requires
//! and what a `StubEngine` in that slot would have broken by fabricating an
//! answer.
//!
//! Which guards apply per command is the same split desktop documents, because
//! these are the same guard functions.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline".

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use myne_core::host::tauri_host::TauriHost;
use myne_core::inference::provider_registry::{list_models_gated, ProviderModel};
use myne_core::inference::provider_transport::ProviderTransport;
use myne_core::plugins::agent::apply::{ApplyOutcome, Approval};
use myne_core::plugins::agent::edit::ProposedEdit;
use myne_core::plugins::agent::error::AgentError;
use myne_core::plugins::agent::history::{
    history_budget, seed_messages, HistoryTurn, SeedControls,
};
use myne_core::plugins::agent::host_adapters::MemoryAdapter;
use myne_core::plugins::agent::host_commands::{
    apply_from_host, probe_threshold, require_ai_enabled, require_unlocked, step, undo_from_host,
    AgentSessionState, AgentStepResult, AgentUndoResult, GrantPreview, HostScopeSource,
};
use myne_core::plugins::agent::probe::{run_probe, ProbeProgress, ProbeVerdict};
use myne_core::plugins::agent::prompt::ProposedSetting;
use myne_core::plugins::agent::prompt::{documents_from, Document};
use myne_core::plugins::agent::run::{
    new_run_id, AgentRunState, AgentRunView, AppliedRun, GrantOrigin,
};
use myne_core::plugins::agent::run_loop::RunProgress;
use myne_core::plugins::agent::scope::{expand_run, preview_grant, start_run, ScopeGrant};
use myne_core::plugins::prefs::commands::prefs_read_from_host;
use myne_core::plugins::vault_indices::state::VaultIndicesState;
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use myne_core::search::SearchIndexState;
use myne_core::vault_io::StdVaultIo;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};

use super::adapters::MobileSearchAdapter;
use super::state::AgentInferenceState;

/// Start a run: resolve the initial scope, then drive until it stops.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_start<R: Runtime>(
    app: AppHandle<R>,
    task: String,
    grant: ScopeGrant,
    // The visible conversation and the interface language, read at run start
    // like desktop does (myne-md/myne#648). Declared here because the shared
    // binding sends both on every call and Tauri drops unknown arguments
    // silently — without these the phone's runs answer in English about a
    // conversation they cannot see, and nothing complains.
    language: Option<String>,
    history: Vec<HistoryTurn>,
    // Declared for the same reason `language` and `history` above are: the
    // shared binding sends it on every call and Tauri drops an unknown argument
    // SILENTLY, so a phone that did not declare this would offer no settings and
    // refuse every `set_setting` with nothing saying why (myne-md/myne#850).
    settings: Vec<String>,
    // The documents the user attached to this run (myne-md/myne#913): their
    // extracted text, which the composer read from the vault. Declared on BOTH
    // clients even where no picker exists yet, because the shared binding sends
    // it on every call and Tauri drops an unknown argument silently: a client
    // that did not declare it would ignore an attachment it was handed and
    // answer about a file it cannot see, with nothing complaining.
    attachments: Vec<Document>,
    on_open: Channel<AgentRunView>,
    on_progress: Channel<RunProgress>,
    runs: State<'_, Arc<AgentRunState>>,
    sessions: State<'_, AgentSessionState>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
    ai: State<'_, AgentInferenceState>,
    search: State<'_, SearchIndexState>,
    hooks: State<'_, myne_core::hooks::Hooks>,
) -> Result<AgentStepResult, AgentError> {
    require_unlocked(&vault).await?;
    require_ai_enabled(&app, &vault).await?;
    // **Re-read the preferences into the snapshot the SELECTION consults**, at
    // the top of every command that can reach a provider, exactly as desktop
    // does. The registry answers from a cached snapshot, so without this the
    // cell stays empty and `active()` short-circuits to the local arm, which on
    // this client refuses everything. It is also what makes a revoked provider
    // stop answering on the next call rather than the next launch.
    ai.refresh().await;
    let source = HostScopeSource {
        app: app.clone(),
        vault: vault.inner(),
        indices: indices.inner(),
    };
    let run_id = new_run_id();
    let (resolved, cancel) = start_run(&runs, run_id.clone(), &grant, &source).await?;
    // Seeded exactly as desktop seeds: the budget read at run start from this
    // client's own prefs read, the seed dropped by `step` when the live
    // controls no longer match the snapshot below (myne-md/myne#648).
    let prefs = prefs_read_from_host(&TauriHost::new(app.clone()), vault.inner(), &StdVaultIo)
        .await
        .map_err(|_| AgentError::ReadFailed)?;
    let seed = seed_messages(&history, history_budget(&prefs));
    let seed_controls = if seed.is_empty() {
        None
    } else {
        Some(SeedControls::from_view(&prefs))
    };
    // Budgeted and wrapped HERE, at the command boundary, because the cap and
    // the untrusted tagging are host policy: `documents_from` truncates each
    // document and marks the truncation, and every span that carries text is a
    // `Content::UntrustedNote`, so it is sanitized and counted in the off-device
    // figure by the same code that handles note bodies.
    let documents = documents_from(attachments);
    sessions.open(
        &run_id,
        task,
        &runs.live_ids(),
        language,
        seed,
        documents,
        seed_controls,
        settings,
    );
    // Before the loop, not after it: this call returns only when the loop has
    // stopped, and until then the surface would have a `running` run with no id
    //: no status, no scope total and no Stop, on a run that is at that moment
    // sending note text to a provider. A failed send is ignored, because a
    // closed channel means the surface let go of this run.
    if let Ok(view) = runs.view(&run_id) {
        let _ = on_open.send(view);
    }
    // Built before the call because `step` takes `app` by value.
    let tauri_host = TauriHost::new(app.clone());
    let memory = MemoryAdapter {
        host: &tauri_host,
        state: vault.inner(),
        hooks: hooks.inner().clone(),
    };
    step(
        app,
        run_id,
        Arc::clone(&runs),
        &sessions,
        &indices,
        &vault,
        &ai.engine_adapter(Arc::clone(&cancel)),
        &MobileSearchAdapter {
            search: search.inner(),
        },
        // The run's memory store (myne-md/myne#697): the shared
        // `MemoryAdapter`, same as desktop wires.
        Some(&memory),
        cancel,
        resolved.excluded_count,
        on_progress,
    )
    .await
}

/// Approve a scope expansion the model asked for, and resume the run.
///
/// The origin is `Model`, because this command exists to answer a request the
/// model made. A user-initiated widening comes in through `agent_start`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_approve_scope<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    grant: ScopeGrant,
    on_progress: Channel<RunProgress>,
    runs: State<'_, Arc<AgentRunState>>,
    sessions: State<'_, AgentSessionState>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
    ai: State<'_, AgentInferenceState>,
    search: State<'_, SearchIndexState>,
    hooks: State<'_, myne_core::hooks::Hooks>,
) -> Result<AgentStepResult, AgentError> {
    require_unlocked(&vault).await?;
    require_ai_enabled(&app, &vault).await?;
    // **Re-read the preferences into the snapshot the SELECTION consults**, at
    // the top of every command that can reach a provider, exactly as desktop
    // does. The registry answers from a cached snapshot, so without this the
    // cell stays empty and `active()` short-circuits to the local arm, which on
    // this client refuses everything. It is also what makes a revoked provider
    // stop answering on the next call rather than the next launch.
    ai.refresh().await;
    let source = HostScopeSource {
        app: app.clone(),
        vault: vault.inner(),
        indices: indices.inner(),
    };
    let resolved = expand_run(&runs, &run_id, &grant, GrantOrigin::Model, &source).await?;
    // The run's OWN flag, not a fresh one seeded from its current value: a copy
    // is a flag nothing else writes to, so Stop and the lock teardown would both
    // be inert for this leg.
    let cancel = runs.cancel_flag(&run_id)?;
    // Built before the call because `step` takes `app` by value.
    let tauri_host = TauriHost::new(app.clone());
    let memory = MemoryAdapter {
        host: &tauri_host,
        state: vault.inner(),
        hooks: hooks.inner().clone(),
    };
    step(
        app,
        run_id,
        Arc::clone(&runs),
        &sessions,
        &indices,
        &vault,
        &ai.engine_adapter(Arc::clone(&cancel)),
        &MobileSearchAdapter {
            search: search.inner(),
        },
        // The run's memory store (myne-md/myne#697): the shared
        // `MemoryAdapter`, same as desktop wires.
        Some(&memory),
        cancel,
        resolved.excluded_count,
        on_progress,
    )
    .await
}

/// What a grant would resolve to, without committing it.
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
///
/// No unlock guard and no opt-in guard, deliberately: this touches only the run
/// table, and a run that outlived a lock is a teardown bug rather than something
/// to refuse here.
#[tauri::command]
pub async fn agent_cancel(
    run_id: String,
    runs: State<'_, Arc<AgentRunState>>,
) -> Result<bool, AgentError> {
    Ok(runs.cancel(&run_id))
}

/// Apply the edits the user approved on the review screen.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_apply<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    approved: Vec<ProposedEdit>,
    approved_new_notes: Vec<usize>,
    // Declared for the same reason `language` and `history` are on
    // `agent_start`: the shared binding sends it and Tauri drops an unknown
    // argument silently, so a phone that did not declare this would refuse every
    // setting change with nothing saying why (myne-md/myne#850).
    approved_settings: Vec<ProposedSetting>,
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
        approved_settings,
        approval,
        runs.inner(),
        sessions.inner(),
        indices.inner(),
        vault.inner(),
        hooks.inner(),
    )
    .await
}

/// The run that can still be undone, if any.
///
/// No opt-in guard, and that is the same reason `agent_undo` has none: gating
/// the read would disable the write it feeds.
#[tauri::command]
pub async fn agent_last_run(
    runs: State<'_, Arc<AgentRunState>>,
    vault: State<'_, VaultRuntimeState>,
) -> Result<Option<AppliedRun>, AgentError> {
    require_unlocked(&vault).await?;
    Ok(runs.last_applied())
}

/// Put the notes an applied run wrote back the way they were.
///
/// **No `ai_enabled` guard, and it WRITES**, so the omission is the one that
/// needs arguing: it writes to put notes back, and gating the single act that
/// reverses a run on an opt-in the user may have just switched off would leave
/// the applied edits standing with no way to take them back. The consent being
/// withdrawn is consent to run the model, not consent to keep what it wrote.
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

/// The models the named provider currently publishes.
///
/// **The other half of "Myne ships no model default"**: the user picks from a
/// list, and the list has to come from somewhere. It comes from the provider, at
/// the moment the user opens the chooser, never from a constant in this tree:
/// which would rot and would re-create the pinned-tag problem the decision
/// rejected.
///
/// **It is an egress, gated exactly like a completion.** Asking a provider "what
/// models do you have" over an authenticated connection tells that provider this
/// account exists and is active. It fetches model NAMES and never weights, which
/// is what keeps it on the permitted side of the pull-or-download line.
///
/// Named `agent_…` and living in this plugin because on this client the agent is
/// the only consumer of a remote provider: there is no local-inference plugin
/// here for it to belong to, and a second plugin for one command would be a
/// second ACL namespace to keep honest.
#[tauri::command]
pub async fn agent_list_provider_models<R: Runtime>(
    app: AppHandle<R>,
    vault: State<'_, VaultRuntimeState>,
) -> Result<Vec<ProviderModel>, AgentError> {
    require_unlocked(&vault).await?;
    require_ai_enabled(&app, &vault).await?;
    let host = TauriHost::new(app.clone());
    let prefs = prefs_read_from_host(&host, vault.inner(), &StdVaultIo)
        .await
        .map_err(|_| AgentError::ReadFailed)?;
    // The gate first, and the network only after it says yes. Written in this
    // order on purpose: an implementation that connected and then checked would
    // satisfy every assertion about the RESULT while still having sent a byte.
    list_models_gated(&prefs, |provider, key| {
        let transport = ProviderTransport::new(provider.host());
        transport.get_json(provider.models_path(), key)
    })
    .await
    .map_err(|_| AgentError::ProviderFailed)
}

/// Whether agent mode can run on the configured backend, and why not.
#[tauri::command]
pub async fn agent_capability<R: Runtime>(
    app: AppHandle<R>,
    on_attempt: Channel<ProbeProgress>,
    ai: State<'_, AgentInferenceState>,
    vault: State<'_, VaultRuntimeState>,
) -> Result<ProbeVerdict, AgentError> {
    require_unlocked(&vault).await?;
    // Gated on the opt-in even though the probe prompt is a compile-time
    // constant: asking a model whether it can hold the edit format is still
    // asking a model, and on this client that means sending a request to a
    // remote provider.
    require_ai_enabled(&app, &vault).await?;
    // **Re-read the preferences into the snapshot the SELECTION consults**, at
    // the top of every command that can reach a provider, exactly as desktop
    // does. The registry answers from a cached snapshot, so without this the
    // cell stays empty and `active()` short-circuits to the local arm, which on
    // this client refuses everything. It is also what makes a revoked provider
    // stop answering on the next call rather than the next launch.
    ai.refresh().await;
    let engine = ai.engine_adapter(Arc::new(AtomicBool::new(false)));
    let sink = move |p: ProbeProgress| {
        let _ = on_attempt.send(p);
    };
    run_probe(&engine, probe_threshold(), &sink).await
}
