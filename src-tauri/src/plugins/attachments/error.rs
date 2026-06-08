//! `attachments` plugin IPC error enums (MYND-169).
//!
//! Closed taxonomies for `attachment_import`, `catalog_list`, and
//! `attachment_delete`, all DENY-list clean per `src-tauri/CLAUDE.md`
//! "Secret-handling logging discipline" (no path strings, no key
//! material, no attachment-id correlation tags, no kernel-error display
//! strings). Hand-mirrored on the TS side by the library/insert
//! consumers (sub-features 3/5).
//!
//! ## Import error surface (the "locked reject enum")
//!
//! `attachment_import` distinguishes the user-actionable rejections —
//! `Oversize`, `UnsupportedType`, `Locked` — so the UI can render the
//! exact remediation (shrink the file / pick a supported type /
//! re-unlock) rather than a generic "import failed". Everything else
//! collapses to `Io` (filesystem) or `EncodeFailed` (the practically-
//! unreachable codec failure under v0.1 fixed parameters).

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use thiserror::Error;

/// Failure surface for [`super::commands::attachment_import`].
///
/// Serialization shape (with `tag = "kind", content = "detail"`):
///
/// | Variant                  | JSON                                                           |
/// |--------------------------|----------------------------------------------------------------|
/// | `Locked`                 | `{"kind":"Locked"}`                                            |
/// | `Oversize`               | `{"kind":"Oversize","detail":{"cap_bytes":67108864}}`         |
/// | `UnsupportedType`        | `{"kind":"UnsupportedType"}`                                   |
/// | `Io { io_error_kind }`   | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}` |
/// | `InvalidVaultMeta`       | `{"kind":"InvalidVaultMeta"}`                                  |
/// | `EncodeFailed`           | `{"kind":"EncodeFailed"}`                                     |
/// | `JoinFailure`            | `{"kind":"JoinFailure"}`                                      |
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AttachmentImportError {
    /// `VaultRuntimeState`'s slot was not `Slot::Unlocked` when the
    /// import ran. Frontend CTA: re-prompt for unlock. Bug-canary in
    /// the legitimate flow because the import UI only mounts behind the
    /// unlock gate.
    #[error("vault is not unlocked")]
    Locked,

    /// The file exceeds the § 9.9 64 MiB cap. Carries the cap so the UI
    /// can render "max 64 MiB" without hardcoding the constant. The
    /// file's actual size is NOT included — a size is benign on its own
    /// but the UI already knows it (it's the file the user picked), so
    /// echoing it back adds nothing and keeps the payload minimal.
    #[error("attachment exceeds the size cap")]
    Oversize {
        /// The inclusive byte cap (`67108864`).
        cap_bytes: usize,
    },

    /// The file's magic bytes did not match the import allowlist
    /// (PNG / JPEG / GIF / WebP / SVG / PDF). Sniffed by content, not by
    /// extension. The sniffed-or-claimed type is intentionally NOT
    /// echoed back (it could carry attacker-chosen bytes); the UI shows
    /// a static "unsupported file type" message.
    #[error("unsupported attachment type")]
    UnsupportedType,

    /// Filesystem error: reading the source path (picker/drop path
    /// import), reading `vault.meta` (for `account_number_hash`),
    /// reading the catalog for the dedup check, or writing the blob /
    /// catalog via `atomic_write`. The closed-enum kind lets the UI
    /// distinguish disk-full vs permission-denied for the error toast.
    #[error("filesystem error during attachment import")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },

    /// `vault.meta` parse failure during the `account_number_hash`
    /// extraction (needed to build the catalog AAD). Same surface as
    /// `prefs`'s `InvalidVaultMeta`.
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,

    /// `protocol::encode_attachment_blob` or
    /// `protocol::encode_attachments_catalog` returned an error —
    /// practically unreachable in v0.1 (the size cap is checked before
    /// encode; AEAD seal under fixed parameters does not fail), but
    /// preserved as a closed variant so a future codec change has a
    /// surface.
    #[error("attachment blob or catalog encode failed")]
    EncodeFailed,

    /// `spawn_blocking` panic / runtime shutdown during the encode +
    /// write pipeline.
    #[error("attachment import worker failed")]
    JoinFailure,
}

impl From<std::io::Error> for AttachmentImportError {
    fn from(e: std::io::Error) -> Self {
        AttachmentImportError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Failure surface for [`super::commands::catalog_list`].
///
/// | Variant                | JSON                                                           |
/// |------------------------|----------------------------------------------------------------|
/// | `Locked`               | `{"kind":"Locked"}`                                            |
/// | `Io { io_error_kind }` | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}` |
/// | `InvalidVaultMeta`     | `{"kind":"InvalidVaultMeta"}`                                  |
///
/// Note: catalog DECODE failures (absent / truncated / AEAD-fail /
/// parse-fail) do NOT surface here — they collapse to the empty catalog
/// per `protocol::read_or_empty` (§ 9.10.4), exactly like `prefs_read`'s
/// fall-back-to-defaults. Only the slot gate and the `vault.meta` read
/// (needed for the AAD) can fail the list.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum CatalogListError {
    /// Slot was not `Slot::Unlocked`.
    #[error("vault is not unlocked")]
    Locked,

    /// Filesystem error reading `vault.meta` (for the AAD).
    #[error("filesystem error reading vault.meta")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },

    /// `vault.meta` parse failed.
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,
}

impl From<std::io::Error> for CatalogListError {
    fn from(e: std::io::Error) -> Self {
        CatalogListError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Failure surface for [`super::commands::attachment_delete`].
///
/// | Variant                | JSON                                                           |
/// |------------------------|----------------------------------------------------------------|
/// | `Locked`               | `{"kind":"Locked"}`                                            |
/// | `InvalidId`            | `{"kind":"InvalidId"}`                                         |
/// | `Io { io_error_kind }` | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}` |
/// | `InvalidVaultMeta`     | `{"kind":"InvalidVaultMeta"}`                                  |
/// | `EncodeFailed`         | `{"kind":"EncodeFailed"}`                                      |
///
/// Deleting an id that is absent from the catalog is **not** an error —
/// it collapses to `Ok(())` (idempotent delete), mirroring the UX
/// posture that `note_delete`'s UI applies to its `NoteNotFound`.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AttachmentDeleteError {
    /// Slot was not `Slot::Unlocked`.
    #[error("vault is not unlocked")]
    Locked,

    /// The supplied id string is not a valid 64-char lowercase-hex
    /// attachment-id. Bug-canary: the UI only hands back ids the
    /// `catalog_list` command produced.
    #[error("invalid attachment id")]
    InvalidId,

    /// Filesystem error reading `vault.meta` / the catalog, unlinking
    /// the blob, or rewriting the catalog.
    #[error("filesystem error during attachment delete")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },

    /// `vault.meta` parse failed.
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,

    /// `protocol::encode_attachments_catalog` returned an error on the
    /// catalog rewrite — practically unreachable in v0.1.
    #[error("catalog encode failed")]
    EncodeFailed,
}

impl From<std::io::Error> for AttachmentDeleteError {
    fn from(e: std::io::Error) -> Self {
        AttachmentDeleteError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Failure surface for [`super::commands::attachment_rename`] (MYND-170).
///
/// | Variant                | JSON                                                           |
/// |------------------------|----------------------------------------------------------------|
/// | `Locked`               | `{"kind":"Locked"}`                                            |
/// | `InvalidId`            | `{"kind":"InvalidId"}`                                         |
/// | `EmptyFilename`        | `{"kind":"EmptyFilename"}`                                     |
/// | `AttachmentNotFound`   | `{"kind":"AttachmentNotFound"}`                                |
/// | `Io { io_error_kind }` | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}` |
/// | `InvalidVaultMeta`     | `{"kind":"InvalidVaultMeta"}`                                  |
/// | `EncodeFailed`         | `{"kind":"EncodeFailed"}`                                      |
///
/// Free-form rename: duplicates are allowed (the content-addressed id is
/// the key; the filename is a cosmetic display label), so there is no
/// duplicate-name variant. `AttachmentNotFound` is a bug-canary — the UI
/// only renames ids surfaced by `catalog_list`.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AttachmentRenameError {
    /// Slot was not `Slot::Unlocked`.
    #[error("vault is not unlocked")]
    Locked,

    /// The supplied id string is not a valid 64-char lowercase-hex
    /// attachment-id. Bug-canary: the UI only hands back catalog ids.
    #[error("invalid attachment id")]
    InvalidId,

    /// The supplied filename was empty / whitespace-only. The UI prevents
    /// this; it is a bug-canary, not a normal-flow rejection.
    #[error("attachment filename is empty")]
    EmptyFilename,

    /// No catalog entry with the supplied id exists. Bug-canary — the UI
    /// only renames ids surfaced by `catalog_list`.
    #[error("attachment not found")]
    AttachmentNotFound,

    /// Filesystem error reading `vault.meta` / the catalog, or rewriting
    /// the catalog.
    #[error("filesystem error during attachment rename")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },

    /// `vault.meta` parse failed.
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,

    /// `protocol::encode_attachments_catalog` returned an error on the
    /// catalog rewrite — practically unreachable in v0.1.
    #[error("catalog encode failed")]
    EncodeFailed,
}

impl From<std::io::Error> for AttachmentRenameError {
    fn from(e: std::io::Error) -> Self {
        AttachmentRenameError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Failure surface for the `attachments` reconcile commands
/// (`attachment_refs_apply` / `attachment_refs_remove` /
/// `attachment_refs_referencing`, MYND-169 SYNC-6).
///
/// | Variant            | JSON                          |
/// |--------------------|-------------------------------|
/// | `SlotNotUnlocked`  | `{"kind":"SlotNotUnlocked"}`  |
///
/// Closed taxonomy, DENY-list clean (no note-id / attachment-id content).
/// The reference graph is plaintext-derived RAM that only exists while
/// `Slot::Unlocked`, so every reconcile command is slot-gated — the same
/// single-variant surface as `vault_indices::VaultIndicesError`. Mirrored
/// on the TS side by `src/notes/attachmentRefs.ts`.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AttachmentRefsError {
    /// `VaultRuntimeState`'s slot was not `Slot::Unlocked` when the
    /// reconcile command ran. Frontend CTA: re-prompt for unlock.
    /// Bug-canary in the legitimate flow — the reconcile commands are only
    /// invoked post-unlock (rebuild sweep + note lifecycle); a routing
    /// regression or dev-tools injection are the only production causes.
    #[error("vault is not unlocked")]
    SlotNotUnlocked,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_serializes_with_kind_tag() {
        assert_eq!(
            serde_json::to_string(&AttachmentImportError::Locked).unwrap(),
            r#"{"kind":"Locked"}"#
        );
    }

    #[test]
    fn oversize_serializes_with_cap() {
        assert_eq!(
            serde_json::to_string(&AttachmentImportError::Oversize {
                cap_bytes: 67108864
            })
            .unwrap(),
            r#"{"kind":"Oversize","detail":{"cap_bytes":67108864}}"#
        );
    }

    #[test]
    fn unsupported_type_serializes_with_kind_tag() {
        assert_eq!(
            serde_json::to_string(&AttachmentImportError::UnsupportedType).unwrap(),
            r#"{"kind":"UnsupportedType"}"#
        );
    }

    #[test]
    fn import_io_serializes_with_io_error_kind() {
        assert_eq!(
            serde_json::to_string(&AttachmentImportError::Io {
                io_error_kind: IoFailureKind::PermissionDenied
            })
            .unwrap(),
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    #[test]
    fn delete_invalid_id_serializes_with_kind_tag() {
        assert_eq!(
            serde_json::to_string(&AttachmentDeleteError::InvalidId).unwrap(),
            r#"{"kind":"InvalidId"}"#
        );
    }
}
