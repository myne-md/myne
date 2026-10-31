// SPDX-License-Identifier: AGPL-3.0
//! The `NTV7` to `NTV8` upgrade, run by the unlock that opens the vault
//! (myne-md/myne#938, `decisions/protocol/0758`, `protocol.md` §10.4.3).
//!
//! This is the first format change in the product that is **silent and
//! automatic**. [`super::ntv7`] warns before it runs because it destroys a
//! credential the user may have written down; this one destroys nothing the user
//! can still use. `NTV7` already zeroed the recovery-phrase wrap, so the only
//! thing the person wrap in that frame can do is open `root_key` to a phrase the
//! user has already typed into this session. Dropping it removes a second way to
//! reach the same key and adds none, which is why §10.4.3 lets a MEMBER's device
//! perform it and why there is no prompt, no banner and no Settings row.
//!
//! **Nothing is derived, re-wrapped or re-signed.** The `NTV8` frame is the
//! `NTV7` frame truncated: bytes `[6..]` of the short frame are bytes `[6..]` of
//! the long one (`protocol::serialize_vault_meta_ntv8`'s central claim).
//!
//! **It runs only on an unlock that PROVED THE PASSWORD** ([`UpgradeAuthority`]).
//! The byte range could be dropped from any session that holds `root_key`, a PIN or
//! biometric unlock included, and this module used to say so with pride. That was
//! wrong, and the reason is a lockout rather than a cryptographic one: the person
//! wrap is the only door for a user who opened the vault with their identity
//! phrase BECAUSE they no longer remember the password, and truncating it during
//! that very unlock destroys the credential they just used. The same holds for a
//! quick-unlock session, which proves a PIN and never the password. So the frame
//! moves on the one credential that survives it, and a vault whose user only ever
//! types a PIN stays `NTV7` until they type their password once. The person wrap is
//! defence in depth, not a correctness requirement: staying on it costs nothing.
//!
//! **One atomic write, no journal, no `legacy/` snapshot.** [`VaultIo::write`] is
//! an atomic replace, so a failure leaves the previous `vault.meta` byte for byte
//! and the vault opens exactly as it did. There is deliberately no backup copy:
//! unlike the `NTV5` to `NTV6` re-key, which replaces every sealed singleton and
//! so needs `legacy/` to undo, this step only ever removes bytes, and the frame it
//! removed is one no reader needs (an `NTV7` frame opens under the same password
//! the `NTV8` frame does, so keeping the old file would preserve nothing the
//! upgrade loses).
//!
//! **The failure is swallowed by every caller, on purpose.** An upgrade that
//! cannot write is not an unlock failure: the user's vault is open, their notes
//! are readable, and the next unlock tries again. Surfacing it would put a
//! filesystem detail in front of a user who has no action to take.

use crate::vault_io::{VaultIo, WriteOpts};
use sha2::{Digest, Sha256};
use std::path::Path;

/// What a committed upgrade changed, for the caller that has to move its own
/// anchor.
#[derive(Debug, Clone, Copy)]
pub struct Ntv8UpgradeOutput {
    /// SHA-256 of the committed `NTV8` bytes. The caller must move its in-memory
    /// CAS anchor to this hash, or the next `change_password` reads this write as
    /// external tampering (`VaultMetaChangedExternally`).
    pub new_meta_hash: [u8; 32],
    /// SHA-256 of the `NTV7` bytes it replaced, so the anchor refresh can be
    /// conditional on the entry still holding what was read.
    pub previous_meta_hash: [u8; 32],
    /// The group-key epoch, carried through untouched. Reported so a caller that
    /// tracks it does not have to re-read the file it just wrote.
    pub group_key_epoch: u64,
}

/// Failure of the automatic `NTV7` to `NTV8` upgrade.
///
/// Deliberately two variants: every caller swallows this, so the only distinction
/// that matters is "the file did not move" (`Io`) versus "the file was not a frame
/// this step can carry" (`InvalidVaultMeta`, which includes an `NTV7` frame whose
/// tail does not parse). A generation that is simply not `NTV7` is not an error;
/// it is [`None`] from [`upgrade_vault_to_ntv8`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ntv8UpgradeError {
    /// `vault.meta` is unreadable, or is an `NTV7` frame whose tail will not parse.
    InvalidVaultMeta,
    /// A filesystem read or write failed. The previous metadata is intact.
    Io,
}

/// Whether `vault.meta` bytes are the generation this step upgrades, already
/// upgraded, or neither.
///
/// The three answers are what keeps the call site honest: `Some(())` is "write",
/// `None` is "nothing to do" (including `NTV8` itself, so a second unlock of an
/// upgraded vault does no work and no write), and the third arm is every other
/// generation, which belongs to a different step and is left alone.
fn needs_upgrade(meta_bytes: &[u8]) -> Option<bool> {
    match meta_bytes.get(..4) {
        Some(magic) if magic == protocol::vault_meta_ntv7::VAULT_META_NTV7_MAGIC.as_slice() => {
            Some(true)
        }
        Some(magic) if magic == protocol::VAULT_META_NTV8_MAGIC.as_slice() => Some(false),
        // `MYV1`, `NTV5` and `NTV6` are all reachable in the field and none of
        // them is this step's business: the first needs the whole-vault v0.1
        // migration, the second the v0.2 migration, and the third `ntv7`'s own
        // explicit upgrade. Anything unrecognised is likewise left alone rather
        // than rewritten from a frame nobody could parse.
        _ => None,
    }
}

/// Whether the unlock that reached this point proved the credential that SURVIVES
/// the upgrade.
///
/// Named rather than a `bool` because the two arms are a policy the review of
/// myne-md/myne#938 changed once already, and a bare `true` at a call site does not
/// say what it is asserting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpgradeAuthority {
    /// The vault password was typed and its wrap AEAD-verified in this call. The
    /// upgrade removes the person wrap and leaves the password wrap, so the
    /// credential the user just proved is the one that remains.
    PasswordProven,
    /// Something else opened the vault: the identity phrase, a quick-unlock PIN, a
    /// biometric, a member's device gate. Each unwraps `root_key` without the
    /// password, so truncating here would delete a door the user may still depend
    /// on. The upgrade waits for a password unlock.
    PasswordNotProven,
}

/// Drop an `NTV7` vault's person wrap, committing an `NTV8` frame.
///
/// Returns `Ok(None)` when there is nothing to do, which is the answer for an
/// already-upgraded vault and for every generation this step does not own.
///
/// **The caller has already proven the frame opens.** This function verifies no
/// credential: it truncates a frame whose password wrap the unlock that called it
/// just AEAD-verified, so a corrupt frame cannot reach the write through this
/// path. It is `pub` for the tests, and a caller that has not unlocked the vault
/// would be using it as a format conversion, which is what
/// [`super::ntv7::upgrade_vault_to_ntv7`]'s explicit path exists for.
///
/// **The caller must hold the shared `auth_permits` permit.** The read, the
/// truncation and the write are one read-modify-write over `vault.meta`, and a
/// `change_password` that committed between the read and the write would be
/// silently reverted to the frame read here. Both call sites are inside the unlock
/// that holds it (`unlock_with_credential`'s tail and `ntv7`'s explicit path, each
/// of which runs under `auth_permits`), and this function deliberately does NOT
/// acquire it again: the permit is capacity 1, so a re-acquire inside a holder
/// would fail and the upgrade would never run.
pub async fn upgrade_vault_to_ntv8(
    io: &dyn VaultIo,
    meta_path: &Path,
) -> Result<Option<Ntv8UpgradeOutput>, Ntv8UpgradeError> {
    let meta_bytes = io.read(meta_path).await.map_err(|_| Ntv8UpgradeError::Io)?;
    match needs_upgrade(&meta_bytes) {
        Some(true) => {}
        Some(false) | None => return Ok(None),
    }

    let ntv7 = protocol::parse_vault_meta_ntv7(&meta_bytes)
        .map_err(|_| Ntv8UpgradeError::InvalidVaultMeta)?;
    let group_key_epoch = ntv7.group_key_epoch;
    // The whole frame, minus the wrap. `as_ntv6_tail`-shaped by construction: the
    // `NTV8` codec is the `NTV7` frame with its trailing person wrap removed, so
    // this is a field-for-field move with nothing derived.
    let frame = protocol::PasswordOnlyVaultMeta {
        base: ntv7.base,
        group_key_nonce: ntv7.group_key_nonce,
        enc_group_key: ntv7.enc_group_key,
        group_key_epoch,
        signed_roster_envelope: ntv7.signed_roster_envelope,
    };
    let bytes = protocol::serialize_vault_meta_ntv8(&frame)
        .map_err(|_| Ntv8UpgradeError::InvalidVaultMeta)?;

    // The new frame has to REACH the other devices, and nothing else will push it:
    // the sync loop's meta phase pushes only when `allow_push` (a content edit
    // advanced the counter) or when this marker is set. The upgrade edits no note,
    // so without it the server keeps the `NTV7` frame and every other device keeps
    // accepting the person wrap the user believes is gone (`protocol.md` §10.4.3
    // point 4 makes the push a MUST, and this is the same marker `ntv7` sets).
    //
    // BEFORE the write, because a marker that cannot be written must stop the
    // upgrade: the other order leaves an `NTV8` frame on disk that nothing will
    // ever push, and the next unlock sees `NTV8` and does no work, so the hole is
    // permanent. Failing here leaves the `NTV7` frame byte for byte and the next
    // unlock retries the whole step (myne-md/myne#938 review).
    let root = meta_path.parent().unwrap_or(meta_path);
    if crate::plugins::sync::state::mark_vault_meta_dirty(io, root)
        .await
        .is_err()
    {
        return Err(Ntv8UpgradeError::Io);
    }

    // The one write. Atomic replace: a failure here leaves the `NTV7` bytes.
    io.write(meta_path, &bytes, WriteOpts::default())
        .await
        .map_err(|_| Ntv8UpgradeError::Io)?;

    Ok(Some(Ntv8UpgradeOutput {
        new_meta_hash: Sha256::digest(&bytes).into(),
        previous_meta_hash: Sha256::digest(&meta_bytes).into(),
        group_key_epoch,
    }))
}

/// The unlock-time entry point: upgrade if needed, then move the session's CAS
/// anchor so the write does not read as tampering.
///
/// Never returns an error and never fails an unlock. `previous_meta_hash` is the
/// hash the unlocking session captured, so [`VaultRuntimeState::refresh_meta_hash_if`]
/// only moves an anchor that still holds the bytes this call read; a concurrent
/// rotation that landed first keeps its own.
///
/// `vault_id` is passed rather than resolved so the caller names the vault it just
/// unlocked: a caller that resolved it again would race a switch.
///
/// [`VaultRuntimeState::refresh_meta_hash_if`]: crate::plugins::vault_unlock::state::VaultRuntimeState::refresh_meta_hash_if
pub async fn upgrade_on_unlock(
    io: &dyn VaultIo,
    meta_path: &Path,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    vault_id: crate::vault_id::VaultId,
    authority: UpgradeAuthority,
) -> Option<Ntv8UpgradeOutput> {
    // The permit is NOT taken here: the caller's unlock already holds the shared
    // `auth_permits` permit for its whole duration, and the semaphore is capacity 1,
    // so a `try_acquire` at this depth would fail every time. See
    // [`upgrade_vault_to_ntv8`]'s precondition.
    if authority == UpgradeAuthority::PasswordNotProven {
        tracing::debug!(
            event = "vault_meta_upgrade_deferred",
            from = "NTV7",
            "the unlock did not prove the password, so the person wrap stays"
        );
        return None;
    }
    match upgrade_vault_to_ntv8(io, meta_path).await {
        Ok(Some(out)) => {
            state
                .refresh_meta_hash_if(vault_id, out.previous_meta_hash, out.new_meta_hash)
                .await;
            // Coarse, no key material, no path: this is the only trace the
            // upgrade leaves, and it is the one an operator needs when a vault's
            // generation is questioned later.
            tracing::info!(
                event = "vault_meta_upgraded",
                from = "NTV7",
                to = "NTV8",
                group_key_epoch = out.group_key_epoch,
                "dropped the person wrap of root_key on unlock"
            );
            Some(out)
        }
        Ok(None) => None,
        Err(_) => {
            // The vault is open and readable either way, so this is a warning
            // rather than an unlock failure, and the next unlock retries.
            tracing::warn!(
                event = "vault_meta_upgrade_failed",
                from = "NTV7",
                to = "NTV8",
                "the person wrap could not be dropped; the vault still opens as NTV7"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let d =
            std::env::temp_dir().join(format!("myne-ntv8-upgrade-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    /// A real `NTV7` frame, minted by the app's own person-session builder, so the
    /// upgrade is exercised against the shape creation actually wrote rather than
    /// a hand-rolled frame that could agree with the reader by accident.
    fn an_ntv7_vault(dir: &Path) -> (Vec<u8>, [u8; 32]) {
        use crate::plugins::vault_creation::commands::{
            build_and_serialize_person_vault_meta, build_person_session,
        };
        use crate::plugins::vault_creation::state::CreationPerson;

        const PHRASE: &str = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

        let person_id = protocol::kdf::person_id_hash(PHRASE);
        let seed = protocol::kdf::derive_person_identity_seed(
            PHRASE,
            &person_id,
            &crate::test_support::FAST_TEST_KDF,
        )
        .expect("identity seed");
        let seeds = protocol::kdf::expand_person_identity_key_seeds(&seed);
        let person = CreationPerson {
            pair: protocol::PersonKeyPair::generate_raw(&seeds.kem, &seeds.ed25519, &seeds.mldsa),
            person_id,
            number: protocol::account_number_from_person_id(&person_id),
        };
        // Captured before the session takes ownership: the public half is what
        // the person wrap is sealed to, and it is the only thing this test needs
        // from the identity after creation.
        let owner_public = person.pair.public_half();
        let session = build_person_session(
            crate::paths::vault_id_from_root(dir),
            "upgrade-pw",
            crate::test_support::FAST_TEST_KDF,
            person,
        )
        .expect("person session");
        // The builder now emits `NTV8`; the vault this test upgrades is the frame
        // an `NTV7` device wrote, which is the same tail with the person wrap
        // re-appended. `serialize_vault_meta_ntv7` refuses a frame whose phrase
        // wrap is live, and the builder already zeroes it.
        let (ntv8, _group) =
            build_and_serialize_person_vault_meta(&session).expect("serialize NTV8");
        let parsed = protocol::parse_vault_meta_ntv8(&ntv8).expect("parse NTV8");
        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        let person_wrap = protocol::seal_root_key_to_person_raw(
            &owner_public,
            &session.root_key,
            &parsed.base.items_key_id,
            &mut rng,
        )
        .expect("seal the person wrap");
        let ntv7 = protocol::serialize_vault_meta_ntv7(&protocol::PersonWrappedVaultMeta {
            base: parsed.base,
            group_key_nonce: parsed.group_key_nonce,
            enc_group_key: parsed.enc_group_key,
            group_key_epoch: parsed.group_key_epoch,
            signed_roster_envelope: parsed.signed_roster_envelope,
            person_wrap,
        })
        .expect("serialize NTV7");
        let hash: [u8; 32] = Sha256::digest(&ntv7).into();
        (ntv7, hash)
    }

    /// The upgrade commits, and it commits the frame the codec says it should:
    /// the same bytes minus the person wrap.
    #[test]
    fn an_ntv7_vault_upgrades_to_the_truncated_frame() {
        block_on(async {
            let dir = temp_dir("commit");
            let meta_path = dir.join("vault.meta");
            let (ntv7, ntv7_hash) = an_ntv7_vault(&dir);
            std::fs::write(&meta_path, &ntv7).unwrap();

            let out = upgrade_vault_to_ntv8(&crate::vault_io::StdVaultIo, &meta_path)
                .await
                .expect("upgrade")
                .expect("an NTV7 vault is upgradable");
            assert_eq!(out.previous_meta_hash, ntv7_hash);

            let after = std::fs::read(&meta_path).unwrap();
            assert_eq!(&after[..4], b"NTV8");
            assert_eq!(out.new_meta_hash, <[u8; 32]>::from(Sha256::digest(&after)));
            // The claim the whole design rests on: the short frame is the long
            // one truncated, so nothing was re-derived, re-wrapped or re-signed.
            assert_eq!(after.len() + protocol::PERSON_WRAP_LEN, ntv7.len());
            assert_eq!(&after[6..], &ntv7[6..after.len()]);
            // And the frame still carries its group tail, so the session keeps the
            // group tier it needs for every shared singleton.
            assert!(protocol::has_b2b_tail(&after));
            assert_eq!(
                protocol::vault_meta_generation(&after),
                protocol::VaultMetaGeneration::PersonNoWrap
            );
        })
    }

    /// The owner's roster and `group_key_epoch` survive the truncation unchanged,
    /// which is the `identity-seat-portability` task 12 criterion stated on its own
    /// rather than left for a reader to infer from a tail slice.
    ///
    /// The test exists because the assertion above is a `&[u8]` comparison and says
    /// nothing about WHICH facts those bytes carry: if a future codec ever moved the
    /// roster or the epoch into the person wrap (or re-derived them), the tail
    /// comparison would still hold for a frame that lost both. Parsing both sides is
    /// what names the two facts, and the byte comparison below then holds them to
    /// byte-identity rather than to `==`.
    #[test]
    fn the_owners_roster_and_group_key_epoch_are_byte_identical_after_the_upgrade() {
        block_on(async {
            let dir = temp_dir("roster");
            let meta_path = dir.join("vault.meta");
            let (ntv7, _hash) = an_ntv7_vault(&dir);
            std::fs::write(&meta_path, &ntv7).unwrap();
            let before = protocol::parse_vault_meta_ntv7(&ntv7).expect("parse NTV7");

            upgrade_vault_to_ntv8(&crate::vault_io::StdVaultIo, &meta_path)
                .await
                .expect("upgrade")
                .expect("an NTV7 vault is upgradable");

            let after_bytes = std::fs::read(&meta_path).unwrap();
            let after = protocol::parse_vault_meta_ntv8(&after_bytes).expect("parse NTV8");
            assert_eq!(after.group_key_epoch, before.group_key_epoch);
            assert_eq!(
                after.signed_roster_envelope, before.signed_roster_envelope,
                "the owner's signed roster is the same bytes: a member's upgrade must not \
                 re-sign or re-order it"
            );
            assert_eq!(after.enc_group_key, before.enc_group_key);
            assert_eq!(after.group_key_nonce, before.group_key_nonce);
        })
    }

    /// A second unlock of an upgraded vault does no work and writes nothing.
    #[test]
    fn an_upgraded_vault_is_left_alone() {
        block_on(async {
            let dir = temp_dir("idempotent");
            let meta_path = dir.join("vault.meta");
            let (ntv7, _) = an_ntv7_vault(&dir);
            std::fs::write(&meta_path, &ntv7).unwrap();
            upgrade_vault_to_ntv8(&crate::vault_io::StdVaultIo, &meta_path)
                .await
                .expect("first upgrade")
                .expect("upgradable");
            let once = std::fs::read(&meta_path).unwrap();

            assert!(
                upgrade_vault_to_ntv8(&crate::vault_io::StdVaultIo, &meta_path)
                    .await
                    .expect("second call")
                    .is_none(),
                "an NTV8 vault reports nothing to do"
            );
            assert_eq!(
                std::fs::read(&meta_path).unwrap(),
                once,
                "and the bytes did not move"
            );
        })
    }

    /// Every other generation is somebody else's step, and is left untouched.
    /// `NTV6` in particular must NOT be truncated here: it has no person wrap to
    /// drop, and the upgrade would be a silent generation claim with nothing
    /// behind it.
    #[test]
    fn the_other_generations_are_not_this_steps_business() {
        block_on(async {
            let dir = temp_dir("others");
            let meta_path = dir.join("vault.meta");
            let (ntv7, _) = an_ntv7_vault(&dir);
            let parsed = protocol::parse_vault_meta_ntv7(&ntv7).unwrap();
            let ntv6 = protocol::serialize_vault_meta_ntv6(&parsed.as_ntv6_tail()).unwrap();
            let ntv5 = protocol::serialize_vault_meta_v0_2(&parsed.base);
            let myv1 = b"MYV1 a v0.1 frame this step does not read".to_vec();

            for (tag, bytes) in [
                ("NTV6", ntv6),
                ("NTV5", ntv5),
                ("MYV1", myv1),
                ("junk", b"nope".to_vec()),
            ] {
                std::fs::write(&meta_path, &bytes).unwrap();
                assert!(
                    upgrade_vault_to_ntv8(&crate::vault_io::StdVaultIo, &meta_path)
                        .await
                        .expect("no error for a generation it does not own")
                        .is_none(),
                    "{tag} is not upgradable by this step"
                );
                assert_eq!(
                    std::fs::read(&meta_path).unwrap(),
                    bytes,
                    "{tag} must be left byte-identical"
                );
            }
        })
    }

    /// The upgrade is REFUSED on an unlock that did not prove the password, and
    /// that refusal is the whole defence against locking a user out.
    ///
    /// The frame can be truncated from any session that holds `root_key`, so the
    /// byte range is not what decides it. What decides it is the credential: the
    /// person wrap is the only door for a user who opened this vault with their
    /// phrase because they no longer know the password, and truncating it during
    /// that very unlock destroys the credential they just used
    /// (myne-md/myne#938 review). Both answers are asserted, in one test, so the
    /// gate cannot pass by never running: the same fixture upgrades under
    /// `PasswordProven`.
    #[test]
    fn an_unlock_that_did_not_prove_the_password_leaves_the_ntv7_frame_alone() {
        block_on(async {
            use crate::plugins::vault_unlock::state::VaultRuntimeState;

            let dir = temp_dir("authority");
            let meta_path = dir.join("vault.meta");
            let (ntv7, _) = an_ntv7_vault(&dir);
            std::fs::write(&meta_path, &ntv7).unwrap();
            let vault_id = crate::paths::vault_id_from_root(&dir);
            let state = VaultRuntimeState::default();

            // A phrase unlock, a PIN unlock and a member gate all answer this.
            assert!(
                upgrade_on_unlock(
                    &crate::vault_io::StdVaultIo,
                    &meta_path,
                    &state,
                    vault_id,
                    UpgradeAuthority::PasswordNotProven,
                )
                .await
                .is_none(),
                "an unlock that did not prove the password must not upgrade"
            );
            assert_eq!(
                std::fs::read(&meta_path).unwrap(),
                ntv7,
                "and it must leave the person wrap on disk, byte for byte: this is the \
                 credential the user just used"
            );

            // The same fixture, one unlock later, with the password proved.
            let out = upgrade_on_unlock(
                &crate::vault_io::StdVaultIo,
                &meta_path,
                &state,
                vault_id,
                UpgradeAuthority::PasswordProven,
            )
            .await
            .expect("a password unlock performs it");
            assert_eq!(
                out.group_key_epoch, 1,
                "the fixture's epoch is carried through"
            );
            let after = std::fs::read(&meta_path).unwrap();
            assert_eq!(
                &after[..4],
                protocol::VAULT_META_NTV8_MAGIC.as_slice(),
                "the deferred upgrade lands on the next password unlock"
            );
        })
    }

    /// The upgrade does not touch the identity session, and that is what makes
    /// "the user does not lose sync by upgrading" a fact rather than an intention.
    ///
    /// The session is seeded and observed HERE rather than through an unlock,
    /// because the unlock has its own session discipline (lock-then-unlock clears
    /// the previous vault's) and a test that entangled the two could not say which
    /// one kept or dropped the session. What is under test is the upgrade: it may
    /// move the CAS anchor and nothing else.
    #[test]
    fn the_upgrade_leaves_the_identity_session_alone() {
        block_on(async {
            use crate::plugins::vault_unlock::state::{PersonSessionInstall, VaultRuntimeState};

            const PHRASE: &str = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

            let dir = temp_dir("session");
            let meta_path = dir.join("vault.meta");
            let (ntv7, _) = an_ntv7_vault(&dir);
            std::fs::write(&meta_path, &ntv7).unwrap();
            let vault_id = crate::paths::vault_id_from_root(&dir);

            let state = VaultRuntimeState::default();
            let person_id = protocol::kdf::person_id_hash(PHRASE);
            let seed = protocol::kdf::derive_person_identity_seed(
                PHRASE,
                &person_id,
                &crate::test_support::FAST_TEST_KDF,
            )
            .expect("identity seed");
            let seeds = protocol::kdf::expand_person_identity_key_seeds(&seed);
            let generation = state.person_session_generation().await;
            assert!(
                state
                    .install_person_session_if_generation(
                        generation,
                        PersonSessionInstall {
                            pair: protocol::PersonKeyPair::generate_raw(
                                &seeds.kem,
                                &seeds.ed25519,
                                &seeds.mldsa,
                            ),
                            person_id,
                            profile: None,
                            transition: None,
                        },
                    )
                    .await,
                "the fixture must install the session it is about to check"
            );
            let session_generation = state.person_session_generation().await;
            assert!(state.person_identity_unlocked().await);

            upgrade_on_unlock(
                &crate::vault_io::StdVaultIo,
                &meta_path,
                &state,
                vault_id,
                UpgradeAuthority::PasswordProven,
            )
            .await
            .expect("the fixture is an NTV7 frame");

            assert!(
                state.person_identity_unlocked().await,
                "the upgrade removed a credential from disk; it must not remove the live session"
            );
            assert!(
                state.clone_person_identity().await.is_some(),
                "the keypair has to survive with the session, or sync signs nothing"
            );
            assert_eq!(
                state.person_session_generation().await,
                session_generation,
                "and nothing may have re-installed or cleared it behind the caller's back"
            );
        })
    }

    /// A failure between the read and the rename leaves the `NTV7` bytes in place
    /// and still openable. The write is the only thing that can fail, so the
    /// injection is a vault root the process cannot write to.
    #[test]
    fn a_failed_write_leaves_the_ntv7_frame_untouched_and_openable() {
        block_on(async {
            let dir = temp_dir("failed-write");
            let meta_path = dir.join("vault.meta");
            let (ntv7, _) = an_ntv7_vault(&dir);
            std::fs::write(&meta_path, &ntv7).unwrap();

            // A `VaultIo` whose write always fails, which is the shape of a
            // read-only disk, a full disk or a permission change mid-unlock.
            // Everything else delegates to the real seam, so the only difference
            // from production is the one call under test.
            struct ReadOnlyIo;
            #[async_trait::async_trait]
            impl crate::vault_io::VaultIo for ReadOnlyIo {
                async fn read(&self, path: &Path) -> crate::vault_io::IoResult<Vec<u8>> {
                    crate::vault_io::StdVaultIo.read(path).await
                }
                async fn read_prefix(
                    &self,
                    path: &Path,
                    len: usize,
                ) -> crate::vault_io::IoResult<Vec<u8>> {
                    crate::vault_io::StdVaultIo.read_prefix(path, len).await
                }
                async fn write(
                    &self,
                    _path: &Path,
                    _bytes: &[u8],
                    _opts: WriteOpts,
                ) -> crate::vault_io::IoResult<()> {
                    Err(myne_format::io_failure_kind::IoFailureKind::NoSpace)
                }
                async fn remove_file(&self, path: &Path) -> crate::vault_io::IoResult<()> {
                    crate::vault_io::StdVaultIo.remove_file(path).await
                }
                async fn remove_dir_all(&self, path: &Path) -> crate::vault_io::IoResult<()> {
                    crate::vault_io::StdVaultIo.remove_dir_all(path).await
                }
                async fn create_dir_all(&self, path: &Path) -> crate::vault_io::IoResult<()> {
                    crate::vault_io::StdVaultIo.create_dir_all(path).await
                }
                async fn read_dir(
                    &self,
                    path: &Path,
                ) -> crate::vault_io::IoResult<Vec<crate::vault_io::DirEntry>> {
                    crate::vault_io::StdVaultIo.read_dir(path).await
                }
                async fn exists(&self, path: &Path) -> crate::vault_io::IoResult<bool> {
                    crate::vault_io::StdVaultIo.exists(path).await
                }
                async fn is_dir(&self, path: &Path) -> crate::vault_io::IoResult<bool> {
                    crate::vault_io::StdVaultIo.is_dir(path).await
                }
                async fn rename(&self, from: &Path, to: &Path) -> crate::vault_io::IoResult<()> {
                    crate::vault_io::StdVaultIo.rename(from, to).await
                }
            }

            assert!(
                matches!(
                    upgrade_vault_to_ntv8(&ReadOnlyIo, &meta_path).await,
                    Err(Ntv8UpgradeError::Io)
                ),
                "a write that fails is reported as Io"
            );
            assert_eq!(
                std::fs::read(&meta_path).unwrap(),
                ntv7,
                "a failed upgrade must leave the vault exactly as it was"
            );
            // Still an `NTV7` frame, so the next unlock opens it and retries.
            assert!(protocol::parse_vault_meta_ntv7(&std::fs::read(&meta_path).unwrap()).is_ok());
        })
    }
}
