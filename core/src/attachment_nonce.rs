// SPDX-License-Identifier: AGPL-3.0
//! Decryption-free `MYA1` `content_nonce` primitives — the attachment twin of
//! [`crate::note_nonce`] (MYND-468).
//!
//! An `MYA1` header carries the attachment's `content_nonce` in the clear at a
//! fixed offset (`protocol.md` §9.9: the wrapped attachment-key segment is
//! fixed-width, so the offset never varies). Attachments are immutable per id,
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
/// Minimum `MYA1` header bytes needed to read `content_nonce`.
pub const MYA1_HEADER_PREFIX_FOR_NONCE: usize = OFFSET_CONTENT_NONCE + AEAD_NONCE_LEN;
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

/// Read an `MYA1` file's `content_nonce` from its header bytes WITHOUT
/// decrypting. `header` must be at least the first
/// [`MYA1_HEADER_PREFIX_FOR_NONCE`] bytes; `None` if too short or the magic
/// is wrong (not an `MYA1`).
pub fn read_mya1_content_nonce(header: &[u8]) -> Option<[u8; AEAD_NONCE_LEN]> {
    if header.len() < MYA1_HEADER_PREFIX_FOR_NONCE {
        return None;
    }
    if header[0..4] != MYA1_MAGIC {
        return None;
    }
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&header[OFFSET_CONTENT_NONCE..MYA1_HEADER_PREFIX_FOR_NONCE]);
    Some(nonce)
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

/// Scan `attachments_dir` for canonical `MYA1` blobs and build the sync-plane
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
                MYA1_HEADER_PREFIX_FOR_NONCE,
            )
            .await
        else {
            continue;
        };
        let Some(content_nonce) = read_mya1_content_nonce(&header) else {
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
        let mut h = vec![0u8; MYA1_HEADER_PREFIX_FOR_NONCE];
        h[0..4].copy_from_slice(magic);
        h[OFFSET_CONTENT_NONCE..].fill(nonce_byte);
        h
    }

    #[test]
    fn reads_content_nonce_from_valid_header() {
        let h = header_with(&MYA1_MAGIC, 0xAB);
        assert_eq!(read_mya1_content_nonce(&h), Some([0xAB; AEAD_NONCE_LEN]));
    }

    #[test]
    fn rejects_wrong_magic_and_short_header() {
        let h = header_with(b"XXXX", 0xAB);
        assert_eq!(read_mya1_content_nonce(&h), None);
        assert_eq!(read_mya1_content_nonce(b"MYA1short"), None);
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

    /// A blob SHORTER than the header prefix is skipped, not misread.
    ///
    /// New with the seam port and worth its own case: `File::read_exact` failed
    /// outright on a short file, while `read_prefix` is specified to return
    /// fewer bytes than asked for at EOF — "shorter than expected is a normal
    /// answer". So the length check moved from the IO call into
    /// `read_mya1_content_nonce`, and this pins that it is still made. Without
    /// it a truncated blob would read a nonce out of whatever followed.
    #[test]
    fn scan_skips_a_truncated_blob() {
        let tmp = crate::test_support::ScopedTempDir::new("attachment-nonce-short").unwrap();
        let dir = tmp.path();
        crate::test_support::block_on(async {
            let io = io();
            let mut short = header_with(&MYA1_MAGIC, 0xCD);
            short.truncate(MYA1_HEADER_PREFIX_FOR_NONCE - 1);
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
