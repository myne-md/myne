// SPDX-License-Identifier: AGPL-3.0
//! The `cli-bridge` Tauri plugin: the WebView's read-only window onto the CLI
//! door's *session* state (cli-thin-client task 12; MYND-490).
//!
//! ## Why a plugin at all, for one command
//!
//! Every other thing Settings needs about this door is a `vault.prefs` field
//! and goes through the `prefs` plugin (`cli_enabled`,
//! `cli_excluded_folders`, `cli_rate_limit_disabled` — task 2). The two facts
//! *this* command answers are not preferences and cannot be:
//!
//! - **how long ago the door last served a command** — RAM only, by design
//!   (`super::activity` explains why persisting it would turn a read loop into
//!   hundreds of vault writes);
//! - **whether `myne` is actually typeable, and where the shim lives** — a
//!   property of the user's `$PATH` and this machine's install, not of the
//!   vault (`super::path_shim` rule 3: we report the missing `export PATH=…`
//!   line instead of editing a shell profile).
//!
//! So they get their own narrow ACL namespace instead of being smuggled into a
//! plugin named for encrypted per-vault preferences. One command, read-only,
//! no arguments, no vault state touched — which is also why it needs no
//! `Slot::Unlocked` gate: it can answer honestly with the vault locked (the
//! door is shut, so the age is `None`), and the panel that reads it only
//! renders post-unlock anyway.
//!
//! ## Not available on web
//!
//! `cli-bridge` is `Class::Unsupported` in `web/wasm/src/capability.rs`, and
//! the matching product capability (`cliAccess`) is absent from the web
//! descriptor, so the Settings block is **omitted** rather than greyed out
//! (`decisions.md` 2026-07-26 "Web capability set"). A browser tab cannot host
//! a terminal's Unix socket, and the sidecar it would talk to is a file inside
//! a desktop bundle.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — the reply
//! carries an age in seconds and one directory path the user owns, and this
//! module logs nothing.

use std::time::Instant;

use serde::Serialize;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, State};

use super::activity::{LastAccess, SharedLastAccess};

/// What Settings needs to render the CLI-access block's non-preference half.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CliAccessState {
    /// Whole seconds since the command socket last served a request, or `None`
    /// for "nothing since the door opened" — which is also the answer while
    /// the vault is locked, since closing the door clears the marker.
    pub last_used_secs_ago: Option<u64>,
    /// Whether `myne` resolves on the live `$PATH` right now. `false` means
    /// the user would get `command not found`, whatever the toggle says.
    pub command_on_path: bool,
    /// The directory the PATH shim is installed into, for the one line the
    /// user adds themselves when `command_on_path` is false. `None` where
    /// there is no shim mechanism (Windows) or `$HOME` is unresolvable.
    pub shim_dir: Option<String>,
}

/// The `$PATH` half, split out so the Windows build says "no shim mechanism"
/// rather than probing for a `myne` it would look for under the wrong name.
#[cfg(unix)]
fn reachability() -> (bool, Option<String>) {
    (
        super::path_shim::command_on_path(),
        super::path_shim::shim_dir_for_display(),
    )
}

#[cfg(not(unix))]
fn reachability() -> (bool, Option<String>) {
    // No shim is written on Windows (`path_shim::reconcile`'s own
    // `#[cfg(windows)]` arm is a log line), so there is no directory to point
    // the user at and no claim to make about `%PATH%`.
    (false, None)
}

/// Testable core: everything the command does, over an explicit marker and an
/// explicit `now`. The `*_with_…` shape the rest of this codebase uses so a
/// test needs no Tauri runtime.
fn cli_access_state_from(last_access: &LastAccess, now: Instant) -> CliAccessState {
    let (command_on_path, shim_dir) = reachability();
    CliAccessState {
        last_used_secs_ago: last_access.elapsed_secs(now),
        command_on_path,
        shim_dir,
    }
}

/// Read the CLI door's session state. Read-only, no arguments, no vault access.
///
/// The marker comes from managed state (`lib.rs` `setup`), which is the same
/// instance the lifecycle supervisor hands to every socket it opens.
#[tauri::command]
pub fn cli_access_state(last_access: State<'_, SharedLastAccess>) -> CliAccessState {
    cli_access_state_from(last_access.inner(), Instant::now())
}

/// Construct the `cli-bridge` plugin.
///
/// The ACL namespace is `cli-bridge` (kebab-case) — it must match
/// `permissions/cli-bridge/default.toml` and the `build.rs` `InlinedPlugin`
/// declaration, or the permission flattens into `__app-acl__` and never
/// authorizes the `plugin:cli-bridge|cli_access_state` invoke form.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("cli-bridge")
        .invoke_handler(tauri::generate_handler![cli_access_state])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_access_is_reported_as_an_age_in_seconds() {
        let marker = LastAccess::default();
        let t0 = Instant::now();
        marker.record(t0);
        let state = cli_access_state_from(&marker, t0 + std::time::Duration::from_secs(7_260));
        // Two hours and a minute: the panel renders "2 h ago" from this, and
        // what crossed the boundary is an age, never a clock reading.
        assert_eq!(state.last_used_secs_ago, Some(7_260));
    }

    #[test]
    fn clearing_the_marker_is_visible_through_the_command_core() {
        // The relock path: `socket::teardown` clears, and the very next read
        // reports "not used since this vault was unlocked".
        let marker = LastAccess::default();
        marker.record(Instant::now());
        marker.clear();
        assert_eq!(
            cli_access_state_from(&marker, Instant::now()).last_used_secs_ago,
            None
        );
    }

    #[test]
    fn state_is_serializable_with_the_wire_field_names_the_ui_reads() {
        // `src/lib/cli-access.ts` maps these exact snake_case keys; a rename
        // here compiles fine and silently gives the panel `undefined`.
        let json = serde_json::to_string(&CliAccessState {
            last_used_secs_ago: Some(42),
            command_on_path: true,
            shim_dir: Some("/home/u/.local/bin".into()),
        })
        .expect("serialize CliAccessState");
        assert_eq!(
            json,
            r#"{"last_used_secs_ago":42,"command_on_path":true,"shim_dir":"/home/u/.local/bin"}"#
        );
    }

    #[test]
    fn absent_values_serialize_as_null_rather_than_being_omitted() {
        // No `skip_serializing_if`: the panel distinguishes "not used" from
        // "unknown", and a missing key would collapse the two.
        let json = serde_json::to_string(&CliAccessState {
            last_used_secs_ago: None,
            command_on_path: false,
            shim_dir: None,
        })
        .expect("serialize CliAccessState");
        assert_eq!(
            json,
            r#"{"last_used_secs_ago":null,"command_on_path":false,"shim_dir":null}"#
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_shim_dir_is_reported_under_the_users_home() {
        // Not an assertion about the literal path (the runner's `$HOME` is
        // whatever it is) — only that the hint points inside the home dir the
        // shim is actually written to, so the `export PATH=…` line Settings
        // shows is the line that would work.
        if let Some(home) = std::env::var_os("HOME") {
            let dir = super::super::path_shim::shim_dir_for_display()
                .expect("a UTF-8 HOME yields a shim dir");
            assert!(dir.starts_with(&home.to_string_lossy().to_string()));
            assert!(dir.ends_with("/.local/bin"));
        }
    }
}
