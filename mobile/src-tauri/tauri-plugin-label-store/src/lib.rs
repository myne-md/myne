// SPDX-License-Identifier: AGPL-3.0-only
//! Android Keystore bridge for the two device-local **label** keys (myne-md/myne#1091,
//! `decisions/clients/0795`): each vault's cached name and the account record.
//!
//! This plugin exposes **no WebView-facing commands**: only the Rust backend can drive
//! it (the `tauri-plugin-screen-guard` and `tauri-plugin-device-key` precedent), so it
//! carries no permission file, no capability grant and no `InlinedPlugin` declaration.
//! The WebView cannot read or write these items.
//!
//! On Android, `init` registers `md.myne.labelstore.LabelStorePlugin` (committed Kotlin
//! under `android/`, NOT the gitignored `gen/android` tree) and manages a
//! [`LabelStore`] handle for the mobile host's label provider to fetch via `try_state`.
//! On every other target `init` registers a no-op plugin, so `lib.rs` stays free of
//! per-target cfg.
//!
//! **Item addressing is the account name**, the same string `myne-core` uses: a
//! `VaultId` rendering for a vault's key, `account-record` for the account record. The
//! name reaches the Kotlin side as an argument and becomes a preferences key, so the
//! Kotlin half refuses anything that is not a plain name.
//!
//! **Threading is load-bearing.** `run_mobile_plugin` is a blocking JNI round-trip
//! serviced by the Android main thread, so the caller MUST NOT be the main thread or the
//! call deadlocks. The label store's call sites (unlock, rename, the erase, the picker's
//! read) all run off the main thread; do not call this from a `setup` hook or a
//! `run_on_main_thread` body.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Java package of the committed Kotlin plugin class (its `class_name` is
/// `LabelStorePlugin`). Distinct from the app id `md.myne.mobile`.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "md.myne.labelstore";

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
struct ItemArgs {
    /// The account name this item is addressed by.
    item: String,
}

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
struct SealArgs {
    item: String,
    /// Bytes as `u8` values, matching the Kotlin `List<Int>`: no base64 layer is
    /// invented on either side.
    key: Vec<u8>,
}

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct OpenReply {
    /// `None` when the store holds no item under this name, which is the ordinary
    /// first-run state and not a fault.
    key: Option<Vec<u8>>,
}

/// Managed handle to the Kotlin plugin. Fetched by the mobile host's provider via
/// `app.try_state::<LabelStore<R>>()`.
#[cfg(target_os = "android")]
pub struct LabelStore<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> LabelStore<R> {
    /// Read the item's plaintext. `Ok(None)` when the store holds none.
    pub fn open(
        &self,
        item: &str,
    ) -> Result<Option<Vec<u8>>, tauri::plugin::mobile::PluginInvokeError> {
        let reply: OpenReply = self.0.run_mobile_plugin(
            "open",
            ItemArgs {
                item: item.to_string(),
            },
        )?;
        Ok(reply.key)
    }

    /// Seal and persist one item, replacing any previous bytes under this name.
    pub fn seal(
        &self,
        item: &str,
        key: &[u8],
    ) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin::<()>(
            "seal",
            SealArgs {
                item: item.to_string(),
                key: key.to_vec(),
            },
        )
    }

    /// Delete one item. Best-effort, like every erase in this family: the caller's
    /// guarantee is that the key stops existing, and the Kotlin half removes the only
    /// copy of it.
    pub fn delete(&self, item: &str) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0.run_mobile_plugin::<()>(
            "delete",
            ItemArgs {
                item: item.to_string(),
            },
        )
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("label-store")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "LabelStorePlugin")?;
                _app.manage(LabelStore(handle));
            }
            Ok(())
        })
        .build()
}
