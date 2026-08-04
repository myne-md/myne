// SPDX-License-Identifier: AGPL-3.0
//! The `MYS1` search-index lifecycle, shared by every client
//! (phase3-web-client tasks 14 + 83).
//!
//! # What moved here, and what deliberately did not
//!
//! `src-tauri/src/plugins/notes/search_sync.rs` owned the whole thing: load
//! `vault.search`, reconcile it against the notes directory's `.myn` header
//! nonces, decrypt only what changed, and write the snapshot back. None of that
//! is desktop-specific — it is AEAD, a directory scan and a reconcile, all of
//! which a browser does identically.
//!
//! One part **is** desktop-specific, and it is the reason this is an extraction
//! with a seam rather than a file move: the **attachment documents**. A note's
//! embedded attachments become their own search docs, built from the `MYE1`
//! extracted-text cache — and `text_cache`'s producers are
//! `#[cfg(not(target_arch = "wasm32"))]` by construction (task 90 owns the web
//! verdict for `MYE1`, and the extractors behind it are bound to `lopdf` / `zip`
//! / `quick-xml`, which are desktop dependencies).
//!
//! So the attachment layer is **injected** ([`AttachmentDocs`]), exactly like
//! the extractor injection in `attachment_import_with_dir_ext`. Desktop passes
//! an implementation that reads the catalog and the cache; web passes
//! [`NoAttachmentDocs`].
//!
//! # What that means for search on web, stated plainly
//!
//! **A browser's search index covers note bodies and nothing else.** An
//! attachment's text is not searchable there. That is a capability boundary, not
//! a bug and not a gap to be closed by a fallback: the extraction that produces
//! the text cannot run in a browser, so a web index containing `att:` documents
//! could only contain STALE ones, synced from a desktop that built them. Stale
//! attachment hits are worse than absent ones — they point at text this client
//! cannot re-derive or verify.
//!
//! The absence is structural rather than argued: `collect_attachment_texts` does
//! not exist on `wasm32`, so there is no code path that could produce a dangling
//! `att:` doc even by mistake.
//!
//! # Best-effort, at every call site
//!
//! Neither function may block unlock, lock or quit, and neither surfaces a
//! user-facing error. A stale or empty index degrades search until the next
//! reconcile; it never degrades findability of the notes themselves, and never
//! touches note data. The `Result` exists so these are unit-testable — every
//! caller logs and swallows.
//!
//! # The manifest is re-derived at BOTH ends, never held
//!
//! Hydrate scans the notes directory for current header nonces; persist scans it
//! again before writing. Holding the manifest in state would let it drift from
//! disk, and a drifted manifest makes the next unlock re-decrypt everything (the
//! cheap failure) or skip a changed note (the expensive one). The `.myn` headers
//! are the single source of truth for staleness, and reading them costs a short
//! prefix read per note — no decrypt.

use crate::host::HostCtx;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::search::persist::{decode_snapshot, encode_snapshot, reconcile};
use crate::search::SearchIndexState;
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::{derive_subkey, parse_vault_meta, SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN};
use std::collections::HashMap;
use std::path::Path;

/// Why a hydrate / persist did not complete. No payload — the variant name is
/// the whole message, which keeps it DENY-list-safe for tracing.
#[derive(Debug)]
pub enum SearchSyncError {
    /// The slot was not `Unlocked` (the `root_key` peek failed). Hydrate has
    /// nothing to load into; persist has no key.
    SlotNotUnlocked,
    /// `vault.meta` missing or unreadable — needed for the `account_number_hash`
    /// AAD binding.
    InvalidVaultMeta,
    /// A store failure: reading `vault.meta`, scanning headers, or writing
    /// `vault.search`.
    Io,
    /// `encode_snapshot` failed (structurally unreachable under v0.1's fixed
    /// AEAD params; mapped defensively).
    Encode,
    /// The blocking encode task did not complete.
    Join,
}

/// Static label for tracing. A new variant compile-fails the match, which is the
/// point — a silently unlabelled failure is one nobody can grep for.
pub fn search_sync_error_kind(e: &SearchSyncError) -> &'static str {
    match e {
        SearchSyncError::SlotNotUnlocked => "slot_not_unlocked",
        SearchSyncError::InvalidVaultMeta => "invalid_vault_meta",
        SearchSyncError::Io => "io",
        SearchSyncError::Encode => "encode",
        SearchSyncError::Join => "join",
    }
}

/// Emit the skip event for a failed hydrate / persist.
///
/// Lives here rather than at the call site because the wasm entry crate carries
/// no `tracing` dependency — and adding one there to write two `warn!`s would be
/// a dependency decision made sideways, for logging. The event names and the
/// error labels belong next to the error type anyway, so a new variant is
/// labelled once.
///
/// `op` is `"hydrate"` or `"persist"`; both are `&'static str` so nothing
/// caller-supplied can reach the log.
pub fn log_search_sync_skip(op: &'static str, e: &SearchSyncError) {
    tracing::warn!(
        event = "search_index_skipped",
        op,
        reason = search_sync_error_kind(e),
    );
}

/// The per-note attachment-document layer, injected because it cannot exist on
/// every target.
///
/// Called once per note the hydrate actually decrypted — never for an unchanged
/// note, whose docs are already in the loaded snapshot. Returning an EMPTY
/// vector is meaningful and is not the same as not being called: it clears the
/// attachment docs of a note that no longer embeds any.
///
/// `Send` unconditionally: the native hook drives this from a `Send` future, and
/// on wasm32 the bound costs nothing (every implementation there is a unit
/// struct). Gating it per-target would be two trait definitions for one
/// contract, which is the shape the whole seam design exists to avoid.
pub trait AttachmentDocs: Send {
    /// `(attachment_id_hex, title, extracted_text)` for one note's embeds.
    fn for_note(
        &mut self,
        note_id: &str,
        title: &str,
        plaintext: &str,
    ) -> Vec<(String, String, String)>;
}

/// The web (and mobile) answer: no attachment documents at all.
///
/// Not a stub for something owed. The producer that would build these is absent
/// from this target's binary by `cfg`, so there is nothing to call — and an
/// index carrying `att:` docs it cannot re-derive would be worse than one
/// without them. See the module header.
pub struct NoAttachmentDocs;

impl AttachmentDocs for NoAttachmentDocs {
    fn for_note(&mut self, _: &str, _: &str, _: &str) -> Vec<(String, String, String)> {
        Vec::new()
    }
}

async fn account_number_hash(
    io: &dyn VaultIo,
    vault_dir: &Path,
) -> Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], SearchSyncError> {
    let bytes = io
        .read(&vault_dir.join("vault.meta"))
        .await
        .map_err(|_| SearchSyncError::Io)?;
    let meta = parse_vault_meta(&bytes).map_err(|_| SearchSyncError::InvalidVaultMeta)?;
    Ok(meta.account_number_hash)
}

/// Load `vault.search`, reconcile it against the notes directory, and swap the
/// result into `search`.
///
/// A note is decrypted **only** when its `content_nonce` differs from — or is
/// absent in — the loaded manifest. An absent, AEAD-failing or schema-stale blob
/// decodes to an empty pair, which makes the reconcile a full rebuild rather
/// than an error: there is no state in which this refuses to produce an index.
pub async fn hydrate_search_index_core(
    io: &dyn VaultIo,
    host: &dyn HostCtx,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    search: &SearchIndexState,
    attachments: &mut dyn AttachmentDocs,
) -> Result<(), SearchSyncError> {
    let root_key = state
        .peek_unlocked_root_key_clone()
        .await
        .ok_or(SearchSyncError::SlotNotUnlocked)?;
    let account_hash = account_number_hash(io, vault_dir).await?;
    let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);
    // Through the IO seam, NOT `notes_dir_under` (myne#303): that helper's root
    // check is a `std::fs` `Path::is_dir`, which on wasm32 is the
    // unsupported-platform stub and answers `false` for every path — so on the
    // web client this line returned `NotFound` before `vault.search` was ever
    // touched, and the best-effort caller swallowed it as a warning. The MYS1
    // index therefore never hydrated and never persisted there: every session
    // started empty, and only notes created or edited in THAT session were
    // findable. Notes pulled by sync were invisible to the palette entirely.
    let notes_dir = crate::paths::notes_dir_under_io(io, vault_dir)
        .await
        .map_err(|_| SearchSyncError::Io)?;

    // Decryption-free staleness scan: a short header prefix per note.
    let on_disk = crate::note_nonce::scan_on_disk_manifest_io(io, &notes_dir).await;
    let on_disk: crate::note_nonce::NonceManifest = on_disk.into_iter().collect();

    // Through the SINGLETON fallback (myne#301). A rebuildable cache, so a lost
    // snapshot is not data loss — but on the web client a torn slot threw away
    // an intact copy and made every note stale, which is a full re-decrypt of
    // the vault on a path that exists to avoid exactly that.
    let (mut manifest, mut index) = crate::singleton::open_newest_and_sweep(
        io,
        &vault_dir.join("vault.search"),
        |blob: &[u8]| decode_snapshot(&search_index_key, &account_hash, blob).ok_or(()),
    )
    .await
    .unwrap_or_default();

    // Notes that vanished from disk: reconcile drops their body doc, and their
    // separate attachment docs are dropped explicitly below.
    let deleted_note_ids: Vec<String> = manifest
        .keys()
        .filter(|id| !on_disk.contains_key(*id))
        .cloned()
        .collect();

    let mut fetched: HashMap<String, (String, String)> = HashMap::new();
    let mut note_attachments: HashMap<String, Vec<(String, String, String)>> = HashMap::new();
    for (id, nonce) in &on_disk {
        if manifest.get(id) == Some(nonce) {
            continue; // unchanged — never decrypted
        }
        let Ok(plaintext) = crate::plugins::notes::commands::note_read_with_dir(
            notes_dir.clone(),
            state,
            id.clone(),
            io,
            host,
        )
        .await
        else {
            // Unreadable (locked mid-hydrate, corrupt, non-UTF-8): leave it for
            // the next pass. No id or cause logged — reconcile leaves the prior
            // index entry intact, so this degrades to staleness, never to loss.
            continue;
        };
        let title = crate::plugins::notes::title_extract::resolve_note_title(plaintext.as_bytes())
            .unwrap_or_default();

        // A drawing note has no markdown embeds: its body doc is the PROJECTED
        // scene text, never the raw ```excalidraw JSON, and it gets no
        // attachment docs. Parity with the incremental path — without it the
        // projection would survive one session and be replaced by JSON at the
        // next unlock.
        if crate::plugins::notes::drawing_text::is_drawing(plaintext.as_bytes()) {
            let body =
                crate::plugins::notes::drawing_text::project_drawing_text(plaintext.as_bytes())
                    .unwrap_or_default();
            fetched.insert(id.clone(), (title, body));
            continue;
        }

        note_attachments.insert(id.clone(), attachments.for_note(id, &title, &plaintext));
        fetched.insert(id.clone(), (title, plaintext.to_string()));
    }
    let reindexed = fetched.len();

    reconcile(&mut index, &mut manifest, &on_disk, |id| fetched.remove(id));
    for id in &deleted_note_ids {
        index.remove_note_attachments(id);
    }
    for (note_id, atts) in &note_attachments {
        index.set_note_attachments(note_id, atts);
    }
    search.replace(index);

    tracing::info!(
        event = "search_index_hydrated",
        reindexed,
        total = on_disk.len(),
    );
    Ok(())
}

/// Snapshot the live index, pair it with a freshly-scanned nonce manifest, and
/// write the encrypted `vault.search` blob.
///
/// The manifest is re-derived from disk here rather than carried, so the
/// persisted snapshot matches the notes directory exactly and the next unlock
/// takes the skip-everything path. MUST run while the slot is still `Unlocked`.
pub async fn persist_search_index_core(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    search: &SearchIndexState,
) -> Result<(), SearchSyncError> {
    // The writer guard is held across the write below, so a concurrent lock
    // cannot zeroize the key underneath it.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(SearchSyncError::SlotNotUnlocked)?;
    let account_hash = account_number_hash(io, vault_dir).await?;
    let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);
    // Through the IO seam, NOT `notes_dir_under` (myne#303): that helper's root
    // check is a `std::fs` `Path::is_dir`, which on wasm32 is the
    // unsupported-platform stub and answers `false` for every path — so on the
    // web client this line returned `NotFound` before `vault.search` was ever
    // touched, and the best-effort caller swallowed it as a warning. The MYS1
    // index therefore never hydrated and never persisted there: every session
    // started empty, and only notes created or edited in THAT session were
    // findable. Notes pulled by sync were invisible to the palette entirely.
    let notes_dir = crate::paths::notes_dir_under_io(io, vault_dir)
        .await
        .map_err(|_| SearchSyncError::Io)?;

    let on_disk: crate::note_nonce::NonceManifest =
        crate::note_nonce::scan_on_disk_manifest_io(io, &notes_dir)
            .await
            .into_iter()
            .collect();
    let total = on_disk.len();
    let index = search.snapshot();

    // `run_blocking`, not `spawn_blocking`: the native arm dispatches to a
    // worker so a 10k-note encode does not park one, and the wasm arm runs
    // inline — which is correct there, since the Worker thread is already the
    // off-main-thread place this work belongs.
    let key = search_index_key;
    let blob =
        crate::task::run_blocking(move || encode_snapshot(&key, &account_hash, &on_disk, &index))
            .await
            .map_err(|_| SearchSyncError::Join)?
            .map_err(|_| SearchSyncError::Encode)?;

    io.write(&vault_dir.join("vault.search"), &blob, WriteOpts::default())
        .await
        .map_err(|_| SearchSyncError::Io)?;

    tracing::info!(event = "search_index_persisted", total);
    Ok(())
}

// ── the query side (tasks 14 + 83) ─────────────────────────────────────────
//
// Moved here from `src-tauri/src/plugins/notes/desktop_commands.rs` with the
// lifecycle above. Nothing about ranking a query against an in-RAM index is
// platform-specific — it is a gate, a `query`, and a shape change — and leaving
// it behind would have meant a web client with a populated index and no way to
// ask it anything.

/// One ranked hit, as the WebView renders it.
///
/// `matched_in` drives the palette's "matched in body" badge: a body-only hit is
/// a note whose title does not contain the query. Snippets are deliberately
/// absent — the index stores postings and titles, not bodies, and decrypting per
/// hit to build one was rejected on threat-model grounds.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    pub note_id: String,
    pub title: String,
    pub score: f32,
    pub matched_in: crate::search::MatchedIn,
    /// `None` for a note-body hit; `Some(attachment_id_hex)` when the hit is an
    /// embedded attachment's extracted text (its own doc,
    /// `att:<attachment_id>:<note_id>`). `note_id` is the embedding note either
    /// way, so the palette opens the same note; a `Some` badges the row.
    ///
    /// **Always `None` on a browser**, and structurally so: that client's index
    /// carries no `att:` documents because the producer does not exist there.
    pub attachment_id: Option<String>,
}

/// Upper bound on results returned per query.
///
/// The index returns the full BM25-ranked match set, and a broad type-ahead
/// prefix on a large vault can match thousands of notes. The palette renders
/// ~10–20 rows, so an unbounded set is wasted IPC and render. Result-shaping
/// only — the index data model and the `MYS1` blob are untouched.
pub const NOTE_SEARCH_RESULT_CAP: usize = 50;

/// Rank `query` against the live index.
///
/// Gated on `Slot::Unlocked` and returns an EMPTY vector when it is not — not an
/// error. A locked vault has nothing to say about its contents, and an index
/// that has not yet been zeroized must not answer through this door.
pub async fn note_search_core(
    state: &VaultRuntimeState,
    search: &SearchIndexState,
    query: &str,
) -> Vec<SearchResult> {
    use crate::plugins::vault_unlock::state::SlotKind;
    if !matches!(state.slot_kind_active().await, SlotKind::Unlocked) {
        return Vec::new();
    }
    search
        .query(query)
        .into_iter()
        .take(NOTE_SEARCH_RESULT_CAP)
        .map(|hit| {
            // An attachment doc's id carries its provenance
            // (`att:<attachment>:<note>`); decode it so the WebView opens the
            // embedding note and can badge an attachment-content match.
            let (note_id, attachment_id) = match crate::search::doc_id::parse_search_doc_id(&hit.id)
            {
                crate::search::doc_id::SearchDocId::Attachment {
                    attachment_id,
                    note_id,
                } => (note_id.to_string(), Some(attachment_id.to_string())),
                crate::search::doc_id::SearchDocId::Note { note_id } => (note_id.to_string(), None),
            };
            SearchResult {
                note_id,
                title: hit.title,
                score: hit.score,
                matched_in: hit.matched_in,
                attachment_id,
            }
        })
        .collect()
}
