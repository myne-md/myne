// SPDX-License-Identifier: AGPL-3.0

//! Error enums for the agent-memory plugin (myne-md/myne#697).
//!
//! One closed `serde::Serialize` enum per command family, `#[serde(tag =
//! "kind", content = "detail")]`, hand-mirrored on the TS side in the same
//! change as any variant edit. No `String` field ever reaches the frontend:
//! IO collapses to `IoFailureKind`, and every decode failure is a closed tag.
//! The chats error enums are the archetype; the memory family answers the
//! same request-echo discipline (a caller named the entry it asked about).

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use thiserror::Error;

/// Failure modes of `memory_list` / `memory_read` (the read family).
#[derive(Debug, Error, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum MemoryReadError {
    /// The vault slot is not `Unlocked` (every memory command is
    /// unlocked-gated: the KEKs derive from `root_key`).
    #[error("the vault is not unlocked")]
    SlotNotUnlocked,
    /// `vault.meta` could not be read or parsed (the account hash and the
    /// protocol version come from it).
    #[error("vault.meta unreadable or invalid")]
    InvalidVaultMeta,
    /// IO failure kind from the seam (closed enum, no path strings).
    #[error("io failure: {io_error_kind:?}")]
    Io { io_error_kind: IoFailureKind },
    /// The `ai_enabled` runtime opt-in is off on this device. The whole
    /// surface (reads and writes) exists only while it is on
    /// (`decisions/ai/0590`); a decode failure also gates closed, never open.
    #[error("ai is switched off on this device")]
    AiDisabled,
    /// The catalog blob exists but cannot be decoded (magic / version /
    /// AEAD / cap / canonical-JSON). **Reported, never collapsed to an empty
    /// roster** (§ 9.25.3 report-don't-empty): an empty read + the next
    /// write would persist emptiness over real memory records.
    #[error("the agent-memory catalog is unreadable")]
    CatalogUnreadable,
    /// A memory-entry file exists under a live catalog row but cannot be
    /// decoded. **The catalog row is NOT dropped** in response (§ 9.26.4).
    /// Carries no id: the caller asked for a named entry and knows which one
    /// failed.
    #[error("a memory entry is unreadable")]
    EntryUnreadable,
    /// The named entry is tombstoned in the catalog (deleted) or has no
    /// catalog row at all.
    #[error("memory entry not found")]
    EntryNotFound,
    /// `vault.personality` exists but cannot be decoded. **Reported, never
    /// collapsed to an absent personality** (§ 9.27.3 report-don't-empty).
    #[error("the agent-personality blob is unreadable")]
    PersonalityUnreadable,
}

impl From<IoFailureKind> for MemoryReadError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        MemoryReadError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for MemoryReadError {
    fn from(e: std::io::Error) -> Self {
        MemoryReadError::from(from_io_error_kind(e.kind()))
    }
}

/// Failure modes of `memory_write` / `memory_delete` /
/// `personality_read` / `personality_write` (the mutation family, plus the
/// personality read which shares the refusal shape). There is no
/// `memory_clear_all` command: clearing is a per-entry delete loop in the UI.
#[derive(Debug, Error, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum MemoryMutateError {
    /// The vault slot is not `Unlocked`.
    #[error("the vault is not unlocked")]
    SlotNotUnlocked,
    /// `vault.meta` could not be read or parsed.
    #[error("vault.meta unreadable or invalid")]
    InvalidVaultMeta,
    /// IO failure kind from the seam.
    #[error("io failure: {io_error_kind:?}")]
    Io { io_error_kind: IoFailureKind },
    /// The `ai_enabled` runtime opt-in is off on this device. Refused
    /// before any store is touched, on reads and writes alike.
    #[error("ai is switched off on this device")]
    AiDisabled,
    /// The catalog blob exists but cannot be decoded. **The mutation is
    /// refused rather than performed over an unreadable store** (the
    /// `themes` #255 refuse-don't-wipe discipline).
    #[error("the agent-memory catalog is unreadable; refusing to mutate over it")]
    CatalogUnreadable,
    /// The named entry does not exist in the catalog (or is a tombstone).
    /// Carries no id: the caller named it in the request.
    #[error("the memory entry does not exist")]
    EntryNotFound,
    /// A model write tried to overwrite a user-authored row (myne-md/myne#709,
    /// the authorship gate, `decisions/ai/0591`). Model rows carry a
    /// `source_conversation` provenance link; user rows carry none. A model
    /// write naming a row without one is refused rather than applied, so a
    /// documented correction loses to the next run no more. User writes
    /// overwrite anything. Carries no id: the caller named it in the request.
    #[error("the agent may not overwrite a user-authored memory entry")]
    ModelOverwriteRefused,
    /// A `remember` write whose source notes sit under an `ai_excluded_folders`
    /// folder (myne-md/myne#709, `decisions/ai/0591`). The run loop threads the
    /// folders of every note it read this run; the write re-reads the live
    /// exclusion set at the write boundary (the `apply.rs` discipline) and
    /// refuses on any match, so a folder excluded mid-run stops the learning
    /// surface too, not just the read surface. Read-side clamping is why this
    /// rarely fires; this is the backstop for when it moves underneath a run.
    #[error("the memory was learned from a note in an excluded folder")]
    ExcludedSource,
    /// The entry text or the personality payload failed the write-time gate:
    /// schema enforcement, the 2000-character cap, or the injection-pattern
    /// scan (`decisions/ai/0590`). A refused write is never injected. A
    /// refused USER write or a refused UPDATE is never persisted either; a
    /// refused MODEL create persists as `quarantined` (held for user review,
    /// never injected) instead of being dropped silently (myne-md/myne#709,
    /// `decisions/ai/0591`). Carries no detail: the scan's classes are closed
    /// and the memory UI renders the entry as rejected or held.
    #[error("the payload failed the injection scan or the schema gate")]
    ScanRejected,
    /// The entry text exceeds the 2000-character cap.
    #[error("the memory text exceeds the cap")]
    TextTooLong,
    /// The roster already holds `MAX_MEMORY_ENTRIES` live entries and this
    /// write would add one more (§ 9.25.3). Updates to existing entries stay
    /// allowed; only roster growth refuses. The UI renders the roster-full
    /// state from this kind.
    #[error("the memory roster is full")]
    EntryLimitReached,
    /// The encoded entry or catalog or personality blob exceeds its size cap
    /// (256 KiB per entry file / 1 MiB catalog / 256 KiB personality,
    /// § 9.25.3 / § 9.26.4 / § 9.27.3). Refused, never truncated.
    #[error("the payload exceeds the size cap")]
    PayloadTooLarge,
    /// The OS CSPRNG was unavailable (entry id or nonce generation).
    #[error("os randomness unavailable")]
    RandomnessUnavailable,
}

impl From<IoFailureKind> for MemoryMutateError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        MemoryMutateError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for MemoryMutateError {
    fn from(e: std::io::Error) -> Self {
        MemoryMutateError::from(from_io_error_kind(e.kind()))
    }
}
