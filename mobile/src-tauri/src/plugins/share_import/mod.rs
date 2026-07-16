//! `share-import` plugin (mobile) — the share-import staging queue for files
//! shared into Myne via the OS share sheet (iOS Share Extension / Android
//! `ACTION_SEND`).
//!
//! A shared file is sealed into a device-local encrypted `MYF1` queue
//! (`myne_core::plugins::share_import`, `protocol.md` § 9.19) while the vault
//! may be locked, and drained into the vault's attachment library
//! (`attachment_import`, MYA1/MYC1) on unlock. The whole core (device-key seal +
//! queue + host-side drain) lives in `myne-core`; this crate only registers the
//! three shared commands. Off Apple targets the device key is currently
//! unavailable (Android Keystore provider is the SF1 open item), so the seal
//! commands no-op cleanly.
//!
//! See: main repo `docs/decisions.md` (share-import; MYND-507).

// Re-exported so `crate::plugins::share_import::{commands, error}::…` paths resolve.
#[allow(unused_imports)]
pub use myne_core::plugins::share_import::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `share-import` plugin. Holds no own state (the queue lives
/// on-disk and in the keychain); binds only its three IPC commands. Registered
/// via the `myne_core::plugins::share_import` module paths so `generate_handler!`
/// sees each command's `#[tauri::command]`-generated hidden items.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("share-import")
        .invoke_handler(tauri::generate_handler![
            myne_core::plugins::share_import::commands::seal_share,
            myne_core::plugins::share_import::commands::drain_pending_shares,
            myne_core::plugins::share_import::commands::share_ack,
        ])
        .build()
}
