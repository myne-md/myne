// SPDX-License-Identifier: AGPL-3.0
//! Authoritative attachment-reference scan for cleanup (MYND-171).
//!
//! Extracted from the desktop `notes::desktop_commands` into `myne-core` so the
//! shared `attachment_unused_list` / `attachment_clean_unused` command cores can
//! compute the referenced set on both desktop and mobile. Depends only on
//! `protocol::decode_note`, the core note enumerator
//! ([`crate::plugins::notes::commands::enumerate_notes_dir`]), and the shared
//! embed tokenizer ([`crate::plugins::attachments::reconcile::extract_att_embed_spans`]).
//!
//! See: `src-tauri/CLAUDE.md` "Secret-handling logging discipline".

use protocol::{decode_note, DecryptError};

/// Closed failure surface of [`collect_referenced_attachment_ids`]
/// (MYND-171). The attachments-cleanup commands (`attachment_unused_list` /
/// `attachment_clean_unused`) map each variant onto their own IPC error enum.
/// DENY-list clean — no path string, no `note_id` correlation tag, no key
/// material; only the closed io kind or a bare cause name.
#[derive(Debug)]
pub enum ReferencedScanError {
    /// `read_dir` of the notes directory, or a per-note `read` other than
    /// `NotFound`, failed. Carries the closed io kind.
    Io(std::io::ErrorKind),
    /// A note blob failed to AEAD-decrypt (`decode_note` → `CannotDecrypt`).
    /// **Fail-closed**: the scan cannot prove the note's references, so the
    /// caller MUST refuse to compute the unused set rather than under-count.
    CannotDecrypt,
    /// A decrypted note's plaintext was not valid UTF-8 — same fail-closed
    /// posture as `CannotDecrypt`.
    InvalidPlaintextEncoding,
}

/// Collect the set of attachment-ids referenced by ANY note in the vault —
/// the **authoritative** reference reconcile behind attachment cleanup
/// (MYND-171). Enumerates every `.myn` in `notes_dir`, AEAD-decrypts each,
/// and unions the canonical form-C embed ids
/// ([`crate::plugins::attachments::reconcile::extract_att_embed_spans`]).
/// Includes trashed + template notes: a trashed note is recoverable and a
/// template is a live note, so either's embeds keep an attachment
/// referenced — mirroring the reconcile graph's trash posture
/// (`attachments/reconcile_commands.rs`).
///
/// **Fail-closed (load-bearing for cleanup safety, MYND-171 Q1/Q2):** ANY
/// per-note read / decode / UTF-8 failure aborts the whole scan with an
/// error. The caller MUST treat a failed scan as "cannot determine the
/// unused set" and refuse cleanup — silently skipping an undecryptable note
/// would under-count references and could erase an attachment that note
/// embeds (irreversible: cleanup is cryptographic erase). A note deleted
/// mid-scan (`NotFound` on read) is the one benign skip — a gone note
/// references nothing — and an absent `notes/` dir yields the empty set.
///
/// Deliberately does NOT consult the best-effort in-RAM reconcile graph:
/// that graph's swallowed-error self-heal posture is fine for a "used in N
/// notes" badge but unsafe for a destructive op. Synchronous; the caller
/// hosts it in `spawn_blocking` (it decrypts every note).
pub fn collect_referenced_attachment_ids(
    notes_dir: &std::path::Path,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
) -> Result<std::collections::HashSet<String>, ReferencedScanError> {
    let ids = match crate::plugins::notes::commands::enumerate_notes_dir(notes_dir) {
        Ok(ids) => ids,
        // An absent notes/ dir means no notes → no references.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(std::collections::HashSet::new())
        }
        Err(e) => return Err(ReferencedScanError::Io(e.kind())),
    };
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    for note_id in ids {
        let note_uuid_bytes = *note_id.as_uuid().as_bytes();
        let path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
        let blob = match std::fs::read(&path) {
            Ok(b) => b,
            // Deleted between enumerate + read (single-writer TOCTOU): the
            // note is gone, so it references nothing. Benign skip.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(ReferencedScanError::Io(e.kind())),
        };
        let decrypted = decode_note(&blob, &note_uuid_bytes, items_key, items_key_id)
            .map_err(|_: DecryptError| ReferencedScanError::CannotDecrypt)?;
        let plaintext = std::str::from_utf8(decrypted.plaintext())
            .map_err(|_| ReferencedScanError::InvalidPlaintextEncoding)?;
        for span in crate::plugins::attachments::reconcile::extract_att_embed_spans(plaintext) {
            referenced.insert(span.id.to_string());
        }
        // Minimize the non-Zeroized window: the spans (borrowing plaintext,
        // which borrows `decrypted`) are out of scope past the loop; drop the
        // decrypted handle so its Zeroizing plaintext wipes before the next
        // note's blob is read (the `note_read_with_dir` discipline).
        drop(decrypted);
    }
    Ok(referenced)
}
