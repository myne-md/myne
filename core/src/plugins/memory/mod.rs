// SPDX-License-Identifier: AGPL-3.0

//! The agent-memory storage core (`vault.agent-memory` catalog singleton,
//! `MYN1` plus per-entry `memories/<id-hex>` files, `MYX1`, and the
//! `vault.personality` singleton, `MYZ1`; myne-md/myne#697, `protocol.md`
//! § 9.25, § 9.26 and § 9.27).
//!
//! Layer shape mirrors `chats` (the per-key map singleton with causal
//! versions) for the catalog and `attachments` (the id-named per-file family)
//! for the entry bodies; the personality rides the prefs/themes whole-value
//! singleton shape. Three layers per command: a `*_with_dir` inner (unlocked
//! slot → key + hash), `*_from_host` (host → vault dir), and the cfg-gated
//! `#[tauri::command]` wrapper. Each client registers its own IPC surface;
//! nothing here lists handlers.
//!
//! Three spec divergences from the cosmetic singletons are load-bearing here:
//! reads REPORT failures rather than collapsing to empty (§ 9.25.3
//! report-don't-empty: memory is user content), every write passes the
//! write-time gate (schema + 2000-character cap + injection scan,
//! `decisions/ai/0590`), and every mutation bumps the local-change push
//! window (`hooks.bump_local_change()`), because every blob is Class-1
//! synced content. The whole surface exists only while `ai_enabled` is on;
//! the caller re-reads the gate before
//! each command.

pub mod commands;
pub mod error;
