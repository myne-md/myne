// SPDX-License-Identifier: AGPL-3.0
//! The OS ingress for the plain-file editor (myne-md/myne#788).
//!
//! One funnel for every path that arrives from outside the WebView:
//! Windows/Linux file-association argv (including the second-launch argv the
//! single-instance plugin forwards), the macOS `RunEvent::Opened` file URLs,
//! the in-app dialog, the CLI command and the confirmed deep link. Each
//! funnels into [`ingest_paths`], which is the only place that calls
//! `PlainFileRegistry::open` on a path this app did not itself produce.
//!
//! **The drag ingress is deliberately not wired here.** Tauri's native
//! `WindowEvent::DragDrop` requires `dragDropEnabled: true`, and enabling it
//! consumes every OS file drop at the wry layer (`tauri-runtime-wry`'s
//! handler returns `true` unconditionally): the WebView stops receiving the
//! HTML5 `DataTransfer` that MYND-629's drag-import and the sidebar's
//! HTML5 reorder both depend on, and on Windows wry additionally disables
//! external drops outright (`SetAllowExternalDrop(false)`). The main window
//! therefore keeps `dragDropEnabled: false` (`agent-tooling/design-notes/storage/0151`;
//! `src/notes/dropImport.ts`), and a drop cannot carry a filesystem path the
//! WebView could hand back. Wiring drag means re-basing those two flows
//! first; see the feature's tasks.md task 10.
//!
//! **Silent while off or refused.** A gate-off request, an unsupported
//! extension or an unreadable file produces no event and no dialog: the only
//! channel to the user here would be a window that may not exist yet, and the
//! design decision is that the gate-off state is invisible by construction.
//! [`ingest_paths_reporting`] exists for the callers where the user IS looking
//! at the app (the dialog, the CLI, the confirmed deep link), which translate
//! the typed refusal into their own surface.

use super::commands::SharedRegistry;
use super::gate::{gate_path_in, read_gate};
use super::handles::PlainFileError;
use std::path::PathBuf;
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri::Url;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Frontend event carrying an `OpenedFile` payload.
pub const OPENED_EVENT: &str = "plain-file:opened";

/// The label of the sole app window (`tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";

/// Ingest the first openable file from an OS-delivered argument vector.
///
/// `argv[0]` is skipped, dash-prefixed arguments are ignored (the app has
/// other argv flags, e.g. `--native-messaging-host` and the screen-capture
/// override), and non-existing paths are skipped, so an ordinary launch with
/// no file arguments is a no-op.
pub fn ingest_args<R: Runtime>(app: &AppHandle<R>, args: Vec<String>) {
    let paths: Vec<PathBuf> = args
        .into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .collect();
    ingest_paths(app, paths);
}

/// Ingest the first openable file from a URL list (macOS `RunEvent::Opened`).
///
/// Gated to the platforms that deliver `RunEvent::Opened`; on Linux the sole
/// caller does not exist, so an ungated definition is dead code and fails
/// clippy's `-D warnings` in CI.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
pub fn ingest_urls<R: Runtime>(app: &AppHandle<R>, urls: Vec<Url>) {
    let paths: Vec<PathBuf> = urls
        .iter()
        .filter_map(|url| url.to_file_path().ok())
        .collect();
    ingest_paths(app, paths);
}

/// Open the first path that is actually openable, and tell the frontend.
///
/// First-match-wins rather than opening several: a file-association launch
/// with more than one file is a bulk action, and v1's honest answer for it is
/// one tab, not a silent fan-out of N windows nobody asked for. Fire and
/// forget: the OS ingresses have no user to answer, so [`ingest_paths`] keeps
/// this module's silent posture and [`ingest_paths_reporting`] carries the
/// typed outcome for the callers that do.
pub fn ingest_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    let _ = ingest_paths_reporting(app, paths);
}

/// [`ingest_paths`] with its outcome returned.
///
/// `Ok(())` means a handle was minted and the event emitted. `Err` is the last
/// refusal seen; it is a [`PlainFileError`], so it carries a closed enum and
/// never a path or file content (the DENY list in `src-tauri/AGENTS.md`).
/// An empty list is `Ok(())`: no path was asked about, nothing to refuse.
pub fn ingest_paths_reporting<R: Runtime>(
    app: &AppHandle<R>,
    paths: Vec<PathBuf>,
) -> Result<(), PlainFileError> {
    if paths.is_empty() {
        return Ok(());
    }
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| PlainFileError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        })?;
    if !read_gate(&gate_path_in(&config_dir)) {
        return Err(PlainFileError::GateOff);
    }
    let registry = app.state::<SharedRegistry>();
    let mut last_refusal = PlainFileError::NotAFile;
    let Ok(mut guard) = registry.lock().map_err(|_| ()) else {
        return Err(PlainFileError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        });
    };
    for path in paths {
        match guard.open(&config_dir, &path) {
            Ok(opened) => {
                // Best-effort: the frontend also drains `take_unclaimed` on
                // mount, so an emit into a WebView that is not listening yet
                // loses nothing.
                let _ = app.emit_to(MAIN_WINDOW, OPENED_EVENT, &opened);
                return Ok(());
            }
            Err(refusal) => last_refusal = refusal,
        }
    }
    Err(last_refusal)
}
