// SPDX-License-Identifier: AGPL-3.0
//! Tauri-layer error type for the `export` plugin (MYND-211 —
//! whole-vault plaintext markdown tree export).
//!
//! Same discipline as the backup / notes error enums: one closed
//! `serde(tag = "kind", content = "detail")` enum, no `String` field
//! anywhere, hand-mirrored on the TS side at
//! `src/types/vault-export-error.ts`. Adding a variant is an IPC
//! contract change that requires updating both sides in the same
//! change (the Rust-side exhaustiveness pin is
//! `commands::vault_export_error_kind` — a new variant compile-fails
//! its match).
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by
/// [`super::commands::vault_export_markdown`].
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum VaultExportError {
    /// No vault is unlocked (slot is `Empty` or `Recovering`). The
    /// export decrypts plaintext, so unlike the ciphertext-copying
    /// backup export it is impossible while locked. Frontend gates the
    /// entry points on an unlocked vault; surfacing this is a router
    /// bug.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// The capacity-1 lifecycle permit is held by an in-flight unlock /
    /// change-password / delete / backup / export. Reject-never-queue
    /// (the SYNC-6 backup discipline): the user retries after the other
    /// operation finishes.
    #[error("another auth-level operation is in progress")]
    AuthOperationInProgress,

    /// The resolved vault directory has no `vault.meta` — the explicit
    /// `vault_id` was stale/forged, or nothing exists at the sole-vault
    /// fallback path (non-creating resolution, MYND-253).
    #[error("vault not found")]
    VaultNotFound,

    /// The destination's parent directory does not exist or is not a
    /// directory (backup precedent — `BackupExportError::InvalidDestination`).
    #[error("destination is invalid")]
    InvalidDestination,

    /// The destination canonicalizes to a location inside the app data
    /// directory / a vault root — a plaintext tree inside Myne's own
    /// storage would corrupt vault discovery and co-mingle plaintext
    /// with ciphertext. Write-side mirror of the importer seam's
    /// canonicalize+`starts_with` check (MYND-253 principle).
    #[error("destination is inside the application data directory")]
    DestinationNotAllowed,

    /// Something already exists at the destination path itself. The
    /// export NEVER merges into or replaces an existing directory — the
    /// user picks a fresh tree location (distinct variant so the UI can
    /// offer "choose another folder").
    #[error("destination already exists")]
    DestinationAlreadyExists,

    /// AEAD-tag failure decrypting a note blob (non-distinguishing per
    /// `protocol.md` §6.4). The export skips nothing silently: one
    /// undecryptable note fails the whole export with the destination
    /// untouched.
    #[error("a note cannot be decrypted")]
    CannotDecrypt,

    /// A note's AEAD authenticity passed but the recovered plaintext is
    /// not valid UTF-8 — structural corruption is surfaced, never
    /// exported as garbage bytes.
    #[error("a note's plaintext is not valid utf-8")]
    InvalidPlaintextEncoding,

    /// `vault.meta` exists but does not parse, so the prefs /
    /// attachments-catalog AAD identity cannot be derived.
    #[error("vault metadata is invalid")]
    InvalidVaultMeta,

    /// A referenced attachment id has no catalog entry, or its blob
    /// file is gone — all-or-nothing: the export fails with nothing
    /// published.
    #[error("a referenced attachment is missing")]
    AttachmentMissing,

    /// A referenced attachment blob exists but fails to decrypt
    /// (corruption / tampering).
    #[error("a referenced attachment cannot be decrypted")]
    AttachmentCorrupt,

    /// The cooperative cancel flag was set (`vault_export_cancel`).
    /// The staging tree is discarded; nothing appears at the
    /// destination.
    #[error("export cancelled")]
    Cancelled,

    /// Residual file-system IO failure (vault reads / staging writes /
    /// the publish rename). The bounded [`IoFailureKind`] keeps OS
    /// error messages off the wire.
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown). User-facing CTA
    /// is "try again".
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for VaultExportError {
    fn from(e: std::io::Error) -> Self {
        VaultExportError::Io {
            io_error_kind: crate::io_failure_kind::from_io_error_kind(e.kind()),
        }
    }
}

/// Static-string label for [`VaultExportError`] variants — the same
/// drift-detector discipline as `note_export_error_kind` /
/// `backup_export_error_kind`. A new variant compile-fails this match
/// (the exhaustiveness pin for the TS mirror).
pub fn vault_export_error_kind(e: &VaultExportError) -> &'static str {
    match e {
        VaultExportError::VaultNotUnlocked => "VaultNotUnlocked",
        VaultExportError::AuthOperationInProgress => "AuthOperationInProgress",
        VaultExportError::VaultNotFound => "VaultNotFound",
        VaultExportError::InvalidDestination => "InvalidDestination",
        VaultExportError::DestinationNotAllowed => "DestinationNotAllowed",
        VaultExportError::DestinationAlreadyExists => "DestinationAlreadyExists",
        VaultExportError::CannotDecrypt => "CannotDecrypt",
        VaultExportError::InvalidPlaintextEncoding => "InvalidPlaintextEncoding",
        VaultExportError::InvalidVaultMeta => "InvalidVaultMeta",
        VaultExportError::AttachmentMissing => "AttachmentMissing",
        VaultExportError::AttachmentCorrupt => "AttachmentCorrupt",
        VaultExportError::Cancelled => "Cancelled",
        VaultExportError::Io { .. } => "Io",
        VaultExportError::JoinFailure => "JoinFailure",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io_failure_kind::IoFailureKind;

    #[test]
    fn error_kind_label_covers_every_variant() {
        // The closed-surface pin: every variant has a static label, and
        // a new variant compile-fails the helper's match before it can
        // ship without its TS-mirror twin.
        let all: Vec<(VaultExportError, &str)> = vec![
            (VaultExportError::VaultNotUnlocked, "VaultNotUnlocked"),
            (
                VaultExportError::AuthOperationInProgress,
                "AuthOperationInProgress",
            ),
            (VaultExportError::VaultNotFound, "VaultNotFound"),
            (VaultExportError::InvalidDestination, "InvalidDestination"),
            (
                VaultExportError::DestinationNotAllowed,
                "DestinationNotAllowed",
            ),
            (
                VaultExportError::DestinationAlreadyExists,
                "DestinationAlreadyExists",
            ),
            (VaultExportError::CannotDecrypt, "CannotDecrypt"),
            (
                VaultExportError::InvalidPlaintextEncoding,
                "InvalidPlaintextEncoding",
            ),
            (VaultExportError::InvalidVaultMeta, "InvalidVaultMeta"),
            (VaultExportError::AttachmentMissing, "AttachmentMissing"),
            (VaultExportError::AttachmentCorrupt, "AttachmentCorrupt"),
            (VaultExportError::Cancelled, "Cancelled"),
            (
                VaultExportError::Io {
                    io_error_kind: IoFailureKind::Other,
                },
                "Io",
            ),
            (VaultExportError::JoinFailure, "JoinFailure"),
        ];
        for (e, label) in &all {
            assert_eq!(vault_export_error_kind(e), *label);
        }
    }

    #[test]
    fn io_variant_serializes_with_kind_and_detail() {
        let e = VaultExportError::Io {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
        let unit = serde_json::to_string(&VaultExportError::Cancelled).unwrap();
        assert_eq!(unit, r#"{"kind":"Cancelled"}"#);
    }
}
