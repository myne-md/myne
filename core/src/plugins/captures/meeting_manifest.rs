// SPDX-License-Identifier: AGPL-3.0
//! Device-local **pending-meeting manifest** — the grouping half of the Apple
//! Watch meeting-capture lane (myne-md/myne#812).
//!
//! The phone seals each arrived watch audio chunk *on arrival* under the same
//! device-local `wrap_key` the pending-capture queue uses ([`super::device_key`],
//! § 9.18.2), into a device-local **entry** (see
//! [`super::commands::seal_meeting_chunk_from_file`]). This module is the small
//! index that sits *beside* those sealed entries and records **which entries
//! belong to which meeting session, in which order, and when the session
//! started**:
//!
//! ```text
//! <app_data_dir>/pending-captures/meetings/
//! ├── entries/<entry-id-hex>        sealed audio chunks (opaque AEAD blobs)
//! └── manifest/<session-id>.json    one JSON record per session
//! ```
//!
//! It lives in the capture queue's own directory family (`pending-captures/`),
//! reuses its device key and its 32-hex filename convention, and is deleted per
//! session once the meeting has drained into a note. Like the queue itself it is
//! **device-global, never synced and never backed up** (`sync-protocol.md`
//! Class 3): it is created while the vault is locked and drains into whichever
//! vault unlocks first.
//!
//! ## Why this store carries NO § 10.3 magic
//!
//! The § 10.3 registry governs on-disk **content** (vault blobs, and the
//! device-local *secret-bearing* families such as `MYK1`/`MYF1`, whose framed
//! bytes must travel byte-stably and be versioned). This manifest is neither:
//! it is a plain index holding **routing metadata only** — an opaque session id,
//! a start timestamp, and `(chunk_index → entry_id)` pairs — never audio and
//! never vault content. The audio is inside the AEAD-sealed entries it points
//! at; this file gets a magic only when the bytes on disk have to mean something
//! to another implementation, and no second implementation ever reads this file
//! (it is not synced, not backed up, and not exported). A magic here would
//! allocate a § 10.3 family for a file nothing else consumes — exactly the
//! "quantity of magic" the registry's discipline is meant to avoid. It is
//! protected at rest the same way the plaintext `staging/` carve-out is: by the
//! OS Data Protection on the app's private container.
//!
//! ## Idempotency
//!
//! [`append_chunk`] is idempotent on `(session_id, chunk_index)`: a duplicate
//! transfer of the same chunk (the receiver re-delivering, the watch retrying)
//! records nothing new and reports "not added", so a chunk can never be counted
//! twice. That is what lets the drain treat the manifest's chunk list as the
//! session's true contents.

use serde::{Deserialize, Serialize};
use std::path::Path;

use super::error::CaptureError;
use super::queue;
use crate::io_failure_kind::from_io_error_kind;

/// Longest accepted `session_id` (a watch-generated opaque token). Bounded so a
/// hostile / malformed id cannot become a filesystem name of arbitrary length.
pub const MAX_SESSION_ID_LEN: usize = 64;

/// One sealed chunk recorded against its session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MeetingChunk {
    /// The wire-supplied chunk index (the watch's ordering position).
    pub chunk_index: u32,
    /// The 32-char hex id of the sealed entry in `entries/` — pass to the ack /
    /// drain path.
    pub entry_id: String,
}

/// One pending meeting session: its id, when it started (ms since the Unix
/// epoch, the wire's `started_at`), and its chunks in [`chunk_index`] order.
///
/// [`chunk_index`]: MeetingChunk::chunk_index
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MeetingSession {
    /// The opaque watch-supplied session id (also the manifest filename stem).
    pub session_id: String,
    /// Session start, milliseconds since the Unix epoch (the wire `started_at`).
    pub started_at: u64,
    /// The session's sealed chunks, ascending by `chunk_index`.
    pub chunks: Vec<MeetingChunk>,
    /// The vault note this session already drained into, once one exists
    /// (myne-md/myne#812 review). Recorded so a later drain that resolves a
    /// previously-retryable chunk APPENDS to that note rather than creating a
    /// second one — one import hiccup must not fragment a meeting into two
    /// disconnected notes. `None` until the first successful note creation.
    /// `#[serde(default)]` so a record written before this field existed still
    /// parses.
    #[serde(default)]
    pub note_id: Option<String>,
}

/// Is `s` a safe manifest-stem session id? Non-empty, at most
/// [`MAX_SESSION_ID_LEN`] bytes, ASCII alphanumerics plus `-`/`_` only.
///
/// The allowlist is the path-traversal guard: a session id becomes a filename
/// directly, so anything that could name a parent directory (`.`, `/`, `\`, a
/// path separator) is refused by construction rather than escaped.
pub fn is_session_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_SESSION_ID_LEN
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn manifest_path(
    manifest_dir: &Path,
    session_id: &str,
) -> Result<std::path::PathBuf, CaptureError> {
    if !is_session_id(session_id) {
        return Err(CaptureError::Backend);
    }
    Ok(manifest_dir.join(format!("{session_id}.json")))
}

fn io(e: std::io::Error) -> CaptureError {
    CaptureError::Io(from_io_error_kind(e.kind()))
}

/// Read one session record. `Ok(None)` when the session has no manifest yet (or
/// was already deleted). A file that cannot be parsed is a genuine backend
/// failure (it was written atomically by this module).
pub fn read_session(
    manifest_dir: &Path,
    session_id: &str,
) -> Result<Option<MeetingSession>, CaptureError> {
    let path = manifest_path(manifest_dir, session_id)?;
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(e)),
    };
    let mut session: MeetingSession =
        serde_json::from_slice(&bytes).map_err(|_| CaptureError::Backend)?;
    session.chunks.sort_by_key(|c| c.chunk_index);
    Ok(Some(session))
}

/// Append one sealed chunk to its session, creating the record on first append.
///
/// Idempotent on `(session_id, chunk_index)`: returns `Ok(false)` when a chunk
/// with that index is already recorded (the entry id already present is kept),
/// and `Ok(true)` when the chunk was newly added. `started_at` is only used when
/// the record is created; a later append cannot move the original start time.
pub fn append_chunk(
    manifest_dir: &Path,
    session_id: &str,
    started_at: u64,
    chunk_index: u32,
    entry_id: &str,
) -> Result<bool, CaptureError> {
    // An entry id must be the queue's 32-hex shape — a manifest pointing at
    // anything else could never drain.
    if !queue::is_capture_id(entry_id) {
        return Err(CaptureError::Backend);
    }
    let path = manifest_path(manifest_dir, session_id)?;
    let mut session = match read_session(manifest_dir, session_id)? {
        Some(s) => s,
        None => MeetingSession {
            session_id: session_id.to_string(),
            started_at,
            chunks: Vec::new(),
            note_id: None,
        },
    };
    if session.chunks.iter().any(|c| c.chunk_index == chunk_index) {
        return Ok(false);
    }
    session.chunks.push(MeetingChunk {
        chunk_index,
        entry_id: entry_id.to_string(),
    });
    session.chunks.sort_by_key(|c| c.chunk_index);

    queue::ensure_dir(manifest_dir)?;
    let encoded = serde_json::to_vec(&session).map_err(|_| CaptureError::Backend)?;
    crate::atomic_write::atomic_write_private(&path, &encoded, true).map_err(io)?;
    Ok(true)
}

/// Record the vault note a session drained into, so a later re-drain appends to
/// it instead of creating a second note (myne-md/myne#812 review). A no-op when
/// the session record is already gone (fully acked) — there is nothing to append
/// to, and the caller is mid-ack anyway.
pub fn set_note_id(
    manifest_dir: &Path,
    session_id: &str,
    note_id: &str,
) -> Result<(), CaptureError> {
    let path = manifest_path(manifest_dir, session_id)?;
    let Some(mut session) = read_session(manifest_dir, session_id)? else {
        return Ok(());
    };
    session.note_id = Some(note_id.to_string());
    let encoded = serde_json::to_vec(&session).map_err(|_| CaptureError::Backend)?;
    crate::atomic_write::atomic_write_private(&path, &encoded, true).map_err(io)?;
    Ok(())
}

/// List every readable session record. Best-effort: a file whose name is not a
/// valid session id is skipped, and a record that cannot be parsed is skipped
/// **and left on disk** (one damaged manifest must not wedge the whole drain —
/// unlike [`read_session`], which surfaces it).
pub fn list_sessions(manifest_dir: &Path) -> Result<Vec<MeetingSession>, CaptureError> {
    let mut out = Vec::new();
    for path in queue::list_files(manifest_dir) {
        let Some(stem) = path.file_stem().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_session_id(stem) {
            continue;
        }
        if let Ok(Some(session)) = read_session(manifest_dir, stem) {
            out.push(session);
        }
    }
    // Deterministic order (oldest first) so a drain walks sessions the same way
    // on every run.
    out.sort_by_key(|s| (s.started_at, s.session_id.clone()));
    Ok(out)
}

/// Delete one session's manifest record. Its sealed entries are the caller's
/// responsibility (they are keyed by entry id, not by session). An absent
/// record is a successful delete (idempotent).
pub fn delete_session(manifest_dir: &Path, session_id: &str) -> Result<(), CaptureError> {
    let path = manifest_path(manifest_dir, session_id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let mut sfx = [0u8; 8];
        getrandom::getrandom(&mut sfx).unwrap();
        let d =
            std::env::temp_dir().join(format!("myne-meeting-manifest-{}", queue::hex_lower(&sfx)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn entry(n: u8) -> String {
        // 32-hex entry id, distinct per index.
        queue::hex_lower(&[n; 16])
    }

    #[test]
    fn appends_read_back_in_chunk_order_and_survive_a_reload() {
        let dir = tmp();
        // Append out of order to prove the reader orders, not the writer.
        assert!(append_chunk(&dir, "sess-a", 1_700_000_000_000, 2, &entry(2)).unwrap());
        assert!(append_chunk(&dir, "sess-a", 1_700_000_000_000, 0, &entry(0)).unwrap());
        assert!(append_chunk(&dir, "sess-a", 1_700_000_000_000, 1, &entry(1)).unwrap());

        let s = read_session(&dir, "sess-a").unwrap().expect("session");
        assert_eq!(s.started_at, 1_700_000_000_000);
        assert_eq!(
            s.chunks.iter().map(|c| c.chunk_index).collect::<Vec<_>>(),
            vec![0, 1, 2],
            "entries read back in chunk order"
        );

        // A fresh read from disk (no in-memory state) sees the same record.
        let reloaded = read_session(&dir, "sess-a").unwrap().expect("persisted");
        assert_eq!(reloaded, s, "record survives a reload from disk");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_session_and_chunk_did_not_double_count() {
        let dir = tmp();
        assert!(append_chunk(&dir, "sess-a", 10, 0, &entry(0)).unwrap());
        // Same (session_id, chunk_index) → recorded already, no growth.
        assert!(!append_chunk(&dir, "sess-a", 10, 0, &entry(9)).unwrap());
        let s = read_session(&dir, "sess-a").unwrap().expect("session");
        assert_eq!(s.chunks.len(), 1, "duplicate chunk not counted twice");
        assert_eq!(s.chunks[0].entry_id, entry(0), "the original entry is kept");
        // The original start time is not overwritten by a later append either.
        assert_eq!(s.started_at, 10);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_id_is_recorded_and_survives_a_reload() {
        let dir = tmp();
        append_chunk(&dir, "sess-a", 1, 0, &entry(0)).unwrap();
        assert!(
            read_session(&dir, "sess-a")
                .unwrap()
                .unwrap()
                .note_id
                .is_none(),
            "no note id before the note exists"
        );

        set_note_id(&dir, "sess-a", "n1").unwrap();
        assert_eq!(
            read_session(&dir, "sess-a")
                .unwrap()
                .unwrap()
                .note_id
                .as_deref(),
            Some("n1"),
            "note id recorded"
        );
        // A later chunk append does not clear it.
        append_chunk(&dir, "sess-a", 1, 1, &entry(1)).unwrap();
        assert_eq!(
            read_session(&dir, "sess-a")
                .unwrap()
                .unwrap()
                .note_id
                .as_deref(),
            Some("n1"),
            "note id survives a chunk append"
        );
        // A no-op on an absent session (already acked).
        set_note_id(&dir, "sess-gone", "n2").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_one_session_leaves_the_other_intact() {
        let dir = tmp();
        append_chunk(&dir, "sess-a", 1, 0, &entry(0)).unwrap();
        append_chunk(&dir, "sess-b", 2, 0, &entry(1)).unwrap();

        delete_session(&dir, "sess-a").unwrap();
        assert!(read_session(&dir, "sess-a").unwrap().is_none(), "deleted");
        let b = read_session(&dir, "sess-b").unwrap().expect("survives");
        assert_eq!(b.chunks.len(), 1);

        // Deleting an absent session is a successful no-op.
        delete_session(&dir, "sess-a").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_is_device_local_files_never_a_magic_blob() {
        // The record is a plain JSON file, not an AEAD-framed §10.3 blob: it
        // begins with `{` and carries no magic bytes.
        let dir = tmp();
        append_chunk(&dir, "sess-a", 5, 0, &entry(0)).unwrap();
        let raw = std::fs::read(dir.join("sess-a.json")).unwrap();
        assert_eq!(raw.first(), Some(&b'{'), "plain JSON, no blob magic");
        assert!(!raw.starts_with(b"MY"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_session_id_that_could_traverse() {
        let dir = tmp();
        let bad = append_chunk(&dir, "../escape", 1, 0, &entry(0));
        assert_eq!(bad, Err(CaptureError::Backend));
        assert_eq!(
            read_session(&dir, "a/b").unwrap_err(),
            CaptureError::Backend
        );
        assert_eq!(delete_session(&dir, "").unwrap_err(), CaptureError::Backend);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_an_entry_id_that_is_not_the_queue_hex_shape() {
        let dir = tmp();
        assert_eq!(
            append_chunk(&dir, "sess-a", 1, 0, "not-hex"),
            Err(CaptureError::Backend)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
