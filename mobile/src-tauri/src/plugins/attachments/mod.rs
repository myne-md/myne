// SPDX-License-Identifier: AGPL-3.0
//! `attachments` plugin — mobile host (MYND-169, the attachments epic).
//!
//! Owns the `MYA1` blob + `MYC1` catalog CRUD and the in-RAM reference graph
//! for the open vault. The whole plugin core (commands, error, sniff, reconcile,
//! reconcile_commands, text_cache, the pure `scheme_core`, the cleanup ref-scan)
//! lives in `myne-core` (`myne_core::plugins::attachments`, shared with the
//! desktop client). Mobile registers the CRUD subset that works without a native
//! microphone or the desktop text extractor:
//!
//! - `attachment_import` — the **extraction-free** core import command (mobile
//!   has no `lopdf`/`zip`/`quick-xml` producer, so no `MYE1` text cache is
//!   written; desktop registers its own eager-extracting wrapper instead).
//! - `catalog_list` / `attachment_delete` / `attachment_rename` /
//!   `attachment_export` / `attachment_unused_list` / `attachment_clean_unused`.
//! - the reconcile trio (`attachment_refs_apply` / `_remove` / `_referencing`).
//!
//! NOT registered on mobile: the `voice_record_*` commands (native `cpal` mic —
//! a hard mobile blocker). Mobile voice notes still SHIP — the WebView records
//! audio via the Web Audio API (`getUserMedia`), wraps the PCM as `audio/wav` in
//! TS, and stores it through the ordinary `attachment_import` above (no native
//! recorder, no new command; `decisions.md` 2026-07-12). The `attachment://` URI
//! scheme IS registered on the mobile Tauri `Builder` in `lib.rs` (delegating to
//! the shared `scheme_core::build_response`) and already serves `audio/wav`.
//!
//! The lock-teardown wipe of the reference graph is wired: `myne-core` calls
//! `VaultLifecycleHooks::zeroize_attachment_refs` at every slot-drop site and
//! `crate::hooks::MobileHooks` implements it against the `AttachmentRefsState`
//! `lib.rs` manages (myne-md/myne#454). It was an empty body until then, which
//! left one vault's note-id ↔ attachment-id correlation tags (AS3) resident
//! across a lock and additively merged with the next vault's.
//!
//! Commands are registered via the `myne_core::plugins::attachments` module path
//! so `generate_handler!` finds each command's hidden `__cmd__` items (a bare
//! `pub use` of the `#[tauri::command]` fns would drop them).
//!
//! See: the main repo's `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline".

// Re-exported for path-compatibility with any consumer referencing
// `crate::plugins::attachments::{commands, reconcile, …}` (mirrors the desktop
// re-export surface). `commands` + `reconcile_commands` are the symbols `init()`
// registers; `AttachmentRefsState` is managed in `lib.rs`.
pub use myne_core::plugins::attachments::AttachmentRefsState;
#[allow(unused_imports)]
pub use myne_core::plugins::attachments::{
    commands, error, reconcile, reconcile_commands, scheme_core, sniff, text_cache,
};

// Mobile Tauri glue for the `attachment://` URI scheme (delegates to the shared
// `scheme_core::build_response`). Registered on the Builder in `lib.rs`.
pub mod import_mobile;
pub mod scheme;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Construct the mobile `attachments` plugin. The `VaultRuntimeState` it
/// borrows is registered by the `vault-unlock` plugin; its own
/// [`AttachmentRefsState`] is managed in `lib.rs` setup (like desktop). The
/// `attachment://` scheme is registered separately on the `Builder`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("attachments")
        .invoke_handler(tauri::generate_handler![
            // MYND-441: import with eager image OCR into the MYE1 cache, so a
            // photo or screenshot taken on the phone is searchable by its
            // contents exactly as on desktop. PDF/DOCX/text extraction stays
            // desktop-only (lopdf/zip/quick-xml are desktop deps).
            import_mobile::attachment_import,
            commands::catalog_list,
            commands::attachment_delete,
            commands::attachment_rename,
            commands::attachment_export,
            commands::attachment_unused_list,
            commands::attachment_clean_unused,
            reconcile_commands::attachment_refs_apply,
            reconcile_commands::attachment_refs_remove,
            reconcile_commands::attachment_refs_referencing,
        ])
        .setup(|app, _api| {
            // Load the bundled OCR weights once at startup from the platform
            // resource dir (MYND-441), mirroring desktop. Failure is not an
            // error: without weights, image attachments simply report
            // `Unsupported` and the app starts normally.
            let available = app
                .path()
                .resource_dir()
                .ok()
                .map(|rd| {
                    myne_core::plugins::attachments::ocr::init_from_base(
                        &rd.join("models")
                            .join(myne_core::plugins::attachments::ocr::OCR_MODELS_DIR_NAME),
                    )
                })
                .unwrap_or(false);
            if !available {
                tracing::info!("OCR weights unavailable; image attachments will not be indexed");
            }
            Ok(())
        })
        .build()
}
