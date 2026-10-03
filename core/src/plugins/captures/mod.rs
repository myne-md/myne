// SPDX-License-Identifier: AGPL-3.0
//! Pending-capture queue plugin core (Apple Watch voice quick-capture; § 9.18).
//!
//! A watch-dictated note arrives from the paired Apple Watch (via WatchConnectivity)
//! while the phone's vault may be locked. The native receiver writes it as a
//! plaintext file into `staging/`; this plugin seals it into a device-local
//! encrypted `MYK1` queue (`sealed/`) under a keychain wrap key (`device_key`,
//! Apple-only), and drains the queue into the vault as ordinary notes on unlock.
//!
//! Mobile-only in practice (the watch feature); `device_key` returns
//! `HardwareUnavailable` off Apple targets, so the commands no-op there. Like
//! `notes` / `quick_unlock`, `init()` is per-client — the mobile host builds the
//! plugin and registers the three commands from this module's paths (this core
//! crate does not build the plugin; the desktop host never registers it).

pub mod commands;
pub mod device_key;
pub mod error;
pub mod meeting_manifest;
pub mod queue;
