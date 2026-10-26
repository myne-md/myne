// SPDX-License-Identifier: AGPL-3.0
//! Whole-vault v0.1 → v0.2 migration — the crypto core (`spec/protocol.md`
//! §10.4.1, automerge-sync-migration #420 task 2).
//!
//! This module holds the **pure, I/O-free crypto heart** of the eager whole-vault
//! §10.4 cutover: given a completed v0.1 unlock (the old `itemsKey`) and the two
//! credentials, it mints a fresh v0.2 key hierarchy and re-encrypts every note
//! from `MY01` to `NC05` under the new `itemsKey`. It returns the bytes the I/O
//! orchestration writes — it does no disk work itself, so it is unit-testable to
//! the byte without a vault on disk.
//!
//! The **phrase-required rule** (§10.4.1) is structural here: [`migrate_keys_and_notes`]
//! takes the normalized recovery phrase as a required parameter and wraps the new
//! `root_key` under BOTH credentials via [`protocol::encode_vault_meta_v0_2_raw`],
//! so a caller that lacks the phrase cannot call it. The command layer adds the
//! typed `RecoveryPhraseRequired` refusal in front (the UI-bug-proof gate).
//!
//! [`migrate_keys_and_notes`] is the pure crypto core (keys + `MY01`→`NC05`); the
//! I/O orchestration ([`migrate_vault_notes_on_disk`]) around it stages the
//! `legacy/` snapshot, writes the re-keyed artifacts, re-seals every real-content
//! singleton to its `MY?5` family (prefs, themes, dictionary, attachments catalog +
//! blobs), drops the rebuildable caches + quick-unlock, and commits the
//! `vault.meta`→`NTV5` last. **Not yet wired here:** the automatic `legacy/`-restore
//! on a torn migration (the snapshot exists; the restore path is follow-on), and
//! progress events.

pub(crate) mod adopt;
pub mod b2b;
pub mod ntv7;
pub mod progress;

use crate::host::HostCtx;
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::aead::{ROLE_STR_CUSTOM_THEMES_BLOB, ROLE_STR_PERSONAL_DICT_BLOB};
use protocol::{
    decode_attachments_catalog, decode_note, decode_prefs_blob, derive_subkey, derive_subkey_v0_2,
    encode_attachments_catalog_versioned, encode_prefs_blob_versioned, encode_vault_meta_v0_2_raw,
    reseal_agent_memory_blob_v0_2, reseal_attachment_v0_2, reseal_chats_blob_v0_2,
    reseal_kek_envelope_v0_2_with_formats, KdfParams, MetaVersion, SubkeyRole,
    AGENT_MEMORY_CATALOG_BLOB_AAD_ROLE, AGENT_MEMORY_CATALOG_BLOB_MAGIC,
    AGENT_MEMORY_CATALOG_BLOB_V0_2_MAGIC, AGENT_PERSONALITY_BLOB_AAD_ROLE,
    AGENT_PERSONALITY_BLOB_MAGIC, AGENT_PERSONALITY_BLOB_V0_2_MAGIC, CHATS_CATALOG_BLOB_AAD_ROLE,
    CHATS_CATALOG_BLOB_MAGIC, CHATS_CATALOG_BLOB_V0_2_MAGIC, DICTIONARY_BLOB_MAGIC,
    DICTIONARY_BLOB_V0_2_MAGIC, MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN,
    MAX_AGENT_PERSONALITY_PLAINTEXT_LEN, THEMES_BLOB_MAGIC, THEMES_BLOB_V0_2_MAGIC,
};
use std::path::Path;
use zeroize::Zeroizing;

/// One KEK-envelope singleton family the migration re-seals in place (§10.4.1).
struct KekSingleton {
    /// Vault-root filename (e.g. `vault.themes`).
    filename: &'static str,
    /// v0.1 magic and its v0.2 (`MY?5`) successor.
    old_magic: &'static [u8; 4],
    new_magic: &'static [u8; 4],
    /// The family's `blob_envelope` format-version byte: what the re-sealed
    /// blob is WRITTEN with.
    format_version: u8,
    /// The `format_version` values the SOURCE blob may carry. `None` means
    /// "exactly `format_version`" (the single-generation case, which is every
    /// family but one). `Some` is for a family whose inner format gained a
    /// generation while its on-disk blobs from the previous build still exist:
    /// `vault.dictionary` is `0x01` on a pre-myne#640 vault and `0x02` today, so
    /// a migration must accept both while producing the current one. A single
    /// value here would make the migration abort on every vault that had not yet
    /// re-written its dictionary, which is the silent-loss shape the migration
    /// exists to avoid.
    decode_formats: Option<&'static [u8]>,
    /// The family's AAD role string, imported from `protocol` rather than
    /// spelled here. The registry is `docs/spec/protocol.md` §5.2 and a drift
    /// between the two spellings is invisible to every compiler.
    aad_role: &'static [u8],
    /// The `root_key`-derived KEK role (`derive_subkey` v0.1 / `_v0_2` v0.2).
    kek_role: SubkeyRole,
    /// The family's inner-plaintext cap.
    cap: usize,
}

/// The real-content KEK-envelope singletons re-sealed in place. `vault.prefs`
/// (`MYP1`, hand-rolled) and the catalog (`MYC1`) carry their own framing and
/// re-seal on their own paths; the rebuildable KEK caches are dropped, not sealed.
const KEK_SINGLETONS: &[KekSingleton] = &[
    KekSingleton {
        filename: "vault.themes",
        old_magic: &THEMES_BLOB_MAGIC,
        new_magic: &THEMES_BLOB_V0_2_MAGIC,
        format_version: 0x01,
        decode_formats: None,
        aad_role: ROLE_STR_CUSTOM_THEMES_BLOB,
        kek_role: SubkeyRole::CustomThemesKey,
        cap: 4 * 1024 * 1024,
    },
    KekSingleton {
        filename: "vault.dictionary",
        old_magic: &DICTIONARY_BLOB_MAGIC,
        new_magic: &DICTIONARY_BLOB_V0_2_MAGIC,
        // myne-md/myne#640: a pre-#640 vault's dictionary is `0x01` and this
        // build writes `0x02`, so the SOURCE accepts both and the re-seal
        // produces the current one. A single expected format here aborts the
        // whole migration on every vault whose dictionary had not been
        // re-written yet.
        format_version: protocol::DICTIONARY_BLOB_FORMAT_CURRENT,
        decode_formats: Some(&protocol::DICTIONARY_BLOB_SUPPORTED_FORMATS),
        aad_role: ROLE_STR_PERSONAL_DICT_BLOB,
        kek_role: SubkeyRole::PersonalDictKey,
        cap: 4 * 1024 * 1024,
    },
    // AI conversations catalog (MYM1 → MYM5, myne-md/myne#675): same
    // KEK-envelope re-seal as the other singletons. The per-conversation
    // files (`chats/<id>`) re-seal separately below (they need their
    // conversation id for the AAD, which this table's shape cannot carry).
    KekSingleton {
        filename: "vault.chats",
        old_magic: &CHATS_CATALOG_BLOB_MAGIC,
        new_magic: &CHATS_CATALOG_BLOB_V0_2_MAGIC,
        format_version: 0x01,
        decode_formats: None,
        aad_role: CHATS_CATALOG_BLOB_AAD_ROLE,
        kek_role: SubkeyRole::ChatsCatalogKey,
        cap: 4 * 1024 * 1024,
    },
    // Agent-memory catalog (MYN1 → MYN5, myne-md/myne#697): same
    // KEK-envelope re-seal as the other singletons. The per-entry files
    // (`memories/<id>`) re-seal separately below (they need their entry id
    // for the AAD, which this table's shape cannot carry).
    KekSingleton {
        filename: "vault.agent-memory",
        old_magic: &AGENT_MEMORY_CATALOG_BLOB_MAGIC,
        new_magic: &AGENT_MEMORY_CATALOG_BLOB_V0_2_MAGIC,
        format_version: 0x01,
        decode_formats: None,
        aad_role: AGENT_MEMORY_CATALOG_BLOB_AAD_ROLE,
        kek_role: SubkeyRole::AgentMemoryCatalogKey,
        // The codec's own cap, not a copy of it: a drift between the re-seal
        // cap and the reader cap strands or truncates (myne-md/myne#697).
        cap: MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN,
    },
    // Agent personality (MYZ1 → MYZ5, myne-md/myne#697): same re-seal.
    KekSingleton {
        filename: "vault.personality",
        old_magic: &AGENT_PERSONALITY_BLOB_MAGIC,
        new_magic: &AGENT_PERSONALITY_BLOB_V0_2_MAGIC,
        format_version: 0x01,
        decode_formats: None,
        aad_role: AGENT_PERSONALITY_BLOB_AAD_ROLE,
        kek_role: SubkeyRole::AgentPersonalityKey,
        cap: MAX_AGENT_PERSONALITY_PLAINTEXT_LEN,
    },
];
/// Re-seal ONE [`KekSingleton`] from the old root tier to the new one.
///
/// Factored out so the fail-closed PRE-FLIGHT (step 3b) and the real re-seal
/// (step 5) cannot drift: they used to be two hand-copied calls, and the
/// `decode_formats` half of this change had to be applied to both or the
/// pre-flight would have aborted a vault the real pass would have accepted
/// (myne-md/myne#640).
fn reseal_kek_singleton(
    fam: &KekSingleton,
    old_blob: &[u8],
    old_root_key: &[u8; 32],
    new_root_key: &[u8; 32],
    account_number_hash: &[u8; 16],
) -> Result<Vec<u8>, protocol::ProtocolError> {
    // The re-seal is inner-opaque by design (it decodes the envelope and
    // re-encodes the plaintext unchanged), so the header MUST keep describing the
    // payload it carries. For a multi-generation family the source byte is
    // preserved and the next local write performs the real upgrade; writing the
    // current byte over an older payload is a relabel the reader then rejects,
    // which is a silent loss of the family on the upgrade path
    // (myne-md/myne#640).
    let single = [fam.format_version];
    let supported = fam.decode_formats.unwrap_or(&single);
    let source_format = old_blob
        .get(5)
        .copied()
        .filter(|f| supported.contains(f))
        .unwrap_or(fam.format_version);
    let encode_format = if fam.decode_formats.is_some() {
        source_format
    } else {
        fam.format_version
    };
    reseal_kek_envelope_v0_2_with_formats(
        old_blob,
        &derive_subkey(old_root_key, fam.kek_role),
        &derive_subkey_v0_2(new_root_key, fam.kek_role),
        fam.old_magic,
        fam.new_magic,
        supported,
        encode_format,
        fam.aad_role,
        account_number_hash,
        fam.cap,
    )
}
/// A note re-encrypted from `MY01` to `NC05` by the migration.
#[derive(Debug, Clone)]
pub struct MigratedNote {
    /// The note's 16-byte UUID (unchanged across the migration — the filename
    /// stays `<uuid>.myn`, only the blob family changes).
    pub note_uuid: [u8; 16],
    /// The freshly-sealed `NC05` blob (a new per-note `item_key` under the new
    /// `itemsKey`, v0.2 AAD).
    pub nc05_blob: Vec<u8>,
}

/// The bytes the I/O orchestration writes to commit a migration.
pub struct MigrationOutput {
    /// The new `NTV5` `vault.meta` (345 bytes) — the atomic commit point, written
    /// LAST (§10.4.1). The new `root_key` is wrapped under both credentials inside.
    pub ntv5_meta: Vec<u8>,
    /// The freshly-minted v0.2 `root_key` (the migrated vault's new root). The
    /// caller uses it to re-seal singletons under their v0.2 KEKs, then zeroizes.
    pub new_root_key: Zeroizing<[u8; 32]>,
    /// The v0.2 `itemsKey` (random) the notes were re-wrapped under, and its id.
    pub new_items_key: Zeroizing<[u8; 32]>,
    /// The v0.2 `items_key_id` written into the `NTV5` header + every `NC05` note.
    pub new_items_key_id: [u8; 16],
    /// Every note, re-encrypted `MY01`→`NC05`.
    pub notes: Vec<MigratedNote>,
}

/// Why the migration crypto core failed. Non-distinguishing at the eventual IPC
/// boundary (the command layer collapses these), split here for the tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationError {
    /// A source `MY01` note did not decrypt under the old `itemsKey` (wrong key,
    /// tamper, or not a `MY01` blob).
    CannotDecryptNote,
    /// A decrypted note's plaintext was not valid UTF-8 (structural corruption —
    /// a `.myn` note is always UTF-8).
    NoteNotUtf8,
    /// The OS/Worker CSPRNG was unavailable while minting keys/salts.
    Csprng,
    /// A v0.2 AEAD/KDF operation failed (unreachable under fixed v0.2 params).
    Crypto,
}

fn fill_random(buf: &mut [u8]) -> Result<(), MigrationError> {
    getrandom::getrandom(buf).map_err(|_| MigrationError::Csprng)
}

/// Re-key + re-format the crypto core of a v0.1 vault into v0.2 (§10.4.1).
///
/// Preconditions the caller owns: the v0.1 unlock has already run (so `old_items_key`
/// / `old_items_key_id` are in hand), the recovery phrase has been entered and
/// normalized (§7.4), and `kdf_params` are the vault's existing parameters
/// (re-parameterisation at migration is out of scope, mirroring §4.2). `notes` is
/// every `(uuid, MY01-blob)` in the vault. `actor` seeds each note's Automerge
/// document (device provenance, ASM-3); `host` supplies the change timestamp.
///
/// Mints a fresh random v0.2 `root_key`, `itemsKey`, and `items_key_id`; builds
/// the `NTV5` `vault.meta` wrapping `root_key` under BOTH credentials; and
/// re-encrypts every note `MY01`→`NC05` under the new `itemsKey`. Pure — returns
/// the bytes; writes nothing.
#[allow(clippy::too_many_arguments)]
pub fn migrate_keys_and_notes(
    old_items_key: &[u8; 32],
    old_items_key_id: &[u8; 16],
    password: &str,
    phrase_normalized: &str,
    account_number_hash: &[u8; 16],
    kdf_params: &KdfParams,
    notes: &[([u8; 16], Vec<u8>)],
    actor: &[u8],
    // The wall clock for the `NC05` change timestamps, pre-read by the caller.
    // Host-free on purpose (myne-md/myne#434): this whole function is the
    // migration's CPU core — four production-parameter Argon2id derivations plus
    // the note-encryption loop — and it now runs inside `crate::task::run_blocking`,
    // whose closure is `'static` and cannot borrow `&dyn HostCtx`. Same shape as
    // `crdt::encode_note_at_millis`, which exists for exactly this reason.
    now_millis: u64,
) -> Result<MigrationOutput, MigrationError> {
    // --- mint the fresh v0.2 key material ---
    let mut new_root_key = Zeroizing::new([0u8; 32]);
    fill_random(new_root_key.as_mut_slice())?;
    let mut new_items_key = Zeroizing::new([0u8; 32]);
    fill_random(new_items_key.as_mut_slice())?;
    let mut new_items_key_id = [0u8; 16];
    fill_random(&mut new_items_key_id)?;

    let mut salt_password = [0u8; 16];
    let mut salt_recovery = [0u8; 16];
    let mut nonce_password = [0u8; 24];
    let mut nonce_recovery = [0u8; 24];
    let mut items_key_nonce = [0u8; 24];
    fill_random(&mut salt_password)?;
    fill_random(&mut salt_recovery)?;
    fill_random(&mut nonce_password)?;
    fill_random(&mut nonce_recovery)?;
    fill_random(&mut items_key_nonce)?;

    // --- build the NTV5 vault.meta (root_key wrapped under BOTH credentials) ---
    let ntv5_meta = encode_vault_meta_v0_2_raw(
        &new_root_key,
        &new_items_key,
        &new_items_key_id,
        password,
        phrase_normalized,
        account_number_hash,
        kdf_params,
        &salt_password,
        &salt_recovery,
        &nonce_password,
        &nonce_recovery,
        &items_key_nonce,
    )
    .map_err(|_| MigrationError::Crypto)?;

    // --- re-encrypt every note MY01 → NC05 under the new itemsKey ---
    let mut migrated = Vec::with_capacity(notes.len());
    for (uuid, my01_blob) in notes {
        let decrypted = decode_note(my01_blob, uuid, old_items_key, old_items_key_id)
            .map_err(|_| MigrationError::CannotDecryptNote)?;
        let markdown =
            core::str::from_utf8(decrypted.plaintext()).map_err(|_| MigrationError::NoteNotUtf8)?;
        let nc05_blob = crate::plugins::notes::crdt::encode_note_blob_at_millis(
            markdown,
            &new_items_key,
            &new_items_key_id,
            uuid,
            actor,
            now_millis,
        )
        .map_err(|_| MigrationError::Crypto)?;
        migrated.push(MigratedNote {
            note_uuid: *uuid,
            nc05_blob,
        });
    }

    Ok(MigrationOutput {
        ntv5_meta: ntv5_meta.to_vec(),
        new_root_key,
        new_items_key,
        new_items_key_id,
        notes: migrated,
    })
}

/// Failure of the whole-vault migration command (`vault_migrate_from_host`).
/// Serde-serialized to the IPC surface (`#[serde(tag = "kind")]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind")]
pub enum VaultMigrateError {
    /// A filesystem read/write failed.
    Io,
    /// `vault.meta` is unreadable / not a `MYV1` v0.1 vault.
    InvalidVaultMeta,
    /// Wrong password (non-distinguishing, §7.3).
    InvalidCredentialOrVault,
    /// The recovery phrase was missing or did not verify against this vault.
    /// Migration REQUIRES a valid phrase (§10.4.1): the new `root_key` is wrapped
    /// under both credentials, and a wrong phrase would strand recovery.
    RecoveryPhraseRequired,
    /// The vault is already migrated (its `vault.meta` is `NTV5`).
    AlreadyMigrated,
    /// The CSPRNG was unavailable.
    Csprng,
    /// A v0.2 seal/derive failed (unreachable under fixed params).
    Crypto,
    /// Another auth-pipeline operation (change-password, backup, quick-unlock
    /// enrolment, another migration) is already in flight (myne-md/myne#434).
    ///
    /// Reject, never queue — `decisions.md` 2026-05-02 generalizes the
    /// single-in-flight posture across the auth pipeline, and a whole-vault
    /// re-key is the most exclusive operation in the app.
    AuthOperationInProgress,
}

/// Run the whole-vault v0.1 → v0.2 migration for the active vault (§10.4.1, #420).
/// Verifies the password AND the recovery phrase against the existing `MYV1`
/// vault, then re-keys + re-encrypts the notes and KEK singletons and commits
/// `NTV5` last (via [`migrate_vault_notes_on_disk`]).
///
/// The **phrase-required rule is a backend gate here**: this refuses with
/// `RecoveryPhraseRequired` unless the phrase actually opens the old vault's
/// `enc_root_key_recovery`, so a UI bug cannot strand recovery.
pub async fn vault_migrate_from_host(
    host: &dyn HostCtx,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    password: &str,
    phrase: &str,
    io: &dyn VaultIo,
) -> Result<OnDiskMigrationSummary, VaultMigrateError> {
    use protocol::{
        aad_password_wrap, aad_recovery_wrap, aead_open_ctx, derive_items_key,
        derive_password_wrap_key, derive_recovery_wrap_key_from_normalized, normalize_user_phrase,
        parse_vault_meta, VAULT_META_MAGIC, VAULT_META_V0_2_MAGIC,
    };

    // The single-in-flight permit, before anything is read (myne-md/myne#434).
    // Every peer in the auth pipeline takes it — `vault_change_password`, backup
    // export, quick-unlock enrolment — and the migration, which re-keys the whole
    // vault, took nothing at all. Bound to `_permit` so it is held for the whole
    // call.
    let _permit = state
        .auth_permits()
        .try_acquire()
        .map_err(|_| VaultMigrateError::AuthOperationInProgress)?;

    let vault_root =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
            .map_err(|_| VaultMigrateError::Io)?;
    let notes_dir = vault_root.join("notes");
    let bytes = io
        .read(&vault_root.join("vault.meta"))
        .await
        .map_err(|_| VaultMigrateError::Io)?;

    // Already migrated? (Refuse rather than double-migrate.)
    if bytes.get(0..4) == Some(VAULT_META_V0_2_MAGIC.as_slice()) {
        return Err(VaultMigrateError::AlreadyMigrated);
    }
    if bytes.get(0..4) != Some(VAULT_META_MAGIC.as_slice()) {
        return Err(VaultMigrateError::InvalidVaultMeta);
    }
    let meta = parse_vault_meta(&bytes).map_err(|_| VaultMigrateError::InvalidVaultMeta)?;

    // Derive the old root_key from the PASSWORD (verifies the password).
    let pw_wrap = derive_password_wrap_key(
        password,
        &meta.random_salt_password,
        &meta.account_number_hash,
        &meta.kdf_params,
    )
    .map_err(|_| VaultMigrateError::Crypto)?;
    let root_pt = aead_open_ctx(
        &pw_wrap,
        &meta.nonce_password_wrap,
        &meta.enc_root_key_password,
        &aad_password_wrap(&meta.kdf_params),
    )
    .map_err(|_| VaultMigrateError::InvalidCredentialOrVault)?;
    if root_pt.len() != 32 {
        return Err(VaultMigrateError::InvalidVaultMeta);
    }
    let mut old_root_key = Zeroizing::new([0u8; 32]);
    old_root_key.copy_from_slice(&root_pt);
    let old_items_key =
        derive_items_key(&old_root_key, &meta).map_err(|_| VaultMigrateError::InvalidVaultMeta)?;

    // REQUIRE + VERIFY the recovery phrase: it must open the OLD vault's
    // `enc_root_key_recovery` to the SAME root_key. Otherwise the NTV5 recovery
    // wrap would be under a phrase the user does not actually hold → recovery
    // stranded. This is the backend gate the UI cannot bypass (§10.4.1).
    let normalized = normalize_user_phrase(phrase);
    let phrase_ok = derive_recovery_wrap_key_from_normalized(
        &normalized,
        &meta.random_salt_recovery,
        &meta.account_number_hash,
        &meta.kdf_params,
    )
    .ok()
    .and_then(|rec_wrap| {
        aead_open_ctx(
            &rec_wrap,
            &meta.nonce_recovery_wrap,
            &meta.enc_root_key_recovery,
            &aad_recovery_wrap(&meta.kdf_params),
        )
        .ok()
    })
    .map(|via_phrase| via_phrase.as_slice() == old_root_key.as_slice())
    .unwrap_or(false);
    if !phrase_ok {
        return Err(VaultMigrateError::RecoveryPhraseRequired);
    }

    // The migrated notes' Automerge actor is THIS device's stable id (device
    // provenance, `collab-provenance` task 1), not one fresh actor shared by every
    // note: a revision must be resolvable to the device that made the migration.
    // A vault with no device identity yet falls back to a fresh draw
    // (`note_actor_bytes(None)`), which resolves to `Unknown` downstream.
    let device_actor = crate::plugins::sync::state::read_device_actor(io, &vault_root).await;
    let actor = crate::plugins::sync::crdt_doc::note_actor_bytes(device_actor)
        .map_err(|_| VaultMigrateError::Csprng)?;

    // Writer quiescence, held across the whole on-disk pass (myne-md/myne#434).
    // In-flight note writers drain first and new ones queue until this drops.
    //
    // Without it the migration read every note at one point and wrote its `NC05`
    // replacement at a later one, with nothing held in between — so an autosave
    // landing in that window was either overwritten by an `NC05` built from the
    // STALE pre-edit markdown (the edit gone, and `legacy/` holding the pre-edit
    // copy too), or wrote an `MY01` blob AFTER the `NC05` one, leaving that note
    // permanently `CannotDecrypt` under the discarded old `itemsKey`. Both
    // reported `notes_migrated: N`.
    let _quiesce = state.quiesce_writers().await;

    let summary = migrate_vault_notes_on_disk(
        io,
        &vault_root,
        &notes_dir,
        &old_root_key,
        &old_items_key,
        &meta.items_key_id,
        password,
        &normalized,
        &meta.account_number_hash,
        &meta.kdf_params,
        &actor,
        host,
    )
    .await;
    // Clear the progress cell on EVERY outcome, including the failures. A
    // migration that aborts must not leave a reading that says a run is still in
    // flight — the UI would show a stuck bar with no way to learn otherwise.
    progress::finish();
    let summary = summary.map_err(|e| match e {
        OnDiskMigrationError::Io => VaultMigrateError::Io,
        OnDiskMigrationError::Crypto(MigrationError::Csprng) => VaultMigrateError::Csprng,
        OnDiskMigrationError::Crypto(_) => VaultMigrateError::Crypto,
    })?;

    // Release the writer quiescence BEFORE the lock below. Both take the slots
    // write lock, so holding this across `lock_from_host` self-deadlocks — the
    // migration would complete on disk and then hang forever with the vault
    // still unlocked on stale keys.
    drop(_quiesce);

    // Migration is a RE-KEY event: `NTV5` mints a fresh `root_key` and a fresh
    // `items_key`, so any still-Unlocked slot is now holding STALE v0.1 keys that
    // decrypt none of the just-written `NC05` notes. Drop the slot so the running
    // session cannot operate on the migrated vault with dead keys — the frontend
    // then routes to Unlock and the user re-unlocks the `NTV5` vault fresh (the
    // established re-key → re-unlock shape; unlike change-password, which leaves the
    // keys valid and stays unlocked). Best-effort: the migration already committed
    // `NTV5` to disk, so a lock failure here must not turn a successful migration
    // into an error — the next reprobe/lock reconciles. The stale search index it
    // persists under the old key is a rebuildable cache and is rebuilt on unlock.
    if crate::plugins::vault_unlock::commands::lock_from_host(state, hooks)
        .await
        .is_err()
    {
        // Static label only (secret-handling discipline: no `?e` Debug format even
        // on the closed `VaultUnlockError`). Best-effort — `NTV5` is already
        // committed, so the next reprobe/lock reconciles the dead-keyed session.
        tracing::warn!(
            target: "vault_migrate",
            event = "post_migration_lock_failed",
            "post-migration session lock failed; the next reprobe/lock reconciles"
        );
    }

    Ok(summary)
}

/// IPC command: migrate the active vault v0.1 → v0.2 (§10.4.1, #420). Thin wrapper
/// over [`vault_migrate_from_host`]; the phrase-required gate lives in the core.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_migrate<R: tauri::Runtime>(
    state: tauri::State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
    hooks: tauri::State<'_, crate::hooks::Hooks>,
    app: tauri::AppHandle<R>,
    password: String,
    phrase: String,
) -> Result<OnDiskMigrationSummary, VaultMigrateError> {
    // First-line plaintext-IPC discipline (myne-md/myne#434): bind both secrets to
    // `Zeroizing` so they wipe on every return path rather than lingering as
    // plain `String`s across the migration's `.await`s — which, for a whole-vault
    // re-key, is the longest-lived secret window in the app. The master password
    // AND the recovery phrase are both in scope here, and the phrase is the one
    // credential the user can never rotate.
    let password = Zeroizing::new(password);
    let phrase = Zeroizing::new(phrase);
    vault_migrate_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        &password,
        &phrase,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Failure of [`vault_migrate_abort_from_host`] / [`vault_migrate_confirm_from_host`]
/// (§10.4.1 point 5, myne-md/myne#430).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind")]
pub enum MigrationSettleError {
    /// A filesystem read/write failed.
    Io,
    /// There is no `legacy/` snapshot — the vault was never migrated, or the
    /// migration was already confirmed (and therefore crypto-erased).
    NothingToSettle,
    /// The migrated vault has already published its v0.2 generation to the sync
    /// server, so restoring the v0.1 vault locally would fork this device away
    /// from every peer. §10.4.1 point 5 scopes abort to **pre-sync** for exactly
    /// this reason; past that point the way back is a restore from backup.
    AlreadySynced,
    /// Another auth-pipeline operation is in flight.
    AuthOperationInProgress,
}

/// Everything the migration stages under `legacy/`, by name.
///
/// One list, walked by BOTH the abort (restore each) and the confirm
/// (erase the lot). Two copies of this roster is how an abort quietly stops
/// restoring a family the migration started staging.
const LEGACY_RESTORE_FILES: &[&str] = &[
    "vault.meta",
    "vault.themes",
    "vault.dictionary",
    "vault.prefs",
    "vault.attachments",
    "vault.chats",
    "vault.agent-memory",
    "vault.personality",
];

/// Singletons sealed under a `root_key` that is being replaced, by name.
///
/// Every one is either rebuildable from the notes (search, indices, graph), a
/// retired cache an older build may have written (the AI embedding index,
/// `vault.embeddings`), device-local editor state (workspace), a credential
/// wrapping a
/// now-stale `root_key` copy (`vault.quickunlock` + its attempt counter), or the
/// sync baseline whose integrity is the old head's own MAC (`vault.head-state`).
/// Left in place they are undecryptable bytes their readers already fall back
/// over; removed, they rebuild under the new root.
///
/// **Two callers, and they are not the same event**: the migration replacing its
/// own root (§10.4.1), and a peer promoting the generation a migration produced
/// on another device (myne-md/myne#447). The roster is shared because "which
/// artefacts does a root replacement invalidate" has exactly one answer.
///
/// **The abort path deliberately does NOT use this list** — see
/// `restore_legacy_vault`, which drops what the *v0.2 session* built while
/// rolling back to v0.1. The overlap is coincidental; the questions are
/// opposite, and answering both from one roster is how a roll-back starts
/// deleting something it was supposed to restore.
const STALE_UNDER_REPLACED_ROOT: &[&str] = &[
    "vault.search",
    "vault.workspace",
    "vault.indices",
    "vault.graph",
    // A retired family, kept because an older v0.2 session really did build this
    // file: it answers "what did the OLD root seal", and a migration meeting one
    // still has to drop it.
    "vault.embeddings",
    "vault.quickunlock",
    "vault.quickunlock.attempts",
    "vault.head-state",
];

/// Remove every artefact [`STALE_UNDER_REPLACED_ROOT`] names, plus `also`, plus
/// the per-attachment extracted-text cache subtree.
///
/// Best-effort throughout: a delete failure must never abort a committed re-key
/// or a promotion the user's credential already proved. What is left behind is
/// undecryptable bytes, which every reader on this path already tolerates.
pub(crate) async fn drop_artefacts_sealed_under_replaced_root(
    io: &dyn VaultIo,
    vault_root: &Path,
    also: &[&str],
) {
    for stale in STALE_UNDER_REPLACED_ROOT.iter().chain(also) {
        let _ = io.remove_file(&vault_root.join(stale)).await;
    }
    // `attachments-text/` (`MYE1`, §9.15) is a rebuildable search-extraction
    // cache under the old key — the whole subtree goes, so it re-extracts on
    // demand rather than lingering undecryptable.
    let _ = io
        .remove_dir_all(&vault_root.join("attachments-text"))
        .await;
}

/// Restore the byte-identical v0.1 vault from `legacy/` (§10.4.1 point 5).
///
/// **Valid pre-sync and pre-confirm only.** After the re-based head has landed
/// on the server this device's peers have adopted the v0.2 generation, and a
/// local roll-back would fork it away from them; the pre-sync condition is read
/// off `SyncState::rekey_rebase_pending`, which the migration arms and the push
/// that publishes the new head clears (myne-md/myne#429). An unenrolled vault is
/// pre-sync by construction.
pub async fn vault_migrate_abort_from_host(
    host: &dyn HostCtx,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    io: &dyn VaultIo,
) -> Result<(), MigrationSettleError> {
    let _permit = state
        .auth_permits()
        .try_acquire()
        .map_err(|_| MigrationSettleError::AuthOperationInProgress)?;
    let vault_root =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
            .map_err(|_| MigrationSettleError::Io)?;
    let legacy = vault_root.join("legacy");
    if io.read(&legacy.join("vault.meta")).await.is_err() {
        return Err(MigrationSettleError::NothingToSettle);
    }
    if sync_has_published_the_new_generation(io, &vault_root).await {
        return Err(MigrationSettleError::AlreadySynced);
    }

    let _quiesce = state.quiesce_writers().await;

    // Notes first, meta LAST — the mirror of the migration's own commit order.
    // `vault.meta` is what decides which key hierarchy the vault opens under, so
    // it is the one file whose write flips the whole vault back; anything that
    // fails before it leaves a vault that still reads as v0.2, which is the
    // state we came from rather than a new one.
    restore_tree(io, &legacy.join("notes"), &vault_root.join("notes")).await?;
    restore_tree(io, &legacy.join("snapshots"), &vault_root.join("snapshots")).await?;
    restore_tree(
        io,
        &legacy.join("attachments"),
        &vault_root.join("attachments"),
    )
    .await?;
    // The per-file families the migration re-seals entry by entry (5b chats,
    // 5b2 memories, myne-md/myne#675 + myne-md/myne#697): without these two
    // lines an abort restores the catalogs but leaves the live entry files
    // as undecryptable v0.2 bytes, then deletes the only surviving v0.1
    // copies with `legacy/`. Absent source dir = no-op by construction.
    restore_tree(io, &legacy.join("chats"), &vault_root.join("chats")).await?;
    restore_tree(io, &legacy.join("memories"), &vault_root.join("memories")).await?;
    for name in LEGACY_RESTORE_FILES.iter().filter(|n| **n != "vault.meta") {
        if let Ok(bytes) = io.read(&legacy.join(name)).await {
            io.write(&vault_root.join(name), &bytes, WriteOpts::default())
                .await
                .map_err(|_| MigrationSettleError::Io)?;
        }
    }
    let old_meta = io
        .read(&legacy.join("vault.meta"))
        .await
        .map_err(|_| MigrationSettleError::Io)?;
    io.write(
        &vault_root.join("vault.meta"),
        &old_meta,
        WriteOpts::default(),
    )
    .await
    .map_err(|_| MigrationSettleError::Io)?;

    // The v0.2 caches and the armed re-base flag both describe a vault that no
    // longer exists.
    //
    // **Deliberately its own list, not `STALE_UNDER_REPLACED_ROOT`.** That
    // roster answers "what did the OLD root seal"; this one answers "what did
    // the v0.2 session BUILD", and a roll-back needs the second. The lists
    // overlap only because those caches happen to exist in both states — reusing
    // the roster here would start deleting `vault.prefs`-class artefacts this
    // path has just restored from `legacy/`.
    for stale in [
        "vault.search",
        "vault.indices",
        "vault.graph",
        // A retired family, kept: a v0.2 session on an older build really did
        // build `vault.embeddings`, and a roll-back has to drop it.
        "vault.embeddings",
        "vault.head-state",
    ] {
        let _ = io.remove_file(&vault_root.join(stale)).await;
    }
    if let Ok(mut sync_state) = crate::plugins::sync::state::read_sync_state(io, &vault_root).await
    {
        sync_state.rekey_rebase_pending = false;
        let _ = crate::plugins::sync::state::write_sync_state(io, &vault_root, &sync_state).await;
    }
    let _ = io.remove_dir_all(&legacy).await;

    drop(_quiesce);
    // A re-key in either direction is a re-unlock event: the running slot holds
    // the v0.2 keys, which now open nothing.
    let _ = crate::plugins::vault_unlock::commands::lock_from_host(state, hooks).await;
    Ok(())
}

/// Crypto-erase the pre-migration vault: the old `root_key` (which exists only
/// inside `legacy/vault.meta`, wrapped under the old password and the old
/// recovery phrase) and every blob staged beside it. After this the migration is
/// **settled** (§10.4.1 point 5) and there is no way back.
///
/// This is the step whose absence made rotating the master password stop meaning
/// what it means: `vault_change_password` rewrites `<vault>/vault.meta` only, so
/// while `legacy/vault.meta` survived, anyone holding the OLD password and a copy
/// of the vault directory could still unwrap the old `itemsKey` and read every
/// staged note. The recovery phrase is unrevocable by design, so the same held
/// for it permanently.
pub async fn vault_migrate_confirm_from_host(
    host: &dyn HostCtx,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    io: &dyn VaultIo,
) -> Result<(), MigrationSettleError> {
    let _permit = state
        .auth_permits()
        .try_acquire()
        .map_err(|_| MigrationSettleError::AuthOperationInProgress)?;
    let vault_root =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
            .map_err(|_| MigrationSettleError::Io)?;
    let legacy = vault_root.join("legacy");
    if io.read(&legacy.join("vault.meta")).await.is_err() {
        return Err(MigrationSettleError::NothingToSettle);
    }
    io.remove_dir_all(&legacy)
        .await
        .map_err(|_| MigrationSettleError::Io)?;
    Ok(())
}

/// Whether this device has already published its v0.2 generation to the server.
///
/// `rekey_rebase_pending` is armed by the migration and cleared by the push that
/// lands the re-authored head (myne-md/myne#429), so "enrolled AND not pending"
/// is exactly "peers have seen v0.2". An unenrolled or unreadable state answers
/// `false` — abort is the recoverable direction, and refusing it on a doubt
/// would strand the user with no way back at all.
async fn sync_has_published_the_new_generation(io: &dyn VaultIo, vault_root: &Path) -> bool {
    let Ok(state) = crate::plugins::sync::state::read_sync_state(io, vault_root).await else {
        return false;
    };
    state.device_id_hex.is_some() && !state.rekey_rebase_pending
}

/// Copy every file of `from` over `to`, creating `to` if needed. A missing
/// source is not an error (the migration stages only what the vault had).
async fn restore_tree(
    io: &dyn VaultIo,
    from: &Path,
    to: &Path,
) -> Result<(), MigrationSettleError> {
    let Ok(entries) = io.read_dir(from).await else {
        return Ok(());
    };
    io.create_dir_all(to)
        .await
        .map_err(|_| MigrationSettleError::Io)?;
    for entry in &entries {
        if entry.is_dir {
            continue;
        }
        let Ok(bytes) = io.read(&from.join(&entry.name)).await else {
            continue;
        };
        io.write(&to.join(&entry.name), &bytes, WriteOpts::default())
            .await
            .map_err(|_| MigrationSettleError::Io)?;
    }
    Ok(())
}

/// Whether this vault holds an **unsettled** migration — a `legacy/` snapshot
/// the user has neither aborted nor confirmed (§10.4.1 point 5).
///
/// Read-only, and separate from the two acting commands on purpose: probing by
/// calling `confirm` and reading its `NothingToSettle` would erase the very
/// thing being probed for.
///
/// `can_abort` is the pre-sync condition — once the re-based head has landed on
/// the server, restoring locally would fork this device from its peers, so the
/// surface offers only confirm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct MigrationSettleStatus {
    /// A `legacy/` snapshot is present and the migration is not settled.
    pub pending: bool,
    /// Abort is still available (pre-sync).
    pub can_abort: bool,
    /// **This vault is still v0.1, so the upgrade is offerable.** False for a
    /// vault that is already v0.2 — whether it was migrated or born that way
    /// (`decisions.md` 2026-08-13).
    ///
    /// The settle surface and the migrate form are two different questions and
    /// this command answers both, rather than adding a second round-trip: after
    /// a migration `offerable` is false while `pending` is true (the vault is
    /// current, but its `legacy/` snapshot still has to be settled), and on a
    /// freshly-created vault both are false and the whole block disappears.
    pub offerable: bool,
}

/// Core of [`vault_migrate_settle_status`].
pub async fn vault_migrate_settle_status_from_host(
    host: &dyn HostCtx,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    io: &dyn VaultIo,
) -> Result<MigrationSettleStatus, MigrationSettleError> {
    let vault_root =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
            .map_err(|_| MigrationSettleError::Io)?;
    let pending = io
        .read(&vault_root.join("legacy").join("vault.meta"))
        .await
        .is_ok();
    let can_abort = pending && !sync_has_published_the_new_generation(io, &vault_root).await;
    // Read the generation off the LIVE meta, not off the presence of `legacy/`:
    // the two answer different questions, and a vault born v0.2 has neither.
    let offerable = match io.read(&vault_root.join("vault.meta")).await {
        Ok(bytes) => protocol::meta_version_of(&bytes) == Some(MetaVersion::V0_1),
        // An unreadable meta is not a migration offer. The unlock path owns that
        // failure and states it far better than a settings row could.
        Err(_) => false,
    };
    Ok(MigrationSettleStatus {
        pending,
        can_abort,
        offerable,
    })
}

/// IPC command: is there an unsettled migration on this vault? (§10.4.1 point 5)
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_migrate_settle_status<R: tauri::Runtime>(
    state: tauri::State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
    app: tauri::AppHandle<R>,
) -> Result<MigrationSettleStatus, MigrationSettleError> {
    vault_migrate_settle_status_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// IPC command: abort a not-yet-settled migration (§10.4.1 point 5, #430).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_migrate_abort<R: tauri::Runtime>(
    state: tauri::State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
    hooks: tauri::State<'_, crate::hooks::Hooks>,
    app: tauri::AppHandle<R>,
) -> Result<(), MigrationSettleError> {
    vault_migrate_abort_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// IPC command: settle a migration by crypto-erasing `legacy/` (§10.4.1 point 5).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_migrate_confirm<R: tauri::Runtime>(
    state: tauri::State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
    app: tauri::AppHandle<R>,
) -> Result<(), MigrationSettleError> {
    vault_migrate_confirm_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// What the on-disk migration did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct OnDiskMigrationSummary {
    /// Notes re-encrypted `MY01`→`NC05` and written.
    pub notes_migrated: usize,
    /// KEK-envelope singletons (themes/dictionary) re-sealed to their `MY?5`
    /// family and written (only the ones present on disk).
    pub singletons_migrated: usize,
}

/// On-disk migration failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnDiskMigrationError {
    /// A filesystem read/write failed.
    Io,
    /// The crypto core failed (undecryptable note / entropy / v0.2 seal).
    Crypto(MigrationError),
}

/// Decode a 32-hex conversation filename to its 16 bytes.
///
/// **Lenient** (`protocol::hex::decode_ci`), unlike the chats helper that decodes
/// the same shape strictly, and the difference is the INPUT rather than the id: a
/// filename is attacker-renameable on-disk state (A5), so the migration has to
/// answer for whatever spelling is there rather than refuse a vault because a
/// name came back uppercase. The ASCII gate `decode_ci` carries is load-bearing
/// for the same reason the old one was: `s.len()` counts BYTES and the decoder
/// indexes bytes, so a 32-byte name containing a multibyte character would put a
/// slice boundary mid-character and panic, stranding a half-rewritten vault.
/// `is_ascii_hex_ci` rejects every byte above `0x7f` before a slice is taken.
/// Aşama 3, R1.2.
fn hex_decode_16_conversation(s: &str) -> Option<[u8; 16]> {
    protocol::hex::decode_ci(s)
}

#[allow(clippy::too_many_arguments)]
pub async fn migrate_vault_notes_on_disk(
    io: &dyn VaultIo,
    vault_root: &Path,
    notes_dir: &Path,
    old_root_key: &[u8; 32],
    old_items_key: &[u8; 32],
    old_items_key_id: &[u8; 16],
    password: &str,
    phrase_normalized: &str,
    account_number_hash: &[u8; 16],
    kdf_params: &KdfParams,
    actor: &[u8],
    host: &dyn HostCtx,
) -> Result<OnDiskMigrationSummary, OnDiskMigrationError> {
    use OnDiskMigrationError::Io;

    // (1) Scan + read every MY01 note blob.
    let entries = io.read_dir(notes_dir).await.map_err(|_| Io)?;
    let ids = crate::plugins::notes::commands::note_ids_from_entries(&entries);
    let mut notes: Vec<([u8; 16], Vec<u8>)> = Vec::with_capacity(ids.len());
    for id in &ids {
        let uuid = *id.as_uuid().as_bytes();
        let path = notes_dir.join(format!("{}.myn", id.as_uuid()));
        let blob = io.read(&path).await.map_err(|_| Io)?;
        notes.push((uuid, blob));
    }

    // §10.4.1 md.2's per-blob progress (myne-md/myne#441). The denominator is
    // notes plus the singleton families actually present, counted before any work
    // starts so the bar never moves backwards.
    let singleton_count = {
        let mut n = 0u32;
        for name in [
            "vault.themes",
            "vault.dictionary",
            "vault.prefs",
            "vault.attachments",
        ] {
            if io.read(&vault_root.join(name)).await.is_ok() {
                n += 1;
            }
        }
        n
    };
    progress::begin(notes.len() as u32 + singleton_count);

    // (2) Run the pure crypto core (mint v0.2 keys, NTV5, MY01→NC05) OFF the
    //     async executor (myne-md/myne#434).
    //
    //     This is four production-parameter Argon2id derivations
    //     (m=256 MiB, t=3) plus one AEAD seal per note. On the executor it parks
    //     a runtime worker for the whole run — seconds on a small vault, minutes
    //     on a large one — which is the exact shape `crate::task::run_blocking`
    //     exists to prevent, and which every other Argon2id-bound command in the
    //     app already avoids (`vault_change_password`, backup, quick-unlock).
    let now_millis = host.now_unix_millis();
    let (old_ik, old_ikid, acct, kdf) = (
        *old_items_key,
        *old_items_key_id,
        *account_number_hash,
        *kdf_params,
    );
    let (pw, phrase, actor_owned) = (
        Zeroizing::new(password.to_string()),
        Zeroizing::new(phrase_normalized.to_string()),
        actor.to_vec(),
    );
    // The closure takes ownership and hands `notes` back: the `legacy/` staging
    // below writes the ORIGINAL blobs, so they must outlive the crypto pass.
    let (out, notes) = crate::task::run_blocking(move || {
        let out = migrate_keys_and_notes(
            &old_ik,
            &old_ikid,
            &pw,
            &phrase,
            &acct,
            &kdf,
            &notes,
            &actor_owned,
            now_millis,
        );
        (out, notes)
    })
    .await
    .map_err(|_| OnDiskMigrationError::Crypto(MigrationError::Crypto))?;
    let out = out.map_err(OnDiskMigrationError::Crypto)?;

    // (3) Stage the legacy/ snapshot (old vault.meta + old note blobs) BEFORE any
    //     overwrite — the abort-before-sync escape hatch (§10.4.1).
    let legacy = vault_root.join("legacy");
    let legacy_notes = legacy.join("notes");
    io.create_dir_all(&legacy_notes).await.map_err(|_| Io)?;
    let meta_path = vault_root.join("vault.meta");
    if let Ok(old_meta) = io.read(&meta_path).await {
        io.write(&legacy.join("vault.meta"), &old_meta, WriteOpts::default())
            .await
            .map_err(|_| Io)?;
    }
    for (uuid, blob) in &notes {
        let name = format!("{}.myn", uuid::Uuid::from_bytes(*uuid));
        io.write(&legacy_notes.join(&name), blob, WriteOpts::default())
            .await
            .map_err(|_| Io)?;
    }

    // (3b) FAIL-CLOSED PRE-FLIGHT (§10.4.1 md.3's MAY; myne-md/myne#441).
    //
    //      Every KEK-envelope singleton is re-sealed for real, and the result
    //      thrown away, BEFORE a single note is overwritten below. The point is
    //      the failure ordering, not the bytes: the re-seal at step (5) aborts on
    //      `?`, and it used to sit AFTER the in-place note pass — so an
    //      undecodable `vault.themes` or `vault.dictionary` produced exactly the
    //      torn vault §10.4.1 md.3 describes as the CRASH case, with no crash,
    //      and with no way back (the `legacy/` restore is myne-md/myne#430).
    //
    //      Doing the work twice is the deliberate trade. These families are
    //      capped at 4 MiB and hold single-digit themes or a word list, so the
    //      second AEAD pass is noise next to the Argon2id derivations this
    //      migration already paid — and it buys "the vault is still entirely
    //      v0.1 when this fails", which is the only recovery story that needs no
    //      new machinery.
    for fam in KEK_SINGLETONS {
        let Ok(old_blob) = io.read(&vault_root.join(fam.filename)).await else {
            continue; // family not present in this vault
        };
        reseal_kek_singleton(
            fam,
            &old_blob,
            old_root_key,
            &out.new_root_key,
            account_number_hash,
        )
        .map_err(|_| OnDiskMigrationError::Crypto(MigrationError::Crypto))?;
    }

    // (3c) Move `snapshots/` into `legacy/` (myne-md/myne#435).
    //
    //      A snapshot is a byte-verbatim `MY01` note blob under the vault's
    //      `itemsKey` — there is no snapshot codec or magic of its own — so the
    //      re-key leaves every one of them permanently undecryptable. The
    //      migration used to not mention `snapshots/` at all (`grep -c snapshots`
    //      returned 0), which left that ciphertext sitting in the vault root
    //      under a key nothing holds, while the version-history UI went on
    //      listing every revision and failing to open each one.
    //
    //      MOVED, not copied: `protocol.md` §9.2 already says a migrated note's
    //      pre-migration snapshots are part of the `legacy/` snapshot and are
    //      crypto-erased on confirm, and orphan ciphertext is precisely what
    //      cryptographic erase exists to prevent. Forward from here the store is
    //      inert by design — an `NC05` note captures no snapshots, because its
    //      change-graph IS the history (`decisions.md` 2026-08-09, ASM-12→B).
    let snapshots = vault_root.join("snapshots");
    if let Ok(entries) = io.read_dir(&snapshots).await {
        let legacy_snapshots = legacy.join("snapshots");
        io.create_dir_all(&legacy_snapshots).await.map_err(|_| Io)?;
        for entry in &entries {
            if entry.is_dir {
                continue;
            }
            let Ok(bytes) = io.read(&snapshots.join(&entry.name)).await else {
                continue; // vanished under us — nothing to preserve
            };
            io.write(
                &legacy_snapshots.join(&entry.name),
                &bytes,
                WriteOpts::default(),
            )
            .await
            .map_err(|_| Io)?;
        }
        // Only after every one is safely in `legacy/`.
        let _ = io.remove_dir_all(&snapshots).await;
    }

    // (4) Write every NC05 note over its MY01 (same <uuid>.myn filename).
    for mn in &out.notes {
        let name = format!("{}.myn", uuid::Uuid::from_bytes(mn.note_uuid));
        io.write(&notes_dir.join(&name), &mn.nc05_blob, WriteOpts::default())
            .await
            .map_err(|_| Io)?;
        progress::advance();
    }

    // (5) Re-seal the KEK-envelope singletons (themes/dictionary) present on disk:
    //     old KEK = derive_subkey(old_root, role); new KEK = derive_subkey_v0_2(
    //     new_root, role). Each old blob is staged to legacy/ first, then replaced
    //     by its MY?5 re-seal (content re-keyed, opaque inner carried through).
    let mut singletons_migrated = 0usize;
    for fam in KEK_SINGLETONS {
        let path = vault_root.join(fam.filename);
        let Ok(old_blob) = io.read(&path).await else {
            continue; // family not present in this vault
        };
        io.write(&legacy.join(fam.filename), &old_blob, WriteOpts::default())
            .await
            .map_err(|_| Io)?;
        let resealed = reseal_kek_singleton(
            fam,
            &old_blob,
            old_root_key,
            &out.new_root_key,
            account_number_hash,
        )
        .map_err(|_| OnDiskMigrationError::Crypto(MigrationError::Crypto))?;
        io.write(&path, &resealed, WriteOpts::default())
            .await
            .map_err(|_| Io)?;
        singletons_migrated += 1;
        progress::advance();
    }

    // (5b) Re-seal `vault.prefs` (`MYP1`→`MYP5`). Prefs is hand-rolled (not a
    //      KEK-envelope family), so it re-seals on its own path: decode the
    //      `MYP1` blob under the OLD prefs KEK into a `PrefsView`, then re-encode
    //      it under the NEW v0.2 prefs KEK as `MYP5`. The user's settings survive
    //      the re-key (the prefs reader derives its KEK version-aware, so it reads
    //      the `MYP5` result). Staged to legacy/ first; an undecodable old blob is
    //      left to the reader's fall-back-to-default rather than aborting the
    //      migration.
    let prefs_path = vault_root.join("vault.prefs");
    if let Ok(old_blob) = io.read(&prefs_path).await {
        io.write(&legacy.join("vault.prefs"), &old_blob, WriteOpts::default())
            .await
            .map_err(|_| Io)?;
        let old_kek = derive_subkey(old_root_key, SubkeyRole::PrefsKey);
        if let Ok(prefs) = decode_prefs_blob(&old_kek, account_number_hash, &old_blob) {
            let new_kek = derive_subkey_v0_2(&out.new_root_key, SubkeyRole::PrefsKey);
            let resealed = encode_prefs_blob_versioned(
                MetaVersion::V0_2,
                &new_kek,
                account_number_hash,
                &prefs,
            )
            .map_err(|_| OnDiskMigrationError::Crypto(MigrationError::Crypto))?;
            io.write(&prefs_path, &resealed, WriteOpts::default())
                .await
                .map_err(|_| Io)?;
            singletons_migrated += 1;
        }
    }

    // (5bb) Re-key the attachments to v0.2 — the catalog (`vault.attachments`
    //       `MYC1`→`MYC5`) and every per-attachment blob (`attachments/<id-hex>`
    //       `MYA1`→`MYA5`). Both move fully into the v0.2 generation: the catalog
    //       under `derive_subkey_v0_2(new_root, AttachmentsCatalogKey)` (its reader
    //       is now version-aware), each blob's content-addressed id CARRIED (stable,
    //       `decisions.md` 2026-08-09) so the catalog keys still resolve and the
    //       magic-detecting reader decodes them under the new `itemsKey`. Without
    //       this leg a migrated vault's attachments read as gone.
    //
    //       The raw catalog is staged to legacy/ FIRST, BEFORE the decode — so a
    //       catalog that will not even decrypt is still recoverable — and if it
    //       fails to decode, the whole `attachments/` subtree is staged too (the
    //       ids can't be enumerated without the catalog), preserving the
    //       "every original in legacy/" guarantee even for a corrupt catalog.
    let catalog_path = vault_root.join("vault.attachments");
    let att_dir = vault_root.join("attachments");
    let legacy_att = legacy.join("attachments");
    if let Ok(old_catalog_blob) = io.read(&catalog_path).await {
        io.write(
            &legacy.join("vault.attachments"),
            &old_catalog_blob,
            WriteOpts::default(),
        )
        .await
        .map_err(|_| Io)?;
        let old_catalog_key = derive_subkey(old_root_key, SubkeyRole::AttachmentsCatalogKey);
        match decode_attachments_catalog(&old_catalog_key, account_number_hash, &old_catalog_blob) {
            Ok(catalog) => {
                // Re-seal each live attachment blob under the new itemsKey.
                for (id_hex, meta) in &catalog.entries {
                    if meta.is_tombstone() {
                        continue; // no blob on disk for a deleted attachment
                    }
                    let Some(id) = crate::plugins::attachments::commands::hex_decode_id(id_hex)
                    else {
                        continue; // malformed catalog key — leave it, do not abort
                    };
                    let blob_path = att_dir.join(id_hex);
                    let Ok(old_blob) = io.read(&blob_path).await else {
                        continue; // catalog entry with no blob file (torn state)
                    };
                    // Stage the original to legacy/ FIRST, then attempt the re-seal.
                    io.create_dir_all(&legacy_att).await.map_err(|_| Io)?;
                    io.write(&legacy_att.join(id_hex), &old_blob, WriteOpts::default())
                        .await
                        .map_err(|_| Io)?;
                    // A single attachment that will not re-seal (its old blob does
                    // not decode under the old itemsKey — already corrupt, so it was
                    // unreadable BEFORE the migration too) is SKIPPED, not fatal:
                    // aborting would strand the whole half-rewritten vault for one
                    // dead attachment. The old bytes stay in place AND in legacy/.
                    let Ok(resealed) = reseal_attachment_v0_2(
                        &old_blob,
                        &id,
                        meta.content_type.as_bytes(),
                        old_items_key,
                        old_items_key_id,
                        &out.new_items_key,
                        &out.new_items_key_id,
                    ) else {
                        continue;
                    };
                    io.write(&blob_path, &resealed, WriteOpts::default())
                        .await
                        .map_err(|_| Io)?;
                }
                // Re-key the catalog itself to `MYC5` under the v0.2 KEK.
                let new_catalog_key =
                    derive_subkey_v0_2(&out.new_root_key, SubkeyRole::AttachmentsCatalogKey);
                let new_catalog_blob = encode_attachments_catalog_versioned(
                    MetaVersion::V0_2,
                    &new_catalog_key,
                    account_number_hash,
                    &catalog,
                )
                .map_err(|_| OnDiskMigrationError::Crypto(MigrationError::Crypto))?;
                io.write(&catalog_path, &new_catalog_blob, WriteOpts::default())
                    .await
                    .map_err(|_| Io)?;
                singletons_migrated += 1;
            }
            Err(_) => {
                // Corrupt/undecodable catalog: cannot enumerate ids to re-key. Stage
                // the whole `attachments/` subtree to legacy/ (best-effort) so the
                // blobs are recoverable, and leave them un-re-keyed rather than
                // stranding the vault. Post-migration they read as gone; recovery is
                // the legacy/ snapshot.
                if let Ok(entries) = io.read_dir(&att_dir).await {
                    for entry in entries {
                        if entry.is_dir {
                            continue;
                        }
                        if let Ok(bytes) = io.read(&att_dir.join(&entry.name)).await {
                            io.create_dir_all(&legacy_att).await.map_err(|_| Io)?;
                            let _ = io
                                .write(&legacy_att.join(&entry.name), &bytes, WriteOpts::default())
                                .await;
                        }
                    }
                }
            }
        }
    }

    // (5b) Re-seal the AI conversation files (`chats/<id-hex>`) present on
    //      disk: `MYJ1` → `MYJ5` under the v0.2 chats KEK (myne-md/myne#675).
    //      Same stage-first, skip-dead discipline as the attachment loop
    //      above: the catalog was re-sealed by the KEK_SINGLETONS pass just
    //      before (so its causal versions survive), and each conversation
    //      file re-seals independently. A file that will not re-seal (torn,
    //      or a name that is not a conversation id) is left in place AND
    //      staged to legacy/: aborting would strand the whole half-rewritten
    //      vault for one dead conversation; silence here would lose it. The
    //      sync-id of each conversation (its own id bytes) does not change
    //      across the cut, so no stranded-sync-id tombstone is owed (§5.6.1
    //      applies to root_key-derived sync-ids; conversation ids are
    //      client-minted, not derived).
    {
        let chats_dir = vault_root.join("chats");
        let legacy_chats = legacy.join("chats");
        let old_chats_key = derive_subkey(old_root_key, SubkeyRole::ChatsKey);
        let new_chats_key = derive_subkey_v0_2(&out.new_root_key, SubkeyRole::ChatsKey);
        if let Ok(entries) = io.read_dir(&chats_dir).await {
            for entry in entries {
                if entry.is_dir {
                    continue;
                }
                let Some(conv_id) = hex_decode_16_conversation(&entry.name) else {
                    continue; // stray file: leave it, do not abort
                };
                let blob_path = chats_dir.join(&entry.name);
                let Ok(old_blob) = io.read(&blob_path).await else {
                    continue;
                };
                io.create_dir_all(&legacy_chats).await.map_err(|_| Io)?;
                io.write(
                    &legacy_chats.join(&entry.name),
                    &old_blob,
                    WriteOpts::default(),
                )
                .await
                .map_err(|_| Io)?;
                let Ok(resealed) = reseal_chats_blob_v0_2(
                    &old_blob,
                    &old_chats_key,
                    &new_chats_key,
                    account_number_hash,
                    &conv_id,
                ) else {
                    continue;
                };
                io.write(&blob_path, &resealed, WriteOpts::default())
                    .await
                    .map_err(|_| Io)?;
            }
        }
    }

    // (5b2) Re-seal the agent-memory entry files (`memories/<id-hex>`)
    //       present on disk: `MYX1` → `MYX5` under the v0.2 memory KEK
    //       (myne-md/myne#697). The chats (5b) shape verbatim: stage-first,
    //       skip-dead, sync-ids unchanged (entry ids are client-minted, so no
    //       stranded-sync-id tombstone is owed).
    {
        let memories_dir = vault_root.join("memories");
        let legacy_memories = legacy.join("memories");
        let old_memory_key = derive_subkey(old_root_key, SubkeyRole::AgentMemoryKey);
        let new_memory_key = derive_subkey_v0_2(&out.new_root_key, SubkeyRole::AgentMemoryKey);
        if let Ok(entries) = io.read_dir(&memories_dir).await {
            for entry in entries {
                if entry.is_dir {
                    continue;
                }
                let Some(entry_id) = hex_decode_16_conversation(&entry.name) else {
                    continue; // stray file: leave it, do not abort
                };
                let blob_path = memories_dir.join(&entry.name);
                let Ok(old_blob) = io.read(&blob_path).await else {
                    continue;
                };
                io.create_dir_all(&legacy_memories).await.map_err(|_| Io)?;
                io.write(
                    &legacy_memories.join(&entry.name),
                    &old_blob,
                    WriteOpts::default(),
                )
                .await
                .map_err(|_| Io)?;
                let Ok(resealed) = reseal_agent_memory_blob_v0_2(
                    &old_blob,
                    &old_memory_key,
                    &new_memory_key,
                    account_number_hash,
                    &entry_id,
                ) else {
                    continue;
                };
                io.write(&blob_path, &resealed, WriteOpts::default())
                    .await
                    .map_err(|_| Io)?;
            }
        }
    }

    // (5c) Drop the rebuildable / device-local caches and the quick-unlock
    //      credential. Each is either reconstructable from the notes (search,
    //      indices, graph), device-local editor state (workspace), or
    //      a PIN/biometric credential wrapping a NOW-STALE `root_key` copy
    //      (`vault.quickunlock`). Leaving them would only be stale bytes the
    //      readers already fall back over; deleting them keeps the migrated vault
    //      byte-clean and forces a fresh rebuild / PIN re-enrolment under v0.2.
    //      Best-effort: a delete failure never aborts a committed re-key.
    //      The roster is `STALE_UNDER_REPLACED_ROOT`, shared with the peer-side
    //      promotion (#447) because "which artefacts does a root replacement
    //      invalidate" has one answer. Notably it includes the PIN/biometric
    //      credential and its attempt counter, so a re-key forces a fresh
    //      enrolment. The OS-keychain biometric item is destroyed by the
    //      `invalidate_credential` call below, on the same chokepoint the
    //      change-password path uses: the roster drop alone takes the `MYQ1`
    //      blob and leaves the wrap key that opens it (myne-md/myne#761, the
    //      class rule in `docs/decisions/security/0709`).
    drop_artefacts_sealed_under_replaced_root(io, vault_root, &[]).await;
    // Best-effort and idempotent: the files are already gone above, and this adds
    // the Keychain half (read `vault.meta`, derive the per-vault account,
    // delete). Called AFTER the roster drop, so a failure cannot leave a live
    // credential over a live blob.
    crate::plugins::quick_unlock::commands::invalidate_credential(vault_root);

    // (5d) Re-base the SYNC plane onto the new generation (#429).
    //
    // A re-key invalidates four root-derived sync artefacts at once, and the
    // migration used to touch none of them: the vault-head MAC, the device-local
    // head baseline (dropped just above), the SCRAM verifier, and the reserved
    // sync-ids of the three synced singletons. Left alone, the very next cycle
    // reads the server's stale-generation head as a FORGERY and tells the user
    // their server may be tampering with their data — forever, because the cycle
    // aborts before it could ever re-author the head.
    //
    // Best-effort: `NTV5` is about to commit and a sync-bookkeeping failure must
    // not turn a completed re-key into an error. A device that misses this
    // re-bases on its next unlock instead, from the same flag.
    rebase_sync_plane_after_rekey(io, vault_root, old_root_key, &out.new_root_key).await;

    // (6) Write the NTV5 vault.meta LAST — the atomic commit point.
    io.write(&meta_path, &out.ntv5_meta, WriteOpts::default())
        .await
        .map_err(|_| Io)?;

    Ok(OnDiskMigrationSummary {
        notes_migrated: out.notes.len(),
        singletons_migrated,
    })
}

/// Point this device's sync bookkeeping at the new key generation (#429).
///
/// Three things have to be true before the next cycle runs, and the migration is
/// the only place that knows all three:
///
/// 1. **The re-base flag is armed.** The server still holds a head MAC'd under
///    the old `root_key`; without the flag the pull reads it as a forged head,
///    raises the malicious-server alert and aborts before the push — so the head
///    is never re-authored and the state feeds itself.
/// 2. **`vault.meta` is marked dirty.** The `NTV5` meta must reach the server, or
///    a second device can never learn the vault was re-keyed (it fetches the meta
///    to derive the new root). The meta phase already knows how to push a dirty
///    meta; it just needs to be told there is one.
/// 3. **The old singletons' CAS baselines are dropped.** `prefs`/`catalog`/
///    `themes` ride reserved sync-ids derived from `root_key`, so all three
///    CHANGE with the re-key. Their old baselines describe blobs this device can
///    no longer read and will never push again.
///
/// **Known, deliberate leftover:** the blobs behind those three old ids stay on
/// the server. Horizon-GC reclaims `deleted`-marked records only, and nothing
/// marks these — a live record simply loses its last reader. They are inert (the
/// puller's `read_myn_content_nonce` accepts `MY01`/`NC05` magic only, so a
/// stray `MYP1`/`MYT1`/`MYC1` is skipped, never written as a note), so this is
/// storage debt rather than a defect. Reclaiming them needs a tombstone push for
/// an id that is in no local manifest, which is a mechanism of its own; tracked
/// separately rather than folded into the wedge fix.
///
/// Best-effort throughout: a re-key that has already re-written every note must
/// not fail on sync bookkeeping. A device that misses this still re-bases later,
/// because the flag is read on every cycle rather than consumed once here.
async fn rebase_sync_plane_after_rekey(
    io: &dyn VaultIo,
    vault_root: &Path,
    old_root_key: &[u8; 32],
    new_root_key: &[u8; 32],
) {
    use crate::plugins::sync::orchestrator::{
        agent_memory_catalog_sync_id, agent_personality_sync_id, catalog_sync_id,
        chats_catalog_sync_id, prefs_sync_id, themes_sync_id,
    };
    use crate::plugins::sync::state::{mark_vault_meta_dirty, read_sync_state, write_sync_state};

    let Ok(mut state) = read_sync_state(io, vault_root).await else {
        // Present and unreadable — NOT the same as absent, and the one case where
        // writing would destroy the cursor, the VV log and every CAS baseline.
        // Leave it alone; sync is already in a state a human has to look at.
        return;
    };
    if state.device_id_hex.is_none() {
        return; // never enrolled — there is no sync plane to re-base
    }
    state.rekey_rebase_pending = true;
    for id in [
        catalog_sync_id(old_root_key),
        prefs_sync_id(old_root_key),
        themes_sync_id(old_root_key),
        // The conversations catalog (myne-md/myne#675): same root_key-derived
        // sync-id shape as the three above, so the old id strands a server
        // record on re-key and owes the same orphan tombstone. The
        // per-conversation files do NOT appear here: their sync blob-ids are
        // the client-minted conversation ids, not root_key derivations, so a
        // re-key does not strand them.
        chats_catalog_sync_id(old_root_key),
        // The agent-memory catalog + personality (myne-md/myne#697): same
        // root_key-derived sync-id shape, so the same orphan tombstone. The
        // per-entry files do NOT appear here: their sync blob-ids are the
        // client-minted entry ids, not root_key derivations.
        agent_memory_catalog_sync_id(old_root_key),
        agent_personality_sync_id(old_root_key),
    ] {
        let hex = crate::plugins::sync::to_hex(&id);
        // Queue the tombstone BEFORE dropping the baseline (#443): the removal
        // takes the `base_version` with it, and that version is what the
        // tombstone push CASes against. A singleton this device never pushed
        // has no baseline and therefore nothing stranded — there is no server
        // record under that id to reclaim.
        if let Some(baseline) = state.blobs.get(&hex) {
            let mut nonce = [0u8; 24];
            if getrandom::getrandom(&mut nonce).is_ok() {
                state.pending_orphan_tombstones.push(
                    crate::plugins::sync::state::OrphanTombstone {
                        blob_id_hex: hex.clone(),
                        base_version: baseline.version,
                        content_nonce_hex: crate::plugins::sync::to_hex(&nonce),
                    },
                );
            }
        }
        state.blobs.remove(&hex);
    }
    // Asserted rather than assumed: the new ids must not collide with the old
    // ones, or the removals above would delete a baseline the new generation is
    // about to need. They are HKDF outputs under different roots, so this holds
    // by construction — but the removal is destructive and the check is free.
    debug_assert!(prefs_sync_id(old_root_key) != prefs_sync_id(new_root_key));
    if write_sync_state(io, vault_root, &state).await.is_err() {
        tracing::warn!(
            target: "vault_migrate",
            event = "sync_rebase_state_write_failed",
            "post-migration sync re-base flag not persisted; the next cycle may alarm"
        );
        return;
    }
    let _ = mark_vault_meta_dirty(io, vault_root).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::test_host::TestHost;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use protocol::{
        decode_crdt_note_blob, derive_items_key_v0_2, encode_new_note, parse_vault_meta_v0_2,
        unlock_root_key_v0_2_password, unlock_root_key_v0_2_recovery,
    };

    const OLD_ROOT: [u8; 32] = [0x99; 32];
    const OLD_ITEMS: [u8; 32] = [0x9A; 32];
    const OLD_ITEMS_ID: [u8; 16] = [0x9B; 16];
    const ACCT: [u8; 16] = [0x44; 16];
    const PASSWORD: &str = "correct horse battery staple";
    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const ACTOR: &[u8] = &[0xAA; 16];

    fn fast_params() -> KdfParams {
        // `MIN_KDF_M_KIB` (8 MiB) is the validation floor `derive_root_key_v0_2`
        // enforces on unlock — the command test drives a full re-unlock, so the
        // fixture must sit AT the floor (weak-but-VALID), not below it. Argon2id
        // at 8 MiB / t1 / p1 is still sub-100ms.
        KdfParams {
            m_kib: protocol::MIN_KDF_M_KIB,
            t: 1,
            p: 1,
            argon2_version: 0x13,
        }
    }

    /// Seed a v0.1 `MY01` note under the OLD itemsKey (the pre-migration shape).
    fn my01(uuid: &[u8; 16], markdown: &str) -> Vec<u8> {
        encode_new_note(&OLD_ITEMS, &OLD_ITEMS_ID, uuid, markdown.as_bytes()).expect("MY01")
    }

    #[test]
    fn hex_decode_16_rejects_a_32_byte_non_ascii_name_without_panicking() {
        // 16 two-byte characters = exactly 32 BYTES: the length gate alone
        // passes, and the byte-indexed slices would land mid-character
        // (byte index 1 is not a char boundary) without the ASCII gate.
        let multibyte = "é".repeat(16);
        assert_eq!(multibyte.len(), 32, "fixture must be 32 bytes");
        assert_eq!(multibyte.chars().count(), 16, "fixture must be multi-char");
        assert!(hex_decode_16_conversation(&multibyte).is_none());
        // The valid shape still decodes.
        let valid = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            hex_decode_16_conversation(valid),
            Some([
                0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
                0xcd, 0xef
            ])
        );
        // Wrong length still rejects.
        assert!(hex_decode_16_conversation("0123").is_none());
        // Non-hex ASCII still rejects.
        assert!(hex_decode_16_conversation(&"z".repeat(32)).is_none());
    }

    #[test]
    fn migrates_keys_and_notes_end_to_end() {
        let _host = TestHost::new("/base");
        let u1 = [0x01u8; 16];
        let u2 = [0x02u8; 16];
        let md1 = "---\ntitle: One İş 🚀\n---\n\n# Body with a [[link]]\n";
        let md2 = "second note, plain body";
        let notes = vec![(u1, my01(&u1, md1)), (u2, my01(&u2, md2))];

        let out = migrate_keys_and_notes(
            &OLD_ITEMS,
            &OLD_ITEMS_ID,
            PASSWORD,
            PHRASE,
            &ACCT,
            &fast_params(),
            &notes,
            ACTOR,
            0,
        )
        .expect("migrate");

        // (1) The NTV5 vault.meta is the v0.2 family and unwraps the SAME new
        //     root_key under BOTH credentials (recovery not stranded, §10.4.1).
        assert_eq!(&out.ntv5_meta[0..4], b"NTV5");
        let meta = parse_vault_meta_v0_2(&out.ntv5_meta).expect("parse NTV5");
        let via_pw = unlock_root_key_v0_2_password(&meta, PASSWORD, &ACCT).expect("pw unlock");
        let via_rec = unlock_root_key_v0_2_recovery(&meta, PHRASE, &ACCT).expect("rec unlock");
        assert_eq!(*via_pw, *out.new_root_key);
        assert_eq!(
            *via_rec, *out.new_root_key,
            "recovery recovers the new root_key"
        );

        // (2) The v0.2 itemsKey the notes were wrapped under is the one NTV5 carries.
        let items_from_meta = derive_items_key_v0_2(&via_pw, &meta).expect("items derive");
        assert_eq!(*items_from_meta, *out.new_items_key);

        // (3) Every note became a decodable NC05 note whose markdown is byte-exact,
        //     decodable under the NEW itemsKey (proof the re-wrap landed).
        assert_eq!(out.notes.len(), 2);
        for (expected_md, mn) in [md1, md2].iter().zip(out.notes.iter()) {
            assert_eq!(&mn.nc05_blob[0..4], protocol::NC05_MAGIC);
            let got = crate::plugins::notes::crdt::decode_note_blob(
                &mn.nc05_blob,
                &mn.note_uuid,
                &out.new_items_key,
                &out.new_items_key_id,
            )
            .expect("decode migrated NC05 under new itemsKey");
            assert_eq!(
                &got, expected_md,
                "note markdown survived the migration byte-exact"
            );
        }

        // (4) The OLD itemsKey can no longer read the migrated notes (the re-key is
        //     real, not a re-label) — a wrong-key decode fails.
        let first = &out.notes[0];
        assert!(crate::plugins::notes::crdt::decode_note_blob(
            &first.nc05_blob,
            &first.note_uuid,
            &OLD_ITEMS,
            &out.new_items_key_id,
        )
        .is_err());
    }

    #[test]
    fn a_note_that_does_not_decrypt_under_the_old_key_is_rejected() {
        let _host = TestHost::new("/base");
        let u = [0x03u8; 16];
        // A MY01 blob under a DIFFERENT items_key → cannot decrypt under OLD_ITEMS.
        let alien = encode_new_note(&[0x77; 32], &OLD_ITEMS_ID, &u, b"x").expect("MY01");
        // Matched (not `unwrap_err`) so `MigrationOutput` — which holds key
        // material — never needs a `Debug` impl that could print it.
        match migrate_keys_and_notes(
            &OLD_ITEMS,
            &OLD_ITEMS_ID,
            PASSWORD,
            PHRASE,
            &ACCT,
            &fast_params(),
            &[(u, alien)],
            ACTOR,
            0,
        ) {
            Err(e) => assert_eq!(e, MigrationError::CannotDecryptNote),
            Ok(_) => panic!("an undecryptable note must abort the migration"),
        }
    }

    #[test]
    fn on_disk_migration_rewrites_notes_to_nc05_stages_legacy_and_commits_ntv5_last() {
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-on-disk").unwrap();
            let vault_root = tmp.path().to_path_buf();
            let notes_dir = vault_root.join("notes");
            let io = StdVaultIo;
            io.create_dir_all(&notes_dir).await.unwrap();

            // Seed a pre-migration vault: a (dummy) MYV1 vault.meta + two MY01 notes
            // under the OLD itemsKey.
            io.write(
                &vault_root.join("vault.meta"),
                b"MYV1 old vault meta bytes (opaque to the migration)",
                WriteOpts::default(),
            )
            .await
            .unwrap();
            // Real UUIDv7 note ids (the on-disk scan strict-parses filenames as v7).
            let u1 = *crate::plugins::notes::note_id::NoteId::new_v7()
                .as_uuid()
                .as_bytes();
            let u2 = *crate::plugins::notes::note_id::NoteId::new_v7()
                .as_uuid()
                .as_bytes();
            let md1 = "---\ntitle: One\n---\n\n# Body [[link]] 🚀\n";
            let md2 = "second";
            for (u, md) in [(u1, md1), (u2, md2)] {
                let blob = my01(&u, md);
                io.write(
                    &notes_dir.join(format!("{}.myn", uuid::Uuid::from_bytes(u))),
                    &blob,
                    WriteOpts::default(),
                )
                .await
                .unwrap();
            }

            // Seed a KEK-envelope singleton (vault.dictionary, MYD1) under the OLD
            // dictionary KEK, so the migration re-seals it to MYD5.
            let old_dict_kek =
                protocol::derive_subkey(&OLD_ROOT, protocol::SubkeyRole::PersonalDictKey);
            // A GENUINE pre-myne#640 payload: the `0x01` shape is the two word
            // sets with no clock map, so the fixture can actually be parsed back
            // and a relabel is distinguishable from a faithful re-seal. The
            // earlier fixture was `b"opaque dict bytes"`, which parses as neither
            // generation and so passed while the migration stamped `0x02` over
            // `0x01` bytes (myne-md/myne#640).
            let v1_payload = crate::plugins::sync::dictionary_payload::PersonalDictionaryV1 {
                personal_words: vec!["myne".to_string()],
                ignore_words: vec!["kubectl".to_string()],
            }
            .encode();
            let mut dict_blob = protocol::encode_dictionary_blob(&old_dict_kek, &ACCT, &v1_payload)
                .expect("seed MYD1");
            dict_blob[5] = protocol::DICTIONARY_BLOB_FORMAT_V1;
            io.write(
                &vault_root.join("vault.dictionary"),
                &dict_blob,
                WriteOpts::default(),
            )
            .await
            .unwrap();

            let summary = migrate_vault_notes_on_disk(
                &io,
                &vault_root,
                &notes_dir,
                &OLD_ROOT,
                &OLD_ITEMS,
                &OLD_ITEMS_ID,
                PASSWORD,
                PHRASE,
                &ACCT,
                &fast_params(),
                ACTOR,
                &TestHost::new("/base"),
            )
            .await
            .expect("on-disk migration");
            assert_eq!(summary.notes_migrated, 2);
            assert_eq!(summary.singletons_migrated, 1, "vault.dictionary re-sealed");

            // vault.dictionary is now MYD5 and no longer decodes as a MYD1 blob;
            // legacy/ preserves the original MYD1 (still decodable under the old KEK).
            let new_dict = io.read(&vault_root.join("vault.dictionary")).await.unwrap();
            assert_eq!(&new_dict[0..4], b"MYD5");
            assert_eq!(
                protocol::dictionary_blob_format(&new_dict),
                Some(protocol::DICTIONARY_BLOB_FORMAT_V1),
                "a v0.1 payload must keep a v0.1 header: the inner re-seal is opaque, so \
                 stamping the current byte over old bytes is a relabel the reader then \
                 refuses (myne-md/myne#640)"
            );
            assert!(protocol::decode_dictionary_blob(&old_dict_kek, &ACCT, &new_dict).is_err());
            let legacy_dict = io
                .read(&vault_root.join("legacy/vault.dictionary"))
                .await
                .unwrap();
            assert_eq!(&legacy_dict[0..4], b"MYD1");
            assert!(
                protocol::decode_dictionary_blob(&old_dict_kek, &ACCT, &legacy_dict).is_ok(),
                "the legacy snapshot preserves the original dictionary"
            );

            // vault.meta is now NTV5 and recovers the new root_key under both creds.
            let meta_bytes = io.read(&vault_root.join("vault.meta")).await.unwrap();
            assert_eq!(&meta_bytes[0..4], b"NTV5");
            let meta = parse_vault_meta_v0_2(&meta_bytes).expect("NTV5 parse");
            let root_pw = unlock_root_key_v0_2_password(&meta, PASSWORD, &ACCT).expect("pw");
            let root_rec = unlock_root_key_v0_2_recovery(&meta, PHRASE, &ACCT).expect("rec");
            assert_eq!(*root_pw, *root_rec, "both creds recover the same root_key");
            let new_items = derive_items_key_v0_2(&root_pw, &meta).expect("items");

            // Each note file is now an NC05 blob decodable under the NEW itemsKey,
            // and its markdown survived byte-exact.
            for (u, md) in [(u1, md1), (u2, md2)] {
                let blob = io
                    .read(&notes_dir.join(format!("{}.myn", uuid::Uuid::from_bytes(u))))
                    .await
                    .unwrap();
                assert_eq!(&blob[0..4], protocol::NC05_MAGIC);
                let save = decode_crdt_note_blob(&blob, &u, &new_items, &meta.items_key_id)
                    .expect("decode NC05 under new itemsKey");
                let got = crate::plugins::notes::crdt::decode_note(&save).expect("bridge");
                assert_eq!(got, md);
            }

            // legacy/ holds the old vault.meta + the old MY01 notes (abort hatch).
            let legacy_meta = io
                .read(&vault_root.join("legacy/vault.meta"))
                .await
                .unwrap();
            assert_eq!(&legacy_meta[0..4], b"MYV1");
            let legacy_note = io
                .read(&vault_root.join(format!("legacy/notes/{}.myn", uuid::Uuid::from_bytes(u1))))
                .await
                .unwrap();
            assert_eq!(&legacy_note[0..4], protocol::blob::MAGIC.as_slice());
            // The legacy MY01 note still decodes under the OLD itemsKey.
            let dec =
                decode_note(&legacy_note, &u1, &OLD_ITEMS, &OLD_ITEMS_ID).expect("legacy MY01");
            assert_eq!(
                core::str::from_utf8(dec.plaintext()).unwrap(),
                md1,
                "the legacy snapshot preserves the original note"
            );
        })
    }

    /// Build a real `MYV1` v0.1 `vault.meta` sealing `OLD_ROOT` under both
    /// `PASSWORD` and `PHRASE`, and `OLD_ITEMS` under it — the pre-migration
    /// vault the command reads.
    /// An enrolled device mid-sync on a fresh v0.1 vault: a `notes` directory,
    /// the vault itself, and a `SyncState` carrying a cursor, a device id, an
    /// account hash, and a CAS baseline for each of the three root-derived
    /// singleton sync-ids. Returns those three ids as hex, which is the form
    /// `SyncState::blobs` is keyed by and the form every assertion wants.
    ///
    /// Extracted because two tests rest on exactly this premise, and the shape
    /// duplicated rather than shared is a shape that drifts: a change to what an
    /// enrolled device's sync state looks like would have to be made twice, and
    /// the second copy drifting is invisible because both tests stay green.
    /// Which of the six seeded singletons `drop_one_baseline` un-seeds. Themes: a
    /// settings family, so leaving it out is invisible in the loss list and the
    /// assertion has to name it.
    const THEME_INDEX: usize = 2;

    async fn seed_enrolled_device_sync_state(
        io: &StdVaultIo,
        vault_root: &std::path::Path,
    ) -> Vec<String> {
        use crate::plugins::sync::orchestrator::{catalog_sync_id, prefs_sync_id, themes_sync_id};
        use crate::plugins::sync::state::{write_sync_state, BlobSyncState, SyncState};
        io.create_dir_all(&vault_root.join("notes")).await.unwrap();
        build_myv1_vault(io, vault_root).await;

        // All SIX root-derived singletons, because the re-key queues a
        // tombstone only for an id this device actually pushed ("a singleton
        // this device never pushed has no baseline and therefore nothing
        // stranded". Seeding three made the test's own count an artefact of the
        // fixture while the code under test had six candidates, which is how
        // three different numbers ended up in three places.
        let old_ids = [
            catalog_sync_id(&OLD_ROOT),
            prefs_sync_id(&OLD_ROOT),
            themes_sync_id(&OLD_ROOT),
            crate::plugins::sync::orchestrator::chats_catalog_sync_id(&OLD_ROOT),
            crate::plugins::sync::orchestrator::agent_memory_catalog_sync_id(&OLD_ROOT),
            crate::plugins::sync::orchestrator::agent_personality_sync_id(&OLD_ROOT),
        ];
        let mut seeded = SyncState {
            cursor: 42,
            device_id_hex: Some("aa".repeat(16)),
            account_hash_hex: Some("bb".repeat(16)),
            ..SyncState::default()
        };
        for id in &old_ids {
            seeded.blobs.insert(
                crate::plugins::sync::to_hex(id),
                BlobSyncState {
                    version: 7,
                    content_nonce_hex: "cc".repeat(24),
                    doc_heads_hex: Vec::new(),
                },
            );
        }
        write_sync_state(io, vault_root, &seeded).await.unwrap();
        drop_one_baseline(io, vault_root, &old_ids[THEME_INDEX]).await;
        old_ids
            .iter()
            .map(|id| crate::plugins::sync::to_hex(id.as_slice()))
            .collect()
    }

    /// Remove one singleton's CAS baseline, so the fixture covers both halves of the
    /// rule in `rebase_sync_plane_after_rekey`: a pushed singleton is stranded and
    /// owes a reclaim tombstone, and one this device never pushed has no baseline
    /// and therefore nothing stranded.
    ///
    /// The index is a named constant rather than a position because the negative arm
    /// is the one a reader cannot see: the queue length is compared against the
    /// seeded list, so a fixture that seeds all six makes "no baseline means no
    /// tombstone" unreachable and the suite stays green with the guard deleted. It
    /// was reachable at the merge base and a first pass at six removed it.
    async fn drop_one_baseline(io: &StdVaultIo, vault_root: &std::path::Path, id: &[u8]) {
        use crate::plugins::sync::state::{read_sync_state, write_sync_state};
        let mut state = read_sync_state(io, vault_root).await.unwrap();
        assert!(
            state
                .blobs
                .remove(&crate::plugins::sync::to_hex(id))
                .is_some(),
            "precondition: the singleton to leave unseeded was seeded"
        );
        write_sync_state(io, vault_root, &state).await.unwrap();
    }

    async fn build_myv1_vault(io: &StdVaultIo, vault_root: &std::path::Path) {
        use protocol::{
            aad_password_wrap, aad_recovery_wrap, aad_vault_items_key_wrap, aead_seal_ctx,
            derive_password_wrap_key, derive_recovery_wrap_key_from_normalized, derive_subkey,
            normalize_user_phrase, serialize_vault_meta, SubkeyRole, VaultMeta,
        };
        let p = fast_params();
        let seal64 = |v: Vec<u8>| -> [u8; 64] {
            let mut a = [0u8; 64];
            a.copy_from_slice(&v);
            a
        };
        let salt_pw = [0x01u8; 16];
        let salt_rec = [0x03u8; 16];
        let nonce_pw = [0x02u8; 24];
        let nonce_rec = [0x04u8; 24];
        let items_nonce = [0x05u8; 24];

        let pw_wrap = derive_password_wrap_key(PASSWORD, &salt_pw, &ACCT, &p).unwrap();
        let enc_root_pw =
            seal64(aead_seal_ctx(&pw_wrap, &nonce_pw, &OLD_ROOT, &aad_password_wrap(&p)).unwrap());
        let normalized = normalize_user_phrase(PHRASE);
        let rec_wrap =
            derive_recovery_wrap_key_from_normalized(&normalized, &salt_rec, &ACCT, &p).unwrap();
        let enc_root_rec = seal64(
            aead_seal_ctx(&rec_wrap, &nonce_rec, &OLD_ROOT, &aad_recovery_wrap(&p)).unwrap(),
        );
        let items_wrap = derive_subkey(&OLD_ROOT, SubkeyRole::ItemsKeyWrap);
        let enc_items = seal64(
            aead_seal_ctx(
                &items_wrap,
                &items_nonce,
                &OLD_ITEMS,
                &aad_vault_items_key_wrap(&OLD_ITEMS_ID),
            )
            .unwrap(),
        );
        let meta = VaultMeta {
            account_number_hash: ACCT,
            kdf_params: p,
            random_salt_password: salt_pw,
            random_salt_recovery: salt_rec,
            nonce_password_wrap: nonce_pw,
            enc_root_key_password: enc_root_pw,
            nonce_recovery_wrap: nonce_rec,
            enc_root_key_recovery: enc_root_rec,
            items_key_id: OLD_ITEMS_ID,
            items_key_nonce: items_nonce,
            enc_items_key: enc_items,
            membership: None,
            person_binding: None,
        };
        io.write(
            &vault_root.join("vault.meta"),
            &serialize_vault_meta(&meta),
            WriteOpts::default(),
        )
        .await
        .unwrap();
    }

    #[test]
    fn command_migrates_a_real_vault_and_enforces_the_phrase_gate() {
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-cmd").unwrap();
            let host = TestHost::new(tmp.path());
            let io = StdVaultIo;
            // Seed at the SAME path the command resolves (host app_data_dir → the
            // legacy single-vault dir), not a hand-built path.
            let vault_root = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            let notes_dir = vault_root.join("notes");
            io.create_dir_all(&notes_dir).await.unwrap();
            build_myv1_vault(&io, &vault_root).await;

            // One MY01 note (real v7 id, under the OLD itemsKey).
            let u = *crate::plugins::notes::note_id::NoteId::new_v7()
                .as_uuid()
                .as_bytes();
            let md = "---\ntitle: Pre\n---\n\n# Body [[l]] 🚀\n";
            io.write(
                &notes_dir.join(format!("{}.myn", uuid::Uuid::from_bytes(u))),
                &my01(&u, md),
                WriteOpts::default(),
            )
            .await
            .unwrap();

            let state = VaultRuntimeState::default();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);

            // (1) A WRONG phrase is refused backend-side, and writes nothing — the
            //     vault.meta is still MYV1 afterwards (the phrase-required gate).
            let wrong = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
            match vault_migrate_from_host(&host, &state, &hooks, PASSWORD, wrong, &io).await {
                Err(VaultMigrateError::RecoveryPhraseRequired) => {}
                other => panic!("wrong phrase must refuse, got {other:?}"),
            }
            let still = io.read(&vault_root.join("vault.meta")).await.unwrap();
            assert_eq!(&still[0..4], b"MYV1", "a refused migration writes nothing");

            // (2) A wrong PASSWORD is refused (non-distinguishing).
            match vault_migrate_from_host(&host, &state, &hooks, "wrong pw", PHRASE, &io).await {
                Err(VaultMigrateError::InvalidCredentialOrVault) => {}
                other => panic!("wrong password must refuse, got {other:?}"),
            }

            // (3) Correct password + phrase migrates the whole vault.
            let summary = vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io)
                .await
                .expect("migration succeeds");
            assert_eq!(summary.notes_migrated, 1);

            // vault.meta is now NTV5 and recovers the new root_key under BOTH creds.
            let meta_bytes = io.read(&vault_root.join("vault.meta")).await.unwrap();
            assert_eq!(&meta_bytes[0..4], b"NTV5");
            let meta = parse_vault_meta_v0_2(&meta_bytes).unwrap();
            let root_pw = unlock_root_key_v0_2_password(&meta, PASSWORD, &ACCT).unwrap();
            let root_rec = unlock_root_key_v0_2_recovery(&meta, PHRASE, &ACCT).unwrap();
            assert_eq!(*root_pw, *root_rec, "recovery recovers the new root_key");
            // The note is NC05 under the new itemsKey, byte-exact.
            let new_items = derive_items_key_v0_2(&root_pw, &meta).unwrap();
            let blob = io
                .read(&notes_dir.join(format!("{}.myn", uuid::Uuid::from_bytes(u))))
                .await
                .unwrap();
            assert_eq!(&blob[0..4], protocol::NC05_MAGIC);
            let save = decode_crdt_note_blob(&blob, &u, &new_items, &meta.items_key_id).unwrap();
            assert_eq!(crate::plugins::notes::crdt::decode_note(&save).unwrap(), md);

            // (4) Re-running on the migrated vault is refused (already NTV5). Runs
            //     while the slot is still empty so `active_vault_id` resolves to the
            //     seeded dir.
            match vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io).await {
                Err(VaultMigrateError::AlreadyMigrated) => {}
                other => panic!("second migration must refuse, got {other:?}"),
            }

            // (5) The FULL unlock command re-opens the migrated NTV5 vault under the
            //     password — the exact `NTV5` magic-dispatch the desktop re-unlock
            //     drives (#420 t4). The migration locked the running slot (a re-key
            //     event), so this proves the slot re-populates with the new v0.2
            //     keys — the deterministic proof behind the E2E's re-unlock step,
            //     free of its production-KDF-at-tail timing.
            crate::plugins::vault_unlock::commands::unlock_with_path(
                PASSWORD.to_string(),
                None,
                &vault_root.join("vault.meta"),
                &state,
                &io,
                &host,
            )
            .await
            .expect("the migrated NTV5 vault unlocks under the password");
            assert!(
                crate::plugins::vault_unlock::commands::vault_is_unlocked_from_host(&state)
                    .await
                    .unwrap(),
                "the slot is populated after the NTV5 re-unlock"
            );
        })
    }

    /// The ABORT unwind covers one of the three durable changes the re-base
    /// made. (myne-md/myne#750)
    ///
    /// `rebase_sync_plane_after_rekey` runs at step (5d) of
    /// `migrate_vault_notes_on_disk`, before the NTV5 write at (6) which that
    /// function names the atomic commit point, and it makes three durable
    /// changes: it arms `rekey_rebase_pending`, it queues an `OrphanTombstone`
    /// per root-derived singleton, and it drops each of their CAS baselines. The
    /// abort at `vault_migrate_abort_from_host` restores `legacy/vault.meta` and
    /// clears the flag. The queue and the dropped baselines outlive it.
    ///
    /// The consequence is a data loss, not a bookkeeping drift. After the
    /// rollback the vault is back on the OLD `root_key`, so the ids those
    /// tombstones name are live again, and `drain_orphan_tombstones` pushes each
    /// as `PushBlob { tombstone: true, ciphertext: [] }` at the version the
    /// dropped baseline held. Every peer that pulls that tombstone drops its own
    /// `vault.attachments` catalog, `vault.prefs` and `vault.themes`.
    ///
    /// Asserted in the REFUSAL direction, so the fix makes these live, and
    /// IGNORED because the fix is not this branch's. An earlier version of this
    /// test asserted the defective state and passed, which is worse than no
    /// test: it certified the data loss as correct and would have gone red at
    /// the moment someone fixed it. Run it with `cargo test -p myne-core
    /// -- --ignored an_aborted_migration`. Tracked by myne-md/myne#759.
    ///
    /// Why the fix is not written here: clearing the queue is the obvious
    /// one-liner and it is a HALF fix, because restoring the dropped baselines
    /// needs the pre-rebase state the abort path does not hold. That is the sync
    /// plane, which the sizing rule classes as never small however short the
    /// diff, so it carries its own risk tier and a design step. The issue that
    /// owns the verdicts does not own a sync-plane change, so the fix needs its
    /// own issue, and it now has one: myne-md/myne#759.
    ///
    /// What this does NOT settle either way: whether the server ACCEPTS that
    /// push is a CAS-ordering fact and `myne-server` is absent from this
    /// repository. The assertions are the half this repository owns.
    /// The precondition of the ignored test below, asserted on its own so it
    /// RUNS. Inside an `#[ignore]`d test it never executes in `cargo test` or
    /// in CI, which is the one failure its own comment says it exists to catch:
    /// a fixture that armed nothing and a fixture that armed six look identical
    /// from outside a test that does not run.
    #[test]
    fn the_rebase_arms_one_tombstone_per_root_derived_singleton() {
        use crate::plugins::sync::state::read_sync_state;
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-rebase-arms").unwrap();
            let host = TestHost::new(tmp.path());
            let io = StdVaultIo;
            let vault_root = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            seed_enrolled_device_sync_state(&io, &vault_root).await;

            let state = VaultRuntimeState::default();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io)
                .await
                .expect("migration succeeds");

            let mid = read_sync_state(&io, &vault_root).await.unwrap();
            assert!(
                mid.rekey_rebase_pending,
                "precondition: the re-key armed the re-base flag"
            );
            // Five, not six: the fixture un-seeds one singleton so the "no
            // baseline means nothing stranded" arm stays reachable, and a
            // precondition that asserted the candidate count would be asserting
            // the fixture rather than the rule.
            assert_eq!(
                mid.pending_orphan_tombstones.len(),
                5,
                "precondition: one tombstone per root-derived singleton this device \
                 pushed, out of six candidates (attachments catalog, prefs, \
                 themes, conversations catalog, agent-memory catalog, \
                 personality)"
            );
        });
    }

    #[test]
    #[ignore = "unfixed: the abort unwinds one of the re-base's durable changes; see myne-md/myne#759"]
    fn an_aborted_migration_leaves_nothing_aimed_at_a_live_singleton() {
        use crate::plugins::sync::state::read_sync_state;
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-abort-rebase").unwrap();
            let host = TestHost::new(tmp.path());
            let io = StdVaultIo;
            let vault_root = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            let old_ids = seed_enrolled_device_sync_state(&io, &vault_root).await;

            let state = VaultRuntimeState::default();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io)
                .await
                .expect("migration succeeds");

            // The re-base armed the queue while the vault was still v0.1. This
            // is the precondition, and it is asserted LIVE so the ignored
            // assertions below cannot be reached by a fixture that never armed
            // anything.
            // The re-base queues one tombstone per root_key-derived SINGLETON,
            // and there are six of them, not three: the attachments catalog,
            // prefs, themes, the conversations catalog, the agent-memory catalog
            // and the personality directive (myne-md/myne#675, #697). The first
            // version of this test asserted 3 and the dev note then claimed
            // "the fixture is smaller than production, and the test says so":
            // which no comment in the test said. It is the same size.
            let mid = read_sync_state(&io, &vault_root).await.unwrap();
            assert_eq!(
                mid.pending_orphan_tombstones.len(),
                6,
                "precondition: the re-base queues one tombstone per root-derived \
                 singleton, and there are six"
            );

            vault_migrate_abort_from_host(&host, &state, &hooks, &io)
                .await
                .expect("abort succeeds");

            let after = read_sync_state(&io, &vault_root).await.unwrap();
            // (1) The flag IS unwound today. Asserted so the finding is not read
            //     as "the abort does nothing".
            assert!(
                !after.rekey_rebase_pending,
                "the armed re-base flag must be cleared by the rollback"
            );
            // (2) …the queue is NOT, and must be. The rollback restores the old
            //     `root_key`, so the ids these tombstones name are live again.
            assert!(
                after.pending_orphan_tombstones.is_empty(),
                "the tombstone queue outlived the premise that made those ids \
                 orphans: the vault is back on the old root_key, so they are live, \
                 and draining it deletes them on every peer"
            );
            let still_queued: std::collections::BTreeSet<&str> = after
                .pending_orphan_tombstones
                .iter()
                .map(|t| t.blob_id_hex.as_str())
                .collect();
            for id in &old_ids {
                assert!(
                    !still_queued.contains(id.as_str()),
                    "a tombstone for a now-live singleton id survived the rollback"
                );
            }
            // (3) The dropped CAS baselines must be restored too, or the local
            //     view no longer knows the version its own singletons sit at and
            //     the next push goes out at base_version 0.
            for id in &old_ids {
                assert!(
                    after.blobs.contains_key(id),
                    "a rolled-back migration left the singleton's CAS baseline \
                     dropped, so the next push would CAS against version 0"
                );
            }
        })
    }

    /// A migration on a SYNC-ENROLLED device must hand the sync plane over to the
    /// new key generation (myne-md/myne#429).
    ///
    /// The re-key replaces `root_key`, and four sync artefacts hang off it: the
    /// vault-head MAC, the device-local head baseline, the SCRAM verifier, and
    /// the reserved sync-ids of the three synced singletons. The migration used
    /// to touch none of them, so the next cycle read the server's
    /// previous-generation head as a FORGERY, raised the malicious-server alert,
    /// and aborted before the push — never re-authoring the head, so the state
    /// fed itself forever.
    ///
    /// Each assertion below is one leg of that, and each is separately
    /// falsifiable: removing any single leg leaves the others green.
    #[test]
    fn a_migration_hands_the_sync_plane_to_the_new_key_generation() {
        use crate::plugins::sync::state::{read_sync_state, vault_meta_is_dirty};
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-rebase").unwrap();
            let host = TestHost::new(tmp.path());
            let io = StdVaultIo;
            let vault_root = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            let all_ids_hex = seed_enrolled_device_sync_state(&io, &vault_root).await;
            // Five of the six: `seed_enrolled_device_sync_state` un-seeds one, so
            // the tombstone count is the seeded count and the un-seeded id is
            // named below as the one that owes nothing.
            let expected_tombstones = all_ids_hex.len() - 1;
            let theme_hex = &all_ids_hex[THEME_INDEX];
            // The device-local head baseline (`MYH1`), whose integrity is the
            // head's own HMAC under a subkey of the root about to be replaced.
            io.write(
                &vault_root.join("vault.head-state"),
                b"MYH1-placeholder",
                WriteOpts::default(),
            )
            .await
            .unwrap();

            let state = VaultRuntimeState::default();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io)
                .await
                .expect("migration succeeds");

            let after = read_sync_state(&io, &vault_root).await.unwrap();
            // (1) The next pull is allowed to see an unopenable head once, instead
            //     of accusing the server of forging it.
            assert!(
                after.rekey_rebase_pending,
                "the re-base exemption must be armed for the next cycle"
            );
            // (2) The head baseline is gone: it can no longer verify its own MAC.
            assert!(
                io.read(&vault_root.join("vault.head-state")).await.is_err(),
                "the stale-generation head baseline must not survive the re-key"
            );
            // (3) The NTV5 meta is queued for the server, or a second device can
            //     never learn the vault was re-keyed.
            assert!(
                vault_meta_is_dirty(&io, &vault_root).await,
                "the migrated vault.meta must be queued for push"
            );
            // (4) The old singletons' CAS baselines describe blobs under sync-ids
            //     this vault no longer derives.
            for id in &all_ids_hex {
                assert!(
                    !after.blobs.contains_key(id),
                    "a previous-generation singleton baseline survived the re-key"
                );
            }
            // (4b) …and each one is queued for a server-side tombstone (#443),
            //      carrying the version the baseline held. Dropping the baseline
            //      without queueing first is exactly the bug: the CAS base is
            //      gone and the blob is stranded forever.
            let queued: std::collections::BTreeMap<String, u64> = after
                .pending_orphan_tombstones
                .iter()
                .map(|t| (t.blob_id_hex.clone(), t.base_version))
                .collect();
            assert_eq!(
                queued.len(),
                expected_tombstones,
                "every re-keyed singleton this device had PUSHED owes a reclaim \
                 tombstone, and the one it never pushed owes none, got {queued:?}"
            );
            assert!(
                !queued.contains_key(theme_hex),
                "a singleton with no baseline was queued: there is no server record \
                 under that id to reclaim, and a tombstone for it would delete a \
                 blob the peer still holds"
            );
            for id in all_ids_hex.iter().filter(|id| *id != theme_hex) {
                assert_eq!(
                    queued.get(id),
                    Some(&7),
                    "the tombstone must CAS against the version the dropped \
                     baseline held, not 0"
                );
            }
            // A fresh nonce per entry, and none of them the one the live blob
            // carried — reusing it would be "different bytes, same nonce".
            let nonces: std::collections::BTreeSet<&str> = after
                .pending_orphan_tombstones
                .iter()
                .map(|t| t.content_nonce_hex.as_str())
                .collect();
            assert_eq!(
                nonces.len(),
                expected_tombstones,
                "each tombstone mints its own nonce"
            );
            assert!(!nonces.contains(&"cc".repeat(24).as_str()));
            // (5) …and the rest of the enrolment is untouched: re-basing is not
            //     re-enrolling, and dropping these would cost the device its
            //     identity and every note's CAS base.
            assert_eq!(after.cursor, 42);
            assert_eq!(
                after.device_id_hex.as_deref(),
                Some("aa".repeat(16).as_str())
            );
            assert_eq!(
                after.account_hash_hex.as_deref(),
                Some("bb".repeat(16).as_str())
            );
        })
    }

    /// The whole-vault re-key takes the single-in-flight auth permit
    /// (myne-md/myne#434).
    ///
    /// It took nothing at all, while every peer in the auth pipeline took it —
    /// change-password, backup export, quick-unlock enrolment. The concrete cost
    /// was not theoretical: `export_backup_core` guards only against permit
    /// HOLDERS, so a scheduled backup firing mid-migration streamed a vault whose
    /// notes were half `NC05` and half `MY01` under a still-`MYV1` `vault.meta`
    /// into a `.myne-backup` that verified cleanly and restored to a permanently
    /// torn vault.
    #[test]
    fn a_migration_is_refused_while_another_auth_operation_holds_the_permit() {
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-permit").unwrap();
            let host = TestHost::new(tmp.path());
            let io = StdVaultIo;
            let vault_root = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            io.create_dir_all(&vault_root.join("notes")).await.unwrap();
            build_myv1_vault(&io, &vault_root).await;

            let state = VaultRuntimeState::default();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);

            // Stand in for any other auth-pipeline operation.
            let held = state
                .auth_permits()
                .try_acquire()
                .expect("the permit is free at rest");
            match vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io).await {
                Err(VaultMigrateError::AuthOperationInProgress) => {}
                other => panic!("a migration must be refused, not queued, got {other:?}"),
            }
            // Refused BEFORE reading anything: the vault is untouched.
            let meta = io.read(&vault_root.join("vault.meta")).await.unwrap();
            assert_eq!(&meta[0..4], b"MYV1", "a refused migration writes nothing");

            // Released → it proceeds. The permit is a serializer, not a ban.
            drop(held);
            vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io)
                .await
                .expect("migration succeeds once the permit is free");
            let meta = io.read(&vault_root.join("vault.meta")).await.unwrap();
            assert_eq!(&meta[0..4], b"NTV5");
        })
    }

    /// An undecodable singleton aborts with the vault still entirely v0.1
    /// (myne-md/myne#441).
    ///
    /// The failure ordering is the whole subject. The singleton re-seal aborts on
    /// `?`, and it used to run AFTER the in-place note pass — so a corrupt
    /// `vault.themes` produced precisely the torn vault §10.4.1 md.3 describes as
    /// the CRASH case, with no crash, and with no way back. The assertions below
    /// are therefore about what did NOT happen: the meta is still `MYV1` and the
    /// note is still `MY01`, byte-identical.
    #[test]
    fn an_undecodable_singleton_aborts_before_anything_is_rewritten() {
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-failclosed").unwrap();
            let host = TestHost::new(tmp.path());
            let io = StdVaultIo;
            let vault_root = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            let notes_dir = vault_root.join("notes");
            io.create_dir_all(&notes_dir).await.unwrap();
            build_myv1_vault(&io, &vault_root).await;

            let u = *crate::plugins::notes::note_id::NoteId::new_v7()
                .as_uuid()
                .as_bytes();
            let md = "---\ntitle: Survivor\n---\n\n# Untouched\n";
            let note_path = notes_dir.join(format!("{}.myn", uuid::Uuid::from_bytes(u)));
            let original_note = my01(&u, md);
            io.write(&note_path, &original_note, WriteOpts::default())
                .await
                .unwrap();

            // A `vault.themes` with the right magic and a payload that will not
            // open — the shape a torn write or a bit-flip leaves behind.
            let mut junk = THEMES_BLOB_MAGIC.to_vec();
            junk.extend_from_slice(&[0xAB; 96]);
            io.write(
                &vault_root.join("vault.themes"),
                &junk,
                WriteOpts::default(),
            )
            .await
            .unwrap();

            let state = VaultRuntimeState::default();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            match vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io).await {
                Err(VaultMigrateError::Crypto) => {}
                other => panic!("an undecodable singleton must abort, got {other:?}"),
            }

            // Nothing was rewritten: this is the whole assertion.
            let meta = io.read(&vault_root.join("vault.meta")).await.unwrap();
            assert_eq!(&meta[0..4], b"MYV1", "the vault must still be v0.1");
            let note = io.read(&note_path).await.unwrap();
            assert_eq!(
                note, original_note,
                "the note must be byte-identical, not an NC05 rewrite"
            );
        })
    }

    /// The migration is not settled until the user says so: `abort` puts the
    /// v0.1 vault back byte-for-byte, and `confirm` crypto-erases it
    /// (§10.4.1 point 5, myne-md/myne#430 + #435).
    ///
    /// The `legacy/` staging shipped write-only — no reader, no deleter, no
    /// command — and the consequence was not merely a missing feature. Because
    /// `vault_change_password` rewrites `<vault>/vault.meta` only, `legacy/
    /// vault.meta` went on opening under the OLD password forever, so rotating
    /// the master password stopped revoking access to the staged notes. The
    /// recovery phrase cannot be rotated at all, so for it the exposure was
    /// permanent.
    #[test]
    fn abort_restores_the_v0_1_vault_and_confirm_erases_it() {
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-settle").unwrap();
            let host = TestHost::new(tmp.path());
            let io = StdVaultIo;
            let vault_root = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            let notes_dir = vault_root.join("notes");
            io.create_dir_all(&notes_dir).await.unwrap();
            build_myv1_vault(&io, &vault_root).await;

            let u = *crate::plugins::notes::note_id::NoteId::new_v7()
                .as_uuid()
                .as_bytes();
            let md = "---\ntitle: Pre\n---\n\n# Body\n";
            let note_path = notes_dir.join(format!("{}.myn", uuid::Uuid::from_bytes(u)));
            let original_note = my01(&u, md);
            io.write(&note_path, &original_note, WriteOpts::default())
                .await
                .unwrap();
            let original_meta = io.read(&vault_root.join("vault.meta")).await.unwrap();

            // A pre-migration snapshot: a byte-verbatim MY01 blob under the OLD
            // itemsKey, which the re-key would otherwise strand forever (#435).
            let snapshots = vault_root.join("snapshots");
            io.create_dir_all(&snapshots).await.unwrap();
            let snap_name = "snap-one.myn";
            io.write(
                &snapshots.join(snap_name),
                &original_note,
                WriteOpts::default(),
            )
            .await
            .unwrap();

            let state = VaultRuntimeState::default();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            // Agent-memory + personality seed (myne-md/myne#697): the abort
            // must restore these families byte-identical, or the live MYN5 /
            // MYX5 / MYZ5 files strand under the restored v0.1 meta and the
            // only surviving v0.1 copies die with legacy/.
            let seeded = seed_v0_1_singletons(&io, &vault_root).await;
            let original_memory_catalog = io
                .read(&vault_root.join("vault.agent-memory"))
                .await
                .unwrap();
            let original_memory_entry = io
                .read(
                    &vault_root
                        .join("memories")
                        .join(&seeded.memory_entry_id_hex),
                )
                .await
                .unwrap();
            let original_personality = io
                .read(&vault_root.join("vault.personality"))
                .await
                .unwrap();
            vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io)
                .await
                .expect("migration succeeds");

            // #435: the snapshot moved into legacy/ rather than being left as
            // undecryptable ciphertext in the vault root.
            assert!(
                io.read(&snapshots.join(snap_name)).await.is_err(),
                "snapshots/ must not survive the re-key as orphan ciphertext"
            );
            assert!(
                io.read(&vault_root.join("legacy/snapshots").join(snap_name))
                    .await
                    .is_ok(),
                "the snapshot must be preserved under legacy/"
            );

            // ABORT → the v0.1 vault is back, byte for byte.
            vault_migrate_abort_from_host(&host, &state, &hooks, &io)
                .await
                .expect("abort succeeds pre-sync");
            assert_eq!(
                io.read(&vault_root.join("vault.meta")).await.unwrap(),
                original_meta,
                "vault.meta must be the original bytes"
            );
            assert_eq!(
                io.read(&note_path).await.unwrap(),
                original_note,
                "the note must be the original MY01 bytes"
            );
            assert_eq!(
                io.read(&snapshots.join(snap_name)).await.unwrap(),
                original_note,
                "the snapshot must come back too"
            );
            assert_eq!(
                io.read(&vault_root.join("vault.agent-memory"))
                    .await
                    .unwrap(),
                original_memory_catalog,
                "the memory catalog must come back as the original MYN1 bytes"
            );
            assert_eq!(
                io.read(
                    &vault_root
                        .join("memories")
                        .join(&seeded.memory_entry_id_hex)
                )
                .await
                .unwrap(),
                original_memory_entry,
                "the memory entry must come back as the original MYX1 bytes"
            );
            assert_eq!(
                io.read(&vault_root.join("vault.personality"))
                    .await
                    .unwrap(),
                original_personality,
                "the personality must come back as the original MYZ1 bytes"
            );
            assert!(
                io.read(&vault_root.join("legacy/vault.meta"))
                    .await
                    .is_err(),
                "a completed abort leaves no legacy/ behind"
            );

            // Migrate again, then CONFIRM → the old root_key is gone.
            vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io)
                .await
                .expect("re-migration succeeds");
            assert!(
                io.read(&vault_root.join("legacy/vault.meta")).await.is_ok(),
                "the staged old meta is what confirm has to erase"
            );
            vault_migrate_confirm_from_host(&host, &state, &io)
                .await
                .expect("confirm succeeds");
            assert!(
                io.read(&vault_root.join("legacy/vault.meta"))
                    .await
                    .is_err(),
                "confirm must erase the old root_key's only remaining wrapper"
            );
            assert!(
                io.read(
                    &vault_root
                        .join("legacy/notes")
                        .join(format!("{}.myn", uuid::Uuid::from_bytes(u)))
                )
                .await
                .is_err(),
                "confirm must erase every staged blob, not just the meta"
            );

            // Both are idempotent-safe: with nothing staged they refuse rather
            // than half-acting on a vault that is already settled.
            assert_eq!(
                vault_migrate_confirm_from_host(&host, &state, &io).await,
                Err(MigrationSettleError::NothingToSettle)
            );
            assert_eq!(
                vault_migrate_abort_from_host(&host, &state, &hooks, &io).await,
                Err(MigrationSettleError::NothingToSettle)
            );
        })
    }

    #[test]
    fn empty_vault_migrates_to_just_the_ntv5_meta() {
        let _host = TestHost::new("/base");
        let out = migrate_keys_and_notes(
            &OLD_ITEMS,
            &OLD_ITEMS_ID,
            PASSWORD,
            PHRASE,
            &ACCT,
            &fast_params(),
            &[],
            ACTOR,
            0,
        )
        .expect("migrate empty");
        assert_eq!(&out.ntv5_meta[0..4], b"NTV5");
        assert!(out.notes.is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The re-key legs BEYOND the notes: themes (`MYT1`→`MYT5`), prefs
    // (`MYP1`→`MYP5`) and the whole attachment family (`vault.attachments`
    // `MYC1`→`MYC5` plus every `attachments/<id>` `MYA1`→`MYA5`).
    //
    // Until these landed, the only on-disk migration test seeded a
    // `vault.dictionary` and asserted `singletons_migrated == 1` — one row of the
    // two-row KEK table, and neither of the two families that carry their own
    // framing. So the themes row's role/magic/aad wiring, the hand-rolled prefs
    // leg and the ENTIRE attachment leg were unexecuted, while the attachment
    // leg's own source comment states the stake: "Without this leg a migrated
    // vault's attachments read as gone."
    //
    // The failure that shape produces is silent AND unrecoverable in place: a
    // wrong AAD role or a wrong KEK generation is self-consistent inside the
    // migration (it writes and would read back its own mistake), and only the
    // production reader — which derives version-aware off `vault.meta` — finds
    // out. `read_catalog` and §9.21.4 both fall back to EMPTY on a decode
    // failure, so the user sees "no attachments" and "no themes" rather than an
    // error. Hence the two-layer coverage below: the byte-level test pins the
    // families the migration writes, and the end-to-end one re-unlocks the
    // migrated vault and reads all three back through the production surfaces.
    // ─────────────────────────────────────────────────────────────────────────

    /// Theme name seeded into the pre-migration `vault.themes`.
    const THEME_NAME: &str = "Copper Dusk";
    /// One attachment's file bytes — asserted byte-identical after the re-key.
    const ATTACHMENT_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nnot really a PNG, but byte-exact";
    /// The live attachment's catalog `content_type` (bound into the inner AAD).
    const CONTENT_TYPE: &str = "image/png";
    /// The deleted attachment's pre-tombstone bytes.
    const DELETED_BYTES: &[u8] = b"the file behind the tombstone";
    /// Wall-clock stand-in for the seeded catalog / themes entries.
    const T0: u64 = 1_700_000_000;

    /// A palette whose one token survives the read-side `vetted` filter, so an
    /// end-to-end assertion can check the VALUE came through and not only the name.
    fn a_palette() -> crate::plugins::themes::commands::ThemePalette {
        let mut palette = crate::plugins::themes::commands::ThemePalette::new();
        palette.insert("--accent".to_string(), "#8a5a2b".to_string());
        palette
    }

    /// Prefs whose values are all NON-default, so "the migration reset the
    /// settings" cannot pass as "the migration preserved them".
    fn a_prefs_view() -> protocol::PrefsView {
        protocol::PrefsView {
            screen_capture_protection: false, // default true
            developer_mode: true,             // default false
            auto_lock_seconds: Some(900),     // default None
            ..Default::default()
        }
    }

    /// What [`seed_v0_1_singletons`] put on disk, for the assertions to compare against.
    struct SeededV0_1 {
        /// The exact inner plaintext the `MYT1` blob wrapped.
        themes_plaintext: Vec<u8>,
        /// The `PrefsView` the `MYP1` blob carried.
        prefs: protocol::PrefsView,
        /// The `MYC1` catalog, live entry + tombstone.
        catalog: protocol::AttachmentsCatalog,
        /// The live attachment's content-addressed id (stable across the re-key).
        live_id: [u8; protocol::ATTACHMENT_ID_LEN],
        /// …and its lowercase-hex form, which is the on-disk filename.
        live_id_hex: String,
        /// The tombstoned entry's id-hex; its blob file is still on disk (a torn
        /// delete), which is what makes the tombstone SKIP falsifiable.
        tomb_id_hex: String,
        /// That leftover blob's exact bytes.
        tomb_blob: Vec<u8>,
        /// The `MYM1` chats catalog: one live conversation row.
        chats_catalog: crate::plugins::chats::commands::ChatsCatalogMap,
        /// The live conversation's client-minted id (stable across the re-key:
        /// conversation sync-ids are the ids themselves, not derivations).
        chats_conv_id: [u8; 16],
        /// …and its lowercase-hex form, which is the `chats/` filename.
        chats_conv_id_hex: String,
        /// The exact turn-list payload the `MYJ1` file wrapped.
        chats_turns_payload: Vec<u8>,
        /// The `MYN1` memory catalog: one live row (myne-md/myne#697).
        memory_catalog_plaintext: Vec<u8>,
        /// The live memory entry's client-minted id (stable across the re-key).
        memory_entry_id: [u8; 16],
        /// …and its lowercase-hex form, which is the `memories/` filename.
        memory_entry_id_hex: String,
        /// The exact entry plaintext the `MYX1` file wrapped.
        memory_entry_plaintext: Vec<u8>,
        /// The exact directives JSON the `MYZ1` file wrapped.
        personality_plaintext: Vec<u8>,
    }

    /// Seed the v0.1 shape of every family the note pass does not touch:
    /// `vault.themes` (`MYT1`), `vault.prefs` (`MYP1`), `vault.dictionary`
    /// (`MYD1`), `vault.attachments` (`MYC1`) and two `attachments/<id>` blobs
    /// (`MYA1`, one live and one behind a tombstone) plus the AI conversations
    /// pair: `vault.chats` (`MYM1`) with one live row and one `chats/<id>`
    /// file (`MYJ1`) (myne-md/myne#675).
    async fn seed_v0_1_singletons(io: &StdVaultIo, vault_root: &Path) -> SeededV0_1 {
        use crate::plugins::attachments::commands::hex_encode;
        use crate::plugins::chats::commands::{ChatsCatalogMap, ConversationEntry};
        use crate::plugins::themes::commands::{encode_themes_map, ThemeEntry, ThemesMap};
        use protocol::{
            compute_attachment_id, decode_themes_blob, encode_attachment_blob,
            encode_attachments_catalog, encode_chats_blob, encode_chats_catalog_blob,
            encode_prefs_blob, AttachmentMeta, AttachmentsCatalog,
        };

        // vault.themes (MYT1) under the OLD CustomThemesKey.
        let mut map = ThemesMap::new();
        map.insert(THEME_NAME.to_string(), ThemeEntry::live(a_palette(), T0));
        let old_themes_kek = derive_subkey(&OLD_ROOT, SubkeyRole::CustomThemesKey);
        let themes_blob =
            encode_themes_map(MetaVersion::V0_1, &old_themes_kek, &ACCT, &map).expect("seed MYT1");
        io.write(
            &vault_root.join("vault.themes"),
            &themes_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();
        let themes_plaintext = decode_themes_blob(&old_themes_kek, &ACCT, &themes_blob)
            .expect("the seed decodes under the old KEK")
            .to_vec();

        // vault.dictionary (MYD1) — the one family the pre-existing test drove;
        // seeded here so the singleton COUNT below is over the full roster.
        let old_dict_kek = derive_subkey(&OLD_ROOT, SubkeyRole::PersonalDictKey);
        let dict_blob =
            protocol::encode_dictionary_blob(&old_dict_kek, &ACCT, b"opaque dict bytes")
                .expect("seed MYD1");
        io.write(
            &vault_root.join("vault.dictionary"),
            &dict_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();

        // vault.prefs (MYP1) under the OLD PrefsKey.
        let old_prefs_kek = derive_subkey(&OLD_ROOT, SubkeyRole::PrefsKey);
        let prefs = a_prefs_view();
        let prefs_blob = encode_prefs_blob(&old_prefs_kek, &ACCT, &prefs).expect("seed MYP1");
        io.write(
            &vault_root.join("vault.prefs"),
            &prefs_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();

        // Two MYA1 attachment blobs under the OLD itemsKey, at their
        // content-addressed ids (the filenames the catalog keys resolve to).
        let att_dir = vault_root.join("attachments");
        io.create_dir_all(&att_dir).await.unwrap();
        let live_id = compute_attachment_id(&OLD_ROOT, ATTACHMENT_BYTES);
        let live_id_hex = hex_encode(&live_id);
        let live_blob = encode_attachment_blob(
            &OLD_ITEMS,
            &OLD_ITEMS_ID,
            &live_id,
            CONTENT_TYPE.as_bytes(),
            ATTACHMENT_BYTES,
        )
        .expect("seed live MYA1");
        io.write(
            &att_dir.join(&live_id_hex),
            &live_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();

        let tomb_id = compute_attachment_id(&OLD_ROOT, DELETED_BYTES);
        let tomb_id_hex = hex_encode(&tomb_id);
        let tomb_blob = encode_attachment_blob(
            &OLD_ITEMS,
            &OLD_ITEMS_ID,
            &tomb_id,
            b"text/plain",
            DELETED_BYTES,
        )
        .expect("seed tombstoned MYA1");
        io.write(
            &att_dir.join(&tomb_id_hex),
            &tomb_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();

        // vault.attachments (MYC1) under the OLD AttachmentsCatalogKey: one live
        // entry, one tombstone.
        let mut catalog = AttachmentsCatalog::empty();
        catalog.entries.insert(
            live_id_hex.clone(),
            AttachmentMeta::live(
                CONTENT_TYPE.to_string(),
                T0,
                "shot.png".to_string(),
                ATTACHMENT_BYTES.len() as u64,
            ),
        );
        catalog.entries.insert(
            tomb_id_hex.clone(),
            AttachmentMeta::live(
                "text/plain".to_string(),
                T0,
                "gone.txt".to_string(),
                DELETED_BYTES.len() as u64,
            )
            .into_tombstone(T0 + 100),
        );
        let old_catalog_kek = derive_subkey(&OLD_ROOT, SubkeyRole::AttachmentsCatalogKey);
        let catalog_blob =
            encode_attachments_catalog(&old_catalog_kek, &ACCT, &catalog).expect("seed MYC1");
        io.write(
            &vault_root.join("vault.attachments"),
            &catalog_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();

        // vault.chats (MYM1) under the OLD ChatsCatalogKey: one live row.
        // chats/<id-hex> (MYJ1) under the OLD ChatsKey: its turn list.
        let chats_conv_id = [0xC0u8; 16];
        let chats_conv_id_hex = hex_encode(&chats_conv_id[..]);
        let mut chats_map = ChatsCatalogMap::new();
        chats_map.insert(
            chats_conv_id_hex.clone(),
            ConversationEntry {
                created_at: 1_000,
                deleted_at: None,
                folder: None,
                title: "migrate me".to_string(),
                updated_at: 2_000,
                version: 2,
                note_id: None,
            },
        );
        let old_chats_catalog_kek = derive_subkey(&OLD_ROOT, SubkeyRole::ChatsCatalogKey);
        let chats_catalog_plaintext = serde_json::to_vec(&chats_map).expect("seed roster JSON");
        let chats_catalog_blob =
            encode_chats_catalog_blob(&old_chats_catalog_kek, &ACCT, &chats_catalog_plaintext)
                .expect("seed MYM1");
        io.write(
            &vault_root.join("vault.chats"),
            &chats_catalog_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();
        let chats_turns_payload =
            br#"{"turns":[{"id":"m1-1","kind":"text","role":"user","text":"migrate this chat"}]}"#
                .to_vec();
        let old_chats_key = derive_subkey(&OLD_ROOT, SubkeyRole::ChatsKey);
        let chats_file_blob =
            encode_chats_blob(&old_chats_key, &ACCT, &chats_conv_id, &chats_turns_payload)
                .expect("seed MYJ1");
        io.create_dir_all(&vault_root.join("chats")).await.unwrap();
        io.write(
            &vault_root.join("chats").join(&chats_conv_id_hex),
            &chats_file_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();

        // vault.agent-memory (MYN1) under the OLD AgentMemoryCatalogKey: one
        // live row. memories/<id-hex> (MYX1) under the OLD AgentMemoryKey:
        // its distilled text. vault.personality (MYZ1) under the OLD
        // AgentPersonalityKey (myne-md/myne#697).
        let memory_entry_id = [0xD0u8; 16];
        let memory_entry_id_hex = hex_encode(&memory_entry_id[..]);
        let memory_catalog_plaintext =
            br#"{"0184a2b3c4d5e6f708192a3b4c5d6e7f":{"created_at":1725417600000,"updated_at":1725417600000,"version":3}}"#
                .to_vec();
        let old_memory_catalog_kek = derive_subkey(&OLD_ROOT, SubkeyRole::AgentMemoryCatalogKey);
        let memory_catalog_blob = protocol::encode_agent_memory_catalog_blob(
            &old_memory_catalog_kek,
            &ACCT,
            &memory_catalog_plaintext,
        )
        .expect("seed MYN1");
        io.write(
            &vault_root.join("vault.agent-memory"),
            &memory_catalog_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();
        let memory_entry_plaintext = br#"{"text":"The user prefers concise answers."}"#.to_vec();
        let old_memory_key = derive_subkey(&OLD_ROOT, SubkeyRole::AgentMemoryKey);
        let memory_file_blob = protocol::encode_agent_memory_blob(
            &old_memory_key,
            &ACCT,
            &memory_entry_id,
            &memory_entry_plaintext,
        )
        .expect("seed MYX1");
        io.create_dir_all(&vault_root.join("memories"))
            .await
            .unwrap();
        io.write(
            &vault_root.join("memories").join(&memory_entry_id_hex),
            &memory_file_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();
        let personality_plaintext =
            br#"{"directives":[{"text":"Keep answers short.","updated_at":1725417600000}]}"#
                .to_vec();
        let old_personality_kek = derive_subkey(&OLD_ROOT, SubkeyRole::AgentPersonalityKey);
        let personality_blob = protocol::encode_agent_personality_blob(
            &old_personality_kek,
            &ACCT,
            &personality_plaintext,
        )
        .expect("seed MYZ1");
        io.write(
            &vault_root.join("vault.personality"),
            &personality_blob,
            WriteOpts::default(),
        )
        .await
        .unwrap();

        SeededV0_1 {
            themes_plaintext,
            prefs,
            catalog,
            live_id,
            live_id_hex,
            tomb_id_hex,
            tomb_blob,
            chats_catalog: chats_map,
            chats_conv_id,
            chats_conv_id_hex,
            chats_turns_payload,
            memory_catalog_plaintext,
            memory_entry_id,
            memory_entry_id_hex,
            memory_entry_plaintext,
            personality_plaintext,
        }
    }

    /// The v0.2 key material a migrated vault's `NTV5` meta hands back — what
    /// every post-migration reader derives, so the assertions derive it the same
    /// way rather than trusting a value the migration returned.
    async fn v0_2_material_from_disk(
        io: &StdVaultIo,
        vault_root: &Path,
    ) -> (Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>, [u8; 16]) {
        let meta_bytes = io.read(&vault_root.join("vault.meta")).await.unwrap();
        assert_eq!(
            &meta_bytes[0..4],
            b"NTV5",
            "the migration must have committed"
        );
        let meta = parse_vault_meta_v0_2(&meta_bytes).expect("NTV5 parse");
        let root = unlock_root_key_v0_2_password(&meta, PASSWORD, &ACCT).expect("pw unlock");
        let items = derive_items_key_v0_2(&root, &meta).expect("items derive");
        (root, items, meta.items_key_id)
    }

    /// Every non-note family the migration re-keys, asserted at the byte level:
    /// the family magic it lands in, the KEK generation it is readable under, and
    /// the original preserved in `legacy/`.
    ///
    /// Each leg is separately falsifiable — swap one v0.2 role string, drop one
    /// re-seal, or remove the tombstone skip, and exactly one assertion here goes
    /// red while every other migration test stays green.
    #[test]
    fn migration_rekeys_themes_prefs_and_the_attachment_family_to_v0_2() {
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-families").unwrap();
            let vault_root = tmp.path().to_path_buf();
            let notes_dir = vault_root.join("notes");
            let io = StdVaultIo;
            io.create_dir_all(&notes_dir).await.unwrap();
            io.write(
                &vault_root.join("vault.meta"),
                b"MYV1 old vault meta bytes (opaque to the migration)",
                WriteOpts::default(),
            )
            .await
            .unwrap();
            let u = *crate::plugins::notes::note_id::NoteId::new_v7()
                .as_uuid()
                .as_bytes();
            io.write(
                &notes_dir.join(format!("{}.myn", uuid::Uuid::from_bytes(u))),
                &my01(&u, "# note\n"),
                WriteOpts::default(),
            )
            .await
            .unwrap();
            let seeded = seed_v0_1_singletons(&io, &vault_root).await;

            let summary = migrate_vault_notes_on_disk(
                &io,
                &vault_root,
                &notes_dir,
                &OLD_ROOT,
                &OLD_ITEMS,
                &OLD_ITEMS_ID,
                PASSWORD,
                PHRASE,
                &ACCT,
                &fast_params(),
                ACTOR,
                &TestHost::new("/base"),
            )
            .await
            .expect("on-disk migration");

            // FIVE families were re-sealed: themes + dictionary + chats catalog
            // (the KEK table), prefs (hand-rolled) and the attachments catalog.
            // A dropped leg shows up here before any of the per-family
            // assertions below.
            assert_eq!(
                summary.singletons_migrated, 7,
                "themes + dictionary + chats-catalog + memory-catalog + personality + prefs + attachments-catalog"
            );

            let (new_root, new_items, new_items_key_id) =
                v0_2_material_from_disk(&io, &vault_root).await;

            // ── vault.themes: MYT5 under derive_subkey_v0_2(new_root, CustomThemesKey)
            let old_themes_kek = derive_subkey(&OLD_ROOT, SubkeyRole::CustomThemesKey);
            let new_themes_kek = derive_subkey_v0_2(&new_root, SubkeyRole::CustomThemesKey);
            let themes = io.read(&vault_root.join("vault.themes")).await.unwrap();
            assert_eq!(
                &themes[0..4],
                b"MYT5",
                "themes must land in the v0.2 family"
            );
            let decoded = protocol::decode_themes_blob(&new_themes_kek, &ACCT, &themes)
                .expect("MYT5 decodes under the v0.2 themes KEK");
            assert_eq!(
                decoded.as_slice(),
                seeded.themes_plaintext.as_slice(),
                "the theme store survived the re-key byte-exact"
            );
            assert!(
                protocol::decode_themes_blob(&old_themes_kek, &ACCT, &themes).is_err(),
                "the re-key is real: the OLD themes KEK must no longer open it"
            );
            let legacy_themes = io
                .read(&vault_root.join("legacy/vault.themes"))
                .await
                .unwrap();
            assert_eq!(&legacy_themes[0..4], b"MYT1");
            assert!(
                protocol::decode_themes_blob(&old_themes_kek, &ACCT, &legacy_themes).is_ok(),
                "legacy/ preserves the original openable MYT1 themes blob"
            );

            // ── vault.chats: MYM5 under derive_subkey_v0_2(new_root, ChatsCatalogKey)
            // (myne-md/myne#675). The catalog re-seals through the KEK table;
            // the causal versions survive, so the merge clock is not reset.
            let new_chats_catalog_kek = derive_subkey_v0_2(&new_root, SubkeyRole::ChatsCatalogKey);
            let chats_catalog = io.read(&vault_root.join("vault.chats")).await.unwrap();
            assert_eq!(
                &chats_catalog[0..4],
                b"MYM5",
                "chats catalog must land in the v0.2 family"
            );
            let catalog_plaintext = protocol::decode_chats_catalog_blob_versioned(
                protocol::MetaVersion::V0_2,
                &new_chats_catalog_kek,
                &ACCT,
                &chats_catalog,
            )
            .expect("MYM5 decodes under the v0.2 catalog KEK");
            let catalog_map: crate::plugins::chats::commands::ChatsCatalogMap =
                serde_json::from_slice(&catalog_plaintext).expect("catalog JSON parses");
            let row = &catalog_map[&seeded.chats_conv_id_hex];
            assert_eq!(row.title, "migrate me");
            assert_eq!(row.version, 2, "the causal version survives the re-key");
            assert!(row.deleted_at.is_none());
            assert_eq!(
                catalog_map, seeded.chats_catalog,
                "the roster survives the re-key entry-for-entry"
            );
            let legacy_catalog = io
                .read(&vault_root.join("legacy/vault.chats"))
                .await
                .unwrap();
            assert_eq!(&legacy_catalog[0..4], b"MYM1");

            // ── chats/<id>: MYJ5 under derive_subkey_v0_2(new_root, ChatsKey).
            // Each conversation file re-seals independently (stage-first,
            // skip-dead); the turn list passes through opaquely.
            let new_chats_key = derive_subkey_v0_2(&new_root, SubkeyRole::ChatsKey);
            let conv_path = vault_root.join("chats").join(&seeded.chats_conv_id_hex);
            let conv_blob = io.read(&conv_path).await.unwrap();
            assert_eq!(
                &conv_blob[0..4],
                b"MYJ5",
                "conversation file must land in the v0.2 family"
            );
            let conv_plaintext = protocol::decode_chats_blob_v0_2(
                &new_chats_key,
                &ACCT,
                &seeded.chats_conv_id,
                &conv_blob,
            )
            .expect("MYJ5 decodes under the v0.2 chats KEK");
            assert_eq!(
                conv_plaintext.as_slice(),
                seeded.chats_turns_payload.as_slice(),
                "the turn list survived the re-key byte-exact"
            );
            let legacy_conv = io
                .read(
                    &vault_root
                        .join("legacy/chats")
                        .join(&seeded.chats_conv_id_hex),
                )
                .await
                .unwrap();
            assert_eq!(&legacy_conv[0..4], b"MYJ1");

            // ── vault.agent-memory: MYN5 under derive_subkey_v0_2(new_root,
            // AgentMemoryCatalogKey) (myne-md/myne#697). The roster passes
            // through opaquely; the causal version survives.
            let new_memory_catalog_kek =
                derive_subkey_v0_2(&new_root, SubkeyRole::AgentMemoryCatalogKey);
            let memory_catalog = io
                .read(&vault_root.join("vault.agent-memory"))
                .await
                .unwrap();
            assert_eq!(
                &memory_catalog[0..4],
                b"MYN5",
                "memory catalog must land in the v0.2 family"
            );
            let memory_roster_plaintext = protocol::decode_agent_memory_catalog_blob_versioned(
                protocol::MetaVersion::V0_2,
                &new_memory_catalog_kek,
                &ACCT,
                &memory_catalog,
            )
            .expect("MYN5 decodes under the v0.2 memory-catalog KEK");
            assert_eq!(
                memory_roster_plaintext.as_slice(),
                seeded.memory_catalog_plaintext.as_slice(),
                "the memory roster survived the re-key byte-exact"
            );
            let legacy_memory_catalog = io
                .read(&vault_root.join("legacy/vault.agent-memory"))
                .await
                .unwrap();
            assert_eq!(&legacy_memory_catalog[0..4], b"MYN1");

            // ── memories/<id>: MYX5 under derive_subkey_v0_2(new_root,
            // AgentMemoryKey). Stage-first, skip-dead; the distilled text
            // passes through opaquely.
            let new_memory_key = derive_subkey_v0_2(&new_root, SubkeyRole::AgentMemoryKey);
            let mem_path = vault_root
                .join("memories")
                .join(&seeded.memory_entry_id_hex);
            let mem_blob = io.read(&mem_path).await.unwrap();
            assert_eq!(
                &mem_blob[0..4],
                b"MYX5",
                "memory entry must land in the v0.2 family"
            );
            let mem_plaintext = protocol::decode_agent_memory_blob_versioned(
                protocol::MetaVersion::V0_2,
                &new_memory_key,
                &ACCT,
                &seeded.memory_entry_id,
                &mem_blob,
            )
            .expect("MYX5 decodes under the v0.2 memory KEK");
            assert_eq!(
                mem_plaintext.as_slice(),
                seeded.memory_entry_plaintext.as_slice(),
                "the entry text survived the re-key byte-exact"
            );
            let legacy_mem = io
                .read(
                    &vault_root
                        .join("legacy/memories")
                        .join(&seeded.memory_entry_id_hex),
                )
                .await
                .unwrap();
            assert_eq!(&legacy_mem[0..4], b"MYX1");

            // ── vault.personality: MYZ5 under derive_subkey_v0_2(new_root,
            // AgentPersonalityKey). Whole-value singleton; the directives pass
            // through opaquely.
            let new_personality_kek =
                derive_subkey_v0_2(&new_root, SubkeyRole::AgentPersonalityKey);
            let personality = io
                .read(&vault_root.join("vault.personality"))
                .await
                .unwrap();
            assert_eq!(
                &personality[0..4],
                b"MYZ5",
                "personality must land in the v0.2 family"
            );
            let personality_plaintext = protocol::decode_agent_personality_blob_versioned(
                protocol::MetaVersion::V0_2,
                &new_personality_kek,
                &ACCT,
                &personality,
            )
            .expect("MYZ5 decodes under the v0.2 personality KEK");
            assert_eq!(
                personality_plaintext.as_slice(),
                seeded.personality_plaintext.as_slice(),
                "the directives survived the re-key byte-exact"
            );
            let legacy_personality = io
                .read(&vault_root.join("legacy/vault.personality"))
                .await
                .unwrap();
            assert_eq!(&legacy_personality[0..4], b"MYZ1");

            // ── vault.prefs: MYP5 under derive_subkey_v0_2(new_root, PrefsKey)
            let old_prefs_kek = derive_subkey(&OLD_ROOT, SubkeyRole::PrefsKey);
            let new_prefs_kek = derive_subkey_v0_2(&new_root, SubkeyRole::PrefsKey);
            let prefs_bytes = io.read(&vault_root.join("vault.prefs")).await.unwrap();
            assert_eq!(
                &prefs_bytes[0..4],
                b"MYP5",
                "prefs must land in the v0.2 family"
            );
            let prefs = decode_prefs_blob(&new_prefs_kek, &ACCT, &prefs_bytes)
                .expect("MYP5 decodes under the v0.2 prefs KEK");
            assert_eq!(
                prefs, seeded.prefs,
                "every setting survived the re-key (a reset would read as defaults)"
            );
            let legacy_prefs = io
                .read(&vault_root.join("legacy/vault.prefs"))
                .await
                .unwrap();
            assert_eq!(&legacy_prefs[0..4], b"MYP1");
            assert!(
                decode_prefs_blob(&old_prefs_kek, &ACCT, &legacy_prefs).is_ok(),
                "legacy/ preserves the original openable MYP1 prefs blob"
            );

            // ── vault.attachments: MYC5 under derive_subkey_v0_2(new_root, …Catalog…)
            let old_catalog_kek = derive_subkey(&OLD_ROOT, SubkeyRole::AttachmentsCatalogKey);
            let new_catalog_kek = derive_subkey_v0_2(&new_root, SubkeyRole::AttachmentsCatalogKey);
            let catalog_bytes = io
                .read(&vault_root.join("vault.attachments"))
                .await
                .unwrap();
            assert_eq!(
                &catalog_bytes[0..4],
                b"MYC5",
                "the catalog must land in the v0.2 family"
            );
            let catalog = decode_attachments_catalog(&new_catalog_kek, &ACCT, &catalog_bytes)
                .expect("MYC5 decodes under the v0.2 catalog KEK");
            assert_eq!(
                catalog, seeded.catalog,
                "the entry set — live AND tombstone — is carried unchanged"
            );
            let legacy_catalog = io
                .read(&vault_root.join("legacy/vault.attachments"))
                .await
                .unwrap();
            assert_eq!(&legacy_catalog[0..4], b"MYC1");
            assert!(
                decode_attachments_catalog(&old_catalog_kek, &ACCT, &legacy_catalog).is_ok(),
                "legacy/ preserves the original openable MYC1 catalog"
            );

            // ── attachments/<id>: MYA5 under the NEW itemsKey, at the SAME id
            let live_path = vault_root.join("attachments").join(&seeded.live_id_hex);
            let live = io.read(&live_path).await.unwrap();
            assert_eq!(
                &live[0..4],
                protocol::ATTACHMENT_BLOB_V0_2_MAGIC.as_slice(),
                "the blob must land in the v0.2 family at its ORIGINAL filename"
            );
            let file = protocol::decode_attachment_blob(
                &live,
                &seeded.live_id,
                CONTENT_TYPE.as_bytes(),
                &new_items,
                &new_items_key_id,
            )
            .expect("MYA5 decodes under the NEW itemsKey");
            assert_eq!(
                file.as_slice(),
                ATTACHMENT_BYTES,
                "the file bytes survived the re-key exactly"
            );
            assert!(
                protocol::decode_attachment_blob(
                    &live,
                    &seeded.live_id,
                    CONTENT_TYPE.as_bytes(),
                    &OLD_ITEMS,
                    &OLD_ITEMS_ID,
                )
                .is_err(),
                "the re-key is real: the OLD itemsKey must no longer open the blob"
            );
            let legacy_live = io
                .read(
                    &vault_root
                        .join("legacy/attachments")
                        .join(&seeded.live_id_hex),
                )
                .await
                .unwrap();
            assert_eq!(
                &legacy_live[0..4],
                protocol::ATTACHMENT_BLOB_MAGIC.as_slice(),
                "legacy/ holds the original MYA1"
            );
            assert!(
                protocol::decode_attachment_blob(
                    &legacy_live,
                    &seeded.live_id,
                    CONTENT_TYPE.as_bytes(),
                    &OLD_ITEMS,
                    &OLD_ITEMS_ID,
                )
                .is_ok(),
                "the legacy copy still opens under the old itemsKey"
            );

            // ── the tombstone produced NO blob work.
            //
            // Its blob file is still on disk (the torn-delete shape), so this is
            // falsifiable rather than vacuous: drop the `is_tombstone()` skip and
            // these bytes become MYA5 and get staged to legacy/.
            let tomb_path = vault_root.join("attachments").join(&seeded.tomb_id_hex);
            assert_eq!(
                io.read(&tomb_path).await.unwrap(),
                seeded.tomb_blob,
                "a tombstoned entry's leftover blob is not re-sealed"
            );
            assert!(
                io.read(
                    &vault_root
                        .join("legacy/attachments")
                        .join(&seeded.tomb_id_hex)
                )
                .await
                .is_err(),
                "and it is not staged either — the tombstone skip runs before both"
            );
        })
    }

    /// The user-visible half of the same property: migrate a real `MYV1` vault,
    /// re-unlock it, and read the themes, the settings and the attachment back
    /// through the PRODUCTION surfaces.
    ///
    /// This is the assertion the byte-level test cannot make. Every reader here
    /// derives its KEK version-aware off `vault.meta`, and every one of them
    /// falls back to EMPTY / DEFAULT on a decode failure (§9.21.4, §9.5.5,
    /// `read_catalog`) — so a migration that seals a family under the wrong
    /// generation produces no error anywhere, just a vault whose themes,
    /// settings and attachments are quietly gone.
    #[test]
    fn a_migrated_vault_still_serves_its_themes_prefs_and_attachments_after_re_unlock() {
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-e2e-families").unwrap();
            let host = TestHost::new(tmp.path());
            let io = StdVaultIo;
            let vault_root = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            let notes_dir = vault_root.join("notes");
            io.create_dir_all(&notes_dir).await.unwrap();
            build_myv1_vault(&io, &vault_root).await;
            let u = *crate::plugins::notes::note_id::NoteId::new_v7()
                .as_uuid()
                .as_bytes();
            io.write(
                &notes_dir.join(format!("{}.myn", uuid::Uuid::from_bytes(u))),
                &my01(&u, "# note\n"),
                WriteOpts::default(),
            )
            .await
            .unwrap();
            let seeded = seed_v0_1_singletons(&io, &vault_root).await;

            let state = VaultRuntimeState::default();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            vault_migrate_from_host(&host, &state, &hooks, PASSWORD, PHRASE, &io)
                .await
                .expect("migration succeeds");

            // The migration locks the slot (a re-key is a re-unlock event), so the
            // readers below run against a vault opened exactly the way the user's
            // next launch opens it.
            crate::plugins::vault_unlock::commands::unlock_with_path(
                PASSWORD.to_string(),
                None,
                &vault_root.join("vault.meta"),
                &state,
                &io,
                &host,
            )
            .await
            .expect("the migrated NTV5 vault unlocks");

            // Themes — through the picker's own surface.
            let themes =
                crate::plugins::themes::commands::themes_list_with_dir(&io, &vault_root, &state)
                    .await
                    .expect("themes list");
            let names: Vec<&str> = themes.iter().map(|t| t.name.as_str()).collect();
            assert_eq!(
                names,
                vec![THEME_NAME],
                "the custom theme is still in the store after the migration"
            );
            assert_eq!(
                themes[0].palette.get("--accent").map(String::as_str),
                Some("#8a5a2b"),
                "…and its palette came through, not just its name"
            );

            // Prefs — through the settings reader.
            let prefs =
                crate::plugins::prefs::commands::prefs_read_with_dir(&vault_root, &state, &io)
                    .await
                    .expect("prefs read");
            assert_eq!(
                prefs,
                a_prefs_view(),
                "the settings survived; §9.5.5 would have degraded them to defaults"
            );

            // Attachments — through the serve path the WebView actually calls.
            let served = crate::plugins::attachments::commands::attachment_serve_with_dir(
                &io,
                &vault_root,
                &state,
                &seeded.live_id_hex,
            )
            .await
            .expect("the migrated attachment still serves");
            assert_eq!(
                served.bytes.as_slice(),
                ATTACHMENT_BYTES,
                "the attachment's bytes are byte-identical after the re-key"
            );

            // The tombstoned entry stays deleted — the re-key did not resurrect it.
            match crate::plugins::attachments::commands::attachment_serve_with_dir(
                &io,
                &vault_root,
                &state,
                &seeded.tomb_id_hex,
            )
            .await
            {
                Err(crate::plugins::attachments::error::AttachmentServeError::NotFound) => {}
                other => panic!("a tombstoned attachment must stay deleted, got {other:?}"),
            }
        })
    }

    /// An undecodable `vault.attachments` does NOT abort the migration (unlike a
    /// KEK-envelope singleton, which is fail-closed pre-flighted) — it stages the
    /// whole `attachments/` subtree to `legacy/` and leaves the blobs un-re-keyed.
    ///
    /// The ids cannot be enumerated without the catalog, so there is nothing to
    /// re-seal; what this pins is that the "every original is in legacy/"
    /// guarantee still holds when the catalog itself is the corrupt thing. Post
    /// migration those attachments read as gone, and `legacy/` is the recovery.
    #[test]
    fn an_undecodable_attachments_catalog_stages_the_whole_subtree_to_legacy() {
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-bad-catalog").unwrap();
            let vault_root = tmp.path().to_path_buf();
            let notes_dir = vault_root.join("notes");
            let io = StdVaultIo;
            io.create_dir_all(&notes_dir).await.unwrap();
            io.write(
                &vault_root.join("vault.meta"),
                b"MYV1 old vault meta bytes (opaque to the migration)",
                WriteOpts::default(),
            )
            .await
            .unwrap();
            let seeded = seed_v0_1_singletons(&io, &vault_root).await;

            // Overwrite the catalog with right-magic, won't-open bytes — the shape
            // a torn write or a bit-flip leaves behind.
            let mut junk = protocol::CATALOG_BLOB_MAGIC.to_vec();
            junk.extend_from_slice(&[0xAB; 96]);
            io.write(
                &vault_root.join("vault.attachments"),
                &junk,
                WriteOpts::default(),
            )
            .await
            .unwrap();

            let summary = migrate_vault_notes_on_disk(
                &io,
                &vault_root,
                &notes_dir,
                &OLD_ROOT,
                &OLD_ITEMS,
                &OLD_ITEMS_ID,
                PASSWORD,
                PHRASE,
                &ACCT,
                &fast_params(),
                ACTOR,
                &TestHost::new("/base"),
            )
            .await
            .expect("a corrupt catalog must not abort the whole migration");

            // themes + dictionary + prefs + chats-catalog + memory-catalog +
            // personality re-sealed; the attachments catalog did not.
            assert_eq!(summary.singletons_migrated, 6);

            // Both blobs — the live one AND the tombstoned leftover — are in
            // legacy/, byte-identical, because without the catalog neither can be
            // told from the other.
            for id_hex in [&seeded.live_id_hex, &seeded.tomb_id_hex] {
                let staged = io
                    .read(&vault_root.join("legacy/attachments").join(id_hex))
                    .await
                    .expect("every attachment is staged when the catalog will not open");
                assert_eq!(
                    &staged[0..4],
                    protocol::ATTACHMENT_BLOB_MAGIC.as_slice(),
                    "staged as the original MYA1"
                );
                assert_eq!(
                    io.read(&vault_root.join("attachments").join(id_hex))
                        .await
                        .unwrap(),
                    staged,
                    "and left in place un-re-keyed"
                );
            }
            // The corrupt catalog itself is staged verbatim too.
            assert_eq!(
                io.read(&vault_root.join("legacy/vault.attachments"))
                    .await
                    .unwrap(),
                junk,
                "the raw catalog is staged BEFORE the decode attempt"
            );
        })
    }

    /// An undecodable `vault.prefs` is skipped rather than fatal — and the
    /// consequence is that the user's settings reset.
    ///
    /// This pins a CHOICE that was previously expressed only by omission
    /// (`if let Ok(prefs) = decode_prefs_blob(…)`, mod.rs's step 5b). The blob is
    /// staged to `legacy/` and left in place as `MYP1`, which no v0.2 reader can
    /// open — so §9.5.5's fall-back-to-defaults takes over. Deliberate: an
    /// unreadable prefs blob was already unreadable before the migration, and
    /// aborting a whole-vault re-key over recoverable settings would be worse.
    /// If that trade is ever revisited, this test is what says so out loud.
    #[test]
    fn an_undecodable_prefs_blob_is_skipped_and_the_settings_fall_back_to_defaults() {
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-bad-prefs").unwrap();
            let vault_root = tmp.path().to_path_buf();
            let notes_dir = vault_root.join("notes");
            let io = StdVaultIo;
            io.create_dir_all(&notes_dir).await.unwrap();
            io.write(
                &vault_root.join("vault.meta"),
                b"MYV1 old vault meta bytes (opaque to the migration)",
                WriteOpts::default(),
            )
            .await
            .unwrap();
            seed_v0_1_singletons(&io, &vault_root).await;

            let mut junk = protocol::PREFS_BLOB_MAGIC.to_vec();
            junk.extend_from_slice(&[0xCD; 96]);
            io.write(&vault_root.join("vault.prefs"), &junk, WriteOpts::default())
                .await
                .unwrap();

            let summary = migrate_vault_notes_on_disk(
                &io,
                &vault_root,
                &notes_dir,
                &OLD_ROOT,
                &OLD_ITEMS,
                &OLD_ITEMS_ID,
                PASSWORD,
                PHRASE,
                &ACCT,
                &fast_params(),
                ACTOR,
                &TestHost::new("/base"),
            )
            .await
            .expect("an undecodable prefs blob must not abort the migration");

            // themes + dictionary + catalog + chats-catalog + memory-catalog +
            // personality re-sealed; prefs did not.
            assert_eq!(summary.singletons_migrated, 6);

            // The old bytes are staged AND left in place, unreadable under v0.2.
            assert_eq!(
                io.read(&vault_root.join("legacy/vault.prefs"))
                    .await
                    .unwrap(),
                junk,
                "the corrupt blob is staged before the decode attempt"
            );
            let on_disk = io.read(&vault_root.join("vault.prefs")).await.unwrap();
            assert_eq!(on_disk, junk, "and left as-is, not rewritten");
            let (new_root, _items, _id) = v0_2_material_from_disk(&io, &vault_root).await;
            let new_prefs_kek = derive_subkey_v0_2(&new_root, SubkeyRole::PrefsKey);
            assert!(
                decode_prefs_blob(&new_prefs_kek, &ACCT, &on_disk).is_err(),
                "so the v0.2 reader cannot open it and §9.5.5 hands back defaults"
            );
        })
    }

    /// The settings surface asks this command whether it has anything to show,
    /// so `offerable` has to answer for the LIVE meta rather than for the
    /// presence of `legacy/`.
    ///
    /// Three vault shapes, three answers — and the middle one is the reason the
    /// two flags are separate: right after a migration the vault is already
    /// v0.2 (nothing to offer) while its `legacy/` snapshot still has to be
    /// settled (§10.4.1 point 5). Collapsing them would either strand the
    /// snapshot or offer an upgrade the backend refuses with `AlreadyMigrated`.
    #[test]
    fn settle_status_offers_the_upgrade_only_to_a_v0_1_vault() {
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        block_on(async {
            let tmp = ScopedTempDir::new("vault-migrate-offerable").unwrap();
            let host = TestHost::new(tmp.path());
            let io = StdVaultIo;
            let vault_root = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            io.create_dir_all(&vault_root.join("notes")).await.unwrap();
            let state = VaultRuntimeState::default();

            // (1) A v0.1 vault: offerable, nothing staged.
            build_myv1_vault(&io, &vault_root).await;
            let s1 = vault_migrate_settle_status_from_host(&host, &state, &io)
                .await
                .expect("status on a v0.1 vault");
            assert!(s1.offerable, "a v0.1 vault can be upgraded");
            assert!(!s1.pending);

            // (2) The same vault after the meta flips to v0.2, with a `legacy/`
            //     snapshot staged: NOT offerable any more, but still unsettled.
            let ntv5 = protocol::serialize_vault_meta_v0_2(
                &protocol::parse_vault_meta_any(
                    &io.read(&vault_root.join("vault.meta")).await.unwrap(),
                )
                .unwrap(),
            );
            io.write(&vault_root.join("vault.meta"), &ntv5, WriteOpts::default())
                .await
                .unwrap();
            io.create_dir_all(&vault_root.join("legacy")).await.unwrap();
            io.write(
                &vault_root.join("legacy").join("vault.meta"),
                b"staged",
                WriteOpts::default(),
            )
            .await
            .unwrap();
            let s2 = vault_migrate_settle_status_from_host(&host, &state, &io)
                .await
                .expect("status on a migrated vault");
            assert!(!s2.offerable, "a v0.2 vault has nothing to migrate");
            assert!(s2.pending, "but its legacy snapshot is unsettled");

            // (3) Settled: neither flag, so the whole block leaves Settings.
            io.remove_file(&vault_root.join("legacy").join("vault.meta"))
                .await
                .unwrap();
            let s3 = vault_migrate_settle_status_from_host(&host, &state, &io)
                .await
                .expect("status on a settled vault");
            assert!(!s3.offerable);
            assert!(!s3.pending);
        });
    }
}
