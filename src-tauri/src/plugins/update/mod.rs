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

use crate::update::{UpdateCheckError, UpdateStatus};
use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_updater::{Updater, UpdaterExt};

/// The manifest endpoint for the channel this build was COMPILED for.
///
/// `MYNE_UPDATE_CHANNEL=beta` at build time (the release sets it for the beta
/// flavour, together with the matching Vite define) points at the beta manifest;
/// anything else, unset included, is stable. It is a compile-time value on
/// purpose: the channel the About panel SHOWS (`__UPDATE_CHANNEL__`) and the
/// manifest the client FETCHES cannot then disagree, which a config-only
/// endpoint plus a display-only define allowed.
fn channel_endpoint() -> &'static str {
    match option_env!("MYNE_UPDATE_CHANNEL") {
        Some("beta") => "https://downloads.myne.md/releases/latest-beta.json",
        _ => "https://downloads.myne.md/releases/latest.json",
    }
}

/// Build the updater pinned to this build's channel endpoint.
fn updater_for<R: Runtime>(app: &AppHandle<R>) -> Result<Updater, UpdateCheckError> {
    let endpoint = Url::parse(channel_endpoint()).map_err(|_| UpdateCheckError::Other)?;
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

/// Download and install the offered update, then relaunch into it.
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
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(map_error)?;
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
