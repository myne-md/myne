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
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

use super::error::{
    NoteCreateError, NoteDeleteError, NoteListError, NoteReadError, NoteUpdateError,
};
use super::note_id::NoteId;

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
    plaintext: String,
) -> Result<String, NoteCreateError> {
    // Resolve `<vault>/notes/` (lazy `create_dir_all`); map both
    // `NotADirectory` and `AlreadyExists` to the structural defensive
    // variant per the accept-list pinned in `paths::notes_dir_under`'s
    // tests.
    let notes_dir = paths::notes_dir(&app).map_err(|e| {
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
    note_create_with_dir(notes_dir, state.inner(), plaintext).await
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
    let slot = state.slot_read().await;
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
    let notes_dir = paths::notes_dir(&app).map_err(|e| {
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
    let slot = state.slot_read().await;
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
    note_id: String,
    plaintext: String,
) -> Result<(), NoteUpdateError> {
    let notes_dir = paths::notes_dir(&app).map_err(|e| {
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
    note_update_with_dir(notes_dir, state.inner(), note_id, plaintext).await
}

/// Inner — pure-and-testable helper. Mirror of
/// [`note_create_with_dir`] / [`note_read_with_dir`].
pub(crate) async fn note_update_with_dir(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    note_id: String,
    plaintext: String,
) -> Result<(), NoteUpdateError> {
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
    let slot = state.slot_read().await;
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

    // spawn_blocking pipeline: read .myn → decode_note → encode_update.
    // `encode_update` consumes the `DecryptedNote` handle (typestate
    // "one decode, one update"); fresh `content_nonce` generated
    // internally; bytes 0..47+N byte-identical per §6.3.
    let started = Instant::now();
    let join_result =
        tokio::task::spawn_blocking(move || -> Result<Vec<u8>, NoteUpdateError> {
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
                Ok(new_blob) => Ok(new_blob),
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

    let new_blob = match join_result {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "note_update read+decode+encode panicked or runtime shutdown"
            );
            return Err(NoteUpdateError::JoinFailure);
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(blob)) => blob,
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
    note_id: String,
) -> Result<(), NoteDeleteError> {
    let notes_dir = paths::notes_dir(&app).map_err(|e| {
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
    note_delete_with_dir(notes_dir, state.inner(), note_id).await
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
    let slot = state.slot_read().await;
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
/// **Tracing level split** (per `agent-tooling/sessions/grill/2026-05-07-mynd-28-note-list.md` Q4b):
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
    let notes_dir = paths::notes_dir(&app).map_err(|e| {
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
    let slot = state.slot_read().await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::notes_dir_under;
    use crate::plugins::vault_unlock::state::{
        fixture_recovering_with_keys, fixture_unlocked_with_keys, VaultRuntimeState,
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_recovering(fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
                .await;

            let create_state = Arc::clone(&state);
            let create_dir = notes_dir.clone();
            let create = tokio::spawn(async move {
                note_create_with_dir(create_dir, &create_state, "concurrent".to_string()).await
            });

            tokio::task::yield_now().await;

            let lock_state = Arc::clone(&state);
            let lock = tokio::spawn(async move { lock_state.take().await });

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
                state.slot_kind().await,
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_recovering(fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_recovering(fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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

    // ---- 16 MiB boundary -----------------------------------------------

    #[test]
    fn update_plaintext_at_max_succeeds() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("note-update-max").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
            let lock_task = tokio::spawn(async move { lock_state.take().await });

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
                state.slot_kind().await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
            );

            // Update outcome depends on which task acquired its lock first:
            //   - `Ok(())`                        → update ran first; lock
            //                                       waited for the read guard.
            //   - `Err(VaultNotUnlocked)`         → lock ran first; update
            //                                       observed `Slot::Empty`.
            match update_result {
                Ok(()) => {}
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_recovering(fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
            let lock_task = tokio::spawn(async move { lock_state.take().await });

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
                state.slot_kind().await,
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_recovering(fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
                .set_unlocked(fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ))
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
            let lock_task = tokio::spawn(async move { lock_state.take().await });

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
                state.slot_kind().await,
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
}
