// SPDX-License-Identifier: AGPL-3.0
//! Device-local on-disk layout for the pending-capture queue.
//!
//! Two directories under `<app_data_dir>/pending-captures/`:
//! - `staging/` — **plaintext** capture files written by the native
//!   WatchConnectivity receiver (`WCCaptureReceiver.swift`), protected only by
//!   OS Data Protection (`NSFileProtectionCompleteUntilFirstUserAuthentication`);
//!   consumed and deleted by [`super::commands::seal_staged`].
//! - `sealed/` — `MYK1` blobs (`protocol::capture_blob`), one per capture, named
//!   by the hex `capture_id`; drained by [`super::commands::take_pending`].
//!
//! The queue is device-global (NOT per-vault): it is created while the vault is
//! locked and drains into whichever vault unlocks first (§ 9.18).

use crate::io_failure_kind::from_io_error_kind;
use crate::plugins::captures::error::CaptureError;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

const QUEUE_DIR: &str = "pending-captures";
const STAGING_SUBDIR: &str = "staging";
const SEALED_SUBDIR: &str = "sealed";
/// The watch meeting-capture lane's sub-tree (myne-md/myne#812). Same directory
/// family as the dictation queue above and the same device key, but its own
/// `entries/` (sealed audio) + `manifest/` (the per-session group record) so the
/// two lanes never mix filenames.
const MEETINGS_SUBDIR: &str = "meetings";
const MEETING_ENTRIES_SUBDIR: &str = "entries";
const MEETING_MANIFEST_SUBDIR: &str = "manifest";

fn base<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CaptureError> {
    Ok(crate::paths::app_data_dir(app)
        .map_err(|_| CaptureError::Backend)?
        .join(QUEUE_DIR))
}

/// `<app_data_dir>/pending-captures/staging/` — plaintext, native-written.
pub fn staging_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CaptureError> {
    Ok(base(app)?.join(STAGING_SUBDIR))
}

/// `<app_data_dir>/pending-captures/sealed/` — `MYK1` blobs.
pub fn sealed_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CaptureError> {
    Ok(base(app)?.join(SEALED_SUBDIR))
}

/// `<app_data_dir>/pending-captures/meetings/entries/` — the sealed watch audio
/// chunks of the meeting lane (opaque AEAD entries; the same 32-hex filename
/// convention as `sealed/` above).
pub fn meeting_entries_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CaptureError> {
    Ok(base(app)?
        .join(MEETINGS_SUBDIR)
        .join(MEETING_ENTRIES_SUBDIR))
}

/// `<app_data_dir>/pending-captures/meetings/manifest/` — one JSON record per
/// pending meeting session ([`super::meeting_manifest`]).
pub fn meeting_manifest_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CaptureError> {
    Ok(base(app)?
        .join(MEETINGS_SUBDIR)
        .join(MEETING_MANIFEST_SUBDIR))
}

/// Create `dir` (and parents) if absent.
pub fn ensure_dir(dir: &Path) -> Result<(), CaptureError> {
    std::fs::create_dir_all(dir).map_err(|e| CaptureError::Io(from_io_error_kind(e.kind())))
}

/// List the regular files directly in `dir` (non-recursive). A missing dir is
/// an empty list (not an error) — the queue simply has nothing yet.
pub fn list_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_file() {
                out.push(p);
            }
        }
    }
    out
}

/// A `capture_id` filename is exactly 32 lowercase-hex chars (16 bytes). Guards
/// `ack` against path traversal and stray non-queue files.
pub fn is_capture_id(name: &str) -> bool {
    name.len() == 32 && name.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Lowercase-hex encode (no external dep; matches the queue filename form).
pub fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}
