// SPDX-License-Identifier: AGPL-3.0
//! `read_view_manifest` — read ONE `.myneview` file from a user-chosen path and
//! validate it with the strict reader (view-manifests, myne-md/myne#922 task 9).
//!
//! # Why the host reads it
//!
//! The strict reader (`protocol::parse_view_manifest`) is the ONE authority on
//! whether a file is a valid manifest, and it lives in Rust so that the import
//! path and the `vault.prefs` path cannot disagree about the grammar. Reading the
//! file here rather than in the WebView also means the size cap is enforced while
//! reading (a 4 GiB file is refused, not loaded): the bytes never exist in the
//! WebView at all, only the parsed definition.
//!
//! # What it does NOT do
//!
//! No write, no approval, no vault access. Validation is not permission: the
//! caller still has to order the definition against the one this vault holds and
//! ask the person at this device before anything is stored. That comparison is
//! the caller's (it needs the stored version and the device's approval map), so
//! this command stays a pure read + parse.
//!
//! Logging: a stage tag and a closed error kind only, never a path, a view name
//! or the file's contents.

use std::io::Read;

use myne_core::io_failure_kind::{from_io_error_kind, IoFailureKind};
use protocol::{parse_view_manifest, SavedView, ViewManifestError, MAX_MANIFEST_BYTES};
use serde::Serialize;
use thiserror::Error;

/// Bounded failure surface, `#[serde(tag="kind")]` like the sibling export.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ViewManifestReadError {
    /// The file could not be opened or read.
    #[error("the manifest could not be read")]
    Unreadable { io_error_kind: IoFailureKind },
    /// The file is a valid FILE and not a valid MANIFEST. The reason is carried
    /// whole, because the dialog names it: "the manifest carries an unknown key"
    /// with the key, "declares a host-owned field as writable" with the marker.
    #[error("the manifest was refused")]
    Invalid { reason: ViewManifestError },
    /// The blocking read task panicked or the runtime shut down.
    #[error("join failure")]
    JoinFailure,
}

fn read_error_kind(e: &ViewManifestReadError) -> &'static str {
    match e {
        ViewManifestReadError::Unreadable { .. } => "unreadable",
        ViewManifestReadError::Invalid { .. } => "invalid",
        ViewManifestReadError::JoinFailure => "join_failure",
    }
}

/// Testable sync core: bounded read, then the strict parse.
pub(crate) fn read_manifest_from(
    target_path: &std::path::Path,
) -> Result<SavedView, ViewManifestReadError> {
    let file = std::fs::File::open(target_path).map_err(|e| ViewManifestReadError::Unreadable {
        io_error_kind: from_io_error_kind(e.kind()),
    })?;
    // Read one byte past the cap so an oversized file is DETECTED rather than
    // silently truncated into a parse error that blames the wrong thing.
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| ViewManifestReadError::Unreadable {
            io_error_kind: from_io_error_kind(e.kind()),
        })?;
    parse_view_manifest(&bytes).map_err(|reason| ViewManifestReadError::Invalid { reason })
}

/// Read and validate a `.myneview` manifest from `target_path`.
#[tauri::command]
pub async fn read_view_manifest(target_path: String) -> Result<SavedView, ViewManifestReadError> {
    let target = std::path::PathBuf::from(target_path);
    let result = tokio::task::spawn_blocking(move || read_manifest_from(&target))
        .await
        .map_err(|_| ViewManifestReadError::JoinFailure)?;
    if let Err(e) = &result {
        tracing::warn!(
            event = "view_manifest_read_failed",
            error_kind = read_error_kind(e),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{canonical_encode_saved_view, FilterNode, ViewType};

    fn sample() -> SavedView {
        SavedView {
            id: "0190a000-0000-7000-8000-0000000000aa".to_string(),
            name: "Unread books".to_string(),
            view_type: ViewType::Table,
            filters: FilterNode::All,
            sort: None,
            group_by: None,
            columns: vec![],
            card_size: None,
            image: None,
            image_aspect_ratio: None,
            version: Some(2),
            write_fields: vec![],
            lanes: Vec::new(),
            template: None,
        }
    }

    fn write(
        dir: &crate::test_support::ScopedTempDir,
        name: &str,
        bytes: &[u8],
    ) -> std::path::PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn reads_a_valid_manifest_back_to_the_same_definition() {
        let dir = crate::test_support::ScopedTempDir::new("view-manifest-read").unwrap();
        let path = write(&dir, "v.myneview", &canonical_encode_saved_view(&sample()));
        assert_eq!(read_manifest_from(&path).unwrap(), sample());
    }

    #[test]
    fn names_the_reserved_marker_it_refuses() {
        let dir = crate::test_support::ScopedTempDir::new("view-manifest-reserved").unwrap();
        let mut view = sample();
        view.write_fields = vec!["archived".to_string()];
        let path = write(&dir, "v.myneview", &canonical_encode_saved_view(&view));
        match read_manifest_from(&path).unwrap_err() {
            ViewManifestReadError::Invalid {
                reason: ViewManifestError::ReservedWriteField(marker),
            } => assert_eq!(marker, "archived"),
            other => panic!("expected ReservedWriteField, got {other:?}"),
        }
    }

    #[test]
    fn names_the_unknown_key_it_refuses() {
        let dir = crate::test_support::ScopedTempDir::new("view-manifest-unknown").unwrap();
        let mut bytes = canonical_encode_saved_view(&sample());
        // Splice an unknown key in at the front of the object. A plausible
        // future key rather than a nonsense one, because the refusal's job is to
        // name a key this build does not implement.
        bytes.splice(1..1, b"\"wip_limit\":3,".iter().copied());
        let path = write(&dir, "v.myneview", &bytes);
        match read_manifest_from(&path).unwrap_err() {
            ViewManifestReadError::Invalid {
                reason: ViewManifestError::UnknownKey(key),
            } => assert_eq!(key, "wip_limit"),
            other => panic!("expected UnknownKey, got {other:?}"),
        }
    }

    #[test]
    fn refuses_a_file_without_a_version() {
        let dir = crate::test_support::ScopedTempDir::new("view-manifest-noversion").unwrap();
        let mut view = sample();
        view.version = None;
        let path = write(&dir, "v.myneview", &canonical_encode_saved_view(&view));
        assert!(matches!(
            read_manifest_from(&path),
            Err(ViewManifestReadError::Invalid {
                reason: ViewManifestError::VersionRequired
            })
        ));
    }

    #[test]
    fn refuses_an_oversized_file_rather_than_truncating_it() {
        let dir = crate::test_support::ScopedTempDir::new("view-manifest-bigread").unwrap();
        let path = write(&dir, "v.myneview", &vec![b'{'; MAX_MANIFEST_BYTES + 1]);
        assert!(matches!(
            read_manifest_from(&path),
            Err(ViewManifestReadError::Invalid {
                reason: ViewManifestError::TooLarge
            })
        ));
    }

    #[test]
    fn reports_a_missing_file_as_unreadable() {
        let dir = crate::test_support::ScopedTempDir::new("view-manifest-missing").unwrap();
        let path = dir.path().join("nope.myneview");
        assert!(matches!(
            read_manifest_from(&path),
            Err(ViewManifestReadError::Unreadable { .. })
        ));
    }
}
