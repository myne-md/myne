// SPDX-License-Identifier: AGPL-3.0
//! Decryption-free `.myn` `content_nonce` primitives — the shared staleness
//! signal both the desktop search-index persistence (`MYS1`) and the
//! vault-indices persistence (`MYI1`, `plugins::vault_indices::persist`) diff
//! against disk.
//!
//! A `.myn` header carries the note's `content_nonce` in the clear; any save
//! re-encrypts and rotates it, so a note is "changed" iff its header nonce
//! differs from a persisted manifest — no decryption required. These pure fns
//! read that nonce and build the vault-wide `note_id → content_nonce` manifest.
//!
//! Extracted from the desktop crate (`search::persist` + `notes::search_sync`)
//! into `myne-core` so the vault-indices plugin core — now shared with the
//! mobile client — can reuse the identical scan instead of a desktop-only path.
//! The desktop modules re-export these so every existing
//! `crate::search::persist::{NonceManifest, …}` path keeps resolving. The
//! BLOCKING walk lives in the desktop crate rather than here (task 84) —
//! `search_sync::scan_on_disk_manifest`; only the pure header parse is shared,
//! which is the half whose disagreement would matter.

use protocol::AEAD_NONCE_LEN;
use std::collections::BTreeMap;
use std::path::Path;

/// `.myn` magic — sourced from `protocol::blob` (protocol.md §9.2 offset 0) so
/// a header-format change can't silently rot this decryption-free reader.
const MYN_MAGIC: [u8; 4] = *protocol::blob::MAGIC;
/// The allocated v0.2 `NC05` CRDT note magic (`protocol.md` §10.7). A `.myn` file may
/// hold EITHER family, and `NC05` reuses `blob.rs`'s `OFFSET_CONTENT_NONCE`
/// verbatim, so the `content_nonce` sits at the identical header offset in both —
/// the decryption-free staleness signal is magic-agnostic across the note
/// families by construction. Reading only `MY01` would make every migrated CRDT
/// note invisible to the sync manifest, the search index and the vault indices
/// (dropped from every scan, so nothing this device wrote would ever sync).
const NC05_MAGIC: [u8; 4] = *protocol::NC05_MAGIC;
/// Offset of `content_nonce` in the `.myn` header — `protocol::blob` *derives*
/// it from the item-key-wrap sizes, so importing it (not a literal `112`)
/// tracks any future layout shift (protocol.md §9.2).
const MYN_CONTENT_NONCE_OFFSET: usize = protocol::blob::OFFSET_CONTENT_NONCE;
/// Length of `content_nonce` (the XChaCha20-Poly1305 nonce width).
pub const MYN_CONTENT_NONCE_LEN: usize = AEAD_NONCE_LEN;
/// Minimum `.myn` header bytes needed to read `content_nonce`.
pub const MYN_HEADER_PREFIX_FOR_NONCE: usize = MYN_CONTENT_NONCE_OFFSET + MYN_CONTENT_NONCE_LEN;

/// note_id → the note's `.myn` `content_nonce` recorded at index time. The
/// staleness manifest (decryption-free diffable).
pub type NonceManifest = BTreeMap<String, [u8; MYN_CONTENT_NONCE_LEN]>;

/// Read a `.myn` file's `content_nonce` from its header bytes WITHOUT
/// decrypting (the decryption-free staleness signal). `header` must be at
/// least the first [`MYN_HEADER_PREFIX_FOR_NONCE`] bytes of the file; returns
/// `None` if too short or the magic is neither note family (`MY01` nor `NC05`).
///
/// Both families share the §9.2 header layout, so the same offset reads the
/// nonce for either — see [`NC05_MAGIC`] for why the reader must accept both.
pub fn read_myn_content_nonce(header: &[u8]) -> Option<[u8; MYN_CONTENT_NONCE_LEN]> {
    crate::content_nonce::content_nonce_at(
        header,
        MYN_CONTENT_NONCE_OFFSET,
        &MYN_MAGIC,
        &[&NC05_MAGIC],
    )
}

/// Build the on-disk staleness manifest (`note_id → content_nonce`) by
/// scanning every `.myn` header in `notes_dir` — the decryption-free staleness
/// signal diffed against a persisted manifest. Shared by the search index's
/// `MYS1` persistence and the vault-indices `MYI1` persistence (MYND-271),
/// which diff the identical `.myn` `content_nonce` signal. An unreadable dir
/// yields an empty manifest (treated as "no notes" — hydrate then drops
/// everything from a loaded blob, persist writes an empty snapshot).
///
/// **This is now the only scan in `myne-core`** (phase3-web-client task 84). The
/// synchronous twin it used to sit beside moved to the desktop crate
/// (`search_sync.rs`), because its two remaining callers are `spawn_blocking`
/// regions there and keeping a `std::fs` scan here would have held this file on
/// the io-seam ratchet for code the browser never runs. The header parse stays
/// shared as the pure [`read_myn_content_nonce`], so the two arms cannot
/// disagree about what a `.myn` header means — which is the part that matters.
///
/// Uses [`crate::vault_io::VaultIo::read_prefix`] rather than whole-file reads:
/// this runs on the unlock path over every note, and pulling complete blobs to
/// read 47 bytes each is the cost that motivated adding that method.
pub async fn scan_on_disk_manifest_io(
    io: &dyn crate::vault_io::VaultIo,
    notes_dir: &Path,
) -> NonceManifest {
    let mut manifest = NonceManifest::new();
    let Ok(entries) = io.read_dir(notes_dir).await else {
        return manifest;
    };
    for id in crate::plugins::notes::commands::note_ids_from_entries(&entries) {
        let id_str = id.as_uuid().to_string();
        let path = notes_dir.join(format!("{id_str}.myn"));
        let Ok(header) = io.read_prefix(&path, MYN_HEADER_PREFIX_FOR_NONCE).await else {
            continue;
        };
        if let Some(nonce) = read_myn_content_nonce(&header) {
            manifest.insert(id_str, nonce);
        }
    }
    manifest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce(b: u8) -> [u8; MYN_CONTENT_NONCE_LEN] {
        [b; MYN_CONTENT_NONCE_LEN]
    }

    #[test]
    fn reads_content_nonce_from_valid_header() {
        let mut header = vec![0u8; MYN_HEADER_PREFIX_FOR_NONCE];
        header[0..4].copy_from_slice(&MYN_MAGIC);
        header[MYN_CONTENT_NONCE_OFFSET..].copy_from_slice(&nonce(0xAB));
        assert_eq!(read_myn_content_nonce(&header), Some(nonce(0xAB)));
    }

    #[test]
    fn rejects_wrong_magic_and_short_header() {
        let mut header = vec![0u8; MYN_HEADER_PREFIX_FOR_NONCE];
        header[0..4].copy_from_slice(b"XXXX");
        assert_eq!(read_myn_content_nonce(&header), None);
        assert_eq!(read_myn_content_nonce(b"MY01short"), None);
    }

    #[test]
    fn reads_content_nonce_from_an_nc05_crdt_header_too() {
        // A migrated CRDT note is a `.myn` with the NC05 magic and the identical
        // §9.2 header layout — the decryption-free nonce must read from it, or the
        // note is invisible to sync/search/indices. Reading the SAME offset from
        // both families is the property under test.
        let mut header = vec![0u8; MYN_HEADER_PREFIX_FOR_NONCE];
        header[0..4].copy_from_slice(NC05_MAGIC.as_slice());
        header[MYN_CONTENT_NONCE_OFFSET..].copy_from_slice(&nonce(0xCD));
        assert_eq!(read_myn_content_nonce(&header), Some(nonce(0xCD)));
        // And a real NC05 blob from the protocol codec reads back the nonce its
        // header carries — the two crates agree on the offset, not just this test.
        let blob =
            protocol::encode_crdt_note_blob(&[0x11; 32], &[0x22; 16], &[0x33; 16], b"payload")
                .expect("seal NC05");
        assert_eq!(
            read_myn_content_nonce(&blob),
            Some(
                blob[MYN_CONTENT_NONCE_OFFSET..MYN_HEADER_PREFIX_FOR_NONCE]
                    .try_into()
                    .unwrap()
            ),
        );
    }

    /// The scan must find notes on a CONTAINER-backed store, not only on a
    /// plain-file one.
    ///
    /// This is the regression test for a silent production failure on the web
    /// client: `notes/<uuid>.myn` is `Mode::SingleLive`, so its bytes live at
    /// `<path>.a` behind an 8-byte generation frame, and the browser's
    /// `read_prefix` was raw. Every header read failed, every note was skipped,
    /// and `sync::unsynced::scan_unsynced` — which walks exactly this manifest —
    /// reported nothing to push. The editor said "Saved", the vault held the
    /// note, the sync loop pulled happily, and the server never got it.
    ///
    /// It is written against `ContainerVaultIo` rather than `StdVaultIo`
    /// because a plain store cannot express the failure: the bug is entirely in
    /// the layout, and a test on the flat layout passes either way.
    #[test]
    fn scans_notes_through_a_container_backed_store() {
        use crate::test_support::{block_on, ContainerVaultIo, ScopedTempDir};
        use crate::vault_io::{VaultIo, WriteOpts};

        let tmp = ScopedTempDir::new("note-nonce-container").unwrap();
        let notes = tmp.path().join("notes");
        let id = "019fa948-5417-7e33-bbe6-f583e41a8422";

        let mut blob = vec![0u8; MYN_HEADER_PREFIX_FOR_NONCE + 16];
        blob[0..4].copy_from_slice(&MYN_MAGIC);
        blob[MYN_CONTENT_NONCE_OFFSET..MYN_HEADER_PREFIX_FOR_NONCE].copy_from_slice(&nonce(0x5A));

        block_on(async {
            let io = ContainerVaultIo;
            io.create_dir_all(&notes).await.unwrap();
            io.write(
                &notes.join(format!("{id}.myn")),
                &blob,
                WriteOpts::default(),
            )
            .await
            .unwrap();

            // The bytes are NOT at the plain path — asserted so the test fails
            // loudly if the layout ever changes underneath it, rather than
            // passing for the wrong reason.
            assert!(
                !notes.join(format!("{id}.myn")).exists(),
                "a container-backed note must not land at the plain path"
            );

            let manifest = scan_on_disk_manifest_io(&io, &notes).await;
            assert_eq!(
                manifest.get(id).copied(),
                Some(nonce(0x5A)),
                "the scan found no note on a container-backed store — this is the \
                 shape that made the web client push nothing it wrote"
            );
        });
    }
}
