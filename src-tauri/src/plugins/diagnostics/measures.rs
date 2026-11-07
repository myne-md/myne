// SPDX-License-Identifier: AGPL-3.0
//! The readings the diagnostic block cannot take in the WebView
//! (myne-md/myne#991).
//!
//! Two fields of that block have no page-side source on desktop, and this module
//! is where the host answers them:
//!
//! | Field | Why the page cannot answer it |
//! |---|---|
//! | `bundleHash` | a digest must be computed from the running artefact, and an artefact cannot contain the digest of its own bytes |
//! | `storageUsedMb` + `storageEntries` | `navigator.storage.estimate()` measures the WebView's own origin store, and a desktop vault is a directory of `.myn` files outside it |
//!
//! The vault half is one call to [`myne_core::vault_sweep::footprint`], which is
//! also what `vault_repair` counts with: one walk, one rule about symlinks, one
//! answer to what "the size of a vault directory" means.
//!
//! # What the digest IS, and what it is not
//!
//! It is the SHA-256 of the running executable: the code payload of the
//! installed bundle. It is **not** the digest of the installer artefact: a
//! `.dmg`, `.deb`, `AppImage` or `.msi` hashes differently from the program
//! inside it, so it does not match a published `SHA256SUMS`, and nobody should
//! try. What it answers is the question the block is read for: are these two
//! reports from the same build, and did the binary under this version string
//! change.

use protocol::hex::encode_lower;
use std::path::Path;

/// The prefix the block prints before a SHA-256 digest.
///
/// The same spelling `version.json` uses for a served bundle's hash, so one
/// block line reads the same way on both clients. What the value COVERS differs
/// (a served bundle on web, the running executable on desktop), which
/// `crate::plugins::diagnostics::commands::build_digest` states and the block's
/// own documentation repeats.
pub(crate) const DIGEST_PREFIX: &str = "sha256:";

/// The lowercase-hex SHA-256 of one file, with the block's prefix.
///
/// The hashing itself is [`crate::file_digest::sha256_of_file`], shared with the
/// model store's weights fingerprint: this function is the formatter the block
/// wants, not a second read loop.
pub(crate) fn digest_of_file(path: &Path) -> std::io::Result<String> {
    let digest = crate::file_digest::sha256_of_file(path)?;
    let mut formatted = String::with_capacity(DIGEST_PREFIX.len() + 64);
    formatted.push_str(DIGEST_PREFIX);
    formatted.push_str(&encode_lower(&digest));
    Ok(formatted)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The expectation is a value, not "some hex came back": `"abc"` is the
    /// canonical SHA-256 vector, and the prefix is what the block prints.
    #[test]
    fn the_digest_is_prefixed_and_lowercase_hex() {
        let dir =
            std::env::temp_dir().join(format!("myne-diagnostics-digest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("payload");
        std::fs::write(&file, b"abc").expect("write");
        assert_eq!(
            digest_of_file(&file).expect("digest"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The wire shape the page reads, pinned in the crate that owns it.
    ///
    /// Without this, a rename or a `#[serde(rename_all = ...)]` on
    /// `vault_sweep::Footprint` breaks both storage lines on every desktop build
    /// while every TypeScript test stays green: those fixtures state their own
    /// copy of the field names, so the fixture is the contract they check.
    #[test]
    fn the_footprint_wire_shape_is_the_one_the_page_reads() {
        let value = serde_json::to_value(myne_core::vault_sweep::Footprint {
            entries: 3,
            bytes: 9,
        })
        .expect("serialize the footprint");
        assert_eq!(value, serde_json::json!({ "entries": 3, "bytes": 9 }));
    }
}
