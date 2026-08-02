// SPDX-License-Identifier: AGPL-3.0
//! `attachment_read_text` — decrypt one attachment's plaintext as TEXT for a
//! Tier-1 inline preview (MYND-268). The decode core is
//! [`crate::plugins::attachments::scheme_core::read_attachment_text`]; this host
//! wrapper is the `Slot::Unlocked` gate + active-vault-dir resolution + the
//! closed IPC error surface — the SAME shape as the `attachment://` scheme
//! handler ([`super::scheme`]), except it returns inert text over `invoke`
//! rather than serving bytes to the WebView.
//!
//! Secret-handling: the returned `text` is note-body-class plaintext — it is
//! DENY-listed and MUST NOT be logged or placed in any tracing field; see
//! `src-tauri/CLAUDE.md` "Plaintext IPC across the WebView boundary".

use crate::plugins::attachments::extract::{extract_docx_blocks, extract_xlsx_grid, DocxBlockKind};
use crate::plugins::attachments::extract_types::{ExtractStatus, SourceFormat};
use crate::plugins::attachments::scheme_core::{
    decode_attachment_plaintext, read_attachment_text, DecodeError, ReadTextOutcome, ServeKeys,
};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use serde::Serialize;
use std::path::Path;
use tauri::{Runtime, State};

/// The decrypted preview text (with a truncation flag when the attachment
/// exceeded the preview cap). `text` is plaintext — DENY-listed, never logged.
#[derive(Serialize)]
pub struct AttachmentTextResponse {
    pub text: String,
    /// True when the attachment was larger than the preview cap and `text`
    /// carries only the leading bytes (the user still has full-fidelity Export).
    pub truncated: bool,
}

/// Closed IPC error surface for [`attachment_read_text`]. DENY-list clean — no
/// path, no id, no key material. `Denied` is deliberately non-distinguishing
/// (tampered / wrong-key / cross-vault collapse to one, mirroring the serve
/// path's §6.4 posture).
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum AttachmentReadTextError {
    /// The vault slot was not `Slot::Unlocked`. Frontend CTA: re-unlock.
    Locked,
    /// No such attachment (absent id / catalog entry / blob).
    NotFound,
    /// Malformed id or a decode failure (non-distinguishing).
    Denied,
    /// Host / IO failure reading vault.meta or the blob.
    Io,
}

/// Decrypt attachment `id`'s plaintext as (lossy) UTF-8 text for a Tier-1
/// preview. `Slot::Unlocked`-gated; text decrypts in RAM and crosses IPC as a
/// plaintext `String` (accepted under the V8-leak-dominance argument, like
/// `note_read`). Never re-sniffs/allowlists — the caller renders inert text.
#[tauri::command]
pub async fn attachment_read_text<R: Runtime>(
    id: String,
    app: tauri::AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<AttachmentTextResponse, AttachmentReadTextError> {
    let keys = match state.peek_unlocked_attachment_material().await {
        Some((items_key, items_key_id, root_key)) => ServeKeys {
            items_key,
            items_key_id,
            root_key,
        },
        None => return Err(AttachmentReadTextError::Locked),
    };
    let vault_dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| AttachmentReadTextError::Io)?;

    // Blob read + AEAD decrypt → CPU/IO-bound → spawn_blocking (the pattern of
    // `attachment_export` and the ref scans). `keys` (Zeroizing) moves into the
    // closure and wipes on exit.
    let outcome = tokio::task::spawn_blocking(move || read_attachment_text(&vault_dir, &keys, &id))
        .await
        .map_err(|_join| {
            tracing::error!(stage = "spawn_blocking_join", error_kind = "JoinFailure");
            AttachmentReadTextError::Io
        })?;
    match outcome {
        ReadTextOutcome::Ok { text, truncated } => Ok(AttachmentTextResponse { text, truncated }),
        ReadTextOutcome::NotFound => Err(AttachmentReadTextError::NotFound),
        ReadTextOutcome::Denied => Err(AttachmentReadTextError::Denied),
        ReadTextOutcome::ServerError => Err(AttachmentReadTextError::Io),
    }
}

/// A Tier-2 attachment parsed into a SAFE structured model (MYND-268): a
/// row-major grid (xlsx) or a heading/paragraph block list (docx). Only the
/// model crosses IPC — never raw bytes or HTML — so there is no WebView XSS
/// surface (the whole point of parsing in Rust, not the renderer).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StructuredContent {
    Grid { rows: Vec<Vec<String>> },
    Blocks { blocks: Vec<StructuredBlock> },
}

/// One docx block: `heading_level` is 1..=6 for a heading, `null` for body text.
#[derive(Serialize)]
pub struct StructuredBlock {
    pub heading_level: Option<u8>,
    pub text: String,
}

/// Max grid rows / doc blocks materialized for a preview (the rest is Export).
const STRUCTURED_PREVIEW_MAX: usize = 1000;

/// Decrypt + parse a Tier-2 attachment (`kind` = `"xlsx"` | `"docx"`) into a safe
/// structured model for inline preview (MYND-268 Tier-2). Parsing runs in Rust
/// (`zip` + `quick-xml`); only the structured model crosses IPC. Slot::Unlocked-
/// gated. An unrecognized `kind` is a `NotFound` (nothing to render).
#[tauri::command]
pub async fn attachment_read_structured<R: Runtime>(
    id: String,
    kind: String,
    app: tauri::AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<StructuredContent, AttachmentReadTextError> {
    let keys = match state.peek_unlocked_attachment_material().await {
        Some((items_key, items_key_id, root_key)) => ServeKeys {
            items_key,
            items_key_id,
            root_key,
        },
        None => return Err(AttachmentReadTextError::Locked),
    };
    let vault_dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| AttachmentReadTextError::Io)?;
    // Blob read + AEAD decrypt + zip inflate + XML parse → CPU/IO-bound →
    // spawn_blocking (the pattern of `attachment_export` and the ref scans).
    // `keys` (Zeroizing) moves into the closure and wipes on exit.
    tokio::task::spawn_blocking(move || {
        let bytes = decode_attachment_plaintext(&vault_dir, &keys, &id).map_err(|e| match e {
            DecodeError::NotFound => AttachmentReadTextError::NotFound,
            DecodeError::Denied => AttachmentReadTextError::Denied,
            DecodeError::ServerError => AttachmentReadTextError::Io,
        })?;
        match kind.as_str() {
            "xlsx" => Ok(StructuredContent::Grid {
                rows: extract_xlsx_grid(&bytes, STRUCTURED_PREVIEW_MAX),
            }),
            "docx" => Ok(StructuredContent::Blocks {
                blocks: extract_docx_blocks(&bytes, STRUCTURED_PREVIEW_MAX)
                    .into_iter()
                    .map(|b| StructuredBlock {
                        heading_level: match b.kind {
                            DocxBlockKind::Heading(level) => Some(level),
                            DocxBlockKind::Paragraph => None,
                        },
                        text: b.text,
                    })
                    .collect(),
            }),
            _ => Err(AttachmentReadTextError::NotFound),
        }
    })
    .await
    .map_err(|_join| {
        tracing::error!(stage = "spawn_blocking_join", error_kind = "JoinFailure");
        AttachmentReadTextError::Io
    })?
}

/// The decrypted `MYE1` extracted-text cache entry for an attachment
/// (`protocol.md` § 9.15). Today the only producer whose output this reads back
/// is the on-device voice-note transcription path (`SourceFormat::Audio`, written
/// by the `local-inference` transcribe command), but the shape is format-agnostic
/// so a future "view extracted text" affordance for PDFs/images reuses it. `text`
/// is plaintext — same secret class as a note body, DENY-listed (never logged).
#[derive(Serialize)]
pub struct AttachmentExtractedText {
    /// The cached extracted / transcribed text (only present for an `Ok`,
    /// non-empty extraction).
    pub text: String,
    /// The producing extractor's source format, lowercased — `"audio"` | `"pdf"`
    /// | `"docx"` | `"text"` | `"image"` | `"other"`. Lets the caller confirm an
    /// audio transcript before rendering it as one.
    pub source_format: String,
    /// True when the extraction hit the 1 MiB cache cap and `text` holds the head.
    pub truncated: bool,
}

/// Lowercased tag for a [`SourceFormat`], matching the frontend `kindOf` vocabulary.
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

/// Read `vault.meta`'s 16-byte `account_number_hash` — the AAD binding identity of
/// the `MYE1` cache blob (§ 9.15.3). `None` on IO / parse failure. The bytes are a
/// vault-stable correlation tag: used, never logged (DENY-list).
fn read_account_number_hash(
    vault_dir: &Path,
) -> Option<[u8; protocol::VAULT_META_ACCOUNT_HASH_LEN]> {
    let bytes = std::fs::read(vault_dir.join("vault.meta")).ok()?;
    protocol::parse_vault_meta(&bytes)
        .map(|m| m.account_number_hash)
        .ok()
}

/// Decrypt + decode an attachment's `MYE1` extracted-text cache, returning the
/// `Ok`, non-empty text (else `None` on any miss — bad id, absent meta, an absent
/// / undecryptable / stale / empty blob). Sync (runs inside `spawn_blocking`); the
/// text is plaintext — never logged.
fn read_cached_extracted_text(
    vault_dir: &Path,
    root_key: &[u8; 32],
    id_hex: &str,
) -> Option<AttachmentExtractedText> {
    let attachment_id = super::commands::hex_decode_id(id_hex)?;
    let account_number_hash = read_account_number_hash(vault_dir)?;
    let attachment_text_key =
        protocol::derive_subkey(root_key, protocol::SubkeyRole::AttachmentTextKey);
    let extracted = super::text_cache::read_extracted(
        vault_dir,
        &attachment_text_key,
        &account_number_hash,
        &attachment_id,
    )?;
    if extracted.status != ExtractStatus::Ok || extracted.text.is_empty() {
        return None;
    }
    Some(AttachmentExtractedText {
        text: extracted.text,
        source_format: source_format_label(extracted.source_format).to_string(),
        truncated: extracted.truncated,
    })
}

/// Read one attachment's cached `MYE1` extracted text (`protocol.md` § 9.15) — the
/// read-back side of the transcription / OCR / text-extraction cache the desktop
/// writes. `Slot::Unlocked`-gated; returns `Ok(None)` when no `Ok` extracted-text
/// blob exists for `id` (never transcribed / silence / decode miss), which is the
/// "has no transcript" signal the UI reads. Decrypts in Rust RAM and crosses IPC
/// as plaintext (note-body class, DENY-listed) — the caller renders it INERT in a
/// read-only surface, never as interpreted content. Mirrors the `Slot::Unlocked`
/// gate + closed error surface of [`attachment_read_text`].
///
/// Deliberately in the `attachments` plugin, NOT `local_inference`: reading an
/// already-produced transcript needs no engine and no `ai_enabled` gate, so it
/// stays available in the auditable `--no-default-features` build (which drops the
/// whole inference stack) exactly as in the default one.
#[tauri::command]
pub async fn attachment_read_extracted_text<R: Runtime>(
    id: String,
    app: tauri::AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Option<AttachmentExtractedText>, AttachmentReadTextError> {
    let root_key = match state.peek_unlocked_root_key_clone().await {
        Some(root_key) => root_key,
        None => return Err(AttachmentReadTextError::Locked),
    };
    let vault_dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| AttachmentReadTextError::Io)?;
    // Blob read + AEAD decrypt → CPU/IO-bound → spawn_blocking. `root_key`
    // (Zeroizing) moves into the closure and wipes on exit.
    tokio::task::spawn_blocking(move || read_cached_extracted_text(&vault_dir, &root_key, &id))
        .await
        .map_err(|_join| {
            tracing::error!(stage = "spawn_blocking_join", error_kind = "JoinFailure");
            AttachmentReadTextError::Io
        })
}
