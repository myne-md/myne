// SPDX-License-Identifier: AGPL-3.0
//! The Android device-key store: the Keystore, over the Kotlin
//! `tauri-plugin-device-key` bridge (`decisions/protocol/0760`,
//! `identity-seat-portability` task 9).
//!
//! Installed from [`crate::device_key`], which is the same file on every host.
//!
//! ⚠️ **DEVICE-VERIFY-PENDING.** The Kotlin half cannot be compiled or run on the
//! macOS dev host, and no CI lane builds Android Kotlin, so what is proven today is
//! that this Rust half compiles and that `core`'s provider seam works (its own unit
//! tests, on a fake provider). The Keystore behaviour (non-biometric, device-only,
//! no prompt, surviving an app restart) needs a real device; the row to run is in
//! `agent-tooling/docs/dev/device-matrix.md`.

use myne_core::plugins::sync::device_identity::{
    from_item_bytes, install_host_provider, log_key_op, to_item_bytes, DeviceKeyProvider,
    DeviceKeyStoreError,
};

/// Install the Android Keystore store as `core`'s device-key provider.
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    install_host_provider(Box::new(KeystoreProvider { app: app.clone() }));
}

struct KeystoreProvider<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> KeystoreProvider<R> {
    /// A host that registered the plugin always has this state, so a missing one is
    /// a WIRING failure and is reported as one (myne-md/myne#938 review).
    ///
    /// It used to answer `Unsupported`, which `device_identity::load_for_fallback`
    /// treats as the silent arm: a build whose plugin was registered without its
    /// state would sign `0x02` heads on every cycle with nothing in the log saying
    /// why. That is the same collapse the module header of `device_identity.rs`
    /// records as a fixed defect ("a keychain refusal ... collapsed into the same
    /// `None` as an unsupported platform"), re-entered one layer up. A wiring fault
    /// is not the platform having no rung.
    fn store(
        &self,
    ) -> Result<tauri::State<'_, tauri_plugin_device_key::DeviceKeyStore<R>>, DeviceKeyStoreError>
    {
        use tauri::Manager;
        self.app
            .try_state::<tauri_plugin_device_key::DeviceKeyStore<R>>()
            .ok_or(DeviceKeyStoreError::Backend)
    }
}

impl<R: tauri::Runtime> DeviceKeyProvider for KeystoreProvider<R> {
    fn load(&self) -> Result<Option<protocol::device_key::DeviceKeyPair>, DeviceKeyStoreError> {
        let store = self.store()?;
        let bytes = store.open().map_err(|_| DeviceKeyStoreError::Backend)?;
        match bytes {
            None => Ok(None),
            Some(bytes) => from_item_bytes(&bytes).map(Some),
        }
    }

    fn store(&self, pair: &protocol::device_key::DeviceKeyPair) -> Result<(), DeviceKeyStoreError> {
        let store = self.store()?;
        let sealed = store
            .seal(&to_item_bytes(pair))
            .map_err(|_| DeviceKeyStoreError::Backend);
        // The shared line every other platform arm writes (myne-md/myne#1027). On the phone the
        // Keystore is where the key lives, so a diagnostics paste without it cannot answer "was
        // this device's signing key ever written?".
        log_key_op("store", if sealed.is_ok() { "ok" } else { "refused" });
        sealed
    }

    fn destroy(&self) {
        if let Ok(store) = self.store() {
            // Best-effort: the erase's own guarantee is about vault content, so a
            // Keystore refusal must not fail it.
            let ok = store.delete().is_ok();
            log_key_op("delete", if ok { "ok" } else { "refused" });
        }
    }
}
