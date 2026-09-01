// SPDX-License-Identifier: AGPL-3.0
//! Decryption-free attachment `content_nonce` primitives, the attachment twin
//! of [`crate::note_nonce`] (MYND-468).
//!
//! An attachment header carries the `content_nonce` in the clear at a fixed
//! offset (`protocol.md` §9.9: the wrapped attachment-key segment is
//! fixed-width, so the offset never varies), and BOTH generations of the family
//! share that layout byte for byte: `MYA5` (v0.2, §10.4.1) differs from `MYA1`
//! only in the magic, the version byte and the AADs, so one offset reads the
//! nonce for either. Attachments are immutable per id,
//! but two devices independently importing the same file mint the same id with
//! **different** ciphertext/nonce (the id is a plaintext HMAC; encryption is
//! randomized) — so the nonce is still the sync discriminator that detects the
//! divergence (`sync-protocol.md` §4.2 server-wins rule) and feeds the head
//! manifest.
//!
//! The sync-plane key of an attachment is the **first 16 bytes** of its
//! 32-byte content-addressed id (the *attachment sync-id*, `sync-protocol.md`
//! §4.2); [`scan_attachments_manifest`] surfaces both widths so the caller
//! never re-derives the truncation.

use protocol::attachment_blob::{ATTACHMENT_ID_LEN, OFFSET_CONTENT_NONCE};
use protocol::AEAD_NONCE_LEN;
use std::collections::BTreeMap;
use std::path::Path;

/// `MYA1` magic — sourced from `protocol::attachment_blob` so a header-format
/// change can't silently rot this decryption-free reader.
const MYA1_MAGIC: [u8; 4] = *protocol::attachment_blob::ATTACHMENT_BLOB_MAGIC;
/// The v0.2 `MYA5` attachment magic (`protocol.md` §10.4.1). A file under
/// `attachments/` may hold EITHER generation, and this reader accepts both.
///
/// Accepting only one is a silent stop rather than a degradation: the reader
/// answers `None`, which every caller reads as "not this family, nothing to
/// do". It shipped that way and stopped attachment sync in both directions on
/// every migrated vault; `design-notes/protocol/0567` carries the incident,
/// the measurements and why the pair is now a required argument to
/// [`crate::content_nonce::content_nonce_at`] (myne-md/myne#638).
const MYA5_MAGIC: [u8; 4] = *protocol::attachment_blob::ATTACHMENT_BLOB_V0_2_MAGIC;
/// Minimum attachment header bytes needed to read `content_nonce` (identical
/// for both generations).
pub const ATTACHMENT_HEADER_PREFIX_FOR_NONCE: usize = OFFSET_CONTENT_NONCE + AEAD_NONCE_LEN;
/// Width of the attachment sync-id — the manifest/wire key (`sync-protocol.md`
/// §4.2: the first 16 bytes of the 32-byte attachment-id).
pub const ATTACHMENT_SYNC_ID_LEN: usize = 16;

/// One scanned on-disk attachment: full id, sync-id prefix, header nonce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentManifestEntry {
    /// Full 32-byte content-addressed attachment-id (the on-disk filename).
    pub id: [u8; ATTACHMENT_ID_LEN],
    /// The 16-byte attachment sync-id (`id[0..16]`) — the manifest/wire key.
    pub sync_id: [u8; ATTACHMENT_SYNC_ID_LEN],
    /// The blob's cleartext-header `content_nonce` (the sync discriminator).
    pub content_nonce: [u8; AEAD_NONCE_LEN],
}

/// Read an attachment file's `content_nonce` from its header bytes WITHOUT
/// decrypting. `header` must be at least the first
/// [`ATTACHMENT_HEADER_PREFIX_FOR_NONCE`] bytes; `None` if too short or the
/// magic is neither attachment generation (`MYA1` nor `MYA5`).
///
/// Both generations share the §9.9 header layout, so one offset reads the nonce
/// for either. The comparison itself lives in
/// [`crate::content_nonce::content_nonce_at`], which takes the pair as a
/// required argument. See [`MYA5_MAGIC`] for what this file cost when it was
/// a hand-written comparison that could name one generation.
pub fn read_attachment_content_nonce(header: &[u8]) -> Option<[u8; AEAD_NONCE_LEN]> {
    crate::content_nonce::content_nonce_at(
        header,
        OFFSET_CONTENT_NONCE,
        &MYA1_MAGIC,
        &[&MYA5_MAGIC],
    )
}

/// Parse a canonical attachment filename (exactly 64 lowercase-hex chars)
/// into the 32-byte id. Mirrors the attachments plugin's strict-name rule —
/// anything else (temp files, uppercase, partials) is not a canonical blob.
fn parse_canonical_id(name: &str) -> Option<[u8; ATTACHMENT_ID_LEN]> {
    if name.len() != ATTACHMENT_ID_LEN * 2 {
        return None;
    }
    let mut id = [0u8; ATTACHMENT_ID_LEN];
    for (i, chunk) in name.as_bytes().chunks_exact(2).enumerate() {
        let hi = hex_nibble_lower(chunk[0])?;
        let lo = hex_nibble_lower(chunk[1])?;
        id[i] = (hi << 4) | lo;
    }
    Some(id)
}

fn hex_nibble_lower(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

/// Scan `attachments_dir` for canonical attachment blobs of EITHER generation
/// (`MYA1`, `MYA5`) and build the sync-plane
/// manifest, keyed by sync-id so the caller consumes it in the same shape as
/// [`crate::note_nonce::scan_on_disk_manifest_io`]. Non-canonical names (temp
/// files, partials — anything not 64 lowercase hex) and unreadable/bad-magic
/// files are skipped, mirroring the stray-reconcile discipline. An
/// absent/unreadable dir yields an empty manifest (a vault with no attachments
/// has no `attachments/` dir until the first import).
///
/// Over the IO seam (phase3-web-client task 84). Its caller — the sync cycle's
/// once-per-attempt disk scan — went async two passes ago, and this was the leaf
/// it still reached `std::fs` through: a hole that compiles on `wasm32` and
/// fails at first attachment sync.
///
/// [`crate::vault_io::VaultIo::read_prefix`] rather than whole-file reads, for
/// the reason that method exists: an attachment can be 64 MiB and this wants 40
/// bytes of it, once per blob, every cycle.
pub async fn scan_attachments_manifest(
    io: &dyn crate::vault_io::VaultIo,
    attachments_dir: &Path,
) -> BTreeMap<[u8; ATTACHMENT_SYNC_ID_LEN], AttachmentManifestEntry> {
    let mut manifest = BTreeMap::new();
    let Ok(entries) = io.read_dir(attachments_dir).await else {
        return manifest;
    };
    for entry in entries {
        // Names, not paths: the seam's `DirEntry` carries a name because OPFS
        // has no path API at all. The canonical-name check is unchanged.
        let Some(id) = parse_canonical_id(&entry.name) else {
            continue;
        };
        let Ok(header) = io
            .read_prefix(
                &attachments_dir.join(&entry.name),
                ATTACHMENT_HEADER_PREFIX_FOR_NONCE,
            )
            .await
        else {
            continue;
        };
        let Some(content_nonce) = read_attachment_content_nonce(&header) else {
            continue;
        };
        let mut sync_id = [0u8; ATTACHMENT_SYNC_ID_LEN];
        sync_id.copy_from_slice(&id[..ATTACHMENT_SYNC_ID_LEN]);
        manifest.insert(
            sync_id,
            AttachmentManifestEntry {
                id,
                sync_id,
                content_nonce,
            },
        );
    }
    manifest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_with(magic: &[u8; 4], nonce_byte: u8) -> Vec<u8> {
        let mut h = vec![0u8; ATTACHMENT_HEADER_PREFIX_FOR_NONCE];
        h[0..4].copy_from_slice(magic);
        h[OFFSET_CONTENT_NONCE..].fill(nonce_byte);
        h
    }

    #[test]
    fn reads_content_nonce_from_valid_header() {
        let h = header_with(&MYA1_MAGIC, 0xAB);
        assert_eq!(
            read_attachment_content_nonce(&h),
            Some([0xAB; AEAD_NONCE_LEN])
        );
    }

    /// The v0.2 half of the reader. Its own case rather than an extra
    /// assertion inside the v0.1 one, so a regression names the generation it
    /// broke: this is the arm whose absence stopped attachment sync dead on
    /// every migrated vault while `MYA1` kept working and every gate stayed
    /// green.
    #[test]
    fn reads_content_nonce_from_v0_2_header() {
        let h = header_with(&MYA5_MAGIC, 0x5A);
        assert_eq!(
            read_attachment_content_nonce(&h),
            Some([0x5A; AEAD_NONCE_LEN])
        );
    }

    #[test]
    fn rejects_wrong_magic_and_short_header() {
        let h = header_with(b"XXXX", 0xAB);
        assert_eq!(read_attachment_content_nonce(&h), None);
        assert_eq!(read_attachment_content_nonce(b"MYA1short"), None);
    }

    #[test]
    fn parse_canonical_id_is_strict() {
        let ok = "ab".repeat(32);
        assert!(parse_canonical_id(&ok).is_some());
        assert!(parse_canonical_id(&"AB".repeat(32)).is_none()); // uppercase
        assert!(parse_canonical_id(&"ab".repeat(31)).is_none()); // short
        assert!(parse_canonical_id(&format!("{}.partial", "ab".repeat(32))).is_none());
    }

    /// The fixture writes through the SEAM, not `std::fs`.
    ///
    /// The rule this follows: a test that stages its files with `std::fs` while
    /// production reads them through `VaultIo` is testing a path production does
    /// not take, and the port it is supposed to prove goes unproven. Here it also
    /// keeps this file OFF the io-seam ratchet, which a `std::fs` fixture alone
    /// would have held it on.
    fn io() -> crate::vault_io::StdVaultIo {
        crate::vault_io::StdVaultIo
    }

    async fn put(io: &dyn crate::vault_io::VaultIo, path: &Path, bytes: &[u8]) {
        io.write(path, bytes, crate::vault_io::WriteOpts::default())
            .await
            .expect("stage fixture through the seam");
    }

    #[test]
    fn scan_skips_non_canonical_and_bad_magic_files() {
        let tmp = crate::test_support::ScopedTempDir::new("attachment-nonce-scan").unwrap();
        let dir = tmp.path();

        crate::test_support::block_on(async {
            let io = io();
            // Canonical blob with valid header.
            let id_hex = "11".repeat(32);
            put(&io, &dir.join(&id_hex), &header_with(&MYA1_MAGIC, 0xCD)).await;
            // Canonical name, wrong magic → skipped.
            put(&io, &dir.join("22".repeat(32)), &header_with(b"NOPE", 0x01)).await;
            // Non-canonical name → skipped.
            put(&io, &dir.join("readme.txt"), b"x").await;

            let manifest = scan_attachments_manifest(&io, dir).await;
            assert_eq!(manifest.len(), 1);
            let entry = manifest.values().next().unwrap();
            assert_eq!(entry.id, [0x11; 32]);
            assert_eq!(entry.sync_id, [0x11; 16]);
            assert_eq!(entry.content_nonce, [0xCD; AEAD_NONCE_LEN]);
        });
    }

    /// Both generations reach the manifest from ONE directory.
    ///
    /// The scan is what the sync cycle's push-detect loop iterates, so a family
    /// missing here is not a degraded push, it is no push at all: the loop runs
    /// zero times and the bodies stay on this device forever, with the catalog
    /// still syncing so other devices show names and sizes over nothing. A
    /// migrated vault holds only `MYA5`, so the mixed directory below is the
    /// weaker case and is deliberately what is asserted: it fails if EITHER
    /// arm is dropped.
    #[test]
    fn scan_accepts_both_attachment_generations() {
        let tmp = crate::test_support::ScopedTempDir::new("attachment-nonce-both").unwrap();
        let dir = tmp.path();

        crate::test_support::block_on(async {
            let io = io();
            let v0_1 = "11".repeat(32);
            let v0_2 = "22".repeat(32);
            put(&io, &dir.join(&v0_1), &header_with(&MYA1_MAGIC, 0xCD)).await;
            put(&io, &dir.join(&v0_2), &header_with(&MYA5_MAGIC, 0x5A)).await;

            let manifest = scan_attachments_manifest(&io, dir).await;
            assert_eq!(manifest.len(), 2, "both generations are manifest entries");
            assert_eq!(
                manifest.get(&[0x22; 16]).map(|e| e.content_nonce),
                Some([0x5A; AEAD_NONCE_LEN]),
                "the MYA5 blob's nonce is read at the shared §9.9 offset"
            );
        });
    }

    /// A blob SHORTER than the header prefix is skipped, not misread.
    ///
    /// New with the seam port and worth its own case: `File::read_exact` failed
    /// outright on a short file, while `read_prefix` is specified to return
    /// fewer bytes than asked for at EOF — "shorter than expected is a normal
    /// answer". So the length check moved from the IO call into
    /// `read_attachment_content_nonce`, and this pins that it is still made. Without
    /// it a truncated blob would read a nonce out of whatever followed.
    #[test]
    fn scan_skips_a_truncated_blob() {
        let tmp = crate::test_support::ScopedTempDir::new("attachment-nonce-short").unwrap();
        let dir = tmp.path();
        crate::test_support::block_on(async {
            let io = io();
            let mut short = header_with(&MYA1_MAGIC, 0xCD);
            short.truncate(ATTACHMENT_HEADER_PREFIX_FOR_NONCE - 1);
            put(&io, &dir.join("11".repeat(32)), &short).await;
            assert!(scan_attachments_manifest(&io, dir).await.is_empty());
        });
    }

    #[test]
    fn scan_of_absent_dir_is_empty() {
        let tmp = crate::test_support::ScopedTempDir::new("attachment-nonce-absent").unwrap();
        crate::test_support::block_on(async {
            assert!(
                scan_attachments_manifest(&io(), &tmp.path().join("missing"))
                    .await
                    .is_empty()
            );
        });
    }
}
