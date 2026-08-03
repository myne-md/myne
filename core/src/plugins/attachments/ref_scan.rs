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

use crate::io_failure_kind::IoFailureKind;
use crate::vault_io::VaultIo;
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
    Io(IoFailureKind),
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
/// notes" badge but unsafe for a destructive op.
///
/// **Async because the storage seam is** (phase3-web-client task 44). It used
/// to be a synchronous function the callers hosted inside one `run_blocking`;
/// the reads now go through [`VaultIo`], whose native arm dispatches its own
/// blocking. The fail-closed contract above is byte-identical — only the error
/// type narrowed from `std::io::ErrorKind` to the closed [`IoFailureKind`],
/// which is what the two callers' IPC enums carried anyway.
///
/// **The per-note `decode_note` stays inline rather than getting its own
/// dispatch**, which is a deliberate departure from `note_read`'s
/// read-through-the-seam-then-`run_blocking`-the-decode shape. There the choice
/// is one dispatch for one note; here it would be one dispatch PER note across a
/// whole-vault walk, on a path whose cost is already dominated by N reads. The
/// alternative — read everything first, decode in a single dispatch — would hold
/// the entire vault's ciphertext in RAM at once (a `.myn` caps at 16 MiB), which
/// is a worse trade than a few hundred milliseconds of executor time on a
/// user-initiated, dialog-blocking operation. On wasm it is moot: `run_blocking`
/// runs its closure inline there anyway.
pub async fn collect_referenced_attachment_ids(
    io: &dyn VaultIo,
    notes_dir: &std::path::Path,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
) -> Result<std::collections::HashSet<String>, ReferencedScanError> {
    let mut referenced = collect_from_notes(io, notes_dir, items_key, items_key_id).await?;

    // #257: snapshots are a SECOND corpus that keeps an attachment alive.
    //
    // The scan walked `notes/` only, and its result is the sole survival
    // predicate for an irreversible unlink — so an attachment embedded in a
    // restorable snapshot but no longer in the live note was classified
    // "not used in any note" and erased. `snapshot_restore` then brought the
    // old body back verbatim, embed span and all, pointing at a blob that no
    // longer exists.
    //
    // `snapshots/` sits beside `notes/` under the vault root. Deriving it here
    // rather than taking a second parameter keeps both call sites — the preview
    // list and the confirmed sweep — on the same corpus by construction; a
    // sweep that consulted a wider corpus than the list it was shown from would
    // be a different bug of the same family.
    let snapshots_dir = notes_dir.parent().map(|root| root.join("snapshots"));
    if let Some(dir) = snapshots_dir {
        collect_from_snapshots(io, &dir, items_key, items_key_id, &mut referenced).await?;
    }

    Ok(referenced)
}

/// The `notes/` half of [`collect_referenced_attachment_ids`].
async fn collect_from_notes(
    io: &dyn VaultIo,
    notes_dir: &std::path::Path,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
) -> Result<std::collections::HashSet<String>, ReferencedScanError> {
    let ids = match io.read_dir(notes_dir).await {
        // The classification half is shared verbatim with the desktop
        // enumerator, so the skip/warn behaviour cannot drift between clients.
        Ok(entries) => crate::plugins::notes::commands::note_ids_from_entries(&entries),
        // An absent notes/ dir means no notes → no references.
        Err(IoFailureKind::NotFound) => return Ok(std::collections::HashSet::new()),
        Err(kind) => return Err(ReferencedScanError::Io(kind)),
    };
    let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();
    for note_id in ids {
        let note_uuid_bytes = *note_id.as_uuid().as_bytes();
        let path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
        let blob = match io.read(&path).await {
            Ok(b) => b,
            // Deleted between enumerate + read (single-writer TOCTOU): the
            // note is gone, so it references nothing. Benign skip.
            Err(IoFailureKind::NotFound) => continue,
            Err(kind) => return Err(ReferencedScanError::Io(kind)),
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

/// The `snapshots/` half of [`collect_referenced_attachment_ids`] (#257).
///
/// Same fail-closed posture as the notes walk, for the same reason: this feeds
/// an irreversible unlink, so a snapshot we could not read must abort the scan
/// rather than under-count references. The one benign skip is identical too —
/// a file that vanished between enumerate and read references nothing.
///
/// A filename that does not parse as `<note-uuid>__<snap-uuid>.myn` is skipped
/// rather than fatal: the enumerator is a directory listing, and a stranger's
/// file in `snapshots/` is not a snapshot this vault wrote. That mirrors
/// `note_ids_from_entries`' classification on the notes side.
async fn collect_from_snapshots(
    io: &dyn VaultIo,
    snapshots_dir: &std::path::Path,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
    referenced: &mut std::collections::HashSet<String>,
) -> Result<(), ReferencedScanError> {
    let entries = match io.read_dir(snapshots_dir).await {
        Ok(entries) => entries,
        // No snapshots dir → no snapshot references. A vault that has never
        // captured one is the common case on a fresh install.
        Err(IoFailureKind::NotFound) => return Ok(()),
        Err(kind) => return Err(ReferencedScanError::Io(kind)),
    };

    for entry in entries {
        if entry.is_dir {
            continue;
        }
        let Some((note_uuid, _snap_uuid)) =
            crate::snapshot_store::parse_snapshot_filename(&entry.name)
        else {
            continue;
        };
        // The AAD binds the NOTE's uuid, not the snapshot's — a snapshot is a
        // prior revision of that note, sealed under the same binding, which is
        // what lets `decode_note` read it unchanged.
        let Ok(parsed) = uuid::Uuid::parse_str(&note_uuid) else {
            continue;
        };
        let note_uuid_bytes = *parsed.as_bytes();
        let path = snapshots_dir.join(&entry.name);
        let blob = match io.read(&path).await {
            Ok(b) => b,
            Err(IoFailureKind::NotFound) => continue,
            Err(kind) => return Err(ReferencedScanError::Io(kind)),
        };
        let decrypted = decode_note(&blob, &note_uuid_bytes, items_key, items_key_id)
            .map_err(|_: DecryptError| ReferencedScanError::CannotDecrypt)?;
        let plaintext = std::str::from_utf8(decrypted.plaintext())
            .map_err(|_| ReferencedScanError::InvalidPlaintextEncoding)?;
        for span in crate::plugins::attachments::reconcile::extract_att_embed_spans(plaintext) {
            referenced.insert(span.id.to_string());
        }
        drop(decrypted);
    }
    Ok(())
}

/// Every note's attachment references, as `(note_id, [attachment_id])` pairs.
///
/// The per-note twin of [`collect_referenced_attachment_ids`], which flattens
/// the same walk into a bare set because its caller (the GC) only needs "is
/// this attachment referenced at all". The reference GRAPH needs the mapping:
/// "used in N notes" and the delete warning's note list are both answers about
/// which notes, not how many attachments.
///
/// **Why this exists (MYND — attachment refs read 0 after every unlock).** The
/// graph is RAM-only and zeroized on lock, and it was only ever populated by
/// `attachment_refs_apply` as notes are saved. `reconcile.rs` says so in its own
/// header — "the live note lifecycle + the unlock-time full rebuild is NOT wired
/// here" — so after every app start each attachment reported "used in 0 notes"
/// until the referencing note happened to be re-saved. Persisted indices
/// (`vault.indices`, MYI1) survive a lock; this graph does not, so it has to be
/// rebuilt, and rebuilding needs the mapping this returns.
///
/// Fail-closed exactly like its twin: any read or decrypt failure aborts with an
/// error rather than returning a partial map, because a partial graph would
/// under-report references — and under-reporting is what makes a delete warning
/// lie about which notes it will break.
///
/// A note with no attachment embeds is omitted rather than emitted empty: the
/// caller applies these to a graph keyed by note, and an absent note is already
/// "references nothing".
pub async fn collect_note_attachment_refs(
    io: &dyn VaultIo,
    notes_dir: &std::path::Path,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
) -> Result<Vec<(String, Vec<String>)>, ReferencedScanError> {
    let ids = match io.read_dir(notes_dir).await {
        Ok(entries) => crate::plugins::notes::commands::note_ids_from_entries(&entries),
        Err(IoFailureKind::NotFound) => return Ok(Vec::new()),
        Err(kind) => return Err(ReferencedScanError::Io(kind)),
    };
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for note_id in ids {
        let note_uuid_bytes = *note_id.as_uuid().as_bytes();
        let path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
        let blob = match io.read(&path).await {
            Ok(b) => b,
            // Deleted between enumerate + read (single-writer TOCTOU) — it
            // references nothing. Benign skip, same as the twin.
            Err(IoFailureKind::NotFound) => continue,
            Err(kind) => return Err(ReferencedScanError::Io(kind)),
        };
        let decrypted = decode_note(&blob, &note_uuid_bytes, items_key, items_key_id)
            .map_err(|_: DecryptError| ReferencedScanError::CannotDecrypt)?;
        let plaintext = std::str::from_utf8(decrypted.plaintext())
            .map_err(|_| ReferencedScanError::InvalidPlaintextEncoding)?;
        let mut refs: Vec<String> = Vec::new();
        for span in crate::plugins::attachments::reconcile::extract_att_embed_spans(plaintext) {
            let id = span.id.to_string();
            // One note embedding the same attachment twice is one reference.
            if !refs.contains(&id) {
                refs.push(id);
            }
        }
        if !refs.is_empty() {
            out.push((note_id.as_uuid().to_string(), refs));
        }
        // Same minimize-the-window discipline as the twin: drop the decrypted
        // handle so its Zeroizing plaintext wipes before the next read.
        drop(decrypted);
    }
    Ok(out)
}
