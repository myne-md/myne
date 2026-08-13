// SPDX-License-Identifier: AGPL-3.0
//! Android FLAG_SECURE bridge for the mobile screen-capture protection
//! (`screen_guard`, MYND-469).
//!
//! This plugin exposes **no WebView-facing commands** — only the Rust backend
//! can drive it (the `tauri-plugin-deep-link` `setEventHandler` precedent), so
//! it carries no permission file, no capability grant, and no `InlinedPlugin`
//! declaration. TB6 is untouched: the WebView cannot toggle protection except
//! through the audited `prefs` IPC, which commits the pref to disk before the
//! `apply_screen_capture` hook reaches this bridge.
//!
//! On Android, `init` registers `md.myne.screenguard.ScreenGuardPlugin`
//! (committed Kotlin under `android/`, NOT the gitignored `gen/android` tree)
//! and manages a [`ScreenGuard`] handle for `screen_guard::apply` to fetch via
//! `try_state`. The Kotlin `load()` adds FLAG_SECURE immediately — the
//! pre-unlock always-ON invariant (threat-model §6) holds from the first frame
//! without waiting for any Rust hook. On every other target `init` registers a
//! no-op plugin (registration keeps `lib.rs` free of per-target cfg).

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Java package of the committed Kotlin plugin class (its `class_name` is
/// `ScreenGuardPlugin`). Distinct from the app id `md.myne.mobile`.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "md.myne.screenguard";

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
struct SetSecureArgs {
    enabled: bool,
}

/// Managed handle to the Kotlin plugin. Fetched by `screen_guard::apply` via
/// `app.try_state::<ScreenGuard<R>>()`.
#[cfg(target_os = "android")]
pub struct ScreenGuard<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> ScreenGuard<R> {
    /// Add or clear FLAG_SECURE on the activity window.
    ///
    /// Blocking JNI round-trip **serviced by the Android main thread**
    /// (`run_mobile_plugin` posts through the main pipe and parks on `recv`):
    /// the caller MUST NOT be the main thread or the call deadlocks. The
    /// `apply_screen_capture` hook's async-command context is safe.
    pub fn set_secure(
        &self,
        enabled: bool,
    ) -> Result<(), tauri::plugin::mobile::PluginInvokeError> {
        self.0
            .run_mobile_plugin::<()>("setSecure", SetSecureArgs { enabled })
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("screen-guard")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle =
                    _api.register_android_plugin(PLUGIN_IDENTIFIER, "ScreenGuardPlugin")?;
                _app.manage(ScreenGuard(handle));
            }
            Ok(())
        })
        .build()
}
