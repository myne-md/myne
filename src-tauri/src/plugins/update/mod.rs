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

use crate::update::{UpdateCheckError, UpdateProgress, UpdateStatus, PROGRESS_EVENT};
use tauri::{AppHandle, Emitter, Manager, Runtime, Url};
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

/// Map the updater's error to our closed presentation set.
///
/// Coarse on purpose: the UI only needs "could not reach", "refused", "cannot
/// update here", or "other". The updater's `Error` is `#[non_exhaustive]`, so a
/// new variant lands on `Other` rather than widening this set.
fn map_error(error: tauri_plugin_updater::Error) -> UpdateCheckError {
    use tauri_plugin_updater::Error;
    match error {
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound | Error::UrlParse(_) => {
            UpdateCheckError::Unreachable
        }
        // A local IO failure (disk full, permission denied) is NOT reachability;
        // it falls to `Other` so the user gets a line that does not point at the
        // network for a disk problem.
        Error::Minisign(_) | Error::Base64(_) | Error::Serialization(_) | Error::Semver(_) => {
            UpdateCheckError::Verification
        }
        Error::EmptyEndpoints | Error::UnsupportedArch | Error::UnsupportedOs => {
            UpdateCheckError::Unsupported
        }
        _ => UpdateCheckError::Other,
    }
}

/// Check for a signed update. Returns the running version's status; a failure
/// is the `Err` arm, never a status value.
#[tauri::command]
pub async fn update_check<R: Runtime>(app: AppHandle<R>) -> Result<UpdateStatus, UpdateCheckError> {
    let updater = updater_for(&app)?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateStatus::Available {
            version: update.version,
            notes: update.body,
        }),
        Ok(None) => Ok(UpdateStatus::UpToDate),
        Err(error) => Err(map_error(error)),
    }
}

/// The smallest byte delta between two `Downloading` ticks.
///
/// One event per transport chunk would be thousands of IPC round trips for a
/// 200 MiB artifact, and the UI cannot paint faster than about 60 Hz anyway. A
/// step of one percent of the total keeps the bar within half a percent of the
/// truth while capping the stream at about a hundred ticks; the 64 KiB floor
/// stops a small artifact from reporting every chunk, and 256 KiB is the fallback
/// for an origin that sent no `Content-Length` (where there is no total to take a
/// percentage of). Everything is capped at 4 MiB so a very large artifact still
/// reports movement.
fn progress_step(total: Option<u64>) -> u64 {
    total.map_or(256 * 1024, |total| {
        (total / 100).clamp(64 * 1024, 4 * 1024 * 1024)
    })
}

/// Download and install the offered update, then relaunch into it.
///
/// The install is streamed to the WebView as [`UpdateProgress`] events on
/// [`PROGRESS_EVENT`], which is the difference from `download_and_install`: that
/// call downloads and installs in one expression, so a UI can only say
/// "installing" for however many minutes the download takes. Splitting it is not
/// a reimplementation of anything. `download` verifies the artifact's minisign
/// signature before it returns, and `install` does the same work it did inside
/// the combined call, so the split only puts a seam where the phase boundary
/// already was.
///
/// **Every emit is best effort.** A closed window, or a WebView that listened to
/// nothing, must not fail an install that is otherwise fine: the progress stream
/// is a readout for a window that may no longer exist, and the install's own
/// result travels in this command's return value. A discarded `emit` error is
/// therefore the intended behaviour rather than an oversight, and each of the
/// three sites below says so where it happens.
///
/// On Windows the installer exits the process itself; on macOS and Linux this
/// returns and the relaunch below is what starts the new version.
#[tauri::command]
pub async fn update_install<R: Runtime>(app: AppHandle<R>) -> Result<(), UpdateCheckError> {
    let updater = updater_for(&app)?;
    let Some(update) = updater.check().await.map_err(map_error)? else {
        // The offer vanished between the check and the install. Report it rather
        // than resolving, so the UI leaves its "installing" state instead of
        // hanging on it.
        return Err(UpdateCheckError::Other);
    };

    let chunk_app = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_reported: u64 = 0;
    let bytes = update
        .download(
            move |chunk: usize, total: Option<u64>| {
                downloaded += chunk as u64;
                let complete = total.is_some_and(|total| downloaded >= total);
                if complete || downloaded - last_reported >= progress_step(total) {
                    last_reported = downloaded;
                    // Discarded on purpose: an emit fails when the window is gone,
                    // and a closed window must not abort an install that is
                    // otherwise fine.
                    let _ = chunk_app.emit(
                        PROGRESS_EVENT,
                        UpdateProgress::Downloading { downloaded, total },
                    );
                }
            },
            {
                // Runs after the last chunk and BEFORE the signature check, which
                // is what makes `Verifying` a phase the host can testify to rather
                // than a sentence it made up.
                let finish_app = app.clone();
                move || {
                    // Same best-effort rule as the chunk arm above.
                    let _ = finish_app.emit(PROGRESS_EVENT, UpdateProgress::Verifying);
                }
            },
        )
        .await
        .map_err(map_error)?;

    // Same best-effort rule: the swap below is what the user is waiting for, and
    // a window that closed mid-download cannot be allowed to veto it.
    let _ = app.emit(PROGRESS_EVENT, UpdateProgress::Installing);
    // Sync and blocking on purpose: it is the same work the combined call did on
    // this task, and there is nothing else for this task to do while it runs.
    update.install(&bytes).map_err(map_error)?;
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
