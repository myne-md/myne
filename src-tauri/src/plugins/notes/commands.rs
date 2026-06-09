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
use crate::plugins::vault_unlock::state::{Slot, SlotKind, VaultRuntimeState};
use crate::search::{MatchedIn, SearchIndexState};
use protocol::{decode_note, encode_new_note, encode_update, DecryptError, ProtocolError};
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Runtime, State};
use zeroize::Zeroizing;

use super::error::{
    NoteCreateError, NoteDeleteError, NoteListError, NoteReadError, NoteTitleBatchError,
    NoteTitleError, NoteUpdateError,
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
    search: State<'_, SearchIndexState>,
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
        search.upsert(id, &title, &plaintext);
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
pub(crate) async fn note_create_with_dir(
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
fn note_create_error_kind(e: &NoteCreateError) -> &'static str {
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
pub(crate) async fn note_read_with_dir(
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
fn note_read_error_kind(e: &NoteReadError) -> &'static str {
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
    search: State<'_, SearchIndexState>,
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
        note_id.clone(),
        (*plaintext).clone(),
    )
    .await;
    match result {
        Ok(outcome) => {
            // MYND-29: re-index the edited note after a successful write.
            let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
            search.upsert(&note_id, &title, &plaintext);
            // SYNC-8: a best-effort snapshot failure is surfaced non-blockingly
            // (the note itself saved fine). The frontend shows it on the
            // save-status channel; the IPC return stays `Ok(())`.
            if outcome.snapshot_warning {
                let _ = app.emit(SNAPSHOT_WRITE_FAILED_EVENT, &note_id);
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
pub(crate) const SNAPSHOT_WRITE_FAILED_EVENT: &str = "snapshot://write-failed";

/// Internal outcome of [`note_update_with_dir`] — carries a non-blocking
/// snapshot-failure signal out to the `note_update` wrapper without changing the
/// IPC contract (which stays `Result<(), NoteUpdateError>`).
#[derive(Debug, Default)]
pub(crate) struct NoteUpdateOutcome {
    /// True if the best-effort pre-overwrite snapshot could not be written. The
    /// note itself saved correctly.
    pub(crate) snapshot_warning: bool,
}

/// Inner — pure-and-testable helper. Mirror of
/// [`note_create_with_dir`] / [`note_read_with_dir`].
pub(crate) async fn note_update_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
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
    let now_ms = crate::snapshot_store::now_unix_ms();

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
                        Some(root) => capture_snapshot_best_effort(
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

/// Best-effort: capture a snapshot of a note's pre-overwrite `.myn` blob
/// (MYND-96), gated by the coalescing window. A snapshot is a recovery
/// convenience, not part of the note write's integrity contract — so this
/// **never** fails the caller's update (SYNC-8); every failure is logged and
/// swallowed. `old_blob` is the verbatim `.myn` bytes about to be replaced;
/// `vault_root` is the parent of `notes/` (the flat `snapshots/` dir is its
/// sibling). Runs inside the caller's `spawn_blocking` + held slot read-guard,
/// before the live note is overwritten — so a failed snapshot cannot corrupt
/// the note. `force` bypasses the coalescing gate (on-close/lock flush, restore
/// undo point).
///
/// **Returns `true` if the snapshot could not be written** (dir-create or write
/// failure) — a non-blocking warning the caller surfaces to the frontend
/// (SYNC-8). Returns `false` on success or a coalesced skip. A prune failure is
/// NOT a warning (the snapshot itself already succeeded).
fn capture_snapshot_best_effort(
    vault_root: &std::path::Path,
    note_uuid: &str,
    old_blob: &[u8],
    now_ms: u64,
    force: bool,
) -> bool {
    let sdir = match crate::paths::snapshots_dir_under(vault_root) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(
                stage = "snapshot_mkdir",
                io_failure_kind = ?from_io_error_kind(e.kind()),
                "snapshot dir create failed (best-effort; note save unaffected)"
            );
            return true;
        }
    };
    let existing = crate::snapshot_store::list_note_snapshots(&sdir, note_uuid).unwrap_or_default();
    let last = existing.first().map(|s| s.captured_at_ms);
    if !crate::snapshot_policy::should_snapshot(last, now_ms, force) {
        tracing::debug!(
            stage = "snapshot_coalesced",
            "snapshot skipped: within window"
        );
        return false;
    }
    let snap_uuid = crate::snapshot_store::new_snapshot_uuid().to_string();
    if let Err(e) =
        crate::snapshot_store::write_snapshot_blob(&sdir, note_uuid, &snap_uuid, old_blob)
    {
        tracing::warn!(
            stage = "snapshot_write",
            io_failure_kind = ?from_io_error_kind(e.kind()),
            "snapshot write failed (best-effort; note save unaffected)"
        );
        return true;
    }
    tracing::debug!(
        stage = "snapshot_created",
        "pre-overwrite snapshot captured"
    );

    // Eager prune (SYNC-2): enforce retention at the single write-path source of
    // truth, right after creating the snapshot. Best-effort; a prune failure is
    // not surfaced as a warning (the snapshot already landed).
    if let Err(e) = crate::snapshot_store::prune_note_snapshots(
        &sdir,
        note_uuid,
        now_ms,
        &crate::snapshot_policy::RetentionPolicy::default(),
    ) {
        tracing::warn!(
            stage = "snapshot_prune",
            io_failure_kind = ?from_io_error_kind(e.kind()),
            "snapshot prune scan failed (best-effort; snapshot already written)"
        );
    }
    false
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
        Some(vault_root) => {
            capture_snapshot_best_effort(
                vault_root, note_uuid, &blob, now_ms, /* force = */ true,
            )
        }
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
        Slot::Empty | Slot::Recovering { .. } => {
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
/// state on editor-close / before vault-lock (MYND-96, SYNC-3). The frontend
/// calls this from its close/lock flush path (paired with the autosave
/// flush-on-blur/close already in place). Best-effort: a snapshot failure
/// surfaces the non-blocking `snapshot://write-failed` event; the IPC return
/// stays `Result<(), NoteUpdateError>`.
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

/// Static-string label for [`NoteUpdateError`] variants — same
/// drift-detector discipline as [`note_create_error_kind`] /
/// [`note_read_error_kind`]. A new variant compile-fails this match.
fn note_update_error_kind(e: &NoteUpdateError) -> &'static str {
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
    search: State<'_, SearchIndexState>,
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
    let result = note_delete_with_dir(notes_dir, state.inner(), note_id.clone()).await;
    if result.is_ok() {
        search.remove(&note_id);
    }
    result
}

/// Inner — pure-and-testable helper. Mirror of
/// [`note_create_with_dir`] / [`note_read_with_dir`] /
/// [`note_update_with_dir`].
pub(crate) async fn note_delete_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
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
            let sdir = vault_root.join("snapshots");
            match crate::snapshot_store::remove_all_note_snapshots(&sdir, &note_uuid_str) {
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
pub(crate) fn enumerate_notes_dir(notes_dir: &std::path::Path) -> std::io::Result<Vec<NoteId>> {
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
fn note_delete_error_kind(e: &NoteDeleteError) -> &'static str {
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
pub(crate) async fn note_list_with_dir(
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
fn note_list_error_kind(e: &NoteListError) -> &'static str {
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
fn note_title_error_kind(e: &NoteTitleError) -> &'static str {
    match e {
        NoteTitleError::CannotDecrypt => "CannotDecrypt",
        NoteTitleError::NoteNotFound => "NoteNotFound",
        NoteTitleError::Io { .. } => "Io",
        NoteTitleError::JoinFailure => "JoinFailure",
    }
}

/// Static-string label for [`NoteTitleBatchError`] variants — drift-
/// detector pattern. A new variant compile-fails this match.
fn note_title_batch_error_kind(e: &NoteTitleBatchError) -> &'static str {
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
pub(crate) async fn note_titles_batch_with_dir(
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
fn extract_one_title_slice(
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

/// A ranked search result for the WebView (MYND-29 Task 5; `matched_in` +
/// cap added in MYND-40): the matching note's id + display title + BM25 score,
/// best score first, plus which field(s) the query matched in. `matched_in`
/// drives the palette's "matched in body" badge — a body-only hit is a note
/// whose title does not contain the query. Match-context SNIPPET rendering is
/// deferred to Phase 2 (the index stores postings + titles, not the full body,
/// and decrypting per hit to build a snippet is rejected on threat-model
/// grounds); v0.1 ranks over the body but renders title + the body-match badge.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchResult {
    pub note_id: String,
    pub title: String,
    pub score: f32,
    pub matched_in: MatchedIn,
}

/// Upper bound on results returned to the WebView per query (MYND-40). The
/// index returns the full BM25-ranked match set; a broad type-ahead prefix on
/// a large vault can match thousands of notes, so the command caps to the
/// top-N highest-scored — the palette renders ~10-20 rows, and an unbounded
/// result set is wasted IPC + render. Result-shaping only: the index
/// data-model and the `MYS1` blob are untouched.
pub(crate) const NOTE_SEARCH_RESULT_CAP: usize = 50;

/// `note_search` — `Slot::Unlocked`-gated full-text search over the live
/// in-RAM index (MYND-29 Task 5). Returns BM25-ranked results, or an EMPTY
/// vec when the vault is not unlocked (no error, no leak). The index is
/// populated/updated while unlocked (Tasks 4/7) and cleared on lock (Task 8).
#[tauri::command]
pub async fn note_search(
    state: State<'_, VaultRuntimeState>,
    search: State<'_, SearchIndexState>,
    query: String,
) -> Result<Vec<SearchResult>, ()> {
    // Infallible in practice (the gate yields an empty vec, not an error, when
    // not unlocked; `query` is infallible). The `Result` is only here because
    // Tauri requires reference-taking async commands to return a `Result`; the
    // `Err(())` arm is never produced.
    Ok(note_search_core(state.inner(), search.inner(), &query).await)
}

/// Testable core of [`note_search`]: gate on `Slot::Unlocked`, then map the
/// index's ranked hits to the WebView result shape. Takes plain refs so tests
/// exercise the slot gate without a Tauri runtime (mirrors the `_with_dir`
/// testability pattern). No secret material is logged.
pub(crate) async fn note_search_core(
    state: &VaultRuntimeState,
    search: &SearchIndexState,
    query: &str,
) -> Vec<SearchResult> {
    // Gate: search only while Unlocked. Recovering / Empty → empty result, so a
    // stale-but-not-yet-cleared index (pre-Task-8) cannot leak when locked.
    if !matches!(state.slot_kind_active().await, SlotKind::Unlocked) {
        return Vec::new();
    }
    search
        .query(query)
        .into_iter()
        .take(NOTE_SEARCH_RESULT_CAP)
        .map(|hit| SearchResult {
            note_id: hit.id,
            title: hit.title,
            score: hit.score,
            matched_in: hit.matched_in,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::notes_dir_under;
    use crate::plugins::vault_unlock::state::{
        fixture_recovering_with_keys, fixture_unlocked_with_keys, test_vault_id, test_vault_id_b,
        VaultRuntimeState,
    };
    use crate::test_support::ScopedTempDir;
    use std::path::Path;

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
            let note_id_str =
                note_create_with_dir(notes_dir.clone(), &state, plaintext.to_string())
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
            let id = note_create_with_dir(notes_dir.clone(), &state, v1.to_string())
                .await
                .unwrap();
            let v2 = "# v2\nedited body";
            let outcome =
                note_update_with_dir(notes_dir.clone(), &state, id.clone(), v2.to_string())
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

            let id = note_create_with_dir(notes_dir.clone(), &state, "v1".to_string())
                .await
                .unwrap();
            note_update_with_dir(notes_dir.clone(), &state, id.clone(), "v2".to_string())
                .await
                .unwrap();
            // Second update lands within the ~5-min coalescing window → no new snapshot.
            note_update_with_dir(notes_dir.clone(), &state, id.clone(), "v3".to_string())
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

            let id = note_create_with_dir(notes_dir.clone(), &state, "v1".to_string())
                .await
                .unwrap();
            let outcome =
                note_update_with_dir(notes_dir.clone(), &state, id.clone(), "v2".to_string())
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

            let id = note_create_with_dir(notes_dir.clone(), &state, "v1".to_string())
                .await
                .unwrap();
            // First update captures one snapshot (of v1); we're now inside the window.
            note_update_with_dir(notes_dir.clone(), &state, id.clone(), "v2".to_string())
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

            let id = note_create_with_dir(notes_dir.clone(), &state, "v1".to_string())
                .await
                .unwrap();
            note_update_with_dir(notes_dir.clone(), &state, id.clone(), "v2".to_string())
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
            note_delete_with_dir(notes_dir.clone(), &state, id.clone())
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

            let result = note_create_with_dir(notes_dir, &state, "x".to_string()).await;
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

            let result = note_create_with_dir(notes_dir, &state, "x".to_string()).await;
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
            let result = note_create_with_dir(notes_dir, &state, plaintext).await;
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
            let result = note_create_with_dir(notes_dir, &state, plaintext).await;
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
                note_create_with_dir(create_dir, &create_state, "concurrent".to_string()).await
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
            let note_id_str =
                note_create_with_dir(notes_dir.clone(), &state, plaintext.to_string())
                    .await
                    .unwrap();

            let recovered = note_read_with_dir(notes_dir, &state, note_id_str)
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

            let result = note_read_with_dir(notes_dir, &state, "too-short".to_string()).await;
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
            let result = note_read_with_dir(notes_dir, &state, phantom.to_string()).await;
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
            let note_id_str =
                note_create_with_dir(notes_dir.clone(), &state, "untampered original".to_string())
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

            let result = note_read_with_dir(notes_dir, &state, note_id_str).await;
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

            let result = note_read_with_dir(notes_dir, &state, note_id.to_string()).await;
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
            let note_id_str = note_create_with_dir(notes_dir.clone(), &state, original.to_string())
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
                note_id_str.clone(),
                updated.to_string(),
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
            let recovered = note_read_with_dir(notes_dir, &state, note_id_str)
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
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                "x".to_string(),
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
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
                "x".to_string(),
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

            let result =
                note_update_with_dir(notes_dir, &state, "too-short".to_string(), "x".to_string())
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
            let result =
                note_update_with_dir(notes_dir, &state, phantom.to_string(), "x".to_string()).await;
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
            let note_id_str =
                note_create_with_dir(notes_dir.clone(), &state, "untampered original".to_string())
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

            let result =
                note_update_with_dir(notes_dir, &state, note_id_str, "rewrite".to_string()).await;
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
            note_create_with_dir(notes_dir.clone(), &state, plaintext)
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

            let note_id_str =
                note_create_with_dir(notes_dir.clone(), &state, "# v1\nfirst body".to_string())
                    .await
                    .unwrap();
            let updated = format!("# v2\n{PLAINTEXT_CANARY} rewritten");
            note_update_with_dir(notes_dir.clone(), &state, note_id_str, updated)
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
            let note_id_str = note_create_with_dir(notes_dir.clone(), &state, original.to_string())
                .await
                .unwrap();

            // r-x only: creating the atomic_write temp inside now fails
            // with PermissionDenied. Read perms remain, so the pre-write
            // decode of the existing blob still succeeds.
            std::fs::set_permissions(&notes_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
            let result = note_update_with_dir(
                notes_dir.clone(),
                &state,
                note_id_str.clone(),
                "rewrite that cannot land".to_string(),
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
            let recovered = note_read_with_dir(notes_dir, &state, note_id_str)
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
            let result =
                note_create_with_dir(notes_dir.clone(), &state, "# never lands".to_string()).await;
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

            let note_id_str = note_create_with_dir(notes_dir.clone(), &state, "small".to_string())
                .await
                .unwrap();

            let big = String::from_utf8(vec![b'a'; protocol::MAX_PLAINTEXT_LEN]).unwrap();
            let result = note_update_with_dir(notes_dir, &state, note_id_str, big).await;
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

            let note_id_str = note_create_with_dir(notes_dir.clone(), &state, "small".to_string())
                .await
                .unwrap();

            let too_big = String::from_utf8(vec![b'a'; protocol::MAX_PLAINTEXT_LEN + 1]).unwrap();
            let result = note_update_with_dir(notes_dir, &state, note_id_str, too_big).await;
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

            let note_id_str =
                note_create_with_dir(notes_dir.clone(), &state, "initial body".to_string())
                    .await
                    .unwrap();

            let update_state = Arc::clone(&state);
            let update_dir = notes_dir.clone();
            let update_id = note_id_str.clone();
            let update_task = tokio::spawn(async move {
                note_update_with_dir(update_dir, &update_state, update_id, "rewrite".to_string())
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

            let note_id_str =
                note_create_with_dir(notes_dir.clone(), &state, "to be deleted".to_string())
                    .await
                    .unwrap();

            // Confirm file exists pre-delete.
            let path = notes_dir.join(format!(
                "{}.myn",
                NoteId::parse(&note_id_str).unwrap().as_uuid()
            ));
            assert!(path.is_file(), "file must exist pre-delete");

            note_delete_with_dir(notes_dir.clone(), &state, note_id_str.clone())
                .await
                .expect("delete must succeed on a fresh note");

            // File is gone (cryptographic erase yapısal: enc_item_key
            // lived inside the .myn; unlink removes both ciphertext and
            // wrapped key in one operation).
            assert!(!path.exists(), "file must be removed post-delete");

            // Subsequent read returns NoteNotFound — the ledger / editor
            // route's natural affordance for a deleted note.
            let read_result = note_read_with_dir(notes_dir, &state, note_id_str).await;
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

            let note_id_str =
                note_create_with_dir(notes_dir.clone(), &state, "transient".to_string())
                    .await
                    .unwrap();

            note_delete_with_dir(notes_dir.clone(), &state, note_id_str.clone())
                .await
                .expect("first delete must succeed");

            let second = note_delete_with_dir(notes_dir, &state, note_id_str).await;
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
            let result = note_delete_with_dir(notes_dir, &state, phantom.to_string()).await;
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
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
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
                "01970e83-4f2f-7000-8000-000000000000".to_string(),
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

            let result = note_delete_with_dir(notes_dir, &state, "too-short".to_string()).await;
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
            let result = note_delete_with_dir(bogus_notes_dir, &state, phantom.to_string()).await;
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

            let note_id_str =
                note_create_with_dir(notes_dir.clone(), &state, "to be deleted".to_string())
                    .await
                    .unwrap();

            let delete_state = Arc::clone(&state);
            let delete_dir = notes_dir.clone();
            let delete_id = note_id_str.clone();
            let delete_task = tokio::spawn(async move {
                note_delete_with_dir(delete_dir, &delete_state, delete_id).await
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

            let result = note_list_with_dir(notes_dir, &state).await;
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

            let ids = note_list_with_dir(notes_dir, &state).await.unwrap();
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

            let result = note_list_with_dir(notes_dir, &state).await;
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

            let result = note_list_with_dir(notes_dir, &state).await;
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

            let result = note_list_with_dir(conflict, &state).await;
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
            let list_task =
                tokio::spawn(async move { note_list_with_dir(list_dir, &list_state).await });

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
        note_create_with_dir(notes_dir.to_path_buf(), state, plaintext.to_string())
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
            let results = note_titles_batch_with_dir(notes_dir, &state, ids.clone())
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
            let result = note_titles_batch_with_dir(notes_dir, &state, ids).await;
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

            let results = note_titles_batch_with_dir(notes_dir, &state, ids)
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
            let result = note_titles_batch_with_dir(notes_dir, &state, vec![]).await;
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
            let result = note_titles_batch_with_dir(notes_dir, &state, vec![]).await;
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

            let results = note_titles_batch_with_dir(notes_dir, &state, vec![id.clone()])
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
            let results =
                note_titles_batch_with_dir(notes_dir, &state, vec!["not-a-valid-uuid".to_string()])
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
            let results = note_titles_batch_with_dir(notes_dir, &state, vec![])
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
            let id = note_create_with_dir(notes_dir.clone(), &state, plaintext.to_string())
                .await
                .expect("note_create must operate on the sole Unlocked vault");

            // Round-trip read (also no vault_id param) returns the same body —
            // confirming both the create and read seams resolved the active
            // vault and used its `items_key`.
            let read_back = note_read_with_dir(notes_dir, &state, id)
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

            let result = note_create_with_dir(notes_dir, &state, "x".to_string()).await;
            assert!(
                matches!(result, Err(NoteCreateError::VaultNotUnlocked)),
                "no unlocked vault must yield the clean guard error, got {result:?}"
            );
        });
    }
}
