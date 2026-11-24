// SPDX-License-Identifier: AGPL-3.0-only
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
//! See: ../../AGENTS.md "Secret-handling logging discipline".

use super::calendar::CalendarRange;
use super::error::VaultIndicesError;
use super::persist::{decode_snapshot, encode_snapshot, reconcile_delta};
use super::state::{
    BlockAnchor, CandidateEdge, HeadingEntry, NoteRecord, PropertyEntry, TagEntry, TagTreeNode,
    TaskRecord, VaultBlockAnchor, VaultHeadingRow, VaultIndicesState, VaultTask, WikilinkEdge,
};
use crate::host::HostCtx;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use protocol::{parse_vault_meta_any, SubkeyRole, VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN};
use std::path::Path;
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
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
pub async fn vault_indices_apply_from_host(
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
    // MYND-612: line-tasks TS extracted. `Option` for the same reason
    // `block_anchors` is — a caller that omits it (mobile, which has its own
    // extractor, or an older desktop build) is `None` → `[]`, so the wire shape
    // stays compatible in both directions.
    tasks: Option<Vec<TaskRecord>>,
    headings: Option<Vec<HeadingEntry>>,
    // myne-md/myne#848: whether the producer's `isLiveNote` classified this note
    // as part of the working set.
    //
    // **REQUIRED, unlike the three vectors above** (review finding): those are
    // display data and an absent one costs an empty list, while this is a
    // PERMISSION input. A default would fail OPEN (every note in the agent's
    // scope) and the wire-compat reason the neighbours give does not exist here:
    // the WebView ships in the same binary, mobile's own wrapper takes `live` as
    // required, and the web dispatcher does not reach this command. So an absent
    // field is a deserialization failure, which the wrapper reports, rather than
    // a silent widening.
    live: bool,
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
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
            // MYND-612: opaque verbatim task fields. Rust stores and returns
            // them; it parses no date and compares nothing — §3.8.3 typing
            // belongs to the dialect layer, TS-side.
            tasks: tasks.unwrap_or_default(),
            // myne#216: the note's headings, for the vault-wide `[[##` picker.
            // Unlike the two fields above, TS reads these off the parse it
            // already ran — no additional extraction pass.
            headings: headings.unwrap_or_default(),
            // myne-md/myne#848: the producer's verdict, not a re-derivation. The
            // agent's scope reads this so the working set is the sidebar's.
            live,
        },
    );
    Ok(())
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
///
/// The argument count is inherited, not introduced: each field is a distinct
/// IPC argument and bundling them would change the wire shape.
#[allow(clippy::too_many_arguments)]
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
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
    // MYND-612: line-tasks TS extracted, same `Option` wire-compat shape as
    // `block_anchors`.
    tasks: Option<Vec<TaskRecord>>,
    // myne#216: the note's headings, same `Option` wire-compat shape again.
    headings: Option<Vec<HeadingEntry>>,
    // myne-md/myne#848: the producer's `isLiveNote` verdict. **Not `Option`**,
    // unlike the three vectors above: those carry display data and an omission
    // costs an empty list, while this is the permission the agent's scope reads,
    // so an omission must be a refusal rather than a default. Every client in
    // this tree sends it (the desktop and mobile wrappers both take it as
    // required), and the web dispatcher does not reach this command.
    live: bool,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<(), VaultIndicesError> {
    vault_indices_apply_from_host(
        note_id,
        title,
        folder,
        title_key,
        wikilinks,
        tags,
        properties,
        block_anchors,
        tasks,
        headings,
        live,
        runtime.inner(),
        indices.inner(),
    )
    .await
}

/// Defensive ceiling on a single whole-vault edge dump. The client no longer
/// caps the graph by note count (the whole vault renders at any size), so this
/// is the SOLE guard bounding a pathological IPC payload — a high, finite
/// DoS/memory backstop, NOT a render limit (cf. per-blob pre-alloc caps
/// §9.2/§9.6.5). Sized well above any realistic vault (~200k notes × ~10 links).
const MAX_GRAPH_EDGES: usize = 2_000_000;

/// Whole-vault edge dump — `[(note_id, edges)]` for every indexed note
/// (MYND-197). The TS graph adapter resolves the raw edges once against the
/// resident note-set and lays the graph out off-thread. The client dumps the
/// WHOLE vault (no node cap); the [`MAX_GRAPH_EDGES`] ceiling is the sole
/// defensive backstop against a pathological payload. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
pub async fn vault_indices_all_edges_from_host(
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<(String, Vec<WikilinkEdge>)>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.all_edges(MAX_GRAPH_EDGES))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_all_edges(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<(String, Vec<WikilinkEdge>)>, VaultIndicesError> {
    vault_indices_all_edges_from_host(runtime.inner(), indices.inner()).await
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
pub async fn vault_indices_block_anchors_from_host(
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<VaultBlockAnchor>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.all_block_anchors(MAX_BLOCK_ANCHORS))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_block_anchors(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<VaultBlockAnchor>, VaultIndicesError> {
    vault_indices_block_anchors_from_host(runtime.inner(), indices.inner()).await
}

/// Defensive ceiling on a whole-vault heading dump (myne#216). Headings are far
/// denser than block anchors — every note has some — so this is sized against a
/// large vault (~200k notes) rather than the sparse case, and still only bounds
/// a pathological payload.
const MAX_HEADINGS: usize = 1_000_000;

/// Every heading across the vault (myne#216) — `{note_id, text, level}` per
/// heading, for the `[[##` vault-wide heading picker.
///
/// **This exists to replace a full-vault read.** The picker's set was previously
/// derived by re-reading and re-parsing every note body on each index change,
/// i.e. work proportional to the vault on every autosave. The headings now ride
/// the `apply` that autosave already performs, and this is the one query that
/// serves them.
///
/// Rows are trash-blind, like every accessor here: the caller joins against the
/// resident note-set, which is the single place trashed/template exclusion lives
/// (`resolverNotes.ts`). Rejected with [`VaultIndicesError::SlotNotUnlocked`]
/// when no vault is unlocked (the index is plaintext-derived RAM, unlocked-only).
pub async fn vault_indices_headings_from_host(
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<VaultHeadingRow>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.all_headings(MAX_HEADINGS))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_headings(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<VaultHeadingRow>, VaultIndicesError> {
    vault_indices_headings_from_host(runtime.inner(), indices.inner()).await
}

/// Defensive ceiling on a whole-vault task dump, parallel to the block-anchor
/// ceiling: a high, finite bound on a pathological IPC payload rather than a
/// product limit anyone should reach.
const MAX_TASKS: usize = 100_000;

/// Every line-task across the vault (MYND-612) — the record plus the note that
/// carries it. **Rust filters nothing**: no date comparison, no sorting, no tag
/// matching. A parameterized accessor was rejected because it would require Rust
/// to compare dates, and the next request after that is sorting and the one
/// after is tag filtering — at which point the §3.6.4 type authority has quietly
/// moved out of the dialect layer. Surfaces filter TS-side over one shared
/// fetch. Rejected with [`VaultIndicesError::SlotNotUnlocked`] when no vault is
/// unlocked (the index is plaintext-derived RAM, unlocked-only).
pub async fn vault_indices_tasks_from_host(
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<VaultTask>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.all_tasks(MAX_TASKS))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_tasks(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<VaultTask>, VaultIndicesError> {
    vault_indices_tasks_from_host(runtime.inner(), indices.inner()).await
}

/// The calendar's range read (myne-md/myne#1037).
///
/// `bounded` is the caller's choice and it is the SECURITY half of this command,
/// not a performance option: the user's own pane may ask for any window, while the
/// fifth agent tool asks bounded, so "the whole calendar in one call" is
/// structurally unreachable from the model's side. The window is parsed here from
/// the same wall-clock shape the event fields carry (`markdown-dialect.md` §3.10.2),
/// so a caller cannot smuggle an offset or a zone into a query.
pub async fn vault_indices_calendar_range_from_host(
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
    window_start: String,
    window_end: String,
    bounded: bool,
) -> Result<CalendarRange, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    let start = crate::plugins::vault_indices::calendar::EventInstant::parse(&window_start)
        .ok_or(VaultIndicesError::CalendarWindowUnreadable)?;
    let end = crate::plugins::vault_indices::calendar::EventInstant::parse(&window_end)
        .ok_or(VaultIndicesError::CalendarWindowUnreadable)?;
    let bound = crate::plugins::vault_indices::calendar::bound_for_window(start, end, bounded)
        .map_err(|refusal| match refusal {
            crate::plugins::vault_indices::calendar::WindowRefusal::Unreadable => {
                VaultIndicesError::CalendarWindowUnreadable
            }
            crate::plugins::vault_indices::calendar::WindowRefusal::TooWide { max_days } => {
                VaultIndicesError::CalendarWindowTooWide { max_days }
            }
        })?;
    Ok(crate::plugins::vault_indices::calendar::range(
        indices, start, end, bound,
    ))
}

/// IPC wrapper.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_calendar_range(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
    window_start: String,
    window_end: String,
    bounded: bool,
) -> Result<CalendarRange, VaultIndicesError> {
    vault_indices_calendar_range_from_host(
        runtime.inner(),
        indices.inner(),
        window_start,
        window_end,
        bounded,
    )
    .await
}

/// Structurally-isolated ("orphan") note ids — zero in+out raw edges
/// (MYND-197 / SYNC-13). A degree-0 index query, so the orphans-only graph
/// view works at any vault size without an edge dump. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
pub async fn vault_indices_orphans_from_host(
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<String>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.orphans())
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_orphans(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<String>, VaultIndicesError> {
    vault_indices_orphans_from_host(runtime.inner(), indices.inner()).await
}

/// Return a note's raw outbound wikilink edges (Task 2). The TS `forward()`
/// wrapper resolves each edge via the single resolver (`resolveWikilink.ts`,
/// plain-B) into resolved + broken targets. Empty when the note is absent /
/// linkless. Rejected with [`VaultIndicesError::SlotNotUnlocked`] when no
/// vault is unlocked.
pub async fn vault_indices_forward_from_host(
    note_id: String,
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<WikilinkEdge>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.forward(&note_id))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_forward(
    note_id: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<WikilinkEdge>, VaultIndicesError> {
    vault_indices_forward_from_host(note_id, runtime.inner(), indices.inner()).await
}

/// Return every candidate backlink edge naming `title_key` (Task 3) — all
/// source notes' edges whose folded target title-key matches. The TS
/// `backlinks()` wrapper resolves each via the single resolver, keeps
/// those resolving to the queried note, and groups by source. `title_key`
/// is folded TS-side (§3.7.8) before the call. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
pub async fn vault_indices_backlink_candidates_from_host(
    title_key: String,
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<CandidateEdge>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.backlink_candidates(&title_key))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_backlink_candidates(
    title_key: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<CandidateEdge>, VaultIndicesError> {
    vault_indices_backlink_candidates_from_host(title_key, runtime.inner(), indices.inner()).await
}

/// Note ids tagged with `folded_tag` or any descendant (Task 4) —
/// subtree-inclusive. The query key is folded TS-side (§3.7.8) before the
/// call so write-fold == query-fold. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
pub async fn vault_indices_by_tag_from_host(
    folded_tag: String,
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<String>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.by_tag(&folded_tag))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_by_tag(
    folded_tag: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<String>, VaultIndicesError> {
    vault_indices_by_tag_from_host(folded_tag, runtime.inner(), indices.inner()).await
}

/// The full tag tree (Task 4) — nodes with direct + subtree counts and a
/// deterministic display, derived from the stored exact folded tags.
/// Rejected with [`VaultIndicesError::SlotNotUnlocked`] when no vault is
/// unlocked.
pub async fn vault_indices_tag_tree_from_host(
    folder: Option<String>,
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<TagTreeNode>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.tag_tree(folder.as_deref()))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_tag_tree(
    // myne-md/myne#908 item 8: optional, so an older caller (mobile, or a build
    // that predates this) keeps the whole-vault answer instead of a wire break.
    folder: Option<String>,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<TagTreeNode>, VaultIndicesError> {
    vault_indices_tag_tree_from_host(folder, runtime.inner(), indices.inner()).await
}

/// Vault-wide by-key property accessor (Task 7 / MYND-271) — `(noteId, entry)`
/// for every note carrying a property named `key`. The query engine's
/// primitive: it compares + filters these values TS-side (`rating > 4`, sort by
/// `due`, …). Returns vault-wide property metadata (AS3/AS4-Sensitive) →
/// main-window-only, same invariant as the other index reads. No comparison
/// logic and **no expression evaluation** lives in Rust. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
pub async fn vault_indices_property_values_from_host(
    key: String,
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<(String, PropertyEntry)>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.property_values(&key))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_property_values(
    key: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<(String, PropertyEntry)>, VaultIndicesError> {
    vault_indices_property_values_from_host(key, runtime.inner(), indices.inner()).await
}

/// Vault-wide DISTINCT frontmatter property-key list — the saved-view authoring
/// UI's picker source (groupBy / sort / columns are chosen from the keys that
/// actually exist). Returns vault-wide property-key metadata (AS3/AS4-Sensitive)
/// → main-window-only, same invariant as `vault_indices_property_values`. No
/// values, no comparison, no expression eval. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
pub async fn vault_indices_property_keys_from_host(
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<Vec<String>, VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    Ok(indices.property_keys())
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_property_keys(
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<String>, VaultIndicesError> {
    vault_indices_property_keys_from_host(runtime.inner(), indices.inner()).await
}

/// Remove a hard-deleted note from the index (no-op if absent).
///
/// Trash does NOT route here — a trashed note stays indexed and is
/// filtered TS-side via `isTrashed` (T3, Task 6). Only hard-delete /
/// empty-trash removes. Rejected with
/// [`VaultIndicesError::SlotNotUnlocked`] when no vault is unlocked.
pub async fn vault_indices_remove_from_host(
    note_id: String,
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
) -> Result<(), VaultIndicesError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(VaultIndicesError::SlotNotUnlocked);
    }
    indices.remove(&note_id);
    Ok(())
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_remove(
    note_id: String,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<(), VaultIndicesError> {
    vault_indices_remove_from_host(note_id, runtime.inner(), indices.inner()).await
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
async fn read_account_number_hash(
    io: &dyn crate::vault_io::VaultIo,
    vault_meta_path: &Path,
) -> Result<
    (
        protocol::MetaVersion,
        [u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN],
    ),
    VaultIndicesError,
> {
    let bytes = io
        .read(vault_meta_path)
        .await
        .map_err(|_| VaultIndicesError::InvalidVaultMeta)?;
    let version = protocol::meta_version_of(&bytes).unwrap_or(protocol::MetaVersion::V0_1);
    let meta = parse_vault_meta_any(&bytes).map_err(|_| VaultIndicesError::InvalidVaultMeta)?;
    Ok((version, meta.account_number_hash))
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
pub async fn vault_indices_persist_from_host(
    host: &dyn HostCtx,
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), VaultIndicesError> {
    // SYNC-6 writer-guard held across the atomic_write below (MYND-32 pattern).
    let (_slots_guard, shared, _vmh) = runtime
        .hold_unlocked_shared_singleton_material()
        .await
        .ok_or(VaultIndicesError::SlotNotUnlocked)?;
    // Hold off a shared-singleton reseal across this read-modify-write
    // (myne-md/myne#711 task 15).
    let _quiesce = crate::singleton_quiesce::shared().await;
    let active_id = runtime.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root_from_host(host, active_id)
        .map_err(|_| VaultIndicesError::PersistIo)?;
    let (meta_version, account_number_hash) =
        read_account_number_hash(io, &vault_dir.join("vault.meta")).await?;
    // `notes_dir_under` both validates and CREATES; through the seam so the
    // wasm arm can do the same. `<vault>/notes` existing is the precondition —
    // an index persist for a vault with no notes dir is a no-op waiting to
    // happen, not an error.
    let notes_dir = vault_dir.join("notes");
    io.create_dir_all(&notes_dir)
        .await
        .map_err(|_| VaultIndicesError::PersistIo)?;

    let vault_indices_key = shared.derive(meta_version, SubkeyRole::VaultIndicesKey);
    let manifest = crate::note_nonce::scan_on_disk_manifest_io(io, &notes_dir).await;
    let records = indices.snapshot();

    let blob = crate::task::run_blocking(move || {
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

    io.write(
        &vault_dir.join("vault.indices"),
        &blob,
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(|_| VaultIndicesError::PersistIo)?;

    tracing::info!(event = "vault_indices_persisted");
    Ok(())
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_persist<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<(), VaultIndicesError> {
    vault_indices_persist_from_host(
        &TauriHost::new(app),
        runtime.inner(),
        indices.inner(),
        &crate::vault_io::StdVaultIo,
    )
    .await
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
pub async fn vault_indices_hydrate_from_host(
    host: &dyn HostCtx,
    runtime: &VaultRuntimeState,
    indices: &VaultIndicesState,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<Vec<String>, VaultIndicesError> {
    let shared = runtime
        .peek_unlocked_shared_singleton_key()
        .await
        .ok_or(VaultIndicesError::SlotNotUnlocked)?;
    let active_id = runtime.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root_from_host(host, active_id)
        .map_err(|_| VaultIndicesError::PersistIo)?;
    let (meta_version, account_number_hash) =
        read_account_number_hash(io, &vault_dir.join("vault.meta")).await?;
    let notes_dir = vault_dir.join("notes");
    io.create_dir_all(&notes_dir)
        .await
        .map_err(|_| VaultIndicesError::PersistIo)?;
    let vault_indices_key = shared.derive(meta_version, SubkeyRole::VaultIndicesKey);

    // Decryption-free staleness scan of the current notes dir, through the seam.
    let on_disk = crate::note_nonce::scan_on_disk_manifest_io(io, &notes_dir).await;

    // Fast path: decode the persisted snapshot. Absent / AEAD-fail / malformed
    // → empty (manifest, records) → every on-disk note stale → full rebuild.
    // Through the SINGLETON fallback (myne#301) — same reasoning as the search
    // snapshot: rebuildable, but a torn slot discarding an intact copy costs a
    // full vault re-parse on the one path built to avoid it.
    let (manifest, records) = crate::singleton::open_newest_and_sweep(
        io,
        &vault_dir.join("vault.indices"),
        |blob: &[u8]| decode_snapshot(&vault_indices_key, &account_number_hash, blob).ok_or(()),
    )
    .await
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

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_indices_hydrate<R: Runtime>(
    app: AppHandle<R>,
    runtime: State<'_, VaultRuntimeState>,
    indices: State<'_, VaultIndicesState>,
) -> Result<Vec<String>, VaultIndicesError> {
    vault_indices_hydrate_from_host(
        &TauriHost::new(app),
        runtime.inner(),
        indices.inner(),
        &crate::vault_io::StdVaultIo,
    )
    .await
}
