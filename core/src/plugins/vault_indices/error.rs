// SPDX-License-Identifier: AGPL-3.0-only
//! `vault_indices` plugin IPC error enum (MYND-31 / A11, Task 1).
//!
//! Closed taxonomy, DENY-list clean per `src-tauri/AGENTS.md`
//! "Secret-handling logging discipline" (no path strings, no key
//! material, no note_id / title content). Hand-mirrored on the TS side
//! at `src/types/vault-indices-error.ts`.

use serde::Serialize;
use thiserror::Error;

/// Failure surface for the `vault_indices` write/query commands.
///
/// Serialization shape (with `tag = "kind", content = "detail"`):
///
/// | Variant            | JSON                          |
/// |--------------------|-------------------------------|
/// | `SlotNotUnlocked`  | `{"kind":"SlotNotUnlocked"}`  |
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum VaultIndicesError {
    /// `VaultRuntimeState`'s slot was not `Slot::Unlocked` when the
    /// command ran. The index is plaintext-derived and only exists while
    /// unlocked, so every command is gated. Frontend CTA: re-prompt for
    /// unlock. Bug-canary in the legitimate flow — the index commands are
    /// only invoked post-unlock; a routing regression or dev-tools
    /// injection are the only causes that should hit this in production.
    #[error("vault is not unlocked")]
    SlotNotUnlocked,
    /// `vault.meta` was unreadable / unparseable when resolving the AAD
    /// `account_number_hash` for the `vault.indices` blob (Task 8). DENY-list
    /// clean (no path / bytes). Persist/hydrate are best-effort — the caller
    /// falls back to the RAM-only index + a full rebuild on next unlock.
    #[error("vault.meta unreadable for vault.indices persistence")]
    InvalidVaultMeta,
    /// A calendar query window that does not parse as the event wall-clock
    /// shape, or whose end precedes its start (myne-md/myne#1037). DENY-list
    /// clean: the offending bytes are never echoed back.
    #[error("calendar window is not a readable time range")]
    CalendarWindowUnreadable,
    /// A calendar range wider than the caller's bound allows
    /// (myne-md/myne#1037). Carries the bound so the refusal can STATE it rather
    /// than saying "too wide": a limit a caller cannot see is a limit it will hit
    /// again. DENY-list clean (two integers, no content).
    #[error("calendar window is wider than {max_days} days")]
    CalendarWindowTooWide { max_days: i64 },
    /// An IO / encode failure while writing the `vault.indices` blob (Task 8).
    /// DENY-list clean (no path, no `io::Error::Display`). Best-effort: the
    /// in-RAM index is unaffected; the next unlock rebuilds the missing delta.
    #[error("vault.indices persistence IO failed")]
    PersistIo,
}
