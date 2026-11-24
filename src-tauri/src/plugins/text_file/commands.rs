// SPDX-License-Identifier: AGPL-3.0-only
//! One plaintext file in, one plaintext file out (myne-md/myne#1037).
//!
//! Its own plugin rather than a member of `export`: `export` is a desktop/mobile TWIN
//! (`mobile/src-tauri/src/plugins/export/`), and a pair that starts answering
//! differently is a ratchet the tree refuses to grow. A desktop-only plugin is the
//! sanctioned shape for a capability one client has and the other does not
//! (`plain_file`, `pdf_export`, `mcp`), and this is one: the phone has no
//! path-taking dialog and no calendar surface yet.
//!
//! # Why these two commands exist
//!
//! The calendar exchanges `.ics` files with the rest of the world, and the codec
//! that reads and writes them lives in TypeScript (`client-core/src/ics.ts`) so
//! the same parser serves every client. Two things were missing between that codec
//! and a user's disk, and they are not the same thing: a way to write text the
//! WebView produced to a path the user named, and a way to read a file the user
//! picked as text, bounded, without a path being invented by the page.
//!
//! Neither existed. `plain_file` is the closest neighbour and it is a different
//! shape on purpose: its ingress is a Markdown-filtered editor, it mints a handle
//! and a base hash so a later write can compare-and-swap, and it opens a tab. This
//! pair mints no handle, holds no state and opens nothing.
//!
//! # The shape it copies
//!
//! `plugins/prefs/{import,export}.rs` for the view manifest, deliberately: a path
//! crosses IPC in both directions there, the destination is validated with
//! `paths::parent_dir_ok`, the write goes through `atomic_write_unclobbered` with
//! the save dialog's own "Replace" consent, and the read is capped while reading
//! so an oversized file is DETECTED rather than silently truncated. A second
//! opinion about any of that would be a second place for it to be wrong.
//!
//! # The cap, and why it is shared
//!
//! [`TEXT_FILE_MAX_BYTES`] is one number for both directions because the reader
//! and the writer have to agree: a file Myne wrote past the cap is a file Myne
//! would refuse to import, which is a formatting bug that reads as a security
//! one. It matches the `.ics` codec's own `ICS_BYTE_CAP`.
//!
//! # TB3
//!
//! This is deliberate, user-initiated plaintext egress and ingress, the same
//! exception every export in this tree is. Nothing here runs on its own: a save
//! is a click, a cancelled dialog writes nothing, and the reader is only ever
//! reached from a file the user picked.
//!
//! Logging: a closed error kind and a byte count only, never a path and never a
//! byte of the content (`src-tauri/AGENTS.md`, "Secret-handling logging
//! discipline").

use std::io::Read;
use std::path::Path;

use myne_core::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use thiserror::Error;

/// One cap for both directions. See the module note.
///
/// 1 MiB is the `.ics` codec's own bound: a real calendar file is kilobytes, and
/// a whole-vault `.ics` export of a few thousand events fits inside it with room
/// to spare.
pub const TEXT_FILE_MAX_BYTES: u64 = 1_048_576;

/// Bounded failure surface, `#[serde(tag="kind")]` like its siblings.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum TextFileError {
    /// The destination is not a path this app will write to (no parent, or a
    /// parent that does not exist).
    #[error("the destination was refused")]
    InvalidDestination,
    /// The destination exists and this call did not carry the dialog's overwrite
    /// consent.
    #[error("the file already exists")]
    TargetAlreadyExists,
    /// The content is larger than [`TEXT_FILE_MAX_BYTES`], so a reader would
    /// refuse what this call would write.
    #[error("the file is too large")]
    TooLarge,
    /// The file is not UTF-8. Named rather than replaced: a calendar file in a
    /// legacy encoding is a file the user should convert, and guessing would
    /// corrupt the titles it carries.
    #[error("the file is not UTF-8")]
    NotUtf8,
    /// A filesystem failure.
    #[error("io failure")]
    Io { io_error_kind: IoFailureKind },
    /// The blocking task panicked or the runtime shut down.
    #[error("join failure")]
    JoinFailure,
}

/// Static-string label for tracing: a new variant compile-fails the match, so the
/// log vocabulary cannot drift from the enum.
fn text_file_error_kind(e: &TextFileError) -> &'static str {
    match e {
        TextFileError::InvalidDestination => "invalid_destination",
        TextFileError::TargetAlreadyExists => "target_already_exists",
        TextFileError::TooLarge => "too_large",
        TextFileError::NotUtf8 => "not_utf8",
        TextFileError::Io { .. } => "io_failure",
        TextFileError::JoinFailure => "join_failure",
    }
}

/// What a caller gets back from a read: the file's NAME and its text.
///
/// The name is reported because a dialog names the file it read ("Imported 12
/// events from team.ics"), and it is the basename only: a full path never comes
/// back to the page that asked, the same rule `plain_file`'s `PickedFile` holds.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedText {
    /// The file's basename.
    pub name: String,
    /// The file's bytes, decoded as UTF-8.
    pub content: String,
}

/// The stores this plugin refuses to touch.
///
/// The same list `diagnostics` guards, and for the same reason: a destination
/// inside one of them is a vault component, not an exported calendar.
fn guarded_roots<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Vec<Result<std::path::PathBuf, ()>> {
    crate::plugins::diagnostics::commands::GuardedStore::ALL
        .iter()
        .map(|store| store.resolve(app))
        .collect()
}

/// The one file kind this plugin exchanges.
///
/// A general text writer with a page-supplied destination is a capability no other
/// command in this tree grants: a compromised WebView could write
/// `~/.config/autostart/*.desktop` or a shell rc file, and read `~/.ssh/id_ed25519`.
/// The calendar is the whole reason the plugin exists, so the extension IS the
/// bound, and it is enforced here rather than promised in a comment.
pub(crate) const TEXT_FILE_EXTENSION: &str = "ics";

/// Whether `path` names a file this plugin is allowed to touch.
///
/// Checked case-insensitively on the extension alone: a path is a path, and the
/// case of its suffix is the user's file manager rather than a security property.
fn has_the_one_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(TEXT_FILE_EXTENSION))
}

/// Reject a destination that is not a calendar, or that resolves inside a store
/// this app owns.
///
/// `containment_refused` is the shared predicate for the second half, and it is
/// reused rather than reimplemented: `format/src/dest_guard.rs` names the failure
/// (a page that skipped the dialog replacing `vault.meta`) and the four commands
/// that must re-validate. `secret_export` and `diagnostics` are the two precedent.
fn validate_text_file_destination(
    destination: &Path,
    guarded_roots: &[Result<std::path::PathBuf, ()>],
) -> Result<(), TextFileError> {
    if !has_the_one_extension(destination) {
        return Err(TextFileError::InvalidDestination);
    }
    myne_core::paths::containment_refused(destination, guarded_roots)
        .map_err(|_| TextFileError::InvalidDestination)
}

/// Testable sync core: bound the content, validate the destination, write durably.
pub(crate) fn write_text_to(
    target_path: &Path,
    content: &[u8],
    overwrite: bool,
    guarded_roots: &[Result<std::path::PathBuf, ()>],
) -> Result<(), TextFileError> {
    if content.len() as u64 > TEXT_FILE_MAX_BYTES {
        return Err(TextFileError::TooLarge);
    }
    validate_text_file_destination(target_path, guarded_roots)?;
    crate::atomic_write::atomic_write_unclobbered(target_path, content, overwrite).map_err(|e| {
        match e.kind() {
            std::io::ErrorKind::AlreadyExists => TextFileError::TargetAlreadyExists,
            k => TextFileError::Io {
                io_error_kind: from_io_error_kind(k),
            },
        }
    })
}

/// Testable sync core: capped read, same destination bounds, then strict UTF-8.
pub(crate) fn read_text_from(
    target_path: &Path,
    guarded_roots: &[Result<std::path::PathBuf, ()>],
) -> Result<ImportedText, TextFileError> {
    if !has_the_one_extension(target_path) {
        return Err(TextFileError::InvalidDestination);
    }
    myne_core::paths::containment_refused(target_path, guarded_roots)
        .map_err(|_| TextFileError::InvalidDestination)?;
    let file = std::fs::File::open(target_path).map_err(|e| TextFileError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    })?;
    // One byte past the cap, so an oversized file is DETECTED rather than
    // truncated into a parse error that blames the file's grammar.
    let mut bytes = Vec::new();
    file.take(TEXT_FILE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| TextFileError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        })?;
    if bytes.len() as u64 > TEXT_FILE_MAX_BYTES {
        return Err(TextFileError::TooLarge);
    }
    let content = String::from_utf8(bytes).map_err(|_| TextFileError::NotUtf8)?;
    let name = target_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(ImportedText { name, content })
}

/// Write `content` to `target_path`, which the caller obtained from the OS save
/// dialog. `overwrite` carries that dialog's own "Replace" consent.
#[tauri::command]
pub async fn export_text_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    content: String,
    target_path: String,
    overwrite: bool,
) -> Result<(), TextFileError> {
    let target = std::path::PathBuf::from(target_path);
    let roots = guarded_roots(&app);
    let bytes = content.into_bytes();
    let len = bytes.len();
    let result =
        tokio::task::spawn_blocking(move || write_text_to(&target, &bytes, overwrite, &roots))
            .await
            .map_err(|_| TextFileError::JoinFailure)?;
    match &result {
        Ok(()) => tracing::info!(event = "text_file_exported", bytes = len),
        Err(e) => tracing::error!(
            event = "text_file_export_failed",
            error_kind = text_file_error_kind(e),
        ),
    }
    result
}

/// Read `target_path`, which the caller obtained from the OS open dialog, as
/// UTF-8 text under [`TEXT_FILE_MAX_BYTES`].
#[tauri::command]
pub async fn import_text_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    target_path: String,
) -> Result<ImportedText, TextFileError> {
    let target = std::path::PathBuf::from(target_path);
    let roots = guarded_roots(&app);
    let result = tokio::task::spawn_blocking(move || read_text_from(&target, &roots))
        .await
        .map_err(|_| TextFileError::JoinFailure)?;
    match &result {
        Ok(text) => tracing::info!(event = "text_file_imported", bytes = text.content.len()),
        Err(e) => tracing::warn!(
            event = "text_file_import_failed",
            error_kind = text_file_error_kind(e),
        ),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No guarded store, which is what a temp directory is: these cases prove the
    /// extension and size bounds, and the store refusal has its own case below.
    const UNGUARDED: &[Result<std::path::PathBuf, ()>] = &[];

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("myne-text-file-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir.join("calendar.ics")
    }

    #[test]
    fn writes_then_reads_the_same_bytes() {
        let path = tmp("roundtrip");
        let text = "BEGIN:VCALENDAR\nEND:VCALENDAR\n";
        write_text_to(&path, text.as_bytes(), false, UNGUARDED).expect("write");
        let read = read_text_from(&path, UNGUARDED).expect("read");
        assert_eq!(read.content, text);
        assert_eq!(read.name, "calendar.ics");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn refuses_a_second_write_without_the_consent() {
        let path = tmp("noclobber");
        write_text_to(&path, b"one", false, UNGUARDED).expect("first write");
        let err = write_text_to(&path, b"two", false, UNGUARDED).expect_err("must refuse");
        assert!(matches!(err, TextFileError::TargetAlreadyExists));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn refuses_content_a_reader_would_reject() {
        let path = tmp("toolarge");
        let bytes = vec![b'x'; TEXT_FILE_MAX_BYTES as usize + 1];
        let err = write_text_to(&path, &bytes, false, UNGUARDED).expect_err("must refuse");
        assert!(matches!(err, TextFileError::TooLarge));
        assert!(!path.exists(), "a refused write must leave nothing behind");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn reading_detects_an_oversized_file_instead_of_truncating_it() {
        let path = tmp("readtoolarge");
        std::fs::write(&path, vec![b'x'; TEXT_FILE_MAX_BYTES as usize + 1]).expect("seed");
        let err = read_text_from(&path, UNGUARDED).expect_err("must refuse");
        assert!(matches!(err, TextFileError::TooLarge));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn reading_refuses_bytes_that_are_not_utf8() {
        let path = tmp("notutf8");
        std::fs::write(&path, [0xff, 0xfe, 0x00]).expect("seed");
        let err = read_text_from(&path, UNGUARDED).expect_err("must refuse");
        assert!(matches!(err, TextFileError::NotUtf8));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn refuses_any_file_that_is_not_a_calendar() {
        // The extension IS the bound: without it this command is a general text
        // writer at a page-supplied path, which nothing else in this tree grants.
        let dir = std::env::temp_dir().join(format!("myne-text-file-ext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let script = dir.join("authorized_keys");
        let err =
            write_text_to(&script, b"ssh-ed25519 AAAA", false, UNGUARDED).expect_err("refuse");
        assert!(matches!(err, TextFileError::InvalidDestination));
        assert!(
            !script.exists(),
            "a refused write must leave nothing behind"
        );
        let err = read_text_from(&script, UNGUARDED).expect_err("refuse");
        assert!(matches!(err, TextFileError::InvalidDestination));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_destination_inside_a_store_this_app_owns() {
        // A page that skipped the save dialog must not be able to rename over
        // `vault.meta`; `containment_refused` is the shared predicate for that, and
        // this pins that the plugin actually calls it.
        let dir = std::env::temp_dir().join(format!("myne-text-file-guard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let target = dir.join("vault.ics");
        let guarded = vec![Ok(dir.clone())];
        for err in [
            write_text_to(&target, b"BEGIN:VCALENDAR", true, &guarded).expect_err("refuse"),
            read_text_from(&target, &guarded)
                .err()
                .unwrap_or(TextFileError::JoinFailure),
        ] {
            assert!(matches!(err, TextFileError::InvalidDestination));
        }
        // And the same path is allowed once the store is not guarded, so the case
        // above measures the predicate rather than an unrelated refusal.
        assert!(write_text_to(&target, b"BEGIN:VCALENDAR", false, UNGUARDED).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_a_destination_with_no_directory() {
        let err = write_text_to(Path::new("calendar.ics"), b"x", true, UNGUARDED)
            .expect_err("must refuse");
        assert!(matches!(err, TextFileError::InvalidDestination));
    }
}
