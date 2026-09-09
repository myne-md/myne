// SPDX-License-Identifier: AGPL-3.0
//! Markdown ↔ single-`Text` Automerge bridge for the `NC05` CRDT note-type
//! (`automerge-sync-migration` epic, myne-md/myne#418 task 3; ASM-7).
//!
//! The **whole** note — YAML frontmatter *and* body, as one exact byte string —
//! is modelled as a single Automerge `Text` under the document root. That choice
//! is what preserves, **by construction**, the three v0.1 guarantees a note-body
//! format must not break:
//!
//! * the §6 C1 **byte-exact round-trip** — `decode_note(encode_note(md)) == md`
//!   for arbitrary markdown, because the document stores the string verbatim and
//!   `Text` reads it back unchanged;
//! * **unknown-frontmatter-field preservation** — the frontmatter is not parsed
//!   into structured CRDT fields, so nothing a future field could carry is lost;
//! * **plain-markdown portability** ("walk away with your files") — the decoded
//!   value *is* the note's markdown, no proprietary structure in between.
//!
//! A `kind: drawing` note (whose body is Excalidraw JSON, not prose) maps
//! identically — it is still one UTF-8 string in one `Text`.
//!
//! This module produces / consumes the **plaintext** Automerge `save()` bytes
//! only. Sealing those bytes into the `NC05` AEAD envelope is #418 task 2
//! (`protocol/`), and the client-side merge / CAS loop is #419 — neither is here.
//! Actor identity and change timestamps come from the [`crdt_doc`] seam (Myne's
//! CSPRNG + the `HostCtx` clock), never automerge's runtime defaults (ASM-3).
//!
//! [`crdt_doc`]: crate::plugins::sync::crdt_doc

use crate::host::HostCtx;
use crate::plugins::sync::crdt_doc::{commit_at_millis, doc_heads_hex, new_note_doc};
use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjId, ObjType, ReadDoc, ROOT};
use protocol::{decode_crdt_note_blob, encode_crdt_note_blob, ProtocolError};

// The host-free decode half of the NC05 bridge lives in `myne-format` so the
// `myne-decrypt` CLI can read an NC05 note without pulling this crate's host
// clock + actor CSPRNG. Re-exported here so the encode half below (and every
// existing `crate::plugins::notes::crdt::…` caller) keeps resolving.
pub use myne_format::notes::crdt_decode::{
    blob_magic, decode_note, decode_note_blob, is_nc05_blob, DecodeNoteBlobError,
    MalformedCrdtNote, NOTE_TEXT_KEY,
};

/// Encode a whole note (frontmatter + body, arbitrary UTF-8 markdown) into a
/// fresh Automerge document holding the exact string as one root `Text`, and
/// return the compacted `save()` bytes — the opaque plaintext #418 task 2 seals
/// into the `NC05` blob.
///
/// `actor` seeds the document's `ActorId` (from Myne's CSPRNG on the production
/// path — [`crate::plugins::sync::crdt_doc::fresh_actor_bytes`]); `host` supplies
/// the change timestamp. A `.myn` note is always valid UTF-8, so `markdown` is
/// `&str`.
pub fn encode_note(markdown: &str, actor: &[u8], host: &dyn HostCtx) -> Vec<u8> {
    encode_note_at_millis(markdown, actor, host.now_unix_millis())
}

/// Host-free [`encode_note`] — the caller pre-reads `now_unix_millis()` and
/// passes it. Exists so the whole-vault migration (#420) can re-encode a note
/// batch under one clock read without threading `&dyn HostCtx` through a
/// `'static` blocking closure (see [`crate::plugins::sync::crdt_doc::commit_at_millis`]).
pub fn encode_note_at_millis(markdown: &str, actor: &[u8], now_millis: u64) -> Vec<u8> {
    let mut doc = new_note_doc(actor);
    let text = doc
        .put_object(ROOT, NOTE_TEXT_KEY, ObjType::Text)
        .expect("root Text object");
    doc.splice_text(&text, 0, 0, markdown)
        .expect("seed note text");
    commit_at_millis(&mut doc, now_millis);
    doc.save()
}

/// Encode a whole note (markdown) into a sealed `NC05` blob: bridge it into a
/// single-`Text` Automerge document, `save()` it, and seal the opaque bytes
/// under the vault's `items_key` via protocol's `NC05` codec (item_key + nonces
/// drawn from `getrandom` inside the codec).
///
/// `actor` seeds the document's `ActorId` (device provenance, from Myne's
/// CSPRNG on the production path). This is the full write path #419 drives per
/// note.
pub fn encode_note_blob(
    markdown: &str,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
    note_uuid: &[u8; 16],
    actor: &[u8],
    host: &dyn HostCtx,
) -> Result<Vec<u8>, ProtocolError> {
    encode_note_blob_at_millis(
        markdown,
        items_key,
        items_key_id,
        note_uuid,
        actor,
        host.now_unix_millis(),
    )
}

/// Host-free [`encode_note_blob`] — the caller pre-reads the clock.
///
/// Exists for the whole-vault migration (myne-md/myne#434), whose crypto core
/// runs inside a `'static` [`crate::task::run_blocking`] closure that cannot
/// borrow `&dyn HostCtx`. One clock read covers the whole batch, which is also
/// the honest thing to record: every note of one migration is re-encoded at one
/// instant.
pub fn encode_note_blob_at_millis(
    markdown: &str,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
    note_uuid: &[u8; 16],
    actor: &[u8],
    now_millis: u64,
) -> Result<Vec<u8>, ProtocolError> {
    let save = encode_note_at_millis(markdown, actor, now_millis);
    encode_crdt_note_blob(items_key, items_key_id, note_uuid, &save)
}

/// Failure of an `NC05` edit or merge operation (both decode a source blob,
/// mutate the Automerge doc, and re-seal).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrdtNoteOpError {
    /// A source blob's AEAD envelope did not open.
    CannotDecrypt,
    /// A decrypted payload was not a valid single-`Text` Automerge document.
    Malformed,
    /// The resulting document exceeds the per-note cap.
    TooLarge,
    /// The CSPRNG was unavailable while re-sealing.
    Csprng,
    /// The requested revision id is not a change this document carries — a
    /// malformed hash, or one from a list the note has since diverged from.
    RevisionNotFound,
}

impl From<ProtocolError> for CrdtNoteOpError {
    fn from(e: ProtocolError) -> Self {
        match e {
            ProtocolError::PlaintextTooLarge => CrdtNoteOpError::TooLarge,
            ProtocolError::Csprng => CrdtNoteOpError::Csprng,
            _ => CrdtNoteOpError::Malformed,
        }
    }
}

/// The root single-`Text` object id of a loaded `NC05` note document.
fn note_text_id(doc: &AutoCommit) -> Result<ObjId, CrdtNoteOpError> {
    doc.get(ROOT, NOTE_TEXT_KEY)
        .map_err(|_| CrdtNoteOpError::Malformed)?
        .map(|(_, id)| id)
        .ok_or(CrdtNoteOpError::Malformed)
}

/// Apply a full-text edit to an existing `NC05` note **in place on its
/// Automerge document**, preserving change-graph ancestry (so a concurrent
/// device's edit still merges) — the update path, analogous to `MY01`'s
/// §6.3 `encode_update`. Loads the doc, replaces the single `Text` with
/// `new_markdown`, commits under the host clock, and re-seals a fresh `NC05`
/// blob. Returns the new blob and its heads (for `BlobSyncState`).
///
/// The whole-`Text` replace is the correctness-first shape: concurrent replaces
/// interleave (both survive, ASM-6/§10.1) rather than one clobbering the other;
/// a minimal-diff splice is a later optimization, not a correctness need.
pub fn encode_note_edit(
    existing_blob: &[u8],
    new_markdown: &str,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
    note_uuid: &[u8; 16],
    host: &dyn HostCtx,
) -> Result<CrdtNoteUpdate, CrdtNoteOpError> {
    encode_note_edit_at_millis(
        existing_blob,
        new_markdown,
        items_key,
        items_key_id,
        note_uuid,
        host.now_unix_millis(),
    )
}

/// Host-free [`encode_note_edit`] — the caller pre-reads `now_unix_millis()` and
/// passes it. The note-update command runs the automerge mutation inside a
/// `'static` [`crate::task::run_blocking`] closure that cannot borrow the host,
/// so it reads the clock first and calls this.
pub fn encode_note_edit_at_millis(
    existing_blob: &[u8],
    new_markdown: &str,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
    note_uuid: &[u8; 16],
    now_millis: u64,
) -> Result<CrdtNoteUpdate, CrdtNoteOpError> {
    let save = decode_crdt_note_blob(existing_blob, note_uuid, items_key, items_key_id)
        .map_err(|_| CrdtNoteOpError::CannotDecrypt)?;
    let mut doc = AutoCommit::load(&save).map_err(|_| CrdtNoteOpError::Malformed)?;
    let text = note_text_id(&doc)?;
    // `update_text` DIFFS the new full text against the current one and records
    // only the minimal splices. The obvious-looking alternative — a whole-body
    // `splice_text(0, len, new)` — records "delete every character, then insert
    // this entire string", and when two devices each do that from a shared base
    // both deletions AND both insertions survive the merge: the note comes back
    // containing itself twice (myne-md/myne#428). A full replace is not a
    // stronger form of an edit; it is a different edit, and it does not merge.
    doc.update_text(&text, new_markdown)
        .map_err(|_| CrdtNoteOpError::Malformed)?;
    commit_at_millis(&mut doc, now_millis);
    let heads = doc_heads_hex(&mut doc);
    let blob = encode_crdt_note_blob(items_key, items_key_id, note_uuid, &doc.save())?;
    Ok(CrdtNoteUpdate { blob, heads })
}

/// A re-sealed `NC05` blob plus the heads its `BlobSyncState` should record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrdtNoteUpdate {
    /// The freshly-sealed `NC05` blob (a new random `content_nonce`).
    pub blob: Vec<u8>,
    /// The document's heads after the operation (the ASM-5 convergence marker).
    pub heads: Vec<String>,
}

/// How a divergent pair of `NC05` revisions of the same note was resolved.
///
/// A note deletion is **not** expressed inside the CRDT: per `sync-protocol.md`
/// §11.1 it is a `deleted:`-marked new encrypted version, i.e. it lives in the
/// frontmatter the document merely *contains*. An edit, by contrast, is
/// expressed inside it. A text merge therefore reconciles a deletion and an edit
/// as two overlapping edits to one string, which is not a resolution rule at all
/// (myne-md/myne#431).
///
/// Measured, not theorised. With the gate below removed, a device deleting a
/// note (`deleted: 2026-08-11T09:00:00Z`) racing a device editing it
/// (`updated: 2026-08-11T09:30:00Z`) merges to a note carrying the edit **and**
/// `deleted: 2026-09-11T09:30:00Z` — a timestamp **neither device ever wrote**,
/// assembled character-wise from both. The interleave does not corrupt the field
/// into something a reader rejects; it fabricates a well-formed value. So the
/// managed frontmatter that carries deletion, trash and daily-note identity is
/// exactly the content a CRDT text merge must never be handed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrdtMergeResolution {
    /// Both revisions are live — the Automerge documents were merged (§10.1).
    Merged,
    /// The **remote** revision carries the tombstone and wins (remove-wins): the
    /// local edit is discarded and the remote blob is adopted verbatim.
    RemoteTombstoneWins,
    /// The **local** revision carries the tombstone and wins: the remote edit is
    /// discarded and the local blob stands.
    LocalTombstoneWins,
}

/// The result of merging two divergent `NC05` blobs of the same note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrdtNoteMerge {
    /// The winning `NC05` blob: the re-sealed merge, or — when a tombstone won —
    /// the winning side's bytes **verbatim** (re-sealing would churn the
    /// `content_nonce` for a revision neither side changed).
    pub blob: Vec<u8>,
    /// The winning document's heads (records into `BlobSyncState`).
    pub heads: Vec<String>,
    /// The winning markdown (for the editor + the "#422" changed-from-remote hint).
    pub text: String,
    /// Which rule produced the above — the caller pushes, adopts or hints
    /// differently per arm.
    pub resolution: CrdtMergeResolution,
}

/// The `deleted:` sync-tombstone marker of a decoded note, or `None` for a live
/// one. Value-strict through the one reader family the rest of the app uses
/// ([`fm_deleted_value_strict`]), so a user's own non-timestamp `deleted:` value
/// leaves the note live here exactly as it does everywhere else.
///
/// [`fm_deleted_value_strict`]: crate::plugins::notes::daily_match::fm_deleted_value_strict
fn deleted_marker(markdown: &str) -> Option<String> {
    let fm = crate::plugins::notes::title_extract::extract_title_slices(markdown.as_bytes())
        .frontmatter_bytes?;
    crate::plugins::notes::daily_match::fm_deleted_value_strict(fm)
}

/// Merge a `remote` `NC05` blob into the `local` one (both the same note): decode
/// both, `merge()` the Automerge documents (commutative + associative, drops no
/// edit — §10.1 by interleave), and re-seal. This is the download-merge-retry
/// core the orchestrator runs when a concurrent remote revision is seen, in
/// place of `MY01`'s keep-both. `merge()` requires shared ancestry, which the
/// sync flow guarantees (a note is created once and replicated, never
/// independently instantiated).
///
/// **Deletion is decided before the text merge, not by it** (`sync-protocol.md`
/// §11.1, myne-md/myne#431). If either side carries the `deleted:` tombstone the
/// documents are never merged: the tombstone wins outright (**remove-wins**),
/// the same rule §10.2.2 / §11.4 apply to the themes map and the attachments
/// catalog. Resurrecting a note the user permanently deleted is the worse of the
/// two failures — worse than losing a concurrent edit — and it is the one a text
/// merge produces, because the tombstone lives in the frontmatter rather than in
/// the CRDT.
///
/// The tie-break is a **symmetric total order over content** (`deleted:` value,
/// then text, then heads), so the two devices — which hold the same pair with
/// the labels swapped — pick the same winner without either one's "local" role
/// entering into it.
pub fn merge_crdt_note_blobs(
    local_blob: &[u8],
    remote_blob: &[u8],
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
    note_uuid: &[u8; 16],
) -> Result<CrdtNoteMerge, CrdtNoteOpError> {
    let local_save = decode_crdt_note_blob(local_blob, note_uuid, items_key, items_key_id)
        .map_err(|_| CrdtNoteOpError::CannotDecrypt)?;
    let remote_save = decode_crdt_note_blob(remote_blob, note_uuid, items_key, items_key_id)
        .map_err(|_| CrdtNoteOpError::CannotDecrypt)?;
    let mut local = AutoCommit::load(&local_save).map_err(|_| CrdtNoteOpError::Malformed)?;
    let mut remote = AutoCommit::load(&remote_save).map_err(|_| CrdtNoteOpError::Malformed)?;

    let local_text = doc_text(&local)?;
    let remote_text = doc_text(&remote)?;
    let local_tomb = deleted_marker(&local_text);
    let remote_tomb = deleted_marker(&remote_text);
    if local_tomb.is_some() || remote_tomb.is_some() {
        let local_heads = doc_heads_hex(&mut local);
        let remote_heads = doc_heads_hex(&mut remote);
        // Ordered by tombstone-ness first (remove-wins), then over retained
        // content only. Every component is symmetric in the two sides, so
        // swapping the labels cannot swap the winner.
        let local_wins = (local_tomb.is_some(), &local_tomb, &local_text, &local_heads)
            > (
                remote_tomb.is_some(),
                &remote_tomb,
                &remote_text,
                &remote_heads,
            );
        return Ok(if local_wins {
            CrdtNoteMerge {
                blob: local_blob.to_vec(),
                heads: local_heads,
                text: local_text,
                resolution: CrdtMergeResolution::LocalTombstoneWins,
            }
        } else {
            CrdtNoteMerge {
                blob: remote_blob.to_vec(),
                heads: remote_heads,
                text: remote_text,
                resolution: CrdtMergeResolution::RemoteTombstoneWins,
            }
        });
    }

    local
        .merge(&mut remote)
        .map_err(|_| CrdtNoteOpError::Malformed)?;
    let text = doc_text(&local)?;
    let heads = doc_heads_hex(&mut local);
    let blob = encode_crdt_note_blob(items_key, items_key_id, note_uuid, &local.save())?;
    Ok(CrdtNoteMerge {
        blob,
        heads,
        text,
        resolution: CrdtMergeResolution::Merged,
    })
}

/// The whole-note markdown of a loaded `NC05` document.
fn doc_text(doc: &AutoCommit) -> Result<String, CrdtNoteOpError> {
    let text_id = note_text_id(doc)?;
    doc.text(&text_id).map_err(|_| CrdtNoteOpError::Malformed)
}

/// For an `NC05` note whose on-disk `content_nonce` changed since last sync,
/// decide whether it is **genuinely** dirty by comparing Automerge heads — NOT
/// the `content_nonce`, which a non-deterministic re-save always flips (ASM-5;
/// the fix for the note-level §10.2.2 ping-pong). Decrypts + `load()`s the local
/// blob and returns `(dirty, current_heads)`:
///
/// * `dirty == false` → same heads, just a re-serialize/merge with nothing new
///   to send: the orchestrator does **not** push, but adopts the new
///   `content_nonce` into `BlobSyncState` so the fast decryption-free diff stops
///   re-flagging it;
/// * `dirty == true` → there are local changes the last-synced revision lacked:
///   push, and record `current_heads`.
pub fn nc05_convergence(
    local_blob: &[u8],
    last_synced_heads: &[String],
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
    note_uuid: &[u8; 16],
) -> Result<(bool, Vec<String>), CrdtNoteOpError> {
    let save = decode_crdt_note_blob(local_blob, note_uuid, items_key, items_key_id)
        .map_err(|_| CrdtNoteOpError::CannotDecrypt)?;
    let mut doc = AutoCommit::load(&save).map_err(|_| CrdtNoteOpError::Malformed)?;
    let heads = doc_heads_hex(&mut doc);
    let dirty = heads.as_slice() != last_synced_heads;
    Ok((dirty, heads))
}

/// One revision in a CRDT (`NC05`) note's synced Automerge change-history —
/// the read surface that replaces per-note snapshots for CRDT notes (#421 t4,
/// ASM-12→B: the change-graph *is* the version store).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrdtRevision {
    /// The change's content hash (lowercase hex) — a stable revision id.
    pub change_hash_hex: String,
    /// The revision's host-injected timestamp (unix millis, ASM-3). Not a wall
    /// clock guarantee — it is whatever the authoring device's `HostCtx` supplied.
    pub timestamp_millis: i64,
    /// The authoring device's Automerge actor id (hex) — the device that made
    /// this edit. Cross-device provenance; not a user identity.
    pub actor_hex: String,
    /// The change's encoded size in bytes — what this revision costs inside the
    /// note blob. The analogue of a `snapshots/` entry's file size, and the same
    /// thing the history UI renders beside each entry.
    pub size_bytes: u64,
}

/// Enumerate a CRDT note's revision history in causal order — every change the
/// synced Automerge document carries, oldest first. This is the read side of the
/// snapshots-retirement (#421): a migrated note's history rides inside the note
/// itself, so a version list needs no separate `snapshots/` store. Reconstructing
/// the *text* at a given revision (a "view old version" feature) is a follow-on;
/// this pins the change list + metadata.
pub fn crdt_note_history(
    blob: &[u8],
    note_uuid: &[u8; 16],
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
) -> Result<Vec<CrdtRevision>, CrdtNoteOpError> {
    let save = decode_crdt_note_blob(blob, note_uuid, items_key, items_key_id)
        .map_err(|_| CrdtNoteOpError::CannotDecrypt)?;
    let mut doc = AutoCommit::load(&save).map_err(|_| CrdtNoteOpError::Malformed)?;
    Ok(doc
        .get_changes(&[])
        .into_iter()
        .map(|c| CrdtRevision {
            change_hash_hex: c.hash().to_string(),
            timestamp_millis: c.timestamp(),
            actor_hex: hex_lower(c.actor_id().to_bytes()),
            size_bytes: c.raw_bytes().len() as u64,
        })
        .collect())
}

/// Reconstruct a CRDT note's text **as of** the revision `change_hash_hex`
/// names — the "view an old version" half of [`crdt_note_history`], which that
/// function's doc left as a follow-on.
///
/// The revision id is a change hash, and a change hash is a causal frontier: the
/// document read at `heads = [hash]` is the document as it stood when that change
/// landed, including every change it depends on and excluding everything
/// concurrent-but-later. That is exactly the "old version" a reader means, and it
/// is why no separate stored copy is needed — the history is inside the note.
///
/// A hash the document does not carry is [`CrdtNoteOpError::RevisionNotFound`]
/// rather than an empty string, so a stale UI list cannot silently preview a
/// blank note.
pub fn crdt_note_text_at(
    blob: &[u8],
    note_uuid: &[u8; 16],
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
    change_hash_hex: &str,
) -> Result<String, CrdtNoteOpError> {
    let save = decode_crdt_note_blob(blob, note_uuid, items_key, items_key_id)
        .map_err(|_| CrdtNoteOpError::CannotDecrypt)?;
    let mut doc = AutoCommit::load(&save).map_err(|_| CrdtNoteOpError::Malformed)?;
    let target: automerge::ChangeHash = change_hash_hex
        .parse()
        .map_err(|_| CrdtNoteOpError::RevisionNotFound)?;
    if !doc.get_changes(&[]).into_iter().any(|c| c.hash() == target) {
        return Err(CrdtNoteOpError::RevisionNotFound);
    }
    let text_obj = match doc.get(ROOT, NOTE_TEXT_KEY) {
        Ok(Some((_, id))) => id,
        _ => return Err(CrdtNoteOpError::Malformed),
    };
    doc.text_at(&text_obj, &[target])
        .map_err(|_| CrdtNoteOpError::Malformed)
}

/// Lowercase-hex a byte slice (local helper — the crate's `to_hex` lives in the
/// sync module, which this note-layer module does not depend on).
fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::test_host::TestHost;
    use crate::plugins::sync::crdt_doc::{commit_with_host_time, new_note_doc};
    use automerge::transaction::Transactable;

    const ACTOR: &[u8] = &[0x5Au8; 16];

    fn round_trips(markdown: &str) {
        let host = TestHost::new("/base");
        let saved = encode_note(markdown, ACTOR, &host);
        let decoded = decode_note(&saved).expect("decodes");
        assert_eq!(decoded, markdown, "byte-exact round-trip (§6 C1)");
    }

    #[test]
    fn round_trips_a_frontmatter_plus_body_note() {
        round_trips(
            "---\ntitle: Example\ntags: [a, b]\ncustom_unknown_field: kept\n---\n\n# Heading\n\nBody with a [[wikilink]] and a - [ ] task.\n",
        );
    }

    #[test]
    fn round_trips_unicode_and_turkish() {
        round_trips("Başlık: İçğüşöÇĞÜŞÖ — emoji 🚀🔐, combining é, and CJK 日本語。");
    }

    #[test]
    fn round_trips_empty_and_whitespace() {
        round_trips("");
        round_trips("   \n\t\n");
    }

    #[test]
    fn round_trips_a_drawing_json_body() {
        // `kind: drawing` bodies are Excalidraw JSON, not prose — same mapping.
        round_trips(
            "---\nkind: drawing\n---\n{\"type\":\"excalidraw\",\"elements\":[{\"id\":\"a1\",\"x\":0.5}],\"appState\":{}}",
        );
    }

    #[test]
    fn round_trips_markdown_special_bytes() {
        round_trips("backticks ``` and $math$ and <html> & \"quotes\" and \\ escapes\r\nCRLF too");
    }

    #[test]
    fn garbage_bytes_are_malformed_not_a_panic() {
        assert_eq!(
            decode_note(b"not an automerge document"),
            Err(MalformedCrdtNote)
        );
        assert_eq!(decode_note(&[]), Err(MalformedCrdtNote));
    }

    #[test]
    fn a_document_without_the_root_text_is_malformed() {
        // A valid Automerge doc that lacks the `NOTE_TEXT_KEY` Text → malformed.
        let host = TestHost::new("/base");
        let mut doc = new_note_doc(ACTOR);
        doc.put(ROOT, "not_text", "x").expect("put");
        commit_with_host_time(&mut doc, &host);
        assert_eq!(decode_note(&doc.save()), Err(MalformedCrdtNote));
    }

    #[test]
    fn full_encrypt_path_round_trips_markdown_byte_exact() {
        // markdown → single-Text Automerge doc → NC05 AEAD blob → back to markdown.
        let host = TestHost::new("/base");
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let note_uuid = [0x33u8; 16];
        let md =
            "---\ntitle: Café İş\ntags: [a]\n---\n\n# Body 🚀 with a [[link]] and a - [ ] task\n";
        let blob = encode_note_blob(md, &items_key, &items_key_id, &note_uuid, ACTOR, &host)
            .expect("seal");
        // It is a real NC05 blob (magic in the cleartext header).
        assert_eq!(&blob[0..4], protocol::NC05_MAGIC);
        let out =
            decode_note_blob(&blob, &note_uuid, &items_key, &items_key_id).expect("open + bridge");
        assert_eq!(
            out, md,
            "byte-exact §6 C1 round-trip through the full crypto path"
        );
    }

    #[test]
    fn wrong_items_key_cannot_decrypt_the_blob() {
        let host = TestHost::new("/base");
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let note_uuid = [0x33u8; 16];
        let blob = encode_note_blob("body", &items_key, &items_key_id, &note_uuid, ACTOR, &host)
            .expect("seal");
        assert_eq!(
            decode_note_blob(&blob, &note_uuid, &[0x99u8; 32], &items_key_id),
            Err(DecodeNoteBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn edit_path_replaces_content_and_still_decodes() {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        let base =
            encode_note_blob("first version", &ik, &ikid, &uuid, ACTOR, &host).expect("seal");
        let upd =
            encode_note_edit(&base, "second version", &ik, &ikid, &uuid, &host).expect("edit");
        assert_eq!(
            decode_note_blob(&upd.blob, &uuid, &ik, &ikid).expect("decode"),
            "second version"
        );
        assert!(!upd.heads.is_empty());
    }

    /// A deletion racing an edit resolves **remove-wins**, identically on both
    /// devices (myne-md/myne#431).
    ///
    /// The scenario is deliberately an OVERLAPPING frontmatter edit, because a
    /// disjoint one does not exercise the bug: if device A only appends a
    /// `deleted:` line and device B only appends to the body, the text merge
    /// keeps both and the note stays deleted by luck. The dangerous shape is two
    /// edits to the SAME frontmatter region — Myne rewrites managed frontmatter
    /// on save. Removing the remove-wins gate and running this test prints what
    /// that produces: the edit rides into the deleted note AND `deleted:` comes
    /// out as `2026-09-11T09:30:00Z`, a timestamp neither device wrote, blended
    /// character-wise from A's `deleted:` and B's `updated:`.
    #[test]
    fn a_deletion_beats_a_concurrent_edit_in_either_order() {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        const BASE: &str = "---\ntitle: Groceries\nupdated: 2026-08-11T08:00:00Z\n---\n\nMilk.\n";
        let base = encode_note_blob(BASE, &ik, &ikid, &uuid, ACTOR, &host).expect("seal");

        // Device A deletes the note: a `deleted:`-marked revision (§11.1), which
        // rewrites the managed-frontmatter block.
        let deleted = encode_note_edit(
            &base,
            "---\ntitle: Groceries\nupdated: 2026-08-11T09:00:00Z\ndeleted: 2026-08-11T09:00:00Z\n---\n\nMilk.\n",
            &ik, &ikid, &uuid, &host,
        )
        .expect("delete");
        // Device B never saw the deletion and edits the note, touching the same
        // managed-frontmatter block on its way.
        let edited = encode_note_edit(
            &base,
            "---\ntitle: Groceries\nupdated: 2026-08-11T09:30:00Z\n---\n\nMilk.\nEggs.\n",
            &ik,
            &ikid,
            &uuid,
            &host,
        )
        .expect("edit");

        let ab = merge_crdt_note_blobs(&deleted.blob, &edited.blob, &ik, &ikid, &uuid)
            .expect("merge, deleting device local");
        let ba = merge_crdt_note_blobs(&edited.blob, &deleted.blob, &ik, &ikid, &uuid)
            .expect("merge, editing device local");

        // The outcome may not depend on which device happens to run the merge.
        assert_eq!(
            ab.text, ba.text,
            "delete-vs-edit resolved differently depending on which side was local"
        );
        assert_eq!(ab.heads, ba.heads);
        // The deletion survives as a READABLE marker — the assertion that a
        // shredded frontmatter key fails.
        assert!(
            deleted_marker(&ab.text).is_some(),
            "the note must stay deleted, and `deleted:` must still parse: {:?}",
            ab.text
        );
        // And the losing edit did not ride along into a note the user deleted.
        assert!(
            !ab.text.contains("Eggs."),
            "a deleted note must not carry the concurrent edit: {:?}",
            ab.text
        );
        // Both sides agree on WHO won even though they label it differently.
        assert_eq!(ab.resolution, CrdtMergeResolution::LocalTombstoneWins);
        assert_eq!(ba.resolution, CrdtMergeResolution::RemoteTombstoneWins);
    }

    /// Two devices deleting the same note concurrently converge on one revision.
    /// The tie-break is a total order over content, so it cannot depend on the
    /// local/remote labels — which are swapped between the two devices.
    #[test]
    fn two_concurrent_deletions_pick_the_same_winner_on_both_devices() {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        const BASE: &str = "---\ntitle: Groceries\n---\n\nMilk.\n";
        let base = encode_note_blob(BASE, &ik, &ikid, &uuid, ACTOR, &host).expect("seal");
        let early = encode_note_edit(
            &base,
            "---\ntitle: Groceries\ndeleted: 2026-08-11T09:00:00Z\n---\n\nMilk.\n",
            &ik,
            &ikid,
            &uuid,
            &host,
        )
        .expect("delete early");
        let late = encode_note_edit(
            &base,
            "---\ntitle: Groceries\ndeleted: 2026-08-11T11:00:00Z\n---\n\nMilk.\n",
            &ik,
            &ikid,
            &uuid,
            &host,
        )
        .expect("delete late");

        let ab = merge_crdt_note_blobs(&early.blob, &late.blob, &ik, &ikid, &uuid).expect("merge");
        let ba = merge_crdt_note_blobs(&late.blob, &early.blob, &ik, &ikid, &uuid).expect("merge");

        assert_eq!(ab.text, ba.text, "tombstone-vs-tombstone must converge");
        assert_eq!(
            deleted_marker(&ab.text).as_deref(),
            Some("2026-08-11T11:00:00Z"),
            "the greater `deleted:` stamp wins: {:?}",
            ab.text
        );
    }

    #[test]
    fn concurrent_edits_merge_converge_drop_neither_and_duplicate_nothing() {
        // The merge-engine core: two devices fork a shared note, edit concurrently,
        // and the merge is order-independent (converges), drops neither edit, and
        // leaves the shared base present exactly once.
        //
        // That last clause has to be asserted by COUNT (#428). A whole-body-replace
        // encode converges and keeps both edits too — it just returns the entire
        // document twice, and a `contains(…)` assertion cannot tell the two apart.
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        const BASE: &str = "# Meeting notes\n\nFirst item.\n";
        // The note is created once; both devices' edits start from THIS blob
        // (shared change-graph ancestry — the merge precondition).
        let base = encode_note_blob(BASE, &ik, &ikid, &uuid, ACTOR, &host).expect("seal");
        let a = encode_note_edit(
            &base,
            &format!("{BASE}Added from the desktop.\n"),
            &ik,
            &ikid,
            &uuid,
            &host,
        )
        .expect("edit A");
        let b = encode_note_edit(
            &base,
            &format!("{BASE}Added from the phone.\n"),
            &ik,
            &ikid,
            &uuid,
            &host,
        )
        .expect("edit B");

        let ab = merge_crdt_note_blobs(&a.blob, &b.blob, &ik, &ikid, &uuid).expect("merge a←b");
        let ba = merge_crdt_note_blobs(&b.blob, &a.blob, &ik, &ikid, &uuid).expect("merge b←a");

        // Commutative + associative → order-independent convergence.
        assert_eq!(ab.heads, ba.heads, "merge converges regardless of order");
        // Neither edit is dropped, and neither is duplicated.
        for line in ["Added from the desktop.", "Added from the phone."] {
            assert_eq!(
                ab.text.matches(line).count(),
                1,
                "{line:?} must survive the merge exactly once: {:?}",
                ab.text
            );
        }
        // The shared base is not re-inserted by either side — the #428 assertion.
        for line in ["# Meeting notes", "First item."] {
            assert_eq!(
                ab.text.matches(line).count(),
                1,
                "the shared base line {line:?} must not be duplicated: {:?}",
                ab.text
            );
        }
        // The merged blob is a real, decodable NC05 note.
        assert_eq!(&ab.blob[0..4], protocol::NC05_MAGIC);
        let _ = decode_note_blob(&ab.blob, &uuid, &ik, &ikid).expect("merged blob decodes");
    }

    #[test]
    fn magic_dispatch_distinguishes_nc05_from_my01() {
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        let nc05 = encode_note_blob("x", &ik, &ikid, &uuid, ACTOR, &host).expect("seal");
        assert!(is_nc05_blob(&nc05));
        assert_eq!(blob_magic(&nc05), Some(*protocol::NC05_MAGIC));
        // A MY01-magic header is NOT dispatched as NC05.
        assert!(!is_nc05_blob(b"MY01\x00\x00\x00\x00"));
        assert!(!is_nc05_blob(&[0x01, 0x02])); // too short
        assert_eq!(blob_magic(&[0x01, 0x02]), None);
    }

    #[test]
    fn nc05_convergence_uses_heads_not_content_nonce() {
        // The ASM-5 property at the blob level: a re-seal (fresh content_nonce,
        // different bytes) with NO new change reads NOT dirty; a real edit reads dirty.
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        let base = encode_note_blob("base", &ik, &ikid, &uuid, ACTOR, &host).expect("seal");
        // Base heads, via the helper (empty last-synced → dirty=true, returns heads).
        let (_, base_heads) = nc05_convergence(&base, &[], &ik, &ikid, &uuid).expect("conv");

        // Re-seal the SAME document → new content_nonce + different bytes, SAME heads.
        let save = protocol::decode_crdt_note_blob(&base, &uuid, &ik, &ikid).expect("open");
        let reblob = protocol::encode_crdt_note_blob(&ik, &ikid, &uuid, &save).expect("reseal");
        assert_ne!(
            reblob, base,
            "a re-seal changes the bytes (fresh content_nonce)"
        );
        let (dirty, heads) =
            nc05_convergence(&reblob, &base_heads, &ik, &ikid, &uuid).expect("conv");
        assert!(
            !dirty,
            "a re-serialize with no new change is NOT dirty (ping-pong fix)"
        );
        assert_eq!(heads, base_heads);

        // A genuine edit → dirty, advanced heads.
        let edited =
            encode_note_edit(&base, "base + more", &ik, &ikid, &uuid, &host).expect("edit");
        let (dirty2, heads2) =
            nc05_convergence(&edited.blob, &base_heads, &ik, &ikid, &uuid).expect("conv");
        assert!(dirty2, "a real edit IS dirty");
        assert_ne!(heads2, base_heads);
    }

    #[test]
    fn crdt_note_history_lists_revisions_in_causal_order() {
        // #421 t4: the change-graph IS the version store. Create + 2 edits → 3
        // revisions, oldest first, carrying the host-injected timestamps (ASM-3)
        // and the authoring device's actor.
        let host = TestHost::new("/base");
        let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
        host.set_now(1000); // seconds → 1_000_000 ms
        let base = encode_note_blob("v1", &ik, &ikid, &uuid, ACTOR, &host).expect("seal");
        host.set_now(2000);
        let e1 = encode_note_edit(&base, "v2", &ik, &ikid, &uuid, &host).expect("edit");
        host.set_now(3000);
        let e2 = encode_note_edit(&e1.blob, "v3", &ik, &ikid, &uuid, &host).expect("edit");

        let hist = crdt_note_history(&e2.blob, &uuid, &ik, &ikid).expect("history");
        assert_eq!(hist.len(), 3, "create + 2 edits = 3 revisions");
        assert_eq!(hist[0].timestamp_millis, 1_000_000);
        assert_eq!(hist[1].timestamp_millis, 2_000_000);
        assert_eq!(hist[2].timestamp_millis, 3_000_000);
        // The create pins the seeded device actor; every revision carries a
        // well-formed actor id (16-byte device provenance).
        assert_eq!(
            hist[0].actor_hex,
            hex_lower(ACTOR),
            "create authored by the seeded device"
        );
        assert!(hist
            .iter()
            .all(|r| r.actor_hex.len() == ACTOR.len() * 2 && !r.actor_hex.is_empty()));
        assert_ne!(
            hist[0].change_hash_hex, hist[2].change_hash_hex,
            "distinct revision ids"
        );
    }
}
