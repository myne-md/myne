// SPDX-License-Identifier: AGPL-3.0
//! `captures` plugin commands — the pending-capture queue for the Apple Watch
//! voice-quick-capture companion (`protocol.md` § 9.18), plus the watch
//! meeting-capture lane (myne-md/myne#812).
//!
//! Dictation commands, all device-key based (they do NOT touch the vault
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
//! Meeting command, also device-key based (seals while the vault is locked):
//! - **`seal_meeting_chunk`** — seal one arrived watch meeting-audio chunk under
//!   the same device-local `wrap_key` and record it in the per-session
//!   pending-meeting manifest ([`super::meeting_manifest`]). See the lane's
//!   block below the ack core for the codec choice and its constraint.
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
//! ../../AGENTS.md "Secret-handling logging discipline" — the dictated text and
//! the wrap key are never logged.

use std::path::Path;

use getrandom::getrandom;
use protocol::capture_blob::{decode_capture_blob, encode_capture_blob, MAX_CAPTURE_PLAINTEXT_LEN};
use protocol::share_import_blob::{
    decode_share_import_blob, encode_share_import_blob, MAX_SHARE_IMPORT_PLAINTEXT_LEN,
};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

use super::device_key;
use super::error::CaptureError;
use super::meeting_manifest;
use super::queue;
use crate::io_failure_kind::from_io_error_kind;
use crate::plugins::attachments::commands::{attachment_import_with_dir, ImportSource};
use crate::plugins::attachments::error::AttachmentImportError;
use crate::plugins::vault_unlock::state::VaultRuntimeState;

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

// ── watch meeting-capture lane (myne-md/myne#812) ──────────────────────────
//
// The watch records a meeting and transfers audio in chunks. Each arrived chunk
// is sealed HERE, on arrival, under the same device-local `wrap_key` the
// dictated-capture queue uses (`device_key`, § 9.18.2) — i.e. while the vault is
// LOCKED, `root_key` unavailable — and indexed in a per-session manifest
// ([`super::meeting_manifest`]) that groups chunks by session and orders them.
//
// **Codec choice, and the one hard constraint it answers.** The seal reuses the
// EXISTING device-local wrap-key codec whose plaintext cap and payload shape
// match the `MYA1` attachment the drained chunk becomes: `protocol::
// share_import_blob` (`MYF1`, § 9.20) — an arbitrary-binary, 64 MiB-capped,
// vault-agnostic blob sealed under a device-local `wrap_key` (its own doc:
// "matching the `MYA1` attachment cap"). That is what "reusing the `MYA1`
// attachment shape" resolves to without a new § 10.3 magic, a new AAD role, a
// new HKDF context, a new subkey role or a new KDF parameter, and — unlike the
// 16 KiB `MYK1` text codec — it can hold an audio chunk. The wrap key is the
// capture queue's own (`md.myne.captures`), minted exactly as § 9.18.2 states,
// so this lane is Apple-only today for the same reason the queue is.
//
// The `MYF1` codec is provider-agnostic (it only ever sees a symmetric wrap key)
// and vault-agnostic (it binds its per-entry id, not a vault identity), which is
// what lets a device that has never unlocked hold the audio. The manifest is
// what turns a bag of sealed entries into one ordered meeting.

/// Read `source`, refuse it if its plaintext exceeds the `MYF1` cap **before
/// reading it into RAM**, seal it into an entry under `entries/`, then record
/// `(session_id, chunk_index) → entry_id` in the session manifest under
/// `manifest/`.
///
/// Returns the entry id (hex) when this call newly sealed + recorded a chunk;
/// `Ok(None)` when the chunk was a duplicate of one already recorded (the
/// redundant just-sealed entry is removed) or when the source was empty (a
/// zero-length chunk can never be audio). Self-consistent: an entry is written
/// only if it is then recorded, and a duplicate drops the redundant entry, so a
/// crash cannot leave an orphaned entry silently double-draining.
pub fn seal_meeting_chunk_from_file(
    entries: &Path,
    manifest: &Path,
    key: &[u8; 32],
    session_id: &str,
    chunk_index: u32,
    started_at: u64,
    source: &Path,
) -> Result<Option<String>, CaptureError> {
    // Refuse BEFORE allocation (the §9.18.4 / §9.20.4 discipline, at the
    // attachment-sized cap this lane's audio needs): a hostile or corrupt length
    // must never drive a multi-MiB read, and a chunk is never truncated.
    let len = std::fs::metadata(source).map_err(io)?.len();
    if len > MAX_SHARE_IMPORT_PLAINTEXT_LEN as u64 {
        return Err(CaptureError::ChunkTooLarge);
    }
    if len == 0 {
        return Ok(None);
    }

    queue::ensure_dir(entries)?;
    let plaintext = Zeroizing::new(std::fs::read(source).map_err(io)?);
    // Belt to the metadata pre-check above: a file that grew between the stat
    // and the read is still refused as over-cap rather than passed to the codec
    // (which would collapse it into an opaque Backend error).
    if plaintext.len() > MAX_SHARE_IMPORT_PLAINTEXT_LEN {
        return Err(CaptureError::ChunkTooLarge);
    }
    let mut id = [0u8; 16];
    getrandom(&mut id).map_err(|_| CaptureError::Backend)?;
    let blob = encode_share_import_blob(key, &id, &plaintext).map_err(|_| CaptureError::Backend)?;
    let entry_id = queue::hex_lower(&id);
    crate::atomic_write::atomic_write_private(&entries.join(&entry_id), &blob, true).map_err(io)?;

    match meeting_manifest::append_chunk(manifest, session_id, started_at, chunk_index, &entry_id) {
        // Newly recorded → the seal stands. Best-effort drop the plaintext
        // source (the receiver's handed-off file) so the transient window is as
        // short as possible; a failed delete costs one re-seal on retry.
        Ok(true) => {
            let _ = std::fs::remove_file(source);
            Ok(Some(entry_id))
        }
        // Duplicate: the recorded entry is the one we keep, so drop the
        // redundant blob we just wrote rather than orphan it, and drop the
        // redundant source too.
        Ok(false) => {
            let _ = std::fs::remove_file(entries.join(&entry_id));
            let _ = std::fs::remove_file(source);
            Ok(None)
        }
        // The record could not be written (bad session id, IO, corrupt
        // manifest). Remove the entry we just sealed too, so the queue cannot
        // fill with entries no manifest points at.
        Err(e) => {
            let _ = std::fs::remove_file(entries.join(&entry_id));
            Err(e)
        }
    }
}

/// Seal one arrived watch audio chunk and record it in the pending-meeting
/// manifest. Device-key based, so it runs while the vault is locked. Called by
/// the native WatchConnectivity receiver the moment a chunk file lands (never
/// via a plaintext staging file — the point of sealing on arrival).
///
/// **Key, and why it is the SHARE-IMPORT device key, not the capture queue's.**
/// The codec below is `MYF1` (§9.20), and §9.20.2 pins the keychain service for
/// that queue at `md.myne.shareimport`, deliberately DISTINCT from the capture
/// queue's `md.myne.captures` so the two device-local keys can be rotated and
/// erased independently. Sealing an `MYF1` blob under `md.myne.captures` would
/// work cryptographically (the codec only ever sees a symmetric key) but would
/// make the two queues share one lifetime, which is exactly the coupling
/// §9.20.2 exists to prevent. This lane therefore uses the share-import device
/// key provider.
#[tauri::command]
pub async fn seal_meeting_chunk<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    chunk_index: u32,
    started_at: u64,
    path: String,
) -> Result<Option<String>, CaptureError> {
    let _guard = QUEUE_LOCK.lock().await;
    let entries = queue::meeting_entries_dir(&app)?;
    let manifest = queue::meeting_manifest_dir(&app)?;
    // §9.20.2: an `MYF1` blob is sealed under the SHARE-IMPORT device key
    // (`md.myne.shareimport`), which is deliberate — that key is distinct from
    // the capture queue's so the two device-local queues can be rotated and
    // erased independently. Both are 32-byte device-local wrap keys minted the
    // same way; the codec is provider-agnostic.
    let key = crate::plugins::share_import::device_key::get_or_create()
        .map_err(|_| CaptureError::Backend)?;
    seal_meeting_chunk_from_file(
        &entries,
        &manifest,
        &key,
        &session_id,
        chunk_index,
        started_at,
        Path::new(&path),
    )
}

/// One sealed chunk that drained into the vault's attachment library, in
/// capture order: its wire `chunk_index` plus the content-addressed attachment
/// id the note's embed resolves against.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DrainedMeetingChunk {
    /// The wire-supplied chunk index (the watch's ordering position).
    pub chunk_index: u32,
    /// The `MYA1` attachment id (hex) in the vault library.
    pub attachment_id: String,
}

/// One pending meeting session drained into the vault. Returns the session id,
/// its start time, the chunks that imported successfully in chunk order, and the
/// chunk indices that could NOT be imported (a chunk the watch never delivered,
/// or an entry that failed to open). The caller still builds a note from
/// `chunks` and reports `missing` — an incomplete session is a note with a gap,
/// never a lost meeting.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DrainedMeeting {
    /// The opaque watch-supplied session id.
    pub session_id: String,
    /// Session start, milliseconds since the Unix epoch (the wire `started_at`).
    pub started_at: u64,
    /// Successfully imported chunks, ascending by `chunk_index` (embed order).
    pub chunks: Vec<DrainedMeetingChunk>,
    /// Chunk indices absent from `0..=max(chunk_index)`: a chunk the watch never
    /// delivered, or one whose entry could not be opened. Non-empty means the
    /// session is incomplete.
    pub missing_chunk_indices: Vec<u32>,
}

/// Every chunk index in `0..=max`, minus the indices actually present. The
/// watch's indices start at 0 (task 7's chunker), so a session whose first chunk
/// never arrived is incomplete too — reporting only interior holes would hide
/// it.
fn missing_chunk_indices(present: &[u32]) -> Vec<u32> {
    let Some(max) = present.iter().copied().max() else {
        return Vec::new();
    };
    (0..=max).filter(|i| !present.contains(i)).collect()
}

/// Drain every pending meeting session into the vault as ordinary attachments:
/// for each session, decrypt each sealed chunk entry under the share-import
/// device key ([`crate::plugins::share_import::device_key`], matching the seal
/// in [`seal_meeting_chunk`]) and import it through `attachment_import_with_dir`
/// (host-side — the up-to-64 MiB audio never crosses the WebView).
///
/// **At-least-once, and the delete is NOT here.** A drained session's manifest
/// record and sealed entries are removed only by [`ack_meeting_session`], which
/// the WebView calls once the meeting's note exists. A crash between the import
/// and that ack re-drains the session; the content-addressed attachment dedups,
/// so the cost is a repeated import, never a lost meeting.
///
/// Returns one [`DrainedMeeting`] per session, ordered oldest-first (the
/// manifest's own order). A session whose entry cannot be opened (corrupt /
/// foreign / wrong key) simply omits that chunk, and its index is reported in
/// `missing_chunk_indices` — never a hard error, because a partial meeting is
/// still worth a note.
#[tauri::command]
pub async fn drain_pending_meetings<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
) -> Result<Vec<DrainedMeeting>, CaptureError> {
    let _guard = QUEUE_LOCK.lock().await;
    let manifest = queue::meeting_manifest_dir(&app)?;
    let entries = queue::meeting_entries_dir(&app)?;
    let sessions = meeting_manifest::list_sessions(&manifest)?;
    if sessions.is_empty() {
        return Ok(Vec::new());
    }
    // The vault must be unlocked to import; a locked slot is a `Locked` on the
    // first import, which the loop maps to "stop and leave the rest queued".
    let key = crate::plugins::share_import::device_key::get_or_create()
        .map_err(|_| CaptureError::Backend)?;
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| CaptureError::Backend)?;

    let mut out = Vec::new();
    for session in sessions {
        let mut chunks = Vec::new();
        let mut present = Vec::new();
        for chunk in &session.chunks {
            // Open the sealed entry: filename/header agreement first (best-
            // effort — a stray name is skipped rather than opened), then decode.
            let Some(mut blob) = read_validated_entry(&entries, &key, &chunk.entry_id) else {
                // A chunk that cannot be opened is a hole, not a failure.
                continue;
            };
            let source = ImportSource::Bytes {
                // MOVE, not `to_vec()`: the copy was a second full-size buffer
                // per chunk, and the import takes ownership anyway.
                bytes: std::mem::take(&mut *blob),
                filename: Some(format!("watch-meeting-{}.wav", chunk.chunk_index)),
            };
            match attachment_import_with_dir(
                &crate::vault_io::StdVaultIo,
                &crate::host::tauri_host::TauriHost::new(app.clone()),
                &dir,
                state.inner(),
                source,
            )
            .await
            {
                Ok(att) => {
                    if !att.deduplicated {
                        hooks.bump_local_change();
                    }
                    present.push(chunk.chunk_index);
                    chunks.push(DrainedMeetingChunk {
                        chunk_index: chunk.chunk_index,
                        attachment_id: att.id,
                    });
                }
                // Re-locked mid-drain — stop everything and leave the queue for
                // the next unlock (the captures/share-import contract).
                Err(AttachmentImportError::Locked) => return Ok(out),
                // Any other import failure leaves this chunk missing and the
                // drain continues: one bad chunk must not wedge the meeting.
                Err(_) => {}
            }
        }
        chunks.sort_by_key(|c| c.chunk_index);
        let missing = missing_chunk_indices(&present);
        out.push(DrainedMeeting {
            session_id: session.session_id,
            started_at: session.started_at,
            chunks,
            missing_chunk_indices: missing,
        });
    }
    Ok(out)
}

/// Read and decode one sealed meeting entry: 32-hex filename, header/filename
/// agreement, then AEAD open under `key`. Returns `None` (never an error) for a
/// stray name or an entry that cannot open — a poison entry is a hole in the
/// meeting, not a reason to fail the whole drain.
fn read_validated_entry(
    entries: &Path,
    key: &[u8; 32],
    entry_id: &str,
) -> Option<Zeroizing<Vec<u8>>> {
    if !queue::is_capture_id(entry_id) {
        return None;
    }
    let blob = std::fs::read(entries.join(entry_id)).ok()?;
    // Header/filename agreement: the AAD binds the header id, not the filename,
    // so a copy under a second name would open. Skip the mismatch (the correctly
    // named twin still drains) rather than delete on filesystem state.
    if let Ok(h) = protocol::share_import_blob::parse_share_import_header(&blob) {
        if !entry_id.eq_ignore_ascii_case(&queue::hex_lower(&h.share_id)) {
            return None;
        }
    }
    decode_share_import_blob(key, &blob).ok()
}

/// Acknowledge a drained meeting session: delete each of its sealed entries and
/// then its manifest record. Called by the WebView **only after** the meeting's
/// note exists (at-least-once). Deleting a session that is already gone is a
/// successful no-op. An entry id that is not the queue's 32-hex shape is
/// rejected by the manifest read, so a hostile record cannot traverse.
#[tauri::command]
pub async fn ack_meeting_session<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
) -> Result<(), CaptureError> {
    let _guard = QUEUE_LOCK.lock().await;
    let manifest = queue::meeting_manifest_dir(&app)?;
    let entries = queue::meeting_entries_dir(&app)?;
    ack_meeting_session_in_dirs(&entries, &manifest, &session_id)
}

/// OS-free core of [`ack_meeting_session`]: delete the session's sealed entries,
/// then its manifest record. Explicit dirs so the whole thing unit-tests without
/// an `AppHandle` or a keychain.
pub fn ack_meeting_session_in_dirs(
    entries: &Path,
    manifest: &Path,
    session_id: &str,
) -> Result<(), CaptureError> {
    // Read the record FIRST, so the entries it names are removed before the
    // record that names them disappears.
    let session = match meeting_manifest::read_session(manifest, session_id)? {
        Some(s) => s,
        None => return Ok(()),
    };
    for chunk in &session.chunks {
        if !queue::is_capture_id(&chunk.entry_id) {
            continue;
        }
        match std::fs::remove_file(entries.join(&chunk.entry_id)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io(e)),
        }
    }
    meeting_manifest::delete_session(manifest, session_id)
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

    // ── watch meeting-capture lane (myne-md/myne#812) ──────────────────────

    /// Mint a fresh, unique source path under `root` (per call — tests run in
    /// parallel and the production seal deletes the source, so a shared name
    /// would race).
    fn unique_src(root: &Path) -> std::path::PathBuf {
        let mut sfx = [0u8; 8];
        getrandom(&mut sfx).unwrap();
        root.join(format!("chunk-src-{}", queue::hex_lower(&sfx)))
    }

    /// Drop a synthetic "arrived chunk" file and seal it. Returns the entry id
    /// (hex) the seal recorded.
    fn seal_chunk(
        root: &Path,
        entries: &Path,
        manifest: &Path,
        session_id: &str,
        chunk_index: u32,
        bytes: &[u8],
    ) -> String {
        let src = unique_src(root);
        std::fs::write(&src, bytes).unwrap();
        seal_meeting_chunk_from_file(
            entries,
            manifest,
            &KEY,
            session_id,
            chunk_index,
            1_700_000_000_000,
            &src,
        )
        .unwrap()
        .expect("newly sealed")
    }

    /// The whole point of this lane: a chunk seals and round-trips **with no
    /// vault at all** (the vault slot is locked and never touched — the seal is
    /// device-key based, §9.18.2). Reuses the existing `MYF1` device-local
    /// codec, so the plaintext decodes back byte-for-byte.
    #[test]
    fn meeting_chunk_seals_and_round_trips_with_the_vault_locked() {
        let root = tmp();
        let entries = root.join("entries");
        let manifest = root.join("manifest");
        let audio: Vec<u8> = (0..4096u32).map(|n| (n % 251) as u8).collect();

        let id = seal_chunk(&root, &entries, &manifest, "sess-1", 0, &audio);
        assert!(queue::is_capture_id(&id));

        // Decode through the existing device-local codec (the same one the
        // vault-side attachment import will re-seal from).
        let blob = std::fs::read(entries.join(&id)).unwrap();
        let plaintext = protocol::share_import_blob::decode_share_import_blob(&KEY, &blob).unwrap();
        assert_eq!(plaintext.as_slice(), audio.as_slice(), "audio round-trips");

        // …and it is recorded in the session manifest.
        let session = meeting_manifest::read_session(&manifest, "sess-1")
            .unwrap()
            .expect("session");
        assert_eq!(session.chunks.len(), 1);
        assert_eq!(session.chunks[0].entry_id, id);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_tampered_meeting_entry_fails_aead() {
        let root = tmp();
        let entries = root.join("entries");
        let manifest = root.join("manifest");
        let id = seal_chunk(
            &root,
            &entries,
            &manifest,
            "sess-1",
            0,
            b"watch audio bytes",
        );

        let path = entries.join(&id);
        let mut blob = std::fs::read(&path).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0x01; // flip a byte inside the CTX tag
        std::fs::write(&path, &blob).unwrap();

        assert_eq!(
            protocol::share_import_blob::decode_share_import_blob(&KEY, &blob),
            Err(protocol::share_import_blob::ShareImportBlobError::CannotDecrypt)
        );
        // A different device key cannot open it either (non-distinguishing).
        let other = [0x11u8; 32];
        assert_eq!(
            protocol::share_import_blob::decode_share_import_blob(&other, &blob),
            Err(protocol::share_import_blob::ShareImportBlobError::CannotDecrypt)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_over_cap_chunk_is_refused_not_truncated() {
        let root = tmp();
        let entries = root.join("entries");
        let manifest = root.join("manifest");
        let big = vec![0x61u8; MAX_SHARE_IMPORT_PLAINTEXT_LEN + 1];
        let src = root.join("big");
        std::fs::write(&src, &big).unwrap();

        assert_eq!(
            seal_meeting_chunk_from_file(&entries, &manifest, &KEY, "sess-1", 0, 1, &src),
            Err(CaptureError::ChunkTooLarge)
        );
        // The source is left in place (the receiver can retry with a smaller
        // chunk), and nothing was sealed or recorded.
        assert!(src.exists());
        assert_eq!(queue::list_files(&entries).len(), 0, "nothing sealed");
        assert!(meeting_manifest::read_session(&manifest, "sess-1")
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A duplicate `(session_id, chunk_index)` must not double-count: the
    /// session keeps one entry, the just-sealed redundant blob is removed, and
    /// the record survives a reload from disk unchanged.
    #[test]
    fn a_duplicate_chunk_does_not_double_count_and_survives_reload() {
        let root = tmp();
        let entries = root.join("entries");
        let manifest = root.join("manifest");
        let first = seal_chunk(&root, &entries, &manifest, "sess-1", 0, b"first delivery");
        // A second delivery of chunk 0 (e.g. the watch retried the transfer).
        let dup_src = unique_src(&root);
        std::fs::write(&dup_src, b"second delivery").unwrap();
        let second = seal_meeting_chunk_from_file(
            &entries,
            &manifest,
            &KEY,
            "sess-1",
            0,
            1_700_000_000_000,
            &dup_src,
        )
        .unwrap();
        assert_eq!(second, None, "duplicate reports 'not newly added'");

        let reloaded = meeting_manifest::read_session(&manifest, "sess-1")
            .unwrap()
            .expect("persisted");
        assert_eq!(reloaded.chunks.len(), 1, "one entry, not two");
        assert_eq!(reloaded.chunks[0].entry_id, first, "the original is kept");
        assert_eq!(
            queue::list_files(&entries).len(),
            1,
            "the redundant blob was removed, not orphaned"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Two sessions in one queue stay isolated: appending to one never touches
    /// the other's record, and deleting one leaves the other's entry intact.
    #[test]
    fn meeting_sessions_are_isolated_per_session() {
        let root = tmp();
        let entries = root.join("entries");
        let manifest = root.join("manifest");
        let a = seal_chunk(&root, &entries, &manifest, "sess-a", 0, b"a0");
        let _a1 = seal_chunk(&root, &entries, &manifest, "sess-a", 1, b"a1");
        let b = seal_chunk(&root, &entries, &manifest, "sess-b", 0, b"b0");

        let sa = meeting_manifest::read_session(&manifest, "sess-a")
            .unwrap()
            .unwrap();
        assert_eq!(sa.chunks.len(), 2);
        let sb = meeting_manifest::read_session(&manifest, "sess-b")
            .unwrap()
            .unwrap();
        assert_eq!(sb.chunks.len(), 1);
        assert_eq!(sb.chunks[0].entry_id, b);

        meeting_manifest::delete_session(&manifest, "sess-a").unwrap();
        assert!(meeting_manifest::read_session(&manifest, "sess-a")
            .unwrap()
            .is_none());
        let sb = meeting_manifest::read_session(&manifest, "sess-b")
            .unwrap()
            .unwrap();
        assert_eq!(sb.chunks[0].entry_id, b, "sess-b untouched");
        assert!(entries.join(&a).exists() && entries.join(&b).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A source that is empty is dropped (a zero-length chunk can never be
    /// audio), leaving no entry and no manifest record.
    #[test]
    fn an_empty_chunk_is_dropped() {
        let root = tmp();
        let entries = root.join("entries");
        let manifest = root.join("manifest");
        let src = root.join("empty");
        std::fs::write(&src, b"").unwrap();
        assert_eq!(
            seal_meeting_chunk_from_file(&entries, &manifest, &KEY, "sess-1", 0, 1, &src).unwrap(),
            None
        );
        assert_eq!(queue::list_files(&entries).len(), 0);
        assert!(meeting_manifest::read_session(&manifest, "sess-1")
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// An invalid session id is refused, and the entry sealed for it is removed
    /// rather than orphaned.
    #[test]
    fn an_invalid_session_id_leaves_no_orphan_entry() {
        let root = tmp();
        let entries = root.join("entries");
        let manifest = root.join("manifest");
        let src = root.join("src");
        std::fs::write(&src, b"audio").unwrap();
        assert_eq!(
            seal_meeting_chunk_from_file(&entries, &manifest, &KEY, "../../escape", 0, 1, &src),
            Err(CaptureError::Backend)
        );
        assert_eq!(queue::list_files(&entries).len(), 0, "no orphan entry");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── meeting drain cores (myne-md/myne#812 task 3) ──────────────────────

    #[test]
    fn missing_indices_report_a_hole_and_a_lost_first_chunk() {
        // Interior hole: {0,2} is missing 1.
        assert_eq!(missing_chunk_indices(&[0, 2]), vec![1]);
        // A lost FIRST chunk is a gap too (indices start at 0).
        assert_eq!(missing_chunk_indices(&[1, 2]), vec![0]);
        // Contiguous → no gap.
        assert!(missing_chunk_indices(&[0, 1, 2]).is_empty());
        // A singleton at 4 means chunks 0..=3 never arrived: they are holes.
        assert_eq!(missing_chunk_indices(&[4]), vec![0, 1, 2, 3]);
        assert!(missing_chunk_indices(&[]).is_empty());
    }

    /// A restored entry decodes to the exact bytes that were sealed, and a
    /// foreign entry is refused (`None`) rather than erroring the drain.
    #[test]
    fn a_sealed_entry_reads_back_or_is_a_hole() {
        let root = tmp();
        let entries = root.join("entries");
        let manifest = root.join("manifest");
        let audio = b"watch meeting audio chunk";
        let id = seal_chunk(&root, &entries, &manifest, "sess-1", 0, audio);

        let back = read_validated_entry(&entries, &KEY, &id).expect("opens");
        assert_eq!(&back[..], audio, "the sealed bytes round-trip");

        // Wrong key → undecryptable → a hole, never a panic.
        let other = [0x11u8; 32];
        assert!(read_validated_entry(&entries, &other, &id).is_none());
        // Not a 32-hex id → refused before any read.
        assert!(read_validated_entry(&entries, &KEY, "../escape").is_none());
        // Absent id → a hole.
        assert!(read_validated_entry(&entries, &KEY, &"f".repeat(32)).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Acknowledge deletes the session's sealed entries AND its manifest record,
    /// leaves a sibling session untouched, and is idempotent.
    #[test]
    fn ack_deletes_entries_and_record_for_one_session_only() {
        let root = tmp();
        let entries = root.join("entries");
        let manifest = root.join("manifest");
        let a0 = seal_chunk(&root, &entries, &manifest, "sess-a", 0, b"a0");
        let a1 = seal_chunk(&root, &entries, &manifest, "sess-a", 1, b"a1");
        let b0 = seal_chunk(&root, &entries, &manifest, "sess-b", 0, b"b0");

        ack_meeting_session_in_dirs(&entries, &manifest, "sess-a").unwrap();
        assert!(!entries.join(&a0).exists());
        assert!(!entries.join(&a1).exists());
        assert!(entries.join(&b0).exists(), "sess-b entries survive");
        assert!(meeting_manifest::read_session(&manifest, "sess-a")
            .unwrap()
            .is_none());
        assert_eq!(
            meeting_manifest::read_session(&manifest, "sess-b")
                .unwrap()
                .unwrap()
                .chunks
                .len(),
            1
        );

        // Idempotent: acking again is a successful no-op.
        ack_meeting_session_in_dirs(&entries, &manifest, "sess-a").unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A chunk whose entry is missing from disk is a hole in the session and the
    /// drain must still be able to ack the rest. This exercises the read half
    /// without an `AppHandle`: the manifest still names both, one file is gone.
    #[test]
    fn a_missing_entry_is_a_hole_and_still_acks() {
        let root = tmp();
        let entries = root.join("entries");
        let manifest = root.join("manifest");
        let _a0 = seal_chunk(&root, &entries, &manifest, "sess-a", 0, b"a0");
        let a1 = seal_chunk(&root, &entries, &manifest, "sess-a", 1, b"a1");
        // Simulate a lost delivery: the manifest still names chunk 1's entry,
        // but the file is gone.
        std::fs::remove_file(entries.join(&a1)).unwrap();

        assert!(read_validated_entry(&entries, &KEY, &a1).is_none());
        ack_meeting_session_in_dirs(&entries, &manifest, "sess-a").unwrap();
        assert!(meeting_manifest::read_session(&manifest, "sess-a")
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
