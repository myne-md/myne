// SPDX-License-Identifier: AGPL-3.0
//! The CLI terminal-access door: a local socket bound to the running,
//! unlocked desktop (cli-thin-client task 3; MYND-490).
//!
//! `docs/decisions.md` "CLI terminal access is a default-off, unlock-gated
//! local socket with a folder exclusion list (MYND-490)" and
//! `docs/threat-model.md` §7 are the governing spec entries (task 1 of this
//! feature) — read them before changing anything here. In one line: the
//! command socket exists ONLY while `cli_enabled` is true AND the vault is
//! unlocked, created the instant both hold and torn down the instant either
//! stops holding, so auto-lock closes the door with NO CLI-specific code
//! path. **`auto_lock.rs` is untouched by this feature** — see that file's
//! own docs for why CLI activity must never reset the idle timer: resetting
//! it would benefit only a background script, silently piercing the A6
//! guarantee this door's threat-model entry names as intact.
//!
//! ## Shape
//!
//! - [`gate`] — pure classification of `(cli_enabled, unlocked)` into a
//!   [`gate::DoorState`]. No IO, no socket — the decision core, unit-tested
//!   without a runtime.
//! - [`socket`] — the command-socket transport: a Unix domain socket on
//!   macOS/Linux (owner-only 0600, `clipper::relay`'s posture); the Windows
//!   named-pipe bind is a documented seam matching `clipper::relay`'s own
//!   existing Unix-only posture.
//! - [`framing`] — the bounded, panic-free length-prefixed frame reader the
//!   command socket's connections use. Content dispatch is task 4's job.
//! - [`status`] — the `cli-status` marker that lets a CLI (task 4) tell
//!   "vault locked" apart from "CLI access disabled" apart from "app not
//!   running", even though the command socket's mere absence collapses the
//!   first two into one observable (connection refused).
//! - [`scope`] — the central `cli_excluded_folders` enforcement point (task
//!   5): every command that hands a note (or a write destination) across the
//!   wire filters through this module rather than re-deriving the check.
//! - [`compose`] — plaintext composition for `myne new` (task 8): structural
//!   folder-path normalization + frontmatter injection, the narrow Rust
//!   re-implementation of the TS-side writer surgery this socket-only
//!   dispatch path cannot reach.
//! - [`rate_limit`] — the default-on, removable command-socket rate limit
//!   (task 10). A slowdown against a runaway script, NOT a protection —
//!   read that module's own opening paragraph before writing any copy that
//!   mentions it.
//! - [`path_shim`] — how the bundled sidecar becomes a typeable command
//!   (task 11): a `~/.local/bin/myne` launcher reconciled on every startup,
//!   which never clobbers a `myne` it did not write and is deliberately NOT
//!   gated on `cli_enabled` (a refusal you can only read if the command
//!   exists). The bundling half is `tauri.conf.json`'s `externalBin` plus
//!   `scripts/build-cli-sidecar.mjs`.
//! - [`activity`] — the session-memory "when did the door last serve a
//!   command" marker behind the Settings last-access line (task 12). RAM
//!   only; read that module's docs before considering persisting it.
//! - [`plugin`] — the one narrow, read-only `cli-bridge` IPC command Settings
//!   reads for the two facts that are NOT `vault.prefs` fields: the
//!   last-access age and whether `myne` is typeable at all (task 12).
//! - [`daily`] — `myne daily`/`daily:append` (task 9): resolves today's
//!   daily note through the same folder/template/naming rules the app's
//!   own "open today's note" flow uses, via
//!   `myne_core::plugins::notes::daily_match`'s Rust port of the TS match
//!   predicate and the shared `protocol::template` render engine.
//!
//! ## Why polling, not a push hook
//!
//! [`spawn_lifecycle_supervisor`] is a `tokio` task that re-evaluates the
//! gate on a short fixed interval ([`SUPERVISOR_TICK`]) — the exact shape
//! `plugins::sync::poke_listener::spawn_poke_supervisor` and
//! `auto_lock::spawn_idle_lock_timer` already use for "does a background
//! resource's lifetime match the current unlock/config state" decisions.
//! `cli_enabled` is a per-vault ENCRYPTED preference (`vault.prefs`), so it
//! can only be read while `Slot::Unlocked` — there is no push event to hook
//! for "the vault just locked, and by the way here was the last config we
//! saw" other than caching the last read. The supervisor keeps that cache
//! as plain loop-local state (never written back to `VaultRuntimeState`,
//! never persisted): each tick, while unlocked, it re-reads `vault.prefs`
//! and refreshes the cache; while locked, it reuses the cache from the last
//! unlocked tick (a lock cannot itself flip `cli_enabled` — only an
//! unlocked-gated setter writes it — so the cached value is exactly what
//! the vault last actually held). A tick lands within [`SUPERVISOR_TICK`]
//! of the real transition, the same latency bound the sync poke supervisor
//! already accepts for its own start/stop decision.
//!
//! **The cache is keyed to the vault it was read from, and a read failure
//! while unlocked resolves to `false`.** Both are fail-closed corrections to
//! the shape above, and both matter for the same reason: "a lock cannot flip
//! `cli_enabled`" is true of ONE vault, and the cache would otherwise outlive
//! its own. Unlock vault A with the door on → lock → unlock vault B with the
//! door off, and an unkeyed cache carries A's `true` into B for as long as
//! B's prefs read keeps failing, binding the socket and serving **B's** notes
//! against a setting B never had. Keying the cache retires A's answer the
//! moment the active vault id changes; resolving a failed read to `false`
//! means the door closes for a tick rather than staying open on a value
//! nothing just confirmed. Every other gate in this module is fail-closed —
//! this one is too.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — this
//! module and its submodules touch no note content, no note id, no folder
//! name and no filesystem path in any log line; this module's own logging
//! stays inside the ALLOW list: bounded stage/event tags only. That is no
//! longer only a claim — [`logging_discipline`] (task 13) enforces it two
//! ways: a `TRACE`-level capture across every dispatch path, and a source
//! audit of every `tracing::` call site in this directory against a
//! field-name and value allowlist. **A new log site here will fail that
//! audit until its field is allowlisted**, which is the intended stop: read
//! the DENY list before adding one. The CLI's own half of the same
//! discipline lives in `cli/src/logging_discipline.rs` plus the end-to-end
//! `cli/tests/logging_discipline.rs`.

pub mod activity;
pub mod compose;
pub mod daily;
pub mod dispatch;
pub mod framing;
pub mod gate;
#[cfg(test)]
mod logging_discipline;
pub mod path_shim;
#[cfg(windows)]
mod pipe;
pub mod plugin;
pub mod rate_limit;
pub mod scope;
pub mod socket;
pub mod status;

#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use tauri::{AppHandle, Manager, Runtime};

#[cfg(unix)]
use crate::plugins::vault_unlock::state::VaultRuntimeState;
#[cfg(unix)]
use gate::DoorState;

/// Supervisor decision cadence — matches
/// `plugins::sync::poke_listener::SUPERVISOR_TICK_MS`, the existing
/// precedent for "gate a background resource on live unlock state".
#[cfg(unix)]
const SUPERVISOR_TICK: Duration = Duration::from_millis(1_000);

/// Spawn the CLI bridge's lifecycle supervisor for the process lifetime.
/// Wired from the app `setup` hook (`lib.rs`), alongside
/// `auto_lock::spawn_idle_lock_timer` and
/// `plugins::sync::poke_listener::spawn_poke_supervisor`. Unix-only —
/// matches `clipper::relay_app::spawn_relay_listener`'s existing posture
/// (the command socket itself is Unix-only today; see `socket` module
/// docs).
#[cfg(unix)]
pub fn spawn_lifecycle_supervisor<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut listener: Option<socket::ListenerHandle> = None;
        // Last `cli_enabled` observed while unlocked, PAIRED WITH the vault it
        // was read from. Retained (not reset) across a lock, but never across
        // a vault change — see module docs "Why polling, not a push hook".
        let mut cached_cli_enabled: Option<(myne_core::vault_id::VaultId, bool)> = None;
        // ONE limiter for the process, handed to every socket the loop
        // opens (task 10) — the budget must span a lock/unlock cycle, and
        // its removal flag is refreshed below from the same per-tick prefs
        // read `cli_enabled` uses, which is what makes a Settings change
        // take effect without an app restart.
        let limiter = std::sync::Arc::new(rate_limit::SharedRateLimiter::default());
        // The Settings last-access marker (task 12), taken from managed state
        // so the `cli-bridge` command reads the SAME instance the sockets
        // write. A missing state (nothing managed it) degrades to a private
        // marker: the sockets still record, the panel just always reads
        // "not used" — a cosmetic loss, never a broken door.
        let last_access: activity::SharedLastAccess = app
            .try_state::<activity::SharedLastAccess>()
            .map(|s| s.inner().clone())
            .unwrap_or_default();
        let mut last_written_door: Option<DoorState> = None;
        let mut ticker = tokio::time::interval(SUPERVISOR_TICK);
        loop {
            ticker.tick().await;

            let Ok(app_data_dir) = app.path().app_data_dir() else {
                continue; // unresolved app_data_dir — nothing to do this tick
            };

            let state = app.try_state::<VaultRuntimeState>();
            let active_vault = match &state {
                Some(s) => s.active_vault_id().await,
                None => None,
            };
            let unlocked = active_vault.is_some();

            if let (Some(vault_id), Some(state)) = (active_vault, &state) {
                let host = myne_core::host::tauri_host::TauriHost::new(app.clone());
                match myne_core::plugins::prefs::commands::prefs_read_from_host(
                    &host,
                    state.inner(),
                    &myne_core::vault_io::StdVaultIo,
                )
                .await
                {
                    Ok(prefs) => {
                        cached_cli_enabled = Some((vault_id, prefs.cli_enabled));
                        // Unlike `cli_enabled`, this one is NOT cached
                        // across a lock: the socket is gone while locked,
                        // so there is nothing for the flag to affect, and
                        // a fresh read on the next unlocked tick is
                        // always the truth.
                        limiter.set_disabled(prefs.cli_rate_limit_disabled.unwrap_or(false));
                    }
                    // Fail closed. A read failure (e.g. the slot raced to
                    // Empty between the check above and here) is NOT evidence
                    // that the door should stay open — it is the absence of
                    // evidence either way, and the last value that WAS
                    // confirmed may belong to a different vault entirely. The
                    // next tick re-reads; one tick of a closed door costs a
                    // `myne` invocation a retry, where one tick of a wrongly
                    // open one serves notes.
                    Err(_) => cached_cli_enabled = Some((vault_id, false)),
                }
            }

            // A cache belonging to a DIFFERENT vault answers nothing about
            // this one. While locked there is no active vault to compare
            // against, so the last unlocked tick's value stands (that is the
            // whole point of caching it); on unlock it is either refreshed
            // above or retired here.
            let cli_enabled = match cached_cli_enabled {
                Some((cached_id, enabled)) => match active_vault {
                    Some(active_id) => cached_id == active_id && enabled,
                    None => enabled,
                },
                None => false,
            };

            let door = gate::classify(cli_enabled, unlocked);

            if last_written_door != Some(door) {
                let _ = status::write(&app_data_dir, door);
                last_written_door = Some(door);
            }

            let want_open = gate::socket_should_be_open(door);
            match (&listener, want_open) {
                (None, true) => {
                    let lister = std::sync::Arc::new(dispatch::AppNoteLister::new(app.clone()));
                    match socket::spawn(&app_data_dir, lister, limiter.clone(), last_access.clone())
                    {
                        Ok(h) => listener = Some(h),
                        Err(e) => {
                            let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                            tracing::error!(
                                stage = "cli_bridge_bind",
                                io_failure_kind = ?kind,
                                "CLI bridge socket could not bind; door stays closed"
                            );
                        }
                    }
                }
                (Some(_), false) => {
                    // Also clears the last-access marker — see
                    // `socket::teardown`, which owns that so the reset cannot
                    // be forgotten by a future caller.
                    socket::teardown(listener.take());
                }
                _ => {}
            }
        }
    });
}
