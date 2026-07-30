//! [`IpcBackend`] — the Phase 1 [`MyneBackend`]: talks to the desktop's
//! already-running, already-unlocked CLI bridge command socket
//! (`src-tauri/src/cli_bridge/`). Never opens the vault, never holds a
//! key, never prompts for a password.
//!
//! Unix-only today (`std::os::unix::net::UnixStream`), matching the
//! desktop-side command socket's own posture (`cli_bridge::socket`'s bind
//! is `#[cfg(unix)]`-only; the Windows named-pipe transport is a documented
//! seam there, not yet implemented, and this crate's dev/CI target is
//! Linux like the rest of this feature).

use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

use super::{BackendError, MyneBackend, SearchHit};
use crate::status::DoorState;
use crate::{framing, paths, status, wire};

pub struct IpcBackend {
    /// `None` when the platform data directory itself cannot be resolved
    /// (see `paths::app_data_dir`'s own doc comment) — every request then
    /// fails fast as `AppNotRunning` without attempting a connect.
    app_data_dir: Option<PathBuf>,
}

impl IpcBackend {
    /// Points at the real running desktop's app-data dir.
    pub fn new() -> Self {
        Self {
            app_data_dir: paths::app_data_dir(),
        }
    }

    /// Points at an explicit app-data dir — the test seam (a real desktop
    /// install lives at a fixed, non-injectable path via `paths::app_data_dir`,
    /// so tests exercise the real socket/status-file protocol against a
    /// temp dir instead).
    #[cfg(test)]
    fn at(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir: Some(app_data_dir),
        }
    }

    fn connect(&self) -> Result<UnixStream, BackendError> {
        let Some(dir) = &self.app_data_dir else {
            return Err(BackendError::AppNotRunning);
        };
        match UnixStream::connect(paths::socket_path(dir)) {
            Ok(stream) => Ok(stream),
            Err(_) => Err(self.classify_unreachable(dir)),
        }
    }

    /// The command socket exists ONLY while the door is Open
    /// (`cli_bridge::gate::DoorState::Open` — task 3), so a failed connect
    /// is the expected outcome in every other state. The `cli-status`
    /// marker (written whenever the app has ticked its lifecycle
    /// supervisor at least once — i.e. whenever it's running at all) is
    /// what tells the three refusal states apart; this is exactly the
    /// mechanism task 3's own doc comment built it for.
    fn classify_unreachable(&self, dir: &Path) -> BackendError {
        match status::read(dir) {
            Some(DoorState::Disabled) => BackendError::CliDisabled,
            Some(DoorState::Locked) => BackendError::VaultLocked,
            // The marker says Open but the connect still failed: a narrow
            // one-tick race (the door just closed and the socket file is
            // gone but the marker hasn't caught up yet, or vice versa) —
            // not a stable refusal state, so it is not one of the three
            // named exit codes. Treated as a generic connection failure.
            Some(DoorState::Open) => {
                BackendError::Io("could not reach the running app".to_string())
            }
            None => BackendError::AppNotRunning,
        }
    }

    fn request(&self, request: &wire::Request) -> Result<wire::RawResponse, BackendError> {
        let mut stream = self.connect()?;
        let body = serde_json::to_vec(request)
            .map_err(|_| BackendError::Io("could not encode the request".to_string()))?;
        framing::write_frame(&mut stream, &body)
            .map_err(|e| BackendError::Io(format!("could not send the request ({})", e.label())))?;
        let reply = framing::read_frame(&mut stream)
            .map_err(|e| BackendError::Io(format!("could not read the reply ({})", e.label())))?;
        serde_json::from_slice(&reply)
            .map_err(|_| BackendError::Io("the app sent an unreadable reply".to_string()))
    }
}

impl Default for IpcBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MyneBackend for IpcBackend {
    fn list(&self) -> Result<Vec<String>, BackendError> {
        let response = self.request(&wire::Request::List)?;
        if response.ok {
            return Ok(response.notes.unwrap_or_default());
        }
        Err(map_wire_error(response.error))
    }

    fn show(&self, id: &str) -> Result<String, BackendError> {
        let response = self.request(&wire::Request::Show { id: id.to_string() })?;
        if response.ok {
            return Ok(response.body.unwrap_or_default());
        }
        Err(map_wire_error(response.error))
    }

    fn search(&self, query: &str) -> Result<Vec<SearchHit>, BackendError> {
        let response = self.request(&wire::Request::Search {
            query: query.to_string(),
        })?;
        if response.ok {
            return Ok(response
                .results
                .unwrap_or_default()
                .into_iter()
                .map(|hit| SearchHit {
                    id: hit.id,
                    title: hit.title,
                })
                .collect());
        }
        Err(map_wire_error(response.error))
    }

    fn create(&self, body: &str, folder: Option<&str>) -> Result<String, BackendError> {
        let response = self.request(&wire::Request::New {
            body: body.to_string(),
            folder: folder.map(str::to_string),
        })?;
        if response.ok {
            return Ok(response.id.unwrap_or_default());
        }
        Err(map_wire_error(response.error))
    }

    fn daily(&self) -> Result<String, BackendError> {
        let response = self.request(&wire::Request::Daily)?;
        if response.ok {
            return Ok(response.body.unwrap_or_default());
        }
        Err(map_wire_error(response.error))
    }

    fn daily_append(&self, line: &str) -> Result<(), BackendError> {
        let response = self.request(&wire::Request::DailyAppend {
            line: line.to_string(),
        })?;
        if response.ok {
            return Ok(());
        }
        Err(map_wire_error(response.error))
    }
}

/// Map a failure reply's wire `kind` onto the transport-independent
/// [`BackendError`] taxonomy — one table for every command, rather than a
/// per-command copy that has to be revisited each time a kind is added (the
/// `rate_limited` kind of task 10 applies to all six commands at once,
/// since the limiter answers before the request is even parsed).
///
/// An unrecognized kind — including a kind a newer desktop knows and this
/// binary does not — falls through to [`BackendError::Io`] carrying the
/// desktop's own message, so a version-skewed pair still says something
/// true rather than mislabelling the failure.
fn map_wire_error(error: Option<wire::WireError>) -> BackendError {
    match error.as_ref().map(|e| e.kind.as_str()) {
        Some("vault_locked") => BackendError::VaultLocked,
        Some("not_found") => BackendError::NotFound,
        Some("folder_excluded") => BackendError::FolderExcluded,
        Some("rate_limited") => BackendError::RateLimited,
        _ => BackendError::Io(
            error
                .map(|e| e.message)
                .unwrap_or_else(|| "an internal error occurred".to_string()),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    // Unix socket paths are kernel-capped at ~104-108 bytes; a long temp-dir
    // name (e.g. one with a UUID) is too long once joined with a basename —
    // the exact problem `src-tauri/src/cli_bridge/socket.rs`'s own `ShortDir`
    // test helper exists to solve. Mirrored here for the same reason.
    struct ShortDir(PathBuf);
    impl ShortDir {
        fn new(tag: &str) -> Self {
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let name = format!("mcli{}_{}", n % 100_000_000, tag);
            let path = std::env::temp_dir().join(&name);
            let path = if path.as_os_str().len() > 40 {
                PathBuf::from(format!("/tmp/{name}"))
            } else {
                path
            };
            std::fs::create_dir_all(&path).expect("create short temp dir");
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for ShortDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn serve_once(listener: UnixListener, reply_body: Vec<u8>) {
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = framing::read_frame(&mut stream);
                let _ = framing::write_frame(&mut stream, &reply_body);
            }
        });
    }

    #[test]
    fn no_app_data_dir_is_app_not_running() {
        let backend = IpcBackend { app_data_dir: None };
        assert_eq!(backend.list(), Err(BackendError::AppNotRunning));
    }

    #[test]
    fn no_socket_and_no_marker_is_app_not_running() {
        let dir = ShortDir::new("absent");
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.list(), Err(BackendError::AppNotRunning));
    }

    #[test]
    fn marker_disabled_with_no_socket_is_cli_disabled() {
        let dir = ShortDir::new("disabled");
        std::fs::write(paths::status_path(dir.path()), b"D").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.list(), Err(BackendError::CliDisabled));
    }

    #[test]
    fn marker_locked_with_no_socket_is_vault_locked() {
        let dir = ShortDir::new("locked");
        std::fs::write(paths::status_path(dir.path()), b"L").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.list(), Err(BackendError::VaultLocked));
    }

    #[test]
    fn real_socket_returns_the_note_list() {
        let dir = ShortDir::new("list-ok");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(listener, br#"{"ok":true,"notes":["a","b"]}"#.to_vec());
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.list(), Ok(vec!["a".to_string(), "b".to_string()]));
    }

    #[test]
    fn real_socket_vault_locked_error_maps_through() {
        let dir = ShortDir::new("list-locked");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":false,"error":{"kind":"vault_locked","message":"x"}}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.list(), Err(BackendError::VaultLocked));
    }

    #[test]
    fn real_socket_unrecognized_error_kind_maps_to_io() {
        let dir = ShortDir::new("list-io");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":false,"error":{"kind":"invalid_request","message":"bad"}}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        match backend.list() {
            Err(BackendError::Io(_)) => {}
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn a_malformed_reply_never_panics_and_maps_to_io() {
        let dir = ShortDir::new("malformed");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(listener, b"not json".to_vec());
        let backend = IpcBackend::at(dir.path().to_path_buf());
        match backend.list() {
            Err(BackendError::Io(_)) => {}
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn show_no_app_data_dir_is_app_not_running() {
        let backend = IpcBackend { app_data_dir: None };
        assert_eq!(backend.show("x"), Err(BackendError::AppNotRunning));
    }

    #[test]
    fn show_marker_disabled_with_no_socket_is_cli_disabled() {
        let dir = ShortDir::new("show-disabled");
        std::fs::write(paths::status_path(dir.path()), b"D").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.show("x"), Err(BackendError::CliDisabled));
    }

    #[test]
    fn show_marker_locked_with_no_socket_is_vault_locked() {
        let dir = ShortDir::new("show-locked");
        std::fs::write(paths::status_path(dir.path()), b"L").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.show("x"), Err(BackendError::VaultLocked));
    }

    #[test]
    fn real_socket_returns_the_note_body() {
        let dir = ShortDir::new("show-ok");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(listener, br#"{"ok":true,"body":"hello world"}"#.to_vec());
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.show("x"), Ok("hello world".to_string()));
    }

    #[test]
    fn real_socket_not_found_error_maps_through() {
        let dir = ShortDir::new("show-not-found");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":false,"error":{"kind":"not_found","message":"x"}}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.show("bogus"), Err(BackendError::NotFound));
    }

    #[test]
    fn real_socket_show_vault_locked_error_maps_through() {
        let dir = ShortDir::new("show-locked-wire");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":false,"error":{"kind":"vault_locked","message":"x"}}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.show("x"), Err(BackendError::VaultLocked));
    }

    #[test]
    fn search_no_app_data_dir_is_app_not_running() {
        let backend = IpcBackend { app_data_dir: None };
        assert_eq!(backend.search("x"), Err(BackendError::AppNotRunning));
    }

    #[test]
    fn search_marker_disabled_with_no_socket_is_cli_disabled() {
        let dir = ShortDir::new("search-disabled");
        std::fs::write(paths::status_path(dir.path()), b"D").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.search("x"), Err(BackendError::CliDisabled));
    }

    #[test]
    fn search_marker_locked_with_no_socket_is_vault_locked() {
        let dir = ShortDir::new("search-locked");
        std::fs::write(paths::status_path(dir.path()), b"L").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.search("x"), Err(BackendError::VaultLocked));
    }

    #[test]
    fn real_socket_returns_search_hits() {
        let dir = ShortDir::new("search-ok");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":true,"results":[{"id":"a","title":"Note A"}]}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(
            backend.search("a"),
            Ok(vec![SearchHit {
                id: "a".to_string(),
                title: "Note A".to_string()
            }])
        );
    }

    #[test]
    fn real_socket_empty_search_result_is_an_empty_vec() {
        let dir = ShortDir::new("search-empty");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(listener, br#"{"ok":true,"results":[]}"#.to_vec());
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.search("nothing"), Ok(vec![]));
    }

    #[test]
    fn real_socket_search_vault_locked_error_maps_through() {
        let dir = ShortDir::new("search-locked-wire");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":false,"error":{"kind":"vault_locked","message":"x"}}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.search("x"), Err(BackendError::VaultLocked));
    }

    #[test]
    fn search_request_carries_the_requested_query() {
        let dir = ShortDir::new("search-query");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let body = framing::read_frame(&mut stream).unwrap();
                tx.send(body).unwrap();
                let _ = framing::write_frame(&mut stream, br#"{"ok":true,"results":[]}"#);
            }
        });
        let backend = IpcBackend::at(dir.path().to_path_buf());
        backend.search("unique term").unwrap();
        let sent = rx.recv().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&sent).unwrap();
        assert_eq!(value["cmd"], "search");
        assert_eq!(value["query"], "unique term");
    }

    #[test]
    fn create_no_app_data_dir_is_app_not_running() {
        let backend = IpcBackend { app_data_dir: None };
        assert_eq!(
            backend.create("hello", None),
            Err(BackendError::AppNotRunning)
        );
    }

    #[test]
    fn create_marker_disabled_with_no_socket_is_cli_disabled() {
        let dir = ShortDir::new("new-disabled");
        std::fs::write(paths::status_path(dir.path()), b"D").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(
            backend.create("hello", None),
            Err(BackendError::CliDisabled)
        );
    }

    #[test]
    fn create_marker_locked_with_no_socket_is_vault_locked() {
        let dir = ShortDir::new("new-locked");
        std::fs::write(paths::status_path(dir.path()), b"L").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(
            backend.create("hello", None),
            Err(BackendError::VaultLocked)
        );
    }

    #[test]
    fn real_socket_returns_the_new_note_id() {
        let dir = ShortDir::new("new-ok");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(listener, br#"{"ok":true,"id":"abc-123"}"#.to_vec());
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.create("hello", None), Ok("abc-123".to_string()));
    }

    #[test]
    fn real_socket_folder_excluded_error_maps_through() {
        let dir = ShortDir::new("new-excluded");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":false,"error":{"kind":"folder_excluded","message":"x"}}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(
            backend.create("hello", Some("Private/")),
            Err(BackendError::FolderExcluded)
        );
    }

    #[test]
    fn real_socket_create_vault_locked_error_maps_through() {
        let dir = ShortDir::new("new-locked-wire");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":false,"error":{"kind":"vault_locked","message":"x"}}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(
            backend.create("hello", None),
            Err(BackendError::VaultLocked)
        );
    }

    #[test]
    fn create_request_carries_the_body_and_folder() {
        let dir = ShortDir::new("new-body-folder");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let body = framing::read_frame(&mut stream).unwrap();
                tx.send(body).unwrap();
                let _ = framing::write_frame(&mut stream, br#"{"ok":true,"id":"x"}"#);
            }
        });
        let backend = IpcBackend::at(dir.path().to_path_buf());
        backend.create("note body", Some("Work/")).unwrap();
        let sent = rx.recv().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&sent).unwrap();
        assert_eq!(value["cmd"], "new");
        assert_eq!(value["body"], "note body");
        assert_eq!(value["folder"], "Work/");
    }

    #[test]
    fn create_request_with_no_folder_omits_the_folder_field() {
        let dir = ShortDir::new("new-no-folder");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let body = framing::read_frame(&mut stream).unwrap();
                tx.send(body).unwrap();
                let _ = framing::write_frame(&mut stream, br#"{"ok":true,"id":"x"}"#);
            }
        });
        let backend = IpcBackend::at(dir.path().to_path_buf());
        backend.create("note body", None).unwrap();
        let sent = rx.recv().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&sent).unwrap();
        assert_eq!(value["cmd"], "new");
        assert!(value.get("folder").is_none());
    }

    #[test]
    fn show_request_carries_the_requested_id() {
        // The desktop side only sees the frame bytes — decode them here to
        // prove the id round-trips through `IpcBackend::show` onto the wire
        // rather than being dropped or hardcoded.
        let dir = ShortDir::new("show-id");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let body = framing::read_frame(&mut stream).unwrap();
                tx.send(body).unwrap();
                let _ = framing::write_frame(&mut stream, br#"{"ok":true,"body":"x"}"#);
            }
        });
        let backend = IpcBackend::at(dir.path().to_path_buf());
        backend.show("note-42").unwrap();
        let sent = rx.recv().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&sent).unwrap();
        assert_eq!(value["cmd"], "show");
        assert_eq!(value["id"], "note-42");
    }

    #[test]
    fn daily_no_app_data_dir_is_app_not_running() {
        let backend = IpcBackend { app_data_dir: None };
        assert_eq!(backend.daily(), Err(BackendError::AppNotRunning));
    }

    #[test]
    fn daily_marker_disabled_with_no_socket_is_cli_disabled() {
        let dir = ShortDir::new("daily-disabled");
        std::fs::write(paths::status_path(dir.path()), b"D").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.daily(), Err(BackendError::CliDisabled));
    }

    #[test]
    fn daily_marker_locked_with_no_socket_is_vault_locked() {
        let dir = ShortDir::new("daily-locked");
        std::fs::write(paths::status_path(dir.path()), b"L").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.daily(), Err(BackendError::VaultLocked));
    }

    #[test]
    fn real_socket_returns_the_daily_note_body() {
        let dir = ShortDir::new("daily-ok");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(listener, br#"{"ok":true,"body":"today's note"}"#.to_vec());
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.daily(), Ok("today's note".to_string()));
    }

    #[test]
    fn real_socket_daily_folder_excluded_error_maps_through() {
        let dir = ShortDir::new("daily-excluded");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":false,"error":{"kind":"folder_excluded","message":"x"}}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.daily(), Err(BackendError::FolderExcluded));
    }

    #[test]
    fn real_socket_daily_vault_locked_error_maps_through() {
        let dir = ShortDir::new("daily-locked-wire");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":false,"error":{"kind":"vault_locked","message":"x"}}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.daily(), Err(BackendError::VaultLocked));
    }

    #[test]
    fn daily_request_encodes_the_documented_shape_on_the_wire() {
        let dir = ShortDir::new("daily-cmd");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let body = framing::read_frame(&mut stream).unwrap();
                tx.send(body).unwrap();
                let _ = framing::write_frame(&mut stream, br#"{"ok":true,"body":""}"#);
            }
        });
        let backend = IpcBackend::at(dir.path().to_path_buf());
        backend.daily().unwrap();
        let sent = rx.recv().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&sent).unwrap();
        assert_eq!(value["cmd"], "daily");
    }

    #[test]
    fn daily_append_no_app_data_dir_is_app_not_running() {
        let backend = IpcBackend { app_data_dir: None };
        assert_eq!(backend.daily_append("x"), Err(BackendError::AppNotRunning));
    }

    #[test]
    fn daily_append_marker_disabled_with_no_socket_is_cli_disabled() {
        let dir = ShortDir::new("daily-append-disabled");
        std::fs::write(paths::status_path(dir.path()), b"D").unwrap();
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.daily_append("x"), Err(BackendError::CliDisabled));
    }

    #[test]
    fn real_socket_daily_append_ok_returns_unit() {
        let dir = ShortDir::new("daily-append-ok");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(listener, br#"{"ok":true}"#.to_vec());
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.daily_append("a new line"), Ok(()));
    }

    #[test]
    fn real_socket_daily_append_folder_excluded_error_maps_through() {
        let dir = ShortDir::new("daily-append-excluded");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        serve_once(
            listener,
            br#"{"ok":false,"error":{"kind":"folder_excluded","message":"x"}}"#.to_vec(),
        );
        let backend = IpcBackend::at(dir.path().to_path_buf());
        assert_eq!(backend.daily_append("x"), Err(BackendError::FolderExcluded));
    }

    #[test]
    fn real_socket_rate_limited_error_maps_through_on_every_command() {
        // The limiter answers before the request is even parsed (task 10),
        // so `rate_limited` can come back from ANY command — this asserts
        // the shared `map_wire_error` table really does cover all six,
        // which the previous per-command copies would not have.
        let reply = br#"{"ok":false,"error":{"kind":"rate_limited","message":"x"}}"#;
        type Call = Box<dyn Fn(&IpcBackend) -> BackendError>;
        let cases: Vec<(&str, Call)> = vec![
            ("list", Box::new(|b: &IpcBackend| b.list().unwrap_err())),
            ("show", Box::new(|b: &IpcBackend| b.show("x").unwrap_err())),
            (
                "search",
                Box::new(|b: &IpcBackend| b.search("x").unwrap_err()),
            ),
            (
                "new",
                Box::new(|b: &IpcBackend| b.create("x", None).unwrap_err()),
            ),
            ("daily", Box::new(|b: &IpcBackend| b.daily().unwrap_err())),
            (
                "daily_append",
                Box::new(|b: &IpcBackend| b.daily_append("x").unwrap_err()),
            ),
        ];
        for (name, call) in cases {
            let dir = ShortDir::new(&format!("rl-{name}"));
            let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
            serve_once(listener, reply.to_vec());
            let backend = IpcBackend::at(dir.path().to_path_buf());
            assert_eq!(
                call(&backend),
                BackendError::RateLimited,
                "{name} must surface a rate-limited reply as RateLimited"
            );
        }
    }

    #[test]
    fn daily_append_request_carries_the_line() {
        let dir = ShortDir::new("daily-append-line");
        let listener = UnixListener::bind(paths::socket_path(dir.path())).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let body = framing::read_frame(&mut stream).unwrap();
                tx.send(body).unwrap();
                let _ = framing::write_frame(&mut stream, br#"{"ok":true}"#);
            }
        });
        let backend = IpcBackend::at(dir.path().to_path_buf());
        backend.daily_append("captured thought").unwrap();
        let sent = rx.recv().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&sent).unwrap();
        assert_eq!(value["cmd"], "daily_append");
        assert_eq!(value["line"], "captured thought");
    }
}
