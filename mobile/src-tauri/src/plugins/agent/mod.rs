// SPDX-License-Identifier: AGPL-3.0
//! `agent` Tauri plugin for the mobile client (myne-md/myne#456).
//!
//! The command cores live in `myne-core`, and since myne-md/myne#456 so does the
//! host-generic half of the command surface, so what is here is this client's
//! own wiring: the two seams that genuinely differ (its registry and its
//! full-text searcher), the nine IPC wrappers, and `init()`.
//!
//! ## Capability ACL
//!
//! `agent:default` bundles all nine, main-window-only. The guard split is the
//! same one the desktop plugin documents, because both clients call the same
//! guard functions: seven are unlock-gated, five of those additionally re-read
//! the `ai_enabled` opt-in host-side, and `agent_cancel` is gated on neither
//! because it touches only the run table.
//!
//! **`agent_undo` writes and is deliberately not opt-in-gated.** It writes to
//! put notes back, and gating the single act that reverses a run on an opt-in
//! the user may have just switched off would leave the applied edits standing
//! with no way to take them back. `agent_last_run` reads the record undo needs,
//! so it follows undo for the same reason.
//!
//! **Adding a command here is three edits, not one**: `build.rs`'s
//! `InlinedPlugin` command list, a `[[permission]]` block in
//! `permissions/agent/default.toml`, and the `generate_handler!` below. A
//! command that is declared and permitted but unregistered compiles, passes
//! clippy, renders its UI and is dead at runtime.
//!
//! See: src-tauri/CLAUDE.md "Secret-handling logging discipline".

pub mod adapters;
pub mod commands;
pub mod state;

pub use myne_core::plugins::agent::host_commands::AgentSessionState;
pub use state::AgentInferenceState;

use std::sync::{Arc, RwLock};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Drop every agent run and every transcript. The vault-lock teardown leg.
///
/// **Total by requirement rather than by convenience**, and on this client the
/// requirement is sharper than on desktop: a run dies with the foreground here,
/// so this is not only the lock path but the ordinary way a run ends
/// (`docs/decisions/ai/…`, myne-md/myne#456). A run holds a note-id set derived
/// from decrypted plaintext, a transcript containing note bodies, and a proposal
/// built out of both; none of it may outlive the unlocked session.
///
/// The cancel-then-clear order inside `AgentRunState::clear` matters: a loop
/// already past its cancel check must find the flag set rather than merely find
/// its run gone.
///
/// Both tables are cleared, and that pairing is the thing to keep true.
/// Clearing only the run table would leave the transcript, which is the half
/// that actually holds note bodies.
pub fn teardown_on_lock<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(runs) = app.try_state::<Arc<myne_core::plugins::agent::run::AgentRunState>>() {
        runs.clear();
    }
    if let Some(sessions) = app.try_state::<AgentSessionState>() {
        sessions.clear();
    }
}

/// Construct the `agent` plugin.
/// The vault unlocked right now, or `None`.
///
/// The selection refuses to route remote unless the preferences snapshot was
/// read from the SAME vault that is open, which is a real refusal rather than a
/// belt: prefs are per vault, so a snapshot from the previous one would let a
/// vault the user did not configure for AI inherit another's provider.
fn active_vault_reader<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> myne_core::inference::state::ActiveVaultReader {
    Arc::new(move || {
        app.try_state::<myne_core::plugins::vault_unlock::state::VaultRuntimeState>()?
            .active_vault_id_now()
    })
}

/// Read the preferences and stamp the vault they came from.
///
/// Without this the snapshot cell is never filled, `active()` short-circuits to
/// the local arm, and every run on this phone answers `NoModel`. See
/// `AgentInferenceState::new`.
fn prefs_reader<R: Runtime>(app: tauri::AppHandle<R>) -> myne_core::inference::state::PrefsReader {
    Arc::new(move || {
        let app = app.clone();
        Box::pin(async move {
            let vault =
                app.try_state::<myne_core::plugins::vault_unlock::state::VaultRuntimeState>()?;
            let dir =
                myne_core::paths::active_vault_root_io(&app, vault.active_vault_id().await).ok()?;
            let prefs = myne_core::plugins::prefs::commands::prefs_read_with_dir(
                &dir,
                &vault,
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .ok()?;
            Some(myne_core::inference::state::PrefsSnapshot {
                prefs,
                vault_id: vault.active_vault_id().await,
            })
        })
    })
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("agent")
        .setup(|app, _api| {
            app.manage(Arc::new(
                myne_core::plugins::agent::run::AgentRunState::default(),
            ));
            app.manage(AgentSessionState::default());
            // The preferences snapshot the registry and the remote engine BOTH
            // read. One cell, handed to both, so the engine and the seam cannot
            // disagree about what the preferences say.
            //
            // The cancel source is `|| false` here and the run's own flag is
            // what actually stops a request: the adapter is rebuilt per run in
            // `AgentInferenceState::engine_adapter`, bound to that run's flag.
            // A registry-level source would be a flag no run writes to.
            let cell: myne_core::inference::state::PrefsCell = Arc::new(RwLock::new(None));
            app.manage(AgentInferenceState::new(
                cell,
                Arc::new(|| false),
                prefs_reader(app.clone()),
                active_vault_reader(app.clone()),
            ));
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
            commands::agent_list_provider_models,
        ])
        .build()
}

#[cfg(test)]
mod acl_tests {
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
    ///
    /// **Written after an injection proved the obvious check was the wrong
    /// one** (myne-md/myne#456). The task this landed under claimed a missing
    /// ACL row would fail the BUILD. It does not: dropping `allow-agent-apply`
    /// from the `[default]` bundle compiles clean and refuses at invoke time,
    /// silently, on a phone. Four sources compared both directions is what
    /// actually catches it, which is why desktop has this test and why this
    /// client now does too.
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
        // command, which is what a whole-command deletion looks like. EIGHT is
        // the roster as it stands, so shipping a ninth is an edit here too.
        // (This comment said nine directly above an assertion of eight, from
        // the round-two removal of `agent_status`, myne-md/myne#531 review
        // round five. A prose number beside the number it describes is the one
        // place drift is both cheapest to introduce and most misleading.)
        assert_eq!(
            (
                granted.len(),
                permitted.len(),
                registered.len(),
                declared.len()
            ),
            (9, 9, 9, 9),
            "the agent plugin's command roster changed; update this floor in the same \
             change that adds or removes a command"
        );
    }

    /// The plugin's capability bundle has to be granted to the main window, or
    /// all nine are refused however well the four sources above agree.
    /// The bundle is granted, and it is granted to the main window only.
    ///
    /// **Asserted on the STATIC file, unlike desktop's.** That plugin compiles
    /// only under the `local-inference` cargo feature, so a static entry naming
    /// `agent:default` would dangle in the `--no-default-features` build, where
    /// the namespace `build.rs` declares is absent too; it adds its capability
    /// at runtime instead. This client has no such feature: the agent is
    /// either present or it does not exist here, so the grant belongs in the
    /// file, where a reviewer sees it.
    ///
    /// Main-window-only is the load-bearing half: every command in this plugin
    /// reaches decrypted note plaintext and two of them WRITE.
    #[test]
    fn the_agent_bundle_is_granted_to_the_main_window() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../../../capabilities/default.json"))
                .expect("capabilities/default.json must be valid JSON");
        let permissions = caps["permissions"]
            .as_array()
            .expect("the capability file must list permissions");
        assert!(
            permissions.iter().any(|p| p == "agent:default"),
            "capabilities/default.json must grant agent:default, or every agent \
             command is refused at runtime with nothing saying why"
        );
        assert_eq!(
            caps["windows"].as_array().map(Vec::as_slice),
            Some(&[serde_json::json!("main")][..]),
            "every command in this plugin reaches note plaintext and two of them \
             write, so the grant stays main-window-only"
        );
    }
}
