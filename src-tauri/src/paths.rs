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
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

/// Resolve the vault directory and ensure it exists. The returned
/// `PathBuf` always points at `<app_data_dir>/vault/` and the
/// directory is `create_dir_all`'d before return.
pub fn vault_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, AppError> {
    let base = app.path().app_data_dir().map_err(|_| AppError::Io {
        kind: crate::plugins::vault_creation::error::IoErrorKind::Other,
    })?;
    let dir = base.join("vault");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
