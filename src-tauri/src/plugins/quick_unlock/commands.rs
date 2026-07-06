//! Desktop quick-unlock commands.
//!
//! The PIN path, status, and the OS-free `*_with_dir` cores come from
//! `myne-core` (`myne_core::plugins::quick_unlock::commands`, shared with
//! mobile). This crate adds the macOS Touch ID biometric branch + the
//! OS-credential (Keychain) cleanup that layer over the shared cores.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline" — `root_key`,
//! `items_key`, `wrap_key`, and the PIN are never logged.

use std::path::Path;

use tauri::{AppHandle, Runtime, State};

use crate::plugins::vault_unlock::state::VaultRuntimeState;
use myne_core::plugins::quick_unlock::commands::{active_dir, disable_with_dir, wipe_files};
use myne_core::plugins::quick_unlock::error::QuickUnlockError;
// The PIN/status commands are registered directly from the myne-core module path
// in `mod.rs::init()` (a bare `pub use` of a `#[tauri::command]` fn would not
// carry its hidden `__cmd__` items), so this module only defines the desktop
// biometric branch + OS-credential cleanup.

/// Best-effort removal of the macOS biometric Keychain credential for the vault
/// at `dir`. No-op on non-macOS and harmless for a PIN vault (the item simply
/// won't exist). Used by disable + invalidation so a biometric credential's
/// OS-side item does not outlive its blob.
fn cleanup_os_credential(dir: &Path) {
    #[cfg(target_os = "macos")]
    if let Ok((_, meta)) = myne_core::plugins::quick_unlock::commands::read_meta(dir) {
        use myne_core::plugins::quick_unlock::provider::QuickUnlockProvider;
        let _ = super::macos::MacosBiometricProvider::new(meta.account_number_hash).delete();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = dir;
}

/// Cross-plugin invalidation hook (MYND-329 task 8): wipe the device-local
/// quick-unlock credential + its macOS keychain item (if any). Called on a
/// master-password change (defense-in-depth reset). Best-effort no-op when
/// nothing is configured.
pub(crate) fn invalidate_credential(dir: &Path) {
    cleanup_os_credential(dir);
    wipe_files(dir);
}

/// Configure macOS Touch ID quick-unlock for the active (Unlocked) vault.
///
/// ⚠️ The macOS provider's biometric gating is UNVERIFIED pending Touch ID
/// hardware + a primitive review (see `macos.rs`). Returns `HardwareUnavailable`
/// off macOS.
#[tauri::command]
pub async fn quick_unlock_setup_biometric<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<(), QuickUnlockError> {
    #[cfg(target_os = "macos")]
    {
        use myne_core::plugins::quick_unlock::commands::{read_meta, setup_with_dir};
        let dir = active_dir(&app, &state).await?;
        let (_, meta) = read_meta(&dir)?;
        let provider = super::macos::MacosBiometricProvider::new(meta.account_number_hash);
        setup_with_dir(&dir, &state, provider, &meta.account_number_hash).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &state);
        Err(QuickUnlockError::HardwareUnavailable)
    }
}

/// Attempt a macOS Touch ID quick-unlock of the active vault. (See the setup
/// command's verification caveat.)
#[tauri::command]
pub async fn quick_unlock_with_biometric<R: Runtime>(
    vault_id: Option<String>,
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<(), QuickUnlockError> {
    #[cfg(target_os = "macos")]
    {
        use myne_core::plugins::quick_unlock::commands::{quick_unlock_with_dir, read_meta, target_dir};
        let dir = target_dir(&app, &state, vault_id.as_deref()).await?;
        let (_, meta) = read_meta(&dir)?;
        let id = myne_core::paths::vault_id_from_root(&dir);
        let provider = super::macos::MacosBiometricProvider::new(meta.account_number_hash);
        quick_unlock_with_dir(&dir, id, &state, provider).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &state, &vault_id);
        Err(QuickUnlockError::HardwareUnavailable)
    }
}

/// Disable quick-unlock for the active vault (device-local files + the macOS
/// keychain item, if any).
#[tauri::command]
pub async fn quick_unlock_disable<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<(), QuickUnlockError> {
    let dir = active_dir(&app, &state).await?;
    cleanup_os_credential(&dir);
    disable_with_dir(&dir)
}
