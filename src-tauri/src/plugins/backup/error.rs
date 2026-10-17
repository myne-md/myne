// SPDX-License-Identifier: AGPL-3.0
//! `backup` plugin IPC error enum (MYND-32 / MYND-218).
//!
//! Closed taxonomy mirroring `SnapshotError` — DENY-list clean (no path
//! strings, no vault identifiers, no kernel-error display strings). See
//! `src-tauri/AGENTS.md` "Secret-handling logging discipline". Hand-mirrored
//! on the TS side (task 6 of `backup-export-engine`).

use crate::backup_container::BackupContainerError;
use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by the backup
/// commands (`vault_export_backup` now; `vault_restore_backup` joins in
/// MYND-218).
///
/// Serialization shape (`tag = "kind", content = "detail"`), the
/// `SnapshotError` precedent.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum BackupExportError {
    /// No vault exists at the resolved root (no `vault.meta`).
    #[error("vault not found")]
    VaultNotFound,
    /// The destination path is not usable (empty, no parent directory).
    #[error("destination is invalid")]
    InvalidDestination,
    /// A vault member exceeded its family's allocation bound — the vault
    /// directory holds something §9.11 cannot carry.
    #[error("a vault member exceeds its family cap")]
    MemberTooLarge,
    /// The SYNC-4 read-back verification of the written container failed —
    /// the bytes did not verify (typically a lying/corrupting destination
    /// medium; rarely a source mutated mid-export). No file is left behind.
    #[error("backup verification failed")]
    VerifyFailed,
    /// Another credential/lifecycle operation (unlock, recover,
    /// change-password, delete — or another export) holds the capacity-1
    /// `auth_permits` lifecycle permit. Reject-never-queue (SYNC-6); the
    /// UI renders the honest "another operation in progress" copy.
    #[error("another vault operation is in progress")]
    AuthOperationInProgress,
    /// Filesystem failure, reduced to the closed kind.
    #[error("io failure")]
    Io { io_error_kind: IoFailureKind },
    /// The user cancelled the operation; partial output was discarded
    /// (SYNC-7 — the opposite of the importer's keep-partial Cancel).
    #[error("operation cancelled")]
    Cancelled,
    /// Background task failed to join.
    #[error("background task failed")]
    JoinFailure,
}

impl From<BackupContainerError> for BackupExportError {
    fn from(e: BackupContainerError) -> Self {
        // Exhaustive on purpose (no `_` arm): a new container variant must
        // be classified here deliberately — the same drift-detector
        // discipline as `backup_export_error_kind`.
        match e {
            BackupContainerError::Io(kind) => BackupExportError::Io {
                io_error_kind: crate::io_failure_kind::from_io_error_kind(kind),
            },
            // Size-class rejections: the vault holds something §9.11
            // cannot carry (member over its family cap, or table/count
            // past the reference ceilings) — never a media problem.
            BackupContainerError::MemberLenOverflow
            | BackupContainerError::MemberCountOverflow
            | BackupContainerError::MemberTableOverflow => BackupExportError::MemberTooLarge,
            BackupContainerError::Cancelled => BackupExportError::Cancelled,
            // Verify-shaped failures: the bytes (or their consistency
            // equations) did not survive the round trip. `LengthsInconsistent`
            // from phase two (a deferred source mutated mid-export) lands
            // here too — the export did not verify.
            BackupContainerError::HeaderTooShort
            | BackupContainerError::MagicMismatch
            | BackupContainerError::ProtocolVersionMismatch
            | BackupContainerError::ReservedByteNonZero
            | BackupContainerError::PathInvalid
            | BackupContainerError::PathNotAllowlisted
            | BackupContainerError::DuplicatePath
            | BackupContainerError::PathOrderViolation
            | BackupContainerError::LengthsInconsistent
            | BackupContainerError::HashMismatch => BackupExportError::VerifyFailed,
        }
    }
}

impl From<std::io::Error> for BackupExportError {
    fn from(e: std::io::Error) -> Self {
        BackupExportError::Io {
            io_error_kind: crate::io_failure_kind::from_io_error_kind(e.kind()),
        }
    }
}

/// Static-string label for [`BackupExportError`] variants — drift-detector
/// discipline (a new variant compile-fails this match), DENY-list-safe for
/// `tracing`. Mirrors `snapshot_error_kind`.
pub(crate) fn backup_export_error_kind(e: &BackupExportError) -> &'static str {
    match e {
        BackupExportError::VaultNotFound => "VaultNotFound",
        BackupExportError::InvalidDestination => "InvalidDestination",
        BackupExportError::MemberTooLarge => "MemberTooLarge",
        BackupExportError::VerifyFailed => "VerifyFailed",
        BackupExportError::AuthOperationInProgress => "AuthOperationInProgress",
        BackupExportError::Cancelled => "Cancelled",
        BackupExportError::Io { .. } => "Io",
        BackupExportError::JoinFailure => "JoinFailure",
    }
}

/// Single error type returned across the IPC boundary by
/// `vault_restore_backup` (MYND-218). Same serde shape + DENY-list
/// discipline as [`BackupExportError`]; hand-mirrored on the TS side.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum BackupRestoreError {
    /// The file is not a `.myne-backup` container (bad magic / not ours).
    #[error("not a backup file")]
    NotABackupFile,
    /// The file is a FUTURE major-version backup (`MYB5`). §10.4: refuse
    /// with an explicit migration prompt, never auto-read.
    #[error("backup from a newer protocol version")]
    FutureVersionBackup,
    /// Structural/integrity verification failed — truncation, hash
    /// mismatch, inconsistent lengths, malformed table. The default
    /// posture rejects the whole restore (SYNC-5 all-or-nothing).
    #[error("backup file is damaged")]
    DamagedBackup,
    /// The container carries no `vault.meta` member (§9.11.3 REQUIRED) —
    /// nothing restored from it could ever unlock.
    #[error("backup is missing its vault metadata")]
    MissingVaultMeta,
    /// The embedded `vault.meta` fails the §9.3 structural parse — placing
    /// it would reproduce the exact `InvalidVaultMeta` state restore exists
    /// to repair.
    #[error("backup vault metadata is unreadable")]
    InvalidVaultMeta,
    /// A vault with the same identity (`account_number_hash` header match)
    /// already exists on this device and the caller declared no
    /// `CollisionIntent` — the UI asks the user ("İkisini de tut" /
    /// "Mevcutla değiştir") and re-invokes with the choice (SYNC-5).
    /// `vault_id` is an opaque random UUIDv7 directory name (DENY-list
    /// safe — deliberately decoupled from any account identity).
    #[error("a vault with this identity already exists")]
    VaultAlreadyExists { vault_id: String },
    /// Another lifecycle operation holds the `auth_permits` permit at
    /// commit time. Reject-never-queue (SYNC-6).
    #[error("another vault operation is in progress")]
    AuthOperationInProgress,
    /// The user cancelled; staged state was discarded.
    #[error("operation cancelled")]
    Cancelled,
    /// Filesystem failure, reduced to the closed kind.
    #[error("io failure")]
    Io { io_error_kind: IoFailureKind },
    /// Background task failed to join.
    #[error("background task failed")]
    JoinFailure,
}

impl From<BackupContainerError> for BackupRestoreError {
    fn from(e: BackupContainerError) -> Self {
        // Exhaustive — drift-detector discipline.
        match e {
            BackupContainerError::Io(kind) => BackupRestoreError::Io {
                io_error_kind: crate::io_failure_kind::from_io_error_kind(kind),
            },
            BackupContainerError::Cancelled => BackupRestoreError::Cancelled,
            // The caller distinguishes MYB5 (FutureVersionBackup) by
            // re-reading the magic before mapping MagicMismatch.
            BackupContainerError::MagicMismatch
            | BackupContainerError::HeaderTooShort
            | BackupContainerError::ProtocolVersionMismatch => BackupRestoreError::NotABackupFile,
            BackupContainerError::ReservedByteNonZero
            | BackupContainerError::MemberCountOverflow
            | BackupContainerError::MemberTableOverflow
            | BackupContainerError::PathInvalid
            | BackupContainerError::PathNotAllowlisted
            | BackupContainerError::DuplicatePath
            | BackupContainerError::PathOrderViolation
            | BackupContainerError::MemberLenOverflow
            | BackupContainerError::LengthsInconsistent
            | BackupContainerError::HashMismatch => BackupRestoreError::DamagedBackup,
        }
    }
}

impl From<std::io::Error> for BackupRestoreError {
    fn from(e: std::io::Error) -> Self {
        BackupRestoreError::Io {
            io_error_kind: crate::io_failure_kind::from_io_error_kind(e.kind()),
        }
    }
}

/// Static-string label for [`BackupRestoreError`] — drift-detector,
/// DENY-list-safe.
pub(crate) fn backup_restore_error_kind(e: &BackupRestoreError) -> &'static str {
    match e {
        BackupRestoreError::NotABackupFile => "NotABackupFile",
        BackupRestoreError::FutureVersionBackup => "FutureVersionBackup",
        BackupRestoreError::DamagedBackup => "DamagedBackup",
        BackupRestoreError::MissingVaultMeta => "MissingVaultMeta",
        BackupRestoreError::InvalidVaultMeta => "InvalidVaultMeta",
        BackupRestoreError::VaultAlreadyExists { .. } => "VaultAlreadyExists",
        BackupRestoreError::AuthOperationInProgress => "AuthOperationInProgress",
        BackupRestoreError::Cancelled => "Cancelled",
        BackupRestoreError::Io { .. } => "Io",
        BackupRestoreError::JoinFailure => "JoinFailure",
    }
}
