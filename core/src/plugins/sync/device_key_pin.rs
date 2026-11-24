// SPDX-License-Identifier: AGPL-3.0-only
//! Device signing key, **rung 3** of the storage ladder: a `0600` file sealed by a
//! user PIN (`decisions/protocol/0733` decision 4).
//!
//! # Why this rung exists at all
//!
//! Rungs 1 and 2 are OS stores. Where neither exists (a Linux session with no
//! Secret Service, a platform whose keychain the build does not reach) the ladder
//! offers a choice, and it is the user's: a PIN-protected file, or no device key
//! on that machine at all. **A plaintext file is not a rung**: a signing key any
//! process running as the user can read is worse than the phrase entry the device
//! key would save, because it is attribution forgery for the cost of a `cat`.
//!
//! # What it seals, and what a PIN is worth
//!
//! The payload is the device key plaintext (both private seeds), sealed under
//! [`protocol::kdf::derive_device_key_pin_wrap_key`], Argon2id over the PIN with the
//! vault's memory-hard parameter set, under the
//! `"myne.v0.2 argon2id-device-key-pin|"` salt domain. That memory-hardness is the
//! **only** offline bound: a 6-digit PIN is ~10^6 candidates, so an attacker
//! holding a copy of the file is bounded by Argon2id's cost per candidate, not by
//! the counter below.
//!
//! The attempt counter ([`super::super::quick_unlock::attempt`]) therefore bounds
//! the **online** attacker typing at the keyboard, exactly as it does for
//! quick-unlock, and it inherits that module's documented limit: a copied file
//! carries a copy of the counter, and a tampered counter can only make this rung
//! *stricter* (the threshold is a code constant, and a corrupt counter is read as
//! "cap reached").
//!
//! # What losing it costs
//!
//! Nothing but attribution. A device key unwraps no content, so a wipe at the cap
//! costs the device its ability to author heads until it re-binds; it never costs
//! a note. That is why this rung may destroy itself, which would be unthinkable
//! for a vault credential.
//!
//! # The file
//!
//! Magic-less JSON like the other device-local sealed stores (`vault.member-unlock`),
//! because this is not a vault artefact and never leaves the device: there is no
//! generation to tell apart and nothing to migrate. `0600` via
//! [`crate::vault_io::WriteOpts`], and the AEAD tag is the integrity check: no
//! separate MAC.
//!
//! The seal carries a role AAD
//! ([`protocol::aad_device_key_pin_store`]) binding the envelope version and the KDF
//! parameter set, and it deliberately binds no vault id: this file is device-scoped
//! and outlives every vault on the machine. It used to seal with a zero-length AAD,
//! which no other production seal site in the tree does (myne-md/myne#938 review).

use std::path::{Path, PathBuf};

use protocol::device_key::{DeviceKeyPair, DEVICE_KEY_PLAINTEXT_LEN};
use protocol::hex::{decode_lower, decode_lower_vec, encode_lower};
use protocol::KdfParams;
use zeroize::Zeroizing;

use crate::plugins::quick_unlock::attempt::{
    encode_attempt_count, parse_attempt_count, AttemptOutcome, AttemptState,
};
use crate::vault_io::{VaultIo, WriteOpts};

/// The sealed key, inside the device config directory (device-scoped, so it sits
/// beside `sync-config.json` rather than under any vault root).
pub const DEVICE_KEY_PIN_FILE: &str = "device-key.sealed";

/// The consecutive-failure counter for the file above. Its own file, not a field
/// in the envelope: a write to the envelope is a re-seal, and a re-seal must not
/// be able to reset the counter.
pub const DEVICE_KEY_PIN_ATTEMPTS_FILE: &str = "device-key.attempts";

/// Envelope version. Bumped only if the shape below changes; a v1 reader refuses
/// a version it does not know rather than guessing.
const ENVELOPE_VERSION: u8 = 1;

#[derive(serde::Serialize, serde::Deserialize)]
struct Envelope {
    version: u8,
    m_kib: u32,
    t: u32,
    p: u8,
    argon2_version: u8,
    salt_hex: String,
    nonce_hex: String,
    sealed_hex: String,
}

/// Why the PIN rung could not be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKeyPinError {
    /// No sealed key at this path. The ordinary state before the user opts in.
    Absent,
    /// The PIN did not open the file. `remaining` counts down to the wipe.
    WrongPin { remaining: u32 },
    /// The attempt cap was reached, so the sealed key and its counter were
    /// destroyed. The device falls back to the person key (rung 4) and re-binds
    /// when the user sets a new PIN.
    Wiped,
    /// The file is present but not a well-formed envelope, or its declared version
    /// is not one this build writes.
    Corrupt,
    /// The filesystem refused the read or the write.
    Io,
    /// The key had to be destroyed and the filesystem refused the erase, so a
    /// sealed file this build has just decided is unusable may still be on disk.
    /// Distinct from [`Io`](Self::Io) because the caller's next action differs:
    /// `Io` is retried, this one is reported to the user as a key that could not
    /// be removed (myne-md/myne#938 review).
    WipeFailed,
    /// Argon2id refused the parameters (a tampered envelope, or a hostile `m_kib`).
    Kdf,
    /// The OS entropy source failed while sealing.
    Csprng,
}

fn sealed_path(dir: &Path) -> PathBuf {
    dir.join(DEVICE_KEY_PIN_FILE)
}

fn attempts_path(dir: &Path) -> PathBuf {
    dir.join(DEVICE_KEY_PIN_ATTEMPTS_FILE)
}

/// Whether a PIN-sealed device key exists here. Drives the surface that offers the
/// PIN ceremony: present means "ask for the PIN", absent means "offer to set one".
pub async fn is_sealed(io: &dyn VaultIo, dir: &Path) -> bool {
    io.exists(&sealed_path(dir)).await.unwrap_or(false)
}

/// Seal `pair` under `pin` and write it, replacing any previous file.
///
/// `params` must be the vault's own memory-hard set, not a cheaper one: the
/// parameters are written into the envelope so a later open uses what the seal
/// used, and reading a *weaker* set back would be a downgrade an attacker could
/// arrange by rewriting the envelope. Two things stop that: the parameters are an
/// input to the Argon2id derivation, so a rewritten set derives a different wrap
/// key and fails the tag, and they are bound into the AAD as well so the frame
/// states the property instead of relying on the derivation order.
pub async fn seal(
    io: &dyn VaultIo,
    dir: &Path,
    pin: &str,
    params: &KdfParams,
    pair: &DeviceKeyPair,
) -> Result<(), DeviceKeyPinError> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; protocol::AEAD_NONCE_LEN];
    getrandom::getrandom(&mut salt).map_err(|_| DeviceKeyPinError::Csprng)?;
    getrandom::getrandom(&mut nonce).map_err(|_| DeviceKeyPinError::Csprng)?;

    // The parameters come from the caller, and a weak set is refused rather than
    // written: they are bound into the AAD below AND feed the derivation, so a
    // rewritten envelope fails the tag, but a caller that sealed under a weak set
    // would have produced a file that opens under one.
    protocol::validate_kdf_params(params).map_err(|_| DeviceKeyPinError::Kdf)?;

    let key = protocol::kdf::derive_device_key_pin_wrap_key(pin, &salt, params)
        .map_err(|_| DeviceKeyPinError::Kdf)?;
    let plaintext = Zeroizing::new(pair.to_plaintext_bytes());
    let aad = protocol::aad_device_key_pin_store(ENVELOPE_VERSION, params);
    let sealed = protocol::aead_seal_ctx(&key, &nonce, plaintext.as_slice(), &aad)
        .map_err(|_| DeviceKeyPinError::Csprng)?;

    let env = Envelope {
        version: ENVELOPE_VERSION,
        m_kib: params.m_kib,
        t: params.t,
        p: params.p,
        argon2_version: params.argon2_version,
        salt_hex: encode_lower(&salt),
        nonce_hex: encode_lower(&nonce),
        sealed_hex: encode_lower(&sealed),
    };
    let bytes = serde_json::to_vec_pretty(&env).map_err(|_| DeviceKeyPinError::Io)?;
    // The counter is cleared BEFORE the new file lands, and a failure here is fatal
    // to the seal. The other order leaves a fresh sealed key beside a counter left
    // at the cap, and the next open would destroy the key the user has just set
    // without ever trying their PIN (myne-md/myne#938 review). An ABSENT counter is
    // already clear, so it is checked rather than removed blind: a `remove_file` on
    // a path that is not there is an `Io` error on this trait, which would fail
    // every first seal.
    if io
        .exists(&attempts_path(dir))
        .await
        .map_err(|_| DeviceKeyPinError::Io)?
    {
        io.remove_file(&attempts_path(dir))
            .await
            .map_err(|_| DeviceKeyPinError::Io)?;
    }
    io.write(&sealed_path(dir), &bytes, WriteOpts::default())
        .await
        .map_err(|_| DeviceKeyPinError::Io)?;
    Ok(())
}

/// Open the sealed key with `pin`, recording the attempt.
///
/// Every failure that is not "wrong PIN" is reported as itself: an absent file, a
/// corrupt envelope and a reached cap each give the caller a different action, and
/// collapsing them into one "failed" would leave the surface unable to say whether
/// to offer a new PIN or a new file.
pub async fn open(
    io: &dyn VaultIo,
    dir: &Path,
    pin: &str,
) -> Result<DeviceKeyPair, DeviceKeyPinError> {
    let mut attempts = read_attempts(io, dir).await;
    if attempts.must_wipe() {
        return match wipe(io, dir).await {
            Ok(()) => Err(DeviceKeyPinError::Wiped),
            Err(_) => Err(DeviceKeyPinError::WipeFailed),
        };
    }

    let bytes = match io.read(&sealed_path(dir)).await {
        Ok(bytes) => bytes,
        Err(_) => return Err(DeviceKeyPinError::Absent),
    };
    let env: Envelope = serde_json::from_slice(&bytes).map_err(|_| DeviceKeyPinError::Corrupt)?;
    if env.version != ENVELOPE_VERSION {
        return Err(DeviceKeyPinError::Corrupt);
    }
    let salt = decode_lower::<16>(&env.salt_hex).ok_or(DeviceKeyPinError::Corrupt)?;
    let nonce = decode_lower::<{ protocol::AEAD_NONCE_LEN }>(&env.nonce_hex)
        .ok_or(DeviceKeyPinError::Corrupt)?;
    let sealed = decode_lower_vec(&env.sealed_hex).ok_or(DeviceKeyPinError::Corrupt)?;
    let params = KdfParams {
        m_kib: env.m_kib,
        t: env.t,
        p: env.p,
        argon2_version: env.argon2_version,
    };
    // The envelope's parameters are attacker-writable, so they are held to the same
    // bounds a freshly sealed file is, AND they are part of the AAD below: a set that
    // was rewritten after the seal fails the tag even if it is within bounds.
    protocol::validate_kdf_params(&params).map_err(|_| DeviceKeyPinError::Corrupt)?;

    let key = protocol::kdf::derive_device_key_pin_wrap_key(pin, &salt, &params)
        .map_err(|_| DeviceKeyPinError::Kdf)?;
    let aad = protocol::aad_device_key_pin_store(env.version, &params);
    let plaintext = match protocol::aead_open_ctx(&key, &nonce, &sealed, &aad) {
        Ok(plaintext) => plaintext,
        Err(_) => {
            // A wrong PIN and a tampered frame are ONE answer here, deliberately:
            // they are indistinguishable by construction (the tag is the only
            // check), and telling them apart would say whether the PIN was right.
            return Err(record_failure(io, dir, &mut attempts).await);
        }
    };

    let fixed: [u8; DEVICE_KEY_PLAINTEXT_LEN] = plaintext
        .as_slice()
        .try_into()
        .map_err(|_| DeviceKeyPinError::Corrupt)?;
    let pair =
        DeviceKeyPair::from_plaintext_bytes(&fixed).map_err(|_| DeviceKeyPinError::Corrupt)?;
    // Best-effort, and the one place it is: a counter that survives a SUCCESSFUL
    // open can only shorten the next allowance, never extend it.
    let _ = io.remove_file(&attempts_path(dir)).await;
    Ok(pair)
}

/// Destroy the sealed key and its counter. Called at the cap, and by the erase
/// paths that wipe the device identity.
///
/// Returns the erase's outcome rather than swallowing it: at the cap this is the
/// only thing standing between a key this build has decided is unusable and the
/// next attempt to open it.
///
/// **An absent file is success, not failure.** `VaultIo::remove_file` reports a
/// missing path as an `Io` error by contract, so the unconditional pair below made
/// `wipe` answer `WipeFailed` on every device that never used this rung — the
/// ordinary case — and the forget path then logged "the PIN-sealed device key could
/// not be removed" every single time, training the operator to ignore the one log
/// line that would matter (myne-md/myne#938 review). `seal` documents the same trap
/// and guards for it.
pub async fn wipe(io: &dyn VaultIo, dir: &Path) -> Result<(), DeviceKeyPinError> {
    let sealed = remove_if_present(io, &sealed_path(dir)).await;
    let counter = remove_if_present(io, &attempts_path(dir)).await;
    if sealed.is_err() || counter.is_err() {
        return Err(DeviceKeyPinError::WipeFailed);
    }
    Ok(())
}

/// Remove a path that may not be there, treating absence as done.
async fn remove_if_present(io: &dyn VaultIo, path: &Path) -> Result<(), ()> {
    match io.exists(path).await {
        Ok(false) => Ok(()),
        Ok(true) => io.remove_file(path).await.map_err(|_| ()),
        Err(_) => Err(()),
    }
}

async fn read_attempts(io: &dyn VaultIo, dir: &Path) -> AttemptState {
    match io.read(&attempts_path(dir)).await {
        // A corrupt counter reads as the cap, which is the fail-safe direction: it
        // can only shorten the allowance, never extend it.
        Ok(bytes) => parse_attempt_count(&bytes).unwrap_or_else(|| {
            AttemptState::from_count(
                crate::plugins::quick_unlock::attempt::MAX_QUICK_UNLOCK_ATTEMPTS,
            )
        }),
        Err(_) => AttemptState::fresh(),
    }
}

async fn record_failure(
    io: &dyn VaultIo,
    dir: &Path,
    attempts: &mut AttemptState,
) -> DeviceKeyPinError {
    match attempts.record_failure() {
        AttemptOutcome::Allowed { remaining } => {
            // The counter is the only thing bounding the attempts, so a counter that
            // cannot be persisted must not be reported as "try again": the next open
            // would read a fresh counter and the allowance would never end. Fail
            // closed at the cap, which is the answer a corrupt counter already gives
            // (myne-md/myne#938 review).
            if io
                .write(
                    &attempts_path(dir),
                    &encode_attempt_count(attempts),
                    WriteOpts::default(),
                )
                .await
                .is_err()
            {
                return match wipe(io, dir).await {
                    Ok(()) => DeviceKeyPinError::Wiped,
                    Err(_) => DeviceKeyPinError::WipeFailed,
                };
            }
            DeviceKeyPinError::WrongPin { remaining }
        }
        AttemptOutcome::Wipe => match wipe(io, dir).await {
            Ok(()) => DeviceKeyPinError::Wiped,
            Err(_) => DeviceKeyPinError::WipeFailed,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_io::{IoResult, StdVaultIo};

    /// Cheap Argon2id parameters. The production seal passes the vault's own
    /// memory-hard set; these tests are about the envelope and the counter, and a
    /// 256 MiB derivation per case would put the suite in minutes.
    fn fast_params() -> KdfParams {
        KdfParams {
            m_kib: protocol::MIN_KDF_M_KIB,
            t: 1,
            p: 1,
            argon2_version: 0x13,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "myne-device-key-pin-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn the_sealed_key_round_trips_and_leaves_no_plaintext_on_disk() {
        crate::test_support::block_on(async {
            let dir = temp_dir("roundtrip");
            let io = StdVaultIo;
            let pair = DeviceKeyPair::generate_raw(&[0x51; 32], &[0x52; 32]);
            seal(&io, &dir, "123456", &fast_params(), &pair)
                .await
                .expect("seal");

            assert!(is_sealed(&io, &dir).await);
            let back = open(&io, &dir, "123456").await.expect("open");
            assert_eq!(back.public_half(), pair.public_half());

            // The whole point of the rung: the private seeds are NOT in the file. A
            // seal that wrote them would still round-trip, so this assertion is the
            // one that distinguishes a sealed store from a plaintext one.
            //
            // Both encodings are checked, because a leak does not have to be raw:
            // the first version of this assertion searched only for the raw bytes and
            // stayed GREEN under an injection that wrote the seeds out as lowercase
            // hex, which is how this file's own envelope spells every field.
            let raw = std::fs::read(dir.join(DEVICE_KEY_PIN_FILE)).expect("read sealed file");
            let plaintext = pair.to_plaintext_bytes();
            for (half, seed) in [(1, &plaintext[..32]), (2, &plaintext[32..])] {
                assert!(
                    !raw.windows(32).any(|w| w == seed),
                    "private seed {half} must not appear raw in the sealed file"
                );
                let hex = encode_lower(seed);
                assert!(
                    !raw.windows(hex.len()).any(|w| w == hex.as_bytes()),
                    "private seed {half} must not appear as hex in the sealed file"
                );
            }

            // Owner-only permissions: the file is a secret even though it is sealed.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(dir.join(DEVICE_KEY_PIN_FILE))
                    .expect("stat")
                    .permissions()
                    .mode()
                    & 0o777;
                assert_eq!(mode, 0o600, "the sealed key must be owner-only");
            }

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn a_wrong_pin_counts_down_and_the_cap_wipes_the_file() {
        crate::test_support::block_on(async {
            let dir = temp_dir("wipe");
            let io = StdVaultIo;
            let pair = DeviceKeyPair::generate_raw(&[0x61; 32], &[0x62; 32]);
            seal(&io, &dir, "123456", &fast_params(), &pair)
                .await
                .expect("seal");

            // Under the cap: the file survives and the remaining count is reported.
            let mut seen_remaining = Vec::new();
            for expected_remaining in
                (1..crate::plugins::quick_unlock::attempt::MAX_QUICK_UNLOCK_ATTEMPTS).rev()
            {
                match open(&io, &dir, "000000").await {
                    Err(DeviceKeyPinError::WrongPin { remaining }) => {
                        assert_eq!(remaining, expected_remaining);
                        seen_remaining.push(remaining);
                    }
                    other => panic!("expected a wrong-PIN answer, got {other:?}"),
                }
                assert!(
                    is_sealed(&io, &dir).await,
                    "the file survives under the cap"
                );
            }
            assert!(!seen_remaining.is_empty());

            // The attempt that reaches the cap destroys the sealed key AND its counter.
            assert!(matches!(
                open(&io, &dir, "000000").await,
                Err(DeviceKeyPinError::Wiped)
            ));
            assert!(
                !is_sealed(&io, &dir).await,
                "the cap must delete the sealed key"
            );
            assert!(
                !attempts_path(&dir).exists(),
                "the cap must delete the counter too, so a re-seal starts clean"
            );

            // And the state is terminal for this file: it is now absent, not "one more try".
            assert!(matches!(
                open(&io, &dir, "123456").await,
                Err(DeviceKeyPinError::Absent)
            ));

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn a_corrupt_envelope_is_named_rather_than_read_as_a_wrong_pin() {
        crate::test_support::block_on(async {
            let dir = temp_dir("corrupt");
            let io = StdVaultIo;
            std::fs::write(dir.join(DEVICE_KEY_PIN_FILE), b"{not json").expect("write junk");
            assert!(matches!(
                open(&io, &dir, "123456").await,
                Err(DeviceKeyPinError::Corrupt)
            ));

            // A well-formed envelope of an unknown version is also refused by name, not
            // parsed optimistically.
            let env = Envelope {
                version: ENVELOPE_VERSION + 1,
                m_kib: protocol::MIN_KDF_M_KIB,
                t: 1,
                p: 1,
                argon2_version: 0x13,
                salt_hex: "00".repeat(16),
                nonce_hex: "00".repeat(protocol::AEAD_NONCE_LEN),
                sealed_hex: "00"
                    .repeat(DEVICE_KEY_PLAINTEXT_LEN + protocol::CTX_COMMITMENT_TAG_LEN),
            };
            std::fs::write(
                dir.join(DEVICE_KEY_PIN_FILE),
                serde_json::to_vec(&env).expect("serialize"),
            )
            .expect("write envelope");
            assert!(matches!(
                open(&io, &dir, "123456").await,
                Err(DeviceKeyPinError::Corrupt)
            ));

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    /// A rewritten KDF parameter set must not open, and must not be told apart
    /// from a wrong PIN: the parameters are bound into the AAD and are an input to
    /// the derivation, so a downgrade to a cheaper `m_kib` derives a different wrap
    /// key and fails the tag. This is the property `decisions/protocol/0759` rests
    /// on when it says a weak set cannot be read back.
    #[test]
    fn a_rewritten_kdf_parameter_fails_closed_and_looks_like_a_wrong_pin() {
        crate::test_support::block_on(async {
            let dir = temp_dir("kdf-rewrite");
            let io = StdVaultIo;
            let pair = DeviceKeyPair::generate_raw(&[0x81; 32], &[0x82; 32]);
            let params = fast_params();
            seal(&io, &dir, "123456", &params, &pair)
                .await
                .expect("seal");

            let path = dir.join(DEVICE_KEY_PIN_FILE);
            let mut env: Envelope =
                serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("parse");
            // Still a VALID set, so the refusal cannot come from validation: only
            // the tag can catch this. `+ 8` rather than a cheap value, because
            // `fast_params()` already sits at `MIN_KDF_M_KIB` and assigning the
            // same number would test nothing (the first version of this test did
            // exactly that and passed for the wrong reason).
            env.m_kib = protocol::MIN_KDF_M_KIB + 8;
            std::fs::write(&path, serde_json::to_vec(&env).expect("serialize")).expect("write");

            // The correct PIN, against the rewritten frame. A wrong-credential
            // answer is the requirement (§6.4): naming the tamper would be an
            // oracle telling an attacker which field to leave alone.
            assert!(matches!(
                open(&io, &dir, "123456").await,
                Err(DeviceKeyPinError::WrongPin { remaining: 4 })
            ));

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn a_corrupt_counter_reads_as_the_cap_and_wipes() {
        crate::test_support::block_on(async {
            let dir = temp_dir("counter");
            let io = StdVaultIo;
            let pair = DeviceKeyPair::generate_raw(&[0x71; 32], &[0x72; 32]);
            seal(&io, &dir, "123456", &fast_params(), &pair)
                .await
                .expect("seal");
            // A counter whose magic byte is wrong: read as the cap, so the file is
            // destroyed rather than handed five fresh guesses.
            std::fs::write(attempts_path(&dir), [0x00, 0x00]).expect("write counter");
            assert!(matches!(
                open(&io, &dir, "123456").await,
                Err(DeviceKeyPinError::Wiped)
            ));
            assert!(!is_sealed(&io, &dir).await);

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn a_success_resets_the_counter() {
        crate::test_support::block_on(async {
            let dir = temp_dir("reset");
            let io = StdVaultIo;
            let pair = DeviceKeyPair::generate_raw(&[0x81; 32], &[0x82; 32]);
            seal(&io, &dir, "123456", &fast_params(), &pair)
                .await
                .expect("seal");

            assert!(matches!(
                open(&io, &dir, "000000").await,
                Err(DeviceKeyPinError::WrongPin { .. })
            ));
            assert!(attempts_path(&dir).exists(), "a failure is persisted");
            open(&io, &dir, "123456").await.expect("open");
            assert!(
                !attempts_path(&dir).exists(),
                "a success clears the counter, so earlier typos do not accumulate"
            );

            let _ = std::fs::remove_dir_all(&dir);
        });
    }
    /// `StdVaultIo` with one path's operation refused, so a failure the product
    /// treats as fatal can be reached. The two branches below exist because a
    /// counter that cannot be written or cleared is the difference between an
    /// allowance that ends and one that never does (myne-md/myne#938 review).
    struct RefusingIo {
        refuse: PathBuf,
        refuse_write: bool,
        refuse_remove: bool,
    }

    #[async_trait::async_trait]
    impl crate::vault_io::VaultIo for RefusingIo {
        async fn read(&self, path: &Path) -> IoResult<Vec<u8>> {
            StdVaultIo.read(path).await
        }
        async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>> {
            StdVaultIo.read_prefix(path, len).await
        }
        async fn write(&self, path: &Path, bytes: &[u8], opts: WriteOpts) -> IoResult<()> {
            if self.refuse_write && path == self.refuse {
                return Err(crate::io_failure_kind::IoFailureKind::Other);
            }
            StdVaultIo.write(path, bytes, opts).await
        }
        async fn remove_file(&self, path: &Path) -> IoResult<()> {
            if self.refuse_remove && path == self.refuse {
                return Err(crate::io_failure_kind::IoFailureKind::Other);
            }
            StdVaultIo.remove_file(path).await
        }
        async fn remove_dir_all(&self, path: &Path) -> IoResult<()> {
            StdVaultIo.remove_dir_all(path).await
        }
        async fn create_dir_all(&self, path: &Path) -> IoResult<()> {
            StdVaultIo.create_dir_all(path).await
        }
        async fn read_dir(&self, path: &Path) -> IoResult<Vec<crate::vault_io::DirEntry>> {
            StdVaultIo.read_dir(path).await
        }
        async fn exists(&self, path: &Path) -> IoResult<bool> {
            StdVaultIo.exists(path).await
        }
        async fn is_dir(&self, path: &Path) -> IoResult<bool> {
            StdVaultIo.is_dir(path).await
        }
        async fn stat(&self, path: &Path) -> IoResult<Option<crate::vault_io::FileStat>> {
            StdVaultIo.stat(path).await
        }
        async fn rename(&self, from: &Path, to: &Path) -> IoResult<()> {
            StdVaultIo.rename(from, to).await
        }
    }

    #[test]
    fn a_counter_that_cannot_be_persisted_fails_closed_instead_of_granting_a_retry() {
        crate::test_support::block_on(async {
            let dir = temp_dir("counter-write-fail");
            let io = StdVaultIo;
            let pair = DeviceKeyPair::generate_raw(&[0x91; 32], &[0x92; 32]);
            seal(&io, &dir, "123456", &fast_params(), &pair)
                .await
                .expect("seal");

            // A counter exists, so the wipe this branch performs can remove it; what
            // the fixture refuses is the WRITE, which is the operation the fail-closed
            // branch is about.
            std::fs::write(
                attempts_path(&dir),
                encode_attempt_count(&AttemptState::from_count(0)),
            )
            .expect("write counter");

            // A wrong PIN whose counter cannot be written must NOT answer
            // `WrongPin { remaining }`: the next open would read a fresh counter and
            // the allowance would never end. It destroys the key instead.
            let refusing = RefusingIo {
                refuse: attempts_path(&dir),
                refuse_write: true,
                refuse_remove: false,
            };
            assert!(
                matches!(
                    open(&refusing, &dir, "000000").await,
                    Err(DeviceKeyPinError::Wiped)
                ),
                "an unpersistable counter must fail closed at the cap, not grant a retry"
            );
            assert!(
                !is_sealed(&io, &dir).await,
                "failing closed means the sealed key is gone"
            );

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn a_seal_that_cannot_clear_the_counter_leaves_the_old_key_in_place() {
        crate::test_support::block_on(async {
            let dir = temp_dir("counter-clear-fail");
            let io = StdVaultIo;
            let old = DeviceKeyPair::generate_raw(&[0xa1; 32], &[0xa2; 32]);
            seal(&io, &dir, "123456", &fast_params(), &old)
                .await
                .expect("seal");
            // A counter that exists, which is the precondition for the seal's clear
            // step to run at all. It is deliberately BELOW the cap: a fixture at the
            // cap would make the surviving key unopenable for a second reason and the
            // test would pass without the ordering ever being exercised.
            std::fs::write(
                attempts_path(&dir),
                encode_attempt_count(&AttemptState::from_count(2)),
            )
            .expect("write counter");

            let new = DeviceKeyPair::generate_raw(&[0xb1; 32], &[0xb2; 32]);
            let refusing = RefusingIo {
                refuse: attempts_path(&dir),
                refuse_write: false,
                refuse_remove: true,
            };
            assert!(matches!(
                seal(&refusing, &dir, "654321", &fast_params(), &new).await,
                Err(DeviceKeyPinError::Io)
            ));

            // The previous key still opens with the previous PIN, because the seal
            // refused BEFORE overwriting: a new key beside a counter at the cap is
            // the state this ordering exists to make unreachable.
            let back = open(&io, &dir, "123456")
                .await
                .expect("the old key survives");
            assert_eq!(back.public_half(), old.public_half());

            let _ = std::fs::remove_dir_all(&dir);
        });
    }
}
