// SPDX-License-Identifier: AGPL-3.0-only
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
    let extractor = ocr_extractor(ocr_enabled);
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
        // The ordinary paste / share / file-pick path on mobile: bytes arriving
        // from outside the vault for the first time, so the user's compression
        // preference is the answer about them. `created_at` is `Some` only when
        // the caller re-materializes a file that carries its own age.
        myne_core::plugins::attachments::commands::IngestPolicy {
            created_at_override: created_at,
            compression: myne_core::plugins::attachments::commands::IngestCompression::Apply,
            // **The library, because mobile has no chat-attachment surface
            // wired yet** (myne-md/myne#913 is a desktop panel change). The
            // field is declared rather than defaulted so a mobile paste cannot
            // silently join the library if that surface ever arrives: the
            // compiler asks this call site the question then.
            scope: myne_core::plugins::attachments::commands::scope_for_wire(None),
        },
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

/// The extractor the opt-out selects. Named rather than written inline at the
/// call site so the BRANCH is testable: myne-md/myne#880 added the switch that
/// writes `attachment_ocr_enabled`, and the property that makes it more than a
/// stored value is that this path injects a no-op extractor when it is off.
/// Asserting the pref was written would pass over a path that ignored it.
fn ocr_extractor(
    ocr_enabled: bool,
) -> fn(&str, &str, &[u8]) -> myne_core::plugins::attachments::ExtractedText {
    if ocr_enabled {
        myne_core::plugins::attachments::ocr::extract_image_only
    } else {
        no_ocr_extract
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::plugins::attachments::{ExtractStatus, SourceFormat};

    /// The content types the import path treats as OCR-able, so a case below
    /// cannot pass by choosing a format nothing would have extracted anyway.
    const IMAGE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/heic"];

    #[test]
    fn the_opt_out_disables_extraction_for_every_image_format() {
        // The property the switch exists for: with OCR off, an image-only
        // attachment is no longer indexed. Asserted through the same function
        // the command calls, not through the pref.
        let extractor = ocr_extractor(false);
        for content_type in IMAGE_TYPES {
            let out = extractor(content_type, "scan.png", b"\x89PNG\r\n\x1a\n");
            assert_eq!(
                out.status,
                ExtractStatus::Unsupported,
                "OCR off must decline {content_type}"
            );
            assert_eq!(out.source_format, SourceFormat::Other);
            assert!(out.text.is_empty(), "OCR off must produce no text");
        }
    }

    #[test]
    fn the_opt_in_selects_the_real_extractor() {
        // The other direction, so the case above is not satisfied by a path that
        // declines everything unconditionally. `extract_image_only` on a
        // non-image content type reports `Unsupported` too, so this asserts the
        // SELECTION rather than a successful extraction, in two halves.
        //
        // Identity first: the opt-in hands back a different function.
        assert!(!std::ptr::fn_addr_eq(
            ocr_extractor(true) as fn(&str, &str, &[u8]) -> _,
            ocr_extractor(false) as fn(&str, &str, &[u8]) -> _,
        ));
        // Then behaviour, since identity alone would pass over two distinct
        // functions that both decline (myne-md/myne#867 review). The input is an
        // image content type carrying a truncated PNG (the signature and nothing
        // after it), which the real extractor ATTEMPTS: it claims the bytes as an
        // image, and with the bundled weights loaded it reports the decode as
        // `Failed`. The no-op reports `Unsupported` with `SourceFormat::Other`
        // for the same input, as the case above asserts.
        //
        // A checkout without the Git-LFS weights has no OCR engine, and the real
        // extractor then honestly reports `Unsupported` before reading a byte, so
        // that branch can assert only the source format. The helper PANICS when
        // the weights are present and will not load, so a broken engine cannot
        // pass as the weightless branch.
        let truncated_png = b"\x89PNG\r\n\x1a\n";
        let weights_loaded = myne_core::plugins::attachments::ocr::init_bundled_models_for_tests();
        for content_type in IMAGE_TYPES {
            let out = ocr_extractor(true)(content_type, "scan.png", truncated_png);
            assert_eq!(
                out.source_format,
                SourceFormat::Image,
                "OCR on must claim {content_type} as an image"
            );
            let expected = if weights_loaded {
                ExtractStatus::Failed
            } else {
                ExtractStatus::Unsupported
            };
            assert_eq!(
                out.status, expected,
                "OCR on, {content_type}, truncated PNG (weights loaded: {weights_loaded})"
            );
            assert!(out.text.is_empty(), "a truncated image yields no text");
        }
        // And a non-image is declined by BOTH, which is why the assertion above
        // is about identity rather than about a format neither would read.
        assert_eq!(
            ocr_extractor(true)("text/plain", "notes.txt", b"hello").status,
            ExtractStatus::Unsupported
        );
        assert_eq!(
            ocr_extractor(false)("text/plain", "notes.txt", b"hello").status,
            ExtractStatus::Unsupported
        );
    }
}
