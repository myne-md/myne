//! WebView IPC commands for the **browser-clipper host install** toggle (TB10).
//!
//! The Settings "Connected extensions" section drives these to register /
//! deregister the native-messaging host manifest that lets the keyless clipper
//! extension launch this desktop host (see [`crate::clipper::install`]). They are
//! ordinary WebView→Rust IPC, so TB6 governs them: each has a NARROW named
//! permission in `permissions/clipper-pairing/default.toml` (co-located on the
//! `clipper-pairing` plugin to minimize ACL churn — same browser-extension
//! surface as pairing). No vault state is touched — the flag + manifests live
//! outside any vault, readable at boot before unlock.
//!
//! The manifest is config, not key material (host name + binary path + public
//! extension IDs). Per `src-tauri/CLAUDE.md` "Secret-handling logging discipline"
//! we still keep full paths out of logs — bounded outcome labels only.

use tauri::{AppHandle, Runtime};

use crate::clipper::install::{self, InstallStatus};

/// Closed failure surface for the install-toggle commands (`tag = "kind"`).
/// Carries no path — the WebView switches on the bounded `kind` only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind")]
pub enum ClipperInstallError {
    /// The app-data dir could not be resolved (no place to read/write the flag).
    AppDataUnavailable,
    /// Persisting the opt-in flag failed (the reconcile is best-effort and does
    /// not surface here — only the flag write is a hard error).
    WriteFailed,
}

impl ClipperInstallError {
    /// Stable `&'static str` label for tracing (mirrors the `*_error_kind`
    /// discipline; a new variant compile-fails the match).
    fn label(self) -> &'static str {
        match self {
            ClipperInstallError::AppDataUnavailable => "app_data_unavailable",
            ClipperInstallError::WriteFailed => "write_failed",
        }
    }
}

/// Read the current install status: the opt-in flag, the resolved host binary
/// path, and which browsers currently carry our manifest. Read-only.
#[tauri::command]
pub async fn clipper_install_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<InstallStatus, ClipperInstallError> {
    let base = crate::paths::app_data_dir(&app).map_err(|_| {
        tracing::error!(
            stage = "clipper_install_status",
            outcome = ClipperInstallError::AppDataUnavailable.label()
        );
        ClipperInstallError::AppDataUnavailable
    })?;
    Ok(install::status(&base))
}

/// Set the opt-in flag and reconcile the on-disk manifests immediately (enable →
/// register for every installed browser; disable → remove). Returns the fresh
/// status so the UI updates without a re-query. A flag-write failure is the only
/// hard error (the reconcile is best-effort).
#[tauri::command]
pub async fn clipper_install_set_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<InstallStatus, ClipperInstallError> {
    let base = crate::paths::app_data_dir(&app).map_err(|_| {
        tracing::error!(
            stage = "clipper_install_set_enabled",
            outcome = ClipperInstallError::AppDataUnavailable.label()
        );
        ClipperInstallError::AppDataUnavailable
    })?;
    let status = install::set_enabled(&base, enabled).map_err(|e| {
        let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
        tracing::error!(
            stage = "clipper_install_set_enabled",
            outcome = ClipperInstallError::WriteFailed.label(),
            io_failure_kind = ?kind
        );
        ClipperInstallError::WriteFailed
    })?;
    tracing::debug!(
        stage = "clipper_install_set_enabled",
        outcome = if enabled { "enabled" } else { "disabled" }
    );
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_serializes_with_a_closed_kind_tag() {
        let json = serde_json::to_value(ClipperInstallError::AppDataUnavailable).unwrap();
        assert_eq!(json["kind"], "AppDataUnavailable");
        let json = serde_json::to_value(ClipperInstallError::WriteFailed).unwrap();
        assert_eq!(json["kind"], "WriteFailed");
    }

    #[test]
    fn labels_are_stable() {
        assert_eq!(
            ClipperInstallError::AppDataUnavailable.label(),
            "app_data_unavailable"
        );
        assert_eq!(ClipperInstallError::WriteFailed.label(), "write_failed");
    }
}
