//! Tauri-layer error types for the `notes` plugin.
//!
//! Mirrors the `vault_unlock::error::VaultUnlockError` discipline (no
//! `String` field anywhere reaches the frontend) but specialized to
//! the per-note CRUD domain. Two closed enums are exported — one per
//! command — so the frontend's discriminated-union mirrors stay tight
//! and an `Err` from `note_create` cannot accidentally type-narrow to
//! `NoteReadError`.
//!
//! Spec touchpoints:
//!
//! - `protocol.md` §6.4 — `NoteReadError::CannotDecrypt` is the single
//!   non-distinguishing tag for AEAD-tag failure on `decode_note`.
//!   The codec's internal `pub(crate) DecryptCause` is routed to
//!   `tracing::debug!` inside the codec; this enum never carries it.
//! - `protocol.md` §6.2 + `decisions.md` 2026-05-07 (Note UUIDv7
//!   backend-gen) — `NoteCreateError::NoteAlreadyExists` is a defensive
//!   canary: backend-generated UUIDv7 is unique by construction;
//!   `src-tauri/CLAUDE.md` "Defensive guards" makes the exists-check
//!   mandatory anyway. Production never reaches this variant in normal
//!   flow.
//! - `decisions.md` 2026-04-26 unlock-error-discipline — the single
//!   non-distinguishing public tag + internal stage-tag-via-tracing
//!   pattern this enum mirrors.
//! - `decisions.md` 2026-05-07 (atomic_write durability + replace:bool)
//!   — `replace=false` returns `io::ErrorKind::AlreadyExists` from the
//!   helper layer; `note_create` maps that to `NoteAlreadyExists`.
//! - Q4 grilling decision — `InvalidPlaintextEncoding` is **distinct**
//!   from `CannotDecrypt`: §6.4 covers AEAD failure (which leaks
//!   credential validity); UTF-8 invalid post-AEAD-success is a
//!   structural-corruption / foreign-writer-suspicion category, the
//!   not-reading kin of `InvalidVaultMeta`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_create`].
///
/// Hand-mirrored on the TS side at `src/types/note-create-error.ts`.
/// Variant set is closed; adding a variant is an IPC contract change
/// that requires updating both sides.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
#[allow(dead_code)] // production constructors land with Task 8 (note_create command)
pub enum NoteCreateError {
    /// Slot is `Empty` or `Recovering`. Frontend routes the user to
    /// the lock screen via `vault_status` / `vault_slot_kind`; if this
    /// surfaces from `note_create`, a router bug.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// `<vault>/notes/<note_id>.myn` already exists. Backend-generated
    /// UUIDv7 makes a real collision astronomically improbable; this
    /// variant is the canary the `atomic_write(replace=false)` helper
    /// guarantees per `src-tauri/CLAUDE.md` "Defensive guards".
    /// **Not user-facing in normal flow.**
    #[error("note already exists")]
    NoteAlreadyExists,

    /// Plaintext exceeds `protocol::MAX_PLAINTEXT_LEN` (16 MiB). UI
    /// surfaces "16 MiB sınırını aşıyor" with an attachment-Phase 1.5+
    /// affordance (PRD U11 / task 5).
    #[error("plaintext too large")]
    PlaintextTooLarge,

    /// `<vault>/notes` exists as a regular file rather than a
    /// directory — defensive edge case for OS-level user manipulation
    /// of the vault directory. UI surfaces "Vault directory'nizde
    /// 'notes' adlı bir dosya var. Lütfen kaldırın veya vault'u
    /// taşıyın."
    #[error("vault notes path is not a directory")]
    NotesDirNotADirectory,

    /// File-system IO failure during `notes_dir` resolution or
    /// `atomic_write`. The bounded [`IoFailureKind`] keeps OS error
    /// messages off the wire.
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown). Includes the
    /// `unreachable!` panic path for `encode_new_note` AEAD seal
    /// failure (impossible under v0.1 fixed parameters; if it ever
    /// fires, it's caught here). User-facing CTA is "try again".
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteCreateError {
    fn from(e: std::io::Error) -> Self {
        // `AlreadyExists` and `NotADirectory` are special-cased by the
        // calling command (mapped to the structural variants
        // `NoteAlreadyExists` / `NotesDirNotADirectory`). This `From`
        // handles the residual cases where an `io::Error` bubbles up
        // unclassified.
        NoteCreateError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_read`].
///
/// Hand-mirrored on the TS side at `src/types/note-read-error.ts`.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
#[allow(dead_code)] // production constructors land with Task 9 (note_read command)
pub enum NoteReadError {
    /// `<vault>/notes/<note_id>.myn` does not exist. UI: "Bu not
    /// silinmiş olabilir." Distinct from `InvalidNoteId` because that
    /// is a UI-bug-canary while this is a normal user-flow outcome.
    #[error("note not found")]
    NoteNotFound,

    /// `note_id` failed strict parse via `super::note_id::NoteId::parse`.
    /// The internal sub-cause (`WrongLength`, `InvalidChar`,
    /// `WrongHyphenPosition`, `ParseFailed`, `WrongVersion`) is
    /// emitted via `tracing::debug!(stage = ?cause)` for ops debugging
    /// and **does not** cross the IPC boundary as a distinguisher.
    /// Bug-canary: backend always returns canonical `note_id` strings,
    /// so anything else is a UI regression.
    #[error("invalid note id")]
    InvalidNoteId,

    /// Slot is `Empty` or `Recovering` — same shape as
    /// [`NoteCreateError::VaultNotUnlocked`]; reproduced as a separate
    /// per-enum variant so the read and create error surfaces stay
    /// independent.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// AEAD-tag failure on `decode_note`. **By design this single tag
    /// does NOT distinguish** parse-level failure (magic / version /
    /// reserved / `enc_item_key_len` / cap), `items_key_id` mismatch,
    /// outer-AEAD failure (`enc_item_key` wrap), or inner-AEAD failure
    /// (content) — see `protocol.md` §6.4. The codec's internal
    /// `pub(crate) DecryptCause` flows through its own
    /// `tracing::debug!(stage = ?cause)` inside `decode_note`; the
    /// host plugin emits an additional `outcome = "cannot_decrypt"`
    /// stage but does not re-introduce the distinguisher at the IPC
    /// boundary.
    #[error("note cannot be decrypted")]
    CannotDecrypt,

    /// AEAD authenticity passed but the recovered plaintext bytes are
    /// not valid UTF-8. Distinct from [`Self::CannotDecrypt`] because
    /// `protocol.md` §6.4's non-distinguishing rule covers AEAD-tag
    /// failure (which leaks credential validity); UTF-8 invalid
    /// post-AEAD-success is the not-reading kin of `InvalidVaultMeta`
    /// (structural corruption / foreign-writer suspicion). UI: "Not
    /// içeriği bozuk olabilir, backup'tan restore et."
    #[error("plaintext is not valid utf-8")]
    InvalidPlaintextEncoding,

    /// File-system IO failure during `notes_dir` resolution or the
    /// blob read. `NotFound` is special-cased upstream as
    /// [`Self::NoteNotFound`]; only `PermissionDenied` / `NoSpace` /
    /// `Other` surface here.
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error.
    /// User-facing CTA is "try again".
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteReadError {
    fn from(e: std::io::Error) -> Self {
        // `NotFound` is special-cased by the calling command (mapped
        // to `NoteNotFound` for the distinct user message). This
        // `From` handles the residual cases.
        NoteReadError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialize_create(e: &NoteCreateError) -> String {
        serde_json::to_string(e).expect("NoteCreateError must serialize cleanly")
    }
    fn serialize_read(e: &NoteReadError) -> String {
        serde_json::to_string(e).expect("NoteReadError must serialize cleanly")
    }

    // ---- NoteCreateError serde shape ------------------------------------

    #[test]
    fn create_vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize_create(&NoteCreateError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn create_note_already_exists_serializes_with_kind_tag() {
        assert_eq!(
            serialize_create(&NoteCreateError::NoteAlreadyExists),
            r#"{"kind":"NoteAlreadyExists"}"#
        );
    }

    #[test]
    fn create_plaintext_too_large_serializes_with_kind_tag() {
        assert_eq!(
            serialize_create(&NoteCreateError::PlaintextTooLarge),
            r#"{"kind":"PlaintextTooLarge"}"#
        );
    }

    #[test]
    fn create_notes_dir_not_a_directory_serializes_with_kind_tag() {
        assert_eq!(
            serialize_create(&NoteCreateError::NotesDirNotADirectory),
            r#"{"kind":"NotesDirNotADirectory"}"#
        );
    }

    #[test]
    fn create_io_serializes_with_io_failure_kind_payload() {
        let e = NoteCreateError::Io {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        assert_eq!(
            serialize_create(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    #[test]
    fn create_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_create(&NoteCreateError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    // ---- NoteReadError serde shape -------------------------------------

    #[test]
    fn read_note_not_found_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::NoteNotFound),
            r#"{"kind":"NoteNotFound"}"#
        );
    }

    #[test]
    fn read_invalid_note_id_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::InvalidNoteId),
            r#"{"kind":"InvalidNoteId"}"#
        );
    }

    #[test]
    fn read_vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn read_cannot_decrypt_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::CannotDecrypt),
            r#"{"kind":"CannotDecrypt"}"#
        );
    }

    #[test]
    fn read_invalid_plaintext_encoding_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::InvalidPlaintextEncoding),
            r#"{"kind":"InvalidPlaintextEncoding"}"#
        );
    }

    #[test]
    fn read_io_serializes_with_io_failure_kind_payload() {
        let e = NoteReadError::Io {
            io_error_kind: IoFailureKind::Other,
        };
        assert_eq!(
            serialize_read(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"Other"}}"#
        );
    }

    #[test]
    fn read_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    // ---- Closed-payload exhaustiveness pin ------------------------------
    //
    // Mirror of `vault_unlock::error::tests::all_variants_have_closed_
    // payloads_only`. If a future variant is added to either enum, the
    // exhaustive match below stops compiling; the reviewer must add the
    // new arm AND verify the new variant's payload is closed (no
    // `String`, no unbounded-shape data crossing the IPC boundary).

    #[test]
    fn create_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteCreateError) {
            match e {
                NoteCreateError::VaultNotUnlocked => {}
                NoteCreateError::NoteAlreadyExists => {}
                NoteCreateError::PlaintextTooLarge => {}
                NoteCreateError::NotesDirNotADirectory => {}
                NoteCreateError::Io { io_error_kind: _ } => {}
                NoteCreateError::JoinFailure => {}
            }
        }
        assert_closed(&NoteCreateError::VaultNotUnlocked);
    }

    #[test]
    fn read_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteReadError) {
            match e {
                NoteReadError::NoteNotFound => {}
                NoteReadError::InvalidNoteId => {}
                NoteReadError::VaultNotUnlocked => {}
                NoteReadError::CannotDecrypt => {}
                NoteReadError::InvalidPlaintextEncoding => {}
                NoteReadError::Io { io_error_kind: _ } => {}
                NoteReadError::JoinFailure => {}
            }
        }
        assert_closed(&NoteReadError::NoteNotFound);
    }

    // ---- From<std::io::Error> mapping ----------------------------------

    #[test]
    fn create_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteCreateError = raw.into();
        match mapped {
            NoteCreateError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn create_from_io_error_unknown_kind_collapses_to_other() {
        let raw = std::io::Error::from(std::io::ErrorKind::AlreadyExists);
        let mapped: NoteCreateError = raw.into();
        match mapped {
            NoteCreateError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::Other);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn read_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteReadError = raw.into();
        match mapped {
            NoteReadError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn read_from_io_error_no_space_collapses_to_no_space() {
        let raw = std::io::Error::from(std::io::ErrorKind::StorageFull);
        let mapped: NoteReadError = raw.into();
        match mapped {
            NoteReadError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::NoSpace);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }
}
