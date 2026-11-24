// SPDX-License-Identifier: AGPL-3.0-only
//! Android Keystore bridge for the **device signing key** (`decisions/protocol/0733`
//! decision 4, rung 2 on Android; `identity-seat-portability` task 9).
//!
//! This plugin exposes **no WebView-facing commands**: only the Rust backend can
//! drive it (the `tauri-plugin-screen-guard` precedent), so it carries no permission
//! file, no capability grant and no `InlinedPlugin` declaration. TB6 is untouched: the
//! WebView cannot read or write the device key.
//!
//! On Android, `init` registers `md.myne.devicekey.DeviceKeyPlugin` (committed Kotlin
//! under `android/`, NOT the gitignored `gen/android` tree) and manages a
//! [`DeviceKeyStore`] handle for the mobile host's `DeviceKeyProvider` to fetch via
//! `try_state`. On every other target `init` registers a no-op plugin, so `lib.rs`
//! stays free of per-target cfg.
//!
//! **Threading is load-bearing.** `run_mobile_plugin` is a blocking JNI round-trip
//! serviced by the Android main thread, so the caller MUST NOT be the main thread or
//! the call deadlocks. The device-key call sites (unlock, sync cycle, device binding)
//! all run off the main thread; do not call this from a `setup` hook or a
//! `run_on_main_thread` body.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Java package of the committed Kotlin plugin class (its `class_name` is
/// `DeviceKeyPlugin`). Distinct from the app id `md.myne.mobile`.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "md.myne.devicekey";

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
struct SealArgs {
    /// Bytes as `u8` values, matching the Kotlin `List<Int>`: no base64 layer is
    /// invented on either side.
    key: Vec<u8>,
}

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct OpenReply {
    key: Option<Vec<u8>>,
}

/// Managed handle to the Kotlin plugin. Fetched by the mobile host's provider via
/// `app.try_state::<DeviceKeyStore<R>>()`.
#[cfg(target_os = "android")]
pub struct DeviceKeyStore<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> DeviceKeyStore<R> {
    /// Read the sealed device key. `Ok(None)` when the store holds none, which is the
    /// ordinary first-run state and not a fault.
    pub fn open(&self) -> Result<Option<Vec<u8>>, tauri::plugin::mobile::PluginInvokeError> {
        let reply: OpenReply = self.0.run_mobile_plugin("open", ())?;
        Ok(reply.key)
    }

    /// Seal and persist the device key, replacing any previous one.
    pub fn seal(&self, key: &[u8]) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0
            .run_mobile_plugin::<()>("seal", SealArgs { key: key.to_vec() })
    }

    /// Delete the sealed key. Best-effort, like every erase on the storage ladder.
    pub fn delete(&self) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin::<()>("delete", ())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("device-key")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "DeviceKeyPlugin")?;
                _app.manage(DeviceKeyStore(handle));
            }
            Ok(())
        })
        .build()
}
