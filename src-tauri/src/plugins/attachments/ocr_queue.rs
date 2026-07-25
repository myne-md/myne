//! Background OCR backlog worker (MYND-441).
//!
//! ## Why this exists
//!
//! Extraction of pre-existing attachments has always ridden the on-unlock search
//! index rebuild (`notes::search_sync`, via
//! `text_cache::backfill_note_attachment_text`). That was fine while every
//! extractor was deterministic and finished in milliseconds. OCR is seconds per
//! page, so leaving it there would stall the rebuild — and with it the first
//! search after unlock — for as long as it takes to read every scanned document
//! in the vault.
//!
//! So the rebuild now injects
//! [`crate::plugins::attachments::extract::extract_deferring_ocr`], which reports
//! OCR candidates as `Unsupported`. That status is deliberately **not cached**
//! by the backfill (a pre-existing rule this feature reuses rather than
//! invents), so those attachments simply have no cache entry — and "no cache
//! entry" is exactly this worker's work list. Nothing is persisted to track the
//! queue: the absence of a cache blob already *is* the "not yet processed"
//! marker, so there is no new blob family, no migration, and quitting mid-run
//! loses nothing but the in-memory ordering.
//!
//! ## Lifecycle
//!
//! Runs only while the app is open **and the vault is unlocked** — not a chosen
//! restriction but a consequence of the security model: OCR needs the attachment
//! plaintext, which needs `root_key`, which is zeroized on lock. An OS-level
//! background job (iOS `BGProcessingTask`, Android `WorkManager`) would wake
//! holding ciphertext and no key. The platforms permit background execution; the
//! zero-knowledge design makes it useless.
//!
//! Each item re-checks the unlocked slot before doing any work, so a lock takes
//! effect within one attachment rather than at the end of the backlog. Work is
//! strictly sequential — one attachment at a time — because the point is to stay
//! out of the user's way, not to finish fastest.

use std::path::Path;

use myne_core::plugins::attachments::text_cache;
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{derive_subkey, SubkeyRole};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::commands::hex_decode_id;

/// WebView event carrying the backlog's progress (MYND-441).
///
/// Emitted at start, after every completed attachment, and once at the end with
/// `remaining = 0`. Counts only — DENY-list safe, nothing about *which* files.
/// Its purpose is to explain a busy fan: a user opening a large vault on the OCR
/// build sees sustained CPU with no visible cause, which reads as "the app
/// broke". It doubles as the deterministic wait handle for the E2E scenario.
pub const OCR_BACKLOG_PROGRESS_EVENT: &str = "ocr-backlog-progress";

#[derive(Clone, Serialize)]
pub struct OcrBacklogProgress {
    /// Attachments still waiting, this one included.
    pub remaining: usize,
    /// Attachments extracted so far in this drain.
    pub done: usize,
}

/// Whether an attachment could yield text under the OCR generation but has not
/// been extracted yet. Images and PDFs only: everything else is either already
/// handled deterministically at rebuild time or genuinely unsupported, and in
/// both cases it carries a cache entry.
fn is_ocr_candidate(content_type: &str, filename: &str) -> bool {
    if myne_core::plugins::attachments::ocr::is_ocr_image(content_type, filename) {
        return true;
    }
    // A PDF reaches the worker only when its text layer produced nothing — the
    // scanned case. `extract_deferring_ocr` is what decides that; here we only
    // need to know a PDF is worth re-examining.
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    ct == "application/pdf"
        || filename
            .rsplit('.')
            .next()
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// Drain the OCR backlog for the active vault, one attachment at a time.
///
/// Best-effort throughout: any failure to resolve a key, read a blob or decrypt
/// is skipped rather than propagated — a single unreadable attachment must never
/// stop the backlog, and everything here is re-derivable on the next unlock.
pub async fn drain_backlog<R: Runtime>(app: &AppHandle<R>, state: &VaultRuntimeState) {
    let active_id = state.active_vault_id().await;
    let Ok(vault_dir) = crate::paths::active_vault_root_io(app, active_id) else {
        return;
    };

    // MYND-441: the user's opt-out. Checked here rather than at spawn time so a
    // toggle takes effect on the next unlock without any extra plumbing, and
    // re-read per drain rather than cached. Turning it off stops the worker but
    // never deletes cached results, so toggling costs the user nothing.
    if !ocr_enabled(&vault_dir, state).await {
        return;
    }

    // Resolve the work list once, then re-check the slot per item. Holding key
    // material across the whole backlog would keep it alive past a lock.
    let candidates = match collect_candidates(&vault_dir, state).await {
        Some(c) if !c.is_empty() => c,
        _ => return,
    };
    tracing::info!(
        event = "ocr_backlog_start",
        pending = candidates.len(),
        "extracting text from image and scanned-PDF attachments"
    );
    let total = candidates.len();
    let mut done = 0usize;
    emit_progress(app, total, done);
    for (id_hex, content_type, filename) in candidates {
        // Re-check the lock before every attachment: a lock must take effect
        // within one item, not at the end of the backlog.
        let Some((items_key, items_key_id, root_key)) =
            state.peek_unlocked_attachment_material().await
        else {
            tracing::info!(event = "ocr_backlog_stopped", reason = "locked", done);
            // Clear the indicator: a lock must not leave "N processing" on
            // screen forever.
            emit_progress(app, 0, done);
            return;
        };
        let Ok(account_number_hash) = read_account_hash(&vault_dir) else {
            return;
        };
        let attachment_text_key = derive_subkey(&root_key, SubkeyRole::AttachmentTextKey);

        let Some(id) = hex_decode_id(&id_hex) else {
            continue;
        };
        // Someone may have extracted it since the work list was built (an eager
        // import of the same bytes, say) — skip rather than redo.
        if text_cache::read_extracted(&vault_dir, &attachment_text_key, &account_number_hash, &id)
            .is_some()
        {
            continue;
        }

        let dir = vault_dir.clone();
        let ct = content_type.clone();
        let name = filename.clone();
        let hex = id_hex.clone();
        // OCR is CPU-bound for seconds; never on the async runtime's threads.
        let extracted = tokio::task::spawn_blocking(move || {
            extract_one(&dir, &hex, &ct, &name, &items_key, &items_key_id)
        })
        .await
        .ok()
        .flatten();

        let Some(extracted) = extracted else {
            continue;
        };
        let _ = text_cache::write_extracted(
            &vault_dir,
            &attachment_text_key,
            &account_number_hash,
            &id,
            &extracted,
        );
        // Surface it immediately: the note's `att:` docs are re-derived through
        // the same path a live save uses, so a search run right now finds it.
        crate::plugins::notes::search_sync::refresh_attachment_docs_for(app, state, &id_hex).await;
        done += 1;
        emit_progress(app, total.saturating_sub(done), done);

        // Yield between attachments so a burst of small images cannot starve
        // interactive work on the runtime.
        tokio::task::yield_now().await;
    }
    tracing::info!(event = "ocr_backlog_done", done);
    emit_progress(app, 0, done);
}

/// Best-effort progress emit — a failed emit just means no UI update, never a
/// failed extraction.
fn emit_progress<R: Runtime>(app: &AppHandle<R>, remaining: usize, done: usize) {
    let _ = app.emit(
        OCR_BACKLOG_PROGRESS_EVENT,
        OcrBacklogProgress { remaining, done },
    );
}

/// Whether the user has left image OCR on for this vault. Absent / unreadable
/// prefs read as ON — the default — because a prefs read failure must not
/// silently disable a search feature.
async fn ocr_enabled(vault_dir: &Path, state: &VaultRuntimeState) -> bool {
    let Some((_, _, root_key)) = state.peek_unlocked_attachment_material().await else {
        return false;
    };
    let Ok(account_number_hash) = read_account_hash(vault_dir) else {
        return true;
    };
    let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
    match std::fs::read(vault_dir.join("vault.prefs"))
        .ok()
        .and_then(|b| protocol::decode_prefs_blob(&prefs_key, &account_number_hash, &b).ok())
    {
        Some(p) => p.attachment_ocr_enabled,
        None => true,
    }
}

/// Attachments in the catalog that are OCR candidates and have no cache entry.
async fn collect_candidates(
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Option<Vec<(String, String, String)>> {
    let (_, _, root_key) = state.peek_unlocked_attachment_material().await?;
    let account_number_hash = read_account_hash(vault_dir).ok()?;
    let attachment_text_key = derive_subkey(&root_key, SubkeyRole::AttachmentTextKey);
    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog = super::commands::read_catalog(
        &vault_dir.join("vault.attachments"),
        &catalog_key,
        &account_number_hash,
    )
    .ok()?;

    let mut out = Vec::new();
    for (id_hex, meta) in &catalog.entries {
        if !is_ocr_candidate(&meta.content_type, &meta.filename) {
            continue;
        }
        let Some(id) = hex_decode_id(id_hex) else {
            continue;
        };
        if text_cache::read_extracted(vault_dir, &attachment_text_key, &account_number_hash, &id)
            .is_some()
        {
            continue; // already extracted at this generation
        }
        out.push((
            id_hex.clone(),
            meta.content_type.clone(),
            meta.filename.clone(),
        ));
    }
    Some(out)
}

/// Decrypt one `MYA1` blob and run the FULL extractor (OCR included) over it.
/// Returns `None` when the blob is missing or will not decrypt.
fn extract_one(
    vault_dir: &Path,
    id_hex: &str,
    content_type: &str,
    filename: &str,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
) -> Option<myne_core::plugins::attachments::ExtractedText> {
    let id = hex_decode_id(id_hex)?;
    let blob = std::fs::read(vault_dir.join("attachments").join(id_hex)).ok()?;
    let plaintext = protocol::decode_attachment_blob(
        &blob,
        &id,
        content_type.as_bytes(),
        items_key,
        items_key_id,
    )
    .ok()?;
    Some(super::extract::extract(content_type, filename, &plaintext))
}

fn read_account_hash(vault_dir: &Path) -> Result<[u8; 16], ()> {
    let bytes = std::fs::read(vault_dir.join("vault.meta")).map_err(|_| ())?;
    let meta = protocol::parse_vault_meta(&bytes).map_err(|_| ())?;
    Ok(meta.account_number_hash)
}

/// Kick the backlog off the unlock hot path.
///
/// Deliberately detached: the caller (the search-index hydrate hook) must not
/// wait for OCR — that is the entire point of moving it out of the rebuild.
pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<VaultRuntimeState>() else {
            return;
        };
        drain_backlog(&app, state.inner()).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_and_pdfs_are_candidates() {
        assert!(is_ocr_candidate("image/png", "scan.png"));
        assert!(is_ocr_candidate("image/jpeg", "photo.jpg"));
        assert!(is_ocr_candidate("application/pdf", "contract.pdf"));
        // Extension fallback, for octet-stream-stored attachments.
        assert!(is_ocr_candidate("application/octet-stream", "scan.PDF"));
        assert!(is_ocr_candidate("application/octet-stream", "shot.webp"));
    }

    #[test]
    fn deterministic_formats_are_not_candidates() {
        // These are fully extracted during the rebuild and carry a cache entry,
        // so re-queueing them would be pure waste.
        for (ct, name) in [
            ("text/plain", "notes.txt"),
            (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "report.docx",
            ),
            ("application/zip", "bundle.zip"),
            // Deliberately excluded from OCR everywhere: animation and vector.
            ("image/gif", "loop.gif"),
            ("image/svg+xml", "logo.svg"),
        ] {
            assert!(
                !is_ocr_candidate(ct, name),
                "{ct} / {name} must not enter the OCR backlog"
            );
        }
    }
}
