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
use super::handles::{resolve_openable, FileContent, PlainFileError, PlainFileRegistry};
use crate::io_failure_kind::IoFailureKind;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, Runtime, State, Url};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

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

/// Lift the gate's error into the plugin's one error surface.
///
/// The gate error is a single closed `Io` arm today; folding it here keeps
/// the ingress commands' signature uniform without merging the two types,
/// which still encode different things (a gate write vs. a file read).
fn gate_to_plain(error: PlainFileGateError) -> PlainFileError {
    match error {
        PlainFileGateError::Io { io_error_kind } => PlainFileError::Io { io_error_kind },
    }
}

/// A `file://` URL or an absolute path, as the path it names.
///
/// The deep link carries its target in a query parameter, and both shapes
/// are legal there. A string that parses as some OTHER scheme (`https:`,
/// `javascript:`) is not dereferenced: it falls to the raw-path arm and dies
/// at canonicalisation, which is the refusal this ingress wants.
fn path_from_input(raw: &str) -> PathBuf {
    if let Ok(url) = Url::parse(raw) {
        if url.scheme() == "file" {
            if let Ok(path) = url.to_file_path() {
                return path;
            }
        }
    }
    PathBuf::from(raw)
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
    // Plaintext IPC: bound the bytes to a Zeroizing wrapper on the first
    // non-doc statement so every early return drops them wiped
    // (`src-tauri/AGENTS.md` "Plaintext IPC across the WebView boundary").
    let content = Zeroizing::new(content);
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = registry.lock().map_err(|_| registry_unavailable())?;
        guard.write(handle, &content, &expected_base)
    })
    .await
    .map_err(|_| registry_unavailable())?
}

/// Write the current buffer to a file the user names (the conflict banner's
/// copy arm).
///
/// The save dialog runs host-side like the open dialog, so the destination
/// comes from the OS picker and no path ever reaches the WebView. `Ok(None)` is
/// a cancelled dialog: nothing was written and nothing was refused. On success
/// the answer is the written file's NAME, never its path.
///
/// No gate check: a handle is a grant the user already made, and refusing this
/// write because the device flag moved would strand the user's text in a
/// conflicted tab (the same open-vs-read/write split `handles.rs` documents).
#[tauri::command]
pub async fn plain_file_save_copy<R: Runtime>(
    handle: u64,
    content: String,
    app: AppHandle<R>,
    registry: State<'_, SharedRegistry>,
) -> Result<Option<String>, PlainFileError> {
    // Plaintext leaves the WebView into a file the user explicitly chose, so
    // the wrapper does not make the copy ephemeral; it bounds the RAM copy
    // exactly as the write command does.
    let content = Zeroizing::new(content);
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let suggested = {
            let guard = registry.lock().map_err(|_| registry_unavailable())?;
            guard.copy_name(handle)?
        };
        let picked = app
            .dialog()
            .file()
            .set_file_name(suggested)
            .add_filter("Markdown", super::handles::ALLOWED_EXTENSIONS)
            .blocking_save_file();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let destination = picked.into_path().map_err(|_| PlainFileError::NotAFile)?;
        let guard = registry.lock().map_err(|_| registry_unavailable())?;
        Ok(Some(guard.write_copy(handle, &content, &destination)?))
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

/// The in-app Open: a native Markdown-filtered dialog, then the shared
/// ingest.
///
/// No path is returned to the WebView. The dialog runs host-side (the
/// plugin's own rule: never block the main thread) and the picked file is
/// opened through the same funnel as every OS ingress, so the frontend learns
/// about it only through `plain-file:opened` / `take_unclaimed`, carrying the
/// handle and the file name. Cancelling is `Ok(())`: nothing was refused.
///
/// The gate is checked BEFORE the dialog opens. A gate that went off in this
/// session must refuse visibly here rather than showing a picker whose
/// selection would then be silently dropped.
#[tauri::command]
pub async fn plain_file_open_dialog<R: Runtime>(app: AppHandle<R>) -> Result<(), PlainFileError> {
    tauri::async_runtime::spawn_blocking(move || {
        let config_dir = config_dir(&app).map_err(gate_to_plain)?;
        if !gate::read_gate(&gate::gate_path_in(&config_dir)) {
            return Err(PlainFileError::GateOff);
        }
        let picked = app
            .dialog()
            .file()
            .add_filter("Markdown", super::handles::ALLOWED_EXTENSIONS)
            .blocking_pick_file();
        let Some(picked) = picked else {
            return Ok(());
        };
        let path = picked.into_path().map_err(|_| PlainFileError::NotAFile)?;
        super::ingest::ingest_paths_reporting(&app, vec![path])
    })
    .await
    .map_err(|_| registry_unavailable())?
}

/// Canonicalise a caller-named path for the deep link's confirmation layer.
///
/// Reads no content and mints no handle. The confirmation has to show the
/// REAL target rather than the path the link claimed: a link naming
/// `~/notes.md` when that is a symlink somewhere else would otherwise get a
/// yes for a file the user never saw. The confirmed open re-validates from
/// scratch, so nothing this call learns is trusted later.
#[tauri::command]
pub async fn plain_file_resolve_path<R: Runtime>(
    path: String,
    app: AppHandle<R>,
) -> Result<String, PlainFileError> {
    tauri::async_runtime::spawn_blocking(move || {
        let config_dir = config_dir(&app).map_err(gate_to_plain)?;
        let canonical = resolve_openable(&config_dir, &path_from_input(&path))?;
        canonical
            .to_str()
            .map(str::to_string)
            .ok_or(PlainFileError::NotAFile)
    })
    .await
    .map_err(|_| registry_unavailable())?
}

/// The deep link's confirmed open: re-validate and funnel into the ingest.
///
/// `path` is the string the user just saw in the confirmation. It is treated
/// as hostile anyway: gate, extension (raw and canonical) and size are
/// re-checked on the canonical path, and the open runs through the same
/// [`super::ingest::ingest_paths_reporting`] every other ingress uses.
#[tauri::command]
pub async fn plain_file_open_confirmed<R: Runtime>(
    path: String,
    app: AppHandle<R>,
) -> Result<(), PlainFileError> {
    tauri::async_runtime::spawn_blocking(move || {
        let config_dir = config_dir(&app).map_err(gate_to_plain)?;
        let canonical = resolve_openable(&config_dir, &path_from_input(&path))?;
        super::ingest::ingest_paths_reporting(&app, vec![canonical])
    })
    .await
    .map_err(|_| registry_unavailable())?
}
