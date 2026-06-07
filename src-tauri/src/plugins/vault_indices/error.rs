//! `vault_indices` plugin IPC error enum (MYND-31 / A11, Task 1).
//!
//! Closed taxonomy, DENY-list clean per `src-tauri/CLAUDE.md`
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
}
