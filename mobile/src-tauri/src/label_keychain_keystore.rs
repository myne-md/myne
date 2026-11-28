// SPDX-License-Identifier: AGPL-3.0-only
//! The Android label store: the Keystore, over the Kotlin `tauri-plugin-label-store`
//! bridge (myne-md/myne#1091, `decisions/clients/0795`).
//!
//! Installed from [`crate::label_store`], which is the same file on every host.
//!
//! ⚠️ **DEVICE-VERIFY-PENDING.** The Kotlin half cannot be compiled or run on this dev
//! host, and no CI lane builds Android Kotlin (`rust-toolchain.toml` pins `wasm32` and
//! nothing else, and `mobile-compile` clippy's the HOST target), so what is proven today
//! is that this Rust half compiles for the host and that `core`'s provider seam and policy
//! hold (its own tests, on a fake provider). The Keystore behaviour (non-biometric,
//! device-only, no prompt, surviving an app restart, per-item delete) needs a real device;
//! the row to run is in `dev-notes/device-matrix.md`.

use myne_core::vault_label::error::VaultLabelError;
use myne_core::vault_label::key::{install_host_keychain, LabelKeychain};
use zeroize::Zeroizing;

/// Install the Android Keystore store as `core`'s label store.
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    install_host_keychain(Box::new(KeystoreLabelStore { app: app.clone() }));
}

struct KeystoreLabelStore<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> KeystoreLabelStore<R> {
    /// A host that registered the plugin always has this state, so a missing one is a
    /// WIRING failure and is reported as one rather than as the platform having no
    /// store: `Unsupported` here would be the silent arm, and a build whose plugin was
    /// registered without its state would keep no name with nothing in the log saying
    /// why (the same collapse the device-key store records, myne-md/myne#938 review).
    fn store(
        &self,
    ) -> Result<tauri::State<'_, tauri_plugin_label_store::LabelStore<R>>, VaultLabelError> {
        use tauri::Manager;
        self.app
            .try_state::<tauri_plugin_label_store::LabelStore<R>>()
            .ok_or(VaultLabelError::Backend)
    }
}

impl<R: tauri::Runtime> LabelKeychain for KeystoreLabelStore<R> {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultLabelError> {
        let store = self.store()?;
        let bytes = store.open(account).map_err(|_| VaultLabelError::Backend)?;
        Ok(bytes.map(Zeroizing::new))
    }

    fn store(&self, account: &str, secret: &[u8]) -> Result<(), VaultLabelError> {
        let result = self.store().and_then(|store| {
            store
                .seal(account, secret)
                .map_err(|_| VaultLabelError::Backend)
        });
        log_key_op("store", if result.is_ok() { "ok" } else { "refused" });
        result
    }

    fn delete(&self, account: &str) -> Result<(), VaultLabelError> {
        let result = self
            .store()
            .and_then(|store| store.delete(account).map_err(|_| VaultLabelError::Backend));
        log_key_op("delete", if result.is_ok() { "ok" } else { "refused" });
        result
    }
}

/// One line per mutation, with a closed token rather than an error's text.
fn log_key_op(op: &'static str, result: &'static str) {
    tracing::info!(
        stage = "label_store_keystore",
        op,
        result,
        "vault-label Keystore operation"
    );
}
