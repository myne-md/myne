// SPDX-License-Identifier: AGPL-3.0
//! `captures` plugin commands — the pending-capture queue for the Apple Watch
//! voice-quick-capture companion (`protocol.md` § 9.18).
//!
//! Three Tauri commands, all device-key based (they do NOT touch the vault
//! runtime, so `seal_staged` works while the vault is locked):
//! - **`seal_staged`** — encrypt every plaintext file the native WatchConnectivity
//!   receiver dropped in `staging/` into a `MYK1` blob under `sealed/`, deleting
//!   the plaintext. Runs on app boot + on the `capture` event (JS root listener).
//! - **`take_pending`** — decrypt every `sealed/` blob and return the dictated
//!   text to the WebView, which turns each into a note via the audited
//!   `plugin:notes|note_create` path on unlock. A corrupt / foreign / non-UTF-8
//!   entry is silently dropped (a queue entry that cannot become a note is
//!   discarded — never an error).
//! - **`ack`** — delete a drained entry by its hex `capture_id`.
//!
//! Drain is **at-least-once**: `take_pending` does not delete on read (only `ack`
//! deletes), so a crash between note-create and `ack` re-drains that entry into a
//! rare duplicate note. The JS drainer serialises itself (an `isDraining` guard)
//! to avoid same-session duplicates; the process-wide `QUEUE_LOCK` here serialises
//! the filesystem operations regardless of caller.
//!
//! The OS-free `*_in_dir(s)` cores take explicit dirs + a supplied key, so they
//! unit-test end-to-end without a keychain or an `AppHandle` (the `#[tauri::command]`
//! wrappers resolve the queue dirs + fetch the device key). See:
//! ../../CLAUDE.md "Secret-handling logging discipline" — the dictated text and
//! the wrap key are never logged.

use std::path::Path;

use getrandom::getrandom;
use protocol::capture_blob::{decode_capture_blob, encode_capture_blob, MAX_CAPTURE_PLAINTEXT_LEN};
use serde::Serialize;
use tauri::{AppHandle, Runtime};
use zeroize::Zeroizing;

use super::device_key;
use super::error::CaptureError;
use super::queue;
use crate::io_failure_kind::from_io_error_kind;

/// Serialises all queue filesystem operations across concurrent command
/// invocations (e.g. a React StrictMode double-mount firing `take_pending`
/// twice). A `const_new` tokio mutex needs no lazy-init.
static QUEUE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// One drained pending capture handed to the WebView: the hex `capture_id`
/// (used to `ack`) + the dictated text (becomes a note body).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PendingCapture {
    /// The 32-char hex `capture_id` — the `sealed/` filename; pass back to `ack`.
    pub id: String,
    /// The dictated note text (UTF-8).
    pub text: String,
}

fn io(e: std::io::Error) -> CaptureError {
    CaptureError::Io(from_io_error_kind(e.kind()))
}

/// Seal every plaintext file in `staging` into a `MYK1` blob under `sealed`,
/// deleting the plaintext. Empty / oversize staging entries are dropped (they can
/// never become a note). Returns the number of blobs written.
pub fn seal_staged_in_dirs(
    staging: &Path,
    sealed: &Path,
    key: &[u8; 32],
) -> Result<u32, CaptureError> {
    queue::ensure_dir(sealed)?;
    let mut count = 0u32;
    for path in queue::list_files(staging) {
        let plaintext = match std::fs::read(&path) {
            Ok(b) => Zeroizing::new(b),
            Err(_) => continue,
        };
        if plaintext.is_empty() || plaintext.len() > MAX_CAPTURE_PLAINTEXT_LEN {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        let mut id = [0u8; 16];
        getrandom(&mut id).map_err(|_| CaptureError::Backend)?;
        let blob = encode_capture_blob(key, &id, &plaintext).map_err(|_| CaptureError::Backend)?;
        let out = sealed.join(queue::hex_lower(&id));
        crate::atomic_write::atomic_write_private(&out, &blob, true).map_err(io)?;
        // Best-effort: the seal succeeded; if the plaintext delete fails the next
        // seal_staged re-seals it under a fresh id (a duplicate, drained later).
        let _ = std::fs::remove_file(&path);
        count += 1;
    }
    Ok(count)
}

/// Decrypt every `MYK1` blob in `sealed` and return the dictated text. A blob
/// that cannot be decoded (corrupt / wrong-key / non-UTF-8) is deleted and
/// skipped — it can never become a note. Does NOT delete decoded entries (that
/// is `ack`'s job — the at-least-once contract).
pub fn take_pending_in_dir(
    sealed: &Path,
    key: &[u8; 32],
) -> Result<Vec<PendingCapture>, CaptureError> {
    let mut out = Vec::new();
    for path in queue::list_files(sealed) {
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if queue::is_capture_id(n) => n.to_string(),
            // Stray non-queue file — leave it alone, skip.
            _ => continue,
        };
        let blob = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Filename/header agreement (`protocol.md` §9.18.4, reader-side MUST).
        // The AAD binds the `capture_id` in the HEADER, not the one in the
        // filename, so a sealed entry copied to a second name is unaltered and
        // still opens — the AEAD cannot notice, and the copy would drain into a
        // second note. Skip, never delete: the correctly-named twin is a valid
        // drainable entry, and a delete driven by attacker-controlled
        // filesystem state is the wrong reflex (the delete-on-failure arms
        // below are for entries that can never decode, a different case).
        match protocol::capture_blob::parse_capture_header(&blob) {
            Ok(h) if hex_id_matches(&name, &h.capture_id) => {}
            Ok(_) => continue,
            // Unparseable header: fall through to the decode arm, which owns
            // the poison-entry policy.
            Err(_) => {}
        }
        match decode_capture_blob(key, &blob) {
            Ok(pt) => match core::str::from_utf8(&pt) {
                Ok(text) => out.push(PendingCapture {
                    id: name,
                    text: text.to_string(),
                }),
                Err(_) => {
                    let _ = std::fs::remove_file(&path);
                }
            },
            Err(_) => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(out)
}

/// Does the 32-hex queue filename name the same id the blob header carries?
///
/// Case-INSENSITIVE on purpose: [`queue::is_capture_id`] accepts `A-F`, so a
/// lowercase-only comparison would reject entries the queue's own filename
/// validator produced as valid. `protocol.md` §9.18.4 states the same
/// constraint normatively.
fn hex_id_matches(name: &str, id: &[u8]) -> bool {
    name.eq_ignore_ascii_case(&queue::hex_lower(id))
}

/// Delete a drained entry by its hex `capture_id`. A non-hex id is rejected
/// (path-traversal guard); an already-absent entry is a successful ack.
pub fn ack_in_dir(sealed: &Path, id: &str) -> Result<(), CaptureError> {
    if !queue::is_capture_id(id) {
        return Err(CaptureError::Backend);
    }
    match std::fs::remove_file(sealed.join(id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(e)),
    }
}

/// Seal every staged plaintext capture into the encrypted queue. Device-key
/// based, so it runs while the vault is locked. No-op (returns 0) when there is
/// nothing staged.
#[tauri::command]
pub async fn seal_staged<R: Runtime>(app: AppHandle<R>) -> Result<u32, CaptureError> {
    let _guard = QUEUE_LOCK.lock().await;
    let staging = queue::staging_dir(&app)?;
    let sealed = queue::sealed_dir(&app)?;
    let key = device_key::get_or_create()?;
    seal_staged_in_dirs(&staging, &sealed, &key)
}

/// Decrypt and return every pending capture for the WebView to turn into notes.
/// Called on `EditorFlow` mount (i.e. post-unlock) by the JS drainer.
#[tauri::command]
pub async fn take_pending<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<PendingCapture>, CaptureError> {
    let _guard = QUEUE_LOCK.lock().await;
    let sealed = queue::sealed_dir(&app)?;
    let key = device_key::get_or_create()?;
    take_pending_in_dir(&sealed, &key)
}

/// Acknowledge (delete) a drained capture once its note has been created.
#[tauri::command]
pub async fn ack<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), CaptureError> {
    let _guard = QUEUE_LOCK.lock().await;
    let sealed = queue::sealed_dir(&app)?;
    ack_in_dir(&sealed, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [0x5a; 32];

    fn tmp() -> std::path::PathBuf {
        let mut sfx = [0u8; 8];
        getrandom(&mut sfx).unwrap();
        let d = std::env::temp_dir().join(alloc_format(&sfx));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn alloc_format(sfx: &[u8; 8]) -> String {
        let mut s = String::from("myne-captures-test-");
        s.push_str(&queue::hex_lower(sfx));
        s
    }

    #[test]
    fn seal_take_ack_round_trip() {
        let root = tmp();
        let staging = root.join("staging");
        let sealed = root.join("sealed");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("a"), b"Buy oat milk").unwrap();
        std::fs::write(staging.join("b"), "café não 🎙️".as_bytes()).unwrap();

        let n = seal_staged_in_dirs(&staging, &sealed, &KEY).unwrap();
        assert_eq!(n, 2);
        assert_eq!(queue::list_files(&staging).len(), 0, "staging drained");
        assert_eq!(queue::list_files(&sealed).len(), 2, "two MYK1 blobs");

        let pending = take_pending_in_dir(&sealed, &KEY).unwrap();
        let texts: Vec<&str> = pending.iter().map(|p| p.text.as_str()).collect();
        assert!(texts.contains(&"Buy oat milk"));
        assert!(texts.contains(&"café não 🎙️"));
        // take does NOT delete (at-least-once) — entries still present.
        assert_eq!(queue::list_files(&sealed).len(), 2);

        for p in &pending {
            ack_in_dir(&sealed, &p.id).unwrap();
        }
        assert_eq!(queue::list_files(&sealed).len(), 0, "acked → empty");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn wrong_key_entry_is_dropped_not_errored() {
        let root = tmp();
        let staging = root.join("staging");
        let sealed = root.join("sealed");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("x"), b"secret").unwrap();
        seal_staged_in_dirs(&staging, &sealed, &KEY).unwrap();

        // Decrypt under a DIFFERENT key → the entry is undecryptable, so it is
        // dropped (empty result, file removed) rather than surfacing an error.
        let other = [0x11u8; 32];
        let pending = take_pending_in_dir(&sealed, &other).unwrap();
        assert_eq!(pending.len(), 0);
        assert_eq!(queue::list_files(&sealed).len(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_and_oversize_staging_dropped() {
        let root = tmp();
        let staging = root.join("staging");
        let sealed = root.join("sealed");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("empty"), b"").unwrap();
        std::fs::write(
            staging.join("big"),
            vec![0x61u8; MAX_CAPTURE_PLAINTEXT_LEN + 1],
        )
        .unwrap();
        std::fs::write(staging.join("ok"), b"fine").unwrap();

        let n = seal_staged_in_dirs(&staging, &sealed, &KEY).unwrap();
        assert_eq!(n, 1, "only the valid capture is sealed");
        assert_eq!(
            queue::list_files(&staging).len(),
            0,
            "empty/oversize dropped too"
        );
        assert_eq!(queue::list_files(&sealed).len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `protocol.md` §9.18.4: a sealed entry copied to a SECOND queue filename
    /// is byte-identical and opens correctly — the AAD binds the header
    /// `capture_id`, not the filename — so without the reader-side check the
    /// copy drains into a duplicate note. The copy must be skipped, and the
    /// original must still drain.
    #[test]
    fn a_copy_under_a_second_filename_is_skipped_not_drained() {
        let root = tmp();
        let staging = root.join("staging");
        let sealed = root.join("sealed");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("a"), b"Buy oat milk").unwrap();
        seal_staged_in_dirs(&staging, &sealed, &KEY).unwrap();

        let original = queue::list_files(&sealed).into_iter().next().unwrap();
        let forged = sealed.join("ffffffffffffffffffffffffffffffff");
        std::fs::copy(&original, &forged).unwrap();

        let pending = take_pending_in_dir(&sealed, &KEY).unwrap();
        assert_eq!(pending.len(), 1, "the copy must not drain a second time");
        assert_eq!(pending[0].text, "Buy oat milk");
        // Skipped, NOT deleted: a mismatched name is not a poison entry, and
        // deleting on attacker-controlled filesystem state is the wrong reflex.
        assert!(forged.exists(), "the mismatched copy must be left in place");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `queue::is_capture_id` accepts `A-F`, so the filename/header comparison
    /// must be case-insensitive or it would reject entries the queue's own
    /// validator calls valid.
    #[test]
    fn an_uppercase_hex_filename_still_matches_its_header() {
        let root = tmp();
        let staging = root.join("staging");
        let sealed = root.join("sealed");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("a"), b"Ring the dentist").unwrap();
        seal_staged_in_dirs(&staging, &sealed, &KEY).unwrap();

        let original = queue::list_files(&sealed).into_iter().next().unwrap();
        let lower = original.file_name().unwrap().to_str().unwrap().to_string();
        let upper = sealed.join(lower.to_ascii_uppercase());
        std::fs::rename(&original, &upper).unwrap();

        let pending = take_pending_in_dir(&sealed, &KEY).unwrap();
        assert_eq!(pending.len(), 1, "uppercase filename must still drain");
        assert_eq!(pending[0].text, "Ring the dentist");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ack_rejects_non_hex_id_path_traversal() {
        let root = tmp();
        let sealed = root.join("sealed");
        std::fs::create_dir_all(&sealed).unwrap();
        assert_eq!(
            ack_in_dir(&sealed, "../../etc/passwd"),
            Err(CaptureError::Backend)
        );
        // A valid-form but absent id is a successful (idempotent) ack.
        assert!(ack_in_dir(&sealed, &"a".repeat(32)).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }
}
