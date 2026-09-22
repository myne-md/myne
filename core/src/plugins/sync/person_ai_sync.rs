// SPDX-License-Identifier: AGPL-3.0
//! The person-private AI store's sync plane (myne-md/myne#711 task 29).
//!
//! The local half of the store ([`super::person_ai_store`]) keeps the sealed
//! `MYY5` container in a device-local cache. This module carries the same
//! container through the person-authorized profile route
//! (`person_account::person_profile_{read,write}_from_host`,
//! `decisions/protocol/0608`) and merges a remote container into the local one
//! **at the family layer** rather than by whole-value last-writer-wins, so a
//! concurrent edit on another device is never dropped.
//!
//! # Merge rules
//!
//! - **Agent memory / conversations catalogs**: the shared sync's own
//!   per-id causal join (`conflict::merge_memory_catalog` /
//!   `merge_chats_catalog`), so tombstones win ties exactly as they do on the
//!   shared plane.
//! - **Memory entries**: immutable per version, so the side whose catalog row
//!   has the greater `version` wins; a tie keeps the local bytes.
//! - **Conversations**: the turn lists are merged (`conflict::merge_chats_turns`),
//!   the same append-preserving rule the shared chats plane uses.
//! - **Personality**: a whole-value directive list, so the side with the greater
//!   newest `updated_at` wins.
//! - **Pending-tombstone queues**: device-local reclaim queues for the SHARED
//!   plane, never carried on the profile plane; local copies are preserved.
//!
//! The container is sealed as one blob, so two devices can still overwrite each
//! other at the server. Convergence is by pull-merge: every cycle merges the
//! remote container into the local one and pushes the result, so a lost write is
//! re-applied from the device that still holds it.

use std::collections::BTreeMap;

use protocol::{
    decode_agent_memory_catalog_blob_versioned, decode_chats_blob_versioned,
    decode_chats_catalog_blob_versioned, derive_subkey_versioned,
    encode_agent_memory_catalog_blob_versioned, encode_chats_blob_versioned,
    encode_chats_catalog_blob_versioned, meta_version_of, parse_vault_meta_any, MetaVersion,
    SubkeyRole,
};

use crate::host::HostCtx;
use crate::plugins::chats::commands::ChatsCatalogMap;
use crate::plugins::memory::commands::{MemoryCatalogMap, PersonalityView};
use crate::plugins::sync::conflict::{
    merge_chats_catalog, merge_chats_turns, merge_memory_catalog,
};
use crate::plugins::sync::person_ai_store::{
    decode_person_ai_state, encode_person_ai_state, lock_write, person_ai_is_private,
    read_person_ai_cache, write_person_ai_state, PersonAiState,
};
use crate::vault_io::VaultIo;
use zeroize::Zeroizing;

const MEMORY_CATALOG_REL: &str = "vault.agent-memory";
const CHATS_CATALOG_REL: &str = "vault.chats";

/// Push the local container to the profile plane and merge any remote container
/// into it, at the family layer. Best-effort: the caller ignores a failure (a
/// transient profile-route error must not fail the content cycle).
///
/// A no-op for an owner or single-user vault (their AI material is the shared
/// families, not the profile) and for a member whose person profile is not
/// materialised.
pub async fn person_ai_sync_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> Result<(), ()> {
    if !person_ai_is_private(state).await {
        return Ok(());
    }
    // One read-merge-write over the container, serialized with every local
    // private write so a concurrent memory/chats edit cannot interleave.
    let _guard = lock_write().await;
    let (profile_id, profile_key) = state.clone_person_profile().await.ok_or(())?;
    let vault_root = crate::paths::active_vault_root_from_base(
        &host.app_data_dir().map_err(|_| ())?,
        state.active_vault_id().await,
    );
    let meta = io
        .read(&vault_root.join("vault.meta"))
        .await
        .map_err(|_| ())?;
    let version = meta_version_of(&meta).ok_or(())?;
    let account_number_hash = parse_vault_meta_any(&meta)
        .map_err(|_| ())?
        .account_number_hash;

    // An ABSENT cache is the empty state; a PRESENT-but-corrupt one is a
    // refusal, not "empty". Treating corruption as empty would let the next
    // write persist the reduced container over real local data (the
    // `read_or_empty` shape `member_key_store` fails closed against).
    let local = match read_person_ai_cache(io, &vault_root).await {
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

    let remote =
        crate::plugins::sync::person_account::person_profile_read_from_host(host, io, state)
            .await
            .map_err(|_| ())?
            .and_then(|plaintext| decode_person_ai_state(&plaintext));

    let merged = match remote {
        Some(remote) => {
            merge_person_ai(&local, &remote, version, &profile_key, &account_number_hash)?
        }
        None => local.clone(),
    };

    // Nothing changed on either side: no cache write, no server write (avoids a
    // fresh nonce every idle cycle).
    if merged == local {
        return Ok(());
    }

    write_person_ai_state(
        io,
        &vault_root,
        &profile_id,
        &profile_key,
        &account_number_hash,
        &merged,
    )
    .await
    .map_err(|_| ())?;
    let plaintext = encode_person_ai_state(&merged)?;
    crate::plugins::sync::person_account::person_profile_write_from_host(
        host, io, state, &plaintext,
    )
    .await
    .map_err(|_| ())?;
    Ok(())
}

/// Merge a remote container into a local one at the family layer. Pure and
/// deterministic, so it is unit-testable without a server.
#[allow(clippy::result_unit_err)]
pub fn merge_person_ai(
    local: &PersonAiState,
    remote: &PersonAiState,
    version: MetaVersion,
    profile_key: &[u8; 32],
    account_number_hash: &[u8; 16],
) -> Result<PersonAiState, ()> {
    let mut out = PersonAiState::empty();

    // Personality: whole-value, newest directive wins.
    out.set_personality(merge_personality(local, remote)?.as_deref());

    // Pending-tombstone queues are device-local; keep ours.
    for (k, v) in &local.files {
        if k.starts_with("pending-") {
            out.files.insert(k.clone(), v.clone());
        }
    }

    merge_memory(
        &mut out.files,
        local,
        remote,
        version,
        profile_key,
        account_number_hash,
    )?;
    merge_chats(
        &mut out.files,
        local,
        remote,
        version,
        profile_key,
        account_number_hash,
    )?;
    Ok(out)
}

fn merge_personality(local: &PersonAiState, remote: &PersonAiState) -> Result<Option<Vec<u8>>, ()> {
    let parse = |s: &PersonAiState| -> Result<Option<PersonalityView>, ()> {
        match s.personality() {
            None => Ok(None),
            Some(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| ()),
        }
    };
    let l = parse(local)?;
    let r = parse(remote)?;
    let winner = match (l, r) {
        (Some(l), Some(r)) => {
            if newest_directive(&r) > newest_directive(&l) {
                Some(r)
            } else {
                Some(l)
            }
        }
        (Some(l), None) => Some(l),
        (None, Some(r)) => Some(r),
        (None, None) => None,
    };
    match winner {
        None => Ok(None),
        Some(view) => serde_json::to_vec(&view).map(Some).map_err(|_| ()),
    }
}

fn newest_directive(view: &PersonalityView) -> u64 {
    view.directives
        .iter()
        .map(|d| d.updated_at)
        .max()
        .unwrap_or(0)
}

fn derive_family_key(
    version: MetaVersion,
    profile_key: &[u8; 32],
    role: SubkeyRole,
) -> Zeroizing<[u8; 32]> {
    derive_subkey_versioned(version, profile_key, role)
}

fn decode_memory_catalog(
    state: &PersonAiState,
    version: MetaVersion,
    key: &[u8; 32],
    hash: &[u8; 16],
) -> Result<MemoryCatalogMap, ()> {
    match state.files.get(MEMORY_CATALOG_REL) {
        None => Ok(MemoryCatalogMap::new()),
        Some(hex) => {
            let bytes = hex_to_vec(hex).ok_or(())?;
            let plaintext = decode_agent_memory_catalog_blob_versioned(version, key, hash, &bytes)
                .map_err(|_| ())?;
            serde_json::from_slice(&plaintext).map_err(|_| ())
        }
    }
}

fn merge_memory(
    out: &mut BTreeMap<String, String>,
    local: &PersonAiState,
    remote: &PersonAiState,
    version: MetaVersion,
    profile_key: &[u8; 32],
    hash: &[u8; 16],
) -> Result<(), ()> {
    let cat_key = derive_family_key(version, profile_key, SubkeyRole::AgentMemoryCatalogKey);
    let lc = decode_memory_catalog(local, version, &cat_key, hash)?;
    let rc = decode_memory_catalog(remote, version, &cat_key, hash)?;
    let merged = merge_memory_catalog(&lc, &rc);

    if !merged.is_empty() {
        let plaintext = serde_json::to_vec(&merged).map_err(|_| ())?;
        let blob = encode_agent_memory_catalog_blob_versioned(version, &cat_key, hash, &plaintext)
            .map_err(|_| ())?;
        out.insert(MEMORY_CATALOG_REL.to_string(), hex_lower(&blob));
    }

    for (id, row) in merged.iter() {
        if !row.is_live() {
            continue; // a tombstone carries no body
        }
        let rel = format!("memories/{id}");
        let chosen = match (local.files.get(&rel), remote.files.get(&rel)) {
            (Some(l), None) => Some(l),
            (None, Some(r)) => Some(r),
            (Some(l), Some(r)) => {
                let lv = lc.get(id).map(|e| e.version).unwrap_or(0);
                let rv = rc.get(id).map(|e| e.version).unwrap_or(0);
                Some(if rv > lv { r } else { l })
            }
            (None, None) => None,
        };
        if let Some(bytes) = chosen {
            out.insert(rel, bytes.clone());
        }
    }
    Ok(())
}

fn decode_chats_catalog(
    state: &PersonAiState,
    version: MetaVersion,
    key: &[u8; 32],
    hash: &[u8; 16],
) -> Result<ChatsCatalogMap, ()> {
    match state.files.get(CHATS_CATALOG_REL) {
        None => Ok(ChatsCatalogMap::new()),
        Some(hex) => {
            let bytes = hex_to_vec(hex).ok_or(())?;
            let plaintext =
                decode_chats_catalog_blob_versioned(version, key, hash, &bytes).map_err(|_| ())?;
            serde_json::from_slice(&plaintext).map_err(|_| ())
        }
    }
}

fn merge_chats(
    out: &mut BTreeMap<String, String>,
    local: &PersonAiState,
    remote: &PersonAiState,
    version: MetaVersion,
    profile_key: &[u8; 32],
    hash: &[u8; 16],
) -> Result<(), ()> {
    let cat_key = derive_family_key(version, profile_key, SubkeyRole::ChatsCatalogKey);
    let conv_key = derive_family_key(version, profile_key, SubkeyRole::ChatsKey);
    let lc = decode_chats_catalog(local, version, &cat_key, hash)?;
    let rc = decode_chats_catalog(remote, version, &cat_key, hash)?;
    let merged = merge_chats_catalog(&lc, &rc);

    if !merged.is_empty() {
        let plaintext = serde_json::to_vec(&merged).map_err(|_| ())?;
        let blob = encode_chats_catalog_blob_versioned(version, &cat_key, hash, &plaintext)
            .map_err(|_| ())?;
        out.insert(CHATS_CATALOG_REL.to_string(), hex_lower(&blob));
    }

    for (id, row) in merged.iter() {
        if !row.is_live() {
            continue;
        }
        let rel = format!("chats/{id}");
        let l = local.files.get(&rel);
        let r = remote.files.get(&rel);
        let chosen = match (l, r) {
            (Some(l), None) => Some(l.clone()),
            (None, Some(r)) => Some(r.clone()),
            (Some(l), Some(r)) => merge_one_conversation(l, r, id, version, &conv_key, hash)?,
            (None, None) => None,
        };
        if let Some(bytes) = chosen {
            out.insert(rel, bytes);
        }
    }
    Ok(())
}

/// Merge one conversation's two sealed bodies. A missing side takes the other
/// verbatim; both present merges the turn lists and re-seals only when the
/// merged payload differs from both sides (so an agreed state does not churn the
/// nonce). A schema/AEAD failure on either side fails closed (report, never
/// merge an artifact onto real content).
fn merge_one_conversation(
    local_hex: &str,
    remote_hex: &str,
    conversation_id_hex: &str,
    version: MetaVersion,
    conv_key: &[u8; 32],
    hash: &[u8; 16],
) -> Result<Option<String>, ()> {
    let id = hex16(conversation_id_hex).ok_or(())?;
    let local_bytes = hex_to_vec(local_hex).ok_or(())?;
    let remote_bytes = hex_to_vec(remote_hex).ok_or(())?;
    let local_plain =
        decode_chats_blob_versioned(version, conv_key, hash, &id, &local_bytes).map_err(|_| ())?;
    let remote_plain =
        decode_chats_blob_versioned(version, conv_key, hash, &id, &remote_bytes).map_err(|_| ())?;

    let (local_ids, local_turns, local_title) = turns_of(&local_plain)?;
    let (remote_ids, remote_turns, remote_title) = turns_of(&remote_plain)?;
    if local_ids == remote_ids {
        // Same turn ids: the local body is authoritative (settled turns are
        // immutable); keep it verbatim.
        return Ok(Some(local_hex.to_string()));
    }
    let merged_ids = merge_chats_turns(&local_ids, &remote_ids);
    let mut by_id: std::collections::HashMap<&str, &serde_json::Value> =
        std::collections::HashMap::new();
    for (id, obj) in local_ids.iter().zip(local_turns.iter()) {
        by_id.insert(id.as_str(), obj);
    }
    for (id, obj) in remote_ids.iter().zip(remote_turns.iter()) {
        by_id.entry(id.as_str()).or_insert(obj);
    }
    let merged_turns: Vec<serde_json::Value> = merged_ids
        .iter()
        .map(|id| {
            by_id
                .remove(id.as_str())
                .cloned()
                .unwrap_or(serde_json::Value::Null)
        })
        .collect();
    let merged_title = local_title.or(remote_title);
    let payload = payload_with_title(merged_turns, merged_title);
    let merged_plain = serde_json::to_vec(&payload).map_err(|_| ())?;

    // Reuse an existing sealed body when it already IS the merged state.
    if merged_plain.as_slice() == local_plain.as_slice() {
        return Ok(Some(local_hex.to_string()));
    }
    if merged_plain.as_slice() == remote_plain.as_slice() {
        return Ok(Some(remote_hex.to_string()));
    }
    let blob =
        encode_chats_blob_versioned(version, conv_key, hash, &id, &merged_plain).map_err(|_| ())?;
    Ok(Some(hex_lower(&blob)))
}

#[allow(clippy::type_complexity)]
fn turns_of(plaintext: &[u8]) -> Result<(Vec<String>, Vec<serde_json::Value>, Option<String>), ()> {
    let v: serde_json::Value = serde_json::from_slice(plaintext).map_err(|_| ())?;
    let turns = v.get("turns").and_then(|t| t.as_array()).ok_or(())?.clone();
    let ids: Vec<String> = turns
        .iter()
        .map(|t| {
            t.get("id")
                .and_then(|i| i.as_str())
                .map(str::to_string)
                .ok_or(())
        })
        .collect::<Result<_, _>>()?;
    let title = v
        .get("title_derived_from")
        .and_then(|s| s.as_str())
        .map(str::to_string);
    Ok((ids, turns, title))
}

fn payload_with_title(turns: Vec<serde_json::Value>, title: Option<String>) -> serde_json::Value {
    let mut map = serde_json::Map::with_capacity(2);
    map.insert("turns".to_string(), serde_json::Value::Array(turns));
    if let Some(t) = title {
        map.insert(
            "title_derived_from".to_string(),
            serde_json::Value::String(t),
        );
    }
    serde_json::Value::Object(map)
}

fn hex_lower(bytes: &[u8]) -> String {
    crate::account::person_identity::hex_lower(bytes)
}

fn hex_to_vec(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn hex16(s: &str) -> Option<[u8; 16]> {
    if s.len() != 32 || s.chars().any(|c| c.is_ascii_uppercase()) {
        return None;
    }
    let mut out = [0u8; 16];
    for (slot, pair) in out.iter_mut().zip(s.as_bytes().chunks(2)) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        *slot = ((hi << 4) | lo) as u8;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::memory::commands::PersonalityDirective;

    fn personality(text: &str, updated_at: u64) -> Vec<u8> {
        serde_json::to_vec(&PersonalityView {
            directives: vec![PersonalityDirective {
                text: text.to_string(),
                updated_at,
            }],
        })
        .expect("view")
    }

    #[test]
    fn personality_merge_takes_the_newest_directive() {
        let mut local = PersonAiState::empty();
        local.set_personality(Some(&personality("old", 10)));
        let mut remote = PersonAiState::empty();
        remote.set_personality(Some(&personality("new", 20)));
        let merged = merge_person_ai(&local, &remote, MetaVersion::V0_2, &[0x11; 32], &[0x22; 16])
            .expect("merge");
        let view: PersonalityView =
            serde_json::from_slice(&merged.personality().expect("personality")).expect("parse");
        assert_eq!(view.directives[0].text, "new");
    }

    #[test]
    fn pending_tombstone_queues_stay_device_local() {
        let mut local = PersonAiState::empty();
        local
            .files
            .insert("pending-memory-tombstones".to_string(), "aa".to_string());
        let mut remote = PersonAiState::empty();
        remote
            .files
            .insert("pending-memory-tombstones".to_string(), "bb".to_string());
        let merged = merge_person_ai(&local, &remote, MetaVersion::V0_2, &[0x11; 32], &[0x22; 16])
            .expect("merge");
        assert_eq!(
            merged
                .files
                .get("pending-memory-tombstones")
                .map(String::as_str),
            Some("aa")
        );
    }

    // The family-layer merge must not drop a memory row that only one side has,
    // and must pick the newer entry body by the catalog row's version.
    #[test]
    fn memory_merge_keeps_both_rows_and_picks_the_newer_body() {
        use crate::plugins::memory::commands::MemoryEntryRow;
        use protocol::{
            encode_agent_memory_blob_versioned, encode_agent_memory_catalog_blob_versioned,
        };

        let version = MetaVersion::V0_2;
        let key = [0x33u8; 32];
        let hash = [0x44u8; 16];
        let cat_key = derive_family_key(version, &key, SubkeyRole::AgentMemoryCatalogKey);
        let entry_key = derive_family_key(version, &key, SubkeyRole::AgentMemoryKey);

        let id_a = "aa".repeat(16);
        let id_b = "bb".repeat(16);
        let id_a_bytes = hex16(&id_a).unwrap();
        let id_b_bytes = hex16(&id_b).unwrap();

        let row = |version: u64| MemoryEntryRow {
            created_at: 1,
            deleted_at: None,
            updated_at: version,
            version,
            quarantined: false,
        };

        let seal_catalog = |map: &MemoryCatalogMap| {
            let plain = serde_json::to_vec(map).unwrap();
            hex_lower(
                &encode_agent_memory_catalog_blob_versioned(version, &cat_key, &hash, &plain)
                    .unwrap(),
            )
        };
        let seal_entry = |id: &[u8; 16], text: &str| {
            hex_lower(
                &encode_agent_memory_blob_versioned(
                    version,
                    &entry_key,
                    &hash,
                    id,
                    text.as_bytes(),
                )
                .unwrap(),
            )
        };

        let mut local = PersonAiState::empty();
        let mut local_map = MemoryCatalogMap::new();
        local_map.insert(id_a.clone(), row(2));
        local_map.insert(id_b.clone(), row(1));
        local
            .files
            .insert(MEMORY_CATALOG_REL.to_string(), seal_catalog(&local_map));
        local
            .files
            .insert(format!("memories/{id_a}"), seal_entry(&id_a_bytes, "old-a"));
        local
            .files
            .insert(format!("memories/{id_b}"), seal_entry(&id_b_bytes, "b"));

        let mut remote = PersonAiState::empty();
        let mut remote_map = MemoryCatalogMap::new();
        remote_map.insert(id_a.clone(), row(3));
        remote
            .files
            .insert(MEMORY_CATALOG_REL.to_string(), seal_catalog(&remote_map));
        remote
            .files
            .insert(format!("memories/{id_a}"), seal_entry(&id_a_bytes, "new-a"));

        let merged = merge_person_ai(&local, &remote, version, &key, &hash).expect("merge");
        // Both rows survive in the merged catalog.
        let merged_map = decode_memory_catalog(&merged, version, &cat_key, &hash).expect("catalog");
        assert!(merged_map.contains_key(&id_a));
        assert!(merged_map.contains_key(&id_b));
        // The newer body won, and it decrypts to the new text.
        let a_body = hex_to_vec(merged.files.get(&format!("memories/{id_a}")).unwrap()).unwrap();
        let a_plain = protocol::decode_agent_memory_blob_versioned(
            version,
            &entry_key,
            &hash,
            &id_a_bytes,
            &a_body,
        )
        .expect("open entry");
        assert_eq!(a_plain.as_slice(), b"new-a");
        // The only-local row's body is preserved.
        let b_body = hex_to_vec(merged.files.get(&format!("memories/{id_b}")).unwrap()).unwrap();
        let b_plain = protocol::decode_agent_memory_blob_versioned(
            version,
            &entry_key,
            &hash,
            &id_b_bytes,
            &b_body,
        )
        .expect("open entry");
        assert_eq!(b_plain.as_slice(), b"b");
    }
}
