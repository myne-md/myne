// SPDX-License-Identifier: AGPL-3.0
//! Android OS-share-sheet receiver for the share-import feature (SF3,
//! MYND-511).
//!
//! This is the **inbound** half: a file the user shares INTO Myne from another
//! app (`ACTION_SEND` / `ACTION_SEND_MULTIPLE`; the `build.rs`-injected
//! intent-filters on MainActivity). The **outbound** "share a file out" half is
//! `src-tauri/src/share_file.rs` — the opposite direction; do not conflate.
//!
//! Like `tauri-plugin-screen-guard` this plugin exposes **no WebView-facing
//! commands** — only the Rust backend drives its Kotlin `@Command`s
//! (`setEventHandler`, `getOrCreateDeviceKey`) through `run_mobile_plugin` (the
//! `tauri-plugin-deep-link` `setEventHandler` precedent), so it carries no
//! permission file, no capability grant, and no `InlinedPlugin` declaration.
//!
//! Delivery mirrors deep-link exactly: `init` hands the Kotlin plugin a
//! [`tauri::ipc::Channel`]; on each received share the Kotlin side reads the
//! `content://` bytes **off the main thread**, base64-encodes them, and
//! `channel.send({filename, mime, dataB64})`. That fires the Rust closure below,
//! which re-emits the payload as a GLOBAL `share-intent` event. The JS half
//! (`src/lib/shareImport.ts` `initShareIntent`) `listen`s for it and forwards to
//! `plugin:share-import|seal_share`.
//!
//! On every non-Android target `init` registers a no-op plugin (registration
//! keeps `lib.rs` free of per-target cfg — the iOS Share Extension is a separate
//! app-extension target, not this plugin).

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Java package of the committed Kotlin plugin class (its `class_name` is
/// `ShareIntentPlugin`). Distinct from the app id `md.myne.mobile`.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "md.myne.shareintent";

/// Length of the share-import device wrap key (256-bit XChaCha20-Poly1305 key;
/// matches `myne_core::plugins::share_import::device_key::SHARE_WRAP_KEY_LEN`).
#[cfg(target_os = "android")]
const DEVICE_KEY_LEN: usize = 32;

/// `run_mobile_plugin("setEventHandler", …)` arg — hands the Kotlin plugin the
/// delivery channel (deep-link's `EventHandler` shape).
#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetEventHandlerArgs {
    handler: tauri::ipc::Channel,
}

/// One received share as delivered by the Kotlin channel and re-emitted to the
/// WebView. `data_b64` is base64 (the file bytes never cross Rust decoded — the
/// JS half `atob`s them before `seal_share`).
#[cfg(target_os = "android")]
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ShareIntentPayload {
    filename: String,
    mime: String,
    #[serde(rename = "dataB64")]
    data_b64: String,
}

/// Kotlin `getOrCreateDeviceKey` response — the raw 32-byte device wrap key as a
/// JSON int array (avoids a base64 decode in Rust; see [`ShareIntent`]).
#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct DeviceKeyResponse {
    key: Vec<u8>,
}

/// Managed handle to the Kotlin plugin. Registered on Android so the Android
/// Keystore device-key path can fetch it via
/// `app.try_state::<ShareIntent<R>>()` — the `screen_guard::ScreenGuard`
/// precedent. The seam IS wired: the mobile host's
/// `ShareImportDeviceKeyProvider` calls `get_or_create_device_key` through
/// `myne-core`'s `device_key` trait.
#[cfg(target_os = "android")]
pub struct ShareIntent<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> ShareIntent<R> {
    /// Get-or-create the non-biometric, device-only share-import wrap key in the
    /// Android Keystore (SF/SYNC-3 seam — see `KEYSTORE_TODO.md`).
    ///
    /// Blocking JNI round-trip **serviced by the Android main thread**
    /// (`run_mobile_plugin` posts through the main pipe and parks on `recv`, the
    /// same threading contract as `screen_guard::ScreenGuard::set_secure`): the
    /// caller MUST NOT be the main thread or the call deadlocks.
    ///
    /// Errors are `String` (not a `myne-core` type) so the plugin stays
    /// decoupled — the eventual core caller maps a failure to
    /// `ShareImportError::Backend` (again, see `KEYSTORE_TODO.md`).
    pub fn get_or_create_device_key(
        &self,
    ) -> Result<zeroize::Zeroizing<[u8; DEVICE_KEY_LEN]>, String> {
        let resp = self
            .0
            .run_mobile_plugin::<DeviceKeyResponse>("getOrCreateDeviceKey", ())
            .map_err(|e| e.to_string())?;
        if resp.key.len() != DEVICE_KEY_LEN {
            return Err(format!(
                "share-intent device key: expected {DEVICE_KEY_LEN} bytes, got {}",
                resp.key.len()
            ));
        }
        let mut key = zeroize::Zeroizing::new([0u8; DEVICE_KEY_LEN]);
        key.copy_from_slice(&resp.key);
        Ok(key)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("share-intent")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::{
                    ipc::{Channel, InvokeResponseBody},
                    Emitter, Manager,
                };

                let handle =
                    _api.register_android_plugin(PLUGIN_IDENTIFIER, "ShareIntentPlugin")?;

                // Bridge the Kotlin delivery channel to a global Tauri event
                // (deep-link's `Channel::new(|event| app.emit(...))` pattern).
                // A `setEventHandler` round-trip only stores the channel and
                // resolves immediately (no main-thread work), so it is safe to
                // call from setup — same as deep-link.
                let app_handle = _app.clone();
                handle.run_mobile_plugin::<()>(
                    "setEventHandler",
                    SetEventHandlerArgs {
                        handler: Channel::new(move |event| {
                            if let InvokeResponseBody::Json(payload) = event {
                                if let Ok(p) = serde_json::from_str::<ShareIntentPayload>(&payload)
                                {
                                    let _ = app_handle.emit("share-intent", p);
                                }
                            }
                            Ok(())
                        }),
                    },
                )?;

                _app.manage(ShareIntent(handle));
            }
            Ok(())
        })
        .build()
}
