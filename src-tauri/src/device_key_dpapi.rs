// SPDX-License-Identifier: AGPL-3.0-only
//! The Windows device-key store: DPAPI, user-scoped, with this app's entropy
//! (`decisions/protocol/0761`, `identity-seat-portability` task 10).
//!
//! Installed from [`crate::device_key`], which is the same file on every host.
//!
//! **Scope is the current USER, never the machine.** `CRYPTPROTECT_LOCAL_MACHINE`
//! is deliberately NOT passed: a machine-scoped blob opens for every account on
//! the box, and the device key is that device's identity, not the box's. The cost
//! is that the same user on the same machine keeps the key across restarts, and a
//! copied blob under another account does not open, which is the property the
//! task asks for.

use myne_core::plugins::sync::device_identity::{
    from_item_bytes, install_host_provider, log_key_op, to_item_bytes, DeviceKeyProvider,
    DeviceKeyStoreError,
};

/// File name of the DPAPI-sealed device key inside the app config directory.
///
/// Beside `person-auth.json` rather than in the vault tree: the key is device-scoped
/// and outlives any one vault, so a per-vault directory would delete it when a vault
/// is forgotten.
const DPAPI_FILE: &str = "device-key.dpapi";

/// Additional entropy mixed into the protection, from the one list of families
/// (`crate::dpapi_entropy`). DPAPI already binds the blob to the user; entropy binds it to
/// *this* app and to *this* family, so another program running as the same user cannot
/// unprotect it and the label store's blobs do not open here.
const DPAPI_ENTROPY: &[u8] = crate::dpapi_entropy::DEVICE_KEY_ENTROPY;

/// Install DPAPI as `core`'s device-key provider.
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    install_host_provider(Box::new(DpapiProvider { app: app.clone() }));
}

struct DpapiProvider<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> DpapiProvider<R> {
    /// `app_config_dir()` is where the rest of the app's device-local state lives.
    /// A resolution failure is rung 4 rather than an error: there is no store to
    /// write to, and the person key path still works.
    fn path(&self) -> Option<std::path::PathBuf> {
        use tauri::Manager;
        self.app
            .path()
            .app_config_dir()
            .ok()
            .map(|dir| dir.join(DPAPI_FILE))
    }
}

impl<R: tauri::Runtime> DeviceKeyProvider for DpapiProvider<R> {
    fn load(&self) -> Result<Option<protocol::device_key::DeviceKeyPair>, DeviceKeyStoreError> {
        let Some(path) = self.path() else {
            return Ok(None);
        };
        let blob = match std::fs::read(&path) {
            Ok(blob) => blob,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                tracing::warn!(
                    stage = "device_key_dpapi",
                    op = "read",
                    kind = ?e.kind(),
                    "the sealed device key could not be read; this cycle signs with \
                     the person key"
                );
                return Err(DeviceKeyStoreError::Backend);
            }
        };
        let plaintext = match crate::dpapi::unprotect(&blob, DPAPI_ENTROPY) {
            Ok(plaintext) => plaintext,
            Err(()) => {
                // A different Windows account, a re-imaged box, or a corrupted
                // blob: the key is unrecoverable either way, so clear it and read
                // as ABSENT. Failing closed to rung 4 keeps a device that can
                // still sync (the person key signs `0x02`) instead of one that
                // warns on every cycle about a file nobody can fix.
                tracing::warn!(
                    stage = "device_key_dpapi",
                    op = "unprotect",
                    "the sealed device key does not open for this user; dropping it \
                     and signing with the person key"
                );
                let _ = std::fs::remove_file(&path);
                return Ok(None);
            }
        };
        from_item_bytes(&plaintext).map(Some)
    }

    fn store(&self, pair: &protocol::device_key::DeviceKeyPair) -> Result<(), DeviceKeyStoreError> {
        let Some(path) = self.path() else {
            return Err(DeviceKeyStoreError::Unsupported);
        };
        let sealed = crate::dpapi::protect(&to_item_bytes(pair), DPAPI_ENTROPY)
            .map_err(|()| DeviceKeyStoreError::Backend)?;
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Write-then-rename: a crash mid-write must not leave a truncated blob,
        // because a truncated blob reads as absent and silently re-mints a key,
        // which un-binds the device.
        let tmp = path.with_extension("dpapi.tmp");
        std::fs::write(&tmp, &sealed).map_err(|e| {
            tracing::warn!(
                stage = "device_key_dpapi",
                op = "write",
                kind = ?e.kind(),
                "the device key could not be sealed to disk; this device will sign \
                 with the person key"
            );
            DeviceKeyStoreError::Backend
        })?;
        let placed = std::fs::rename(&tmp, &path).map_err(|e| {
            tracing::warn!(
                stage = "device_key_dpapi",
                op = "rename",
                kind = ?e.kind(),
                "the sealed device key could not be moved into place; this device \
                 will sign with the person key"
            );
            let _ = std::fs::remove_file(&tmp);
            DeviceKeyStoreError::Backend
        });
        // The shared line the other platform arms write, so the diagnostics answer "was the key
        // ever written?" on a Windows device too (myne-md/myne#1027).
        log_key_op("store", if placed.is_ok() { "ok" } else { "refused" });
        placed
    }

    fn destroy(&self) {
        if let Some(path) = self.path() {
            // Best-effort: the erase's own guarantee is about vault content.
            let ok = std::fs::remove_file(&path).is_ok();
            log_key_op("delete", if ok { "ok" } else { "refused" });
        }
    }
}
