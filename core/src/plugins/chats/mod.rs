// SPDX-License-Identifier: AGPL-3.0

//! The AI conversations storage core (`vault.chats` catalog singleton, `MYM1`
//! plus per-conversation `chats/<id-hex>` files, `MYJ1`; myne-md/myne#675,
//! `protocol.md` § 9.23 and § 9.24).
//!
//! Layer shape mirrors `themes` (the per-key map singleton with causal
//! versions) for the catalog and `attachments` (the id-named per-file family)
//! for the conversation bodies. Four layers per command: a `*_with_dir` inner
//! (unlocked slot → key + hash), `*_from_host` (host → vault dir), and the
//! cfg-gated `#[tauri::command]` wrapper. Each client registers its own IPC
//! surface; nothing here lists handlers.
//!
//! Two spec divergences from the cosmetic singletons are load-bearing here:
//! reads REPORT failures rather than collapsing to empty (§ 9.23.3
//! report-don't-empty: conversations are user content), and every mutation
//! bumps the local-change push window (`hooks.bump_local_change()`), because
//! both blobs are Class-1 synced content.

pub mod commands;
pub mod error;
