// SPDX-License-Identifier: AGPL-3.0
//! Desktop-only `notes` plugin commands.
//!
//! These commands reach into desktop-only subsystems that do NOT live in
//! `myne-core` — the in-RAM full-text search index (`crate::search`), the
//! per-note snapshot store (`crate::snapshot_store` / `crate::snapshot_policy`),
//! the export-naming helpers (`crate::export_naming`), and the attachments
//! plugin (`crate::plugins::attachments`). The platform-agnostic CRUD core
//! (`note_create` / `note_read` / `note_update` / `note_delete` / `note_list` /
//! `note_titles_batch` / `note_write_batch_transactional`) lives in
//! `myne_core::plugins::notes::commands`; this module hosts:
//!
//! - **export**: `note_export_as_markdown`, `note_export_html`,
//!   `note_export_attachments`, `note_export_html_attachments` (+ their
//!   `_with_root` / `_with_dir` inners and error-kind helpers),
//! - **snapshot flush**: `flush_snapshot_for_note`, `note_snapshot_flush`
//!   (+ `_with_dir`) — the on-close / lock force-flush entry points that reuse
//!   the shared `myne_core::snapshot_store::capture_snapshot_best_effort`
//!   write-path the core `note_update` also reaches via the hooks seam,
//! - **search**: `note_search` (+ `note_search_core`), `SearchResult`,
//! - **attachment-reference scan**: `collect_referenced_attachment_ids` +
//!   `ReferencedScanError` moved to `myne_core::plugins::attachments::ref_scan`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use crate::export_naming::{
    rewrite_embeds_to_final_names, rewrite_html_attachment_srcs, sanitize_export_component,
    suffixed_filename, DEDUP_RETRY_CAP,
};
use crate::io_failure_kind::from_io_error_kind;
use crate::paths;
use crate::search::SearchIndexState;
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Runtime, State};
use zeroize::Zeroizing;

use super::SNAPSHOT_WRITE_FAILED_EVENT;
use crate::plugins::vault_unlock::state::{Slot, VaultRuntimeState};
use myne_core::atomic_write;
// `enumerate_notes_dir` is now consumed only by this module's tests (the
// non-test caller, `collect_referenced_attachment_ids`, moved to
// `myne_core::plugins::attachments::ref_scan`).
#[cfg(test)]
use myne_core::plugins::notes::commands::enumerate_notes_dir;
use myne_core::plugins::notes::error::{
    NoteExportAttachmentsError, NoteExportError, NoteUpdateError,
};
use myne_core::plugins::notes::note_id::NoteId;

/// Export one note's FULL decrypted plaintext — frontmatter included,
/// byte-for-byte verbatim, ZERO post-processing (no newline / BOM /
/// CRLF normalization, no embed rewriting) — to a user-chosen file
/// path (MYND-115). This is a deliberate, user-initiated plaintext
/// egress across TB3: the destination comes from the OS save dialog
/// (`threat-model.md` §3 TB3 egress exception; `decisions.md`
/// 2026-06-11 export-suite entry).
///
/// **Pipeline** (decrypt mirrors the [`note_read`] shape):
/// 1. Strict [`NoteId::parse`] — BEFORE any path use; a malformed id
///    never touches the filesystem.
/// 2. Slot read guard + `Slot::Unlocked(uv)` match (clone `items_key`
///    into `Zeroizing`; `Recovering` structurally rejected). Guard held
///    across `spawn_blocking` for `vault_lock` fair-queueing.
/// 3. `spawn_blocking { dest parent check → std::fs::read →
///    decode_note → UTF-8 boundary → atomic_write_unclobbered }` — the
///    destination write rides the export-destination variant of the
///    canonical temp + sync + rename helper (randomized `create_new`
///    temp name, so a user file at the destination can never be
///    clobbered by the temp — 115-F1); a failed write leaves no temp
///    sibling at the destination.
/// 4. Drop guard, emit `event = "note_exported"`.
///
/// **Overwrite consent travels explicitly:** `overwrite=false` maps the
/// `atomic_write(replace=false)` pre-rename `AlreadyExists` to
/// [`NoteExportError::TargetAlreadyExists`] with the existing target
/// untouched; `overwrite=true` (the OS dialog's "Replace") replaces.
///
/// **Failure mapping** (closed-enum, mirrors [`NoteReadError`] plus the
/// destination pair — see `error.rs` type-level rationale):
/// `InvalidNoteId` / `VaultNotUnlocked` / `NoteNotFound` /
/// `CannotDecrypt` / `InvalidPlaintextEncoding` (corruption is
/// surfaced, never exported as garbage bytes) / `InvalidDestination`
/// (parent missing or not a dir, backup precedent) /
/// `TargetAlreadyExists` / `Io` / `JoinFailure`.
#[tauri::command]
pub async fn note_export_as_markdown<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
    target_path: String,
    overwrite: bool,
) -> Result<(), NoteExportError> {
    let notes_dir = paths::notes_dir_for(&app, state.active_vault_id().await).map_err(|e| {
        // No `NotesDirNotADirectory` variant on the export surface (see
        // `error.rs` type-level rationale) — resolution failures collapse
        // into the residual `Io` (closed `IoFailureKind`, DENY-list-safe).
        let io_kind = from_io_error_kind(e.kind());
        tracing::error!(
            stage = "notes_dir",
            error_kind = "Io",
            io_failure_kind = ?io_kind,
            "note_export notes_dir resolution failed"
        );
        NoteExportError::Io {
            io_error_kind: io_kind,
        }
    })?;
    note_export_with_dir(
        notes_dir,
        state.inner(),
        note_id,
        PathBuf::from(target_path),
        overwrite,
    )
    .await
}

/// Inner — pure-and-testable helper. Mirror of [`note_read_with_dir`];
/// takes `notes_dir` + `target_path` directly so tests exercise the
/// full pipeline (parse → slot guard → decrypt → verbatim atomic write)
/// under a `ScopedTempDir` without spinning up a Tauri runtime.
pub(crate) async fn note_export_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    note_id: String,
    target_path: PathBuf,
    overwrite: bool,
) -> Result<(), NoteExportError> {
    // Strict-parse FIRST — before any path concatenation or fs touch.
    // Sub-cause emits to `tracing::debug!(stage = ?cause)`; IPC sees only
    // the single `InvalidNoteId` variant per `decisions.md` 2026-05-07.
    let note_id = NoteId::parse(&note_id).map_err(|cause| {
        tracing::debug!(stage = ?cause, "note_export note_id strict-parse failed");
        NoteExportError::InvalidNoteId
    })?;
    tracing::debug!(stage = "note_id_parse", outcome = "ok");

    // Slot guard. Held across spawn_blocking so vault_lock waits for the
    // in-flight decrypt via `tokio::sync::RwLock` fair queueing — same
    // load-bearing pattern as `note_read_with_dir`.
    let slot = state.slot_read_active().await;
    let (items_key, items_key_id) = match &*slot {
        Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_export rejected: slot is not Unlocked"
            );
            return Err(NoteExportError::VaultNotUnlocked);
        }
    };
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    let path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
    let note_uuid_bytes = *note_id.as_uuid().as_bytes();

    // Destination check, read, AEAD decrypt, UTF-8 boundary, and the
    // verbatim write all run inside spawn_blocking — same bundling
    // rationale as `note_read_with_dir` (sync fs ops off the runtime
    // thread). The decrypted plaintext stays inside the closure: it goes
    // `Zeroizing<Vec<u8>>` → disk with no intermediate copy and never
    // crosses IPC.
    let started = Instant::now();
    let join_result = tokio::task::spawn_blocking(move || -> Result<(), NoteExportError> {
        // Destination validation per the backup precedent
        // (`backup::commands::export_phase_one`): parent must exist and
        // be a directory. The OS save dialog normally guarantees this;
        // it fires when the directory vanished between confirm and write.
        if !paths::parent_dir_ok(&target_path) {
            tracing::error!(
                stage = "dest_check",
                error_kind = "InvalidDestination",
                "note_export destination parent missing or not a directory"
            );
            return Err(NoteExportError::InvalidDestination);
        }

        let blob = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => {
                let io_kind_raw = e.kind();
                let mapped = match io_kind_raw {
                    std::io::ErrorKind::NotFound => NoteExportError::NoteNotFound,
                    _ => NoteExportError::Io {
                        io_error_kind: from_io_error_kind(io_kind_raw),
                    },
                };
                tracing::error!(
                    stage = "read_blob",
                    error_kind = note_export_error_kind(&mapped),
                    "note_export blob read failed"
                );
                return Err(mapped);
            }
        };
        // `decode_note` parameter order is (blob, note_uuid, items_key,
        // items_key_id) — note_uuid is the SECOND argument. The codec
        // emits its sub-cause via `tracing::debug!` internally; the host
        // adds a parallel non-distinguishing event (`protocol.md` §6.4).
        // Either format (myne-md/myne#432) — a single-note export is the same
        // no-lock-in escape hatch as the whole-vault one, one note at a time.
        let decrypted = myne_core::plugins::notes::decode::decode_note_any(
            &blob,
            &note_uuid_bytes,
            &items_key,
            &items_key_id,
        )
        .map_err(|_| {
            tracing::debug!(
                stage = "decode",
                outcome = "cannot_decrypt",
                "note_export decode returned CannotDecrypt"
            );
            NoteExportError::CannotDecrypt
        })?;
        // UTF-8 boundary at the command layer — mirror of `note_read`'s.
        // Validates in place (no copy); on failure the export writes
        // NOTHING: corruption is surfaced, not exported as a file of
        // garbage bytes claiming to be markdown.
        if std::str::from_utf8(&decrypted).is_err() {
            tracing::error!(
                stage = "utf8_check",
                error_kind = "InvalidPlaintextEncoding",
                "note_export post-AEAD plaintext is not valid UTF-8 — structural corruption suspected"
            );
            return Err(NoteExportError::InvalidPlaintextEncoding);
        }
        // Verbatim byte-for-byte write of the full decrypted plaintext
        // through the export-destination variant of the canonical
        // helper: same durability mechanics, randomized `create_new`
        // temp name, so a pre-existing user file shaped like a temp
        // sibling is never truncated (115-F1). The temp lives at the
        // user-chosen export destination, never inside the vault (TB3
        // egress exception; `src-tauri/CLAUDE.md` "Atomic file
        // writes"). A returned error drops the partial temp on the way
        // out. `replace=false` rejects a pre-existing target BEFORE the
        // temp is created, so the existing file stays untouched.
        if let Err(e) = atomic_write::atomic_write_unclobbered(
            &target_path,
            &decrypted,
            /* replace = */ overwrite,
        ) {
            let mapped = match e.kind() {
                std::io::ErrorKind::AlreadyExists => NoteExportError::TargetAlreadyExists,
                other => NoteExportError::Io {
                    io_error_kind: from_io_error_kind(other),
                },
            };
            tracing::error!(
                stage = "atomic_write",
                error_kind = note_export_error_kind(&mapped),
                "note_export atomic_write failed"
            );
            return Err(mapped);
        }
        // mtime fidelity (SYNC-13): after the atomic rename, stamp the
        // exported file's modified time from the frontmatter `updated:`
        // field. Best-effort and structurally non-fatal — the export
        // already succeeded; absent/unparsable `updated:` keeps the
        // natural export time, and a set failure only warns (see
        // `export_mtime` module docs).
        super::export_mtime::apply_updated_mtime(&target_path, &decrypted);
        // Closure exit: `decrypted` (Zeroizing) drops, plaintext bytes
        // in RAM wipe. The on-disk copy is the user's deliberate egress.
        Ok(())
    })
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match join_result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_export read+decode+write panicked or runtime shutdown"
            );
            return Err(NoteExportError::JoinFailure);
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(())) => {}
    }
    tracing::debug!(
        stage = "export_write",
        duration_ms = duration_ms,
        "note_export decrypt + verbatim atomic write succeeded"
    );

    drop(slot);

    tracing::debug!(stage = "success", event = "note_exported");
    Ok(())
}

/// Export one note as a standalone HTML document (note-export MYND-340)
/// — the no-attachments path. Unlike [`note_export_as_markdown`] (which
/// decrypts the note Rust-side and writes its verbatim plaintext), the
/// HTML projection is composed in the MAIN window (`emitStandaloneHtml`
/// — KaTeX / mermaid / highlight need a real WebView, the PDF-export
/// precedent), so this command receives the ALREADY-COMPOSED `html`
/// document string and writes it byte-for-byte to the user-chosen path
/// via the canonical export-destination atomic write — the deliberate
/// user-initiated plaintext egress across TB3 (the same posture and
/// `atomic_write_unclobbered` 115-F1 anti-clobber discipline as the
/// markdown export; egress sentence rides the OS save dialog title,
/// SYNC-6). Reuses [`NoteExportError`] (the verbatim-write error surface)
/// — the note-decrypt variants (`NoteNotFound` / `CannotDecrypt` /
/// `InvalidPlaintextEncoding` / `InvalidNoteId`) are simply never
/// produced on this string-write path.
///
/// **Overwrite consent travels explicitly:** `overwrite=false` maps the
/// pre-rename `AlreadyExists` to [`NoteExportError::TargetAlreadyExists`]
/// with the existing target untouched; `overwrite=true` (the OS dialog's
/// "Replace") replaces.
#[tauri::command]
pub async fn note_export_html(
    state: State<'_, VaultRuntimeState>,
    html: String,
    target_path: String,
    overwrite: bool,
) -> Result<(), NoteExportError> {
    note_export_text_to_path(state.inner(), html, PathBuf::from(target_path), overwrite).await
}

/// Inner — pure-and-testable helper of [`note_export_html`]. Writes an
/// already-composed text document (the HTML projection) verbatim to
/// `target_path` under the unlocked-slot gate, mirroring
/// [`note_export_with_dir`]'s destination-write discipline without the
/// note-read/decrypt steps (the projection is composed WebView-side).
pub(crate) async fn note_export_text_to_path(
    state: &VaultRuntimeState,
    document: String,
    target_path: PathBuf,
    overwrite: bool,
) -> Result<(), NoteExportError> {
    // Slot gate: export is an unlocked-session operation. The HTML body
    // was composed from a decrypted note, so a locked slot means a
    // routing bug — reject rather than write stale WebView state.
    let slot = state.slot_read_active().await;
    match &*slot {
        Slot::Unlocked(_) => {}
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_export_html rejected: slot is not Unlocked"
            );
            return Err(NoteExportError::VaultNotUnlocked);
        }
    }
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    let document = Zeroizing::new(document);
    let started = Instant::now();
    let join_result = tokio::task::spawn_blocking(move || -> Result<(), NoteExportError> {
        if !paths::parent_dir_ok(&target_path) {
            tracing::error!(
                stage = "dest_check",
                error_kind = "InvalidDestination",
                "note_export_html destination parent missing or not a directory"
            );
            return Err(NoteExportError::InvalidDestination);
        }
        if let Err(e) = atomic_write::atomic_write_unclobbered(
            &target_path,
            document.as_bytes(),
            /* replace = */ overwrite,
        ) {
            let mapped = match e.kind() {
                std::io::ErrorKind::AlreadyExists => NoteExportError::TargetAlreadyExists,
                other => NoteExportError::Io {
                    io_error_kind: from_io_error_kind(other),
                },
            };
            tracing::error!(
                stage = "atomic_write",
                error_kind = note_export_error_kind(&mapped),
                "note_export_html atomic_write failed"
            );
            return Err(mapped);
        }
        Ok(())
    })
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match join_result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_export_html write panicked or runtime shutdown"
            );
            return Err(NoteExportError::JoinFailure);
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(())) => {}
    }
    drop(slot);
    tracing::debug!(
        stage = "export_write",
        duration_ms = duration_ms,
        event = "note_exported",
        "note_export_html verbatim atomic write succeeded"
    );
    Ok(())
}

/// Static-string label for [`NoteExportError`] variants — same
/// drift-detector discipline as [`note_create_error_kind`] /
/// [`note_read_error_kind`]. A new variant compile-fails this match.
fn note_export_error_kind(e: &NoteExportError) -> &'static str {
    match e {
        NoteExportError::VaultNotUnlocked => "VaultNotUnlocked",
        NoteExportError::InvalidNoteId => "InvalidNoteId",
        NoteExportError::NoteNotFound => "NoteNotFound",
        NoteExportError::CannotDecrypt => "CannotDecrypt",
        NoteExportError::InvalidPlaintextEncoding => "InvalidPlaintextEncoding",
        NoteExportError::InvalidDestination => "InvalidDestination",
        NoteExportError::TargetAlreadyExists => "TargetAlreadyExists",
        NoteExportError::Io { .. } => "Io",
        NoteExportError::JoinFailure => "JoinFailure",
    }
}

/// Export one note WITH its referenced attachments, side-by-side, into
/// a user-chosen directory (MYND-115 task 4) — the opt-in
/// attachments-included export and the first attachment-plaintext-to-
/// disk path. Returns the number of attachment files written.
///
/// **One command writes BOTH the note and its attachments** (signature
/// `note_export_attachments(note_id, target_dir, note_filename,
/// overwrite)` rather than a two-command attachments-then-note
/// composition): the note's embeds must be rewritten to the FINAL
/// (collision-suffixed) attachment filenames, so the name map and the
/// note write are one atomic unit of intent — splitting them across two
/// IPC round-trips would force the map through the WebView and invite
/// drift between what landed and what the note references. The UI
/// computes `note_filename` from the OS save dialog; `overwrite`
/// governs the NOTE file only (SYNC-2 — the dialog's "Replace" is the
/// consent source). Attachment files are NEVER overwritten: collisions
/// (with pre-existing files or between attachments) deterministically
/// retry with `" (1)"`, `" (2)"`, … suffixes before the extension.
///
/// **The sanctioned export transform** (`markdown-dialect.md` §6,
/// export side): each canonical form-C embed `![[att:<id>|name]]` in
/// the EXPORTED copy is rewritten to `![[<final-filename>]]` — the
/// inverse of the importer's form-C rewrite (which turns
/// `![[image.png]]` into form C), so import → export → import
/// round-trips. (Refs the importer ingested from markdown-image form
/// `![](img.png)` converge to the wikilink form rather than
/// byte-reverting — convergent, not byte-inverse; dialect §6.) Every byte outside the rewritten embed spans is
/// preserved; a note with no embeds exports byte-verbatim. The vault's
/// stored blob is NEVER modified.
///
/// **All-or-nothing:** every referenced attachment is catalog-resolved
/// and decrypted in memory BEFORE the first byte lands at the
/// destination — a missing/corrupt attachment (or the `overwrite=false`
/// note-target rejection) writes nothing. A residual write-phase IO
/// failure best-effort-removes the files this invocation created.
#[tauri::command]
pub async fn note_export_attachments<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
    target_dir: String,
    note_filename: String,
    overwrite: bool,
) -> Result<usize, NoteExportAttachmentsError> {
    let vault_root =
        paths::active_vault_root_io(&app, state.active_vault_id().await).map_err(|e| {
            let io_kind = from_io_error_kind(e.kind());
            tracing::error!(
                stage = "vault_root",
                error_kind = "Io",
                io_failure_kind = ?io_kind,
                "note_export_attachments vault root resolution failed"
            );
            NoteExportAttachmentsError::Io {
                io_error_kind: io_kind,
            }
        })?;
    note_export_attachments_with_root(
        vault_root,
        state.inner(),
        note_id,
        PathBuf::from(target_dir),
        note_filename,
        overwrite,
    )
    .await
}

/// One decrypted-and-validated attachment held in memory between the
/// pre-write validation pass and the write pass.
struct PendingAttachment {
    /// 64-char lowercase-hex attachment-id (the rewrite-map key).
    id: String,
    /// Sanitized export filename (catalog display name, made path- and
    /// embed-grammar-safe).
    filename: String,
    /// Decrypted file bytes — `Zeroizing`, wiped on drop.
    bytes: zeroize::Zeroizing<Vec<u8>>,
}

/// Inner — pure-and-testable helper of [`note_export_attachments`].
/// Takes the vault root + destination directly so tests exercise the
/// full pipeline under a `ScopedTempDir` without a Tauri runtime.
pub(crate) async fn note_export_attachments_with_root(
    vault_root: PathBuf,
    state: &VaultRuntimeState,
    note_id: String,
    target_dir: PathBuf,
    note_filename: String,
    overwrite: bool,
) -> Result<usize, NoteExportAttachmentsError> {
    // Strict-parse FIRST — before any path concatenation or fs touch
    // (same discipline as `note_export_with_dir`).
    let note_id = NoteId::parse(&note_id).map_err(|cause| {
        tracing::debug!(stage = ?cause, "note_export_attachments note_id strict-parse failed");
        NoteExportAttachmentsError::InvalidNoteId
    })?;
    // Bug-canary: the UI derives `note_filename` from the OS save
    // dialog's final path component — anything traversal-shaped is a
    // frontend regression, rejected (never sanitized) host-side.
    if note_filename.is_empty()
        || note_filename == "."
        || note_filename == ".."
        || note_filename
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        tracing::error!(
            stage = "note_filename_check",
            error_kind = "InvalidNoteFilename",
            "note_export_attachments rejected a non-bare note filename"
        );
        return Err(NoteExportAttachmentsError::InvalidNoteFilename);
    }
    tracing::debug!(stage = "note_id_parse", outcome = "ok");

    // Slot guard — note decrypt needs `items_key`; the catalog KEK
    // derivation needs `root_key`. `hold_unlocked_attachment_material`
    // clones all three out of `Slot::Unlocked` under the read guard,
    // which is held across `spawn_blocking` for `vault_lock` fair
    // queueing (the `note_read` / `attachment_import` pattern).
    let Some((slot_guard, items_key, items_key_id, root_key)) =
        state.hold_unlocked_attachment_material().await
    else {
        tracing::debug!(
            stage = "slot_check",
            outcome = "vault_locked",
            "note_export_attachments rejected: slot is not Unlocked"
        );
        return Err(NoteExportAttachmentsError::VaultNotUnlocked);
    };
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    let note_uuid_bytes = *note_id.as_uuid().as_bytes();

    let started = Instant::now();
    let join_result =
        tokio::task::spawn_blocking(move || -> Result<usize, NoteExportAttachmentsError> {
            // (1) Destination validation — the directory the OS dialog
            //     produced must still exist.
            if !target_dir.is_dir() {
                tracing::error!(
                    stage = "dest_check",
                    error_kind = "InvalidDestination",
                    "note_export_attachments destination missing or not a directory"
                );
                return Err(NoteExportAttachmentsError::InvalidDestination);
            }

            // (2) Read + decrypt + UTF-8-check the NOTE (mirror of
            //     `note_export_with_dir`).
            let note_path = vault_root
                .join("notes")
                .join(format!("{}.myn", uuid::Uuid::from_bytes(note_uuid_bytes)));
            let blob = match std::fs::read(&note_path) {
                Ok(bytes) => bytes,
                Err(e) => {
                    let mapped = match e.kind() {
                        std::io::ErrorKind::NotFound => NoteExportAttachmentsError::NoteNotFound,
                        other => NoteExportAttachmentsError::Io {
                            io_error_kind: from_io_error_kind(other),
                        },
                    };
                    tracing::error!(
                        stage = "read_blob",
                        error_kind = note_export_attachments_error_kind(&mapped),
                        "note_export_attachments note blob read failed"
                    );
                    return Err(mapped);
                }
            };
            let decrypted = myne_core::plugins::notes::decode::decode_note_any(
                &blob,
                &note_uuid_bytes,
                &items_key,
                &items_key_id,
            )
            .map_err(|_| {
                tracing::debug!(
                    stage = "decode",
                    outcome = "cannot_decrypt",
                    "note_export_attachments decode returned CannotDecrypt"
                );
                NoteExportAttachmentsError::CannotDecrypt
            })?;
            let Ok(plaintext) = std::str::from_utf8(&decrypted) else {
                tracing::error!(
                    stage = "utf8_check",
                    error_kind = "InvalidPlaintextEncoding",
                    "note_export_attachments post-AEAD plaintext is not valid UTF-8"
                );
                return Err(NoteExportAttachmentsError::InvalidPlaintextEncoding);
            };

            // (3) Locate the canonical form-C embeds (document order) and
            //     reduce to unique ids by FIRST appearance — the
            //     deterministic processing/naming order.
            let spans = crate::plugins::attachments::reconcile::extract_att_embed_spans(plaintext);
            let mut unique_ids: Vec<&str> = Vec::new();
            {
                let mut seen = std::collections::HashSet::new();
                for span in &spans {
                    if seen.insert(span.id) {
                        unique_ids.push(span.id);
                    }
                }
            }

            // (4) Pre-write validation pass: catalog-resolve AND decrypt
            //     EVERY referenced attachment in memory before any write —
            //     the all-or-nothing gate (a missing/corrupt attachment
            //     fails the export with the destination untouched). Skipped
            //     entirely when the note has no embeds (no vault.meta /
            //     catalog read on that path).
            let mut pending: Vec<PendingAttachment> = Vec::with_capacity(unique_ids.len());
            if !unique_ids.is_empty() {
                use crate::plugins::attachments::blocking_reads::load_catalog_for_export;
                use crate::plugins::attachments::commands::{hex_decode_id, CatalogLoadError};
                let catalog =
                    load_catalog_for_export(&vault_root, &root_key).map_err(|e| match e {
                        CatalogLoadError::InvalidVaultMeta => {
                            tracing::error!(
                                stage = "read_meta",
                                error_kind = "InvalidVaultMeta",
                                "note_export_attachments vault.meta parse failed"
                            );
                            NoteExportAttachmentsError::InvalidVaultMeta
                        }
                        CatalogLoadError::MetaIo(io_kind) => {
                            tracing::error!(
                                stage = "read_meta",
                                error_kind = "Io",
                                io_failure_kind = ?io_kind,
                                "note_export_attachments vault.meta read failed"
                            );
                            NoteExportAttachmentsError::Io {
                                io_error_kind: io_kind,
                            }
                        }
                        CatalogLoadError::CatalogIo(io_kind) => {
                            tracing::error!(
                                stage = "read_catalog",
                                error_kind = "Io",
                                io_failure_kind = ?io_kind,
                                "note_export_attachments catalog read failed"
                            );
                            NoteExportAttachmentsError::Io {
                                io_error_kind: io_kind,
                            }
                        }
                    })?;

                for id_hex in &unique_ids {
                    let Some(meta) = catalog.entries.get(*id_hex) else {
                        tracing::error!(
                            stage = "catalog_lookup",
                            error_kind = "AttachmentMissing",
                            "note_export_attachments referenced id absent from catalog"
                        );
                        return Err(NoteExportAttachmentsError::AttachmentMissing);
                    };
                    // The span scanner only yields 64-lowercase-hex ids, so
                    // this decode is structurally infallible; the defensive
                    // mapping keeps the closed surface if that ever drifts.
                    let Some(id_bytes) = hex_decode_id(id_hex) else {
                        return Err(NoteExportAttachmentsError::AttachmentMissing);
                    };
                    let blob = match std::fs::read(vault_root.join("attachments").join(id_hex)) {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            let mapped = match e.kind() {
                                std::io::ErrorKind::NotFound => {
                                    NoteExportAttachmentsError::AttachmentMissing
                                }
                                other => NoteExportAttachmentsError::Io {
                                    io_error_kind: from_io_error_kind(other),
                                },
                            };
                            tracing::error!(
                                stage = "read_attachment_blob",
                                error_kind = note_export_attachments_error_kind(&mapped),
                                "note_export_attachments attachment blob read failed"
                            );
                            return Err(mapped);
                        }
                    };
                    let bytes = protocol::decode_attachment_blob(
                        &blob,
                        &id_bytes,
                        meta.content_type.as_bytes(),
                        &items_key,
                        &items_key_id,
                    )
                    .map_err(|_| {
                        tracing::error!(
                            stage = "decode_attachment",
                            error_kind = "AttachmentCorrupt",
                            "note_export_attachments attachment blob failed to decrypt"
                        );
                        NoteExportAttachmentsError::AttachmentCorrupt
                    })?;
                    pending.push(PendingAttachment {
                        id: (*id_hex).to_string(),
                        filename: sanitize_export_component(&meta.filename, "attachment"),
                        bytes,
                    });
                }
            }

            // (5) Note-target overwrite pre-check (SYNC-2) — BEFORE any
            //     write, so `overwrite=false` + existing note file rejects
            //     with the destination untouched. (The final
            //     `atomic_write(replace=overwrite)` still guards the race.)
            let note_target = target_dir.join(&note_filename);
            if !overwrite && note_target.exists() {
                tracing::debug!(
                    stage = "note_target_check",
                    error_kind = "TargetAlreadyExists",
                    "note_export_attachments note target exists and overwrite consent is absent"
                );
                return Err(NoteExportAttachmentsError::TargetAlreadyExists);
            }

            // (6) Write the attachments with deterministic suffix-dedup.
            //     `atomic_write_unclobbered(replace=false)` is the collision
            //     oracle for PRE-EXISTING files; `assigned` covers names
            //     taken earlier in this run plus the note's own filename
            //     (so an attachment can never occupy the name the note is
            //     about to take — `replace=overwrite` on the note write
            //     would otherwise clobber it). The unclobbered variant's
            //     randomized `create_new` temps also make the temp-vs-
            //     final-name collision structurally impossible (115-F1
            //     variant 2: an attachment finally named `x.png.tmp`
            //     written before its `x.png` sibling used to be destroyed
            //     by the later write's fixed-name temp).
            let mut written: Vec<PathBuf> = Vec::new();
            let mut final_names: std::collections::HashMap<String, String> =
                std::collections::HashMap::with_capacity(pending.len());
            let mut assigned: std::collections::HashSet<String> = std::collections::HashSet::new();
            assigned.insert(note_filename.clone());
            for p in &pending {
                let mut n: u32 = 0;
                let final_name = loop {
                    if n > DEDUP_RETRY_CAP {
                        // Pathological collision flood — bail closed.
                        rollback_written_exports(&written);
                        tracing::error!(
                            stage = "attachment_write",
                            error_kind = "Io",
                            "note_export_attachments exceeded the suffix-dedup retry cap"
                        );
                        return Err(NoteExportAttachmentsError::Io {
                            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
                        });
                    }
                    let candidate = if n == 0 {
                        p.filename.clone()
                    } else {
                        suffixed_filename(&p.filename, n)
                    };
                    if assigned.contains(&candidate) {
                        n += 1;
                        continue;
                    }
                    match atomic_write::atomic_write_unclobbered(
                        &target_dir.join(&candidate),
                        &p.bytes,
                        /* replace = */ false,
                    ) {
                        Ok(()) => break candidate,
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
                        Err(e) => {
                            rollback_written_exports(&written);
                            let io_kind = from_io_error_kind(e.kind());
                            tracing::error!(
                                stage = "attachment_write",
                                error_kind = "Io",
                                io_failure_kind = ?io_kind,
                                "note_export_attachments attachment write failed"
                            );
                            return Err(NoteExportAttachmentsError::Io {
                                io_error_kind: io_kind,
                            });
                        }
                    }
                };
                written.push(target_dir.join(&final_name));
                assigned.insert(final_name.clone());
                final_names.insert(p.id.clone(), final_name);
            }

            // (7) The sanctioned export transform: splice each embed span
            //     to `![[<final-filename>]]` (inverse of the importer's
            //     rewrite); every byte outside the spans is preserved. With
            //     no spans this reproduces the plaintext byte-for-byte.
            let rewritten = zeroize::Zeroizing::new(rewrite_embeds_to_final_names(
                plaintext,
                &spans,
                &final_names,
            ));
            if let Err(e) = atomic_write::atomic_write_unclobbered(
                &note_target,
                rewritten.as_bytes(),
                /* replace = */ overwrite,
            ) {
                rollback_written_exports(&written);
                let mapped = match e.kind() {
                    std::io::ErrorKind::AlreadyExists => {
                        NoteExportAttachmentsError::TargetAlreadyExists
                    }
                    other => NoteExportAttachmentsError::Io {
                        io_error_kind: from_io_error_kind(other),
                    },
                };
                tracing::error!(
                    stage = "note_write",
                    error_kind = note_export_attachments_error_kind(&mapped),
                    "note_export_attachments note write failed"
                );
                return Err(mapped);
            }

            // (8) mtime fidelity (SYNC-13) — the FM block is untouched by
            //     the embed rewrite, so the rewritten bytes carry the same
            //     `updated:`. Best-effort, structurally non-fatal.
            super::export_mtime::apply_updated_mtime(&note_target, rewritten.as_bytes());

            // Closure exit: `decrypted`, `pending` bytes, and `rewritten`
            // (all Zeroizing) drop and wipe. The on-disk copies are the
            // user's deliberate egress.
            Ok(written.len())
        })
        .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    let attachment_count = match join_result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_export_attachments worker panicked or runtime shutdown"
            );
            return Err(NoteExportAttachmentsError::JoinFailure);
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(count)) => count,
    };
    drop(slot_guard);

    // Counts-only success event — no path, no note_id, no filenames.
    tracing::debug!(
        stage = "success",
        event = "note_exported_with_attachments",
        attachment_count = attachment_count,
        duration_ms = duration_ms,
    );
    Ok(attachment_count)
}

/// Export one note as a standalone HTML document WITH its image
/// attachments as relative sidecar files (note-export MYND-340 task 3)
/// — the HTML projection's arm of the opt-in attachments-included
/// export, mirroring [`note_export_attachments`] exactly (catalog
/// resolution, per-attachment decrypt, deterministic suffix-dedup,
/// all-or-nothing, best-effort rollback) and differing only in the
/// artifact: it writes the COMPOSED HTML document (passed from the main
/// window, the PDF-export precedent) with each `attachment://<id>`
/// `<img src>` rewritten to its final relative sidecar filename — the
/// HTML arm of the `markdown-dialect.md` §6 sanctioned export transform
/// (no new §6 entry; HTML joins the existing inverse-of-MYND-52 class).
///
/// Only the attachments the COMPOSED HTML actually references
/// (`attachment://<id>` — the emitter inlines image embeds as `<img>`,
/// while non-image embeds render as in-document placeholders, never
/// `attachment://`) are resolved and written, so every sidecar is
/// referenced and the §6 remap covers every written file. The note's
/// stored blob is never modified.
///
/// `note_filename` is the bare `.html` filename from the OS save dialog;
/// `overwrite` governs the HTML file only (the dialog's "Replace"
/// consent, SYNC-2). Returns the number of sidecar files written. Shares
/// the [`NoteExportAttachmentsError`] surface (identical failure modes).
#[tauri::command]
pub async fn note_export_html_attachments<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
    html: String,
    target_dir: String,
    note_filename: String,
    overwrite: bool,
) -> Result<usize, NoteExportAttachmentsError> {
    let vault_root =
        paths::active_vault_root_io(&app, state.active_vault_id().await).map_err(|e| {
            let io_kind = from_io_error_kind(e.kind());
            tracing::error!(
                stage = "vault_root",
                error_kind = "Io",
                io_failure_kind = ?io_kind,
                "note_export_html_attachments vault root resolution failed"
            );
            NoteExportAttachmentsError::Io {
                io_error_kind: io_kind,
            }
        })?;
    note_export_html_attachments_with_root(
        vault_root,
        state.inner(),
        note_id,
        html,
        PathBuf::from(target_dir),
        note_filename,
        overwrite,
    )
    .await
}

/// The lowercase-hex `attachment://<id>` ids referenced in a composed
/// HTML document, in FIRST-appearance order (the deterministic
/// naming/dedup order, mirroring the markdown export's document-order
/// span scan). Only 64-char lowercase-hex runs are accepted — the exact
/// shape the export emitter writes (`canonicalAttachmentUrl(id)`; the
/// platform-aware runtime form never reaches this scan — MYND-519).
fn html_referenced_attachment_ids(html: &str) -> Vec<String> {
    const PREFIX: &str = "attachment://";
    let mut ids: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut rest = html;
    while let Some(pos) = rest.find(PREFIX) {
        let after = &rest[pos + PREFIX.len()..];
        let run: String = after
            .chars()
            .take_while(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            .collect();
        if run.len() == 64 && seen.insert(run.clone()) {
            ids.push(run);
        }
        // Advance past one CHARACTER of the trailer, not one byte (myne#306).
        //
        // The loop has to move to avoid spinning on a malformed (non-hex)
        // `attachment://` occurrence, and it used to do that with `&after[1..]`.
        // `after` begins on a char boundary — the prefix is ASCII — but the
        // character there need not be one byte, and slicing mid-character
        // panics. A note that merely CONTAINS the text `attachment://` followed
        // by any non-ASCII character (`attachment://…`, `attachment://画像`)
        // therefore killed the whole HTML-with-images export: the panic became a
        // `JoinFailure` whose message says "try again", and every retry failed
        // the same way. The plain-HTML arm never reaches this scanner, so the
        // note exported fine one way and never the other.
        //
        // `char_indices().nth(1)` is the boundary-safe step, and it is what the
        // twin this comment used to claim parity with already had by accident
        // (`export_naming::rewrite_html_attachment_srcs` advances by a count of
        // ASCII hex digits). `None` means `after` held at most one character, so
        // there is nothing left to scan.
        rest = after
            .char_indices()
            .nth(1)
            .map_or("", |(byte_idx, _)| &after[byte_idx..]);
    }
    ids
}

/// Inner — pure-and-testable helper of [`note_export_html_attachments`].
/// Takes the vault root + destination directly so tests exercise the
/// full pipeline under a `ScopedTempDir` without a Tauri runtime
/// (mirror of [`note_export_attachments_with_root`]).
pub(crate) async fn note_export_html_attachments_with_root(
    vault_root: PathBuf,
    state: &VaultRuntimeState,
    note_id: String,
    html: String,
    target_dir: PathBuf,
    note_filename: String,
    overwrite: bool,
) -> Result<usize, NoteExportAttachmentsError> {
    let note_id = NoteId::parse(&note_id).map_err(|cause| {
        tracing::debug!(stage = ?cause, "note_export_html_attachments note_id strict-parse failed");
        NoteExportAttachmentsError::InvalidNoteId
    })?;
    // Bug-canary: `note_filename` is the OS save dialog's final path
    // component — anything traversal-shaped is a frontend regression.
    if note_filename.is_empty()
        || note_filename == "."
        || note_filename == ".."
        || note_filename
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        tracing::error!(
            stage = "note_filename_check",
            error_kind = "InvalidNoteFilename",
            "note_export_html_attachments rejected a non-bare note filename"
        );
        return Err(NoteExportAttachmentsError::InvalidNoteFilename);
    }

    // Slot guard — the catalog KEK derivation needs `root_key`, the
    // attachment decrypt needs `items_key` (the markdown sibling's
    // pattern). The NOTE itself is NOT re-read here: the HTML body was
    // composed WebView-side and carries the only refs we honor.
    let Some((slot_guard, items_key, items_key_id, root_key)) =
        state.hold_unlocked_attachment_material().await
    else {
        tracing::debug!(
            stage = "slot_check",
            outcome = "vault_locked",
            "note_export_html_attachments rejected: slot is not Unlocked"
        );
        return Err(NoteExportAttachmentsError::VaultNotUnlocked);
    };
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    let _ = note_id; // strict-parsed as a bug-canary; the HTML carries the refs.
    let html = Zeroizing::new(html);
    let started = Instant::now();
    let join_result =
        tokio::task::spawn_blocking(move || -> Result<usize, NoteExportAttachmentsError> {
            // (1) Destination validation.
            if !target_dir.is_dir() {
                tracing::error!(
                    stage = "dest_check",
                    error_kind = "InvalidDestination",
                    "note_export_html_attachments destination missing or not a directory"
                );
                return Err(NoteExportAttachmentsError::InvalidDestination);
            }

            // (2) The image attachments the COMPOSED HTML references, in
            //     document order (the deterministic naming order).
            let unique_ids = html_referenced_attachment_ids(&html);

            // (3) Pre-write validation: catalog-resolve AND decrypt EVERY
            //     referenced image in memory before any write (all-or-
            //     nothing). Skipped when the HTML references none.
            let mut pending: Vec<PendingAttachment> = Vec::with_capacity(unique_ids.len());
            if !unique_ids.is_empty() {
                use crate::plugins::attachments::blocking_reads::load_catalog_for_export;
                use crate::plugins::attachments::commands::{hex_decode_id, CatalogLoadError};
                let catalog =
                    load_catalog_for_export(&vault_root, &root_key).map_err(|e| match e {
                        CatalogLoadError::InvalidVaultMeta => {
                            tracing::error!(
                                stage = "read_meta",
                                error_kind = "InvalidVaultMeta",
                                "note_export_html_attachments vault.meta parse failed"
                            );
                            NoteExportAttachmentsError::InvalidVaultMeta
                        }
                        CatalogLoadError::MetaIo(io_kind) => {
                            tracing::error!(
                                stage = "read_meta",
                                error_kind = "Io",
                                io_failure_kind = ?io_kind,
                                "note_export_html_attachments vault.meta read failed"
                            );
                            NoteExportAttachmentsError::Io {
                                io_error_kind: io_kind,
                            }
                        }
                        CatalogLoadError::CatalogIo(io_kind) => {
                            tracing::error!(
                                stage = "read_catalog",
                                error_kind = "Io",
                                io_failure_kind = ?io_kind,
                                "note_export_html_attachments catalog read failed"
                            );
                            NoteExportAttachmentsError::Io {
                                io_error_kind: io_kind,
                            }
                        }
                    })?;

                for id_hex in &unique_ids {
                    let Some(meta) = catalog.entries.get(id_hex) else {
                        tracing::error!(
                            stage = "catalog_lookup",
                            error_kind = "AttachmentMissing",
                            "note_export_html_attachments referenced id absent from catalog"
                        );
                        return Err(NoteExportAttachmentsError::AttachmentMissing);
                    };
                    let Some(id_bytes) = hex_decode_id(id_hex) else {
                        return Err(NoteExportAttachmentsError::AttachmentMissing);
                    };
                    let blob = match std::fs::read(vault_root.join("attachments").join(id_hex)) {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            let mapped = match e.kind() {
                                std::io::ErrorKind::NotFound => {
                                    NoteExportAttachmentsError::AttachmentMissing
                                }
                                other => NoteExportAttachmentsError::Io {
                                    io_error_kind: from_io_error_kind(other),
                                },
                            };
                            tracing::error!(
                                stage = "read_attachment_blob",
                                error_kind = note_export_attachments_error_kind(&mapped),
                                "note_export_html_attachments attachment blob read failed"
                            );
                            return Err(mapped);
                        }
                    };
                    let bytes = protocol::decode_attachment_blob(
                        &blob,
                        &id_bytes,
                        meta.content_type.as_bytes(),
                        &items_key,
                        &items_key_id,
                    )
                    .map_err(|_| {
                        tracing::error!(
                            stage = "decode_attachment",
                            error_kind = "AttachmentCorrupt",
                            "note_export_html_attachments attachment blob failed to decrypt"
                        );
                        NoteExportAttachmentsError::AttachmentCorrupt
                    })?;
                    pending.push(PendingAttachment {
                        id: id_hex.clone(),
                        filename: sanitize_export_component(&meta.filename, "attachment"),
                        bytes,
                    });
                }
            }

            // (4) HTML-target overwrite pre-check (SYNC-2).
            let note_target = target_dir.join(&note_filename);
            if !overwrite && note_target.exists() {
                tracing::debug!(
                    stage = "note_target_check",
                    error_kind = "TargetAlreadyExists",
                    "note_export_html_attachments HTML target exists and overwrite consent is absent"
                );
                return Err(NoteExportAttachmentsError::TargetAlreadyExists);
            }

            // (5) Write the sidecars with deterministic suffix-dedup —
            //     byte-identical loop to the markdown sibling (the HTML
            //     filename is reserved in `assigned` so no sidecar can
            //     take the name the .html is about to take).
            let mut written: Vec<PathBuf> = Vec::new();
            let mut final_names: std::collections::HashMap<String, String> =
                std::collections::HashMap::with_capacity(pending.len());
            let mut assigned: std::collections::HashSet<String> = std::collections::HashSet::new();
            assigned.insert(note_filename.clone());
            for p in &pending {
                let mut n: u32 = 0;
                let final_name = loop {
                    if n > DEDUP_RETRY_CAP {
                        rollback_written_exports(&written);
                        tracing::error!(
                            stage = "attachment_write",
                            error_kind = "Io",
                            "note_export_html_attachments exceeded the suffix-dedup retry cap"
                        );
                        return Err(NoteExportAttachmentsError::Io {
                            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
                        });
                    }
                    let candidate = if n == 0 {
                        p.filename.clone()
                    } else {
                        suffixed_filename(&p.filename, n)
                    };
                    if assigned.contains(&candidate) {
                        n += 1;
                        continue;
                    }
                    match atomic_write::atomic_write_unclobbered(
                        &target_dir.join(&candidate),
                        &p.bytes,
                        /* replace = */ false,
                    ) {
                        Ok(()) => break candidate,
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
                        Err(e) => {
                            rollback_written_exports(&written);
                            let io_kind = from_io_error_kind(e.kind());
                            tracing::error!(
                                stage = "attachment_write",
                                error_kind = "Io",
                                io_failure_kind = ?io_kind,
                                "note_export_html_attachments attachment write failed"
                            );
                            return Err(NoteExportAttachmentsError::Io {
                                io_error_kind: io_kind,
                            });
                        }
                    }
                };
                written.push(target_dir.join(&final_name));
                assigned.insert(final_name.clone());
                final_names.insert(p.id.clone(), final_name);
            }

            // (6) The §6 export transform (HTML arm): rewrite each
            //     `attachment://<id>` src to the final relative filename.
            let rewritten = Zeroizing::new(rewrite_html_attachment_srcs(&html, &final_names));
            if let Err(e) = atomic_write::atomic_write_unclobbered(
                &note_target,
                rewritten.as_bytes(),
                /* replace = */ overwrite,
            ) {
                rollback_written_exports(&written);
                let mapped = match e.kind() {
                    std::io::ErrorKind::AlreadyExists => {
                        NoteExportAttachmentsError::TargetAlreadyExists
                    }
                    other => NoteExportAttachmentsError::Io {
                        io_error_kind: from_io_error_kind(other),
                    },
                };
                tracing::error!(
                    stage = "note_write",
                    error_kind = note_export_attachments_error_kind(&mapped),
                    "note_export_html_attachments HTML write failed"
                );
                return Err(mapped);
            }

            // Closure exit: `html`, `pending` bytes, `rewritten` (all
            // Zeroizing) drop and wipe. The on-disk copies are the user's
            // deliberate egress.
            Ok(written.len())
        })
        .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    let attachment_count = match join_result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_export_html_attachments worker panicked or runtime shutdown"
            );
            return Err(NoteExportAttachmentsError::JoinFailure);
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(count)) => count,
    };
    drop(slot_guard);

    tracing::debug!(
        stage = "success",
        event = "note_exported_html_with_attachments",
        attachment_count = attachment_count,
        duration_ms = duration_ms,
    );
    Ok(attachment_count)
}

/// Best-effort rollback of the attachment files THIS invocation
/// created (never pre-existing ones — only paths that came out of a
/// successful `atomic_write(replace=false)` above). Unlink failures
/// only warn: the export is already failing with the real error.
fn rollback_written_exports(written: &[PathBuf]) {
    for path in written {
        if let Err(e) = std::fs::remove_file(path) {
            let io_kind = from_io_error_kind(e.kind());
            tracing::warn!(
                stage = "export_rollback",
                io_failure_kind = ?io_kind,
                "note_export_attachments rollback unlink failed (best-effort)"
            );
        }
    }
}

/// Static-string label for [`NoteExportAttachmentsError`] variants —
/// same drift-detector discipline as [`note_export_error_kind`].
fn note_export_attachments_error_kind(e: &NoteExportAttachmentsError) -> &'static str {
    match e {
        NoteExportAttachmentsError::VaultNotUnlocked => "VaultNotUnlocked",
        NoteExportAttachmentsError::InvalidNoteId => "InvalidNoteId",
        NoteExportAttachmentsError::InvalidNoteFilename => "InvalidNoteFilename",
        NoteExportAttachmentsError::NoteNotFound => "NoteNotFound",
        NoteExportAttachmentsError::CannotDecrypt => "CannotDecrypt",
        NoteExportAttachmentsError::InvalidPlaintextEncoding => "InvalidPlaintextEncoding",
        NoteExportAttachmentsError::InvalidVaultMeta => "InvalidVaultMeta",
        NoteExportAttachmentsError::InvalidDestination => "InvalidDestination",
        NoteExportAttachmentsError::TargetAlreadyExists => "TargetAlreadyExists",
        NoteExportAttachmentsError::AttachmentMissing => "AttachmentMissing",
        NoteExportAttachmentsError::AttachmentCorrupt => "AttachmentCorrupt",
        NoteExportAttachmentsError::Io { .. } => "Io",
        NoteExportAttachmentsError::JoinFailure => "JoinFailure",
    }
}

/// Force-capture a snapshot of a note's CURRENT on-disk `.myn` (MYND-96
/// on-close / vault-lock flush, SYNC-3). Unlike the `note_update` hook (which
/// snapshots the OLD pre-overwrite content, gated by the window), this is the
/// **force** entry point: it bypasses the coalescing gate so the last active
/// state is recorded when an editor closes or the vault locks. Best-effort —
/// returns the snapshot-failed warning bool. A missing `.myn` is a no-op
/// (returns `false`). Reuses `capture_snapshot_best_effort`, so it shares the
/// same atomic-write + durability + eager-prune path.
fn flush_snapshot_for_note(notes_dir: &std::path::Path, note_uuid: &str, now_ms: u64) -> bool {
    let path = notes_dir.join(format!("{note_uuid}.myn"));
    let blob = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return false, // nothing on disk to flush
    };
    match notes_dir.parent() {
        Some(vault_root) => myne_core::snapshot_store::capture_snapshot_best_effort(
            vault_root, note_uuid, &blob, now_ms, /* force = */ true,
        ),
        None => true,
    }
}

/// Inner, testable core of [`note_snapshot_flush`]. Returns the snapshot-failed
/// warning bool (the #[command] wrapper turns it into a non-blocking event).
pub(crate) async fn note_snapshot_flush_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    note_id: String,
) -> Result<bool, NoteUpdateError> {
    let note_id = NoteId::parse(&note_id).map_err(|cause| {
        tracing::debug!(stage = ?cause, "note_snapshot_flush note_id strict-parse failed");
        NoteUpdateError::InvalidNoteId
    })?;

    // Slot read guard held across spawn_blocking — same fair-queue discipline as
    // note_update. Flush copies the sealed `.myn` verbatim, so it needs no
    // `items_key` clone (no decryption).
    let slot = state.slot_read_active().await;
    match &*slot {
        Slot::Unlocked(_) => {}
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            return Err(NoteUpdateError::VaultNotUnlocked);
        }
    }

    let note_uuid_str = note_id.as_uuid().to_string();
    let now_ms = crate::snapshot_store::now_unix_ms();
    let warning = tokio::task::spawn_blocking(move || {
        flush_snapshot_for_note(&notes_dir, &note_uuid_str, now_ms)
    })
    .await
    .map_err(|_| NoteUpdateError::JoinFailure)?;

    drop(slot);
    Ok(warning)
}

/// `note_snapshot_flush` — force-capture a snapshot of the open note's current
/// state, bypassing the coalescing window (MYND-96, SYNC-3). Best-effort: a
/// snapshot failure surfaces the non-blocking `snapshot://write-failed` event;
/// the IPC return stays `Result<(), NoteUpdateError>`.
///
/// **No production caller (myne#389 item B).** This doc used to say "the
/// frontend calls this from its close/lock flush path (paired with the autosave
/// flush-on-blur/close already in place)", which was not true and is the kind of
/// claim that costs a reviewer an hour: `src/lib/flush-chain.ts` is the single
/// shared close/lock flush path and enumerates its writers, and this is not
/// among them. The only invokers are three E2E files
/// (`snapshots-restore.e2e.ts`, `version-diff.e2e.ts`,
/// `capture/userguide.capture.ts`), which reach it through the production ACL
/// from the page seat.
///
/// **The grant is kept deliberately, and that is a decision rather than an
/// oversight.** Moving it to a test-only seat is possible — the shape exists
/// (`permissions/pdf-export/default.toml`'s second `[[set]]`, and the
/// runtime `app.add_capability` in `plugins::local_inference`) — but it would
/// mean the E2E suite exercising a DIFFERENT capability set than the shipped
/// binary, and the capability set is precisely the thing those scenarios are
/// there to exercise. The command itself is a weak primitive to hold: it writes
/// an encrypted snapshot of a note the caller already has open, behind the
/// `Slot::Unlocked` gate — no read, no egress, no delete.
///
/// **What is genuinely unresolved** is whether the close/lock flush was meant
/// to call this at all. If it was, the step belongs in `FlushChainSteps`
/// *after* `flushAll` — a snapshot of an unflushed body is a snapshot of the
/// wrong bytes — and that is a behaviour change with its own issue, not a
/// silent addition here.
#[tauri::command]
pub async fn note_snapshot_flush<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
) -> Result<(), NoteUpdateError> {
    let notes_dir =
        paths::notes_dir_for(&app, state.active_vault_id().await).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
                NoteUpdateError::NotesDirNotADirectory
            }
            other => NoteUpdateError::Io {
                io_error_kind: from_io_error_kind(other),
            },
        })?;
    let warning = note_snapshot_flush_with_dir(notes_dir, state.inner(), note_id.clone()).await?;
    if warning {
        let _ = app.emit(SNAPSHOT_WRITE_FAILED_EVENT, &note_id);
    }
    Ok(())
}

// The authoritative attachment-reference scan (`collect_referenced_attachment_ids`
// + `ReferencedScanError`) moved to `myne_core::plugins::attachments::ref_scan`
// alongside the `attachment_unused_list` / `attachment_clean_unused` cores that
// consume it (shared desktop↔mobile). It depends only on `protocol::decode_note`,
// the core note enumerator, and the shared embed tokenizer.

/// `note_search` — `Slot::Unlocked`-gated full-text search over the live
/// in-RAM index. The IPC wrapper only; the ranking core is shared.
#[tauri::command]
pub async fn note_search(
    state: tauri::State<'_, VaultRuntimeState>,
    search: tauri::State<'_, SearchIndexState>,
    query: String,
) -> Result<Vec<SearchResult>, ()> {
    // Infallible in practice (the gate yields an empty vec, not an error, when
    // not unlocked; `query` is infallible). The `Result` is only here because
    // Tauri requires reference-taking async commands to return one; the `Err`
    // arm is never produced.
    Ok(note_search_core(state.inner(), search.inner(), &query).await)
}

// The search result shape, the cap and the ranking core moved to
// `myne_core::plugins::notes::search_sync_core` with the index lifecycle
// (phase3-web-client tasks 14 + 83) — none of it is desktop-specific, and a web
// client with a populated index and no way to query it would have been the
// obvious half of the port to leave behind. Re-exported so the `#[tauri::command]`
// wrapper below and every existing consumer keep their paths.
pub use myne_core::plugins::notes::search_sync_core::{note_search_core, SearchResult};
// Read only by the cap test below; the production cap lives in the core.
#[cfg(test)]
use myne_core::plugins::notes::search_sync_core::NOTE_SEARCH_RESULT_CAP;

#[cfg(test)]
mod tests {
    // Desktop-only commands under test (export / search / snapshot flush /
    // attachment-reference scan) come from the enclosing module.
    use super::*;
    // The platform-agnostic CRUD core these tests also exercise lives in
    // `myne-core`; pull in its commands + identifier + title helpers + types.
    use myne_core::plugins::notes::commands::*;
    use myne_core::plugins::notes::error::*;
    use myne_core::plugins::notes::note_id::NoteId;
    // `crate::paths` / `crate::test_support` / `crate::io_failure_kind` are
    // re-exports of the matching `myne-core` modules, so the original `crate::`
    // paths keep resolving in the desktop crate.
    use crate::paths::notes_dir_under;
    use crate::plugins::vault_unlock::state::{
        fixture_recovering_with_keys, fixture_unlocked_with_keys, test_vault_id, test_vault_id_b,
        VaultRuntimeState,
    };
    use crate::test_support::ScopedTempDir;
    use std::path::Path;

    /// A `Hooks` whose snapshot-capture / -purge methods delegate to the REAL
    /// desktop snapshot store (exactly what `DesktopHooks` does), with every
    /// other hook inert. Several tests in this module exercise the snapshot
    /// side-effect that `note_update_with_dir` / `note_delete_with_dir` reach via
    /// this seam, so the snapshot pair must be live; the index/sync side-effects
    /// are irrelevant here. Avoids an `AppHandle` / `tauri::test` harness (TB9
    /// Cargo.lock discipline) — the `ClampHooks` precedent in `prefs/mod.rs`.
    ///
    /// It also RECORDS every `ai_note_changed` call, because what that hook is
    /// handed is a contract the compiler cannot state: three of the notes
    /// commands reach it and each used to decide for itself whether to project a
    /// drawing body first (myne#304).
    #[derive(Default)]
    struct SnapshotHooks {
        ai_changed: std::sync::Mutex<Vec<(String, String)>>,
        /// `(id, body)` per `search_upsert`, and the ids passed to
        /// `search_remove` — the pair test-audit #20 is about.
        search_upserts: std::sync::Mutex<Vec<(String, String)>>,
        search_removes: std::sync::Mutex<Vec<String>>,
    }
    impl myne_core::hooks::VaultLifecycleHooks for SnapshotHooks {
        fn hydrate_attachment_refs<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_search_index<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_spell<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn reclaim_stray_attachment_blobs<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn persist_search_index<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_ai_vectors<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn index_note_attachments<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
            _: &'a str,
            _: &'a str,
            _: &'a str,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn zeroize_search_index(&self) {}
        fn zeroize_spell(&self) {}
        fn zeroize_vault_indices(&self) {}
        fn zeroize_attachment_refs(&self) {}
        fn abort_active_recording(&self) {}
        fn pdf_export_teardown_on_lock(&self) {}
        fn agent_teardown_on_lock(&self) {}
        fn clear_staged_descriptor(&self) {}
        fn apply_screen_capture(&self, _: bool, _: &'static str) {}
        fn search_upsert(&self, id: &str, _: &str, body: &str) {
            self.search_upserts
                .lock()
                .expect("recorder mutex")
                .push((id.to_string(), body.to_string()));
        }
        fn search_remove(&self, id: &str) {
            self.search_removes
                .lock()
                .expect("recorder mutex")
                .push(id.to_string());
        }
        fn ai_note_changed(&self, id: &str, body: &str) {
            self.ai_changed
                .lock()
                .expect("recorder mutex")
                .push((id.to_string(), body.to_string()));
        }
        fn ai_note_deleted(&self, _: &str) {}
        fn ai_policy_changed(&self, _: bool, _: &[String]) {}
        fn bump_local_change(&self) {}
        fn emit_snapshot_write_failed(&self, _: &str) {}
        // `effective_auto_lock_secs` deliberately not overridden: the trait's
        // default clamps (myne-md/myne#479). This body used to be the unclamped
        // `unwrap_or`, which is the exact shape that change removed from two
        // production clients, so a fixture carrying it handed the next author
        // the defect as the copyable example.
        fn hydrate_clipper_pairing(&self, _: &[protocol::PairedExtension]) {}
        fn preempt_inflight_backup<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn invalidate_quick_unlock(&self, _: &Path) {}
        fn capture_snapshot(
            &self,
            vault_root: &Path,
            note_uuid: &str,
            old_blob: &[u8],
            now_ms: u64,
            force: bool,
        ) -> bool {
            myne_core::snapshot_store::capture_snapshot_best_effort(
                vault_root, note_uuid, old_blob, now_ms, force,
            )
        }
        fn purge_note_snapshots(
            &self,
            vault_root: &Path,
            note_uuid: &str,
        ) -> std::io::Result<usize> {
            crate::snapshot_store::remove_all_note_snapshots(
                &vault_root.join("snapshots"),
                note_uuid,
            )
        }
    }

    /// `Hooks` wired to the real desktop snapshot store for the CRUD `_with_dir`
    /// calls these tests drive (the snapshot side-effect is the behavior under
    /// test in several of them).
    fn noop_hooks() -> myne_core::hooks::Hooks {
        std::sync::Arc::new(SnapshotHooks::default())
    }

    /// Byte-pattern items_byte from `fixture_unlocked_with_keys` so
    /// production decode under the same fixture works.
    const FIXTURE_ROOT_BYTE: u8 = 0x07;
    const FIXTURE_ITEMS_BYTE: u8 = 0x09;
    const FIXTURE_ITEMS_ID_BYTE: u8 = 0x01;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("multi-thread runtime")
    }

    // ---- happy path: round-trip create + on-disk decode -----------------

    #[test]
    fn round_trip_create_then_protocol_decode_returns_same_plaintext() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-create-roundtrip").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let plaintext = "# happy path\nnote body";
            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                plaintext.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("happy path must succeed");

            let note_id = NoteId::parse(&note_id_str).expect("returned id must be canonical");
            let on_disk = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
            assert!(on_disk.is_file(), ".myn file must exist on disk");

            let blob = std::fs::read(&on_disk).unwrap();
            let items_key = [FIXTURE_ITEMS_BYTE; 32];
            let items_key_id = [FIXTURE_ITEMS_ID_BYTE; 16];
            let decrypted = protocol::decode_note(
                &blob,
                note_id.as_uuid().as_bytes(),
                &items_key,
                &items_key_id,
            )
            .expect("on-disk blob must decrypt under fixture keys");

            assert_eq!(decrypted.plaintext(), plaintext.as_bytes());
        });
    }

    // ---- MYND-96 snapshot creation hook (note_update) -------------------

    #[test]
    fn note_update_captures_snapshot_of_old_content() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-snapshot").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let v1 = "# v1\noriginal body";
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                v1.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let v2 = "# v2\nedited body";
            let outcome = note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                v2.to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            assert!(
                !outcome.snapshot_warning,
                "a successful snapshot must not raise the warning signal"
            );

            let note_id = NoteId::parse(&id).unwrap();
            let items_key = [FIXTURE_ITEMS_BYTE; 32];
            let items_key_id = [FIXTURE_ITEMS_ID_BYTE; 16];

            // Live note is v2.
            let live = std::fs::read(notes_dir.join(format!("{}.myn", note_id.as_uuid()))).unwrap();
            let live_dec = protocol::decode_note(
                &live,
                note_id.as_uuid().as_bytes(),
                &items_key,
                &items_key_id,
            )
            .unwrap();
            assert_eq!(live_dec.plaintext(), v2.as_bytes());

            // Exactly one snapshot, decrypting to v1 (the pre-edit content).
            let sdir = scratch.path().join("snapshots");
            let snaps =
                crate::snapshot_store::list_note_snapshots(&sdir, &note_id.as_uuid().to_string())
                    .unwrap();
            assert_eq!(snaps.len(), 1, "first update must capture one snapshot");
            let snap_blob = std::fs::read(&snaps[0].path).unwrap();
            let snap_dec = protocol::decode_note(
                &snap_blob,
                note_id.as_uuid().as_bytes(),
                &items_key,
                &items_key_id,
            )
            .unwrap();
            assert_eq!(
                snap_dec.plaintext(),
                v1.as_bytes(),
                "snapshot must hold the pre-edit content"
            );
        });
    }

    #[test]
    fn note_update_within_window_is_coalesced() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-coalesce").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "v1".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "v2".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            // Second update lands within the ~5-min coalescing window → no new snapshot.
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "v3".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let note_id = NoteId::parse(&id).unwrap();
            let sdir = scratch.path().join("snapshots");
            let snaps =
                crate::snapshot_store::list_note_snapshots(&sdir, &note_id.as_uuid().to_string())
                    .unwrap();
            assert_eq!(
                snaps.len(),
                1,
                "an update within the coalescing window must not add a snapshot"
            );
        });
    }

    // ---- MYND-85 transactional batch rewrite (§8.3 / WL-7) --------------

    /// Helper: decode an on-disk `.myn` under the fixture keys and assert
    /// its plaintext equals `expect`.
    fn assert_on_disk_body(notes_dir: &Path, id: &str, expect: &str) {
        let note_id = NoteId::parse(id).unwrap();
        let blob = std::fs::read(notes_dir.join(format!("{}.myn", note_id.as_uuid()))).unwrap();
        let items_key = [FIXTURE_ITEMS_BYTE; 32];
        let items_key_id = [FIXTURE_ITEMS_ID_BYTE; 16];
        let dec = protocol::decode_note(
            &blob,
            note_id.as_uuid().as_bytes(),
            &items_key,
            &items_key_id,
        )
        .expect("on-disk blob must decrypt under fixture keys");
        assert_eq!(dec.plaintext(), expect.as_bytes());
    }

    #[test]
    fn note_write_batch_rewrites_all_and_each_decrypts_to_new_body() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-batch-roundtrip").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            // Three existing notes (the renamed note + two inbound).
            let id_a = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# Old Title\nbody A".into(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let id_b = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "see [[Old Title]] here".into(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let id_c = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "and [[Old Title|alias]] too".into(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            // Simulate the rename rewrite: renamed note's own title swap +
            // inbound link rewrites.
            let items: Vec<(String, Zeroizing<String>)> = vec![
                (id_a.clone(), Zeroizing::new("# New Title\nbody A".into())),
                (
                    id_b.clone(),
                    Zeroizing::new("see [[New Title]] here".into()),
                ),
                (
                    id_c.clone(),
                    Zeroizing::new("and [[New Title|alias]] too".into()),
                ),
            ];
            note_write_batch_with_dir(
                &myne_core::vault_io::StdVaultIo,
                notes_dir.clone(),
                &state,
                &items,
                0,
            )
            .await
            .expect("transactional batch must commit");

            assert_on_disk_body(&notes_dir, &id_a, "# New Title\nbody A");
            assert_on_disk_body(&notes_dir, &id_b, "see [[New Title]] here");
            assert_on_disk_body(&notes_dir, &id_c, "and [[New Title|alias]] too");

            // No transaction residue.
            let residue = std::fs::read_dir(&notes_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let n = e.file_name();
                    let n = n.to_string_lossy();
                    n.ends_with(".tmp") || n == ".rename-journal"
                })
                .count();
            assert_eq!(residue, 0, "no .tmp / marker left after a committed batch");
        });
    }

    #[test]
    fn note_write_batch_aborts_whole_set_when_one_note_missing() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-batch-abort").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let id_a = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "real A v1".into(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            // A canonical-but-nonexistent id (never created on disk).
            let phantom = NoteId::new_v7().as_uuid().to_string();

            let items: Vec<(String, Zeroizing<String>)> = vec![
                (id_a.clone(), Zeroizing::new("real A v2".into())),
                (phantom, Zeroizing::new("ghost".into())),
            ];
            let err = note_write_batch_with_dir(
                &myne_core::vault_io::StdVaultIo,
                notes_dir.clone(),
                &state,
                &items,
                0,
            )
            .await
            .expect_err("a missing note must abort the whole batch");
            assert!(
                matches!(err, NoteBatchError::NoteNotFound),
                "expected NoteNotFound, got {err:?}"
            );

            // The real note is UNCHANGED — the vault is left pre-rename.
            assert_on_disk_body(&notes_dir, &id_a, "real A v1");
            let residue = std::fs::read_dir(&notes_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let n = e.file_name();
                    let n = n.to_string_lossy();
                    n.ends_with(".tmp") || n == ".rename-journal"
                })
                .count();
            assert_eq!(residue, 0, "aborted batch leaves no staged residue");
        });
    }

    // ── myne#304: what the three notes commands hand `ai_note_changed` ──────
    //
    // The hook's body argument is the RAW note body — frontmatter included, and
    // for a drawing the scene JSON rather than its projected text. The AI arm
    // projects for itself, because it needs the frontmatter first (the SYNC-14
    // folder-exclusion set is read from it) and because the unlock-time rebuild
    // reads raw bodies off disk regardless.
    //
    // Before this, `note_create` passed raw while `note_update` and the batch
    // passed projected — three call sites, three chances to decide differently,
    // and nothing that could state the contract. These drive all three against
    // one recording hooks impl so the answer is asserted rather than reviewed.

    /// A `kind: drawing` note: scene JSON in the body, folder in frontmatter.
    const DRAWING: &str = "---\nkind: drawing\nfolder: Sketches/\n---\n\n```excalidraw\n{\"type\":\"excalidraw\",\"elements\":[{\"type\":\"text\",\"text\":\"roadmap\"}]}\n```\n";

    /// A host whose `app_data_dir` is a scratch directory, with the active
    /// vault root materialized so the `_from_host` path resolvers succeed.
    fn host_with_vault(base: &Path) -> myne_core::host::test_host::TestHost {
        let root = base
            .join("data")
            .join("vaults")
            .join(test_vault_id().as_uuid().to_string());
        std::fs::create_dir_all(root.join("notes")).unwrap();
        myne_core::host::test_host::TestHost::new(base)
    }

    /// test-audit #20: a permanent delete under SYNC arrives here as an
    /// ordinary `note_update` carrying a `deleted:` frontmatter stamp — not as
    /// an unlink — and it must REMOVE the note from the search index rather
    /// than re-index it.
    ///
    /// What the old behaviour cost: the purged note's full body went back into
    /// the live BM25 index on the way out, stayed there for the rest of the
    /// session, and was sealed into the encrypted `vault.search` blob at lock.
    /// The palette's only exclusion is the sidebar cache's `trashed:`
    /// predicate, and a tombstoned note has already left that cache — so
    /// nothing filtered it and the note kept answering searches until the next
    /// unlock's hydrate happened to drop it.
    #[test]
    fn a_tombstoning_update_removes_the_note_from_the_search_index() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("tombstone-search-removal").unwrap();
            let host = host_with_vault(scratch.path());
            let recorder = std::sync::Arc::new(SnapshotHooks::default());
            let hooks: myne_core::hooks::Hooks = recorder.clone();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            const LIVE: &str = "---\ntitle: Secret\n---\n\nthe body that must not survive the purge\n";
            // The same shape `patchDeletedField` writes: a top-level `deleted:`
            // timestamp added to the existing frontmatter.
            const TOMBSTONE: &str =
                "---\ntitle: Secret\ndeleted: 2026-08-12T00:00:00Z\n---\n\nthe body that must not survive the purge\n";

            let id = note_create_from_host(
                &host,
                &state,
                &hooks,
                LIVE.to_string(),
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .expect("create");

            // A live edit still indexes — otherwise this test would pass on a
            // build where search_upsert was simply never called.
            assert!(
                recorder
                    .search_upserts
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(seen, _)| seen == &id),
                "the live note must have been indexed in the first place"
            );
            recorder.search_upserts.lock().unwrap().clear();

            note_update_from_host(
                &host,
                &state,
                &hooks,
                id.clone(),
                TOMBSTONE.to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .expect("tombstoning update");

            assert!(
                recorder.search_removes.lock().unwrap().contains(&id),
                "a tombstoning update must remove the note from the index"
            );
            assert!(
                recorder.search_upserts.lock().unwrap().is_empty(),
                "and must NOT re-index it: {:?}",
                recorder.search_upserts.lock().unwrap()
            );
        });
    }

    #[test]
    fn all_three_notes_commands_hand_the_ai_hook_the_raw_body() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("ai-hook-raw-body").unwrap();
            let host = host_with_vault(scratch.path());
            let recorder = std::sync::Arc::new(SnapshotHooks::default());
            let hooks: myne_core::hooks::Hooks = recorder.clone();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            // create
            let id = note_create_from_host(
                &host,
                &state,
                &hooks,
                DRAWING.to_string(),
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .expect("create");

            // update
            note_update_from_host(
                &host,
                &state,
                &hooks,
                id.clone(),
                DRAWING.to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .expect("update");

            // batch
            note_write_batch_transactional_from_host(
                &host,
                &myne_core::vault_io::StdVaultIo,
                &state,
                &hooks,
                vec![NoteBatchUpdate {
                    note_id: id.clone(),
                    plaintext: DRAWING.to_string(),
                }],
            )
            .await
            .expect("batch");

            let seen = recorder.ai_changed.lock().unwrap().clone();
            assert_eq!(seen.len(), 3, "all three commands must reach the hook");
            for (i, (got_id, body)) in seen.iter().enumerate() {
                assert_eq!(got_id, &id, "call {i} carried the wrong note id");
                assert_eq!(
                    body, DRAWING,
                    "call {i} must hand the hook the raw body, frontmatter and all"
                );
            }
        });
    }

    #[test]
    fn note_write_batch_empty_is_a_noop() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-batch-empty").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;
            note_write_batch_with_dir(&myne_core::vault_io::StdVaultIo, notes_dir, &state, &[], 0)
                .await
                .expect("empty batch is a no-op success");
        });
    }

    #[test]
    fn note_write_batch_rejected_when_slot_locked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-batch-locked").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            // Default slot is Empty (locked).
            let state = VaultRuntimeState::default();
            let items: Vec<(String, Zeroizing<String>)> = vec![(
                NoteId::new_v7().as_uuid().to_string(),
                Zeroizing::new("x".into()),
            )];
            let err = note_write_batch_with_dir(
                &myne_core::vault_io::StdVaultIo,
                notes_dir,
                &state,
                &items,
                0,
            )
            .await
            .expect_err("a locked slot must reject the batch");
            assert!(
                matches!(err, NoteBatchError::VaultNotUnlocked),
                "expected VaultNotUnlocked, got {err:?}"
            );
        });
    }

    #[test]
    fn note_update_succeeds_even_if_snapshot_write_fails() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-snapshot-fail").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            // Sabotage: a regular file where `snapshots/` would go → create_dir_all
            // fails → best-effort snapshot is skipped, update must still succeed.
            std::fs::write(scratch.path().join("snapshots"), b"not a dir").unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "v1".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let outcome = note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "v2".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("update must succeed despite a failing snapshot");
            assert!(
                outcome.snapshot_warning,
                "a failed snapshot must surface the non-blocking warning signal (SYNC-8)"
            );

            let note_id = NoteId::parse(&id).unwrap();
            let items_key = [FIXTURE_ITEMS_BYTE; 32];
            let items_key_id = [FIXTURE_ITEMS_ID_BYTE; 16];
            let live = std::fs::read(notes_dir.join(format!("{}.myn", note_id.as_uuid()))).unwrap();
            let dec = protocol::decode_note(
                &live,
                note_id.as_uuid().as_bytes(),
                &items_key,
                &items_key_id,
            )
            .unwrap();
            assert_eq!(dec.plaintext(), b"v2");
        });
    }

    // ---- MYND-96 force-flush (on-close / vault-lock) --------------------

    #[test]
    fn flush_force_captures_even_within_window() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-flush").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "v1".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            // First update captures one snapshot (of v1); we're now inside the window.
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "v2".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            // Flush force-captures the CURRENT state (v2) despite the window.
            let warn = note_snapshot_flush_with_dir(notes_dir.clone(), &state, id.clone())
                .await
                .unwrap();
            assert!(!warn);

            let note_id = NoteId::parse(&id).unwrap();
            let sdir = scratch.path().join("snapshots");
            let snaps =
                crate::snapshot_store::list_note_snapshots(&sdir, &note_id.as_uuid().to_string())
                    .unwrap();
            assert_eq!(
                snaps.len(),
                2,
                "flush must force a snapshot even within the coalescing window"
            );
        });
    }

    #[test]
    fn flush_missing_note_is_noop() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-flush-missing").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;
            let phantom = "01970e83-4f2f-7000-8000-000000000000".to_string();
            let warn = note_snapshot_flush_with_dir(notes_dir, &state, phantom)
                .await
                .unwrap();
            assert!(!warn, "flushing a missing note is a no-op, not a warning");
        });
    }

    #[test]
    fn flush_rejects_when_locked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-flush-locked").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default(); // Slot::Empty
            let phantom = "01970e83-4f2f-7000-8000-000000000000".to_string();
            let r = note_snapshot_flush_with_dir(notes_dir, &state, phantom).await;
            assert!(matches!(r, Err(NoteUpdateError::VaultNotUnlocked)));
        });
    }

    #[test]
    fn delete_purges_note_snapshots() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-delete-purge").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "v1".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "v2".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let note_id = NoteId::parse(&id).unwrap();
            let uuid = note_id.as_uuid().to_string();
            let sdir = scratch.path().join("snapshots");
            assert_eq!(
                crate::snapshot_store::list_note_snapshots(&sdir, &uuid)
                    .unwrap()
                    .len(),
                1,
                "precondition: one snapshot exists before delete"
            );

            // Permanent delete must purge the note's snapshots (cryptographic erase).
            note_delete_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            assert!(
                !notes_dir.join(format!("{uuid}.myn")).exists(),
                "the live note must be gone"
            );
            assert!(
                crate::snapshot_store::list_note_snapshots(&sdir, &uuid)
                    .unwrap()
                    .is_empty(),
                "delete must purge the note's snapshots (no orphan decryptable ciphertext)"
            );
        });
    }

    // ---- slot guards ----------------------------------------------------

    #[test]
    fn slot_empty_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-create-slot-empty").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default(); // Slot::Empty by default

            let result = note_create_with_dir(
                notes_dir,
                &state,
                "x".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteCreateError::VaultNotUnlocked)));
        });
    }

    #[test]
    fn slot_recovering_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-create-slot-recovering").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;

            let result = note_create_with_dir(
                notes_dir,
                &state,
                "x".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteCreateError::VaultNotUnlocked)));
        });
    }

    // ---- 16 MiB boundary -----------------------------------------------

    #[test]
    fn plaintext_at_max_succeeds() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-create-max").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let plaintext = String::from_utf8(vec![b'a'; protocol::MAX_PLAINTEXT_LEN]).unwrap();
            let result = note_create_with_dir(
                notes_dir,
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(
                result.is_ok(),
                "MAX_PLAINTEXT_LEN must succeed; got {result:?}"
            );
        });
    }

    #[test]
    fn plaintext_above_max_returns_plaintext_too_large() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-create-above-max").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let plaintext = String::from_utf8(vec![b'a'; protocol::MAX_PLAINTEXT_LEN + 1]).unwrap();
            let result = note_create_with_dir(
                notes_dir,
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteCreateError::PlaintextTooLarge)));
        });
    }

    // ---- defensive guards ------------------------------------------------

    #[test]
    fn atomic_write_replace_false_canary_under_notes_dir() {
        // The `NoteAlreadyExists` defensive guard rides on
        // `atomic_write::atomic_write(.., replace=false)` rejecting a
        // pre-existing destination. UUIDv7 isn't predictable mid-test,
        // so we cannot forge a real collision through `note_create`;
        // this test pins the helper-layer guard the canary depends on.
        // That `note_create_with_dir` invokes the helper with
        // `replace=false` is verified by reading the call site directly.
        let scratch = ScopedTempDir::new("note-create-already-exists").unwrap();
        let notes_dir = notes_dir_under(scratch.path()).unwrap();
        let sentinel = notes_dir.join("sentinel.myn");
        std::fs::write(&sentinel, b"pre-existing").unwrap();

        let err = atomic_write::atomic_write(&sentinel, b"replacement", false).expect_err(
            "atomic_write replace=false must reject a pre-existing dest — the canary \
                that note_create maps to NoteAlreadyExists",
        );
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }

    #[test]
    fn notes_dir_resolution_failing_with_not_a_directory_returns_structural_variant() {
        // `note_create_with_dir` takes `notes_dir` already resolved,
        // so the `NotesDirNotADirectory` mapping lives in the outer
        // `note_create` (which calls `paths::notes_dir`). We exercise
        // the helper-layer surface that the outer matches: confirm
        // `paths::notes_dir_under` returns an IO error of the expected
        // kind when `<parent>/notes` is a regular file. The outer's
        // accept-list mapping (`NotADirectory | AlreadyExists`) is
        // verified at the `paths::tests::notes_dir_under_errors_when_path_is_a_file`
        // boundary, which is where the kind preservation is pinned.
        let scratch = ScopedTempDir::new("note-create-notes-is-file").unwrap();
        let conflict = scratch.path().join("notes");
        std::fs::write(&conflict, b"hostile").unwrap();
        let err = notes_dir_under(scratch.path()).expect_err("conflict must error");
        assert!(matches!(
            err.kind(),
            std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists
        ));
    }

    // ---- concurrent vault_lock fair-queue --------------------------------

    #[test]
    fn note_create_concurrent_with_vault_lock_completes_cleanly() {
        // The deterministic properties: under multi-thread scheduling,
        // `note_create` and a concurrent `state.take()` (which is what
        // `vault_lock` does internally) both complete without deadlock,
        // and the terminal state is `Slot::Empty`. The fair-queue
        // ordering between read and write requests is a
        // `tokio::sync::RwLock` implementation guarantee — exercised
        // structurally by holding the read guard across spawn_blocking
        // + atomic_write in `note_create_with_dir`. The race outcome
        // (which task acquired its lock first) is non-deterministic
        // under multi-thread runtime; both orderings produce a valid
        // terminal state that this test pins.
        rt().block_on(async {
            use std::sync::Arc;

            let scratch = ScopedTempDir::new("note-create-concurrent-lock").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = Arc::new(VaultRuntimeState::default());
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let create_state = Arc::clone(&state);
            let create_dir = notes_dir.clone();
            let create = tokio::spawn(async move {
                note_create_with_dir(
                    create_dir,
                    &create_state,
                    "concurrent".to_string(),
                    &myne_core::vault_io::StdVaultIo,
                    &myne_core::host::NoopHost,
                )
                .await
            });

            tokio::task::yield_now().await;

            let lock_state = Arc::clone(&state);
            let lock = tokio::spawn(async move { lock_state.take(test_vault_id()).await });

            let create_result = create.await.expect("create task joins");
            let lock_taken = lock.await.expect("lock task joins");

            // Lock observed `Slot::Unlocked(_)` regardless of which
            // task's lock-request reached the queue first — the
            // variant set at test start. Under fair queueing, the
            // write-lock (lock's `state.take()`) waits for any
            // outstanding read guard before it runs.
            assert!(
                matches!(
                    lock_taken,
                    crate::plugins::vault_unlock::state::Slot::Unlocked(_)
                ),
                "lock must take the Unlocked variant"
            );

            // After both tasks join, the slot is Empty (lock consumed
            // it; create never mutated the variant).
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
            );

            // create's outcome depends on which task acquired its
            // lock first. Both orderings are valid; either proves no
            // deadlock + no state corruption:
            //   - `Ok(_)`                        → create ran first;
            //                                       lock waited for the
            //                                       read guard to drop.
            //   - `Err(VaultNotUnlocked)`        → lock ran first;
            //                                       create observed
            //                                       `Slot::Empty`.
            match create_result {
                Ok(_) => {}
                Err(NoteCreateError::VaultNotUnlocked) => {}
                Err(other) => panic!("unexpected create outcome: {other:?}"),
            }
        });
    }

    // ---- error_kind label ------------------------------------------------

    #[test]
    fn error_kind_label_covers_every_variant() {
        // Compile-time exhaustiveness via the helper's match. Each
        // label is a static `&'static str`; the test just exercises
        // every variant through the helper to pin the wire shape.
        use crate::io_failure_kind::IoFailureKind;
        assert_eq!(
            note_create_error_kind(&NoteCreateError::VaultNotUnlocked),
            "VaultNotUnlocked"
        );
        assert_eq!(
            note_create_error_kind(&NoteCreateError::NoteAlreadyExists),
            "NoteAlreadyExists"
        );
        assert_eq!(
            note_create_error_kind(&NoteCreateError::PlaintextTooLarge),
            "PlaintextTooLarge"
        );
        assert_eq!(
            note_create_error_kind(&NoteCreateError::NotesDirNotADirectory),
            "NotesDirNotADirectory"
        );
        assert_eq!(
            note_create_error_kind(&NoteCreateError::Io {
                io_error_kind: IoFailureKind::Other,
            }),
            "Io"
        );
        assert_eq!(
            note_create_error_kind(&NoteCreateError::JoinFailure),
            "JoinFailure"
        );
    }

    // =====================================================================
    // note_read
    // =====================================================================

    /// Helper: write a v0.1 .myn blob with caller-supplied randomness
    /// (tests need predictable bytes; `encode_new_note_blob_raw` is the
    /// `_raw` surface in the protocol crate that takes nonces + item_key
    /// as parameters). Used by the non-UTF-8 plaintext test below.
    fn forge_note_blob_with_plaintext(
        notes_dir: &Path,
        items_key: &[u8; 32],
        items_key_id: &[u8; 16],
        plaintext: &[u8],
    ) -> (NoteId, PathBuf) {
        let note_id = NoteId::new_v7();
        let item_key = [0xAAu8; 32];
        let item_key_nonce = [0xBBu8; 24];
        let content_nonce = [0xCCu8; 24];
        let blob = protocol::encode_new_note_blob_raw(
            items_key,
            items_key_id,
            note_id.as_uuid().as_bytes(),
            &item_key,
            &item_key_nonce,
            &content_nonce,
            plaintext,
        )
        .expect("forge encode must succeed for raw input");
        let path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
        std::fs::write(&path, &blob).unwrap();
        (note_id, path)
    }

    // ---- happy round-trip with note_create -----------------------------

    #[test]
    fn round_trip_create_then_read_returns_same_plaintext() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-read-roundtrip").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let plaintext = "# round trip\nbody bytes";
            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                plaintext.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let recovered = note_read_with_dir(
                notes_dir,
                &state,
                note_id_str,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("read of freshly created note must succeed");
            assert_eq!(recovered, plaintext);
        });
    }

    // ---- slot guards ---------------------------------------------------

    #[test]
    fn read_slot_empty_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-read-slot-empty").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();

            let result = note_read_with_dir(
                notes_dir,
                &state,
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteReadError::VaultNotUnlocked)));
        });
    }

    #[test]
    fn read_slot_recovering_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-read-slot-recovering").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;

            let result = note_read_with_dir(
                notes_dir,
                &state,
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteReadError::VaultNotUnlocked)));
        });
    }

    // ---- strict NoteId parse rejects -----------------------------------

    #[test]
    fn read_invalid_note_id_wrong_length() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-read-id-len").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let result = note_read_with_dir(
                notes_dir,
                &state,
                "too-short".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteReadError::InvalidNoteId)));
        });
    }

    #[test]
    fn read_invalid_note_id_uppercase() {
        // Filesystem case-sensitivity defense — APFS/ext4 inconsistency
        // structurally prevented at the parser before any path
        // concatenation (path-traversal-impossible by construction).
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-read-id-upper").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let result = note_read_with_dir(
                notes_dir,
                &state,
                "01970E83-4F2F-7000-8000-000000000000".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteReadError::InvalidNoteId)));
        });
    }

    #[test]
    fn read_invalid_note_id_v4_uuid() {
        // Backend-gen v7-only contract is double-pinned: UI cannot
        // inject a v4 UUID and have it routed to a real file.
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-read-id-v4").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let result = note_read_with_dir(
                notes_dir,
                &state,
                "550e8400-e29b-41d4-a716-446655440000".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteReadError::InvalidNoteId)));
        });
    }

    // ---- NoteNotFound: valid v7 UUID, no file --------------------------

    #[test]
    fn read_note_not_found_for_valid_id_with_no_file() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-read-not-found").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            // Mint a fresh v7 UUID; no corresponding file on disk.
            let phantom = NoteId::new_v7();
            let result = note_read_with_dir(
                notes_dir,
                &state,
                phantom.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteReadError::NoteNotFound)));
        });
    }

    // ---- AEAD failure: tampered byte returns CannotDecrypt --------------

    #[test]
    fn read_tampered_blob_returns_cannot_decrypt() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-read-tamper").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            // Create a real note, then tamper one byte of the on-disk
            // blob's content_nonce region (offset > 47, post-prefix) so
            // §6.4 inner-AEAD verification fails.
            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "untampered original".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let path = notes_dir.join(format!(
                "{}.myn",
                NoteId::parse(&note_id_str).unwrap().as_uuid()
            ));
            let mut blob = std::fs::read(&path).unwrap();
            // Last byte sits in the inner ciphertext + CTX tag region;
            // flipping it invalidates the inner-AEAD CTX commitment.
            let last = blob.len() - 1;
            blob[last] ^= 0xFF;
            std::fs::write(&path, &blob).unwrap();

            let result = note_read_with_dir(
                notes_dir,
                &state,
                note_id_str,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteReadError::CannotDecrypt)));
        });
    }

    // ---- Post-AEAD UTF-8 boundary: InvalidPlaintextEncoding ------------

    #[test]
    fn read_non_utf8_plaintext_returns_invalid_plaintext_encoding() {
        // Use the protocol crate's `_raw` surface to forge a blob with
        // intentionally non-UTF-8 plaintext bytes ([0xFF, 0xFE]) under
        // the same items_key + items_key_id the fixture uses. The blob
        // is a valid v0.1 `.myn` (AEAD verifies); only the post-AEAD
        // UTF-8 conversion fails. This is the structural-corruption
        // distinguisher distinct from `CannotDecrypt`.
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-read-non-utf8").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let items_key = [FIXTURE_ITEMS_BYTE; 32];
            let items_key_id = [FIXTURE_ITEMS_ID_BYTE; 16];
            let bad_plaintext: &[u8] = &[0xFF, 0xFE]; // valid bytes, invalid UTF-8 prefix
            let (note_id, _path) = forge_note_blob_with_plaintext(
                &notes_dir,
                &items_key,
                &items_key_id,
                bad_plaintext,
            );

            let result = note_read_with_dir(
                notes_dir,
                &state,
                note_id.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(
                result,
                Err(NoteReadError::InvalidPlaintextEncoding)
            ));
        });
    }

    // ---- error_kind label ----------------------------------------------

    #[test]
    fn read_error_kind_label_covers_every_variant() {
        use crate::io_failure_kind::IoFailureKind;
        assert_eq!(
            note_read_error_kind(&NoteReadError::NoteNotFound),
            "NoteNotFound"
        );
        assert_eq!(
            note_read_error_kind(&NoteReadError::InvalidNoteId),
            "InvalidNoteId"
        );
        assert_eq!(
            note_read_error_kind(&NoteReadError::VaultNotUnlocked),
            "VaultNotUnlocked"
        );
        assert_eq!(
            note_read_error_kind(&NoteReadError::CannotDecrypt),
            "CannotDecrypt"
        );
        assert_eq!(
            note_read_error_kind(&NoteReadError::InvalidPlaintextEncoding),
            "InvalidPlaintextEncoding"
        );
        assert_eq!(
            note_read_error_kind(&NoteReadError::NotesDirNotADirectory),
            "NotesDirNotADirectory"
        );
        assert_eq!(
            note_read_error_kind(&NoteReadError::Io {
                io_error_kind: IoFailureKind::Other,
            }),
            "Io"
        );
        assert_eq!(
            note_read_error_kind(&NoteReadError::JoinFailure),
            "JoinFailure"
        );
    }

    // ---- MYND-26 retroactive: notes_dir-as-regular-file behavioral pin --

    #[test]
    fn read_notes_dir_resolution_failing_with_not_a_directory_returns_structural_variant() {
        // `note_read_with_dir` takes `notes_dir` already resolved; the
        // `NotesDirNotADirectory` mapping lives in the outer `note_read`
        // (which calls `paths::notes_dir`). Exercise the helper-layer
        // surface that the outer matches: `paths::notes_dir_under`
        // returns an IO error of the expected kind when `<parent>/notes`
        // is a regular file. The outer's accept-list mapping
        // (`NotADirectory | AlreadyExists`) is verified by code
        // inspection on `note_read`'s map_err arm.
        let scratch = ScopedTempDir::new("note-read-notes-is-file").unwrap();
        let conflict = scratch.path().join("notes");
        std::fs::write(&conflict, b"hostile").unwrap();
        let err = notes_dir_under(scratch.path()).expect_err("conflict must error");
        assert!(matches!(
            err.kind(),
            std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists
        ));
    }

    // =====================================================================
    // note_update
    // =====================================================================

    // ---- happy path: round-trip create + update + read ------------------

    #[test]
    fn round_trip_create_then_update_then_read_returns_updated_plaintext() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-roundtrip").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let original = "# original\nfirst body";
            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                original.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            // Capture the original blob's prefix for the byte-identical pin
            // below. `protocol.md` §6.3: bytes 0..=47+N (where N = 64 in
            // v0.1: enc_item_key_len = 32 ct + 32 CTX tag) are byte-identical
            // across update revisions. Total prefix = 48 + 64 = 112 bytes.
            let note_id = NoteId::parse(&note_id_str).unwrap();
            let path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
            let original_blob = std::fs::read(&path).unwrap();
            const PREFIX_LEN: usize = 48 + 64;
            let original_prefix = original_blob[..PREFIX_LEN].to_vec();

            let updated = "# updated\nrewritten body bytes";
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                note_id_str.clone(),
                updated.to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("update must succeed on a fresh note");

            // Pin §6.3: bytes 0..=47+N must be byte-identical post-update.
            let updated_blob = std::fs::read(&path).unwrap();
            let updated_prefix = updated_blob[..PREFIX_LEN].to_vec();
            assert_eq!(
                original_prefix, updated_prefix,
                "bytes 0..=47+N must be byte-identical across update per protocol.md §6.3"
            );

            // The content tail (content_nonce + ciphertext_len + ciphertext)
            // MUST differ — fresh content_nonce + new plaintext.
            assert_ne!(
                original_blob[PREFIX_LEN..],
                updated_blob[PREFIX_LEN..],
                "content tail must change across update (fresh content_nonce + new plaintext)"
            );

            // Round-trip: post-update read returns the new plaintext.
            let recovered = note_read_with_dir(
                notes_dir,
                &state,
                note_id_str,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("read after update must succeed");
            assert_eq!(recovered, updated);
        });
    }

    // ---- slot guards ----------------------------------------------------

    #[test]
    fn update_slot_empty_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-slot-empty").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();

            // Valid v7 UUID so InvalidNoteId doesn't intercept the slot
            // guard (NoteId::parse runs before the slot check).
            let result = note_update_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                "x".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteUpdateError::VaultNotUnlocked)));
        });
    }

    #[test]
    fn update_slot_recovering_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-slot-recovering").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;

            let result = note_update_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                "x".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteUpdateError::VaultNotUnlocked)));
        });
    }

    // ---- strict NoteId parse rejects -----------------------------------

    #[test]
    fn update_invalid_note_id_returns_invalid_note_id() {
        // Parser is exhaustively covered by `note_id::tests`; the host-
        // layer test pins that update routes the rejection to the public
        // `InvalidNoteId` variant before any path concatenation or slot
        // guard.
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-invalid-id").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let result = note_update_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                "too-short".to_string(),
                "x".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteUpdateError::InvalidNoteId)));
        });
    }

    // ---- NoteNotFound: valid v7 UUID, no file --------------------------

    #[test]
    fn update_note_not_found_for_valid_id_with_no_file() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-not-found").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            // Mint a fresh v7 UUID; no corresponding file on disk.
            // This is the autosave-after-delete race signal per the q1
            // decision in `decisions.md` 2026-05-07 "`note_update` error
            // surface".
            let phantom = NoteId::new_v7();
            let result = note_update_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                phantom.to_string(),
                "x".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteUpdateError::NoteNotFound)));
        });
    }

    // ---- AEAD failure: tampered byte returns CannotDecrypt --------------

    #[test]
    fn update_tampered_blob_returns_cannot_decrypt() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-tamper").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            // Create a real note, then tamper one byte of the on-disk
            // blob's inner ciphertext + CTX tag region so §6.4 inner-AEAD
            // verification fails on decode_note.
            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "untampered original".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let path = notes_dir.join(format!(
                "{}.myn",
                NoteId::parse(&note_id_str).unwrap().as_uuid()
            ));
            let mut blob = std::fs::read(&path).unwrap();
            let last = blob.len() - 1;
            blob[last] ^= 0xFF;
            std::fs::write(&path, &blob).unwrap();

            let result = note_update_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                note_id_str,
                "rewrite".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteUpdateError::CannotDecrypt)));
        });
    }

    // ---- durability: never plaintext on disk; failed write keeps old ----
    //
    // The "no plaintext temp files" + "interrupted write keeps a valid
    // blob" acceptance gate (MYND-88). The atomic_write mechanism itself is
    // fault-injected in `atomic_write.rs::tests`; these exercise the same
    // contract end-to-end through the note commands.

    /// True if `haystack` contains `needle` as a contiguous byte run.
    fn bytes_contain_run(haystack: &[u8], needle: &[u8]) -> bool {
        !needle.is_empty()
            && needle.len() <= haystack.len()
            && haystack.windows(needle.len()).any(|w| w == needle)
    }

    /// Assert no file under `dir` contains `marker`; return how many files
    /// were scanned (so callers can sanity-check the scan was non-empty).
    fn assert_no_file_under_contains(dir: &std::path::Path, marker: &[u8]) -> usize {
        let mut scanned = 0;
        for entry in std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                scanned += 1;
                let bytes = std::fs::read(&path).unwrap();
                assert!(
                    !bytes_contain_run(&bytes, marker),
                    "plaintext marker leaked into on-disk file {:?}",
                    path.file_name()
                );
            }
        }
        scanned
    }

    const PLAINTEXT_CANARY: &str = "ZZ_PLAINTEXT_LEAK_CANARY_8675309";

    #[test]
    fn create_persists_only_ciphertext_no_plaintext_on_disk() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-create-no-plaintext").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let plaintext = format!("# leak check\n{PLAINTEXT_CANARY} body");
            note_create_with_dir(
                notes_dir.clone(),
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("create must succeed");

            // Every file persisted under notes/ (the .myn blob plus any
            // leftover temp) must be ciphertext — the plaintext canary may
            // appear in none.
            let scanned = assert_no_file_under_contains(&notes_dir, PLAINTEXT_CANARY.as_bytes());
            assert!(scanned >= 1, "expected at least the .myn blob on disk");
        });
    }

    #[test]
    fn update_persists_only_ciphertext_no_plaintext_on_disk() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-no-plaintext").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# v1\nfirst body".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let updated = format!("# v2\n{PLAINTEXT_CANARY} rewritten");
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                note_id_str,
                updated,
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("update must succeed");

            let scanned = assert_no_file_under_contains(&notes_dir, PLAINTEXT_CANARY.as_bytes());
            assert!(scanned >= 1, "expected at least the .myn blob on disk");
        });
    }

    /// A real OS write failure (read-only notes dir) on update returns a
    /// closed typed `Io` error AND leaves the committed note intact — the
    /// "old or new, never partial" recovery invariant, end to end.
    #[cfg(unix)]
    #[test]
    fn update_in_readonly_dir_returns_io_error_and_keeps_old_note() {
        use crate::io_failure_kind::IoFailureKind;
        use std::os::unix::fs::PermissionsExt;
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-readonly").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let original = "# original\ndurable body";
            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                original.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            // r-x only: creating the atomic_write temp inside now fails
            // with PermissionDenied. Read perms remain, so the pre-write
            // decode of the existing blob still succeeds.
            std::fs::set_permissions(&notes_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
            let result = note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                note_id_str.clone(),
                "rewrite that cannot land".to_string(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            // Restore write perms BEFORE asserting so a failing assert can
            // not skip the ScopedTempDir cleanup.
            std::fs::set_permissions(&notes_dir, std::fs::Permissions::from_mode(0o700)).unwrap();

            assert!(
                matches!(
                    &result,
                    Err(NoteUpdateError::Io {
                        io_error_kind: IoFailureKind::PermissionDenied
                    })
                ),
                "expected Io PermissionDenied, got {result:?}"
            );

            // The committed note is byte-for-byte the original — a failed
            // update never corrupts or partially overwrites it.
            let recovered = note_read_with_dir(
                notes_dir,
                &state,
                note_id_str,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("note must still be readable after a failed update");
            assert_eq!(recovered, original);
        });
    }

    /// A read-only notes dir on create returns a closed typed `Io` error
    /// and writes nothing — no `.myn`, no leftover `.tmp`.
    #[cfg(unix)]
    #[test]
    fn create_in_readonly_dir_returns_io_error_and_writes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-create-readonly").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            std::fs::set_permissions(&notes_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
            let result = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# never lands".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            // Snapshot the dir contents while still read-only, then restore.
            let entries: Vec<_> = std::fs::read_dir(&notes_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.file_name())
                .collect();
            std::fs::set_permissions(&notes_dir, std::fs::Permissions::from_mode(0o700)).unwrap();

            assert!(
                matches!(&result, Err(NoteCreateError::Io { .. })),
                "expected Io error, got {result:?}"
            );
            assert!(
                entries.is_empty(),
                "a failed create must leave no .myn / .tmp behind, got {entries:?}"
            );
        });
    }

    // ---- 16 MiB boundary -----------------------------------------------

    #[test]
    fn update_plaintext_at_max_succeeds() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-max").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "small".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let big = String::from_utf8(vec![b'a'; protocol::MAX_PLAINTEXT_LEN]).unwrap();
            let result = note_update_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                note_id_str,
                big,
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(
                result.is_ok(),
                "MAX_PLAINTEXT_LEN must succeed; got {result:?}"
            );
        });
    }

    #[test]
    fn update_plaintext_above_max_returns_plaintext_too_large() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-above-max").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "small".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let too_big = String::from_utf8(vec![b'a'; protocol::MAX_PLAINTEXT_LEN + 1]).unwrap();
            let result = note_update_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                note_id_str,
                too_big,
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteUpdateError::PlaintextTooLarge)));
        });
    }

    // ---- concurrent vault_lock fair-queue --------------------------------

    #[test]
    fn update_concurrent_with_vault_lock_completes_cleanly() {
        // Mirror of `note_create_concurrent_with_vault_lock_completes_cleanly`.
        // The deterministic properties: under multi-thread scheduling,
        // `note_update` and a concurrent `state.take()` (which is what
        // `vault_lock` does internally) both complete without deadlock,
        // and the terminal state is `Slot::Empty`. Update's outcome
        // depends on which task acquired its lock first; both orderings
        // are valid and tested.
        rt().block_on(async {
            use std::sync::Arc;

            let scratch = ScopedTempDir::new("note-update-concurrent-lock").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = Arc::new(VaultRuntimeState::default());
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "initial body".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let update_state = Arc::clone(&state);
            let update_dir = notes_dir.clone();
            let update_id = note_id_str.clone();
            let update_task = tokio::spawn(async move {
                note_update_with_dir(
                    update_dir,
                    &update_state,
                    &noop_hooks(),
                    update_id,
                    "rewrite".to_string(),
                    None,
                    &myne_core::vault_io::StdVaultIo,
                    &myne_core::host::NoopHost,
                )
                .await
            });

            tokio::task::yield_now().await;

            let lock_state = Arc::clone(&state);
            let lock_task = tokio::spawn(async move { lock_state.take(test_vault_id()).await });

            let update_result = update_task.await.expect("update task joins");
            let lock_taken = lock_task.await.expect("lock task joins");

            assert!(
                matches!(
                    lock_taken,
                    crate::plugins::vault_unlock::state::Slot::Unlocked(_)
                ),
                "lock must take the Unlocked variant"
            );
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
            );

            // Update outcome depends on which task acquired its lock first:
            //   - `Ok(())`                        → update ran first; lock
            //                                       waited for the read guard.
            //   - `Err(VaultNotUnlocked)`         → lock ran first; update
            //                                       observed `Slot::Empty`.
            match update_result {
                Ok(_) => {}
                Err(NoteUpdateError::VaultNotUnlocked) => {}
                Err(other) => panic!("unexpected update outcome: {other:?}"),
            }
        });
    }

    // ---- error_kind label ------------------------------------------------

    #[test]
    fn update_error_kind_label_covers_every_variant() {
        use crate::io_failure_kind::IoFailureKind;
        assert_eq!(
            note_update_error_kind(&NoteUpdateError::VaultNotUnlocked),
            "VaultNotUnlocked"
        );
        assert_eq!(
            note_update_error_kind(&NoteUpdateError::InvalidNoteId),
            "InvalidNoteId"
        );
        assert_eq!(
            note_update_error_kind(&NoteUpdateError::NoteNotFound),
            "NoteNotFound"
        );
        assert_eq!(
            note_update_error_kind(&NoteUpdateError::PlaintextTooLarge),
            "PlaintextTooLarge"
        );
        assert_eq!(
            note_update_error_kind(&NoteUpdateError::CannotDecrypt),
            "CannotDecrypt"
        );
        assert_eq!(
            note_update_error_kind(&NoteUpdateError::NotesDirNotADirectory),
            "NotesDirNotADirectory"
        );
        assert_eq!(
            note_update_error_kind(&NoteUpdateError::Io {
                io_error_kind: IoFailureKind::Other,
            }),
            "Io"
        );
        assert_eq!(
            note_update_error_kind(&NoteUpdateError::JoinFailure),
            "JoinFailure"
        );
    }

    // =====================================================================
    // note_delete
    // =====================================================================

    // ---- happy path: round-trip create + delete + read NoteNotFound ----

    #[test]
    fn round_trip_create_then_delete_then_read_returns_note_not_found() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-delete-roundtrip").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "to be deleted".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            // Confirm file exists pre-delete.
            let path = notes_dir.join(format!(
                "{}.myn",
                NoteId::parse(&note_id_str).unwrap().as_uuid()
            ));
            assert!(path.is_file(), "file must exist pre-delete");

            note_delete_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                note_id_str.clone(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("delete must succeed on a fresh note");

            // File is gone (cryptographic erase yapısal: enc_item_key
            // lived inside the .myn; unlink removes both ciphertext and
            // wrapped key in one operation).
            assert!(!path.exists(), "file must be removed post-delete");

            // Subsequent read returns NoteNotFound — the ledger / editor
            // route's natural affordance for a deleted note.
            let read_result = note_read_with_dir(
                notes_dir,
                &state,
                note_id_str,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(read_result, Err(NoteReadError::NoteNotFound)));
        });
    }

    // ---- idempotent contract: second delete returns NoteNotFound -------

    #[test]
    fn double_delete_returns_note_not_found_on_second_call() {
        // Strict at IPC, idempotent at UI — `decisions.md` 2026-05-07
        // "Note delete UX". Pin the IPC-side strictness here; the UI
        // fold to "note already gone" is editor-side and not in scope.
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-delete-idempotent").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "transient".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            note_delete_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                note_id_str.clone(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("first delete must succeed");

            let second = note_delete_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                note_id_str,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(second, Err(NoteDeleteError::NoteNotFound)));
        });
    }

    // ---- NoteNotFound: valid v7 UUID, no file --------------------------

    #[test]
    fn delete_note_not_found_for_valid_id_with_no_file() {
        // Autosave-after-delete race + cross-tab race: ledger view
        // deletes a note while the editor is still open; the editor's
        // subsequent close-prompt-driven delete call hits this path.
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-delete-not-found").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let phantom = NoteId::new_v7();
            let result = note_delete_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                phantom.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteDeleteError::NoteNotFound)));
        });
    }

    // ---- slot guards ----------------------------------------------------

    #[test]
    fn delete_slot_empty_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-delete-slot-empty").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();

            let result = note_delete_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteDeleteError::VaultNotUnlocked)));
        });
    }

    #[test]
    fn delete_slot_recovering_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-delete-slot-recovering").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;

            let result = note_delete_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteDeleteError::VaultNotUnlocked)));
        });
    }

    // ---- strict NoteId parse rejects -----------------------------------

    #[test]
    fn delete_invalid_note_id_returns_invalid_note_id() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-delete-invalid-id").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let result = note_delete_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                "too-short".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteDeleteError::InvalidNoteId)));
        });
    }

    // ---- defensive: notes_dir is a regular file ------------------------

    #[test]
    fn delete_notes_dir_not_a_directory_defensive_canary() {
        // Inner `note_delete_with_dir` takes `notes_dir` already
        // resolved; the outer `note_delete` maps `paths::notes_dir`
        // failures upstream. Here we exercise the spawn_blocking-side
        // defensive check directly: pass a path that resolves to a
        // regular file rather than a directory.
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-delete-notes-is-file").unwrap();
            let bogus_notes_dir = scratch.path().join("notes");
            std::fs::write(&bogus_notes_dir, b"hostile content").unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let phantom = NoteId::new_v7();
            let result = note_delete_with_dir(
                bogus_notes_dir,
                &state,
                &noop_hooks(),
                phantom.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(
                result,
                Err(NoteDeleteError::NotesDirNotADirectory)
            ));
        });
    }

    // ---- concurrent vault_lock fair-queue --------------------------------

    #[test]
    fn delete_concurrent_with_vault_lock_completes_cleanly() {
        // Mirror of `note_create_concurrent_with_vault_lock_completes_cleanly`
        // and the update equivalent. Both task orderings produce a
        // valid `Slot::Empty` terminal state; delete's outcome depends
        // on which task acquired its lock first.
        rt().block_on(async {
            use std::sync::Arc;

            let scratch = ScopedTempDir::new("note-delete-concurrent-lock").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = Arc::new(VaultRuntimeState::default());
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "to be deleted".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let delete_state = Arc::clone(&state);
            let delete_dir = notes_dir.clone();
            let delete_id = note_id_str.clone();
            let delete_task = tokio::spawn(async move {
                note_delete_with_dir(
                    delete_dir,
                    &delete_state,
                    &noop_hooks(),
                    delete_id,
                    &myne_core::vault_io::StdVaultIo,
                    &myne_core::host::NoopHost,
                )
                .await
            });

            tokio::task::yield_now().await;

            let lock_state = Arc::clone(&state);
            let lock_task = tokio::spawn(async move { lock_state.take(test_vault_id()).await });

            let delete_result = delete_task.await.expect("delete task joins");
            let lock_taken = lock_task.await.expect("lock task joins");

            assert!(
                matches!(
                    lock_taken,
                    crate::plugins::vault_unlock::state::Slot::Unlocked(_)
                ),
                "lock must take the Unlocked variant"
            );
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
            );

            //   - `Ok(())`                      → delete ran first; lock
            //                                     waited for the read guard.
            //   - `Err(VaultNotUnlocked)`       → lock ran first; delete
            //                                     observed `Slot::Empty`.
            match delete_result {
                Ok(()) => {}
                Err(NoteDeleteError::VaultNotUnlocked) => {}
                Err(other) => panic!("unexpected delete outcome: {other:?}"),
            }
        });
    }

    // ---- error_kind label ------------------------------------------------

    #[test]
    fn delete_error_kind_label_covers_every_variant() {
        use crate::io_failure_kind::IoFailureKind;
        assert_eq!(
            note_delete_error_kind(&NoteDeleteError::VaultNotUnlocked),
            "VaultNotUnlocked"
        );
        assert_eq!(
            note_delete_error_kind(&NoteDeleteError::InvalidNoteId),
            "InvalidNoteId"
        );
        assert_eq!(
            note_delete_error_kind(&NoteDeleteError::NoteNotFound),
            "NoteNotFound"
        );
        assert_eq!(
            note_delete_error_kind(&NoteDeleteError::NotesDirNotADirectory),
            "NotesDirNotADirectory"
        );
        assert_eq!(
            note_delete_error_kind(&NoteDeleteError::Io {
                io_error_kind: IoFailureKind::Other,
            }),
            "Io"
        );
        assert_eq!(
            note_delete_error_kind(&NoteDeleteError::JoinFailure),
            "JoinFailure"
        );
    }

    // ---- enumerate_notes_dir tests ---------------------------------------

    #[test]
    fn list_with_dir_empty_directory_returns_empty_vec() {
        let tmp = ScopedTempDir::new("list-empty").unwrap();
        let notes_dir = notes_dir_under(tmp.path()).unwrap();

        let result = enumerate_notes_dir(&notes_dir).unwrap();

        assert!(result.is_empty(), "empty notes/ must return empty Vec");
    }

    #[test]
    fn list_with_dir_three_valid_files_returns_all_sorted() {
        let tmp = ScopedTempDir::new("list-three").unwrap();
        let notes_dir = notes_dir_under(tmp.path()).unwrap();

        let stems = [
            "01970e83-4f2f-7000-8000-000000000001",
            "01970e84-4f2f-7000-8000-000000000002",
            "01970e85-4f2f-7000-8000-000000000003",
        ];
        for stem in stems {
            std::fs::write(notes_dir.join(format!("{stem}.myn")), b"\0").unwrap();
        }

        let result = enumerate_notes_dir(&notes_dir).unwrap();

        assert_eq!(result.len(), 3);
        let result_strs: Vec<String> = result.iter().map(|id| format!("{id}")).collect();
        assert_eq!(result_strs, stems.to_vec());
    }

    #[test]
    fn list_with_dir_reversed_insertion_order_still_returns_sorted() {
        // Cross-platform determinism pin: writing files in descending UUID
        // order must NOT yield a descending Vec. The backend sort is what
        // makes `Vec<NoteId>` honest as a sorted contract — POSIX `readdir`
        // order is unspecified per platform.
        let tmp = ScopedTempDir::new("list-reversed").unwrap();
        let notes_dir = notes_dir_under(tmp.path()).unwrap();

        let stems_descending = [
            "01970e85-4f2f-7000-8000-000000000003",
            "01970e84-4f2f-7000-8000-000000000002",
            "01970e83-4f2f-7000-8000-000000000001",
        ];
        for stem in stems_descending {
            std::fs::write(notes_dir.join(format!("{stem}.myn")), b"\0").unwrap();
        }

        let result = enumerate_notes_dir(&notes_dir).unwrap();
        let result_strs: Vec<String> = result.iter().map(|id| format!("{id}")).collect();

        assert_eq!(
            result_strs,
            vec![
                "01970e83-4f2f-7000-8000-000000000001",
                "01970e84-4f2f-7000-8000-000000000002",
                "01970e85-4f2f-7000-8000-000000000003",
            ]
        );
    }

    #[test]
    fn list_with_dir_silently_skips_non_myn_orphan_files() {
        let tmp = ScopedTempDir::new("list-orphan").unwrap();
        let notes_dir = notes_dir_under(tmp.path()).unwrap();

        let valid_stem = "01970e83-4f2f-7000-8000-000000000001";
        std::fs::write(notes_dir.join(format!("{valid_stem}.myn")), b"\0").unwrap();
        std::fs::write(notes_dir.join(".DS_Store"), b"\0").unwrap();
        std::fs::write(notes_dir.join("random.txt"), b"hello").unwrap();
        std::fs::write(notes_dir.join("temp.tmp"), b"\0").unwrap();

        let result = enumerate_notes_dir(&notes_dir).unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(format!("{}", result[0]), valid_stem);
        // Tracing-level assertion (skip_orphan debug events fired exactly
        // 3 times) is Task 3's responsibility.
    }

    #[test]
    fn list_with_dir_silently_skips_myn_files_with_malformed_uuid_stem() {
        let tmp = ScopedTempDir::new("list-malformed").unwrap();
        let notes_dir = notes_dir_under(tmp.path()).unwrap();

        let valid_stem = "01970e83-4f2f-7000-8000-000000000001";
        std::fs::write(notes_dir.join(format!("{valid_stem}.myn")), b"\0").unwrap();
        // v4 UUID — passes char/length/hyphen filters but `NoteId::parse`
        // rejects with `WrongVersion`.
        std::fs::write(
            notes_dir.join("550e8400-e29b-41d4-a716-446655440000.myn"),
            b"\0",
        )
        .unwrap();
        // Outright not a UUID — fails on hyphen positions.
        std::fs::write(notes_dir.join("not-a-uuid-at-all-stem-here.myn"), b"\0").unwrap();
        // Uppercase canonical form — rejected by `InvalidChar`.
        std::fs::write(
            notes_dir.join("01970E83-4F2F-7000-8000-000000000002.myn"),
            b"\0",
        )
        .unwrap();

        let result = enumerate_notes_dir(&notes_dir).unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(format!("{}", result[0]), valid_stem);
        // Tracing-level assertion (skip_malformed_uuid warn events fired
        // exactly 3 times) is Task 3's responsibility.
    }

    // ---- note_list_with_dir integration tests --------------------------
    //
    // These tests exercise the async slot-guarded wrapper (Task 4) — the
    // outer `note_list` Tauri command's path-resolution layer is covered
    // via `paths::tests::notes_dir_under_*` (the `<parent>/notes is a
    // file` boundary). The wrapper layer is the meaningful coverage
    // target: slot guard + `spawn_blocking` + io-error mapping +
    // success-path tracing event.

    #[test]
    fn note_list_with_dir_empty_unlocked_returns_empty_vec() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-list-empty-unlocked").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let result = note_list_with_dir(
                notes_dir,
                &state,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Ok(ref v) if v.is_empty()));
        });
    }

    #[test]
    fn note_list_with_dir_three_valid_files_unlocked_returns_sorted() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-list-three-unlocked").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let stems_descending = [
                "01970e85-4f2f-7000-8000-000000000003",
                "01970e84-4f2f-7000-8000-000000000002",
                "01970e83-4f2f-7000-8000-000000000001",
            ];
            for stem in stems_descending {
                std::fs::write(notes_dir.join(format!("{stem}.myn")), b"\0").unwrap();
            }

            let ids = note_list_with_dir(
                notes_dir,
                &state,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let id_strs: Vec<String> = ids.iter().map(|id| format!("{id}")).collect();
            assert_eq!(
                id_strs,
                vec![
                    "01970e83-4f2f-7000-8000-000000000001",
                    "01970e84-4f2f-7000-8000-000000000002",
                    "01970e85-4f2f-7000-8000-000000000003",
                ]
            );
        });
    }

    #[test]
    fn note_list_with_dir_slot_empty_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-list-slot-empty").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default(); // Slot::Empty by default

            let result = note_list_with_dir(
                notes_dir,
                &state,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteListError::VaultNotUnlocked)));
        });
    }

    #[test]
    fn note_list_with_dir_slot_recovering_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-list-slot-recovering").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;

            let result = note_list_with_dir(
                notes_dir,
                &state,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteListError::VaultNotUnlocked)));
        });
    }

    #[test]
    fn note_list_with_dir_path_is_file_returns_notes_dir_not_a_directory() {
        // Pass a regular-file path as `notes_dir` — `read_dir` errors
        // with `NotADirectory` and the wrapper's map_err routes it to
        // the structural variant. This is the test-seam-layer pin for
        // the `notes_dir_under` boundary; the outer `note_list` Tauri
        // command's path-resolution map_err lands the same variant
        // before reaching the wrapper.
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-list-notes-as-file").unwrap();
            let conflict = scratch.path().join("notes-as-file");
            std::fs::write(&conflict, b"hostile").unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let result = note_list_with_dir(
                conflict,
                &state,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteListError::NotesDirNotADirectory)));
        });
    }

    #[test]
    fn note_list_concurrent_with_vault_lock_completes_cleanly() {
        // Mirrors `note_create_concurrent_with_vault_lock_completes_cleanly` /
        // `update_concurrent_with_vault_lock_completes_cleanly` /
        // `delete_concurrent_with_vault_lock_completes_cleanly`. Under
        // multi-thread scheduling, an in-flight `note_list_with_dir`
        // and a concurrent `state.take()` (the inner of `vault_lock`)
        // both complete without deadlock. Two terminal outcomes are
        // valid:
        //   - `Ok(_)`                       → list ran first; lock
        //                                     waited for the read guard.
        //   - `Err(VaultNotUnlocked)`       → lock ran first; list
        //                                     observed `Slot::Empty`.
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-list-concurrent-lock").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = std::sync::Arc::new(VaultRuntimeState::default());
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            // Pre-populate so the list does real work.
            for stem in [
                "01970e83-4f2f-7000-8000-000000000001",
                "01970e84-4f2f-7000-8000-000000000002",
            ] {
                std::fs::write(notes_dir.join(format!("{stem}.myn")), b"\0").unwrap();
            }

            let list_state = std::sync::Arc::clone(&state);
            let list_dir = notes_dir.clone();
            let list_task = tokio::spawn(async move {
                note_list_with_dir(
                    list_dir,
                    &list_state,
                    &myne_core::vault_io::StdVaultIo,
                    &myne_core::host::NoopHost,
                )
                .await
            });

            tokio::task::yield_now().await;

            let lock_state = std::sync::Arc::clone(&state);
            let lock_task = tokio::spawn(async move { lock_state.take(test_vault_id()).await });

            let list_result = list_task.await.expect("list task joins");
            let lock_taken = lock_task.await.expect("lock task joins");

            assert!(
                matches!(
                    lock_taken,
                    crate::plugins::vault_unlock::state::Slot::Unlocked(_)
                ),
                "lock must take the Unlocked variant"
            );
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
            );

            match list_result {
                Ok(_) => {}
                Err(NoteListError::VaultNotUnlocked) => {}
                Err(other) => panic!("unexpected list outcome: {other:?}"),
            }
        });
    }

    #[test]
    fn list_error_kind_label_covers_every_variant() {
        use crate::io_failure_kind::IoFailureKind;
        assert_eq!(
            note_list_error_kind(&NoteListError::VaultNotUnlocked),
            "VaultNotUnlocked"
        );
        assert_eq!(
            note_list_error_kind(&NoteListError::NotesDirNotADirectory),
            "NotesDirNotADirectory"
        );
        assert_eq!(
            note_list_error_kind(&NoteListError::Io {
                io_error_kind: IoFailureKind::Other,
            }),
            "Io"
        );
        assert_eq!(
            note_list_error_kind(&NoteListError::JoinFailure),
            "JoinFailure"
        );
    }

    // =====================================================================
    // note_titles_batch
    // =====================================================================

    async fn make_unlocked_state_and_dir(
        slug: &str,
    ) -> (ScopedTempDir, PathBuf, VaultRuntimeState) {
        let scratch = ScopedTempDir::new(slug).unwrap();
        let notes_dir = notes_dir_under(scratch.path()).unwrap();
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ),
            )
            .await;
        (scratch, notes_dir, state)
    }

    async fn create_note_with(
        notes_dir: &Path,
        state: &VaultRuntimeState,
        plaintext: &str,
    ) -> String {
        note_create_with_dir(
            notes_dir.to_path_buf(),
            state,
            plaintext.to_string(),
            &myne_core::vault_io::StdVaultIo,
            &myne_core::host::NoopHost,
        )
        .await
        .expect("note_create must succeed in test setup")
    }

    // ---- happy path: mixed FM / H1 / both / neither --------------------

    #[test]
    fn batch_returns_per_item_slices_in_input_order() {
        rt().block_on(async {
            let (_scratch, notes_dir, state) = make_unlocked_state_and_dir("nt-batch-happy").await;

            // Four notes with distinct shapes.
            let id_a = create_note_with(&notes_dir, &state, "# Heading A\nbody a").await;
            let id_b = create_note_with(
                &notes_dir,
                &state,
                "---\ntitle: B Title\nupdated: 2026-01-01T00:00:00Z\n---\n\nbody b\n",
            )
            .await;
            let id_c = create_note_with(
                &notes_dir,
                &state,
                "---\ntags: [x]\n---\n\n# Heading C\nbody c\n",
            )
            .await;
            let id_d = create_note_with(&notes_dir, &state, "no heading, no fm\njust body\n").await;

            // Input order: B, D, A, C — verifies output ordering matches.
            let ids = vec![id_b.clone(), id_d.clone(), id_a.clone(), id_c.clone()];
            let results = note_titles_batch_with_dir(
                notes_dir,
                &state,
                ids.clone(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("batch must succeed at outer level");

            assert_eq!(results.len(), 4);
            // Position 0 — id_b (FM with title).
            let r0 = results[0].as_ref().expect("position 0 must be Ok");
            assert_eq!(r0.note_uuid, id_b);
            assert_eq!(
                r0.frontmatter_bytes.as_deref(),
                Some("title: B Title\nupdated: 2026-01-01T00:00:00Z\n")
            );
            assert!(r0.first_h1_line.is_none());
            // Position 1 — id_d (no fm, no h1).
            let r1 = results[1].as_ref().expect("position 1 must be Ok");
            assert_eq!(r1.note_uuid, id_d);
            assert!(r1.frontmatter_bytes.is_none());
            assert!(r1.first_h1_line.is_none());
            // Position 2 — id_a (H1 only).
            let r2 = results[2].as_ref().expect("position 2 must be Ok");
            assert_eq!(r2.note_uuid, id_a);
            assert!(r2.frontmatter_bytes.is_none());
            assert_eq!(r2.first_h1_line.as_deref(), Some("# Heading A"));
            // Position 3 — id_c (FM + H1).
            let r3 = results[3].as_ref().expect("position 3 must be Ok");
            assert_eq!(r3.note_uuid, id_c);
            assert_eq!(r3.frontmatter_bytes.as_deref(), Some("tags: [x]\n"));
            assert_eq!(r3.first_h1_line.as_deref(), Some("# Heading C"));
        });
    }

    // ---- cap exceeded --------------------------------------------------

    #[test]
    fn batch_cap_exceeded_returns_batch_too_large_with_cap_payload() {
        rt().block_on(async {
            let (_scratch, notes_dir, state) = make_unlocked_state_and_dir("nt-batch-cap").await;

            // 101 fake IDs — cap is 100 per NOTE_TITLES_BATCH_CAP.
            let ids: Vec<String> = (0..101)
                .map(|_| "00000000-0000-7000-8000-000000000000".to_string())
                .collect();
            let result = note_titles_batch_with_dir(
                notes_dir,
                &state,
                ids,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            match result {
                Err(NoteTitleBatchError::BatchTooLarge { cap }) => {
                    assert_eq!(cap, NOTE_TITLES_BATCH_CAP);
                }
                other => panic!("expected BatchTooLarge, got {other:?}"),
            }
        });
    }

    #[test]
    fn batch_at_cap_succeeds() {
        rt().block_on(async {
            let (_scratch, notes_dir, state) = make_unlocked_state_and_dir("nt-batch-at-cap").await;

            // Create one real note + pad with malformed IDs to reach the cap.
            // Per-item NoteNotFound for the malformed slots, Ok for the real.
            let real_id = create_note_with(&notes_dir, &state, "# At cap\n").await;
            let mut ids: Vec<String> = vec![real_id.clone()];
            for _ in 0..(NOTE_TITLES_BATCH_CAP - 1) {
                ids.push("not-a-uuid".to_string());
            }
            assert_eq!(ids.len(), NOTE_TITLES_BATCH_CAP);

            let results = note_titles_batch_with_dir(
                notes_dir,
                &state,
                ids,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("at-cap batch must succeed at outer level");
            assert_eq!(results.len(), NOTE_TITLES_BATCH_CAP);
            assert!(results[0].is_ok(), "real ID at position 0 must succeed");
            for (i, r) in results.iter().enumerate().skip(1) {
                assert!(
                    matches!(r, Err(NoteTitleError::NoteNotFound)),
                    "position {i} expected NoteNotFound, got {r:?}"
                );
            }
        });
    }

    // ---- slot guards ---------------------------------------------------

    #[test]
    fn batch_slot_empty_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("nt-batch-slot-empty").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default(); // Slot::Empty by default
            let result = note_titles_batch_with_dir(
                notes_dir,
                &state,
                vec![],
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteTitleBatchError::VaultNotUnlocked)));
        });
    }

    #[test]
    fn batch_slot_recovering_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("nt-batch-slot-recovering").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;
            let result = note_titles_batch_with_dir(
                notes_dir,
                &state,
                vec![],
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(NoteTitleBatchError::VaultNotUnlocked)));
        });
    }

    // ---- per-item failure modes ---------------------------------------

    #[test]
    fn batch_per_item_missing_file_surfaces_note_not_found() {
        rt().block_on(async {
            let (_scratch, notes_dir, state) =
                make_unlocked_state_and_dir("nt-batch-missing").await;

            // Create one note, then delete it BEFORE the batch — simulates the
            // note_list / note_titles_batch race.
            let id = create_note_with(&notes_dir, &state, "# Will vanish\n").await;
            let note_id = NoteId::parse(&id).unwrap();
            std::fs::remove_file(notes_dir.join(format!("{}.myn", note_id.as_uuid()))).unwrap();

            let results = note_titles_batch_with_dir(
                notes_dir,
                &state,
                vec![id.clone()],
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("outer must succeed");
            assert_eq!(results.len(), 1);
            assert!(matches!(results[0], Err(NoteTitleError::NoteNotFound)));
        });
    }

    #[test]
    fn batch_per_item_malformed_id_surfaces_note_not_found() {
        rt().block_on(async {
            let (_scratch, notes_dir, state) =
                make_unlocked_state_and_dir("nt-batch-malformed-id").await;
            let results = note_titles_batch_with_dir(
                notes_dir,
                &state,
                vec!["not-a-valid-uuid".to_string()],
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("outer must succeed");
            assert_eq!(results.len(), 1);
            assert!(matches!(results[0], Err(NoteTitleError::NoteNotFound)));
        });
    }

    #[test]
    fn batch_empty_input_returns_empty_results() {
        rt().block_on(async {
            let (_scratch, notes_dir, state) = make_unlocked_state_and_dir("nt-batch-empty").await;
            let results = note_titles_batch_with_dir(
                notes_dir,
                &state,
                vec![],
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("empty batch must succeed");
            assert!(results.is_empty());
        });
    }

    // ---- error_kind labels --------------------------------------------

    #[test]
    fn title_error_kind_label_covers_every_variant() {
        use crate::io_failure_kind::IoFailureKind;
        assert_eq!(
            note_title_error_kind(&NoteTitleError::CannotDecrypt),
            "CannotDecrypt"
        );
        assert_eq!(
            note_title_error_kind(&NoteTitleError::NoteNotFound),
            "NoteNotFound"
        );
        assert_eq!(
            note_title_error_kind(&NoteTitleError::Io {
                io_error_kind: IoFailureKind::Other,
            }),
            "Io"
        );
        assert_eq!(
            note_title_error_kind(&NoteTitleError::JoinFailure),
            "JoinFailure"
        );
    }

    #[test]
    fn title_batch_error_kind_label_covers_every_variant() {
        use crate::io_failure_kind::IoFailureKind;
        assert_eq!(
            note_title_batch_error_kind(&NoteTitleBatchError::VaultNotUnlocked),
            "VaultNotUnlocked"
        );
        assert_eq!(
            note_title_batch_error_kind(&NoteTitleBatchError::NotesDirNotADirectory),
            "NotesDirNotADirectory"
        );
        assert_eq!(
            note_title_batch_error_kind(&NoteTitleBatchError::BatchTooLarge { cap: 100 }),
            "BatchTooLarge"
        );
        assert_eq!(
            note_title_batch_error_kind(&NoteTitleBatchError::Io {
                io_error_kind: IoFailureKind::Other,
            }),
            "Io"
        );
        assert_eq!(
            note_title_batch_error_kind(&NoteTitleBatchError::JoinFailure),
            "JoinFailure"
        );
    }

    // ---- note_search (MYND-29 Task 5) -----------------------------------

    #[test]
    fn note_search_returns_ranked_results_when_unlocked() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;
            let search = SearchIndexState::default();
            search.upsert("note-a", "Rust Guide", "rust async runtime");
            let results = note_search_core(&state, &search, "rust").await;
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].note_id, "note-a");
            assert_eq!(results[0].title, "Rust Guide");
        });
    }

    #[test]
    fn note_search_returns_empty_when_locked() {
        rt().block_on(async {
            // Slot Empty (locked): even with a populated index, the gate
            // returns empty — no leak.
            let state = VaultRuntimeState::default();
            let search = SearchIndexState::default();
            search.upsert("note-a", "t", "rust");
            assert!(note_search_core(&state, &search, "rust").await.is_empty());
        });
    }

    #[test]
    fn note_search_returns_empty_when_recovering() {
        rt().block_on(async {
            // Recovering is gated out for note ops (recovery-flow.md §4.1);
            // search gates it too.
            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;
            let search = SearchIndexState::default();
            search.upsert("note-a", "t", "rust");
            assert!(note_search_core(&state, &search, "rust").await.is_empty());
        });
    }

    #[test]
    fn note_search_caps_results_at_top_n() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;
            let search = SearchIndexState::default();
            // More matching notes than the cap → the result set must be bounded.
            for i in 0..(NOTE_SEARCH_RESULT_CAP + 5) {
                search.upsert(&format!("note-{i:03}"), "rust note", "rust body text");
            }
            let results = note_search_core(&state, &search, "rust").await;
            assert_eq!(results.len(), NOTE_SEARCH_RESULT_CAP);
            // BM25-ordered: scores are non-increasing across the capped set.
            assert!(results.windows(2).all(|w| w[0].score >= w[1].score));
        });
    }

    #[test]
    fn note_search_reports_matched_in_field() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;
            let search = SearchIndexState::default();
            search.upsert("title-hit", "rust guide", "lorem ipsum");
            search.upsert("body-hit", "notes", "rust async");
            let results = note_search_core(&state, &search, "rust").await;
            let title_hit = results
                .iter()
                .find(|r| r.note_id == "title-hit")
                .expect("title-hit present");
            let body_hit = results
                .iter()
                .find(|r| r.note_id == "body-hit")
                .expect("body-hit present");
            assert!(title_hit.matched_in.title && !title_hit.matched_in.body);
            assert!(body_hit.matched_in.body && !body_hit.matched_in.title);
        });
    }

    // ---- multi-slot active-vault resolution (MYND-203 sub-feature 3) -----
    //
    // The note-CRUD commands carry NO `vault_id` IPC parameter; they resolve
    // the active (sole `Unlocked`) vault internally via `slot_read_active()`.
    // These two tests pin that seam at the CRUD layer: (a) a command with no
    // vault_id operates on whichever vault is the sole `Unlocked` entry — even
    // when that key is NOT the legacy sentinel `slot_read_active()` falls back
    // to when nothing is unlocked — and (b) with no vault unlocked the command
    // returns the clean `VaultNotUnlocked` guard error and does not panic.

    #[test]
    fn note_create_resolves_to_sole_unlocked_vault_without_vault_id() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-create-active-resolve").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            // Unlock under a NON-legacy id (`test_vault_id_b`, i.e. a
            // `vaults/<uuid>/`-style key), deliberately different from the
            // legacy sentinel `slot_read_active()` keys when no vault is
            // unlocked. If the CRUD seam keyed a hardcoded id instead of
            // resolving the active vault, this `note_create` would observe
            // an EMPTY slot and reject — so a successful create + round-trip
            // proves active-vault resolution.
            state
                .set_unlocked(
                    test_vault_id_b(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            let plaintext = "# active vault\nresolved with no vault_id param";
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                plaintext.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("note_create must operate on the sole Unlocked vault");

            // Round-trip read (also no vault_id param) returns the same body —
            // confirming both the create and read seams resolved the active
            // vault and used its `items_key`.
            let read_back = note_read_with_dir(
                notes_dir,
                &state,
                id,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("note_read must operate on the sole Unlocked vault");
            assert_eq!(read_back, plaintext);
        });
    }

    #[test]
    fn note_create_with_no_vault_unlocked_returns_clean_guard_no_panic() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-create-no-unlocked").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            // Empty slot map: NO vault unlocked or recovering. `active_vault_id`
            // resolves `None`, `slot_read_active` keys an absent entry and the
            // guard `Deref`s to `Slot::Empty`. The CRUD command must take the
            // clean guard branch (`VaultNotUnlocked`) — never panic / unwrap.
            let state = VaultRuntimeState::default();

            let result = note_create_with_dir(
                notes_dir,
                &state,
                "x".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await;
            assert!(
                matches!(result, Err(NoteCreateError::VaultNotUnlocked)),
                "no unlocked vault must yield the clean guard error, got {result:?}"
            );
        });
    }

    // =====================================================================
    // note_export_as_markdown (MYND-115)
    // =====================================================================

    /// Fixture body deliberately stressing the verbatim contract:
    /// frontmatter block, trailing whitespace on a line, markdown
    /// escapes, a literal CRLF, and NO trailing newline — the export
    /// must reproduce every byte without normalization.
    const EXPORT_FIXTURE_PLAINTEXT: &str = "---\ntitle: Exported Note\nupdated: 2026-06-11T10:00:00Z\n---\n\n# Heading\n\nbody with \\*escapes\\* and trailing spaces   \nliteral CRLF here\r\n\ttab-indented last line, no trailing newline";

    /// Set up an unlocked-state scratch vault with one note containing
    /// [`EXPORT_FIXTURE_PLAINTEXT`]; returns (scratch, notes_dir, state,
    /// note_id_str).
    async fn export_fixture() -> (ScopedTempDir, PathBuf, VaultRuntimeState, String) {
        let scratch = ScopedTempDir::new("note-export").unwrap();
        let notes_dir = notes_dir_under(scratch.path()).unwrap();
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ),
            )
            .await;
        let note_id_str = note_create_with_dir(
            notes_dir.clone(),
            &state,
            EXPORT_FIXTURE_PLAINTEXT.to_string(),
            &myne_core::vault_io::StdVaultIo,
            &myne_core::host::NoopHost,
        )
        .await
        .expect("fixture note create must succeed");
        (scratch, notes_dir, state, note_id_str)
    }

    // ---- happy path: verbatim byte identity -----------------------------

    #[test]
    fn export_writes_bytes_identical_to_stored_plaintext() {
        rt().block_on(async {
            let (scratch, notes_dir, state, note_id_str) = export_fixture().await;
            // overwrite=false + absent target → writes (the false+absent
            // arm of the overwrite matrix rides the happy path).
            let target = scratch.path().join("exported.md");

            note_export_with_dir(notes_dir, &state, note_id_str, target.clone(), false)
                .await
                .expect("export to an absent target must succeed");

            let on_disk = std::fs::read(&target).unwrap();
            assert_eq!(
                on_disk,
                EXPORT_FIXTURE_PLAINTEXT.as_bytes(),
                "exported bytes must be identical to the stored plaintext"
            );
            // No temp sibling left behind on the success path either
            // (naming-agnostic: the unclobbered helper's temps are
            // randomized `<name>.<pid>-<n>.tmp` siblings).
            assert!(no_tmp_residue(scratch.path()));
        });
    }

    /// `true` when `dir` holds no `*.tmp`-suffixed entry — the
    /// naming-agnostic temp-residue probe (covers both the legacy
    /// `<name>.tmp` shape and the unclobbered `<name>.<pid>-<n>.tmp`
    /// shape).
    fn no_tmp_residue(dir: &Path) -> bool {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .all(|e| !e.file_name().to_string_lossy().ends_with(".tmp"))
    }

    // ---- overwrite matrix ------------------------------------------------

    #[test]
    fn export_overwrite_false_existing_target_rejects_and_leaves_target_untouched() {
        rt().block_on(async {
            let (scratch, notes_dir, state, note_id_str) = export_fixture().await;
            let target = scratch.path().join("exported.md");
            std::fs::write(&target, b"sentinel: pre-existing bytes").unwrap();

            let result =
                note_export_with_dir(notes_dir, &state, note_id_str, target.clone(), false).await;
            assert!(matches!(result, Err(NoteExportError::TargetAlreadyExists)));

            // Target untouched (replace=false rejects BEFORE creating
            // the temp sibling) and no temp left behind.
            assert_eq!(
                std::fs::read(&target).unwrap(),
                b"sentinel: pre-existing bytes"
            );
            assert!(no_tmp_residue(scratch.path()));
        });
    }

    #[test]
    fn export_overwrite_true_replaces_existing_target() {
        rt().block_on(async {
            let (scratch, notes_dir, state, note_id_str) = export_fixture().await;
            let target = scratch.path().join("exported.md");
            std::fs::write(&target, b"sentinel: pre-existing bytes").unwrap();

            note_export_with_dir(notes_dir, &state, note_id_str, target.clone(), true)
                .await
                .expect("export with overwrite=true must replace");
            assert_eq!(
                std::fs::read(&target).unwrap(),
                EXPORT_FIXTURE_PLAINTEXT.as_bytes()
            );
        });
    }

    // ---- 115-F1: user file shaped like a temp sibling survives -----------

    /// A pre-existing USER file literally named `<target>.tmp` at the
    /// export destination must survive byte-identical through BOTH
    /// overwrite modes — the legacy fixed-temp-name `atomic_write`
    /// would have truncated it and renamed it over the target.
    #[test]
    fn export_preexisting_user_tmp_sibling_survives_both_overwrite_modes() {
        rt().block_on(async {
            let (scratch, notes_dir, state, note_id_str) = export_fixture().await;
            let target = scratch.path().join("exported.md");
            let user_tmp = scratch.path().join("exported.md.tmp");
            std::fs::write(&user_tmp, b"user file, not a temp").unwrap();

            // overwrite=false + absent target: export succeeds AROUND
            // the user file.
            note_export_with_dir(
                notes_dir.clone(),
                &state,
                note_id_str.clone(),
                target.clone(),
                false,
            )
            .await
            .expect("export must succeed");
            assert_eq!(
                std::fs::read(&target).unwrap(),
                EXPORT_FIXTURE_PLAINTEXT.as_bytes()
            );
            assert_eq!(std::fs::read(&user_tmp).unwrap(), b"user file, not a temp");

            // overwrite=true over the existing target: user file STILL
            // untouched.
            note_export_with_dir(notes_dir, &state, note_id_str, target.clone(), true)
                .await
                .expect("export with overwrite=true must succeed");
            assert_eq!(
                std::fs::read(&target).unwrap(),
                EXPORT_FIXTURE_PLAINTEXT.as_bytes()
            );
            assert_eq!(std::fs::read(&user_tmp).unwrap(), b"user file, not a temp");
        });
    }

    // ---- slot guards -----------------------------------------------------

    #[test]
    fn export_slot_empty_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-export-slot-empty").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            let target = scratch.path().join("exported.md");

            let result = note_export_with_dir(
                notes_dir,
                &state,
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                target.clone(),
                false,
            )
            .await;
            assert!(matches!(result, Err(NoteExportError::VaultNotUnlocked)));
            assert!(!target.exists());
        });
    }

    #[test]
    fn export_slot_recovering_rejects_with_vault_not_unlocked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-export-slot-recovering").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;
            let target = scratch.path().join("exported.md");

            let result = note_export_with_dir(
                notes_dir,
                &state,
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                target.clone(),
                false,
            )
            .await;
            assert!(matches!(result, Err(NoteExportError::VaultNotUnlocked)));
            assert!(!target.exists());
        });
    }

    // ---- strict NoteId parse before any fs touch -------------------------

    #[test]
    fn export_invalid_note_id_rejects_before_any_fs_touch() {
        rt().block_on(async {
            let (scratch, notes_dir, state, _note_id_str) = export_fixture().await;
            // Target under a MISSING parent: if the destination check (or
            // any fs touch) ran before the strict parse, this would surface
            // `InvalidDestination` instead of `InvalidNoteId`.
            let target = scratch.path().join("no-such-dir").join("exported.md");

            let result = note_export_with_dir(
                notes_dir,
                &state,
                "not-a-note-id".to_string(),
                target.clone(),
                true,
            )
            .await;
            assert!(matches!(result, Err(NoteExportError::InvalidNoteId)));
            assert!(!target.exists());
            assert!(!scratch.path().join("no-such-dir").exists());
        });
    }

    // ---- destination validation (backup precedent) -----------------------

    #[test]
    fn export_to_missing_parent_is_invalid_destination() {
        rt().block_on(async {
            let (scratch, notes_dir, state, note_id_str) = export_fixture().await;
            let target = scratch.path().join("no-such-dir").join("exported.md");

            let result =
                note_export_with_dir(notes_dir, &state, note_id_str, target.clone(), false).await;
            assert!(matches!(result, Err(NoteExportError::InvalidDestination)));
            assert!(!target.exists());
        });
    }

    #[test]
    fn export_to_parent_that_is_a_file_is_invalid_destination() {
        rt().block_on(async {
            let (scratch, notes_dir, state, note_id_str) = export_fixture().await;
            let not_a_dir = scratch.path().join("not-a-dir");
            std::fs::write(&not_a_dir, b"regular file").unwrap();
            let target = not_a_dir.join("exported.md");

            let result = note_export_with_dir(notes_dir, &state, note_id_str, target, false).await;
            assert!(matches!(result, Err(NoteExportError::InvalidDestination)));
        });
    }

    // ---- missing note ------------------------------------------------------

    #[test]
    fn export_missing_note_is_note_not_found() {
        rt().block_on(async {
            let (scratch, notes_dir, state, _note_id_str) = export_fixture().await;
            let target = scratch.path().join("exported.md");

            let result = note_export_with_dir(
                notes_dir,
                &state,
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                target.clone(),
                false,
            )
            .await;
            assert!(matches!(result, Err(NoteExportError::NoteNotFound)));
            assert!(!target.exists());
        });
    }

    // ---- post-AEAD UTF-8 boundary: never write garbage ---------------------

    #[test]
    fn export_non_utf8_plaintext_is_invalid_plaintext_encoding_and_writes_nothing() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-export-non-utf8").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;

            // Forge a valid v0.1 blob (AEAD verifies) whose plaintext is
            // not UTF-8 — same `_raw` surface as the `note_read` boundary
            // test above.
            let items_key = [FIXTURE_ITEMS_BYTE; 32];
            let items_key_id = [FIXTURE_ITEMS_ID_BYTE; 16];
            let bad_plaintext: &[u8] = &[0xFF, 0xFE];
            let (note_id, _path) = forge_note_blob_with_plaintext(
                &notes_dir,
                &items_key,
                &items_key_id,
                bad_plaintext,
            );
            let target = scratch.path().join("exported.md");

            let result = note_export_with_dir(
                notes_dir,
                &state,
                note_id.to_string(),
                target.clone(),
                false,
            )
            .await;
            assert!(matches!(
                result,
                Err(NoteExportError::InvalidPlaintextEncoding)
            ));
            // Corruption is surfaced, not exported: no target, no temp.
            assert!(!target.exists());
            assert!(no_tmp_residue(scratch.path()));
        });
    }

    // ---- corrupted blob: CannotDecrypt -------------------------------------

    #[test]
    fn export_corrupted_blob_is_cannot_decrypt_and_writes_nothing() {
        rt().block_on(async {
            let (scratch, notes_dir, state, note_id_str) = export_fixture().await;
            // Flip the last ciphertext byte → AEAD-tag failure.
            let note_id = NoteId::parse(&note_id_str).unwrap();
            let blob_path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
            let mut blob = std::fs::read(&blob_path).unwrap();
            let last = blob.len() - 1;
            blob[last] ^= 0xFF;
            std::fs::write(&blob_path, &blob).unwrap();
            let target = scratch.path().join("exported.md");

            let result =
                note_export_with_dir(notes_dir, &state, note_id_str, target.clone(), false).await;
            assert!(matches!(result, Err(NoteExportError::CannotDecrypt)));
            assert!(!target.exists());
        });
    }

    // ---- forced write failure: no temp sibling ------------------------------

    #[cfg(unix)]
    #[test]
    fn export_write_failure_leaves_no_temp_sibling() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let (scratch, notes_dir, state, note_id_str) = export_fixture().await;
            // Read-only destination directory: `atomic_write` fails at
            // temp-file creation (PermissionDenied) and must leave no
            // `.tmp` behind. (Same forcing approach as the read-only-dir
            // cases elsewhere; the `Fault` seam is private to
            // `atomic_write`'s own test mod.)
            let ro_dir = scratch.path().join("read-only");
            std::fs::create_dir(&ro_dir).unwrap();
            std::fs::set_permissions(&ro_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
            let target = ro_dir.join("exported.md");

            let result =
                note_export_with_dir(notes_dir, &state, note_id_str, target.clone(), false).await;

            // Restore perms BEFORE asserting so ScopedTempDir cleanup works
            // even if an assert fails.
            std::fs::set_permissions(&ro_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(matches!(
                result,
                Err(NoteExportError::Io {
                    io_error_kind: crate::io_failure_kind::IoFailureKind::PermissionDenied,
                })
            ));
            assert!(!target.exists());
            // No residue under either temp naming; in fact nothing at all
            // landed in the destination dir.
            assert_eq!(std::fs::read_dir(&ro_dir).unwrap().count(), 0);
        });
    }

    // ---- mtime fidelity (SYNC-13, task 3) ------------------------------------

    /// The epoch instant of [`EXPORT_FIXTURE_PLAINTEXT`]'s
    /// `updated: 2026-06-11T10:00:00Z` line.
    const EXPORT_FIXTURE_UPDATED_EPOCH: u64 = 1_781_172_000;

    fn mtime_epoch_secs(path: &Path) -> u64 {
        std::fs::metadata(path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn now_epoch_secs() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    #[test]
    fn export_sets_mtime_from_frontmatter_updated() {
        rt().block_on(async {
            let (scratch, notes_dir, state, note_id_str) = export_fixture().await;
            let target = scratch.path().join("exported.md");

            note_export_with_dir(notes_dir, &state, note_id_str, target.clone(), false)
                .await
                .expect("export must succeed");

            // ±5 s tolerance for coarse-mtime filesystems (FAT's 2 s
            // granularity etc.); `set_modified` itself is exact.
            let mtime = mtime_epoch_secs(&target);
            assert!(
                mtime.abs_diff(EXPORT_FIXTURE_UPDATED_EPOCH) <= 5,
                "exported file mtime ({mtime}) must equal the frontmatter \
                 updated: instant ({EXPORT_FIXTURE_UPDATED_EPOCH})"
            );
        });
    }

    #[test]
    fn export_without_updated_field_keeps_natural_export_time() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-export-mtime-absent").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;
            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# no frontmatter\nbody".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let target = scratch.path().join("exported.md");

            note_export_with_dir(notes_dir, &state, note_id_str, target.clone(), false)
                .await
                .unwrap();

            let mtime = mtime_epoch_secs(&target);
            assert!(
                mtime.abs_diff(now_epoch_secs()) <= 120,
                "absent updated: must leave the natural export time (~now), got {mtime}"
            );
        });
    }

    #[test]
    fn export_with_unparsable_updated_keeps_natural_export_time() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-export-mtime-bad").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(
                        FIXTURE_ROOT_BYTE,
                        FIXTURE_ITEMS_BYTE,
                        FIXTURE_ITEMS_ID_BYTE,
                    ),
                )
                .await;
            let note_id_str = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "---\nupdated: yesterday-ish\n---\n\nbody".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let target = scratch.path().join("exported.md");

            note_export_with_dir(notes_dir, &state, note_id_str, target.clone(), false)
                .await
                .unwrap();

            let mtime = mtime_epoch_secs(&target);
            assert!(
                mtime.abs_diff(now_epoch_secs()) <= 120,
                "unparsable updated: must leave the natural export time (~now), got {mtime}"
            );
        });
    }

    // mtime-set FAILURE non-fatality: not portably forcible at this layer
    // (the file was just created by us, so it is writable). Covered by
    // code structure instead — `export_mtime::apply_updated_mtime`
    // returns `()` (it cannot fail the export by construction) and its
    // missing-file no-op is pinned by
    // `export_mtime::tests::apply_on_missing_file_is_a_nonfatal_noop`.

    // ---- error_kind label ----------------------------------------------------

    #[test]
    fn export_error_kind_label_covers_every_variant() {
        use crate::io_failure_kind::IoFailureKind;
        assert_eq!(
            note_export_error_kind(&NoteExportError::VaultNotUnlocked),
            "VaultNotUnlocked"
        );
        assert_eq!(
            note_export_error_kind(&NoteExportError::InvalidNoteId),
            "InvalidNoteId"
        );
        assert_eq!(
            note_export_error_kind(&NoteExportError::NoteNotFound),
            "NoteNotFound"
        );
        assert_eq!(
            note_export_error_kind(&NoteExportError::CannotDecrypt),
            "CannotDecrypt"
        );
        assert_eq!(
            note_export_error_kind(&NoteExportError::InvalidPlaintextEncoding),
            "InvalidPlaintextEncoding"
        );
        assert_eq!(
            note_export_error_kind(&NoteExportError::InvalidDestination),
            "InvalidDestination"
        );
        assert_eq!(
            note_export_error_kind(&NoteExportError::TargetAlreadyExists),
            "TargetAlreadyExists"
        );
        assert_eq!(
            note_export_error_kind(&NoteExportError::Io {
                io_error_kind: IoFailureKind::Other,
            }),
            "Io"
        );
        assert_eq!(
            note_export_error_kind(&NoteExportError::JoinFailure),
            "JoinFailure"
        );
    }

    // =====================================================================
    // note_export_attachments (MYND-115 task 4)
    // =====================================================================

    use crate::plugins::attachments::commands::{attachment_import_with_dir, ImportSource};

    /// Sniffable fixture payloads (PNG magic / `%PDF-` magic) with
    /// distinct tails so distinct imports get distinct content-addressed
    /// ids.
    const ATT_PNG_A: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xA1, 0xA2];
    const ATT_PNG_B: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xB1, 0xB2];
    const ATT_PDF: &[u8] = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n";

    /// Seed a parse-passing `vault.meta` (the catalog AAD identity
    /// source) at the vault root — mirror of the attachments plugin's
    /// own test seeder.
    fn seed_export_vault_meta(vault_root: &Path) {
        let meta = protocol::VaultMeta {
            account_number_hash: [0x33; protocol::VAULT_META_ACCOUNT_HASH_LEN],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [7u8; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
            membership: None,
        };
        std::fs::write(
            vault_root.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed vault.meta");
    }

    /// Unlocked-state scratch vault wired for the attachments-included
    /// export: vault.meta + notes/ + an `out/` destination directory.
    /// Returns (scratch, state); the vault root is `scratch.path()` and
    /// the destination is `scratch.path()/out`.
    async fn export_att_fixture() -> (ScopedTempDir, VaultRuntimeState) {
        let scratch = ScopedTempDir::new("note-export-att").unwrap();
        seed_export_vault_meta(scratch.path());
        notes_dir_under(scratch.path()).unwrap();
        std::fs::create_dir(scratch.path().join("out")).unwrap();
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ),
            )
            .await;
        (scratch, state)
    }

    /// Import inline bytes as an attachment under the fixture vault and
    /// return the 64-hex content-addressed id.
    async fn import_att(
        vault_root: &Path,
        state: &VaultRuntimeState,
        bytes: &[u8],
        filename: &str,
    ) -> String {
        attachment_import_with_dir(
            &myne_core::vault_io::StdVaultIo,
            &myne_core::host::test_host::TestHost::new("/nonexistent-desktop-cmds-test-host"),
            vault_root,
            state,
            ImportSource::Bytes {
                bytes: bytes.to_vec(),
                filename: Some(filename.to_string()),
            },
        )
        .await
        .expect("fixture attachment import must succeed")
        .id
    }

    /// Non-recursive listing of the destination dir's entry names,
    /// sorted — the "nothing written" / side-by-side assertions.
    fn dir_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    // ---- happy path: side-by-side + sanctioned rewrite -------------------

    #[test]
    fn export_attachments_writes_note_and_attachments_side_by_side_with_rewritten_embeds() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            let id_png = import_att(&vault_root, &state, ATT_PNG_A, "photo.png").await;
            let id_pdf = import_att(&vault_root, &state, ATT_PDF, "doc.pdf").await;

            let plaintext = format!(
                "---\ntitle: T\nupdated: 2026-06-11T10:00:00Z\n---\n\nintro ![[att:{id_png}|photo.png]] mid\n![[att:{id_pdf}|doc.pdf]]\ntail, no trailing newline"
            );
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext.clone(),
            &myne_core::vault_io::StdVaultIo, &myne_core::host::NoopHost,)
            .await
            .unwrap();

            let count = note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await
            .expect("attachments-included export must succeed");
            assert_eq!(count, 2);

            // Attachments side-by-side under their catalog filenames,
            // decrypted byte-for-byte.
            assert_eq!(std::fs::read(out.join("photo.png")).unwrap(), ATT_PNG_A);
            assert_eq!(std::fs::read(out.join("doc.pdf")).unwrap(), ATT_PDF);

            // The exported note: byte-exact expected plaintext — embeds
            // rewritten to `![[<final-filename>]]` (the importer
            // transform's inverse), every other byte preserved.
            let expected = "---\ntitle: T\nupdated: 2026-06-11T10:00:00Z\n---\n\nintro ![[photo.png]] mid\n![[doc.pdf]]\ntail, no trailing newline";
            assert_eq!(
                std::fs::read(out.join("note.md")).unwrap(),
                expected.as_bytes()
            );

            // mtime fidelity rides the same path (task 3 helper reuse).
            let mtime = mtime_epoch_secs(&out.join("note.md"));
            assert!(mtime.abs_diff(EXPORT_FIXTURE_UPDATED_EPOCH) <= 5);

            // Exactly the three expected files — no temp siblings.
            assert_eq!(dir_names(&out), vec!["doc.pdf", "note.md", "photo.png"]);

            // The vault's stored blob is NEVER modified by export.
            let note_id2 =
                NoteId::parse(dir_names(&vault_root.join("notes"))[0].trim_end_matches(".myn"))
                    .unwrap();
            let stored = std::fs::read(
                vault_root
                    .join("notes")
                    .join(format!("{}.myn", note_id2.as_uuid())),
            )
            .unwrap();
            let dec = protocol::decode_note(
                &stored,
                note_id2.as_uuid().as_bytes(),
                &[FIXTURE_ITEMS_BYTE; 32],
                &[FIXTURE_ITEMS_ID_BYTE; 16],
            )
            .unwrap();
            assert_eq!(dec.plaintext(), plaintext.as_bytes());
        });
    }

    // ---- deterministic suffix-dedup ---------------------------------------

    #[test]
    fn export_attachments_dedups_colliding_filenames_deterministically() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            // Two DIFFERENT attachments sharing the display filename,
            // plus a pre-existing file at the destination with that
            // same name.
            let id_a = import_att(&vault_root, &state, ATT_PNG_A, "photo.png").await;
            let id_b = import_att(&vault_root, &state, ATT_PNG_B, "photo.png").await;
            std::fs::write(out.join("photo.png"), b"sentinel: pre-existing").unwrap();

            let plaintext = format!("a ![[att:{id_a}|photo.png]] b ![[att:{id_b}|photo.png]] c");
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext.clone(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let count = note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await
            .unwrap();
            assert_eq!(count, 2);

            // Deterministic: first appearance → " (1)", second → " (2)";
            // the pre-existing file is untouched.
            assert_eq!(
                std::fs::read(out.join("photo.png")).unwrap(),
                b"sentinel: pre-existing"
            );
            assert_eq!(std::fs::read(out.join("photo (1).png")).unwrap(), ATT_PNG_A);
            assert_eq!(std::fs::read(out.join("photo (2).png")).unwrap(), ATT_PNG_B);
            assert_eq!(
                std::fs::read(out.join("note.md")).unwrap(),
                b"a ![[photo (1).png]] b ![[photo (2).png]] c"
            );
        });
    }

    /// 115-F1 variant 2: an attachment whose FINAL name is `x.png.tmp`
    /// written before its `x.png` sibling used to be destroyed by the
    /// later write's fixed-name temp (`x.png` + `.tmp`); with the
    /// unclobbered helper's randomized `create_new` temps both files
    /// land intact and the embeds point at real files.
    #[test]
    fn export_attachments_tmp_shaped_final_name_survives_its_sibling() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            // Document order writes "x.png.tmp" FIRST, then "x.png".
            let id_tmpish = import_att(&vault_root, &state, ATT_PNG_A, "x.png.tmp").await;
            let id_plain = import_att(&vault_root, &state, ATT_PNG_B, "x.png").await;

            let plaintext =
                format!("a ![[att:{id_tmpish}|x.png.tmp]] b ![[att:{id_plain}|x.png]] c");
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let count = note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await
            .expect("export with a .tmp-shaped attachment name must succeed");
            assert_eq!(count, 2);

            // BOTH attachments landed intact — the later write's temp
            // never occupied (or destroyed) the earlier final name.
            assert_eq!(std::fs::read(out.join("x.png.tmp")).unwrap(), ATT_PNG_A);
            assert_eq!(std::fs::read(out.join("x.png")).unwrap(), ATT_PNG_B);
            assert_eq!(dir_names(&out), vec!["note.md", "x.png", "x.png.tmp"]);
            assert_eq!(
                std::fs::read(out.join("note.md")).unwrap(),
                b"a ![[x.png.tmp]] b ![[x.png]] c"
            );
        });
    }

    #[test]
    fn export_attachments_same_id_referenced_twice_writes_one_file() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            let id = import_att(&vault_root, &state, ATT_PNG_A, "photo.png").await;

            let plaintext = format!("x ![[att:{id}|alias-one.png]] y ![[att:{id}]] z");
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let count = note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await
            .unwrap();

            // One id → one exported file, both spans rewritten to it.
            assert_eq!(count, 1);
            assert_eq!(dir_names(&out), vec!["note.md", "photo.png"]);
            assert_eq!(
                std::fs::read(out.join("note.md")).unwrap(),
                b"x ![[photo.png]] y ![[photo.png]] z"
            );
        });
    }

    // ---- default (no-embeds) path stays byte-verbatim ---------------------

    #[test]
    fn export_attachments_note_without_embeds_exports_byte_verbatim() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            // Includes a RAW media ref and a plain wikilink — neither is
            // a canonical form-C embed, so no byte may change.
            let plaintext = "---\ntitle: T\n---\n\n![[image.png]] and [[Other Note|alias]]\ntrailing spaces   \nno trailing newline";
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext.to_string(),
            &myne_core::vault_io::StdVaultIo, &myne_core::host::NoopHost,)
            .await
            .unwrap();

            let count = note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await
            .unwrap();

            assert_eq!(count, 0);
            assert_eq!(
                std::fs::read(out.join("note.md")).unwrap(),
                plaintext.as_bytes(),
                "no-embeds export must be byte-verbatim"
            );
            assert_eq!(dir_names(&out), vec!["note.md"]);
        });
    }

    // ---- all-or-nothing: missing / corrupt referenced attachment ----------

    #[test]
    fn export_attachments_missing_catalog_entry_errors_and_writes_nothing() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            // A real attachment AND a never-imported id: the validation
            // pass must fail the whole export before any write.
            let id_real = import_att(&vault_root, &state, ATT_PNG_A, "photo.png").await;
            let id_ghost = "f".repeat(64);

            let plaintext = format!("![[att:{id_real}|photo.png]] ![[att:{id_ghost}|ghost.png]]");
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let result = note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await;
            assert!(matches!(
                result,
                Err(NoteExportAttachmentsError::AttachmentMissing)
            ));
            assert!(dir_names(&out).is_empty(), "nothing may be written");
        });
    }

    #[test]
    fn export_attachments_corrupt_blob_errors_and_writes_nothing() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            let id = import_att(&vault_root, &state, ATT_PNG_A, "photo.png").await;
            // Flip the stored blob's last byte → AEAD-tag failure.
            let blob_path = vault_root.join("attachments").join(&id);
            let mut blob = std::fs::read(&blob_path).unwrap();
            let last = blob.len() - 1;
            blob[last] ^= 0xFF;
            std::fs::write(&blob_path, &blob).unwrap();

            let plaintext = format!("![[att:{id}|photo.png]]");
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let result = note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await;
            assert!(matches!(
                result,
                Err(NoteExportAttachmentsError::AttachmentCorrupt)
            ));
            assert!(dir_names(&out).is_empty(), "nothing may be written");
        });
    }

    #[test]
    fn export_attachments_missing_blob_file_is_attachment_missing() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            let id = import_att(&vault_root, &state, ATT_PNG_A, "photo.png").await;
            // Catalog entry stays; the blob file vanishes.
            std::fs::remove_file(vault_root.join("attachments").join(&id)).unwrap();

            let plaintext = format!("![[att:{id}|photo.png]]");
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let result = note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await;
            assert!(matches!(
                result,
                Err(NoteExportAttachmentsError::AttachmentMissing)
            ));
            assert!(dir_names(&out).is_empty());
        });
    }

    // ---- note-file overwrite matrix (SYNC-2; note file ONLY) --------------

    #[test]
    fn export_attachments_note_overwrite_false_existing_rejects_and_writes_nothing() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            let id = import_att(&vault_root, &state, ATT_PNG_A, "photo.png").await;
            std::fs::write(out.join("note.md"), b"sentinel: pre-existing note").unwrap();

            let plaintext = format!("![[att:{id}|photo.png]]");
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let result = note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await;
            assert!(matches!(
                result,
                Err(NoteExportAttachmentsError::TargetAlreadyExists)
            ));
            // The pre-check fires BEFORE the attachment writes: the
            // destination holds only the untouched sentinel.
            assert_eq!(dir_names(&out), vec!["note.md"]);
            assert_eq!(
                std::fs::read(out.join("note.md")).unwrap(),
                b"sentinel: pre-existing note"
            );
        });
    }

    #[test]
    fn export_attachments_note_overwrite_true_replaces_note_file() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            let id = import_att(&vault_root, &state, ATT_PNG_A, "photo.png").await;
            std::fs::write(out.join("note.md"), b"sentinel: pre-existing note").unwrap();

            let plaintext = format!("![[att:{id}|photo.png]]");
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let count = note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                true,
            )
            .await
            .expect("overwrite=true must replace the note file");
            assert_eq!(count, 1);
            assert_eq!(
                std::fs::read(out.join("note.md")).unwrap(),
                b"![[photo.png]]"
            );
            assert_eq!(std::fs::read(out.join("photo.png")).unwrap(), ATT_PNG_A);
        });
    }

    // ---- catalog-filename sanitation (traversal-shaped display name) ------

    #[test]
    fn export_attachments_sanitizes_traversal_shaped_catalog_filename() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            // The catalog display filename is free-form (rename allows
            // anything non-empty) — a separator-bearing name must NOT
            // escape the destination directory.
            let id = import_att(&vault_root, &state, ATT_PNG_A, "../escape.png").await;

            let plaintext = format!("![[att:{id}|x]]");
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                plaintext,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            note_export_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await
            .unwrap();

            // Lands INSIDE `out/` under the sanitized name; nothing at
            // the traversal target.
            assert_eq!(dir_names(&out), vec![".._escape.png", "note.md"]);
            assert!(!vault_root.join("escape.png").exists());
            assert_eq!(
                std::fs::read(out.join("note.md")).unwrap(),
                b"![[.._escape.png]]"
            );
        });
    }

    // ---- guards ------------------------------------------------------------

    #[test]
    fn export_attachments_locked_vault_rejects() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-export-att-locked").unwrap();
            std::fs::create_dir(scratch.path().join("out")).unwrap();
            let state = VaultRuntimeState::default(); // Empty slot
            let result = note_export_attachments_with_root(
                scratch.path().to_path_buf(),
                &state,
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                scratch.path().join("out"),
                "note.md".to_string(),
                false,
            )
            .await;
            assert!(matches!(
                result,
                Err(NoteExportAttachmentsError::VaultNotUnlocked)
            ));
            assert!(dir_names(&scratch.path().join("out")).is_empty());
        });
    }

    #[test]
    fn export_attachments_invalid_note_id_rejects_before_any_fs_touch() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let result = note_export_attachments_with_root(
                scratch.path().to_path_buf(),
                &state,
                "not-a-note-id".to_string(),
                scratch.path().join("no-such-dir"),
                "note.md".to_string(),
                false,
            )
            .await;
            // InvalidNoteId, NOT InvalidDestination — the parse runs first.
            assert!(matches!(
                result,
                Err(NoteExportAttachmentsError::InvalidNoteId)
            ));
        });
    }

    #[test]
    fn export_attachments_traversal_shaped_note_filename_rejects() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let out = scratch.path().join("out");
            for bad in ["", ".", "..", "../escape.md", "a/b.md", "a\\b.md"] {
                let result = note_export_attachments_with_root(
                    scratch.path().to_path_buf(),
                    &state,
                    "01970e83-4f2f-7000-8000-000000000000".to_string(),
                    out.clone(),
                    bad.to_string(),
                    false,
                )
                .await;
                assert!(
                    matches!(result, Err(NoteExportAttachmentsError::InvalidNoteFilename)),
                    "must reject note_filename {bad:?}"
                );
            }
            assert!(dir_names(&out).is_empty());
        });
    }

    #[test]
    fn export_attachments_missing_target_dir_is_invalid_destination() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let plaintext = "body";
            let note_id = note_create_with_dir(
                scratch.path().join("notes"),
                &state,
                plaintext.to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let result = note_export_attachments_with_root(
                scratch.path().to_path_buf(),
                &state,
                note_id,
                scratch.path().join("no-such-dir"),
                "note.md".to_string(),
                false,
            )
            .await;
            assert!(matches!(
                result,
                Err(NoteExportAttachmentsError::InvalidDestination)
            ));
        });
    }

    #[test]
    fn export_attachments_missing_note_is_note_not_found() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let out = scratch.path().join("out");
            let result = note_export_attachments_with_root(
                scratch.path().to_path_buf(),
                &state,
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                out.clone(),
                "note.md".to_string(),
                false,
            )
            .await;
            assert!(matches!(
                result,
                Err(NoteExportAttachmentsError::NoteNotFound)
            ));
            assert!(dir_names(&out).is_empty());
        });
    }

    // (The pure export-naming helpers — sanitize / suffix-dedup /
    // embed rewrite — moved to `crate::export_naming` with their
    // tests.)

    // ---- error_kind label ------------------------------------------------------

    #[test]
    fn export_attachments_error_kind_label_covers_every_variant() {
        use crate::io_failure_kind::IoFailureKind;
        for (e, expected) in [
            (
                NoteExportAttachmentsError::VaultNotUnlocked,
                "VaultNotUnlocked",
            ),
            (NoteExportAttachmentsError::InvalidNoteId, "InvalidNoteId"),
            (
                NoteExportAttachmentsError::InvalidNoteFilename,
                "InvalidNoteFilename",
            ),
            (NoteExportAttachmentsError::NoteNotFound, "NoteNotFound"),
            (NoteExportAttachmentsError::CannotDecrypt, "CannotDecrypt"),
            (
                NoteExportAttachmentsError::InvalidPlaintextEncoding,
                "InvalidPlaintextEncoding",
            ),
            (
                NoteExportAttachmentsError::InvalidVaultMeta,
                "InvalidVaultMeta",
            ),
            (
                NoteExportAttachmentsError::InvalidDestination,
                "InvalidDestination",
            ),
            (
                NoteExportAttachmentsError::TargetAlreadyExists,
                "TargetAlreadyExists",
            ),
            (
                NoteExportAttachmentsError::AttachmentMissing,
                "AttachmentMissing",
            ),
            (
                NoteExportAttachmentsError::AttachmentCorrupt,
                "AttachmentCorrupt",
            ),
            (
                NoteExportAttachmentsError::Io {
                    io_error_kind: IoFailureKind::Other,
                },
                "Io",
            ),
            (NoteExportAttachmentsError::JoinFailure, "JoinFailure"),
        ] {
            assert_eq!(note_export_attachments_error_kind(&e), expected);
        }
    }

    // =====================================================================
    // note_export_html / note_export_html_attachments (MYND-340)
    // =====================================================================

    #[test]
    fn html_referenced_attachment_ids_are_first_appearance_unique() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let html = format!(
            "<img src=\"attachment://{a}\"><img src=\"attachment://{b}\">\
             <img src=\"attachment://{a}\">"
        );
        // First-appearance order, de-duplicated.
        assert_eq!(html_referenced_attachment_ids(&html), vec![a.clone(), b]);
        // No refs → empty.
        assert!(html_referenced_attachment_ids("<p>plain</p>").is_empty());
        // A non-64-hex trailer is not accepted as an id (no infinite loop).
        assert!(html_referenced_attachment_ids("attachment://xyz").is_empty());
    }

    /// myne#306: a non-ASCII character immediately after `attachment://`.
    ///
    /// The scanner advanced by one BYTE to break out of a malformed occurrence,
    /// which lands mid-character when that character is multi-byte — a panic,
    /// surfaced as `JoinFailure` ("try again") from a retry that could never
    /// succeed. The whole roster here was ASCII, so nothing saw it.
    #[test]
    fn html_referenced_attachment_ids_survives_a_non_ascii_trailer() {
        // Each of these used to panic on the `&after[1..]` slice.
        for html in [
            "attachment://…",
            "attachment://ör",
            "attachment://画像",
            "attachment://\u{1F600}",
            // Nothing at all after the prefix — the other end of the same step.
            "attachment://",
        ] {
            assert!(
                html_referenced_attachment_ids(html).is_empty(),
                "{html:?} carries no id and must simply yield none"
            );
        }

        // …and a real id is still found when the noise sits beside it, in both
        // orders — the advance must not swallow a following occurrence.
        let a = "a".repeat(64);
        let html = format!("attachment://…<img src=\"attachment://{a}\">");
        assert_eq!(html_referenced_attachment_ids(&html), vec![a.clone()]);
        let html = format!("<img src=\"attachment://{a}\">attachment://画像");
        assert_eq!(html_referenced_attachment_ids(&html), vec![a]);
    }

    #[test]
    fn export_text_to_path_writes_verbatim_under_unlocked_slot() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let out = scratch.path().join("out");
            let dest = out.join("doc.html");
            let document = "<!DOCTYPE html>\n<html><body><p>x</p></body></html>\n";

            note_export_text_to_path(&state, document.to_string(), dest.clone(), false)
                .await
                .expect("html write must succeed under an unlocked slot");

            assert_eq!(std::fs::read(&dest).unwrap(), document.as_bytes());
            // Atomic publish: no temp sibling.
            assert_eq!(dir_names(&out), vec!["doc.html"]);

            // overwrite=false against an existing target rejects, untouched.
            let again =
                note_export_text_to_path(&state, "REPLACEMENT".to_string(), dest.clone(), false)
                    .await;
            assert!(matches!(again, Err(NoteExportError::TargetAlreadyExists)));
            assert_eq!(std::fs::read(&dest).unwrap(), document.as_bytes());

            // overwrite=true replaces.
            note_export_text_to_path(&state, "REPLACEMENT".to_string(), dest.clone(), true)
                .await
                .unwrap();
            assert_eq!(std::fs::read(&dest).unwrap(), b"REPLACEMENT");
        });
    }

    #[test]
    fn export_text_to_path_rejects_when_slot_is_locked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("html-write-locked").unwrap();
            std::fs::create_dir(scratch.path().join("out")).unwrap();
            let state = VaultRuntimeState::default(); // Empty slot
            let res = note_export_text_to_path(
                &state,
                "<html></html>".to_string(),
                scratch.path().join("out").join("x.html"),
                false,
            )
            .await;
            assert!(matches!(res, Err(NoteExportError::VaultNotUnlocked)));
        });
    }

    #[test]
    fn export_html_attachments_writes_sidecars_and_rewrites_srcs() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            // Two DIFFERENT images sharing a display filename → the second
            // sidecar dedups to "photo (1).png", and BOTH srcs rewrite.
            let id_a = import_att(&vault_root, &state, ATT_PNG_A, "photo.png").await;
            let id_b = import_att(&vault_root, &state, ATT_PNG_B, "photo.png").await;
            // A valid note id is required (bug-canary parse) even though
            // the HTML — not the note — carries the refs.
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                "body".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();

            let doc = format!(
                "<!DOCTYPE html>\n<html><body>\
                 <img class=\"att-image\" src=\"attachment://{id_a}\" alt=\"a\">\
                 <img class=\"att-image\" src=\"attachment://{id_b}\" alt=\"b\">\
                 </body></html>\n"
            );

            let count = note_export_html_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                doc,
                out.clone(),
                "page.html".to_string(),
                false,
            )
            .await
            .expect("html attachments export must succeed");
            assert_eq!(count, 2);

            // Side-by-side sidecars, decrypted byte-for-byte, deduped.
            assert_eq!(std::fs::read(out.join("photo.png")).unwrap(), ATT_PNG_A);
            assert_eq!(std::fs::read(out.join("photo (1).png")).unwrap(), ATT_PNG_B);
            assert_eq!(
                dir_names(&out),
                vec!["page.html", "photo (1).png", "photo.png"]
            );

            // The HTML's attachment:// srcs are rewritten to the final
            // relative filenames (percent-encoded); the scheme is gone.
            let html = std::fs::read_to_string(out.join("page.html")).unwrap();
            assert!(!html.contains("attachment://"));
            assert!(html.contains("src=\"photo.png\""));
            assert!(html.contains("src=\"photo%20%281%29.png\""));
        });
    }

    #[test]
    fn export_html_attachments_no_refs_writes_only_the_html() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let out = vault_root.join("out");
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                "body".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let doc = "<!DOCTYPE html>\n<html><body><p>no images</p></body></html>\n";

            let count = note_export_html_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                doc.to_string(),
                out.clone(),
                "page.html".to_string(),
                false,
            )
            .await
            .unwrap();

            // No image refs → zero sidecars; the HTML is written verbatim
            // (no vault.meta / catalog read on this path).
            assert_eq!(count, 0);
            assert_eq!(dir_names(&out), vec!["page.html"]);
            assert_eq!(
                std::fs::read(out.join("page.html")).unwrap(),
                doc.as_bytes()
            );
        });
    }

    #[test]
    fn export_html_attachments_rejects_traversal_shaped_filename() {
        rt().block_on(async {
            let (scratch, state) = export_att_fixture().await;
            let vault_root = scratch.path().to_path_buf();
            let note_id = note_create_with_dir(
                vault_root.join("notes"),
                &state,
                "body".to_string(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .unwrap();
            let res = note_export_html_attachments_with_root(
                vault_root.clone(),
                &state,
                note_id,
                "<html></html>".to_string(),
                vault_root.join("out"),
                "../escape.html".to_string(),
                false,
            )
            .await;
            assert!(matches!(
                res,
                Err(NoteExportAttachmentsError::InvalidNoteFilename)
            ));
        });
    }
}
