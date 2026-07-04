// SPDX-License-Identifier: AGPL-3.0
//! Quick-unlock plugin core (MYND-329) — the platform-agnostic PIN path.
//!
//! Extracted from the desktop crate (shared desktop↔mobile). Holds the wrap-key
//! provider trait (`provider`), the PIN (Argon2id) provider (`pin`), the
//! failed-attempt counter (`attempt`), the error enum (`error`), and the OS-free
//! `*_with_dir` cores + the PIN/status/disable `#[tauri::command]` wrappers
//! (`commands`).
//!
//! The macOS biometric provider + its command branch live in the desktop crate
//! and layer over the `pub` cores here; mobile registers only the PIN commands.
//! Like `notes`, `init()` is per-client — each host builds its own plugin with
//! the command set appropriate to its platform.

pub mod attempt;
pub mod commands;
pub mod error;
pub mod pin;
pub mod provider;
