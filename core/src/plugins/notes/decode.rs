// SPDX-License-Identifier: AGPL-3.0
//! The one place a note blob is turned back into markdown, whatever its format
//! (myne-md/myne#432, #442).
//!
//! # Why this module exists at all
//!
//! A vault holds two note formats: v0.1 `MY01` (`protocol.md` §9.2) and v0.2
//! `NC05`, the Automerge CRDT note-type (§10.7). Which one a given `.myn` file
//! is depends on whether its vault has been through the §10.4 migration, and the
//! answer is written in the blob's own cleartext magic — so a reader can always
//! tell, cheaply, without a key.
//!
//! It can tell, and for a while almost none of them did. The `NC05` branch was
//! written **at the call site**, and it reached three of them: note read, note
//! update, and the sync merge. Everything else kept calling the `MY01`-only
//! `protocol::decode_note`, which hard-rejects on the magic check. On a migrated
//! vault that meant: vault export aborted on the first note (the escape hatch
//! backing the no-lock-in commitment), note titles stopped rendering, the
//! attachment reference scan saw every note as unreadable, snapshot preview and
//! restore failed, and the conflict surfaces went blind.
//!
//! The lesson is in the shape rather than the count. A per-call-site branch is a
//! rule every future reader has to know and remember, with the wrong variant
//! still in scope and still compiling — so the population of correct call sites
//! can only decay. One dispatcher inverts that: the branch exists once, and a
//! new reader gets it by calling the obvious function.
//!
//! [`crate::plugins::notes::crdt::is_nc05_blob`] stays public for the two places
//! that genuinely need to know the format rather than the content (the sync
//! orchestrator, deciding merge-vs-keep-both before it downloads anything), and
//! `scripts/check-version-routing.mjs` is what keeps a fourth one from appearing
//! without an argument for it.

use crate::plugins::notes::crdt::{decode_note_blob, is_nc05_blob, DecodeNoteBlobError};
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
/// of their way to keep the non-zeroized window narrow (see the drop comments in
/// `attachments::ref_scan`). Returning a bare `String` would have quietly
/// removed that property from every one of them at once, which is not a thing a
/// mechanical sweep should be able to do. Callers that want text wrap this in
/// `std::str::from_utf8`, exactly as they did before.
///
/// One honest gap, unchanged by this module: the `NC05` arm's automerge bridge
/// materialises the note as a `String` before this function can wrap it, so that
/// intermediate is not zeroized. That is a property of the CRDT read path
/// (`crdt::decode_note_blob`) and predates the dispatcher; it is noted here
/// rather than hidden behind the `Zeroizing` return type.
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
    use crate::host::test_host::TestHost;
    use crate::plugins::notes::crdt::encode_note_blob;

    const IK: [u8; 32] = [0x11; 32];
    const IKID: [u8; 16] = [0x22; 16];
    const UUID: [u8; 16] = [0x33; 16];
    const ACTOR: &[u8] = &[0x44; 16];
    const MD: &str = "---\ntitle: Both\n---\n\n# Body [[l]] 🚀\n";

    /// The whole point of the module: one call decodes either format, so a
    /// reader cannot be correct for one kind of vault and broken for the other.
    #[test]
    fn one_call_decodes_both_formats() {
        let host = TestHost::new("/base");
        let my01 = protocol::encode_new_note(&IK, &IKID, &UUID, MD.as_bytes()).expect("MY01 seal");
        let nc05 = encode_note_blob(MD, &IK, &IKID, &UUID, ACTOR, &host).expect("NC05 seal");
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
        let host = TestHost::new("/base");
        let wrong = [0x99u8; 32];
        let my01 = protocol::encode_new_note(&IK, &IKID, &UUID, MD.as_bytes()).expect("MY01 seal");
        let nc05 = encode_note_blob(MD, &IK, &IKID, &UUID, ACTOR, &host).expect("NC05 seal");
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
