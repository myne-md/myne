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
use crate::plugins::attachments::scheme_core::{
    decode_attachment_plaintext, read_attachment_text, DecodeError, ReadTextOutcome, ServeKeys,
};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use serde::Serialize;
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
