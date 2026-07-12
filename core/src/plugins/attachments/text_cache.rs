//! Durable per-attachment extracted-text cache (`MYE1`, MYND-328;
//! `protocol.md` § 9.15). One encrypted file per attachment at
//! `<vault-root>/attachments-text/<attachment-id-hex>`, mirroring the
//! `attachments/<attachment-id-hex>` layout of the `MYA1` source blob.
//!
//! This module is the storage seam between [`super::extract`] (which produces
//! an [`ExtractedText`]) and the `protocol::attachment_text_blob` codec (which
//! seals it). It keeps the search-index rebuild-on-unlock from re-extracting:
//! once an attachment's text is cached, [`read_extracted`] returns it without
//! touching the source.
//!
//! **`extractor_version` invalidation is automatic.** The codec rejects a blob
//! whose `extractor_version` is not the one this client understands
//! (`AttachmentTextBlobError::ExtractorVersionUnsupported`), so a stale cache
//! entry (older extractor, or a future OCR generation) surfaces here as a cache
//! **miss** → the caller re-extracts. Every other decode failure (absent,
//! truncated, AEAD-fail, corrupt) collapses to the same miss
//! (fall-back-to-re-extract, § 9.15.4).
//!
//! The caller derives the KEK once per session via
//! `protocol::derive_subkey(root_key, SubkeyRole::AttachmentTextKey)` and passes
//! it in, mirroring how `commands.rs` derives the catalog KEK at its call site.

use super::extract_types::{ExtractStatus, ExtractedText};
use protocol::{
    decode_attachment_blob, decode_attachment_text_blob, encode_attachment_text_blob,
    AttachmentsCatalog, AEAD_KEY_LEN, ATTACHMENT_ID_LEN, ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Length of the vault `items_key_id` (the MYA1 wrap-key selector).
const ITEMS_KEY_ID_LEN: usize = 16;

/// The Ok-status searchable text of a cache entry (moved out, not cloned —
/// the extracted text can be up to 1 MiB), or `None` for any negative/empty
/// result.
fn ok_text(extracted: ExtractedText) -> Option<String> {
    if extracted.status == ExtractStatus::Ok && !extracted.text.is_empty() {
        Some(extracted.text)
    } else {
        None
    }
}

/// Subdirectory under the vault root holding the per-attachment `MYE1` blobs.
pub const ATTACHMENT_TEXT_DIR: &str = "attachments-text";

use super::commands::hex_encode;

/// On-disk path of an attachment's extracted-text cache blob.
pub fn cache_path(vault_dir: &Path, attachment_id: &[u8; ATTACHMENT_ID_LEN]) -> PathBuf {
    vault_dir
        .join(ATTACHMENT_TEXT_DIR)
        .join(hex_encode(attachment_id))
}

/// Seal `extracted` into the attachment's `MYE1` cache blob and write it
/// atomically (overwriting any prior entry — the cache is idempotent and a
/// re-extraction at a new `extractor_version` replaces the stale blob).
pub fn write_extracted(
    vault_dir: &Path,
    attachment_text_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
    extracted: &ExtractedText,
) -> std::io::Result<()> {
    let plaintext = extracted.to_blob_plaintext();
    let blob = encode_attachment_text_blob(
        attachment_text_key,
        account_number_hash,
        attachment_id,
        &plaintext,
    )
    .map_err(|e| std::io::Error::other(format!("MYE1 encode failed: {e}")))?;

    let dir = vault_dir.join(ATTACHMENT_TEXT_DIR);
    std::fs::create_dir_all(&dir)?;
    // `replace = true`: a cache blob may be overwritten (re-extraction), unlike
    // the write-once MYA1 source blob.
    crate::atomic_write::atomic_write(&cache_path(vault_dir, attachment_id), &blob, true)
}

/// Load an attachment's cached [`ExtractedText`], or `None` on a cache miss —
/// absent file, decode/AEAD failure, a stale/unsupported `extractor_version`,
/// or a malformed payload. A `None` tells the caller to re-extract.
pub fn read_extracted(
    vault_dir: &Path,
    attachment_text_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
) -> Option<ExtractedText> {
    let blob = std::fs::read(cache_path(vault_dir, attachment_id)).ok()?;
    let plaintext = decode_attachment_text_blob(
        attachment_text_key,
        account_number_hash,
        attachment_id,
        &blob,
    )
    .ok()?;
    ExtractedText::from_blob_plaintext(&plaintext)
}

/// Append the cached extracted text of every form-C attachment embedded in
/// `note_body` to a copy of the body, so the search index folds attachment
/// content into the embedding note (§ 9.6 `index_format` 0x02 behavior).
/// Missing/uncached attachments contribute nothing — the lazy backfill (Task 7)
/// populates them on the next rebuild. Best-effort: any read failure is skipped.
///
/// `memo` deduplicates cache reads across notes within a single rebuild — an
/// attachment embedded in N notes is read + decoded once (the in-RAM memo of
/// § 9.6.4). Pass a fresh map for a one-off fold (the live note-save path).
pub fn fold_attachment_text(
    note_body: &str,
    vault_dir: &Path,
    attachment_text_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN],
    memo: &mut std::collections::HashMap<[u8; ATTACHMENT_ID_LEN], Option<String>>,
) -> String {
    let ids = super::reconcile::extract_att_ids(note_body);
    if ids.is_empty() {
        return note_body.to_string();
    }
    let mut out = note_body.to_string();
    for id_hex in ids {
        let Some(id) = super::commands::hex_decode_id(&id_hex) else {
            continue;
        };
        let cached = memo.entry(id).or_insert_with(|| {
            // Only Ok results carry searchable text; Empty/Failed/Unsupported
            // contribute nothing but are still "resolved" in the memo.
            read_extracted(vault_dir, attachment_text_key, account_number_hash, &id)
                .and_then(ok_text)
        });
        if let Some(text) = cached {
            out.push('\n');
            out.push_str(text);
        }
    }
    out
}

/// MYND-448a: the cached extracted text of each form-C attachment embedded in
/// `note_body`, as `(attachment_id_hex, text)` pairs — the per-attachment form
/// of [`fold_attachment_text`]. The search layer indexes each as its OWN doc
/// (`att:<id>:<note_id>`) so an attachment-content hit surfaces distinctly from
/// the embedding note's body, instead of being folded into it. Only attachments
/// with Ok extracted text yield a pair (Empty/Failed/Unsupported/uncached
/// contribute no doc); each unique attachment appears at most once even when
/// embedded twice. Best-effort; `memo` dedups cache reads across notes within a
/// rebuild, exactly as the fold does.
pub fn collect_attachment_texts(
    note_body: &str,
    vault_dir: &Path,
    attachment_text_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN],
    memo: &mut std::collections::HashMap<[u8; ATTACHMENT_ID_LEN], Option<String>>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut emitted: std::collections::HashSet<[u8; ATTACHMENT_ID_LEN]> =
        std::collections::HashSet::new();
    for id_hex in super::reconcile::extract_att_ids(note_body) {
        let Some(id) = super::commands::hex_decode_id(&id_hex) else {
            continue;
        };
        if !emitted.insert(id) {
            continue; // same attachment embedded twice → one doc
        }
        let cached = memo.entry(id).or_insert_with(|| {
            read_extracted(vault_dir, attachment_text_key, account_number_hash, &id).and_then(ok_text)
        });
        if let Some(text) = cached {
            out.push((id_hex, text.clone()));
        }
    }
    out
}

/// Lazy backfill (Task 7): for each embedded attachment of `note_body` not yet
/// resolved in `memo`, ensure its `MYE1` cache exists — extracting from the
/// `MYA1` source blob if missing — and record the result in `memo` so the
/// subsequent [`fold_attachment_text`] uses it. This is what makes attachments
/// imported BEFORE the eager cache (Task 5) searchable after the first
/// post-MYND-328 rebuild (which the snapshot `extractor_version` forces).
/// Best-effort: an unreadable / undecryptable / unsupported attachment resolves
/// to no text and is not retried this pass.
///
/// `extract` is the injected text-extraction *producer* — the desktop client
/// passes its `lopdf`/`zip`/`quick-xml` extractor; this pure cache module never
/// depends on those crates so it compiles on mobile (which simply never calls
/// this — mobile has no extraction step).
#[allow(clippy::too_many_arguments)]
pub fn backfill_note_attachment_text<F>(
    note_body: &str,
    vault_dir: &Path,
    attachment_text_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN],
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
    catalog: &AttachmentsCatalog,
    memo: &mut HashMap<[u8; ATTACHMENT_ID_LEN], Option<String>>,
    extract: F,
) where
    F: Fn(&str, &str, &[u8]) -> ExtractedText,
{
    for id_hex in super::reconcile::extract_att_ids(note_body) {
        let Some(id) = super::commands::hex_decode_id(&id_hex) else {
            continue;
        };
        if memo.contains_key(&id) {
            continue; // resolved by a prior note this rebuild (or eager cache)
        }
        // Already cached (eager import, Task 5)?
        if let Some(e) = read_extracted(vault_dir, attachment_text_key, account_number_hash, &id) {
            memo.insert(id, ok_text(e));
            continue;
        }
        // Backfill from the MYA1 source. The catalog carries the content_type
        // (AAD-bound into MYA1, required to decrypt) + the filename (extension
        // dispatch for octet-stream-stored docx/text).
        let Some(meta) = catalog.entries.get(&id_hex) else {
            memo.insert(id, None);
            continue;
        };
        let blob = match std::fs::read(vault_dir.join("attachments").join(&id_hex)) {
            Ok(b) => b,
            Err(_) => {
                memo.insert(id, None);
                continue;
            }
        };
        let plaintext = match decode_attachment_blob(
            &blob,
            &id,
            meta.content_type.as_bytes(),
            items_key,
            items_key_id,
        ) {
            Ok(p) => p,
            Err(_) => {
                memo.insert(id, None);
                continue;
            }
        };
        let extracted = extract(&meta.content_type, &meta.filename, &plaintext);
        if extracted.status != ExtractStatus::Unsupported {
            let _ = write_extracted(
                vault_dir,
                attachment_text_key,
                account_number_hash,
                &id,
                &extracted,
            );
        }
        memo.insert(id, ok_text(extracted));
    }
}

/// Delete an attachment's cache blob if present (lifecycle cleanup, Task 8).
/// Absent file is success (idempotent).
pub fn remove_extracted(
    vault_dir: &Path,
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
) -> std::io::Result<()> {
    match std::fs::remove_file(cache_path(vault_dir, attachment_id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::extract_types::{ExtractStatus, SourceFormat};
    use super::*;
    use crate::test_support::ScopedTempDir;

    /// A minimal text-only extractor for the backfill test — stands in for the
    /// desktop `lopdf`/`zip`/`quick-xml` producer, which lives in the desktop
    /// crate. Text-like content is UTF-8-decoded; everything else is Unsupported.
    fn test_extract(content_type: &str, filename: &str, bytes: &[u8]) -> ExtractedText {
        let is_text = content_type.starts_with("text/")
            || filename.ends_with(".txt")
            || filename.ends_with(".md");
        if !is_text {
            return ExtractedText::negative(ExtractStatus::Unsupported, SourceFormat::Other);
        }
        let text = String::from_utf8_lossy(bytes).into_owned();
        if text.trim().is_empty() {
            return ExtractedText::negative(ExtractStatus::Empty, SourceFormat::Text);
        }
        let char_count = text.chars().count() as u32;
        ExtractedText {
            status: ExtractStatus::Ok,
            source_format: SourceFormat::Text,
            text,
            char_count,
            truncated: false,
        }
    }

    const KEY: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN] =
        [0x7c; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN];
    const ATT_ID: [u8; ATTACHMENT_ID_LEN] = [0x5a; ATTACHMENT_ID_LEN];

    fn sample() -> ExtractedText {
        ExtractedText {
            status: ExtractStatus::Ok,
            source_format: SourceFormat::Pdf,
            text: "cached extracted text".to_string(),
            char_count: 21,
            truncated: false,
        }
    }

    #[test]
    fn write_then_read_round_trips() {
        let tmp = ScopedTempDir::new("mye1-cache").expect("tmp");
        let e = sample();
        write_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID, &e).expect("write");
        let got = read_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID).expect("read");
        assert_eq!(got, e);
    }

    #[test]
    fn collect_attachment_texts_returns_per_attachment_ok_text() {
        // MYND-448a: an embedded attachment with cached Ok text yields one
        // (attachment_id_hex, text) pair; an uncached embed yields nothing.
        let tmp = ScopedTempDir::new("mye1-collect").expect("tmp");
        write_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID, &sample()).expect("write");
        let id_hex = "5a".repeat(ATTACHMENT_ID_LEN);
        let uncached_hex = "77".repeat(ATTACHMENT_ID_LEN);
        // Embed the cached one twice (must collapse to one doc) + one uncached.
        let body = format!("intro ![[att:{id_hex}]] mid ![[att:{id_hex}]] ![[att:{uncached_hex}]]");
        let mut memo = std::collections::HashMap::new();
        let got = collect_attachment_texts(&body, tmp.path(), &KEY, &ACCOUNT_HASH, &mut memo);
        assert_eq!(
            got,
            vec![(id_hex, "cached extracted text".to_string())],
            "cached attachment yields one pair; duplicate embed collapses; uncached omitted"
        );
    }

    #[test]
    fn negative_results_round_trip() {
        // An Empty/Failed/Unsupported result is cached so rebuilds don't retry.
        let tmp = ScopedTempDir::new("mye1-cache-neg").expect("tmp");
        let e = ExtractedText {
            status: ExtractStatus::Empty,
            source_format: SourceFormat::Pdf,
            text: String::new(),
            char_count: 0,
            truncated: false,
        };
        write_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID, &e).expect("write");
        assert_eq!(
            read_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID).expect("read"),
            e
        );
    }

    #[test]
    fn missing_file_is_cache_miss() {
        let tmp = ScopedTempDir::new("mye1-cache-miss").expect("tmp");
        assert!(read_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID).is_none());
    }

    #[test]
    fn stale_extractor_version_is_cache_miss() {
        // A blob written at a different extractor_version (offset 5) must read
        // back as a miss → caller re-extracts. Simulate by flipping the byte.
        let tmp = ScopedTempDir::new("mye1-cache-stale").expect("tmp");
        write_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID, &sample()).expect("write");
        let path = cache_path(tmp.path(), &ATT_ID);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[5] = 0x02; // a future extractor generation this client rejects
        std::fs::write(&path, &bytes).unwrap();
        assert!(read_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID).is_none());
    }

    #[test]
    fn corrupt_blob_is_cache_miss() {
        let tmp = ScopedTempDir::new("mye1-cache-corrupt").expect("tmp");
        std::fs::create_dir_all(tmp.path().join(ATTACHMENT_TEXT_DIR)).unwrap();
        std::fs::write(cache_path(tmp.path(), &ATT_ID), b"not a MYE1 blob").unwrap();
        assert!(read_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID).is_none());
    }

    #[test]
    fn wrong_attachment_id_is_cache_miss() {
        // AAD binds attachment_id — reading blob A under id B fails to decode.
        let tmp = ScopedTempDir::new("mye1-cache-idbind").expect("tmp");
        write_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID, &sample()).expect("write");
        // Move the blob to id B's path and try to read it as B.
        let other = [0x11; ATTACHMENT_ID_LEN];
        std::fs::rename(
            cache_path(tmp.path(), &ATT_ID),
            cache_path(tmp.path(), &other),
        )
        .unwrap();
        assert!(read_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &other).is_none());
    }

    #[test]
    fn remove_is_idempotent() {
        let tmp = ScopedTempDir::new("mye1-cache-rm").expect("tmp");
        write_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID, &sample()).expect("write");
        remove_extracted(tmp.path(), &ATT_ID).expect("remove existing");
        assert!(read_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID).is_none());
        remove_extracted(tmp.path(), &ATT_ID).expect("remove absent is ok");
    }

    #[test]
    fn cache_path_is_attachments_text_subdir() {
        let p = cache_path(Path::new("/vault"), &ATT_ID);
        assert!(p.ends_with(format!("{ATTACHMENT_TEXT_DIR}/{}", hex_encode(&ATT_ID))));
    }

    // ---- fold (search-index integration, Task 6) -----------------------

    #[test]
    fn fold_appends_cached_attachment_text() {
        let tmp = ScopedTempDir::new("mye1-fold").expect("tmp");
        let mut e = sample();
        e.text = "NEEDLEWORD from the pdf body".to_string();
        write_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID, &e).expect("write");
        let body = format!("note prose ![[att:{}|f.pdf]] tail", hex_encode(&ATT_ID));
        let mut memo = std::collections::HashMap::new();
        let folded = fold_attachment_text(&body, tmp.path(), &KEY, &ACCOUNT_HASH, &mut memo);
        assert!(folded.contains("note prose"), "keeps the note body");
        assert!(
            folded.contains("NEEDLEWORD from the pdf body"),
            "folds in the cached attachment text"
        );
    }

    #[test]
    fn fold_no_refs_returns_body_unchanged() {
        let tmp = ScopedTempDir::new("mye1-fold-none").expect("tmp");
        let mut memo = std::collections::HashMap::new();
        let body = "plain note, no embeds";
        assert_eq!(
            fold_attachment_text(body, tmp.path(), &KEY, &ACCOUNT_HASH, &mut memo),
            body
        );
    }

    #[test]
    fn fold_uncached_ref_contributes_nothing() {
        // A ref to an attachment with no cache entry leaves the body unchanged
        // (lazy backfill, Task 7, will populate it later) — and never panics.
        let tmp = ScopedTempDir::new("mye1-fold-miss").expect("tmp");
        let body = format!("text ![[att:{}|x]] end", hex_encode(&ATT_ID));
        let mut memo = std::collections::HashMap::new();
        assert_eq!(
            fold_attachment_text(&body, tmp.path(), &KEY, &ACCOUNT_HASH, &mut memo),
            body
        );
    }

    #[test]
    fn backfill_extracts_from_mya1_when_uncached() {
        // A pre-eager-cache attachment: only the MYA1 source exists. Backfill
        // must decrypt it, extract, write the MYE1 cache, and resolve the memo.
        let tmp = ScopedTempDir::new("mye1-backfill").expect("tmp");
        let items_key = [0x11u8; AEAD_KEY_LEN];
        let items_key_id = [0x22u8; 16];
        let root_key = [0x42u8; 32];
        let plaintext = b"backfilled needle text from a txt file";
        let att_id = protocol::compute_attachment_id(&root_key, plaintext);
        let id_hex = hex_encode(&att_id);

        let blob = protocol::encode_attachment_blob(
            &items_key,
            &items_key_id,
            &att_id,
            b"text/plain",
            plaintext,
        )
        .expect("encode MYA1");
        let att_dir = tmp.path().join("attachments");
        std::fs::create_dir_all(&att_dir).unwrap();
        std::fs::write(att_dir.join(&id_hex), &blob).unwrap();

        let mut catalog = protocol::AttachmentsCatalog::empty();
        catalog.entries.insert(
            id_hex.clone(),
            protocol::AttachmentMeta {
                content_type: "text/plain".to_string(),
                created_at: 0,
                filename: "n.txt".to_string(),
                size: plaintext.len() as u64,
            },
        );

        let body = format!("note ![[att:{id_hex}|n.txt]]");
        let mut memo = std::collections::HashMap::new();
        backfill_note_attachment_text(
            &body,
            tmp.path(),
            &KEY,
            &ACCOUNT_HASH,
            &items_key,
            &items_key_id,
            &catalog,
            &mut memo,
            test_extract,
        );

        // The cache now exists on disk...
        let cached = read_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &att_id).expect("backfilled");
        assert_eq!(cached.status, ExtractStatus::Ok);
        assert!(cached.text.contains("backfilled needle text"));
        // ...and the memo carries the text for the fold that follows.
        assert!(memo[&att_id].as_deref().unwrap().contains("needle"));
    }

    #[test]
    fn backfill_uncatalogued_ref_resolves_to_none() {
        let tmp = ScopedTempDir::new("mye1-backfill-miss").expect("tmp");
        let catalog = protocol::AttachmentsCatalog::empty();
        let body = format!("note ![[att:{}|x]]", hex_encode(&ATT_ID));
        let mut memo = std::collections::HashMap::new();
        backfill_note_attachment_text(
            &body,
            tmp.path(),
            &KEY,
            &ACCOUNT_HASH,
            &[0u8; AEAD_KEY_LEN],
            &[0u8; 16],
            &catalog,
            &mut memo,
            test_extract,
        );
        assert_eq!(memo.get(&ATT_ID), Some(&None)); // resolved, no text
    }

    #[test]
    fn fold_skips_negative_status_text() {
        // An Empty/Failed/Unsupported cached result contributes no tokens.
        let tmp = ScopedTempDir::new("mye1-fold-neg").expect("tmp");
        let e = ExtractedText {
            status: ExtractStatus::Empty,
            source_format: SourceFormat::Pdf,
            text: String::new(),
            char_count: 0,
            truncated: false,
        };
        write_extracted(tmp.path(), &KEY, &ACCOUNT_HASH, &ATT_ID, &e).expect("write");
        let body = format!("body ![[att:{}|f]]", hex_encode(&ATT_ID));
        let mut memo = std::collections::HashMap::new();
        assert_eq!(
            fold_attachment_text(&body, tmp.path(), &KEY, &ACCOUNT_HASH, &mut memo),
            body
        );
    }
}
