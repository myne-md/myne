// SPDX-License-Identifier: AGPL-3.0
//! Argon2id wrap-key derivation — see `myne-agents/docs/spec/protocol.md` § 3.1, § 4.
//!
//! Two parallel paths derive 32-byte AEAD keys that wrap `root_key`:
//!
//! - [`derive_password_wrap_key`] — input is the master password
//!   (UTF-8 bytes); salt prefix is `"myne.v0.1 argon2id-password|"`.
//! - [`derive_recovery_wrap_key`] — input is the BIP-39 24-word phrase
//!   joined as `phrase_normalized` (`RecoveryPhrase::join_normalized`);
//!   salt prefix is `"myne.v0.1 argon2id-recovery|"`.
//!
//! Both paths share the same Argon2id parameter set
//! (`m, t, p, argon2_version`), drawn from `vault.meta` and bound into
//! the wrap AADs (spec § 4.3) so any tampering with the parameters
//! invalidates the AEAD tag downstream of these functions.
//!
//! ## Salt construction (spec § 3.1)
//!
//! ```text
//! salt = SHA-256( prefix || account_number_hash || salt_random )[:16]
//! ```
//!
//! Mixing `account_number_hash` into the salt prevents pre-computation
//! of Argon2id outputs across accounts (account-binding); using two
//! distinct prefixes domain-separates the password and recovery
//! Argon2id outputs even if the same secret were ever used for both
//! (which spec § 3.1 last paragraph mandates against).
//!
//! ## Argon2id parameters
//!
//! Parameters come from a [`KdfParams`] supplied by the caller. v0.1
//! mandates `argon2_version = 0x13`, and `0x13` is the **only** accepted
//! value: every other version byte — including the also-published
//! Argon2 v1.0 `0x10` — returns [`ProtocolError::KdfFailure`]. On the
//! read path it never reaches this check, because `parse_kdf_params`
//! (`types.rs`) already rejects anything but `0x13` (spec §9.3).
//! Range checks on `m`, `t`, `p` are
//! deferred to the `argon2` crate's `Params::new` constructor — Argon2
//! RFC 9106 minima (`m >= 8*p`, `t >= 1`, `p >= 1`) surface there.
//!
//! ## Twin-prefix gotcha (3rd variant)
//!
//! The salt prefixes are 28-byte ASCII strings that share the same
//! `"myne.v0.1 argon2id-"` head as the HKDF prefix `"myne.v0.1 "` and
//! the AAD prefix `"myne.v0.1|"`. **All three prefix families differ
//! in their trailing-character region**; tests pin the exact bytes
//! verbatim because any drift silently invalidates every existing
//! vault.

use crate::error::ProtocolError;
use crate::phrase::RecoveryPhrase;
use crate::types::KdfParams;
use argon2::{Algorithm, Argon2, Params, Version};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Salt prefix for the password-derived wrap key
/// (spec § 3.1; 28 ASCII bytes, trailing pipe).
const SALT_PREFIX_PASSWORD: &[u8] = b"myne.v0.1 argon2id-password|";

/// Salt prefix for the recovery-phrase-derived wrap key
/// (spec § 3.1; 28 ASCII bytes, trailing pipe).
const SALT_PREFIX_RECOVERY: &[u8] = b"myne.v0.1 argon2id-recovery|";

/// Salt prefix for the PIN-derived quick-unlock wrap key
/// (spec § 9.14.2; 35 ASCII bytes, trailing pipe). DISTINCT from the password
/// and recovery prefixes so a PIN wrap key is domain-separated from the
/// credential wrap keys even if a user's PIN coincided with their password.
const SALT_PREFIX_QUICKUNLOCK_PIN: &[u8] = b"myne.v0.1 argon2id-quickunlock-pin|";

/// Salt prefix for the **v0.2** password-derived wrap key (`spec/protocol.md`
/// §10.3 v0.2 row / §10.4.1). The next-major mirror of [`SALT_PREFIX_PASSWORD`]:
/// same Argon2id primitive + parameters, distinct salt domain, so the same
/// password derives a different wrap key across major versions (the §10.5
/// anti-downgrade property at the KDF layer). Allocated by the
/// `automerge-sync-migration` epic (#420) for the whole-vault re-key.
const SALT_PREFIX_PASSWORD_V0_2: &[u8] = b"myne.v0.2 argon2id-password|";

/// Salt prefix for the **v0.2** recovery-phrase-derived wrap key
/// (`spec/protocol.md` §10.4.1). The next-major mirror of [`SALT_PREFIX_RECOVERY`].
const SALT_PREFIX_RECOVERY_V0_2: &[u8] = b"myne.v0.2 argon2id-recovery|";

/// Salt prefix for the **person keypair** wrap key (b2b-identity-substrate,
/// myne-md/myne#698 task 2). The person's own recovery phrase derives a
/// wrap key for THEIR keypair under this domain, NOT under any vault's
/// credential domains: a person keypair is vault-independent (one person,
/// many vaults) and a vault credential must never be able to unwrap it
/// (and vice versa). Distinct from every other prefix by its
/// `argon2id-person-keypair` segment; v0.2-prefixed because the feature
/// ships post-v0.2-birth-format.
const SALT_PREFIX_PERSON_KEYPAIR_V0_2: &[u8] = b"myne.v0.2 argon2id-person-keypair|";

/// Salt domain for the person-scoped SCRAM secret.
pub const SALT_PREFIX_PERSON_SERVER_AUTH_V0_2: &[u8] = b"myne.v0.2 argon2id-person-server-auth|";

/// Salt domain for one person's private profile in one vault.
pub const SALT_PREFIX_PERSON_VAULT_PROFILE_V0_2: &[u8] =
    b"myne.v0.2 argon2id-person-vault-profile|";

/// Domain for deriving a stable per-person, per-vault profile identifier.
pub const PERSON_PROFILE_ID_PREFIX: &[u8] = b"myne.person-profile-id v1|";

/// The FIXED salt randomizer for the private-profile KDF.
///
/// The profile key must be reproducible from the phrase alone on every client
/// (spec §9.28: "derive its deterministic ... key from the normalized phrase"),
/// so there is no per-device salt to store or sync — a random salt would make
/// the profile unopenable on a second device. Separation comes from the domain
/// prefix and the `profile_id`, which already binds the person-id hash and the
/// vault's account-number hash; this constant is deliberately not secret.
pub const PERSON_VAULT_PROFILE_SALT_RANDOM: [u8; 16] = [0u8; 16];

/// Salt domain for the deterministic person-identity key seed
/// (`decisions/protocol/0604`, absorbing myne-md/myne#713). The person keypair
/// is derived from the normalized phrase under this domain rather than generated
/// from the OS CSPRNG, so the same phrase is the same identity on every device.
/// Distinct from `SALT_PREFIX_PERSON_KEYPAIR_V0_2` so the key seed and the
/// at-rest wrap key are never the same value.
pub const SALT_PREFIX_PERSON_IDENTITY_V0_2: &[u8] = b"myne.v0.2 argon2id-person-identity|";

/// The person-identity seed derivation uses no per-device randomizer: a fixed
/// (non-secret) salt makes the derivation a pure function of the phrase, which
/// is the whole point of the deterministic path. Mirrors the private-profile
/// fixed salt.
pub const PERSON_IDENTITY_SALT_RANDOM: [u8; 16] = [0u8; 16];

/// The FIXED salt randomizer for the person-level SCRAM secret
/// (`"myne.v0.2 argon2id-person-server-auth|"`, `decisions/protocol/0594`).
///
/// The secret must be reproducible from the phrase alone on every device the
/// person signs in from (`decisions/protocol/0603`: a person account "opens one
/// account bound to the person-id"), so there is no per-device salt to store or
/// sync; a random one would strand every other device. Separation comes from the
/// domain prefix and the `person_id_hash` in the salt slot, which is itself a
/// pure function of the phrase; this constant is deliberately not secret.
/// Mirrors [`PERSON_IDENTITY_SALT_RANDOM`] and [`PERSON_VAULT_PROFILE_SALT_RANDOM`].
pub const PERSON_SERVER_AUTH_SALT_RANDOM: [u8; 16] = [0u8; 16];

/// Per-key-type HKDF context strings for the deterministic person identity.
/// Each key type derives from the one identity seed under its own context, so
/// no key is a re-encoding of another (`decisions/protocol/0604`).
pub const PERSON_KEM_CONTEXT: &[u8] = b"myne.person-kem v1|";
pub const PERSON_ED25519_CONTEXT: &[u8] = b"myne.person-ed25519 v1|";
pub const PERSON_MLDSA_CONTEXT: &[u8] = b"myne.person-mldsa v1|";

/// Deterministic person-identity seed length (Argon2id output).
pub const PERSON_IDENTITY_SEED_LEN: usize = 32;
/// ML-KEM-768 decapsulation seed length (`d || z`).
pub const PERSON_KEM_SEED_LEN: usize = 64;
/// Ed25519 secret-seed length.
pub const PERSON_ED25519_SEED_LEN: usize = 32;
/// ML-DSA-65 signing-seed length.
pub const PERSON_MLDSA_SEED_LEN: usize = 32;

/// Argon2id salt length: 16 bytes (truncated SHA-256 output).
pub const ARGON2_SALT_LEN: usize = 16;

/// Argon2id wrap-key output length: 32 bytes (256-bit AEAD key).
pub const ARGON2_OUTPUT_LEN: usize = 32;

/// Derive the 32-byte AEAD wrap key for the password-protected copy of
/// `root_key` (spec § 3.1).
///
/// Salt = SHA-256(`"myne.v0.1 argon2id-password|"` || `account_number_hash`
/// || `salt_random`)[:16]. Argon2id is invoked with the parameters from
/// `params` and the `password` UTF-8 bytes as the password input. Output
/// is `Zeroizing<[u8; 32]>` so the wrap key is wiped on drop.
///
/// Returns [`ProtocolError::KdfFailure`] for any Argon2id error
/// (out-of-range parameters, allocation failure, etc.). Underlying
/// detail is intentionally dropped at the `map_err` boundary; spec
/// § 7.3 / PRD's no-`String`-in-errors rule applies. A future
/// hardening pass MAY add backend-side `tracing` logging of the
/// concrete `argon2::Error` before mapping; today it is discarded.
pub fn derive_password_wrap_key(
    password: &str,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(SALT_PREFIX_PASSWORD, account_number_hash, salt_random);
    argon2id_derive(password.as_bytes(), &salt, params)
}

/// Derive the 32-byte AEAD wrap key for the recovery-phrase-protected
/// copy of `root_key` (spec § 3.1) from a structured [`RecoveryPhrase`].
///
/// Internally calls `phrase.join_normalized()` to obtain the spec § 7.4
/// `phrase_normalized` form — single-space-joined ASCII-lowercase BIP-39
/// words — then delegates to
/// [`derive_recovery_wrap_key_from_normalized`]. Used at vault-creation
/// time when the phrase has been freshly generated (and therefore
/// already conforms to the canonical normalized form by construction).
///
/// Salt construction uses the recovery prefix
/// `"myne.v0.1 argon2id-recovery|"` (distinct from the password
/// prefix).
///
/// Returns [`ProtocolError::KdfFailure`] on Argon2id error (same
/// discipline as [`derive_password_wrap_key`]).
pub fn derive_recovery_wrap_key(
    phrase: &RecoveryPhrase,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let phrase_normalized = phrase.join_normalized();
    derive_recovery_wrap_key_from_normalized(
        phrase_normalized.as_str(),
        salt_random,
        account_number_hash,
        params,
    )
}

/// Derive the 32-byte AEAD wrap key for the recovery-phrase-protected
/// copy of `root_key` (spec § 3.1) directly from the
/// `phrase_normalized` byte string.
///
/// Used by the **recovery-time** flow (`vault_recover_with_phrase` in
/// `src-tauri/src/plugins/vault_recover/`) where the phrase comes from
/// raw user input that has been normalized via
/// [`crate::phrase::normalize_user_phrase`] (NFKD + ASCII lowercase +
/// trim + whitespace coalesce per spec § 7.4). The function deliberately
/// **does not validate** against the BIP-39 wordlist — invalid phrases
/// produce a wrap key that fails AEAD-tag verification on
/// `enc_root_key_recovery`, surfacing the single non-distinguishing
/// error per `recovery-flow.md` § 3.4. Wordlist validation here would
/// leak BIP-39 membership through error timing or class.
///
/// Salt construction is identical to [`derive_recovery_wrap_key`]; the
/// two functions are byte-equivalent given byte-equivalent normalized
/// input.
///
/// Returns [`ProtocolError::KdfFailure`] on Argon2id error (same
/// discipline as [`derive_password_wrap_key`]).
pub fn derive_recovery_wrap_key_from_normalized(
    phrase_normalized: &str,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(SALT_PREFIX_RECOVERY, account_number_hash, salt_random);
    argon2id_derive(phrase_normalized.as_bytes(), &salt, params)
}

/// Derive the 32-byte AEAD wrap key for the **PIN-protected quick-unlock copy**
/// of `root_key` (spec § 9.14.2).
///
/// Salt = SHA-256(`"myne.v0.1 argon2id-quickunlock-pin|"` || `account_number_hash`
/// || `pin_salt`)[:16]. Argon2id runs with `params` — the **same** memory-hard
/// parameter set the vault uses for the master password (drawn from `vault.meta`
/// § 4.2): the memory-hardness is what makes a low-entropy PIN costly to
/// brute-force offline. `pin` is the user's PIN as UTF-8 bytes (the host layer
/// enforces a minimum length before calling this); the distinct salt prefix
/// domain-separates it from [`derive_password_wrap_key`].
///
/// Returns [`ProtocolError::KdfFailure`] on Argon2id error (same discipline as
/// [`derive_password_wrap_key`]).
pub fn derive_quick_unlock_pin_wrap_key(
    pin: &str,
    pin_salt: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(SALT_PREFIX_QUICKUNLOCK_PIN, account_number_hash, pin_salt);
    argon2id_derive(pin.as_bytes(), &salt, params)
}

/// Salt prefix for the **device-key PIN rung** (`decisions/protocol/0733`
/// decision 4, rung 3; `identity-seat-portability` task 8). The device signing
/// key is device-scoped and vault-agnostic, so this domain is bound to **no**
/// `account_number_hash`: the salt is the per-file random value alone, and the
/// key must survive a vault being forgotten, since the device key outlives it.
///
/// Deliberately NOT [`SALT_PREFIX_QUICKUNLOCK_PIN`]: reusing that domain would
/// make one PIN derive one key for two purposes, so a quick-unlock wrap key
/// would double as the device key's seal key (and vice versa).
const SALT_PREFIX_DEVICE_KEY_PIN: &[u8] = b"myne.v0.2 argon2id-device-key-pin|";

/// Derive the 32-byte AEAD wrap key that seals the **device signing key** at
/// rest on a platform with no OS keychain rung (`decisions/protocol/0733`
/// decision 4, rung 3).
///
/// Salt = SHA-256(`"myne.v0.2 argon2id-device-key-pin|"` || `pin_salt`)[:16],
/// no account component, because the key is device-scoped and must not become
/// unopenable when a vault is forgotten.
///
/// The memory-hardness of `params` is the **only** offline bound on a
/// low-entropy PIN, exactly as in [`derive_quick_unlock_pin_wrap_key`]: the
/// on-disk attempt counter bounds an attacker typing at the keyboard, and an
/// attacker holding a copy of the file never touches it. Callers therefore pass
/// the same memory-hard parameter set the vault uses, not a cheaper one.
///
pub fn derive_device_key_pin_wrap_key(
    pin: &str,
    pin_salt: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let mut h = Sha256::new();
    h.update(SALT_PREFIX_DEVICE_KEY_PIN);
    h.update(pin_salt);
    let digest = h.finalize();
    let mut salt = [0u8; ARGON2_SALT_LEN];
    salt.copy_from_slice(&digest[..ARGON2_SALT_LEN]);
    argon2id_derive(pin.as_bytes(), &salt, params)
}

/// Derive the **v0.2** 32-byte AEAD wrap key for the password-protected copy of
/// the new `root_key` (`spec/protocol.md` §10.4.1). Byte-for-byte the same
/// construction as [`derive_password_wrap_key`] — Argon2id over the password
/// bytes with `salt = SHA-256(prefix || account_number_hash || salt_random)[:16]`
/// — under the v0.2 salt domain [`SALT_PREFIX_PASSWORD_V0_2`]. The migration
/// (#420) calls this to wrap the freshly-minted v0.2 `root_key`.
pub fn derive_password_wrap_key_v0_2(
    password: &str,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(SALT_PREFIX_PASSWORD_V0_2, account_number_hash, salt_random);
    argon2id_derive(password.as_bytes(), &salt, params)
}

/// Derive the **v0.2** 32-byte AEAD wrap key from a freshly-generated
/// [`RecoveryPhrase`] — the next-major mirror of [`derive_recovery_wrap_key`],
/// and the twin the **creation** path needs (the migration re-enters a phrase
/// and so goes through the `_from_normalized_v0_2` door instead).
///
/// Same shape as its v0.1 namesake: a generated phrase is canonical by
/// construction, so this joins it and forwards.
pub fn derive_recovery_wrap_key_v0_2(
    phrase: &RecoveryPhrase,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let phrase_normalized = phrase.join_normalized();
    derive_recovery_wrap_key_from_normalized_v0_2(
        phrase_normalized.as_str(),
        salt_random,
        account_number_hash,
        params,
    )
}

/// Derive the **v0.2** 32-byte AEAD wrap key for the recovery-phrase-protected
/// copy of the new `root_key` from the `phrase_normalized` byte string
/// (`spec/protocol.md` §10.4.1). The next-major mirror of
/// [`derive_recovery_wrap_key_from_normalized`], under the v0.2 recovery salt
/// domain [`SALT_PREFIX_RECOVERY_V0_2`]. Takes the already-normalized phrase (§7.4
/// NFKD + ASCII-lowercase + single-space join) so the migration can feed the
/// user's re-entered phrase through the same normalization the recovery flow uses.
pub fn derive_recovery_wrap_key_from_normalized_v0_2(
    phrase_normalized: &str,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(SALT_PREFIX_RECOVERY_V0_2, account_number_hash, salt_random);
    argon2id_derive(phrase_normalized.as_bytes(), &salt, params)
}

/// Derive the 32-byte AEAD wrap key for the **person keypair** (B2B
/// identity substrate, myne-md/myne#698 task 2) from the person's own
/// normalized recovery phrase.
///
/// NOT a vault credential path: the salt domain
/// `"myne.v0.2 argon2id-person-keypair|"` is distinct from every vault
/// credential prefix, and `account_number_hash` is NOT bound into the salt
/// (a person keypair outlives and outranks any one vault account). The
/// `salt_random` is a per-person random value generated once at enrolment and
/// stored, with the KDF params, inside the sealed `person_keypair.sealed`
/// frame; the caller passes a fresh CSPRNG salt on first derivation.
///
/// `person_id_hash` is the phrase-derived person id
/// (`SHA-256("myne.person-id|" || phrase)[:16]`). It occupies the
/// `account_number_hash` salt slot because the person path is VAULT-independent
/// and binds to the person, not to any vault. It keeps the person-path salt
/// domain distinct from the vault credential domains; it does NOT separate two
/// people who hold the same phrase (the id is a pure function of the phrase,
/// so they derive the same wrap key).
///
/// Returns [`ProtocolError::KdfFailure`] on Argon2id error (same
/// discipline as every other path in this module).
pub fn derive_person_keypair_wrap_key_from_normalized(
    phrase_normalized: &str,
    salt_random: &[u8; 16],
    person_id_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(SALT_PREFIX_PERSON_KEYPAIR_V0_2, person_id_hash, salt_random);
    argon2id_derive(phrase_normalized.as_bytes(), &salt, params)
}

/// Derive a person-scoped SCRAM secret from the normalized recovery phrase.
pub fn derive_person_server_auth_key_from_normalized(
    phrase_normalized: &str,
    salt_random: &[u8; 16],
    person_id_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(
        SALT_PREFIX_PERSON_SERVER_AUTH_V0_2,
        person_id_hash,
        salt_random,
    );
    argon2id_derive(phrase_normalized.as_bytes(), &salt, params)
}

/// The production entry point for the person SCRAM secret: the
/// `_from_normalized` form with the spec's fixed salt. The server never sees
/// this value; the client feeds it to `scram_client_proof` and the server stores
/// only the resulting verifier (`server-protocol.md` §3.1).
pub fn derive_person_server_auth_key(
    phrase_normalized: &str,
    person_id_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    derive_person_server_auth_key_from_normalized(
        phrase_normalized,
        &PERSON_SERVER_AUTH_SALT_RANDOM,
        person_id_hash,
        params,
    )
}

/// Derive a private AI-profile key scoped to one person and one vault.
pub fn derive_person_vault_profile_key_from_normalized(
    phrase_normalized: &str,
    salt_random: &[u8; 16],
    profile_id: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(
        SALT_PREFIX_PERSON_VAULT_PROFILE_V0_2,
        profile_id,
        salt_random,
    );
    argon2id_derive(phrase_normalized.as_bytes(), &salt, params)
}

/// The private-profile key with the spec's fixed salt — the production entry
/// point. [`derive_person_vault_profile_key_from_normalized`] stays for vector
/// generation, where the salt is an explicit input.
pub fn derive_person_vault_profile_key(
    phrase_normalized: &str,
    profile_id: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    derive_person_vault_profile_key_from_normalized(
        phrase_normalized,
        &PERSON_VAULT_PROFILE_SALT_RANDOM,
        profile_id,
        params,
    )
}

/// HKDF context string for the gate-derived private-profile key (myne-md/myne#938
/// task 12).
///
/// A private `MYY5` profile is sealed under a KEK derived from the person's
/// recovery phrase, which makes the phrase a permanent requirement on top of the
/// vault's own password. This context derives the same profile key from the
/// **gate of the vault the profile belongs to** instead: the member-unlock wrap
/// key (`"myne.v0.2 argon2id-person-vault-member-unlock|"`), already a
/// vault-scoped, per-person, password-derived secret.
///
/// **Nothing seals a profile under this yet, and the reason is structural rather
/// than pending work** (`decisions/protocol/0763` §4): `MYY5` also carries the
/// pinned owner identity code a joining device must read BEFORE any gate exists,
/// so moving the seal without moving that field breaks the second-device join.
/// The owner chose to leave the lock alone, so the accept path still derives the
/// profile key from `phrase_normalized` and this function is exercised only by
/// its own two tests. It ships because the change that moves the pinned code will
/// need it, and deriving it twice would be the way two domain strings drift.
///
/// The wrap key is a strong Argon2id output, so this is a plain HKDF expansion
/// rather than a second password KDF, and it is domain-separated by this context
/// string plus the `profile_id` in the `info` slot: two profiles under one gate
/// derive two keys, and no other use of the wrap key can collide with this one.
pub const PERSON_PROFILE_GATE_CONTEXT: &[u8] = b"myne.person-vault-profile-gate v1|";

/// Derive a private-profile key from the gate of the vault the profile belongs
/// to (myne-md/myne#938 task 12). The gate is the member-unlock wrap key; the
/// caller supplies the profile id, which is
/// `person_profile_id(person_id, account_number_hash)`.
pub fn derive_person_vault_profile_key_from_gate(
    gate: &[u8; 32],
    profile_id: &[u8; 16],
) -> Zeroizing<[u8; 32]> {
    let mut info = [0u8; PERSON_PROFILE_GATE_CONTEXT.len() + 16];
    info[..PERSON_PROFILE_GATE_CONTEXT.len()].copy_from_slice(PERSON_PROFILE_GATE_CONTEXT);
    info[PERSON_PROFILE_GATE_CONTEXT.len()..].copy_from_slice(profile_id);
    let mut out = [0u8; 32];
    crate::subkey::derive_with_context_into(gate, &info, &mut out);
    Zeroizing::new(out)
}

/// Salt domain for the **member vault unlock password** store: the key that
/// seals a member's group and items keys AND their person keypair at rest under a
/// member-chosen password, so a member vault re-unlocks without the 24-word
/// recovery phrase. Scoped per `(person, vault)` by the account-number hash in
/// the salt. It was originally the SECOND member credential, distinct from the
/// phrase-sealed `vault.member-key`; that store is retired (myne-md/myne#938 task
/// 12, `decisions/protocol/0763`) so this is now the only one, and the domain
/// stays distinct from every other so no key is reused across planes.
pub const SALT_PREFIX_PERSON_VAULT_MEMBER_UNLOCK_V0_2: &[u8] =
    b"myne.v0.2 argon2id-person-vault-member-unlock|";

/// Derive the KEK that seals a member's vault-unlock credential for one vault
/// under the member's own password. Unlike the phrase store there is a
/// per-device `salt_random` (stored in the device-local envelope): the password
/// is a device-local convenience, not a portable credential, so a random salt is
/// available and preferred.
pub fn derive_person_vault_member_unlock_key(
    password: &str,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(
        SALT_PREFIX_PERSON_VAULT_MEMBER_UNLOCK_V0_2,
        account_number_hash,
        salt_random,
    );
    argon2id_derive(password.as_bytes(), &salt, params)
}

/// Derive the deterministic person-identity key seed from the normalized
/// recovery phrase (`decisions/protocol/0604`). The seed is the single root the
/// three key-type seeds expand from; it is derived under its own salt domain so
/// it is never the same value as the person-keypair at-rest wrap key.
///
/// [`derive_person_identity_seed`] is the production entry point (fixed salt);
/// this `_from_normalized` form stays for vector generation, where the salt is
/// an explicit input.
pub fn derive_person_identity_seed_from_normalized(
    phrase_normalized: &str,
    salt_random: &[u8; 16],
    person_id_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(
        SALT_PREFIX_PERSON_IDENTITY_V0_2,
        person_id_hash,
        salt_random,
    );
    argon2id_derive(phrase_normalized.as_bytes(), &salt, params)
}

/// The deterministic person-identity seed with the spec's fixed salt, the
/// production entry point. A pure function of the normalized phrase and the
/// phrase-derived `person_id_hash`, so one phrase is one identity everywhere.
pub fn derive_person_identity_seed(
    phrase_normalized: &str,
    person_id_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    derive_person_identity_seed_from_normalized(
        phrase_normalized,
        &PERSON_IDENTITY_SALT_RANDOM,
        person_id_hash,
        params,
    )
}

/// The three key-type seeds expanded from the one deterministic identity seed,
/// each zeroized on drop.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct PersonIdentitySeeds {
    /// ML-KEM-768 decapsulation seed (`d || z`, 64 bytes).
    pub kem: [u8; PERSON_KEM_SEED_LEN],
    /// Ed25519 secret seed (32 bytes).
    pub ed25519: [u8; PERSON_ED25519_SEED_LEN],
    /// ML-DSA-65 signing seed (32 bytes).
    pub mldsa: [u8; PERSON_MLDSA_SEED_LEN],
}

/// Expand the one identity seed into the three key-type seeds, each under its
/// own HKDF context string, so the KEM, Ed25519 and ML-DSA key material is
/// domain-separated. The expansion goes through the crate's single HKDF helper
/// (`subkey.rs`), never a bare `hkdf.expand` call.
pub fn expand_person_identity_key_seeds(
    seed: &[u8; PERSON_IDENTITY_SEED_LEN],
) -> PersonIdentitySeeds {
    let mut out = PersonIdentitySeeds {
        kem: [0u8; PERSON_KEM_SEED_LEN],
        ed25519: [0u8; PERSON_ED25519_SEED_LEN],
        mldsa: [0u8; PERSON_MLDSA_SEED_LEN],
    };
    crate::subkey::derive_with_context_into(seed, PERSON_KEM_CONTEXT, &mut out.kem);
    crate::subkey::derive_with_context_into(seed, PERSON_ED25519_CONTEXT, &mut out.ed25519);
    crate::subkey::derive_with_context_into(seed, PERSON_MLDSA_CONTEXT, &mut out.mldsa);
    out
}

/// The person-id hash: `SHA-256("myne.person-id|" || phrase_normalized)[:16]`.
///
/// It occupies the `account_number_hash` salt slot in
/// [`derive_person_keypair_wrap_key_from_normalized`]: the person path is
/// vault-independent, so the binding is to the PERSON, not to any vault. Two
/// people holding the SAME phrase derive the SAME id and the SAME key: this
/// hash is a pure function of the phrase, so separation between two people
/// comes from the phrase itself plus the per-person `salt_random`, with this
/// id as a defense-in-depth binding, not as a separator. A domain-separation
/// constant with no registry of its own, so it is pinned here (and by the
/// `person-keypair` vectors) as well as in the root identifier table.
pub const PERSON_ID_PREFIX: &[u8] = b"myne.person-id|";

pub fn person_id_hash(phrase_normalized: &str) -> [u8; 16] {
    let mut h = Sha256::new();
    h.update(PERSON_ID_PREFIX);
    h.update(phrase_normalized.as_bytes());
    let out = h.finalize();
    let mut id = [0u8; 16];
    id.copy_from_slice(&out[..16]);
    id
}

/// The stable id for one person's private profile in one vault.
pub fn person_profile_id(person_id_hash: &[u8; 16], account_number_hash: &[u8; 16]) -> [u8; 16] {
    let mut h = Sha256::new();
    h.update(PERSON_PROFILE_ID_PREFIX);
    h.update(person_id_hash);
    h.update(account_number_hash);
    let out = h.finalize();
    let mut id = [0u8; 16];
    id.copy_from_slice(&out[..16]);
    id
}

/// `salt = SHA-256(prefix || account_number_hash || salt_random)[:16]`
/// per spec § 3.1.
fn build_salt(
    prefix: &[u8],
    account_number_hash: &[u8; 16],
    salt_random: &[u8; 16],
) -> [u8; ARGON2_SALT_LEN] {
    let mut h = Sha256::new();
    h.update(prefix);
    h.update(account_number_hash);
    h.update(salt_random);
    let result = h.finalize();
    let mut out = [0u8; ARGON2_SALT_LEN];
    out.copy_from_slice(&result[..ARGON2_SALT_LEN]);
    out
}

/// Drive Argon2id with `params` and produce a 32-byte output.
///
/// Maps `KdfParams::argon2_version` (`0x13` only) onto
/// [`argon2::Version`]. Any other value — including the rejected Argon2
/// v1.0 (`0x10`) per spec §9.3 — plus any error from the underlying
/// `argon2` crate, becomes [`ProtocolError::KdfFailure`].
fn argon2id_derive(
    password: &[u8],
    salt: &[u8; ARGON2_SALT_LEN],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; ARGON2_OUTPUT_LEN]>, ProtocolError> {
    let version = match params.argon2_version {
        0x13 => Version::V0x13,
        // v1.0 (0x10) and everything else is rejected — the on-disk parser
        // (`parse_kdf_params`) already gates argon2_version to 0x13, so a
        // 0x10 arm here was unreachable dead code (spec §9.3 rejects v1.0).
        _ => return Err(ProtocolError::KdfFailure),
    };
    let argon_params = Params::new(
        params.m_kib,
        params.t,
        params.p as u32,
        Some(ARGON2_OUTPUT_LEN),
    )
    .map_err(|_| ProtocolError::KdfFailure)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, version, argon_params);

    let mut output = Zeroizing::new([0u8; ARGON2_OUTPUT_LEN]);
    argon2
        .hash_password_into(password, salt, output.as_mut_slice())
        .map_err(|_| ProtocolError::KdfFailure)?;
    Ok(output)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::phrase::recovery_phrase_from_fixed_entropy_for_test;
    use crate::test_vector_fmt::{hex_lower, json_escape};

    /// Fast Argon2id parameters for unit tests. Default v0.1 baseline
    /// (256 MiB / t=3) takes 1–2 seconds per call; running every test
    /// at default would balloon the suite. m=8 KiB / t=1 / p=1 are
    /// the RFC 9106 minimum (`m >= 8*p`); compute time is microseconds.
    /// **Production NEVER uses these** — only `DEFAULT_V0_1_KDF_PARAMS`
    /// or stored vault.meta values reach `derive_*_wrap_key` at runtime.
    const FAST_TEST_KDF_PARAMS: KdfParams = KdfParams {
        m_kib: 8,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    /// Fixed test fixtures used across multiple tests so any drift in
    /// salt prefix, account binding, or random salt mixing surfaces
    /// as one of the golden tests failing.
    const FIXED_ACCOUNT_HASH: [u8; 16] = [
        0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99,
    ];
    const FIXED_SALT_RANDOM: [u8; 16] = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,
        0x10,
    ];
    const FIXED_PHRASE_ENTROPY: [u8; 32] = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
        0xFF, 0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xA9, 0xBA, 0xCB, 0xDC, 0xED,
        0xFE, 0x0F,
    ];

    #[test]
    fn quick_unlock_pin_wrap_key_is_deterministic() {
        let a = derive_quick_unlock_pin_wrap_key(
            "123456",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("derive a");
        let b = derive_quick_unlock_pin_wrap_key(
            "123456",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("derive b");
        assert_eq!(a.as_slice(), b.as_slice());
    }

    #[test]
    fn quick_unlock_pin_wrap_key_is_domain_separated_from_password() {
        // The same secret + salt + account hash produce DIFFERENT keys for the
        // PIN quick-unlock domain vs the password domain — the distinct salt
        // prefix (`argon2id-quickunlock-pin|` vs `argon2id-password|`) is what
        // guarantees this even if a user's PIN equalled their password.
        let pin_key = derive_quick_unlock_pin_wrap_key(
            "secret",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("pin key");
        let password_key = derive_password_wrap_key(
            "secret",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("password key");
        assert_ne!(pin_key.as_slice(), password_key.as_slice());
    }

    /// The device-key PIN rung's salt derivation is pinned, for the same reason every
    /// other salt path is: the prefix and the mixing order are load-bearing, and a
    /// change to either silently re-derives a key no existing file opens.
    ///
    /// Hand-derived: SHA-256("myne.v0.2 argon2id-device-key-pin|"
    ///                    || FIXED_SALT_RANDOM)[:16].
    #[test]
    fn build_salt_device_key_pin_path_pinned_hex() {
        let mut h = Sha256::new();
        h.update(SALT_PREFIX_DEVICE_KEY_PIN);
        h.update(FIXED_SALT_RANDOM);
        let digest = h.finalize();
        let mut salt = [0u8; ARGON2_SALT_LEN];
        salt.copy_from_slice(&digest[..ARGON2_SALT_LEN]);
        let expected: [u8; ARGON2_SALT_LEN] = [
            0xF9, 0x8C, 0x14, 0x4C, 0x11, 0x77, 0x90, 0x12, 0xF4, 0x89, 0x5F, 0xA3, 0xCE, 0x1A,
            0x8E, 0xB0,
        ];
        assert_eq!(salt, expected);
    }

    /// The gate-derived profile key is a pure function of `(gate, profile_id)`:
    /// pinned so a change to the context string or the `info` layout is a red
    /// test rather than a silent re-key of every member's private AI profile.
    #[test]
    fn the_gate_derived_profile_key_is_pinned() {
        let gate = [0x5Au8; 32];
        let profile_id = [0x11u8; 16];
        let key = derive_person_vault_profile_key_from_gate(&gate, &profile_id);
        assert_eq!(
            crate::test_vector_fmt::hex_lower(&*key),
            "252496e48e62df452f0d6661889a10dabaf5313e4ee99513d2591edf70be5fa5"
        );
    }

    #[test]
    fn the_gate_derived_profile_key_is_domain_separated() {
        let gate = [0x5Au8; 32];
        let a = derive_person_vault_profile_key_from_gate(&gate, &[0x11u8; 16]);
        let b = derive_person_vault_profile_key_from_gate(&gate, &[0x22u8; 16]);
        assert_ne!(*a, *b, "two profiles under one gate must not share a key");
        // And it is not the phrase path under another name: the whole point is
        // that the profile stops depending on the phrase.
        let phrase = derive_person_vault_profile_key(
            "abandon ability",
            &[0x11u8; 16],
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("phrase key");
        assert_ne!(
            *a, *phrase,
            "the gate path must not reproduce the phrase path"
        );
    }

    #[test]
    fn device_key_pin_key_is_domain_separated_from_quick_unlock() {
        // One PIN, one salt: the two purposes must not share a key, or a
        // quick-unlock wrap key would double as the device key's seal key.
        let device =
            derive_device_key_pin_wrap_key("123456", &FIXED_SALT_RANDOM, &FAST_TEST_KDF_PARAMS)
                .expect("device key");
        let quick_unlock = derive_quick_unlock_pin_wrap_key(
            "123456",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("quick-unlock key");
        assert_ne!(device.as_slice(), quick_unlock.as_slice());

        // Deterministic, and it varies with the salt (so a re-sealed file under a
        // new salt cannot open with the old one).
        let again =
            derive_device_key_pin_wrap_key("123456", &FIXED_SALT_RANDOM, &FAST_TEST_KDF_PARAMS)
                .expect("derive again");
        assert_eq!(device.as_slice(), again.as_slice());
        let other_salt =
            derive_device_key_pin_wrap_key("123456", &[0x77; 16], &FAST_TEST_KDF_PARAMS)
                .expect("other salt");
        assert_ne!(device.as_slice(), other_salt.as_slice());
    }

    #[test]
    fn quick_unlock_pin_wrap_key_varies_with_salt() {
        let a = derive_quick_unlock_pin_wrap_key(
            "123456",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("a");
        let mut other_salt = FIXED_SALT_RANDOM;
        other_salt[0] ^= 0x01;
        let b = derive_quick_unlock_pin_wrap_key(
            "123456",
            &other_salt,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("b");
        assert_ne!(a.as_slice(), b.as_slice());
    }

    #[test]
    fn salt_prefixes_match_spec_verbatim() {
        // Spec § 3.1 — load-bearing identifiers (AGENTS.md "Cryptographically
        // load-bearing identifiers"). Any drift silently invalidates every
        // vault on disk.
        assert_eq!(SALT_PREFIX_PASSWORD, b"myne.v0.1 argon2id-password|");
        assert_eq!(SALT_PREFIX_RECOVERY, b"myne.v0.1 argon2id-recovery|");
        assert_eq!(SALT_PREFIX_PASSWORD.len(), 28);
        assert_eq!(SALT_PREFIX_RECOVERY.len(), 28);
        // Both end in `|` — distinct from the HKDF prefix's trailing space
        // and the AAD prefix's tail.
        assert_eq!(SALT_PREFIX_PASSWORD[27], b'|');
        assert_eq!(SALT_PREFIX_RECOVERY[27], b'|');
    }

    #[test]
    fn password_and_recovery_salt_prefixes_share_head_and_tail() {
        // The two prefixes share the head `"myne.v0.1 argon2id-"` (19
        // bytes) and tail `|` (byte 27). The role bytes 19..27 are
        // `"password"` vs `"recovery"` — those differ as a whole, but
        // not every byte differs (e.g. byte 25 is `'r'` in both
        // `"password"` and `"recovery"`).
        for i in 0..19 {
            assert_eq!(
                SALT_PREFIX_PASSWORD[i], SALT_PREFIX_RECOVERY[i],
                "byte {i} should match"
            );
        }
        assert_eq!(SALT_PREFIX_PASSWORD[27], SALT_PREFIX_RECOVERY[27]);
        // The role region as a whole differs.
        assert_ne!(&SALT_PREFIX_PASSWORD[19..27], &SALT_PREFIX_RECOVERY[19..27]);
    }

    #[test]
    fn build_salt_password_path_pinned_hex() {
        // Hand-derived: SHA-256("myne.v0.1 argon2id-password|"
        //                || FIXED_ACCOUNT_HASH || FIXED_SALT_RANDOM)[:16].
        // First-run pinned value (regenerate by running this test).
        let salt = build_salt(
            SALT_PREFIX_PASSWORD,
            &FIXED_ACCOUNT_HASH,
            &FIXED_SALT_RANDOM,
        );
        let expected: [u8; ARGON2_SALT_LEN] = [
            0xDB, 0x7B, 0x00, 0x49, 0xE1, 0x88, 0xE5, 0xE6, 0x30, 0x0E, 0x30, 0xB9, 0x46, 0x03,
            0xD6, 0x4F,
        ];
        assert_eq!(salt, expected);
    }

    #[test]
    fn build_salt_recovery_path_pinned_hex() {
        let salt = build_salt(
            SALT_PREFIX_RECOVERY,
            &FIXED_ACCOUNT_HASH,
            &FIXED_SALT_RANDOM,
        );
        let expected: [u8; ARGON2_SALT_LEN] = [
            0x4A, 0x34, 0x59, 0x3D, 0x66, 0x6B, 0x70, 0xE9, 0x6E, 0x36, 0x8E, 0x3B, 0xD0, 0x86,
            0x5E, 0x21,
        ];
        assert_eq!(salt, expected);
    }

    #[test]
    fn password_and_recovery_salts_differ_for_same_inputs() {
        let pw_salt = build_salt(
            SALT_PREFIX_PASSWORD,
            &FIXED_ACCOUNT_HASH,
            &FIXED_SALT_RANDOM,
        );
        let rec_salt = build_salt(
            SALT_PREFIX_RECOVERY,
            &FIXED_ACCOUNT_HASH,
            &FIXED_SALT_RANDOM,
        );
        assert_ne!(pw_salt, rec_salt);
    }

    #[test]
    fn derive_password_wrap_key_is_deterministic() {
        let a = derive_password_wrap_key(
            "correct horse battery staple",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("derives");
        let b = derive_password_wrap_key(
            "correct horse battery staple",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("derives");
        assert_eq!(*a, *b);
    }

    #[test]
    fn derive_password_wrap_key_pinned_hex() {
        // Pinned against fixed inputs + FAST_TEST_KDF_PARAMS. Not a
        // production-realistic value (uses test-fast m_kib=8); the goal
        // is to catch silent algorithm/encoding drift, not to assert
        // any cryptographic property of the derived key itself.
        let derived = derive_password_wrap_key(
            "correct horse battery staple",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let expected: [u8; 32] = [
            0x32, 0xCE, 0xD3, 0xC1, 0xED, 0xC4, 0x13, 0xEC, 0xFF, 0x6F, 0xF1, 0x1F, 0xD9, 0x2F,
            0xC2, 0x06, 0xC0, 0x2D, 0x29, 0x01, 0x7F, 0x94, 0x65, 0x82, 0x1E, 0x93, 0xC1, 0xFB,
            0xDB, 0x93, 0xFC, 0xE0,
        ];
        assert_eq!(*derived, expected);
    }

    #[test]
    fn derive_recovery_wrap_key_pinned_hex() {
        let phrase = recovery_phrase_from_fixed_entropy_for_test(&FIXED_PHRASE_ENTROPY);
        let derived = derive_recovery_wrap_key(
            &phrase,
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let expected: [u8; 32] = [
            0x7A, 0x65, 0xCE, 0x57, 0x3E, 0xD9, 0x44, 0xC7, 0x49, 0x8F, 0xD4, 0x58, 0x8F, 0x78,
            0xFC, 0x98, 0xD7, 0x9B, 0xEC, 0x5C, 0x1A, 0x1A, 0xC4, 0xA0, 0xB6, 0xD5, 0x21, 0x06,
            0xD8, 0x78, 0x6E, 0x76,
        ];
        assert_eq!(*derived, expected);
    }

    #[test]
    fn different_passwords_produce_different_wrap_keys() {
        let a = derive_password_wrap_key(
            "alpha",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let b = derive_password_wrap_key(
            "bravo",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        assert_ne!(*a, *b);
    }

    #[test]
    fn different_account_hashes_produce_different_wrap_keys() {
        // Spec § 3.1: account_number_hash is mixed into the salt
        // precisely to prevent precomputation across accounts.
        let mut other_account = FIXED_ACCOUNT_HASH;
        other_account[0] ^= 0x01;
        let a = derive_password_wrap_key(
            "same password",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let b = derive_password_wrap_key(
            "same password",
            &FIXED_SALT_RANDOM,
            &other_account,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        assert_ne!(*a, *b);
    }

    #[test]
    fn different_salt_random_produces_different_wrap_keys() {
        let mut other_salt = FIXED_SALT_RANDOM;
        other_salt[0] ^= 0x01;
        let a = derive_password_wrap_key(
            "p",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let b =
            derive_password_wrap_key("p", &other_salt, &FIXED_ACCOUNT_HASH, &FAST_TEST_KDF_PARAMS)
                .unwrap();
        assert_ne!(*a, *b);
    }

    #[test]
    fn different_kdf_params_produce_different_wrap_keys() {
        // Parameter binding: spec § 4.3 ensures that any change to the
        // stored Argon2id parameters yields a different output (which
        // then fails the AEAD tag check under the AAD-bound parameters).
        let mut other_params = FAST_TEST_KDF_PARAMS;
        other_params.t = 2;
        let a = derive_password_wrap_key(
            "p",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let b =
            derive_password_wrap_key("p", &FIXED_SALT_RANDOM, &FIXED_ACCOUNT_HASH, &other_params)
                .unwrap();
        assert_ne!(*a, *b);
    }

    #[test]
    fn password_and_recovery_paths_produce_different_keys_for_same_secret() {
        // Spec § 3.1 last paragraph: "the two distinct argon2id-password
        // / argon2id-recovery salt prefixes ensure the two Argon2id
        // outputs are domain-separated even if the same secret were
        // ever used for both (which it MUST NOT be)."
        let phrase = recovery_phrase_from_fixed_entropy_for_test(&FIXED_PHRASE_ENTROPY);
        let phrase_str = phrase.join_normalized();
        // Use the phrase string as a hypothetical password too — confirms
        // domain separation comes from the prefix, not the input bytes.
        let pw_key = derive_password_wrap_key(
            phrase_str.as_str(),
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let rec_key = derive_recovery_wrap_key(
            &phrase,
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        assert_ne!(*pw_key, *rec_key);
    }

    #[test]
    fn rejects_unsupported_argon2_version() {
        let mut bad_params = FAST_TEST_KDF_PARAMS;
        bad_params.argon2_version = 0xFF;
        let err =
            derive_password_wrap_key("p", &FIXED_SALT_RANDOM, &FIXED_ACCOUNT_HASH, &bad_params)
                .unwrap_err();
        assert_eq!(err, ProtocolError::KdfFailure);
    }

    #[test]
    fn rejects_invalid_argon2_params() {
        // Argon2 RFC 9106 requires m >= 8*p; m=4, p=1 violates this and
        // `Params::new` rejects. We map any error to KdfFailure.
        let bad_params = KdfParams {
            m_kib: 4, // below RFC 9106 minimum 8
            t: 1,
            p: 1,
            argon2_version: 0x13,
        };
        let err =
            derive_password_wrap_key("p", &FIXED_SALT_RANDOM, &FIXED_ACCOUNT_HASH, &bad_params)
                .unwrap_err();
        assert_eq!(err, ProtocolError::KdfFailure);
    }

    // ---- KAT vector regenerator (companion repo) ---------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/argon2id/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_argon2id_vectors.json`.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act —
    /// AND because regenerating at canonical params takes ~21 seconds
    /// (7 cases × ~3s per Argon2id derivation at m=256 MiB, t=3, p=2).
    /// The shipped vectors run as part of default `cargo test` (NOT
    /// `#[ignore]`-gated on the runner side) because they are
    /// protocol-contract assertions; only the regenerator is gated.
    ///
    /// 7 cases pin (per MYND-69 / D4; + the MYND-329 quickunlock-pin path):
    /// - 3 password-path × {short ASCII, long ASCII, raw unicode}
    /// - 3 recovery-path × {short ASCII, long ASCII, NFKD unicode}
    /// - 1 quickunlock-pin path (§9.14.2 PIN → wrap key)
    ///
    /// All cases use the canonical Phase 1 Argon2id parameters
    /// (`m_kib=262144, t=3, p=2, argon2_version=0x13`) — the v0.1
    /// baseline. Future v0.1.x mobile-profile vectors would land in
    /// a separate sub-directory with their own KdfParams; not this
    /// category's scope.
    #[test]
    #[ignore]
    fn emit_argon2id_wrap_vectors_for_paste() {
        extern crate std;
        use crate::types::DEFAULT_V0_1_KDF_PARAMS;
        use unicode_normalization::UnicodeNormalization;

        // Canonical Phase 1 params. DEFAULT_V0_1_KDF_PARAMS exposed via
        // crate::types — same constant the production code uses.
        let canonical_params = DEFAULT_V0_1_KDF_PARAMS;

        // Distinct fixed inputs across cases — same salt + account hash
        // every case so byte-level differences trace to (path × input).
        let salt_random: [u8; 16] = [0xEF; 16];
        let account_number_hash: [u8; 16] = [0x42; 16];

        // Password-path inputs (raw — no normalization by Myne).
        let pw_short = b"new-pw".to_vec();
        let pw_long = b"a-deliberately-long-passphrase-with-many-characters".to_vec();
        // Raw unicode password: "şifre-ñ" in NFC form. Bytes:
        // 0xC5 0x9F (ş) 0x69 (i) 0x66 (f) 0x72 (r) 0x65 (e) 0x2D (-) 0xC3 0xB1 (ñ)
        let pw_unicode = "şifre-ñ".as_bytes().to_vec();

        // Recovery-path inputs (caller MUST pre-normalize per spec §3.4
        // — we pass strings that ARE in NFKD form).
        let rec_short = b"abandon abandon abandon".to_vec();
        let rec_long =
            b"abandon abandon abandon abandon abandon abandon abandon abandon abandon".to_vec();
        // NFKD decomposition of "şifre-ñ":
        //   "ş" → "s" (0x73) + COMBINING CEDILLA (U+0327 = 0xCC 0xA7)
        //   "ifre-" → ASCII bytes
        //   "ñ" → "n" (0x6E) + COMBINING TILDE (U+0303 = 0xCC 0x83)
        // Total 11 UTF-8 bytes (vs 9 in NFC).
        let rec_unicode = "şifre-ñ"
            .nfkd()
            .collect::<alloc::string::String>()
            .into_bytes();

        // Derive all 6 wrap keys. ~3s each at canonical params; total ~18s.
        let pw_short_key = derive_password_wrap_key(
            core::str::from_utf8(&pw_short).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive password short");
        let pw_long_key = derive_password_wrap_key(
            core::str::from_utf8(&pw_long).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive password long");
        let pw_unicode_key = derive_password_wrap_key(
            core::str::from_utf8(&pw_unicode).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive password unicode");
        let rec_short_key = derive_recovery_wrap_key_from_normalized(
            core::str::from_utf8(&rec_short).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive recovery short");
        let rec_long_key = derive_recovery_wrap_key_from_normalized(
            core::str::from_utf8(&rec_long).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive recovery long");
        let rec_unicode_key = derive_recovery_wrap_key_from_normalized(
            core::str::from_utf8(&rec_unicode).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive recovery unicode");

        // quickunlock-pin path (§9.14.2): the PIN run through Argon2id with the
        // distinct salt-domain prefix "myne.v0.1 argon2id-quickunlock-pin|". The
        // 16-byte pin_salt plays the salt_random role in build_salt, so it is
        // carried in the shared `input_salt_random_hex` field. ~3s at canonical
        // params (the memory-hardness is what makes a low-entropy PIN costly to
        // brute-force offline). 6-digit PIN — the host enforces MIN_PIN_LEN.
        let pin = b"246813".to_vec();
        let pin_key = derive_quick_unlock_pin_wrap_key(
            core::str::from_utf8(&pin).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive quickunlock pin");
        let salt_hex = hex_lower(&salt_random);
        let acct_hex = hex_lower(&account_number_hash);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"argon2id\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §3 + §4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::derive_password_wrap_key + protocol::derive_recovery_wrap_key_from_normalized + protocol::derive_quick_unlock_pin_wrap_key byte mapping under canonical Phase 1 Argon2id parameters (m=256 MiB, t=3, p=2, v=0x13). 7 cases: password × {short, long, unicode} + recovery × {short, long, NFKD-unicode} + quickunlock-pin (§9.14.2). The three paths share an Argon2id core but use distinct salt-domain prefixes (argon2id-password| / argon2id-recovery| / argon2id-quickunlock-pin|), so identical input bytes derive different keys per path. EXPECTED RUNTIME: ~21s total (~3s per case at canonical params). Default-on in `cargo test`; only the regenerator is `#[ignore]`-gated. Cases generated by `cargo test -p protocol --lib emit_argon2id_wrap_vectors_for_paste -- --ignored` (in protocol/src/kdf.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        // Helper emit closure.
        let emit_case = |dump: &mut alloc::string::String,
                         slug: &str,
                         description: &str,
                         path: &str,
                         password_or_phrase: &[u8],
                         wrap_key: &[u8],
                         trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"argon2id/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str(&alloc::format!("      \"input_path\": \"{}\",\n", path));
            dump.push_str(&alloc::format!(
                "      \"input_password_or_phrase_utf8_hex\": \"{}\",\n",
                hex_lower(password_or_phrase)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_salt_random_hex\": \"{}\",\n",
                salt_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                acct_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_kdf_params\": {{\n        \"m_kib\": {},\n        \"t\": {},\n        \"p\": {},\n        \"argon2_version_hex\": \"{:02x}\"\n      }},\n",
                canonical_params.m_kib,
                canonical_params.t,
                canonical_params.p,
                canonical_params.argon2_version
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_wrap_key_hex\": \"{}\"\n",
                hex_lower(wrap_key)
            ));
            if trailing_comma {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        };

        emit_case(
            &mut dump,
            "password-short",
            "Password-path derivation with 6-byte ASCII password ('new-pw'). Smallest representative password — exercises the Argon2id derive at canonical params with minimal input length.",
            "password",
            &pw_short,
            &*pw_short_key,
            true,
        );
        emit_case(
            &mut dump,
            "password-long",
            "Password-path derivation with 51-byte ASCII passphrase. Mid-length representative case; password length does not affect Argon2id memory cost (input is absorbed into the BLAKE2b state regardless), so timing is identical to other cases.",
            "password",
            &pw_long,
            &*pw_long_key,
            true,
        );
        emit_case(
            &mut dump,
            "password-unicode",
            "Password-path derivation with raw NFC unicode bytes ('şifre-ñ' = 9 UTF-8 bytes). Myne does NOT normalize passwords on the client side — the bytes the user types are the bytes fed to Argon2id. This case pins the cross-impl byte mapping for non-ASCII passwords.",
            "password",
            &pw_unicode,
            &*pw_unicode_key,
            true,
        );
        emit_case(
            &mut dump,
            "recovery-short",
            "Recovery-path derivation with 3-word abandon phrase (NFKD-normalized — caller MUST normalize before invoking derive_recovery_wrap_key_from_normalized per spec §3.4). Smallest valid input.",
            "recovery",
            &rec_short,
            &*rec_short_key,
            true,
        );
        emit_case(
            &mut dump,
            "recovery-long",
            "Recovery-path derivation with 9-word abandon phrase. Longer NFKD input — same Argon2id memory cost; cross-impl byte mapping pinned at a representative full-length recovery phrase footprint.",
            "recovery",
            &rec_long,
            &*rec_long_key,
            true,
        );
        emit_case(
            &mut dump,
            "recovery-nfkd-unicode",
            "Recovery-path derivation with NFKD-decomposed unicode bytes (11 UTF-8 bytes representing 'şifre-ñ' decomposed via NFKD: 's' + COMBINING CEDILLA U+0327 + 'ifre-' + 'n' + COMBINING TILDE U+0303). Demonstrates the NFKD-output bytes are what reach Argon2id — implementations that skip the NFKD normalization step would feed different bytes (e.g., NFC form 0xC5 0x9F instead of 0x73 0xCC 0xA7 for 'ş') and produce a different wrap key.",
            "recovery",
            &rec_unicode,
            &*rec_unicode_key,
            true,
        );
        emit_case(
            &mut dump,
            "quickunlock-pin",
            "Quick-unlock PIN-path derivation (§9.14.2). The PIN ('246813' = 6 ASCII digits) is fed to Argon2id with salt = SHA-256('myne.v0.1 argon2id-quickunlock-pin|' || account_number_hash || pin_salt)[:16] — a DISTINCT salt-domain prefix from the password path ('myne.v0.1 argon2id-password|'), so the same input bytes + salt_random + account_hash under a different path produce a different wrap key (domain separation). The wrap key returned here is what the MYQ1 vault.quickunlock codec consumes DIRECTLY (see the vault-quickunlock category — the codec never runs Argon2id itself). NOTE: for this path the shared input_salt_random_hex field carries the 16-byte pin_salt.",
            "quickunlock-pin",
            &pin,
            &*pin_key,
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_argon2id_vectors.json", dump.as_bytes())
            .expect("write argon2id vectors dump");
    }

    /// Vector generator for the `person-keypair` v0.2 Argon2id path (the B2B
    /// identity substrate, myne-md/myne#698). `#[ignore]`-gated, emits
    /// ready-to-copy JSON to `/tmp/myne_person_keypair_vectors.json`.
    ///
    /// Pins [`derive_person_keypair_wrap_key_from_normalized`] under the
    /// `"myne.v0.2 argon2id-person-keypair|"` salt domain: the person's own
    /// recovery phrase → wrap key, with the phrase-derived `person_id_hash` in
    /// the `account_number_hash` salt slot (this path is vault-independent, so
    /// no vault account hash is involved). Two cases with different person ids
    /// show the person-level domain separation: the same phrase and salt derive
    /// DIFFERENT keys for two people. ~3s per case at canonical params.
    #[test]
    #[ignore = "vector generator; run explicitly to refresh person-keypair cases.json"]
    fn emit_person_keypair_vectors_for_paste() {
        extern crate std;
        use crate::types::DEFAULT_V0_1_KDF_PARAMS;

        let params = DEFAULT_V0_1_KDF_PARAMS;
        let salt_random: [u8; 16] = [0xEF; 16];
        let phrase = b"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".to_vec();
        let phrase_str = core::str::from_utf8(&phrase).unwrap();
        // The REAL phrase-derived person id, so the vector pins the actual
        // construction (`person_id_hash`) and not a fabricated constant. Case B
        // uses a different phrase, which changes both the person id and the
        // Argon2id password, so it is domain separation in the strong sense.
        let person_a: [u8; 16] = person_id_hash(phrase_str);
        let phrase_b = b"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon".to_vec();
        let phrase_b_str = core::str::from_utf8(&phrase_b).unwrap();
        let person_b: [u8; 16] = person_id_hash(phrase_b_str);

        let key_a = derive_person_keypair_wrap_key_from_normalized(
            phrase_str,
            &salt_random,
            &person_a,
            &params,
        )
        .expect("derive person keypair A");
        let key_b = derive_person_keypair_wrap_key_from_normalized(
            phrase_b_str,
            &salt_random,
            &person_b,
            &params,
        )
        .expect("derive person keypair B");
        // Domain separation assertion at mint: two people (different phrase,
        // hence different person id), same salt, MUST derive different keys.
        assert_ne!(&*key_a, &*key_b, "person id must domain-separate the key");

        let salt_hex = hex_lower(&salt_random);
        let phrase_a_hex = hex_lower(&phrase);
        let phrase_b_hex = hex_lower(&phrase_b);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"person-keypair\",\n");
        dump.push_str("  \"protocol_version\": \"v0.2\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §3.1\",\n");
        dump.push_str("  \"description\": \"Pins protocol::derive_person_keypair_wrap_key_from_normalized + protocol::person_id_hash under the v0.2 salt domain 'myne.v0.2 argon2id-person-keypair|'. Two cases, different normalized phrases (hence different person_id_hash values), same salt, so person-level domain separation is pinned: different phrases derive different wrap keys under the same salt. Vault-independent: the account_number_hash salt slot carries the phrase-derived person_id_hash, not any vault's account hash. EXPECTED RUNTIME: ~6s total. Default-on in `cargo test`; only the regenerator is #[ignore]-gated. Generated by `cargo test -p protocol --lib emit_person_keypair_vectors_for_paste -- --ignored`.\",\n");
        dump.push_str("  \"cases\": [\n");

        let emit_case = |dump: &mut alloc::string::String,
                         slug: &str,
                         description: &str,
                         phrase_hex: &str,
                         person_id: &[u8; 16],
                         wrap_key: &[u8; 32],
                         trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"person-keypair/v0.2/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_phrase_utf8_hex\": \"{}\",\n",
                phrase_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_salt_random_hex\": \"{}\",\n",
                salt_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_person_id_hash_hex\": \"{}\",\n",
                hex_lower(person_id)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_kdf_params\": {{\n        \"m_kib\": {},\n        \"t\": {},\n        \"p\": {},\n        \"argon2_version_hex\": \"{:02x}\"\n      }},\n",
                params.m_kib, params.t, params.p, params.argon2_version
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_wrap_key_hex\": \"{}\"\n",
                hex_lower(wrap_key)
            ));
            dump.push_str(if trailing_comma {
                "    },\n"
            } else {
                "    }\n"
            });
        };

        emit_case(
            &mut dump,
            "person-keypair-a",
            "Person-keypair wrap key for the 12-word 'abandon … about' phrase. Its person_id_hash is SHA-256('myne.person-id|' || phrase)[:16], pinned here so the derivation the salt binds is cross-implementation. The phrase is fed raw (already NFKD-normalizable ASCII; the caller normalizes before this call per §3.4).",
            &phrase_a_hex,
            &person_a,
            &key_a,
            true,
        );
        emit_case(
            &mut dump,
            "person-keypair-b",
            "A DIFFERENT normalized phrase, same salt. Both the Argon2id password and the person_id_hash change, so the wrap key differs from case A: two people never share a wrap key for one salt.",
            &phrase_b_hex,
            &person_b,
            &key_b,
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");
        std::fs::write("/tmp/myne_person_keypair_vectors.json", dump.as_bytes())
            .expect("write person-keypair vectors dump");
    }

    /// Vector generator for the `bip39-recovery` companion category.
    /// `#[ignore]`-gated — emits ready-to-copy JSON to
    /// `/tmp/myne_bip39_recovery_vectors.json`. Composes
    /// [`crate::phrase::normalize_user_phrase`] (§7.4) →
    /// [`derive_recovery_wrap_key_from_normalized`] (§3.1) end-to-end: a
    /// raw user-typed 24-word phrase is normalized, then fed **directly**
    /// to Argon2id (NOT through BIP-39's PBKDF2 step). The three cases
    /// type the SAME 24 words three ways (canonical / mixed-case+messy
    /// whitespace / NFKD-foldable full-width + exotic whitespace) and the
    /// generator asserts all three normalize identically and derive the
    /// SAME wrap key — pinning the NFKD-before-Argon2id ordering. ~3s per
    /// case at canonical params.
    #[test]
    #[ignore = "vector generator — run explicitly to refresh bip39-recovery cases.json"]
    fn emit_bip39_recovery_vectors_for_paste() {
        extern crate std;
        use crate::phrase::normalize_user_phrase;
        use crate::types::DEFAULT_V0_1_KDF_PARAMS;
        use alloc::string::String;
        use alloc::vec::Vec;

        let params = DEFAULT_V0_1_KDF_PARAMS;
        // Distinct from the argon2id category's fixtures so a key collision
        // across categories can never mask a bug.
        let salt_random: [u8; 16] = [0x5A; 16];
        let account_number_hash: [u8; 16] = [0xA5; 16];

        // The canonical BIP-39 all-zero-entropy 24-word phrase: 23×abandon
        // + the checksum word `art`. Already in normalized form (lowercase,
        // single ASCII spaces, trimmed).
        let mut words: Vec<&str> = alloc::vec!["abandon"; 23];
        words.push("art");
        let canonical: String = words.join(" ");

        // Variant 2: same 24 words, UPPERCASED, with leading/trailing pad
        // and irregular interior whitespace (double space + tab). Exercises
        // ASCII-lowercase + whitespace-coalesce + trim.
        let messy: String = alloc::format!(
            "   {}   ",
            words
                .iter()
                .map(|w| w.to_uppercase())
                .collect::<Vec<_>>()
                .join("  \t ")
        );

        // Variant 3: same 24 words, but the last word `art` typed in
        // full-width Latin (U+FF41 U+FF52 U+FF54) and two separators using
        // a no-break space (U+00A0) and an ideographic space (U+3000).
        // NFKD folds full-width letters → ASCII and both exotic spaces →
        // regular space. Pins NFKD-before-Argon2id: a port that skips NFKD
        // feeds different bytes and derives a different key.
        let nfkd_raw: String = alloc::format!(
            "{}\u{00A0}{}\u{3000}{}",
            words[..22].join(" "),
            words[22],
            "\u{FF41}\u{FF52}\u{FF54}"
        );

        // Normalize each, assert all three collapse to the canonical form.
        let norm_canonical = normalize_user_phrase(&canonical);
        let norm_messy = normalize_user_phrase(&messy);
        let norm_nfkd = normalize_user_phrase(&nfkd_raw);
        assert_eq!(
            norm_canonical.as_str(),
            canonical.as_str(),
            "canonical input must be a fixed point of normalize_user_phrase"
        );
        assert_eq!(
            norm_messy.as_str(),
            canonical.as_str(),
            "messy variant must normalize to the canonical phrase"
        );
        assert_eq!(
            norm_nfkd.as_str(),
            canonical.as_str(),
            "NFKD variant must normalize to the canonical phrase"
        );

        // Derive a wrap key per case (the full §3.1 recovery composition).
        let derive = |normalized: &str| {
            derive_recovery_wrap_key_from_normalized(
                normalized,
                &salt_random,
                &account_number_hash,
                &params,
            )
            .expect("derive recovery wrap key")
        };
        let key_canonical = derive(norm_canonical.as_str());
        let key_messy = derive(norm_messy.as_str());
        let key_nfkd = derive(norm_nfkd.as_str());
        // The whole point: three different raw inputs, one wrap key.
        assert_eq!(&*key_messy, &*key_canonical, "messy must derive same key");
        assert_eq!(&*key_nfkd, &*key_canonical, "NFKD must derive same key");

        let salt_hex = hex_lower(&salt_random);
        let acct_hex = hex_lower(&account_number_hash);

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"bip39-recovery\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §3.1 + §7.4\",\n");
        dump.push_str("  \"description\": \"Pins the end-to-end recovery composition protocol::phrase::normalize_user_phrase (§7.4) -> protocol::derive_recovery_wrap_key_from_normalized (§3.1): a raw user-typed 24-word phrase is NFKD-normalized then fed DIRECTLY to Argon2id (NOT BIP-39's PBKDF2 step). 3 cases type the SAME 24 words three ways (canonical / mixed-case+messy-whitespace / NFKD-foldable full-width+exotic-whitespace); all three MUST derive the identical wrap key, pinning the NFKD-before-Argon2id ordering. EXPECTED RUNTIME: ~9s total (~3s per case at canonical params m=256 MiB, t=3, p=2). Default-on in `cargo test`; only the regenerator is `#[ignore]`-gated. Cases generated by `cargo test -p protocol --lib emit_bip39_recovery_vectors_for_paste -- --ignored` (in protocol/src/kdf.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        let emit_case = |dump: &mut String,
                         slug: &str,
                         description: &str,
                         raw_phrase: &str,
                         normalized: &str,
                         wrap_key: &[u8],
                         trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"bip39-recovery/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_raw_phrase_utf8_hex\": \"{}\",\n",
                hex_lower(raw_phrase.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"input_salt_random_hex\": \"{}\",\n",
                salt_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                acct_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_kdf_params\": {{\n        \"m_kib\": {},\n        \"t\": {},\n        \"p\": {},\n        \"argon2_version_hex\": \"{:02x}\"\n      }},\n",
                params.m_kib, params.t, params.p, params.argon2_version
            ));
            dump.push_str(&alloc::format!(
                "      \"informational_normalized_phrase_utf8_hex\": \"{}\",\n",
                hex_lower(normalized.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_recovery_wrap_key_hex\": \"{}\"\n",
                hex_lower(wrap_key)
            ));
            dump.push_str(if trailing_comma {
                "    },\n"
            } else {
                "    }\n"
            });
        };

        emit_case(
            &mut dump,
            "canonical-24w",
            "The canonical BIP-39 all-zero-entropy 24-word phrase (23x abandon + checksum word 'art'), typed already in normalized form (lowercase, single ASCII spaces, no padding). Baseline: normalize_user_phrase is a fixed point here, so this pins the recovery_wrap_key for the canonical normalized string fed straight to Argon2id.",
            &canonical,
            norm_canonical.as_str(),
            &*key_canonical,
            true,
        );
        emit_case(
            &mut dump,
            "messy-case-whitespace-24w",
            "The SAME 24 words, fully UPPERCASED, with leading/trailing whitespace padding and irregular interior whitespace (double space + tab between every word). normalize_user_phrase ASCII-lowercases, coalesces whitespace runs to a single U+0020, and trims — yielding the identical normalized string as the canonical case, hence the IDENTICAL wrap key. Pins that case-folding + whitespace normalization happen BEFORE Argon2id.",
            &messy,
            norm_messy.as_str(),
            &*key_messy,
            true,
        );
        emit_case(
            &mut dump,
            "nfkd-fullwidth-24w",
            "The SAME 24 words, but the checksum word 'art' typed in full-width Latin (U+FF41 U+FF52 U+FF54) and two word separators replaced by a no-break space (U+00A0) and an ideographic space (U+3000). NFKD compatibility-decomposition folds the full-width letters to ASCII and both exotic spaces to regular spaces; the result normalizes to the canonical phrase and derives the IDENTICAL wrap key. Pins NFKD-before-Argon2id: a port that skips the NFKD pass would feed the raw full-width/NBSP bytes to Argon2id and derive a DIFFERENT (wrong) key.",
            &nfkd_raw,
            norm_nfkd.as_str(),
            &*key_nfkd,
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_bip39_recovery_vectors.json", dump.as_bytes())
            .expect("write bip39-recovery vectors dump");
    }

    #[test]
    fn person_scram_and_private_profile_domains_are_distinct() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let person_id = person_id_hash(phrase);
        let profile_id = person_profile_id(&person_id, &FIXED_ACCOUNT_HASH);

        let scram = derive_person_server_auth_key_from_normalized(
            phrase,
            &FIXED_SALT_RANDOM,
            &person_id,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("person SCRAM key");
        let profile = derive_person_vault_profile_key_from_normalized(
            phrase,
            &FIXED_SALT_RANDOM,
            &profile_id,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("private profile key");

        assert_ne!(scram.as_slice(), profile.as_slice());
    }

    #[test]
    fn person_server_auth_production_entry_point_uses_the_fixed_salt() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let person_id = person_id_hash(phrase);

        // The production wrapper is the `_from_normalized` form with the spec's
        // fixed salt, so a device with only the phrase derives the same secret.
        let prod =
            derive_person_server_auth_key(phrase, &person_id, &FAST_TEST_KDF_PARAMS).expect("prod");
        let explicit = derive_person_server_auth_key_from_normalized(
            phrase,
            &PERSON_SERVER_AUTH_SALT_RANDOM,
            &person_id,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("explicit");
        assert_eq!(prod.as_slice(), explicit.as_slice());

        // Phrase-sensitive AND bound to the person id in the salt slot.
        let other_id = person_id_hash("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon");
        let by_id =
            derive_person_server_auth_key(phrase, &other_id, &FAST_TEST_KDF_PARAMS).expect("id");
        assert_ne!(prod.as_slice(), by_id.as_slice());
        let by_phrase = derive_person_server_auth_key(
            "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
            &person_id,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("phrase");
        assert_ne!(prod.as_slice(), by_phrase.as_slice());
    }

    // ---- Deterministic person identity (decisions/protocol/0604) ----

    #[test]
    fn person_identity_seed_is_deterministic_and_phrase_sensitive() {
        let phrase_a = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let phrase_b = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
        let id_a = person_id_hash(phrase_a);
        let id_b = person_id_hash(phrase_b);

        let seed_a1 =
            derive_person_identity_seed(phrase_a, &id_a, &FAST_TEST_KDF_PARAMS).expect("seed A");
        let seed_a2 =
            derive_person_identity_seed(phrase_a, &id_a, &FAST_TEST_KDF_PARAMS).expect("seed A2");
        let seed_b =
            derive_person_identity_seed(phrase_b, &id_b, &FAST_TEST_KDF_PARAMS).expect("seed B");

        assert_eq!(
            *seed_a1, *seed_a2,
            "the same phrase must derive the same identity seed on every call"
        );
        assert_ne!(
            *seed_a1, *seed_b,
            "a different phrase must derive a different identity seed"
        );

        let ka = expand_person_identity_key_seeds(&seed_a1);
        let kb = expand_person_identity_key_seeds(&seed_b);
        assert_ne!(
            ka.kem, kb.kem,
            "a different phrase must change the KEM seed"
        );
        assert_ne!(
            ka.ed25519, kb.ed25519,
            "a different phrase must change the Ed25519 seed"
        );
        assert_ne!(
            ka.mldsa, kb.mldsa,
            "a different phrase must change the ML-DSA seed"
        );
    }

    #[test]
    fn person_identity_seed_differs_from_the_at_rest_wrap_key() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let id = person_id_hash(phrase);
        let seed =
            derive_person_identity_seed(phrase, &id, &FAST_TEST_KDF_PARAMS).expect("identity seed");
        let wrap = derive_person_keypair_wrap_key_from_normalized(
            phrase,
            &PERSON_IDENTITY_SALT_RANDOM,
            &id,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("wrap key");
        assert_ne!(
            seed.as_slice(),
            wrap.as_slice(),
            "the identity seed and the at-rest wrap key must be domain-separated"
        );
    }

    #[test]
    fn person_identity_key_types_are_domain_separated() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let id = person_id_hash(phrase);
        let seed =
            derive_person_identity_seed(phrase, &id, &FAST_TEST_KDF_PARAMS).expect("identity seed");
        let seeds = expand_person_identity_key_seeds(&seed);

        assert_eq!(seeds.kem.len(), PERSON_KEM_SEED_LEN);
        assert_eq!(seeds.ed25519.len(), PERSON_ED25519_SEED_LEN);
        assert_eq!(seeds.mldsa.len(), PERSON_MLDSA_SEED_LEN);
        assert_ne!(
            &seeds.kem[..32],
            &seeds.ed25519[..],
            "KEM and Ed25519 seeds must differ"
        );
        assert_ne!(
            &seeds.ed25519[..],
            &seeds.mldsa[..],
            "Ed25519 and ML-DSA seeds must differ"
        );
        assert_ne!(
            &seeds.kem[..32],
            &seeds.mldsa[..],
            "KEM and ML-DSA seeds must differ"
        );
    }

    #[test]
    fn person_identity_derives_a_stable_keypair_and_fingerprint() {
        use crate::person_key::PersonKeyPair;
        let phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let id = person_id_hash(phrase);
        let seed =
            derive_person_identity_seed(phrase, &id, &FAST_TEST_KDF_PARAMS).expect("identity seed");

        let k1 = expand_person_identity_key_seeds(&seed);
        let k2 = expand_person_identity_key_seeds(&seed);
        let a = PersonKeyPair::generate_raw(&k1.kem, &k1.ed25519, &k1.mldsa);
        let b = PersonKeyPair::generate_raw(&k2.kem, &k2.ed25519, &k2.mldsa);
        assert_eq!(
            a.fingerprint(),
            b.fingerprint(),
            "a deterministically derived identity must be stable across calls"
        );
    }
}
