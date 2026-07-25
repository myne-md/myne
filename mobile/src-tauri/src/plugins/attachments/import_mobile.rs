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
    let result = attachment_import_with_dir_ext(
        &dir,
        state.inner(),
        source,
        created_at,
        myne_core::plugins::attachments::ocr::extract_image_only,
    )
    .await;
    if matches!(&result, Ok(imported) if !imported.deduplicated) {
        hooks.bump_local_change();
    }
    result
}
