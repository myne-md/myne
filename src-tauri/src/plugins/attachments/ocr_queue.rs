// SPDX-License-Identifier: AGPL-3.0
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
//! Each item re-checks the unlocked slot before starting, so a lock stops the
//! backlog within one attachment rather than at the end. To be precise about
//! what that does NOT cover: a lock landing *mid-extraction* does not abort the
//! in-flight item, which then still writes its `MYE1` blob under a KEK derived
//! before the lock. Nothing escapes — the blob is AEAD-sealed and the index
//! refresh that follows needs the unlocked slot, so it no-ops — but the window
//! is one attachment wide, not instantaneous.
//!
//! Work is strictly sequential — one attachment at a time — because the point is
//! to stay out of the user's way, not to finish fastest.

use std::path::Path;

use myne_core::plugins::attachments::scheme_core::{decode_attachment_plaintext, ServeKeys};
use myne_core::plugins::attachments::text_cache;
use myne_core::plugins::attachments::{ExtractStatus, ExtractedText, SourceFormat};
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::SubkeyRole;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::blocking_reads::{read_account_number_hash, read_catalog};
use super::commands::hex_decode_id;
use super::extract::detect_format;

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

/// One attachment the backlog still owes work for. A named struct rather than a
/// 3-tuple of `String`s, so the fields cannot be transposed at either end.
struct Candidate {
    id_hex: String,
    content_type: String,
    filename: String,
}

/// Whether an attachment could yield text under the OCR generation but has not
/// been extracted yet.
///
/// Delegates to the extractor's own [`detect_format`] rather than re-deriving
/// the content-type / extension dispatch: the backlog's "is a candidate" answer
/// and the rebuild's "is deferred" answer must not be able to drift. A PDF
/// reaches the worker only when its text layer produced nothing (the scanned
/// case) — `extract_deferring_ocr` decides that; here we only need to know a PDF
/// is worth re-examining.
fn is_ocr_candidate(content_type: &str, filename: &str) -> bool {
    matches!(
        detect_format(content_type, filename),
        Some(SourceFormat::Image) | Some(SourceFormat::Pdf)
    )
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

    // MYND-441: the user's opt-out. Read per drain rather than cached, so a
    // toggle takes effect on the next unlock with no extra plumbing. Reuses the
    // shared prefs read (which carries its own decrypt-failure tracing) rather
    // than open-coding the peek → derive → decode chain. An unreadable blob
    // reads as ON: a prefs read failure must not silently disable a search
    // feature.
    let enabled = myne_core::plugins::prefs::commands::prefs_read_with_dir(
        &vault_dir,
        state,
        &myne_core::vault_io::StdVaultIo,
    )
    .await
    .map(|p| p.attachment_ocr_enabled)
    .unwrap_or(true);
    if !enabled {
        return;
    }

    // The account hash is a FILE CONSTANT — read once, not per attachment. Only
    // the key material is re-peeked inside the loop, which is the part that must
    // not outlive a lock.
    let Ok(Some(account_number_hash)) = read_account_number_hash(&vault_dir.join("vault.meta"))
    else {
        return;
    };
    // The `attachments-text` cache is a shared singleton role, so its KEK comes
    // from the session's shared tier (root-tier before a B2B migration,
    // group-tier after). A stale root-tier cache is unreadable under the group
    // tier, which is fine: §10.4.1 md.2 makes it rebuildable, and the miss
    // simply re-extracts.
    let meta_version = std::fs::read(vault_dir.join("vault.meta"))
        .ok()
        .and_then(|b| protocol::meta_version_of(&b))
        .unwrap_or(protocol::MetaVersion::V0_1);

    let candidates = collect_candidates(&vault_dir, state, &account_number_hash).await;
    if candidates.is_empty() {
        return;
    }
    tracing::info!(
        event = "ocr_backlog_start",
        pending = candidates.len(),
        "extracting text from image and scanned-PDF attachments"
    );
    let total = candidates.len();
    let mut done = 0usize;
    emit_progress(app, total, done);
    for c in candidates {
        // Re-check the lock before every attachment: a lock must take effect
        // within one item, not at the end of the backlog.
        let Some((items_key, items_key_id, shared)) =
            state.peek_unlocked_attachment_material().await
        else {
            tracing::info!(event = "ocr_backlog_stopped", reason = "locked", done);
            // Clear the indicator: a lock must not leave "N processing" on
            // screen forever.
            emit_progress(app, 0, done);
            return;
        };
        let attachment_text_key = shared.derive(meta_version, SubkeyRole::AttachmentTextKey);

        let Some(id) = hex_decode_id(&c.id_hex) else {
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
        let keys = ServeKeys {
            items_key,
            items_key_id,
            shared,
        };
        let Candidate {
            id_hex,
            content_type,
            filename,
        } = c;
        let hex = id_hex.clone(); // the original is needed after the join, below
                                  // OCR is CPU-bound for seconds; never on the async runtime's threads.
        let extracted = tokio::task::spawn_blocking(move || {
            extract_one(&dir, &keys, &hex, &content_type, &filename)
        })
        .await
        .ok()
        .flatten();

        let Some(extracted) = extracted else {
            continue;
        };
        // NEVER cache `Unsupported`. It is the "nothing was attempted" status —
        // returned when the weights are unavailable (an unfetched Git-LFS blob,
        // a resource-dir resolution failure), not when the image held no text.
        // Persisting it would permanently skip that attachment at this
        // `extractor_version`, recoverable only by another bump. Same rule the
        // backfill and the import path already follow.
        if extracted.status == ExtractStatus::Unsupported {
            continue;
        }
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
    // Make the drain DURABLE (myne#307).
    //
    // `refresh_attachment_docs_for` above patches the LIVE index only, and the
    // note's own `.myn` is never rewritten — the MYE1 cache write does not touch
    // its `content_nonce`. So the extracted text existed only in RAM until the
    // next free-running 120 s flush. An idle auto-lock in that window zeroizes
    // the index and deliberately skips persist, and the next unlock then
    // reasons: hydrate sees the note's nonce unchanged and never re-derives its
    // `att:` docs, while `collect_candidates` sees the MYE1 cache present and
    // never re-OCRs it. The text was on disk and unreachable — findable for one
    // session, then gone across every later one, with nothing to say so.
    //
    // One persist per DRAIN, not per item: the snapshot is the whole blob, and
    // rewriting it once per attachment would be quadratic on a large vault.
    //
    // Residual window, stated rather than papered over: a crash or a lock that
    // interrupts the loop still loses the items already extracted this pass —
    // the lock arm above returns with the keys already gone, so there is no
    // persist it could do. Closing that needs an attachment-side staleness
    // signal in the snapshot (so hydrate can re-derive an unchanged note's
    // `att:` docs), which is a persisted-format change.
    if done > 0 {
        crate::plugins::notes::search_sync::persist_search_index(app, state).await;
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

/// Attachments in the catalog that are OCR candidates and have no cache entry.
async fn collect_candidates(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    account_number_hash: &[u8; 16],
) -> Vec<Candidate> {
    let Some((_, _, shared)) = state.peek_unlocked_attachment_material().await else {
        return Vec::new();
    };
    // Both the `attachments-text` cache and the CATALOG are shared singleton
    // roles, so both derive through the session's shared tier. The catalog is
    // re-sealed by the B2B migration; the text cache is a rebuildable cache the
    // migration drops (§10.4.1 md.2), so a stale root-tier cache simply misses
    // and re-extracts. Getting the catalog key wrong is silent, because
    // `read_catalog` degrades to an empty catalog and this function then queues
    // nothing, forever.
    let version = std::fs::read(vault_dir.join("vault.meta"))
        .ok()
        .and_then(|b| protocol::meta_version_of(&b))
        .unwrap_or(protocol::MetaVersion::V0_1);
    let attachment_text_key = shared.derive(version, SubkeyRole::AttachmentTextKey);
    let catalog_key = shared.derive(version, SubkeyRole::AttachmentsCatalogKey);
    let Ok(catalog) = read_catalog(
        &vault_dir.join("vault.attachments"),
        &catalog_key,
        account_number_hash,
    ) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (id_hex, meta) in &catalog.entries {
        if !is_ocr_candidate(&meta.content_type, &meta.filename) {
            continue;
        }
        let Some(id) = hex_decode_id(id_hex) else {
            continue;
        };
        if text_cache::read_extracted(vault_dir, &attachment_text_key, account_number_hash, &id)
            .is_some()
        {
            continue; // already extracted at this generation
        }
        out.push(Candidate {
            id_hex: id_hex.clone(),
            content_type: meta.content_type.clone(),
            filename: meta.filename.clone(),
        });
    }
    out
}

/// Decrypt one `MYA1` blob and run the FULL extractor (OCR included) over it.
/// Returns `None` when the blob is missing or will not decrypt.
///
/// Decryption goes through the shared `attachment://` serve core, so the
/// plaintext arrives `Zeroizing`-wrapped and is wiped on drop — the same
/// handling every other read of attachment plaintext gets. Open-coding the
/// read+decode here would have dropped that guarantee.
fn extract_one(
    vault_dir: &Path,
    keys: &ServeKeys,
    id_hex: &str,
    content_type: &str,
    filename: &str,
) -> Option<ExtractedText> {
    let plaintext = decode_attachment_plaintext(vault_dir, keys, id_hex).ok()?;
    Some(super::extract::extract(content_type, filename, &plaintext))
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
