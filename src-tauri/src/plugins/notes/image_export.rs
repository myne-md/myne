//! `note_image_export` — write a WebView-rasterized selection card (PNG/JPEG)
//! to a user-chosen path (MYND-361 note→image "share selection as image").
//!
//! The rasterization happens ENTIRELY in the main WebView (the rendered
//! selection → an `<svg>` card → `<canvas>` → a PNG/JPEG blob, `src/lib/
//! noteImageCard.ts` + `noteImageExport.ts`); this command performs only the
//! final durable write of the already-rendered bytes to the user's chosen
//! destination.
//!
//! No vault gate, deliberately: there is no decrypt here — the bytes arrive from
//! the unlocked editor's WebView, mirroring `pdf_export_render`. TB3 egress: the
//! produced image is deliberate, user-initiated content leaving the vault — same
//! posture as the `.md` / `.pdf` exports. The atomic temp sibling lives at the
//! USER destination (via `atomic_write_unclobbered`), never inside the vault
//! (`src-tauri/CLAUDE.md` "Atomic file writes", 2026-06-11 amendment).
//!
//! Logging: stage tags + closed error kinds only; never the image bytes or any
//! path (`src-tauri/CLAUDE.md` "Secret-handling logging discipline").

use std::path::Path;

use serde::Serialize;
use thiserror::Error;

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};

/// PNG 8-byte signature.
const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
/// JPEG start-of-image + first marker byte.
const JPEG_MAGIC: &[u8] = &[0xff, 0xd8, 0xff];

/// Whether `bytes` begins with a PNG or JPEG signature — the only image forms
/// the WebView `canvas.toBlob` export produces. A magic-byte gate so a WebView
/// bug (or a hostile IPC caller) cannot use this command to write ARBITRARY
/// bytes to a user path (e.g. raw SVG / a script).
fn is_supported_image(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_MAGIC) || bytes.starts_with(JPEG_MAGIC)
}

/// Bounded failure surface for the image export. `#[serde(tag="kind")]` mirrors
/// the sibling `NoteExportError` so the TS side matches on `kind`.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteImageExportError {
    /// The user-chosen `target_path`'s parent is missing / not a directory (the
    /// OS save dialog normally guarantees it; fires only on a between-confirm-
    /// and-write vanish). Mirrors `NoteExportError::InvalidDestination`.
    #[error("invalid destination")]
    InvalidDestination,
    /// `overwrite=false` + the target already exists — the OS dialog's "Replace"
    /// consent was not given. The existing file is untouched (SYNC-2).
    #[error("target already exists")]
    TargetAlreadyExists,
    /// The bytes are not a PNG/JPEG image (a WebView-render bug / hostile
    /// caller) — the write is refused rather than dumping arbitrary bytes.
    #[error("not a supported image")]
    InvalidImage,
    /// A filesystem failure writing the destination.
    #[error("io failure")]
    Io { io_error_kind: IoFailureKind },
    /// The `spawn_blocking` write task panicked / the runtime shut down.
    #[error("join failure")]
    JoinFailure,
}

/// Static-string label for [`NoteImageExportError`] — tracing-safe, drift-
/// detecting (a new variant compile-fails the match).
fn image_export_error_kind(e: &NoteImageExportError) -> &'static str {
    match e {
        NoteImageExportError::InvalidDestination => "invalid_destination",
        NoteImageExportError::TargetAlreadyExists => "target_already_exists",
        NoteImageExportError::InvalidImage => "invalid_image",
        NoteImageExportError::Io { .. } => "io_failure",
        NoteImageExportError::JoinFailure => "join_failure",
    }
}

/// Testable sync core: validate the destination + the image magic, then durably
/// write via `atomic_write_unclobbered` (randomized temp name at the user
/// destination). `overwrite` carries the save dialog's "Replace" consent.
pub(crate) fn write_image_to(
    target_path: &Path,
    image_bytes: &[u8],
    overwrite: bool,
) -> Result<(), NoteImageExportError> {
    if !crate::paths::parent_dir_ok(target_path) {
        return Err(NoteImageExportError::InvalidDestination);
    }
    if !is_supported_image(image_bytes) {
        return Err(NoteImageExportError::InvalidImage);
    }
    crate::atomic_write::atomic_write_unclobbered(target_path, image_bytes, overwrite).map_err(
        |e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => NoteImageExportError::TargetAlreadyExists,
            k => NoteImageExportError::Io {
                io_error_kind: from_io_error_kind(k),
            },
        },
    )
}

/// Write an already-rasterized selection card (`image_bytes`, PNG or JPEG) to
/// `target_path`. `overwrite` carries the OS save dialog's explicit "Replace"
/// consent (SYNC-2): `false` + existing target → [`NoteImageExportError::TargetAlreadyExists`],
/// target untouched. No vault gate — there is no decrypt here.
#[tauri::command]
pub async fn note_image_export(
    image_bytes: Vec<u8>,
    target_path: String,
    overwrite: bool,
) -> Result<(), NoteImageExportError> {
    let target = std::path::PathBuf::from(target_path);
    let result =
        tokio::task::spawn_blocking(move || write_image_to(&target, &image_bytes, overwrite))
            .await
            .map_err(|_| NoteImageExportError::JoinFailure)?;
    if let Err(e) = &result {
        tracing::error!(
            event = "note_image_export_failed",
            error_kind = image_export_error_kind(e),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01];
    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];

    #[test]
    fn is_supported_image_accepts_png_and_jpeg_only() {
        assert!(is_supported_image(PNG));
        assert!(is_supported_image(JPEG));
        assert!(!is_supported_image(b"<svg>...")); // raw SVG must never reach disk
        assert!(!is_supported_image(b"not an image"));
        assert!(!is_supported_image(&[]));
    }

    #[test]
    fn write_image_to_writes_png_bytes_verbatim() {
        let dir = ScopedTempDir::new("img-export").unwrap();
        let target = dir.path().join("card.png");
        write_image_to(&target, PNG, /* overwrite = */ false).expect("write");
        assert_eq!(std::fs::read(&target).unwrap(), PNG);
    }

    #[test]
    fn write_image_to_rejects_non_image_bytes() {
        let dir = ScopedTempDir::new("img-export-bad").unwrap();
        let target = dir.path().join("evil.png");
        assert!(matches!(
            write_image_to(&target, b"#!/bin/sh\nrm -rf", false),
            Err(NoteImageExportError::InvalidImage)
        ));
        assert!(!target.exists(), "nothing written for a non-image payload");
    }

    #[test]
    fn write_image_to_honors_overwrite_consent() {
        let dir = ScopedTempDir::new("img-export-clobber").unwrap();
        let target = dir.path().join("card.png");
        write_image_to(&target, PNG, false).expect("first write");
        // overwrite=false on an existing target → refused, file untouched.
        assert!(matches!(
            write_image_to(&target, JPEG, false),
            Err(NoteImageExportError::TargetAlreadyExists)
        ));
        assert_eq!(std::fs::read(&target).unwrap(), PNG);
        // overwrite=true → replaced.
        write_image_to(&target, JPEG, true).expect("overwrite");
        assert_eq!(std::fs::read(&target).unwrap(), JPEG);
    }

    #[test]
    fn write_image_to_rejects_missing_parent() {
        let dir = ScopedTempDir::new("img-export-noparent").unwrap();
        let target = dir.path().join("nonexistent-subdir").join("card.png");
        assert!(matches!(
            write_image_to(&target, PNG, false),
            Err(NoteImageExportError::InvalidDestination)
        ));
    }
}
