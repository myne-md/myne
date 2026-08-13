//! Mobile `attachment_import` command wrapper (MYND-441).
//!
//! The platform-agnostic import core
//! (`myne_core::plugins::attachments::commands::attachment_import_with_dir_ext`)
//! takes the text-extraction *producer* as an injected closure. Mobile used to
//! pass nothing at all — it registered the extraction-free core command, so no
//! `MYE1` cache was ever written on a phone and search never reached inside any
//! attachment.
//!
//! This wrapper injects
//! [`myne_core::plugins::attachments::ocr::extract_image_only`], closing the
//! **image** half of that gap: a photo or screenshot imported on the phone is
//! OCR'd and becomes searchable exactly as on desktop, byte-for-byte, because
//! both platforms run the same extractor over the same bundled weights.
//!
//! PDF / DOCX / text-like extraction stays desktop-only: those are bound to
//! `lopdf` / `zip` / `quick-xml`, which are desktop dependencies. Mobile reports
//! them `Unsupported`, exactly as before.

use myne_core::plugins::attachments::commands::{
    attachment_import_with_dir_ext, ImportSource, ImportedAttachment,
};
use myne_core::plugins::attachments::error::AttachmentImportError;
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use tauri::{AppHandle, Runtime, State};

/// `Slot::Unlocked`-gated attachment import with eager image OCR into the `MYE1`
/// cache (the mobile path).
#[tauri::command]
pub async fn attachment_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, myne_core::hooks::Hooks>,
    source: ImportSource,
    created_at: Option<u64>,
) -> Result<ImportedAttachment, AttachmentImportError> {
    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(AttachmentImportError::from)?;
    // MYND-441: honour the image-OCR opt-out here too. The pref is DEVICE-LOCAL
    // by design (per-device compute budget, `sync-protocol.md` §10.2), so a
    // desktop toggle cannot reach a phone — which means if this path ignored it,
    // a phone would have no way to turn OCR off at all. An unreadable prefs blob
    // reads as ON, matching desktop: a prefs read failure must not silently
    // disable a search feature.
    let ocr_enabled = myne_core::plugins::prefs::commands::prefs_read_with_dir(
        &dir,
        state.inner(),
        &myne_core::vault_io::StdVaultIo,
    )
    .await
    .map(|p| p.attachment_ocr_enabled)
    .unwrap_or(true);
    let extractor = if ocr_enabled {
        myne_core::plugins::attachments::ocr::extract_image_only
    } else {
        no_ocr_extract
    };
    // `StdVaultIo` + `TauriHost`: the same `std::fs` and the same Tauri app
    // handle this path already used before the shared core moved filesystem
    // access and host services behind seams. Mobile is a native target — the
    // seams exist so a *browser* can supply something else, not so mobile
    // behaves differently.
    let result = attachment_import_with_dir_ext(
        &myne_core::vault_io::StdVaultIo,
        &myne_core::host::tauri_host::TauriHost::new(app.clone()),
        &dir,
        state.inner(),
        source,
        created_at,
        extractor,
    )
    .await;
    if matches!(&result, Ok(imported) if !imported.deduplicated) {
        hooks.bump_local_change();
    }
    result
}

/// The extractor injected when the user has turned image OCR off: every format
/// reports `Unsupported`, which the import path declines to cache, so nothing is
/// extracted and nothing is recorded as final.
fn no_ocr_extract(
    _content_type: &str,
    _filename: &str,
    _bytes: &[u8],
) -> myne_core::plugins::attachments::ExtractedText {
    myne_core::plugins::attachments::ExtractedText::negative(
        myne_core::plugins::attachments::ExtractStatus::Unsupported,
        myne_core::plugins::attachments::SourceFormat::Other,
    )
}
