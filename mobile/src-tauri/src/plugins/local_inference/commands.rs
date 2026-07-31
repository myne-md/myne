//! `transcribe` / `read_transcript` Tauri commands — the mobile port of the
//! desktop local_inference transcription commands (MYND-563). **Transcription
//! only** — the desktop infer/embed/chat/semantic-search commands are out of
//! scope on mobile.
//!
//! Discipline (`src-tauri/CLAUDE.md`, normative here too): the decrypted WAV, the
//! derived PCM, and the transcript are `Zeroizing`/never-logged; the model call
//! runs under `spawn_blocking` (CPU-bound, keeps the async command `Send`), the
//! engine reached ONLY through the `Engine` trait; the `transcription_enabled`
//! gate is re-read host-side (a compromised WebView is not trusted to stop
//! calling). The transcript is sealed into the attachment's MYE1 cache so it is
//! searchable + re-insertable without re-transcribing; the backend NEVER writes
//! it into a note body (insertion is the frontend's explicit MY01 action).

#![cfg_attr(not(test), allow(dead_code))]

use std::path::Path;

use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

use myne_core::plugins::attachments::extract_types::{ExtractStatus, SourceFormat};
use myne_core::plugins::attachments::scheme_core::{decode_attachment_plaintext, ServeKeys};
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;

use super::cancel::{guarded_on_token, CancelToken};
use super::error::EngineError;
use super::state::LocalInferenceState;

/// DENY-list-safe static label for structured logging (mirrors
/// `protocol_error_kind`): a new [`EngineError`] variant compile-fails
/// `EngineError::kind`, structurally catching drift.
pub fn local_inference_error_kind(e: &EngineError) -> &'static str {
    e.kind()
}

/// Transcribe an audio attachment on-device, streaming each ~30 s segment through
/// `on_segment` and returning the full transcript. Gated host-side on
/// `transcription_enabled` (default ON; MYND-592 — NOT the `ai_enabled` embedding
/// opt-in). Seals the transcript into the attachment's MYE1 cache.
#[tauri::command]
pub async fn transcribe<R: Runtime>(
    attachment_id: String,
    on_segment: Channel<String>,
    app: AppHandle<R>,
    engine_state: State<'_, LocalInferenceState>,
    vault_state: State<'_, VaultRuntimeState>,
    cancel: State<'_, CancelToken>,
) -> Result<String, EngineError> {
    // Host-side `transcription_enabled` gate — no engine call and no decrypt when
    // speech-to-text is off. Re-read here (not taken on the caller's word): a
    // prefs blob that cannot be read decodes to defaults, and this field defaults
    // ON; a locked slot still fails closed (`prefs_read_from_host` refuses without
    // one). One small AEAD-decrypt is free next to running an ML model.
    let prefs = myne_core::plugins::prefs::commands::prefs_read_from_host(
        &myne_core::host::tauri_host::TauriHost::new(app.clone()),
        vault_state.inner(),
        &myne_core::vault_io::StdVaultIo,
    )
    .await
    .map_err(|_| EngineError::NotReady)?;
    if !prefs.transcription_enabled {
        return Err(EngineError::NotReady);
    }
    // Fresh cancel window (a prior Stop must not abort this run).
    cancel.reset();

    // Resolve the unlocked slot's key material + the active vault dir.
    let keys = match vault_state.peek_unlocked_attachment_material().await {
        Some((items_key, items_key_id, root_key)) => ServeKeys {
            items_key,
            items_key_id,
            root_key,
        },
        None => return Err(EngineError::NotReady),
    };
    let active_id = vault_state.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root_io(&app, active_id)
        .map_err(|_| EngineError::TranscriptionFailed)?;

    let engine = engine_state.engine();
    let cancel_token: CancelToken = (*cancel).clone();
    let app_for_cache = app.clone();

    // Heavy work off the async thread: decrypt → decode → resample → engine →
    // seal the transcript into the attachment's MYE1 cache.
    let transcript = tokio::task::spawn_blocking(move || -> Result<String, EngineError> {
        // Decrypt the MYA1 blob to WAV bytes in RAM (wiped on drop).
        let wav = decode_attachment_plaintext(&vault_dir, &keys, &attachment_id)
            .map_err(|_| EngineError::TranscriptionFailed)?;
        // Decode + resample to 16 kHz mono; wrap the derived PCM.
        let pcm = Zeroizing::new(
            super::audio::wav_to_mono_16k(&wav).map_err(|_| EngineError::TranscriptionFailed)?,
        );
        drop(wav);
        // Stream each decoded segment through the cancel publish-guard into the
        // IPC channel; the transcript text is never logged.
        let mut on = guarded_on_token(&cancel_token, |seg: &str| {
            let _ = on_segment.send(seg.to_string());
        });
        let transcript = engine.transcribe_streaming(&pcm, &mut on)?;
        // Seal into the attachment's MYE1 cache so it is searchable +
        // re-insertable without re-transcribing; the model's SHA-256 (SYNC-V3)
        // binds cache-invalidation identity into the INNER payload. Best-effort —
        // a cache-write miss must not discard the transcript the user has.
        persist_transcript_cache(
            &vault_dir,
            &keys.root_key,
            &attachment_id,
            &transcript,
            &app_for_cache,
        );
        Ok(transcript)
    })
    .await
    .map_err(|_| EngineError::TranscriptionFailed)??;

    // NOTE (mobile): desktop live-refreshes the AI-embedding `att:` search docs
    // here (`notes::search_sync`), which is out of scope on mobile — MYS1 search
    // is frontend-fed and the sealed MYE1 transcript is folded into the owning
    // note's searchable content on the next index build. No refresh call here.

    Ok(transcript)
}

/// Read `vault.meta`'s `account_number_hash` (the AAD binding for the
/// attachment-text cache). `None` on IO / parse failure. Used, never logged.
fn read_account_number_hash(
    vault_dir: &Path,
) -> Option<[u8; protocol::VAULT_META_ACCOUNT_HASH_LEN]> {
    let bytes = std::fs::read(vault_dir.join("vault.meta")).ok()?;
    protocol::parse_vault_meta(&bytes)
        .map(|m| m.account_number_hash)
        .ok()
}

/// Seal a produced transcript into the attachment's MYE1 cache. Resolves the
/// account-hash AAD binding, derives the `AttachmentTextKey` KEK from the
/// unlocked-slot `root_key`, binds the current transcription model's SHA-256 into
/// the inner payload (SYNC-V3), and writes via `text_cache::write_transcript`.
/// Best-effort; DENY-list: no transcript / hash / path is logged.
fn persist_transcript_cache<R: Runtime>(
    vault_dir: &Path,
    root_key: &[u8; 32],
    attachment_id_hex: &str,
    transcript: &str,
    app: &AppHandle<R>,
) {
    let Some(attachment_id) =
        myne_core::plugins::attachments::commands::hex_decode_id(attachment_id_hex)
    else {
        return;
    };
    let Some(account_number_hash) = read_account_number_hash(vault_dir) else {
        return;
    };
    let model_hash = super::model_store::transcription_model_hash_for(app);
    let attachment_text_key =
        protocol::derive_subkey(root_key, protocol::SubkeyRole::AttachmentTextKey);
    let _ = myne_core::plugins::attachments::text_cache::write_transcript(
        vault_dir,
        &attachment_text_key,
        &account_number_hash,
        &attachment_id,
        transcript,
        model_hash,
    );
}

/// Read an already-transcribed attachment's cached transcript from its MYE1 cache
/// so the UI can show / re-insert it WITHOUT re-running the engine.
/// `Slot::Unlocked`-gated; `None` when no `Ok` audio transcript is cached. No
/// engine call and no gate — this reads already-produced, already-searchable
/// text. The transcript is plaintext — returned to the WebView, never logged.
#[tauri::command]
pub async fn read_transcript<R: Runtime>(
    attachment_id: String,
    app: AppHandle<R>,
    vault_state: State<'_, VaultRuntimeState>,
) -> Result<Option<String>, EngineError> {
    let Some(root_key) = vault_state.peek_unlocked_root_key_clone().await else {
        return Err(EngineError::NotReady);
    };
    let active_id = vault_state.active_vault_id().await;
    let vault_dir = crate::paths::active_vault_root_io(&app, active_id)
        .map_err(|_| EngineError::TranscriptionFailed)?;
    let transcript = tokio::task::spawn_blocking(move || -> Option<String> {
        read_cached_transcript(&vault_dir, &root_key, &attachment_id)
    })
    .await
    .map_err(|_| EngineError::TranscriptionFailed)?;
    Ok(transcript)
}

/// Read + decode the cached `Ok` AUDIO transcript for `attachment_id_hex`, or
/// `None` on any miss. Sync (runs in `spawn_blocking`); never logged.
fn read_cached_transcript(
    vault_dir: &Path,
    root_key: &[u8; 32],
    attachment_id_hex: &str,
) -> Option<String> {
    let attachment_id =
        myne_core::plugins::attachments::commands::hex_decode_id(attachment_id_hex)?;
    let account_number_hash = read_account_number_hash(vault_dir)?;
    let attachment_text_key =
        protocol::derive_subkey(root_key, protocol::SubkeyRole::AttachmentTextKey);
    let extracted = myne_core::plugins::attachments::text_cache::read_extracted(
        vault_dir,
        &attachment_text_key,
        &account_number_hash,
        &attachment_id,
    )?;
    if extracted.status == ExtractStatus::Ok
        && extracted.source_format == SourceFormat::Audio
        && !extracted.text.is_empty()
    {
        Some(extracted.text)
    } else {
        None
    }
}
