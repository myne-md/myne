// SPDX-License-Identifier: AGPL-3.0

//! Command bodies for the AI conversations plugin (myne-md/myne#675).
//!
//! Storage pair (§ 9.23 / § 9.24): the `vault.chats` catalog singleton
//! (`MYM1`) holds the roster (one entry per conversation: id, title,
//! timestamps, causal `version`, tombstone) and one `chats/<id-hex>` file
//! (`MYJ1`) per conversation holds the ordered immutable turn list. The
//! catalog is the per-key causal map shape of `themes`; the files are the
//! id-named family shape of `attachments`.
//!
//! Layer shape (see `mod.rs`): `*_with_dir` (testable inner) →
//! `*_from_host` (host → vault dir) → cfg-gated `#[tauri::command]`.
//!
//! Load-bearing divergences from the cosmetic singleton siblings:
//! - **Report-don't-empty** (§ 9.23.3): a catalog read failure is
//!   `CatalogUnreadable`, never an empty map, and a mutation over an
//!   unreadable catalog is REFUSED (the themes #255 discipline) rather than
//!   performed.
//! - **`derive_subkey_versioned`** everywhere (Class-1 synced vault content,
//!   not a migration-dropped cache): the KEKs follow the vault's generation.
//! - **`hooks.bump_local_change()`** after every persisted mutation: both
//!   blobs are synced, so each write opens a push window.

use crate::hooks::Hooks;
use crate::host::HostCtx;
use crate::io_failure_kind::IoFailureKind;
// The Tauri adapter is needed only by the cfg-gated wrappers below, so its
// import is gated the same way (the themes discipline).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
use crate::plugins::chats::error::{ChatsMutateError, ChatsReadError};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::singleton::{open_newest_and_sweep, OpenOutcome};
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::{
    decode_chats_blob_versioned, decode_chats_catalog_blob_versioned, derive_subkey_versioned,
    encode_chats_blob_versioned, encode_chats_catalog_blob_versioned, meta_version_of,
    parse_vault_meta_any, ChatsBlobError, ChatsCatalogError, MetaVersion, SubkeyRole,
    ACCOUNT_NUMBER_HASH_LEN,
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::Mutex;
use uuid::Uuid;
use zeroize::Zeroizing;

/// One catalog row (§ 9.23): the roster entry for a conversation. Field
/// order is the canonical-JSON key order (alphabetical), the `themes`
/// `ThemeEntry` discipline.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConversationEntry {
    pub created_at: u64,
    /// Tombstone marker (§ 9.23 / § 9.24.4 delete-everywhere). When set, the
    /// conversation file is gone and the entry is a deletion record that
    /// syncs (remove-wins over a concurrent append, the § 11.4 rule).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
    pub title: String,
    pub updated_at: u64,
    /// Causal merge counter, the sync race key (§ 11.4 discipline:
    /// `max(observed) + 1` on any mutation of this key; absent ≡ 0).
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub version: u64,
    /// The note this conversation is anchored to, when it is (myne-md/myne#771).
    /// A **field on the existing row, not a new blob family**: the roster already
    /// syncs Class-1, so the Hub can list and link every note-anchored
    /// conversation without reading each conversation file. `None` for a
    /// vault-general conversation.
    ///
    /// **Additive and backward-compatible**: the field is `Option` with
    /// `skip_serializing_if`, so a conversation written before this existed
    /// reads back with `None`, and a reader that does not know the field keeps
    /// the row it already understood. The canonical-JSON key order is
    /// alphabetical (§ 9.23), so `note_id` sorts between `deleted_at` and
    /// `title`; serde emits struct fields in declaration order, and
    /// `serde_json`'s default map is a `BTreeMap`-ordered pass only when the
    /// `preserve_order` feature is off, which is the case here, so the emitted
    /// key order stays canonical whatever this declaration order is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
}

fn is_zero_u64(v: &u64) -> bool {
    *v == 0
}

impl ConversationEntry {
    /// A live (non-tombstone) entry.
    pub fn is_live(&self) -> bool {
        self.deleted_at.is_none()
    }
}

/// One roster row as the list command returns it: the catalog key (the
/// conversation id) plus the entry. The id lives in the KEY on disk
/// (§ 9.23: the roster is a map); duplicating it into the row would store
/// the same bytes twice and invite a key/value mismatch, so the duplication
/// happens here, at the read boundary, and nowhere else.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConversationListRow {
    pub id: String,
    #[serde(flatten)]
    pub entry: ConversationEntry,
}

/// The catalog map: conversation id (hex) → entry. `BTreeMap` for
/// byte-deterministic serialization (id-sorted), the `ThemesMap` discipline.
pub type ChatsCatalogMap = BTreeMap<String, ConversationEntry>;

const CHATS_CATALOG_FILE: &str = "vault.chats";
const CHATS_DIR: &str = "chats";

/// Title derivation (§ 9.24.2): the first user turn's first 48 Unicode
/// scalar values, newlines stripped, no model call. Deterministic so the
/// title can be re-derived and a rename detected as a deliberate divergence
/// (the `title_derived_from` snapshot rides the conversation file).
pub const TITLE_DERIVATION_MAX_USVS: usize = 48;

/// The plugin-wide write mutex (FIFO across all mutations, the themes
/// discipline; the sync phase will hold it too).
pub fn write_mutex() -> std::sync::Arc<Mutex<()>> {
    static WRITE_MUTEX: OnceLock<std::sync::Arc<Mutex<()>>> = OnceLock::new();
    WRITE_MUTEX
        .get_or_init(|| std::sync::Arc::new(Mutex::new(())))
        .clone()
}

// ---------------------------------------------------------------------------
// Shared in_dir helpers
// ---------------------------------------------------------------------------

struct VaultSeal {
    version: MetaVersion,
    hash: [u8; ACCOUNT_NUMBER_HASH_LEN],
    chats_key: Zeroizing<[u8; 32]>,
    chats_catalog_key: Zeroizing<[u8; 32]>,
}

/// Read `vault.meta` and derive both family KEKs, version-stamped (Class-1
/// synced content follows the vault's generation, never bare
/// `derive_subkey`).
async fn seal_from_slot(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<(Zeroizing<[u8; 32]>, VaultSeal), ChatsMutateError> {
    // Design A (myne-md/myne#711 task 28): a MEMBER of a shared vault holds no
    // `root_key`, so the chats family seals under a key derived from the held
    // person-profile key. Private once the blobs live in the `PersonAiFs`
    // container; the owner and single-user vaults are unchanged.
    let seal_key = crate::plugins::sync::person_ai_store::seal_key_from_slot(state)
        .await
        .ok_or(ChatsMutateError::SlotNotUnlocked)?;
    let bytes = io
        .read(&vault_dir.join("vault.meta"))
        .await
        .map_err(io_error)?;
    let version = meta_version_of(&bytes).ok_or(ChatsMutateError::InvalidVaultMeta)?;
    let meta = parse_vault_meta_any(&bytes).map_err(|_| ChatsMutateError::InvalidVaultMeta)?;
    let seal = VaultSeal {
        version,
        hash: meta.account_number_hash,
        chats_key: derive_subkey_versioned(version, &seal_key, SubkeyRole::ChatsKey),
        chats_catalog_key: derive_subkey_versioned(version, &seal_key, SubkeyRole::ChatsCatalogKey),
    };
    Ok((seal_key, seal))
}

fn io_error(e: IoFailureKind) -> ChatsMutateError {
    ChatsMutateError::Io { io_error_kind: e }
}

/// Resolve the active vault's root directory from the host (the shared
/// plugin-local helper shape; `active_vault_root_io_from_host` handles the
/// picker/legacy fallbacks).
fn vault_dir_from_host(
    host: &dyn HostCtx,
    active_id: Option<crate::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    crate::paths::active_vault_root_io_from_host(host, active_id)
}

/// Read the catalog map from disk. `Absent` → empty map (§ 9.23's
/// no-file-is-no-conversations rule); `Undecodable`/`Io` → the honest error.
async fn read_catalog_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    seal: &VaultSeal,
) -> Result<ChatsCatalogMap, ChatsReadError> {
    let path = vault_dir.join(CHATS_CATALOG_FILE);
    let decode = |bytes: &[u8]| -> Result<ChatsCatalogMap, ChatsCatalogError> {
        let plaintext = decode_chats_catalog_blob_versioned(
            seal.version,
            &seal.chats_catalog_key,
            &seal.hash,
            bytes,
        )?;
        serde_json::from_slice(&plaintext).map_err(|_| ChatsCatalogError::CannotDecrypt)
    };
    match open_newest_and_sweep(io, &path, decode).await {
        Ok(map) => Ok(map),
        Err(OpenOutcome::Absent) => Ok(ChatsCatalogMap::default()),
        Err(OpenOutcome::Undecodable(_)) => Err(ChatsReadError::CatalogUnreadable),
        Err(OpenOutcome::Io(e)) => Err(ChatsReadError::Io { io_error_kind: e }),
    }
}

/// Read the catalog for a mutation: an unreadable store REFUSES the mutation
/// (refuse-don't-wipe, the themes #255 discipline applied to § 9.23.3).
async fn load_catalog_for_mutation(
    io: &dyn VaultIo,
    vault_dir: &Path,
    seal: &VaultSeal,
) -> Result<ChatsCatalogMap, ChatsMutateError> {
    match read_catalog_in_dir(io, vault_dir, seal).await {
        Ok(map) => Ok(map),
        Err(ChatsReadError::CatalogUnreadable) => Err(ChatsMutateError::CatalogUnreadable),
        Err(ChatsReadError::Io { io_error_kind }) => Err(ChatsMutateError::Io { io_error_kind }),
        Err(_) => Err(ChatsMutateError::InvalidVaultMeta),
    }
}

/// Serialize + seal + write the catalog map. An empty map removes the file
/// (the omit-when-empty file rule, § 9.23); tombstones keep it non-empty.
async fn write_catalog_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    map: &ChatsCatalogMap,
    seal: &VaultSeal,
) -> Result<(), ChatsMutateError> {
    let path = vault_dir.join(CHATS_CATALOG_FILE);
    if map.is_empty() {
        // The single representation of "no conversations" is no file.
        match io.remove_file(&path).await {
            Ok(()) | Err(IoFailureKind::NotFound) => Ok(()),
            Err(e) => Err(ChatsMutateError::Io { io_error_kind: e }),
        }
    } else {
        let plaintext =
            serde_json::to_vec(map).map_err(|_| ChatsMutateError::InvalidTurnPayload)?;
        let blob = encode_chats_catalog_blob_versioned(
            seal.version,
            &seal.chats_catalog_key,
            &seal.hash,
            &plaintext,
        )
        .map_err(map_catalog_error)?;
        io.write(&path, &blob, WriteOpts::default())
            .await
            .map_err(io_error)
    }
}

fn conversation_path(vault_dir: &Path, conversation_id_hex: &str) -> PathBuf {
    vault_dir.join(CHATS_DIR).join(conversation_id_hex)
}

/// Seal + write one conversation file (the § 9.24 payload verbatim: the host
/// owns the canonical turn-list JSON).
async fn write_conversation_file(
    io: &dyn VaultIo,
    vault_dir: &Path,
    conversation_id: &[u8; 16],
    seal: &VaultSeal,
    plaintext: &[u8],
) -> Result<(), ChatsMutateError> {
    let blob = encode_chats_blob_versioned(
        seal.version,
        &seal.chats_key,
        &seal.hash,
        conversation_id,
        plaintext,
    )
    .map_err(map_chats_blob_error)?;
    let dir = vault_dir.join(CHATS_DIR);
    io.create_dir_all(&dir).await.map_err(io_error)?;
    let path = conversation_path(vault_dir, &hex_encode_16(conversation_id));
    io.write(&path, &blob, WriteOpts::default())
        .await
        .map_err(io_error)
}

/// Read one conversation's turn-list plaintext. Every failure (absent under
/// a live row, magic/version/AEAD/cap) collapses to
/// `ConversationUnreadable` (§ 9.24.4; the catalog row is NOT dropped in
/// response; the caller knows which conversation it asked for).
async fn read_conversation_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    conversation_id_hex: &str,
    seal: &VaultSeal,
) -> Result<Zeroizing<Vec<u8>>, ChatsReadError> {
    let unreadable = || ChatsReadError::ConversationUnreadable;
    let id_bytes = hex_decode_16(conversation_id_hex).ok_or_else(unreadable)?;
    let path = conversation_path(vault_dir, conversation_id_hex);
    let bytes = io
        .read(&path)
        .await
        .map_err(|io_error_kind| ChatsReadError::Io { io_error_kind })?;
    decode_chats_blob_versioned(seal.version, &seal.chats_key, &seal.hash, &id_bytes, &bytes)
        .map_err(|_| unreadable())
}

/// Hex helpers (the attachments discipline: lowercase, no separators,
/// validated length).
fn hex_encode_16(bytes: &[u8; 16]) -> String {
    let mut s = String::with_capacity(32);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn hex_decode_16(s: &str) -> Option<[u8; 16]> {
    // Lowercase-only, matching `from_hex16` (sync orchestrator), `is_32_hex`
    // (double_buffer) and `is_lower_hex` (backup classifier): conversation ids
    // are minted lowercase, so an uppercase id decodes nowhere. Divergent
    // strictness here would decode in chats commands what the sync scan and
    // the container classifier skip.
    if s.len() != 32
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, pair) in s.as_bytes().chunks(2).enumerate() {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out[i] = (hi * 16 + lo) as u8;
    }
    Some(out)
}

/// Validate that a turn payload is a legal conversation inner plaintext: a
/// JSON object carrying the § 9.24.2 `turns` array. The host refuses a
/// malformed turn rather than persisting it.
fn validate_turn_payload(payload: &str) -> Result<(), ChatsMutateError> {
    let v: serde_json::Value =
        serde_json::from_str(payload).map_err(|_| ChatsMutateError::InvalidTurnPayload)?;
    match v {
        serde_json::Value::Object(map) if map.contains_key("turns") => Ok(()),
        _ => Err(ChatsMutateError::InvalidTurnPayload),
    }
}

fn map_chats_blob_error(e: ChatsBlobError) -> ChatsMutateError {
    match e {
        ChatsBlobError::PlaintextTooLarge => ChatsMutateError::PayloadTooLarge,
        ChatsBlobError::RandomnessUnavailable => ChatsMutateError::RandomnessUnavailable,
        _ => ChatsMutateError::InvalidTurnPayload,
    }
}

fn map_catalog_error(e: ChatsCatalogError) -> ChatsMutateError {
    match e {
        ChatsCatalogError::PlaintextTooLarge => ChatsMutateError::PayloadTooLarge,
        ChatsCatalogError::RandomnessUnavailable => ChatsMutateError::RandomnessUnavailable,
        _ => ChatsMutateError::CatalogUnreadable,
    }
}

/// Extract the first turn's text from the turn-list payload and derive the
/// title (first 48 USVs of the first user turn, newlines stripped, § 9.24.2;
/// no model call).
fn derive_title(payload: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let text = v
        .get("turns")
        .and_then(|t| t.get(0))
        .and_then(|turn| turn.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    title_from_text(text)
}

fn title_from_text(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if ch == '\n' || ch == '\r' {
            continue;
        }
        if out.chars().count() >= TITLE_DERIVATION_MAX_USVS {
            break;
        }
        out.push(ch);
    }
    out
}

// ---------------------------------------------------------------------------
// chats_create
// ---------------------------------------------------------------------------

/// Create a conversation: mint the id (UUIDv7, time-ordered like note ids),
/// derive the title from the first user turn, write the turn list, add the
/// catalog row. Returns the new conversation id (hex).
///
/// File-first, matching the attachment commit (blob before catalog row): a
/// catalog-write ERROR removes the just-written file below, so no error path
/// leaves an orphan. A CRASH between the two writes still can (no cross-file
/// atomicity anywhere in this tree): the orphan file is unrowed, hence
/// unlisted, unpushed and unswept, and the next create mints past it.
/// Accepted like the attachment twin, and the milder half of the two crash
/// orders: a row-first crash would leave a VISIBLE broken row that syncs
/// cluster-wide, while a file-first crash leaves bytes nothing names.
pub async fn chats_create_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    first_turn_payload: &str,
    now_unix_millis: u64,
    requested_id_hex: Option<&str>,
    note_id: Option<&str>,
) -> Result<String, ChatsMutateError> {
    let _guard = lock_write().await;
    validate_turn_payload(first_turn_payload)?;
    let (root_key, seal) = seal_from_slot(io, vault_dir, state).await?;
    let map = load_catalog_for_mutation(io, vault_dir, &seal).await?;

    // Idempotent create: a retry of a create whose response was lost carries
    // the same client-minted id and adopts the existing row instead of
    // minting a second conversation with identical turns.
    if let Some(wanted) = requested_id_hex {
        let wanted_id = hex_decode_16(wanted).ok_or(ChatsMutateError::ConversationNotFound)?;
        if map.contains_key(wanted) {
            return Ok(wanted.to_string());
        }
        return create_with_id(
            io,
            vault_dir,
            hooks,
            root_key,
            seal,
            map,
            wanted_id,
            wanted.to_string(),
            first_turn_payload,
            now_unix_millis,
            note_id,
        )
        .await;
    }

    let conversation_id = Uuid::now_v7();
    let conversation_id_hex = hex_encode_16(conversation_id.as_bytes());
    create_with_id(
        io,
        vault_dir,
        hooks,
        root_key,
        seal,
        map,
        *conversation_id.as_bytes(),
        conversation_id_hex,
        first_turn_payload,
        now_unix_millis,
        note_id,
    )
    .await
}

/// Shared create body: write the file, then the catalog row (file-first so a
/// catalog-write failure cannot leave an orphan no roster names).
#[allow(clippy::too_many_arguments)]
async fn create_with_id(
    io: &dyn VaultIo,
    vault_dir: &Path,
    hooks: &Hooks,
    root_key: Zeroizing<[u8; 32]>,
    seal: VaultSeal,
    map: ChatsCatalogMap,
    conversation_id: [u8; 16],
    conversation_id_hex: String,
    first_turn_payload: &str,
    now_unix_millis: u64,
    note_id: Option<&str>,
) -> Result<String, ChatsMutateError> {
    let title = derive_title(first_turn_payload);

    write_conversation_file(
        io,
        vault_dir,
        &conversation_id,
        &seal,
        first_turn_payload.as_bytes(),
    )
    .await?;

    let mut next = map;
    next.insert(
        conversation_id_hex.clone(),
        ConversationEntry {
            created_at: now_unix_millis,
            deleted_at: None,
            title,
            updated_at: now_unix_millis,
            version: 1,
            note_id: note_id.map(|s| s.to_string()),
        },
    );
    // The file is on disk before its catalog row: a catalog-write failure
    // must not leave an orphan no roster names (unlisted by `chats_list`,
    // unpushed by sync, re-minted past on every retry). Best-effort removal
    // of the just-written file, mirroring `atomic_write`'s
    // failed-write-leaves-no-stray-temp contract; the removal's own failure
    // is ignored (the error below is the one that matters).
    if let Err(e) = write_catalog_in_dir(io, vault_dir, &next, &seal).await {
        let _ = io
            .remove_file(&conversation_path(vault_dir, &conversation_id_hex))
            .await;
        return Err(e);
    }
    drop(root_key);
    hooks.bump_local_change();
    Ok(conversation_id_hex)
}

async fn lock_write() -> tokio::sync::OwnedMutexGuard<()> {
    // An async mutex (the themes discipline): the guard is held across every
    // `.await` of the mutation, which a std MutexGuard cannot be.
    write_mutex().lock_owned().await
}

// ---------------------------------------------------------------------------
// chats_append_turn (the finalize-time write path, § 9.24.4)
// ---------------------------------------------------------------------------

/// Write a settled conversation state: the full current turn list (turns are
/// immutable once settled, so the host sends the authoritative list), bump
/// the catalog row's `version` + `updated_at`. Called when a turn settles
/// (text finalize, agent settle, failure, interrupted-stream partial text).
pub async fn chats_append_turn_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    conversation_id_hex: &str,
    turns_payload: &str,
    now_unix_millis: u64,
) -> Result<(), ChatsMutateError> {
    let _guard = lock_write().await;
    validate_turn_payload(turns_payload)?;
    let (root_key, seal) = seal_from_slot(io, vault_dir, state).await?;
    let map = load_catalog_for_mutation(io, vault_dir, &seal).await?;
    let entry = live_entry(&map, conversation_id_hex)?;
    let bumped_version = entry.version + 1;
    let conversation_id =
        hex_decode_16(conversation_id_hex).ok_or(ChatsMutateError::ConversationNotFound)?;

    write_conversation_file(
        io,
        vault_dir,
        &conversation_id,
        &seal,
        turns_payload.as_bytes(),
    )
    .await?;

    let mut next = map;
    next.entry(conversation_id_hex.to_string()).and_modify(|e| {
        e.version = bumped_version;
        e.updated_at = now_unix_millis;
    });
    write_catalog_in_dir(io, vault_dir, &next, &seal).await?;
    drop(root_key);
    hooks.bump_local_change();
    Ok(())
}

fn live_entry<'a>(
    map: &'a ChatsCatalogMap,
    conversation_id_hex: &str,
) -> Result<&'a ConversationEntry, ChatsMutateError> {
    let entry = map
        .get(conversation_id_hex)
        .ok_or(ChatsMutateError::ConversationNotFound)?;
    if entry.deleted_at.is_some() {
        return Err(ChatsMutateError::ConversationNotFound);
    }
    Ok(entry)
}

// ---------------------------------------------------------------------------
// chats_read / chats_list
// ---------------------------------------------------------------------------

/// Read one conversation's canonical turn-list payload (the host-layer JSON
/// string it sealed).
///
/// Consults catalog liveness first: a tombstoned row (or no row) answers
/// `ConversationNotFound` even when the file bytes are still on disk (a
/// tombstone merge whose local file erase failed must not leave the deleted
/// conversation readable by id).
pub async fn chats_read_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    conversation_id_hex: &str,
) -> Result<String, ChatsReadError> {
    let (_, seal) = seal_from_slot_for_read(io, vault_dir, state).await?;
    let map = read_catalog_in_dir(io, vault_dir, &seal).await?;
    match map.get(conversation_id_hex) {
        Some(entry) if entry.deleted_at.is_none() => {}
        _ => return Err(ChatsReadError::ConversationNotFound),
    }
    let plaintext = read_conversation_in_dir(io, vault_dir, conversation_id_hex, &seal).await?;
    Ok(String::from_utf8_lossy(&plaintext).into_owned())
}

async fn seal_from_slot_for_read(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<(Zeroizing<[u8; 32]>, VaultSeal), ChatsReadError> {
    let seal_key = crate::plugins::sync::person_ai_store::seal_key_from_slot(state)
        .await
        .ok_or(ChatsReadError::SlotNotUnlocked)?;
    let bytes = io
        .read(&vault_dir.join("vault.meta"))
        .await
        .map_err(|io_error_kind| ChatsReadError::Io { io_error_kind })?;
    let version = meta_version_of(&bytes).ok_or(ChatsReadError::InvalidVaultMeta)?;
    let meta = parse_vault_meta_any(&bytes).map_err(|_| ChatsReadError::InvalidVaultMeta)?;
    let seal = VaultSeal {
        version,
        hash: meta.account_number_hash,
        chats_key: derive_subkey_versioned(version, &seal_key, SubkeyRole::ChatsKey),
        chats_catalog_key: derive_subkey_versioned(version, &seal_key, SubkeyRole::ChatsCatalogKey),
    };
    Ok((seal_key, seal))
}

/// List the roster: live entries ordered by `updated_at` descending (the
/// conversation-list order). Tombstones are excluded from the UI list.
pub async fn chats_list_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<Vec<ConversationListRow>, ChatsReadError> {
    let (_, seal) = seal_from_slot_for_read(io, vault_dir, state).await?;
    let map = read_catalog_in_dir(io, vault_dir, &seal).await?;
    let mut rows: Vec<ConversationListRow> = map
        .into_iter()
        .filter(|(_, e)| e.is_live())
        .map(|(id, entry)| ConversationListRow { id, entry })
        .collect();
    rows.sort_by_key(|b| std::cmp::Reverse(b.entry.updated_at));
    Ok(rows)
}

// ---------------------------------------------------------------------------
// chats_rename
// ---------------------------------------------------------------------------

/// Rename a conversation: a catalog-row mutation (bumps `version` +
/// `updated_at`; the conversation file is untouched (its
/// `title_derived_from` snapshot is what a rename diverges from).
pub async fn chats_rename_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    conversation_id_hex: &str,
    new_title: &str,
    now_unix_millis: u64,
) -> Result<(), ChatsMutateError> {
    let _guard = lock_write().await;
    let (root_key, seal) = seal_from_slot(io, vault_dir, state).await?;
    let map = load_catalog_for_mutation(io, vault_dir, &seal).await?;
    let entry = live_entry(&map, conversation_id_hex)?;
    let bumped = entry.version + 1;
    let mut next = map;
    next.entry(conversation_id_hex.to_string()).and_modify(|e| {
        e.title = new_title.to_string();
        e.version = bumped;
        e.updated_at = now_unix_millis;
    });
    write_catalog_in_dir(io, vault_dir, &next, &seal).await?;
    drop(root_key);
    hooks.bump_local_change();
    Ok(())
}

// ---------------------------------------------------------------------------
// chats_delete (tombstone, § 9.24.4 delete-everywhere)
// ---------------------------------------------------------------------------

/// Delete a conversation everywhere: mark the catalog row as a tombstone
/// (`deleted_at` + version bump), remove the conversation file. The
/// tombstone is what syncs (remove-wins over a concurrent append, § 11.4).
/// Deleting a tombstoned conversation is an idempotent success.
pub async fn chats_delete_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    conversation_id_hex: &str,
    now_unix_millis: u64,
) -> Result<(), ChatsMutateError> {
    let _guard = lock_write().await;
    let (root_key, seal) = seal_from_slot(io, vault_dir, state).await?;
    let map = load_catalog_for_mutation(io, vault_dir, &seal).await?;
    let entry = match map.get(conversation_id_hex) {
        Some(e) if e.deleted_at.is_some() => return Ok(()), // idempotent
        Some(e) => e,
        None => return Err(ChatsMutateError::ConversationNotFound),
    };
    let bumped = entry.version + 1;
    let mut next = map;
    next.entry(conversation_id_hex.to_string()).and_modify(|e| {
        e.deleted_at = Some(now_unix_millis);
        e.version = bumped;
        e.updated_at = now_unix_millis;
    });

    // Tombstone FIRST, file second: a crash between the two must leave a
    // hidden row plus an orphan file (which the pull loop already erases),
    // never a live row with no body (which the sync layer cannot repair: the
    // push loop skips absent files and no remote arm reconciles it).
    write_catalog_in_dir(io, vault_dir, &next, &seal).await?;

    // Queue the server-side tombstone so the next push reclaims the server
    // copy instead of orphaning it. Best-effort: a queue failure must not
    // fail the delete itself (the catalog tombstone already propagated the
    // deletion to every device; only the server reclaim is at stake).
    if let Some(conv_id) = hex_decode_16(conversation_id_hex) {
        let _ = add_pending_chats_tombstone(io, vault_dir, &conv_id).await;
    }

    // Remove the conversation file (the tombstone stays in the catalog).
    let path = conversation_path(vault_dir, conversation_id_hex);
    match io.remove_file(&path).await {
        Ok(()) | Err(IoFailureKind::NotFound) => {}
        Err(e) => return Err(ChatsMutateError::Io { io_error_kind: e }),
    }

    drop(root_key);
    hooks.bump_local_change();
    Ok(())
}

// ---------------------------------------------------------------------------
// pending-chats-tombstones: server-side reclaim for deleted conversations
// ---------------------------------------------------------------------------

/// The device-local "this conversation id is tombstoned server-side" queue:
/// conversation ids (32-hex) the delete path tombstoned, so the next push
/// sets the server's tombstone flag (horizon-GC). Without it the catalog
/// tombstone erases every device copy while the server ciphertext is
/// orphaned permanently: never downloaded (no catalog row names it), never
/// classified as dropped, never deleted. `<vault>/pending-chats-tombstones`,
/// newline-separated `"<conv-id-hex> <fresh-nonce-hex>"`. The fresh random
/// nonce becomes the tombstone record's `content_nonce` (a visible change on
/// the blob plane). Mirrors the attachment-tombstone queue shape.
fn pending_chats_tombstones_path(vault_root: &Path) -> PathBuf {
    vault_root.join("pending-chats-tombstones")
}

/// One queued conversation tombstone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingChatsTombstone {
    /// The 16-byte conversation id (blob-plane key).
    pub conv_id: [u8; 16],
    /// The fresh tombstone `content_nonce`.
    pub content_nonce: [u8; 24],
}

/// Read the pending conversation-tombstone queue (absent → empty; a malformed
/// line is skipped rather than wedging the cycle).
pub async fn read_pending_chats_tombstones(
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Vec<PendingChatsTombstone> {
    let Some(body) = io
        .read(&pending_chats_tombstones_path(vault_root))
        .await
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in body.lines() {
        let mut parts = line.split_whitespace();
        let (Some(c), Some(n)) = (parts.next(), parts.next()) else {
            continue;
        };
        let (Some(conv_id), Some(content_nonce)) = (hex_decode_16(c), hex_decode_24(n)) else {
            continue;
        };
        out.push(PendingChatsTombstone {
            conv_id,
            content_nonce,
        });
    }
    out
}

/// Queue a conversation deletion for the next push (called by the delete path
/// right after the catalog-tombstone rewrite). Mints the fresh tombstone
/// nonce internally. Idempotent per conversation id.
pub async fn add_pending_chats_tombstone(
    io: &dyn VaultIo,
    vault_root: &Path,
    conv_id: &[u8; 16],
) -> Result<(), IoFailureKind> {
    let mut queue = read_pending_chats_tombstones(io, vault_root).await;
    if queue.iter().any(|t| &t.conv_id == conv_id) {
        return Ok(());
    }
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|_| IoFailureKind::Other)?;
    queue.push(PendingChatsTombstone {
        conv_id: *conv_id,
        content_nonce: nonce,
    });
    write_pending_chats_tombstones(io, vault_root, &queue).await
}

/// Drop queue entries (after their tombstone records pushed, or when a re-add
/// made them stale).
pub async fn clear_pending_chats_tombstones(
    io: &dyn VaultIo,
    vault_root: &Path,
    drop_ids: &[[u8; 16]],
) -> Result<(), IoFailureKind> {
    if drop_ids.is_empty() {
        return Ok(());
    }
    let queue: Vec<PendingChatsTombstone> = read_pending_chats_tombstones(io, vault_root)
        .await
        .into_iter()
        .filter(|t| !drop_ids.contains(&t.conv_id))
        .collect();
    write_pending_chats_tombstones(io, vault_root, &queue).await
}

async fn write_pending_chats_tombstones(
    io: &dyn VaultIo,
    vault_root: &Path,
    queue: &[PendingChatsTombstone],
) -> Result<(), IoFailureKind> {
    let mut lines: Vec<String> = queue
        .iter()
        .map(|t| {
            format!(
                "{} {}",
                hex_encode_16(&t.conv_id),
                hex_encode_24(&t.content_nonce)
            )
        })
        .collect();
    lines.sort();
    let body = if lines.is_empty() {
        Vec::new()
    } else {
        format!("{}\n", lines.join("\n")).into_bytes()
    };
    io.write(
        &pending_chats_tombstones_path(vault_root),
        &body,
        WriteOpts::default(),
    )
    .await
}

fn hex_decode_24(s: &str) -> Option<[u8; 24]> {
    if s.len() != 48
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut out = [0u8; 24];
    for (i, pair) in s.as_bytes().chunks(2).enumerate() {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out[i] = (hi * 16 + lo) as u8;
    }
    Some(out)
}

fn hex_encode_24(bytes: &[u8; 24]) -> String {
    let mut s = String::with_capacity(48);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

// ---------------------------------------------------------------------------
// from_host + cfg-gated Tauri wrappers
// ---------------------------------------------------------------------------

pub async fn chats_create_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    first_turn_payload: &str,
    requested_id_hex: Option<&str>,
    note_id: Option<&str>,
) -> Result<String, ChatsMutateError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(ChatsMutateError::from)?;
    let now = host.now_unix_millis();
    // Design A (task 28): a member's conversations live person-privately.
    if crate::plugins::sync::person_ai_store::person_ai_is_private(state).await {
        let _guard = crate::plugins::sync::person_ai_store::lock_write().await;
        let fs = crate::plugins::sync::person_ai_store::open_for_active(io, &dir, state)
            .await
            .map_err(|_| ChatsMutateError::CatalogUnreadable)?;
        return chats_create_with_dir(
            &fs,
            &dir,
            state,
            hooks,
            first_turn_payload,
            now,
            requested_id_hex,
            note_id,
        )
        .await;
    }
    chats_create_with_dir(
        io,
        &dir,
        state,
        hooks,
        first_turn_payload,
        now,
        requested_id_hex,
        note_id,
    )
    .await
}

pub async fn chats_append_turn_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    conversation_id_hex: &str,
    turns_payload: &str,
) -> Result<(), ChatsMutateError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(ChatsMutateError::from)?;
    let now = host.now_unix_millis();
    if crate::plugins::sync::person_ai_store::person_ai_is_private(state).await {
        let _guard = crate::plugins::sync::person_ai_store::lock_write().await;
        let fs = crate::plugins::sync::person_ai_store::open_for_active(io, &dir, state)
            .await
            .map_err(|_| ChatsMutateError::CatalogUnreadable)?;
        return chats_append_turn_with_dir(
            &fs,
            &dir,
            state,
            hooks,
            conversation_id_hex,
            turns_payload,
            now,
        )
        .await;
    }
    chats_append_turn_with_dir(
        io,
        &dir,
        state,
        hooks,
        conversation_id_hex,
        turns_payload,
        now,
    )
    .await
}

pub async fn chats_read_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    conversation_id_hex: &str,
) -> Result<String, ChatsReadError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(ChatsReadError::from)?;
    if crate::plugins::sync::person_ai_store::person_ai_is_private(state).await {
        let fs = crate::plugins::sync::person_ai_store::open_for_active(io, &dir, state)
            .await
            .map_err(|_| ChatsReadError::CatalogUnreadable)?;
        return chats_read_with_dir(&fs, &dir, state, conversation_id_hex).await;
    }
    chats_read_with_dir(io, &dir, state, conversation_id_hex).await
}

pub async fn chats_list_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<Vec<ConversationListRow>, ChatsReadError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(ChatsReadError::from)?;
    if crate::plugins::sync::person_ai_store::person_ai_is_private(state).await {
        let fs = crate::plugins::sync::person_ai_store::open_for_active(io, &dir, state)
            .await
            .map_err(|_| ChatsReadError::CatalogUnreadable)?;
        return chats_list_with_dir(&fs, &dir, state).await;
    }
    chats_list_with_dir(io, &dir, state).await
}

pub async fn chats_rename_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    conversation_id_hex: &str,
    new_title: &str,
) -> Result<(), ChatsMutateError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(ChatsMutateError::from)?;
    let now = host.now_unix_millis();
    if crate::plugins::sync::person_ai_store::person_ai_is_private(state).await {
        let _guard = crate::plugins::sync::person_ai_store::lock_write().await;
        let fs = crate::plugins::sync::person_ai_store::open_for_active(io, &dir, state)
            .await
            .map_err(|_| ChatsMutateError::CatalogUnreadable)?;
        return chats_rename_with_dir(&fs, &dir, state, hooks, conversation_id_hex, new_title, now)
            .await;
    }
    chats_rename_with_dir(io, &dir, state, hooks, conversation_id_hex, new_title, now).await
}

pub async fn chats_delete_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    conversation_id_hex: &str,
) -> Result<(), ChatsMutateError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(ChatsMutateError::from)?;
    let now = host.now_unix_millis();
    if crate::plugins::sync::person_ai_store::person_ai_is_private(state).await {
        let _guard = crate::plugins::sync::person_ai_store::lock_write().await;
        let fs = crate::plugins::sync::person_ai_store::open_for_active(io, &dir, state)
            .await
            .map_err(|_| ChatsMutateError::CatalogUnreadable)?;
        return chats_delete_with_dir(&fs, &dir, state, hooks, conversation_id_hex, now).await;
    }
    chats_delete_with_dir(io, &dir, state, hooks, conversation_id_hex, now).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn chats_create<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, Hooks>,
    first_turn_payload: String,
    requested_id_hex: Option<String>,
    note_id: Option<String>,
) -> Result<String, ChatsMutateError> {
    chats_create_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        &first_turn_payload,
        requested_id_hex.as_deref(),
        note_id.as_deref(),
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn chats_append_turn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, Hooks>,
    conversation_id_hex: String,
    turns_payload: String,
) -> Result<(), ChatsMutateError> {
    chats_append_turn_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        &conversation_id_hex,
        &turns_payload,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn chats_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    conversation_id_hex: String,
) -> Result<String, ChatsReadError> {
    chats_read_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        &conversation_id_hex,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn chats_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<ConversationListRow>, ChatsReadError> {
    chats_list_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn chats_rename<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, Hooks>,
    conversation_id_hex: String,
    new_title: String,
) -> Result<(), ChatsMutateError> {
    chats_rename_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        &conversation_id_hex,
        &new_title,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn chats_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, Hooks>,
    conversation_id_hex: String,
) -> Result<(), ChatsMutateError> {
    chats_delete_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        &conversation_id_hex,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::NoopHooks;
    use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
    use crate::test_support::ScopedTempDir;
    use crate::vault_io::StdVaultIo;

    const ROOT_BYTE: u8 = 0x42;
    const HASH_BYTE: u8 = 0x99;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
    }

    fn seed_real_vault_meta(dir: &Path, seed_byte: u8) {
        let meta = protocol::VaultMeta {
            account_number_hash: [seed_byte; ACCOUNT_NUMBER_HASH_LEN],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [7u8; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
            membership: None,
            person_binding: None,
        };
        std::fs::write(
            dir.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed vault.meta");
    }

    async fn unlocked_vault() -> (ScopedTempDir, VaultRuntimeState) {
        let tmp = ScopedTempDir::new("chats-it").expect("scoped tempdir");
        seed_real_vault_meta(tmp.path(), HASH_BYTE);
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(ROOT_BYTE, 0x11, 1),
            )
            .await;
        (tmp, state)
    }

    const FIRST_TURN: &str = r#"{"turns":[{"id":"c1-1","kind":"text","role":"user","text":"Help me summarize the tax folder"}]}"#;

    #[test]
    fn create_list_read_round_trip() {
        let (tmp, state) = rt().block_on(unlocked_vault());
        let hooks: Hooks = std::sync::Arc::new(NoopHooks);
        let id = rt()
            .block_on(chats_create_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                FIRST_TURN,
                1_000,
                None,
                None,
            ))
            .expect("create");
        // 32-char lowercase hex UUIDv7.
        assert_eq!(id.len(), 32);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));

        let rows = rt()
            .block_on(chats_list_with_dir(&StdVaultIo, tmp.path(), &state))
            .expect("list");
        assert_eq!(rows.len(), 1);
        // Title derived from the first user turn: first 48 USVs, no model call.
        assert_eq!(rows[0].entry.title, "Help me summarize the tax folder");
        assert_eq!(rows[0].entry.created_at, 1_000);
        assert_eq!(rows[0].entry.version, 1);

        let payload = rt()
            .block_on(chats_read_with_dir(&StdVaultIo, tmp.path(), &state, &id))
            .expect("read");
        assert!(payload.contains("tax folder"));
    }

    #[test]
    fn create_with_requested_id_is_idempotent() {
        // A retry of a create whose response was lost carries the same
        // client-minted id and adopts the existing row instead of minting a
        // duplicate conversation with identical turns.
        let (tmp, state) = rt().block_on(unlocked_vault());
        let hooks: Hooks = std::sync::Arc::new(NoopHooks);
        let wanted = "0190a00000007000800000000000000b";
        let first = rt()
            .block_on(chats_create_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                FIRST_TURN,
                1_000,
                Some(wanted),
                None,
            ))
            .expect("create");
        assert_eq!(first, wanted);
        let second = rt()
            .block_on(chats_create_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                FIRST_TURN,
                1_000,
                Some(wanted),
                None,
            ))
            .expect("retry adopts");
        assert_eq!(second, wanted);
        let rows = rt()
            .block_on(chats_list_with_dir(&StdVaultIo, tmp.path(), &state))
            .expect("list");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn title_derivation_strips_newlines_and_caps_at_48() {
        let long = "a\nb\r\nc".to_string() + &"x".repeat(80);
        let payload = {
            let turns =
                serde_json::json!([{ "id": "t1", "kind": "text", "role": "user", "text": long }]);
            serde_json::to_string(&serde_json::json!({ "turns": turns })).unwrap()
        };
        let title = derive_title(&payload);
        assert_eq!(title.chars().count(), TITLE_DERIVATION_MAX_USVS);
        assert!(!title.contains('\n'));
        assert!(!title.contains('\r'));
        assert!(title.starts_with("abc"));
    }

    #[test]
    fn append_bumps_version_and_updated_at() {
        let (tmp, state) = rt().block_on(unlocked_vault());
        let hooks: Hooks = std::sync::Arc::new(NoopHooks);
        let id = rt()
            .block_on(chats_create_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                FIRST_TURN,
                1_000,
                None,
                None,
            ))
            .expect("create");
        let second = r#"{"turns":[{"id":"c1-1","kind":"text","role":"user","text":"q"},{"id":"c1-2","kind":"text","role":"assistant","text":"a"}]}"#;
        rt().block_on(chats_append_turn_with_dir(
            &StdVaultIo,
            tmp.path(),
            &state,
            &hooks,
            &id,
            second,
            2_000,
        ))
        .expect("append");
        let rows = rt()
            .block_on(chats_list_with_dir(&StdVaultIo, tmp.path(), &state))
            .expect("list");
        assert_eq!(rows[0].entry.version, 2);
        assert_eq!(rows[0].entry.updated_at, 2_000);
        let payload = rt()
            .block_on(chats_read_with_dir(&StdVaultIo, tmp.path(), &state, &id))
            .expect("read");
        assert!(payload.contains("c1-2"));
    }

    #[test]
    fn delete_tombstones_and_removes_file_idempotent() {
        let (tmp, state) = rt().block_on(unlocked_vault());
        let hooks: Hooks = std::sync::Arc::new(NoopHooks);
        let id = rt()
            .block_on(chats_create_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                FIRST_TURN,
                1_000,
                None,
                None,
            ))
            .expect("create");
        assert!(tmp.path().join("chats").join(&id).exists());
        rt().block_on(chats_delete_with_dir(
            &StdVaultIo,
            tmp.path(),
            &state,
            &hooks,
            &id,
            3_000,
        ))
        .expect("delete");
        // File gone, catalog row is a tombstone (list excludes it).
        assert!(!tmp.path().join("chats").join(&id).exists());
        let rows = rt()
            .block_on(chats_list_with_dir(&StdVaultIo, tmp.path(), &state))
            .expect("list");
        assert!(rows.is_empty());
        // The catalog file still exists (the tombstone is in it).
        assert!(tmp.path().join("vault.chats").exists());
        // Idempotent: deleting a tombstone succeeds without error.
        rt().block_on(chats_delete_with_dir(
            &StdVaultIo,
            tmp.path(),
            &state,
            &hooks,
            &id,
            4_000,
        ))
        .expect("idempotent delete");
        // And appending to a tombstoned conversation is refused.
        let second = r#"{"turns":[{"id":"c1-9","kind":"text","role":"user","text":"z"}]}"#;
        let err = rt()
            .block_on(chats_append_turn_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                &id,
                second,
                5_000,
            ))
            .unwrap_err();
        assert!(matches!(err, ChatsMutateError::ConversationNotFound));
    }

    #[test]
    fn rename_bumps_and_reads_back() {
        let (tmp, state) = rt().block_on(unlocked_vault());
        let hooks: Hooks = std::sync::Arc::new(NoopHooks);
        let id = rt()
            .block_on(chats_create_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                FIRST_TURN,
                1_000,
                None,
                None,
            ))
            .expect("create");
        rt().block_on(chats_rename_with_dir(
            &StdVaultIo,
            tmp.path(),
            &state,
            &hooks,
            &id,
            "Taxes 2026",
            2_000,
        ))
        .expect("rename");
        let rows = rt()
            .block_on(chats_list_with_dir(&StdVaultIo, tmp.path(), &state))
            .expect("list");
        assert_eq!(rows[0].entry.title, "Taxes 2026");
        assert_eq!(rows[0].entry.version, 2);
    }

    #[test]
    fn corrupted_catalog_read_is_reported_not_emptied() {
        let (tmp, state) = rt().block_on(unlocked_vault());
        let hooks: Hooks = std::sync::Arc::new(NoopHooks);
        rt().block_on(chats_create_with_dir(
            &StdVaultIo,
            tmp.path(),
            &state,
            &hooks,
            FIRST_TURN,
            1_000,
            None,
            None,
        ))
        .expect("create");
        // Corrupt the catalog bytes (not the header: a byte in the middle of
        // the ciphertext).
        let path = tmp.path().join("vault.chats");
        let mut bytes = std::fs::read(&path).expect("read catalog");
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0x01;
        std::fs::write(&path, bytes).expect("corrupt catalog");
        // Read: reported, not an empty list.
        let err = rt()
            .block_on(chats_list_with_dir(&StdVaultIo, tmp.path(), &state))
            .unwrap_err();
        assert_eq!(err, ChatsReadError::CatalogUnreadable);
        // Mutation over the unreadable store is REFUSED (refuse-don't-wipe).
        let err = rt()
            .block_on(chats_create_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                FIRST_TURN,
                2_000,
                None,
                None,
            ))
            .unwrap_err();
        assert_eq!(err, ChatsMutateError::CatalogUnreadable);
    }

    #[test]
    fn locked_slot_refuses_every_command() {
        let tmp = ScopedTempDir::new("chats-locked").expect("scoped tempdir");
        seed_real_vault_meta(tmp.path(), HASH_BYTE);
        let state = VaultRuntimeState::default(); // never unlocked
        let hooks: Hooks = std::sync::Arc::new(NoopHooks);
        let err = rt()
            .block_on(chats_create_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                FIRST_TURN,
                1_000,
                None,
                None,
            ))
            .unwrap_err();
        assert_eq!(err, ChatsMutateError::SlotNotUnlocked);
        let err = rt()
            .block_on(chats_list_with_dir(&StdVaultIo, tmp.path(), &state))
            .unwrap_err();
        assert_eq!(err, ChatsReadError::SlotNotUnlocked);
    }

    #[test]
    fn list_orders_by_updated_at_descending() {
        let (tmp, state) = rt().block_on(unlocked_vault());
        let hooks: Hooks = std::sync::Arc::new(NoopHooks);
        let a = rt()
            .block_on(chats_create_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                r#"{"turns":[{"id":"a1","kind":"text","role":"user","text":"first"}]}"#,
                1_000,
                None,
                None,
            ))
            .expect("create a");
        let b = rt()
            .block_on(chats_create_with_dir(
                &StdVaultIo,
                tmp.path(),
                &state,
                &hooks,
                r#"{"turns":[{"id":"b1","kind":"text","role":"user","text":"second"}]}"#,
                2_000,
                None,
                None,
            ))
            .expect("create b");
        // Touch A so it becomes the most recently updated.
        rt().block_on(chats_append_turn_with_dir(
            &StdVaultIo,
            tmp.path(),
            &state,
            &hooks,
            &a,
            r#"{"turns":[{"id":"a1","kind":"text","role":"user","text":"first"},{"id":"a2","kind":"text","role":"assistant","text":"reply"}]}"#,
            3_000,
        ))
        .expect("append a");
        let rows = rt()
            .block_on(chats_list_with_dir(&StdVaultIo, tmp.path(), &state))
            .expect("list");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].entry.title, "first"); // updated_at 3_000
        assert_eq!(rows[1].entry.title, "second"); // updated_at 2_000
        assert!(rows[0].entry.updated_at >= rows[1].entry.updated_at);
        let _ = b;
    }

    // ---- design A (task 28): a member's conversations are person-private --

    #[test]
    fn a_member_conversation_is_person_private_and_never_touches_the_shared_family() {
        use crate::host::test_host::TestHost;
        use crate::paths::active_vault_root_from_base;
        use crate::plugins::sync::person_ai_store as pai;
        use crate::plugins::vault_unlock::state::UnlockedVault;

        let rt = rt();
        let base = ScopedTempDir::new("chats-member-private").expect("scoped tempdir");
        let host = TestHost::new(base.path());
        let state = VaultRuntimeState::default();
        rt.block_on(state.set_unlocked(
            test_vault_id(),
            UnlockedVault::member(
                Zeroizing::new([0x21; 32]),
                Zeroizing::new([0x22; 32]),
                [0x23; 16],
                0,
                [0x24; 32],
            ),
        ));
        let profile_id = [0x31u8; 16];
        let profile_key = Zeroizing::new([0x32u8; 32]);
        rt.block_on(state.set_person_profile(profile_id, profile_key.clone()));
        let dir = active_vault_root_from_base(
            &host.app_data_dir().expect("data dir"),
            Some(test_vault_id()),
        );
        std::fs::create_dir_all(&dir).expect("vault root");
        seed_real_vault_meta(&dir, HASH_BYTE);
        let hooks: Hooks = std::sync::Arc::new(NoopHooks);

        let id = rt
            .block_on(chats_create_from_host(
                &host,
                &StdVaultIo,
                &state,
                &hooks,
                FIRST_TURN,
                None,
                None,
            ))
            .expect("member create");
        let rows = rt
            .block_on(chats_list_from_host(&host, &StdVaultIo, &state))
            .expect("member list");
        assert_eq!(rows.len(), 1);
        let read = rt
            .block_on(chats_read_from_host(&host, &StdVaultIo, &state, &id))
            .expect("member read");
        assert_eq!(read, FIRST_TURN);

        // Nothing in the shared family the owner would hold.
        assert!(!dir.join(CHATS_CATALOG_FILE).exists());
        assert!(!dir.join(CHATS_DIR).exists());
        // Everything in the person-private container.
        let acct =
            protocol::parse_vault_meta_any(&std::fs::read(dir.join("vault.meta")).expect("meta"))
                .expect("parse meta")
                .account_number_hash;
        let container = rt
            .block_on(pai::read_person_ai_state(
                &StdVaultIo,
                &dir,
                &profile_id,
                &profile_key,
                &acct,
            ))
            .expect("container");
        assert!(container.files.contains_key(CHATS_CATALOG_FILE));
        assert!(container
            .files
            .keys()
            .any(|k| k.starts_with(&format!("{CHATS_DIR}/"))));
    }
}
