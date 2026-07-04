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
//! `crate::search::persist::{NonceManifest, …}` /
//! `crate::plugins::notes::search_sync::scan_on_disk_manifest` path keeps
//! resolving.

use crate::plugins::notes::commands::enumerate_notes_dir;
use protocol::AEAD_NONCE_LEN;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

/// `.myn` magic — sourced from `protocol::blob` (protocol.md §9.2 offset 0) so
/// a header-format change can't silently rot this decryption-free reader.
const MYN_MAGIC: [u8; 4] = *protocol::blob::MAGIC;
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
/// `None` if too short or the magic is wrong (not a `.myn`).
pub fn read_myn_content_nonce(header: &[u8]) -> Option<[u8; MYN_CONTENT_NONCE_LEN]> {
    if header.len() < MYN_HEADER_PREFIX_FOR_NONCE {
        return None;
    }
    if header[0..4] != MYN_MAGIC {
        return None;
    }
    let mut nonce = [0u8; MYN_CONTENT_NONCE_LEN];
    nonce.copy_from_slice(&header[MYN_CONTENT_NONCE_OFFSET..MYN_HEADER_PREFIX_FOR_NONCE]);
    Some(nonce)
}

/// Read a single `.myn` file's `content_nonce` from its header WITHOUT
/// decrypting — only the first [`MYN_HEADER_PREFIX_FOR_NONCE`] bytes are
/// read. `None` on any IO failure / short file / bad magic.
fn read_header_nonce(path: &Path) -> Option<[u8; MYN_CONTENT_NONCE_LEN]> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut header = [0u8; MYN_HEADER_PREFIX_FOR_NONCE];
    file.read_exact(&mut header).ok()?;
    read_myn_content_nonce(&header)
}

/// Build the on-disk staleness manifest (`note_id → content_nonce`) by
/// scanning every `.myn` header in `notes_dir` — the decryption-free
/// staleness signal diffed against a persisted manifest. Shared by the search
/// index's `MYS1` persistence and the vault-indices `MYI1` persistence
/// (MYND-271), which diff the identical `.myn` `content_nonce` signal. An
/// unreadable dir yields an empty manifest (treated as "no notes" — hydrate
/// then drops everything from a loaded blob, persist writes an empty snapshot).
pub fn scan_on_disk_manifest(notes_dir: &Path) -> NonceManifest {
    let mut manifest = NonceManifest::new();
    let Ok(ids) = enumerate_notes_dir(notes_dir) else {
        return manifest;
    };
    for id in ids {
        let id_str = id.as_uuid().to_string();
        let path = notes_dir.join(format!("{id_str}.myn"));
        if let Some(nonce) = read_header_nonce(&path) {
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
}
