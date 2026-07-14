//! `vault_indices` Tauri command handlers (MYND-31 / A11, Task 1).
//!
//! - [`vault_indices_apply`] — Slot::Unlocked-gated upsert of a note's
//!   index contribution (Task 1: title + folder; later tasks extend the
//!   payload with wikilink edges + tags). TS calls this per note during
//!   the rebuild-on-unlock sweep and on every live note-lifecycle op.
//! - [`vault_indices_remove`] — Slot::Unlocked-gated removal of a
//!   hard-deleted note from the index.
//!
//! Build-B: extraction is TS-side, so these commands receive already-
//! extracted data — they never parse markdown. Both are gated on
//! `Slot::Unlocked` because the index is plaintext-derived RAM that only
//! exists while a vault is open.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::error::VaultIndicesError;
use super::persist::{decode_snapshot, encode_snapshot, reconcile_delta};
use super::state::{
    BlockAnchor, CandidateEdge, NoteRecord, PropertyEntry, TagEntry, TagTreeNode, VaultBlockAnchor,
    VaultIndicesState, WikilinkEdge,
};
use crate::note_nonce::scan_on_disk_manifest;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use protocol::{derive_subkey, parse_vault_meta, SubkeyRole, VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN};
use std::path::Path;
use tauri::{AppHandle, Runtime, State};

/// Upsert a note's index contribution (`title` + `folder` + per-occurrence
/// outbound wikilink `wikilinks` edges).
///
/// Replace semantics — re-applying a note id fully overwrites its prior
/// record. Build-B: the edges arrive already extracted + classified TS-side
/// (media embeds excluded), so this command never parses markdown. Rejected
/// with [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
// Each field is a distinct IPC argument; bundling into a struct would change
// the wire shape for no gain. The Tauri command boundary inherently widens here.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn vault_indices_apply(
    note_id: String,
    title: Option<String>,
    folder: Option<String>,
    title_key: Option<String>,
    wikilinks: Vec<WikilinkEdge>,
    tags: Vec<TagEntry>,
    properties: Vec<PropertyEntry>,
    // MYND-382: imported `^block-id` anchors TS extracted (`extractBlockAnchors`).
    // `Option` (not a bare `Vec`) so a caller that omits it — mobile, or an older
    // desktop build — is `None` → `[]`, exactly the `title: Option` pattern Tauri
    // already relies on for an absent optional invoke arg (no wire break).
    block_anchors: Option<Vec<BlockAnchor>>,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<(), VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    indices.apply(
        &note_id,
        NoteRecord {
            title,
            folder,
            title_key,
            edges: wikilinks,
            tags,
            // Build-B (MYND-271): TS coerced every frontmatter property per
            // §3.6.4; Rust stores these opaque pre-typed values, never parsing
            // YAML (TB9) nor interpreting the type.
            properties,
            // MYND-382: enumerate-only imported block anchors for the `[[^^` picker.
            block_anchors: block_anchors.unwrap_or_default(),
        },
    );
    Ok(())
}

/// Defensive ceiling on a single whole-vault edge dump. The normal path
/// routes by `note_count()` so this never trips at ≤ cap; it exists only to
/// bound a pathological payload (cf. the per-blob pre-alloc caps §9.2/§9.6.5).
const MAX_GRAPH_EDGES: usize = 500_000;

/// Whole-vault edge dump — `[(note_id, edges)]` for every indexed note
/// (MYND-197). The TS graph adapter resolves the raw edges once against the
/// resident note-set. The client routes by note count BEFORE calling this (a
/// `> cap` vault takes the per-note subgraph path), so this only runs at
/// ≤ cap; the [`MAX_GRAPH_EDGES`] ceiling is a defensive backstop. Rejected
/// with [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
#[tauri::command]
pub async fn vault_indices_all_edges(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<(String, Vec<WikilinkEdge>)>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.all_edges(MAX_GRAPH_EDGES))
}

/// Defensive ceiling on a single whole-vault block-anchor dump (MYND-382).
/// Imported block anchors are sparse (only imported notes carry them), so a
/// real vault stays far under this; the cap only bounds a pathological payload.
const MAX_BLOCK_ANCHORS: usize = 100_000;

/// Every imported `^block-id` anchor across the vault (MYND-382, the `[[^^`
/// picker) — `{note_id, note_title, block_id, preview}` per anchor. The picker
/// sorts + filters TS-side and inserts a `[[<note>^block_id]]` deep-link on
/// pick. Enumerate-only: this surfaces markers that already exist (import),
/// never mints one. Rejected with [`VaultIndicesError::SlotNotUnlocked`] when no
/// vault is unlocked (the index is plaintext-derived RAM, unlocked-only).
#[tauri::command]
pub async fn vault_indices_block_anchors(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<VaultBlockAnchor>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.all_block_anchors(MAX_BLOCK_ANCHORS))
}

/// Structurally-isolated ("orphan") note ids — zero in+out raw edges
/// (MYND-197 / SYNC-13). A degree-0 index query, so the orphans-only graph
/// view works at any vault size without an edge dump. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
#[tauri::command]
pub async fn vault_indices_orphans(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<String>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.orphans())
}

/// Return a note's raw outbound wikilink edges (Task 2). The TS `forward()`
/// wrapper resolves each edge via the single resolver (`resolveWikilink.ts`,
/// plain-B) into resolved + broken targets. Empty when the note is absent /
/// linkless. Rejected with [`VaultIndicesError::SlotNotUnlocked`] when no
/// vault is unlocked.
#[tauri::command]
pub async fn vault_indices_forward(
    note_id: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<WikilinkEdge>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.forward(&note_id))
}

/// Return every candidate backlink edge naming `title_key` (Task 3) — all
/// source notes' edges whose folded target title-key matches. The TS
/// `backlinks()` wrapper resolves each via the single resolver, keeps
/// those resolving to the queried note, and groups by source. `title_key`
/// is folded TS-side (§3.7.8) before the call. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
#[tauri::command]
pub async fn vault_indices_backlink_candidates(
    title_key: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<CandidateEdge>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.backlink_candidates(&title_key))
}

/// Note ids tagged with `folded_tag` or any descendant (Task 4) —
/// subtree-inclusive. The query key is folded TS-side (§3.7.8) before the
/// call so write-fold == query-fold. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
#[tauri::command]
pub async fn vault_indices_by_tag(
    folded_tag: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<String>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.by_tag(&folded_tag))
}

/// The full tag tree (Task 4) — nodes with direct + subtree counts and a
/// deterministic display, derived from the stored exact folded tags.
/// Rejected with [`VaultIndicesError::SlotNotUnlocked`] when no vault is
/// unlocked.
#[tauri::command]
pub async fn vault_indices_tag_tree(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<TagTreeNode>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.tag_tree())
}

/// Return a note's typed frontmatter properties (Task 7 / MYND-271) — the
/// opaque pre-typed values TS stored on `apply`. Empty when the note is
/// absent / propertyless. Pure accessor: type-aware filter/sort happens
/// TS-side in the query-engine sub-feature; there is **no** evaluatable
/// expression hook here. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
#[tauri::command]
pub async fn vault_indices_note_properties(
    note_id: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<PropertyEntry>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.note_properties(&note_id))
}

/// Vault-wide by-key property accessor (Task 7 / MYND-271) — `(noteId, entry)`
/// for every note carrying a property named `key`. The query engine's
/// primitive: it compares + filters these values TS-side (`rating > 4`, sort by
/// `due`, …). Returns vault-wide property metadata (AS3/AS4-Sensitive) →
/// main-window-only, same invariant as the other index reads. No comparison
/// logic and **no expression evaluation** lives in Rust. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
#[tauri::command]
pub async fn vault_indices_property_values(
    key: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<(String, PropertyEntry)>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.property_values(&key))
}

/// Remove a hard-deleted note from the index (no-op if absent).
///
/// Trash does NOT route here — a trashed note stays indexed and is
/// filtered TS-side via `isTrashed` (T3, Task 6). Only hard-delete /
/// empty-trash removes. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
#[tauri::command]
pub async fn vault_indices_remove(
    note_id: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<(), VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    indices.remove(&note_id);
    Ok(())
}

// ---- MYI1 persistence (Task 8 / MYND-271) -----------------------------------
//
// The encrypted-at-rest projection of the in-RAM index. Build-B: Rust owns the
// blob codec + the staleness scan, but extraction stays TS-side — so hydrate
// returns the STALE note ids for TS to re-read + re-parse + re-apply (it cannot
// re-extract a changed note itself). The persisted blob is a derived,
// rebuildable cache (§9.8.4 / SYNC-1): absent / undecodable / stale → an empty
// load → every on-disk note stale → a full TS rebuild. The pure core
// (encode/decode snapshot + reconcile_delta) lives in `super::persist`.

/// Read `vault.meta`'s `account_number_hash` — the AAD binding for the
/// `vault.indices` blob (spec §9.8.3 + §9.3 offset 6). Not cached; a single
/// ~345-byte read + parse (same lazy cadence as prefs / search).
fn read_account_number_hash(
    vault_meta_path: &Path,
) -> Result<[u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN], VaultIndicesError> {
    let bytes = std::fs::read(vault_meta_path).map_err(|_| VaultIndicesError::InvalidVaultMeta)?;
    let meta = parse_vault_meta(&bytes).map_err(|_| VaultIndicesError::InvalidVaultMeta)?;
    Ok(meta.account_number_hash)
}

// The decryption-free on-disk nonce scan (`scan_on_disk_manifest`) is shared
// with the search index's persistence — reused from `crate::note_nonce` rather
// than duplicated, since both features diff the identical `.myn` `content_nonce`
// staleness signal.

/// Persist the live in-RAM index to the encrypted `vault.indices` (`MYI1`)
/// blob (Task 8). Snapshots the store, pairs it with a freshly-scanned nonce
/// manifest (so the persisted snapshot matches disk exactly → the next unlock
/// reconciles a minimal delta), encrypts (CPU-bound serialize + AEAD in
/// `spawn_blocking`), and `atomic_write`s it. MUST run while `Slot::Unlocked`
/// (peeks `root_key`); the writer-guard is held across the write (SYNC-6).
/// Best-effort — every failure leaves the RAM index intact and the next unlock
/// rebuilds. DENY-list clean (no path / key / id logged). Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
#[tauri::command]
pub async fn vault_indices_persist<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<(), VaultIndicesError> {
    // SYNC-6 writer-guard held across the atomic_write below (MYND-32 pattern).
    let (_slots_guard, root_key, _vmh) = runtime
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(VaultIndicesError::SlotNotUnlocked)?;
    let active_id = runtime.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root(&app, active_id)
        .map_err(|_| VaultIndicesError::PersistIo)?;
    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"))?;
    let notes_dir =
        crate::paths::notes_dir_under(&vault_dir).map_err(|_| VaultIndicesError::PersistIo)?;

    let vault_indices_key = derive_subkey(&root_key, SubkeyRole::VaultIndicesKey);
    let manifest = scan_on_disk_manifest(&notes_dir);
    let records = indices.snapshot();

    let blob = tokio::task::spawn_blocking(move || {
        encode_snapshot(
            &vault_indices_key,
            &account_number_hash,
            &manifest,
            &records,
        )
    })
    .await
    .map_err(|_| VaultIndicesError::PersistIo)?
    .map_err(|_| VaultIndicesError::PersistIo)?;

    crate::atomic_write::atomic_write(
        &vault_dir.join("vault.indices"),
        &blob,
        /* replace = */ true,
    )
    .map_err(|_| VaultIndicesError::PersistIo)?;

    tracing::info!(event = "vault_indices_persisted");
    Ok(())
}

/// Hydrate the in-RAM index from the encrypted `vault.indices` blob on unlock
/// (Task 8) — the fast path. Loads + decodes the snapshot, populates the store
/// with the loaded records (the unchanged-note fast path), drops notes deleted
/// since the snapshot, and returns the **stale** note ids (changed / new) for
/// TS to re-read + re-parse + re-apply (Build-B reconcile). Absent / AEAD-fail
/// / unsupported-format / malformed blob → an empty load → every on-disk note
/// is stale → TS does a full rebuild (the cache is never authoritative). MUST
/// run while `Slot::Unlocked`. DENY-list clean. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
#[tauri::command]
pub async fn vault_indices_hydrate<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<String>, VaultIndicesError> {
    let (root_key, _vmh) = runtime
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(VaultIndicesError::SlotNotUnlocked)?;
    let active_id = runtime.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root(&app, active_id)
        .map_err(|_| VaultIndicesError::PersistIo)?;
    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"))?;
    let notes_dir =
        crate::paths::notes_dir_under(&vault_dir).map_err(|_| VaultIndicesError::PersistIo)?;
    let vault_indices_key = derive_subkey(&root_key, SubkeyRole::VaultIndicesKey);

    // Decryption-free staleness scan of the current notes dir.
    let on_disk = scan_on_disk_manifest(&notes_dir);

    // Fast path: decode the persisted snapshot. Absent / AEAD-fail / malformed
    // → empty (manifest, records) → every on-disk note stale → full rebuild.
    let (manifest, records) = std::fs::read(vault_dir.join("vault.indices"))
        .ok()
        .and_then(|blob| decode_snapshot(&vault_indices_key, &account_number_hash, &blob))
        .unwrap_or_default();

    let delta = reconcile_delta(&manifest, &on_disk);

    // Populate the store with the loaded records, EXCLUDING notes deleted since
    // the snapshot — filtering before the install avoids installing-then-
    // removing them. Unchanged notes are served immediately; the stale ids
    // return to TS for re-apply.
    let mut records = records;
    for id in &delta.deleted {
        records.remove(id);
    }
    indices.bulk_replace(records);

    tracing::info!(
        event = "vault_indices_hydrated",
        stale = delta.stale.len(),
        total = on_disk.len(),
    );
    Ok(delta.stale)
}
