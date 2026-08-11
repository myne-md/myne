// SPDX-License-Identifier: AGPL-3.0
//! Embed-on-unlock trigger (semantic-search-qa task 3): the thin, best-effort
//! desktop glue that fires the tested [`indexing::embed_all`] walk after a vault
//! unlocks.
//!
//! Shape mirrors `notes::search_sync::hydrate_search_index` — a thin impure
//! wrapper over the vault-runtime state, gathering decrypted note bodies through
//! the sanctioned `note_read` path and reusing the pure, unit-tested mechanism
//! (here [`indexing::embed_all`]) for the actual work. The only NEW logic is
//! folder derivation + the exclusion predicate, both pure and tested below.
//!
//! Sequence:
//! 1. **Gate on the opt-in.** Read `vault.prefs`; if `ai_enabled` is off (the
//!    default — the feature ships opt-in + default-off, SYNC-12) there is nothing
//!    to do. This is the ONLY cost the default AI-off user pays: one prefs
//!    decrypt, the same cadence `apply_persisted_prefs` already runs on unlock.
//! 2. **Probe readiness.** A single cheap `Engine::embed` probe short-circuits
//!    the walk when no model is side-loaded (`NotReady`), so an opted-in-but-no-
//!    model unlock never decrypts every note only to discover it cannot embed.
//! 3. **Walk + embed detached.** The gather (async decrypt) + embed (model-bound,
//!    under `spawn_blocking`) run in a detached task so unlock returns
//!    immediately — the search-index hydrate is bounded and runs inline, but an
//!    LLM-grade embed pass is not, so it must not block the unlock hot path.
//! 4. **Publish guarded.** Before merging the freshly embedded vectors into the
//!    `app.manage`d RAM store, re-check the slot is still `Unlocked` for the same
//!    vault — an idle auto-lock firing mid-embed must not leave plaintext-derived
//!    embeddings resident for a locked vault (an AS1 leak). Teardown
//!    (`zeroize_ai_vectors`) still wins the race in Phase-1 single-window: the
//!    re-check is await-free-adjacent and the merge critical section holds only
//!    the std-Mutex, never spanning a suspension point.
//!
//! Best-effort end-to-end — a locked slot, an absent model, or an IO miss stops
//! the walk silently and never blocks or fails unlock.
//!
//! Secret-handling (`src-tauri/CLAUDE.md`): note bodies + derived folders are
//! plaintext — never logged (DENY-list). Only bounded, id-free counters reach
//! `tracing`. The transient `Vec<NoteForIndex>` holds decrypted bodies for the
//! duration of the walk, exactly as `search_sync`'s rebuild `fetched` map does,
//! and is dropped when the detached task ends.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

use myne_core::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};

use protocol::{derive_subkey, parse_vault_meta, SubkeyRole};

use myne_core::plugins::notes::note_id::NoteId;

use crate::plugins::notes::commands::{enumerate_notes_dir, note_read_with_dir};
use crate::plugins::notes::title_extract::{extract_title_slices, fm_folder};
use crate::search::persist::{read_myn_content_nonce, MYN_HEADER_PREFIX_FOR_NONCE};

use super::chunker::{ChunkParams, CHUNKER_VERSION};
use super::embeddings_persist::{
    decode_snapshot, encode_snapshot, EmbeddingsIdentity, ModelIdentity,
};
use super::indexing::{embed_all, embed_note, reconcile, NoteForIndex};
use super::state::LocalInferenceState;
use super::vector_store::{AiVectorStore, LocalInferenceVectorState};

/// The canonical trailing-slash folder for a note's decrypted body (`""` =
/// root), read from the frontmatter `folder:` field the same way the export
/// engine does. Pure + testable.
pub fn folder_of(body: &str) -> String {
    extract_title_slices(body.as_bytes())
        .frontmatter_bytes
        .and_then(fm_folder)
        .unwrap_or_default()
}

/// The text the AI actually embeds for a note body.
///
/// For an ordinary note this is the body verbatim. For a `kind: drawing` note
/// the body is Excalidraw scene JSON, and what gets embedded is its projected
/// text elements — the same thing the search index stores (SF5 / MYND-502).
/// Embedding the raw JSON puts coordinates, element ids and version counters
/// into the vector store and leaves the words the user actually wrote buried
/// among them.
///
/// **Projecting here rather than at the hook's call sites** (myne#304): the
/// exclusion check just above needs the frontmatter, which a projected body no
/// longer has — so a drawing inside an AI-excluded folder resolved to root and
/// was embedded anyway. And this walk reads raw bodies off disk regardless, so
/// projecting at the call sites left the eager path storing scene text and the
/// durable `vault.embeddings` blob storing JSON, with every unlock replacing
/// the first with the second.
fn embeddable_body(body: String) -> String {
    if myne_core::plugins::notes::drawing_text::is_drawing(body.as_bytes()) {
        myne_core::plugins::notes::drawing_text::project_drawing_text(body.as_bytes())
            .unwrap_or_default()
    } else {
        body
    }
}

/// Whether `folder` falls under any excluded folder (SYNC-14). A folder is
/// excluded when it EQUALS an excluded entry or is NESTED beneath one. The
/// excluded entries are canonical trailing-slash paths, so a `starts_with`
/// prefix test never false-matches a sibling (`PrivateStuff/` is NOT under
/// `Private/`, because the `/` in the entry breaks the prefix). An empty entry
/// is ignored (a degenerate value that would otherwise exclude the whole vault).
/// Pure + testable.
pub fn folder_is_excluded(folder: &str, excluded: &[String]) -> bool {
    // Delegate to the store's canonical matcher so embed-time exclusion is the
    // SAME case/diacritic-insensitive test the resident store applies (SYNC-14):
    // matching raw strings here let a note under `Private/` embed while the store
    // excluded it under a `private/` entry. `folder_matches_excluded` canonicalizes
    // the folder; canonicalize the excluded entries the same way the store does.
    let canon: Vec<String> = excluded
        .iter()
        .map(|e| super::vector_store::canonical_folder(e))
        .collect();
    super::vector_store::folder_matches_excluded(folder, &canon)
}

/// Read a single `.myn` file's `content_nonce` from its header WITHOUT
/// decrypting (the cleartext-header staleness signal; task 4). `None` on any IO
/// failure / short file / bad magic. Local twin of `search_sync::read_header_
/// nonce` — kept private rather than cross-plugin re-exporting a 4-line reader.
fn read_header_nonce(path: &std::path::Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut header = [0u8; MYN_HEADER_PREFIX_FOR_NONCE];
    file.read_exact(&mut header).ok()?;
    read_myn_content_nonce(&header).map(|n| n.to_vec())
}

/// Read `vault.meta`'s 16-byte `account_number_hash` — the `vault.embeddings`
/// AAD binding (`protocol.md` §9.17.3 + §9.3 offset 6). `None` on any IO /
/// parse failure: best-effort, a missing hash just means the persisted index is
/// skipped (the walk still hydrates the RAM store, un-persisted).
fn read_account_number_hash(vault_meta_path: &std::path::Path) -> Option<[u8; 16]> {
    let bytes = std::fs::read(vault_meta_path).ok()?;
    parse_vault_meta(&bytes)
        .ok()
        .map(|meta| meta.account_number_hash)
}

/// App event fired once the detached embed-on-unlock walk settles (MYND-453).
/// Carries only bounded, id-free counters (DENY-list safe) — the E2E harness
/// (`ai-embeddings-persistence.e2e.ts`) observes it to distinguish a
/// **persistence hit** (`loaded_from_blob = true`, `reembedded = 0`) from a
/// **full rebuild** (`loaded_from_blob = false`, `reembedded > 0` — the
/// model-swap / cold-start path). Surfaced into a `data-testid` by
/// `src/notes/components/AiHydrationProbe.tsx`.
pub const AI_VECTORS_HYDRATED_EVENT: &str = "ai://vectors-hydrated";

/// Payload of [`AI_VECTORS_HYDRATED_EVENT`]. Counts only — never a `note_id`,
/// nonce, or vector (DENY-list; `src-tauri/CLAUDE.md`).
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct AiVectorsHydrated {
    /// Total notes resident in the store after the walk.
    pub embedded: usize,
    /// Whether a persisted `vault.embeddings` blob was loaded under the current
    /// model identity (the persistence hit). `false` on a cold start or an
    /// identity mismatch (model/dim/chunker swap → fall-to-rebuild).
    pub loaded_from_blob: bool,
    /// Notes freshly (re-)embedded this walk — `0` on a clean persistence hit
    /// with no changed notes; `> 0` on a rebuild or a reconcile of changed
    /// notes.
    pub reembedded: usize,
}

/// Embed-on-unlock trigger. See module docs. Best-effort; returns after
/// (optionally) spawning the detached walk. Feature-gated in `DesktopHooks`, so
/// this never compiles into the default auditable build.
pub(crate) async fn hydrate_ai_vectors<R: Runtime>(app: &AppHandle<R>, state: &VaultRuntimeState) {
    let Some(active_id) = state.active_vault_id().await else {
        return;
    };

    // 1. Gate on the opt-in (default OFF). A read failure (locked slot / bad
    //    meta) or `ai_enabled == false` → nothing to do.
    let Ok(vault_dir) = myne_core::paths::active_vault_root_io(app, Some(active_id)) else {
        return;
    };
    let Ok(prefs) = myne_core::plugins::prefs::commands::prefs_read_with_dir(
        &vault_dir,
        state,
        &myne_core::vault_io::StdVaultIo,
    )
    .await
    else {
        return;
    };
    if !prefs.ai_enabled {
        return;
    }
    let excluded = prefs.ai_excluded_folders.clone();

    // Resolve the managed engine + notes dir. A missing engine state = feature
    // wired but plugin not installed → no-op.
    let Some(engine_state) = app.try_state::<LocalInferenceState>() else {
        return;
    };
    // The vault-wide embedding walk (SYNC-16): refused against a remote backend
    // unconditionally. Both reasons apply here at full strength — it fires on
    // unlock without anyone asking, and it is the highest-volume operation in
    // the AI surface.
    let Ok(engine) = engine_state.embedding_engine() else {
        return;
    };
    let Ok(notes_dir) = myne_core::paths::notes_dir_for(app, Some(active_id)) else {
        return;
    };

    // 2 + 3 + 4. Spawn detached so unlock is not blocked on the (model-bound)
    //    embed. The task loads the persisted `vault.embeddings` index, reconciles
    //    it against the current notes (§9.17.4), re-embeds ONLY the delta,
    //    persists the result, then publishes into the RAM store.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Capture the vector-store teardown generation at the START of the walk.
        // If a lock / auto-lock zeroizes the store before we publish, this bumps
        // and the publish below becomes a no-op (see the publish guard) — closing
        // the check-then-fill race that would leave plaintext-derived vectors
        // resident for a locked vault (AS1).
        let gen0 = app
            .try_state::<LocalInferenceVectorState>()
            .map(|vs| vs.generation());
        // Cheap readiness probe that ALSO captures the embedding dimension. A
        // no-model unlock (`NotReady`) never decrypts a note; the dim is part of
        // the model-identity tuple (a dimension change invalidates the index).
        let dim = {
            let probe = Arc::clone(&engine);
            tauri::async_runtime::spawn_blocking(move || {
                probe.embed("ready?").ok().map(|v| v.len())
            })
            .await
            .ok()
            .flatten()
        };
        let Some(dim) = dim else {
            return;
        };

        let vault_state = app.state::<VaultRuntimeState>();

        // The model-identity tuple (§9.17.2), in whichever of its two arms this
        // backend supports. A served model has no file to hash, and asking the
        // runtime costs a round trip — so ask once, here, not per note.
        //
        // Still `Option`: with NEITHER derivation available we cannot name a
        // stable identity, so the load below yields nothing and the walk is a
        // cold, un-persisted embed. That was the ONLY outcome for a served
        // model before the served arm existed, which is the silent regression
        // this arm removes — not a missing feature but the reinstatement of the
        // whole-vault re-embed `MYR1` exists to prevent.
        let model = {
            let probe = Arc::clone(&engine);
            tauri::async_runtime::spawn_blocking(move || probe.served_model_identity())
                .await
                .ok()
                .flatten()
                .map(|(name, digest)| ModelIdentity::Served { name, digest })
                .or_else(|| {
                    super::model_store::embedding_model_hash_for(&app).map(ModelIdentity::FileHash)
                })
        };
        let identity = model.map(|model| EmbeddingsIdentity {
            model,
            embedding_dim: dim as u32,
            chunker_version: CHUNKER_VERSION,
        });

        // Blob KEK + AAD material.
        let ai_key = vault_state
            .peek_unlocked_root_key_and_hash_clone()
            .await
            .map(|(root_key, _vmh)| derive_subkey(&root_key, SubkeyRole::AiEmbeddingsKey));
        let account_hash = read_account_number_hash(&vault_dir.join("vault.meta"));

        // Decryption-free current-nonce scan of every resident note.
        let Ok(ids) = enumerate_notes_dir(&notes_dir) else {
            return;
        };
        let mut current: Vec<(myne_core::plugins::notes::note_id::NoteId, Vec<u8>)> =
            Vec::with_capacity(ids.len());
        for id in &ids {
            let id_str = id.as_uuid().to_string();
            let nonce =
                read_header_nonce(&notes_dir.join(format!("{id_str}.myn"))).unwrap_or_default();
            current.push((*id, nonce));
        }

        // Fast path: load + decode the persisted snapshot under the CURRENT model
        // identity. Absent / AEAD-fail / unsupported-format / malformed /
        // model-identity mismatch → a full cold re-embed (§9.17.4). The blob is
        // NEVER authoritative — a rebuild always recovers the correct index.
        let mut store = AiVectorStore::new();
        // The persistence-hit signal (MYND-453): whether a blob decoded under the
        // CURRENT identity. `false` on a cold start or a model/dim/chunker swap
        // (identity mismatch → fall-to-rebuild). Surfaced in the hydrated event.
        let mut loaded_from_blob = false;
        if let (Some(id), Some(k), Some(h)) = (&identity, &ai_key, &account_hash) {
            if let Some(loaded) = std::fs::read(vault_dir.join("vault.embeddings"))
                .ok()
                .and_then(|blob| decode_snapshot(k, h, &blob, id))
            {
                store = loaded;
                loaded_from_blob = true;
            }
        }

        // Reconcile: (re-)embed new/changed notes, drop deleted ones. On a cold
        // build the store is empty → every current note is `to_embed`.
        let plan = reconcile(&store, &current);
        // Notes freshly (re-)embedded this walk (0 on a clean persistence hit).
        let reembedded = plan.to_embed.len();
        for id in &plan.to_drop {
            store.remove_note(id);
        }

        // Gather bodies for ONLY the delta — unchanged notes keep their loaded
        // vectors and are never re-decrypted (the whole point of persistence). A
        // note unreadable mid-walk is skipped (best-effort, no id/cause logged).
        let nonce_by_id: std::collections::HashMap<_, _> = current.into_iter().collect();
        let mut notes: Vec<NoteForIndex> = Vec::new();
        for id in &plan.to_embed {
            let id_str = id.as_uuid().to_string();
            let Ok(body) = note_read_with_dir(
                notes_dir.clone(),
                &vault_state,
                id_str,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::tauri_host::TauriHost::new(app.clone()),
            )
            .await
            else {
                continue;
            };
            // Folder FIRST, from the raw body — it comes out of the
            // frontmatter, which the projection strips.
            let folder = folder_of(&body);
            let content_nonce = nonce_by_id.get(id).cloned().unwrap_or_default();
            notes.push(NoteForIndex {
                note_id: *id,
                folder,
                body: embeddable_body(body),
                content_nonce,
            });
        }

        // Nothing loaded AND nothing to embed → nothing to do.
        if store.is_empty() && notes.is_empty() {
            return;
        }

        // Embed the delta into the (possibly pre-loaded) store off the async
        // runtime (model-bound, CPU). Reuses the pure, tested `embed_all`.
        let embed_engine = Arc::clone(&engine);
        let excluded_for_embed = excluded.clone();
        let store = tauri::async_runtime::spawn_blocking(move || {
            let mut store = store;
            let _ = embed_all(
                &mut store,
                &notes,
                |folder| folder_is_excluded(folder, &excluded_for_embed),
                ChunkParams::default(),
                |text| embed_engine.embed(text),
            );
            store
        })
        .await;
        let Ok(mut store) = store else {
            return;
        };

        // Apply the live exclusion policy and purge any note that was embedded
        // (or reloaded from the blob) before its folder became excluded — a
        // reconcile hit keeps such a note's vectors, so without this the blob and
        // RAM store would still hold excluded content (SYNC-14). The policy also
        // travels with the store so query-time enforcement + the opt-in gate have
        // an in-RAM source of truth.
        store.set_policy(true, &excluded);
        store.purge_excluded();

        // Persist the reconciled index (best-effort; only while STILL unlocked so
        // a mid-embed lock/delete never recreates a blob for a gone vault). The
        // blob is a pure cache — a torn/failed write just costs one rebuild.
        if let (Some(id), Some(k), Some(h)) = (&identity, &ai_key, &account_hash) {
            if vault_state.slot_kind(active_id).await == SlotKind::Unlocked {
                if let Ok(blob) = encode_snapshot(k, h, &store, id) {
                    let _ = crate::atomic_write::atomic_write(
                        &vault_dir.join("vault.embeddings"),
                        &blob,
                        /* replace = */ true,
                    );
                }
            }
        }

        if store.is_empty() {
            return;
        }
        let embedded = store.embedded_note_ids().len();

        // Publish guarded: only if the vault is STILL unlocked (an idle auto-lock
        //    may have fired mid-embed — do not repopulate a just-zeroized store).
        //    The merge holds only the std-Mutex and spans no await; the reconciled
        //    `store` is the full index, so REPLACE (zeroize-then-fill) the RAM
        //    store rather than merge into a stale one.
        if vault_state.slot_kind(active_id).await != SlotKind::Unlocked {
            return;
        }
        let Some(vector_state) = app.try_state::<LocalInferenceVectorState>() else {
            return;
        };
        {
            let mut resident = vector_state.lock();
            // Second half of the teardown-race guard: if the store was cleared
            // since this walk began (generation bumped), the vault locked
            // mid-walk — do NOT repopulate it. The generation read and the swap
            // both happen under this guard, which `clear()` must also take, so
            // teardown strictly wins.
            if gen0 != Some(vector_state.generation()) {
                return;
            }
            // The reconciled `store` already carries the full index (vectors +
            // nonces + folders + live policy) and was purged of excluded notes,
            // so REPLACE the resident store wholesale (zeroizing the old one)
            // rather than merging into a stale one.
            let mut old = std::mem::replace(&mut *resident, store);
            old.zeroize();
        }
        tracing::info!(
            event = "ai_vectors_hydrated",
            embedded,
            loaded_from_blob,
            reembedded
        );

        // Surface the bounded outcome to the WebView so the persistence behavior
        // is E2E-observable (MYND-453 task 8). Counts + one bool only — DENY-list
        // safe. Best-effort; a failed emit just means no UI probe update.
        let _ = app.emit(
            AI_VECTORS_HYDRATED_EVENT,
            AiVectorsHydrated {
                embedded,
                loaded_from_blob,
                reembedded,
            },
        );
    });
}

/// Idle debounce for the per-save re-embed (#218).
///
/// Autosave fires on a 1000 ms idle debounce (`src/notes/saveNote.ts`), so
/// continuous typing used to schedule roughly one full-note embedding pass per
/// second — each one chunking and re-embedding the WHOLE note for a single
/// changed character, and each one queued behind the others on the single Metal
/// compute lock that inline ghost-text and chat also wait on.
///
/// What MYND-453 guarantees is that a this-session edit is searchable without a
/// re-unlock; it does not require per-save eagerness, so the pass is coalesced
/// onto the LAST save of a note within this window. A burst of N saves costs one
/// embedding pass over the final body instead of N over intermediate ones.
const REEMBED_DEBOUNCE: Duration = Duration::from_secs(5);

/// Per-note generation counter backing [`REEMBED_DEBOUNCE`].
///
/// Keyed by note id, so two notes edited in the same window each get their own
/// pass — the coalescing is per note, not global. Entries are consumed by the
/// pass that claims them, so the map holds only notes with a re-embed currently
/// pending rather than every note ever edited this session.
fn reembed_generations() -> &'static Mutex<HashMap<String, u64>> {
    static GENERATIONS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a newly-requested re-embed for `note_id` and return its generation.
/// Bumping supersedes any pass still sitting in its debounce window.
fn bump_reembed_generation(note_id: &str) -> u64 {
    let mut pending = reembed_generations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let slot = pending.entry(note_id.to_string()).or_insert(0);
    *slot = slot.wrapping_add(1);
    *slot
}

/// Whether the pass holding `generation` is still the newest one for `note_id`
/// — i.e. no later save (and no delete) landed during its debounce window.
/// Claiming consumes the entry, so exactly one pass per window does the work.
fn claim_reembed_generation(note_id: &str, generation: u64) -> bool {
    let mut pending = reembed_generations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if pending.get(note_id) == Some(&generation) {
        pending.remove(note_id);
        true
    } else {
        false
    }
}

/// Supersede any pending re-embed for `note_id` without scheduling one. Used by
/// [`drop_one_note`] so a delete cannot be undone by a pass that was already
/// waiting out its debounce when the delete landed.
fn cancel_pending_reembed(note_id: &str) {
    reembed_generations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(note_id);
}

/// Eager per-note re-embed on save (MYND-453, task 5) — the `ai_note_changed`
/// hook target. Detached + best-effort: re-embeds ONLY this note into the RAM
/// vector store so a this-session create/edit is searchable without a re-unlock.
/// The save critical path never blocks (all work is on a spawned task). The
/// durable `vault.embeddings` blob is NOT written here — it is refreshed by the
/// next unlock's reconcile (§9.17.4), which sees the changed `content_nonce`.
///
/// Coalesced onto the last save of a note within [`REEMBED_DEBOUNCE`] (#218).
pub(crate) fn reembed_one_note<R: Runtime>(app: &AppHandle<R>, note_id: &str, body: &str) {
    let Ok(nid) = NoteId::parse(note_id) else {
        return;
    };
    let generation = bump_reembed_generation(note_id);
    let key = note_id.to_string();
    let app = app.clone();
    let body = body.to_string();
    tauri::async_runtime::spawn(async move {
        // Debounce FIRST, before any vault state is touched: a superseded pass
        // must cost nothing but the sleep. Waiting here also bounds how long the
        // captured plaintext body stays resident after a lock — the vault-state
        // reads below all fail closed once the slot is no longer `Unlocked`.
        tokio::time::sleep(REEMBED_DEBOUNCE).await;
        if !claim_reembed_generation(&key, generation) {
            return;
        }

        // Teardown-generation snapshot (see `hydrate_ai_vectors`): a lock that
        // fires mid-embed makes the publish below a no-op.
        let gen0 = app
            .try_state::<LocalInferenceVectorState>()
            .map(|vs| vs.generation());
        let state = app.state::<VaultRuntimeState>();
        let Some(active_id) = state.active_vault_id().await else {
            return;
        };
        let Ok(vault_dir) = myne_core::paths::active_vault_root_io(&app, Some(active_id)) else {
            return;
        };
        // Gate on the opt-in + fetch the exclusion set.
        let Ok(prefs) = myne_core::plugins::prefs::commands::prefs_read_with_dir(
            &vault_dir,
            &state,
            &myne_core::vault_io::StdVaultIo,
        )
        .await
        else {
            return;
        };
        if !prefs.ai_enabled {
            return;
        }

        // A note in (or moved into) an excluded folder must NOT be embedded, and
        // any stale vectors for it are dropped.
        let folder = folder_of(&body);
        if folder_is_excluded(&folder, &prefs.ai_excluded_folders) {
            if let Some(vs) = app.try_state::<LocalInferenceVectorState>() {
                vs.lock().remove_note(&nid);
            }
            return;
        }

        let Some(engine_state) = app.try_state::<LocalInferenceState>() else {
            return;
        };
        // Per-note re-embed on save — same bar, same two reasons (SYNC-16).
        let Ok(engine) = engine_state.embedding_engine() else {
            return;
        };
        let Ok(notes_dir) = myne_core::paths::notes_dir_for(&app, Some(active_id)) else {
            return;
        };
        let nonce = read_header_nonce(&notes_dir.join(format!("{}.myn", nid.as_uuid())))
            .unwrap_or_default();
        let note = NoteForIndex {
            note_id: nid,
            folder,
            body: embeddable_body(body),
            content_nonce: nonce,
        };

        // Embed off the async runtime (model-bound). A missing model / embed
        // error leaves `local` empty → nothing is published (the note keeps its
        // prior vectors; the next unlock reconciles it).
        let embed_engine = Arc::clone(&engine);
        let local = tauri::async_runtime::spawn_blocking(move || {
            let mut local = AiVectorStore::new();
            let _ = embed_note(&mut local, &note, ChunkParams::default(), |text| {
                embed_engine.embed(text)
            });
            local
        })
        .await;
        let Ok(local) = local else {
            return;
        };
        if local.is_empty() {
            return;
        }

        // Publish guarded: only while STILL unlocked. Replace this note's slice
        // of the RAM store (drop stale vectors, insert fresh) under the std-Mutex.
        if state.slot_kind(active_id).await != SlotKind::Unlocked {
            return;
        }
        let Some(vector_state) = app.try_state::<LocalInferenceVectorState>() else {
            return;
        };
        {
            let mut resident = vector_state.lock();
            // Teardown-race guard (see `hydrate_ai_vectors`): a lock since this
            // walk began means the vault is torn down — do not repopulate.
            if gen0 != Some(vector_state.generation()) {
                return;
            }
            resident.remove_note(&nid);
            for (key, vector) in local.iter() {
                resident.insert_vector(*key, vector.to_vec());
            }
            if let Some(n) = local.nonce(&nid) {
                resident.set_nonce(nid, n.to_vec());
            }
            // Carry the folder so query-time exclusion can classify this note.
            if let Some(f) = local.folder(&nid) {
                resident.set_folder(nid, f.to_string());
            }
        }
    });
}

/// Drop a deleted note's vectors from the RAM store (MYND-453, task 5) — the
/// `ai_note_deleted` hook target. Cheap + synchronous (no model call). The
/// durable blob is refreshed by the next unlock's reconcile, which sees the note
/// gone from disk and drops it there too.
pub(crate) fn drop_one_note<R: Runtime>(app: &AppHandle<R>, note_id: &str) {
    let Ok(nid) = NoteId::parse(note_id) else {
        return;
    };
    // Cancel first: a re-embed scheduled by the save that preceded this delete
    // may still be in its debounce window, and publishing it after the removal
    // below would resurrect the deleted note's vectors (#218).
    cancel_pending_reembed(note_id);
    if let Some(vector_state) = app.try_state::<LocalInferenceVectorState>() {
        vector_state.lock().remove_note(&nid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_of_reads_frontmatter_folder_field() {
        let body = "---\nfolder: Private/\ntitle: Secret\n---\n# Body\n";
        assert_eq!(folder_of(body), "Private/");
    }

    #[test]
    fn folder_of_defaults_to_root_when_absent() {
        assert_eq!(folder_of("# Just a body\nno frontmatter\n"), "");
        assert_eq!(folder_of("---\ntitle: X\n---\nbody"), "");
    }

    #[test]
    fn folder_is_excluded_matches_exact_and_nested() {
        let excluded = vec!["Private/".to_string(), "Work/Secret/".to_string()];
        // Exact match.
        assert!(folder_is_excluded("Private/", &excluded));
        // Nested beneath an excluded folder.
        assert!(folder_is_excluded("Private/Journal/", &excluded));
        assert!(folder_is_excluded("Work/Secret/2026/", &excluded));
    }

    #[test]
    fn folder_is_excluded_does_not_false_match_siblings_or_root() {
        let excluded = vec!["Private/".to_string()];
        // A sibling that merely shares a name prefix is NOT excluded — the
        // trailing slash in the entry breaks the prefix.
        assert!(!folder_is_excluded("PrivateStuff/", &excluded));
        // Root and unrelated folders are not excluded.
        assert!(!folder_is_excluded("", &excluded));
        assert!(!folder_is_excluded("Work/", &excluded));
    }

    #[test]
    fn folder_is_excluded_ignores_empty_entries() {
        // A degenerate empty entry must NOT exclude the whole vault.
        let excluded = vec![String::new()];
        assert!(!folder_is_excluded("Private/", &excluded));
        assert!(!folder_is_excluded("", &excluded));
    }

    #[test]
    fn folder_is_excluded_empty_set_excludes_nothing() {
        assert!(!folder_is_excluded("Private/", &[]));
    }

    // ---- myne#304: what the AI actually embeds -----------------------------

    /// A `kind: drawing` note whose scene carries one text element.
    fn drawing(folder: &str, text: &str) -> String {
        let scene =
            format!(r#"{{"type":"excalidraw","elements":[{{"type":"text","text":"{text}"}}]}}"#);
        format!("---\nkind: drawing\nfolder: {folder}\n---\n\n```excalidraw\n{scene}\n```\n")
    }

    #[test]
    fn a_drawing_is_embedded_as_its_projected_text_not_as_scene_json() {
        let body = drawing("Sketches/", "quarterly roadmap");
        let embedded = embeddable_body(body);
        assert!(
            embedded.contains("quarterly roadmap"),
            "the words the user wrote must survive: {embedded:?}"
        );
        assert!(
            !embedded.contains("excalidraw"),
            "…and the scene JSON must not: {embedded:?}"
        );
    }

    #[test]
    fn an_ordinary_note_is_embedded_verbatim() {
        let body = "---\nfolder: Work/\n---\n# Plan\n\nSome prose.\n".to_string();
        assert_eq!(embeddable_body(body.clone()), body);
    }

    #[test]
    fn the_folder_must_be_read_before_the_projection_strips_the_frontmatter() {
        // The ordering hazard this helper's placement exists for. Projecting at
        // the hook's CALL SITES handed this walk a body with no frontmatter, so
        // `folder_of` answered "root" for every drawing — and a drawing sitting
        // in an AI-excluded folder was embedded anyway, which is the SYNC-14
        // exclusion set failing silently for one note kind.
        let body = drawing("Private/", "bank details");
        assert_eq!(folder_of(&body), "Private/");
        assert!(folder_is_excluded(
            &folder_of(&body),
            &["Private/".to_string()]
        ));
        // Post-projection, the same question has the wrong answer.
        assert_eq!(folder_of(&embeddable_body(body)), "");
    }

    // ---- #218: re-embed debounce generations ------------------------------
    //
    // The generation map is process-global, so each test uses a note id of its
    // own rather than clearing shared state.

    #[test]
    fn a_lone_save_claims_its_own_generation() {
        let id = "debounce-lone";
        let generation = bump_reembed_generation(id);
        assert!(
            claim_reembed_generation(id, generation),
            "an unsuperseded pass must do the work"
        );
    }

    #[test]
    fn a_burst_of_saves_leaves_exactly_one_pass_claiming() {
        let id = "debounce-burst";
        // Ten autosaves inside one debounce window.
        let generations: Vec<u64> = (0..10).map(|_| bump_reembed_generation(id)).collect();
        let (last, superseded) = generations.split_last().expect("ten generations");
        for g in superseded {
            assert!(
                !claim_reembed_generation(id, *g),
                "a superseded pass must not embed"
            );
        }
        assert!(
            claim_reembed_generation(id, *last),
            "the newest pass embeds the final body"
        );
    }

    #[test]
    fn claiming_consumes_the_entry_so_the_map_does_not_grow() {
        let id = "debounce-consumed";
        let generation = bump_reembed_generation(id);
        assert!(claim_reembed_generation(id, generation));
        // Second claim of the same generation finds nothing.
        assert!(!claim_reembed_generation(id, generation));
        assert!(
            !reembed_generations().lock().unwrap().contains_key(id),
            "a claimed note leaves no residue in the pending map"
        );
    }

    #[test]
    fn coalescing_is_per_note_not_global() {
        let (a, b) = ("debounce-note-a", "debounce-note-b");
        let ga = bump_reembed_generation(a);
        let gb = bump_reembed_generation(b);
        assert!(claim_reembed_generation(a, ga));
        assert!(
            claim_reembed_generation(b, gb),
            "a save to one note must not cancel another note's pending pass"
        );
    }

    #[test]
    fn a_delete_cancels_a_pending_reembed() {
        let id = "debounce-deleted";
        let generation = bump_reembed_generation(id);
        cancel_pending_reembed(id);
        assert!(
            !claim_reembed_generation(id, generation),
            "a delete must not be undone by a re-embed still in its window"
        );
    }
}
