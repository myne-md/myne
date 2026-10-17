// SPDX-License-Identifier: AGPL-3.0
//! Tauri commands for the `notes` plugin.
//!
//! `note_create` mints a backend-side [`NoteId::new_v7`], AEAD-encrypts
//! the plaintext via `protocol::encode_new_note` on a
//! `tokio::task::spawn_blocking` thread, and atomically writes the
//! `.myn` blob via `atomic_write::atomic_write(.., replace=false)` so
//! the destination is created-only (the canary defense against
//! backend-gen UUIDv7 collision).
//!
//! `note_read` mirrors the flow: strict-parse the UI-supplied `NoteId`
//! string, read + AEAD-decrypt via `protocol::decode_note` on a
//! `spawn_blocking` thread, and apply the UTF-8 boundary check at the
//! command layer (codec stays content_type-agnostic).
//!
//! Both commands pattern-match `Slot::Unlocked(uv) => ...` only;
//! `Slot::Recovering` is structurally rejected at compile time per
//! `recovery-flow.md` §4.1. `items_key` is cloned out of the slot
//! into a `Zeroizing<[u8; 32]>` and moved into the blocking closure;
//! `vault_lock` waits for in-flight ops via `tokio::sync::RwLock`
//! fair queueing — no extra synchronization primitive needed.
//!
//! Spec touchpoints:
//! - `protocol.md` §6.2 (per-note encryption flow)
//! - `protocol.md` §3.3 (three-level wrapping)
//! - `protocol.md` §9.1 (vault layout — `.myn` filename is the
//!   canonical UUIDv7)
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

use crate::host::HostCtx;
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::paths;
use crate::plugins::vault_unlock::state::{Slot, VaultRuntimeState};
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::{decode_note, encode_new_note, encode_update, DecryptError, ProtocolError};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use super::daily_match::{
    fm_archived_value_strict, fm_deleted_value_strict, fm_trashed_value_strict,
};
use super::drawing_text::{is_drawing, project_drawing_text};
use super::error::{
    NoteBatchError, NoteCreateError, NoteDeleteError, NoteListError, NoteReadError,
    NoteTitleBatchError, NoteTitleError, NoteUpdateError,
};
use super::note_id::NoteId;
use super::title_extract::{extract_title_slices, resolve_note_title};

/// Create a new encrypted `.myn` note. See module-level docs for the
/// full pipeline narration.
///
/// Returns the canonical lowercase-hyphenated 36-char `NoteId` string
/// on success — the UI never produces a `NoteId`, only consumes one
/// returned by this command (see `decisions.md` 2026-05-07
/// "Note UUIDv7 backend-gen; UI never names the destination").
pub async fn note_create_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    plaintext: String,
    io: &dyn VaultIo,
) -> Result<String, NoteCreateError> {
    // First-line Plaintext-IPC wrap (`src-tauri/AGENTS.md`): the index needs
    // the body AFTER the core consumes its own copy, so bound this retained
    // copy to a `Zeroizing` wrapper — it wipes on every early-return and at
    // function exit (after the post-write `upsert`) rather than lingering as a
    // plain `String` across the `.await`. The core takes a fresh plain clone
    // and re-wraps it first-line.
    let plaintext = Zeroizing::new(plaintext);
    // Resolve `<vault>/notes/` (lazy `create_dir_all`); map both
    // `NotADirectory` and `AlreadyExists` to the structural defensive
    // variant per the accept-list pinned in `paths::notes_dir_under`'s
    // tests.
    let notes_dir = paths::notes_dir_for_host_io(host, io, state.active_vault_id().await)
        .await
        .map_err(|e| {
            let kind = e.kind();
            match kind {
                std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "NotesDirNotADirectory",
                        "note_create notes_dir resolution conflicted with a non-dir entry"
                    );
                    NoteCreateError::NotesDirNotADirectory
                }
                other => {
                    let io_kind = from_io_error_kind(other);
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "Io",
                        io_failure_kind = ?io_kind,
                        "note_create notes_dir resolution failed"
                    );
                    NoteCreateError::Io {
                        io_error_kind: io_kind,
                    }
                }
            }
        })?;
    // MYND-29 Task 4: incremental in-RAM index update — index after a
    // successful write so the new note is searchable in-session without a
    // rebuild. Title is best-effort H1; body is the full plaintext. (The
    // index is plaintext-derived RAM; the lock path clears it — Task 8.)
    let result = note_create_with_dir(notes_dir, state, (*plaintext).clone(), io, host).await;
    if let Ok(id) = &result {
        let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
        // MYND-448a: the note body is indexed UNFOLDED; each embedded attachment
        // is indexed as its OWN doc (`index_note_attachments`) so an
        // attachment-content hit surfaces as a distinct result, not folded into
        // the note.
        // SF5 (MYND-502): a `kind: drawing` body is Excalidraw scene JSON, not
        // markdown — index its projected text elements, never the raw JSON
        // (SYNC-4 body-only guard) and never scan it for attachment docs. An
        // empty/malformed scene → title-only.
        if is_drawing(plaintext.as_bytes()) {
            let body = project_drawing_text(plaintext.as_bytes()).unwrap_or_default();
            hooks.search_upsert(id, &title, &body);
        } else {
            hooks.search_upsert(id, &title, &plaintext);
            hooks
                .index_note_attachments(state, id, &title, &plaintext)
                .await;
        }
        // MYND-424: mark the sync loop dirty so the new note pushes (soft dep).
        hooks.bump_local_change();
    }
    result
}

/// IPC wrapper. Delegates; the name and payload the frontend sends are
/// unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn note_create<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    plaintext: String,
) -> Result<String, NoteCreateError> {
    note_create_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        plaintext,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Inner — pure-and-testable helper. Tauri-aware path resolution is
/// the [`note_create`] caller's responsibility; this fn takes
/// `notes_dir` directly so tests exercise the full pipeline (slot
/// guard → AEAD → atomic_write) under a `ScopedTempDir` without
/// spinning up a Tauri runtime.
///
/// Mirrors the `vault_unlock::commands::unlock_with_path` shape.
pub async fn note_create_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    plaintext: String,
    io: &dyn VaultIo,
    host: &dyn HostCtx,
) -> Result<String, NoteCreateError> {
    // First non-doc statement: bound the lifetime of plaintext bytes
    // to a `Zeroizing<String>` wrapper. Every early-return path drops
    // the wrapper and zeroes the bytes (see
    // `src-tauri/AGENTS.md` "Secret-handling logging discipline").
    let plaintext = Zeroizing::new(plaintext);

    // Acquire the slot read guard and HOLD it across spawn_blocking +
    // atomic_write. `tokio::sync::RwLock`'s fair queueing makes
    // `vault_lock`'s subsequent write-lock request wait for this guard
    // to drop, so an in-flight `note_create` cannot race with
    // `vault_lock` taking the slot mid-write (`decisions.md` 2026-05-07
    // "Note AEAD ops"). The guard drops at the function-exit `drop(slot)`
    // below — or any early-return on its way out.
    let slot = state.slot_read_active().await;
    let (items_key, items_key_id) = match &*slot {
        Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_create rejected: slot is not Unlocked"
            );
            return Err(NoteCreateError::VaultNotUnlocked);
        }
    };
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    // Mint NoteId server-side — UI never produces this.
    let note_id = NoteId::new_v7();
    let note_uuid_bytes = *note_id.as_uuid().as_bytes();

    // The new note's seal format follows the vault's generation: a migrated
    // (v0.2 / `NTV5`) vault writes `NC05` — the CRDT format the migration
    // produced and that `note_read`/`note_update` dispatch on — so new content
    // gets the Automerge merge the migration exists to enable rather than
    // reverting to the `MY01` keep-both model (a resting mixed state §10.4.1
    // rule 2 forbids). The unlocked slot carries no `MetaVersion`, so read it
    // from `vault.meta` the same per-op way prefs/themes/dictionary/attachments
    // do; an absent/unreadable meta falls back to v0.1 (the pre-migration
    // default), so a test fixture with no `vault.meta` keeps writing `MY01`.
    let is_v0_2 = match notes_dir.parent() {
        Some(vault_root) => match io.read(&vault_root.join("vault.meta")).await {
            Ok(bytes) => protocol::meta_version_of(&bytes) == Some(protocol::MetaVersion::V0_2),
            Err(_) => false,
        },
        None => false,
    };
    // The Automerge actor for an NC05 note: this device's stable identity
    // (`SYNC-42`), derived from the persisted `device_id`, falling back to a fresh
    // CSPRNG actor when the vault has no device identity (never enrolled /
    // local-only). Resolved here so a getrandom failure surfaces before the
    // blocking hop, and so the note is attributed to the device that created it.
    let actor = if is_v0_2 {
        let device_id = match notes_dir.parent() {
            Some(vault_root) => {
                crate::plugins::sync::state::read_device_actor(io, vault_root).await
            }
            None => None,
        };
        match crate::plugins::sync::crdt_doc::note_actor_bytes(device_id) {
            Ok(a) => a,
            Err(_) => {
                tracing::error!(
                    stage = "encode",
                    error_kind = "JoinFailure",
                    "note_create failed to derive an NC05 actor id for this device"
                );
                return Err(NoteCreateError::JoinFailure);
            }
        }
    } else {
        [0u8; 16]
    };

    // AEAD on a background thread. `Zeroizing<String>` and
    // `Zeroizing<[u8; 32]>` move into the closure; both drop and zero
    // their bytes on closure exit. The slot read guard remains in the
    // outer task across this `.await` — its lifetime is bounded by
    // `state`, not the closure. The note's content timestamp (`now_millis`) is
    // pre-read so the NC05 branch need not move `host` across the hop.
    let started_ms = host.monotonic_millis();
    let now_millis = host.now_unix_millis();
    let blob_result = crate::task::run_blocking(move || {
        if is_v0_2 {
            let save = crate::plugins::notes::crdt::encode_note_at_millis(
                plaintext.as_str(),
                &actor,
                now_millis,
            );
            protocol::encode_crdt_note_blob(&items_key, &items_key_id, &note_uuid_bytes, &save)
        } else {
            encode_new_note(
                &items_key,
                &items_key_id,
                &note_uuid_bytes,
                plaintext.as_bytes(),
            )
        }
    })
    .await;
    let duration_ms = host.monotonic_millis().saturating_sub(started_ms);

    let blob = match blob_result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_create encode panicked or runtime shutdown"
            );
            return Err(NoteCreateError::JoinFailure);
        }
        Ok(Err(ProtocolError::PlaintextTooLarge)) => {
            tracing::debug!(
                stage = "encode",
                error_kind = "PlaintextTooLarge",
                "note_create rejected: plaintext exceeds MAX_PLAINTEXT_LEN"
            );
            return Err(NoteCreateError::PlaintextTooLarge);
        }
        Ok(Err(_other_protocol_err)) => {
            // v0.1 fixed parameters make AEAD seal failure
            // unreachable: `items_key` is 32 bytes by type, nonces are
            // 24 bytes from `getrandom`, AAD widths are compile-time
            // const, plaintext boundary already passed. If this fires,
            // it's a v0.1 invariant violation; surface as JoinFailure
            // (panic-equivalent semantic) and let the user retry.
            tracing::error!(
                stage = "encode",
                error_kind = "JoinFailure",
                "note_create encode_new_note returned an unreachable ProtocolError under v0.1 fixed params"
            );
            return Err(NoteCreateError::JoinFailure);
        }
        Ok(Ok(blob)) => blob,
    };
    tracing::debug!(
        stage = "encode",
        duration_ms = duration_ms,
        "note_create AEAD seal succeeded"
    );

    // Atomic write with create-only semantic. The defensive
    // `replace=false` guarantees `<dest>` did not exist; backend-gen
    // UUIDv7 collision is astronomically improbable so the canary
    // never fires in normal flow.
    let dest = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
    // Create-only through the IO seam. `WriteOpts::create_new()` carries the
    // `replace = false` semantic the old `atomic_write` call had.
    //
    // **The `AlreadyExists` / `NotADirectory` distinctions are recovered by
    // ASKING, not by widening the seam's error vocabulary.** `IoFailureKind` is
    // a closed four-variant enum that crosses the IPC boundary and is matched
    // exhaustively in TypeScript (`src/lib/stage.ts`), so a fifth variant would
    // be a two-language change to every consumer — to express two conditions
    // that are cheaply *observable* on an already-failing path. One `exists`
    // call answers both:
    //
    //   dest exists            -> the UUIDv7-collision canary (`NoteAlreadyExists`)
    //   parent does not exist  -> the notes dir is missing or not a directory
    //
    // Same shape as `note_list`'s `NotesDirNotADirectory` recovery. The cost is
    // one extra call, only when the write already failed; the alternative cost
    // was a serialized-enum change reaching `src/types/`.
    if let Err(io_error_kind) = io.write(&dest, &blob, WriteOpts::create_new()).await {
        let mapped = if io.exists(&dest).await.unwrap_or(false) {
            NoteCreateError::NoteAlreadyExists
        } else if !io.is_dir(&notes_dir).await.unwrap_or(true) {
            NoteCreateError::NotesDirNotADirectory
        } else {
            NoteCreateError::Io { io_error_kind }
        };
        tracing::error!(
            stage = "atomic_write",
            error_kind = note_create_error_kind(&mapped),
            "note_create atomic_write failed"
        );
        return Err(mapped);
    }

    // Explicit drop — make the lock-release point visible to readers
    // (the implicit end-of-fn drop would do the same). After this
    // line, `vault_lock`'s queued write-lock request can proceed.
    drop(slot);

    tracing::debug!(stage = "success", event = "note_created");
    Ok(note_id.as_uuid().to_string())
}

/// Static-string label for [`NoteCreateError`] variants — emitted via
/// `tracing` without crossing the IPC boundary. Mirrors the
/// `vault_unlock`'s `protocol_error_kind` discipline (see
/// `src-tauri/AGENTS.md` "Secret-handling logging discipline" closed-
/// enum mapping rule). A new variant compile-fails this match, so
/// drift between the public enum and the tracing label is structurally
/// caught.
pub fn note_create_error_kind(e: &NoteCreateError) -> &'static str {
    match e {
        NoteCreateError::VaultNotUnlocked => "VaultNotUnlocked",
        NoteCreateError::NoteAlreadyExists => "NoteAlreadyExists",
        NoteCreateError::PlaintextTooLarge => "PlaintextTooLarge",
        NoteCreateError::NotesDirNotADirectory => "NotesDirNotADirectory",
        NoteCreateError::Io { .. } => "Io",
        NoteCreateError::JoinFailure => "JoinFailure",
    }
}

/// Read + AEAD-decrypt an existing `.myn` note by [`NoteId`] string.
///
/// Returns the canonical UTF-8 markdown plaintext on success. UI never
/// produces `NoteId` values — only consumes ones returned by
/// [`note_create`]; this command's strict-parse step
/// ([`NoteId::parse`]) doubly enforces that contract for any UI that
/// hands back an unexpected string (`InvalidNoteId` is a bug-canary
/// per `decisions.md` 2026-05-07).
///
/// Failure modes (closed-enum surface, `decisions.md` 2026-04-26
/// unlock-error-discipline pattern):
/// - `InvalidNoteId` — strict parse rejected (sub-cause via tracing).
/// - `VaultNotUnlocked` — slot is `Empty` or `Recovering`.
/// - `NoteNotFound` — file at `<vault>/notes/<note_id>.myn` missing.
/// - `Io` — other filesystem failure.
/// - `CannotDecrypt` — AEAD-tag failure on `decode_note` (non-
///   distinguishing per `protocol.md` §6.4; codec emits its own
///   sub-cause via `tracing`).
/// - `InvalidPlaintextEncoding` — AEAD passed but plaintext is not
///   valid UTF-8 (structural-corruption / foreign-writer suspicion;
///   distinct from `CannotDecrypt`).
/// - `JoinFailure` — `spawn_blocking` panic / runtime shutdown.
pub async fn note_read_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    note_id: String,
    io: &dyn VaultIo,
) -> Result<String, NoteReadError> {
    let notes_dir = paths::notes_dir_for_host_io(host, io, state.active_vault_id().await)
        .await
        .map_err(|e| {
            let kind = e.kind();
            match kind {
                std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "NotesDirNotADirectory",
                        "note_read notes_dir resolution conflicted with a non-dir entry"
                    );
                    NoteReadError::NotesDirNotADirectory
                }
                other => {
                    let io_kind = from_io_error_kind(other);
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "Io",
                        io_failure_kind = ?io_kind,
                        "note_read notes_dir resolution failed"
                    );
                    NoteReadError::Io {
                        io_error_kind: io_kind,
                    }
                }
            }
        })?;
    note_read_with_dir(notes_dir, state, note_id, io, host).await
}

/// IPC wrapper. Delegates; the name and payload the frontend sends are
/// unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn note_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
) -> Result<String, NoteReadError> {
    note_read_from_host(
        &TauriHost::new(app),
        state.inner(),
        note_id,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Inner — pure-and-testable helper. Mirror of [`note_create_with_dir`].
pub async fn note_read_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    note_id: String,
    io: &dyn VaultIo,
    host: &dyn HostCtx,
) -> Result<String, NoteReadError> {
    // Strict-parse FIRST — before any path concatenation. Sub-cause
    // emits to `tracing::debug!(stage = ?cause)` for ops debugging;
    // IPC sees only the single `InvalidNoteId` variant per
    // `decisions.md` 2026-05-07.
    let note_id = NoteId::parse(&note_id).map_err(|cause| {
        tracing::debug!(stage = ?cause, "note_read note_id strict-parse failed");
        NoteReadError::InvalidNoteId
    })?;
    tracing::debug!(stage = "note_id_parse", outcome = "ok");

    // Slot guard. Held across spawn_blocking + file read so vault_lock
    // waits for in-flight decrypts via `tokio::sync::RwLock` fair
    // queueing — same load-bearing pattern as `note_create_with_dir`.
    let slot = state.slot_read_active().await;
    let (items_key, items_key_id) = match &*slot {
        Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_read rejected: slot is not Unlocked"
            );
            return Err(NoteReadError::VaultNotUnlocked);
        }
    };
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    let path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
    let note_uuid_bytes = *note_id.as_uuid().as_bytes();

    // File read AND AEAD decrypt run together inside spawn_blocking —
    // `std::fs::read` is synchronous and reads up to ~16 MiB on a
    // 16 MiB-cap blob; running it on the async runtime thread would
    // block all other tokio tasks for the read window. Bundling read +
    // decode keeps both blocking ops on the worker thread; the slot
    // read guard remains in the outer task and the fair-queue
    // semantics for `vault_lock` are preserved.
    let started_ms = host.monotonic_millis();
    // The blob read moved OUT of `run_blocking` and onto the IO seam (task 13).
    // The comment above still holds for the half that stayed: the AEAD decode is
    // CPU-bound and belongs on the blocking pool. The read does not — the seam's
    // native arm dispatches its own, and the wasm arm's read is genuinely async.
    //
    // The slot read guard is still held across both, so `vault_lock`'s queued
    // write-lock request continues to wait for an in-flight decrypt.
    let blob = match io.read(&path).await {
        Ok(bytes) => bytes,
        Err(IoFailureKind::NotFound) => {
            tracing::error!(
                stage = "read_blob",
                error_kind = "NoteNotFound",
                "note_read blob read failed"
            );
            return Err(NoteReadError::NoteNotFound);
        }
        Err(io_error_kind) => {
            tracing::error!(
                stage = "read_blob",
                error_kind = "Io",
                "note_read blob read failed"
            );
            return Err(NoteReadError::Io { io_error_kind });
        }
    };

    // NC05 dispatch (automerge-sync-migration): a migrated CRDT note decodes
    // through the single-`Text` Automerge bridge, not the `MY01` codec. Branch on
    // the cleartext magic BEFORE the `MY01` decode; the AEAD + automerge `load()`
    // stays on the blocking pool (a CRDT note's `save()` grows with edit history).
    // Every arm of this block returns, so `blob` / `items_key` / `note_uuid_bytes`
    // are still available to the `MY01` path below (the CRDT branch diverges).
    if crate::plugins::notes::crdt::is_nc05_blob(&blob) {
        use crate::plugins::notes::crdt::DecodeNoteBlobError;
        let join = crate::task::run_blocking(move || {
            crate::plugins::notes::crdt::decode_note_blob(
                &blob,
                &note_uuid_bytes,
                &items_key,
                &items_key_id,
            )
        })
        .await;
        let duration_ms = host.monotonic_millis().saturating_sub(started_ms);
        let plaintext = match join {
            Err(_join_err) => {
                tracing::error!(
                    stage = "spawn_blocking_join",
                    error_kind = "JoinFailure",
                    "note_read NC05 read+decode panicked or runtime shutdown"
                );
                return Err(NoteReadError::JoinFailure);
            }
            // Same non-distinguishing §6.4 collapse as the `MY01` arm: the codec
            // logged the sub-cause; the IPC surface sees only `CannotDecrypt`.
            Ok(Err(DecodeNoteBlobError::CannotDecrypt)) => {
                tracing::debug!(
                    stage = "decode",
                    outcome = "cannot_decrypt",
                    "note_read NC05 decode returned CannotDecrypt"
                );
                return Err(NoteReadError::CannotDecrypt);
            }
            // The AEAD opened but the payload was not a well-formed single-`Text`
            // document — structural corruption, the CRDT analogue of a non-UTF-8
            // `MY01` plaintext.
            Ok(Err(DecodeNoteBlobError::Malformed)) => {
                tracing::error!(
                    stage = "decode",
                    error_kind = "InvalidPlaintextEncoding",
                    "note_read NC05 payload was not a valid single-Text document"
                );
                return Err(NoteReadError::InvalidPlaintextEncoding);
            }
            Ok(Ok(markdown)) => markdown,
        };
        drop(slot);
        tracing::debug!(
            stage = "success",
            event = "note_read",
            note_type = "nc05",
            duration_ms = duration_ms,
        );
        return Ok(plaintext);
    }

    let join_result =
        crate::task::run_blocking(move || -> Result<protocol::DecryptedNote, NoteReadError> {
            // `decode_note` parameter order is
            // (blob, note_uuid, items_key, items_key_id) — note_uuid is
            // the SECOND argument (different from `encode_new_note`'s).
            decode_note(&blob, &note_uuid_bytes, &items_key, &items_key_id).map_err(
                |_: DecryptError| {
                    // The codec emitted its sub-cause via
                    // `tracing::debug!(stage = ?cause, ...)` from inside
                    // `decode_note`; the host adds a parallel non-
                    // distinguishing event without re-introducing the
                    // distinguisher at the IPC boundary
                    // (`protocol.md` §6.4 preserved).
                    tracing::debug!(
                        stage = "decode",
                        outcome = "cannot_decrypt",
                        "note_read decode_note returned CannotDecrypt"
                    );
                    NoteReadError::CannotDecrypt
                },
            )
        })
        .await;
    let duration_ms = host.monotonic_millis().saturating_sub(started_ms);

    let decrypted = match join_result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_read read+decode panicked or runtime shutdown"
            );
            return Err(NoteReadError::JoinFailure);
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(decrypted)) => decrypted,
    };
    tracing::debug!(
        stage = "decode",
        duration_ms = duration_ms,
        "note_read read + AEAD verification + decrypt succeeded"
    );

    // UTF-8 boundary at the command layer (codec stays content_type-
    // agnostic per the Q4 grilling decision). The intermediate
    // `to_vec()` allocation is non-Zeroizing — accepted under the V8-
    // leak-dominance argument in `decisions.md` 2026-05-07: V8-side
    // retention strictly dominates this Rust-side window. The original
    // plaintext bytes inside `decrypted` (Zeroizing<Vec<u8>>) wipe on
    // `decrypted`'s drop at end-of-scope.
    let utf8_check = String::from_utf8(decrypted.plaintext().to_vec());
    drop(decrypted);
    let plaintext = match utf8_check {
        Ok(s) => s,
        Err(_) => {
            tracing::error!(
                stage = "utf8_check",
                error_kind = "InvalidPlaintextEncoding",
                "note_read post-AEAD plaintext is not valid UTF-8 — structural corruption suspected"
            );
            return Err(NoteReadError::InvalidPlaintextEncoding);
        }
    };

    drop(slot);

    tracing::debug!(stage = "success", event = "note_read");
    Ok(plaintext)
}

/// Static-string label for [`NoteReadError`] variants — same
/// discipline as [`note_create_error_kind`].
pub fn note_read_error_kind(e: &NoteReadError) -> &'static str {
    match e {
        NoteReadError::NoteNotFound => "NoteNotFound",
        NoteReadError::InvalidNoteId => "InvalidNoteId",
        NoteReadError::VaultNotUnlocked => "VaultNotUnlocked",
        NoteReadError::CannotDecrypt => "CannotDecrypt",
        NoteReadError::InvalidPlaintextEncoding => "InvalidPlaintextEncoding",
        NoteReadError::NotesDirNotADirectory => "NotesDirNotADirectory",
        NoteReadError::Io { .. } => "Io",
        NoteReadError::JoinFailure => "JoinFailure",
    }
}

/// In-process serializer for every note-blob WRITE that must be atomic with
/// respect to its own read (read → decode → guard → re-encode → write). There
/// are **three** such writers, and the list is the contract:
///
/// 1. [`note_update_with_dir`] — one note, expected-base guarded;
/// 2. `sync::orchestrator::apply_pulled_note_blob` — one note, nonce guarded;
/// 3. [`note_write_batch_with_dir`] — N notes under the §8.3 transaction, with
///    no per-note guard at all (myne#302). Its read and its publish are
///    separated by the whole encode pipeline, so it is the writer with the
///    widest window and the one with the least to fall back on.
///
/// Without the lock these interleave and a guard's decision goes stale between
/// its check and its write — or, for the batch, a concurrent write lands inside
/// the window and is overwritten by a body re-encoded from the plaintext that
/// preceded it, with no conflict, no `BaseMismatch` and a sync baseline that
/// now names a version disk does not hold.
///
/// `OnceLock<Mutex<()>>`, lazily initialized — same shape as
/// `attachments::commands::catalog_write_mutex` / prefs `write_mutex`.
/// Review invariant: NEVER held across network I/O (the orchestrator locks
/// per-blob, download outside the lock).
pub(crate) fn notes_write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Strict 64-hex → 32-byte parse for the expected-base hash. `None` on any
/// malformation — the only writer is our own autosave hook, so a bad value is
/// a frontend bug; the caller logs the canary and skips the guard (fail-open
/// to legacy overwrite beats manufacturing a spurious conflict from a bug).
fn parse_base_hash_hex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Update an existing encrypted `.myn` note in place. See module-level
/// docs for the broader pipeline narration.
///
/// **Pipeline:**
/// 1. First-line `Zeroizing::new(plaintext)` Plaintext-IPC discipline.
/// 2. Strict [`NoteId::parse`] — UI bug-canary; sub-cause via tracing.
/// 3. Slot read guard + `Slot::Unlocked(uv)` match (clone `items_key`
///    + `items_key_id` into Zeroizing wrappers; reject `Empty` /
///      `Recovering` as `VaultNotUnlocked`). Guard held across
///      `spawn_blocking + atomic_write` so `vault_lock` fair-queues per
///      `decisions.md` 2026-05-07 "Note AEAD ops".
/// 4. `spawn_blocking { std::fs::read → decode_note → encode_update }`
///    — `encode_update` consumes the [`protocol::DecryptedNote`] handle
///    (typestate "one decode, one update"); fresh `content_nonce` is
///    generated internally by the convenience wrapper; bytes 0..47+N
///    of the new blob are byte-identical to the previous blob per
///    `protocol.md` §6.3.
/// 5. `atomic_write(replace=true)` — `decisions.md` 2026-05-07
///    `atomic_write` durability + `replace:bool` parameter pin.
/// 6. Drop guard, emit `event = "note_updated"`.
///
/// **Failure mapping** (closed-enum, drift-free MYND-26 mirror per
/// `decisions.md` 2026-05-07 "`note_update` error surface"):
/// - `InvalidNoteId` — strict parse rejected (sub-cause via tracing).
/// - `VaultNotUnlocked` — slot is `Empty` or `Recovering`.
/// - `NoteNotFound` — `<vault>/notes/<id>.myn` missing during read
///   (autosave-after-delete race signal; q1 decision keeps this
///   distinct from `CannotDecrypt`).
/// - `CannotDecrypt` — AEAD-tag failure on `decode_note`; non-
///   distinguishing per `protocol.md` §6.4.
/// - `PlaintextTooLarge` — `protocol::ProtocolError::PlaintextTooLarge`
///   from `encode_update`; cap is sole canonical enforcement in the
///   protocol crate (no host-side pre-check).
/// - `NotesDirNotADirectory` — `<vault>/notes` is a regular file
///   (defensive bug-canary parallel to MYND-26).
/// - `Io` — residual filesystem failure.
/// - `JoinFailure` — `spawn_blocking` panic / runtime shutdown,
///   absorbing v0.1-unreachable `ProtocolError::Csprng` /
///   `ProtocolError::AeadFailure` paths defensively.
// Eight arguments (host, state, hooks, note id, plaintext, expected base, io, live
// registry), the three-layer core command shape plus the single-writer registry,
// the same count every `*_from_host` in this tree already runs at.
#[allow(clippy::too_many_arguments)]
pub async fn note_update_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    note_id: String,
    plaintext: String,
    expected_base_hash_hex: Option<String>,
    io: &dyn VaultIo,
    registry: &crate::plugins::live::LiveSessionRegistry,
) -> Result<(), NoteUpdateError> {
    // Single-writer refusal (`SYNC-33`, `collab-editor-bridge`): while a live
    // co-editing session owns this note it IS the only durable writer, so a
    // stateless save is refused rather than racing the session's persistence.
    // Checked before any work; nothing is written.
    if registry.is_note_open(&note_id) {
        tracing::debug!(
            stage = "live_session",
            outcome = "refused",
            "note_update refused: a live co-editing session owns this note"
        );
        return Err(NoteUpdateError::LiveSessionOpen);
    }
    // First-line Plaintext-IPC wrap (`src-tauri/AGENTS.md`): bound the
    // index-feeding copy to `Zeroizing` so it wipes on every early-return and
    // at function exit rather than lingering as a plain `String` across the
    // `.await`. The core takes a fresh plain clone and re-wraps it first-line.
    let plaintext = Zeroizing::new(plaintext);
    let notes_dir = paths::notes_dir_for_host_io(host, io, state.active_vault_id().await)
        .await
        .map_err(|e| {
            let kind = e.kind();
            match kind {
                std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "NotesDirNotADirectory",
                        "note_update notes_dir resolution conflicted with a non-dir entry"
                    );
                    NoteUpdateError::NotesDirNotADirectory
                }
                other => {
                    let io_kind = from_io_error_kind(other);
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "Io",
                        io_failure_kind = ?io_kind,
                        "note_update notes_dir resolution failed"
                    );
                    NoteUpdateError::Io {
                        io_error_kind: io_kind,
                    }
                }
            }
        })?;
    // Expected-base guard input (§11.3 ms-race closure): strict-parse or skip.
    // A malformed value is a frontend bug — canary-trace + fail-open to the
    // legacy overwrite (never manufacture a spurious BaseMismatch from a bug).
    let expected_base_hash = match expected_base_hash_hex.as_deref() {
        None => None,
        Some(s) => match parse_base_hash_hex(s) {
            Some(h) => Some(h),
            None => {
                tracing::error!(
                    stage = "base_guard",
                    outcome = "malformed_hash",
                    "note_update expected_base_hash_hex failed strict parse — guard skipped"
                );
                None
            }
        },
    };
    // MYND-29 Task 4: re-index the edited note (replace semantics drop the
    // stale terms and add the new ones) after a successful write.
    let result = note_update_with_dir(
        notes_dir,
        state,
        hooks,
        note_id.clone(),
        (*plaintext).clone(),
        expected_base_hash,
        io,
        host,
    )
    .await;
    match result {
        Ok(outcome) => {
            // MYND-29: re-index the edited note after a successful write.
            // MYND-448a: note body indexed UNFOLDED; embedded attachments are
            // re-indexed as their own docs (dropping any no longer embedded).
            let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
            // A TOMBSTONE is a removal from the index, not a re-index of it
            // (test-audit #20). With sync configured, a permanent delete is not
            // an unlink — `deleteNoteRouted` writes a `deleted:` frontmatter
            // stamp through this very command, so a purge arrives here as an
            // ordinary update. Upserting it put the purged note's FULL BODY back
            // into the live BM25 index, where it stayed for the rest of the
            // session and was then sealed into `vault.search` at lock. The only
            // thing keeping it out of the palette was the sidebar cache's
            // `trashed:` predicate, and a tombstoned note has already left that
            // cache — so the predicate could not filter it and the note kept
            // answering searches until the next unlock's hydrate dropped it.
            //
            // `fm_deleted_value_strict` is the same strict reader the daily-note
            // matcher uses, so "is this deleted" has one answer in this crate.
            let fm_bytes = extract_title_slices(plaintext.as_bytes()).frontmatter_bytes;
            let tombstoned = fm_bytes.and_then(fm_deleted_value_strict).is_some();
            if tombstoned {
                hooks.search_remove(&note_id);
            } else if is_drawing(plaintext.as_bytes()) {
                let body = project_drawing_text(plaintext.as_bytes()).unwrap_or_default();
                hooks.search_upsert(&note_id, &title, &body);
            } else {
                hooks.search_upsert(&note_id, &title, &plaintext);
                hooks
                    .index_note_attachments(state, &note_id, &title, &plaintext)
                    .await;
            }
            // MYND-424: mark the sync loop dirty so the coalesced push fires
            // (soft dependency — a no-op when the sync plugin isn't registered).
            hooks.bump_local_change();
            // myne-md/myne#839: a soft-trash or archive takes the note out of
            // the live tree exactly as a permanent delete does, so a detached
            // (pop-out) window holding it must reach the same terminal state.
            // Before this it did not: `trashNote`/`archiveNote` are ordinary
            // `note_update` writes and only the hard-delete path emitted
            // `notes://deleted`, so the pop-out stayed open and its next
            // autosave wrote its stale buffer back without the just-set
            // `trashed:`/`archived:` field, resurrecting the note the user had
            // removed. Emitting through `HostCtx` (not the desktop-only hooks)
            // means every client inherits the behaviour, and folding in the
            // `deleted:` tombstone closes the same gap for the routed permanent
            // delete, which also arrives here as a plain update. Payload is the
            // note id only, never plaintext, matching the hard-delete event.
            let removed_from_live_tree = tombstoned
                || fm_bytes.and_then(fm_trashed_value_strict).is_some()
                || fm_bytes.and_then(fm_archived_value_strict).is_some();
            if removed_from_live_tree {
                host.emit(
                    NOTES_DELETED_EVENT,
                    crate::host::EventPayload::Text(note_id.clone()),
                );
            }
            // SYNC-8: a best-effort snapshot failure is surfaced non-blockingly
            // (the note itself saved fine). The frontend shows it on the
            // save-status channel; the IPC return stays `Ok(())`.
            if outcome.snapshot_warning {
                hooks.emit_snapshot_write_failed(&note_id);
            }
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// IPC wrapper. Delegates; the name and payload the frontend sends are
/// unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn note_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    registry: State<'_, crate::plugins::live::LiveSessionRegistry>,
    note_id: String,
    plaintext: String,
    expected_base_hash_hex: Option<String>,
) -> Result<(), NoteUpdateError> {
    note_update_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        note_id,
        plaintext,
        expected_base_hash_hex,
        &crate::vault_io::StdVaultIo,
        registry.inner(),
    )
    .await
}

/// Tauri event emitted (non-blocking) when a note saved successfully but its
/// best-effort pre-overwrite snapshot could not be written (SYNC-8). Payload is
/// the note id. The frontend surfaces this on the save-status channel; it never
/// blocks editing and never implies the live note was lost.
pub const SNAPSHOT_WRITE_FAILED_EVENT: &str = "snapshot://write-failed";

/// Tauri event emitted (non-blocking) when a note leaves the live tree: a hard
/// delete, a soft-trash, an archive, or the `deleted:` tombstone the routed
/// permanent delete writes (myne-md/myne#681; the soft-removal half is
/// myne-md/myne#839). Payload is the note id. A detached (pop-out) note window
/// holding that id shows the terminal "removed elsewhere" state instead of
/// autosaving its stale buffer back; every other window ignores an id it does not
/// hold. The change/rename reload path reuses the existing `sync://changed`
/// instead (removals are one-shot, so this needs its own event and is not the
/// autosave path).
pub const NOTES_DELETED_EVENT: &str = "notes://deleted";

/// Internal outcome of [`note_update_with_dir`] — carries a non-blocking
/// snapshot-failure signal out to the `note_update` wrapper without changing the
/// IPC contract (which stays `Result<(), NoteUpdateError>`).
#[derive(Debug, Default)]
pub struct NoteUpdateOutcome {
    /// True if the best-effort pre-overwrite snapshot could not be written. The
    /// note itself saved correctly.
    pub snapshot_warning: bool,
}

/// Inner — pure-and-testable helper. Mirror of
/// [`note_create_with_dir`] / [`note_read_with_dir`].
///
/// `expected_base_hash` (the §11.3 expected-base guard): when `Some`, the
/// SHA-256 of the CURRENT on-disk plaintext must equal it or the update is
/// rejected as [`NoteUpdateError::BaseMismatch`] with **no write, no snapshot,
/// no index touch** — a sync pull-apply advanced the note underneath the
/// editor and the caller resolves via local keep-both. `None` = legacy
/// last-write-wins (every non-autosave caller, snapshots restore, mobile).
// Clippy's arity limit (8/7), and it is pointing at something real rather than
// being noise: `io` and `host` now travel TOGETHER through every ported
// signature in this crate, which means they are one concept wearing two
// parameters.
//
// The right fix is a `Platform<'a> { io: &'a dyn VaultIo, host: &'a dyn HostCtx }`
// passed as a single argument — it would shorten every signature the port has
// touched, and it would make the pairing explicit instead of conventional.
// Deliberately NOT done inside this port: it is a wide mechanical change across
// work that is currently green and uncommitted, and bundling a refactor into a
// migration is how both become unreviewable.
//
// Recorded as debt with the fix named, so this `allow` is a decision rather
// than a silenced lint.
#[allow(
    clippy::too_many_arguments,
    reason = "seam pair; see the Platform struct note above"
)]
pub async fn note_update_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    note_id: String,
    plaintext: String,
    expected_base_hash: Option<[u8; 32]>,
    io: &dyn VaultIo,
    host: &dyn HostCtx,
) -> Result<NoteUpdateOutcome, NoteUpdateError> {
    // First non-doc statement: bound the lifetime of plaintext bytes
    // to a `Zeroizing<String>` wrapper. Same Plaintext-IPC discipline
    // as `note_create_with_dir` (see `src-tauri/AGENTS.md`).
    let plaintext = Zeroizing::new(plaintext);

    // Strict NoteId parse FIRST — before any path concatenation.
    let note_id = NoteId::parse(&note_id).map_err(|cause| {
        tracing::debug!(stage = ?cause, "note_update note_id strict-parse failed");
        NoteUpdateError::InvalidNoteId
    })?;
    tracing::debug!(stage = "note_id_parse", outcome = "ok");

    // Slot read guard. Held across `spawn_blocking + atomic_write` so
    // `tokio::sync::RwLock`'s fair queueing gives `vault_lock`
    // wait-and-complete semantics — same uniform pattern as
    // `note_create_with_dir` / `note_read_with_dir` per
    // `decisions.md` 2026-05-07 "Note AEAD ops".
    let slot = state.slot_read_active().await;
    let (items_key, items_key_id) = match &*slot {
        Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_update rejected: slot is not Unlocked"
            );
            return Err(NoteUpdateError::VaultNotUnlocked);
        }
    };
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    // Serialize this read→decode→guard→re-encode→write pipeline against the
    // sync pull-apply writer (see `notes_write_mutex` doc). Acquired AFTER the
    // slot guard — the only site taking both, so the slot→notes order can
    // never invert (the orchestrator locks with keys already cloned, no slot
    // guard held). Held through the post-closure `atomic_write`; dropped
    // explicitly before the slot guard below. CPU-only under the lock.
    let notes_guard = notes_write_mutex().lock().await;

    let path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
    let note_uuid_bytes = *note_id.as_uuid().as_bytes();
    let path_for_read = path.clone();

    // MYND-96 snapshot creation hook inputs (moved into the closure below).
    // `vault_root` is the parent of `notes/`; the flat `snapshots/` dir is its
    // sibling. `now_ms` is the single clock read, fed to the pure
    // `should_snapshot` gate. The snapshot of the OLD content is written inside
    // the closure (before this fn's post-closure `atomic_write` overwrites the
    // live note), so a failed snapshot can never corrupt the note. Best-effort
    // (SYNC-8): snapshot failure never fails the update.
    let note_uuid_str = note_id.as_uuid().to_string();
    let vault_root = notes_dir.parent().map(|p| p.to_path_buf());
    // Single wall-clock read fed to the snapshot coalescing gate (a pre-1970 /
    // unset clock yields 0, treated conservatively as "within window"). Computed
    // here in core rather than via the desktop-only `snapshot_store` so the
    // snapshot machinery stays fully behind the hooks seam.
    //
    // Through the host seam (task 13): `SystemTime::now()` panics on wasm32.
    // This was already hoisted out of the blocking closure, so the port is one
    // line — and it is a WALL clock on purpose, not the monotonic one: the
    // coalescing gate compares against a timestamp persisted in a previous
    // session, which a per-process monotonic reading cannot be compared to.
    let now_ms = host.now_unix_millis();
    // This device's Automerge actor (`SYNC-42`), resolved here because the
    // blocking closure below is `'static` and cannot borrow `io`. `None` (no
    // device identity) keeps the edited document's inherited actor.
    let device_actor = match vault_root.as_deref() {
        Some(root) => crate::plugins::sync::state::read_device_actor(io, root).await,
        None => None,
    };
    // The snapshot-capture side-effect rides the hooks seam (desktop wires the
    // real snapshot store; mobile is a no-op). Clone the `Arc` so it moves into
    // the blocking closure alongside the other captured inputs.
    let hooks = hooks.clone();

    // spawn_blocking pipeline: read .myn → decode_note → encode_update.
    // `encode_update` consumes the `DecryptedNote` handle (typestate
    // "one decode, one update"); fresh `content_nonce` generated
    // internally; bytes 0..47+N byte-identical per §6.3.
    let started_ms = host.monotonic_millis();
    // The blob read moved onto the IO seam, out of the closure — same split as
    // `note_read`: the decode + re-encode stay on the blocking pool, the read
    // does not.
    let blob_bytes = match io.read(&path_for_read).await {
        Ok(bytes) => bytes,
        Err(IoFailureKind::NotFound) => {
            tracing::error!(
                stage = "read_blob",
                error_kind = "NoteNotFound",
                "note_update blob read failed"
            );
            return Err(NoteUpdateError::NoteNotFound);
        }
        Err(io_error_kind) => {
            tracing::error!(
                stage = "read_blob",
                error_kind = "Io",
                "note_update blob read failed"
            );
            return Err(NoteUpdateError::Io { io_error_kind });
        }
    };

    // NC05 dispatch (automerge-sync-migration): a migrated CRDT note edits through
    // the single-`Text` bridge (a whole-`Text` replace preserving change-graph
    // ancestry, so a peer's concurrent edit still merges), NOT `MY01`'s
    // `encode_update`. And per ASM-12→B it captures **no snapshot** — the CRDT
    // change-graph *is* the note's history, so the snapshot store it would feed is
    // retired for CRDT notes. Every arm returns, leaving the `MY01` pipeline below
    // intact (this branch diverges, so its moves do not consume the shared bindings
    // the `MY01` path needs).
    if crate::plugins::notes::crdt::is_nc05_blob(&blob_bytes) {
        use crate::plugins::notes::crdt::{CrdtNoteOpError, DecodeNoteBlobError};
        let join = crate::task::run_blocking(move || -> Result<Vec<u8>, NoteUpdateError> {
            // Expected-base guard (§11.3), against the DECODED markdown — the same
            // property as the `MY01` arm, one representation over.
            if let Some(expected) = expected_base_hash {
                use sha2::{Digest, Sha256};
                let base_md = crate::plugins::notes::crdt::decode_note_blob(
                    &blob_bytes,
                    &note_uuid_bytes,
                    &items_key,
                    &items_key_id,
                )
                .map_err(|e| match e {
                    // Non-distinguishing §6.4 collapse: either the base could not
                    // be read, so the guard cannot be evaluated safely.
                    DecodeNoteBlobError::CannotDecrypt | DecodeNoteBlobError::Malformed => {
                        NoteUpdateError::CannotDecrypt
                    }
                })?;
                let disk_hash: [u8; 32] = Sha256::digest(base_md.as_bytes()).into();
                if disk_hash != expected {
                    tracing::debug!(
                        stage = "base_guard",
                        outcome = "mismatch",
                        "note_update NC05 rejected: on-disk base advanced past the caller's declared base"
                    );
                    return Err(NoteUpdateError::BaseMismatch);
                }
                tracing::debug!(stage = "base_guard", outcome = "match");
            }
            let upd = crate::plugins::notes::crdt::encode_note_edit_at_millis(
                &blob_bytes,
                &plaintext,
                device_actor.as_ref(),
                &items_key,
                &items_key_id,
                &note_uuid_bytes,
                now_ms,
            )
            .map_err(|e| match e {
                CrdtNoteOpError::TooLarge => NoteUpdateError::PlaintextTooLarge,
                CrdtNoteOpError::CannotDecrypt | CrdtNoteOpError::Malformed => {
                    NoteUpdateError::CannotDecrypt
                }
                // Entropy failure while re-sealing — the CRDT analogue of the
                // `MY01` arm's unreachable-ProtocolError → JoinFailure.
                // `RevisionNotFound` belongs to the history reader, not to a
                // write; it cannot arise here and collapses the same way.
                CrdtNoteOpError::Csprng | CrdtNoteOpError::RevisionNotFound => {
                    NoteUpdateError::JoinFailure
                }
            })?;
            Ok(upd.blob)
        })
        .await;
        let duration_ms = host.monotonic_millis().saturating_sub(started_ms);
        let new_blob = match join {
            Err(_join_err) => {
                tracing::error!(
                    stage = "spawn_blocking_join",
                    error_kind = "JoinFailure",
                    "note_update NC05 read+decode+encode panicked or runtime shutdown"
                );
                return Err(NoteUpdateError::JoinFailure);
            }
            Ok(Err(e)) => return Err(e),
            Ok(Ok(b)) => b,
        };
        // Shared write tail (mirrors the `MY01` path below).
        if let Err(io_error_kind) = io.write(&path, &new_blob, WriteOpts::default()).await {
            let mapped = if !io.is_dir(&notes_dir).await.unwrap_or(true) {
                NoteUpdateError::NotesDirNotADirectory
            } else {
                NoteUpdateError::Io { io_error_kind }
            };
            tracing::error!(
                stage = "atomic_write",
                error_kind = note_update_error_kind(&mapped),
                "note_update NC05 atomic_write failed"
            );
            return Err(mapped);
        }
        drop(notes_guard);
        drop(slot);
        tracing::debug!(
            stage = "success",
            event = "note_updated",
            note_type = "nc05",
            duration_ms = duration_ms,
        );
        // A CRDT note captures no snapshot → never a snapshot warning.
        return Ok(NoteUpdateOutcome {
            snapshot_warning: false,
        });
    }

    let join_result =
        crate::task::run_blocking(move || -> Result<(Vec<u8>, bool), NoteUpdateError> {
            let blob = blob_bytes;
            // `decode_note` parameter order matches `note_read_with_dir`:
            // (blob, note_uuid, items_key, items_key_id). The codec
            // emits its sub-cause via `tracing::debug!(stage = ?cause)`
            // from inside `decode_note`; host adds parallel non-
            // distinguishing event without re-introducing the
            // distinguisher at the IPC boundary (`protocol.md` §6.4).
            let decrypted = decode_note(&blob, &note_uuid_bytes, &items_key, &items_key_id)
                .map_err(|_: DecryptError| {
                    tracing::debug!(
                        stage = "decode_note",
                        outcome = "cannot_decrypt",
                        "note_update decode_note returned CannotDecrypt"
                    );
                    NoteUpdateError::CannotDecrypt
                })?;
            // Expected-base guard (§11.3): the current on-disk plaintext must
            // still be the base the caller edited from. Checked BEFORE the
            // snapshot capture and `encode_update` — a rejected save leaves
            // disk, snapshots, and indices untouched. The hash VALUE is
            // plaintext-derived and never logged (outcome only). Plain `==`:
            // both sides are the same trust domain, no timing-oracle concern.
            if let Some(expected) = expected_base_hash {
                use sha2::{Digest, Sha256};
                let disk_hash: [u8; 32] = Sha256::digest(decrypted.plaintext()).into();
                if disk_hash != expected {
                    tracing::debug!(
                        stage = "base_guard",
                        outcome = "mismatch",
                        "note_update rejected: on-disk base advanced past the caller's declared base"
                    );
                    return Err(NoteUpdateError::BaseMismatch);
                }
                tracing::debug!(stage = "base_guard", outcome = "match");
            }
            // `encode_update` consumes `decrypted` and pulls a fresh
            // 24-byte `content_nonce` from `getrandom` internally.
            match encode_update(decrypted, plaintext.as_bytes()) {
                Ok(new_blob) => {
                    // MYND-96: capture a snapshot of the OLD content (`blob`,
                    // the verbatim pre-overwrite `.myn`) before returning the
                    // new blob to the post-closure overwrite. Gated by the
                    // coalescing window; best-effort. The returned bool (snapshot
                    // failed → surface a non-blocking warning) rides out with the
                    // new blob, so the live note save is never affected.
                    let snapshot_warning = match vault_root.as_deref() {
                        Some(root) => hooks.capture_snapshot(
                            root,
                            &note_uuid_str,
                            &blob,
                            now_ms,
                            /* force = */ false,
                        ),
                        None => false,
                    };
                    Ok((new_blob, snapshot_warning))
                }
                Err(ProtocolError::PlaintextTooLarge) => {
                    tracing::debug!(
                        stage = "encode_update",
                        error_kind = "PlaintextTooLarge",
                        "note_update rejected: plaintext exceeds MAX_PLAINTEXT_LEN"
                    );
                    Err(NoteUpdateError::PlaintextTooLarge)
                }
                Err(_other_protocol_err) => {
                    // v0.1 fixed parameters make AEAD seal failure
                    // unreachable: `item_key` is 32 bytes by type,
                    // nonces are 24 bytes from `getrandom`, AAD widths
                    // are compile-time const, plaintext boundary
                    // already checked by encode_update. If this fires,
                    // it's a v0.1 invariant violation; surface as
                    // JoinFailure (panic-equivalent semantic).
                    tracing::error!(
                        stage = "encode_update",
                        error_kind = "JoinFailure",
                        "note_update encode_update returned an unreachable ProtocolError under v0.1 fixed params"
                    );
                    Err(NoteUpdateError::JoinFailure)
                }
            }
        })
        .await;
    let duration_ms = host.monotonic_millis().saturating_sub(started_ms);

    let (new_blob, snapshot_warning) = match join_result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_update read+decode+encode panicked or runtime shutdown"
            );
            return Err(NoteUpdateError::JoinFailure);
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(pair)) => pair,
    };
    tracing::debug!(
        stage = "encode_update",
        duration_ms = duration_ms,
        "note_update read + AEAD verify + re-encrypt succeeded"
    );

    // Atomic write with replace=true semantic — bytes 0..47+N are
    // byte-identical to the previous blob; `atomic_write` durably
    // commits the rename per `decisions.md` 2026-05-07 atomic_write
    // entry.
    // Through the IO seam (task 13). `WriteOpts::default()` carries the
    // `replace = true` semantic, and on the native arm the seam delegates to the
    // very same `atomic_write` — so desktop durability is unchanged by reading,
    // not only by testing.
    //
    // `NotesDirNotADirectory` recovered by asking, as in `note_create`: the
    // seam's closed vocabulary has no `NotADirectory`, but `is_dir` answers the
    // question directly, and only on an already-failing path.
    if let Err(io_error_kind) = io.write(&path, &new_blob, WriteOpts::default()).await {
        let mapped = if !io.is_dir(&notes_dir).await.unwrap_or(true) {
            NoteUpdateError::NotesDirNotADirectory
        } else {
            NoteUpdateError::Io { io_error_kind }
        };
        tracing::error!(
            stage = "atomic_write",
            error_kind = note_update_error_kind(&mapped),
            "note_update atomic_write failed"
        );
        return Err(mapped);
    }

    // Explicit drops — make both lock-release points visible (notes-write
    // mutex first, then the slot read guard: inverse of acquisition).
    drop(notes_guard);
    drop(slot);

    tracing::debug!(stage = "success", event = "note_updated");
    Ok(NoteUpdateOutcome { snapshot_warning })
}

/// Static-string label for [`NoteUpdateError`] variants — same
/// drift-detector discipline as [`note_create_error_kind`] /
/// [`note_read_error_kind`]. A new variant compile-fails this match.
pub fn note_update_error_kind(e: &NoteUpdateError) -> &'static str {
    match e {
        NoteUpdateError::VaultNotUnlocked => "VaultNotUnlocked",
        NoteUpdateError::InvalidNoteId => "InvalidNoteId",
        NoteUpdateError::NoteNotFound => "NoteNotFound",
        NoteUpdateError::PlaintextTooLarge => "PlaintextTooLarge",
        NoteUpdateError::CannotDecrypt => "CannotDecrypt",
        NoteUpdateError::NotesDirNotADirectory => "NotesDirNotADirectory",
        NoteUpdateError::Io { .. } => "Io",
        NoteUpdateError::JoinFailure => "JoinFailure",
        NoteUpdateError::BaseMismatch => "BaseMismatch",
        NoteUpdateError::LiveSessionOpen => "LiveSessionOpen",
    }
}

/// One note in a transactional batch rewrite: the canonical `note_id`
/// string + the full rewritten plaintext body that replaces it. Mirrors
/// the `note_update` IPC shape (`{ noteId, plaintext }`) per item; the
/// frontend (`src/notes/renameInbound.ts`, MYND-85 task 4) builds the
/// array from `planInboundRewrites`. `plaintext` is the *new* body
/// (title swap on the renamed note, inbound `[[…]]` rewrites on the
/// others), NOT a diff.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteBatchUpdate {
    pub note_id: String,
    pub plaintext: String,
}

/// `note_write_batch_transactional` — re-encrypt and atomically rewrite
/// **N existing notes all-or-nothing** (`wikilink.md` §8.3 / WL-7). This
/// is the host half of wikilink rename auto-update: a title rename
/// rewrites the renamed note's own body PLUS every inbound `[[…]]`-bearing
/// note, and §8.3 requires the whole set to land together — a partial
/// commit genuinely breaks links (an un-rewritten `[[Old Title]]`
/// resolves to no note). The TS orchestrator (MYND-85 task 4) pre-flushes
/// any open+dirty inbound pane (WL-8 / SYNC-15) before invoking, so this
/// command only ever disk-rewrites notes it is safe to clobber.
///
/// Each item runs the **same AEAD pipeline as `note_update`** — read the
/// existing `.myn` → `decode_note` (preserves the per-note `item_key`
/// typestate) → `encode_update` (fresh `content_nonce`, §6.3 byte-
/// identical 0..47+N). The N encoded blobs are then committed through
/// [`crate::note_txn::write_batch_transactional`]: stage every
/// `<uuid>.myn.tmp` → empty `.rename-journal` marker → commit all renames
/// → clear marker; a crash mid-commit is roll-forward-recovered on the
/// next unlock ([`crate::note_txn::recover_pending_rename`], MYND-85
/// task 3c). Any per-note failure (missing file, decrypt failure,
/// oversize body) aborts the **whole** batch with the vault untouched —
/// there is no per-item partial-success surface.
///
/// **Secret-handling** (`src-tauri/AGENTS.md`): every plaintext is
/// first-line `Zeroizing`-wrapped; `note_id`, plaintext, and full paths
/// never reach any `tracing` line; the encode runs on a `spawn_blocking`
/// thread with the slot read-guard held across it (same `vault_lock`
/// fair-queueing as `note_update`).
///
/// On success, each rewritten note is re-indexed into the live search
/// index (MYND-29 parity with `note_update`); the wikilink-graph reindex
/// is the orchestrator's job (it bumps the index nonce after this
/// resolves). Snapshots are deliberately NOT captured here — a rename is
/// a deterministic, reversible mechanical rewrite, and coupling the
/// transaction to the best-effort snapshot subsystem would add a
/// failure-ambiguity surface for no integrity gain (§8.3 is about
/// crash-atomicity, not undo history).
pub async fn note_write_batch_transactional_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    registry: &crate::plugins::live::LiveSessionRegistry,
    notes: Vec<NoteBatchUpdate>,
) -> Result<(), NoteBatchError> {
    // First-line Plaintext-IPC discipline: bound every body to a
    // `Zeroizing<String>` so each wipes on every early-return and at
    // function exit rather than lingering as plain `String` across the
    // `.await`. Keep the (id, body) pairs in this outer scope for the
    // post-commit re-index; the inner helper takes a borrowed slice and
    // re-wraps a fresh clone per body for the move into `spawn_blocking`.
    let items: Vec<(String, Zeroizing<String>)> = notes
        .into_iter()
        .map(|n| (n.note_id, Zeroizing::new(n.plaintext)))
        .collect();

    // Empty batch is a no-op success (a rename with zero inbound links and
    // — by the orchestrator's construction — at least the renamed note,
    // but defend the degenerate call anyway). Resolve `notes_dir` only
    // when there is work.
    if items.is_empty() {
        return Ok(());
    }

    // Through the IO SEAM, not `std::fs` (myne#299). `notes_dir_for_host` ends in
    // `require_vault_root`, a `Path::is_dir` stat, and on
    // wasm32-unknown-unknown that is the unsupported-platform stub — always
    // false. So this command returned `Io { NotFound }` unconditionally on every
    // web client, before a single note was read or written, and note rename and
    // folder rename/move were simply dead there while the identical code worked
    // on desktop: precisely the divergence the seam exists to prevent. The batch
    // is never empty on either path (the renamed note's own rewritten body is
    // always in it), so the early return above never covered it.
    let notes_dir = paths::notes_dir_for_host_io(host, io, state.active_vault_id().await)
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
                tracing::error!(
                    stage = "notes_dir",
                    error_kind = "NotesDirNotADirectory",
                    "note_write_batch notes_dir resolution conflicted with a non-dir entry"
                );
                NoteBatchError::NotesDirNotADirectory
            }
            other => {
                let io_kind = from_io_error_kind(other);
                tracing::error!(
                    stage = "notes_dir",
                    error_kind = "Io",
                    io_failure_kind = ?io_kind,
                    "note_write_batch notes_dir resolution failed"
                );
                NoteBatchError::Io {
                    io_error_kind: io_kind,
                }
            }
        })?;

    note_write_batch_with_dir(
        io,
        notes_dir,
        state,
        &items,
        host.now_unix_millis(),
        registry,
    )
    .await?;

    // MYND-29 parity with `note_update`: re-index every rewritten note so
    // full-text search reflects the new bodies (esp. the renamed note's
    // new title). The graph/backlink reindex is the orchestrator's
    // follow-up (it bumps the index nonce once this resolves).
    for (note_id, plaintext) in &items {
        let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
        // MYND-448a: unfolded note body doc + separate attachment docs.
        // SF5 (MYND-502): a `kind: drawing` body → projected scene text, never raw
        // JSON (SYNC-4) and no attachment docs; AI re-embeds over the same.
        if is_drawing(plaintext.as_bytes()) {
            let body = project_drawing_text(plaintext.as_bytes()).unwrap_or_default();
            hooks.search_upsert(note_id, &title, &body);
        } else {
            hooks.search_upsert(note_id, &title, plaintext);
            hooks
                .index_note_attachments(state, note_id, &title, plaintext)
                .await;
        }
    }
    tracing::debug!(
        stage = "success",
        count = items.len(),
        "note_write_batch committed + re-indexed"
    );
    Ok(())
}

/// IPC wrapper. Delegates; the name and payload the frontend sends are
/// unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn note_write_batch_transactional<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    registry: State<'_, crate::plugins::live::LiveSessionRegistry>,
    notes: Vec<NoteBatchUpdate>,
) -> Result<(), NoteBatchError> {
    note_write_batch_transactional_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        registry.inner(),
        notes,
    )
    .await
}

/// Testable core of [`note_write_batch_transactional`]: takes a resolved
/// `notes_dir` + borrowed `(id, body)` slice so tests exercise the full
/// parse → slot-guard → AEAD → transactional-commit pipeline under a
/// `ScopedTempDir` without a Tauri runtime. Mirror of
/// [`note_update_with_dir`], generalized to N notes under one transaction.
pub async fn note_write_batch_with_dir(
    io: &dyn VaultIo,
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    items: &[(String, Zeroizing<String>)],
    // The wall clock for an `NC05` re-encode, pre-read by the caller. The
    // blocking closure below is `'static` and cannot borrow `&dyn HostCtx`, so
    // the timestamp is threaded in — the same shape
    // `crdt::encode_note_edit_at_millis` exists for.
    now_millis: u64,
    registry: &crate::plugins::live::LiveSessionRegistry,
) -> Result<(), NoteBatchError> {
    if items.is_empty() {
        return Ok(());
    }
    // Single-writer refusal (`SYNC-33`, `collab-editor-bridge`): a note a live
    // session owns has that session as its only durable writer, so a rename/move
    // batch is refused rather than writing behind it (which the session's next
    // flush, or the pane's next save, would silently discard). Checked before any
    // filesystem touch, over EVERY item.
    for (note_id, _) in items {
        if registry.is_note_open(note_id) {
            return Err(NoteBatchError::LiveSessionOpen);
        }
    }
    // Kept for the commit, which happens after the blocking closure consumes
    // its own copy (task 86).
    let notes_dir_for_commit = notes_dir.clone();
    // This device's Automerge actor (`SYNC-42`) for the NC05 re-encode below,
    // resolved before the `'static` closure (which cannot borrow `io`). `None`
    // keeps the edited documents' inherited actor.
    let device_actor = match notes_dir.parent() {
        Some(root) => crate::plugins::sync::state::read_device_actor(io, root).await,
        None => None,
    };

    // Strict-parse EVERY note_id before any filesystem touch (a malformed
    // id never reaches a path). Re-wrap each body in a fresh `Zeroizing`
    // clone to move into the blocking closure; the caller's originals stay
    // for re-indexing.
    let mut parsed: Vec<(NoteId, Zeroizing<String>)> = Vec::with_capacity(items.len());
    for (id, body) in items {
        let note_id = NoteId::parse(id).map_err(|cause| {
            tracing::debug!(stage = ?cause, "note_write_batch note_id strict-parse failed");
            NoteBatchError::InvalidNoteId
        })?;
        parsed.push((note_id, Zeroizing::new((**body).clone())));
    }

    // Slot read guard. Held across `spawn_blocking` so `vault_lock`
    // fair-queues behind the whole transaction — same uniform pattern as
    // `note_update_with_dir`.
    let slot = state.slot_read_active().await;
    let (items_key, items_key_id) = match &*slot {
        Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_write_batch rejected: slot is not Unlocked"
            );
            return Err(NoteBatchError::VaultNotUnlocked);
        }
    };
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    // Serialize this read→decode→re-encode→write pipeline against the other two
    // note-blob writers (myne#302). It is the same shape `note_update_with_dir`
    // takes the lock for, over N notes instead of one, and it shipped without
    // it: the closure below reads every blob and nothing is published until
    // `write_batch_transactional` far below, so anything that wrote a note
    // inside that window was silently overwritten by a body re-encoded from the
    // pre-write plaintext.
    //
    // Both interleavings are reachable from an ordinary wikilink rename:
    //
    //   - the sync cycle applies another device's edit of X through
    //     `apply_pulled_note_blob`, whose in-lock nonce re-check sees the
    //     pre-batch blob (the batch has published nothing yet), adopts the
    //     remote version as the new baseline, and is then overwritten. The
    //     baseline now records a version disk does not hold, so the next scan
    //     reads X as a local change and pushes the stale body to every device;
    //   - with no sync and no second device, an autosave `note_update` for X
    //     fires after the WL-8 pane flush, passes its §11.3 base guard against
    //     the still-unpublished blob, writes, and is overwritten — the editor
    //     having reported the save as successful.
    //
    // Acquired AFTER the slot guard, matching `note_update_with_dir`: those two
    // are the only sites taking both, so the slot→notes order cannot invert.
    // Held across the blocking pipeline AND the commit; dropped explicitly
    // before the slot guard. No network IO under it (the review invariant on
    // `notes_write_mutex`) — the batch is disk and CPU only.
    let notes_guard = notes_write_mutex().lock().await;

    // spawn_blocking pipeline: for each note read .myn → decode_note →
    // encode_update; build the TxnBlob set; then commit all-or-nothing.
    // Every fallible step aborts the whole closure (and thus the batch)
    // BEFORE `write_batch_transactional` stages anything, so a failure
    // leaves the vault untouched.
    let started = Instant::now();
    let join_result =
        crate::task::run_blocking(move || -> Result<Vec<crate::note_txn::TxnBlob>, NoteBatchError> {
        let mut blobs: Vec<crate::note_txn::TxnBlob> = Vec::with_capacity(parsed.len());
        for (note_id, plaintext) in &parsed {
            let uuid = note_id.as_uuid();
            let note_uuid_bytes = *uuid.as_bytes();
            let dst = notes_dir.join(format!("{uuid}.myn"));

            let old_blob = std::fs::read(&dst).map_err(|e| {
                let mapped = match e.kind() {
                    std::io::ErrorKind::NotFound => NoteBatchError::NoteNotFound,
                    other => NoteBatchError::Io {
                        io_error_kind: from_io_error_kind(other),
                    },
                };
                tracing::error!(
                    stage = "fs_read",
                    error_kind = note_batch_error_kind(&mapped),
                    "note_write_batch blob read failed"
                );
                mapped
            })?;

            // `NC05` (myne-md/myne#432): the CRDT note-type re-encodes through the
            // automerge bridge rather than `encode_update`, exactly as
            // `note_update_with_dir` does one arm over. Without this a batch write
            // — the path bulk operations and the importer take — failed on every
            // note of a migrated vault, while single-note update worked, which is
            // the shape that made it easy to miss.
            if crate::plugins::notes::crdt::is_nc05_blob(&old_blob) {
                let upd = crate::plugins::notes::crdt::encode_note_edit_at_millis(
                    &old_blob,
                    plaintext,
                    device_actor.as_ref(),
                    &items_key,
                    &items_key_id,
                    &note_uuid_bytes,
                    now_millis,
                )
                .map_err(|_| {
                    tracing::debug!(
                        stage = "decode_note",
                        outcome = "cannot_decrypt",
                        "note_write_batch NC05 re-encode failed"
                    );
                    NoteBatchError::CannotDecrypt
                })?;
                blobs.push(crate::note_txn::TxnBlob {
                    path: dst,
                    bytes: upd.blob,
                });
                continue;
            }

            let decrypted = decode_note(&old_blob, &note_uuid_bytes, &items_key, &items_key_id)
                .map_err(|_: DecryptError| {
                    tracing::debug!(
                        stage = "decode_note",
                        outcome = "cannot_decrypt",
                        "note_write_batch decode_note returned CannotDecrypt"
                    );
                    NoteBatchError::CannotDecrypt
                })?;

            let new_blob = match encode_update(decrypted, plaintext.as_bytes()) {
                Ok(b) => b,
                Err(ProtocolError::PlaintextTooLarge) => {
                    tracing::debug!(
                        stage = "encode_update",
                        error_kind = "PlaintextTooLarge",
                        "note_write_batch rejected: a rewritten body exceeds MAX_PLAINTEXT_LEN"
                    );
                    return Err(NoteBatchError::PlaintextTooLarge);
                }
                Err(_other_protocol_err) => {
                    // Unreachable under v0.1 fixed params (see note_update).
                    tracing::error!(
                        stage = "encode_update",
                        error_kind = "JoinFailure",
                        "note_write_batch encode_update returned an unreachable ProtocolError under v0.1 fixed params"
                    );
                    return Err(NoteBatchError::JoinFailure);
                }
            };

            blobs.push(crate::note_txn::TxnBlob {
                path: dst,
                bytes: new_blob,
            });
        }

        // All N encoded. The COMMIT is handed to the async caller
        // (phase3-web-client task 86): `write_batch_transactional` went onto the
        // storage seam and is async, while this closure is on the blocking pool.
        // The CPU work — N decodes and N re-encodes — is what belongs here, and
        // it all still happens before anything is staged, so the "every fallible
        // step aborts before the transaction begins" property is unchanged.
        Ok(blobs)
    })
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match join_result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_write_batch pipeline panicked or runtime shutdown"
            );
            return Err(NoteBatchError::JoinFailure);
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(blobs)) => {
            // The deferred commit (task 86). All-or-nothing is unaffected by the
            // move: nothing has been staged until this line, so every failure
            // above still leaves the vault in its pre-rename state.
            crate::note_txn::write_batch_transactional(io, &notes_dir_for_commit, &blobs)
                .await
                .map_err(|failure| {
                    // The two sides of the commit point are different answers
                    // and always were; only the type distinguishes them now
                    // (myne#300). `Aborted` really is "the vault is unchanged";
                    // `CommittedPendingPublish` is "it happened, and the rest
                    // lands at the next open" — folding that into `Io` told
                    // every caller to roll back a rename that had committed.
                    let mapped = match failure {
                        crate::note_txn::TxnFailure::Aborted(io_error_kind) => {
                            NoteBatchError::Io { io_error_kind }
                        }
                        crate::note_txn::TxnFailure::CommittedPendingPublish(io_error_kind) => {
                            NoteBatchError::CommittedPendingPublish { io_error_kind }
                        }
                    };
                    tracing::error!(
                        stage = "write_batch_transactional",
                        error_kind = note_batch_error_kind(&mapped),
                        "note_write_batch transactional commit failed"
                    );
                    mapped
                })?;
        }
    }
    tracing::debug!(
        stage = "encode_commit",
        duration_ms = duration_ms,
        "note_write_batch read + AEAD + transactional commit succeeded"
    );

    // Explicit drops — make the lock-release points visible. Notes before slot,
    // the reverse of acquisition.
    drop(notes_guard);
    drop(slot);
    Ok(())
}

/// Stable `&'static str` tag for a [`NoteBatchError`] used in `tracing`
/// (the enum itself never crosses a log line). Mirror of
/// [`note_update_error_kind`].
pub fn note_batch_error_kind(e: &NoteBatchError) -> &'static str {
    match e {
        NoteBatchError::VaultNotUnlocked => "VaultNotUnlocked",
        NoteBatchError::InvalidNoteId => "InvalidNoteId",
        NoteBatchError::NoteNotFound => "NoteNotFound",
        NoteBatchError::PlaintextTooLarge => "PlaintextTooLarge",
        NoteBatchError::CannotDecrypt => "CannotDecrypt",
        NoteBatchError::NotesDirNotADirectory => "NotesDirNotADirectory",
        NoteBatchError::Io { .. } => "Io",
        NoteBatchError::CommittedPendingPublish { .. } => "CommittedPendingPublish",
        NoteBatchError::JoinFailure => "JoinFailure",
        NoteBatchError::LiveSessionOpen => "LiveSessionOpen",
    }
}

/// Hard-delete an existing `.myn` note. See module-level docs for the
/// broader pipeline narration.
///
/// **Cryptographic erase is structural in v0.1** per `decisions.md`
/// 2026-05-07 "Note delete cryptographic erase: structural property of
/// v0.1 key hierarchy". The per-note `item_key` lives wrapped *inside*
/// the `.myn` blob as `enc_item_key` (offset 48..48+N per
/// `protocol.md` §9.2); `std::fs::remove_file` removes both the
/// ciphertext and the only on-disk copy of the wrapped key in one
/// syscall. No platform-specific secure-delete is added; the guarantee
/// derives from the v0.1 key hierarchy.
///
/// **Pipeline:**
/// 1. Strict [`NoteId::parse`] — UI bug-canary; sub-cause via tracing.
/// 2. Slot read guard + `Slot::Unlocked(_)` peek (no `items_key` clone
///    — delete does no AEAD). Reject `Empty` / `Recovering` as
///    `VaultNotUnlocked`. Guard held across `spawn_blocking` for
///    fair-queue uyumu with `vault_lock` per `decisions.md` 2026-05-07
///    "Note AEAD ops".
/// 3. `spawn_blocking { is_dir(notes_dir) → remove_file → #[cfg(unix)]
///    parent_dir.sync_all() }`. Uniform `spawn_blocking` shape with
///    the other three notes-plugin commands per the same decisions
///    entry, even though delete touches no AEAD — `parent_dir.sync_all`
///    can block on ext4 journal commit / NFS / FUSE / AV-overlay
///    scanner worst cases.
/// 4. Drop guard, emit `event = "note_deleted"`.
///
/// **Durability is asymmetric vs `atomic_write`** per `decisions.md`
/// 2026-05-07 "`note_delete` durability: Unix parent-dir `sync_all`
/// only; Windows s1 best-effort": Windows arm is `#[cfg(unix)]`-explicit
/// no-op (no `FlushFileBuffers` parent-handle, no `windows-sys` direct
/// dep extension). Power-loss may leave the deleted file reappearing
/// after reboot; user re-deletes; security-neutral (AEAD-encrypted
/// bytes leak nothing in the meantime per the cryptographic-erase
/// yapısal property).
///
/// **Failure mapping** (closed-enum, drift-free MYND-26 mirror):
/// - `InvalidNoteId` — strict parse rejected.
/// - `VaultNotUnlocked` — slot is `Empty` or `Recovering`.
/// - `NoteNotFound` — `<vault>/notes/<id>.myn` already gone (strict
///   at IPC, idempotent at UI per `decisions.md` 2026-05-07 "Note
///   delete UX"; the second invoke for the same id returns this
///   variant, but the UI folds it to a "note already gone" toast).
/// - `NotesDirNotADirectory` — `<vault>/notes` is a regular file
///   (defensive bug-canary parallel to MYND-26).
/// - `Io` — residual filesystem failure on `remove_file` or parent-
///   dir `sync_all`.
/// - `JoinFailure` — `spawn_blocking` panic / runtime shutdown.
pub async fn note_delete_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    note_id: String,
    io: &dyn VaultIo,
) -> Result<(), NoteDeleteError> {
    let notes_dir = paths::notes_dir_for_host_io(host, io, state.active_vault_id().await)
        .await
        .map_err(|e| {
            let kind = e.kind();
            match kind {
                std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "NotesDirNotADirectory",
                        "note_delete notes_dir resolution conflicted with a non-dir entry"
                    );
                    NoteDeleteError::NotesDirNotADirectory
                }
                other => {
                    let io_kind = from_io_error_kind(other);
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "Io",
                        io_failure_kind = ?io_kind,
                        "note_delete notes_dir resolution failed"
                    );
                    NoteDeleteError::Io {
                        io_error_kind: io_kind,
                    }
                }
            }
        })?;
    // MYND-29 Task 4: drop the deleted note from the live index after a
    // successful delete.
    let result = note_delete_with_dir(notes_dir, state, hooks, note_id.clone(), io, host).await;
    if result.is_ok() {
        hooks.search_remove(&note_id);
        // myne#681: notify any window (the detached one holding this note) that it
        // was deleted, so a pop-out shows the terminal "deleted elsewhere" state
        // rather than autosaving its stale buffer back. Same call site as the
        // hook side-effect above; emit is desktop-only, mobile/web no-op.
        hooks.emit_notes_deleted(&note_id);
    }
    result
}

/// IPC wrapper. Delegates; the name and payload the frontend sends are
/// unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn note_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    note_id: String,
) -> Result<(), NoteDeleteError> {
    note_delete_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        note_id,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Inner — pure-and-testable helper. Mirror of
/// [`note_create_with_dir`] / [`note_read_with_dir`] /
/// [`note_update_with_dir`].
pub async fn note_delete_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    note_id: String,
    io: &dyn VaultIo,
    host: &dyn HostCtx,
) -> Result<(), NoteDeleteError> {
    // Strict NoteId parse FIRST — before any path concatenation.
    let note_id = NoteId::parse(&note_id).map_err(|cause| {
        tracing::debug!(stage = ?cause, "note_delete note_id strict-parse failed");
        NoteDeleteError::InvalidNoteId
    })?;
    tracing::debug!(stage = "note_id_parse", outcome = "ok");

    // Slot read guard. Held across `spawn_blocking` so `vault_lock`
    // fair-queues per `decisions.md` 2026-05-07 "Note AEAD ops" — same
    // uniform pattern even though delete touches no AEAD. **No
    // `items_key` clone** — delete needs only the `Slot::Unlocked`
    // invariant, not the keys themselves.
    let slot = state.slot_read_active().await;
    match &*slot {
        Slot::Unlocked(_) => {}
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_delete rejected: slot is not Unlocked"
            );
            return Err(NoteDeleteError::VaultNotUnlocked);
        }
    }
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    let path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
    // MYND-96: the note's UUID string, used to purge its snapshots (SYNC-1).
    let note_uuid_str = note_id.as_uuid().to_string();
    // The snapshot-purge side-effect rides the hooks seam (desktop wires the
    // real snapshot store; mobile is a no-op). Clone the `Arc` to move into the
    // blocking closure.
    let hooks = hooks.clone();

    let started_ms = host.monotonic_millis();
    // Defensive bug-canary, and it runs BEFORE the unlink — as it did when it
    // lived at the top of the blocking closure. Hoisting the unlink above it
    // (my first attempt) made a hostile `<vault>/notes` regular file report
    // `NoteNotFound` instead, because the unlink fails first and its error is
    // more specific-looking. A desktop test caught the reordering; the ordering
    // is the contract, not an accident of where the code sat.
    //
    // `is_dir`, not `exists`: `exists()` answers `true` for that hostile file,
    // which would disarm the canary entirely (`vault_io.rs`, `is_dir` doc).
    if !io.is_dir(&notes_dir).await.unwrap_or(false) {
        tracing::error!(
            stage = "exists_check",
            error_kind = "NotesDirNotADirectory",
            "note_delete notes_dir is not a directory"
        );
        return Err(NoteDeleteError::NotesDirNotADirectory);
    }

    // (1) PURGE FIRST — MYND-96 SYNC-1. Purge this note's snapshots BEFORE
    // removing the live `.myn`, so cryptographic erase holds. A snapshot is a
    // verbatim `.myn` copy carrying its own wrapped `enc_item_key`, so it stays
    // decryptable under `itemsKey` even after the live note is gone — the purge
    // IS the erase of the note's history. Purge-first is what makes a crash
    // mid-delete leave the live note intact (recoverable by retrying the delete)
    // rather than orphan decryptable snapshots.
    //
    // **This is the ordering the comment below the closure had claimed since
    // MYND-96 while the code did the opposite**: the unlink ran first (`:2019`)
    // and the purge second (`:2039`), so the two failure windows the comment
    // describes were both live. The retry that closes them is why the purge sits
    // above the `NoteNotFound` arm too: an unlink that already landed (a crash
    // one step later, or a second click) still finds the snapshots and erases
    // them, instead of skipping the half that never ran.
    //
    // Best-effort INSIDE the closure (a purge error is logged, not fatal to the
    // delete — the live note removal is the user-facing action), but a PANIC
    // aborts the whole delete: a join failure after the unlink is exactly the
    // orphan state this ordering exists to prevent.
    let notes_dir_for_purge = notes_dir.clone();
    let purge = crate::task::run_blocking(move || {
        if let Some(vault_root) = notes_dir_for_purge.parent() {
            match hooks.purge_note_snapshots(vault_root, &note_uuid_str) {
                Ok(n) if n > 0 => {
                    tracing::debug!(
                        stage = "snapshot_purge",
                        removed = n,
                        "purged note snapshots on delete"
                    );
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(
                        stage = "snapshot_purge",
                        io_failure_kind = ?from_io_error_kind(e.kind()),
                        "snapshot purge on delete failed (best-effort)"
                    );
                }
            }
        }
    })
    .await;
    if purge.is_err() {
        tracing::error!(
            stage = "spawn_blocking_join",
            error_kind = "JoinFailure",
            "note_delete snapshot purge panicked or runtime shutdown — \
             the live note is left in place rather than orphaned"
        );
        return Err(NoteDeleteError::JoinFailure);
    }

    // (2) Unlink the live note. Moved onto the IO seam and out of
    // `run_blocking` (task 13).
    match io.remove_file(&path).await {
        Ok(()) => {}
        Err(IoFailureKind::NotFound) => {
            // The live file is already gone — a retry, or a crash that landed
            // after step (2) of an earlier attempt. The purge above has already
            // run for THIS call, so the retry erases the snapshots the crashed
            // attempt left behind instead of skipping them.
            tracing::debug!(
                stage = "remove_file",
                error_kind = "NoteNotFound",
                "note_delete file already gone"
            );
            return Err(NoteDeleteError::NoteNotFound);
        }
        Err(io_error_kind) => {
            let mapped = NoteDeleteError::Io { io_error_kind };
            tracing::error!(
                stage = "remove_file",
                error_kind = note_delete_error_kind(&mapped),
                "note_delete remove_file failed"
            );
            return Err(mapped);
        }
    }

    let notes_dir_for_sync = notes_dir.clone();
    let join_result = crate::task::run_blocking(move || -> Result<(), NoteDeleteError> {
        // (3) Unix-only durability: flush the directory entry's removal to
        // the journal. Windows arm is intentionally absent —
        // `decisions.md` 2026-05-07 "`note_delete` durability" pins the
        // asymmetry (write durability is data-integrity, delete
        // durability is redundancy-elimination; failure mode'lar farklı).
        #[cfg(unix)]
        {
            let dir = std::fs::File::open(&notes_dir_for_sync).map_err(|e| {
                let mapped = NoteDeleteError::Io {
                    io_error_kind: from_io_error_kind(e.kind()),
                };
                tracing::error!(
                    stage = "parent_dir_sync",
                    error_kind = note_delete_error_kind(&mapped),
                    "note_delete parent dir open failed"
                );
                mapped
            })?;
            dir.sync_all().map_err(|e| {
                let mapped = NoteDeleteError::Io {
                    io_error_kind: from_io_error_kind(e.kind()),
                };
                tracing::error!(
                    stage = "parent_dir_sync",
                    error_kind = note_delete_error_kind(&mapped),
                    "note_delete parent dir sync_all failed"
                );
                mapped
            })?;
        }
        #[cfg(not(unix))]
        let _ = notes_dir_for_sync;
        Ok(())
    })
    .await;
    let duration_ms = host.monotonic_millis().saturating_sub(started_ms);

    match join_result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_delete remove+sync panicked or runtime shutdown"
            );
            return Err(NoteDeleteError::JoinFailure);
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(())) => {}
    }
    tracing::debug!(
        stage = "remove_file",
        duration_ms = duration_ms,
        "note_delete remove_file + parent_dir_sync (Unix) succeeded"
    );

    // Explicit drop — make the lock-release point visible.
    drop(slot);

    tracing::debug!(stage = "success", event = "note_deleted");
    Ok(())
}

/// Inner sync enumerator — reads `notes_dir`, filters by `.myn`
/// extension + strict [`NoteId::parse`], sorts ascending UUIDv7,
/// returns the result. Called from inside the async wrapper's
/// `spawn_blocking` closure (see [`note_list_with_dir`]). Tests
/// exercise this layer directly via `ScopedTempDir` to verify the
/// filter + sort + tracing-level behavior without taking the slot
/// guard.
///
/// Lexicographic UUIDv7 order approximates creation-time-asc per
/// `protocol.md` §9.1; the backend-side sort is the cross-platform
/// determinism guarantee (POSIX `readdir` order is unspecified —
/// ext4 / APFS / tmpfs / FAT all differ).
///
/// **Tracing level split** (per `agent-tooling/sessions/grill/2026-05-07-mynd-28-note-list.md` Q4b):
/// - non-`.myn` files (`.DS_Store`, `.tmp`, accidental drops) +
///   non-UTF-8 filenames → `tracing::debug!(stage = "skip_orphan")`,
///   benign noise.
/// - `.myn` files whose stem fails [`NoteId::parse`] →
///   `tracing::warn!(stage = "skip_malformed_uuid", cause = ?cause)`,
///   corruption canary. The offending stem string itself is **never**
///   logged (DENY-list compliance per `src-tauri/AGENTS.md`
///   "Secret-handling logging discipline").
pub fn enumerate_notes_dir(notes_dir: &std::path::Path) -> std::io::Result<Vec<NoteId>> {
    let entries: Vec<crate::vault_io::DirEntry> = std::fs::read_dir(notes_dir)?
        .map(|e| {
            let e = e?;
            Ok(crate::vault_io::DirEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                is_dir: e.file_type()?.is_dir(),
            })
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    Ok(note_ids_from_entries(&entries))
}

/// The `.myn` filter and UUID-parse half of [`enumerate_notes_dir`], over
/// entries already read.
///
/// Split out for the wasm port (phase3-web-client task 13): the directory read
/// now goes through [`crate::vault_io::VaultIo::read_dir`], which is async and
/// yields names rather than `std::fs::DirEntry`. Everything below the read is
/// pure classification and is shared verbatim by both arms — so the skip/warn
/// behaviour cannot drift between desktop and web, which it would if the web
/// port had reimplemented the loop.
///
/// Non-UTF-8 names cannot reach here (the seam's `DirEntry::name` is a `String`,
/// lossy-converted at the boundary); a lossy-mangled name simply fails the
/// `.myn`/UUID checks below and is skipped, which is what the old `to_str()`
/// arm did too.
pub fn note_ids_from_entries(entries: &[crate::vault_io::DirEntry]) -> Vec<NoteId> {
    let mut ids: Vec<NoteId> = Vec::new();
    for entry in entries {
        let name_str = entry.name.as_str();
        {
            // Non-UTF-8 filename (Linux can hold arbitrary bytes; APFS /
            // NTFS normalize but accept many invalid sequences). Benign
            // OS-level housekeeping noise — the offending bytes never
            // appear in tracing per `src-tauri/AGENTS.md` DENY list.
            // Non-UTF-8 filenames are handled at the seam boundary now; this
            // block is retained so the control flow below reads unchanged.
        }
        let Some(stem) = name_str.strip_suffix(".myn") else {
            // Non-`.myn` orphan: `.DS_Store`, `.tmp`, accidental drops.
            // Filename string is **not** logged — DENY-list compliance.
            tracing::debug!(stage = "skip_orphan");
            continue;
        };
        match NoteId::parse(stem) {
            Ok(id) => ids.push(id),
            Err(cause) => {
                // `.myn` extension but malformed UUIDv7 stem — corruption
                // canary. The closed `InvalidNoteIdCause` enum's Debug
                // impl emits a bare variant name (DENY-list-safe per the
                // pattern in `src-tauri/src/plugins/notes/note_id.rs`).
                // The offending stem string itself is **not** logged.
                tracing::warn!(stage = "skip_malformed_uuid", cause = ?cause);
            }
        }
    }
    ids.sort();
    ids
}

/// Static-string label for [`NoteDeleteError`] variants — same
/// drift-detector discipline as the other three helpers. A new variant
/// compile-fails this match.
pub fn note_delete_error_kind(e: &NoteDeleteError) -> &'static str {
    match e {
        NoteDeleteError::VaultNotUnlocked => "VaultNotUnlocked",
        NoteDeleteError::InvalidNoteId => "InvalidNoteId",
        NoteDeleteError::NoteNotFound => "NoteNotFound",
        NoteDeleteError::NotesDirNotADirectory => "NotesDirNotADirectory",
        NoteDeleteError::Io { .. } => "Io",
        NoteDeleteError::JoinFailure => "JoinFailure",
    }
}

/// `note_list` Tauri command — returns the set of [`NoteId`]s for all
/// `.myn` files in the unlocked vault, sorted ascending UUIDv7.
///
/// Single-responsibility: "which notes exist in the unlocked vault?"
/// → identifier set. No metadata (no `items_key_id`, no `blob_size`,
/// no `file_mtime`). Field-set rationale: MYND-28 grill Q1–Q3 +
/// `decisions.md` 2026-05-07 "User-meaningful timestamp storage path".
///
/// Pipeline: resolve `<vault>/notes/` via [`paths::notes_dir`] →
/// delegate to [`note_list_with_dir`] (which holds the slot guard +
/// `spawn_blocking`s the inner [`enumerate_notes_dir`] call).
///
/// Failure modes (closed-enum surface):
/// - `VaultNotUnlocked` — slot is `Empty` or `Recovering`.
/// - `NotesDirNotADirectory` — `<vault>/notes` is a regular file
///   (defensive bug-canary).
/// - `Io` — read_dir / per-entry IO failure (`PermissionDenied` /
///   `NoSpace` / other).
/// - `JoinFailure` — `spawn_blocking` panic / runtime shutdown.
pub async fn note_list_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn VaultIo,
) -> Result<Vec<NoteId>, NoteListError> {
    let notes_dir = paths::notes_dir_for_host_io(host, io, state.active_vault_id().await)
        .await
        .map_err(|e| {
            let kind = e.kind();
            match kind {
                std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "NotesDirNotADirectory",
                        "note_list notes_dir resolution conflicted with a non-dir entry"
                    );
                    NoteListError::NotesDirNotADirectory
                }
                other => {
                    let io_kind = from_io_error_kind(other);
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "Io",
                        io_failure_kind = ?io_kind,
                        "note_list notes_dir resolution failed"
                    );
                    NoteListError::Io {
                        io_error_kind: io_kind,
                    }
                }
            }
        })?;
    note_list_with_dir(notes_dir, state, io, host).await
}

/// IPC wrapper. Delegates; the name and payload the frontend sends are
/// unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn note_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<NoteId>, NoteListError> {
    note_list_from_host(
        &TauriHost::new(app),
        state.inner(),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Inner — pure-and-testable helper. Mirror of [`note_create_with_dir`]
/// / [`note_read_with_dir`] / [`note_update_with_dir`] /
/// [`note_delete_with_dir`]. Takes `notes_dir` directly so tests
/// exercise the slot guard + `spawn_blocking` + io-error mapping
/// pipeline under a `ScopedTempDir` without spinning up a Tauri runtime.
///
/// Diverges from the precedent in one way: it does **not** clone an
/// `items_key` from the slot — `note_list` is metadata-only and does
/// no AEAD. The slot guard is just a `match &*slot { Slot::Unlocked(_)
/// => {}, … }` pattern; the read guard is held across the `.await` for
/// `vault_lock` fair-queue uyumu (`decisions.md` 2026-05-07 "Note AEAD
/// ops" — the uniform pattern that Q4e of the MYND-28 grilling extends
/// to the non-AEAD `note_list` to absorb NFS / FUSE / AV-overlay
/// topology violating the laboratuvar "`read_dir` ucuz" assumption).
pub async fn note_list_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    io: &dyn VaultIo,
    host: &dyn HostCtx,
) -> Result<Vec<NoteId>, NoteListError> {
    let slot = state.slot_read_active().await;
    match &*slot {
        Slot::Unlocked(_) => {}
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_list rejected: slot is not Unlocked"
            );
            return Err(NoteListError::VaultNotUnlocked);
        }
    }
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    let started_ms = host.monotonic_millis();
    // Directory read through the IO seam (task 13); the `.myn` filter + UUID
    // parse stay in the shared pure helper so the skip/warn behaviour cannot
    // drift between the two arms.
    //
    // `run_blocking` is gone from this path rather than moved: enumerating a
    // directory is IO, and the seam's native arm already dispatches its own —
    // nesting would be a blocking dispatch inside a blocking dispatch. There is
    // no CPU work left here to keep on the pool.
    let ids = match io.read_dir(&notes_dir).await {
        Ok(entries) => note_ids_from_entries(&entries),
        Err(io_kind) => {
            // `NotesDirNotADirectory` used to come from `ErrorKind::NotADirectory`
            // / `AlreadyExists`, which the seam's closed 4-variant vocabulary
            // does not carry — both now arrive as `Other`. The distinction is
            // preserved by ASKING: a notes dir that exists but is not a
            // directory is exactly the case, and `read_dir` failing while
            // `exists` is true is what identifies it. One extra call, only on an
            // already-failing path.
            let mapped = if io_kind == IoFailureKind::Other
                && !io.is_dir(&notes_dir).await.unwrap_or(true)
            {
                NoteListError::NotesDirNotADirectory
            } else {
                NoteListError::Io {
                    io_error_kind: io_kind,
                }
            };
            tracing::error!(
                stage = "enumerate",
                error_kind = note_list_error_kind(&mapped),
                "note_list enumerate failed"
            );
            return Err(mapped);
        }
    };
    let duration_ms = host.monotonic_millis().saturating_sub(started_ms);

    drop(slot);

    tracing::info!(
        stage = "success",
        event = "note_listed",
        count = ids.len(),
        duration_ms = duration_ms,
    );
    Ok(ids)
}

/// Static-string label for [`NoteListError`] variants — same
/// drift-detector discipline as the other four helpers. A new variant
/// compile-fails this match.
pub fn note_list_error_kind(e: &NoteListError) -> &'static str {
    match e {
        NoteListError::VaultNotUnlocked => "VaultNotUnlocked",
        NoteListError::NotesDirNotADirectory => "NotesDirNotADirectory",
        NoteListError::Io { .. } => "Io",
        NoteListError::JoinFailure => "JoinFailure",
    }
}

/// Static-string label for [`NoteTitleError`] variants — drift-detector
/// pattern parallel to the other five helpers. A new variant
/// compile-fails this match.
pub fn note_title_error_kind(e: &NoteTitleError) -> &'static str {
    match e {
        NoteTitleError::CannotDecrypt => "CannotDecrypt",
        NoteTitleError::NoteNotFound => "NoteNotFound",
        NoteTitleError::Io { .. } => "Io",
        NoteTitleError::JoinFailure => "JoinFailure",
    }
}

/// Static-string label for [`NoteTitleBatchError`] variants — drift-
/// detector pattern. A new variant compile-fails this match.
pub fn note_title_batch_error_kind(e: &NoteTitleBatchError) -> &'static str {
    match e {
        NoteTitleBatchError::VaultNotUnlocked => "VaultNotUnlocked",
        NoteTitleBatchError::NotesDirNotADirectory => "NotesDirNotADirectory",
        NoteTitleBatchError::BatchTooLarge { .. } => "BatchTooLarge",
        NoteTitleBatchError::Io { .. } => "Io",
        NoteTitleBatchError::JoinFailure => "JoinFailure",
    }
}

/// Per-call cap for [`note_titles_batch`] input length, pinned by the
/// 2026-05-15 MYND-82 grill Q5 decision. Larger batches are rejected
/// with [`NoteTitleBatchError::BatchTooLarge`] without touching disk.
pub const NOTE_TITLES_BATCH_CAP: usize = 100;

/// Per-item slice payload returned by [`note_titles_batch`]. Both byte-
/// range fields are UTF-8-lossy stringifications of the post-AEAD
/// plaintext slices — TS dialect side parses these as raw markdown.
///
/// Hand-mirrored on the TS side at `src/types/title-slice.ts` (Task 11
/// of the `notes-sidebar-autosave` PRD).
#[derive(Debug, serde::Serialize)]
pub struct TitleSlice {
    pub note_uuid: String,
    pub frontmatter_bytes: Option<String>,
    pub first_h1_line: Option<String>,
}

/// Hybrid byte-range batch read: per-item decrypt + slice extract, all
/// inside a single slot-read window. Per-item failures surface in the
/// inner `Result` without aborting peers; batch-level preconditions
/// (slot locked, oversize batch, structural notes_dir failure) abort
/// the whole call via the outer `Result`.
///
/// Spec touchpoints:
///
/// - `decisions.md` 2026-05-15 "Note title write target" (companion
///   entry; the precedence chain this batch read serves).
/// - `agent-tooling/sessions/grill/2026-05-15-mynd-82-sidebar-autosave.md`
///   Q3 (hybrid byte-range), Q4 (per-item Result), Q5 (cap 100),
///   Q6 (parallel decrypt — implemented here as concurrent spawn-then-
///   sequential-await; ordering preserved by await order).
/// - `decisions.md` 2026-05-07 "Note AEAD ops: clone-out items_key +
///   always spawn_blocking" — same pattern reused per-item.
pub async fn note_titles_batch_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    ids: Vec<String>,
    io: &dyn VaultIo,
) -> Result<Vec<Result<TitleSlice, NoteTitleError>>, NoteTitleBatchError> {
    // Cap check BEFORE notes_dir resolution — defensive cheap precondition
    // (no I/O if caller bypasses the chunking convention).
    if ids.len() > NOTE_TITLES_BATCH_CAP {
        let err = NoteTitleBatchError::BatchTooLarge {
            cap: NOTE_TITLES_BATCH_CAP,
        };
        tracing::warn!(
            stage = "cap_check",
            error_kind = note_title_batch_error_kind(&err),
            requested = ids.len(),
            cap = NOTE_TITLES_BATCH_CAP,
            "note_titles_batch rejected: input exceeds per-call cap"
        );
        return Err(err);
    }

    let notes_dir = paths::notes_dir_for_host_io(host, io, state.active_vault_id().await)
        .await
        .map_err(|e| {
            let kind = e.kind();
            match kind {
                std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "NotesDirNotADirectory",
                        "note_titles_batch notes_dir resolution conflicted with a non-dir entry"
                    );
                    NoteTitleBatchError::NotesDirNotADirectory
                }
                other => {
                    let io_kind = from_io_error_kind(other);
                    tracing::error!(
                        stage = "notes_dir",
                        error_kind = "Io",
                        io_failure_kind = ?io_kind,
                        "note_titles_batch notes_dir resolution failed"
                    );
                    NoteTitleBatchError::Io {
                        io_error_kind: io_kind,
                    }
                }
            }
        })?;
    note_titles_batch_with_dir(notes_dir, state, ids, io, host).await
}

/// IPC wrapper. Delegates; the name and payload the frontend sends are
/// unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn note_titles_batch<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    ids: Vec<String>,
) -> Result<Vec<Result<TitleSlice, NoteTitleError>>, NoteTitleBatchError> {
    note_titles_batch_from_host(
        &TauriHost::new(app),
        state.inner(),
        ids,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Inner — pure-and-testable helper. Mirror of the other notes-command
/// `_with_dir` helpers.
pub async fn note_titles_batch_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    ids: Vec<String>,
    io: &dyn VaultIo,
    host: &dyn HostCtx,
) -> Result<Vec<Result<TitleSlice, NoteTitleError>>, NoteTitleBatchError> {
    // Cap re-check at the inner layer — direct test callers must
    // honor the same invariant as the IPC boundary.
    if ids.len() > NOTE_TITLES_BATCH_CAP {
        return Err(NoteTitleBatchError::BatchTooLarge {
            cap: NOTE_TITLES_BATCH_CAP,
        });
    }

    let slot = state.slot_read_active().await;
    let (items_key, items_key_id) = match &*slot {
        Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_titles_batch rejected: slot is not Unlocked"
            );
            return Err(NoteTitleBatchError::VaultNotUnlocked);
        }
    };
    tracing::debug!(
        stage = "slot_check",
        outcome = "vault_unlocked",
        count = ids.len()
    );

    let started_ms = host.monotonic_millis();

    // Spawn all per-item tasks up front; each lands on the blocking pool
    // immediately. Awaiting sequentially below preserves input order
    // without sacrificing wall-clock parallelism — tokio executes the
    // spawned tasks concurrently regardless of await order.
    // Read through the IO seam, decode on the blocking pool, one item at a time.
    //
    // **This loop is sequential, and it already was.** The previous shape pushed
    // `crate::task::run_blocking(...)` calls into a `Vec` and awaited them
    // afterwards, under a comment claiming "each lands on the blocking pool
    // immediately … tokio executes the spawned tasks concurrently regardless of
    // await order". That was true of the ORIGINAL `tokio::task::spawn_blocking`,
    // which returns an already-scheduled `JoinHandle` — but task 80 replaced it
    // with `crate::task::run_blocking`, an `async fn`. An async fn's future does
    // nothing until polled, so collecting them and awaiting in order has been a
    // sequential loop ever since, with a comment asserting otherwise.
    //
    // Written honestly here rather than preserved as a fiction. Restoring real
    // concurrency needs a `spawn`-shaped addition to the task seam that has a
    // wasm answer (a Worker has one thread), which is its own decision — noted
    // in `progress.md` rather than smuggled into a port.
    //
    // Sequential reads suit OPFS regardless: a sync access handle is an
    // exclusive per-file lock, so concurrent reads buy nothing there.
    let mut results: Vec<Result<TitleSlice, NoteTitleError>> = Vec::with_capacity(ids.len());
    for id_str in ids {
        let per_item =
            read_and_decode_title(&notes_dir, &id_str, &items_key, &items_key_id, io).await;
        if let Err(ref e) = per_item {
            tracing::warn!(
                stage = "title_extract",
                error_kind = note_title_error_kind(e),
                "note_titles_batch per-item failed"
            );
        }
        results.push(per_item);
    }

    drop(slot);

    let duration_ms = host.monotonic_millis().saturating_sub(started_ms);
    let ok_count = results.iter().filter(|r| r.is_ok()).count();
    let err_count = results.len() - ok_count;
    tracing::info!(
        stage = "success",
        event = "note_titles_batched",
        count = results.len(),
        ok_count = ok_count,
        err_count = err_count,
        duration_ms = duration_ms,
    );
    Ok(results)
}

/// Per-item worker: parse `note_id`, read `.myn`, AEAD-decrypt, extract
/// title slices. Runs inside [`tokio::task::spawn_blocking`].
pub fn extract_one_title_slice(
    notes_dir: &std::path::Path,
    id_str: String,
    items_key: &Zeroizing<[u8; 32]>,
    items_key_id: &[u8; 16],
) -> Result<TitleSlice, NoteTitleError> {
    let (note_id, path) = parse_title_target(notes_dir, &id_str)?;
    let blob = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) => {
            let io_kind_raw = e.kind();
            return Err(match io_kind_raw {
                std::io::ErrorKind::NotFound => NoteTitleError::NoteNotFound,
                _ => NoteTitleError::Io {
                    io_error_kind: from_io_error_kind(io_kind_raw),
                },
            });
        }
    };
    decode_one_title_slice(&note_id, &blob, items_key, items_key_id)
}

/// One batch item, end to end: parse the id, read its blob through the seam,
/// decode on the blocking pool.
///
/// Exists so the batch loop reads as one statement per item; the three halves
/// are separately callable because the read between them is async.
async fn read_and_decode_title(
    notes_dir: &std::path::Path,
    id_str: &str,
    items_key: &Zeroizing<[u8; 32]>,
    items_key_id: &[u8; 16],
    io: &dyn VaultIo,
) -> Result<TitleSlice, NoteTitleError> {
    let (note_id, path) = parse_title_target(notes_dir, id_str)?;
    let blob = match io.read(&path).await {
        Ok(bytes) => bytes,
        Err(IoFailureKind::NotFound) => return Err(NoteTitleError::NoteNotFound),
        Err(io_error_kind) => return Err(NoteTitleError::Io { io_error_kind }),
    };
    let items_key = items_key.clone();
    let items_key_id = *items_key_id;
    match crate::task::run_blocking(move || {
        decode_one_title_slice(&note_id, &blob, &items_key, &items_key_id)
    })
    .await
    {
        Ok(res) => res,
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_titles_batch per-item task panicked or runtime shutdown"
            );
            Err(NoteTitleError::JoinFailure)
        }
    }
}

/// Strict-parse an id and resolve its blob path.
///
/// Split out of [`extract_one_title_slice`] for the wasm port (task 13): the
/// read between these two halves is now async, so the pure parse and the pure
/// decode had to become separately callable. A malformed id is `NoteNotFound`
/// because the canonical id set comes from `note_list` — anything else is a UI
/// bug or a manual invocation, the file does not exist either way, and
/// `NoteNotFound` keeps the user experience honest (the row drops out).
pub fn parse_title_target(
    notes_dir: &std::path::Path,
    id_str: &str,
) -> Result<(NoteId, PathBuf), NoteTitleError> {
    let note_id = match NoteId::parse(id_str) {
        Ok(id) => id,
        Err(cause) => {
            tracing::debug!(
                stage = "note_id_parse",
                outcome = "invalid",
                cause = ?cause,
                "note_titles_batch per-item note_id strict-parse failed; mapping to NoteNotFound"
            );
            return Err(NoteTitleError::NoteNotFound);
        }
    };
    let path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
    Ok((note_id, path))
}

/// AEAD-decrypt one already-read blob and extract its title slices.
///
/// The CPU half of [`extract_one_title_slice`], callable on its own so the
/// wasm path can read through the seam and still run the decode on the blocking
/// pool. Shared by both arms verbatim, so the title-extraction behaviour cannot
/// drift between clients.
pub fn decode_one_title_slice(
    note_id: &NoteId,
    blob: &[u8],
    items_key: &Zeroizing<[u8; 32]>,
    items_key_id: &[u8; 16],
) -> Result<TitleSlice, NoteTitleError> {
    let note_uuid_bytes = *note_id.as_uuid().as_bytes();
    let blob = blob.to_vec();
    // Either format (myne-md/myne#432). This is the sidebar's title source, so
    // an `MY01`-only decode here rendered every note on a migrated vault with no
    // title at all — the most visible symptom of the split, and the one nothing
    // reported as an error.
    let decrypted = match crate::plugins::notes::decode::decode_note_any(
        &blob,
        &note_uuid_bytes,
        items_key,
        items_key_id,
    ) {
        Ok(d) => d,
        Err(_dec_err) => {
            // The sub-cause was already emitted via `tracing::debug!` inside the
            // codec; the host adds a parallel non-distinguishing event without
            // re-introducing the distinguisher at the IPC boundary
            // (`protocol.md` §6.4 preserved).
            return Err(NoteTitleError::CannotDecrypt);
        }
    };

    let slices = extract_title_slices(&decrypted);
    // `from_utf8_lossy` allocates a new `String` even for valid UTF-8 —
    // accepted overhead because the slice sizes are small (FM block
    // ~100-500B, H1 line ~10-80B) and the alternative (strict UTF-8
    // boundary at command layer like `note_read`) would conflate a
    // genuine encoding error with the per-item error surface. The lossy
    // path renders replacement characters in the rare edge case; the
    // sidebar row shows "Untitled" if both slices end up empty.
    let frontmatter_bytes = slices
        .frontmatter_bytes
        .map(|s| String::from_utf8_lossy(s).into_owned());
    let first_h1_line = slices
        .first_h1_line
        .map(|s| String::from_utf8_lossy(s).into_owned());

    // Drop the decrypted plaintext early — `Zeroizing<Vec<u8>>` wipes
    // its bytes on drop. The extracted slice strings are no-longer-
    // sensitive byproducts at this point (they will cross IPC anyway).
    drop(decrypted);

    Ok(TitleSlice {
        // Rendered from the parsed id rather than echoing the caller's string:
        // they are equal by construction (a `NoteId` only exists if the string
        // parsed), and taking it from the parsed value means this helper needs
        // no second parameter carrying the same information.
        note_uuid: note_id.as_uuid().to_string(),
        frontmatter_bytes,
        first_h1_line,
    })
}

#[cfg(test)]
mod tests {
    // The `enumerate_notes_dir` DENY-list-compliant tracing tests live here
    // (next to the function under test) so `tracing_test`'s per-crate event
    // capture sees the events — they fire with a `myne-core` target. The note
    // CRUD / export / search integration tests run desktop-side
    // (`src-tauri/src/plugins/notes/desktop_commands.rs`) where the desktop-only
    // subsystems they touch are available.
    use super::enumerate_notes_dir;
    use crate::paths::notes_dir_under;
    use crate::test_support::ScopedTempDir;

    /// The sidebar's title source must read BOTH note formats (myne-md/myne#432).
    ///
    /// This is the surface where the version split was most visible and least
    /// diagnosable: on a migrated vault every row rendered untitled, and nothing
    /// anywhere reported an error — the per-row failure is swallowed into
    /// "Untitled" by design, because a genuinely title-less note is ordinary.
    #[test]
    fn titles_decode_on_both_note_formats() {
        use crate::host::test_host::TestHost;
        use crate::plugins::notes::note_id::NoteId;
        use zeroize::Zeroizing;

        let host = TestHost::new("/base");
        let ik = Zeroizing::new([0x11u8; 32]);
        let ikid = [0x22u8; 16];
        let id = NoteId::new_v7();
        let uuid = *id.as_uuid().as_bytes();
        let md = "---\ntitle: From Frontmatter\n---\n\n# H1 fallback\n";

        let my01 = protocol::encode_new_note(&ik, &ikid, &uuid, md.as_bytes()).expect("MY01");
        let nc05 = crate::plugins::notes::crdt::encode_note_blob(
            md,
            &ik,
            &ikid,
            &uuid,
            &[0x44u8; 16],
            &host,
        )
        .expect("NC05");

        for (label, blob) in [("MY01", &my01), ("NC05", &nc05)] {
            let slice = super::decode_one_title_slice(&id, blob, &ik, &ikid)
                .unwrap_or_else(|_| panic!("{label} title must decode"));
            let fm = slice
                .frontmatter_bytes
                .unwrap_or_else(|| panic!("{label} must yield a frontmatter slice"));
            assert!(
                fm.contains("title: From Frontmatter"),
                "{label} frontmatter slice must carry the title: {fm:?}"
            );
        }
    }

    // ---- expected-base guard (§11.3 ms-race closure) -----------------------
    // The base-guard unit tests live core-side (they need only the vault-unlock
    // fixture + the notes with_dir cores); the broader CRUD integration tests
    // stay desktop-side as documented above.

    use super::{
        note_create_from_host, note_create_with_dir, note_delete_with_dir, note_read_with_dir,
        note_update_from_host, note_update_with_dir, NoteDeleteError,
    };
    use crate::plugins::notes::note_id::NoteId;
    use crate::plugins::vault_unlock::state::{
        fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
    };
    use sha2::{Digest, Sha256};

    fn noop_hooks() -> crate::hooks::Hooks {
        std::sync::Arc::new(crate::hooks::NoopHooks)
    }

    /// Current-thread runtime per test — the crate convention (no
    /// `#[tokio::test]`; cf. vault_unlock).
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    async fn unlocked() -> VaultRuntimeState {
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(7, 9, 1))
            .await;
        state
    }

    fn hash_of(s: &str) -> [u8; 32] {
        Sha256::digest(s.as_bytes()).into()
    }

    #[test]
    fn note_update_base_mismatch_rejects_without_write() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("base-guard-mismatch").unwrap();
            let notes_dir = notes_dir_under(tmp.path()).unwrap();
            let state = unlocked().await;
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "base body".to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            // Another writer (the sync pull-apply shape) advances the note…
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "moved on".to_string(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            // …then the editor saves against its STALE base → rejected, no write.
            let err = note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "my racing edit".to_string(),
                Some(hash_of("base body")),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap_err();
            assert!(matches!(err, super::NoteUpdateError::BaseMismatch));
            let on_disk = note_read_with_dir(
                notes_dir,
                &state,
                id,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            assert_eq!(on_disk, "moved on", "a rejected save must not touch disk");
        })
    }

    #[test]
    fn delete_purges_snapshots_before_it_unlinks_the_live_note() {
        // MYND-96 SYNC-1, and the ordering is the whole guarantee. The comment
        // beside the purge had claimed purge-first since MYND-96 while the code
        // unlinked first and purged second, so a crash between the two left
        // orphan `MY01`/`NC05` snapshots that stay decryptable under `itemsKey`
        // with the live note already gone — the cryptographic erase defeated by
        // an ordering. End-state assertions cannot see it: when nothing fails,
        // both orders delete everything.
        rt().block_on(async {
            let tmp = ScopedTempDir::new("note-delete-purge-order").unwrap();
            let notes_dir = notes_dir_under(tmp.path()).unwrap();
            let state = unlocked().await;
            let io = crate::vault_io::StdVaultIo;
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "to be purged".to_string(),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("create");
            let live = notes_dir.join(format!("{id}.myn"));
            assert!(
                live.exists(),
                "fixture must have a live note to be meaningful"
            );

            let hooks = crate::test_support::RecordingHooks::new();
            note_delete_with_dir(
                notes_dir.clone(),
                &state,
                &(hooks.clone() as crate::hooks::Hooks),
                id.clone(),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("delete");

            assert_eq!(
                hooks.purge_saw_live_note(),
                vec![true],
                "the purge must run while the live note is still on disk"
            );
            assert!(!live.exists(), "and the delete must still finish");
        })
    }

    #[test]
    fn a_purge_join_failure_leaves_the_live_note_in_place() {
        // The crash half of the same ordering. With the purge first, an abort
        // inside it leaves the live note untouched — the user retries the delete
        // and the retry erases the snapshots. With the unlink first, that same
        // abort is the orphan state.
        rt().block_on(async {
            let tmp = ScopedTempDir::new("note-delete-purge-join-fail").unwrap();
            let notes_dir = notes_dir_under(tmp.path()).unwrap();
            let state = unlocked().await;
            let io = crate::vault_io::StdVaultIo;
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "must survive the aborted delete".to_string(),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("create");
            let live = notes_dir.join(format!("{id}.myn"));

            let hooks = crate::test_support::RecordingHooks::panicking_purge();
            let result = note_delete_with_dir(
                notes_dir.clone(),
                &state,
                &(hooks.clone() as crate::hooks::Hooks),
                id.clone(),
                &io,
                &crate::host::NoopHost,
            )
            .await;

            assert!(
                matches!(result, Err(NoteDeleteError::JoinFailure)),
                "expected JoinFailure, got {result:?}"
            );
            assert!(
                live.exists(),
                "an aborted purge must not have unlinked the live note"
            );
        })
    }

    // ── automerge-sync-migration: the NC05 read/edit dispatch (myne#418/#419) ──
    //
    // A migrated CRDT note is a `.myn` with the `NC05` magic; `note_read` /
    // `note_update` must dispatch on that magic and route through the automerge
    // bridge instead of the `MY01` codec. The vault fixture's items_key is
    // `[9;32]` / id `[1;16]` (`fixture_unlocked_with_keys(7, 9, 1)`), so a blob
    // sealed under those keys decodes under the same unlocked slot.

    /// Seed an `NC05` note directly on disk under the fixture's items_key, the
    /// shape the migration (#420) produces and the sync pull-apply writes.
    fn seed_nc05_note(notes_dir: &std::path::Path, markdown: &str) -> NoteId {
        let id = NoteId::new_v7();
        let uuid = *id.as_uuid().as_bytes();
        let blob = crate::plugins::notes::crdt::encode_note_blob(
            markdown,
            &[9u8; 32],
            &[1u8; 16],
            &uuid,
            &[0xAAu8; 16],
            &crate::host::NoopHost,
        )
        .expect("seal NC05 fixture note");
        std::fs::write(notes_dir.join(format!("{}.myn", id.as_uuid())), &blob).unwrap();
        id
    }

    #[test]
    fn note_create_seals_nc05_on_a_migrated_v0_2_vault_and_my01_otherwise() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("note-create-generation").unwrap();
            let notes_dir = notes_dir_under(tmp.path()).unwrap();
            let state = unlocked().await; // items_key [9;32], id [1;16]
            let io = crate::vault_io::StdVaultIo;

            // (a) No vault.meta on disk → note_create falls back to v0.1 and seals
            //     `MY01` (the pre-migration default; this is why every existing
            //     note test that seeds no meta keeps its `MY01` blobs).
            let v0_1_id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "pre-migration note".to_string(),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            let v0_1_blob =
                std::fs::read(notes_dir.join(format!("{v0_1_id}.myn"))).unwrap();
            assert!(
                !crate::plugins::notes::crdt::is_nc05_blob(&v0_1_blob),
                "no vault.meta → v0.1 default → MY01"
            );
            assert_eq!(&v0_1_blob[0..4], protocol::blob::MAGIC.as_slice());

            // (b) A migrated vault carries an `NTV5` vault.meta at the vault root
            //     (`notes_dir.parent()`). `note_create` reads only the generation
            //     (`meta_version_of` inspects the 4-byte magic), so the real magic
            //     constant is a faithful stand-in for a full NTV5 meta here.
            std::fs::write(
                tmp.path().join("vault.meta"),
                protocol::VAULT_META_V0_2_MAGIC, // NTV5 → MetaVersion::V0_2
            )
            .unwrap();
            let v0_2_id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "post-migration note".to_string(),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            let v0_2_blob =
                std::fs::read(notes_dir.join(format!("{v0_2_id}.myn"))).unwrap();
            assert!(
                crate::plugins::notes::crdt::is_nc05_blob(&v0_2_blob),
                "a migrated (NTV5) vault seals new notes as NC05, not a reverted MY01 (§10.4.1 rule 2)"
            );
            // …and it round-trips through the magic-dispatching read path under the
            // same unlocked slot.
            let got = note_read_with_dir(
                notes_dir,
                &state,
                v0_2_id,
                &io,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            assert_eq!(got, "post-migration note");
        })
    }

    #[test]
    fn nc05_note_reads_edits_and_rereads_through_the_command_path() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("nc05-read-edit").unwrap();
            let notes_dir = notes_dir_under(tmp.path()).unwrap();
            let state = unlocked().await;
            let md = "---\ntitle: Café İş\n---\n\n# Body 🚀 [[link]]\n";
            let id = seed_nc05_note(&notes_dir, md);

            // Read dispatches on the NC05 magic → byte-exact markdown.
            let read = note_read_with_dir(
                notes_dir.clone(),
                &state,
                id.as_uuid().to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            assert_eq!(read, md, "NC05 note read back byte-exact");

            // Edit against the correct base → succeeds, no snapshot for a CRDT note.
            let out = note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.as_uuid().to_string(),
                "second version".to_string(),
                Some(hash_of(md)),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            assert!(!out.snapshot_warning, "a CRDT note captures no snapshot");

            // Re-read → the edit landed, and it is STILL an NC05 blob (the edit
            // path preserved the family, not silently downgraded to MY01).
            let reread = note_read_with_dir(
                notes_dir.clone(),
                &state,
                id.as_uuid().to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            assert_eq!(reread, "second version");
            let on_disk = std::fs::read(notes_dir.join(format!("{}.myn", id.as_uuid()))).unwrap();
            assert!(
                crate::plugins::notes::crdt::is_nc05_blob(&on_disk),
                "the edit kept the note in the NC05 family"
            );
        })
    }

    #[test]
    fn nc05_note_update_honors_the_expected_base_guard() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("nc05-base-guard").unwrap();
            let notes_dir = notes_dir_under(tmp.path()).unwrap();
            let state = unlocked().await;
            let id = seed_nc05_note(&notes_dir, "base body");

            // A stale base hash is rejected without a write — same §11.3 guard as
            // the MY01 path, evaluated against the decoded CRDT markdown.
            let err = note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.as_uuid().to_string(),
                "racing edit".to_string(),
                Some(hash_of("a different base")),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap_err();
            assert!(matches!(err, super::NoteUpdateError::BaseMismatch));
            // Disk untouched.
            let read = note_read_with_dir(
                notes_dir,
                &state,
                id.as_uuid().to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            assert_eq!(
                read, "base body",
                "a rejected NC05 save must not touch disk"
            );
        })
    }

    // ── myne#302: the §8.3 batch is the third `notes_write_mutex` writer ────
    //
    // `note_write_batch_with_dir` is a read→decode→re-encode→write pipeline over
    // N notes, and it shipped taking only the slot READ guard. Its read and its
    // publish are separated by the whole encode pass, so anything that wrote a
    // note inside that window was silently overwritten by a body re-encoded from
    // the plaintext that preceded it — no conflict, no keep-both, no
    // `BaseMismatch`, and (via sync) a baseline naming a version disk does not
    // hold, which the next scan pushes to every other device.
    //
    // The property is "it does not proceed while another writer holds the lock",
    // which is what the two racing writers (`note_update_with_dir`, the sync
    // pull-apply) both rely on. Driven from the lock side rather than by racing
    // two writers: holding the mutex is exactly the state either of them is in
    // mid-pipeline, and it makes the test deterministic instead of timing-shaped.
    #[test]
    fn note_write_batch_waits_for_the_notes_write_mutex() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("batch-notes-mutex").unwrap();
            let notes_dir = notes_dir_under(tmp.path()).unwrap();
            let state = unlocked().await;
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "original body".to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            let items: Vec<(String, zeroize::Zeroizing<String>)> = vec![(
                id.clone(),
                zeroize::Zeroizing::new("batch body".to_string()),
            )];

            // Stand in for a writer mid-pipeline (either of the other two).
            let held = super::notes_write_mutex().lock().await;
            let blocked = tokio::time::timeout(
                std::time::Duration::from_millis(250),
                super::note_write_batch_with_dir(
                    &crate::vault_io::StdVaultIo,
                    notes_dir.clone(),
                    &state,
                    &items,
                    0,
                    &crate::plugins::live::LiveSessionRegistry::new(),
                ),
            )
            .await;
            assert!(
                blocked.is_err(),
                "the batch must not run its pipeline while another note writer holds the lock"
            );
            assert_eq!(
                note_read_with_dir(
                    notes_dir.clone(),
                    &state,
                    id.clone(),
                    &crate::vault_io::StdVaultIo,
                    &crate::host::NoopHost,
                )
                .await
                .unwrap(),
                "original body",
                "…and must not have published anything"
            );

            // Released → it proceeds normally. The lock is a serializer, not a
            // refusal.
            drop(held);
            super::note_write_batch_with_dir(
                &crate::vault_io::StdVaultIo,
                notes_dir.clone(),
                &state,
                &items,
                0,
                &crate::plugins::live::LiveSessionRegistry::new(),
            )
            .await
            .unwrap();
            assert_eq!(
                note_read_with_dir(
                    notes_dir,
                    &state,
                    id,
                    &crate::vault_io::StdVaultIo,
                    &crate::host::NoopHost,
                )
                .await
                .unwrap(),
                "batch body"
            );
        })
    }

    #[test]
    fn note_update_matching_base_hash_writes() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("base-guard-match").unwrap();
            let notes_dir = notes_dir_under(tmp.path()).unwrap();
            let state = unlocked().await;
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "base body".to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "edited".to_string(),
                Some(hash_of("base body")),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            let on_disk = note_read_with_dir(
                notes_dir,
                &state,
                id,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            assert_eq!(on_disk, "edited");
        })
    }

    #[test]
    fn note_update_none_hash_skips_guard_legacy_pin() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("base-guard-none").unwrap();
            let notes_dir = notes_dir_under(tmp.path()).unwrap();
            let state = unlocked().await;
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "base body".to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            // Disk moves on; a guardless caller (mobile / trash / templates /
            // snapshots restore) still overwrites — the pinned legacy semantic.
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "moved on".to_string(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "guardless overwrite".to_string(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            let on_disk = note_read_with_dir(
                notes_dir,
                &state,
                id,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            assert_eq!(on_disk, "guardless overwrite");
        })
    }

    /// myne-md/myne#839: an update that takes a note out of the live tree (a
    /// soft-trash, an archive, or the `deleted:` tombstone the routed permanent
    /// delete writes) must notify every window exactly as the hard-delete path
    /// does. Before this, only the hard delete emitted `notes://deleted`, so a
    /// detached (pop-out) window holding a soft-trashed note stayed open and its
    /// next autosave wrote its stale buffer back without the `trashed:` field
    /// and resurrected the note. A plain live edit must NOT emit.
    #[test]
    fn removing_a_note_from_the_live_tree_emits_notes_deleted() {
        use crate::host::test_host::TestHost;
        use crate::host::EventPayload;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("removed-emit").unwrap();
            let state = unlocked().await;
            let host = TestHost::new(tmp.path());
            // `note_*_from_host` resolves `<app_data_dir>/vaults/<id>/notes` and
            // requires the vault root to exist (a `NotFound` before any write),
            // so create it, as an unlocked vault on disk always would.
            let data_dir = crate::host::HostCtx::app_data_dir(&host).unwrap();
            std::fs::create_dir_all(crate::paths::vault_root_for_id_from_base(
                &data_dir,
                test_vault_id(),
            ))
            .unwrap();

            async fn drive(
                host: &TestHost,
                state: &VaultRuntimeState,
                body: &str,
                edited: &str,
            ) -> String {
                let id = note_create_from_host(
                    host,
                    state,
                    &noop_hooks(),
                    body.to_string(),
                    &crate::vault_io::StdVaultIo,
                )
                .await
                .unwrap();
                note_update_from_host(
                    host,
                    state,
                    &noop_hooks(),
                    id.clone(),
                    edited.to_string(),
                    None,
                    &crate::vault_io::StdVaultIo,
                    &crate::plugins::live::LiveSessionRegistry::new(),
                )
                .await
                .unwrap();
                id
            }

            // The events are filtered by note id, so one host serves every case.
            let emitted = |id: &str| {
                host.events().iter().any(|(name, payload)| {
                    *name == super::NOTES_DELETED_EVENT
                        && matches!(payload, EventPayload::Text(t) if t.as_str() == id)
                })
            };

            let id = drive(
                &host,
                &state,
                "---\ntitle: Live\n---\n\nbody",
                "---\ntitle: Live\n---\n\nedited",
            )
            .await;
            assert!(!emitted(&id), "a live edit must not emit notes://deleted");

            let id = drive(
                &host,
                &state,
                "---\ntitle: T\n---\n\nbody",
                "---\ntitle: T\ntrashed: 2026-01-01T00:00:00Z\n---\n\nbody",
            )
            .await;
            assert!(emitted(&id), "soft-trash must emit notes://deleted");

            let id = drive(
                &host,
                &state,
                "---\ntitle: A\n---\n\nbody",
                "---\ntitle: A\narchived: 2026-01-01T00:00:00Z\n---\n\nbody",
            )
            .await;
            assert!(emitted(&id), "archive must emit notes://deleted");

            let id = drive(
                &host,
                &state,
                "---\ntitle: D\n---\n\nbody",
                "---\ntitle: D\ndeleted: 2026-01-01T00:00:00Z\n---\n\nbody",
            )
            .await;
            assert!(
                emitted(&id),
                "a deleted: tombstone must emit notes://deleted"
            );
        })
    }

    #[test]
    fn parse_base_hash_hex_is_strict() {
        let valid = "ab".repeat(32);
        assert!(super::parse_base_hash_hex(&valid).is_some());
        assert!(super::parse_base_hash_hex(&valid.to_uppercase()).is_some());
        assert!(super::parse_base_hash_hex("").is_none());
        assert!(super::parse_base_hash_hex(&"ab".repeat(31)).is_none());
        assert!(super::parse_base_hash_hex(&"ab".repeat(33)).is_none());
        assert!(super::parse_base_hash_hex(&("zz".to_string() + &"ab".repeat(31))).is_none());
    }

    // ---- enumerate_notes_dir tracing tests --------------------------------

    #[tracing_test::traced_test]
    #[test]
    fn list_with_dir_emits_skip_orphan_debug_for_non_myn_files() {
        let tmp = ScopedTempDir::new("list-trace-orphan").unwrap();
        let notes_dir = notes_dir_under(tmp.path()).unwrap();

        let valid_stem = "01970e83-4f2f-7000-8000-000000000001";
        std::fs::write(notes_dir.join(format!("{valid_stem}.myn")), b"\0").unwrap();
        std::fs::write(notes_dir.join(".DS_Store"), b"\0").unwrap();
        std::fs::write(notes_dir.join("random.txt"), b"hello").unwrap();

        let result = enumerate_notes_dir(&notes_dir).unwrap();

        assert_eq!(result.len(), 1);
        assert!(
            logs_contain("skip_orphan"),
            "non-.myn entries must trigger skip_orphan tracing event"
        );
    }

    #[tracing_test::traced_test]
    #[test]
    fn list_with_dir_emits_skip_malformed_uuid_warn_for_bad_stems() {
        let tmp = ScopedTempDir::new("list-trace-malformed").unwrap();
        let notes_dir = notes_dir_under(tmp.path()).unwrap();

        // Uppercase canonical form → `InvalidNoteIdCause::InvalidChar`.
        std::fs::write(
            notes_dir.join("01970E83-4F2F-7000-8000-000000000002.myn"),
            b"\0",
        )
        .unwrap();

        let result = enumerate_notes_dir(&notes_dir).unwrap();

        assert!(result.is_empty());
        assert!(
            logs_contain("skip_malformed_uuid"),
            "malformed-UUID `.myn` must trigger skip_malformed_uuid tracing event"
        );
        assert!(
            logs_contain("InvalidChar"),
            "the closed `InvalidNoteIdCause` Debug variant name must appear in the captured cause field"
        );
    }

    #[tracing_test::traced_test]
    #[test]
    fn list_with_dir_mixed_directory_emits_correct_event_counts() {
        let tmp = ScopedTempDir::new("list-trace-counts").unwrap();
        let notes_dir = notes_dir_under(tmp.path()).unwrap();

        let valid_stem = "01970e83-4f2f-7000-8000-000000000001";
        std::fs::write(notes_dir.join(format!("{valid_stem}.myn")), b"\0").unwrap();
        std::fs::write(notes_dir.join(".DS_Store"), b"\0").unwrap();
        std::fs::write(notes_dir.join("random.txt"), b"hello").unwrap();
        std::fs::write(notes_dir.join("not-a-uuid-at-all-stem-here.myn"), b"\0").unwrap();

        let result = enumerate_notes_dir(&notes_dir).unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(format!("{}", result[0]), valid_stem);

        logs_assert(|lines: &[&str]| {
            let orphan_count = lines.iter().filter(|l| l.contains("skip_orphan")).count();
            let malformed_count = lines
                .iter()
                .filter(|l| l.contains("skip_malformed_uuid"))
                .count();
            if orphan_count != 2 {
                return Err(format!("expected 2 skip_orphan events, got {orphan_count}"));
            }
            if malformed_count != 1 {
                return Err(format!(
                    "expected 1 skip_malformed_uuid event, got {malformed_count}"
                ));
            }
            Ok(())
        });
    }

    #[tracing_test::traced_test]
    #[test]
    fn list_with_dir_skip_events_do_not_leak_offending_stem_string() {
        // DENY-list compliance: `note_id` strings (and the offending
        // pre-parse stem variants) must never appear in any captured
        // tracing field. Per `src-tauri/AGENTS.md` "Secret-handling
        // logging discipline".
        let tmp = ScopedTempDir::new("list-trace-deny").unwrap();
        let notes_dir = notes_dir_under(tmp.path()).unwrap();

        // Distinctive, hard-to-mistake stem strings.
        let orphan_name = "alphareconnaissancehallmark.txt";
        let malformed_stem = "betacontradictionperformative";
        std::fs::write(notes_dir.join(orphan_name), b"\0").unwrap();
        std::fs::write(notes_dir.join(format!("{malformed_stem}.myn")), b"\0").unwrap();

        let _ = enumerate_notes_dir(&notes_dir).unwrap();

        assert!(
            !logs_contain(orphan_name),
            "offending non-.myn filename must not appear in tracing fields"
        );
        assert!(
            !logs_contain(malformed_stem),
            "offending malformed-UUID stem must not appear in tracing fields"
        );
    }

    #[cfg(target_os = "linux")]
    #[tracing_test::traced_test]
    #[test]
    fn list_with_dir_emits_skip_orphan_for_non_utf8_filename() {
        // `name.to_str()` None branch is exercised here. Linux ext4
        // accepts arbitrary bytes; APFS / NTFS normalize, so this test
        // is `#[cfg(target_os = "linux")]`-gated. Production code path
        // is platform-agnostic — when an invalid-UTF-8 entry appears
        // (corrupt FS, foreign tooling), it is treated as an orphan.
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let tmp = ScopedTempDir::new("list-trace-non-utf8").unwrap();
        let notes_dir = notes_dir_under(tmp.path()).unwrap();

        // Invalid UTF-8 prefix (lone continuation bytes) + `.myn` suffix
        // bytes; the entry will hit the `to_str()` None branch before
        // any extension check runs.
        let bad_bytes: &[u8] = b"\xff\xfename.myn";
        let bad_name = OsStr::from_bytes(bad_bytes);
        std::fs::write(notes_dir.join(bad_name), b"\0").unwrap();

        let result = enumerate_notes_dir(&notes_dir).unwrap();

        assert!(result.is_empty(), "non-UTF-8 entry must be skipped");
        assert!(
            logs_contain("skip_orphan"),
            "non-UTF-8 filename must hit the skip_orphan branch"
        );
    }
}
