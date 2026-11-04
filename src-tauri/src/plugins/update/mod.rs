// SPDX-License-Identifier: AGPL-3.0
//! The desktop self-update plugin: the two host-side commands the UI calls.
//!
//! # Why these are host-side and not the updater's own commands
//!
//! `tauri-plugin-updater` exposes `plugin:updater|check` / `|download` /
//! `|install` to the WebView. This plugin deliberately does NOT grant them.
//! Instead the WebView calls `plugin:update|update_check` and
//! `plugin:update|update_install`, which run the updater in Rust and return a
//! typed result. Two reasons: the update surface the page can reach is exactly
//! two narrow commands rather than the plugin's whole API, and the result the
//! page sees is `src-tauri/src/update`'s closed model, not the updater's error
//! type. `no_egress.rs` keeps `updater` in its network-permission prefixes for
//! the same reason: a future grant of the raw updater commands is a widening
//! this guard still catches.
//!
//! # What verifies what
//!
//! Signature verification, the version gate and the download all belong to the
//! updater. This module only maps its result and its errors. A failure is the
//! `Err` arm, so the UI never has to tell a failure apart from an update.

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::update::{UpdateCheckError, UpdateStatus};
use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_updater::{Updater, UpdaterExt};

/// Build the updater pinned to this build's channel endpoint.
///
/// The endpoint comes from `crate::update::Channel` and from nowhere else.
/// `UpdaterBuilder::endpoints` REPLACES the plugin's configured list rather
/// than merging with it (`tauri-plugin-updater`'s `UpdaterBuilder::build` reads
/// `self.endpoints.unwrap_or_else(|| config.endpoints.clone())`), so
/// `tauri.conf.json` deliberately carries no endpoint: a list there would be a
/// second source of truth that is silently overridden, and
/// `scripts/check-update-channel.mjs` fails if one is added back.
///
/// The channel that picks this endpoint is also what the About panel shows
/// (`__UPDATE_CHANNEL__`) and what the log header names. One compile-time
/// resolution, three readers.
fn updater_for<R: Runtime>(app: &AppHandle<R>) -> Result<Updater, UpdateCheckError> {
    let endpoint = Url::parse(&crate::update::Channel::from_env().endpoint())
        .map_err(|_| UpdateCheckError::Other)?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|_| UpdateCheckError::Unsupported)?
        .build()
        .map_err(|_| UpdateCheckError::Unsupported)
}

/// Resolve `<app_config_dir>/update-prefs.json`, creating the directory.
fn prefs_path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, UpdateCheckError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|_| UpdateCheckError::Other)?;
    std::fs::create_dir_all(&dir).map_err(|_| UpdateCheckError::Other)?;
    Ok(crate::update::prefs::update_prefs_path(dir))
}

/// Why a step failed, in the vocabulary the diagnostic log records.
///
/// **One classification, two readers.** `map_error` projects it onto the WebView's
/// closed set, and the `kind` field of the log event carries it verbatim. Before
/// this existed the classification WAS `map_error`, and it discarded the one thing
/// a maintainer needs first: which step failed. `myne-md/myne#864` and the
/// 2026-11-04 report are the same round of "the update did not finish" with
/// nothing behind it, and the difference between a download that died and a bundle
/// swap the OS refused is the whole diagnosis.
///
/// `Install` is deliberately absent from the IPC set: the UI's sentence is the same
/// line either way, so widening `UpdateCheckError` would buy the WebView nothing and
/// cost a TS mirror, an i18n key and a test. The log is where the detail is worth
/// having, and the log is not an IPC surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    /// The manifest could not be fetched, or named no release for this platform.
    Unreachable,
    /// The artifact is present but its signature, hash or version will not verify.
    Verification,
    /// The updater cannot work on this target at all (no endpoints, wrong arch/OS).
    Unsupported,
    /// A filesystem or process failure while replacing the bundle — the step after
    /// a successful download and verification, and the one with no second chance.
    Install,
    Other,
}

/// Classify the updater's error once. Its `Error` is `#[non_exhaustive]`, so a new
/// variant lands on `Other` rather than being guessed at.
fn classify(error: &tauri_plugin_updater::Error) -> FailureKind {
    use tauri_plugin_updater::Error;
    match error {
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound | Error::UrlParse(_) => {
            FailureKind::Unreachable
        }
        Error::Minisign(_) | Error::Base64(_) | Error::Serialization(_) | Error::Semver(_) => {
            FailureKind::Verification
        }
        Error::EmptyEndpoints | Error::UnsupportedArch | Error::UnsupportedOs => {
            FailureKind::Unsupported
        }
        // `install_inner` is the only part of the sequence that touches the
        // filesystem or a child process, so an IO failure here IS the bundle swap:
        // on macOS the plugin renames the running bundle aside and moves the new
        // one in, and on a refusal it falls back to an AppleScript hop that asks
        // for administrator rights.
        Error::Io(_) => FailureKind::Install,
        _ => FailureKind::Other,
    }
}

/// The IO kind of an install failure, when the update had one.
///
/// A closed unit enum rather than `std::io::Error`'s `Display`, which would carry an
/// OS message and a path into a file the user is invited to publish.
fn io_kind_of(error: &tauri_plugin_updater::Error) -> Option<IoFailureKind> {
    match error {
        tauri_plugin_updater::Error::Io(e) => Some(from_io_error_kind(e.kind())),
        _ => None,
    }
}

/// Record a failed step, then hand the error to the IPC projection.
///
/// One call site per failure, so the log line and the value the page sees can never
/// disagree about what happened.
fn failed(step: &'static str, error: tauri_plugin_updater::Error) -> UpdateCheckError {
    let kind = classify(&error);
    tracing::warn!(
        event = "update_step_failed",
        stage = step,
        kind = ?kind,
        io_kind = ?io_kind_of(&error)
    );
    map_error(error)
}

/// Map the classified failure onto the WebView's closed set.
///
/// Coarse on purpose: the UI only needs "could not reach", "refused", "cannot
/// update here", or "other".
fn map_error(error: tauri_plugin_updater::Error) -> UpdateCheckError {
    match classify(&error) {
        FailureKind::Unreachable => UpdateCheckError::Unreachable,
        FailureKind::Verification => UpdateCheckError::Verification,
        FailureKind::Unsupported => UpdateCheckError::Unsupported,
        // A local IO failure (disk full, permission denied) is NOT reachability, so
        // the user gets a line that does not point at the network for a disk problem.
        FailureKind::Install | FailureKind::Other => UpdateCheckError::Other,
    }
}

/// Check for a signed update. Returns the running version's status; a failure
/// is the `Err` arm, never a status value.
#[tauri::command]
pub async fn update_check<R: Runtime>(app: AppHandle<R>) -> Result<UpdateStatus, UpdateCheckError> {
    let updater = updater_for(&app)?;
    match updater.check().await {
        Ok(Some(update)) => {
            // The version is public material (it is in the manifest the request
            // just fetched), and it is the one field that makes a "why did it not
            // offer anything" report answerable.
            tracing::info!(
                event = "update_check_outcome",
                outcome = "available",
                offered = ?update.version
            );
            Ok(UpdateStatus::Available {
                version: update.version,
                notes: update.body,
            })
        }
        Ok(None) => {
            tracing::info!(event = "update_check_outcome", outcome = "up_to_date");
            Ok(UpdateStatus::UpToDate)
        }
        Err(error) => Err(failed("check", error)),
    }
}

/// Download and install the offered update, then relaunch into it.
///
/// On Windows the installer exits the process itself; on macOS and Linux this
/// returns and the relaunch below is what starts the new version.
#[tauri::command]
/// # What the diagnostic log gets, and why the callback is not a no-op
///
/// This path is the one place in the app where a failure leaves **no other
/// evidence at all**: the screen shows one sentence, the window is replaced by the
/// updating stage so nothing behind it can be read, and a process that never
/// restarts writes no line anywhere. Three events close that: the offer, the
/// outcome of download-and-install with the bytes it moved, and the restart it is
/// about to perform. A log that stops after the first one says the download died; a
/// log that reaches the third says the bundle was replaced.
///
/// The download's chunk callback was `|_, _| {}` — a no-op that made a 149 MiB
/// transfer and a dead socket look identical. It now counts bytes for the outcome
/// event, which is the cheapest honest progress signal there is: it costs a `+=` on
/// a callback the plugin already calls, and it turns "did not finish" into a number.
pub async fn update_install<R: Runtime>(app: AppHandle<R>) -> Result<(), UpdateCheckError> {
    let updater = updater_for(&app)?;
    let offer = updater
        .check()
        .await
        .map_err(|error| failed("check", error))?;
    let Some(update) = offer else {
        // The offer vanished between the check and the install. Report it rather
        // than resolving, so the UI leaves its "installing" state instead of
        // hanging on it.
        tracing::warn!(event = "update_offer_gone");
        return Err(UpdateCheckError::Other);
    };

    tracing::info!(
        event = "update_install_started",
        offered = ?update.version
    );

    let started = std::time::Instant::now();
    let mut received: u64 = 0;
    let outcome = update
        .download_and_install(|chunk, _total| received += chunk as u64, || {})
        .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    if let Err(error) = outcome {
        // `stage="install"` plus the classified kind separates the three steps the
        // updater hides behind one error type: `unreachable` is the download,
        // `verification` is the signature, and `install` is the bundle swap, whose
        // `io_kind` names a refusal (`PermissionDenied`), a full disk or a missing
        // path.
        let kind = classify(&error);
        tracing::warn!(
            event = "update_step_failed",
            stage = "install",
            kind = ?kind,
            io_kind = ?io_kind_of(&error),
            bytes = received,
            elapsed_ms
        );
        return Err(map_error(error));
    }

    tracing::info!(event = "update_installed", bytes = received, elapsed_ms);
    // The last line this process writes before it hands over. Its presence without a
    // following startup entry is the one shape that proves the restart itself failed.
    tracing::info!(event = "update_restarting", offered = ?update.version);
    tauri::process::restart(&app.env());
}

/// Whether this device checks for updates automatically (device-local).
#[tauri::command]
pub async fn update_get_auto_check<R: Runtime>(
    app: AppHandle<R>,
) -> Result<bool, UpdateCheckError> {
    let path = prefs_path(&app)?;
    Ok(crate::update::prefs::read(&path).auto_check)
}

/// Set whether this device checks for updates automatically (device-local).
#[tauri::command]
pub async fn update_set_auto_check<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), UpdateCheckError> {
    let path = prefs_path(&app)?;
    crate::update::prefs::write(
        &path,
        crate::update::prefs::UpdatePrefs {
            auto_check: enabled,
        },
    )
    .map_err(|_| UpdateCheckError::Other)
}

/// Build the `update` plugin: the four commands above, nothing else.
pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("update")
        .invoke_handler(tauri::generate_handler![
            update_check,
            update_install,
            update_get_auto_check,
            update_set_auto_check
        ])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io_failure_kind::IoFailureKind;
    use std::io::ErrorKind;
    use tauri_plugin_updater::Error;

    /// The invariant that used to be a comment and nothing more: a failure to write
    /// the bundle must not be reported as a network problem.
    ///
    /// `map_error` sent every `Error::Io` to `Other` for this reason, and the line
    /// explaining it could not stop a future edit from folding `Io` into
    /// `Unreachable` — which would tell a user with a locked-down `/Applications` to
    /// check their connection. The classification is now read by two callers, so the
    /// distinction has somewhere to be asserted.
    #[test]
    fn a_bundle_swap_failure_is_not_reported_as_a_network_problem() {
        let refused = Error::Io(std::io::Error::from(ErrorKind::PermissionDenied));
        assert_eq!(classify(&refused), FailureKind::Install);
        assert_eq!(map_error(refused), UpdateCheckError::Other);
    }

    /// The IO kind is what makes "did not finish" actionable: a refusal and a full
    /// disk are the same sentence on screen and different repairs.
    #[test]
    fn the_install_stage_names_the_io_kind_that_refused() {
        let refused = Error::Io(std::io::Error::from(ErrorKind::PermissionDenied));
        assert_eq!(io_kind_of(&refused), Some(IoFailureKind::PermissionDenied));

        // `WriteZero` is the "there was a write and no room for it" kind, and the
        // one `NoSpace` is derived from alongside `StorageFull`.
        let full = Error::Io(std::io::Error::from(ErrorKind::WriteZero));
        assert_eq!(io_kind_of(&full), Some(IoFailureKind::NoSpace));

        // A failure that never touched the filesystem must not invent an IO kind.
        assert_eq!(io_kind_of(&Error::Network("reset".into())), None);
    }

    /// A variant this build has never seen lands on a closed kind rather than being
    /// guessed at, and the guess is not allowed to be `Unreachable`.
    #[test]
    fn an_unclassified_failure_still_lands_on_a_closed_kind() {
        assert_eq!(classify(&Error::UnsupportedArch), FailureKind::Unsupported);
        assert_eq!(
            classify(&Error::Network("reset".into())),
            FailureKind::Unreachable
        );
        assert_eq!(
            classify(&Error::TargetNotFound("darwin-aarch64".into())),
            FailureKind::Other
        );
    }

    /// The record the 2026-11-04 report did not have: the step, the kind, and the IO
    /// kind, on the one failure path that returns to the page.
    ///
    /// `failed` is the whole call site for a failed step, so asserting its record is
    /// asserting that `update_check` and `update_install` cannot return an error
    /// without leaving a line — which is the property, not the text.
    #[test]
    #[tracing_test::traced_test]
    fn a_failed_step_is_recorded_with_the_kind_it_classified() {
        let refused = Error::Io(std::io::Error::from(ErrorKind::PermissionDenied));
        let mapped = failed("install", refused);
        assert_eq!(mapped, UpdateCheckError::Other);
        assert!(logs_contain("event=\"update_step_failed\""));
        assert!(logs_contain("stage=\"install\""));
        assert!(logs_contain("kind=Install"));
        assert!(logs_contain("io_kind=Some(PermissionDenied)"));
    }
}
