// SPDX-License-Identifier: AGPL-3.0
//! Backend-held person identity (B2B identity substrate, myne-md/myne#698).
//!
//! The owner's person keypair lives HERE. in process memory, held by
//! [`crate::plugins::vault_unlock::state::VaultRuntimeState`], and never
//! in frontend JS memory. `sync_person_unlock` populates it once per
//! process from the person's recovery phrase; `sync_person_lock` drops it;
//! `sync_invite_member` reads it without any secret crossing IPC. The
//! master-password-at-unlock precedent applies in full: a credential
//! crosses the bridge exactly once, at the unlock-equivalent moment, and
//! every later operation references the held identity.
//!
//! At rest the keypair is one sealed file,
//! `<app_config_dir>/person_keypair.sealed`, framed as
//! `salt(16) || nonce(24) || ct`. The wrap key derives from the person's
//! OWN normalized recovery phrase under the person salt domain
//! (`"myne.v0.2 argon2id-person-keypair|"`, vault-independent), with the
//! baseline v0.1 KDF cost (one unlock-equivalent Argon2id per process).
//! The OS-keychain convenience carrier (`account::person_key`) is gone:
//! it had no production caller and a second carrier doubles the audit
//! surface for a convenience; the phrase path plus the sealed file cover
//! persistence and recovery with one mechanism.
//!
//! `person_id_hash` (the KDF person domain) derives deterministically
//! from the phrase itself. `SHA-256("myne.person-id|" ||
//! phrase_normalized)[:16]`, so it needs no storage and two different
//! phrases never share a domain.

use crate::host::HostCtx;
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::{PersonKeyPair, DEFAULT_V0_1_KDF_PARAMS};
use std::path::PathBuf;

/// Sealed person-keypair file name under `<app_config_dir>`.
pub const PERSON_KEYPAIR_FILE: &str = "person_keypair.sealed";

/// Lengths of the sealed-file framing:
/// `salt(16) || kdf_params(11) || nonce(24) || ct`.
const SEALED_SALT_LEN: usize = 16;
const SEALED_NONCE_LEN: usize = 24;

/// Person-identity errors. Closed enum, no secret material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersonIdentityError {
    /// The phrase is empty or fails normalization shape.
    BadPhrase,
    /// The sealed file parses but does not open under this phrase
    /// (wrong phrase or tampered file, non-distinguishing, §7.3).
    CannotDecrypt,
    /// Host paths or file IO failed.
    Io,
    /// The OS CSPRNG failed.
    Csprng,
}

/// The person-id hash lives in `protocol` (`kdf::person_id_hash`, the one
/// derivation the `person-keypair` vectors pin); re-exported so this module's
/// callers keep the path they had.
pub use protocol::person_id_hash;

fn sealed_path(host: &dyn HostCtx) -> Result<PathBuf, PersonIdentityError> {
    host.app_config_dir()
        .map(|d| d.join(PERSON_KEYPAIR_FILE))
        .map_err(|_| PersonIdentityError::Io)
}

/// Unlock (or first-enroll) the backend-held person identity from the
/// person's normalized recovery phrase. Reads the sealed file when
/// present (open under the phrase-derived wrap); otherwise generates a
/// fresh keypair, seals it, and persists the frame. Returns the live
/// pair for the caller to store in
/// [`crate::plugins::vault_unlock::state::VaultRuntimeState`].
pub async fn unlock_person_identity(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    phrase_normalized: &str,
) -> Result<PersonKeyPair, PersonIdentityError> {
    if phrase_normalized.trim().is_empty() {
        return Err(PersonIdentityError::BadPhrase);
    }
    let person_id = person_id_hash(phrase_normalized);
    let path = sealed_path(host)?;
    match io.read(&path).await {
        // An all-zero frame is what `delete_sealed_file` leaves behind (VaultIo
        // has no unlink): treat it as absent so a forget-then-reunlock
        // re-enrols rather than failing on the erased bytes.
        Ok(bytes) if is_erased_frame(&bytes) => {
            enroll_fresh(host, io, phrase_normalized, &person_id).await
        }
        Ok(bytes) => open_sealed_file(&bytes, phrase_normalized, &person_id),
        // ONLY a genuinely absent file means "first enrolment". Every other
        // read error (permission, transient IO, partial read) is surfaced,
        // never treated as absence: enrolling over an unreadable-but-present
        // file would mint a NEW keypair, overwrite the only copy of the private
        // halves, and orphan every `itemsKey` wrap sealed to the old
        // fingerprint. That is the default-on-error-reaching-a-write shape.
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => {
            enroll_fresh(host, io, phrase_normalized, &person_id).await
        }
        Err(_) => Err(PersonIdentityError::Io),
    }
}

/// The exact sealed-frame length: `salt(16) || kdf_params(11) || nonce(24) ||
/// ct(plaintext + 32-byte CTX commitment)`.
const SEALED_FRAME_LEN: usize = SEALED_SALT_LEN
    + protocol::KDF_PARAMS_CANONICAL_LEN
    + SEALED_NONCE_LEN
    + protocol::PERSON_PLAINTEXT_LEN
    + 32;

/// A sealed frame erased by [`delete_sealed_file`] is all-zero at EXACTLY
/// `SEALED_FRAME_LEN`. The length is load-bearing: a torn write, a filesystem
/// zero-fill or an OPFS container loss can also produce an all-zero file, and
/// treating one of those as "erased" would re-enrol a NEW keypair over a
/// recoverable frame, orphaning every wrap sealed to the old fingerprint. Only
/// the exact shape the erase writes is absent-equivalent; anything else is
/// surfaced as `CannotDecrypt`.
fn is_erased_frame(bytes: &[u8]) -> bool {
    bytes.len() == SEALED_FRAME_LEN && bytes.iter().all(|b| *b == 0)
}

fn open_sealed_file(
    bytes: &[u8],
    phrase_normalized: &str,
    person_id: &[u8; 16],
) -> Result<PersonKeyPair, PersonIdentityError> {
    if is_erased_frame(bytes) {
        return Err(PersonIdentityError::CannotDecrypt);
    }
    let head = SEALED_SALT_LEN + protocol::KDF_PARAMS_CANONICAL_LEN + SEALED_NONCE_LEN;
    if bytes.len() < head + 32 {
        return Err(PersonIdentityError::CannotDecrypt);
    }
    let mut salt = [0u8; SEALED_SALT_LEN];
    let mut params_bytes = [0u8; protocol::KDF_PARAMS_CANONICAL_LEN];
    let mut nonce = [0u8; SEALED_NONCE_LEN];
    salt.copy_from_slice(&bytes[..SEALED_SALT_LEN]);
    params_bytes.copy_from_slice(
        &bytes[SEALED_SALT_LEN..SEALED_SALT_LEN + protocol::KDF_PARAMS_CANONICAL_LEN],
    );
    nonce.copy_from_slice(&bytes[SEALED_SALT_LEN + protocol::KDF_PARAMS_CANONICAL_LEN..head]);
    let ct = &bytes[head..];
    // The params ride the frame, exactly as `vault.meta` carries its own: a
    // later baseline bump must not strand an existing sealed keypair, which it
    // would if the reader re-derived under a hardcoded default.
    let params = protocol::parse_kdf_params(&params_bytes)
        .map_err(|_| PersonIdentityError::CannotDecrypt)?;
    // Validate BEFORE allocating: a tampered frame could declare an
    // unaffordable `m_kib` and OOM the device inside Argon2id, before any AEAD
    // check can fire. Every other unlock path validates here.
    protocol::validate_kdf_params(&params).map_err(|_| PersonIdentityError::CannotDecrypt)?;
    let wrap_key = protocol::derive_person_keypair_wrap_key_from_normalized(
        phrase_normalized,
        &salt,
        person_id,
        &params,
    )
    .map_err(|_| PersonIdentityError::CannotDecrypt)?;
    PersonKeyPair::open(&wrap_key, &nonce, ct).map_err(|_| PersonIdentityError::CannotDecrypt)
}

async fn enroll_fresh(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    phrase_normalized: &str,
    person_id: &[u8; 16],
) -> Result<PersonKeyPair, PersonIdentityError> {
    let pair = PersonKeyPair::generate().map_err(|_| PersonIdentityError::Csprng)?;
    let mut salt = [0u8; SEALED_SALT_LEN];
    getrandom::getrandom(&mut salt).map_err(|_| PersonIdentityError::Csprng)?;
    let params = DEFAULT_V0_1_KDF_PARAMS;
    let wrap_key = protocol::derive_person_keypair_wrap_key_from_normalized(
        phrase_normalized,
        &salt,
        person_id,
        &params,
    )
    .map_err(|_| PersonIdentityError::CannotDecrypt)?;
    let (nonce, ct) = pair
        .seal(&wrap_key)
        .map_err(|_| PersonIdentityError::CannotDecrypt)?;
    let params_bytes = protocol::serialize_kdf_params(&params);
    let mut frame = Vec::with_capacity(
        SEALED_SALT_LEN + protocol::KDF_PARAMS_CANONICAL_LEN + SEALED_NONCE_LEN + ct.len(),
    );
    frame.extend_from_slice(&salt);
    frame.extend_from_slice(&params_bytes);
    frame.extend_from_slice(&nonce[..]);
    frame.extend_from_slice(&ct);
    let path = sealed_path(host)?;
    io.write(&path, &frame, WriteOpts::default())
        .await
        .map_err(|_| PersonIdentityError::Io)?;
    Ok(pair)
}

/// Delete the sealed person-keypair file (person off-boarding from this
/// device). The in-memory identity is dropped by the caller holding the
/// state lock. VaultIo exposes no delete: overwrite with zeros and leave
/// the inert frame. The plaintext never lived here (AEAD-sealed), so a
/// zeroed same-length frame leaks nothing beyond length.
pub async fn delete_sealed_file(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<(), PersonIdentityError> {
    let path = sealed_path(host)?;
    match io.read(&path).await {
        Ok(bytes) => {
            io.write(&path, &vec![0u8; bytes.len()], WriteOpts::default())
                .await
                .map_err(|_| PersonIdentityError::Io)?;
            Ok(())
        }
        // A genuinely absent file is already erased. Any OTHER read error is
        // surfaced: swallowing it would report success while the private halves
        // stay on disk, the one place a silent IO error leaves secret material
        // behind.
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => Ok(()),
        Err(_) => Err(PersonIdentityError::Io),
    }
}

/// Lowercase hex encode (the fingerprint rendering the UI compares).
pub fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::new();
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn person_id_is_deterministic_and_phrase_bound() {
        let a = person_id_hash("word ".repeat(24).trim());
        let b = person_id_hash("word ".repeat(24).trim());
        let c = person_id_hash("other ".repeat(24).trim());
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn sealed_frame_rejects_truncation_closed() {
        let person_id = person_id_hash("word ".repeat(24).trim());
        assert!(open_sealed_file(&[0u8; 10], "word ".repeat(24).trim(), &person_id).is_err());
    }
}
