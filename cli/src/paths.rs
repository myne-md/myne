// SPDX-License-Identifier: AGPL-3.0-only
//! App-data-dir + command-socket/status-marker path resolution for the CLI
//! (cli-thin-client task 4; MYND-490).
//!
//! Independently mirrors `core::paths` / `cli_bridge::socket` /
//! `cli_bridge::status`'s own resolution — no dependency on `myne-desktop`
//! or `myne-core` (see the workspace `Cargo.toml` comment on this crate).

use std::path::{Path, PathBuf};

/// The desktop bundle identifier (`src-tauri/tauri.conf.json`'s
/// `identifier` field). Tauri's own `app_data_dir()` resolves to
/// `dirs::data_dir().join(identifier)` exactly (verified against the
/// vendored `tauri` crate's `src/path/desktop.rs::PathResolver::app_data_dir`)
/// — this constant is the ONE place this crate hardcodes that identifier.
/// `scripts/check-cli-sidecar.mjs` re-reads it and fails, naming the file,
/// when it stops matching `tauri.conf.json` or `src-tauri/src/cli_bridge/`;
/// a changed identifier there needs the same change here. (The check is a
/// guard, not a shared source: this crate deliberately depends on neither
/// `myne-desktop` nor `myne-core`, see the workspace `Cargo.toml`.)
const BUNDLE_IDENTIFIER: &str = "md.myne.desktop";

/// Basename of the command socket inside the app-data dir — matches
/// `src-tauri/src/cli_bridge/socket.rs::SOCKET_BASENAME` exactly (a wire
/// contract, not shared code).
///
/// Unix-only: the Windows transport is a named pipe, whose name is derived by
/// `crate::windows_pipe::pipe_path` rather than joined onto this directory.
#[cfg(unix)]
pub const SOCKET_BASENAME: &str = "cli.sock";

/// Basename of the status marker inside the app-data dir — matches
/// `src-tauri/src/cli_bridge/status.rs::STATUS_BASENAME` exactly.
pub const STATUS_BASENAME: &str = "cli-status";

/// Resolve the running desktop's app-data dir. `None` if the platform's
/// data directory cannot be determined at all (an unusual environment,
/// e.g. `$HOME` unset) — callers treat that the same as "app not running":
/// there is nowhere to even look for the socket or the status marker.
pub fn app_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join(BUNDLE_IDENTIFIER))
}

/// Resolve the command-socket path under an already-resolved app-data dir.
#[cfg(unix)]
pub fn socket_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SOCKET_BASENAME)
}

/// Resolve the status-marker path under an already-resolved app-data dir.
pub fn status_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(STATUS_BASENAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn socket_path_joins_the_basename() {
        assert_eq!(
            socket_path(Path::new("/some/app/data")),
            Path::new("/some/app/data/cli.sock")
        );
    }

    #[test]
    fn status_path_joins_the_basename() {
        assert_eq!(
            status_path(Path::new("/some/app/data")),
            Path::new("/some/app/data/cli-status")
        );
    }

    #[test]
    fn socket_and_status_paths_are_siblings_not_the_same_file() {
        let dir = Path::new("/some/app/data");
        assert_ne!(socket_path(dir), status_path(dir));
    }
}
