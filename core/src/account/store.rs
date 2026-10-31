// SPDX-License-Identifier: AGPL-3.0
//! The account record: the device-local half of the account/vault split
//! (`decisions.md` 2026-09-07).
//!
//! One sealed file per device, at `<app_config_dir>/account.json`, holding a
//! list of accounts. Each account carries an account id and its member vault
//! ids. It is what lets the LOCKED picker group vaults before any unlock, and it
//! is the device-local counterpart of the sealed membership field inside each
//! member vault's `vault.meta` (§9.3.1).
//!
//! An account has no name (`design-notes/ui/0728`): the heading a picker draws
//! for a group is derived from the group's own vault names, so nothing in this
//! record is user-authored text.
//!
//! ## Why sealed, and why under a keychain key
//!
//! The record carries the grouping itself (a privacy signal: which vaults belong
//! together). It must
//! be readable while every vault is LOCKED, so it cannot be sealed under a
//! `root_key`-derived KEK. It is sealed under a device-local keychain wrap key
//! (see `key::KEYCHAIN_ACCOUNT` for the shared-service namespace partition),
//! the `vault_label` pattern. Where the keychain is
//! unavailable there is no record and no grouping, and vaults keep working
//! standalone. **No path writes the record in plaintext.**
//!
//! ## Reconcile against discovery
//!
//! The disk-scan is the authority for which vaults exist (`vault_registry`). The
//! record is reconciled against it: vaults that appeared on disk are adopted
//! into the account, vaults that vanished are pruned, and an account left with
//! no members is pruned entirely. A missing or corrupt record is rebuilt from the
//! scan (one account holding every discovered vault), so a lost record is an
//! inconvenience, never data loss.

use crate::account::error::AccountError;
use crate::account::key::{
    existing_key, get_or_create_key, ACCOUNT_WRAP_KEY_LEN, KEYCHAIN_ACCOUNT,
};
use crate::io_failure_kind::IoFailureKind;
use crate::vault_id::VaultId;
use crate::vault_io::{VaultIo, WriteOpts};
use crate::vault_label::hide_flag::{
    names_hidden_at_rest, read_hide_vault_names, HIDE_FLAG_FILE_NAME,
};
use crate::vault_label::key::LabelKeychain;
use crate::vault_registry::DiscoveredVault;
use protocol::aead::{aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use std::path::{Path, PathBuf};

/// The account record file's name under `<app_config_dir>`. Sibling of
/// `vault-names.json`, `tor-routing.json` and `sync-config.json`.
pub const ACCOUNT_FILE_NAME: &str = "account.json";

/// Fixed magic at offset 0. Device-local and never synced, so it is NOT a
/// §10.3 registry entry; it exists only so a corrupt or foreign file is
/// detected before any decryption. Sealed at rest, which is what makes it safe
/// inside a platform backup: a backup carries the ciphertext, never the
/// grouping in the clear (`threat-model.md` §7 records this).
const ACCOUNT_MAGIC: [u8; 4] = *b"MYAC";

/// `protocol_version` byte at offset 4.
const ACCOUNT_VERSION: u8 = 0x01;

/// The AAD bound into the seal. A fixed domain string: the record is
/// device-global, so there is no `VaultId` or `account_number_hash` to bind.
const ACCOUNT_AAD: &[u8] = b"myne.v0.1 account-record";

/// The account id: a random UUIDv7, distinct from the account number and from
/// `account_number_hash`. 16 raw bytes.
pub const ACCOUNT_ID_LEN: usize = 16;

/// One account: an account id and its member vault ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    /// The account id (16 raw bytes, hex-encoded in the JSON).
    pub account_id: [u8; ACCOUNT_ID_LEN],
    /// The member vault ids, in no particular order.
    pub vaults: Vec<VaultId>,
}

/// The device-local account record as persisted: a list of accounts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRecord {
    /// The accounts on this device.
    pub accounts: Vec<Account>,
}

/// What reading the record answered. See the module header for why the cases are
/// facts rather than error flavours.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountRead {
    /// No record file for this device.
    Absent,
    /// The record.
    Record(AccountRecord),
    /// A file exists but can never be decoded again. Rebuild it.
    Unreadable,
}

/// `<app_config_dir>/account.json`.
pub fn account_path(config_dir: &Path) -> PathBuf {
    config_dir.join(ACCOUNT_FILE_NAME)
}

/// Serialize the record to its canonical JSON inner plaintext.
fn serialize_record(record: &AccountRecord) -> Vec<u8> {
    let value = serde_json::json!({
        "version": 1,
        "accounts": record
            .accounts
            .iter()
            .map(|a| serde_json::json!({
                "account_id": hex(a.account_id),
                "vaults": a.vaults.iter().map(|v| v.to_string()).collect::<Vec<_>>(),
            }))
            .collect::<Vec<_>>(),
    });
    serde_json::to_vec(&value).unwrap_or_default()
}

/// Strict parse of the record JSON. Any structural problem yields `None`.
fn parse_record(bytes: &[u8]) -> Option<AccountRecord> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let obj = value.as_object()?;
    if obj.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    let accounts = obj
        .get("accounts")?
        .as_array()?
        .iter()
        .map(|a| {
            let a = a.as_object()?;
            // Strict: this record is this device's own writer's output, so an
            // uppercase id is a second identity for one account rather than a
            // spelling to accept (protocol::hex::decode_lower, R1.2).
            let account_id =
                protocol::hex::decode_lower::<ACCOUNT_ID_LEN>(a.get("account_id")?.as_str()?)?;
            // A record written before `design-notes/ui/0728` still carries a
            // `label` member. It is not read and not required: an unknown key
            // parses fine, so an old file opens and the next write drops it.
            let vaults = a
                .get("vaults")?
                .as_array()?
                .iter()
                .map(|v| v.as_str().and_then(|s| VaultId::parse(s).ok()))
                .collect::<Option<Vec<_>>>()?;
            Some(Account { account_id, vaults })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(AccountRecord { accounts })
}

pub(crate) fn hex(bytes: [u8; ACCOUNT_ID_LEN]) -> String {
    let mut s = String::with_capacity(ACCOUNT_ID_LEN * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Seal a record into the on-disk blob under the account wrap key.
fn seal_record(
    key: &[u8; ACCOUNT_WRAP_KEY_LEN],
    record: &AccountRecord,
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, AccountError> {
    let plaintext = serialize_record(record);
    let sealed =
        aead_seal_ctx(key, nonce, &plaintext, ACCOUNT_AAD).map_err(|_| AccountError::Backend)?;
    let mut out = Vec::with_capacity(4 + 1 + AEAD_NONCE_LEN + sealed.len());
    out.extend_from_slice(&ACCOUNT_MAGIC);
    out.push(ACCOUNT_VERSION);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Open a sealed blob into a record.
fn open_record(
    key: &[u8; ACCOUNT_WRAP_KEY_LEN],
    blob: &[u8],
) -> Result<AccountRecord, AccountError> {
    if blob.len() < 4 + 1 + AEAD_NONCE_LEN + 32 {
        return Err(AccountError::Backend);
    }
    if blob[0..4] != ACCOUNT_MAGIC || blob[4] != ACCOUNT_VERSION {
        return Err(AccountError::Backend);
    }
    let nonce: &[u8; AEAD_NONCE_LEN] = blob[5..5 + AEAD_NONCE_LEN]
        .try_into()
        .map_err(|_| AccountError::Backend)?;
    let sealed = &blob[5 + AEAD_NONCE_LEN..];
    let plaintext =
        aead_open_ctx(key, nonce, sealed, ACCOUNT_AAD).map_err(|_| AccountError::Backend)?;
    parse_record(&plaintext).ok_or(AccountError::Backend)
}

/// Read the account record. The file is read FIRST, and only a present file
/// makes this touch the keychain, so a device with no keychain and no record
/// gets [`AccountRead::Absent`] rather than an error it would have to swallow.
pub async fn read_account(
    io: &dyn VaultIo,
    config_dir: &Path,
    keychain: &dyn LabelKeychain,
) -> Result<AccountRead, AccountError> {
    let path = account_path(config_dir);
    let blob = match io.read(&path).await {
        Ok(bytes) => bytes,
        Err(IoFailureKind::NotFound) => return Ok(AccountRead::Absent),
        Err(kind) => return Err(AccountError::Io(kind)),
    };

    let key = match existing_key(keychain) {
        Ok(key) => key,
        Err(AccountError::KeyMissing) => return Ok(AccountRead::Unreadable),
        Err(e) => return Err(e),
    };

    match open_record(&key, &blob) {
        Ok(record) => Ok(AccountRead::Record(record)),
        Err(_) => Ok(AccountRead::Unreadable),
    }
}

/// Write the account record, minting the wrap key on first use.
pub async fn write_account(
    io: &dyn VaultIo,
    config_dir: &Path,
    keychain: &dyn LabelKeychain,
    record: &AccountRecord,
) -> Result<(), AccountError> {
    let key = get_or_create_key(keychain)?;
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| AccountError::Backend)?;
    let blob = seal_record(&key, record, &nonce)?;
    io.write(&account_path(config_dir), &blob, WriteOpts::default())
        .await
        .map_err(AccountError::Io)?;
    tracing::info!(event = "account_record_written");
    Ok(())
}

/// Reconcile a record against the disk-scan: adopt appearing vaults, prune
/// vanished ones, and drop accounts left with no members.
///
/// Pure: reconciling never touches the disk or the keychain. Persistence is the
/// caller's decision (`load_account` never writes; mutation paths write back
/// explicitly), so merely listing the picker cannot regroup vaults.
pub fn reconcile(
    record: &AccountRecord,
    discovered: &[DiscoveredVault],
) -> Result<AccountRecord, AccountError> {
    let discovered_ids: std::collections::BTreeSet<VaultId> =
        discovered.iter().map(|d| d.id).collect();
    // Prune vanished vaults from each account; drop accounts left empty.
    let mut accounts: Vec<Account> = record
        .accounts
        .iter()
        .map(|a| Account {
            account_id: a.account_id,
            vaults: a
                .vaults
                .iter()
                .copied()
                .filter(|v| discovered_ids.contains(v))
                .collect(),
        })
        .filter(|a| !a.vaults.is_empty())
        .collect();

    // Adopt appearing vaults (not already a member of any account) into the
    // first account, or a fresh account when none survives. Membership is
    // independent of well-formedness: a corrupted directory joins the merge
    // and keeps its corrupted badge (PRD story 13), so migration never hides
    // damage by stranding it standalone.
    let member_ids: std::collections::BTreeSet<VaultId> = accounts
        .iter()
        .flat_map(|a| a.vaults.iter().copied())
        .collect();
    let appearing: Vec<VaultId> = discovered
        .iter()
        .filter(|d| !member_ids.contains(&d.id))
        .map(|d| d.id)
        .collect();

    if !appearing.is_empty() {
        if let Some(first) = accounts.first_mut() {
            first.vaults.extend(appearing);
        } else if let Some(account) = build_from_scan(discovered)? {
            accounts.push(account);
        }
    }

    Ok(AccountRecord { accounts })
}

/// Build a fresh record from the disk-scan: one account holding every
/// discovered vault, with a freshly minted account id.
///
/// Corrupted directories join too (PRD story 13): the record tracks
/// membership, not health, and the picker keeps rendering the corrupted badge
/// exactly as the vault list reports it.
///
/// Fallible: the fresh id mints from the OS CSPRNG, and a CSPRNG failure is an
/// error, never a zeroed id (myne-md/myne#684 review).
pub fn build_from_scan(discovered: &[DiscoveredVault]) -> Result<Option<Account>, AccountError> {
    let vaults: Vec<VaultId> = discovered.iter().map(|d| d.id).collect();
    if vaults.is_empty() {
        return Ok(None);
    }
    let mut account_id = [0u8; ACCOUNT_ID_LEN];
    getrandom::getrandom(&mut account_id).map_err(|_| AccountError::Backend)?;
    Ok(Some(Account { account_id, vaults }))
}

/// The most recently unlocked vault id, from the registry's last-unlock stamps.
/// `None` when no vault has ever been unlocked on this device.
pub fn most_recent_vault(registry: &crate::vault_registry::VaultRegistry) -> Option<VaultId> {
    registry
        .entries
        .iter()
        .filter_map(|e| e.last_unlock_ms.map(|ms| (ms, e.id)))
        .max_by_key(|(ms, _)| *ms)
        .map(|(_, id)| id)
}

/// Resolve the account id a new (or newly-unlocked) vault should join, per the
/// recency rule: the account owning the most recently unlocked vault, the sole
/// account when only one exists, or a fresh account for the first vault.
///
/// The fresh-account fallback mints a random id; it is the first-vault case
/// (no account yet) and the no-recency-info case (multiple accounts, none
/// unlocked). A CSPRNG failure is an error: the caller seals this id into the
/// vault's membership field, and a zeroed id would merge unrelated vaults
/// under one owner with zero signal (myne-md/myne#684 review).
pub fn account_id_for_new_vault(
    record: &AccountRecord,
    most_recent_vault_id: Option<VaultId>,
) -> Result<[u8; ACCOUNT_ID_LEN], AccountError> {
    if record.accounts.len() == 1 {
        return Ok(record.accounts[0].account_id);
    }
    if let Some(most_recent) = most_recent_vault_id {
        if let Some(account) = record
            .accounts
            .iter()
            .find(|a| a.vaults.contains(&most_recent))
        {
            return Ok(account.account_id);
        }
    }
    let mut id = [0u8; ACCOUNT_ID_LEN];
    getrandom::getrandom(&mut id).map_err(|_| AccountError::Backend)?;
    Ok(id)
}

/// A loaded record plus where it came from. The provenance decides what the
/// caller may do next: persisting a fresh build is first-write creation,
/// persisting over undecryptable bytes is evidence destruction, and treating
/// an in-memory member as persisted strands the sealed field.
pub struct LoadedAccount {
    /// The record: read from disk, or rebuilt in memory from the scan.
    pub record: AccountRecord,
    /// Whether the record may be persisted, and whether its memberships are.
    pub kind: LoadKind,
}

/// Provenance of a [`LoadedAccount`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadKind {
    /// Read from `account.json` (reconciled in memory). Memberships are
    /// persisted; mutations may write back.
    Stored,
    /// Built in memory: no source file (or no vaults at all). The first
    /// persist is creation, never an overwrite.
    Fresh,
    /// Rebuilt in memory over undecryptable bytes. Must never persist: a
    /// restored key could still open the source.
    Unreadable,
}

impl LoadedAccount {
    /// Whether the record may be written back. False exactly for
    /// `Unreadable`.
    pub fn writable(&self) -> bool {
        !matches!(self.kind, LoadKind::Unreadable)
    }
}

/// Load the account record, reconciling against the disk-scan and rebuilding
/// from it when the file is missing or corrupt.
///
/// READ-ONLY by construction: reconciling, rebuilding, and pruning all happen
/// in memory and nothing here writes. Merely listing the picker must not
/// regroup vaults, so persistence belongs to [`ensure_vault_membership`], the
/// one writer left after the account move/split mutations were removed
/// (myne-md/myne#937); it writes back explicitly and propagates the failure. In
/// particular an `Unreadable` source (key destroyed, or a record restored onto a
/// device that never held it) is never overwritten: the undecryptable bytes stay
/// on disk and the caller gets the in-memory rebuild, so keychain loss costs the
/// grouping but cannot also destroy the evidence.
///
/// Returns an empty record when there is no account (no vaults, or the keychain
/// is unavailable), which is the standalone state, never an error.
pub async fn load_account(
    io: &dyn VaultIo,
    config_dir: &Path,
    base: &Path,
    keychain: &dyn LabelKeychain,
) -> Result<AccountRecord, AccountError> {
    load_account_tracked(io, config_dir, base, keychain)
        .await
        .map(|loaded| loaded.record)
}

/// [`load_account`], plus the provenance that decides what the caller may do
/// next. Mutations refuse the write-back on `Unreadable` (see
/// `AccountError::RecordUnreadable`) instead of converting keychain loss into
/// evidence destruction; `ensure_vault_membership` additionally persists a
/// fresh in-memory membership, so the sealed field and the record derive from
/// one write.
pub async fn load_account_tracked(
    io: &dyn VaultIo,
    config_dir: &Path,
    base: &Path,
    keychain: &dyn LabelKeychain,
) -> Result<LoadedAccount, AccountError> {
    let discovered = crate::vault_registry::discover_vaults(base);
    if discovered.is_empty() {
        return Ok(LoadedAccount {
            record: AccountRecord { accounts: vec![] },
            kind: LoadKind::Fresh,
        });
    }

    match read_account(io, config_dir, keychain).await {
        Ok(AccountRead::Record(record)) => Ok(LoadedAccount {
            record: reconcile(&record, &discovered)?,
            kind: LoadKind::Stored,
        }),
        Ok(AccountRead::Absent) => {
            // A device with no keychain cannot seal a record, so there is no
            // grouping: return the standalone state rather than a record that
            // was never persisted. `KeyMissing` (no key yet, keychain present)
            // is the normal first-run case and must NOT short-circuit.
            if matches!(
                existing_key(keychain),
                Err(AccountError::KeychainUnavailable)
            ) {
                return Ok(LoadedAccount {
                    record: AccountRecord { accounts: vec![] },
                    kind: LoadKind::Fresh,
                });
            }
            match build_from_scan(&discovered)? {
                Some(account) => Ok(LoadedAccount {
                    record: AccountRecord {
                        accounts: vec![account],
                    },
                    kind: LoadKind::Fresh,
                }),
                None => Ok(LoadedAccount {
                    record: AccountRecord { accounts: vec![] },
                    kind: LoadKind::Fresh,
                }),
            }
        }
        // Unreadable: the rebuild is in-memory ONLY. The bytes stay.
        Ok(AccountRead::Unreadable) => {
            if matches!(
                existing_key(keychain),
                Err(AccountError::KeychainUnavailable)
            ) {
                return Ok(LoadedAccount {
                    record: AccountRecord { accounts: vec![] },
                    kind: LoadKind::Fresh,
                });
            }
            match build_from_scan(&discovered)? {
                Some(account) => Ok(LoadedAccount {
                    record: AccountRecord {
                        accounts: vec![account],
                    },
                    kind: LoadKind::Unreadable,
                }),
                None => Ok(LoadedAccount {
                    record: AccountRecord { accounts: vec![] },
                    kind: LoadKind::Unreadable,
                }),
            }
        }
        Err(AccountError::KeychainUnavailable) => Ok(LoadedAccount {
            record: AccountRecord { accounts: vec![] },
            kind: LoadKind::Fresh,
        }),
        Err(e) => Err(e),
    }
}

/// Whether the hide-vault-names option is on for this device. The one
/// implementation the command layer reuses (`commands` calls this): list,
/// mutation, and adoption reduce through the same fail-closed rule (a damaged
/// flag file reads as hidden) and cannot disagree about it.
pub(crate) async fn hide_names_on(io: &dyn VaultIo, config_dir: &Path) -> bool {
    let outcome = read_hide_vault_names(io, &config_dir.join(HIDE_FLAG_FILE_NAME)).await;
    names_hidden_at_rest(outcome)
}

/// Delete the device-local account record: remove `account.json` (a missing
/// file is a successful delete) and destroy its keychain wrap key.
///
/// The working half of the hide-vault-names option alongside
/// `vault_label::erase_all_labels`: enabling hide must destroy the grouping
/// with the same cryptographic-erase semantics as the vault names, or the lock
/// screen keeps showing which vaults belong together while claiming names are
/// hidden (myne-md/myne#684 review). Idempotent.
pub async fn delete_account_record(
    io: &dyn VaultIo,
    config_dir: &Path,
    keychain: &dyn LabelKeychain,
) -> Result<(), AccountError> {
    match io.remove_file(&account_path(config_dir)).await {
        Ok(()) => {}
        Err(IoFailureKind::NotFound) => {}
        Err(kind) => return Err(AccountError::Io(kind)),
    }
    // No keychain means no record could ever have been sealed: absence of the
    // facility is absence of the artefact, so this is a successful no-op
    // rather than an erase failure (keychain-less devices must still be able
    // to enable hide-vault-names for the vault-name half).
    match keychain.delete(KEYCHAIN_ACCOUNT) {
        Ok(()) => Ok(()),
        Err(crate::vault_label::error::VaultLabelError::KeychainUnavailable) => Ok(()),
        Err(e) => Err(AccountError::from(e)),
    }
}

/// Resolve the account id a vault should join, and ensure the record lists the
/// vault as a member of that account. The recency rule: the account owning the
/// most recently unlocked vault, the sole account when only one exists, or a
/// fresh account for the first vault.
///
/// Returns the account id to seal into the vault's membership field. The record
/// is written back when it changed (a fresh account was minted, or the vault was
/// adopted into an existing account), and a write-back failure is an error:
/// the caller must not report grouping it never persisted.
pub async fn ensure_vault_membership(
    io: &dyn VaultIo,
    config_dir: &Path,
    base: &Path,
    keychain: &dyn LabelKeychain,
    vault_id: VaultId,
) -> Result<[u8; ACCOUNT_ID_LEN], AccountError> {
    // Hide-vault-names suppresses grouping entirely: adopting (which mints a
    // key and writes the record) while hidden would silently undo the erase
    // the user just asked for, with the resurrection invisible until unhide.
    // Both callers treat any error as skip-the-stamp, so refusal degrades to
    // no grouping rather than breaking unlock or creation.
    if hide_names_on(io, config_dir).await {
        return Err(AccountError::Hidden);
    }
    let mut loaded = load_account_tracked(io, config_dir, base, keychain).await?;
    let registry = crate::vault_registry::load_or_rebuild_registry(base);
    let most_recent = most_recent_vault(&registry);

    // A vault already a member of a STORED record returns its account id
    // unchanged. But membership of a merely in-memory build was never
    // persisted: returning it would strand the sealed field against a record
    // that names another account on its next rebuild, so a Fresh member is
    // persisted below like an adoption. An Unreadable member refuses: the
    // bytes cannot be written back without destroying them.
    if let Some(account_id) = loaded
        .record
        .accounts
        .iter()
        .find(|a| a.vaults.contains(&vault_id))
        .map(|a| a.account_id)
    {
        match loaded.kind {
            LoadKind::Stored => return Ok(account_id),
            LoadKind::Fresh => {
                write_account(io, config_dir, keychain, &loaded.record).await?;
                return Ok(account_id);
            }
            LoadKind::Unreadable => return Err(AccountError::RecordUnreadable),
        }
    }

    // Adoption persists, so an undecryptable source refuses rather than
    // overwriting: the unlock proceeds without grouping (the caller treats
    // any error as skip-the-stamp), and the bytes survive for a restored key.
    if !loaded.writable() {
        return Err(AccountError::RecordUnreadable);
    }
    let record = &mut loaded.record;

    let account_id = account_id_for_new_vault(record, most_recent)?;

    // Adopt the vault into the account carrying that id, or mint a fresh account.
    if let Some(account) = record
        .accounts
        .iter_mut()
        .find(|a| a.account_id == account_id)
    {
        account.vaults.push(vault_id);
    } else {
        record.accounts.push(Account {
            account_id,
            vaults: vec![vault_id],
        });
    }

    write_account(io, config_dir, keychain, &*record).await?;
    Ok(account_id)
}

/// Stamp the sealed membership field into a `vault.meta` blob, when absent.
///
/// Returns the new blob (417 bytes) when the field was stamped, or the original
/// bytes unchanged when the field was already present, the vault is not v0.2
/// (`NTV5`), or any step failed. Best-effort by design: the caller never gates
/// or delays the unlock on this, and a failure degrades to retry-next-unlock.
pub fn stamp_membership_field(
    root_key: &[u8; AEAD_KEY_LEN],
    account_id: &[u8; ACCOUNT_ID_LEN],
    account_number_hash: &[u8; 16],
    meta_bytes: &[u8],
) -> Vec<u8> {
    // The membership field lives ONLY in an `NTV5` frame. A `NTV6`, `NTV7` or
    // `NTV8` vault carries its membership through the B2B roster instead, and
    // rewriting those bytes through the `NTV5` serializer would DROP the B2B tail
    // (group-key wrap, epoch, signed roster), leaving a vault whose `items_key`
    // is group-sealed but whose meta claims the root tier.
    //
    // `has_b2b_tail` rather than a list of magics (myne-md/myne#938): the list
    // this replaced named `NTV6` and `NTV7` and missed `NTV8`, and the miss was
    // invisible only because `meta_version_of` also did not know the generation.
    // Teaching that function `NTV8` (which every singleton reader needs) would
    // have turned this guard into a silent downgrade of every password-only
    // vault on its first unlock. The predicate is the one question that matters
    // here, "is there a tail a rewrite would drop", and it is the same one the
    // rekey recovery and the epoch merge ask.
    if protocol::has_b2b_tail(meta_bytes) {
        return meta_bytes.to_vec();
    }
    let Ok(meta) = protocol::parse_vault_meta_any(meta_bytes) else {
        return meta_bytes.to_vec();
    };
    if meta.membership.is_some() {
        return meta_bytes.to_vec();
    }
    // The field is NTV5-only; a MYV1 vault groups via the record alone.
    if protocol::meta_version_of(meta_bytes) != Some(protocol::MetaVersion::V0_2) {
        return meta_bytes.to_vec();
    }
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    if getrandom::getrandom(&mut nonce).is_err() {
        return meta_bytes.to_vec();
    }
    let Ok(membership) =
        protocol::seal_membership_raw(root_key, account_id, account_number_hash, &nonce)
    else {
        return meta_bytes.to_vec();
    };
    let mut stamped = meta;
    stamped.membership = Some(membership);
    protocol::serialize_vault_meta_v0_2(&stamped)
}

/// Stamp the sealed person binding field into a `vault.meta` blob, when absent
/// (myne-md/myne#768). The sibling of [`stamp_membership_field`]: binds the
/// vault to a person identity so the identity-first first run can enumerate a
/// person's vaults and show a vault under its person.
///
/// Best-effort by design, like its sibling: returns the new blob when stamped,
/// or the original bytes unchanged when the field is already present, the vault
/// is not `NTV5`, or any step failed. A vault's binding is independent of its
/// account membership, so this never requires `membership` to be present.
pub fn stamp_person_binding_field(
    root_key: &[u8; AEAD_KEY_LEN],
    person_id_hash: &[u8; protocol::PERSON_BINDING_ID_LEN],
    account_number_hash: &[u8; 16],
    meta_bytes: &[u8],
) -> Vec<u8> {
    // The person-binding field lives ONLY in an `NTV5` frame, and this check is
    // the one that MUST come before the parse: `meta_version_of` reports an
    // `NTV6`, `NTV7` or `NTV8` vault as `V0_2` (same generation, different frame),
    // and `parse_vault_meta_any` reads only the 345-byte base of a tail frame. So
    // without this guard, stamping a binding re-serializes through
    // `serialize_vault_meta_v0_2` and silently DOWNGRADES the frame to `NTV5`,
    // dropping the B2B tail: the group-key wrap that `enc_items_key` needs. The
    // result is a vault whose `items_key` is group-sealed but whose meta claims
    // the root tier, so no unlock path can open it (`items_key_unwrap` fails and
    // it reports "corrupted vault"). Every tail generation already binds its
    // owner through the signed roster, so stamping is a no-op there by design.
    //
    // `has_b2b_tail` rather than a list of magics, for the reason its sibling
    // above states: the list missed `NTV8`.
    if protocol::has_b2b_tail(meta_bytes) {
        return meta_bytes.to_vec();
    }
    let Ok(meta) = protocol::parse_vault_meta_any(meta_bytes) else {
        return meta_bytes.to_vec();
    };
    if meta.person_binding.is_some() {
        return meta_bytes.to_vec();
    }
    // The field is NTV5-only, like the membership field.
    if protocol::meta_version_of(meta_bytes) != Some(protocol::MetaVersion::V0_2) {
        return meta_bytes.to_vec();
    }
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    if getrandom::getrandom(&mut nonce).is_err() {
        return meta_bytes.to_vec();
    }
    let Ok(binding) =
        protocol::seal_person_binding_raw(root_key, person_id_hash, account_number_hash, &nonce)
    else {
        return meta_bytes.to_vec();
    };
    let mut stamped = meta;
    stamped.person_binding = Some(binding);
    protocol::serialize_vault_meta_v0_2(&stamped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use crate::vault_label::fake_keychain::FakeKeychain;
    fn account() -> Account {
        Account {
            account_id: [0xAB; ACCOUNT_ID_LEN],
            vaults: vec![VaultId::mint(), VaultId::mint()],
        }
    }

    fn record() -> AccountRecord {
        AccountRecord {
            accounts: vec![account()],
        }
    }

    #[test]
    fn seal_open_round_trips() {
        let key = [0x11; ACCOUNT_WRAP_KEY_LEN];
        let nonce = [0x22; AEAD_NONCE_LEN];
        let r = record();
        let blob = seal_record(&key, &r, &nonce).expect("seal");
        let opened = open_record(&key, &blob).expect("open");
        assert_eq!(opened, r);
    }

    #[test]
    fn the_sealed_blob_carries_no_plaintext_record() {
        let key = [0x11; ACCOUNT_WRAP_KEY_LEN];
        let nonce = [0x22; AEAD_NONCE_LEN];
        let r = record();
        let blob = seal_record(&key, &r, &nonce).expect("seal");
        assert_eq!(&blob[0..4], b"MYAC");
        // The grouping is what this file seals: which vaults belong together,
        // and under which account id. Both are asserted against the values the
        // record actually holds rather than against a literal planted in the
        // fixture, so the check can fail for the reason it exists (the record
        // carried user-authored text until `design-notes/ui/0728`, and this
        // test named that text instead: the shape outlived its subject).
        let id = hex(r.accounts[0].account_id);
        assert!(
            !blob.windows(id.len()).any(|w| w == id.as_bytes()),
            "the plaintext account id must not appear anywhere in the file"
        );
        for vault in &r.accounts[0].vaults {
            let v = vault.to_string();
            assert!(
                !blob.windows(v.len()).any(|w| w == v.as_bytes()),
                "a plaintext member vault id must not appear anywhere in the file"
            );
        }
    }

    #[test]
    fn a_tampered_blob_fails_closed() {
        let key = [0x11; ACCOUNT_WRAP_KEY_LEN];
        let nonce = [0x22; AEAD_NONCE_LEN];
        let mut blob = seal_record(&key, &record(), &nonce).expect("seal");
        let last = blob.len() - 1;
        blob[last] ^= 0xff;
        assert!(open_record(&key, &blob).is_err());
    }

    #[test]
    fn reconcile_adopts_and_prunes() {
        let a = VaultId::mint();
        let b = VaultId::mint();
        let c = VaultId::mint();
        let r = AccountRecord {
            accounts: vec![Account {
                account_id: [0xAB; ACCOUNT_ID_LEN],
                vaults: vec![a, b],
            }],
        };
        let discovered = vec![
            DiscoveredVault {
                id: a,
                root: PathBuf::new(),
                well_formed: true,
            },
            DiscoveredVault {
                id: c,
                root: PathBuf::new(),
                well_formed: true,
            },
        ];
        let reconciled = reconcile(&r, &discovered).expect("reconcile");
        assert_eq!(reconciled.accounts.len(), 1);
        assert_eq!(reconciled.accounts[0].vaults, vec![a, c]);
    }

    #[test]
    fn reconcile_prunes_an_empty_account() {
        let a = VaultId::mint();
        let r = AccountRecord {
            accounts: vec![Account {
                account_id: [0xAB; ACCOUNT_ID_LEN],
                vaults: vec![a],
            }],
        };
        let reconciled = reconcile(&r, &[]).expect("reconcile");
        assert!(reconciled.accounts.is_empty());
    }

    #[test]
    fn build_from_scan_includes_corrupted_dirs() {
        // PRD story 13: a corrupted directory joins the merge and keeps its
        // badge; migration must not hide damage by stranding it standalone.
        let a = VaultId::mint();
        let b = VaultId::mint();
        let discovered = vec![
            DiscoveredVault {
                id: a,
                root: PathBuf::new(),
                well_formed: true,
            },
            DiscoveredVault {
                id: b,
                root: PathBuf::new(),
                well_formed: false,
            },
        ];
        let account = build_from_scan(&discovered)
            .expect("csprng")
            .expect("a vault is a vault");
        assert_eq!(account.vaults, vec![a, b]);
    }

    #[test]
    fn build_from_scan_is_none_when_no_vaults_discovered() {
        assert_eq!(build_from_scan(&[]).expect("csprng"), None);
    }

    #[test]
    fn an_unavailable_keychain_writes_nothing() {
        let dir = ScopedTempDir::new("account-none").expect("scratch");
        let keychain = FakeKeychain::unavailable();
        block_on(async {
            assert_eq!(
                write_account(&StdVaultIo, dir.path(), &keychain, &record()).await,
                Err(AccountError::KeychainUnavailable)
            );
        });
        assert!(!account_path(dir.path()).exists());
    }

    #[test]
    fn account_id_for_new_vault_prefers_the_sole_account() {
        let a = VaultId::mint();
        let r = AccountRecord {
            accounts: vec![Account {
                account_id: [0xAB; ACCOUNT_ID_LEN],
                vaults: vec![a],
            }],
        };
        // Sole account wins even with no recency info.
        assert_eq!(
            account_id_for_new_vault(&r, None).expect("recency"),
            [0xAB; ACCOUNT_ID_LEN]
        );
    }

    #[test]
    fn account_id_for_new_vault_prefers_the_most_recent_vaults_account() {
        let a = VaultId::mint();
        let b = VaultId::mint();
        let r = AccountRecord {
            accounts: vec![
                Account {
                    account_id: [0x01; ACCOUNT_ID_LEN],
                    vaults: vec![a],
                },
                Account {
                    account_id: [0x02; ACCOUNT_ID_LEN],
                    vaults: vec![b],
                },
            ],
        };
        // b is the most recently unlocked vault, so its account wins.
        assert_eq!(
            account_id_for_new_vault(&r, Some(b)).expect("recency"),
            [0x02; ACCOUNT_ID_LEN]
        );
    }

    #[test]
    fn account_id_for_new_vault_mints_a_fresh_id_when_no_account_matches() {
        let a = VaultId::mint();
        let b = VaultId::mint();
        let r = AccountRecord {
            accounts: vec![
                Account {
                    account_id: [0x01; ACCOUNT_ID_LEN],
                    vaults: vec![a],
                },
                Account {
                    account_id: [0x02; ACCOUNT_ID_LEN],
                    vaults: vec![b],
                },
            ],
        };
        // A most-recent vault that belongs to no account → fresh id.
        let fresh = account_id_for_new_vault(&r, Some(VaultId::mint())).expect("recency");
        assert_ne!(fresh, [0x01; ACCOUNT_ID_LEN]);
        assert_ne!(fresh, [0x02; ACCOUNT_ID_LEN]);
    }

    #[test]
    fn stamp_membership_field_is_a_noop_when_already_present() {
        // Build a real NTV5 meta with a membership field, then confirm stamping
        // returns the bytes unchanged.
        let root = [0x11; AEAD_KEY_LEN];
        let account_id = [0xAB; ACCOUNT_ID_LEN];
        let hash = [0x44; 16];
        let nonce = [0xCD; AEAD_NONCE_LEN];
        let membership =
            protocol::seal_membership_raw(&root, &account_id, &hash, &nonce).expect("seal");
        // Build a base NTV5 meta via the v0.2 encoder.
        let base = protocol::VaultMeta {
            account_number_hash: hash,
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [0x01; 16],
            random_salt_recovery: [0x02; 16],
            nonce_password_wrap: [0x03; 24],
            enc_root_key_password: [0x04; 64],
            nonce_recovery_wrap: [0x05; 24],
            enc_root_key_recovery: [0x06; 64],
            items_key_id: [0x07; 16],
            items_key_nonce: [0x08; 24],
            enc_items_key: [0x09; 64],
            membership: Some(membership),
            person_binding: None,
        };
        let bytes = protocol::serialize_vault_meta_v0_2(&base);
        let stamped = stamp_membership_field(&root, &account_id, &hash, &bytes);
        assert_eq!(stamped, bytes, "already-present field must be a no-op");
    }

    #[test]
    fn stamp_person_binding_field_stamps_an_absent_field_without_membership() {
        // The binding is independent of the membership field: stamping it on a
        // vault with no membership must produce a base-plus-binding blob whose
        // reserved byte carries ONLY the binding bit.
        let root = [0x11; AEAD_KEY_LEN];
        let person_id = [0x51; protocol::PERSON_BINDING_ID_LEN];
        let hash = [0x44; 16];
        let base = protocol::VaultMeta {
            account_number_hash: hash,
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [0x01; 16],
            random_salt_recovery: [0x02; 16],
            nonce_password_wrap: [0x03; 24],
            enc_root_key_password: [0x04; 64],
            nonce_recovery_wrap: [0x05; 24],
            enc_root_key_recovery: [0x06; 64],
            items_key_id: [0x07; 16],
            items_key_nonce: [0x08; 24],
            enc_items_key: [0x09; 64],
            membership: None,
            person_binding: None,
        };
        let bytes = protocol::serialize_vault_meta_v0_2(&base);
        let stamped = stamp_person_binding_field(&root, &person_id, &hash, &bytes);
        assert_eq!(
            stamped.len(),
            protocol::VAULT_META_LEN + protocol::PERSON_BINDING_FIELD_LEN
        );
        assert_eq!(stamped[5], protocol::PERSON_BINDING_BIT);
        let parsed = protocol::parse_vault_meta_v0_2(&stamped).expect("parse");
        assert!(parsed.membership.is_none(), "membership must stay absent");
        let b = parsed.person_binding.expect("binding present");
        assert_eq!(
            *protocol::unseal_person_binding(&root, &b, &hash).expect("unseal"),
            person_id
        );
    }

    #[test]
    fn stamp_person_binding_field_is_a_noop_when_already_present() {
        let root = [0x11; AEAD_KEY_LEN];
        let person_id = [0x51; protocol::PERSON_BINDING_ID_LEN];
        let hash = [0x44; 16];
        let binding =
            protocol::seal_person_binding_raw(&root, &person_id, &hash, &[0x52; 24]).expect("seal");
        let base = protocol::VaultMeta {
            account_number_hash: hash,
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [0x01; 16],
            random_salt_recovery: [0x02; 16],
            nonce_password_wrap: [0x03; 24],
            enc_root_key_password: [0x04; 64],
            nonce_recovery_wrap: [0x05; 24],
            enc_root_key_recovery: [0x06; 64],
            items_key_id: [0x07; 16],
            items_key_nonce: [0x08; 24],
            enc_items_key: [0x09; 64],
            membership: None,
            person_binding: Some(binding),
        };
        let bytes = protocol::serialize_vault_meta_v0_2(&base);
        let stamped = stamp_person_binding_field(&root, &person_id, &hash, &bytes);
        assert_eq!(stamped, bytes, "already-present field must be a no-op");
    }

    #[test]
    fn stamp_membership_field_stamps_an_absent_field() {
        let root = [0x11; AEAD_KEY_LEN];
        let account_id = [0xAB; ACCOUNT_ID_LEN];
        let hash = [0x44; 16];
        let base = protocol::VaultMeta {
            account_number_hash: hash,
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [0x01; 16],
            random_salt_recovery: [0x02; 16],
            nonce_password_wrap: [0x03; 24],
            enc_root_key_password: [0x04; 64],
            nonce_recovery_wrap: [0x05; 24],
            enc_root_key_recovery: [0x06; 64],
            items_key_id: [0x07; 16],
            items_key_nonce: [0x08; 24],
            enc_items_key: [0x09; 64],
            membership: None,
            person_binding: None,
        };
        let bytes = protocol::serialize_vault_meta_v0_2(&base);
        let stamped = stamp_membership_field(&root, &account_id, &hash, &bytes);
        assert_eq!(stamped.len(), protocol::VAULT_META_V0_2_WITH_MEMBERSHIP_LEN);
        let parsed = protocol::parse_vault_meta_v0_2(&stamped).expect("parse");
        let m = parsed.membership.expect("membership present");
        assert_eq!(
            *protocol::unseal_membership(&root, &m, &hash).expect("unseal"),
            account_id
        );
    }

    /// An `NTV6` frame carries the B2B tail whose group-key wrap `enc_items_key`
    /// is sealed under. Stamping a membership or person-binding field must NOT
    /// rewrite it through the `NTV5` serializer, because that drops the tail and
    /// leaves a vault no unlock path can open (myne-md/myne#786 regression:
    /// reported as "corrupted vault" on an invite-enabled vault).
    fn b2b_fixture() -> Vec<u8> {
        let base = protocol::VaultMeta {
            account_number_hash: [0x44; 16],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [0x01; 16],
            random_salt_recovery: [0x02; 16],
            nonce_password_wrap: [0x03; 24],
            enc_root_key_password: [0x04; 64],
            nonce_recovery_wrap: [0x05; 24],
            enc_root_key_recovery: [0x06; 64],
            items_key_id: [0x07; 16],
            items_key_nonce: [0x08; 24],
            enc_items_key: [0x09; 64],
            membership: None,
            person_binding: None,
        };
        protocol::serialize_vault_meta_ntv6(&protocol::B2bVaultMeta {
            base,
            group_key_nonce: [0xAB; 24],
            enc_group_key: [0xCD; 64],
            group_key_epoch: 1,
            signed_roster_envelope: vec![0xEF; 128],
        })
        .expect("serialize ntv6")
    }

    #[test]
    fn stamp_person_binding_field_must_not_downgrade_an_ntv6_meta() {
        let bytes = b2b_fixture();
        assert_eq!(
            bytes.get(..4),
            Some(protocol::VAULT_META_NTV6_MAGIC.as_slice())
        );
        let stamped =
            stamp_person_binding_field(&[0x11; AEAD_KEY_LEN], &[0x51; 16], &[0x44; 16], &bytes);
        assert_eq!(
            stamped.get(..4),
            Some(protocol::VAULT_META_NTV6_MAGIC.as_slice()),
            "stamping a person binding must not change the vault generation"
        );
        assert_eq!(stamped, bytes, "an NTV6 meta must be returned untouched");
        assert!(
            protocol::parse_vault_meta_ntv6(&stamped).is_ok(),
            "the B2B tail must survive the stamp"
        );
    }

    #[test]
    fn stamp_membership_field_must_not_downgrade_an_ntv6_meta() {
        let bytes = b2b_fixture();
        let stamped = stamp_membership_field(
            &[0x11; AEAD_KEY_LEN],
            &[0xAB; ACCOUNT_ID_LEN],
            &[0x44; 16],
            &bytes,
        );
        assert_eq!(
            stamped.get(..4),
            Some(protocol::VAULT_META_NTV6_MAGIC.as_slice()),
            "stamping a membership must not change the vault generation"
        );
        assert_eq!(stamped, bytes, "an NTV6 meta must be returned untouched");
    }

    /// The third generation, and the one with the most to lose
    /// (myne-md/myne#911 review). Both stamp functions guard against rewriting a
    /// B2B frame through the `NTV5` serializer; a `NTV8` frame carries the same
    /// tail as `NTV6` and `NTV7`, so a stamp that reached the serializer would
    /// drop the group-key wrap and the signed roster, leaving a vault whose
    /// `itemsKey` is group-sealed behind a frame that claims the root tier, which
    /// no unlock path can open.
    ///
    /// **This test is why the `NTV8` arm in `meta_version_of` is safe.** Teaching
    /// that function the new generation (every singleton reader needs it) is what
    /// makes the version check below these guards answer `V0_2` for an `NTV8`
    /// frame; a guard written as "not `NTV6` and not `NTV7`" would then fall
    /// through and downgrade every password-only vault on its first unlock. The
    /// guards ask `has_b2b_tail` instead, and this is the test that fails if
    /// anybody replaces them with a magic list again.
    ///
    /// The fixture is a REAL frame, minted by the app's own person-session
    /// builder. That matters: the first version of this test used a hand-typed
    /// `NTV7` prefix with junk after it, and removing the guard left it green
    /// because the parse failed and the function returned the bytes untouched
    /// for the wrong reason. A fixture that cannot reach the defective state is
    /// not a test.
    #[test]
    fn the_stamp_guards_return_an_ntv8_meta_untouched() {
        use crate::plugins::vault_creation::commands::{
            build_and_serialize_person_vault_meta, build_person_session,
        };
        use crate::plugins::vault_creation::state::CreationPerson;

        const FAST: protocol::KdfParams = protocol::KdfParams {
            m_kib: protocol::MIN_KDF_M_KIB,
            t: 1,
            p: 1,
            argon2_version: 0x13,
        };
        const PHRASE: &str = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";

        let person_id = protocol::kdf::person_id_hash(PHRASE);
        let seed = protocol::kdf::derive_person_identity_seed(PHRASE, &person_id, &FAST)
            .expect("identity seed");
        let seeds = protocol::kdf::expand_person_identity_key_seeds(&seed);
        let session = build_person_session(
            crate::paths::web_single_vault_id(),
            "stamp-guard-fixture-pw",
            FAST,
            CreationPerson {
                pair: protocol::PersonKeyPair::generate_raw(
                    &seeds.kem,
                    &seeds.ed25519,
                    &seeds.mldsa,
                ),
                person_id,
                number: protocol::account_number_from_person_id(&person_id),
            },
        )
        .expect("person session");
        let (bytes, _group) =
            build_and_serialize_person_vault_meta(&session).expect("serialize NTV8");
        assert_eq!(bytes.get(..4), Some(b"NTV8".as_slice()));
        // The premise the guards rest on: this frame is `V0_2` to every
        // version-aware reader, so only a tail-aware guard can stop a rewrite.
        assert_eq!(
            protocol::meta_version_of(&bytes),
            Some(protocol::MetaVersion::V0_2),
            "an NTV8 frame is a v0.2 vault; that is what makes the stamp dangerous"
        );

        let stamped_person =
            stamp_person_binding_field(&[0x11; AEAD_KEY_LEN], &[0x51; 16], &[0x44; 16], &bytes);
        assert_eq!(
            stamped_person, bytes,
            "an NTV8 meta must be returned untouched by the person-binding stamp"
        );
        let stamped_membership = stamp_membership_field(
            &[0x11; AEAD_KEY_LEN],
            &[0xAB; ACCOUNT_ID_LEN],
            &[0x44; 16],
            &bytes,
        );
        assert_eq!(
            stamped_membership, bytes,
            "an NTV8 meta must be returned untouched by the membership stamp"
        );
    }
}
