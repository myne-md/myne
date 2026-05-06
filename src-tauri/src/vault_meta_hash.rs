//! SHA-256 over `vault.meta` bytes — the CAS anchor for `Slot::Unlocked`'s
//! `vault_meta_bytes_hash` field and the in-pipeline disk integrity check.
//!
//! Single source of truth for the hash construction. Pre-MYND-22 this
//! 4-line `Sha256::new(); h.update(...); h.finalize().into()` was
//! duplicated at 8 sites across `vault_unlock`, `vault_recover`, and
//! `vault_change_password` (production + test code). Lifted to a
//! shared helper during the MYND-22 `/simplify` pass.
//!
//! Public material — SHA-256 of public bytes is itself public; no
//! Zeroize wrap on the output.

use sha2::{Digest, Sha256};

/// `SHA-256(bytes)` returning the bare 32-byte digest. Used wherever
/// the `Slot::Unlocked.vault_meta_bytes_hash` CAS anchor needs to be
/// computed (unlock-time read, post-rewrite verify, change_password
/// disk CAS check, integration-test fixtures).
pub(crate) fn vault_meta_sha256(bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().into()
}
