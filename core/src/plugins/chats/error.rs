// SPDX-License-Identifier: AGPL-3.0

//! Error enums for the AI conversations plugin (myne-md/myne#675).
//!
//! One closed `serde::Serialize` enum per command, `#[serde(tag = "kind",
//! content = "detail")]`, hand-mirrored on the TS side in the same change as
//! any variant edit. No `String` field ever reaches the frontend: IO collapses
//! to `IoFailureKind`, and every decode failure is a closed tag.

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use thiserror::Error;

/// Failure modes of `chats_list` / `chats_read` (the read family).
#[derive(Debug, Error, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ChatsReadError {
    /// The vault slot is not `Unlocked` (every chats command is
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
    /// The catalog blob exists but cannot be decoded (magic / version /
    /// AEAD / cap / canonical-JSON). **Reported, never collapsed to an empty
    /// roster** (§ 9.23.3 report-don't-empty): an empty read + the next write
    /// would persist emptiness over real conversation records.
    #[error("the conversations catalog is unreadable")]
    CatalogUnreadable,
    /// A conversation file exists under a live catalog row but cannot be
    /// decoded. **The catalog row is NOT dropped** in response (§ 9.24.4):
    /// the roster is the index of record and one unreadable conversation
    /// must not hide or destroy the rest. Carries no id: the caller asked
    /// for a named conversation and knows which one failed (the same
    /// request-echo discipline the other error enums hold; a String id in
    /// an IPC-bound error would be the enum's first payload of that kind).
    #[error("a conversation is unreadable")]
    ConversationUnreadable,
    /// The named conversation is tombstoned in the catalog (deleted) or has
    /// no catalog row at all. Reads consult catalog liveness first, so a
    /// deleted conversation stays unreadable by id even when its file erase
    /// failed and the bytes are still on disk.
    #[error("conversation not found")]
    ConversationNotFound,
}

impl From<IoFailureKind> for ChatsReadError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        ChatsReadError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for ChatsReadError {
    fn from(e: std::io::Error) -> Self {
        ChatsReadError::from(from_io_error_kind(e.kind()))
    }
}

/// Failure modes of `chats_create` / `chats_append_turn` / `chats_rename` /
/// `chats_delete` (the mutation family).
#[derive(Debug, Error, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ChatsMutateError {
    /// The vault slot is not `Unlocked`.
    #[error("the vault is not unlocked")]
    SlotNotUnlocked,
    /// `vault.meta` could not be read or parsed.
    #[error("vault.meta unreadable or invalid")]
    InvalidVaultMeta,
    /// IO failure kind from the seam.
    #[error("io failure: {io_error_kind:?}")]
    Io { io_error_kind: IoFailureKind },
    /// The catalog blob exists but cannot be decoded. **The mutation is
    /// refused rather than performed over an unreadable store** (the
    /// `themes` #255 refuse-don't-wipe discipline): creating a conversation
    /// "as a repair" would write over whatever the unreadable blob holds.
    #[error("the conversations catalog is unreadable; refusing to mutate over it")]
    CatalogUnreadable,
    /// The named conversation does not exist in the catalog (or is a
    /// tombstone). Carries no id: the caller named it in the request.
    #[error("the conversation does not exist")]
    ConversationNotFound,
    /// The turn payload is not valid canonical conversation JSON (the host
    /// validates the turn shape before it is sealed; a malformed turn is
    /// refused rather than persisted).
    #[error("the turn payload is not a valid conversation turn list")]
    InvalidTurnPayload,
    /// The encoded conversation or catalog exceeds its size cap (16 MiB per
    /// conversation file / 4 MiB catalog, § 9.23.3 / § 9.24.4). Refused,
    /// never truncated.
    #[error("the payload exceeds the size cap")]
    PayloadTooLarge,
    /// The OS CSPRNG was unavailable (conversation id or nonce generation).
    #[error("os randomness unavailable")]
    RandomnessUnavailable,
}

impl From<IoFailureKind> for ChatsMutateError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        ChatsMutateError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for ChatsMutateError {
    fn from(e: std::io::Error) -> Self {
        ChatsMutateError::from(from_io_error_kind(e.kind()))
    }
}
