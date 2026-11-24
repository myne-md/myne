// SPDX-License-Identifier: AGPL-3.0-only
//! The person-private AI state store (myne-md/myne#711 tasks 26 to 28).
//!
//! In a shared (`NTV6`) vault a **member** keeps their own AI material (their
//! personality directive, agent memory and conversations) in their
//! person-private `MYY5` profile rather than in the shared families, so the
//! other members never read it. The owner of a shared vault, and every
//! single-user vault, keep the shared families unchanged.
//!
//! This module is the local half of that store:
//!
//! - [`PersonAiState`], a versioned container whose payload is sealed exactly
//!   like any other profile, carried in the device-local cache `vault.person-ai`
//!   (task 29 pushes the same bytes through the profile plane);
//! - [`PersonAiFs`], a [`VaultIo`] over the container's per-file map, so the
//!   memory and chats families run their existing code unchanged against
//!   person-private storage instead of the shared vault directory;
//! - [`person_ai_is_private`], the predicate: a Member slot has no `root_key`,
//!   so member authority is exactly "this person's AI material is private
//!   here".
//!
//! # Why the inner family blobs are sealed again
//!
//! The container is itself sealed under the person-profile key, and the family
//! blobs `PersonAiFs` stores are the family's own AEAD blobs, sealed under keys
//! derived from that same profile key (see `memory::commands::seal_from_slot`
//! and `chats::commands::seal_from_slot`). The nesting is deliberate: it lets
//! every existing family function (catalog, entries, injection scan, authorship
//! gate, tombstones) run unmodified, and the family layer keeps owning its own
//! framing. A member holds no `root_key`, so there is no shared family data of
//! theirs to migrate: the private store starts empty and is authoritative for
//! the whole family from the first write.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::io_failure_kind::IoFailureKind;
use crate::plugins::vault_unlock::state::{Slot, VaultAuthority, VaultRuntimeState};
use crate::vault_io::{DirEntry, IoResult, VaultIo, WriteOpts};

/// Device-local cache file name, under the vault root. It holds the SEALED
/// `MYY5` profile bytes (encrypted at rest under the person-profile key), the
/// same bytes the profile plane carries, so the cache and the server copy are
/// one artifact.
pub const PERSON_AI_CACHE_FILE: &str = "vault.person-ai";

/// The container format version. A section added later is an additive field on
/// the same version; a change to an existing section's meaning is a new version.
pub const PERSON_AI_STATE_VERSION: u32 = 1;

/// The person-private AI state: the personality view plus a virtual file map
/// holding the memory and chats families' sealed blobs, keyed by vault-relative
/// path. The map is what [`PersonAiFs`] reads and writes, so the family code
/// needs no private variant.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonAiState {
    /// Container version.
    pub v: u32,
    /// The personality view plaintext (`PersonalityView` JSON, hex), absent
    /// when the person has no directive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub personality_hex: Option<String>,
    /// The person-private families' sealed blobs, keyed by vault-relative
    /// path (`vault.agent-memory`, `memories/<id>`, `vault.chats`,
    /// `chats/<id>`, the pending-tombstone queues), hex-encoded.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub files: BTreeMap<String, String>,
    /// The PINNED owner identity code for this `(person, vault)` membership
    /// (`MYNE-PERSON-1:…`), so a second device of the same person can tell
    /// which owner it is joining before it trusts anything the sync plane
    /// offers it. Additive on the same container version: an older reader
    /// ignores the field, and its presence is not a section the family layer
    /// owns (nothing here is hex, so it stays out of the hex validation loop).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_identity_code: Option<String>,
}

impl PersonAiState {
    /// A fresh, empty state at the current version.
    pub fn empty() -> Self {
        Self {
            v: PERSON_AI_STATE_VERSION,
            ..Default::default()
        }
    }

    /// The personality section plaintext, if any.
    pub fn personality(&self) -> Option<Vec<u8>> {
        hex_to_vec(self.personality_hex.as_deref())
    }

    /// Set (or clear, with `None`) the personality section.
    pub fn set_personality(&mut self, bytes: Option<&[u8]>) {
        self.personality_hex = bytes.map(hex_lower);
    }

    /// The pinned owner identity code for this membership, if one is recorded.
    pub fn owner_identity_code(&self) -> Option<&str> {
        self.owner_identity_code
            .as_deref()
            .filter(|c| !c.is_empty())
    }

    /// Set (or clear, with `None`) the pinned owner identity code. An empty
    /// string clears it, so a caller cannot pin a value that reads back absent.
    pub fn set_owner_identity_code(&mut self, code: Option<&str>) {
        self.owner_identity_code = code.filter(|c| !c.is_empty()).map(str::to_string);
    }
}

/// Serialize the container as JSON (the profile blob's plaintext).
#[allow(clippy::result_unit_err)]
pub fn encode_person_ai_state(state: &PersonAiState) -> Result<Vec<u8>, ()> {
    serde_json::to_vec(state).map_err(|_| ())
}

/// Parse a container, rejecting a version this build does not know (fail-closed,
/// so a newer container is never read as an older one).
pub fn decode_person_ai_state(bytes: &[u8]) -> Option<PersonAiState> {
    let state: PersonAiState = serde_json::from_slice(bytes).ok()?;
    if state.v != PERSON_AI_STATE_VERSION {
        return None;
    }
    // Every present section must be valid hex, so a corrupt one fails closed
    // rather than reading as absent.
    for h in state
        .personality_hex
        .as_deref()
        .into_iter()
        .chain(state.files.values().map(String::as_str))
    {
        if !h.len().is_multiple_of(2) || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
    }
    Some(state)
}

/// Whether the active session holds this vault as a MEMBER, which is exactly
/// when the person's AI material is private. A Member slot has no `root_key` and
/// holds a group key, so it can only be an `NTV6` vault.
pub async fn person_ai_is_private(state: &VaultRuntimeState) -> bool {
    let slot = state.slot_read_active().await;
    matches!(&*slot, Slot::Unlocked(uv) if uv.authority() == VaultAuthority::Member)
}

/// Whether the active session has an unlocked slot, member or owner. The
/// existing `peek_unlocked_root_key_*` probes answer `None` for a member (which
/// is the point), so an AI command must ask this rather than the root-key probe
/// or it refuses a legitimately unlocked member session.
pub async fn ai_slot_unlocked(state: &VaultRuntimeState) -> bool {
    if state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .is_some()
    {
        return true;
    }
    person_ai_is_private(state).await
}

/// The 32-byte input the AI families derive their family KEKs from: the held
/// person-profile key for a member (who has no `root_key`), the owner root key
/// otherwise. [`person_ai_is_private`] is what decides, so a member's family
/// blobs are only ever sealed under keys nobody else holds.
pub async fn seal_key_from_slot(state: &VaultRuntimeState) -> Option<zeroize::Zeroizing<[u8; 32]>> {
    if person_ai_is_private(state).await {
        return state.clone_person_profile().await.map(|(_, key)| key);
    }
    state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .map(|(key, _)| key)
}

/// Open the [`PersonAiFs`] for the active session: read the held profile key,
/// the vault's `account_number_hash` from `vault.meta`, and the cache. `Err(())`
/// on a missing profile key, a `vault.meta` read/parse failure, or a corrupt
/// cache, all of which the caller maps to its own error.
pub async fn open_for_active<'a>(
    io: &'a dyn VaultIo,
    vault_root: &Path,
    state: &VaultRuntimeState,
) -> Result<PersonAiFs<'a>, ()> {
    let (profile_id, key) = state.clone_person_profile().await.ok_or(())?;
    let meta = io
        .read(&vault_root.join("vault.meta"))
        .await
        .map_err(|_| ())?;
    let acct = protocol::parse_vault_meta_any(&meta)
        .map_err(|_| ())?
        .account_number_hash;
    PersonAiFs::open(io, vault_root, profile_id, key, acct).await
}

/// One read-modify-write critical section over the sealed container. The
/// adapter persists on every write, and a whole family command is several
/// writes, so two families (memory, chats) sharing one container must not
/// interleave their read-modify-write cycles. Every private path holds this
/// across its command, after which the adapter can be mutation-simple.
pub async fn lock_write() -> tokio::sync::OwnedMutexGuard<()> {
    use std::sync::OnceLock;
    static MUTEX: OnceLock<std::sync::Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    MUTEX
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
        .lock_owned()
        .await
}

/// Write the sealed profile bytes to the device-local cache (atomic replace).
#[allow(clippy::result_unit_err)]
pub async fn write_person_ai_cache(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    sealed_profile: &[u8],
) -> Result<(), ()> {
    io.write(
        &vault_root.join(PERSON_AI_CACHE_FILE),
        sealed_profile,
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(|_| ())
}

/// Read the sealed profile bytes from the device-local cache, if present.
pub async fn read_person_ai_cache(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
) -> Option<Vec<u8>> {
    io.read(&vault_root.join(PERSON_AI_CACHE_FILE)).await.ok()
}

/// Read the person AI state from the device-local cache, opening the sealed
/// profile with the held `(profile_id, key)`. `None` on an absent cache or any
/// open/parse failure (a wrong key and tampering are the same answer, §6.4).
pub async fn read_person_ai_state(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    profile_id: &[u8; 16],
    profile_key: &[u8; 32],
    account_number_hash: &[u8; 16],
) -> Option<PersonAiState> {
    let sealed = read_person_ai_cache(io, vault_root).await?;
    let plaintext =
        protocol::decode_person_profile_blob(profile_key, profile_id, account_number_hash, &sealed)
            .ok()?;
    decode_person_ai_state(&plaintext)
}

/// Encode the person AI state, seal it as a `MYY5` profile and write it to the
/// device-local cache. (The profile plane push is task 29.)
pub async fn write_person_ai_state(
    io: &dyn VaultIo,
    vault_root: &std::path::Path,
    profile_id: &[u8; 16],
    profile_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    state: &PersonAiState,
) -> Result<(), ()> {
    let plaintext = encode_person_ai_state(state)?;
    let sealed = protocol::encode_person_profile_blob(
        profile_key,
        profile_id,
        account_number_hash,
        &plaintext,
    )
    .map_err(|_| ())?;
    write_person_ai_cache(io, vault_root, &sealed).await
}

// ---------------------------------------------------------------------------
// PersonAiFs: the container as a vault directory
// ---------------------------------------------------------------------------

/// The vault-relative paths that live in the person-private container rather
/// than in the shared vault directory. Anything else the adapter is asked for
/// is either delegated (a read of `vault.meta`, which the family seal needs) or
/// refused, so a future family cannot quietly leak shared bytes.
fn is_private_family_path(rel: &str) -> bool {
    matches!(
        rel,
        "vault.agent-memory"
            | "vault.chats"
            | "pending-memory-tombstones"
            | "pending-chats-tombstones"
    ) || rel.starts_with("memories/")
        || rel.starts_with("chats/")
}

/// Whether `rel` names one of the virtual directories the private families
/// create (`memories`, `chats`).
fn is_private_family_dir(rel: &str) -> bool {
    rel == "memories" || rel == "chats"
}

/// A [`VaultIo`] whose private-family paths live in a sealed [`PersonAiState`]
/// container and whose `vault.meta` reads delegate to the real vault IO. The
/// family command holds [`lock_write`] across its whole run, so the adapter's
/// read-modify-write need not tolerate interleaving.
pub struct PersonAiFs<'a> {
    inner: &'a dyn VaultIo,
    vault_root: PathBuf,
    profile_id: [u8; 16],
    profile_key: zeroize::Zeroizing<[u8; 32]>,
    account_number_hash: [u8; 16],
    state: std::sync::Mutex<PersonAiState>,
}

impl<'a> PersonAiFs<'a> {
    /// Open the container from the device-local cache. An absent cache is the
    /// empty state; a present-but-corrupt one is an error, so a command refuses
    /// rather than persisting an empty container over real data.
    pub async fn open(
        inner: &'a dyn VaultIo,
        vault_root: &Path,
        profile_id: [u8; 16],
        profile_key: zeroize::Zeroizing<[u8; 32]>,
        account_number_hash: [u8; 16],
    ) -> Result<Self, ()> {
        let state = match read_person_ai_cache(inner, vault_root).await {
            None => PersonAiState::empty(),
            Some(sealed) => {
                let plaintext = protocol::decode_person_profile_blob(
                    &profile_key,
                    &profile_id,
                    &account_number_hash,
                    &sealed,
                )
                .map_err(|_| ())?;
                decode_person_ai_state(&plaintext).ok_or(())?
            }
        };
        Ok(Self {
            inner,
            vault_root: vault_root.to_path_buf(),
            profile_id,
            profile_key,
            account_number_hash,
            state: std::sync::Mutex::new(state),
        })
    }

    /// The vault-relative, slash-separated form of `path`, or `None` when the
    /// path is not under the vault root (which must delegate or refuse).
    fn rel(&self, path: &Path) -> Option<String> {
        let rel = path.strip_prefix(&self.vault_root).ok()?;
        Some(rel.to_string_lossy().replace('\\', "/"))
    }

    /// Persist the whole container, re-sealing under the profile key.
    async fn persist(&self) -> IoResult<()> {
        let state = { self.state.lock().expect("person AI state lock").clone() };
        write_person_ai_state(
            self.inner,
            &self.vault_root,
            &self.profile_id,
            &self.profile_key,
            &self.account_number_hash,
            &state,
        )
        .await
        .map_err(|_| IoFailureKind::Other)
    }

    fn with_state<R>(&self, f: impl FnOnce(&mut PersonAiState) -> R) -> R {
        let mut guard = self.state.lock().expect("person AI state lock");
        f(&mut guard)
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
impl VaultIo for PersonAiFs<'_> {
    async fn read(&self, path: &Path) -> IoResult<Vec<u8>> {
        let Some(rel) = self.rel(path) else {
            return Err(IoFailureKind::Other);
        };
        if rel == "vault.meta" {
            return self.inner.read(path).await;
        }
        if !is_private_family_path(&rel) {
            return Err(IoFailureKind::Other);
        }
        self.with_state(|s| match s.files.get(&rel) {
            Some(hex) => hex_to_vec(Some(hex)).ok_or(IoFailureKind::Other),
            None => Err(IoFailureKind::NotFound),
        })
    }

    async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>> {
        let mut bytes = self.read(path).await?;
        bytes.truncate(len);
        Ok(bytes)
    }

    async fn write(&self, path: &Path, bytes: &[u8], _opts: WriteOpts) -> IoResult<()> {
        let Some(rel) = self.rel(path) else {
            return Err(IoFailureKind::Other);
        };
        if !is_private_family_path(&rel) {
            return Err(IoFailureKind::Other);
        }
        self.with_state(|s| s.files.insert(rel, hex_lower(bytes)));
        self.persist().await
    }

    async fn remove_file(&self, path: &Path) -> IoResult<()> {
        let Some(rel) = self.rel(path) else {
            return Err(IoFailureKind::Other);
        };
        if !is_private_family_path(&rel) {
            return Err(IoFailureKind::Other);
        }
        let removed = self.with_state(|s| s.files.remove(&rel).is_some());
        if !removed {
            return Err(IoFailureKind::NotFound);
        }
        self.persist().await
    }

    async fn remove_dir_all(&self, path: &Path) -> IoResult<()> {
        let Some(rel) = self.rel(path) else {
            return Err(IoFailureKind::Other);
        };
        let prefix = format!("{rel}/");
        self.with_state(|s| {
            let keys: Vec<String> = s
                .files
                .keys()
                .filter(|k| *k == &rel || k.starts_with(&prefix))
                .cloned()
                .collect();
            for k in keys {
                s.files.remove(&k);
            }
        });
        self.persist().await
    }

    async fn create_dir_all(&self, path: &Path) -> IoResult<()> {
        // The private families' directories are implicit in the file map.
        match self.rel(path) {
            Some(rel) if is_private_family_dir(&rel) || is_private_family_path(&rel) => Ok(()),
            _ => Err(IoFailureKind::Other),
        }
    }

    async fn read_dir(&self, path: &Path) -> IoResult<Vec<DirEntry>> {
        let Some(rel) = self.rel(path) else {
            return Err(IoFailureKind::Other);
        };
        if !is_private_family_dir(&rel) {
            return Err(IoFailureKind::NotFound);
        }
        let prefix = format!("{rel}/");
        let names = self.with_state(|s| {
            let mut names: Vec<String> = s
                .files
                .keys()
                .filter_map(|k| k.strip_prefix(&prefix))
                .filter(|rest| !rest.is_empty() && !rest.contains('/'))
                .map(str::to_string)
                .collect();
            names.sort();
            names.dedup();
            names
        });
        Ok(names
            .into_iter()
            .map(|name| DirEntry {
                name,
                is_dir: false,
            })
            .collect())
    }

    async fn exists(&self, path: &Path) -> IoResult<bool> {
        let Some(rel) = self.rel(path) else {
            return self.inner.exists(path).await;
        };
        if rel == "vault.meta" {
            return self.inner.exists(path).await;
        }
        if is_private_family_dir(&rel) {
            let prefix = format!("{rel}/");
            return Ok(self.with_state(|s| s.files.keys().any(|k| k.starts_with(&prefix))));
        }
        if !is_private_family_path(&rel) {
            return Err(IoFailureKind::Other);
        }
        Ok(self.with_state(|s| s.files.contains_key(&rel)))
    }

    async fn is_dir(&self, path: &Path) -> IoResult<bool> {
        match self.rel(path) {
            Some(rel) if rel == "vault.meta" => self.inner.is_dir(path).await,
            Some(rel) => Ok(is_private_family_dir(&rel)),
            None => Err(IoFailureKind::Other),
        }
    }

    async fn rename(&self, from: &Path, to: &Path) -> IoResult<()> {
        let (Some(from_rel), Some(to_rel)) = (self.rel(from), self.rel(to)) else {
            return Err(IoFailureKind::Other);
        };
        if !is_private_family_path(&from_rel) || !is_private_family_path(&to_rel) {
            return Err(IoFailureKind::Other);
        }
        let moved = self.with_state(|s| s.files.remove(&from_rel));
        match moved {
            Some(bytes) => {
                self.with_state(|s| {
                    s.files.insert(to_rel, bytes);
                });
                self.persist().await
            }
            None => Err(IoFailureKind::NotFound),
        }
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    crate::account::person_identity::hex_lower(bytes)
}

fn hex_to_vec(s: Option<&str>) -> Option<Vec<u8>> {
    let s = s?;
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_round_trips_and_versions_fail_closed() {
        let mut state = PersonAiState::empty();
        state.set_personality(Some(b"be concise"));
        state
            .files
            .insert("vault.agent-memory".to_string(), "00ff".to_string());
        state.set_owner_identity_code(Some("MYNE-PERSON-1:aa:bb:cc:dd"));

        let bytes = encode_person_ai_state(&state).expect("encode");
        let decoded = decode_person_ai_state(&bytes).expect("decode");
        assert_eq!(decoded, state);
        assert_eq!(decoded.personality().as_deref(), Some(&b"be concise"[..]));
        assert_eq!(
            decoded.files.get("vault.agent-memory").map(String::as_str),
            Some("00ff")
        );
        // The pin is a plain string section, so it survives the hex validation
        // loop that every OTHER section must pass.
        assert_eq!(
            decoded.owner_identity_code(),
            Some("MYNE-PERSON-1:aa:bb:cc:dd")
        );

        // An unknown version is refused rather than read as this one.
        let newer = br#"{"v":99,"personality_hex":"00"}"#;
        assert!(decode_person_ai_state(newer).is_none());
        // A corrupt section fails closed rather than reading as absent.
        let bad = br#"{"v":1,"personality_hex":"zz"}"#;
        assert!(decode_person_ai_state(bad).is_none());
        let bad_file = br#"{"v":1,"files":{"vault.chats":"zz"}}"#;
        assert!(decode_person_ai_state(bad_file).is_none());
    }

    #[test]
    fn clearing_a_section_omits_it_from_the_encoding() {
        let mut state = PersonAiState::empty();
        state.set_personality(Some(b"voice"));
        state.set_personality(None);
        let bytes = encode_person_ai_state(&state).expect("encode");
        assert!(!String::from_utf8_lossy(&bytes).contains("personality_hex"));
        assert!(!String::from_utf8_lossy(&bytes).contains("files"));
    }

    #[test]
    fn the_pin_section_is_absent_by_default_and_an_empty_string_clears_it() {
        // A container written before the pin existed decodes to no pin, which
        // is what lets an older device's copy merge without inventing one.
        let before = br#"{"v":1,"personality_hex":"00"}"#;
        let decoded = decode_person_ai_state(before).expect("decode");
        assert_eq!(decoded.owner_identity_code(), None);

        // Absent by default, so an encoding carries no empty pin section.
        let empty = PersonAiState::empty();
        let bytes = encode_person_ai_state(&empty).expect("encode");
        assert!(!String::from_utf8_lossy(&bytes).contains("owner_identity_code"));

        // An empty string is not a pin: the setter refuses it and the accessor
        // reads it back as absent, so a caller cannot pin "no owner".
        let mut cleared = PersonAiState::empty();
        cleared.set_owner_identity_code(Some("MYNE-PERSON-1:aa:bb:cc:dd"));
        assert!(cleared.owner_identity_code().is_some());
        cleared.set_owner_identity_code(Some(""));
        assert_eq!(cleared.owner_identity_code(), None);
        let bytes = encode_person_ai_state(&cleared).expect("encode");
        assert!(!String::from_utf8_lossy(&bytes).contains("owner_identity_code"));
    }

    #[test]
    fn a_fresh_device_has_no_cached_state() {
        crate::test_support::block_on(async {
            let tmp = crate::test_support::ScopedTempDir::new("person-ai-cache").expect("temp dir");
            let io = crate::vault_io::StdVaultIo;
            assert!(read_person_ai_cache(&io, tmp.path()).await.is_none());
            write_person_ai_cache(&io, tmp.path(), b"sealed")
                .await
                .expect("write");
            assert_eq!(
                read_person_ai_cache(&io, tmp.path()).await.as_deref(),
                Some(&b"sealed"[..])
            );
        });
    }

    #[test]
    fn only_a_member_slot_is_person_private() {
        use crate::plugins::vault_unlock::state::UnlockedVault;
        use zeroize::Zeroizing;
        crate::test_support::block_on(async {
            let state = VaultRuntimeState::default();
            let id = crate::vault_id::VaultId::mint();
            // An owner slot (root_key present) is NOT private: the shared
            // families are the owner's own.
            state
                .set_unlocked(
                    id,
                    UnlockedVault::owner(
                        Zeroizing::new([1u8; 32]),
                        Some(Zeroizing::new([2u8; 32])),
                        Zeroizing::new([3u8; 32]),
                        [4u8; 16],
                        0,
                        [5u8; 32],
                    ),
                )
                .await;
            assert!(!person_ai_is_private(&state).await);
            assert!(ai_slot_unlocked(&state).await);
            // A member slot (no root_key, group key present) IS private.
            state
                .set_unlocked(
                    id,
                    UnlockedVault::member(
                        Zeroizing::new([2u8; 32]),
                        Zeroizing::new([3u8; 32]),
                        [4u8; 16],
                        0,
                        [5u8; 32],
                    ),
                )
                .await;
            assert!(person_ai_is_private(&state).await);
            assert!(ai_slot_unlocked(&state).await);
        });
    }

    #[test]
    fn the_adapter_maps_private_paths_and_refuses_others() {
        crate::test_support::block_on(async {
            use crate::vault_io::StdVaultIo;
            let tmp = crate::test_support::ScopedTempDir::new("person-ai-fs").expect("temp dir");
            let real = StdVaultIo;
            let profile_id = [0x11u8; 16];
            let profile_key = zeroize::Zeroizing::new([0x22u8; 32]);
            let acct = [0x33u8; 16];

            let fs = PersonAiFs::open(&real, tmp.path(), profile_id, profile_key.clone(), acct)
                .await
                .expect("open");
            let catalog = tmp.path().join("vault.agent-memory");
            assert_eq!(fs.read(&catalog).await, Err(IoFailureKind::NotFound));
            assert!(!fs.exists(&catalog).await.expect("exists"));
            fs.write(&catalog, b"sealed-catalog", WriteOpts::default())
                .await
                .expect("write");
            assert_eq!(fs.read(&catalog).await.expect("read"), b"sealed-catalog");
            // A second adapter over the same cache sees the persisted bytes.
            let reopened = PersonAiFs::open(&real, tmp.path(), profile_id, profile_key, acct)
                .await
                .expect("reopen");
            assert_eq!(
                reopened.read(&catalog).await.expect("read"),
                b"sealed-catalog"
            );
            // The shared vault directory got no family file, only the cache.
            assert!(!real.exists(&catalog).await.expect("real exists"));
            assert!(real
                .exists(&tmp.path().join(PERSON_AI_CACHE_FILE))
                .await
                .expect("cache exists"));
            // An unmapped vault path is refused, so nothing leaks shared.
            assert_eq!(
                fs.write(&tmp.path().join("vault.prefs"), b"x", WriteOpts::default())
                    .await,
                Err(IoFailureKind::Other)
            );
        });
    }

    #[test]
    fn a_corrupt_cache_refuses_to_open() {
        crate::test_support::block_on(async {
            use crate::vault_io::StdVaultIo;
            let tmp =
                crate::test_support::ScopedTempDir::new("person-ai-corrupt").expect("temp dir");
            let real = StdVaultIo;
            real.write(
                &tmp.path().join(PERSON_AI_CACHE_FILE),
                b"not a sealed blob",
                WriteOpts::default(),
            )
            .await
            .expect("seed");
            let opened = PersonAiFs::open(
                &real,
                tmp.path(),
                [0x11u8; 16],
                zeroize::Zeroizing::new([0x22u8; 32]),
                [0x33u8; 16],
            )
            .await;
            assert!(opened.is_err());
        });
    }
}
