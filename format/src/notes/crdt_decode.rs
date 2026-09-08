// SPDX-License-Identifier: AGPL-3.0
//! The host-free decode half of the `NC05` CRDT note-type bridge.
//!
//! Split out of `myne-core`'s `plugins::notes::crdt` so the `format/` crate can
//! read an `NC05` note without pulling `myne-core`'s `HostCtx` + sync `crdt_doc`
//! seam. The encode half (`encode_note_blob`, `encode_note_edit`,
//! `merge_crdt_note_blobs`, `crdt_note_history`, `crdt_note_text_at`) stays in
//! `myne-core`, which needs the host clock and the actor-id CSPRNG.
//!
//! The whole note — YAML frontmatter *and* body, as one exact byte string — is
//! modelled as a single Automerge `Text` under the document root. That choice
//! preserves, by construction, the three v0.1 guarantees a note-body format
//! must not break: byte-exact round-trip (§6 C1), unknown-frontmatter-field
//! preservation, and plain-markdown portability.

use automerge::{AutoCommit, ReadDoc, ROOT};
use protocol::{decode_crdt_note_blob, NC05_MAGIC};

/// Root-map key under which the whole note lives as one `Text`. Part of the
/// `NC05` document schema (task 1's single-`Text` mapping); a fixed, internal
/// name — never a theme/user-supplied key.
pub const NOTE_TEXT_KEY: &str = "text";

/// A structurally-invalid `NC05` Automerge payload — the decrypted bytes did not
/// `load()` as an Automerge document, or lacked the single root `Text`. Callers
/// fall back per the sibling-blob discipline (rebuild / non-distinguishing
/// error), never panic. Deliberately carries no detail (it reaches no IPC sink).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MalformedCrdtNote;

/// Decode an `NC05` document's plaintext `save()` bytes back to the exact
/// markdown string, or [`MalformedCrdtNote`] if the bytes are not a well-formed
/// document with the single root `Text`.
pub fn decode_note(saved: &[u8]) -> Result<String, MalformedCrdtNote> {
    let doc = AutoCommit::load(saved).map_err(|_| MalformedCrdtNote)?;
    let (_, text_id) = doc
        .get(ROOT, NOTE_TEXT_KEY)
        .map_err(|_| MalformedCrdtNote)?
        .ok_or(MalformedCrdtNote)?;
    doc.text(&text_id).map_err(|_| MalformedCrdtNote)
}

/// Failure decoding an encrypted `NC05` note blob back to markdown — either the
/// AEAD did not open (wrong key / tamper / not an `NC05` blob) or the decrypted
/// payload was not a well-formed single-`Text` Automerge document. Non-
/// distinguishing at the boundary is the caller's concern; the two are split
/// here only so a caller can tell "cannot decrypt" from "decrypts but corrupt".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeNoteBlobError {
    /// The `NC05` AEAD envelope did not open (§ 6.4 collapse).
    CannotDecrypt,
    /// It opened, but the plaintext was not a valid single-`Text` document.
    Malformed,
}

/// Decode a sealed `NC05` blob back to the exact markdown string: open the AEAD
/// envelope, then bridge the opaque Automerge `save()` bytes back through the
/// single-`Text` mapping. The byte-exact §6 C1 round-trip survives the full
/// encrypt→decrypt path.
pub fn decode_note_blob(
    blob: &[u8],
    note_uuid: &[u8; 16],
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
) -> Result<String, DecodeNoteBlobError> {
    let save = decode_crdt_note_blob(blob, note_uuid, items_key, items_key_id)
        .map_err(|_| DecodeNoteBlobError::CannotDecrypt)?;
    decode_note(&save).map_err(|_| DecodeNoteBlobError::Malformed)
}

/// Read a blob's 4-byte magic from its cleartext header (decryption-free) — how
/// the sync orchestrator dispatches `MY01` (keep-both) vs `NC05` (merge) before
/// decrypting anything. `None` if the blob is shorter than the 4-byte magic.
pub fn blob_magic(blob: &[u8]) -> Option<[u8; 4]> {
    blob.get(0..4).map(|m| [m[0], m[1], m[2], m[3]])
}

/// Is this blob a next-major `NC05` CRDT note (vs a v0.1 `MY01` note)? Read from
/// the cleartext magic — no decryption.
pub fn is_nc05_blob(blob: &[u8]) -> bool {
    blob_magic(blob).as_ref() == Some(NC05_MAGIC)
}
