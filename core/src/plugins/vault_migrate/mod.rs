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

use crate::host::HostCtx;
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::{
    decode_attachments_catalog, decode_note, decode_prefs_blob, derive_subkey, derive_subkey_v0_2,
    encode_attachments_catalog_versioned, encode_prefs_blob_versioned, encode_vault_meta_v0_2_raw,
    reseal_attachment_v0_2, reseal_kek_envelope_v0_2, KdfParams, MetaVersion, SubkeyRole,
    ATTACHMENT_ID_LEN,
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
    /// The family's `blob_envelope` format-version byte (carried through).
    format_version: u8,
    /// The family's AAD role string (e.g. `custom-themes-blob`).
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
        old_magic: b"MYT1",
        new_magic: b"MYT5",
        format_version: 0x01,
        aad_role: b"custom-themes-blob",
        kek_role: SubkeyRole::CustomThemesKey,
        cap: 4 * 1024 * 1024,
    },
    KekSingleton {
        filename: "vault.dictionary",
        old_magic: b"MYD1",
        new_magic: b"MYD5",
        format_version: 0x01,
        aad_role: b"personal-dictionary-blob",
        kek_role: SubkeyRole::PersonalDictKey,
        cap: 4 * 1024 * 1024,
    },
];

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

/// One hex nibble → its 0..=15 value, or `Err(())` on a non-hex byte.
fn hex_nibble(c: u8) -> Result<u8, ()> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(()),
    }
}

/// Decode a hex string into `out`, `Err(())` on a wrong length or a non-hex
/// nibble. Turns an attachments-catalog key (the attachment-id hex) back into the
/// 32-byte id [`reseal_attachment_v0_2`] wants, without pulling in a hex crate.
fn hex_to_bytes(s: &str, out: &mut [u8]) -> Result<(), ()> {
    let bytes = s.as_bytes();
    if bytes.len() != out.len() * 2 {
        return Err(());
    }
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = (hex_nibble(bytes[i * 2])? << 4) | hex_nibble(bytes[i * 2 + 1])?;
    }
    Ok(())
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
    host: &dyn HostCtx,
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
        let nc05_blob = crate::plugins::notes::crdt::encode_note_blob(
            markdown,
            &new_items_key,
            &new_items_key_id,
            uuid,
            actor,
            host,
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

    // Fresh Automerge actor for the migrated notes (device provenance, ASM-3).
    let actor = crate::plugins::sync::crdt_doc::fresh_actor_bytes()
        .map_err(|_| VaultMigrateError::Csprng)?;

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
    .await
    .map_err(|e| match e {
        OnDiskMigrationError::Io => VaultMigrateError::Io,
        OnDiskMigrationError::Crypto(MigrationError::Csprng) => VaultMigrateError::Csprng,
        OnDiskMigrationError::Crypto(_) => VaultMigrateError::Crypto,
    })?;

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
    if let Err(e) = crate::plugins::vault_unlock::commands::lock_from_host(state, hooks).await {
        tracing::warn!(target: "vault_migrate", "post-migration lock failed: {e:?}");
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

/// Run the notes + key-hierarchy leg of the §10.4.1 migration **on disk**, in the
/// commit-safe order: scan and read every `MY01` note, run the crypto core, stage
/// a `legacy/` snapshot of EVERY artifact (old `vault.meta`, note blobs, and each
/// re-sealed singleton) BEFORE overwriting it, write every re-keyed artifact in
/// place, then write the `NTV5` `vault.meta` **LAST** as the atomic commit point.
///
/// **What NTV5-last actually guarantees (§10.4.1).** It is a completion *marker*,
/// not in-place crash safety: notes, prefs, themes, dictionary and attachments are
/// all overwritten with their v0.2 forms BEFORE the meta commits, so a crash
/// between the first overwrite and the `NTV5` write leaves a vault whose meta still
/// reads `MYV1` while its blobs are v0.2 — NOT an openable v0.1 vault. No data is
/// lost (every original is in `legacy/`), but recovery is a `legacy/`-restore, not
/// a resume-where-it-crashed. The `NTV5` marker lets the next boot DETECT a
/// completed vs. torn migration; wiring the `legacy/`-restore is follow-on work.
///
/// Scoped to notes + `vault.meta`. The attachment re-seal
/// ([`protocol::reseal_attachment_v0_2`], stable id) and the KEK-singleton re-seal
/// ([`protocol::reseal_kek_envelope_v0_2`]) are the composed remaining legs; the
/// caller derives the new-vs-old KEKs (`derive_subkey`/`derive_subkey_v0_2`) and
/// threads catalog `content_type`s. `old_items_key` comes from a completed v0.1
/// unlock; crypto-erase of `legacy/` + the old `root_key` is a post-confirm step.
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

    // (2) Run the pure crypto core (mint v0.2 keys, NTV5, MY01→NC05).
    let out = migrate_keys_and_notes(
        old_items_key,
        old_items_key_id,
        password,
        phrase_normalized,
        account_number_hash,
        kdf_params,
        &notes,
        actor,
        host,
    )
    .map_err(OnDiskMigrationError::Crypto)?;

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

    // (4) Write every NC05 note over its MY01 (same <uuid>.myn filename).
    for mn in &out.notes {
        let name = format!("{}.myn", uuid::Uuid::from_bytes(mn.note_uuid));
        io.write(&notes_dir.join(&name), &mn.nc05_blob, WriteOpts::default())
            .await
            .map_err(|_| Io)?;
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
        let old_kek = derive_subkey(old_root_key, fam.kek_role);
        let new_kek = derive_subkey_v0_2(&out.new_root_key, fam.kek_role);
        let resealed = reseal_kek_envelope_v0_2(
            &old_blob,
            &old_kek,
            &new_kek,
            fam.old_magic,
            fam.new_magic,
            fam.format_version,
            fam.aad_role,
            account_number_hash,
            fam.cap,
        )
        .map_err(|_| OnDiskMigrationError::Crypto(MigrationError::Crypto))?;
        io.write(&path, &resealed, WriteOpts::default())
            .await
            .map_err(|_| Io)?;
        singletons_migrated += 1;
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
                    let mut id = [0u8; ATTACHMENT_ID_LEN];
                    if hex_to_bytes(id_hex, &mut id).is_err() {
                        continue; // malformed catalog key — leave it, do not abort
                    }
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

    // (5c) Drop the rebuildable / device-local caches and the quick-unlock
    //      credential. Each is either reconstructable from the notes (search,
    //      indices, graph, embeddings), device-local editor state (workspace), or
    //      a PIN/biometric credential wrapping a NOW-STALE `root_key` copy
    //      (`vault.quickunlock`). Leaving them would only be stale bytes the
    //      readers already fall back over; deleting them keeps the migrated vault
    //      byte-clean and forces a fresh rebuild / PIN re-enrolment under v0.2.
    //      Best-effort: a delete failure never aborts a committed re-key.
    for stale in [
        "vault.search",
        "vault.workspace",
        "vault.indices",
        "vault.graph",
        "vault.embeddings",
        // The PIN/biometric credential wraps a NOW-STALE `root_key` copy; drop the
        // blob AND its sibling attempt-counter so a re-key forces a fresh PIN
        // enrolment. (The OS-keychain biometric item is inert without the blob and
        // was wrapped under the old root — a follow-up should route migration
        // through the same `quick_unlock_invalidate` the change-password path uses.)
        "vault.quickunlock",
        "vault.quickunlock.attempts",
    ] {
        let _ = io.remove_file(&vault_root.join(stale)).await;
    }
    // The per-attachment extracted-text cache (`attachments-text/`, `MYE1`) is a
    // rebuildable search-extraction cache under the OLD key — drop the whole
    // subtree so it re-extracts under v0.2 on demand rather than lingering
    // undecryptable.
    let _ = io
        .remove_dir_all(&vault_root.join("attachments-text"))
        .await;

    // (6) Write the NTV5 vault.meta LAST — the atomic commit point.
    io.write(&meta_path, &out.ntv5_meta, WriteOpts::default())
        .await
        .map_err(|_| Io)?;

    Ok(OnDiskMigrationSummary {
        notes_migrated: out.notes.len(),
        singletons_migrated,
    })
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
    fn migrates_keys_and_notes_end_to_end() {
        let host = TestHost::new("/base");
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
            &host,
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
        let host = TestHost::new("/base");
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
            &host,
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

    #[test]
    fn empty_vault_migrates_to_just_the_ntv5_meta() {
        let host = TestHost::new("/base");
        let out = migrate_keys_and_notes(
            &OLD_ITEMS,
            &OLD_ITEMS_ID,
            PASSWORD,
            PHRASE,
            &ACCT,
            &fast_params(),
            &[],
            ACTOR,
            &host,
        )
        .expect("migrate empty");
        assert_eq!(&out.ntv5_meta[0..4], b"NTV5");
        assert!(out.notes.is_empty());
    }
}
