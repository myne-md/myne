//! IPC surface of the `plain_file` plugin: the device-local gate only
//! (myne-md/myne#788).
//!
//! The file IO commands land in a later task; this module starts with the two
//! the Settings and Welcome toggles need, and the commands the file IO adds
//! live beside them so the permission set stays one file.
//!
//! Every command resolves `app_config_dir` and delegates to a pure `*_in`
//! helper that takes its path directly, so the tests need no Tauri runtime
//! (`src-tauri/AGENTS.md` plugin pattern).

use super::gate::{self, PlainFileGateError};
use crate::io_failure_kind::IoFailureKind;
use tauri::{AppHandle, Manager, Runtime};

fn config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, PlainFileGateError> {
    app.path()
        .app_config_dir()
        .map_err(|_| PlainFileGateError::Io {
            io_error_kind: IoFailureKind::Other,
        })
}

/// Whether the plain-file editor is enabled on this device.
///
/// Answers `false` on every failure (see `gate::read_gate`), so a caller never
/// has to distinguish "off" from "unreadable": both mean the ingress refuses.
#[tauri::command]
pub async fn gate_get<R: Runtime>(app: AppHandle<R>) -> Result<bool, PlainFileGateError> {
    let path = gate::gate_path_in(&config_dir(&app)?);
    Ok(gate::read_gate(&path))
}

/// Persist the device-local gate.
#[tauri::command]
pub async fn gate_set<R: Runtime>(
    enabled: bool,
    app: AppHandle<R>,
) -> Result<(), PlainFileGateError> {
    let path = gate::gate_path_in(&config_dir(&app)?);
    gate::write_gate(&path, enabled)
}
