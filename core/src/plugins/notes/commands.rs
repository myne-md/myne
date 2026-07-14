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
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use crate::atomic_write;
use crate::io_failure_kind::from_io_error_kind;
use crate::paths;
use crate::plugins::vault_unlock::state::{Slot, VaultRuntimeState};
use protocol::{decode_note, encode_new_note, encode_update, DecryptError, ProtocolError};
use serde::Deserialize;
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

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
#[tauri::command]
pub async fn note_create<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    plaintext: String,
) -> Result<String, NoteCreateError> {
    // First-line Plaintext-IPC wrap (`src-tauri/CLAUDE.md`): the index needs
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
    let notes_dir = paths::notes_dir_for(&app, state.active_vault_id().await).map_err(|e| {
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
    let result = note_create_with_dir(notes_dir, state.inner(), (*plaintext).clone()).await;
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
                .index_note_attachments(state.inner(), id, &title, &plaintext)
                .await;
        }
        // MYND-453: eager per-note AI re-embed over the note prose (attachments
        // carry their own search docs now — 448a; detached, no-op unless the
        // local-inference feature + ai_enabled are on).
        hooks.ai_note_changed(id, &plaintext);
        // MYND-424: mark the sync loop dirty so the new note pushes (soft dep).
        hooks.bump_local_change();
    }
    result
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
) -> Result<String, NoteCreateError> {
    // First non-doc statement: bound the lifetime of plaintext bytes
    // to a `Zeroizing<String>` wrapper. Every early-return path drops
    // the wrapper and zeroes the bytes (see
    // `src-tauri/CLAUDE.md` "Secret-handling logging discipline").
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
        Slot::Empty | Slot::Recovering { .. } => {
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

    // AEAD on a background thread. `Zeroizing<String>` and
    // `Zeroizing<[u8; 32]>` move into the closure; both drop and zero
    // their bytes on closure exit. The slot read guard remains in the
    // outer task across this `.await` — its lifetime is bounded by
    // `state`, not the closure.
    let started = Instant::now();
    let blob_result = tokio::task::spawn_blocking(move || {
        encode_new_note(
            &items_key,
            &items_key_id,
            &note_uuid_bytes,
            plaintext.as_bytes(),
        )
    })
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

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
    if let Err(e) = atomic_write::atomic_write(&dest, &blob, /* replace = */ false) {
        let kind = e.kind();
        let mapped = match kind {
            std::io::ErrorKind::AlreadyExists => NoteCreateError::NoteAlreadyExists,
            std::io::ErrorKind::NotADirectory => NoteCreateError::NotesDirNotADirectory,
            other => NoteCreateError::Io {
                io_error_kind: from_io_error_kind(other),
            },
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
/// `src-tauri/CLAUDE.md` "Secret-handling logging discipline" closed-
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
#[tauri::command]
pub async fn note_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
) -> Result<String, NoteReadError> {
    let notes_dir = paths::notes_dir_for(&app, state.active_vault_id().await).map_err(|e| {
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
    note_read_with_dir(notes_dir, state.inner(), note_id).await
}

/// Inner — pure-and-testable helper. Mirror of [`note_create_with_dir`].
pub async fn note_read_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    note_id: String,
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
        Slot::Empty | Slot::Recovering { .. } => {
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
    let started = Instant::now();
    let join_result =
        tokio::task::spawn_blocking(move || -> Result<protocol::DecryptedNote, NoteReadError> {
            let blob = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(e) => {
                    let io_kind_raw = e.kind();
                    let mapped = match io_kind_raw {
                        std::io::ErrorKind::NotFound => NoteReadError::NoteNotFound,
                        _ => NoteReadError::Io {
                            io_error_kind: from_io_error_kind(io_kind_raw),
                        },
                    };
                    tracing::error!(
                        stage = "read_blob",
                        error_kind = note_read_error_kind(&mapped),
                        "note_read blob read failed"
                    );
                    return Err(mapped);
                }
            };
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
    let duration_ms = started.elapsed().as_millis() as u64;

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

/// Update an existing encrypted `.myn` note in place. See module-level
/// docs for the broader pipeline narration.
///
/// **Pipeline:**
/// 1. First-line `Zeroizing::new(plaintext)` Plaintext-IPC discipline.
/// 2. Strict [`NoteId::parse`] — UI bug-canary; sub-cause via tracing.
/// 3. Slot read guard + `Slot::Unlocked(uv)` match (clone `items_key`
///    + `items_key_id` into Zeroizing wrappers; reject `Empty` /
///    `Recovering` as `VaultNotUnlocked`). Guard held across
///    `spawn_blocking + atomic_write` so `vault_lock` fair-queues per
///    `decisions.md` 2026-05-07 "Note AEAD ops".
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
#[tauri::command]
pub async fn note_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    note_id: String,
    plaintext: String,
) -> Result<(), NoteUpdateError> {
    // First-line Plaintext-IPC wrap (`src-tauri/CLAUDE.md`): bound the
    // index-feeding copy to `Zeroizing` so it wipes on every early-return and
    // at function exit rather than lingering as a plain `String` across the
    // `.await`. The core takes a fresh plain clone and re-wraps it first-line.
    let plaintext = Zeroizing::new(plaintext);
    let notes_dir = paths::notes_dir_for(&app, state.active_vault_id().await).map_err(|e| {
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
    // MYND-29 Task 4: re-index the edited note (replace semantics drop the
    // stale terms and add the new ones) after a successful write.
    let result = note_update_with_dir(
        notes_dir,
        state.inner(),
        hooks.inner(),
        note_id.clone(),
        (*plaintext).clone(),
    )
    .await;
    match result {
        Ok(outcome) => {
            // MYND-29: re-index the edited note after a successful write.
            // MYND-448a: note body indexed UNFOLDED; embedded attachments are
            // re-indexed as their own docs (dropping any no longer embedded).
            let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
            // MYND-448a: unfolded note body doc + separate attachment docs.
            // SF5 (MYND-502): a `kind: drawing` body → projected scene text, never
            // raw JSON (SYNC-4) and no attachment docs; AI re-embeds over the same.
            if is_drawing(plaintext.as_bytes()) {
                let body = project_drawing_text(plaintext.as_bytes()).unwrap_or_default();
                hooks.search_upsert(&note_id, &title, &body);
                // MYND-453: eager per-note AI re-embed (detached; feature/ai-gated).
                hooks.ai_note_changed(&note_id, &body);
            } else {
                hooks.search_upsert(&note_id, &title, &plaintext);
                hooks
                    .index_note_attachments(state.inner(), &note_id, &title, &plaintext)
                    .await;
                // MYND-453: eager per-note AI re-embed over note prose (feature/ai-gated).
                hooks.ai_note_changed(&note_id, &plaintext);
            }
            // MYND-424: mark the sync loop dirty so the coalesced push fires
            // (soft dependency — a no-op when the sync plugin isn't registered).
            hooks.bump_local_change();
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

/// Tauri event emitted (non-blocking) when a note saved successfully but its
/// best-effort pre-overwrite snapshot could not be written (SYNC-8). Payload is
/// the note id. The frontend surfaces this on the save-status channel; it never
/// blocks editing and never implies the live note was lost.
pub const SNAPSHOT_WRITE_FAILED_EVENT: &str = "snapshot://write-failed";

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
pub async fn note_update_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    note_id: String,
    plaintext: String,
) -> Result<NoteUpdateOutcome, NoteUpdateError> {
    // First non-doc statement: bound the lifetime of plaintext bytes
    // to a `Zeroizing<String>` wrapper. Same Plaintext-IPC discipline
    // as `note_create_with_dir` (see `src-tauri/CLAUDE.md`).
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
        Slot::Empty | Slot::Recovering { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_update rejected: slot is not Unlocked"
            );
            return Err(NoteUpdateError::VaultNotUnlocked);
        }
    };
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

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
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // The snapshot-capture side-effect rides the hooks seam (desktop wires the
    // real snapshot store; mobile is a no-op). Clone the `Arc` so it moves into
    // the blocking closure alongside the other captured inputs.
    let hooks = hooks.clone();

    // spawn_blocking pipeline: read .myn → decode_note → encode_update.
    // `encode_update` consumes the `DecryptedNote` handle (typestate
    // "one decode, one update"); fresh `content_nonce` generated
    // internally; bytes 0..47+N byte-identical per §6.3.
    let started = Instant::now();
    let join_result =
        tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, bool), NoteUpdateError> {
            let blob = match std::fs::read(&path_for_read) {
                Ok(bytes) => bytes,
                Err(e) => {
                    let io_kind_raw = e.kind();
                    let mapped = match io_kind_raw {
                        std::io::ErrorKind::NotFound => NoteUpdateError::NoteNotFound,
                        _ => NoteUpdateError::Io {
                            io_error_kind: from_io_error_kind(io_kind_raw),
                        },
                    };
                    tracing::error!(
                        stage = "fs_read",
                        error_kind = note_update_error_kind(&mapped),
                        "note_update blob read failed"
                    );
                    return Err(mapped);
                }
            };
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
    let duration_ms = started.elapsed().as_millis() as u64;

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
    if let Err(e) = atomic_write::atomic_write(&path, &new_blob, /* replace = */ true) {
        let kind = e.kind();
        let mapped = match kind {
            std::io::ErrorKind::NotADirectory => NoteUpdateError::NotesDirNotADirectory,
            other => NoteUpdateError::Io {
                io_error_kind: from_io_error_kind(other),
            },
        };
        tracing::error!(
            stage = "atomic_write",
            error_kind = note_update_error_kind(&mapped),
            "note_update atomic_write failed"
        );
        return Err(mapped);
    }

    // Explicit drop — make the lock-release point visible.
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
/// **Secret-handling** (`src-tauri/CLAUDE.md`): every plaintext is
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
#[tauri::command]
pub async fn note_write_batch_transactional<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
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

    let notes_dir =
        paths::notes_dir_for(&app, state.active_vault_id().await).map_err(|e| match e.kind() {
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

    note_write_batch_with_dir(notes_dir, state.inner(), &items).await?;

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
            // MYND-453: eager per-note AI re-embed (detached; feature/ai-gated).
            hooks.ai_note_changed(note_id, &body);
        } else {
            hooks.search_upsert(note_id, &title, plaintext);
            hooks
                .index_note_attachments(state.inner(), note_id, &title, plaintext)
                .await;
            // MYND-453: eager per-note AI re-embed over note prose (feature/ai-gated).
            hooks.ai_note_changed(note_id, plaintext);
        }
    }
    tracing::debug!(
        stage = "success",
        count = items.len(),
        "note_write_batch committed + re-indexed"
    );
    Ok(())
}

/// Testable core of [`note_write_batch_transactional`]: takes a resolved
/// `notes_dir` + borrowed `(id, body)` slice so tests exercise the full
/// parse → slot-guard → AEAD → transactional-commit pipeline under a
/// `ScopedTempDir` without a Tauri runtime. Mirror of
/// [`note_update_with_dir`], generalized to N notes under one transaction.
pub async fn note_write_batch_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    items: &[(String, Zeroizing<String>)],
) -> Result<(), NoteBatchError> {
    if items.is_empty() {
        return Ok(());
    }

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
        Slot::Empty | Slot::Recovering { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_write_batch rejected: slot is not Unlocked"
            );
            return Err(NoteBatchError::VaultNotUnlocked);
        }
    };
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    // spawn_blocking pipeline: for each note read .myn → decode_note →
    // encode_update; build the TxnBlob set; then commit all-or-nothing.
    // Every fallible step aborts the whole closure (and thus the batch)
    // BEFORE `write_batch_transactional` stages anything, so a failure
    // leaves the vault untouched.
    let started = Instant::now();
    let join_result = tokio::task::spawn_blocking(move || -> Result<(), NoteBatchError> {
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

        // All N encoded — commit atomically (§8.3 / WL-7).
        crate::note_txn::write_batch_transactional(&notes_dir, &blobs).map_err(|e| {
            let mapped = NoteBatchError::Io {
                io_error_kind: from_io_error_kind(e.kind()),
            };
            tracing::error!(
                stage = "write_batch_transactional",
                error_kind = note_batch_error_kind(&mapped),
                "note_write_batch transactional commit failed"
            );
            mapped
        })
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
        Ok(Ok(())) => {}
    }
    tracing::debug!(
        stage = "encode_commit",
        duration_ms = duration_ms,
        "note_write_batch read + AEAD + transactional commit succeeded"
    );

    // Explicit drop — make the lock-release point visible.
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
        NoteBatchError::JoinFailure => "JoinFailure",
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
#[tauri::command]
pub async fn note_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    note_id: String,
) -> Result<(), NoteDeleteError> {
    let notes_dir = paths::notes_dir_for(&app, state.active_vault_id().await).map_err(|e| {
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
    let result =
        note_delete_with_dir(notes_dir, state.inner(), hooks.inner(), note_id.clone()).await;
    if result.is_ok() {
        hooks.search_remove(&note_id);
        // MYND-453: drop the deleted note's vectors from the RAM store
        // (feature/ai-gated; the durable blob is reconciled on next unlock).
        hooks.ai_note_deleted(&note_id);
    }
    result
}

/// Inner — pure-and-testable helper. Mirror of
/// [`note_create_with_dir`] / [`note_read_with_dir`] /
/// [`note_update_with_dir`].
pub async fn note_delete_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    note_id: String,
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
        Slot::Empty | Slot::Recovering { .. } => {
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

    let started = Instant::now();
    let join_result = tokio::task::spawn_blocking(move || -> Result<(), NoteDeleteError> {
        // Defensive bug-canary: `<vault>/notes` may have been replaced
        // by a regular file via dev-tools manipulation, disk corruption,
        // or cross-process race. Parallel to
        // `NoteCreateError::NotesDirNotADirectory`.
        if !notes_dir.is_dir() {
            tracing::error!(
                stage = "exists_check",
                error_kind = "NotesDirNotADirectory",
                "note_delete notes_dir is not a directory"
            );
            return Err(NoteDeleteError::NotesDirNotADirectory);
        }
        // MYND-96 SYNC-1: purge this note's snapshots BEFORE removing the live
        // `.myn`, so cryptographic erase holds. A snapshot is a verbatim `.myn`
        // copy carrying its own wrapped `enc_item_key`, so it stays decryptable
        // under `itemsKey` even after the live note is gone — the purge IS the
        // erase of the note's history. Purge-first ordering means a crash
        // mid-delete leaves the live note intact (recoverable) rather than
        // orphan decryptable snapshots. Best-effort; a failure is logged, not
        // fatal to the delete (the live note removal is the user-facing action).
        if let Some(vault_root) = notes_dir.parent() {
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
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::debug!(
                    stage = "remove_file",
                    error_kind = "NoteNotFound",
                    "note_delete file already gone"
                );
                return Err(NoteDeleteError::NoteNotFound);
            }
            Err(e) => {
                let mapped = NoteDeleteError::Io {
                    io_error_kind: from_io_error_kind(e.kind()),
                };
                tracing::error!(
                    stage = "remove_file",
                    error_kind = note_delete_error_kind(&mapped),
                    "note_delete remove_file failed"
                );
                return Err(mapped);
            }
        }
        // Unix-only durability: flush the directory entry's removal to
        // the journal. Windows arm is intentionally absent —
        // `decisions.md` 2026-05-07 "`note_delete` durability" pins the
        // asymmetry (write durability is data-integrity, delete
        // durability is redundancy-elimination; failure mode'lar farklı).
        #[cfg(unix)]
        {
            let dir = std::fs::File::open(&notes_dir).map_err(|e| {
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
        Ok(())
    })
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

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
/// **Tracing level split** (per `myne-agents/sessions/grill/2026-05-07-mynd-28-note-list.md` Q4b):
/// - non-`.myn` files (`.DS_Store`, `.tmp`, accidental drops) +
///   non-UTF-8 filenames → `tracing::debug!(stage = "skip_orphan")`,
///   benign noise.
/// - `.myn` files whose stem fails [`NoteId::parse`] →
///   `tracing::warn!(stage = "skip_malformed_uuid", cause = ?cause)`,
///   corruption canary. The offending stem string itself is **never**
///   logged (DENY-list compliance per `src-tauri/CLAUDE.md`
///   "Secret-handling logging discipline").
pub fn enumerate_notes_dir(notes_dir: &std::path::Path) -> std::io::Result<Vec<NoteId>> {
    let mut ids: Vec<NoteId> = Vec::new();
    for entry in std::fs::read_dir(notes_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            // Non-UTF-8 filename (Linux can hold arbitrary bytes; APFS /
            // NTFS normalize but accept many invalid sequences). Benign
            // OS-level housekeeping noise — the offending bytes never
            // appear in tracing per `src-tauri/CLAUDE.md` DENY list.
            tracing::debug!(stage = "skip_orphan");
            continue;
        };
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
    Ok(ids)
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
#[tauri::command]
pub async fn note_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<NoteId>, NoteListError> {
    let notes_dir = paths::notes_dir_for(&app, state.active_vault_id().await).map_err(|e| {
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
    note_list_with_dir(notes_dir, state.inner()).await
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
) -> Result<Vec<NoteId>, NoteListError> {
    let slot = state.slot_read_active().await;
    match &*slot {
        Slot::Unlocked(_) => {}
        Slot::Empty | Slot::Recovering { .. } => {
            tracing::debug!(
                stage = "slot_check",
                outcome = "vault_locked",
                "note_list rejected: slot is not Unlocked"
            );
            return Err(NoteListError::VaultNotUnlocked);
        }
    }
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    let started = Instant::now();
    let result = tokio::task::spawn_blocking(move || enumerate_notes_dir(&notes_dir)).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    let ids = match result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_list enumerate panicked or runtime shutdown"
            );
            return Err(NoteListError::JoinFailure);
        }
        Ok(Err(e)) => {
            let kind = e.kind();
            let mapped = match kind {
                std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
                    NoteListError::NotesDirNotADirectory
                }
                other => NoteListError::Io {
                    io_error_kind: from_io_error_kind(other),
                },
            };
            tracing::error!(
                stage = "enumerate",
                error_kind = note_list_error_kind(&mapped),
                "note_list enumerate failed"
            );
            return Err(mapped);
        }
        Ok(Ok(ids)) => ids,
    };

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
/// - `myne-agents/sessions/grill/2026-05-15-mynd-82-sidebar-autosave.md`
///   Q3 (hybrid byte-range), Q4 (per-item Result), Q5 (cap 100),
///   Q6 (parallel decrypt — implemented here as concurrent spawn-then-
///   sequential-await; ordering preserved by await order).
/// - `decisions.md` 2026-05-07 "Note AEAD ops: clone-out items_key +
///   always spawn_blocking" — same pattern reused per-item.
#[tauri::command]
pub async fn note_titles_batch<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    ids: Vec<String>,
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

    let notes_dir = paths::notes_dir_for(&app, state.active_vault_id().await).map_err(|e| {
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
    note_titles_batch_with_dir(notes_dir, state.inner(), ids).await
}

/// Inner — pure-and-testable helper. Mirror of the other notes-command
/// `_with_dir` helpers.
pub async fn note_titles_batch_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    ids: Vec<String>,
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
        Slot::Empty | Slot::Recovering { .. } => {
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

    let started = Instant::now();

    // Spawn all per-item tasks up front; each lands on the blocking pool
    // immediately. Awaiting sequentially below preserves input order
    // without sacrificing wall-clock parallelism — tokio executes the
    // spawned tasks concurrently regardless of await order.
    let mut handles = Vec::with_capacity(ids.len());
    for id_str in ids {
        let items_key_clone = items_key.clone();
        let items_key_id_local = items_key_id;
        let notes_dir_clone = notes_dir.clone();
        handles.push(tokio::task::spawn_blocking(move || {
            extract_one_title_slice(
                &notes_dir_clone,
                id_str,
                &items_key_clone,
                &items_key_id_local,
            )
        }));
    }

    let mut results: Vec<Result<TitleSlice, NoteTitleError>> = Vec::with_capacity(handles.len());
    for handle in handles {
        let per_item = match handle.await {
            Ok(per_item) => per_item,
            Err(_join_err) => {
                tracing::error!(
                    stage = "spawn_blocking_join",
                    error_kind = "JoinFailure",
                    "note_titles_batch per-item task panicked or runtime shutdown"
                );
                Err(NoteTitleError::JoinFailure)
            }
        };
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

    let duration_ms = started.elapsed().as_millis() as u64;
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
    // Strict-parse `note_id`. A malformed ID is treated as `NoteNotFound`
    // since the canonical ID set comes from `note_list` — anything else
    // is a UI bug or a manual invocation; the file doesn't exist on
    // disk either way, and surfacing `NoteNotFound` keeps the user
    // experience honest (the row drops out of the sidebar).
    let note_id = match NoteId::parse(&id_str) {
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
    let note_uuid_bytes = *note_id.as_uuid().as_bytes();

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

    let decrypted = match decode_note(&blob, &note_uuid_bytes, items_key, items_key_id) {
        Ok(d) => d,
        Err(_dec_err) => {
            // `DecryptError` sub-cause was already emitted via
            // `tracing::debug!(stage = ?cause)` from inside `decode_note`;
            // host adds a parallel non-distinguishing event without
            // re-introducing the distinguisher at the IPC boundary
            // (`protocol.md` §6.4 preserved).
            return Err(NoteTitleError::CannotDecrypt);
        }
    };

    let slices = extract_title_slices(decrypted.plaintext());
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
        note_uuid: id_str,
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
        // tracing field. Per `src-tauri/CLAUDE.md` "Secret-handling
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
