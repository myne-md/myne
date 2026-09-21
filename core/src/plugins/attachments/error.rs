//! `attachments` plugin IPC error enums (MYND-169).
//!
//! Closed taxonomies for `attachment_import`, `catalog_list`, and
//! `attachment_delete`, all DENY-list clean per `src-tauri/AGENTS.md`
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

    /// A member-held session tried to import. The content-addressed
    /// `attachment-id` is keyed under the OWNER `root_key` and must stay so
    /// across a B2B migration (spec §9.9; an id that moved would orphan every
    /// existing blob and duplicate every re-import), so a member session, which
    /// has no root key by construction, cannot mint one. Typed rather than
    /// `Locked`: the vault IS unlocked, and re-prompting for a password fixes
    /// nothing.
    #[error("attachment import requires the vault owner")]
    NotOwner,

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

    /// Reserved IPC-contract variant. Since MYND-173 the import path
    /// accepts arbitrary bytes (a non-allowlisted type is stored as
    /// `application/octet-stream`, not rejected), so the host no longer
    /// constructs this. The TS error contract + its skip-reason mapping
    /// still recognize `{"kind":"UnsupportedType"}` defensively, so the
    /// variant is retained for wire-contract stability rather than removed.
    #[allow(dead_code)]
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

    /// `vault.attachments` EXISTS and no copy of it decoded, so the catalog
    /// ciphertext is still the only record of every entry (myne#308).
    ///
    /// Refusing is the point. Overwriting it with a catalog rebuilt from the
    /// empty base would destroy every other attachment's `content_type` (the
    /// inner AAD needed to serve or export it), `filename`, `size` and
    /// `created_at` — turning a corruption that a backup or a sync peer's §11.4
    /// union merge could still repair into permanent metadata loss, and arming
    /// the next unlock's stray-blob reclaim to unlink every blob the new
    /// catalog does not name.
    ///
    /// CTA: restore `vault.attachments` from a backup, or let a peer device
    /// sync it back. Read-only surfaces keep working (they show an empty
    /// library); only the paths that rewrite the file refuse.
    #[error("the attachments catalog exists but could not be decoded")]
    CatalogUndecodable,
}

/// The storage seam's closed error, straight through (phase3-web-client task 44).
///
/// Every read and write in this plugin now goes through [`crate::vault_io::VaultIo`],
/// which already reduces `std::io::Error` to [`IoFailureKind`] at its own boundary —
/// so this is an identity wrap rather than a second reduction. The
/// `From<std::io::Error>` impl above stays for the host-only paths that still hold a
/// real `io::Error`.
impl From<IoFailureKind> for AttachmentImportError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        AttachmentImportError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for AttachmentImportError {
    fn from(e: std::io::Error) -> Self {
        AttachmentImportError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Failure surface for [`super::commands::attachment_export`] (MYND-173).
///
/// Export decrypts one attachment blob in RAM and writes the plaintext to
/// a user-chosen destination (the TB3 user-initiated-egress exception —
/// the destination is plaintext by the user's own intent). The closed
/// taxonomy mirrors `pdf_export`'s single-file export surface:
///
/// | Variant                  | JSON                                                           |
/// |--------------------------|----------------------------------------------------------------|
/// | `Locked`                 | `{"kind":"Locked"}`                                            |
/// | `InvalidId`              | `{"kind":"InvalidId"}`                                         |
/// | `NotFound`               | `{"kind":"NotFound"}`                                          |
/// | `Corrupt`                | `{"kind":"Corrupt"}`                                           |
/// | `TargetAlreadyExists`    | `{"kind":"TargetAlreadyExists"}`                              |
/// | `InvalidDestination`     | `{"kind":"InvalidDestination"}`                              |
/// | `InvalidVaultMeta`       | `{"kind":"InvalidVaultMeta"}`                                  |
/// | `Io { io_error_kind }`   | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}` |
/// | `JoinFailure`            | `{"kind":"JoinFailure"}`                                      |
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AttachmentExportError {
    /// The vault was not `Slot::Unlocked` when the export ran — no keys
    /// are available to decrypt. Frontend CTA: re-prompt for unlock.
    #[error("vault is not unlocked")]
    Locked,

    /// The `id` was not a 64-char lowercase-hex attachment-id. Bug-canary
    /// (the UI only exports ids it rendered from the catalog).
    #[error("malformed attachment id")]
    InvalidId,

    /// No catalog entry / blob for this id (deleted, or never existed).
    /// The UI re-renders as a tombstone card.
    #[error("attachment not found")]
    NotFound,

    /// The blob failed to decrypt (AEAD / CTX commitment) — corruption or
    /// a key mismatch. Collapsed from `protocol::AttachmentBlobError`.
    #[error("attachment blob failed to decrypt")]
    Corrupt,

    /// A file already exists at the destination and the caller did not
    /// consent to overwrite. Mirrors `pdf_export::TargetAlreadyExists`.
    #[error("destination already exists")]
    TargetAlreadyExists,

    /// The destination path is unusable — its parent directory does not
    /// exist (or is not a directory), or the destination is itself an
    /// existing directory. Mirrors the export suite's destination guard
    /// (`vault_export::InvalidDestination`); surfaces a clean rejection
    /// instead of a raw filesystem error for a malformed target.
    #[error("destination path is invalid")]
    InvalidDestination,

    /// `vault.meta` parse failure during the `account_number_hash`
    /// extraction (the catalog AAD identity).
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,

    /// Filesystem error reading the blob / `vault.meta` / catalog, or
    /// writing the plaintext to the destination.
    #[error("filesystem error during attachment export")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },

    /// `spawn_blocking` panic / runtime shutdown during decode + write.
    #[error("attachment export worker failed")]
    JoinFailure,
}

/// The storage seam's closed error, straight through (phase3-web-client task 44).
///
/// Every read and write in this plugin now goes through [`crate::vault_io::VaultIo`],
/// which already reduces `std::io::Error` to [`IoFailureKind`] at its own boundary —
/// so this is an identity wrap rather than a second reduction. The
/// `From<std::io::Error>` impl above stays for the host-only paths that still hold a
/// real `io::Error`.
impl From<IoFailureKind> for AttachmentExportError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        AttachmentExportError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for AttachmentExportError {
    fn from(e: std::io::Error) -> Self {
        AttachmentExportError::Io {
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

/// Failure surface for the attachment SERVE path (phase3-web-client task 44) —
/// the browser's equivalent of the desktop `attachment://` handler's status
/// codes.
///
/// **Non-distinguishing, deliberately.** The desktop handler collapses a
/// malformed id, a tampered blob, a cross-vault blob and a wrong-key blob into
/// one `403` (`protocol.md` §6.4), because telling them apart tells an attacker
/// which of those they achieved. This enum keeps that collapse: `Denied` is the
/// single answer for all four, and `NotFound` is reserved for "no catalog entry
/// or no blob file", which a caller already knows from the catalog it rendered.
///
/// | Variant                | JSON                                                           |
/// |------------------------|----------------------------------------------------------------|
/// | `Locked`               | `{"kind":"Locked"}`                                            |
/// | `NotFound`             | `{"kind":"NotFound"}`                                          |
/// | `Denied`               | `{"kind":"Denied"}`                                            |
/// | `Io { io_error_kind }` | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}` |
/// | `InvalidVaultMeta`     | `{"kind":"InvalidVaultMeta"}`                                  |
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AttachmentServeError {
    /// Slot was not `Slot::Unlocked` — no keys to decrypt with.
    #[error("vault is not unlocked")]
    Locked,

    /// No catalog entry for this id, or no blob file behind it.
    #[error("attachment not found")]
    NotFound,

    /// Malformed id, or the blob did not decode. One answer for four causes.
    #[error("attachment refused")]
    Denied,

    /// Filesystem error reading `vault.meta`, the catalog or the blob.
    #[error("filesystem error serving attachment")]
    Io {
        /// Closed-enum mapping of the storage seam's failure.
        io_error_kind: IoFailureKind,
    },

    /// `vault.meta` parse failed — the catalog AAD identity is underivable.
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,
}

impl From<IoFailureKind> for AttachmentServeError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        AttachmentServeError::Io { io_error_kind }
    }
}

/// The storage seam's closed error, straight through (phase3-web-client task 44).
///
/// Every read and write in this plugin now goes through [`crate::vault_io::VaultIo`],
/// which already reduces `std::io::Error` to [`IoFailureKind`] at its own boundary —
/// so this is an identity wrap rather than a second reduction. The
/// `From<std::io::Error>` impl above stays for the host-only paths that still hold a
/// real `io::Error`.
impl From<IoFailureKind> for CatalogListError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        CatalogListError::Io { io_error_kind }
    }
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

    /// `vault.attachments` EXISTS and no copy of it decoded, so the catalog
    /// ciphertext is still the only record of every entry (myne#308).
    ///
    /// Refusing is the point. Overwriting it with a catalog rebuilt from the
    /// empty base would destroy every other attachment's `content_type` (the
    /// inner AAD needed to serve or export it), `filename`, `size` and
    /// `created_at` — turning a corruption that a backup or a sync peer's §11.4
    /// union merge could still repair into permanent metadata loss, and arming
    /// the next unlock's stray-blob reclaim to unlink every blob the new
    /// catalog does not name.
    ///
    /// CTA: restore `vault.attachments` from a backup, or let a peer device
    /// sync it back. Read-only surfaces keep working (they show an empty
    /// library); only the paths that rewrite the file refuse.
    #[error("the attachments catalog exists but could not be decoded")]
    CatalogUndecodable,
}

/// The storage seam's closed error, straight through (phase3-web-client task 44).
///
/// Every read and write in this plugin now goes through [`crate::vault_io::VaultIo`],
/// which already reduces `std::io::Error` to [`IoFailureKind`] at its own boundary —
/// so this is an identity wrap rather than a second reduction. The
/// `From<std::io::Error>` impl above stays for the host-only paths that still hold a
/// real `io::Error`.
impl From<IoFailureKind> for AttachmentDeleteError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        AttachmentDeleteError::Io { io_error_kind }
    }
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

    /// `vault.attachments` EXISTS and no copy of it decoded, so the catalog
    /// ciphertext is still the only record of every entry (myne#308).
    ///
    /// Refusing is the point. Overwriting it with a catalog rebuilt from the
    /// empty base would destroy every other attachment's `content_type` (the
    /// inner AAD needed to serve or export it), `filename`, `size` and
    /// `created_at` — turning a corruption that a backup or a sync peer's §11.4
    /// union merge could still repair into permanent metadata loss, and arming
    /// the next unlock's stray-blob reclaim to unlink every blob the new
    /// catalog does not name.
    ///
    /// CTA: restore `vault.attachments` from a backup, or let a peer device
    /// sync it back. Read-only surfaces keep working (they show an empty
    /// library); only the paths that rewrite the file refuse.
    #[error("the attachments catalog exists but could not be decoded")]
    CatalogUndecodable,
}

/// The storage seam's closed error, straight through (phase3-web-client task 44).
///
/// Every read and write in this plugin now goes through [`crate::vault_io::VaultIo`],
/// which already reduces `std::io::Error` to [`IoFailureKind`] at its own boundary —
/// so this is an identity wrap rather than a second reduction. The
/// `From<std::io::Error>` impl above stays for the host-only paths that still hold a
/// real `io::Error`.
impl From<IoFailureKind> for AttachmentRenameError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        AttachmentRenameError::Io { io_error_kind }
    }
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

/// Failure surface for [`super::commands::attachment_unused_list`]
/// (MYND-171 — attachment cleanup).
///
/// | Variant                | JSON                                                           |
/// |------------------------|----------------------------------------------------------------|
/// | `Locked`               | `{"kind":"Locked"}`                                           |
/// | `Io { io_error_kind }` | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}` |
/// | `InvalidVaultMeta`     | `{"kind":"InvalidVaultMeta"}`                                 |
/// | `NoteScanFailed`       | `{"kind":"NoteScanFailed"}`                                   |
/// | `JoinFailure`          | `{"kind":"JoinFailure"}`                                      |
///
/// Unlike `catalog_list` (which falls back to the empty catalog on any
/// decode failure), the unused-set computation is **fail-closed**: it
/// drives a destructive UX, so a note it cannot read / decrypt / UTF-8-
/// decode surfaces as `NoteScanFailed` rather than silently under-counting
/// references (which could offer a still-referenced attachment for
/// deletion). DENY-list clean — no path, no id, no key material.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AttachmentUnusedListError {
    /// Slot was not `Slot::Unlocked`.
    #[error("vault is not unlocked")]
    Locked,

    /// Filesystem error reading `vault.meta` / the catalog, or enumerating
    /// / reading a note blob during the authoritative reference scan.
    #[error("filesystem error computing the unused-attachment set")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },

    /// `vault.meta` parse failed (needed for the catalog AAD identity).
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,

    /// A note could not be AEAD-decrypted or was not valid UTF-8 during the
    /// authoritative reference scan. **Fail-closed**: the unused set cannot
    /// be computed without reading every note's references, so cleanup is
    /// refused rather than risk erasing an attachment a corrupted /
    /// undecryptable note embeds. UI: "couldn't verify which attachments
    /// are unused — some notes may be unreadable."
    #[error("a note could not be scanned for attachment references")]
    NoteScanFailed,

    /// This device cannot prove it holds the whole vault (phase3-web-client
    /// task 89).
    ///
    /// The unused set is computed by scanning the LOCAL notes directory, so it
    /// is wrong by exactly the notes a mid-materialisation device has not pulled
    /// yet — and every attachment embedded only in one of those is offered as
    /// unused. Confirming performs the §11.4 client action, whose tombstone the
    /// OTHER devices then pull and honour: the desktop erases its copy and the
    /// server drops the body at horizon-GC. The bytes exist nowhere else.
    ///
    /// A device that never enrolled is NOT gated — its local copy is the whole
    /// vault. Only "enrolled and not proven complete" refuses.
    ///
    /// UI: "finish syncing before cleaning up" — never an empty unused list,
    /// which reads as "nothing to clean" and is the second-worst answer.
    #[error("this device has not finished syncing; the unused set would be incomplete")]
    CorpusIncomplete,

    /// `spawn_blocking` panic / runtime shutdown during the note scan.
    #[error("attachment unused-set worker failed")]
    JoinFailure,
}

/// The storage seam's closed error, straight through (phase3-web-client task 44).
///
/// Every read and write in this plugin now goes through [`crate::vault_io::VaultIo`],
/// which already reduces `std::io::Error` to [`IoFailureKind`] at its own boundary —
/// so this is an identity wrap rather than a second reduction. The
/// `From<std::io::Error>` impl above stays for the host-only paths that still hold a
/// real `io::Error`.
impl From<IoFailureKind> for AttachmentUnusedListError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        AttachmentUnusedListError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for AttachmentUnusedListError {
    fn from(e: std::io::Error) -> Self {
        AttachmentUnusedListError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

impl From<crate::plugins::attachments::ref_scan::ReferencedScanError>
    for AttachmentUnusedListError
{
    fn from(e: crate::plugins::attachments::ref_scan::ReferencedScanError) -> Self {
        use crate::plugins::attachments::ref_scan::ReferencedScanError as Scan;
        match e {
            Scan::Io(io_error_kind) => AttachmentUnusedListError::Io { io_error_kind },
            Scan::CannotDecrypt | Scan::InvalidPlaintextEncoding => {
                AttachmentUnusedListError::NoteScanFailed
            }
        }
    }
}

/// Failure surface for [`super::commands::attachment_clean_unused`]
/// (MYND-171 — the batched cleanup erase).
///
/// | Variant                | JSON                                                           |
/// |------------------------|----------------------------------------------------------------|
/// | `Locked`               | `{"kind":"Locked"}`                                           |
/// | `InvalidId`            | `{"kind":"InvalidId"}`                                        |
/// | `Io { io_error_kind }` | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}` |
/// | `InvalidVaultMeta`     | `{"kind":"InvalidVaultMeta"}`                                 |
/// | `NoteScanFailed`       | `{"kind":"NoteScanFailed"}`                                   |
/// | `EncodeFailed`         | `{"kind":"EncodeFailed"}`                                     |
/// | `JoinFailure`          | `{"kind":"JoinFailure"}`                                      |
///
/// The command re-verifies the zero-reference status of every requested id
/// (the same authoritative, **fail-closed** scan as `attachment_unused_list`)
/// before erasing — so a note that gained a reference since the review list
/// was shown causes that id to be *skipped*, not surfaced as an error.
/// `NoteScanFailed` (an unreadable note during the re-verify) aborts the
/// whole erase with **nothing deleted**. DENY-list clean.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AttachmentCleanUnusedError {
    /// Slot was not `Slot::Unlocked`.
    #[error("vault is not unlocked")]
    Locked,

    /// One of the supplied ids is not a valid 64-char lowercase-hex
    /// attachment-id. Bug-canary: the UI only passes ids surfaced by
    /// `attachment_unused_list`. The whole batch is rejected (no partial
    /// erase) so a frontend regression fails loudly rather than silently.
    #[error("invalid attachment id in the cleanup set")]
    InvalidId,

    /// Filesystem error reading `vault.meta` / the catalog, rewriting the
    /// catalog, or enumerating notes during the re-verify scan.
    #[error("filesystem error during attachment cleanup")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },

    /// `vault.meta` parse failed (needed for the catalog AAD identity).
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,

    /// A note could not be decrypted / UTF-8-decoded during the
    /// authoritative re-verify scan. **Fail-closed**: nothing is erased.
    #[error("a note could not be scanned for attachment references")]
    NoteScanFailed,

    /// This device cannot prove it holds the whole vault (phase3-web-client
    /// task 89).
    ///
    /// The unused set is computed by scanning the LOCAL notes directory, so it
    /// is wrong by exactly the notes a mid-materialisation device has not pulled
    /// yet — and every attachment embedded only in one of those is offered as
    /// unused. Confirming performs the §11.4 client action, whose tombstone the
    /// OTHER devices then pull and honour: the desktop erases its copy and the
    /// server drops the body at horizon-GC. The bytes exist nowhere else.
    ///
    /// A device that never enrolled is NOT gated — its local copy is the whole
    /// vault. Only "enrolled and not proven complete" refuses.
    ///
    /// UI: "finish syncing before cleaning up" — never an empty unused list,
    /// which reads as "nothing to clean" and is the second-worst answer.
    #[error("this device has not finished syncing; the unused set would be incomplete")]
    CorpusIncomplete,

    /// `protocol::encode_attachments_catalog` failed on the catalog
    /// rewrite — practically unreachable in v0.1.
    #[error("catalog encode failed")]
    EncodeFailed,

    /// `spawn_blocking` panic / runtime shutdown during the re-verify scan.
    #[error("attachment cleanup worker failed")]
    JoinFailure,

    /// `vault.attachments` EXISTS and no copy of it decoded, so the catalog
    /// ciphertext is still the only record of every entry (myne#308).
    ///
    /// Refusing is the point. Overwriting it with a catalog rebuilt from the
    /// empty base would destroy every other attachment's `content_type` (the
    /// inner AAD needed to serve or export it), `filename`, `size` and
    /// `created_at` — turning a corruption that a backup or a sync peer's §11.4
    /// union merge could still repair into permanent metadata loss, and arming
    /// the next unlock's stray-blob reclaim to unlink every blob the new
    /// catalog does not name.
    ///
    /// CTA: restore `vault.attachments` from a backup, or let a peer device
    /// sync it back. Read-only surfaces keep working (they show an empty
    /// library); only the paths that rewrite the file refuse.
    #[error("the attachments catalog exists but could not be decoded")]
    CatalogUndecodable,
}

/// The storage seam's closed error, straight through (phase3-web-client task 44).
///
/// Every read and write in this plugin now goes through [`crate::vault_io::VaultIo`],
/// which already reduces `std::io::Error` to [`IoFailureKind`] at its own boundary —
/// so this is an identity wrap rather than a second reduction. The
/// `From<std::io::Error>` impl above stays for the host-only paths that still hold a
/// real `io::Error`.
impl From<IoFailureKind> for AttachmentCleanUnusedError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        AttachmentCleanUnusedError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for AttachmentCleanUnusedError {
    fn from(e: std::io::Error) -> Self {
        AttachmentCleanUnusedError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

impl From<crate::plugins::attachments::ref_scan::ReferencedScanError>
    for AttachmentCleanUnusedError
{
    fn from(e: crate::plugins::attachments::ref_scan::ReferencedScanError) -> Self {
        use crate::plugins::attachments::ref_scan::ReferencedScanError as Scan;
        match e {
            Scan::Io(io_error_kind) => AttachmentCleanUnusedError::Io { io_error_kind },
            Scan::CannotDecrypt | Scan::InvalidPlaintextEncoding => {
                AttachmentCleanUnusedError::NoteScanFailed
            }
        }
    }
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

    #[test]
    fn unused_list_note_scan_failed_serializes_with_kind_tag() {
        assert_eq!(
            serde_json::to_string(&AttachmentUnusedListError::NoteScanFailed).unwrap(),
            r#"{"kind":"NoteScanFailed"}"#
        );
    }
}
