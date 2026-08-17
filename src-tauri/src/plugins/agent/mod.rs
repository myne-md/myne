// SPDX-License-Identifier: AGPL-3.0
//! `agent` Tauri plugin: agentic note editing (myne-md/myne#529).
//!
//! The command **cores** live in `myne-core` (`myne_core::plugins::agent`), so
//! mobile inherits the loop rather than reimplementing it. What is here is the
//! desktop's own half: the adapters that satisfy core's seams out of the
//! existing AI, notes and snapshot machinery, the eight IPC commands, and the
//! `init()` wiring.
//!
//! ## Capability ACL
//!
//! `agent:default` bundles all eight, main-window-only.
//!
//! **Seven are unlock-gated and one is not, and the split is deliberate.**
//! `agent_start`, `agent_approve_scope`, `agent_preview_grant`, `agent_apply`,
//! `agent_undo`, `agent_last_run` and `agent_capability` reach the vault and
//! call `require_unlocked` first. **Five of those additionally re-read the
//! `ai_enabled` opt-in host-side**: `agent_start`, `agent_approve_scope`,
//! `agent_preview_grant`, `agent_apply` and `agent_capability`, the last
//! because asking a model whether it can hold the edit format is still asking a
//! model. **`agent_undo` and `agent_last_run` deliberately do not, and it is
//! one reason rather than two.** `agent_undo` WRITES, so its omission is the
//! one that needs arguing: it writes to put notes back, and gating the single
//! act that reverses a run on an opt-in the user may have just switched off
//! would leave the applied edits standing with no way to take them back. The
//! consent being withdrawn is consent to run the model, not consent to keep
//! what it already wrote. `agent_last_run` reads the record undo needs, so it
//! follows undo for the same reason: gating the read would disable the write it
//! feeds. `agent_cancel` touches only the run table, and a run that outlived
//! a lock is a teardown bug rather than something to refuse here.
//! `agent_capability`'s probe prompt is a compile-time constant, so no vault
//! data is involved even though it is gated. Borrowing
//! `State<'_, VaultRuntimeState>` gates nothing on its own; the guard function
//! is the gate.
//!
//! **`agent_status` was removed** (myne-md/myne#529 review round two). It was
//! declared, permitted, registered, mirrored in TypeScript and called by
//! nothing, which is an ACL grant the WebView can reach for no reason. The
//! surface reads a run's view from the step result it already receives.
//! `scripts/check-ipc-binding-callers.mjs` is what found it and is what stops
//! the next one.
//!
//! **Adding a command here is three edits, not one**: `build.rs`'s
//! `InlinedPlugin` command list, a `[[permission]]` block in
//! `permissions/agent/default.toml`, and the `generate_handler!` below. A
//! command that is declared and permitted but unregistered compiles, passes
//! clippy, renders its UI and is dead at runtime; the three-way ACL guard test
//! is what catches that.
//!
//! See: src-tauri/CLAUDE.md "Secret-handling logging discipline".

pub mod adapters;
pub mod commands;

pub use commands::AgentSessionState;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Drop every agent run and every transcript. The vault-lock teardown leg.
///
/// Total by requirement rather than by convenience. A run holds a note-id set
/// derived from decrypted plaintext, a transcript containing note bodies, and a
/// proposal built out of both; none of it may outlive the unlocked session. The
/// cancel-then-clear order inside `AgentRunState::clear` matters too: a loop
/// already past its cancel check must find the flag set rather than merely find
/// its run gone.
///
/// Both tables are cleared, and that pairing is the thing to keep true. Clearing
/// only core's run table would leave the transcript, which is the half that
/// actually holds note bodies.
pub fn teardown_on_lock<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(runs) =
        app.try_state::<std::sync::Arc<myne_core::plugins::agent::run::AgentRunState>>()
    {
        runs.clear();
    }
    if let Some(sessions) = app.try_state::<AgentSessionState>() {
        sessions.clear();
    }
}

/// The main window's grant for this plugin, added at RUNTIME rather than from
/// `capabilities/default.json`.
///
/// The same shape `local_inference` uses, for the same reason: this plugin is
/// compiled only under the `local-inference` feature, so a static capability
/// naming `agent:default` dangles in the `--no-default-features` build and the
/// ACL resolver fails on a namespace that was never declared. It sat in the
/// static file for four pipelines, but the build never got that far: the crate
/// stopped compiling first.
///
/// `agent:default` is the bundle in `permissions/agent/default.toml`, so the
/// eight `allow-<cmd>` identifiers stay defined in exactly one place and this
/// string cannot fall out of step with them.
const AGENT_CAPABILITY: &str = r#"{
  "identifier": "agent",
  "description": "Agentic note editing for the main window (myne-md/myne#529): start, resume, cancel and inspect an agent run, apply the edits the user approved, and report whether the configured backend can hold the edit format. Every command reaches decrypted note plaintext and two of them WRITE, so this grant is main-window-only, exactly as the static entry it replaces was.",
  "windows": ["main"],
  "permissions": ["agent:default"]
}"#;

/// Construct the `agent` plugin.
///
/// Registers two pieces of state: core's run table (the approved scope and the
/// cancel flag) and the host's session table (the transcript). Both are cleared
/// by the vault-lock teardown, and the pair is deliberate rather than
/// accidental: the scope is what every module needs and belongs in core, while a
/// growing message list is a host session concern.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("agent")
        .setup(|app, _api| {
            app.manage(std::sync::Arc::new(
                myne_core::plugins::agent::run::AgentRunState::default(),
            ));
            app.manage(AgentSessionState::default());
            app.add_capability(AGENT_CAPABILITY)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent_start,
            commands::agent_approve_scope,
            commands::agent_preview_grant,
            commands::agent_cancel,
            commands::agent_apply,
            commands::agent_undo,
            commands::agent_last_run,
            commands::agent_capability,
        ])
        .build()
}

#[cfg(test)]
mod acl_registration_guard {
    use super::AGENT_CAPABILITY;

    /// **An ACL entry does not wire a command, and nothing checks that it
    /// does** (`src-tauri/CLAUDE.md`). An agent command with its
    /// `[[permission]]` block, its `[default]` bundle listing and a frontend
    /// caller, but missing from `generate_handler!`, compiles, passes clippy,
    /// renders its UI and is **dead at runtime**: the invoke rejects.
    ///
    /// The `prefs` and `local_inference` twin of this guard. Four sources are
    /// read out of the files and compared **both directions**, because a
    /// one-directional check would pass while a registered-but-unpermitted
    /// command sat there fail-closed.
    ///
    /// This plugin's arm additionally checks `build.rs`, which `prefs` cannot:
    /// every agent command IS named in its `InlinedPlugin` list, so a command
    /// added there and nowhere else is caught too. Do not copy that half to a
    /// plugin whose commands rely on hand-written blocks instead.
    #[test]
    fn every_permitted_agent_command_is_registered_and_vice_versa() {
        let toml = include_str!("../../../permissions/agent/default.toml");
        let shim = include_str!("mod.rs");
        let build_rs = include_str!("../../../build.rs");

        // 1. The `[default]` bundle: which identifiers are actually granted. An
        //    identifier with a block but no bundle listing is refused at
        //    runtime, fail-closed and invisible from the block itself.
        let bundle_start = toml
            .find("permissions = [")
            .expect("the [default] bundle must list its permissions");
        let bundle_end = bundle_start
            + toml[bundle_start..]
                .find(']')
                .expect("unterminated permissions list");
        let mut granted: Vec<String> = toml[bundle_start..bundle_end]
            .split('"')
            .filter_map(|t| t.strip_prefix("allow-"))
            .map(|t| t.replace('-', "_"))
            .collect();
        granted.sort();
        granted.dedup();

        // 2. Every `commands.allow = [...]`: what each block actually permits.
        let mut permitted: Vec<String> = toml
            .lines()
            .filter_map(|l| l.trim().strip_prefix("commands.allow = ["))
            .flat_map(|rest| {
                rest.split('"')
                    .filter(|t| {
                        !t.is_empty() && t.chars().all(|c| c.is_ascii_lowercase() || c == '_')
                    })
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .collect();
        permitted.sort();
        permitted.dedup();

        // 3. `generate_handler!`: the only thing that actually wires a command.
        let gh_start = shim
            .find("generate_handler![")
            .expect("the agent plugin must register a handler list");
        let gh_end = gh_start
            + shim[gh_start..]
                .find(']')
                .expect("unterminated generate_handler!");
        let mut registered: Vec<String> = shim[gh_start..gh_end]
            .lines()
            .filter_map(|l| l.trim().strip_prefix("commands::"))
            .map(|l| l.trim_end_matches(',').trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        registered.sort();
        registered.dedup();

        // 4. `build.rs`'s InlinedPlugin arm.
        let arm_start = build_rs
            .find("\"agent\",")
            .expect("build.rs must declare the agent plugin, or the ACL namespace never exists");
        let arm_end = arm_start
            + build_rs[arm_start..]
                .find("]),")
                .expect("unterminated agent InlinedPlugin arm");
        let mut declared: Vec<String> = build_rs[arm_start..arm_end]
            .split('"')
            .filter(|t| t.starts_with("agent_"))
            .map(str::to_string)
            .collect();
        declared.sort();
        declared.dedup();

        // Non-vacuity, first: an extraction that silently returned nothing makes
        // every comparison below pass against an empty set, which is the exact
        // failure this whole family of checks keeps producing.
        for (name, list) in [
            ("granted", &granted),
            ("permitted", &permitted),
            ("registered", &registered),
            ("declared", &declared),
        ] {
            assert!(
                !list.is_empty(),
                "the {name} extraction returned nothing, so every comparison below \
                 would compare an empty set against an empty set"
            );
        }

        // Then the comparisons, which NAME the offending command. This ordering
        // is load-bearing and was corrected after an injection: with the exact
        // count asserted first, dropping one command from `generate_handler!`
        // failed with "registered=8" and left the reader to work out WHICH of
        // the nine was missing, while the very next assertion had the name.
        assert_eq!(
            granted, permitted,
            "the [default] bundle and the [[permission]] blocks disagree; an identifier \
             in one and not the other is refused at runtime"
        );
        for cmd in &permitted {
            assert!(
                registered.contains(cmd),
                "agent command {cmd:?} is permitted but NOT in generate_handler!: it \
                 compiles, renders its UI, and its invoke rejects at runtime"
            );
            assert!(
                declared.contains(cmd),
                "agent command {cmd:?} is permitted but missing from build.rs"
            );
        }
        for cmd in &registered {
            assert!(
                permitted.contains(cmd),
                "agent command {cmd:?} is registered but has no permission: the ACL is \
                 fail-closed, so every call is refused"
            );
        }
        for cmd in &declared {
            assert!(
                registered.contains(cmd),
                "agent command {cmd:?} is declared in build.rs but never registered"
            );
        }

        // The count floor, last. The comparisons above prove the four sources
        // AGREE; they cannot prove the four are not all missing the same
        // command, which is what a whole-command deletion looks like. Nine is
        // the roster as it stands, so shipping a tenth is an edit here too.
        assert_eq!(
            (
                granted.len(),
                permitted.len(),
                registered.len(),
                declared.len()
            ),
            (8, 8, 8, 8),
            "the agent plugin's command roster changed; update this floor in the same \
             change that adds or removes a command"
        );
    }

    /// The plugin's capability bundle has to be granted to the main window, or
    /// all eight are refused however well the four sources above agree.
    ///
    /// **Asserted on the RUNTIME grant, and on the static file's SILENCE.** The
    /// grant used to live in `capabilities/default.json`, which this test read.
    /// That is wrong now in a way that does not show at runtime: this plugin
    /// compiles only under `local-inference`, so a static entry naming
    /// `agent:default` dangles in the `--no-default-features` build, where the
    /// namespace `build.rs` would have declared it under is absent too.
    ///
    /// Both directions, because each alone passes while the other is broken: a
    /// runtime capability that lost its permission grants nothing, and a static
    /// entry that came back breaks the auditable build rather than this one.
    #[test]
    fn the_agent_capability_bundle_is_granted_to_the_main_window_at_runtime() {
        let cap: serde_json::Value =
            serde_json::from_str(AGENT_CAPABILITY).expect("AGENT_CAPABILITY must be valid JSON");
        assert_eq!(
            cap["permissions"].as_array().map(Vec::as_slice),
            Some(&[serde_json::json!("agent:default")][..]),
            "the runtime capability must grant exactly the agent:default bundle"
        );
        assert_eq!(
            cap["windows"].as_array().map(Vec::as_slice),
            Some(&[serde_json::json!("main")][..]),
            "every command here reaches note plaintext and two of them write, \
             so the grant stays main-window-only"
        );

        let caps = include_str!("../../../capabilities/default.json");
        assert!(
            !caps.contains("agent:default"),
            "capabilities/default.json must NOT name agent:default: the plugin is \
             feature-gated, so a static grant dangles in the --no-default-features \
             build. The grant is added at runtime by init(), where the plugin exists."
        );
    }
}
