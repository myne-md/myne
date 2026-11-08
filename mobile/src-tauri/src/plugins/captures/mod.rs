// SPDX-License-Identifier: AGPL-3.0
//! `captures` plugin (mobile) — the pending-capture queue for the Apple Watch
//! voice-quick-capture companion.
//!
//! A watch-dictated note is relayed to the phone (WatchConnectivity), staged as
//! plaintext by the native `WCCaptureReceiver`, sealed into a device-local
//! encrypted `MYK1` queue (`myne_core::plugins::captures`, `protocol.md` § 9.18),
//! and drained into the vault as a new note on unlock. The whole core lives in
//! `myne-core` (device-key seal + queue); this crate only registers the three
//! shared commands. On non-Apple targets the device key is unavailable and the
//! commands no-op — the feature is Apple-Watch-specific.
//!
//! The same plugin also carries the watch **meeting-capture** lane
//! (myne-md/myne#812): `seal_meeting_chunk` seals each arrived audio chunk under
//! the device-local share-import key and records it in a per-session manifest;
//! `seal_meeting_inbox` re-scans the app-owned inbox and seals every chunk left
//! there (the retry half of the on-arrival seal, since the native move consumes
//! the WatchConnectivity transfer); `drain_pending_meetings` imports every sealed
//! chunk into the vault library as an attachment on unlock; and
//! `ack_meeting_session` removes a drained group once its note exists.
//!
//! See: main repo `myne-agents/docs/decisions.md` 2026-07-12 (Apple Watch companion V1).

// Re-exported so `crate::plugins::captures::{commands, error}::…` paths resolve.
#[allow(unused_imports)]
pub use myne_core::plugins::captures::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `captures` plugin. Holds no own state (the queue is on-disk +
/// keychain); binds only its three IPC commands.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // Commands are registered via their myne-core module path so
    // `generate_handler!` sees the `#[tauri::command]`-generated hidden items.
    Builder::<R>::new("captures")
        .invoke_handler(tauri::generate_handler![
            myne_core::plugins::captures::commands::seal_staged,
            myne_core::plugins::captures::commands::take_pending,
            myne_core::plugins::captures::commands::ack,
            myne_core::plugins::captures::commands::seal_meeting_chunk,
            myne_core::plugins::captures::commands::seal_meeting_inbox,
            myne_core::plugins::captures::commands::drain_pending_meetings,
            myne_core::plugins::captures::commands::set_meeting_session_note,
            myne_core::plugins::captures::commands::ack_meeting_session,
        ])
        .build()
}
