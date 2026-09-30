//! The OS ingress for the plain-file editor (myne-md/myne#788).
//!
//! One funnel for every path that arrives from outside the WebView:
//! Windows/Linux file-association argv (including the second-launch argv the
//! single-instance plugin forwards), the macOS `RunEvent::Opened` file URLs,
//! and (a later task) the in-app dialog, the CLI command and the confirmed
//! deep link. Each funnels into [`ingest_paths`], which is the only place that
//! calls `PlainFileRegistry::open` on a path this app did not itself produce.
//!
//! **Silent while off or refused.** A gate-off request, an unsupported
//! extension or an unreadable file produces no event and no dialog: the only
//! channel to the user here would be a window that may not exist yet, and the
//! design decision is that the gate-off state is invisible by construction.
//! The in-app dialog path (a later task) is where a refusal gets a message,
//! because there the user is looking at the app.

use super::commands::SharedRegistry;
use super::gate::{gate_path_in, read_gate};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Runtime, Url};

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
/// one tab, not a silent fan-out of N windows nobody asked for.
pub fn ingest_paths<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    let Ok(config_dir) = app.path().app_config_dir() else {
        return;
    };
    if !read_gate(&gate_path_in(&config_dir)) {
        return;
    }
    let registry = app.state::<SharedRegistry>();
    let Ok(mut guard) = registry.lock().map_err(|_| ()) else {
        return;
    };
    for path in paths {
        if let Ok(opened) = guard.open(&config_dir, &path) {
            // Best-effort: the frontend also drains `take_unclaimed` on mount,
            // so an emit into a WebView that is not listening yet loses
            // nothing.
            let _ = app.emit_to(MAIN_WINDOW, OPENED_EVENT, &opened);
            break;
        }
    }
}
