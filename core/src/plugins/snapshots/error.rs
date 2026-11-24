// SPDX-License-Identifier: AGPL-3.0-only
//! `snapshots` plugin IPC error enum (MYND-96).
//!
//! Closed taxonomy mirroring `NoteUpdateError` / `NoteReadError` — DENY-list
//! clean (no path strings, no note/snapshot identifiers, no kernel-error display
//! strings). See `src-tauri/AGENTS.md` "Secret-handling logging discipline".
//! Decode failures collapse to the single non-distinguishing `CannotDecrypt`
//! per `protocol.md` §6.4. Hand-mirrored on the TS side.

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by the four
/// `snapshot_*` commands.
///
/// Serialization shape (`tag = "kind", content = "detail"`):
///
/// | Variant                  | JSON                                                          |
/// |--------------------------|---------------------------------------------------------------|
/// | `VaultNotUnlocked`       | `{"kind":"VaultNotUnlocked"}`                                  |
/// | `InvalidNoteId`          | `{"kind":"InvalidNoteId"}`                                     |
/// | `InvalidSnapshotId`      | `{"kind":"InvalidSnapshotId"}`                                 |
/// | `SnapshotNotFound`       | `{"kind":"SnapshotNotFound"}`                                  |
/// | `CannotDecrypt`          | `{"kind":"CannotDecrypt"}`                                     |
/// | `NotesDirNotADirectory`  | `{"kind":"NotesDirNotADirectory"}`                             |
/// | `Io { io_error_kind }`   | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}`  |
/// | `JoinFailure`            | `{"kind":"JoinFailure"}`                                       |
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum SnapshotError {
    #[error("vault is not unlocked")]
    VaultNotUnlocked,
    #[error("invalid note id")]
    InvalidNoteId,
    #[error("invalid snapshot id")]
    InvalidSnapshotId,
    #[error("snapshot not found")]
    SnapshotNotFound,
    #[error("snapshot cannot be decrypted under the current vault")]
    CannotDecrypt,
    #[error("notes directory is not a directory")]
    NotesDirNotADirectory,
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },
    #[error("join failure")]
    JoinFailure,
    /// A live co-editing session owns this note, so a restore would write behind
    /// the session's single durable writer (`SYNC-33`). Refused rather than raced.
    #[error("a live session owns this note")]
    LiveSessionOpen,
}

/// Static-string label for [`SnapshotError`] variants — drift-detector
/// discipline (a new variant compile-fails this match), DENY-list-safe for
/// `tracing`. Mirrors `note_update_error_kind`.
pub(crate) fn snapshot_error_kind(e: &SnapshotError) -> &'static str {
    match e {
        SnapshotError::VaultNotUnlocked => "VaultNotUnlocked",
        SnapshotError::InvalidNoteId => "InvalidNoteId",
        SnapshotError::InvalidSnapshotId => "InvalidSnapshotId",
        SnapshotError::SnapshotNotFound => "SnapshotNotFound",
        SnapshotError::CannotDecrypt => "CannotDecrypt",
        SnapshotError::NotesDirNotADirectory => "NotesDirNotADirectory",
        SnapshotError::Io { .. } => "Io",
        SnapshotError::JoinFailure => "JoinFailure",
        SnapshotError::LiveSessionOpen => "LiveSessionOpen",
    }
}
