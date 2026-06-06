//! Filesystem path resolution for vault data.
//!
//! Spec / decisions: see
//! `agent-tooling/sessions/design/2026-04-28-vault-creation-flow.md` Q5.
//! v0.1 places the vault under `<app_data_dir>/vault/`:
//!
//! - macOS: `~/Library/Application Support/md.myne.desktop/vault/`
//! - Linux: `~/.local/share/md.myne.desktop/vault/`
//! - Windows: `%APPDATA%\md.myne.desktop\vault\`
//!
//! The `vault/` subdirectory keeps vault data separate from Tauri
//! logs / cache that share `app_data_dir`, so a future "Export vault"
//! menu item ships only the right bytes.

use crate::plugins::vault_creation::error::AppError;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

/// Resolve the vault directory and ensure it exists. The returned
/// `PathBuf` always points at `<app_data_dir>/vault/` and the
/// directory is `create_dir_all`'d before return.
pub fn vault_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    // The non-creating resolver owns the base-path lookup + error mapping;
    // this adds only the `create_dir_all` side effect.
    let dir = vault_dir_path(app)?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Resolve the vault directory path **without creating it**.
///
/// Used by read-only probes — `vault_repair`'s residue scan (MYND-159) —
/// that must not have the side effect of materializing an empty `vault/`
/// directory on a device that never created a vault. [`vault_dir`] (which
/// `create_dir_all`s) stays the canonical resolver for write paths.
pub fn vault_dir_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    let base = app.path().app_data_dir().map_err(|_| AppError::Io {
        kind: crate::plugins::vault_creation::error::IoErrorKind::Other,
    })?;
    Ok(base.join("vault"))
}

/// Resolve `<vault-root>/notes/` and ensure it exists. The returned
/// `PathBuf` always points at `<app_data_dir>/vault/notes/` and the
/// directory is `create_dir_all`'d before return.
///
/// Returns [`std::io::Result`] (rather than [`AppError`]) so the
/// `notes` plugin's commands (Tasks 8 / 9) can match on
/// [`std::io::ErrorKind`] — the file-at-notes-path conflict is
/// special-cased into `NoteCreateError::NotesDirNotADirectory`. The
/// `vault_creation`'s `AppError` shape collapses kind information into
/// `IoErrorKind::Other`, which would lose that signal.
///
/// Idempotent: `create_dir_all` is recursive, so a missing
/// `<app_data>/vault` parent is created in the same call; second call
/// on the same `app` is a no-op.
///
/// Tested via the lower-level [`notes_dir_under`] helper (which takes
/// a base path directly, allowing `ScopedTempDir` exercise without
/// `tauri::test::mock_app_builder`).
pub fn notes_dir<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| std::io::Error::other("app_data_dir resolution failed"))?;
    notes_dir_under(&base.join("vault"))
}

/// Pure helper — joins `parent` with `"notes"` and `create_dir_all`s
/// the result. Used by [`notes_dir`] (Tauri-aware caller) and tests.
///
/// `parent` is the vault root in production; tests pass a
/// `ScopedTempDir` path so `notes_dir`'s behavior can be exercised
/// without spinning up a Tauri runtime.
pub(crate) fn notes_dir_under(parent: &Path) -> std::io::Result<PathBuf> {
    let dir = parent.join("notes");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    // ---- happy paths ---------------------------------------------------

    #[test]
    fn notes_dir_under_creates_on_first_call() {
        let tmp = ScopedTempDir::new("notes-dir-first").unwrap();
        let result = notes_dir_under(tmp.path()).unwrap();
        assert!(result.is_dir(), "result must be an existing directory");
        assert_eq!(result, tmp.path().join("notes"));
    }

    #[test]
    fn notes_dir_under_is_idempotent_on_second_call() {
        let tmp = ScopedTempDir::new("notes-dir-idem").unwrap();
        let first = notes_dir_under(tmp.path()).unwrap();
        let second = notes_dir_under(tmp.path()).unwrap();
        assert_eq!(first, second, "second call must return the same path");
        assert!(second.is_dir());
    }

    #[test]
    fn notes_dir_under_returns_canonical_join() {
        let tmp = ScopedTempDir::new("notes-dir-canonical").unwrap();
        let result = notes_dir_under(tmp.path()).unwrap();
        assert_eq!(result, tmp.path().join("notes"));
        assert!(result.starts_with(tmp.path()));
        assert_eq!(result.file_name().expect("filename"), "notes");
    }

    #[test]
    fn notes_dir_under_creates_missing_parent() {
        // `create_dir_all` is recursive — even if `parent` itself
        // doesn't exist, the call should create both.
        let tmp = ScopedTempDir::new("notes-dir-recursive").unwrap();
        let nested_parent = tmp.path().join("vault-that-doesnt-exist-yet");
        let result = notes_dir_under(&nested_parent).unwrap();
        assert!(result.is_dir());
        assert!(nested_parent.is_dir(), "parent must be created too");
        assert_eq!(result, nested_parent.join("notes"));
    }

    // ---- file-at-notes-path defensive ---------------------------------
    //
    // When the user has manually placed a file at `<parent>/notes`
    // (OS-level manipulation of the vault directory), `create_dir_all`
    // surfaces the conflict via an IO error. The exact `io::ErrorKind`
    // depends on platform + Rust version: stable Rust ≥ 1.83 returns
    // `NotADirectory` on Unix; older Rust + Windows may return
    // `AlreadyExists`. Task 8's mapping accepts either via
    // `matches!(io_kind, NotADirectory | AlreadyExists)` →
    // `NotesDirNotADirectory`.

    #[test]
    fn notes_dir_under_errors_when_path_is_a_file() {
        let tmp = ScopedTempDir::new("notes-dir-file-conflict").unwrap();
        let conflict = tmp.path().join("notes");
        std::fs::write(&conflict, b"hostile").unwrap();

        let err = notes_dir_under(tmp.path())
            .expect_err("create_dir_all must reject when <parent>/notes is a regular file");

        let kind = err.kind();
        assert!(
            matches!(
                kind,
                std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists
            ),
            "expected NotADirectory or AlreadyExists, got {kind:?}"
        );

        // Pre-existing file bytes are untouched — the helper rejected
        // before any directory mutation happened.
        let bytes = std::fs::read(&conflict).unwrap();
        assert_eq!(bytes, b"hostile");
    }
}
