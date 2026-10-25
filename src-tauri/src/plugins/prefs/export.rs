// SPDX-License-Identifier: AGPL-3.0
//! `export_view_manifest` — write ONE saved view as a `.myneview` manifest to a
//! user-chosen path (view-manifests, myne-md/myne#922 task 8).
//!
//! # Why the host writes, and why it encodes
//!
//! Export is deliberate, user-initiated plaintext egress (TB3): the OS save
//! dialog names the destination, and the bytes never round-trip through the
//! WebView on their way to disk. `src/AGENTS.md`'s export discipline is the
//! established shape, and `note_image_export` is the sibling this command is
//! modelled on: the frontend holds the bytes' SOURCE and this command performs
//! only the durable write.
//!
//! The one difference from that sibling is where the bytes come from. An image
//! arrives already rasterized; a manifest is a `SavedView`, so this command
//! encodes it with `protocol::canonical_encode_saved_view` — the SAME encoder the
//! prefs blob uses. That is the whole reason export is a command rather than a
//! WebView-side `JSON.stringify`: a second encoder in TypeScript would be a
//! second opinion about the canonical bytes, and the import path compares bytes.
//! `exported_bytes_are_accepted_by_the_strict_reader` pins the property that
//! matters: what this writes, `parse_view_manifest` accepts and re-encodes to
//! itself.
//!
//! # No vault gate, deliberately
//!
//! There is no decrypt here: the definition is already in the caller's hands (it
//! came from `prefs_read`). Refusing on a locked vault would buy nothing, because
//! a WebView holding the definition could write the same JSON itself; what it
//! could NOT do is claim a canonical form, which is this command's actual job.
//!
//! # Bounded, because a write to a caller-named path must be
//!
//! The input is a typed `SavedView`, so the bytes on disk are always a canonical
//! manifest and never arbitrary content; [`MAX_MANIFEST_BYTES`] refuses an
//! oversized one by name rather than writing a file the reader would reject.
//!
//! Logging: stage tags and a closed error kind only, never a view name, an id or
//! a path (`src-tauri/AGENTS.md` "Secret-handling logging discipline").

use std::path::Path;

use myne_core::io_failure_kind::{from_io_error_kind, IoFailureKind};
use protocol::{canonical_encode_saved_view, SavedView, MAX_MANIFEST_BYTES};
use serde::Serialize;
use thiserror::Error;

/// Bounded failure surface, `#[serde(tag="kind")]` like every sibling export so
/// the WebView matches on `kind`.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ViewManifestExportError {
    /// The user-chosen path's parent is missing or is not a directory. The OS
    /// dialog normally guarantees it; this fires only on a between-confirm-and-
    /// write vanish. Mirrors `NoteExportError::InvalidDestination`.
    #[error("invalid destination")]
    InvalidDestination,
    /// `overwrite=false` and the target already exists — the dialog's "Replace"
    /// consent was not given. The existing file is untouched (SYNC-2).
    #[error("target already exists")]
    TargetAlreadyExists,
    /// The encoded manifest exceeds [`MAX_MANIFEST_BYTES`], so the file would be
    /// one no reader accepts. Refused by name rather than written.
    #[error("manifest too large")]
    TooLarge,
    /// A filesystem failure writing the destination.
    #[error("io failure")]
    Io { io_error_kind: IoFailureKind },
    /// The blocking write task panicked or the runtime shut down.
    #[error("join failure")]
    JoinFailure,
}

/// Static-string label for tracing — a new variant compile-fails the match, so
/// the log vocabulary cannot drift from the enum.
fn export_error_kind(e: &ViewManifestExportError) -> &'static str {
    match e {
        ViewManifestExportError::InvalidDestination => "invalid_destination",
        ViewManifestExportError::TargetAlreadyExists => "target_already_exists",
        ViewManifestExportError::TooLarge => "too_large",
        ViewManifestExportError::Io { .. } => "io_failure",
        ViewManifestExportError::JoinFailure => "join_failure",
    }
}

/// Testable sync core: canonical-encode the definition, bound it, then durably
/// write it through `atomic_write_unclobbered` (randomized temp sibling at the
/// USER destination, never inside the vault). `overwrite` carries the save
/// dialog's "Replace" consent.
pub(crate) fn write_manifest_to(
    target_path: &Path,
    view: &SavedView,
    overwrite: bool,
) -> Result<(), ViewManifestExportError> {
    let bytes = canonical_encode_saved_view(view);
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(ViewManifestExportError::TooLarge);
    }
    if !crate::paths::parent_dir_ok(target_path) {
        return Err(ViewManifestExportError::InvalidDestination);
    }
    crate::atomic_write::atomic_write_unclobbered(target_path, &bytes, overwrite).map_err(|e| {
        match e.kind() {
            std::io::ErrorKind::AlreadyExists => ViewManifestExportError::TargetAlreadyExists,
            k => ViewManifestExportError::Io {
                io_error_kind: from_io_error_kind(k),
            },
        }
    })
}

/// Write `view` as a `.myneview` manifest to `target_path`.
#[tauri::command]
pub async fn export_view_manifest(
    view: SavedView,
    target_path: String,
    overwrite: bool,
) -> Result<(), ViewManifestExportError> {
    let target = std::path::PathBuf::from(target_path);
    let result = tokio::task::spawn_blocking(move || write_manifest_to(&target, &view, overwrite))
        .await
        .map_err(|_| ViewManifestExportError::JoinFailure)?;
    if let Err(e) = &result {
        tracing::error!(
            event = "view_manifest_export_failed",
            error_kind = export_error_kind(e),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{parse_view_manifest, FilterNode, SortDirection, ViewSort, ViewType};

    fn sample() -> SavedView {
        SavedView {
            id: "0190a000-0000-7000-8000-0000000000aa".to_string(),
            name: "Unread books".to_string(),
            view_type: ViewType::Table,
            filters: FilterNode::And {
                children: vec![
                    FilterNode::HasTag {
                        tag: "books".to_string(),
                    },
                    FilterNode::Property {
                        key: "finished".to_string(),
                        op: protocol::PropertyOp::Eq,
                        value: "no".to_string(),
                    },
                ],
            },
            sort: Some(ViewSort {
                key: "added".to_string(),
                direction: SortDirection::Desc,
            }),
            group_by: Some("series".to_string()),
            columns: vec!["author".to_string(), "status".to_string()],
            card_size: None,
            image: Some("cover".to_string()),
            image_aspect_ratio: None,
            version: Some(3),
            write_fields: vec!["status".to_string()],
        }
    }

    #[test]
    fn writes_the_canonical_bytes_verbatim() {
        let dir = crate::test_support::ScopedTempDir::new("view-manifest-export").unwrap();
        let target = dir.path().join("unread.myneview");
        write_manifest_to(&target, &sample(), false).expect("write");
        let written = std::fs::read(&target).unwrap();
        assert_eq!(written, canonical_encode_saved_view(&sample()));
    }

    #[test]
    fn exported_bytes_are_accepted_by_the_strict_reader() {
        // The property the import path depends on: what export writes, the
        // strict reader accepts, and it re-encodes to the same bytes, which is
        // what makes a re-import of an exported file the no-op arm.
        let bytes = canonical_encode_saved_view(&sample());
        let decoded = parse_view_manifest(&bytes).expect("export must be importable");
        assert_eq!(canonical_encode_saved_view(&decoded), bytes);
    }

    #[test]
    fn honors_the_overwrite_consent() {
        let dir = crate::test_support::ScopedTempDir::new("view-manifest-clobber").unwrap();
        let target = dir.path().join("v.myneview");
        write_manifest_to(&target, &sample(), false).expect("first write");
        let first = std::fs::read(&target).unwrap();
        // No dialog consent on an existing target → refused, file untouched.
        assert!(matches!(
            write_manifest_to(&target, &sample(), false),
            Err(ViewManifestExportError::TargetAlreadyExists)
        ));
        assert_eq!(std::fs::read(&target).unwrap(), first);
        // With consent → replaced (same bytes here, so the file simply stays).
        write_manifest_to(&target, &sample(), true).expect("overwrite");
    }

    #[test]
    fn rejects_a_missing_parent_directory() {
        let dir = crate::test_support::ScopedTempDir::new("view-manifest-noparent").unwrap();
        let target = dir.path().join("missing").join("v.myneview");
        assert!(matches!(
            write_manifest_to(&target, &sample(), false),
            Err(ViewManifestExportError::InvalidDestination)
        ));
    }

    #[test]
    fn refuses_a_manifest_larger_than_the_reader_accepts() {
        let dir = crate::test_support::ScopedTempDir::new("view-manifest-toolarge").unwrap();
        let target = dir.path().join("big.myneview");
        let mut view = sample();
        view.name = "x".repeat(MAX_MANIFEST_BYTES + 1);
        assert!(matches!(
            write_manifest_to(&target, &view, false),
            Err(ViewManifestExportError::TooLarge)
        ));
        assert!(
            !target.exists(),
            "nothing written for an oversized manifest"
        );
    }
}
