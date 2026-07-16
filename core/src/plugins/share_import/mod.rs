// SPDX-License-Identifier: AGPL-3.0
//! Share-import staging-queue plugin core (`MYF1`; `protocol.md` § 9.19).
//!
//! A file shared into Myne via the OS share sheet (iOS Share Extension /
//! Android `ACTION_SEND`) arrives while the vault may be **locked** (and, on
//! iOS, at a separate process that never holds `root_key`). It is sealed into a
//! device-local encrypted `MYF1` queue (`pending-shares/sealed/`) under a
//! keychain / Keystore `wrap_key` (`device_key`), and drained into the vault's
//! attachment library (`attachment_import`, § 9.9/§ 9.10) on unlock.
//!
//! The file-carrying sibling of `captures` (`MYK1`, § 9.18): same device-key
//! seal + vault-agnostic per-entry-id AAD binding, but the payload is an
//! arbitrary binary file (framed with its filename + declared MIME by
//! [`frame`]) capped at 64 MiB, draining to `attachment_import` (not
//! `note_create`). Like `captures`/`quick_unlock`, `init()` is per-client — the
//! mobile host builds the plugin and registers the commands from this module's
//! paths; this core crate does not build the plugin.

pub mod commands;
pub mod device_key;
pub mod error;
pub mod frame;
pub mod queue;
