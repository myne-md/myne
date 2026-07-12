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

use crate::plugins::attachments::scheme_core::{read_attachment_text, ReadTextOutcome, ServeKeys};
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

    match read_attachment_text(&vault_dir, &keys, &id) {
        ReadTextOutcome::Ok { text, truncated } => Ok(AttachmentTextResponse { text, truncated }),
        ReadTextOutcome::NotFound => Err(AttachmentReadTextError::NotFound),
        ReadTextOutcome::Denied => Err(AttachmentReadTextError::Denied),
        ReadTextOutcome::ServerError => Err(AttachmentReadTextError::Io),
    }
}
