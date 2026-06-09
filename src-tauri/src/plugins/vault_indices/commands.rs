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
use super::state::{
    CandidateEdge, NoteRecord, TagEntry, TagTreeNode, VaultIndicesState, WikilinkEdge,
};
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use tauri::State;

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
