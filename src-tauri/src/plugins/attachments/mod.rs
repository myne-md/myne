//! `attachments` Tauri plugin (MYND-169 — the
//! `attachments-crypto-pipeline` sub-feature of the attachments epic).
//!
//! Owns the `attachment_import` / `catalog_list` / `attachment_delete`
//! IPC commands. All three are `Slot::Unlocked`-gated and consume the
//! existing `VaultRuntimeState` singleton (registered by
//! `vault_unlock::init`) via `tauri::State<...>` — this plugin holds NO
//! plugin-private state. The per-plugin catalog write mutex lives inside
//! `commands.rs` as a `OnceLock<Mutex<()>>`, scoped to serializing the
//! `vault.attachments` read-modify-write.
//!
//! The companion `attachment://<id>` async URI scheme handler lives in
//! [`scheme`] and is registered on the Tauri `Builder` in `lib.rs`
//! (custom protocol handlers are a builder-level concern, not a plugin
//! invoke handler). It decrypts the `MYA1` blob in memory, re-sniffs the
//! content-type from the decrypted bytes, and serves ONLY an allowlisted
//! type — never `text/html` (the XSS-defense invariant).
//!
//! Sibling to `vault_unlock`, `prefs`, `notes`, `vault_indices`. The
//! plugin name in the ACL namespace is `attachments` (hyphenless single
//! word); `build.rs` declares it as an `InlinedPlugin` so permissions
//! resolve under the `attachments:` namespace.
//!
//! ## Design history
//!
//! - PRD: `myne-agents/features/attachments-crypto-pipeline/prd.md`
//! - Epic sync-ledger: `myne-agents/epics/attachments/sync-ledger.md`
//!   (SYNC-4 handler contract, SYNC-6 reference graph, SYNC-8 import +
//!   dedup, SYNC-10 CSP)
//! - Spec: `docs/spec/protocol.md` §9.9 (MYA1) / §9.10 (MYC1) / §5.2
//!   (AADs) / §3.4 (subkeys)
//!
//! ## Capability ACL
//!
//! `attachments:default` bundles `allow-attachment-import`,
//! `allow-catalog-list`, `allow-attachment-delete`,
//! `allow-attachment-rename`, the reconcile trio, and
//! `allow-attachment-unused-list` (MYND-171). Main-window-only — the
//! import/delete/cleanup writes and the catalog/scan reads are privileged
//! operations on vault state.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;
pub mod reconcile;
pub mod reconcile_commands;
pub mod scheme;
pub mod sniff;
pub mod voice;

pub use reconcile::AttachmentRefsState;
pub use voice::{abort_active_recording, VoiceRecordState};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

/// Best-effort zeroize + reset of the in-RAM attachment reference graph
/// on lock teardown (MYND-169, SYNC-6). Resolves the app-managed
/// [`AttachmentRefsState`] and wipes its plaintext-derived contents
/// (note-ids / attachment-ids overwritten before free). Wired into EVERY
/// slot-drop site so the graph never outlives the slot: manual
/// `vault_lock`, idle auto-lock teardown, and `vault_delete` — the twin
/// of `vault_indices::zeroize_vault_indices`. Sync + infallible (no
/// `.await`, no IO); a missing managed state is a silent no-op.
pub fn zeroize_attachment_refs<R: Runtime>(app: &AppHandle<R>) {
    if let Some(refs) = app.try_state::<AttachmentRefsState>() {
        refs.clear();
    }
}

/// Construct the `attachments` plugin.
///
/// Binds the IPC commands declared in [`commands`]. Does NOT register
/// `VaultRuntimeState` (the unlock plugin owns the runtime-state
/// singleton; attachments borrows via `tauri::State<...>`) nor the
/// `attachment://` scheme (registered on the `Builder` in `lib.rs`).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("attachments")
        .invoke_handler(tauri::generate_handler![
            commands::attachment_import,
            commands::catalog_list,
            commands::attachment_delete,
            commands::attachment_rename,
            // MYND-173: export one attachment's decrypted bytes to a
            // user-chosen destination (Save As). Type-agnostic — the
            // generic file-card's Export action and the image/PDF Save-As
            // affordance both call it. TB3 user-initiated-egress exception.
            commands::attachment_export,
            // MYND-171: the unused-attachment query behind the "Clean
            // unused attachments" review dialog — catalog entries with zero
            // live note references, computed authoritatively (decrypts every
            // note), fail-closed. Read-only; no mutation.
            commands::attachment_unused_list,
            // MYND-171: the confirm-step batched erase — re-verifies each
            // id is still zero-reference (TOCTOU + fail-closed), then
            // catalog-first rewrite → blob unlinks. Irreversible.
            commands::attachment_clean_unused,
            // MYND-169 SYNC-6: the reconcile IPC surface over the in-RAM
            // attachment reference graph (rebuild-on-unlock + live note
            // lifecycle drive `apply`/`remove`; the library queries
            // `referencing`). Twin of the `vault_indices` command set.
            reconcile_commands::attachment_refs_apply,
            reconcile_commands::attachment_refs_remove,
            reconcile_commands::attachment_refs_referencing,
            // MYND-259 (voice notes): native mic capture → WAV → stored as an
            // ordinary audio/wav attachment. Slot::Unlocked-gated; the in-RAM
            // PCM never crosses IPC (stop encrypts in Rust, returns metadata).
            voice::commands::voice_record_start,
            voice::commands::voice_record_stop,
            voice::commands::voice_record_cancel,
        ])
        .build()
}
