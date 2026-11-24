// SPDX-License-Identifier: AGPL-3.0-only
//! Mobile read-back of one attachment's cached `MYE1` extracted text, with a
//! lazy re-extraction on a cache miss (myne-md/myne#926).
//!
//! **Why mobile needs a command of its own at all.** The desktop command of the
//! same name lives beside the desktop text extractor, whose imports (`crate::paths`,
//! the `lopdf` / `zip` / `quick-xml` extractors) are desktop dependencies mobile
//! does not compile. Everything shared is called from `myne_core` instead of
//! copied: the `vault.meta` binding read (`commands::read_account_number_hash`,
//! which owns the newest-that-parses rule and the generation-travels-with-the-hash
//! contract), the id decode, the wrapped-cache read (`text_cache::read_extracted`),
//! the blob decrypt (`scheme_core::decode_attachment_plaintext`) and the image
//! extractor (`ocr::extract_image_only`).
//!
//! **And why it re-extracts, which the desktop twin does not need.** `MYE1` is a
//! cache, and `protocol.md` § 9.15.4 gives it one read semantic: a miss is
//! re-derivable from the `MYA1` source. Desktop has a backfill pass
//! (`plugins/notes/search_sync.rs` -> `backfill_note_attachment_text`) that mobile
//! does not compile, and the import dedups by content id BEFORE the extractor
//! runs, so on a phone every one of these is a permanent cache miss without this
//! fallback: a photograph imported by a build older than MYND-441, one imported
//! with image OCR switched off, or a photo library pick of an image the vault
//! already holds. The sheet would then tell the user the page had no text, which
//! is a fact it never established. So a miss re-reads the sealed `MYA1` blob,
//! sniffs it, runs the same extractor the import runs, and writes the cache so the
//! next read is a plain hit. Best effort: a failed cache write still returns the
//! text, because the reading is what the caller asked for.
//!
//! Deliberately NOT consulted: the `MYC1` catalog. The delete path removes the
//! cache in the same operation that removes the blob (§ 9.15.4), so a tombstoned
//! attachment normally has nothing to serve; a caller that starts accepting
//! arbitrary ids from a picker should add the catalog check rather than inherit
//! this narrower contract.
//!
//! Secret-handling: `text` is note-body-class plaintext (AS1). It decrypts in
//! Rust RAM and crosses IPC as a plaintext string, so it is DENY-listed and MUST
//! NOT be logged or placed in any tracing field, exactly as the desktop twin and
//! `src-tauri/AGENTS.md` "Plaintext IPC across the WebView boundary" require.

use myne_core::plugins::attachments::commands::{hex_decode_id, read_account_number_hash};
use myne_core::plugins::attachments::extract_types::{ExtractStatus, ExtractedText, SourceFormat};
use myne_core::plugins::attachments::ocr;
use myne_core::plugins::attachments::scheme_core::{decode_attachment_plaintext, ServeKeys};
use myne_core::plugins::attachments::sniff::sniff_content_type;
use myne_core::plugins::attachments::text_cache;
use myne_core::plugins::vault_unlock::state::{SharedSingletonKey, VaultRuntimeState};
use myne_core::vault_io::StdVaultIo;
use protocol::MetaVersion;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Runtime, State};

/// The decrypted `MYE1` entry, mirroring the desktop DTO field for field so the
/// two clients' bindings describe the same payload.
#[derive(Serialize)]
pub struct AttachmentExtractedText {
    /// Plaintext, DENY-listed, never logged.
    pub text: String,
    /// Producing extractor's source format, lowercased (`image` for a photo).
    pub source_format: String,
    /// True when the cached entry hit the 1 MiB cap and `text` is the head.
    pub truncated: bool,
}

/// Closed error surface: no path, no id, no key material.
///
/// Deliberately two arms, not the desktop enum's four verbatim. `NotFound` and
/// `Denied` cannot occur here: an absent / stale / undecryptable cache blob is
/// `Ok(None)` (the "has no extracted text" signal the UI renders), not an error,
/// and this path never touches a blob that is not the cache or the source.
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum ReadExtractedError {
    /// The vault slot was not `Slot::Unlocked`. Frontend action: re-unlock.
    Locked,
    /// Host / IO failure resolving the vault directory, reading `vault.meta`, or
    /// joining the blocking task.
    Io,
}

/// Read one attachment's cached extracted text, re-extracting once on a miss.
/// `Slot::Unlocked`-gated; returns `Ok(None)` when the attachment has no reading
/// and none can be produced.
#[tauri::command]
pub async fn attachment_read_extracted_text<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    id: String,
) -> Result<Option<AttachmentExtractedText>, ReadExtractedError> {
    // Directory FIRST, key SECOND: the key has to be the freshest thing this
    // read takes, so a vault switch between the two cannot pair a new directory
    // with the previous vault's key. A switch after both still fails the AEAD tag,
    // and the generation comes from the `vault.meta` this read just parsed, so
    // nothing crosses vaults either way.
    let vault_dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| ReadExtractedError::Io)?;
    let material = state
        .peek_unlocked_attachment_material()
        .await
        .ok_or(ReadExtractedError::Locked)?;
    // Closed-set diagnostics, the same shape the desktop twin logs: a handset
    // otherwise reports "could not be read" with no way to tell a missing
    // `vault.meta` from an unparseable one. No path, id or text in any field.
    let (version, account_number_hash) =
        read_account_number_hash(&StdVaultIo, &vault_dir.join("vault.meta"))
            .await
            .map_err(|_| {
                tracing::error!(stage = "read_vault_meta", error_kind = "Io");
                ReadExtractedError::Io
            })?
            .map_err(|_| {
                tracing::error!(stage = "read_vault_meta", error_kind = "Parse");
                ReadExtractedError::Io
            })?;
    let (items_key, items_key_id, shared) = material;
    // Blob read, AEAD decrypt and (on a miss) OCR are CPU/IO bound, so they leave
    // the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        read_cached(
            &vault_dir,
            &items_key,
            items_key_id,
            shared,
            &id,
            version,
            &account_number_hash,
        )
    })
    .await
    .map_err(|join| {
        // Closed-set diagnostic: no id, no path, no text. The desktop twin logs
        // its join failure the same way, and without this a panicked blocking
        // task is indistinguishable from a missing file on a handset.
        tracing::error!(stage = "spawn_blocking_join", error_kind = "JoinFailure");
        let _ = join;
        ReadExtractedError::Io
    })
}

/// Sync body, run inside the blocking pool.
fn read_cached(
    vault_dir: &Path,
    items_key: &[u8; protocol::AEAD_KEY_LEN],
    items_key_id: [u8; 16],
    shared: SharedSingletonKey,
    id_hex: &str,
    version: MetaVersion,
    account_number_hash: &[u8; protocol::VAULT_META_ACCOUNT_HASH_LEN],
) -> Option<AttachmentExtractedText> {
    let attachment_id = hex_decode_id(id_hex)?;
    let attachment_text_key = shared.derive(version, protocol::SubkeyRole::AttachmentTextKey);
    if let Some(cached) = text_cache::read_extracted(
        vault_dir,
        &attachment_text_key,
        account_number_hash,
        &attachment_id,
    ) {
        match cached.status {
            ExtractStatus::Ok if !cached.text.is_empty() => return Some(to_dto(cached)),
            // A WRITTEN verdict is the answer, not a miss: the extractor is
            // deterministic over the same bytes, so re-reading the pixels would
            // reach the same conclusion at the cost of seconds.
            ExtractStatus::Ok | ExtractStatus::Empty | ExtractStatus::Failed => return None,
            // `Unsupported` is not cached by the import (nothing to store), so
            // falling through costs nothing and lets a newer build read it.
            ExtractStatus::Unsupported => {}
        }
    }
    // § 9.15.4's miss contract: re-derive from the sealed source.
    let keys = ServeKeys {
        items_key: (*items_key).into(),
        items_key_id,
        shared,
    };
    let plaintext = decode_attachment_plaintext(vault_dir, &keys, id_hex).ok()?;
    let content_type = sniff_content_type(&plaintext)?;
    if !ocr::is_ocr_image(content_type, id_hex) {
        return None;
    }
    let extracted = ocr::extract_image_only(content_type, id_hex, &plaintext);
    if extracted.status != ExtractStatus::Ok || extracted.text.is_empty() {
        return None;
    }
    // Warm the cache so the next read is a hit. A failed write is not a failed
    // read: the caller asked for the text and has it.
    let _ = text_cache::write_extracted(
        vault_dir,
        &attachment_text_key,
        account_number_hash,
        &attachment_id,
        &extracted,
    );
    Some(to_dto(extracted))
}

fn to_dto(extracted: ExtractedText) -> AttachmentExtractedText {
    AttachmentExtractedText {
        text: extracted.text,
        source_format: source_format_label(extracted.source_format).to_string(),
        truncated: extracted.truncated,
    }
}

/// The extractor's format as the lowercased label the DTO carries (the desktop
/// twin's vocabulary, so one client's consumer can read the other's payload).
fn source_format_label(format: SourceFormat) -> &'static str {
    match format {
        SourceFormat::Pdf => "pdf",
        SourceFormat::Docx => "docx",
        SourceFormat::Text => "text",
        SourceFormat::Other => "other",
        SourceFormat::Audio => "audio",
        SourceFormat::Image => "image",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;
    use zeroize::Zeroizing;

    /// The key the production path derives, so the cache written by a test is
    /// the cache the read expects. `derive` is the KDF under test in the
    /// generation case, not a constant to hardcode.
    fn text_key() -> [u8; protocol::AEAD_KEY_LEN] {
        let key = owner_key().derive(MetaVersion::V0_2, protocol::SubkeyRole::AttachmentTextKey);
        *key
    }

    fn hash() -> [u8; protocol::VAULT_META_ACCOUNT_HASH_LEN] {
        [9u8; protocol::VAULT_META_ACCOUNT_HASH_LEN]
    }

    const ID: &str = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";

    fn owner_key() -> SharedSingletonKey {
        SharedSingletonKey::OwnerRoot(Zeroizing::new([3u8; protocol::AEAD_KEY_LEN]))
    }

    fn write_entry(dir: &Path, id_hex: &str, text: &str, status: ExtractStatus) {
        let id = hex_decode_id(id_hex).expect("test id is valid");
        let mut extracted = ExtractedText::negative(status, SourceFormat::Image);
        extracted.text = text.to_string();
        extracted.char_count = text.chars().count() as u32;
        text_cache::write_extracted(dir, &text_key(), &hash(), &id, &extracted)
            .expect("cache write");
    }

    /// The read is driven through `read_cached` with the cache already written and
    /// NO `MYA1` blob on disk, which is exactly the state a real vault is in after
    /// an import: a hit must not touch the source, and every miss must come back
    /// empty rather than guessing. The re-extraction arm needs a sealed blob and
    /// real weights, so it is covered by the handset item in
    /// `scripts/manual-test-roster.mjs` rather than pretended at here.
    #[test]
    fn a_cache_hit_round_trips_and_every_other_arm_is_empty() {
        let dir = ScopedTempDir::new("read-extracted").expect("temp dir");
        write_entry(dir.path(), ID, "Toplantı notları", ExtractStatus::Ok);

        let hit = read_cached(
            dir.path(),
            &[1u8; protocol::AEAD_KEY_LEN],
            [2u8; 16],
            owner_key(),
            ID,
            MetaVersion::V0_2,
            &hash(),
        )
        .expect("the entry is there and decrypts");
        assert_eq!(hit.text, "Toplantı notları");
        assert_eq!(hit.source_format, "image");
        assert!(!hit.truncated);

        // A written `Empty` verdict is an answer, not a miss to re-derive.
        write_entry(dir.path(), ID, "", ExtractStatus::Empty);
        assert!(read_cached(
            dir.path(),
            &[1u8; 32],
            [2u8; 16],
            owner_key(),
            ID,
            MetaVersion::V0_2,
            &hash()
        )
        .is_none());

        // A written `Failed` verdict likewise.
        write_entry(dir.path(), ID, "", ExtractStatus::Failed);
        assert!(read_cached(
            dir.path(),
            &[1u8; 32],
            [2u8; 16],
            owner_key(),
            ID,
            MetaVersion::V0_2,
            &hash()
        )
        .is_none());

        // A malformed id never reaches the filesystem.
        assert!(read_cached(
            dir.path(),
            &[1u8; 32],
            [2u8; 16],
            owner_key(),
            "not-a-hex-id",
            MetaVersion::V0_2,
            &hash()
        )
        .is_none());

        // An id with no cache entry, and no source blob to re-derive it from.
        let other = "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34";
        assert!(read_cached(
            dir.path(),
            &[1u8; 32],
            [2u8; 16],
            owner_key(),
            other,
            MetaVersion::V0_2,
            &hash()
        )
        .is_none());
    }

    #[test]
    fn the_generation_is_part_of_the_key() {
        // The cache blob is AAD-bound to the generation the writer used, so the
        // same bytes at the other generation must not decrypt. This is the one
        // assertion that would have caught passing the wrong `MetaVersion` into
        // `derive`, which is how a migrated vault's text silently disappears.
        let dir = ScopedTempDir::new("read-extracted-gen").expect("temp dir");
        write_entry(dir.path(), ID, "metin", ExtractStatus::Ok);
        assert!(read_cached(
            dir.path(),
            &[1u8; 32],
            [2u8; 16],
            owner_key(),
            ID,
            MetaVersion::V0_1,
            &hash()
        )
        .is_none());
    }
}
