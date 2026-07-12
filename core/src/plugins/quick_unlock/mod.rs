// SPDX-License-Identifier: AGPL-3.0
//! Quick-unlock plugin core (MYND-329) — the shared PIN + biometric paths.
//!
//! Extracted from the desktop crate (shared desktop↔mobile). Holds the wrap-key
//! provider trait (`provider`), the PIN (Argon2id) provider (`pin`), the
//! Apple-Keychain biometric provider (`apple`, macOS Touch ID / iOS Face ID +
//! Touch ID — decisions.md 2026-07-12), the failed-attempt counter (`attempt`),
//! the error enum (`error`), and the OS-free `*_with_dir` cores + all six
//! `#[tauri::command]` wrappers (`commands` — PIN, biometric, status, disable;
//! the biometric pair returns `HardwareUnavailable` off Apple targets).
//!
//! Like `notes`, `init()` is per-client — each host builds its own plugin and
//! registers the shared commands from this module's paths.

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub mod apple;
pub mod attempt;
pub mod commands;
pub mod error;
pub mod pin;
pub mod provider;
