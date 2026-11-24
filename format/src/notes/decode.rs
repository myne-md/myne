// SPDX-License-Identifier: AGPL-3.0-only
//! The one place a note blob is turned back into markdown, whatever its format
//! (myne-md/myne#432, #442).
//!
//! A vault holds two note formats: v0.1 `MY01` (`protocol.md` §9.2) and v0.2
//! `NC05`, the Automerge CRDT note-type (§10.7). Which one a given `.myn` file
//! is depends on whether its vault has been through the §10.4 migration, and the
//! answer is written in the blob's own cleartext magic — so a reader can always
//! tell, cheaply, without a key.
//!
//! One dispatcher inverts the per-call-site branch that used to be the rule:
//! the branch exists once, and a new reader gets it by calling the obvious
//! function.

use crate::notes::crdt_decode::{decode_note_blob, is_nc05_blob, DecodeNoteBlobError};
use zeroize::Zeroizing;

/// Decode a `.myn` blob of **either** format to its exact plaintext bytes,
/// dispatching on the cleartext magic.
///
/// Both formats seal under the same per-vault `items_key` / `items_key_id` and
/// bind the same `note_uuid`, so the caller needs no new material — only this
/// function instead of `protocol::decode_note`.
///
/// **Bytes, and `Zeroizing`, on purpose.** The callers this replaces held a
/// `protocol::DecryptedNote` and read `.plaintext()`, and several of them go out
/// of their way to keep the non-zeroized window narrow. Returning a bare `String`
/// would have quietly removed that property from every one of them at once.
///
/// One honest gap, unchanged by this module: the `NC05` arm's automerge bridge
/// materialises the note as a `String` before this function can wrap it, so that
/// intermediate is not zeroized. That is a property of the CRDT read path and
/// predates the dispatcher.
///
/// The error is deliberately the §6.4 non-distinguishing collapse: a caller
/// cannot tell a wrong key from a tampered blob from a structurally-invalid
/// Automerge payload, exactly as it could not before.
pub fn decode_note_any(
    blob: &[u8],
    note_uuid: &[u8; 16],
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
) -> Result<Zeroizing<Vec<u8>>, NoteDecodeError> {
    if is_nc05_blob(blob) {
        return decode_note_blob(blob, note_uuid, items_key, items_key_id)
            .map(|s| Zeroizing::new(s.into_bytes()))
            .map_err(NoteDecodeError::from);
    }
    protocol::decode_note(blob, note_uuid, items_key, items_key_id)
        .map(|d| Zeroizing::new(d.plaintext().to_vec()))
        .map_err(|_| NoteDecodeError::CannotDecrypt)
}

/// Failure decoding a note blob of either format.
///
/// One variant, on purpose. `protocol.md` §6.4 collapses every AEAD-open failure
/// into a single non-distinguishing answer, and the `NC05` path adds one more
/// way to fail (a payload that opens but is not a valid single-`Text` document).
/// Surfacing that as its own variant would hand a caller — and through it an IPC
/// boundary — a distinguisher the v0.1 format deliberately does not have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteDecodeError {
    /// The blob did not decode to markdown under these keys.
    CannotDecrypt,
}

impl From<DecodeNoteBlobError> for NoteDecodeError {
    fn from(_: DecodeNoteBlobError) -> Self {
        NoteDecodeError::CannotDecrypt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::transaction::Transactable;
    use automerge::{AutoCommit, ObjType, ROOT};

    const IK: [u8; 32] = [0x11; 32];
    const IKID: [u8; 16] = [0x22; 16];
    const UUID: [u8; 16] = [0x33; 16];
    const MD: &str = "---\ntitle: Both\n---\n\n# Body [[l]] 🚀\n";

    /// Seal a single-`Text` Automerge document holding `md` into an `NC05`
    /// blob, using protocol's codec directly. The encode half of the bridge
    /// lives in `myne-core` (it needs the host clock + actor CSPRNG); this is
    /// the same `save()` bytes that half produces, so the decode half under
    /// test sees a real `NC05` blob.
    fn seal_nc05(md: &str) -> Vec<u8> {
        let mut doc = AutoCommit::new();
        let text = doc
            .put_object(
                ROOT,
                crate::notes::crdt_decode::NOTE_TEXT_KEY,
                ObjType::Text,
            )
            .expect("root Text object");
        doc.splice_text(&text, 0, 0, md).expect("seed note text");
        let save = doc.save();
        protocol::encode_crdt_note_blob(&IK, &IKID, &UUID, &save).expect("NC05 seal")
    }

    /// The whole point of the module: one call decodes either format, so a
    /// reader cannot be correct for one kind of vault and broken for the other.
    #[test]
    fn one_call_decodes_both_formats() {
        let my01 = protocol::encode_new_note(&IK, &IKID, &UUID, MD.as_bytes()).expect("MY01 seal");
        let nc05 = seal_nc05(MD);
        assert_eq!(&my01[0..4], b"MY01");
        assert_eq!(&nc05[0..4], protocol::NC05_MAGIC);

        for (label, blob) in [("MY01", &my01), ("NC05", &nc05)] {
            assert_eq!(
                decode_note_any(blob, &UUID, &IK, &IKID)
                    .expect(label)
                    .as_slice(),
                MD.as_bytes(),
                "{label} must decode byte-exactly through the dispatcher"
            );
        }
    }

    /// A wrong key fails the same way for both formats — the §6.4 collapse is
    /// not weakened by the dispatch.
    #[test]
    fn a_wrong_key_is_indistinguishable_across_formats() {
        let wrong = [0x99u8; 32];
        let my01 = protocol::encode_new_note(&IK, &IKID, &UUID, MD.as_bytes()).expect("MY01 seal");
        let nc05 = seal_nc05(MD);
        for blob in [&my01, &nc05] {
            assert_eq!(
                decode_note_any(blob, &UUID, &wrong, &IKID),
                Err(NoteDecodeError::CannotDecrypt)
            );
        }
    }

    /// Junk is not a panic and not a partial answer.
    #[test]
    fn garbage_is_cannot_decrypt() {
        for blob in [b"".as_slice(), b"MY01".as_slice(), b"NC05 not a document"] {
            assert_eq!(
                decode_note_any(blob, &UUID, &IK, &IKID),
                Err(NoteDecodeError::CannotDecrypt)
            );
        }
    }
}
