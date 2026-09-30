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
use super::handles::{FileContent, PlainFileError, PlainFileRegistry};
use crate::io_failure_kind::IoFailureKind;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime, State};

/// The handle registry, shared with the ingress paths that mint handles.
///
/// An `Arc` rather than a bare `Mutex` because the file IO moves into
/// `spawn_blocking`: a read of a large file must not sit on an async worker,
/// and the closure needs an owned handle to the state to cross the boundary.
pub type SharedRegistry = Arc<Mutex<PlainFileRegistry>>;

/// A poisoned lock or a panicked blocking task. Both mean the registry is
/// unusable for this call; neither ever carries file data, a path or a name.
fn registry_unavailable() -> PlainFileError {
    PlainFileError::Io {
        io_error_kind: IoFailureKind::Other,
    }
}

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

/// Read the current content behind a handle.
///
/// No gate check: the gate guards MINTING a handle (the moment Myne is handed
/// a file); a handle that exists is a grant the user already made. That split
/// is what lets the UI flush an open tab after the gate is switched off,
/// rather than losing the flush to a settings change. See `handles.rs`.
#[tauri::command]
pub async fn plain_file_read(
    handle: u64,
    registry: State<'_, SharedRegistry>,
) -> Result<FileContent, PlainFileError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = registry.lock().map_err(|_| registry_unavailable())?;
        guard.read(handle)
    })
    .await
    .map_err(|_| registry_unavailable())?
}

/// Write `content` when the on-disk bytes still hash to `expected_base`.
///
/// Returns the hash of the bytes written, which the caller carries as the next
/// expected base.
#[tauri::command]
pub async fn plain_file_write(
    handle: u64,
    content: String,
    expected_base: String,
    registry: State<'_, SharedRegistry>,
) -> Result<String, PlainFileError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = registry.lock().map_err(|_| registry_unavailable())?;
        guard.write(handle, &content, &expected_base)
    })
    .await
    .map_err(|_| registry_unavailable())?
}

/// Drop a handle. Idempotent: closing an unknown handle is a no-op.
#[tauri::command]
pub async fn plain_file_close(
    handle: u64,
    registry: State<'_, SharedRegistry>,
) -> Result<(), PlainFileError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = registry.lock().map_err(|_| registry_unavailable())?;
        guard.close(handle);
        Ok(())
    })
    .await
    .map_err(|_| registry_unavailable())?
}

/// Every handle an ingress minted that this frontend has not claimed yet.
///
/// The startup argv ingest runs before the WebView can attach its listener, so
/// the frontend drains this on mount in addition to subscribing to
/// `plain-file:opened`. Both orders deliver the file exactly once to a store
/// keyed by handle.
#[tauri::command]
pub async fn plain_file_take_unclaimed(
    registry: State<'_, SharedRegistry>,
) -> Result<Vec<super::handles::OpenedFile>, PlainFileError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = registry.lock().map_err(|_| registry_unavailable())?;
        Ok(guard.take_unclaimed())
    })
    .await
    .map_err(|_| registry_unavailable())?
}
