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
pub const PERSON_KEY_TRANSITION_FILE: &str = "person_key_transition.pending";

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

fn pending_transition_path(host: &dyn HostCtx) -> Result<PathBuf, PersonIdentityError> {
    host.app_config_dir()
        .map(|d| d.join(PERSON_KEY_TRANSITION_FILE))
        .map_err(|_| PersonIdentityError::Io)
}

async fn write_pending_transition(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    bytes: &[u8],
) -> Result<(), PersonIdentityError> {
    let dir = host.app_config_dir().map_err(|_| PersonIdentityError::Io)?;
    io.create_dir_all(&dir)
        .await
        .map_err(|_| PersonIdentityError::Io)?;
    let path = pending_transition_path(host)?;
    io.write(&path, bytes, WriteOpts::default())
        .await
        .map_err(|_| PersonIdentityError::Io)
}

pub async fn read_pending_person_key_transition(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
) -> Result<Option<Vec<u8>>, PersonIdentityError> {
    let path = pending_transition_path(host)?;
    match io.read(&path).await {
        Ok(bytes) if bytes.is_empty() => Err(PersonIdentityError::CannotDecrypt),
        Ok(bytes) => Ok(Some(bytes)),
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => Ok(None),
        Err(_) => Err(PersonIdentityError::Io),
    }
}

/// Unlock (or first-enroll) the backend-held person identity from the
/// person's normalized recovery phrase.
///
/// The keypair is DETERMINISTIC from the phrase (`decisions/protocol/0604`), so
/// the sealed file is a cache of the derived key rather than its sole carrier.
/// A sealed file holding a legacy CSPRNG identity is migrated in place: the
/// derived pair replaces it and the SUPERSEDED key double-signs a
/// `myne.person-key-transition v1|` record, returned for the caller to publish
/// into the rosters the person belongs to. Nothing changes silently.
///
/// Returns the pair to hold plus, when a migration happened, the encoded signed
/// transition record.
pub async fn unlock_person_identity(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    phrase_normalized: &str,
) -> Result<(PersonKeyPair, Option<Vec<u8>>), PersonIdentityError> {
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
            let pair = enroll_fresh(host, io, phrase_normalized, &person_id).await?;
            Ok((pair, None))
        }
        Ok(bytes) => {
            let old = open_sealed_file(&bytes, phrase_normalized, &person_id)?;
            let (new, transition) = migrate_pair(&old, phrase_normalized, &person_id)?;
            if let Some(ref bytes) = transition {
                write_pending_transition(host, io, bytes).await?;
            }
            if transition.is_some() {
                // Re-seal the derived key so the file is a cache of it. The wrap
                // salt is fresh and random; the KEY is deterministic.
                seal_pair_to_file(host, io, phrase_normalized, &person_id, &new).await?;
            }
            Ok((new, transition))
        }
        // ONLY a genuinely absent file means "first enrolment". Every other
        // read error (permission, transient IO, partial read) is surfaced,
        // never treated as absence: enrolling over an unreadable-but-present
        // file would mint a NEW keypair, overwrite the only copy of the private
        // halves, and orphan every `itemsKey` wrap sealed to the old
        // fingerprint. That is the default-on-error-reaching-a-write shape.
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => {
            let pair = enroll_fresh(host, io, phrase_normalized, &person_id).await?;
            Ok((pair, None))
        }
        Err(_) => Err(PersonIdentityError::Io),
    }
}

pub async fn open_person_identity_without_mutation(
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
        Ok(bytes) if !is_erased_frame(&bytes) => {
            open_sealed_file(&bytes, phrase_normalized, &person_id)
        }
        Ok(_) | Err(crate::io_failure_kind::IoFailureKind::NotFound) => {
            Err(PersonIdentityError::CannotDecrypt)
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

/// The deterministic person keypair from the phrase: derive the identity seed,
/// expand it into the three key-type seeds, and build the pair. A pure function
/// of the phrase and the phrase-derived person id.
fn deterministic_pair(
    phrase_normalized: &str,
    person_id: &[u8; 16],
) -> Result<PersonKeyPair, PersonIdentityError> {
    let seed = protocol::kdf::derive_person_identity_seed(
        phrase_normalized,
        person_id,
        &DEFAULT_V0_1_KDF_PARAMS,
    )
    .map_err(|_| PersonIdentityError::CannotDecrypt)?;
    let seeds = protocol::kdf::expand_person_identity_key_seeds(&seed);
    Ok(PersonKeyPair::generate_raw(
        &seeds.kem,
        &seeds.ed25519,
        &seeds.mldsa,
    ))
}

/// Migrate an opened keypair to the deterministic derivation. Returns the pair
/// to adopt and, when the fingerprint changed, the encoded signed transition
/// record. A legacy CSPRNG identity migrates once; an already-deterministic one
/// is a no-op.
fn migrate_pair(
    old: &PersonKeyPair,
    phrase_normalized: &str,
    person_id: &[u8; 16],
) -> Result<(PersonKeyPair, Option<Vec<u8>>), PersonIdentityError> {
    let new = deterministic_pair(phrase_normalized, person_id)?;
    if new.fingerprint() == old.fingerprint() {
        return Ok((new, None));
    }
    let old_public = old.public_half();
    let payload = protocol::person_invite::PersonKeyTransitionPayload {
        old_kem_ek: *old_public.kem_ek(),
        old_ed_pk: *old_public.ed_pk(),
        old_mldsa_vk: *old_public.mldsa_vk(),
        new_fingerprint: *new.fingerprint(),
    };
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let signed = protocol::person_invite::sign_person_key_transition(old, &payload, &mut rng)
        .map_err(|_| PersonIdentityError::Csprng)?;
    let bytes = protocol::person_invite::encode_signed_person_key_transition(&signed)
        .ok_or(PersonIdentityError::Csprng)?;
    Ok((new, Some(bytes)))
}

/// Seal a keypair to `<app_config_dir>/person_keypair.sealed` as
/// `salt(16) || kdf_params(11) || nonce(24) || ct`.
async fn seal_pair_to_file(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    phrase_normalized: &str,
    person_id: &[u8; 16],
    pair: &PersonKeyPair,
) -> Result<(), PersonIdentityError> {
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
    Ok(())
}

/// First enrolment: derive the deterministic pair, seal it, and return it.
async fn enroll_fresh(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    phrase_normalized: &str,
    person_id: &[u8; 16],
) -> Result<PersonKeyPair, PersonIdentityError> {
    let pair = deterministic_pair(phrase_normalized, person_id)?;
    seal_pair_to_file(host, io, phrase_normalized, person_id, &pair).await?;
    Ok(pair)
}

/// Whether this device already holds a **recoverable** sealed keypair, i.e.
/// whether [`unlock_person_identity`] would re-open an existing identity rather
/// than enrol a fresh one.
///
/// The question a caller actually needs is "did *I* create that file?", and it
/// cannot be read off [`unlock_person_identity`]'s result: a fresh enrolment and
/// a legacy-CSPRNG re-enrol are indistinguishable from outside it, and only the
/// file itself distinguishes them. So this is asked BEFORE enrolling.
///
/// Two answers are deliberately chosen to fail safe toward *keeping* an
/// identity. A frame [`delete_sealed_file`] erased counts as ABSENT, so a
/// forget-then-reunlock still re-enrols instead of reporting a phantom one. An
/// unreadable-but-present frame counts as PRESENT, so a caller gating an erase
/// on `!sealed_keypair_present(...)` declines to erase what it could not read —
/// and `unlock_person_identity` surfaces that read error rather than overwriting
/// it, which is the "default-on-error-reaching-a-write" shape its own comment on
/// the `Ok(bytes)` arm warns against.
pub async fn sealed_keypair_present(host: &dyn HostCtx, io: &dyn VaultIo) -> bool {
    let Ok(path) = sealed_path(host) else {
        return true;
    };
    match io.read(&path).await {
        Ok(bytes) => !is_erased_frame(&bytes),
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => false,
        Err(_) => true,
    }
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
        }
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => {}
        Err(_) => return Err(PersonIdentityError::Io),
    }
    let pending = pending_transition_path(host)?;
    match io.remove_file(&pending).await {
        Ok(()) | Err(crate::io_failure_kind::IoFailureKind::NotFound) => Ok(()),
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

    #[test]
    fn deterministic_pair_is_stable_and_phrase_bound() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let a = deterministic_pair(phrase, &person_id_hash(phrase)).expect("a");
        let b = deterministic_pair(phrase, &person_id_hash(phrase)).expect("b");
        assert_eq!(a.fingerprint(), b.fingerprint());
        let other =
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
        let c = deterministic_pair(other, &person_id_hash(other)).expect("c");
        assert_ne!(a.fingerprint(), c.fingerprint());
    }

    #[test]
    fn migrate_pair_migrates_a_legacy_csprng_identity_visibly() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let person_id = person_id_hash(phrase);
        let legacy = PersonKeyPair::generate_raw(&[9u8; 64], &[9u8; 32], &[9u8; 32]);
        let (new, transition) = migrate_pair(&legacy, phrase, &person_id).expect("migrate");
        assert_eq!(
            new.fingerprint(),
            deterministic_pair(phrase, &person_id)
                .expect("deterministic")
                .fingerprint()
        );
        assert_ne!(
            new.fingerprint(),
            legacy.fingerprint(),
            "the fingerprint must change, and not silently"
        );
        let bytes = transition.expect("a migration emits a transition record");
        let signed =
            protocol::person_invite::decode_signed_person_key_transition(&bytes).expect("decodes");
        let (old_fp, new_fp) =
            protocol::person_invite::verify_person_key_transition(&signed).expect("verifies");
        assert_eq!(&old_fp, legacy.fingerprint());
        assert_eq!(&new_fp, new.fingerprint());
    }

    #[test]
    fn migrate_pair_is_a_noop_for_a_deterministic_identity() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let person_id = person_id_hash(phrase);
        let pair = deterministic_pair(phrase, &person_id).expect("deterministic");
        let (new, transition) = migrate_pair(&pair, phrase, &person_id).expect("migrate");
        assert_eq!(new.fingerprint(), pair.fingerprint());
        assert!(transition.is_none(), "no migration means no transition");
    }

    #[test]
    fn pending_transition_survives_a_device_local_round_trip() {
        crate::test_support::block_on(async {
            let temp =
                crate::test_support::ScopedTempDir::new("person-transition").expect("temp dir");
            let host = crate::host::test_host::TestHost::new(temp.path());
            let io = crate::vault_io::StdVaultIo;
            let bytes = vec![1u8, 3, 3, 7];
            write_pending_transition(&host, &io, &bytes)
                .await
                .expect("write");
            assert_eq!(
                read_pending_person_key_transition(&host, &io)
                    .await
                    .expect("read"),
                Some(bytes)
            );
            delete_sealed_file(&host, &io).await.expect("delete");
            assert_eq!(
                read_pending_person_key_transition(&host, &io)
                    .await
                    .expect("read"),
                None
            );
        });
    }
}
