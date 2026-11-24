// SPDX-License-Identifier: AGPL-3.0-only
//! iOS AVFoundation QR scanner plugin (device-join via QR, MYND-466).
//!
//! Exposes ONE WebView-facing command, `scan`, which the mobile JoinFlow invokes
//! to open the camera and read a device-join QR. On iOS the command bridges to
//! the `ios/` Swift `QrScanPlugin` (AVFoundation `AVCaptureMetadataOutput`) via
//! [`PluginHandle::run_mobile_plugin`]; on every other target (the macOS dev
//! host, Android until MYND-465) it returns [`Error::Unsupported`] so the crate
//! still compiles + `cargo check`s everywhere.
//!
//! The plugin returns ONLY the decoded QR string — it does no parsing. Decoding +
//! Damm-32 + freshness + pin-source selection all happen in the shared
//! `myne_core::plugins::sync::qr_join` codec (via the `sync_decode_join_qr`
//! command), so the trust logic stays host-unit-tested, not trapped in Swift.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginApi, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_qr_scan);

/// Arguments for the Swift `scan` invocation (none — the scanner is self-driving).
#[cfg(target_os = "ios")]
#[derive(Serialize)]
struct ScanArgs {}

/// The result of a scan: the decoded QR text, or `None` if the user cancelled.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScanResponse {
    /// The decoded QR payload string, or `null`/absent when the user dismissed the
    /// scanner (Swift resolves `{}` on cancel → `default` yields `None`).
    #[serde(default)]
    pub value: Option<String>,
}

/// Failure surface for [`scan`], serialized to the WebView.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum Error {
    /// QR scanning is only wired on iOS (SYNC-46; Android is MYND-465).
    #[error("QR scanning is not supported on this platform")]
    Unsupported,
    /// The native scanner returned an error (camera denied, capture failure).
    #[error("scan failed: {0}")]
    Plugin(String),
}

/// The managed plugin state. On iOS it holds the Swift plugin handle; elsewhere it
/// is a zero-sized marker so `scan` can answer [`Error::Unsupported`].
pub struct QrScan<R: Runtime> {
    #[cfg(target_os = "ios")]
    handle: tauri::plugin::PluginHandle<R>,
    // `fn() -> R` keeps `QrScan<R>: Send + Sync` regardless of R's own auto-traits
    // (a bare `PhantomData<R>` would demand `R: Send + Sync` at `app.manage`).
    #[cfg(not(target_os = "ios"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> QrScan<R> {
    /// Open the camera and read a QR, returning the decoded string (or `None` on
    /// cancel). Errors with [`Error::Unsupported`] off iOS.
    pub fn scan(&self) -> Result<ScanResponse, Error> {
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin("scan", ScanArgs {})
                .map_err(|e| Error::Plugin(e.to_string()))
        }
        #[cfg(not(target_os = "ios"))]
        {
            Err(Error::Unsupported)
        }
    }
}

/// Extension trait so callers reach the plugin as `app.qr_scan()`.
pub trait QrScanExt<R: Runtime> {
    fn qr_scan(&self) -> &QrScan<R>;
}

impl<R: Runtime, T: Manager<R>> QrScanExt<R> for T {
    fn qr_scan(&self) -> &QrScan<R> {
        self.state::<QrScan<R>>().inner()
    }
}

/// The `scan` command (WebView-facing). Async so the WebView promise stays live
/// while the native camera UI is up.
#[tauri::command]
async fn scan<R: Runtime>(app: AppHandle<R>) -> Result<ScanResponse, Error> {
    app.qr_scan().scan()
}

/// Register the plugin. On iOS it binds the Swift `QrScanPlugin`; elsewhere it
/// registers the command surface with an unsupported-returning state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("qr-scan")
        .invoke_handler(tauri::generate_handler![scan])
        .setup(|app, api| {
            let state = build_state(&api)?;
            app.manage(state);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "ios")]
fn build_state<R: Runtime>(
    api: &PluginApi<R, ()>,
) -> Result<QrScan<R>, Box<dyn std::error::Error>> {
    let handle = api.register_ios_plugin(init_plugin_qr_scan)?;
    Ok(QrScan { handle })
}

#[cfg(not(target_os = "ios"))]
fn build_state<R: Runtime>(
    _api: &PluginApi<R, ()>,
) -> Result<QrScan<R>, Box<dyn std::error::Error>> {
    Ok(QrScan {
        _marker: std::marker::PhantomData,
    })
}
